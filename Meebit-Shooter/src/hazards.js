// Floor hazards — tetromino-shaped "lava" patches embedded in the arena
// floor. The player takes damage for standing in one. On waves 1-3,
// hazards RAIN DOWN progressively over the course of the wave instead
// of all spawning at once at wave start. Each piece is introduced as a
// 3D hovering block that pulses a warning for ~0.8s, then slams into
// the ground and becomes a floor tile.
//
// Design goals:
//   1. Anti-farm — a player who turtles and farms enemies for XP slowly
//      loses arena space, forcing them to keep moving and finish the
//      wave before their footprint shrinks too far.
//   2. Telegraphed — every drop has a visible warning (hovering block +
//      shadow) so being hit by an incoming drop is always the player's
//      fault, never a surprise.
//   3. Enemies ignore hazards now. They were previously repelled away,
//      which broke AI in late waves when 30+ hazards piled up. With
//      progressive drops the player is already juggling more stuff,
//      enemies don't need hazard-aware pathing on top.
//
// Applies to waves 1, 2, 3 only. Waves 4 (bonus) and 5 (boss) never
// spawn or accumulate hazards.

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA, CHAPTERS } from './config.js';

// Tetromino footprints — each number is a unit cell offset on the XZ grid.
const TETROMINOES = [
  [[-1.5, 0], [-0.5, 0], [0.5, 0], [1.5, 0]],           // I
  [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]], // O
  [[-1, 0], [0, 0], [1, 0], [0, -1]],                    // T
  [[-0.5, -1], [-0.5, 0], [-0.5, 1], [0.5, 1]],          // L
  [[-1, 0.5], [0, 0.5], [0, -0.5], [1, -0.5]],           // S
];

// CELL_SIZE matches the floor grid spacing so tiles align to the grid
// lines and adjacent tetrominoes form a seamless sheet of color.
// Floor uses GridHelper(ARENA*2, 40) → 2.5u per grid cell. Setting
// CELL_SIZE to match gives us perfect snap: a dropped tetromino
// occupies real grid cells and a cluster looks like a continuous
// orange floor instead of a jagged mosaic.
const CELL_SIZE = 2.5;
const SAFE_RADIUS_FROM_CENTER = 7;         // keep center spawn area clear
const MIN_EDGE_PADDING = 6;
const POWERUP_ZONE_CLEAR_RADIUS = 5.5;     // generous so zones stay walkable
const PLAYER_CLEAR_RADIUS = 3.0;           // never drop on or near the player
const EXISTING_OVERLAP_PAD = 0.6;          // tiles must not touch existing ones

const DROP_INTERVAL_SEC = 2.2;             // slower still: was 1.6
const DROP_BATCH_SIZE = 1;                 // one piece at a time: was 2
const HOVER_HEIGHT = 5.0;                  // where incoming blocks hover
const WARNING_DURATION = 0.8;              // hover/pulse time before slam
const DROP_DURATION = 0.35;                // time from hover height to ground

// NOTE: No MAX_HAZARDS cap. Drops continue until no valid spot remains —
// which happens naturally when the arena is nearly full. The arena's
// theoretical maximum with 2.5u cells is ~500 cells; in practice with
// zones/center/edge/player exclusions the cap lands around ~250 cells
// (~15% of arena), well below any visual or perf concern.

// Landed hazards — the flat floor tiles the player can be damaged by.
const hazards = [];
// In-flight hazards currently hovering/falling. Moved to `hazards` on impact.
const incomingHazards = [];

// Module-level drop timer — ticked by updateHazards whenever the caller
// supplies dt > 0. waves.js calls tickHazardSpawning() each frame with
// chapter/wave metadata; when the timer expires we try to drop a batch.
let _dropTimer = 0;
let _spawningEnabled = false;  // gated by waves.js — only true in waves 1-3

// -------- OUTSIDE-IN FILL STATE --------
// Instead of a time-based ring shrink, we use a true saturation-driven
// outside-in fill:
//
// The arena is conceptually divided into concentric square rings (each
// one CELL_SIZE thick). Starting at the outermost ring, we only allow
// drops whose origin falls in the current "active ring" or any outer
// ring (not inner). When the active ring is saturated — measured by
// consecutive failed placement attempts in it — we advance one ring
// inward and continue.
//
// This produces the "fill the whole outer row before moving in" behavior
// the user asked for, without needing to track a literal grid occupancy
// map. It also naturally adapts to zone/player/edge exclusions: a ring
// that's mostly blocked just saturates faster and we move on.
//
// Current ring — the INNERMOST radius that drops are currently allowed
// to spawn in. Drops land ONLY between _activeRingInner and OUTER_MAX.
// Starts at ARENA - MIN_EDGE_PADDING - RING_WIDTH (outermost ring only),
// shrinks toward SAFE_RADIUS_FROM_CENTER as outer rings saturate.
let _activeRingInner = 0;

// Consecutive failed placement attempts in the current ring. When this
// exceeds RING_SATURATION_THRESHOLD, we decide the ring is "full enough"
// and advance the active ring one step inward.
let _ringFailures = 0;

// Thickness of each ring in world units. One ring per CELL_SIZE step
// means a true literal-row fill pattern: outer row completes, next row
// in starts, and so on.
const RING_WIDTH = CELL_SIZE;

// Number of consecutive failed placement attempts before we move the
// ring inward. Higher = more thoroughly packed rings before advancing
// (but more wasted attempts and drop cycles stalled). 4 means: after
// 4 separate drop intervals fail to place anywhere in the ring, we
// consider it saturated. At 2.2s/interval that's ~9 seconds of
// "ring is full" before advancing — a clear visual beat without making
// the player wait too long for the next row to start filling.
const RING_SATURATION_THRESHOLD = 4;

// Outer bound of placement (distance from center). Always fixed at
// ARENA - MIN_EDGE_PADDING. The inner bound (_activeRingInner) is what
// moves as rings saturate.
const OUTER_MAX = ARENA - MIN_EDGE_PADDING;

// Powerup zone positions cached each tick. waves.js supplies these via
// tickHazardSpawning — passing them in avoids a hard dependency from
// hazards.js on powerupZones.js (would create an import cycle through
// waves.js).
let _blockedZones = [];

// Shared geometries — allocated once. Tiles render at 100% of cell size
// (previously 98%) so adjacent tetrominoes touch edge-to-edge with no
// visible gap — a tight cluster reads as a solid orange sheet.
const TILE_GEO = new THREE.PlaneGeometry(CELL_SIZE, CELL_SIZE);
const BLOCK_GEO = new THREE.BoxGeometry(CELL_SIZE * 0.9, CELL_SIZE * 0.9, CELL_SIZE * 0.9);
const SHADOW_GEO = new THREE.CircleGeometry(CELL_SIZE * 0.55, 16);

// Material pools — keyed by chapter tint. Solid color, fully opaque.
const _hazardMatCache = new Map();
const _blockMatCache = new Map();
const _shadowMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function getHazardMat(tintHex) {
  let m = _hazardMatCache.get(tintHex);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tintHex,
      side: THREE.DoubleSide,
    });
    _hazardMatCache.set(tintHex, m);
  }
  return m;
}

// Hovering-block material — slightly emissive + transparent so the
// warning state can pulse opacity without swapping materials.
function getBlockMat(tintHex) {
  let m = _blockMatCache.get(tintHex);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tintHex,
      emissive: tintHex,
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.85,
      metalness: 0.2,
      roughness: 0.4,
    });
    _blockMatCache.set(tintHex, m);
  }
  return m;
}

export function prewarmHazardMat(tintHex) {
  getHazardMat(tintHex);
  getBlockMat(tintHex);
}

// ---------------------------------------------------------------------
// VALIDATION HELPERS
// ---------------------------------------------------------------------

/** Compute final cell positions for a tetromino at origin+rotation. */
function _cellsFor(shape, originX, originZ, rotation) {
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const cells = [];
  for (const [cx, cz] of shape) {
    const rx = cx * cos - cz * sin;
    const rz = cx * sin + cz * cos;
    cells.push({ x: originX + rx * CELL_SIZE, z: originZ + rz * CELL_SIZE });
  }
  return cells;
}

/** Check every constraint for a candidate hazard placement. */
function _isValidPlacement(cells, playerPos) {
  const playerRadiusSq = PLAYER_CLEAR_RADIUS * PLAYER_CLEAR_RADIUS;
  const zoneRadiusSq = POWERUP_ZONE_CLEAR_RADIUS * POWERUP_ZONE_CLEAR_RADIUS;
  for (const c of cells) {
    // Keep out of arena edges (defense against rotation moving a cell out)
    if (Math.abs(c.x) > ARENA - MIN_EDGE_PADDING) return false;
    if (Math.abs(c.z) > ARENA - MIN_EDGE_PADDING) return false;
    // Keep out of center safe zone
    if (c.x * c.x + c.z * c.z < SAFE_RADIUS_FROM_CENTER * SAFE_RADIUS_FROM_CENTER) return false;
    // Keep away from the player
    if (playerPos) {
      const dx = c.x - playerPos.x, dz = c.z - playerPos.z;
      if (dx * dx + dz * dz < playerRadiusSq) return false;
    }
    // Keep away from powerup zones
    for (const z of _blockedZones) {
      const dx = c.x - z.x, dz = c.z - z.z;
      if (dx * dx + dz * dz < zoneRadiusSq) return false;
    }
    // No overlap with existing landed hazards
    for (const h of hazards) {
      const b = h.bbox;
      if (c.x < b.minX - EXISTING_OVERLAP_PAD || c.x > b.maxX + EXISTING_OVERLAP_PAD) continue;
      if (c.z < b.minZ - EXISTING_OVERLAP_PAD || c.z > b.maxZ + EXISTING_OVERLAP_PAD) continue;
      for (const hc of h.cells) {
        if (Math.abs(c.x - hc.x) < CELL_SIZE && Math.abs(c.z - hc.z) < CELL_SIZE) return false;
      }
    }
    // No overlap with already-incoming hazards (don't double-book a spot)
    for (const inc of incomingHazards) {
      for (const ic of inc.cells) {
        if (Math.abs(c.x - ic.x) < CELL_SIZE && Math.abs(c.z - ic.z) < CELL_SIZE) return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------
// DROPS
// ---------------------------------------------------------------------

/**
 * Schedule a new incoming hazard: hovering 3D block + ground shadow.
 * The block hovers at HOVER_HEIGHT for WARNING_DURATION seconds
 * pulsing its emissive intensity, then falls to ground over
 * DROP_DURATION seconds with ease-in gravity. On impact: incoming is
 * destroyed, a flat floor tile takes its place.
 */
function _spawnIncomingHazard(shape, originX, originZ, rotation, tintHex) {
  const cells = _cellsFor(shape, originX, originZ, rotation);
  const group = new THREE.Group();
  const blockMat = getBlockMat(tintHex);

  // Build one 3D block mesh per cell, positioned at the CELL's final
  // landing spot but elevated to HOVER_HEIGHT. We render shadows on
  // the ground beneath each cell to telegraph the landing zone.
  const blocks = [];
  const shadows = [];
  for (const c of cells) {
    const block = new THREE.Mesh(BLOCK_GEO, blockMat);
    block.position.set(c.x, HOVER_HEIGHT + CELL_SIZE * 0.5, c.z);
    group.add(block);
    blocks.push(block);

    const shadow = new THREE.Mesh(SHADOW_GEO, _shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(c.x, 0.02, c.z);  // just above ground, below tiles
    shadow.scale.setScalar(0.6);
    group.add(shadow);
    shadows.push(shadow);
  }
  scene.add(group);

  incomingHazards.push({
    group,
    blocks,
    shadows,
    cells,
    tintHex,
    shape,
    rotation,
    t: 0,                  // elapsed time since spawn
    landed: false,
  });
}

/**
 * Try to spawn DROP_BATCH_SIZE hazards within the current active ring.
 * The arena is conceptually a square grid; we use Chebyshev distance
 * (max of |x|, |z|) instead of Euclidean to define rings, so the
 * "outermost ring" is the full outer row of grid cells — matching the
 * user's mental model of "fill the whole outside row first."
 *
 * Initial state: _activeRingInner = OUTER_MAX - RING_WIDTH. Only the
 * outermost square-ring of the arena accepts drops. When that ring
 * saturates (RING_SATURATION_THRESHOLD consecutive failed attempts),
 * _activeRingInner is pulled one RING_WIDTH inward, unlocking the
 * next row in. And so on until the ring reaches SAFE_RADIUS_FROM_CENTER.
 */
function _tryDropBatch(chapterIdx, playerPos) {
  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  const tint = chapter.full.grid1;

  // Initialize the active ring on first call after a clear. Outermost
  // ring is [OUTER_MAX - RING_WIDTH, OUTER_MAX] in Chebyshev distance.
  if (_activeRingInner === 0) {
    _activeRingInner = OUTER_MAX - RING_WIDTH;
  }

  let placed = 0;
  let attempts = 0;

  while (placed < DROP_BATCH_SIZE && attempts < 80) {
    attempts++;
    const shape = TETROMINOES[Math.floor(Math.random() * TETROMINOES.length)];

    // Pick an origin inside the active ring. We uniformly sample a
    // point on the perimeter of a square of side 2*_activeRingInner..OUTER_MAX,
    // then snap to grid.
    //
    // Strategy: pick a random Chebyshev "radius" in the ring, then
    // pick a random angle-ish offset by choosing which of the 4 square
    // edges the point lands on.
    const cheb = _activeRingInner + Math.random() * (OUTER_MAX - _activeRingInner);
    const edge = Math.floor(Math.random() * 4);
    const along = (Math.random() * 2 - 1) * cheb;   // position along the chosen edge
    let rawX, rawZ;
    if (edge === 0) { rawX = along;  rawZ = cheb; }          // north
    else if (edge === 1) { rawX = along;  rawZ = -cheb; }    // south
    else if (edge === 2) { rawX = cheb;   rawZ = along; }    // east
    else { rawX = -cheb;  rawZ = along; }                    // west

    // Snap to half-cell grid alignment.
    const x = Math.round(rawX / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
    const z = Math.round(rawZ / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);

    const rot = [0, Math.PI / 2, Math.PI, -Math.PI / 2][Math.floor(Math.random() * 4)];
    const cells = _cellsFor(shape, x, z, rot);
    if (!_isValidPlacement(cells, playerPos)) continue;
    _spawnIncomingHazard(shape, x, z, rot, tint);
    placed++;
  }

  // Saturation tracking. If we couldn't place anything this batch, the
  // ring is filling up — increment the failure counter. When it crosses
  // the threshold, advance inward one ring. If we DID place something,
  // reset the failure counter so only consecutive failures trigger a
  // ring advance.
  if (placed === 0) {
    _ringFailures++;
    if (_ringFailures >= RING_SATURATION_THRESHOLD) {
      _ringFailures = 0;
      const next = _activeRingInner - RING_WIDTH;
      // Stop at the safe center radius — we never fill all the way in.
      if (next >= SAFE_RADIUS_FROM_CENTER) {
        _activeRingInner = next;
      }
    }
  } else {
    _ringFailures = 0;
  }
}

/** Called from an incoming hazard on impact — materializes the floor tile. */
function _landHazard(inc) {
  const group = new THREE.Group();
  const mat = getHazardMat(inc.tintHex);
  const finalCells = [];
  for (const c of inc.cells) {
    const tile = new THREE.Mesh(TILE_GEO, mat);
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
  const pad = CELL_SIZE * 0.5;
  hazards.push({
    group,
    cells: finalCells,
    bbox: { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad },
  });
}

// ---------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------

/**
 * Legacy API — kept so old waves.js callers don't break. Now a no-op:
 * hazards are added progressively in updateHazards instead of all at
 * wave start. waves.js no longer calls this in its current state but
 * it's harmless to leave.
 */
export function spawnHazardsForWave(chapterIdx, localWave) {
  // intentionally empty — progressive spawn handles this
}

/**
 * Waves 1-3: enable progressive dropping. Waves 4+: disable + clear.
 * Called from startWave() and from the hyperdrive reveal hook.
 */
export function setHazardSpawningEnabled(enabled) {
  _spawningEnabled = !!enabled;
  _dropTimer = enabled ? DROP_INTERVAL_SEC * 0.5 : 0;  // first drop ~0.6s in
}

/**
 * Called from waves.updateWaves() every frame while a wave is active.
 * Ticks the drop timer and, when it expires, queues a new batch.
 *
 * @param {number} dt — seconds since last frame
 * @param {number} chapterIdx — for chapter color tint
 * @param {{x,z}} playerPos — don't drop on the player
 * @param {Array<{x,z}>} activeZones — powerup zones to avoid
 */
export function tickHazardSpawning(dt, chapterIdx, playerPos, activeZones) {
  // Always advance the drop animation (even when spawning is off,
  // in-flight drops need to land).
  _advanceIncoming(dt);

  if (!_spawningEnabled) return;
  _blockedZones = activeZones || [];
  _dropTimer -= dt;
  if (_dropTimer <= 0) {
    _dropTimer = DROP_INTERVAL_SEC;
    _tryDropBatch(chapterIdx, playerPos);
  }
}

/** Advance hover + drop animation for every in-flight incoming hazard. */
function _advanceIncoming(dt) {
  for (let i = incomingHazards.length - 1; i >= 0; i--) {
    const inc = incomingHazards[i];
    inc.t += dt;
    const warnEnd = WARNING_DURATION;
    const fallEnd = WARNING_DURATION + DROP_DURATION;

    if (inc.t < warnEnd) {
      // HOVER + WARN PULSE
      // Pulse emissive intensity + scale the shadow so the player
      // sees a clear "here it comes" beacon. Block bobs 0.2u
      // vertically for subtle life.
      const p = inc.t / warnEnd;
      const pulse = 0.75 + 0.5 * Math.sin(inc.t * 12);
      for (const b of inc.blocks) {
        b.position.y = HOVER_HEIGHT + CELL_SIZE * 0.5 + Math.sin(inc.t * 6) * 0.15;
        b.material.opacity = 0.6 + pulse * 0.25;
      }
      // Shadow grows from tiny to full size as the warning completes,
      // giving the visual sense of the block "preparing to drop."
      const sh = 0.4 + p * 0.6;
      for (const s of inc.shadows) s.scale.setScalar(sh);
    } else if (inc.t < fallEnd) {
      // FALL — ease-in (gravity-like acceleration)
      const f = (inc.t - warnEnd) / DROP_DURATION;
      const eased = f * f;
      const y = HOVER_HEIGHT * (1 - eased) + CELL_SIZE * 0.5;
      for (const b of inc.blocks) {
        b.position.y = y;
        b.material.opacity = 0.95;
      }
      // Shadow contracts slightly as block nears ground
      const sh = 1.0 - f * 0.2;
      for (const s of inc.shadows) s.scale.setScalar(sh);
    } else {
      // LAND
      if (!inc.landed) {
        inc.landed = true;
        _landHazard(inc);
        // Remove the incoming group (blocks + shadows) from scene.
        if (inc.group.parent) scene.remove(inc.group);
        incomingHazards.splice(i, 1);
      }
    }
  }
}

/**
 * Wipe all hazards AND any in-flight drops from the scene. Called at
 * chapter change, game over, and at the top of each wave 1-3 so the
 * arena starts clean.
 */
export function clearHazards() {
  for (const h of hazards) {
    if (h.group.parent) scene.remove(h.group);
  }
  hazards.length = 0;
  for (const inc of incomingHazards) {
    if (inc.group.parent) scene.remove(inc.group);
  }
  incomingHazards.length = 0;
  _dropTimer = 0;
  // Reset the outside-in ring state so the next chapter starts fresh
  // at the outermost ring. Without this, a chapter that reached the
  // inner rings in chapter 1 would begin chapter 2 already showing
  // drops near the center — not what we want.
  _activeRingInner = 0;
  _ringFailures = 0;
}

export function isHazardAt(x, z) {
  const half = CELL_SIZE * 0.49;
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

/**
 * Kept as an exported no-op for API compat with waves.js's existing
 * enemy-update path, which calls repelEnemyFromHazards(e, dt) every
 * frame for every enemy. Enemies now walk through hazards unaffected,
 * so this function does nothing.
 *
 * NOT removing the export because that would require also editing every
 * caller in waves.js — a no-op keeps the surface area unchanged.
 */
export function repelEnemyFromHazards(e, dt) {
  // intentionally empty — enemies ignore hazards
}

// No-op — all hazard tick work happens in tickHazardSpawning().
export function updateHazards(dt, timeElapsed) {}
