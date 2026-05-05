// ============================================================
// MAZE GENERATOR — Procedural maze for Endless Glyphs mode.
//
// Uses recursive backtracking (depth-first) to carve a perfect
// maze, then removes a few extra walls to create loops (imperfect
// maze = more interesting gameplay, less dead-end frustration).
//
// Each cell is a 2.5u × 2.5u square matching the arena grid.
// The maze is centered in the arena.
//
// Public API:
//   generateMaze(waveNum)  → MazeData
//   getMazeConfig(waveNum) → { cols, rows, glyphCount, ... }
//
// MazeData = {
//   cols, rows,         — grid dimensions
//   cells: [],          — flat array [row * cols + col], each cell has wall flags
//   spawn: {col, row},  — player start position
//   exit: {col, row},   — exit gate position
//   glyphs: [{col, row}, ...],  — glyph pickup positions
//   seed,               — RNG seed used
// }
// ============================================================

const CELL_SIZE = 2.5;  // world units per cell, matches arena grid

// Wall flags (bitmask)
const WALL_N = 1;  // top
const WALL_E = 2;  // right
const WALL_S = 4;  // bottom
const WALL_W = 8;  // left

export { CELL_SIZE, WALL_N, WALL_E, WALL_S, WALL_W };

// ---- SEEDED RNG ----
// Simple mulberry32 PRNG for deterministic maze generation.
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- MAZE CONFIG PER WAVE ----
export function getMazeConfig(waveNum) {
  // Wave 1: tiny learning maze
  // Waves 2-4: medium with enemies
  // Waves 5-9: larger multi-room
  // Wave 10: boss arena
  // After wave 10, pattern repeats with +2 cols/rows per chapter

  const chapter = Math.floor((waveNum - 1) / 10);  // 0-indexed chapter
  const localWave = ((waveNum - 1) % 10) + 1;      // 1-10 within chapter
  const sizeBonus = chapter * 2;                     // grows each chapter

  let cols, rows, glyphCount, enemyCount, hasRooms;

  if (localWave === 1) {
    // Tutorial wave — no enemies, small maze
    cols = 8 + sizeBonus;
    rows = 8 + sizeBonus;
    glyphCount = 3;
    enemyCount = 0;
    hasRooms = false;
  } else if (localWave <= 4) {
    // Add enemies, slightly bigger
    cols = 10 + sizeBonus;
    rows = 10 + sizeBonus;
    glyphCount = 3;
    enemyCount = 2 + (localWave - 2) * 2;  // 2, 4, 6
    hasRooms = false;
  } else if (localWave <= 9) {
    // Multi-room dungeons
    cols = 12 + (localWave - 5) + sizeBonus;  // 12→16
    rows = 12 + (localWave - 5) + sizeBonus;
    glyphCount = 3 + Math.floor((localWave - 5) / 2);  // 3→5
    enemyCount = 3 + (localWave - 5) * 2;  // 3→11
    hasRooms = true;
  } else {
    // Wave 10: boss wave
    cols = 16 + sizeBonus;
    rows = 16 + sizeBonus;
    glyphCount = 0;  // no glyphs — just reach the boss room
    enemyCount = 8;
    hasRooms = true;
  }

  // Cap maze size to fit in arena (ARENA=50, cell=2.5 → max 40 cells)
  cols = Math.min(cols, 38);
  rows = Math.min(rows, 38);

  return {
    cols, rows, glyphCount, enemyCount, hasRooms,
    localWave, chapter, isBoss: localWave === 10,
  };
}

// ---- GENERATE MAZE ----
export function generateMaze(waveNum) {
  const config = getMazeConfig(waveNum);
  const { cols, rows } = config;
  const seed = waveNum * 7919 + 12345;  // deterministic seed
  const rng = mulberry32(seed);

  // Initialize cells — all walls up
  const cells = new Array(cols * rows);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = {
      walls: WALL_N | WALL_E | WALL_S | WALL_W,
      visited: false,
    };
  }

  const idx = (c, r) => r * cols + c;
  const inBounds = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;

  // ---- RECURSIVE BACKTRACKING ----
  const stack = [];
  const startCol = 0;
  const startRow = 0;
  cells[idx(startCol, startRow)].visited = true;
  stack.push([startCol, startRow]);

  const DIRS = [
    [0, -1, WALL_N, WALL_S],  // north: remove my N wall + neighbor's S wall
    [1, 0, WALL_E, WALL_W],   // east
    [0, 1, WALL_S, WALL_N],   // south
    [-1, 0, WALL_W, WALL_E],  // west
  ];

  while (stack.length > 0) {
    const [cc, cr] = stack[stack.length - 1];

    // Find unvisited neighbors
    const neighbors = [];
    for (const [dc, dr, wallA, wallB] of DIRS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (inBounds(nc, nr) && !cells[idx(nc, nr)].visited) {
        neighbors.push([nc, nr, wallA, wallB]);
      }
    }

    if (neighbors.length === 0) {
      stack.pop();  // backtrack
    } else {
      // Pick random neighbor
      const [nc, nr, wallA, wallB] = neighbors[Math.floor(rng() * neighbors.length)];
      // Remove walls between current and neighbor
      cells[idx(cc, cr)].walls &= ~wallA;
      cells[idx(nc, nr)].walls &= ~wallB;
      cells[idx(nc, nr)].visited = true;
      stack.push([nc, nr]);
    }
  }

  // ---- REMOVE EXTRA WALLS for loops (imperfect maze) ----
  // Remove ~10% of remaining internal walls to create alternate paths
  const wallsToRemove = Math.floor(cols * rows * 0.08);
  for (let i = 0; i < wallsToRemove; i++) {
    const c = Math.floor(rng() * (cols - 1));
    const r = Math.floor(rng() * (rows - 1));
    // Randomly pick east or south wall to remove
    if (rng() < 0.5 && c < cols - 1) {
      cells[idx(c, r)].walls &= ~WALL_E;
      cells[idx(c + 1, r)].walls &= ~WALL_W;
    } else if (r < rows - 1) {
      cells[idx(c, r)].walls &= ~WALL_S;
      cells[idx(c, r + 1)].walls &= ~WALL_N;
    }
  }

  // ---- PLACE SPAWN, EXIT, GLYPHS ----
  // Spawn at top-left area
  const spawn = { col: 1, row: 1 };

  // Exit at bottom-right area
  const exit = { col: cols - 2, row: rows - 2 };

  // Place glyphs in dead-end cells or random locations far from spawn
  const glyphs = [];
  const minDistFromSpawn = Math.floor(Math.max(cols, rows) * 0.3);

  // Find dead ends (cells with 3 walls = only one opening)
  const deadEnds = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = cells[idx(c, r)].walls;
      const openings = 4 - _countBits(w);
      if (openings === 1) {
        const dist = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
        if (dist >= minDistFromSpawn) {
          deadEnds.push({ col: c, row: r, dist });
        }
      }
    }
  }

  // Sort dead ends by distance from spawn (farthest first)
  deadEnds.sort((a, b) => b.dist - a.dist);

  // Place glyphs preferring dead ends, then random cells
  const usedCells = new Set();
  usedCells.add(idx(spawn.col, spawn.row));
  usedCells.add(idx(exit.col, exit.row));

  for (let i = 0; i < config.glyphCount; i++) {
    let placed = false;
    // Try dead ends first
    for (const de of deadEnds) {
      const key = idx(de.col, de.row);
      if (!usedCells.has(key)) {
        glyphs.push({ col: de.col, row: de.row });
        usedCells.add(key);
        placed = true;
        break;
      }
    }
    // Fallback: random cell far from spawn
    if (!placed) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const c = Math.floor(rng() * cols);
        const r = Math.floor(rng() * rows);
        const key = idx(c, r);
        const dist = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
        if (!usedCells.has(key) && dist >= minDistFromSpawn) {
          glyphs.push({ col: c, row: r });
          usedCells.add(key);
          break;
        }
      }
    }
  }

  // ---- ENEMY PATROL POSITIONS ----
  // Pick random cells for enemy patrol routes (midpoints of corridors)
  const enemySpawns = [];
  for (let i = 0; i < config.enemyCount; i++) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const c = Math.floor(rng() * cols);
      const r = Math.floor(rng() * rows);
      const key = idx(c, r);
      const dist = Math.abs(c - spawn.col) + Math.abs(r - spawn.row);
      if (!usedCells.has(key) && dist >= 3) {
        enemySpawns.push({ col: c, row: r });
        usedCells.add(key);
        break;
      }
    }
  }

  return {
    cols,
    rows,
    cells,
    spawn,
    exit,
    glyphs,
    enemySpawns,
    seed,
    config,
    cellSize: CELL_SIZE,
  };
}

// ---- UTILITY ----

function _countBits(n) {
  let count = 0;
  while (n) { count += n & 1; n >>= 1; }
  return count;
}

/**
 * Convert a cell grid position to world coordinates.
 * The maze is centered in the arena.
 */
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

/**
 * Convert world coordinates back to cell grid position.
 */
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

/**
 * Check if movement from cell (c,r) in direction is blocked by a wall.
 * dir: 'N','E','S','W'
 */
export function isWallBlocking(mazeData, col, row, dir) {
  const cell = mazeData.cells[row * mazeData.cols + col];
  if (!cell) return true;
  const wallFlag = dir === 'N' ? WALL_N : dir === 'E' ? WALL_E : dir === 'S' ? WALL_S : WALL_W;
  return (cell.walls & wallFlag) !== 0;
}
