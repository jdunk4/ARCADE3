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

// How long (seconds) we've been spawning for the current chapter. Drives
// the outside-in ramp — see _tryDropBatch for how this shrinks the
// "no-drop inner radius" so pieces cluster at the arena edges first and
// only close in toward the center as time passes. Reset by
// setHazardSpawningEnabled(true) and by clearHazards().
let _spawnElapsed = 0;

// Outside-in timing: time (in seconds of active spawning) for the
// inner-no-drop radius to fully collapse from "only outer rim" to
// "center is fair game". 150s gives roughly the duration of waves 1-3
// combined, so the center is only at risk when the player has been
// stalling a long time.
const INWARD_RAMP_SEC = 150;

// Outer rim that drops hug initially. OUTER_MAX is the outer bound of
// the ring (always = ARENA - MIN_EDGE_PADDING so we respect the edge
// clearance). INNER_START is the initial inner radius — drops only
// happen between INNER_START and OUTER_MAX at t=0, then INNER_START
// shrinks toward SAFE_RADIUS_FROM_CENTER as _spawnElapsed grows.
const INNER_START = 30;                    // initial min distance from center

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
 * Try to spawn DROP_BATCH_SIZE hazards. Rejects candidates that fail
 * the validity check (player, zones, overlap). No hard cap on total —
 * the validator's own checks converge on a natural maximum as the
 * arena fills.
 *
 * Outside-in placement: drops are biased toward the arena edges early
 * and allowed closer to center over time. The "inner no-drop radius"
 * starts at INNER_START and collapses linearly toward SAFE_RADIUS_FROM_CENTER
 * over INWARD_RAMP_SEC seconds of spawning. Early game the ring of
 * valid drop positions is just the outer rim; late game the ring opens
 * up all the way to the safe center. Visually: hazards accumulate at
 * the walls first and slowly close in on the player.
 */
function _tryDropBatch(chapterIdx, playerPos) {
  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  const tint = chapter.full.grid1;
  const limit = ARENA - MIN_EDGE_PADDING;

  // Compute the current inner no-drop radius. t=0 → INNER_START (~30u
  // from center = outer 40% of arena). After INWARD_RAMP_SEC seconds of
  // spawning → SAFE_RADIUS_FROM_CENTER (7u, our hard floor). Linear
  // interp — simple and predictable.
  const rampT = Math.min(1, _spawnElapsed / INWARD_RAMP_SEC);
  const innerRadius = INNER_START + (SAFE_RADIUS_FROM_CENTER - INNER_START) * rampT;
  const innerRadiusSq = innerRadius * innerRadius;

  let placed = 0;
  let attempts = 0;
  while (placed < DROP_BATCH_SIZE && attempts < 80) {
    attempts++;
    const shape = TETROMINOES[Math.floor(Math.random() * TETROMINOES.length)];
    // Snap the origin to grid cells (multiples of CELL_SIZE * 0.5) so
    // tiles align to visible grid lines. Tetromino offsets use both
    // half-cell (O/S/L/Z) and whole-cell (I/T) values; snapping to
    // half-cells covers both shapes.
    const rawX = (Math.random() - 0.5) * 2 * limit;
    const rawZ = (Math.random() - 0.5) * 2 * limit;
    const x = Math.round(rawX / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
    const z = Math.round(rawZ / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
    // Outside-in: reject candidates that fall INSIDE the current
    // inner radius. This is done before the full validity check to
    // avoid wasting cycles on cells that would fail anyway.
    if (x * x + z * z < innerRadiusSq) continue;
    const rot = [0, Math.PI / 2, Math.PI, -Math.PI / 2][Math.floor(Math.random() * 4)];
    const cells = _cellsFor(shape, x, z, rot);
    if (!_isValidPlacement(cells, playerPos)) continue;
    _spawnIncomingHazard(shape, x, z, rot, tint);
    placed++;
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
  // Outside-in ramp timer — only advances while actively spawning, so
  // pauses (hyperdrive, wave 4/5 when spawning is off) don't artificially
  // shrink the inner no-drop radius.
  _spawnElapsed += dt;
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
  // Reset the outside-in ramp too. Without this, a player who completes
  // chapter 1 and moves to chapter 2 would skip straight to "inner ring
  // unlocked" because the timer never reset between chapters.
  _spawnElapsed = 0;
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
