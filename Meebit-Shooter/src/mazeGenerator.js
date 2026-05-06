// ============================================================
// MAZE GENERATOR — Endless Glyphs slide-fill maze.
//
// Cell-based walls (cell.kind ∈ 'floor' | 'wall'). Walls occupy a
// whole tile; the slide animator stops when the next cell would be a
// wall. The arena boundary is a ring of wall cells.
//
// Layout philosophy — open, with sparse obstacles. Wave 1 is almost
// an empty arena (a handful of single-cell pillars); later waves
// add more wall cells to build corridors and pockets.
//
// Glyphs are scattered collectibles on floor cells. Picking up every
// glyph clears the wave.
//
// Mining BLOCKS sit on floor cells too — they're impassable until
// the player shoots them, then become floor.
//
// Kill zones sit on floor cells; touching one retries the wave.
//
// MazeData = {
//   cols, rows,
//   cells: [{kind: 'floor'|'wall'}],   // flat row-major
//   spawn: {col, row},
//   glyphs: [{col, row}],
//   miningBlocks: [{col, row, hp, hpMax, broken}],
//   killZones: [{col, row, kind}],
//   seed, config, cellSize,
// }
// ============================================================

const CELL_SIZE = 5.0;
export { CELL_SIZE };

// Legacy bitmask exports — main.js / stratagemTurret still import
// these, but they're no longer used by the renderer's collision
// path. Kept as zero so any stray reference is a no-op.
export const WALL_N = 1;
export const WALL_E = 2;
export const WALL_S = 4;
export const WALL_W = 8;

const MINING_BLOCK_HP = 25;

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- WAVE CONFIG ----
export function getMazeConfig(waveNum) {
  const w = Math.max(1, waveNum | 0);

  const cols = 19;
  const rows = 19;

  // Glyphs — start at 5, climb modestly.
  const glyphCount = Math.min(9, 5 + Math.floor((w - 1) / 2));

  // Mining blocks.
  let miningBlockCount;
  if (w <= 3) miningBlockCount = 0;
  else if (w <= 6) miningBlockCount = 2;
  else if (w <= 9) miningBlockCount = 4;
  else miningBlockCount = 6;

  // Kill zones.
  let killZoneCount;
  if (w <= 3) killZoneCount = 0;
  else if (w <= 6) killZoneCount = 1 + Math.floor(rng01(w) * 2);
  else if (w <= 9) killZoneCount = 3 + Math.floor(rng01(w) * 3);
  else killZoneCount = 6 + Math.floor(rng01(w) * 3);

  // Decor (chapter 1) enemies — purely visual obstacles destroyed by
  // sliding through them. None on wave 1 so the player learns the
  // movement model first; sprinkle a few from wave 2 onward.
  let decorEnemyCount;
  if (w <= 1) decorEnemyCount = 0;
  else if (w <= 4) decorEnemyCount = 2;
  else if (w <= 8) decorEnemyCount = 4;
  else decorEnemyCount = 6;

  return {
    cols, rows,
    glyphCount,
    miningBlockCount,
    killZoneCount,
    decorEnemyCount,
    waveNum: w,
  };
}

function rng01(w) {
  const x = Math.sin(w * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// ---- GENERATE MAZE ----
export function generateMaze(waveNum) {
  const config = getMazeConfig(waveNum);
  const { cols, rows } = config;
  const seed = waveNum * 7919 + 12345;
  const rng = mulberry32(seed);

  // Initialize: boundary ring is wall, interior is floor.
  const cells = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const onBorder = (c === 0 || c === cols - 1 || r === 0 || r === rows - 1);
      cells[r * cols + c] = { kind: onBorder ? 'wall' : 'floor' };
    }
  }
  const idx = (c, r) => r * cols + c;

  // Player spawn — top-left logical cell of the maze. The thick-wall
  // generator below treats this as logical (0, 0).
  const spawn = { col: 1, row: 1 };

  // ---- LAYOUT: THICK-WALL PERFECT MAZE ----
  // Reference: classic mobile slide-fill maze games (the kind with
  // 1-cell-wide wood-floor corridors carved between blocky walls).
  // Generation:
  //   1. Start with the entire interior as wall.
  //   2. Pick a 9x9 "logical" maze grid; each logical cell maps to
  //      a (2c+1, 2r+1) cell in the 19x19 render grid. Carve those
  //      logical cells into floor.
  //   3. Recursive-backtracker through the logical grid; for each
  //      passage carved, also flip the cell BETWEEN the two
  //      logical cells into floor.
  //   4. Optionally knock out N extra walls (creates loops). Loop
  //      count varies by wave so the layout is always different.
  //
  // Result: a perfect maze with 1-cell-wide corridors. Walls are at
  // least 1 cell thick everywhere. The slide animator can reach
  // every floor cell — sliding into any corridor stops at the next
  // wall, and every floor cell sits on at least one slide path.
  const w = config.waveNum;
  const LOGICAL_N = 9;     // (LOGICAL_N * 2 + 1) = 19, matches our cols/rows

  // Step 1 — fill interior with walls (boundaries already are walls).
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      cells[idx(c, r)].kind = 'wall';
    }
  }

  // Step 2 — carve logical cells.
  const logicalToCell = (lc, lr) => idx(2 * lc + 1, 2 * lr + 1);
  for (let lr = 0; lr < LOGICAL_N; lr++) {
    for (let lc = 0; lc < LOGICAL_N; lc++) {
      cells[logicalToCell(lc, lr)].kind = 'floor';
    }
  }

  // Step 3 — recursive backtracker.
  const visited = new Uint8Array(LOGICAL_N * LOGICAL_N);
  const startLC = 0, startLR = 0;
  visited[startLR * LOGICAL_N + startLC] = 1;
  const stack = [[startLC, startLR]];
  const DIRS = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
  ];
  while (stack.length > 0) {
    const [lc, lr] = stack[stack.length - 1];
    const candidates = [];
    for (const [dlc, dlr] of DIRS) {
      const nlc = lc + dlc, nlr = lr + dlr;
      if (nlc < 0 || nlc >= LOGICAL_N || nlr < 0 || nlr >= LOGICAL_N) continue;
      if (visited[nlr * LOGICAL_N + nlc]) continue;
      candidates.push([nlc, nlr, dlc, dlr]);
    }
    if (candidates.length === 0) {
      stack.pop();
    } else {
      const [nlc, nlr, dlc, dlr] = candidates[Math.floor(rng() * candidates.length)];
      // Carve the wall cell between (lc,lr) and (nlc,nlr) into floor.
      const passageC = 2 * lc + 1 + dlc;
      const passageR = 2 * lr + 1 + dlr;
      cells[idx(passageC, passageR)].kind = 'floor';
      visited[nlr * LOGICAL_N + nlc] = 1;
      stack.push([nlc, nlr]);
    }
  }

  // Step 4 — extra openings (loops). Each opening is verified to
  // keep every floor cell slide-reachable (a perfect maze is fully
  // slide-fillable, but adding loops can create open pockets where
  // the slide overshoots a cell with no way to stop on it). Any
  // opening that orphans a cell from the slide-BFS is reverted.
  let loopOpenings;
  if (w <= 2) loopOpenings = 6;
  else if (w <= 5) loopOpenings = 4;
  else if (w <= 8) loopOpenings = 2;
  else loopOpenings = 1;

  for (let i = 0; i < loopOpenings; i++) {
    let attempts = 0;
    while (attempts < 60) {
      attempts++;
      const c = 1 + Math.floor(rng() * (cols - 2));
      const r = 1 + Math.floor(rng() * (rows - 2));
      // Must be on a passage line — exactly one of (c,r) is odd.
      const cOdd = (c & 1) === 1;
      const rOdd = (r & 1) === 1;
      if (cOdd === rOdd) continue;
      if (cells[idx(c, r)].kind !== 'wall') continue;
      cells[idx(c, r)].kind = 'floor';
      if (!_isAllFloorSlideReachable(cells, cols, rows, spawn)) {
        // The opening introduced an unreachable pocket. Revert.
        cells[idx(c, r)].kind = 'wall';
        continue;
      }
      break;
    }
  }

  // Spawn cell guaranteed floor (it's logical (0,0), already carved
  // by Step 2 — defensive assignment in case future tweaks land
  // elsewhere).
  cells[idx(spawn.col, spawn.row)].kind = 'floor';

  // ---- COLLECT FLOOR CELLS for glyph / block / kill-zone placement ----
  const floorCells = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (cells[idx(c, r)].kind === 'floor') {
        floorCells.push({ col: c, row: r });
      }
    }
  }
  const used = new Set([idx(spawn.col, spawn.row)]);

  const pickFloor = (minDistFromSpawn = 0, minSpread = 0, existing = []) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const f = floorCells[Math.floor(rng() * floorCells.length)];
      const k = idx(f.col, f.row);
      if (used.has(k)) continue;
      const dSpawn = Math.abs(f.col - spawn.col) + Math.abs(f.row - spawn.row);
      if (dSpawn < minDistFromSpawn) continue;
      let tooClose = false;
      for (const e of existing) {
        if (Math.abs(e.col - f.col) + Math.abs(e.row - f.row) < minSpread) {
          tooClose = true; break;
        }
      }
      if (tooClose) continue;
      used.add(k);
      return f;
    }
    return null;
  };

  // ---- GLYPHS ----
  const glyphs = [];
  for (let i = 0; i < config.glyphCount; i++) {
    const f = pickFloor(3, 2, glyphs);
    if (f) glyphs.push({ col: f.col, row: f.row });
  }

  // ---- MINING BLOCKS ----
  const miningBlocks = [];
  for (let i = 0; i < config.miningBlockCount; i++) {
    const f = pickFloor(4, 3, miningBlocks);
    if (!f) break;
    miningBlocks.push({
      col: f.col, row: f.row,
      hp: MINING_BLOCK_HP, hpMax: MINING_BLOCK_HP, broken: false,
    });
  }

  // ---- KILL ZONES ----
  const killZones = [];
  if (config.killZoneCount > 0) {
    const chapter = Math.floor((waveNum - 1) / 10) % 6;
    const kind = (chapter <= 1) ? 'rune' : (chapter <= 3) ? 'mine' : 'ghost';
    for (let i = 0; i < config.killZoneCount; i++) {
      const f = pickFloor(3, 2, killZones);
      if (!f) break;
      killZones.push({ col: f.col, row: f.row, kind });
    }
  }

  // ---- DECOR ENEMIES ----
  // Static visual obstacles that get destroyed by a slide passing
  // over them. Never damage the player.
  const decorEnemies = [];
  for (let i = 0; i < (config.decorEnemyCount | 0); i++) {
    const f = pickFloor(2, 1, decorEnemies);
    if (!f) break;
    decorEnemies.push({ col: f.col, row: f.row });
  }

  return {
    cols, rows, cells,
    spawn,
    glyphs,
    miningBlocks,
    killZones,
    decorEnemies,
    seed,
    config,
    cellSize: CELL_SIZE,
  };
}

// ---- SLIDE REACHABILITY ----
// Stronger than walking-connectivity: simulates the slide-fill
// physics so we can verify every floor cell sits on at least one
// possible slide path. The player's slide always travels until a
// wall, so a perfect maze + a stray loop opening can leave a cell
// that walks-connect but the slide can never stop on it (or pass
// over it).
function _isAllFloorSlideReachable(cells, cols, rows, spawn) {
  const idx = (c, r) => r * cols + c;
  const startKey = idx(spawn.col, spawn.row);
  if (cells[startKey].kind !== 'floor') return false;
  const visitedStops = new Uint8Array(cols * rows);
  const filled = new Uint8Array(cols * rows);
  visitedStops[startKey] = 1;
  filled[startKey] = 1;
  const queue = [{ c: spawn.col, r: spawn.row }];
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  while (queue.length > 0) {
    const { c, r } = queue.shift();
    for (const [dc, dr] of DIRS) {
      let nc = c, nr = r;
      while (true) {
        const tc = nc + dc, tr = nr + dr;
        if (tc < 0 || tc >= cols || tr < 0 || tr >= rows) break;
        if (cells[idx(tc, tr)].kind !== 'floor') break;
        nc = tc; nr = tr;
        filled[idx(nc, nr)] = 1;
      }
      if (nc === c && nr === r) continue;       // didn't move
      const stopKey = idx(nc, nr);
      if (!visitedStops[stopKey]) {
        visitedStops[stopKey] = 1;
        queue.push({ c: nc, r: nr });
      }
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[idx(c, r)].kind === 'floor' && !filled[idx(c, r)]) {
        return false;
      }
    }
  }
  return true;
}

// ---- CONNECTIVITY ----
// True if every floor cell is reachable from the spawn cell using
// 4-directional moves. Used to reject wall placements that would
// orphan part of the playable area.
function _isAllFloorReachable(cells, cols, rows, spawn) {
  const visited = new Uint8Array(cols * rows);
  const idx = (c, r) => r * cols + c;
  const start = idx(spawn.col, spawn.row);
  if (cells[start].kind !== 'floor') return false;
  const stack = [start];
  visited[start] = 1;
  let count = 1;
  while (stack.length) {
    const i = stack.pop();
    const r = (i / cols) | 0;
    const c = i - r * cols;
    const nbrs = [
      [c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1],
    ];
    for (const [nc, nr] of nbrs) {
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const ni = idx(nc, nr);
      if (visited[ni]) continue;
      if (cells[ni].kind !== 'floor') continue;
      visited[ni] = 1;
      stack.push(ni);
      count++;
    }
  }
  // Total floor cells.
  let totalFloor = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].kind === 'floor') totalFloor++;
  }
  return count === totalFloor;
}

// ---- HELPERS ----

export function cellToWorld(col, row, mazeCols, mazeRows) {
  const mazeW = mazeCols * CELL_SIZE;
  const mazeH = mazeRows * CELL_SIZE;
  const offsetX = -mazeW / 2 + CELL_SIZE / 2;
  const offsetZ = -mazeH / 2 + CELL_SIZE / 2;
  return {
    x: offsetX + col * CELL_SIZE,
    z: offsetZ + row * CELL_SIZE,
  };
}

export function worldToCell(x, z, mazeCols, mazeRows) {
  const mazeW = mazeCols * CELL_SIZE;
  const mazeH = mazeRows * CELL_SIZE;
  const offsetX = -mazeW / 2;
  const offsetZ = -mazeH / 2;
  const col = Math.floor((x - offsetX) / CELL_SIZE);
  const row = Math.floor((z - offsetZ) / CELL_SIZE);
  return {
    col: Math.max(0, Math.min(mazeCols - 1, col)),
    row: Math.max(0, Math.min(mazeRows - 1, row)),
  };
}

export function isWallCell(mazeData, col, row) {
  if (col < 0 || col >= mazeData.cols || row < 0 || row >= mazeData.rows) return true;
  const cell = mazeData.cells[row * mazeData.cols + col];
  return !cell || cell.kind === 'wall';
}
