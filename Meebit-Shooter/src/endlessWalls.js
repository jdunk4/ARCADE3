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

// Active trim color — chapter-mapped per wave. Defaults to cyan
// (Endless Glyphs lobby identity color); generateWallsForWave can
// override per wave to match chapter tint.
let _activeTrimColor = WALL_TRIM_COLOR;

// =====================================================================
// PUBLIC API
// =====================================================================

/**
 * Build the floorplan for `waveNum`. Disposes any previous wave's walls
 * first (idempotent). Adds new wall meshes to the scene.
 *
 * @param {number} waveNum  wave number (1-30) — used as RNG seed
 * @param {number} [trimColor] hex color for the wall top trim glow.
 *                  Defaults to cyan (matches Endless Glyphs lobby
 *                  identity). Per playtester: "Can we color the top
 *                  of the walls from cyan to match the chapter tint?"
 *                  endlessGlyphs.js passes the chapter-mapped enemy
 *                  tint per wave.
 */
export function generateWallsForWave(waveNum, trimColor) {
  clearWalls();
  _activeTrimColor = (typeof trimColor === 'number') ? trimColor : WALL_TRIM_COLOR;

  // Seeded RNG — Mulberry32, simple and good enough for level generation.
  // Same wave = same floorplan, easier to reason about during dev.
  const rng = _makeRng(waveNum * 1664525 + 1013904223);

  // ===================================================================
  // FLOORPLAN GENERATOR
  // ===================================================================
  // Per playtester: "I think we need a lot more walls. It should look
  // like a floor plan. No enclosed spaces but this is far too open
  // right now. Lets add 100x more walls. Make it like a house floor
  // plan, but with no closed rooms - there should always be a way to
  // get in every room."
  //
  // Approach: BSP-style recursive subdivision. Start with a single
  // central rectangle ~ 70x70u. At each step, pick a random axis and
  // a random cut position; the cut becomes a wall, but a 3-4u
  // doorway gap is punched through it at a random spot. Recurse on
  // both halves until rooms are small enough.
  //
  // Connectivity invariant: every cut wall has at least one doorway,
  // and rooms on either side are accessible through it. Player can
  // always reach every room.

  // Outer arena bounds — leave a buffer so walls don't kiss the edge.
  const AREA_HALF_X = ARENA_HALF - 5;
  const AREA_HALF_Z = ARENA_HALF - 5;

  // Recursive room subdivider. Each call places walls for the cuts
  // it makes inside the given rectangle.
  // bounds = { x0, z0, x1, z1 } in world coords
  // depth = 0 at root, increments each recursion
  const MIN_ROOM_DIM = 8;          // smallest room edge before stop subdividing
  const MAX_DEPTH = 6;             // hard cap; 2^6 = 64 leaf rooms max

  function subdivide(bounds, depth) {
    const w = bounds.x1 - bounds.x0;
    const h = bounds.z1 - bounds.z0;
    if (depth >= MAX_DEPTH) return;
    if (w < MIN_ROOM_DIM * 2 && h < MIN_ROOM_DIM * 2) return;

    // Decide axis: split the longer dim if it's much longer, otherwise
    // 50/50 chance per axis.
    let splitVertical;          // true = vertical cut (constant x)
    if (w > h * 1.4) splitVertical = true;
    else if (h > w * 1.4) splitVertical = false;
    else splitVertical = rng() < 0.5;

    if (splitVertical && w < MIN_ROOM_DIM * 2) splitVertical = false;
    if (!splitVertical && h < MIN_ROOM_DIM * 2) splitVertical = true;

    // Pick cut position with bias toward the middle (40-60% of dim)
    // so rooms are reasonably sized.
    if (splitVertical) {
      const cutX = bounds.x0 + w * (0.35 + rng() * 0.30);
      // Build the wall along the cut, but with a doorway gap.
      _placeWallWithDoorway(
        cutX, bounds.z0,
        cutX, bounds.z1,
        rng,
        true,     // vertical wall
      );
      subdivide({ x0: bounds.x0, z0: bounds.z0, x1: cutX, z1: bounds.z1 }, depth + 1);
      subdivide({ x0: cutX, z0: bounds.z0, x1: bounds.x1, z1: bounds.z1 }, depth + 1);
    } else {
      const cutZ = bounds.z0 + h * (0.35 + rng() * 0.30);
      _placeWallWithDoorway(
        bounds.x0, cutZ,
        bounds.x1, cutZ,
        rng,
        false,    // horizontal wall
      );
      subdivide({ x0: bounds.x0, z0: bounds.z0, x1: bounds.x1, z1: cutZ }, depth + 1);
      subdivide({ x0: bounds.x0, z0: cutZ, x1: bounds.x1, z1: bounds.z1 }, depth + 1);
    }
  }

  // Recurse from the full arena rect.
  subdivide({
    x0: -AREA_HALF_X, z0: -AREA_HALF_Z,
    x1:  AREA_HALF_X, z1:  AREA_HALF_Z,
  }, 0);

  // Punch out any walls that landed inside the spawn safe zone. We
  // do this AFTER subdivision because doing it during placement
  // would break the room structure. Walls fully inside the safe
  // zone are dropped; walls partially overlapping have a notch
  // removed.
  _purgeSpawnZoneWalls();

  // Build the navigation grid from the walls we just placed. Enemies
  // pathfind against this grid in main.js's updateEnemies path-following
  // hook (see endlessPathing.js). Rebuilt every wave so paths stay in
  // sync with the current floorplan.
  buildNavGrid(_walls);
}

/**
 * Place a wall along the given line segment with a doorway gap
 * punched through it. A "wall" here is split into 1-3 sub-segments
 * (always at least 2 unless the segment is very short) with a 3-4u
 * gap between sub-segments at a random position along the wall.
 *
 * @param {number} x0,z0 — start of the segment
 * @param {number} x1,z1 — end of the segment
 * @param {Function} rng — seeded random fn
 * @param {boolean} vertical — true if the wall is vertical (x0===x1)
 */
function _placeWallWithDoorway(x0, z0, x1, z1, rng, vertical) {
  const length = vertical ? Math.abs(z1 - z0) : Math.abs(x1 - x0);
  if (length < 4) {
    // Too short for a useful wall + doorway; place as solid.
    _placeWallSegment(x0, z0, x1, z1, vertical);
    return;
  }

  // Doorway specs:
  //   gap width: 3-4 world units (player + enemy clearance)
  //   gap position: 30-70% along the wall, biased away from corners
  const GAP = 3 + rng() * 1;
  const minStart = 2;
  const maxStart = length - GAP - 2;
  const gapStart = minStart + rng() * Math.max(0, maxStart - minStart);
  const gapEnd = gapStart + GAP;

  // Build two sub-segments around the gap.
  if (vertical) {
    const z = Math.min(z0, z1);
    const xMid = x0;
    // Segment A from z start to z + gapStart
    _placeWallSegment(xMid, z, xMid, z + gapStart, true);
    // Segment B from z + gapEnd to far end
    _placeWallSegment(xMid, z + gapEnd, xMid, z + length, true);

    // 30% chance of a SECOND doorway in long walls (>20u) for added
    // connectivity — doesn't violate the single-region invariant
    // since we only ADD passages, never enclose.
    if (length > 20 && rng() < 0.3) {
      // Re-cut sub-segment B if it's long enough.
      const subLen = length - gapEnd;
      if (subLen > 8) {
        const gap2Start = z + gapEnd + 2 + rng() * (subLen - GAP - 4);
        const gap2End = gap2Start + GAP;
        // Drop the previously-placed B (last wall in _walls) and
        // replace with two segments.
        const lastWall = _walls[_walls.length - 1];
        if (lastWall) {
          if (lastWall.mesh.parent) lastWall.mesh.parent.remove(lastWall.mesh);
          _disposeWallMesh(lastWall);
          _walls.pop();
        }
        _placeWallSegment(xMid, z + gapEnd, xMid, gap2Start, true);
        _placeWallSegment(xMid, gap2End, xMid, z + length, true);
      }
    }
  } else {
    const x = Math.min(x0, x1);
    const zMid = z0;
    _placeWallSegment(x, zMid, x + gapStart, zMid, false);
    _placeWallSegment(x + gapEnd, zMid, x + length, zMid, false);
    if (length > 20 && rng() < 0.3) {
      const subLen = length - gapEnd;
      if (subLen > 8) {
        const gap2Start = x + gapEnd + 2 + rng() * (subLen - GAP - 4);
        const gap2End = gap2Start + GAP;
        const lastWall = _walls[_walls.length - 1];
        if (lastWall) {
          if (lastWall.mesh.parent) lastWall.mesh.parent.remove(lastWall.mesh);
          _disposeWallMesh(lastWall);
          _walls.pop();
        }
        _placeWallSegment(x + gapEnd, zMid, gap2Start, zMid, false);
        _placeWallSegment(gap2End, zMid, x + length, zMid, false);
      }
    }
  }
}

/**
 * Place a single AABB wall segment. Vertical walls have width
 * WALL_THICKNESS, horizontal walls have height WALL_THICKNESS.
 */
function _placeWallSegment(x0, z0, x1, z1, vertical) {
  if (vertical) {
    const length = Math.abs(z1 - z0);
    if (length < 0.5) return;
    const cx = x0;
    const cz = (z0 + z1) * 0.5;
    _addWall(cx, cz, WALL_THICKNESS, length);
  } else {
    const length = Math.abs(x1 - x0);
    if (length < 0.5) return;
    const cx = (x0 + x1) * 0.5;
    const cz = z0;
    _addWall(cx, cz, length, WALL_THICKNESS);
  }
}

/**
 * Remove walls that overlap the spawn safe zone (8u radius from
 * arena origin). Player spawns at (0,0,0) so they can't be inside
 * geometry on wave start.
 */
function _purgeSpawnZoneWalls() {
  for (let i = _walls.length - 1; i >= 0; i--) {
    const w = _walls[i];
    // Closest point on AABB to origin.
    const hx = w.w * 0.5;
    const hz = w.h * 0.5;
    const cx = Math.max(w.x - hx, Math.min(w.x + hx, 0));
    const cz = Math.max(w.z - hz, Math.min(w.z + hz, 0));
    const distSq = cx * cx + cz * cz;
    if (distSq < SPAWN_SAFE_RADIUS * SPAWN_SAFE_RADIUS) {
      // Remove from scene + disposal.
      if (w.mesh.parent) w.mesh.parent.remove(w.mesh);
      _disposeWallMesh(w);
      _walls.splice(i, 1);
    }
  }
}

function _disposeWallMesh(wall) {
  wall.mesh.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    if (node.material) {
      if (Array.isArray(node.material)) {
        for (const m of node.material) m.dispose();
      } else {
        node.material.dispose();
      }
    }
  });
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
  // Color is _activeTrimColor — set per wave by generateWallsForWave to
  // match the wave's chapter tint.
  const trimMat = new THREE.MeshBasicMaterial({
    color: _activeTrimColor,
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
