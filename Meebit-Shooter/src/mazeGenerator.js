// ============================================================
// MAZE GENERATOR — Endless Glyphs maze.
//
// Recursive-backtracker carving + loop openings, plus extra data
// for the new wave design:
//
//   • Maze fills the arena from wave 1; intricacy grows toward wave
//     10 (fewer loops, more dead-ends, more glyphs, more enemies).
//   • Selected interior walls are flagged as mining gates — solid
//     until the player explodes them. Density steps:
//       waves 1-3 → 0 gates,
//       waves 4-6 → 1 gate,
//       waves 7-9 → 2 gates,
//       waves 10+ → 3 gates.
//   • Hive spawn cells placed wave 7+ (1 hive at 7-9, 3 at 10+).
//   • Region IDs computed treating mining gates as blockers, so
//     enemies can patrol a region until the player opens a gate.
//
// Each cell is CELL_SIZE × CELL_SIZE world units. The maze is
// centered at the arena origin.
//
// Public API:
//   generateMaze(waveNum)  → MazeData
//   getMazeConfig(waveNum) → { cols, rows, glyphCount, ... }
//   cellToWorld / worldToCell / isWallBlocking
//
// MazeData = {
//   cols, rows,                      // grid dimensions
//   cells: [{walls}],                // wall bitmask per cell
//   spawn: {col, row},               // player start
//   exit: {col, row},                // exit gate
//   glyphs: [{col, row}],            // glyph pickups
//   miningWalls: [{col, row, dir, hp}],  // dir ∈ 'N'|'W' (canonical edges)
//   hiveSpawns: [{col, row}],        // queen-hive cells (wave 7+)
//   enemySpawns: [{col, row, regionId}],
//   regions: Int32Array,             // regionId per cell index
//   regionCount: number,             // distinct regions
//   spawnRegionId: number,           // region containing the player spawn
//   seed,
//   config,                          // back-ref to getMazeConfig output
//   cellSize,                        // = CELL_SIZE
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
// from 22% (very easy) toward 4% (lots of dead-ends), glyph and enemy
// counts climb, and mining gates / hives unlock at wave 4 / 7.
export function getMazeConfig(waveNum) {
  const w = Math.max(1, waveNum | 0);
  const t = Math.min(1, (w - 1) / 9);   // 0 at wave 1, 1 at wave 10

  // Same arena-filling footprint every wave; difficulty is in density.
  const cols = 19;
  const rows = 19;

  // Loop openings — fraction of internal walls to knock out for
  // alternate paths. High = easy and forgiving (wave 1). Low = lots
  // of dead-ends (wave 10+).
  const loopFraction = 0.22 - 0.18 * t;          // 0.22 → 0.04

  // Glyph count climbs with the wave.
  const glyphCount = Math.round(3 + 4 * t);      // 3 → 7

  // Enemies — drip from 0 at wave 1 up to ~14 at wave 10. Caps and
  // continues climbing past wave 10 for endless scaling.
  let enemyCount;
  if (w === 1) enemyCount = 0;
  else if (w === 2) enemyCount = 2;
  else enemyCount = Math.round(2 + 1.4 * (w - 2));

  // Mining gates step up every 3 waves.
  let miningGateCount;
  if (w <= 3) miningGateCount = 0;
  else if (w <= 6) miningGateCount = 1;
  else if (w <= 9) miningGateCount = 2;
  else miningGateCount = 3;

  // Hives unlock at wave 7. Wave 10+ gets 3.
  let hiveCount;
  if (w < 7) hiveCount = 0;
  else if (w < 10) hiveCount = 1;
  else hiveCount = 3;

  return {
    cols, rows,
    glyphCount,
    enemyCount,
    miningGateCount,
    hiveCount,
    loopFraction,
    waveNum: w,
  };
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

  // ---- SPAWN / EXIT ----
  const spawn = { col: 1, row: 1 };
  const exit = { col: cols - 2, row: rows - 2 };

  const usedCells = new Set();
  usedCells.add(idx(spawn.col, spawn.row));
  usedCells.add(idx(exit.col, exit.row));

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

  // ---- DEAD-END LIST (sorted by distance from spawn) ----
  const deadEnds = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = cells[idx(c, r)].walls;
      if (_countBits(w) === 3) {
        const dist = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
        deadEnds.push({ col: c, row: r, dist, regionId: regions[idx(c, r)] });
      }
    }
  }
  deadEnds.sort((a, b) => b.dist - a.dist);

  // ---- GLYPHS ----
  // Prefer dead-ends in non-spawn regions (forces the player to break
  // gates), then dead-ends in the spawn region, then any far cell.
  const glyphs = [];
  const glyphCandidates = [
    ...deadEnds.filter(d => d.regionId !== spawnRegionId),
    ...deadEnds.filter(d => d.regionId === spawnRegionId),
  ];
  for (const d of glyphCandidates) {
    if (glyphs.length >= config.glyphCount) break;
    const k = idx(d.col, d.row);
    if (usedCells.has(k)) continue;
    glyphs.push({ col: d.col, row: d.row });
    usedCells.add(k);
  }
  // Fallback for very small mazes — fill remaining glyphs anywhere.
  const minDist = Math.floor(Math.max(cols, rows) * 0.3);
  while (glyphs.length < config.glyphCount) {
    let placed = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const c = Math.floor(rng() * cols);
      const r = Math.floor(rng() * rows);
      const k = idx(c, r);
      const dist = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
      if (!usedCells.has(k) && dist >= minDist) {
        glyphs.push({ col: c, row: r });
        usedCells.add(k);
        placed = true;
        break;
      }
    }
    if (!placed) break;
  }

  // ---- HIVE CELLS ----
  // One per non-spawn region while hives remain to place; fall back to
  // any open cell after all gated regions are populated.
  const hiveSpawns = [];
  if (config.hiveCount > 0) {
    const claimedRegions = new Set([spawnRegionId]);
    for (const d of deadEnds) {
      if (hiveSpawns.length >= config.hiveCount) break;
      if (claimedRegions.has(d.regionId)) continue;
      const k = idx(d.col, d.row);
      if (usedCells.has(k)) continue;
      hiveSpawns.push({ col: d.col, row: d.row });
      usedCells.add(k);
      claimedRegions.add(d.regionId);
    }
    // Remaining hives: any far-from-spawn cell.
    while (hiveSpawns.length < config.hiveCount) {
      let placed = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const c = Math.floor(rng() * cols);
        const r = Math.floor(rng() * rows);
        const k = idx(c, r);
        const dist = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
        if (!usedCells.has(k) && dist >= minDist) {
          hiveSpawns.push({ col: c, row: r });
          usedCells.add(k);
          placed = true;
          break;
        }
      }
      if (!placed) break;
    }
  }

  // ---- ENEMY PATROL CELLS ----
  // Spread across regions so each region has at least one enemy when
  // possible; the rest go anywhere available.
  const enemySpawns = [];
  if (config.enemyCount > 0) {
    const perRegionMin = Math.min(2, Math.floor(config.enemyCount / Math.max(1, regionCount)));
    for (let rid = 0; rid < regionCount; rid++) {
      let placed = 0;
      for (let attempt = 0; attempt < 200 && placed < perRegionMin; attempt++) {
        const c = Math.floor(rng() * cols);
        const r = Math.floor(rng() * rows);
        const k = idx(c, r);
        if (regions[k] !== rid) continue;
        if (usedCells.has(k)) continue;
        const dist = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
        if (dist < 3 && rid === spawnRegionId) continue; // not on top of player
        enemySpawns.push({ col: c, row: r, regionId: rid });
        usedCells.add(k);
        placed++;
      }
    }
    // Top up.
    while (enemySpawns.length < config.enemyCount) {
      let placed = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const c = Math.floor(rng() * cols);
        const r = Math.floor(rng() * rows);
        const k = idx(c, r);
        if (usedCells.has(k)) continue;
        const dist = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
        if (dist < 3) continue;
        enemySpawns.push({ col: c, row: r, regionId: regions[k] });
        usedCells.add(k);
        placed = true;
        break;
      }
      if (!placed) break;
    }
  }

  return {
    cols,
    rows,
    cells,
    spawn,
    exit,
    glyphs,
    miningWalls,
    hiveSpawns,
    enemySpawns,
    regions,
    regionCount,
    spawnRegionId,
    seed,
    config,
    cellSize: CELL_SIZE,
  };
}

// ---- HELPERS ----

function _countBits(n) {
  let count = 0;
  while (n) { count += n & 1; n >>= 1; }
  return count;
}

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
