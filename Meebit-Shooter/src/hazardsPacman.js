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
const GHOST_SPEED = 1.5;          // cells per second along their waypoint path (slowed from 2.0)
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

// ---- Vulnerable ghost textures ---------------------------------------
// Blue (vulnerable) and white (about-to-end warning). Same shape as the
// regular ghost but with mouth + scared eyes drawn in. Single shared
// texture for all vulnerable ghosts (color identity is suspended while
// vulnerable — they all look the same as in classic Pac-Man).

let _blueGhostTexCache = null;
let _whiteGhostTexCache = null;
function _renderVulnerableGhost(bodyColor, mouthColor) {
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);
  // Body — same shape as colored ghosts.
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.moveTo(SIZE * 0.15, SIZE * 0.85);
  ctx.lineTo(SIZE * 0.15, SIZE * 0.50);
  ctx.arc(SIZE * 0.50, SIZE * 0.50, SIZE * 0.35, Math.PI, 0, false);
  ctx.lineTo(SIZE * 0.85, SIZE * 0.85);
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
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.stroke();
  // Scared eyes — small white squares, tightly spaced.
  ctx.fillStyle = mouthColor;
  ctx.fillRect(SIZE * 0.34, SIZE * 0.42, SIZE * 0.08, SIZE * 0.10);
  ctx.fillRect(SIZE * 0.58, SIZE * 0.42, SIZE * 0.08, SIZE * 0.10);
  // Wavy "afraid" mouth — zigzag line across the lower face.
  ctx.strokeStyle = mouthColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(SIZE * 0.30, SIZE * 0.65);
  ctx.lineTo(SIZE * 0.40, SIZE * 0.60);
  ctx.lineTo(SIZE * 0.50, SIZE * 0.65);
  ctx.lineTo(SIZE * 0.60, SIZE * 0.60);
  ctx.lineTo(SIZE * 0.70, SIZE * 0.65);
  ctx.stroke();
  return canvas;
}
function _getBlueGhostTexture() {
  if (_blueGhostTexCache) return _blueGhostTexCache;
  const canvas = _renderVulnerableGhost('#2c3aff', '#ffffff');
  _blueGhostTexCache = new THREE.CanvasTexture(canvas);
  _blueGhostTexCache.needsUpdate = true;
  return _blueGhostTexCache;
}
function _getWhiteGhostTexture() {
  if (_whiteGhostTexCache) return _whiteGhostTexCache;
  const canvas = _renderVulnerableGhost('#ffffff', '#ff2020');
  _whiteGhostTexCache = new THREE.CanvasTexture(canvas);
  _whiteGhostTexCache.needsUpdate = true;
  return _whiteGhostTexCache;
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
  const outer = ARENA - EDGE_PAD;        // 44 with default ARENA=50
  const inner = SAFE_RADIUS;             // 8u — closest ghosts get to center
  // Zigzag/serpentine pattern within the quadrant: walk Z rows from
  // outer to inner, alternating direction each row. This covers the
  // ENTIRE quadrant evenly instead of bee-lining for center along
  // a single inner-X column. Result: ghosts visibly meander through
  // their territory, leaving a denser hazard-tile coverage near the
  // perimeter and gradually working inward.
  //
  // For a +X+Z quadrant, walk:
  //   z=outer:        x: outer → inner   (right to left along top edge)
  //   z=outer-step:   x: inner → outer   (left to right one row down)
  //   z=outer-2*step: x: outer → inner
  //   ... until z reaches inner
  //
  // Each cell visited along an edge becomes a hazard tile. With
  // CELL_SIZE=2.5, this covers ~15 columns × 15 rows = 225 cells per
  // quadrant which is too long for a single chapter at GHOST_SPEED=1.5.
  // To shorten: only walk every OTHER row (rowStep = 2 cells = 5u),
  // giving ~75 cells per quadrant ≈ 50 seconds at 1.5 cells/sec —
  // about right for a 2-3 minute chapter.
  const colStep = CELL_SIZE;           // 2.5u between adjacent column visits
  const rowStep = CELL_SIZE * 2;       // 5u between rows (skip every other)
  let leftToRight = false;             // first row goes outer-to-inner i.e. RIGHT-to-LEFT in +X quadrant
  for (let z = outer; z >= inner; z -= rowStep) {
    const zCoord = signZ * z;
    if (leftToRight) {
      // From inner to outer
      for (let x = inner; x <= outer; x += colStep) {
        waypoints.push({ x: signX * x, z: zCoord });
      }
    } else {
      // From outer to inner
      for (let x = outer; x >= inner; x -= colStep) {
        waypoints.push({ x: signX * x, z: zCoord });
      }
    }
    leftToRight = !leftToRight;
  }
  return waypoints;
}

// Module state — vulnerability + eaten/respawn:
//   _vulnerableTimer   — seconds remaining of vulnerable mode (0 = normal)
//   each ghost gets:
//     state         'NORMAL' | 'VULNERABLE' | 'EATEN'
//     respawnTimer  seconds remaining if EATEN (counts down to respawn)
//     startCorner   { x, z } where ghost respawns if eaten
//     waypointIdxAtEaten — saved waypoint idx so they resume their path

const _ghosts = [];          // { mesh, waypoints, idx, lastPlacedKey, ... }
let _initialized = false;
let _vulnerableTimer = 0;
const VULNERABLE_DURATION = 10.0;
const VULNERABLE_WARNING_AT = 2.0;     // start flicker when this many seconds remain
const EATEN_RESPAWN_DURATION = 15.0;

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
      state: 'NORMAL',
      respawnTimer: 0,
      startCorner: { x: start.x, z: start.z },
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

  // Tick vulnerability timer + handle ghost state machine.
  if (_vulnerableTimer > 0) {
    _vulnerableTimer -= dt;
    if (_vulnerableTimer <= 0) {
      // End of vulnerable mode — restore all NORMAL ghosts to their colors.
      _vulnerableTimer = 0;
      for (const g of _ghosts) {
        if (g.state === 'VULNERABLE') {
          g.state = 'NORMAL';
          g.mesh.material.map = _getGhostTexture(g.def.color);
          g.mesh.material.needsUpdate = true;
        }
      }
    } else if (_vulnerableTimer < VULNERABLE_WARNING_AT) {
      // Last 2s — flicker between blue and white. ~6 Hz strobe.
      const flickerOn = Math.floor(_vulnerableTimer * 6) % 2 === 0;
      const tex = flickerOn ? _getWhiteGhostTexture() : _getBlueGhostTexture();
      for (const g of _ghosts) {
        if (g.state === 'VULNERABLE') {
          g.mesh.material.map = tex;
          g.mesh.material.needsUpdate = true;
        }
      }
    }
  }

  // Handle EATEN ghosts — count down respawn timer; on 0, restore.
  for (const g of _ghosts) {
    if (g.state !== 'EATEN') continue;
    g.respawnTimer -= dt;
    if (g.respawnTimer <= 0) {
      g.state = 'NORMAL';
      g.mesh.position.x = g.startCorner.x;
      g.mesh.position.z = g.startCorner.z;
      g.mesh.visible = true;
      g.mesh.material.map = _getGhostTexture(g.def.color);
      g.mesh.material.needsUpdate = true;
      g.idx = 0;          // restart waypoint path from corner
      g.lastPlacedKey = null;
      g.pendingPlacement = { x: g.startCorner.x, z: g.startCorner.z };
    }
  }

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
  // EATEN ghosts skip movement entirely (they're "ghost-eyes" returning home).
  // VULNERABLE ghosts continue their path normally (they don't flee — Pac-Man
  // chases at higher speed, so the chase still feels meaningful).
  const speed = GHOST_SPEED * CELL_SIZE;
  for (const g of _ghosts) {
    if (g.state === 'EATEN') continue;
    if (g.idx >= g.waypoints.length - 1) continue;
    const target = g.waypoints[g.idx + 1];
    const dx = target.x - g.mesh.position.x;
    const dz = target.z - g.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const move = speed * dt;
    if (move >= dist) {
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
        try { hitBurst({ x: target.x, y: 0.3, z: target.z }, 0x4dff4d, 4); } catch (e) {}
      }
    } else {
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
    // Vulnerable ghosts don't kill the player — that's the reward for
    // eating a power pellet. Eaten ghosts are despawned (not in scene)
    // and trivially can't kill anyone.
    if (g.state !== 'NORMAL') continue;
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

// ---- Vulnerability + eating API (called from pacmanCharacter.js) -----

/**
 * Trigger vulnerable mode for all NORMAL ghosts. Resets the timer if
 * already vulnerable (consecutive pellet eats stack the timer fresh).
 * EATEN ghosts stay eaten — they continue their respawn countdown.
 */
export function setGhostsVulnerable() {
  if (!_initialized) return;
  _vulnerableTimer = VULNERABLE_DURATION;
  const blueTex = _getBlueGhostTexture();
  for (const g of _ghosts) {
    if (g.state === 'NORMAL') {
      g.state = 'VULNERABLE';
      g.mesh.material.map = blueTex;
      g.mesh.material.needsUpdate = true;
    }
  }
}

/**
 * Test if a vulnerable ghost is at this position. If so, mark it EATEN
 * and return the ghost reference (for score popup, etc). Returns null
 * if no vulnerable ghost was at the position.
 */
export function tryEatGhostAt(pos, radius) {
  if (!_initialized || !pos) return null;
  const r2 = radius * radius;
  for (const g of _ghosts) {
    if (g.state !== 'VULNERABLE') continue;
    const dx = g.mesh.position.x - pos.x;
    const dz = g.mesh.position.z - pos.z;
    if (dx * dx + dz * dz < r2) {
      g.state = 'EATEN';
      g.respawnTimer = EATEN_RESPAWN_DURATION;
      g.mesh.visible = false;
      try { hitBurst(g.mesh.position, 0x99ddff, 14); } catch (e) {}
      return g;
    }
  }
  return null;
}

/** Get an array of currently-vulnerable ghosts (for Pac-Man's hunt mode). */
export function getVulnerableGhosts() {
  if (!_initialized) return [];
  const out = [];
  for (const g of _ghosts) {
    if (g.state === 'VULNERABLE') out.push(g);
  }
  return out;
}

/** Return position of a ghost (utility for hunt targeting). */
export function getGhostPos(ghost) {
  return ghost && ghost.mesh ? ghost.mesh.position : null;
}
