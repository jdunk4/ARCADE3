// Floor hazards — generic ring-based fill system that delegates the
// per-chapter VISUALS to a "style" module.
//
// This file owns:
//   - The concentric-ring outside-in fill logic
//   - Drop pacing (interval, batch size)
//   - Tile placement (after a delivery completes)
//   - Player damage on tile contact
//   - Validation (player/zone/edge/overlap checks)
//   - Public API (setHazardSpawningEnabled, tickHazardSpawning, clearHazards,
//     hurtPlayerIfOnHazard, isHazardAt, repelEnemyFromHazards)
//
// Each chapter has a STYLE module that owns:
//   - Choosing where to place the next tile (within the active ring)
//   - The warning/delivery visual (e.g. tetris hover-and-slam)
//
// Currently active style is selected via setHazardStyle(). Default =
// chapter 1 tetris. Chapter 2+ will plug in their own modules.

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA, CHAPTERS } from './config.js';
import * as tetrisStyle from './hazardsTetris.js';

const SAFE_RADIUS_FROM_CENTER = 7;
const MIN_EDGE_PADDING = 6;
const POWERUP_ZONE_CLEAR_RADIUS = 5.5;
const PLAYER_CLEAR_RADIUS = 3.0;
const EXISTING_OVERLAP_PAD = 0.6;
const DROP_INTERVAL_SEC = 2.2;
const DROP_BATCH_SIZE = 1;
const RING_SATURATION_THRESHOLD = 4;

const hazards = [];
let _dropTimer = 0;
let _spawningEnabled = false;
let _activeRingInner = 0;
let _ringFailures = 0;
let _blockedZones = [];
let _style = tetrisStyle;

function getRingWidth() { return _style.getCellSize ? _style.getCellSize() : 2.5; }
function getOuterMax() { return ARENA - MIN_EDGE_PADDING; }

const _hazardMatCache = new Map();
function getHazardMat(tintHex) {
  let m = _hazardMatCache.get(tintHex);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: tintHex, side: THREE.DoubleSide });
    _hazardMatCache.set(tintHex, m);
  }
  return m;
}

let _tileGeoCache = null;
let _tileGeoCellSize = -1;
function getTileGeo() {
  const sz = getRingWidth();
  if (_tileGeoCache && _tileGeoCellSize === sz) return _tileGeoCache;
  if (_tileGeoCache) _tileGeoCache.dispose();
  _tileGeoCache = new THREE.PlaneGeometry(sz, sz);
  _tileGeoCellSize = sz;
  return _tileGeoCache;
}

export function prewarmHazardMat(tintHex) {
  getHazardMat(tintHex);
}

function _isValidPlacement(cells, originX, originZ, playerPos) {
  const playerRadiusSq = PLAYER_CLEAR_RADIUS * PLAYER_CLEAR_RADIUS;
  const zoneRadiusSq = POWERUP_ZONE_CLEAR_RADIUS * POWERUP_ZONE_CLEAR_RADIUS;
  const cellSize = getRingWidth();
  for (const c of cells) {
    if (Math.abs(c.x) > ARENA - MIN_EDGE_PADDING) return false;
    if (Math.abs(c.z) > ARENA - MIN_EDGE_PADDING) return false;
    if (c.x * c.x + c.z * c.z < SAFE_RADIUS_FROM_CENTER * SAFE_RADIUS_FROM_CENTER) return false;
    if (playerPos) {
      const dx = c.x - playerPos.x, dz = c.z - playerPos.z;
      if (dx * dx + dz * dz < playerRadiusSq) return false;
    }
    for (const z of _blockedZones) {
      const dx = c.x - z.x, dz = c.z - z.z;
      if (dx * dx + dz * dz < zoneRadiusSq) return false;
    }
    for (const h of hazards) {
      const b = h.bbox;
      if (c.x < b.minX - EXISTING_OVERLAP_PAD || c.x > b.maxX + EXISTING_OVERLAP_PAD) continue;
      if (c.z < b.minZ - EXISTING_OVERLAP_PAD || c.z > b.maxZ + EXISTING_OVERLAP_PAD) continue;
      for (const hc of h.cells) {
        if (Math.abs(c.x - hc.x) < cellSize && Math.abs(c.z - hc.z) < cellSize) return false;
      }
    }
  }
  return true;
}

function _placeTile(cells, tintHex) {
  const group = new THREE.Group();
  const mat = getHazardMat(tintHex);
  const geo = getTileGeo();
  const finalCells = [];
  for (const c of cells) {
    const tile = new THREE.Mesh(geo, mat);
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(c.x, 0.03, c.z);
    group.add(tile);
    finalCells.push({ x: c.x, z: c.z });
  }
  scene.add(group);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of finalCells) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  const pad = getRingWidth() * 0.5;
  hazards.push({
    group,
    cells: finalCells,
    bbox: { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad },
  });
}

function _tryDropBatch(chapterIdx, playerPos) {
  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  const tint = chapter.full.grid1;
  const ringWidth = getRingWidth();
  const outerMax = getOuterMax();

  if (_activeRingInner === 0) {
    _activeRingInner = outerMax - ringWidth;
  }

  let placed = 0;
  let attempts = 0;
  while (placed < DROP_BATCH_SIZE && attempts < 80) {
    attempts++;
    const validate = (cells, ox, oz) => {
      const cheb = Math.max(Math.abs(ox), Math.abs(oz));
      if (cheb < _activeRingInner) return false;
      return _isValidPlacement(cells, ox, oz, playerPos);
    };
    const spot = _style.chooseSpawnLocation(_activeRingInner, outerMax, validate);
    if (!spot) continue;
    _style.spawnDelivery(spot, tint);
    placed++;
  }

  if (placed === 0) {
    _ringFailures++;
    if (_ringFailures >= RING_SATURATION_THRESHOLD) {
      _ringFailures = 0;
      const next = _activeRingInner - ringWidth;
      if (next >= SAFE_RADIUS_FROM_CENTER) {
        _activeRingInner = next;
      }
    }
  } else {
    _ringFailures = 0;
  }
}

export function setHazardStyle(style) {
  if (_style === style) return;
  if (_style && _style.cleanup) _style.cleanup();
  _style = style || tetrisStyle;
}

export function getHazardStyle() {
  return _style;
}

export function setHazardSpawningEnabled(enabled) {
  _spawningEnabled = !!enabled;
  _dropTimer = enabled ? DROP_INTERVAL_SEC * 0.5 : 0;
}

export function tickHazardSpawning(dt, chapterIdx, playerPos, activeZones) {
  _blockedZones = activeZones || [];
  // Give the style a chance to tick — lets it drive its own spawn loop
  // (Galaga) or just advance in-flight deliveries (Tetris). Styles that
  // manage their own spawning also need access to the validator and
  // chapter tint, so we build a context and pass it along.
  if (_style && _style.tickDeliveries) {
    const completed = _style.tickDeliveries(dt);
    for (const c of completed) {
      _placeTile(c.cells, c.tintHex);
    }
  }
  // Styles that own their own spawn pacing (Galaga bugs) get ticked
  // here with a context object: the validator, chapter tint, active
  // ring bounds. They can call ctx.validate(cells, originX, originZ)
  // from their own internal bug-spawn logic.
  if (_style && _style.tickSpawning && _spawningEnabled) {
    if (_activeRingInner === 0) {
      _activeRingInner = getOuterMax() - getRingWidth();
    }
    const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
    const tint = chapter.full.grid1;
    const ctx = {
      tint,
      ringInner: _activeRingInner,
      ringOuter: getOuterMax(),
      validate: (cells, ox, oz) => {
        const cheb = Math.max(Math.abs(ox), Math.abs(oz));
        if (cheb < _activeRingInner) return false;
        return _isValidPlacement(cells, ox, oz, playerPos);
      },
      // Styles call this when they've repeatedly failed validation —
      // indicates the current ring is saturated and should advance inward.
      onRingSaturated: () => {
        const next = _activeRingInner - getRingWidth();
        if (next >= SAFE_RADIUS_FROM_CENTER) {
          _activeRingInner = next;
        }
      },
    };
    _style.tickSpawning(dt, ctx);
  }
  if (!_spawningEnabled) return;
  // Legacy drop loop — only for styles that don't manage their own spawns.
  if (_style && _style.managesOwnSpawns) return;
  _dropTimer -= dt;
  if (_dropTimer <= 0) {
    _dropTimer = DROP_INTERVAL_SEC;
    _tryDropBatch(chapterIdx, playerPos);
  }
}

export function clearHazards() {
  for (const h of hazards) {
    if (h.group.parent) scene.remove(h.group);
  }
  hazards.length = 0;
  if (_style && _style.cleanup) _style.cleanup();
  _dropTimer = 0;
  _activeRingInner = 0;
  _ringFailures = 0;
}

export function isHazardAt(x, z) {
  const cellSize = getRingWidth();
  const half = cellSize * 0.49;
  for (const h of hazards) {
    const b = h.bbox;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    for (const c of h.cells) {
      if (Math.abs(x - c.x) < half && Math.abs(z - c.z) < half) return true;
    }
  }
  return false;
}

export function hurtPlayerIfOnHazard(dt, playerPos, S, UI, Audio, shake) {
  if (S.invulnTimer > 0) return false;
  if (!isHazardAt(playerPos.x, playerPos.z)) return false;
  S._hazardTickTimer = (S._hazardTickTimer || 0) - dt;
  S.hp -= 10 * dt;
  if (S._hazardTickTimer <= 0) {
    S._hazardTickTimer = 0.4;
    if (UI && UI.damageFlash) UI.damageFlash();
    if (Audio && Audio.damage) Audio.damage();
    if (shake) shake(0.12, 0.1);
  }
  if (S.hp <= 0) S.hp = 0;
  return true;
}

export function repelEnemyFromHazards(e, dt) {
  // intentionally empty — enemies walk through hazards
}

export function spawnHazardsForWave(chapterIdx, localWave) {
  // intentionally empty — progressive system uses tickHazardSpawning
}

export function updateHazards(dt, timeElapsed) {}
