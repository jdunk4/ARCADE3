// ============================================================
// MAZE TEMPLATES — hand-traced layouts from reference images.
//
// Each template is a 19×19 grid of characters:
//   '#'  → wall
//   '.'  → floor
//   'S'  → player spawn (exactly one)
//   'G'  → glyph pickup (one or more; 5 typical)
//
// Templates take precedence over the procedural generator when one
// is available for the current wave (see pickTemplateForWave).
// Mining blocks and kill zones are still placed procedurally on
// top of the template's floor cells per the wave config.
//
// To add a new template: paste a 19-line string into the array.
// Trace top-down; row 0 is the top of the screen, col 0 is left.
// ============================================================

const TEMPLATE_LEVEL_94 = `###################
###################
####.............##
####.............##
####.WWWWWWWWW...##
####.....W.......##
####.....W.......##
####..G..W..G....##
####.....W.......##
####.....W.......##
####.....W.......##
####.....W..G....##
####..G..W.......##
####.....W.......##
####.............##
####.............##
####.S......G....##
###################
###################`;

const TEMPLATE_LEVEL_90 = `###################
###################
##.G.............##
##...............##
##.WWWW...WWWWWW.##
##....W..........##
##....W..WWWW....##
##....W..W.......##
##.G..W..W..G....##
##....W..W.......##
##....WWWW.......##
##...............##
##.WWWWWWWW......##
##.........W.....##
##....G....W..G..##
##.........W.....##
##.........WWWWW.##
##........S......##
###################`;

const TEMPLATE_LEVEL_93 = `###################
###################
##.G.............##
##...............##
##.WWWWWWWWWWWWW.##
##.W...W.....W.W.##
##.W.G.W..G..W.W.##
##.W...W.....W.W.##
##.W...W.....W.W.##
##.W...W.....W.W.##
##.W...W.....W.W.##
##.W...W.....W.W.##
##.W...W.....W.W.##
##.W...W..G..W.W.##
##.W...WWWWWWW.W.##
##.W.S.........W.##
##.WWWWWWWWWWWWW.##
##...............##
###################`;

const TEMPLATE_LEVEL_45 = `###################
###################
###################
###################
####.S......G..####
####.WWWW.WWWW.####
####.W.......W.####
####.W..G....W.####
####.W.......W.####
####.W.WWWWW.W.####
####.W.......W.####
####.W..G....W.####
####.W.......W.####
####.WWWW.WWWW.####
####.G......G..####
###################
###################
###################
###################`;

const TEMPLATE_LEVEL_BLOCKS = `###################
###################
##.S.............##
##...............##
##....WW....WW...##
##....WW....WW...##
##.G.............##
##......WWWWW....##
##......W.......G##
##......W........##
##.WWWW.W.WWWW...##
##.W..W.W.W..W...##
##.W..W.W.W..W...##
##.WWWW...WWWW.G.##
##...............##
##.G.....WWWW....##
##.......WWWW....##
##...............##
###################`;

// Snake/zig-zag corridor through interior
const TEMPLATE_LEVEL_51 = `###################
###################
##.S.............##
##.WWWWWWWWWWWW..##
##............W..##
##.WWWWWWWWW..W..##
##.W.......W..W..##
##.W..G....W..W..##
##.W.......W..W..##
##.W.WWWWW.W..W..##
##.W.....W.W..W..##
##.W..G..W.W.GW..##
##.WWWWWWW.W..W..##
##.........W..W..##
##.WWWWWWWWW..W..##
##.W..G.......W..##
##.W..........W..##
##.WWWWWWWWWWWW..##
###################`;

// Diagonal stair-step corridor
const TEMPLATE_LEVEL_36 = `###################
###################
##........WWWWWW.##
##.S......W......##
##.WWWWWWWW....G.##
##.W.............##
##.W..WWWWWWWW...##
##.W..W..........##
##.W..W..WWWWWW..##
##.W..W..W....W..##
##.W..W..W.G..W..##
##.W..W..W....W..##
##.W..W..WWWW.W..##
##.W..W.......W..##
##.W..WWWWWWWWW..##
##.W.............##
##.WWWWWWWWWWWW..##
##............G..##
###################`;

// Open arena with scattered wall blocks
const TEMPLATE_LEVEL_92 = `###################
###################
###################
###..............##
###..WW.....WW...##
###..WW..G..WW...##
###..............##
###....WWWWW.....##
###..G.W.........##
###....W..G......##
###.WW.W.WW......##
###.W..W..W......##
###.WW....WW.....##
###..............##
###.....S........##
###.WWWWWWWWW....##
###..............##
###################
###################`;

// Complex zig-zag with multiple wall segments
const TEMPLATE_LEVEL_40 = `###################
###################
##.WWWWWWWWWWWWW.##
##.W...........W.##
##.W.WWWWWWWW..W.##
##.W.W......W..W.##
##.W.W..G...W..W.##
##.W.W......W..W.##
##.W.WWWWW..W..W.##
##.W..G....WW.GW.##
##.W.WWWWWW....W.##
##.W.W....W....W.##
##.W.W.G..W....W.##
##.W.W....W....W.##
##.W.WWWW.W....W.##
##.W......W....W.##
##.W..S...WWWWWW.##
##.WWWWWWWWWWWWW.##
###################`;

export const MAZE_TEMPLATES = [
  TEMPLATE_LEVEL_45,        // wave 1 — small + simple
  TEMPLATE_LEVEL_94,        // wave 2 — center pillar
  TEMPLATE_LEVEL_51,        // wave 3 — snake zig-zag
  TEMPLATE_LEVEL_92,        // wave 4 — open + scattered blocks
  TEMPLATE_LEVEL_BLOCKS,    // wave 5 — block obstacles
  TEMPLATE_LEVEL_36,        // wave 6 — diagonal stair-step
  TEMPLATE_LEVEL_93,        // wave 7 — parallel corridors
  TEMPLATE_LEVEL_90,        // wave 8 — multi-corridor
  TEMPLATE_LEVEL_40,        // wave 9 — complex zig-zag
];

/**
 * Pick the template that maps to the given wave number, or null if
 * we've run out of templates and should fall back to procedural.
 *
 * Wave 1 → template[0], wave 2 → template[1], etc.
 * Past the template count, returns null and the caller should
 * generate procedurally.
 */
export function pickTemplateForWave(waveNum) {
  const idx = (waveNum | 0) - 1;
  if (idx < 0 || idx >= MAZE_TEMPLATES.length) return null;
  return MAZE_TEMPLATES[idx];
}

/**
 * Parse a template string into MazeData-compatible fields. Returns
 * null on any parse error so the caller can fall back to procedural.
 *
 * @returns {{
 *   cols: number, rows: number,
 *   cells: Array<{kind: 'floor'|'wall'}>,
 *   spawn: {col: number, row: number},
 *   glyphs: Array<{col: number, row: number}>,
 * } | null}
 */
export function parseTemplate(str) {
  const lines = str.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return null;
  const rows = lines.length;
  const cols = lines[0].length;
  // Sanity — every row must be the same length.
  for (const line of lines) {
    if (line.length !== cols) return null;
  }
  const cells = new Array(cols * rows);
  let spawn = null;
  const glyphs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = lines[r][c];
      const isWall = ch === '#';
      cells[r * cols + c] = { kind: isWall ? 'wall' : 'floor' };
      if (ch === 'S') spawn = { col: c, row: r };
      else if (ch === 'G') glyphs.push({ col: c, row: r });
    }
  }
  if (!spawn) return null;     // spawn is required
  return { cols, rows, cells, spawn, glyphs };
}
