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
const DROP_INTERVAL_RUSH_SEC = 0.55;     // 4x faster when rush mode on
const DROP_BATCH_SIZE = 1;
const RING_SATURATION_THRESHOLD = 4;
// Rush-mode auto ring-shrink: every N seconds the inner ring boundary
// marches one cell-width inward (toward the player). Combined with the
// 4x drop rate this creates a "walls closing in" feel.
const RUSH_AUTO_SHRINK_SEC = 1.5;

const hazards = [];
let _dropTimer = 0;
let _spawningEnabled = false;
let _activeRingInner = 0;
let _ringFailures = 0;
let _blockedZones = [];
let _style = tetrisStyle;
let _rushMode = false;
let _rushAutoShrinkT = 0;

/** Toggle rush mode — drops 4x faster + active ring auto-shrinks
 *  inward over time. Used in chapter 2 wave 3 (and other intense
 *  moments) to give the player a "walls closing in" feel. */
export function setHazardRushMode(v) {
  _rushMode = !!v;
  _rushAutoShrinkT = 0;
}

function getRingWidth() { return _style.getCellSize ? _style.getCellSize() : 2.5; }
function getOuterMax() { return ARENA - MIN_EDGE_PADDING; }

/**
 * True if a hazard tile (any color, lethal or not) currently exists at
 * the given world-space (x, z). Used by hazardsPacman.js for 3D-mode
 * ghosts that can only walk on the green tiles they (and their
 * siblings) have already laid down.
 */
export function isCellTiled(x, z) {
  const cellSize = getRingWidth();
  for (const h of hazards) {
    const b = h.bbox;
    if (x < b.minX - EXISTING_OVERLAP_PAD || x > b.maxX + EXISTING_OVERLAP_PAD) continue;
    if (z < b.minZ - EXISTING_OVERLAP_PAD || z > b.maxZ + EXISTING_OVERLAP_PAD) continue;
    for (const hc of h.cells) {
      if (Math.abs(x - hc.x) < cellSize * 0.5 && Math.abs(z - hc.z) < cellSize * 0.5) return true;
    }
  }
  return false;
}

/**
 * True if the given world-space (x, z) is inside any active charging
 * zone (depots, silos, wells). Styles that manage their own spawning —
 * Pacman ghosts in particular — should call this before placing a
 * green hazard tile, so they don't paint damage tiles under structures
 * the player needs to walk on. The standard ring-fill drop loop already
 * does this via _isValidPlacement, but waypoint-based placers need to
 * check explicitly.
 */
export function isCellInBlockedZone(x, z) {
  const r2 = POWERUP_ZONE_CLEAR_RADIUS * POWERUP_ZONE_CLEAR_RADIUS;
  for (const z2 of _blockedZones) {
    const dx = x - z2.x, dz = z - z2.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

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

// Material cache for lethal (red flag-bomb) tiles. Distinct visual
// from numbered/regular damage tiles so the player can tell at a glance
// "this one will kill me." Uses the chapter tint as base but multiplied
// dark + emissive red glow.
const _lethalMatCache = new Map();
function getLethalMat() {
  let m = _lethalMatCache.get('_lethal');
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: 0x8a0a0a,    // dark blood red
      side: THREE.DoubleSide,
    });
    _lethalMatCache.set('_lethal', m);
  }
  return m;
}

// Shared geometry + materials for the 3D flag (planted on lethal tiles).
// Pole is a thin black cylinder; flag is a flat red triangle that
// attaches near the pole top and oscillates ±15° around the Y axis
// to simulate wind. Flag rotation animation lives on the hazard's
// userData and is ticked by updateHazards (currently a no-op — we
// repurpose it to flap flags).
const _flagPoleGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6);
const _flagPoleMat = new THREE.MeshStandardMaterial({
  color: 0x222222,
  metalness: 0.4,
  roughness: 0.6,
});
const _flagBaseGeo = new THREE.CylinderGeometry(0.10, 0.18, 0.10, 8);
const _flagBaseMat = new THREE.MeshStandardMaterial({
  color: 0x111111,
  metalness: 0.3,
  roughness: 0.7,
});
// Flag fabric — equilateral triangle pointing right (+X). Built as
// a flat geometry so the flap rotation around the pole produces the
// effect of fabric catching wind.
const _flagFabricMat = new THREE.MeshStandardMaterial({
  color: 0xff2020,
  emissive: 0x801010,
  emissiveIntensity: 0.5,
  metalness: 0.1,
  roughness: 0.8,
  side: THREE.DoubleSide,
});
function _buildFlagFabricGeo() {
  // Triangle from (0,0) to (0.6, -0.4) to (0.0, -0.4) — long edge at the
  // top, hypotenuse on the right (the flap). Origin at attachment point.
  const geo = new THREE.BufferGeometry();
  const verts = new Float32Array([
    0.0, 0.0, 0.0,
    0.55, -0.18, 0.0,
    0.0, -0.40, 0.0,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex([0, 1, 2]);
  geo.computeVertexNormals();
  return geo;
}
const _flagFabricGeo = _buildFlagFabricGeo();

// Build a flag at the given world position. Returns a Group that can
// be added to a tile. The Group has a `flapAxis` reference to the
// rotating subgroup so the per-frame ticker can animate it.
function _buildFlag(x, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  // Base disc — gives the flag a planted-into-the-ground look.
  const base = new THREE.Mesh(_flagBaseGeo, _flagBaseMat);
  base.position.y = 0.05;
  group.add(base);
  // Pole — vertical cylinder. Pivot at base, top at y = 1.2.
  const pole = new THREE.Mesh(_flagPoleGeo, _flagPoleMat);
  pole.position.y = 0.65;  // half-height + base offset
  group.add(pole);
  // Flap subgroup — pivots at the pole TOP. We rotate this group's
  // .rotation.y to wave the flag.
  const flapAxis = new THREE.Group();
  flapAxis.position.set(0, 1.2, 0);  // pole top
  group.add(flapAxis);
  const fabric = new THREE.Mesh(_flagFabricGeo, _flagFabricMat);
  // Translate fabric so the long edge (height = 0.4) hangs DOWN from
  // the pivot point. Origin (0,0,0) is at top-left of triangle which
  // is at the pole top.
  flapAxis.add(fabric);
  return { group, flapAxis };
}

// ---- NUMBER + BOMB ICON DECORATIONS (Minesweeper stage 2) ----
// Both rendered to canvas once, cached as Three textures, applied
// to flat plane meshes laid on the ground above their tile. Canvas
// approach avoids any font-asset dependency — we use the browser's
// native font rendering (sans-serif) which is always available.

// Classic minesweeper digit colors. Index = digit (1-8). 0 unused.
const _NUMBER_COLORS = [
  '#000000',     // 0 (unused — never displayed)
  '#1d4ed8',     // 1 — blue
  '#15803d',     // 2 — green
  '#dc2626',     // 3 — red
  '#1e3a8a',     // 4 — dark blue
  '#7f1d1d',     // 5 — dark red
  '#0e7490',     // 6 — teal
  '#000000',     // 7 — black
  '#525252',     // 8 — grey
];

// Cache: digit (1..8) → Three.Texture
const _numberTextureCache = new Map();
function _getNumberTexture(digit) {
  if (_numberTextureCache.has(digit)) return _numberTextureCache.get(digit);
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  // Transparent background — shows through to the tile underneath.
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = _NUMBER_COLORS[digit] || '#000000';
  ctx.font = 'bold 96px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // White outline behind the digit so it pops on the tile.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 8;
  ctx.strokeText(String(digit), SIZE / 2, SIZE / 2);
  ctx.fillText(String(digit), SIZE / 2, SIZE / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  _numberTextureCache.set(digit, tex);
  return tex;
}

// Bomb icon — black circle with a thin spike on top (the iconic fuse).
let _bombTextureCache = null;
function _getBombTexture() {
  if (_bombTextureCache) return _bombTextureCache;
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);
  // Bomb body — dark circle with subtle shading.
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.arc(SIZE * 0.5, SIZE * 0.55, SIZE * 0.32, 0, Math.PI * 2);
  ctx.fill();
  // Highlight — small lighter dot on the bomb (gives it volume).
  ctx.fillStyle = '#3a3a3a';
  ctx.beginPath();
  ctx.arc(SIZE * 0.42, SIZE * 0.45, SIZE * 0.08, 0, Math.PI * 2);
  ctx.fill();
  // Fuse — vertical dark line on top.
  ctx.strokeStyle = '#888888';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(SIZE * 0.5, SIZE * 0.23);
  ctx.lineTo(SIZE * 0.55, SIZE * 0.10);
  ctx.stroke();
  // Spark on fuse tip — tiny yellow circle.
  ctx.fillStyle = '#fde047';
  ctx.beginPath();
  ctx.arc(SIZE * 0.56, SIZE * 0.09, SIZE * 0.04, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  _bombTextureCache = tex;
  return tex;
}

// Plane geometry shared by all decorations (numbers + bomb icons).
// Sized to roughly half the cell so the digit doesn't crowd grid edges.
let _decorationGeoCache = null;
let _decorationGeoSize = -1;
function _getDecorationGeo() {
  const sz = getRingWidth() * 0.7;
  if (_decorationGeoCache && _decorationGeoSize === sz) return _decorationGeoCache;
  if (_decorationGeoCache) _decorationGeoCache.dispose();
  _decorationGeoCache = new THREE.PlaneGeometry(sz, sz);
  _decorationGeoSize = sz;
  return _decorationGeoCache;
}

function _buildNumberMesh(digit, x, z) {
  const tex = _getNumberTexture(digit);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(_getDecorationGeo(), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.06, z);   // slightly above tile (which sits at y=0.03)
  return mesh;
}

function _buildBombIconMesh(x, z) {
  const tex = _getBombTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(_getDecorationGeo(), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.06, z);
  return mesh;
}

function _placeTile(cells, tintHex, opts) {
  const lethal = !!(opts && opts.lethal);
  const number = (opts && typeof opts.number === 'number') ? opts.number : null;
  const group = new THREE.Group();
  const mat = lethal ? getLethalMat() : getHazardMat(tintHex);
  const geo = getTileGeo();
  const finalCells = [];
  for (const c of cells) {
    const tile = new THREE.Mesh(geo, mat);
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(c.x, 0.03, c.z);
    group.add(tile);
    finalCells.push({ x: c.x, z: c.z });
  }
  // For lethal tiles we plant a 3D red flag at the cell center AND
  // stamp a 2D bomb icon on the ground for extra warning. The flag
  // is the eye-catching warning; the icon is reinforcement for players
  // who might have missed the flag silhouette.
  let flapAxis = null;
  if (lethal && cells.length === 1) {
    const cx = cells[0].x, cz = cells[0].z;
    // Bomb icon goes UNDER the flag (rendered first, lower in scene
    // graph) so the flag pole appears on top of it visually.
    group.add(_buildBombIconMesh(cx, cz));
    const flag = _buildFlag(cx, cz);
    group.add(flag.group);
    flapAxis = flag.flapAxis;
  }
  // For safe (numbered) tiles, stamp the adjacent-bomb count digit.
  // Only display 1-8 (skip 0 = no neighboring bombs, that's just an
  // open/safe tile that doesn't need a digit).
  if (!lethal && number != null && number > 0 && cells.length === 1) {
    group.add(_buildNumberMesh(number, cells[0].x, cells[0].z));
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
    lethal,
    flapAxis,
    flagPhase: Math.random() * Math.PI * 2,  // randomize start phase per flag
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
      _placeTile(c.cells, c.tintHex, { lethal: !!c.lethal, number: c.number });
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
      // Player position — styles can bias spawn locations near the
      // player so action stays onscreen rather than always firing at
      // distant arena edges.
      playerPos,
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
  // Rush mode: auto-shrink the inner ring inward on a timer. The
  // active ring marches toward the player even before the style
  // saturates and calls onRingSaturated. Combined with the 4x drop
  // rate this creates the "walls closing in" feel.
  if (_rushMode) {
    _rushAutoShrinkT += dt;
    if (_rushAutoShrinkT >= RUSH_AUTO_SHRINK_SEC) {
      _rushAutoShrinkT = 0;
      const next = _activeRingInner - getRingWidth();
      if (next >= SAFE_RADIUS_FROM_CENTER) _activeRingInner = next;
    }
  }
  // Legacy drop loop — only for styles that don't manage their own spawns.
  if (_style && _style.managesOwnSpawns) return;
  _dropTimer -= dt;
  if (_dropTimer <= 0) {
    _dropTimer = _rushMode ? DROP_INTERVAL_RUSH_SEC : DROP_INTERVAL_SEC;
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

// Helper: find the hazard tile a point is on, or null. Used by both
// the damage path and the flag placement logic. Returns the hazard
// object so the caller can read .lethal.
function _hazardAtPoint(x, z) {
  const cellSize = getRingWidth();
  const half = cellSize * 0.49;
  for (const h of hazards) {
    const b = h.bbox;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    for (const c of h.cells) {
      if (Math.abs(x - c.x) < half && Math.abs(z - c.z) < half) return h;
    }
  }
  return null;
}

export function hurtPlayerIfOnHazard(dt, playerPos, S, UI, Audio, shake) {
  if (S.invulnTimer > 0) return false;
  // Ghost-touch instant kill (chapter 4 / Pac-Man style only). Style
  // modules can opt into mobile lethal entities by exposing
  // isPlayerTouchingGhost(playerPos) — currently used only by
  // hazardsPacman.js for the four ghosts. This is checked BEFORE the
  // tile lookup so a ghost standing on a non-hazard cell still kills.
  if (_style && _style.isPlayerTouchingGhost && _style.isPlayerTouchingGhost(playerPos)) {
    S.hp = 0;
    if (UI && UI.damageFlash) UI.damageFlash();
    if (Audio && Audio.bigBoom) Audio.bigBoom();
    else if (Audio && Audio.damage) Audio.damage();
    if (shake) shake(0.45, 0.4);
    return true;
  }
  const haz = _hazardAtPoint(playerPos.x, playerPos.z);
  if (!haz) return false;
  // Lethal tile (flagged bomb) — instant kill, regardless of HP.
  // The visual + audio cues are slightly bigger than a regular tick:
  // bigger shake, damage flash, and a death-snap that drops HP to 0
  // immediately so the existing death pipeline handles the rest.
  if (haz.lethal) {
    S.hp = 0;
    if (UI && UI.damageFlash) UI.damageFlash();
    if (Audio && Audio.bigBoom) Audio.bigBoom();
    else if (Audio && Audio.damage) Audio.damage();
    if (shake) shake(0.45, 0.4);
    return true;
  }
  // Standard damage tile — same logic as before.
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

// Per-frame visual update for hazard tiles. Currently only used to
// animate the wind-flap on flagged (lethal) tiles. Each flag's
// flapAxis subgroup oscillates ±30° around the Y axis at ~3 Hz,
// with each flag's individual phase offset so they don't all flap
// in sync (looks more natural).
export function updateHazards(dt, timeElapsed) {
  for (const h of hazards) {
    if (h.flapAxis && h.lethal) {
      const t = timeElapsed * 3 + h.flagPhase;
      h.flapAxis.rotation.y = Math.sin(t) * 0.5;
      // Subtle bend across the fabric — cosine offset around the X
      // axis adds a bit of "pulling away" motion to read more like
      // catching wind than just rotating.
      h.flapAxis.rotation.x = Math.sin(t * 1.7 + 0.3) * 0.12;
    }
  }
}
