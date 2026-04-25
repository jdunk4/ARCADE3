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
import { ARENA, WAVES_PER_CHAPTER } from './config.js';
import { hitBurst } from './effects.js';
import { isCellInBlockedZone, isCellTiled } from './hazards.js';
import { S } from './state.js';

const CELL_SIZE = 2.5;
const SAFE_RADIUS = 8.0;          // ghosts won't enter cells closer than this to center
const EDGE_PAD = 6.0;             // matches MIN_EDGE_PADDING in hazards.js
const GHOST_SPRITE_WORLD_SIZE = 1.6;  // smaller than a cell (2.5u) — looks proportional
const GHOST_SPEED = 1.8;          // cells per second (slowed from original 2.0
                                  // but bumped from previous 1.5 since path
                                  // is now denser — every row, not every other)

// ---- 3D POP-MODE constants ------------------------------------------
// Periodically each ghost rises off the floor to become a 3D hunter
// that walks only on green-tiled cells. They're lethal on contact
// regardless of the player's position; player must stay OFF green
// tiles (or get the ghost vulnerable so they're eatable instead).

const HUNT_ALTITUDE = 1.5;        // Y offset above floor in HUNTING_3D mode
const RISE_DURATION = 1.0;        // seconds to lift from floor to hunt altitude
const DESCEND_DURATION = 0.8;     // seconds to fall back to floor
const HUNT_DURATION = 8.0;        // seconds in 3D hunting mode before descending
const TIME_2D_FIRST = 22.0;       // seconds before any ghost first pops up (stagger)
                                  // Subsequent pops happen on a per-ghost cycle
const TIME_2D_BETWEEN = 28.0;     // seconds in 2D mode between 3D hunts
const HUNT_SPEED = 2.4;           // cells/sec while hunting (faster than 1.8 tile-mode)
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

// ---- Glow halo for 3D-popped ghosts -----------------------------
// Soft additive radial gradient that reads as "this ghost is dangerous"
// when the ghost lifts off the floor. Single shared canvas/texture
// (white-to-transparent radial gradient) — color tint comes from the
// material's .color which multiplies onto the texture.
//
// Visibility: hidden during TILE mode (2D floor-bound ghost = no glow).
// Fades in during RISING, full opacity during HUNTING_3D, fades out
// during DESCENDING. When ghost is VULNERABLE, halo switches to blue.

const HALO_SIZE = GHOST_SPRITE_WORLD_SIZE * 2.2;  // halo extends well beyond sprite
const _haloPlaneGeo = new THREE.PlaneGeometry(HALO_SIZE, HALO_SIZE);
let _haloTextureCache = null;
function _getHaloTexture() {
  if (_haloTextureCache) return _haloTextureCache;
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  // Radial gradient: bright center fading to transparent edge.
  const grad = ctx.createRadialGradient(
    SIZE * 0.5, SIZE * 0.5, 0,
    SIZE * 0.5, SIZE * 0.5, SIZE * 0.5,
  );
  grad.addColorStop(0.00, 'rgba(255,255,255,1.0)');
  grad.addColorStop(0.30, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  _haloTextureCache = tex;
  return tex;
}

function _buildHaloMesh(colorHex) {
  const mat = new THREE.MeshBasicMaterial({
    map: _getHaloTexture(),
    color: colorHex,
    transparent: true,
    opacity: 0.0,                    // start invisible (TILE mode)
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(_haloPlaneGeo, mat);
  // Position halo SLIGHTLY behind the ghost sprite. Since the ghost
  // sprite has rotation.x = -PI/2 (laid flat), positioning the halo
  // at a tiny -y offset puts it just under the sprite — the additive
  // blend ensures the bright center bleeds through and around the
  // sprite as a glow.
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.02;
  return mesh;
}

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
  // Attach the halo as a child so it follows the ghost's position
  // automatically. The halo's opacity is updated each frame in
  // _tick3DPop based on pop-mode. We hold a reference on mesh.userData
  // for fast access from _tick3DPop without a separate lookup.
  const halo = _buildHaloMesh(colorHex);
  mesh.add(halo);
  mesh.userData.halo = halo;
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
  // Every row (CELL_SIZE step) so the ghost covers the full quadrant.
  // Previously rowStep was 2*CELL_SIZE which meant half the rows stayed
  // untouched and the player could camp on those uncovered strips.
  const colStep = CELL_SIZE;           // 2.5u between adjacent column visits
  const rowStep = CELL_SIZE;           // 2.5u between rows — every row walked
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
  // Stagger 3D-pop timers so ghosts don't all rise simultaneously.
  // Ghost 0 pops first at TIME_2D_FIRST; subsequent ghosts pop at
  // increments. With 4 ghosts × ~7s offset that's a 28s staggered
  // cycle through all four.
  const POP_OFFSET_PER_GHOST = 7.0;
  let staggerIdx = 0;
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
      // 3D pop-mode state. Each ghost periodically rises off the floor
      // to become a 3D hunter that walks only on green-tiled cells. The
      // initial "popDelay" is staggered so all four ghosts don't rise
      // simultaneously — staggering creates rolling threat across the
      // chapter.
      popMode: 'TILE',           // 'TILE' | 'RISING' | 'HUNTING_3D' | 'DESCENDING'
      popTimer: TIME_2D_FIRST + staggerIdx * POP_OFFSET_PER_GHOST,
      popY: 0.10,                // current Y (floor = 0.10, hunting = HUNT_ALTITUDE)
      huntTargetX: 0,            // current XZ target during HUNTING_3D
      huntTargetZ: 0,
    });
    staggerIdx++;
  }
  _initialized = true;
}

// Step a ghost through its 3D pop-mode state machine. Called every
// frame from tickDeliveries before the regular tile-laying logic.
//
// State diagram:
//   TILE → (timer expires) → RISING
//   RISING → (1.0s) → HUNTING_3D
//   HUNTING_3D → (8.0s of hunting on green tiles) → DESCENDING
//   DESCENDING → (0.8s) → TILE
//
// EATEN ghosts skip 3D pop (they're invisible / respawning anyway).
// VULNERABLE ghosts CAN still pop into 3D — when blue and 3D, they
// stay vulnerable and Pac-Man can still eat them via XZ proximity.
function _tick3DPop(g, dt) {
  if (g.state === 'EATEN') {
    // EATEN ghosts are invisible — make sure their halo is too.
    if (g.mesh.userData.halo) g.mesh.userData.halo.material.opacity = 0;
    return;
  }
  g.popTimer -= dt;

  // Update halo color to match the ghost's current visual state. When
  // vulnerable, the halo flashes blue; otherwise it matches the ghost's
  // base tint. This is cheap so we do it every tick.
  const halo = g.mesh.userData.halo;
  if (halo) {
    if (g.state === 'VULNERABLE') {
      halo.material.color.setHex(0x66aaff);    // bright blue glow
    } else {
      halo.material.color.set(g.def.color);
    }
  }

  if (g.popMode === 'TILE') {
    // Stay flat on floor (y=0.10). Timer running down to next pop.
    // No glow during 2D mode — ghost is "asleep" / docile-looking.
    g.popY = 0.10;
    g.mesh.position.y = g.popY;
    if (halo) halo.material.opacity = 0;
    if (g.popTimer <= 0) {
      g.popMode = 'RISING';
      g.popTimer = RISE_DURATION;
      // Pick a hunt target — the green tile nearest the player. If the
      // player is currently on a green tile, target THERE.
      _pickHuntTarget(g);
    }
  } else if (g.popMode === 'RISING') {
    // Smoothly lift from floor to hunt altitude over RISE_DURATION.
    const f = 1 - (g.popTimer / RISE_DURATION);
    g.popY = 0.10 + (HUNT_ALTITUDE - 0.10) * Math.min(1, Math.max(0, f));
    g.mesh.position.y = g.popY;
    // Halo fades IN during rise — same fraction f used for altitude.
    if (halo) halo.material.opacity = 0.7 * Math.min(1, Math.max(0, f));
    if (g.popTimer <= 0) {
      g.popMode = 'HUNTING_3D';
      g.popTimer = HUNT_DURATION;
    }
  } else if (g.popMode === 'HUNTING_3D') {
    g.popY = HUNT_ALTITUDE;
    // Bobbing animation — gentle up-down 0.15u
    g.mesh.position.y = HUNT_ALTITUDE + Math.sin(g.popTimer * 4) * 0.15;
    // Halo at full opacity, with a subtle ~2Hz pulse for a "throbbing"
    // alive feel. Range: 0.55 → 0.85.
    if (halo) {
      const pulse = 0.55 + 0.30 * (0.5 + 0.5 * Math.sin(g.popTimer * 4));
      halo.material.opacity = pulse;
      // Slight scale pulse on the halo too — 1.0 → 1.08
      const sc = 1.0 + 0.08 * (0.5 + 0.5 * Math.sin(g.popTimer * 4));
      halo.scale.set(sc, sc, sc);
    }
    // Move toward hunt target on green tiles only.
    _moveHunting(g, dt);
    // Refresh hunt target periodically (each second) so the ghost
    // adapts to player movement.
    if (Math.floor(g.popTimer * 2) !== Math.floor((g.popTimer + dt) * 2)) {
      _pickHuntTarget(g);
    }
    if (g.popTimer <= 0) {
      g.popMode = 'DESCENDING';
      g.popTimer = DESCEND_DURATION;
    }
  } else if (g.popMode === 'DESCENDING') {
    // Smoothly drop from hunt altitude back to floor.
    const f = 1 - (g.popTimer / DESCEND_DURATION);
    g.popY = HUNT_ALTITUDE - (HUNT_ALTITUDE - 0.10) * Math.min(1, Math.max(0, f));
    g.mesh.position.y = g.popY;
    // Halo fades OUT during descent.
    if (halo) {
      halo.material.opacity = 0.7 * (1 - Math.min(1, Math.max(0, f)));
      halo.scale.set(1, 1, 1);
    }
    if (g.popTimer <= 0) {
      g.popMode = 'TILE';
      g.popTimer = TIME_2D_BETWEEN;
      g.mesh.position.y = 0.10;
      if (halo) halo.material.opacity = 0;
    }
  }
}

// Pick a hunt target XZ for this ghost. Strategy: aim at the green-
// tiled cell nearest to the player. If no green tiles exist yet (very
// early in the chapter), fall back to a random nearby cell.
function _pickHuntTarget(g) {
  const px = (S && S.playerPos) ? S.playerPos.x : 0;
  const pz = (S && S.playerPos) ? S.playerPos.z : 0;
  // Search a 12u radius around the player for a green-tiled cell.
  // Walk grid points in spiral-ish order from player outward.
  const SEARCH_RADIUS = 12;
  let best = { x: g.mesh.position.x, z: g.mesh.position.z };
  let bestDist = Infinity;
  for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += CELL_SIZE) {
    for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz += CELL_SIZE) {
      const x = Math.round((px + dx) / CELL_SIZE) * CELL_SIZE;
      const z = Math.round((pz + dz) / CELL_SIZE) * CELL_SIZE;
      if (!isCellTiled(x, z)) continue;
      const ddx = x - px, ddz = z - pz;
      const d = ddx * ddx + ddz * ddz;
      if (d < bestDist) { bestDist = d; best = { x, z }; }
    }
  }
  g.huntTargetX = best.x;
  g.huntTargetZ = best.z;
}

// Move the ghost toward its current huntTarget. Constrained to green-
// tiled cells: when computing the next step, prefer cardinal moves
// that stay on tiled cells. If no tiled cardinal move exists, allow
// any direction toward target (fallback so ghost doesn't get stuck).
function _moveHunting(g, dt) {
  const dx = g.huntTargetX - g.mesh.position.x;
  const dz = g.huntTargetZ - g.mesh.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.1) return;     // already at target
  const speed = HUNT_SPEED * CELL_SIZE;
  const move = Math.min(speed * dt, dist);
  // Try axial moves first (X, then Z) preferring tiled cells.
  let tryX = g.mesh.position.x + Math.sign(dx) * move;
  let tryZ = g.mesh.position.z + Math.sign(dz) * move;
  // Test the X-move first: if it's on a tiled cell, take it.
  if (Math.abs(dx) > 0.1 && isCellTiled(tryX, g.mesh.position.z)) {
    g.mesh.position.x = tryX;
  } else if (Math.abs(dz) > 0.1 && isCellTiled(g.mesh.position.x, tryZ)) {
    // X-move blocked by un-tiled cell, try Z-move
    g.mesh.position.z = tryZ;
  } else {
    // Both axial moves blocked — slide along diagonal toward target
    // anyway (fallback so ghost isn't permanently stuck).
    g.mesh.position.x += (dx / dist) * move;
    g.mesh.position.z += (dz / dist) * move;
  }
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

  // After the powerup wave (in-chapter wave 2) ends, charging zones
  // become fair game for ghost tiling. The depots/silos/wells are
  // either complete or no longer matter for the chapter's progression
  // by then, and the boss wave benefits from reduced safe ground.
  // localWave >= 3 means: hive wave, bonus wave, boss wave can have
  // green tiles painted under structures.
  const localWave = ((S.wave - 1) % WAVES_PER_CHAPTER) + 1;
  const allowZoneCoverage = localWave >= 3;

  // Drain any pending placements first (placed simultaneously with movement).
  for (const g of _ghosts) {
    if (g.pendingPlacement) {
      const { x, z } = g.pendingPlacement;
      const key = _cellKey(x, z);
      // Skip placement if this cell is inside an active charging zone
      // (depot, silo, well) — UNLESS we're past the powerup wave, in
      // which case zones become fair game.
      if (key !== g.lastPlacedKey && (allowZoneCoverage || !isCellInBlockedZone(x, z))) {
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
  // Ghosts in 3D pop modes (RISING / HUNTING_3D / DESCENDING) skip waypoint
  // walking entirely — _tick3DPop handles their movement and they don't
  // lay tiles while popped (they're hunters, not painters).
  const speed = GHOST_SPEED * CELL_SIZE;
  for (const g of _ghosts) {
    if (g.state === 'EATEN') continue;
    if (g.popMode !== 'TILE') continue;     // 3D modes skip waypoint walking
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
      // Same wave-gated blocked-zone check — `allowZoneCoverage` was
      // computed above based on localWave.
      if (key !== g.lastPlacedKey && (allowZoneCoverage || !isCellInBlockedZone(target.x, target.z))) {
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

  // Tick 3D pop-mode for every ghost (state machine handles altitude,
  // halo glow, and hunting movement on green tiles).
  for (const g of _ghosts) {
    _tick3DPop(g, dt);
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
