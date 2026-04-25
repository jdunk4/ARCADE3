// Galaga hazard style — chapter 2 visuals.
//
// Red "bugs" fly in from the sky along a swooping curve, hover over a
// target floor tile for ~0.8s (warning telegraph — same duration as
// Tetris), descend and "tag" the tile, then fly back up and despawn.
// The tagged tile becomes a hazard (identical damage behavior to the
// Tetris tiles).
//
// Design contract (matches hazards.js style interface):
//   - getCellSize()            — grid quantization (2.5u, matches Tetris)
//   - cleanup()                — wipe all in-flight bugs
//   - tickDeliveries(dt)       — advance bug state machines, report any
//                                that finished tagging (hazards.js then
//                                places the damage tile)
//   - tickSpawning(dt, ctx)    — maintain the bug pool: if fewer than
//                                GALAGA_TARGET_COUNT bugs are active,
//                                spawn more after a short respawn delay
//   - managesOwnSpawns = true  — tells hazards.js to skip its own drop
//                                loop since we drive spawn cadence here
//
// Bug state machine (per-bug):
//   SPAWNING   (instant)  — bug appears off-arena edge at y=12
//   SWOOPING   (~1.5s)    — Bezier curve to hover point at y=8
//   HOVERING   (0.8s)     — bob in place over target tile (telegraph)
//   DESCENDING (0.4s)     — drop from y=8 to y=0.5 (touches floor)
//   ASCENDING  (~1.2s)    — fly straight up and offscreen, despawn
//
// A bug that reaches the ASCENDING phase has already placed its tile
// (reported via tickDeliveries). If the bug is killed mid-flight (in
// any phase before ASCENDING), the tile is NOT placed — stage 3 will
// add the kill path. This stage simply doesn't kill bugs yet.

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA } from './config.js';
import { hitBurst } from './effects.js';

const CELL_SIZE = 2.5;

// Tuning knobs.
const GALAGA_TARGET_COUNT = 3;         // keep this many bugs active
const RESPAWN_DELAY = 0.6;             // seconds between completions and new spawns
const SWOOP_DURATION = 1.5;
const HOVER_DURATION = 0.8;
const DESCEND_DURATION = 0.4;
const ASCEND_DURATION = 1.2;
const HOVER_ALTITUDE = 8.0;            // bug altitude while hovering over target
const SPAWN_ALTITUDE = 12.0;            // y at which bug enters arena
const TOUCH_ALTITUDE = 0.5;            // y at which bug "taps" the floor
const SATURATION_FAIL_LIMIT = 8;       // after N consecutive spawn failures, advance ring

// Bug geometry — an octahedron body + two wing planes. Geometry allocated
// once; each bug instantiates meshes using the shared geo/mat.
const BUG_BODY_GEO = new THREE.OctahedronGeometry(0.35);
const BUG_WING_GEO = new THREE.PlaneGeometry(0.7, 0.3);
const BUG_EYE_GEO = new THREE.SphereGeometry(0.08, 6, 6);
const _eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

// Material cache (one per chapter tint).
const _bugBodyCache = new Map();
const _bugWingCache = new Map();
function getBugBodyMat(tint) {
  let m = _bugBodyCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.9,
      metalness: 0.2,
      roughness: 0.4,
    });
    _bugBodyCache.set(tint, m);
  }
  return m;
}
function getBugWingMat(tint) {
  let m = _bugWingCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.8,
      metalness: 0.1,
      roughness: 0.6,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
    });
    _bugWingCache.set(tint, m);
  }
  return m;
}

// Module state.
const _bugs = [];           // active bugs
let _respawnTimer = 0;      // seconds until next spawn attempt
let _spawnFailCount = 0;    // consecutive failed validator calls

// Public: tells hazards.js we handle our own spawn pacing.
export const managesOwnSpawns = true;

/** Cell size in world units — hazards.js uses for ring math. */
export function getCellSize() {
  return CELL_SIZE;
}

/**
 * Build a bug mesh group. Returns { group, wings, eye } where wings is
 * the array of wing meshes for animating flapping.
 */
function _buildBugMesh(tint) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(BUG_BODY_GEO, getBugBodyMat(tint));
  body.scale.set(1.0, 1.4, 0.8);
  group.add(body);
  const wingMat = getBugWingMat(tint);
  const wingL = new THREE.Mesh(BUG_WING_GEO, wingMat);
  wingL.position.set(-0.4, 0.05, 0);
  wingL.rotation.y = Math.PI / 2;
  group.add(wingL);
  const wingR = new THREE.Mesh(BUG_WING_GEO, wingMat);
  wingR.position.set(0.4, 0.05, 0);
  wingR.rotation.y = Math.PI / 2;
  group.add(wingR);
  const eye = new THREE.Mesh(BUG_EYE_GEO, _eyeMat);
  eye.position.set(0, 0.0, 0.3);  // front of bug
  group.add(eye);
  return { group, wings: [wingL, wingR], eye };
}

/**
 * Pick a target tile cell inside the active ring. Returns
 * { cells, originX, originZ } if a valid spot is found, else null.
 *
 * For Galaga, each bug places a SINGLE CELL (not a tetromino). This
 * is a deliberate choice: simpler visuals, and the outside-in fill
 * naturally happens as bugs pick spots within the current ring band.
 */
function _chooseTargetCell(ctx) {
  const ringInner = ctx.ringInner;
  const ringOuter = ctx.ringOuter;
  // Random placement within the band: pick a random angle, pick a
  // chebyshev distance in [ringInner, ringOuter], compute the edge point.
  const cheb = ringInner + Math.random() * (ringOuter - ringInner);
  const edge = Math.floor(Math.random() * 4);
  const along = (Math.random() * 2 - 1) * cheb;
  let rawX, rawZ;
  if (edge === 0) { rawX = along;  rawZ = cheb; }
  else if (edge === 1) { rawX = along;  rawZ = -cheb; }
  else if (edge === 2) { rawX = cheb;   rawZ = along; }
  else { rawX = -cheb;  rawZ = along; }
  // Snap to grid.
  const x = Math.round(rawX / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
  const z = Math.round(rawZ / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
  const cells = [{ x, z }];
  if (!ctx.validate(cells, x, z)) return null;
  return { cells, originX: x, originZ: z };
}

/**
 * Pick a spawn point on the arena edge — a random side, at altitude.
 * This is where the bug appears before its swoop.
 */
function _pickSpawnPoint() {
  const side = Math.floor(Math.random() * 4);
  const along = (Math.random() * 2 - 1) * ARENA * 0.8;
  const edge = ARENA + 4;  // just outside the arena
  let x, z;
  if (side === 0) { x = along;  z = edge; }
  else if (side === 1) { x = along;  z = -edge; }
  else if (side === 2) { x = edge;   z = along; }
  else { x = -edge;  z = along; }
  return { x, y: SPAWN_ALTITUDE, z };
}

/**
 * Spawn a new bug targeting the given cell.
 */
function _spawnBug(target, tint) {
  const { group, wings, eye } = _buildBugMesh(tint);
  const spawn = _pickSpawnPoint();
  group.position.set(spawn.x, spawn.y, spawn.z);
  scene.add(group);

  // Bezier control point for the swoop curve — sits "above and halfway"
  // between spawn and hover point, giving a graceful arc descent.
  const hoverX = target.originX;
  const hoverZ = target.originZ;
  const ctrlX = (spawn.x + hoverX) * 0.5 + (Math.random() - 0.5) * 4;
  const ctrlZ = (spawn.z + hoverZ) * 0.5 + (Math.random() - 0.5) * 4;
  const ctrlY = SPAWN_ALTITUDE + 2;  // slight arc up before descending

  _bugs.push({
    group,
    wings,
    eye,
    tint,
    phase: 'SWOOPING',
    t: 0,
    // Trajectory data:
    spawnX: spawn.x, spawnY: spawn.y, spawnZ: spawn.z,
    ctrlX, ctrlY, ctrlZ,
    hoverX, hoverZ,
    target,
    // Hover bob phase — random offset so bugs don't bob in sync.
    bobPhase: Math.random() * Math.PI * 2,
  });
}

/**
 * Public: hazards.js calls this every frame. For Galaga, we use the
 * context to validate spawns and drive our own bug pool.
 */
export function tickSpawning(dt, ctx) {
  // Clean up any bugs that finished ascending (they despawn in tickDeliveries
  // but we do a safety sweep here too in case they escaped).
  // Maintain the target bug count: if under, respawn after a cooldown.
  if (_bugs.length < GALAGA_TARGET_COUNT) {
    _respawnTimer -= dt;
    if (_respawnTimer <= 0) {
      // Try to find a valid target cell. If validator rejects, count
      // failures so we can tell hazards.js the ring is saturated.
      const target = _chooseTargetCell(ctx);
      if (target) {
        _spawnBug(target, ctx.tint);
        _respawnTimer = RESPAWN_DELAY;
        _spawnFailCount = 0;
      } else {
        _spawnFailCount++;
        if (_spawnFailCount >= SATURATION_FAIL_LIMIT) {
          ctx.onRingSaturated && ctx.onRingSaturated();
          _spawnFailCount = 0;
        }
        // Re-try soon — short delay, not full respawn delay.
        _respawnTimer = 0.15;
      }
    }
  }
}

/**
 * Public: advance bug state machines. Returns array of completed
 * deliveries for hazards.js to convert into damage tiles.
 */
export function tickDeliveries(dt) {
  const completed = [];
  for (let i = _bugs.length - 1; i >= 0; i--) {
    const b = _bugs[i];
    b.t += dt;

    // Wing flap — ~20 Hz flapping, visible across all phases.
    const flap = Math.sin(b.t * 30) * 0.4;
    b.wings[0].rotation.z = 0.3 + flap;
    b.wings[1].rotation.z = -0.3 - flap;

    if (b.phase === 'SWOOPING') {
      // Quadratic Bezier from spawn → ctrl → hover point.
      const p = Math.min(1, b.t / SWOOP_DURATION);
      const ep = 1 - p;
      const x = ep * ep * b.spawnX + 2 * ep * p * b.ctrlX + p * p * b.hoverX;
      const y = ep * ep * b.spawnY + 2 * ep * p * b.ctrlY + p * p * HOVER_ALTITUDE;
      const z = ep * ep * b.spawnZ + 2 * ep * p * b.ctrlZ + p * p * b.hoverZ;
      b.group.position.set(x, y, z);
      // Face the direction of motion (approximate — use derivative).
      const dx = b.hoverX - x, dz = b.hoverZ - z;
      if (dx * dx + dz * dz > 0.01) b.group.rotation.y = Math.atan2(dx, dz);
      if (p >= 1) {
        b.phase = 'HOVERING';
        b.t = 0;
      }
    } else if (b.phase === 'HOVERING') {
      // Bob up and down gently; pulse wings slightly (already flapping).
      const bob = Math.sin(b.t * 8 + b.bobPhase) * 0.25;
      b.group.position.set(b.hoverX, HOVER_ALTITUDE + bob, b.hoverZ);
      if (b.t >= HOVER_DURATION) {
        b.phase = 'DESCENDING';
        b.t = 0;
      }
    } else if (b.phase === 'DESCENDING') {
      const p = Math.min(1, b.t / DESCEND_DURATION);
      const eased = p * p;  // ease-in (gravity-like)
      const y = HOVER_ALTITUDE * (1 - eased) + TOUCH_ALTITUDE * eased;
      b.group.position.set(b.hoverX, y, b.hoverZ);
      if (p >= 1) {
        // TOUCH — report tile placement, start ascending.
        completed.push({
          cells: b.target.cells,
          tintHex: b.tint,
        });
        try { hitBurst({ x: b.hoverX, y: 0.3, z: b.hoverZ }, b.tint, 6); } catch (e) {}
        b.phase = 'ASCENDING';
        b.t = 0;
      }
    } else if (b.phase === 'ASCENDING') {
      // Fly straight up and accelerate. Despawn when high enough.
      const p = Math.min(1, b.t / ASCEND_DURATION);
      const eased = p * p;
      const y = TOUCH_ALTITUDE + (SPAWN_ALTITUDE + 4 - TOUCH_ALTITUDE) * eased;
      b.group.position.set(b.hoverX, y, b.hoverZ);
      if (p >= 1) {
        if (b.group.parent) scene.remove(b.group);
        _bugs.splice(i, 1);
      }
    }
  }
  return completed;
}

/** Wipe all in-flight bugs. Called on chapter change / reset. */
export function cleanup() {
  for (const b of _bugs) {
    if (b.group.parent) scene.remove(b.group);
  }
  _bugs.length = 0;
  _respawnTimer = 0;
  _spawnFailCount = 0;
}

/**
 * Stub — Galaga's spawn logic is driven by tickSpawning, not by this.
 * Present for style interface compatibility.
 */
export function chooseSpawnLocation(ringInner, ringOuter, validate) {
  return null;
}

/** Stub — spawn is handled in tickSpawning, not spawnDelivery. */
export function spawnDelivery(spot, tintHex) {
  // no-op
}

/** Diagnostic — active bug count. */
export function getInFlightCount() {
  return _bugs.length;
}

/** Expose bugs list for stage 3/4 (bullet collision). Read-only view
 *  for callers that want to iterate. */
export function getBugs() {
  return _bugs;
}
