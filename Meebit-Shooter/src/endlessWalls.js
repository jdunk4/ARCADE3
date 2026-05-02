// endlessWalls.js — Endless Glyphs procedural wall obstacles
//
// Per playtester: "for each wave create floorplan could be of anything.
// but must be black and white. This floor plan becomes the obstacle the
// player must navigate to destroy enemies. This must never be closed off
// separating a player from an enemy, but provides an interesting [layout]"
//
// Implementation strategy — Ship 1 of 3:
//   1. SPARSE PARTIAL WALLS (this file). Generate a handful of short,
//      isolated wall segments + columns scattered around the arena.
//      Geometry is axis-aligned for simplicity. Connectivity is
//      guaranteed by NEVER placing walls in patterns that close
//      regions — every segment is short, oriented to leave gaps.
//   2. (next ship) A* pathfinding so enemies route around walls.
//   3. (next ship) Wave-end dissolve animation that disassembles the
//      walls into an autoglyph-pattern grid on the floor, then sinks.
//
// API:
//   generateWallsForWave(waveNum)       — builds + adds meshes to scene,
//                                         clears any previous wave's walls
//   clearWalls()                        — disposes all wall meshes + state
//   resolveWallCollision(pos, radius)   — push pos out of any wall AABB,
//                                         caller mutates pos in place
//
// Collision philosophy: walls are AABBs, player + enemy radii are circles.
// Standard "find closest point on rect to circle, push out" resolution.
// Bullets ignore walls entirely (Ship 1 design — bullets fly at chest
// height, walls are only 1.5u tall, no raycast cost).

import * as THREE from 'three';
import { scene } from './scene.js';
import { buildNavGrid, clearPathing } from './endlessPathing.js';

// =====================================================================
// CONSTANTS
// =====================================================================

const WALL_HEIGHT = 1.5;
const WALL_THICKNESS = 0.3;
const WALL_COLOR = 0x0a1424;             // dark navy — reads black on the
                                         // white wave floor without being
                                         // pure black (which kills any
                                         // shading the camera angle gives)
const WALL_TRIM_COLOR = 0x66ccff;        // cyan edge accent matching the
                                         // endless-glyphs lobby aesthetic
const WALL_EMISSIVE_INTENSITY = 0.35;

// Arena half-extent (matches config.js ARENA = 50). Hard-coded here so
// the module doesn't pull config in just for one constant.
const ARENA_HALF = 50;

// Player spawn is at (0, 0, 0). Don't place any wall whose AABB
// intersects this radius — gives the player breathing room at wave
// start so they're not stuck in geometry.
const SPAWN_SAFE_RADIUS = 7;

// Generator parameters — increase wall density slightly per wave so
// later waves feel more architecturally cluttered, but stay sparse
// enough that pathfinding is unnecessary in Ship 1.
//
// PERF: enemies will get stuck against walls until Ship 2 lands A*.
// Per playtester acknowledgment we ship sparse-only first so most
// enemies can still flow around naturally.

// =====================================================================
// STATE
// =====================================================================

// Each wall: { mesh, x, z, w, h }  where x,z is center, w is x-extent,
// h is z-extent. AABB in world space — no rotation in Ship 1 so the
// resolver is straightforward.
let _walls = [];

// =====================================================================
// PUBLIC API
// =====================================================================

/**
 * Build the floorplan for `waveNum`. Disposes any previous wave's walls
 * first (idempotent). Adds new wall meshes to the scene.
 *
 * The seed is derived from waveNum so the same wave always generates
 * the same layout — easier to reason about during dev. If you want
 * fresh layouts per attempt, mix Date.now() into the seed.
 */
export function generateWallsForWave(waveNum) {
  clearWalls();

  // Seeded RNG — Mulberry32, simple and good enough for level generation.
  // We seed off (waveNum * a fixed prime) so the same wave produces the
  // same layout. Easier debugging + repeatable playtesting.
  const rng = _makeRng(waveNum * 1664525 + 1013904223);

  // Wall count scales gently with wave. Wave 1 = 5-7 segments, wave 30
  // = 14-18 segments. Stays sparse — never enough to corner the player.
  const baseSegments = 4 + Math.floor(waveNum * 0.45);
  const segmentCount = baseSegments + Math.floor(rng() * 4);

  // Column count — small solid blocks scattered as cover. ~half the
  // segment count.
  const columnCount = Math.max(2, Math.floor(segmentCount / 2));

  // -- Wall segments --
  // Each segment: pick a random anchor, pick orientation (horizontal or
  // vertical), pick length, place. Reject if it intersects spawn safe
  // zone or arena edge buffer. Limit retries so a bad seed doesn't loop.
  let placed = 0;
  let attempts = 0;
  while (placed < segmentCount && attempts < segmentCount * 6) {
    attempts++;
    const horizontal = rng() < 0.5;
    const length = 4 + rng() * 8;       // 4-12 units long
    // Anchor anywhere in the arena minus an edge buffer.
    const ax = (rng() * 2 - 1) * (ARENA_HALF - 4 - length / 2);
    const az = (rng() * 2 - 1) * (ARENA_HALF - 4 - length / 2);
    const w = horizontal ? length : WALL_THICKNESS;
    const h = horizontal ? WALL_THICKNESS : length;
    if (_intersectsSafeSpawn(ax, az, w, h)) continue;
    // Reject overlap with already-placed walls (with a small buffer
    // so two walls don't kiss and form a corner the player has to
    // squeeze around).
    if (_overlapsAnyWall(ax, az, w + 1.0, h + 1.0)) continue;
    _addWall(ax, az, w, h);
    placed++;
  }

  // -- Columns --
  // Single solid pillars, slightly larger than wall thickness. These
  // give the layout architectural punctuation without forming corridors.
  let placedCols = 0;
  let colAttempts = 0;
  while (placedCols < columnCount && colAttempts < columnCount * 6) {
    colAttempts++;
    const cx = (rng() * 2 - 1) * (ARENA_HALF - 4);
    const cz = (rng() * 2 - 1) * (ARENA_HALF - 4);
    const size = 0.8 + rng() * 0.6;     // 0.8-1.4 unit pillar
    if (_intersectsSafeSpawn(cx, cz, size, size)) continue;
    if (_overlapsAnyWall(cx, cz, size + 1.0, size + 1.0)) continue;
    _addWall(cx, cz, size, size);
    placedCols++;
  }

  // Build the navigation grid from the walls we just placed. Enemies
  // pathfind against this grid in main.js's updateEnemies path-following
  // hook (see endlessPathing.js). Rebuilt every wave so paths stay in
  // sync with the current floorplan.
  buildNavGrid(_walls);
}

/**
 * Remove all wall meshes from scene + dispose geometries/materials.
 * Safe to call when no walls exist.
 */
export function clearWalls() {
  for (const w of _walls) {
    if (w.mesh.parent) w.mesh.parent.remove(w.mesh);
    if (w.mesh.geometry) w.mesh.geometry.dispose();
    if (w.mesh.material) {
      if (Array.isArray(w.mesh.material)) {
        for (const m of w.mesh.material) m.dispose();
      } else {
        w.mesh.material.dispose();
      }
    }
  }
  _walls.length = 0;
  // Tear down the nav grid + invalidate all enemy paths. Without this,
  // enemies that were mid-path when the wave ended would keep chasing
  // stale waypoints into the cleared space.
  clearPathing();
}

/**
 * Push `pos` out of any wall AABB it overlaps. Mutates pos in place.
 * `radius` is the entity's collision radius — typical values 0.5
 * (enemy) to 0.8 (player). Returns true if a collision was resolved
 * (caller may want to dampen velocity).
 *
 * Resolution: for each wall, find the closest point on the AABB to
 * the entity, compute the overlap, push out along the shorter axis.
 * O(walls × entities) per frame — acceptable for ~20 walls × 60
 * enemies = 1200 cheap checks.
 */
export function resolveWallCollision(pos, radius) {
  if (_walls.length === 0) return false;
  let resolved = false;
  for (let i = 0; i < _walls.length; i++) {
    const w = _walls[i];
    // Wall extents (half-widths).
    const hx = w.w * 0.5;
    const hz = w.h * 0.5;
    // Closest point on AABB to entity.
    const cx = Math.max(w.x - hx, Math.min(w.x + hx, pos.x));
    const cz = Math.max(w.z - hz, Math.min(w.z + hz, pos.z));
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= radius * radius) continue;
    // Inside or overlapping — push out.
    const dist = Math.sqrt(distSq);
    if (dist < 0.0001) {
      // Entity is exactly on the AABB surface (or inside, somehow).
      // Push along the shorter axis to the nearest edge.
      const overshootX = hx + radius - Math.abs(pos.x - w.x);
      const overshootZ = hz + radius - Math.abs(pos.z - w.z);
      if (overshootX < overshootZ) {
        pos.x = w.x + (pos.x >= w.x ? hx + radius : -(hx + radius));
      } else {
        pos.z = w.z + (pos.z >= w.z ? hz + radius : -(hz + radius));
      }
    } else {
      // Standard pushout — move along (dx, dz) to the radius boundary.
      const push = (radius - dist) / dist;
      pos.x += dx * push;
      pos.z += dz * push;
    }
    resolved = true;
  }
  return resolved;
}

/**
 * Read-only snapshot of wall AABBs. Used by future systems (Ship 2
 * pathfinding, Ship 3 dissolve animation). Don't mutate.
 */
export function getWalls() {
  return _walls;
}

// =====================================================================
// INTERNAL — MESH BUILDER
// =====================================================================

function _addWall(x, z, w, h) {
  // Main body — dark navy box.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: WALL_COLOR,
    emissive: WALL_COLOR,
    emissiveIntensity: WALL_EMISSIVE_INTENSITY,
    roughness: 0.65,
    metalness: 0.4,
  });
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, WALL_HEIGHT, h),
    bodyMat,
  );
  body.position.set(x, WALL_HEIGHT * 0.5, z);
  body.castShadow = true;
  body.receiveShadow = true;

  // Cyan trim along the top edge — thin emissive strip 0.04u tall sitting
  // ON TOP of the body. Reads as a glowing capstone, gives the otherwise
  // black walls a recognizable Endless Glyphs identity.
  const trimMat = new THREE.MeshBasicMaterial({
    color: WALL_TRIM_COLOR,
    transparent: true,
    opacity: 0.85,
    toneMapped: false,
  });
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.02, 0.06, h + 0.02),
    trimMat,
  );
  trim.position.set(x, WALL_HEIGHT + 0.03, z);

  const group = new THREE.Group();
  group.add(body);
  group.add(trim);
  scene.add(group);

  _walls.push({ mesh: group, x, z, w, h });
}

// =====================================================================
// INTERNAL — VALIDATION
// =====================================================================

function _intersectsSafeSpawn(x, z, w, h) {
  // Conservative check — does the wall's bounding circle reach inside
  // the safe spawn radius? Treats wall as a circle of radius
  // sqrt(w^2 + h^2) / 2. False positives are fine (we'll just retry).
  const wallReach = Math.sqrt(w * w + h * h) * 0.5;
  const cx = x;
  const cz = z;
  const distToOrigin = Math.sqrt(cx * cx + cz * cz);
  return distToOrigin < SPAWN_SAFE_RADIUS + wallReach;
}

function _overlapsAnyWall(x, z, w, h) {
  for (const wall of _walls) {
    if (Math.abs(x - wall.x) < (w + wall.w) * 0.5 &&
        Math.abs(z - wall.z) < (h + wall.h) * 0.5) {
      return true;
    }
  }
  return false;
}

// =====================================================================
// INTERNAL — RNG
// =====================================================================

function _makeRng(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
