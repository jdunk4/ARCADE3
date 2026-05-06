// ============================================================
// MAZE GENERATOR — Endless Glyphs slide-fill maze.
//
// Algorithm: Sidewinder. Produces long horizontal corridors broken
// by sparse vertical connections — exactly the "long sweeps with
// occasional U-turns" look the reference asks for.
//
//   • Wave 1: very low east-close probability → near-empty corridors,
//     player can fill an entire row in one slide.
//   • Wave 10+: higher east-close probability → more turns, more
//     dead-ends, harder coverage.
//
// Black mining BLOCKS (cell-based) are placed in some cells along
// long horizontal corridors. The slide animator treats those cells
// as impassable until the player shoots the block to clear it.
//
// Kill zones (static hazards) sit in cells like before; touching one
// retries the wave.
//
// MazeData = {
//   cols, rows,
//   cells: [{walls}],
//   spawn: {col, row},
//   miningBlocks: [{col, row, hp, hpMax, broken}],
//   killZones: [{col, row, kind}],
//   regions: Int32Array, regionCount, spawnRegionId,
//   seed, config, cellSize,
// }
// ============================================================

const CELL_SIZE = 5.0;

const WALL_N = 1;
const WALL_E = 2;
const WALL_S = 4;
const WALL_W = 8;

export { CELL_SIZE, WALL_N, WALL_E, WALL_S, WALL_W };

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
  const t = Math.min(1, (w - 1) / 9);     // 0 at wave 1, 1 at wave 10

  const cols = 19;
  const rows = 19;

  // East-close probability — chance any given cell in a sidewinder
  // run "closes" the east edge (forcing a U-turn). Low value →
  // long uninterrupted corridors. Climbs with the wave.
  const eastCloseProb = 0.18 + 0.42 * t;  // 0.18 → 0.60

  // Mining blocks count.
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

  return {
    cols, rows,
    eastCloseProb,
    miningBlockCount,
    killZoneCount,
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

  const cells = new Array(cols * rows);
  // Sidewinder starts with all walls present; we open passages as
  // we sweep row by row.
  for (let i = 0; i < cells.length; i++) {
    cells[i] = { walls: WALL_N | WALL_E | WALL_S | WALL_W };
  }

  const idx = (c, r) => r * cols + c;

  // ---- SIDEWINDER ----
  // For each row top-down:
  //   - Maintain a "run" of consecutive open cells.
  //   - For each cell except the last column, decide:
  //       • close east (end run + open one cell's south wall to
  //         connect to the row below), OR
  //       • open east (extend run).
  //   - At the rightmost column or when we close, pick a random
  //     cell from the run, open its south wall, clear next row's
  //     north wall to pair.
  //
  // We carve top-down (row 0 first), so the canonical "carve south
  // when closing" rule is what produces the horizontal-corridor
  // look from the player's top-down view.
  for (let r = 0; r < rows; r++) {
    let runStart = 0;
    for (let c = 0; c < cols; c++) {
      const atEastEdge = (c === cols - 1);
      const atSouthEdge = (r === rows - 1);
      // Forced close at east edge so a run never escapes the grid.
      // At south edge we never close (we'd have nothing to pair to);
      // we just keep extending.
      const closeOut = atEastEdge || (!atSouthEdge && rng() < config.eastCloseProb);
      if (closeOut) {
        if (!atSouthEdge) {
          // Pick a random cell in the run [runStart..c] and open
          // its south wall + the next row's matching north wall.
          const pick = runStart + Math.floor(rng() * (c - runStart + 1));
          cells[idx(pick, r)].walls &= ~WALL_S;
          cells[idx(pick, r + 1)].walls &= ~WALL_N;
        }
        runStart = c + 1;
      } else {
        // Extend run east.
        cells[idx(c, r)].walls &= ~WALL_E;
        cells[idx(c + 1, r)].walls &= ~WALL_W;
      }
    }
  }

  // ---- CENTRAL OPENING ----
  // The user asked for "less obstacles in the middle" — clear all
  // interior walls in a small band around the arena center. This
  // gives the maze a hub the player can route through without
  // mining anything.
  const cBand = 3;
  const midC = Math.floor(cols / 2);
  const midR = Math.floor(rows / 2);
  for (let r = midR - cBand; r <= midR + cBand; r++) {
    for (let c = midC - cBand; c <= midC + cBand; c++) {
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      const cell = cells[idx(c, r)];
      if (c < midC + cBand && c < cols - 1) {
        cell.walls &= ~WALL_E;
        cells[idx(c + 1, r)].walls &= ~WALL_W;
      }
      if (r < midR + cBand && r < rows - 1) {
        cell.walls &= ~WALL_S;
        cells[idx(c, r + 1)].walls &= ~WALL_N;
      }
    }
  }

  // ---- SPAWN ----
  const spawn = { col: 1, row: 1 };

  // ---- REGIONS (after carving; treats remaining walls as blockers,
  // mining blocks aren't walls so they don't split regions) ----
  const regions = new Int32Array(cols * rows).fill(-1);
  let regionId = 0;
  for (let startIdx = 0; startIdx < cells.length; startIdx++) {
    if (regions[startIdx] !== -1) continue;
    const queue = [startIdx];
    regions[startIdx] = regionId;
    while (queue.length > 0) {
      const ci = queue.shift();
      const cr = Math.floor(ci / cols);
      const cc = ci - cr * cols;
      const cell = cells[ci];
      if (!(cell.walls & WALL_N) && cr > 0) {
        const ni = idx(cc, cr - 1);
        if (regions[ni] === -1) { regions[ni] = regionId; queue.push(ni); }
      }
      if (!(cell.walls & WALL_S) && cr < rows - 1) {
        const ni = idx(cc, cr + 1);
        if (regions[ni] === -1) { regions[ni] = regionId; queue.push(ni); }
      }
      if (!(cell.walls & WALL_W) && cc > 0) {
        const ni = idx(cc - 1, cr);
        if (regions[ni] === -1) { regions[ni] = regionId; queue.push(ni); }
      }
      if (!(cell.walls & WALL_E) && cc < cols - 1) {
        const ni = idx(cc + 1, cr);
        if (regions[ni] === -1) { regions[ni] = regionId; queue.push(ni); }
      }
    }
    regionId++;
  }
  const regionCount = regionId;
  const spawnRegionId = regions[idx(spawn.col, spawn.row)];

  // ---- MINING BLOCKS ----
  // Cell-based black cubes. Picked from interior cells away from
  // spawn. Spaced so they don't all cluster.
  const miningBlocks = [];
  const usedCells = new Set([idx(spawn.col, spawn.row)]);
  let attempts = 0;
  while (miningBlocks.length < config.miningBlockCount && attempts < 800) {
    attempts++;
    const c = 2 + Math.floor(rng() * (cols - 4));
    const r = 2 + Math.floor(rng() * (rows - 4));
    const k = idx(c, r);
    if (usedCells.has(k)) continue;
    const dSpawn = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
    if (dSpawn < 4) continue;
    // Avoid blocks inside the central opening — that hub is meant
    // to stay clear.
    if (c >= midC - cBand && c <= midC + cBand &&
        r >= midR - cBand && r <= midR + cBand) continue;
    let tooClose = false;
    for (const m of miningBlocks) {
      if (Math.abs(m.col - c) + Math.abs(m.row - r) < 3) { tooClose = true; break; }
    }
    if (tooClose) continue;
    miningBlocks.push({
      col: c, row: r,
      hp: MINING_BLOCK_HP, hpMax: MINING_BLOCK_HP, broken: false,
    });
    usedCells.add(k);
  }

  // ---- KILL ZONES ----
  const killZones = [];
  if (config.killZoneCount > 0) {
    const chapter = Math.floor((waveNum - 1) / 10) % 6;
    const kind = (chapter <= 1) ? 'rune' : (chapter <= 3) ? 'mine' : 'ghost';
    let kzAttempts = 0;
    while (killZones.length < config.killZoneCount && kzAttempts < 800) {
      kzAttempts++;
      const c = Math.floor(rng() * cols);
      const r = Math.floor(rng() * rows);
      const k = idx(c, r);
      if (usedCells.has(k)) continue;
      const dSpawn = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
      if (dSpawn < 3) continue;
      // Don't put kill zones in the central hub either — that area
      // is the player's safe spine.
      if (c >= midC - cBand && c <= midC + cBand &&
          r >= midR - cBand && r <= midR + cBand) continue;
      let tooClose = false;
      for (const other of killZones) {
        if (Math.abs(other.col - c) + Math.abs(other.row - r) < 2) { tooClose = true; break; }
      }
      if (tooClose) continue;
      killZones.push({ col: c, row: r, kind });
      usedCells.add(k);
    }
  }

  return {
    cols,
    rows,
    cells,
    spawn,
    miningBlocks,
    killZones,
    regions,
    regionCount,
    spawnRegionId,
    seed,
    config,
    cellSize: CELL_SIZE,
  };
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

export function isWallBlocking(mazeData, col, row, dir) {
  const cell = mazeData.cells[row * mazeData.cols + col];
  if (!cell) return true;
  const flag = dir === 'N' ? WALL_N : dir === 'E' ? WALL_E : dir === 'S' ? WALL_S : WALL_W;
  return (cell.walls & flag) !== 0;
}
