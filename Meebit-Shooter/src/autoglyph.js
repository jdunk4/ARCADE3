// autoglyph.js — Procedural generator for Larva Labs-style autoglyphs
//
// Per playtester (Ship 3 of 3): wave-end dissolve animation
// transforms the procedural floorplan into an autoglyph pattern,
// which then sinks into the floor. This module produces the pattern
// itself — given a seed, returns a 64×64 cell grid where each cell
// is either empty or holds one of 7 symbols (square, circle, plus,
// X, pipe, dash, slash, backslash).
//
// Implementation: 10 generation schemes inspired by the original
// Larva Labs Autoglyphs algorithm:
//   1. TESSELLATED   — single symbol tiled in a regular pattern
//   2. HALF_ROTATED  — top half, rotated 180° in the bottom half
//   3. QUARTER       — quarter pattern rotated 4-fold (90° symmetry)
//   4. OVERLAPPED    — two motif layers XOR'd together
//   5. MIRRORED      — vertical mirror axis (bilateral)
//   6. RANDOM_WALK   — single connected path traced through the grid
//   7. TWO_WALK      — two walks, one inverted, overlaid
//   8. DIAGONAL      — symmetric across the main diagonal
//   9. SPRINKLE      — small motif repeated at random positions
//  10. CHAOS         — chaotic noise field
//
// Each generated autoglyph picks ONE scheme + ONE primary symbol
// (or pair of symbols for the overlay schemes). Schemes also
// influence density (tessellated is dense, sprinkle is sparse).
//
// API:
//   generateAutoglyph(seed)
//     → { cells, scheme, symbol, width, height }
//
//     cells is a Uint8Array of length 64*64 = 4096.
//     Values: 0 (empty), 1-7 (symbol indices).
//     Read: cells[y * 64 + x].
//
// Design notes:
//   - Cells are pure data — rendering is the caller's job. The
//     dissolve animation in Ship 3B will translate filled cells
//     into particle target positions on the floor.
//   - Symbol shapes are NOT rendered here. The caller (Ship 3B
//     particle system) will choose how to represent each symbol
//     (e.g., one particle for a dot, four for a plus, etc).
//   - Generation is deterministic for a given seed — same seed
//     always produces the same autoglyph. Useful for debugging
//     and for stable per-wave layouts.

// =====================================================================
// CONSTANTS
// =====================================================================

const GRID_DIM = 64;
const GRID_SIZE = GRID_DIM * GRID_DIM;

// Symbol palette — the values stored in the cells array.
// Index 0 is reserved for "empty"; symbols are 1-7.
export const SYMBOLS = {
  EMPTY:     0,
  SQUARE:    1,    // ■  filled square
  CIRCLE:    2,    // O  hollow ring
  PLUS:      3,    // +  cross
  X:         4,    // X  diagonal cross
  PIPE:      5,    // |  vertical bar
  DASH:      6,    // -  horizontal bar
  SLASH:     7,    // /  forward slash
  BACKSLASH: 8,    // \  backward slash
};

const SYMBOL_COUNT = 8;       // SQUARE through BACKSLASH

const SCHEMES = [
  'TESSELLATED',
  'HALF_ROTATED',
  'QUARTER',
  'OVERLAPPED',
  'MIRRORED',
  'RANDOM_WALK',
  'TWO_WALK',
  'DIAGONAL',
  'SPRINKLE',
  'CHAOS',
];

// =====================================================================
// PUBLIC API
// =====================================================================

/**
 * Generate a 64×64 autoglyph pattern.
 *
 * @param {number} seed   integer seed; same seed = same output
 * @param {string} [forceScheme]  optional scheme name to force
 *                                (otherwise picked from seed)
 * @returns {{cells: Uint8Array, scheme: string, symbol: number,
 *           width: number, height: number}}
 */
// Minimum fraction of cells we want filled before showing the glyph.
// Below this, we layer in a tessellated underlay with a contrasting
// symbol so the autoglyph fills the arena instead of leaving big
// blank stretches. Tuned to match the dense reference autoglyphs:
// every cell of the maze footprint should carry SOMETHING.
const MIN_FILL = 0.40;

export function generateAutoglyph(seed, forceScheme) {
  const rng = _makeRng(seed);
  const scheme = forceScheme || SCHEMES[Math.floor(rng() * SCHEMES.length)];

  // Pick the primary symbol for this glyph. Some schemes (overlapped,
  // two-walk) use a secondary symbol — they pick that internally.
  const primary = 1 + Math.floor(rng() * SYMBOL_COUNT);

  const cells = new Uint8Array(GRID_SIZE);

  switch (scheme) {
    case 'TESSELLATED':  _genTessellated(cells, rng, primary); break;
    case 'HALF_ROTATED': _genHalfRotated(cells, rng, primary); break;
    case 'QUARTER':      _genQuarter(cells, rng, primary); break;
    case 'OVERLAPPED':   _genOverlapped(cells, rng, primary); break;
    case 'MIRRORED':     _genMirrored(cells, rng, primary); break;
    case 'RANDOM_WALK':  _genRandomWalk(cells, rng, primary); break;
    case 'TWO_WALK':     _genTwoWalk(cells, rng, primary); break;
    case 'DIAGONAL':     _genDiagonal(cells, rng, primary); break;
    case 'SPRINKLE':     _genSprinkle(cells, rng, primary); break;
    case 'CHAOS':        _genChaos(cells, rng, primary); break;
  }

  // Density backstop — if the chosen scheme produced a sparse pattern
  // (random walk, sprinkle, anything below MIN_FILL), overlay a
  // tessellated background with a contrasting symbol so the glyph
  // covers the arena. Layered, not replaced — the original motif
  // stays on top, the underlay just fills the empty space.
  let filled = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) filled++;
  let secondary = 0;
  if (filled < MIN_FILL * GRID_SIZE) {
    secondary = _pickContrastingSymbol(rng, primary);
    _underlayTessellated(cells, rng, secondary, MIN_FILL);
  }

  return {
    cells,
    scheme,
    symbol: primary,
    width: GRID_DIM,
    height: GRID_DIM,
  };
}

// Pick a symbol distinct from `primary` so the underlay reads as a
// second motif, not just more of the same.
function _pickContrastingSymbol(rng, primary) {
  let s = 1 + Math.floor(rng() * SYMBOL_COUNT);
  if (s === primary) s = ((s) % SYMBOL_COUNT) + 1;
  return s;
}

// Stamp a tessellated background using `sym`, but only into cells the
// foreground left empty. Brings total fill up to roughly `targetFill`.
function _underlayTessellated(cells, rng, sym, targetFill) {
  const tileDim = 4 + Math.floor(rng() * 5);
  const tile = new Uint8Array(tileDim * tileDim);
  // Scale tile fill to hit roughly the target density. The tile only
  // contributes to empty foreground cells, so over-fill the tile a bit
  // to compensate for the cells the foreground already claimed.
  const fillProb = Math.min(0.85, targetFill + 0.20);
  for (let i = 0; i < tile.length; i++) {
    if (rng() < fillProb) tile[i] = 1;
  }
  for (let y = 0; y < GRID_DIM; y++) {
    for (let x = 0; x < GRID_DIM; x++) {
      const idx = y * GRID_DIM + x;
      if (cells[idx] !== 0) continue;
      const tx = x % tileDim;
      const ty = y % tileDim;
      if (tile[ty * tileDim + tx]) cells[idx] = sym;
    }
  }
}

/**
 * Iterator helper for callers — walks the filled cells of an
 * autoglyph and yields {x, y, sym} tuples. Avoids the caller
 * having to do their own loop with empty checks.
 *
 * @param {{cells: Uint8Array}} glyph
 * @param {(x:number, y:number, sym:number) => void} fn
 */
export function forEachCell(glyph, fn) {
  const { cells } = glyph;
  for (let y = 0; y < GRID_DIM; y++) {
    for (let x = 0; x < GRID_DIM; x++) {
      const sym = cells[y * GRID_DIM + x];
      if (sym !== 0) fn(x, y, sym);
    }
  }
}

/**
 * Count filled cells in a glyph. Used by callers to size particle
 * pools.
 */
export function countFilled(glyph) {
  let n = 0;
  const { cells } = glyph;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 0) n++;
  }
  return n;
}

// =====================================================================
// SCHEME IMPLEMENTATIONS
// =====================================================================

// --------------------------------------------------------------------
// 1. TESSELLATED — single symbol tiled in a regular spacing grid
// --------------------------------------------------------------------
// A small 4×4 to 8×8 tile pattern is chosen (with a few cells filled
// inside it), and that tile is repeated across the whole 64×64 grid.
// Reads as a uniform fabric pattern.
function _genTessellated(cells, rng, sym) {
  const tileDim = 4 + Math.floor(rng() * 5);          // 4..8
  // Build the tile as a binary pattern with ~30-50% fill.
  const tile = new Uint8Array(tileDim * tileDim);
  const fillProb = 0.3 + rng() * 0.2;
  for (let i = 0; i < tile.length; i++) {
    if (rng() < fillProb) tile[i] = 1;
  }
  // Stamp the tile across the grid.
  for (let y = 0; y < GRID_DIM; y++) {
    for (let x = 0; x < GRID_DIM; x++) {
      const tx = x % tileDim;
      const ty = y % tileDim;
      if (tile[ty * tileDim + tx]) {
        cells[y * GRID_DIM + x] = sym;
      }
    }
  }
}

// --------------------------------------------------------------------
// 2. HALF_ROTATED — top half is generated, bottom half is the top
//                   rotated 180°. Reads as point-symmetric.
// --------------------------------------------------------------------
function _genHalfRotated(cells, rng, sym) {
  const half = GRID_DIM / 2;
  // Generate a sparse-to-medium random pattern in the top half.
  const fillProb = 0.15 + rng() * 0.20;
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < GRID_DIM; x++) {
      if (rng() < fillProb) cells[y * GRID_DIM + x] = sym;
    }
  }
  // Mirror to the bottom half with point symmetry (rotate 180° about
  // the grid center). cells[y][x] copies to cells[63-y][63-x].
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < GRID_DIM; x++) {
      if (cells[y * GRID_DIM + x]) {
        cells[(GRID_DIM - 1 - y) * GRID_DIM + (GRID_DIM - 1 - x)] = sym;
      }
    }
  }
}

// --------------------------------------------------------------------
// 3. QUARTER — generate one quadrant, then rotate 90° three times.
//              Result has 4-fold rotational symmetry.
// --------------------------------------------------------------------
function _genQuarter(cells, rng, sym) {
  const half = GRID_DIM / 2;
  const fillProb = 0.18 + rng() * 0.22;
  // Fill only the upper-left quadrant.
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      if (rng() < fillProb) cells[y * GRID_DIM + x] = sym;
    }
  }
  // Rotate-90 copy to the other three quadrants. For a cell at
  // (x, y) in the upper-left, the rotations land at:
  //   90°:  (GRID_DIM-1-y, x)
  //   180°: (GRID_DIM-1-x, GRID_DIM-1-y)
  //   270°: (y, GRID_DIM-1-x)
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      if (cells[y * GRID_DIM + x]) {
        cells[x * GRID_DIM + (GRID_DIM - 1 - y)] = sym;
        cells[(GRID_DIM - 1 - y) * GRID_DIM + (GRID_DIM - 1 - x)] = sym;
        cells[(GRID_DIM - 1 - x) * GRID_DIM + y] = sym;
      }
    }
  }
}

// --------------------------------------------------------------------
// 4. OVERLAPPED — two layers, XOR'd. Each layer is its own scheme
//                 (but a simpler one — tessellated or sprinkle).
//                 Layers may use different symbols.
// --------------------------------------------------------------------
function _genOverlapped(cells, rng, sym) {
  // Pick a second symbol that's distinct from the primary.
  let sym2 = 1 + Math.floor(rng() * SYMBOL_COUNT);
  if (sym2 === sym) sym2 = ((sym2) % SYMBOL_COUNT) + 1;

  // Layer A — tessellated.
  const layerA = new Uint8Array(GRID_SIZE);
  _genTessellated(layerA, rng, sym);

  // Layer B — sprinkle in a different pattern.
  const layerB = new Uint8Array(GRID_SIZE);
  _genSprinkle(layerB, rng, sym2);

  // XOR: cell is filled iff exactly one layer is filled. Where both
  // layers cover, the cell is empty (negative space). Where neither
  // covers, also empty. Visual: textured background with negative-
  // space holes punched by the overlay.
  for (let i = 0; i < GRID_SIZE; i++) {
    const a = layerA[i] !== 0;
    const b = layerB[i] !== 0;
    if (a !== b) {
      cells[i] = a ? sym : sym2;
    }
  }
}

// --------------------------------------------------------------------
// 5. MIRRORED — bilateral (vertical-axis) symmetry. Generate the
//               left half, mirror to the right.
// --------------------------------------------------------------------
function _genMirrored(cells, rng, sym) {
  const half = GRID_DIM / 2;
  const fillProb = 0.20 + rng() * 0.20;
  for (let y = 0; y < GRID_DIM; y++) {
    for (let x = 0; x < half; x++) {
      if (rng() < fillProb) {
        cells[y * GRID_DIM + x] = sym;
        cells[y * GRID_DIM + (GRID_DIM - 1 - x)] = sym;
      }
    }
  }
}

// --------------------------------------------------------------------
// 6. RANDOM_WALK — start at a random cell, walk for ~600 steps,
//                  marking cells as we go. Direction picked each step
//                  with 70% chance to keep going + 30% to turn.
// --------------------------------------------------------------------
function _genRandomWalk(cells, rng, sym) {
  const STEPS = 600 + Math.floor(rng() * 400);
  let x = Math.floor(rng() * GRID_DIM);
  let y = Math.floor(rng() * GRID_DIM);
  // 4 cardinal directions.
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let dir = dirs[Math.floor(rng() * 4)];
  for (let i = 0; i < STEPS; i++) {
    cells[y * GRID_DIM + x] = sym;
    if (rng() < 0.30) dir = dirs[Math.floor(rng() * 4)];
    x = (x + dir[0] + GRID_DIM) % GRID_DIM;
    y = (y + dir[1] + GRID_DIM) % GRID_DIM;
  }
}

// --------------------------------------------------------------------
// 7. TWO_WALK — two random walks, one with the symbol, one as
//               negative space. Visual: a meandering filled trail
//               with a meandering hole punched through it.
// --------------------------------------------------------------------
function _genTwoWalk(cells, rng, sym) {
  // First walk fills.
  _genRandomWalk(cells, rng, sym);
  // Second walk erases — temp grid, then subtract.
  const erase = new Uint8Array(GRID_SIZE);
  _genRandomWalk(erase, rng, 1);
  for (let i = 0; i < GRID_SIZE; i++) {
    if (erase[i]) cells[i] = 0;
  }
}

// --------------------------------------------------------------------
// 8. DIAGONAL — symmetric across the main diagonal (TL → BR).
//               cells[y][x] === cells[x][y].
// --------------------------------------------------------------------
function _genDiagonal(cells, rng, sym) {
  const fillProb = 0.18 + rng() * 0.20;
  for (let y = 0; y < GRID_DIM; y++) {
    for (let x = 0; x <= y; x++) {
      if (rng() < fillProb) {
        cells[y * GRID_DIM + x] = sym;
        cells[x * GRID_DIM + y] = sym;
      }
    }
  }
}

// --------------------------------------------------------------------
// 9. SPRINKLE — sparse small-motif placement. Pick ~30-60 random
//               positions, stamp a tiny shape (1-4 cells) at each.
// --------------------------------------------------------------------
function _genSprinkle(cells, rng, sym) {
  const motifCount = 80 + Math.floor(rng() * 60);   // 80-140 motifs
  // Each motif: 1-4 cells in an L or line shape, placed at a random
  // anchor with small extent.
  for (let m = 0; m < motifCount; m++) {
    const ax = Math.floor(rng() * GRID_DIM);
    const ay = Math.floor(rng() * GRID_DIM);
    const motifSize = 1 + Math.floor(rng() * 4);
    cells[ay * GRID_DIM + ax] = sym;
    for (let i = 1; i < motifSize; i++) {
      // Random small offset from anchor.
      const ox = (Math.floor(rng() * 3) - 1);
      const oy = (Math.floor(rng() * 3) - 1);
      const nx = (ax + ox + GRID_DIM) % GRID_DIM;
      const ny = (ay + oy + GRID_DIM) % GRID_DIM;
      cells[ny * GRID_DIM + nx] = sym;
    }
  }
}

// --------------------------------------------------------------------
// 10. CHAOS — pure random noise field with a tunable density.
// --------------------------------------------------------------------
function _genChaos(cells, rng, sym) {
  const fillProb = 0.20 + rng() * 0.25;       // 20-45% fill
  for (let i = 0; i < GRID_SIZE; i++) {
    if (rng() < fillProb) cells[i] = sym;
  }
}

// =====================================================================
// INTERNAL — RNG (Mulberry32, matches endlessWalls.js for consistency)
// =====================================================================

function _makeRng(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =====================================================================
// EXPORTS
// =====================================================================

export { GRID_DIM, SCHEMES };
