// ============================================================
// MAZE GENERATOR — Endless Glyphs slide-fill maze.
//
// Wave design:
//   • Maze fills the arena every wave (19×19 cells).
//   • Loop fraction climbs from 0.22 (wave 1, easy) toward 0.04
//     (wave 10+, more dead-ends).
//   • Mining gates: 0 / 1 / 2 / 3 across waves 1-3 / 4-6 / 7-9 / 10+.
//     Player must shoot to break them and access new cells.
//   • Kill zones (static hazards): 0 / 1-2 / 3-5 / 6-8 across the
//     same wave ranges. Touching one ends the wave.
//
// Public API:
//   generateMaze(waveNum)  → MazeData
//   getMazeConfig(waveNum) → { cols, rows, miningGateCount, ... }
//   cellToWorld / worldToCell / isWallBlocking
//
// MazeData = {
//   cols, rows,                      // grid dimensions
//   cells: [{walls}],                // wall bitmask per cell
//   spawn: {col, row},               // player start
//   miningWalls: [{col, row, dir, hp, broken}],
//   killZones: [{col, row, kind}],   // kind ∈ 'rune' | 'mine' | 'ghost'
//   regions: Int32Array,             // regionId per cell index
//   regionCount: number,
//   spawnRegionId: number,
//   seed, config, cellSize,
// }
// ============================================================

const CELL_SIZE = 5.0;          // world units per cell — wide corridors

// Wall bit flags
const WALL_N = 1;
const WALL_E = 2;
const WALL_S = 4;
const WALL_W = 8;

export { CELL_SIZE, WALL_N, WALL_E, WALL_S, WALL_W };

const MINING_WALL_HP = 25;      // shots to clear a mining gate

// ---- SEEDED RNG ----
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
//
// Arena is 100×100u (ARENA = 50 half-extent). With CELL_SIZE = 5 the
// theoretical maximum is 20×20; capped at 19 for a 1u border. Every
// wave fills the arena. What changes is intricacy: loop openings drop
// 22% → 4% across waves, mining gates step up every 3 waves, and
// kill-zone density climbs accordingly.
export function getMazeConfig(waveNum) {
  const w = Math.max(1, waveNum | 0);
  const t = Math.min(1, (w - 1) / 9);   // 0 at wave 1, 1 at wave 10

  const cols = 19;
  const rows = 19;
  const loopFraction = 0.22 - 0.18 * t;          // 0.22 → 0.04

  // Mining gates step up every 3 waves.
  let miningGateCount;
  if (w <= 3) miningGateCount = 0;
  else if (w <= 6) miningGateCount = 1;
  else if (w <= 9) miningGateCount = 2;
  else miningGateCount = 3;

  // Kill zones — 0 early, ramp up to 6-8 at wave 10+.
  let killZoneCount;
  if (w <= 3) killZoneCount = 0;
  else if (w <= 6) killZoneCount = 1 + Math.floor(rng01(w) * 2);   // 1-2
  else if (w <= 9) killZoneCount = 3 + Math.floor(rng01(w) * 3);   // 3-5
  else killZoneCount = 6 + Math.floor(rng01(w) * 3);               // 6-8

  return {
    cols, rows,
    miningGateCount,
    killZoneCount,
    loopFraction,
    waveNum: w,
  };
}

// Stable per-wave noise so the count for a given wave is deterministic
// (matches the maze seed). Cheap; enough variation for "1-2" buckets.
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
  for (let i = 0; i < cells.length; i++) {
    cells[i] = { walls: WALL_N | WALL_E | WALL_S | WALL_W, visited: false };
  }

  const idx = (c, r) => r * cols + c;
  const inBounds = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;

  // ---- RECURSIVE BACKTRACKING ----
  const stack = [];
  cells[idx(0, 0)].visited = true;
  stack.push([0, 0]);

  const DIRS = [
    [0, -1, WALL_N, WALL_S],
    [1, 0, WALL_E, WALL_W],
    [0, 1, WALL_S, WALL_N],
    [-1, 0, WALL_W, WALL_E],
  ];

  while (stack.length > 0) {
    const [cc, cr] = stack[stack.length - 1];
    const neighbors = [];
    for (const [dc, dr, wallA, wallB] of DIRS) {
      const nc = cc + dc, nr = cr + dr;
      if (inBounds(nc, nr) && !cells[idx(nc, nr)].visited) {
        neighbors.push([nc, nr, wallA, wallB]);
      }
    }
    if (neighbors.length === 0) {
      stack.pop();
    } else {
      const [nc, nr, wallA, wallB] = neighbors[Math.floor(rng() * neighbors.length)];
      cells[idx(cc, cr)].walls &= ~wallA;
      cells[idx(nc, nr)].walls &= ~wallB;
      cells[idx(nc, nr)].visited = true;
      stack.push([nc, nr]);
    }
  }

  // ---- LOOP OPENINGS ----
  // Knock out a fraction of remaining interior walls so the maze isn't
  // a single tortuous path. Higher fraction = easier navigation.
  const internalWallCount = (cols - 1) * rows + cols * (rows - 1);
  const wallsToOpen = Math.floor(internalWallCount * config.loopFraction);
  for (let i = 0; i < wallsToOpen; i++) {
    if (rng() < 0.5) {
      // East/West edge between (c,r) and (c+1,r)
      const c = Math.floor(rng() * (cols - 1));
      const r = Math.floor(rng() * rows);
      cells[idx(c, r)].walls &= ~WALL_E;
      cells[idx(c + 1, r)].walls &= ~WALL_W;
    } else {
      // South/North edge between (c,r) and (c,r+1)
      const c = Math.floor(rng() * cols);
      const r = Math.floor(rng() * (rows - 1));
      cells[idx(c, r)].walls &= ~WALL_S;
      cells[idx(c, r + 1)].walls &= ~WALL_N;
    }
  }

  // ---- SPAWN ----
  const spawn = { col: 1, row: 1 };

  // ---- MINING GATES ----
  // Pick interior open passages and close them — re-set the wall bit
  // on both cells. The wall is then visually rendered as a mining
  // block (themed) and tracked here so the player can damage and
  // destroy it. When destroyed, both adjacent cells get their wall
  // bit cleared, restoring the original perfect-maze passage.
  const miningWalls = [];
  const gateAttempts = config.miningGateCount * 24;
  let gatesPlaced = 0;
  const gateKey = new Set();

  for (let attempt = 0; attempt < gateAttempts && gatesPlaced < config.miningGateCount; attempt++) {
    const horizontal = rng() < 0.5;
    let c, r, dir;
    if (horizontal) {
      // West edge between (c-1,r) and (c,r): canonical via cell (c,r) WALL_W.
      c = 1 + Math.floor(rng() * (cols - 1));
      r = Math.floor(rng() * rows);
      dir = 'W';
      const cell = cells[idx(c, r)];
      if (cell.walls & WALL_W) continue;
    } else {
      // North edge between (c,r-1) and (c,r): canonical via cell (c,r) WALL_N.
      c = Math.floor(rng() * cols);
      r = 1 + Math.floor(rng() * (rows - 1));
      dir = 'N';
      const cell = cells[idx(c, r)];
      if (cell.walls & WALL_N) continue;
    }
    if ((c === spawn.col && r === spawn.row) ||
        (dir === 'W' && c - 1 === spawn.col && r === spawn.row) ||
        (dir === 'N' && c === spawn.col && r - 1 === spawn.row)) continue;
    const k = `${c},${r},${dir}`;
    if (gateKey.has(k)) continue;
    gateKey.add(k);

    // Close the passage on both sides — collision and projectile
    // checks now treat this edge as solid until the gate is broken.
    if (dir === 'W') {
      cells[idx(c, r)].walls |= WALL_W;
      cells[idx(c - 1, r)].walls |= WALL_E;
    } else {
      cells[idx(c, r)].walls |= WALL_N;
      cells[idx(c, r - 1)].walls |= WALL_S;
    }

    miningWalls.push({
      col: c, row: r, dir,
      hp: MINING_WALL_HP, hpMax: MINING_WALL_HP, broken: false,
    });
    gatesPlaced++;
  }

  // ---- REGION COMPUTATION ----
  // BFS over open passages only. Mining gates are CURRENTLY blocking
  // (their wall bits were set above), so the regions reflect what's
  // reachable until the player clears a gate. When a gate is broken
  // at runtime the renderer flips the bits and the patrol behavior
  // catches up naturally on the next frame.
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

  // ---- KILL ZONES ----
  // Stationary hazards. Visual kind cycles by chapter:
  //   chapter 0-1 → 'rune' (glowing skull-rune)
  //   chapter 2-3 → 'mine' (minesweeper bomb)
  //   chapter 4-5 → 'ghost'
  // Density ramps with the wave (config.killZoneCount). Placed
  // away from spawn and away from each other so the player has
  // time to react after a slide reveals a new zone.
  const killZones = [];
  if (config.killZoneCount > 0) {
    const chapter = Math.floor((w - 1) / 10) % 6;
    const kind = (chapter <= 1) ? 'rune' : (chapter <= 3) ? 'mine' : 'ghost';
    const spawnIdx = idx(spawn.col, spawn.row);
    const usedKZ = new Set([spawnIdx]);
    let attempts = 0;
    while (killZones.length < config.killZoneCount && attempts < 800) {
      attempts++;
      const c = Math.floor(rng() * cols);
      const r = Math.floor(rng() * rows);
      const k = idx(c, r);
      if (usedKZ.has(k)) continue;
      // Manhattan distance from spawn — keep at least 3 cells away
      // so the player doesn't slide into one on their first move.
      const dSpawn = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
      if (dSpawn < 3) continue;
      // Spread — at least 2 cells from any other kill zone.
      let tooClose = false;
      for (const other of killZones) {
        if (Math.abs(other.col - c) + Math.abs(other.row - r) < 2) { tooClose = true; break; }
      }
      if (tooClose) continue;
      killZones.push({ col: c, row: r, kind });
      usedKZ.add(k);
    }
  }

  return {
    cols,
    rows,
    cells,
    spawn,
    miningWalls,
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

/** Cell grid → world coordinates (centered at arena origin). */
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

/** World → cell. */
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

/** Is the wall on a given side of a cell currently solid? */
export function isWallBlocking(mazeData, col, row, dir) {
  const cell = mazeData.cells[row * mazeData.cols + col];
  if (!cell) return true;
  const flag = dir === 'N' ? WALL_N : dir === 'E' ? WALL_E : dir === 'S' ? WALL_S : WALL_W;
  return (cell.walls & flag) !== 0;
}
