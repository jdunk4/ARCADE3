// endlessPathing.js — A* pathfinding for Endless Glyphs enemies
//
// Per playtester (Ship 2 of 3): enemies should route around the
// procedural walls instead of pressing against them. This module
// builds a navigation grid from the wall AABBs in endlessWalls.js
// and runs A* per enemy with a tight per-frame budget.
//
// Architecture:
//   1. NAV GRID — a 100×100 boolean array (1u cells) where true =
//      blocked. Built by buildNavGrid() whenever walls regenerate.
//      Walls are inflated by enemy radius (0.5u) so paths leave
//      breathing room around obstacles.
//   2. A* — 8-directional with octile heuristic, binary-heap open set.
//      Returns an array of (x,z) world-space waypoints.
//   3. PER-ENEMY STATE — each enemy carries a `_pathRecord` field:
//        { path, idx, replanT, lastPos, stuckT, lastReplanWave }
//      The pathing module owns this state via a WeakMap keyed by
//      enemy reference (avoids polluting the enemy object).
//   4. REPLAN BUDGET — at most MAX_REPLANS_PER_FRAME enemies recompute
//      paths in a single frame. Others wait — they continue using
//      their last path or fall back to direct chase if none.
//
// Public API:
//   buildNavGrid(walls)       — rebuild the grid from current walls
//   getEnemyMoveTarget(e, gx) — returns {x,z} the enemy should walk
//                                toward this frame, or null if no
//                                pathing is needed. Updates path
//                                state internally + replans on
//                                cadence.
//   clearPathing()            — wipe nav grid + all enemy paths
//
// Performance budget: target <2ms/frame on a 100×100 grid with 60
// enemies. Stagger replans across frames; cap at 8/frame.

import * as THREE from 'three';

// =====================================================================
// CONSTANTS
// =====================================================================

const ARENA_HALF = 50;                  // matches config.js ARENA
const CELL_SIZE = 1.0;                  // world units per grid cell
const GRID_DIM = ARENA_HALF * 2 / CELL_SIZE;  // 100×100
const ENEMY_RADIUS = 0.5;               // for wall inflation
const REPLAN_INTERVAL = 0.5;            // seconds between replans
const STUCK_THRESHOLD_DIST = 0.15;      // moved <this in stuck window → stuck
const STUCK_THRESHOLD_TIME = 0.8;       // seconds of low movement = stuck
const WAYPOINT_REACH_DIST = 0.8;        // close enough to advance to next
const STRAIGHT_LINE_CHECK_STEP = 1.0;   // how often to sample the line
const MAX_REPLANS_PER_FRAME = 8;        // budget cap
const A_STAR_MAX_NODES = 4000;          // hard cap so a hopeless query
                                        // doesn't lock the frame

// 8-direction movement offsets + costs.
const DIRS = [
  { dx:  1, dz:  0, cost: 1 },
  { dx: -1, dz:  0, cost: 1 },
  { dx:  0, dz:  1, cost: 1 },
  { dx:  0, dz: -1, cost: 1 },
  { dx:  1, dz:  1, cost: 1.41421356 },
  { dx:  1, dz: -1, cost: 1.41421356 },
  { dx: -1, dz:  1, cost: 1.41421356 },
  { dx: -1, dz: -1, cost: 1.41421356 },
];

// =====================================================================
// STATE
// =====================================================================

// Boolean[GRID_DIM * GRID_DIM]; true = blocked. Allocated once on
// first buildNavGrid() call. Reused across waves.
let _grid = null;

// Generation counter — bumped on every buildNavGrid call. Each
// enemy's _pathRecord stashes its lastReplanGen; if the gen has
// changed since the path was computed, the path is invalid (walls
// changed underneath it) and a replan is forced.
let _navGen = 0;

// Per-enemy path state. WeakMap keyed by the enemy state object so
// the records GC when enemies die (no manual cleanup needed).
const _pathRecords = new WeakMap();

// Round-robin replan counter — staggers replans across frames so
// not every enemy recomputes on the same tick.
let _replanFrameBudget = 0;

// =====================================================================
// PUBLIC API — NAV GRID
// =====================================================================

/**
 * (Re)build the nav grid from the current wall list. Walls are
 * inflated by ENEMY_RADIUS so paths don't graze corners.
 *
 * @param {Array<{x,z,w,h}>} walls  AABB list from endlessWalls.js
 */
export function buildNavGrid(walls) {
  if (!_grid) _grid = new Uint8Array(GRID_DIM * GRID_DIM);
  else _grid.fill(0);
  _navGen++;

  if (!walls || walls.length === 0) return;

  for (const wall of walls) {
    // Inflate the wall AABB by enemy radius so the path stays clear.
    const minX = wall.x - wall.w * 0.5 - ENEMY_RADIUS;
    const maxX = wall.x + wall.w * 0.5 + ENEMY_RADIUS;
    const minZ = wall.z - wall.h * 0.5 - ENEMY_RADIUS;
    const maxZ = wall.z + wall.h * 0.5 + ENEMY_RADIUS;
    // World → grid cell range.
    const ix0 = Math.max(0, Math.floor((minX + ARENA_HALF) / CELL_SIZE));
    const ix1 = Math.min(GRID_DIM - 1, Math.floor((maxX + ARENA_HALF) / CELL_SIZE));
    const iz0 = Math.max(0, Math.floor((minZ + ARENA_HALF) / CELL_SIZE));
    const iz1 = Math.min(GRID_DIM - 1, Math.floor((maxZ + ARENA_HALF) / CELL_SIZE));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        _grid[iz * GRID_DIM + ix] = 1;
      }
    }
  }
}

/**
 * Wipe nav grid + all enemy paths. Called on mode exit / wave end.
 */
export function clearPathing() {
  _grid = null;
  _navGen++;        // invalidate any cached paths
  // _pathRecords is a WeakMap — no manual clear needed; entries
  // GC when their enemy objects do.
}

// =====================================================================
// PUBLIC API — PER-ENEMY MOVEMENT TARGET
// =====================================================================

/**
 * Returns the world-space (x, z) the enemy should walk toward this
 * frame. Internally manages the enemy's path state — replans on
 * cadence, detects stuck-ness, advances waypoints.
 *
 * Returns null if no pathing is needed (no nav grid, no walls
 * between enemy and target → caller uses direct chase).
 *
 * @param {object} enemy   live enemy state object from enemies array
 * @param {number} goalX   world target X (typically player.pos.x)
 * @param {number} goalZ   world target Z
 * @param {number} dt      frame delta seconds
 * @returns {{x,z}|null}
 */
export function getEnemyMoveTarget(enemy, goalX, goalZ, dt) {
  if (!_grid) return null;
  if (!enemy || !enemy.pos) return null;

  // Cheap shortcut: if there's a clear line of sight to the goal,
  // skip pathing entirely. Saves the A* cost when enemies are in
  // open arena segments (most of the time given sparse walls).
  if (_lineOfSight(enemy.pos.x, enemy.pos.z, goalX, goalZ)) {
    // Discard any stale path so we don't latch onto an old detour.
    const rec = _pathRecords.get(enemy);
    if (rec) rec.path = null;
    return null;     // caller falls through to direct chase
  }

  // Need a path. Check existing state.
  let rec = _pathRecords.get(enemy);
  if (!rec) {
    rec = {
      path: null,
      idx: 0,
      replanT: 0,            // count down; replan at <= 0
      lastPos: { x: enemy.pos.x, z: enemy.pos.z },
      stuckT: 0,
      lastReplanGen: -1,
    };
    _pathRecords.set(enemy, rec);
  }

  // Stuck detection — if movement has stalled, force a replan.
  const movedDx = enemy.pos.x - rec.lastPos.x;
  const movedDz = enemy.pos.z - rec.lastPos.z;
  const moved = Math.sqrt(movedDx * movedDx + movedDz * movedDz);
  if (moved < STUCK_THRESHOLD_DIST * dt * 60) {
    rec.stuckT += dt;
  } else {
    rec.stuckT = 0;
  }
  rec.lastPos.x = enemy.pos.x;
  rec.lastPos.z = enemy.pos.z;

  // Replan triggers:
  //   1. No path yet
  //   2. Replan timer expired
  //   3. Stuck for too long
  //   4. Nav grid regenerated since last plan (walls changed)
  rec.replanT -= dt;
  const needsReplan =
    !rec.path ||
    rec.replanT <= 0 ||
    rec.stuckT >= STUCK_THRESHOLD_TIME ||
    rec.lastReplanGen !== _navGen;

  if (needsReplan && _replanFrameBudget < MAX_REPLANS_PER_FRAME) {
    const newPath = _aStar(enemy.pos.x, enemy.pos.z, goalX, goalZ);
    if (newPath) {
      rec.path = newPath;
      rec.idx = 0;
    } else {
      // A* couldn't find a path — leave the old one alone if any,
      // otherwise null and the caller falls through to direct chase.
    }
    rec.replanT = REPLAN_INTERVAL * (0.85 + Math.random() * 0.3);
    rec.stuckT = 0;
    rec.lastReplanGen = _navGen;
    _replanFrameBudget++;
  }

  if (!rec.path || rec.path.length === 0) return null;

  // Advance through the path: pop waypoints we've reached.
  while (rec.idx < rec.path.length) {
    const wp = rec.path[rec.idx];
    const ddx = wp.x - enemy.pos.x;
    const ddz = wp.z - enemy.pos.z;
    if (ddx * ddx + ddz * ddz < WAYPOINT_REACH_DIST * WAYPOINT_REACH_DIST) {
      rec.idx++;
      continue;
    }
    return { x: wp.x, z: wp.z };
  }

  // Reached end of path — null lets caller direct-chase the goal.
  rec.path = null;
  return null;
}

/**
 * Reset the per-frame replan budget. Called once per frame from the
 * game loop (or just at the top of the enemy update loop).
 */
export function resetReplanBudget() {
  _replanFrameBudget = 0;
}

// =====================================================================
// INTERNAL — LINE OF SIGHT
// =====================================================================

/**
 * Returns true if a straight line from (x1,z1) to (x2,z2) doesn't
 * pass through any blocked cell. Sampled at STRAIGHT_LINE_CHECK_STEP
 * intervals — sub-cell precision isn't needed here because the
 * collision resolver handles fine alignment.
 */
function _lineOfSight(x1, z1, x2, z2) {
  if (!_grid) return true;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.001) return true;
  const steps = Math.ceil(dist / STRAIGHT_LINE_CHECK_STEP);
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 1; i < steps; i++) {
    const x = x1 + sx * i;
    const z = z1 + sz * i;
    if (_isBlocked(x, z)) return false;
  }
  return true;
}

function _isBlocked(worldX, worldZ) {
  const ix = Math.floor((worldX + ARENA_HALF) / CELL_SIZE);
  const iz = Math.floor((worldZ + ARENA_HALF) / CELL_SIZE);
  if (ix < 0 || ix >= GRID_DIM || iz < 0 || iz >= GRID_DIM) return false;
  return _grid[iz * GRID_DIM + ix] === 1;
}

function _cellToWorld(ix, iz) {
  return {
    x: ix * CELL_SIZE - ARENA_HALF + CELL_SIZE * 0.5,
    z: iz * CELL_SIZE - ARENA_HALF + CELL_SIZE * 0.5,
  };
}

function _worldToCell(worldX, worldZ) {
  return {
    ix: Math.max(0, Math.min(GRID_DIM - 1,
      Math.floor((worldX + ARENA_HALF) / CELL_SIZE))),
    iz: Math.max(0, Math.min(GRID_DIM - 1,
      Math.floor((worldZ + ARENA_HALF) / CELL_SIZE))),
  };
}

// =====================================================================
// INTERNAL — A* WITH BINARY HEAP
// =====================================================================
// Reusable scratch buffers — avoids GC churn from per-call allocation.
// Each cell has a closed flag (boolean), gScore (best path cost from
// start), and a parent index (for path reconstruction). Indexed by
// iz * GRID_DIM + ix.

const _aClosed = new Uint8Array(GRID_DIM * GRID_DIM);
const _aGScore = new Float32Array(GRID_DIM * GRID_DIM);
const _aParent = new Int32Array(GRID_DIM * GRID_DIM);

// Binary heap of {idx, fScore}. Pre-allocated for reuse.
const _heap = [];
let _heapSize = 0;

function _heapPush(idx, fScore) {
  let i = _heapSize;
  _heap[i] = { idx, fScore };
  _heapSize++;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (_heap[parent].fScore <= _heap[i].fScore) break;
    const tmp = _heap[parent];
    _heap[parent] = _heap[i];
    _heap[i] = tmp;
    i = parent;
  }
}

function _heapPop() {
  if (_heapSize === 0) return null;
  const top = _heap[0];
  _heapSize--;
  if (_heapSize > 0) {
    _heap[0] = _heap[_heapSize];
    let i = 0;
    while (true) {
      const l = i * 2 + 1, r = i * 2 + 2;
      let best = i;
      if (l < _heapSize && _heap[l].fScore < _heap[best].fScore) best = l;
      if (r < _heapSize && _heap[r].fScore < _heap[best].fScore) best = r;
      if (best === i) break;
      const tmp = _heap[best];
      _heap[best] = _heap[i];
      _heap[i] = tmp;
      i = best;
    }
  }
  return top;
}

/**
 * Run A* from (sx,sz) to (gx,gz). Returns a smoothed waypoint array
 * or null if no path exists / search blew the node budget.
 */
function _aStar(sx, sz, gx, gz) {
  // Snap start + goal to grid. If either is inside a blocked cell
  // (enemy spawned inside a wall, or player went into one), nudge
  // outward to the nearest open cell.
  const start = _findNearestOpenCell(_worldToCell(sx, sz));
  const goal = _findNearestOpenCell(_worldToCell(gx, gz));
  if (!start || !goal) return null;

  const startIdx = start.iz * GRID_DIM + start.ix;
  const goalIdx = goal.iz * GRID_DIM + goal.ix;
  if (startIdx === goalIdx) return null;       // same cell, no path needed

  // Reset scratch buffers. Filling 10000 cells is ~40us — cheap.
  _aClosed.fill(0);
  _aGScore.fill(Infinity);
  _aParent.fill(-1);
  _heapSize = 0;

  _aGScore[startIdx] = 0;
  _heapPush(startIdx, _heuristic(start.ix, start.iz, goal.ix, goal.iz));

  let nodesExpanded = 0;
  while (_heapSize > 0) {
    const node = _heapPop();
    const idx = node.idx;
    if (idx === goalIdx) {
      // Reconstruct + smooth.
      return _reconstructPath(idx, startIdx);
    }
    if (_aClosed[idx]) continue;
    _aClosed[idx] = 1;
    nodesExpanded++;
    if (nodesExpanded > A_STAR_MAX_NODES) return null;

    const ix = idx % GRID_DIM;
    const iz = (idx - ix) / GRID_DIM;
    for (let d = 0; d < DIRS.length; d++) {
      const nx = ix + DIRS[d].dx;
      const nz = iz + DIRS[d].dz;
      if (nx < 0 || nx >= GRID_DIM || nz < 0 || nz >= GRID_DIM) continue;
      const nIdx = nz * GRID_DIM + nx;
      if (_grid[nIdx]) continue;
      // Diagonal corner-cutting: if both perpendicular neighbors are
      // blocked, refuse the diagonal — prevents enemies clipping
      // through wall corners.
      if (DIRS[d].dx !== 0 && DIRS[d].dz !== 0) {
        if (_grid[iz * GRID_DIM + nx] && _grid[nz * GRID_DIM + ix]) continue;
      }
      if (_aClosed[nIdx]) continue;
      const tentativeG = _aGScore[idx] + DIRS[d].cost;
      if (tentativeG < _aGScore[nIdx]) {
        _aGScore[nIdx] = tentativeG;
        _aParent[nIdx] = idx;
        _heapPush(nIdx, tentativeG + _heuristic(nx, nz, goal.ix, goal.iz));
      }
    }
  }
  return null;
}

/**
 * Octile heuristic — admissible for 8-directional movement.
 */
function _heuristic(ax, az, bx, bz) {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return Math.max(dx, dz) + (1.41421356 - 1) * Math.min(dx, dz);
}

function _findNearestOpenCell(cell) {
  if (!cell) return null;
  if (!_grid[cell.iz * GRID_DIM + cell.ix]) return cell;
  // Spiral outward looking for an open cell. Cheap because walls
  // are sparse — open cell almost always within 2-3 steps.
  for (let r = 1; r <= 8; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const ix = cell.ix + dx;
        const iz = cell.iz + dz;
        if (ix < 0 || ix >= GRID_DIM || iz < 0 || iz >= GRID_DIM) continue;
        if (!_grid[iz * GRID_DIM + ix]) return { ix, iz };
      }
    }
  }
  return null;
}

/**
 * Walk parent links from goal back to start, then smooth the path
 * by removing waypoints that are line-of-sight reachable from the
 * previous kept waypoint. This converts a jagged grid path into
 * straighter diagonal hops — much more natural enemy movement.
 */
function _reconstructPath(goalIdx, startIdx) {
  const raw = [];
  let cur = goalIdx;
  while (cur !== -1 && cur !== startIdx) {
    const ix = cur % GRID_DIM;
    const iz = (cur - ix) / GRID_DIM;
    raw.push(_cellToWorld(ix, iz));
    cur = _aParent[cur];
  }
  raw.reverse();

  if (raw.length <= 1) return raw;

  // Funnel-style smoothing: keep waypoint A; if A→C (skipping B) has
  // line of sight, drop B and try A→D, etc. When LOS breaks, commit
  // to the previous kept node and start the next segment.
  const smoothed = [];
  let anchor = raw[0];
  smoothed.push(anchor);
  for (let i = 1; i < raw.length; i++) {
    if (i === raw.length - 1) {
      smoothed.push(raw[i]);
      break;
    }
    const next = raw[i + 1];
    if (!_lineOfSight(anchor.x, anchor.z, next.x, next.z)) {
      // Can't skip raw[i] — commit it.
      smoothed.push(raw[i]);
      anchor = raw[i];
    }
  }
  return smoothed;
}
