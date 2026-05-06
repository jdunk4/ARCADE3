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

  const spawn = { col: 1, row: 1 };

  // ---- LAYOUT: BOUSTROPHEDON ICE-PUZZLE ----
  // Wall rows at every even interior row so each "corridor" is a
  // single cell tall. Each wall row has exactly one gap, alternating
  // between the right edge (col cols-2) and the left edge (col 1).
  // The player's slide path becomes a forced serpentine:
  //   row 1 right → drop through right-edge gap → row 3 left → drop
  //   through left-edge gap → row 5 right → ...
  // Every floor cell is touched by that path, so 100% coverage and
  // every glyph are reachable.
  const w = config.waveNum;
  const placeWallSafe = (c, r) => {
    if (c <= 0 || c >= cols - 1 || r <= 0 || r >= rows - 1) return;
    if (c === spawn.col && r === spawn.row) return;
    cells[idx(c, r)].kind = 'wall';
  };

  // Build the wall-row schedule. Every wave uses the same skeleton
  // for now — variations come from extra gaps and mining blocks
  // in higher waves, not from the wall row spacing.
  const wallRows = [];
  for (let r = 2; r < rows - 1; r += 2) wallRows.push(r);

  // Extra middle gaps for higher waves — gives the player a second
  // route option that can be used to shortcut or to skip a slow
  // section. Wave 1 has none (forced solve).
  let extraMidGapsPerRow;
  if (w <= 1) extraMidGapsPerRow = 0;
  else if (w <= 4) extraMidGapsPerRow = 0;
  else if (w <= 7) extraMidGapsPerRow = 1;
  else extraMidGapsPerRow = 2;

  for (let i = 0; i < wallRows.length; i++) {
    const r = wallRows[i];
    const gaps = new Set();
    // Primary gap: right on even index, left on odd. This is the
    // gap the boustrophedon path uses.
    gaps.add(i % 2 === 0 ? cols - 2 : 1);
    // Extra gaps in middle columns for higher waves.
    for (let g = 0; g < extraMidGapsPerRow; g++) {
      let c = 4 + Math.floor(rng() * (cols - 8));
      let safety2 = 0;
      while (gaps.has(c) && safety2++ < 12) c = 4 + Math.floor(rng() * (cols - 8));
      gaps.add(c);
    }
    for (let c = 1; c < cols - 1; c++) {
      if (!gaps.has(c)) placeWallSafe(c, r);
    }
  }

  // Pillar scatter for high waves only — extra obstacles inside the
  // single-cell corridors. Each placement is connectivity-checked.
  if (w >= 8) {
    const pillarCount = (w >= 10) ? 6 : 3;
    let attempts = 0;
    let placed = 0;
    while (placed < pillarCount && attempts < pillarCount * 30) {
      attempts++;
      // Only scatter into corridor (odd) rows so the wall-row
      // skeleton stays intact.
      const r = 1 + 2 * Math.floor(rng() * Math.floor((rows - 2) / 2));
      const c = 2 + Math.floor(rng() * (cols - 4));
      if (cells[idx(c, r)].kind === 'wall') continue;
      if (Math.abs(c - spawn.col) + Math.abs(r - spawn.row) < 3) continue;
      cells[idx(c, r)].kind = 'wall';
      if (!_isAllFloorReachable(cells, cols, rows, spawn)) {
        cells[idx(c, r)].kind = 'floor';
        continue;
      }
      placed++;
    }
  }

  // Connectivity safety net. Should never trigger in practice
  // because the boustrophedon layout is provably solvable, but
  // keep the guard so generator bugs degrade gracefully instead
  // of orphaning glyphs.
  let safety = 0;
  while (!_isAllFloorReachable(cells, cols, rows, spawn) && safety < 50) {
    safety++;
    const r = wallRows[Math.floor(rng() * wallRows.length)];
    const c = 1 + Math.floor(rng() * (cols - 2));
    cells[idx(c, r)].kind = 'floor';
  }

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
