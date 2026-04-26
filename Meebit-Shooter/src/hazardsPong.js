// hazardsPong.js — Chapter 5 (ARCTIC, chapterIdx 4) hazard style.
//
// CONCEPT
//   Four paddles slide along the four edges of the arena (north/south/
//   east/west). A single ball bounces between them. Wherever the ball
//   travels along the floor, it leaves a trail of icy-blue hazard tiles.
//   Paddles always catch the ball — they're decoration that confirms
//   the Pong concept; the gameplay-relevant entity is the ball.
//
// RING PROGRESSION
//   The arena is divided into concentric square "rings" of width
//   RING_WIDTH from the outside in. The ball + paddles operate in ONE
//   ring at a time, starting with the outermost. When that ring is
//   90% covered with hazard tiles, ball + paddles "move inward" to
//   the next ring. Continues until innermost ring fills, then halts.
//
// ZONE AVOIDANCE
//   During wave 2 (powerup) the player needs to stand in charging
//   zones (POWER, RADIO, etc.) without dying. While the wave is
//   active, ball-trail tiles are SUPPRESSED in cells that overlap a
//   blocked zone. Once wave 2 ends, the suppression lifts.
//
// API (matches the chapter-style contract used by hazards.js):
//   getCellSize()          — quantization unit (2.5u, matches floor grid)
//   chooseSpawnLocation()  — no-op (style manages its own placement)
//   spawnDelivery()        — no-op
//   tickDeliveries(dt)     — advances ball + paddles, returns new tiles
//   cleanup()              — removes meshes
//   managesOwnSpawns       — true: hazards.js skips its drop-loop
//   getRingInfo()          — for debugging/UI

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA, WAVES_PER_CHAPTER } from './config.js';
import { hitBurst } from './effects.js';
import { isCellInBlockedZone } from './hazards.js';
import { S } from './state.js';

// ---- TUNING ----
const CELL_SIZE = 2.5;                  // matches floor grid
const RING_WIDTH = 8.0;                 // radial thickness of each ring (world units)
const FILL_THRESHOLD = 0.90;            // 90% coverage to advance to next ring

const PADDLE_LENGTH = 10.0;             // along the edge
const PADDLE_THICKNESS = 0.6;           // perpendicular to edge
const PADDLE_HEIGHT = 1.2;              // visible height
const PADDLE_FOLLOW_LERP = 6.0;         // how aggressively paddle tracks ball (per second)

const BALL_RADIUS = 0.55;
const BALL_SPEED_INITIAL = 9.0;         // world u/sec
const BALL_Y = 0.55;                    // hovers slightly above floor

const TILE_TINT = 0x33aaff;             // icy blue

// Paddle inset from arena edge — paddles sit slightly INSIDE the
// arena's outer boundary so they're clearly visible on screen.
// Outer ring's paddles sit at ARENA - PADDLE_INSET.
const PADDLE_INSET = 1.5;

// Inner safe radius — tiny dead-center safe zone. Smaller than before
// (was 8u) so pong tiles can keep advancing inward and fill nearly
// the whole arena. Player still has a small breathing room in the
// exact center for last-stand survival.
const SAFE_INNER = 4.0;

// Maximum number of rings — ARENA - SAFE_INNER divided by RING_WIDTH,
// capped at 8 so a long-running chapter eventually fills the entire
// floor with ice tiles rather than capping at the outer 6 rings.
function _ringCount() {
  return Math.max(1, Math.min(8, Math.floor((ARENA - SAFE_INNER) / RING_WIDTH)));
}

// Outer/inner half-extents for ring N (0 = outermost). Ring N occupies
// the square frame between halfOuter(N) and halfOuter(N+1).
function _ringOuterHalf(n) {
  return ARENA - n * RING_WIDTH;
}
function _ringInnerHalf(n) {
  return _ringOuterHalf(n + 1);
}

// ---- STATE ----
let _initialized = false;
let _paddles = null;          // { N, S, E, W } each = { mesh, pos: number along edge }
let _ball = null;             // { mesh, pos: Vec3, vel: Vec3 }
let _currentRing = 0;
let _coveredCells = new Set();      // "x,z" string of cells already laid by pong (across all rings)
let _ringCellTotalCache = new Map();// ring index → total cell count (for fill ratio)

// Track which wave was active last tick so we can detect wave 2 ending
// (cells laid during wave 2 in zones get suppressed; we don't need to
// retroactively change anything but we want the suppression-active flag
// to be cheap to compute).

function _isInWave2() {
  // wave 2 of chapter 5 = global wave 17 (chapter 4 1-indexed wave 2 =
  // 4*5+2 = 22... wait). Chapter 5 = chapterIdx 4. Wave 22 = chapterIdx
  // 4 wave 2 (since chapterIdx = floor((wave-1)/5), so wave 22 → idx 4
  // wave 22-20 = wave 2 within ch). We use S.wave directly + the
  // localWave derivation.
  if (!S || !S.wave) return false;
  const localWave = ((S.wave - 1) % WAVES_PER_CHAPTER) + 1;
  return localWave === 2;
}

// ---- BUILD HELPERS ----
const _paddleGeo = new THREE.BoxGeometry(PADDLE_LENGTH, PADDLE_HEIGHT, PADDLE_THICKNESS);
const _ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);

function _makePaddle(side) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x88ccff,
    emissive: 0x4488ff,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.3,
  });
  const mesh = new THREE.Mesh(_paddleGeo, mat);
  // Orient the paddle along its edge. Default geometry is X-aligned
  // (length along X). N and S paddles run along X; E and W run along Z.
  if (side === 'E' || side === 'W') {
    mesh.rotation.y = Math.PI / 2;
  }
  return mesh;
}

function _makeBall() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xeaf6ff,
    emissive: 0x66bbff,
    emissiveIntensity: 1.8,
    roughness: 0.2,
    metalness: 0.5,
  });
  const mesh = new THREE.Mesh(_ballGeo, mat);
  return mesh;
}

function _ensureInit() {
  if (_initialized) return;
  _paddles = { N: null, S: null, E: null, W: null };
  for (const side of ['N', 'S', 'E', 'W']) {
    const p = _makePaddle(side);
    scene.add(p);
    _paddles[side] = { mesh: p, pos: 0 };       // pos = position along edge
  }
  _ball = {
    mesh: _makeBall(),
    pos: new THREE.Vector3(0, BALL_Y, 0),
    vel: new THREE.Vector3(),
  };
  scene.add(_ball.mesh);
  _initialized = true;
  _placeForRing(0);
}

// Put paddles + ball in correct positions for the given ring. Ball
// starts at one corner of the ring with a 45° velocity heading inward
// along the ring frame.
function _placeForRing(ringIdx) {
  _currentRing = ringIdx;
  const half = _ringOuterHalf(ringIdx) - PADDLE_INSET;
  // Paddle Y position — centered on PADDLE_HEIGHT/2 above floor
  const paddleY = PADDLE_HEIGHT / 2 + 0.1;
  // North paddle slides along the +z edge (back of arena) — but visually
  // "back" depends on camera. Let's say N = +z edge, S = -z edge,
  // E = +x edge, W = -x edge.
  if (_paddles) {
    _paddles.N.mesh.position.set(0, paddleY, +half);
    _paddles.S.mesh.position.set(0, paddleY, -half);
    _paddles.E.mesh.position.set(+half, paddleY, 0);
    _paddles.W.mesh.position.set(-half, paddleY, 0);
    _paddles.N.pos = 0;
    _paddles.S.pos = 0;
    _paddles.E.pos = 0;
    _paddles.W.pos = 0;
  }
  // Ball starts at a corner of the ring with diagonal velocity
  if (_ball) {
    _ball.pos.set(half * 0.6, BALL_Y, half * 0.6);
    // 45° angle, slight randomization so successive rings don't loop
    // identically.
    const ang = -Math.PI / 4 + (Math.random() - 0.5) * 0.4;
    _ball.vel.set(Math.cos(ang) * BALL_SPEED_INITIAL, 0, Math.sin(ang) * BALL_SPEED_INITIAL);
    _ball.mesh.position.copy(_ball.pos);
  }
}

// Compute total cells in ring N (excluding cells already known to be
// blocked-out — this is per-call because blocked zones can be active
// or not). Caches the unblocked count per ring.
function _ringTotalCells(ringIdx) {
  if (_ringCellTotalCache.has(ringIdx)) return _ringCellTotalCache.get(ringIdx);
  const outer = _ringOuterHalf(ringIdx);
  const inner = _ringInnerHalf(ringIdx);
  let count = 0;
  // Iterate every grid cell whose center lies in the ring frame.
  for (let cx = -outer + CELL_SIZE / 2; cx < outer; cx += CELL_SIZE) {
    for (let cz = -outer + CELL_SIZE / 2; cz < outer; cz += CELL_SIZE) {
      const ax = Math.abs(cx);
      const az = Math.abs(cz);
      const inOuter = (ax < outer && az < outer);
      const inInner = (ax < inner && az < inner);
      if (inOuter && !inInner) count++;
    }
  }
  _ringCellTotalCache.set(ringIdx, count);
  return count;
}

// How many cells in ring N have been covered (laid as hazard tile)?
function _ringCoveredCells(ringIdx) {
  const outer = _ringOuterHalf(ringIdx);
  const inner = _ringInnerHalf(ringIdx);
  let count = 0;
  for (const key of _coveredCells) {
    const parts = key.split(',');
    const cx = parseFloat(parts[0]);
    const cz = parseFloat(parts[1]);
    const ax = Math.abs(cx);
    const az = Math.abs(cz);
    if (ax < outer && az < outer && !(ax < inner && az < inner)) count++;
  }
  return count;
}

// Snap a world coord to the cell-center grid.
function _snap(v) {
  return Math.round(v / CELL_SIZE) * CELL_SIZE;
}
function _cellKey(x, z) {
  return `${_snap(x)},${_snap(z)}`;
}

// ---- TICK (called every frame from hazards.js while this style is active) ----
export function tickDeliveries(dt) {
  // After despawnActive() (end of wave 3), the active hazards are gone
  // but the laid tiles persist. Exit early so nothing re-spawns.
  if (_retired) return [];
  _ensureInit();
  const ringIdx = _currentRing;
  const totalRings = _ringCount();
  if (ringIdx >= totalRings) {
    // All rings filled — pong is done. Just keep ball/paddles where
    // they are and emit nothing.
    return [];
  }

  // ---- BALL PHYSICS ----
  // Move ball by velocity, then handle bouncing off the current ring's
  // outer + inner edges. The OUTER edges (paddles' bands) reflect the
  // ball back inward; the INNER edges reflect it back outward — keeping
  // the ball confined to the active ring.
  const outer = _ringOuterHalf(ringIdx) - PADDLE_INSET;
  const inner = _ringInnerHalf(ringIdx);
  _ball.pos.x += _ball.vel.x * dt;
  _ball.pos.z += _ball.vel.z * dt;

  // Bounce off OUTER edges (paddle plane). When ball crosses |x| = outer
  // or |z| = outer, reverse the velocity component and clamp position.
  if (_ball.pos.x > outer) {
    _ball.pos.x = outer;
    _ball.vel.x = -Math.abs(_ball.vel.x);
  } else if (_ball.pos.x < -outer) {
    _ball.pos.x = -outer;
    _ball.vel.x = Math.abs(_ball.vel.x);
  }
  if (_ball.pos.z > outer) {
    _ball.pos.z = outer;
    _ball.vel.z = -Math.abs(_ball.vel.z);
  } else if (_ball.pos.z < -outer) {
    _ball.pos.z = -outer;
    _ball.vel.z = Math.abs(_ball.vel.z);
  }
  // Bounce off INNER edges. Tricky: we only reflect when the ball is
  // ENTERING the inner square. Inner square is the safe zone — the
  // ball must stay outside it. If both |x| < inner AND |z| < inner,
  // we're inside the safe zone — reflect by pushing back along whichever
  // axis was crossed most recently. Simplification: if |x| < inner,
  // reflect Z velocity to push ball toward an outer edge in Z. If
  // |z| < inner, reflect X velocity. (For simultaneous, reflect both.)
  if (Math.abs(_ball.pos.x) < inner && Math.abs(_ball.pos.z) < inner) {
    // Determine which axis the ball is closer to "exiting" the inner
    // square on, and bounce that axis. Simpler: push back along the
    // axis with smaller absolute value (the one we entered through).
    // Either way works — both reflections is fine and looks lively.
    if (Math.abs(_ball.pos.x) < Math.abs(_ball.pos.z)) {
      // closer to z-axis → push along z
      _ball.pos.z = (_ball.pos.z >= 0 ? inner : -inner);
      _ball.vel.z = -_ball.vel.z;
    } else {
      _ball.pos.x = (_ball.pos.x >= 0 ? inner : -inner);
      _ball.vel.x = -_ball.vel.x;
    }
  }
  _ball.mesh.position.copy(_ball.pos);

  // ---- PADDLE TRACKING ----
  // Each paddle slides along its edge to track the ball's relevant
  // axis. N/S paddles track ball.x; E/W paddles track ball.z.
  const lerpF = 1 - Math.exp(-PADDLE_FOLLOW_LERP * dt);
  const targetX = _ball.pos.x;
  const targetZ = _ball.pos.z;
  // Clamp paddle position along edge so half the paddle stays inside
  // the ring (otherwise it slides off the corner)
  const clampMax = outer - PADDLE_LENGTH / 2;
  const clampMin = -clampMax;
  if (_paddles) {
    _paddles.N.pos += (targetX - _paddles.N.pos) * lerpF;
    _paddles.S.pos += (targetX - _paddles.S.pos) * lerpF;
    _paddles.E.pos += (targetZ - _paddles.E.pos) * lerpF;
    _paddles.W.pos += (targetZ - _paddles.W.pos) * lerpF;
    // Apply to mesh positions, clamped
    _paddles.N.mesh.position.set(Math.max(clampMin, Math.min(clampMax, _paddles.N.pos)), _paddles.N.mesh.position.y, +outer);
    _paddles.S.mesh.position.set(Math.max(clampMin, Math.min(clampMax, _paddles.S.pos)), _paddles.S.mesh.position.y, -outer);
    _paddles.E.mesh.position.set(+outer, _paddles.E.mesh.position.y, Math.max(clampMin, Math.min(clampMax, _paddles.E.pos)));
    _paddles.W.mesh.position.set(-outer, _paddles.W.mesh.position.y, Math.max(clampMin, Math.min(clampMax, _paddles.W.pos)));
  }

  // ---- TILE LAYING ----
  // Every frame, find the cell the ball is currently in. If new and
  // (during wave 2) not in a blocked zone, emit it as a hazard tile.
  const cellX = _snap(_ball.pos.x);
  const cellZ = _snap(_ball.pos.z);
  const key = _cellKey(cellX, cellZ);
  const completed = [];
  if (!_coveredCells.has(key)) {
    // Ring membership check — only count cells that ARE in the current
    // active ring. (Ball can occasionally graze inner-ring cells
    // during a corner bounce but we want to keep "current ring's
    // tiles" accurate.)
    const ax = Math.abs(cellX);
    const az = Math.abs(cellZ);
    const inOuter = (ax < _ringOuterHalf(ringIdx) && az < _ringOuterHalf(ringIdx));
    const inInner = (ax < _ringInnerHalf(ringIdx) && az < _ringInnerHalf(ringIdx));
    if (inOuter && !inInner) {
      // Wave-2 zone suppression — skip if this cell is in a blocked zone
      // (POWER plant, RADIO tower, etc.) AND we're currently in wave 2.
      const suppressed = _isInWave2() && isCellInBlockedZone(cellX, cellZ);
      if (!suppressed) {
        _coveredCells.add(key);
        completed.push({
          cells: [{ x: cellX, z: cellZ }],
          tintHex: TILE_TINT,
          lethal: false,
        });
        try {
          hitBurst({ x: cellX, y: 0.3, z: cellZ }, TILE_TINT, 3);
        } catch (e) {}
      }
    }
  }

  // ---- RING ADVANCE ----
  // Check if the active ring is 90% covered. If so, move ball + paddles
  // inward to the next ring. We re-snapshot total + covered counts
  // each tick — cheap (a few hundred iterations max).
  const total = _ringTotalCells(ringIdx);
  const covered = _ringCoveredCells(ringIdx);
  if (total > 0 && covered / total >= FILL_THRESHOLD) {
    if (ringIdx + 1 < _ringCount()) {
      _placeForRing(ringIdx + 1);
    } else {
      _currentRing = ringIdx + 1;     // sentinel — beyond all rings
    }
  }

  return completed;
}

// ---- API STUBS REQUIRED BY hazards.js ----
export function getCellSize() { return CELL_SIZE; }
export function chooseSpawnLocation() { return null; }
export function spawnDelivery() { return null; }
export const managesOwnSpawns = true;

let _retired = false;

/**
 * Despawn the active hazard meshes (paddles + ball) without clearing
 * the laid hazard tiles. Used at end of wave 3 to retire the active
 * mechanic — player still has to navigate the icy tile pattern but
 * no new tiles are laid from this point forward.
 */
export function despawnActive() {
  if (_paddles) {
    for (const side of ['N', 'S', 'E', 'W']) {
      const p = _paddles[side];
      if (p && p.mesh) {
        if (p.mesh.parent) scene.remove(p.mesh);
        if (p.mesh.material) p.mesh.material.dispose();
      }
    }
  }
  if (_ball && _ball.mesh) {
    if (_ball.mesh.parent) scene.remove(_ball.mesh);
    if (_ball.mesh.material) _ball.mesh.material.dispose();
  }
  _paddles = null;
  _ball = null;
  _retired = true;
}

export function cleanup() {
  if (!_initialized && !_retired) return;
  if (_paddles) {
    for (const side of ['N', 'S', 'E', 'W']) {
      const p = _paddles[side];
      if (p && p.mesh) {
        if (p.mesh.parent) scene.remove(p.mesh);
        if (p.mesh.material) p.mesh.material.dispose();
      }
    }
  }
  if (_ball && _ball.mesh) {
    if (_ball.mesh.parent) scene.remove(_ball.mesh);
    if (_ball.mesh.material) _ball.mesh.material.dispose();
  }
  _paddles = null;
  _ball = null;
  _coveredCells.clear();
  _ringCellTotalCache.clear();
  _currentRing = 0;
  _initialized = false;
  _retired = false;
}

// Optional debug — exposed for HUD/console
export function getRingInfo() {
  return {
    currentRing: _currentRing,
    totalRings: _ringCount(),
    coveredCount: _coveredCells.size,
    ringTotal: _ringTotalCells(_currentRing),
    ringCovered: _ringCoveredCells(_currentRing),
  };
}
