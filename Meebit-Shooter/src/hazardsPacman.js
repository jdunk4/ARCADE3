// Pac-Man hazard style — chapter 4 visuals (stage 1: ghosts only).
//
// Four iconic Pac-Man ghosts (Pinky/pink, Blinky/red, Inky/cyan, Clyde/orange)
// occupy the four corners of the arena and patrol inward, leaving green
// hazard tiles in every cell they enter. Each ghost owns one quadrant of
// the arena and spirals through it from outer edge toward center. The
// ghosts visualize the outside-in fill mechanic established in chapters
// 1-3 — instead of mysterious tetrominoes / bugs / pointers placing the
// tiles, the player WATCHES the ghosts walk the arena and "claim" each
// cell. This creates a clear, readable threat: "the ghost is coming for
// that cell next."
//
// CRITICAL GAMEPLAY:
//   - Player walks onto a green hazard tile = standard damage tick (10dps)
//   - Player walks onto/touches a GHOST = instant kill
// So the ghosts are mobile lethal threats, not just tile-placers.
//
// Style interface contract (see hazards.js):
//   - getCellSize()             — 2.5u
//   - cleanup()                 — wipe ghosts + waypoints
//   - tickDeliveries(dt)        — advance ghost positions, return any
//                                 newly-entered cells as completed tiles
//   - tickSpawning(dt, ctx)     — initialize ghosts on first call,
//                                 then no-op (ghosts are persistent)
//   - managesOwnSpawns = true   — hazards.js skips its drop loop
//
// Bonus exports for the lethal-ghost-touch path:
//   - tickGhostTouch(playerPos)  — called from hurtPlayerIfOnHazard or
//                                  similar to test instant-kill collision
//   - getGhosts()                — exposed for debugging and future stages
//
// Future stages (not in this build):
//   stage 2: 3D Pac-Man ball wandering the arena
//   stage 3: power pellets, vulnerability state, ghost-eating loop

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA } from './config.js';
import { hitBurst } from './effects.js';

const CELL_SIZE = 2.5;
const SAFE_RADIUS = 8.0;          // ghosts won't enter cells closer than this to center
const EDGE_PAD = 6.0;             // matches MIN_EDGE_PADDING in hazards.js
const GHOST_SPRITE_WORLD_SIZE = 1.6;  // smaller than a cell (2.5u) — looks proportional
const GHOST_SPEED = 2.0;          // cells per second along their waypoint path
const GHOST_KILL_RADIUS = 0.85;   // distance from ghost center for instant-kill

// Ghost colors. Order matches the standard Pac-Man cast:
const GHOST_DEFS = [
  { name: 'blinky', color: '#ff2020', cornerX:  1, cornerZ:  1 },  // red, top-right
  { name: 'pinky',  color: '#ff8ad8', cornerX: -1, cornerZ:  1 },  // pink, top-left
  { name: 'inky',   color: '#54e5ff', cornerX: -1, cornerZ: -1 },  // cyan, bottom-left
  { name: 'clyde',  color: '#ffaa55', cornerX:  1, cornerZ: -1 },  // orange, bottom-right
];

// ---- Sprite generation -----------------------------------------------
// Each ghost is a flat plane laid on the floor with its top face holding
// a canvas texture rendered to look like a ghost from above. The ghost
// shape: rounded top, two big eyes, zigzag bottom — classic Pac-Man.
//
// Texture cached per color so all ghosts share their pixels.

const _ghostTextureCache = new Map();
function _getGhostTexture(colorHex) {
  if (_ghostTextureCache.has(colorHex)) return _ghostTextureCache.get(colorHex);
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);
  // Body — rounded top + straight sides + zigzag bottom.
  ctx.fillStyle = colorHex;
  ctx.beginPath();
  // Start at bottom-left, go up the left side, arc over the top,
  // down the right side, then zigzag along the bottom back to start.
  ctx.moveTo(SIZE * 0.15, SIZE * 0.85);
  ctx.lineTo(SIZE * 0.15, SIZE * 0.50);
  ctx.arc(SIZE * 0.50, SIZE * 0.50, SIZE * 0.35, Math.PI, 0, false);  // top arc
  ctx.lineTo(SIZE * 0.85, SIZE * 0.85);
  // Zigzag (4 points): from right-bottom in, alternating up/down.
  const zigzagY = SIZE * 0.85;
  const peakY  = SIZE * 0.78;
  ctx.lineTo(SIZE * 0.75, peakY);
  ctx.lineTo(SIZE * 0.65, zigzagY);
  ctx.lineTo(SIZE * 0.55, peakY);
  ctx.lineTo(SIZE * 0.50, zigzagY);
  ctx.lineTo(SIZE * 0.45, peakY);
  ctx.lineTo(SIZE * 0.35, zigzagY);
  ctx.lineTo(SIZE * 0.25, peakY);
  ctx.closePath();
  ctx.fill();
  // Black outline for definition against the green floor.
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.stroke();
  // Two large eyes. Whites first, then dark blue pupils.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(SIZE * 0.40, SIZE * 0.45, SIZE * 0.10, SIZE * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(SIZE * 0.62, SIZE * 0.45, SIZE * 0.10, SIZE * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a3aa0';
  ctx.beginPath();
  ctx.arc(SIZE * 0.42, SIZE * 0.47, SIZE * 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(SIZE * 0.64, SIZE * 0.47, SIZE * 0.05, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  _ghostTextureCache.set(colorHex, tex);
  return tex;
}

const _ghostPlaneGeo = new THREE.PlaneGeometry(GHOST_SPRITE_WORLD_SIZE, GHOST_SPRITE_WORLD_SIZE);

function _buildGhostMesh(colorHex) {
  const mat = new THREE.MeshBasicMaterial({
    map: _getGhostTexture(colorHex),
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(_ghostPlaneGeo, mat);
  mesh.rotation.x = -Math.PI / 2;     // lay flat on floor
  mesh.position.y = 0.10;             // slightly above tile (which sits at y=0.03)
  return mesh;
}

// ---- Waypoint generation ---------------------------------------------
// For each ghost, precompute the full list of cells it will visit in its
// quadrant. The pattern: starting from the corner cell at depth d=0, walk
// the L-shaped boundary of the quadrant. Then increment d and walk the
// next-inner L-shape. Continue until the L collapses or hits the safe zone.
//
// Quadrant shape (for +X+Z, top-right): cells where x ∈ [0, ARENA] and
// z ∈ [0, ARENA]. We generate paths that snake outside-in.
//
// The simplest waypoint pattern that produces clean outside-in fill:
// for each "ring depth" d starting at 0:
//   - Walk along the top row of the ring (z = ARENA-EDGE_PAD - d*CELL_SIZE,
//     x from outer to inner)
//   - Walk down the right column of the ring (x = inner, z decreasing)
// That's an L per ring. After all rings, the quadrant is fully covered.

function _buildWaypointsForQuadrant(signX, signZ) {
  const waypoints = [];
  // Compute outer/inner bounds in cells (coord units).
  const outer = ARENA - EDGE_PAD;        // 44 with default ARENA=50
  // Inner boundary: don't go closer than SAFE_RADIUS from center.
  // Snap to grid (CELL_SIZE = 2.5).
  const innerCellsCount = Math.floor((outer - SAFE_RADIUS) / CELL_SIZE);
  // Iterate ring depths from 0 (outermost) to innerCellsCount-1.
  for (let d = 0; d < innerCellsCount; d++) {
    const ringOuter = outer - d * CELL_SIZE;        // 44, 41.5, 39, ...
    const ringInner = SAFE_RADIUS;
    // Walk the L: along the top edge from ringOuter to ringInner+CELL_SIZE
    // (in X coord), then down the right edge from ringOuter-CELL_SIZE
    // to ringInner (in Z coord).
    // X dimension (top edge):
    for (let xCoord = ringOuter; xCoord >= ringInner; xCoord -= CELL_SIZE) {
      waypoints.push({ x: signX * xCoord, z: signZ * ringOuter });
    }
    // Z dimension (right edge), skipping the corner we just visited:
    for (let zCoord = ringOuter - CELL_SIZE; zCoord >= ringInner; zCoord -= CELL_SIZE) {
      waypoints.push({ x: signX * ringInner, z: signZ * zCoord });
    }
    // After this ring, the next ring is one cell inward. Note that we
    // covered the corner column but not its "inside" L-shape — that's
    // fine because the next iteration starts at the next outer x and
    // z, which is one cell closer to center.
  }
  return waypoints;
}

// ---- State ------------------------------------------------------------

const _ghosts = [];          // { mesh, waypoints, idx, lastPlacedKey }
let _initialized = false;

export const managesOwnSpawns = true;

export function getCellSize() {
  return CELL_SIZE;
}

function _cellKey(x, z) {
  return Math.round(x * 10) + ',' + Math.round(z * 10);
}

function _initGhosts() {
  for (const def of GHOST_DEFS) {
    const waypoints = _buildWaypointsForQuadrant(def.cornerX, def.cornerZ);
    if (waypoints.length === 0) continue;
    const mesh = _buildGhostMesh(def.color);
    const start = waypoints[0];
    mesh.position.x = start.x;
    mesh.position.z = start.z;
    scene.add(mesh);
    _ghosts.push({
      def,
      mesh,
      waypoints,
      idx: 0,                  // index into waypoints[]
      pendingPlacement: null,  // cell to place next (null if already placed)
      lastPlacedKey: null,
    });
  }
  _initialized = true;
}

// ---- Public API: tickSpawning + tickDeliveries + cleanup -------------

export function tickSpawning(dt, ctx) {
  // First call sets up the ghosts and seeds their initial cell. After
  // that, ghosts persist for the chapter — no further spawn work here.
  if (!_initialized) {
    _initGhosts();
    // Seed: each ghost places its starting cell as a hazard immediately
    // so the player sees the ghost AND the hazard tile from frame 1.
    for (const g of _ghosts) {
      g.pendingPlacement = { x: g.mesh.position.x, z: g.mesh.position.z };
    }
  }
}

export function tickDeliveries(dt) {
  if (!_initialized) return [];
  const completed = [];

  // Drain any pending placements first (placed simultaneously with movement).
  for (const g of _ghosts) {
    if (g.pendingPlacement) {
      const { x, z } = g.pendingPlacement;
      const key = _cellKey(x, z);
      if (key !== g.lastPlacedKey) {
        completed.push({
          cells: [{ x, z }],
          tintHex: 0x4dff4d,    // toxic green tile
          lethal: false,
        });
        g.lastPlacedKey = key;
      }
      g.pendingPlacement = null;
    }
  }

  // Advance each ghost along its waypoint path. Ghost moves at GHOST_SPEED
  // cells per second; cell distance = CELL_SIZE so meters/sec = SPEED * CELL_SIZE.
  const speed = GHOST_SPEED * CELL_SIZE;
  for (const g of _ghosts) {
    if (g.idx >= g.waypoints.length - 1) continue;  // reached end of path
    const target = g.waypoints[g.idx + 1];
    const dx = target.x - g.mesh.position.x;
    const dz = target.z - g.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const move = speed * dt;
    if (move >= dist) {
      // Arrived at target. Snap, advance index, schedule placement.
      g.mesh.position.x = target.x;
      g.mesh.position.z = target.z;
      g.idx++;
      const key = _cellKey(target.x, target.z);
      if (key !== g.lastPlacedKey) {
        completed.push({
          cells: [{ x: target.x, z: target.z }],
          tintHex: 0x4dff4d,
          lethal: false,
        });
        g.lastPlacedKey = key;
        // Tiny placement burst — green particles.
        try { hitBurst({ x: target.x, y: 0.3, z: target.z }, 0x4dff4d, 4); } catch (e) {}
      }
    } else {
      // Slide toward target.
      g.mesh.position.x += (dx / dist) * move;
      g.mesh.position.z += (dz / dist) * move;
    }
  }

  return completed;
}

export function cleanup() {
  for (const g of _ghosts) {
    if (g.mesh.parent) scene.remove(g.mesh);
  }
  _ghosts.length = 0;
  _initialized = false;
}

// ---- Lethal collision (player-touch) ---------------------------------
// Called from hazards.js's hurtPlayerIfOnHazard path so that walking
// onto a ghost (regardless of whether the cell has been "tiled" yet) is
// instantly fatal. Returns true if the player is currently colliding
// with any ghost.

export function isPlayerTouchingGhost(playerPos) {
  if (!_initialized) return false;
  const r = GHOST_KILL_RADIUS;
  const r2 = r * r;
  for (const g of _ghosts) {
    const dx = g.mesh.position.x - playerPos.x;
    const dz = g.mesh.position.z - playerPos.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

// Stubs for style-interface compatibility.
export function chooseSpawnLocation(ringInner, ringOuter, validate) { return null; }
export function spawnDelivery(spot, tintHex) {}
export function getInFlightCount() { return _ghosts.length; }

// Exposed for stage 2/3 (Pac-Man's targeting + hunting logic).
export function getGhosts() { return _ghosts; }
