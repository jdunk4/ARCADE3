// =====================================================================
// TUTORIAL MODE
// =====================================================================
// A practice arena that mirrors the real game layout but swaps the floor
// for a rainbow grid of numbered tiles (think: Copic-marker color caps).
// Orange sits in the upper-left corner; the gradient sweeps clockwise
// through yellow → green → blue → purple to the opposite corner.
// All enemies in tutorial mode are forced black or white so they read
// clearly against the rainbow floor. Player gets every weapon unlocked
// from the start so they can practice cycling through the arsenal.
//
// Public API:
//   isTutorialActive()   → boolean
//   setTutorialActive(b) → set the flag (called by main.js)
//   applyTutorialFloor() → swap the ground material to the rainbow texture
//   restoreNormalFloor() → restore the original checker texture
//   tutorialEnemyColor(defaultTint) → returns either 0x000000 or 0xffffff
//                                      to override per-spawn enemy tints
//   tutorialSpawnRateOverride(defaultRate) → clamps the spawn rate to 1..2
//                                            for the chill tutorial pace
// =====================================================================

import * as THREE from 'three';
import { ARENA } from './config.js';
import { Scene, scene } from './scene.js';

let _active = false;
let _originalTexture = null;     // saved checker texture so we can restore
let _rainbowTexture = null;      // built once, cached
let _rainbowMaterial = null;     // optional: a parallel material we swap in

export function isTutorialActive() { return _active; }
export function setTutorialActive(b) { _active = !!b; }

// ---------------------------------------------------------------------
// Build the rainbow floor texture — Hues & Cues style, sized to match
// the game arena.
//
// The game floor is square (PlaneGeometry(ARENA*2, ARENA*2) = 100×100
// units) and the engine renders a 40×40 GridHelper overlay on top.
// We build a SQUARE texture with a 20×20 tile grid so:
//   • The texture's aspect ratio matches the floor — no stretching.
//   • Each tutorial tile aligns with a 2×2 block of game grid cells,
//     so the in-game grid lines visibly subdivide every tutorial
//     tile evenly.
//
// Layout:
//   • 20 columns × 20 rows of color tiles. No grayscale strip on top
//     (per user direction: ignore the black/white strip).
//   • Row letters A..T labeled on the LEFT and RIGHT edges.
//   • Column numbers 1..20 labeled on the TOP and BOTTOM edges.
//   • Tiles themselves are unlabeled — like the reference board, only
//     the borders carry labels.
//
// Color computation (unchanged from previous iteration):
//   The reference board flows the rainbow DIAGONALLY. Red top-left,
//   purple top-right, yellow-green bottom-left, cyan bottom-right.
//   Every tile is a bilinear RGB blend of the four corner colors,
//   re-saturated to keep mid-tones vivid (raw bilerp lands on gray),
//   then nudged toward white in the F–J pastel band.
//
// Orange → purple constraint still holds: red/orange dominates the
// left side of the board, purple lives on the right.
// ---------------------------------------------------------------------
const GRID_COLS = 20;
const GRID_ROWS = 20;
// Square texture so it maps 1:1 onto the square floor plane.
// Border eats some pixels for the letter/number rails; cell pixels
// are derived from what's left.
const BORDER_PX = 90;
const CELL_PX = 130;                                  // 20 × 130 = 2600 inner
const TEX_W = GRID_COLS * CELL_PX + BORDER_PX * 2;    // 2780
const TEX_H = GRID_ROWS * CELL_PX + BORDER_PX * 2;    // 2780 (square)

// Four corner colors. Pumped near-saturation so the bilinear midpoints
// stay vivid instead of sinking to mud, AND so the chapter lighting
// doesn't drag the floor down to gray on a dim wave theme.
//   TL = top-left     = vivid red
//   TR = top-right    = vivid purple/violet
//   BL = bottom-left  = vivid yellow-green
//   BR = bottom-right = vivid cyan
const CORNERS = {
  TL: { r: 255, g:  20, b:  60 },   // red
  TR: { r: 200, g:  50, b: 255 },   // purple
  BL: { r: 230, g: 255, b:  40 },   // yellow-green
  BR: { r:  40, g: 235, b: 255 },   // cyan
};

function lerp(a, b, t) { return a + (b - a) * t; }

function bilerpRGB(u, v) {
  const r = lerp(lerp(CORNERS.TL.r, CORNERS.TR.r, u),
                 lerp(CORNERS.BL.r, CORNERS.BR.r, u), v);
  const g = lerp(lerp(CORNERS.TL.g, CORNERS.TR.g, u),
                 lerp(CORNERS.BL.g, CORNERS.BR.g, u), v);
  const b = lerp(lerp(CORNERS.TL.b, CORNERS.TR.b, u),
                 lerp(CORNERS.BL.b, CORNERS.BR.b, u), v);
  return { r, g, b };
}

// Sample the rainbow floor's color at a world (x, z) coordinate.
// Returns a hex color number suitable for THREE.Color.setHex().
// Used by the tutorial under-foot glow to read the tile color the
// player is currently standing on. ARENA defines the half-extent of
// the floor (game uses PlaneGeometry(ARENA*2, ARENA*2) = 100×100),
// so worldX in [-ARENA, ARENA] → u in [0..1]. Same applies to z/v.
export function getTutorialFloorColorAt(worldX, worldZ) {
  let u = (worldX + ARENA) / (2 * ARENA);
  let v = (worldZ + ARENA) / (2 * ARENA);
  if (u < 0) u = 0; else if (u > 1) u = 1;
  if (v < 0) v = 0; else if (v > 1) v = 1;
  // Apply the same saturation curve buildRainbowTexture uses so the
  // glow matches the floor texel under the player. (Without this the
  // glow color would be the raw bilinear blend, which reads as muddier
  // than the saturated tile.)
  const dx = u - 0.5, dy = v - 0.5;
  const distToCenter = Math.sqrt(dx * dx + dy * dy);
  const satAmt = 0.55 - distToCenter * 0.35;
  let color = bilerpRGB(u, v);
  // Inline saturate() — duplicated from buildRainbowTexture to avoid
  // a needless function call in a hot per-frame path.
  const gray = (color.r + color.g + color.b) / 3;
  const sat1 = 1 + satAmt;
  let r = gray + (color.r - gray) * sat1;
  let g = gray + (color.g - gray) * sat1;
  let b = gray + (color.b - gray) * sat1;
  if (r < 0) r = 0; else if (r > 255) r = 255;
  if (g < 0) g = 0; else if (g > 255) g = 255;
  if (b < 0) b = 0; else if (b > 255) b = 255;
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

// MAXIMUM-SATURATION glow color sampler. Returns the tile's hue at
// full saturation and high lightness — the "vivid" version of the
// floor color that reads as a properly saturated highlight, not a
// washed-out bright patch.
//
// Why a separate function: getTutorialFloorColorAt above samples the
// FLOOR's actual painted color (matched to the texel pattern). For
// the cell highlight overlay we want something MORE vivid — pump
// saturation to 100% and lightness to ~55% via HSL conversion.
// Result: even pastel-ish or near-gray cells get a bold tinted
// highlight when the player walks over them, instead of looking
// like a brighter version of the same washy tile.
export function getTutorialGlowColorAt(worldX, worldZ) {
  // Start from the floor color (same hue, smooth blending across cells).
  const baseHex = getTutorialFloorColorAt(worldX, worldZ);
  // Convert to HSL via THREE.Color — handles the math correctly and
  // avoids reimplementing the conversion. Pump saturation to 1.0 and
  // lightness to 0.55 (the visual sweet spot — high enough to be
  // bright, low enough to keep hue identity instead of washing white).
  const c = _glowTmp.setHex(baseHex);
  c.getHSL(_glowHsl);
  c.setHSL(_glowHsl.h, 1.0, 0.55);
  return c.getHex();
}
// Reusable scratch objects to avoid per-frame allocation in the hot
// glow update path.
const _glowTmp = new THREE.Color();
const _glowHsl = { h: 0, s: 0, l: 0 };

// Snap a world (x, z) point to the rainbow texture's grid cell and
// return that cell's center world position, world-space size, and
// color. Used by the tutorial floor-glow to highlight the SPECIFIC
// tile the player is standing on (rather than a circular spotlight).
//
// Cell layout: 20×20 cells inside the texture's inner area, which
// occupies texture pixels [BORDER_PX..(TEX_W-BORDER_PX)] on each axis.
// The texture maps 1:1 onto the floor mesh (PlaneGeometry(2*ARENA),
// so 100×100 worldspace), which means the rainbow zone in world
// coords runs from -ARENA + (BORDER_PX/TEX_W)*2*ARENA on the low end
// to +ARENA - (BORDER_PX/TEX_W)*2*ARENA on the high end. Cells are
// uniform within that zone.
//
// Returns null when (x, z) falls outside the rainbow zone (player
// standing on the black border rails).
export function getTutorialCellInfo(worldX, worldZ) {
  const innerHalf = ARENA - (BORDER_PX / TEX_W) * (2 * ARENA);
  if (worldX < -innerHalf || worldX > innerHalf) return null;
  if (worldZ < -innerHalf || worldZ > innerHalf) return null;
  const cellSize = (2 * innerHalf) / GRID_COLS;
  // 0..GRID_COLS-1 indices.
  const col = Math.min(GRID_COLS - 1, Math.max(0, Math.floor((worldX + innerHalf) / cellSize)));
  const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((worldZ + innerHalf) / cellSize)));
  // Cell center in world coords.
  const cx = -innerHalf + (col + 0.5) * cellSize;
  const cz = -innerHalf + (row + 0.5) * cellSize;
  return {
    x: cx,
    z: cz,
    size: cellSize,
    color: getTutorialGlowColorAt(cx, cz),
    col, row,
  };
}

// Push a color toward white by amount t in [0..1]. Used for the
// pastel mid-band.
function tintWhite(rgb, t) {
  return {
    r: rgb.r + (255 - rgb.r) * t,
    g: rgb.g + (255 - rgb.g) * t,
    b: rgb.b + (255 - rgb.b) * t,
  };
}

// Push a color away from gray to keep saturation up. amount in [0..1].
// Boosts the distance from the per-pixel grayscale value.
function saturate(rgb, amount) {
  const gray = (rgb.r + rgb.g + rgb.b) / 3;
  return {
    r: Math.max(0, Math.min(255, gray + (rgb.r - gray) * (1 + amount))),
    g: Math.max(0, Math.min(255, gray + (rgb.g - gray) * (1 + amount))),
    b: Math.max(0, Math.min(255, gray + (rgb.b - gray) * (1 + amount))),
  };
}

function buildRainbowTexture() {
  const c = document.createElement('canvas');
  c.width = TEX_W;
  c.height = TEX_H;
  const ctx = c.getContext('2d');

  // Black border for the letter/number rails.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // Build the color cells. Each tile is rendered as a rounded rect
  // with a soft inner bevel — top-left highlight, bottom-right
  // shadow — so each color reads as its own raised tile rather
  // than a flat fill. Gap between rounded shapes shows the black
  // background as natural grout, eliminating the need for a
  // separate grid-line pass.
  //
  // Tile geometry:
  //   inset:  small margin so the rounded corners have visible
  //           gap (the grout) between adjacent tiles.
  //   radius: 12% of the cell size — gentle round-over, not a pill.
  //
  // Bevel layers (drawn in order, top of the stack last):
  //   1. Tile color fill inside the rounded path
  //   2. Diagonal gradient overlay: bright at top-left (~12% white),
  //      transparent in the middle, dark at bottom-right (~22% black)
  //   3. Top-left highlight stroke (1.5px, white at 40% alpha)
  //   4. Bottom-right shadow stroke (1.5px, black at 35% alpha)
  // Together these read as a tile catching light from above-left.
  const TILE_INSET = Math.max(2, Math.floor(CELL_PX * 0.025));    // ~3px grout
  const TILE_RADIUS = Math.max(6, Math.floor(CELL_PX * 0.12));    // ~16px corner
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const u = col / (GRID_COLS - 1);   // horizontal: 0=left, 1=right
      const v = row / (GRID_ROWS - 1);   // vertical:   0=top,  1=bottom

      // Bilinear RGB blend between the four corner colors. This keeps
      // the gradient smooth across the whole board — no hue-wraparound
      // jumps you'd get from interpolating in HSL space.
      let color = bilerpRGB(u, v);

      // Re-saturate. RGB bilinear interpolation produces muddy mid-
      // tones because complementary corner colors average toward gray.
      // We push the result HARD back away from gray, *more* in the
      // middle of the board than at the corners, so the center reads
      // as the single most vibrant region. (Earlier iteration washed
      // the center toward white — opposite of what we want.)
      // Distance from board center, max ~0.71 at the corners.
      const dx = u - 0.5, dy = v - 0.5;
      const distToCenter = Math.sqrt(dx * dx + dy * dy);
      // Saturation amount: 0.55 at center, 0.30 at the corners.
      const satAmt = 0.55 - distToCenter * 0.35;
      color = saturate(color, satAmt);

      const rr = Math.round(color.r);
      const gg = Math.round(color.g);
      const bb = Math.round(color.b);

      // Tile bounds — outer cell is CELL_PX × CELL_PX, with the
      // rounded tile inset by TILE_INSET on every side.
      const cellX = BORDER_PX + col * CELL_PX;
      const cellY = BORDER_PX + row * CELL_PX;
      const tx = cellX + TILE_INSET;
      const ty = cellY + TILE_INSET;
      const tw = CELL_PX - TILE_INSET * 2;
      const th = CELL_PX - TILE_INSET * 2;

      // ----- Step 1: Fill rounded rect with tile color -----
      ctx.beginPath();
      ctx.moveTo(tx + TILE_RADIUS, ty);
      ctx.arcTo(tx + tw, ty,           tx + tw, ty + th,      TILE_RADIUS);
      ctx.arcTo(tx + tw, ty + th,      tx,      ty + th,      TILE_RADIUS);
      ctx.arcTo(tx,      ty + th,      tx,      ty,           TILE_RADIUS);
      ctx.arcTo(tx,      ty,           tx + tw, ty,           TILE_RADIUS);
      ctx.closePath();
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      ctx.fill();

      // ----- Step 2: Diagonal bevel gradient (light → shadow) -----
      // Linear gradient from top-left to bottom-right. Translucent
      // white near the top-left, transparent through the middle,
      // translucent black at the bottom-right. Clipped to the
      // rounded tile path so the overlay doesn't bleed into the
      // grout. We re-build the path as a clip region.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(tx + TILE_RADIUS, ty);
      ctx.arcTo(tx + tw, ty,           tx + tw, ty + th,      TILE_RADIUS);
      ctx.arcTo(tx + tw, ty + th,      tx,      ty + th,      TILE_RADIUS);
      ctx.arcTo(tx,      ty + th,      tx,      ty,           TILE_RADIUS);
      ctx.arcTo(tx,      ty,           tx + tw, ty,           TILE_RADIUS);
      ctx.closePath();
      ctx.clip();
      const grad = ctx.createLinearGradient(tx, ty, tx + tw, ty + th);
      grad.addColorStop(0.00, 'rgba(255,255,255,0.18)');
      grad.addColorStop(0.45, 'rgba(255,255,255,0.00)');
      grad.addColorStop(0.55, 'rgba(0,0,0,0.00)');
      grad.addColorStop(1.00, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = grad;
      ctx.fillRect(tx, ty, tw, th);
      ctx.restore();

      // ----- Step 3: Inner bevel highlight (top + left edges) -----
      // Trace just the top + left arcs to get a "lit edge" effect.
      // We use a short stroke that only covers the upper-left
      // quadrant of the rounded rect. Drawn at 40% white so the
      // edge looks lit without becoming chalky.
      ctx.save();
      ctx.lineWidth = Math.max(1.5, CELL_PX * 0.012);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.40)';
      ctx.beginPath();
      // Left edge
      ctx.moveTo(tx, ty + th - TILE_RADIUS);
      ctx.lineTo(tx, ty + TILE_RADIUS);
      // Top-left corner arc (quarter)
      ctx.arcTo(tx, ty, tx + TILE_RADIUS, ty, TILE_RADIUS);
      // Top edge
      ctx.lineTo(tx + tw - TILE_RADIUS, ty);
      ctx.stroke();
      ctx.restore();

      // ----- Step 4: Inner bevel shadow (right + bottom edges) -----
      ctx.save();
      ctx.lineWidth = Math.max(1.5, CELL_PX * 0.012);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      // Right edge
      ctx.moveTo(tx + tw, ty + TILE_RADIUS);
      ctx.lineTo(tx + tw, ty + th - TILE_RADIUS);
      // Bottom-right corner arc (quarter)
      ctx.arcTo(tx + tw, ty + th, tx + tw - TILE_RADIUS, ty + th, TILE_RADIUS);
      // Bottom edge
      ctx.lineTo(tx + TILE_RADIUS, ty + th);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Border labels — column numbers (top + bottom) and row letters
  // (left + right). White on the black border, just like the
  // reference.
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Column numbers, top + bottom.
  ctx.font = `bold ${Math.floor(BORDER_PX * 0.45)}px "Impact", "Arial Black", sans-serif`;
  for (let col = 0; col < GRID_COLS; col++) {
    const cx = BORDER_PX + (col + 0.5) * CELL_PX;
    const label = String(col + 1);
    ctx.fillText(label, cx, BORDER_PX / 2);
    ctx.fillText(label, cx, TEX_H - BORDER_PX / 2);
  }

  // Row letters, left + right.
  const LETTERS = 'ABCDEFGHIJKLMNOPQRST';
  ctx.font = `bold ${Math.floor(BORDER_PX * 0.55)}px "Impact", "Arial Black", sans-serif`;
  for (let row = 0; row < GRID_ROWS; row++) {
    const cy = BORDER_PX + (row + 0.5) * CELL_PX;
    const ch = LETTERS[row];
    ctx.fillText(ch, BORDER_PX / 2, cy);
    ctx.fillText(ch, TEX_W - BORDER_PX / 2, cy);
  }

  // Grid-line pass removed — the rounded-corner tiles with their
  // grout gap and bevel strokes already separate visually. Adding
  // explicit grid lines on top would compete with the bevel
  // highlight/shadow lines and clutter the floor.

  const tex = new THREE.CanvasTexture(c);
  // Color space MUST be sRGB so the renderer (which outputs sRGB)
  // doesn't read the canvas as linear and wash everything to gray.
  // This was the actual cause of the "floor looks gray even though
  // we set vibrant corners" bug — the colors *were* vibrant in the
  // canvas, but a missing colorSpace flag let three.js gamma-shift
  // them on read.
  tex.colorSpace = THREE.SRGBColorSpace;
  // No tiling — one giant texture maps 1:1 onto the floor plane so each
  // canvas cell is one arena cell.
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1, 1);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------
// Tile bevel mask — a single small canvas texture shaped like one
// rounded-corner beveled tile. White on transparent. Used by the
// player's under-foot highlight so the highlight is the same shape
// (rounded rect with diagonal bevel highlight + shadow) as the floor
// tiles themselves. The shape's shape-of-tile alpha + bevel
// brightening means a flat plane mesh tinted to the cell color
// reads as a tile rising out of the floor.
//
// Built once and cached. Same proportions as the floor-tile bevel
// drawn in buildRainbowTexture (12% corner radius, soft diagonal
// highlight/shadow gradient). Pixel size kept moderate (256) since
// the highlight covers ~5u world space and aniso filters smooth it.
// ---------------------------------------------------------------------
let _tileBevelMaskTex = null;
export function getTileBevelMaskTexture() {
  if (_tileBevelMaskTex) return _tileBevelMaskTex;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  // Transparent background — alpha outside the rounded shape stays 0.
  ctx.clearRect(0, 0, size, size);

  const inset = 4;                           // matches floor TILE_INSET ratio
  const tx = inset, ty = inset;
  const tw = size - inset * 2;
  const th = size - inset * 2;
  const radius = Math.floor(tw * 0.12);

  // Rounded rect path
  ctx.beginPath();
  ctx.moveTo(tx + radius, ty);
  ctx.arcTo(tx + tw, ty,         tx + tw, ty + th,   radius);
  ctx.arcTo(tx + tw, ty + th,    tx,      ty + th,   radius);
  ctx.arcTo(tx,      ty + th,    tx,      ty,        radius);
  ctx.arcTo(tx,      ty,         tx + tw, ty,        radius);
  ctx.closePath();
  // Fill with pure white — the material.color set on the highlight
  // mesh will multiply this to the cell color at sample time.
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Bevel: clip to the rounded shape and overlay the same diagonal
  // highlight/shadow gradient as the floor tiles. The gradient is
  // baked into the white channel — it'll multiply against material
  // color to produce a brighter top-left and darker bottom-right
  // edge on the highlight.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tx + radius, ty);
  ctx.arcTo(tx + tw, ty,         tx + tw, ty + th,   radius);
  ctx.arcTo(tx + tw, ty + th,    tx,      ty + th,   radius);
  ctx.arcTo(tx,      ty + th,    tx,      ty,        radius);
  ctx.arcTo(tx,      ty,         tx + tw, ty,        radius);
  ctx.closePath();
  ctx.clip();
  const grad = ctx.createLinearGradient(tx, ty, tx + tw, ty + th);
  grad.addColorStop(0.00, 'rgba(255,255,255,0.30)');
  grad.addColorStop(0.50, 'rgba(255,255,255,0.00)');
  grad.addColorStop(1.00, 'rgba(0,0,0,0.30)');
  ctx.fillStyle = grad;
  ctx.fillRect(tx, ty, tw, th);
  ctx.restore();

  // Inner highlight stroke (top + left)
  ctx.save();
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.70)';
  ctx.beginPath();
  ctx.moveTo(tx, ty + th - radius);
  ctx.lineTo(tx, ty + radius);
  ctx.arcTo(tx, ty, tx + radius, ty, radius);
  ctx.lineTo(tx + tw - radius, ty);
  ctx.stroke();
  ctx.restore();

  // Inner shadow stroke (right + bottom)
  ctx.save();
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.moveTo(tx + tw, ty + radius);
  ctx.lineTo(tx + tw, ty + th - radius);
  ctx.arcTo(tx + tw, ty + th, tx + tw - radius, ty + th, radius);
  ctx.lineTo(tx + radius, ty + th);
  ctx.stroke();
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _tileBevelMaskTex = tex;
  return tex;
}

// ---------------------------------------------------------------------
// Apply / restore the floor material. We don't replace the mesh — just
// swap the texture on the existing groundMat. That keeps shadows, fog,
// and lighting all unchanged structurally; we just push the floor's
// brightness way up so it reads as VIBRANT instead of getting dragged
// down to muddy gray by the chapter's ambient/fog tint.
//
// Three things drive the brightness boost:
//   1. The texture itself uses near-saturation corner colors and a
//      lighter pastel boost than the original.
//   2. We set groundMat.emissive to white and emissiveIntensity high
//      so the floor self-illuminates and doesn't depend on the moon
//      directional or the dim chapter ambient.
//   3. We crush roughness to 1.0 so we don't get specular hot-spots
//      that look like glare on the bright floor.
// ---------------------------------------------------------------------
let _matSnapshot = null;     // captures pre-tutorial groundMat lighting

export function applyTutorialFloor() {
  if (!Scene || !Scene.groundMat) return;
  if (!_rainbowTexture) _rainbowTexture = buildRainbowTexture();
  if (!_originalTexture) _originalTexture = Scene.groundMat.map;
  // Snapshot the parts of the material we're about to change so
  // restoreNormalFloor can put them back exactly.
  if (!_matSnapshot) {
    _matSnapshot = {
      color: Scene.groundMat.color.getHex(),
      emissive: Scene.groundMat.emissive ? Scene.groundMat.emissive.getHex() : 0x000000,
      emissiveIntensity: Scene.groundMat.emissiveIntensity || 0,
      emissiveMap: Scene.groundMat.emissiveMap || null,
      roughness: Scene.groundMat.roughness,
      metalness: Scene.groundMat.metalness,
    };
  }

  Scene.groundMat.map = _rainbowTexture;
  // Reset the base color tint so the rainbow shows true to its hues
  // instead of being multiplied by the chapter's lamp color.
  Scene.groundMat.color.setHex(0xffffff);
  // Self-illumination: use the same texture as the emissive map. This
  // makes every tile glow with its own color, so dim chapter lighting
  // can't pull the floor toward gray. emissiveIntensity 1.0 means the
  // floor effectively ignores ambient/fog and shows its native color.
  Scene.groundMat.emissive = new THREE.Color(0xffffff);
  Scene.groundMat.emissiveMap = _rainbowTexture;
  Scene.groundMat.emissiveIntensity = 1.0;
  // Kill specularity / metal shine so we don't get camera-angle
  // hot-spots glaring back at the player.
  Scene.groundMat.roughness = 1.0;
  Scene.groundMat.metalness = 0.0;
  Scene.groundMat.needsUpdate = true;

  // Hide the chapter grid overlay during tutorial. The GridHelper is
  // a 40×40 subdivision (2.5u per cell) used by hazard alignment in
  // chapters 2-7, but the rainbow tutorial tiles are 20×20 — so the
  // grid lines fall through the middle of every tile, creating the
  // "smaller subdivisions" the player sees. Per playtester: those
  // gridlines don't light up with the colored tiles or align with
  // the bevels. The bevel + grout gap on the rounded rainbow tiles
  // already self-separates visually, so the grid overlay is pure
  // noise during tutorial. We zero its opacity instead of removing
  // it from the scene since restoreNormalFloor expects the helper
  // to be present.
  if (Scene.gridHelper && Scene.gridHelper.material) {
    Scene.gridHelper.material.opacity = 0;
    Scene.gridHelper.material.needsUpdate = true;
  }
}

export function restoreNormalFloor() {
  if (!Scene || !Scene.groundMat) return;
  if (_originalTexture) {
    Scene.groundMat.map = _originalTexture;
    _originalTexture = null;
  }
  if (_matSnapshot) {
    Scene.groundMat.color.setHex(_matSnapshot.color);
    if (Scene.groundMat.emissive) Scene.groundMat.emissive.setHex(_matSnapshot.emissive);
    Scene.groundMat.emissiveIntensity = _matSnapshot.emissiveIntensity;
    Scene.groundMat.emissiveMap = _matSnapshot.emissiveMap;
    Scene.groundMat.roughness = _matSnapshot.roughness;
    Scene.groundMat.metalness = _matSnapshot.metalness;
    _matSnapshot = null;
  }
  Scene.groundMat.needsUpdate = true;
  if (Scene.gridHelper && Scene.gridHelper.material) {
    Scene.gridHelper.material.opacity = 0.15;
    Scene.gridHelper.material.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------
// Enemy color override — every tutorial enemy is either black or white,
// alternating randomly so they pop on every region of the rainbow floor.
// ---------------------------------------------------------------------
export function tutorialEnemyColor(_defaultTint) {
  // Even split. Black reads strongly on the lighter (yellow/green) tiles;
  // white reads strongly on the deeper (blue/purple/orange) ones.
  return Math.random() < 0.5 ? 0x000000 : 0xffffff;
}

// ---------------------------------------------------------------------
// Spawn rate clamp — keep tutorial chill at 1..2 spawns/sec regardless
// of what the underlying wave def asks for.
// ---------------------------------------------------------------------
export function tutorialSpawnRateOverride(defaultRate) {
  // Always return something in [1, 2]. If the wave's native rate is
  // already in that band we leave it alone; otherwise we clamp.
  if (defaultRate >= 1 && defaultRate <= 2) return defaultRate;
  return Math.max(1, Math.min(2, defaultRate || 1.5));
}

// ---------------------------------------------------------------------
// Renderer shadow toggle. Tutorial mode wants a flat, bare-bones look
// — shadows add depth that fights the "polar opposite from the game"
// direction. We snapshot the renderer's shadow state on entry and
// restore it on exit so a normal run after the tutorial keeps shadows.
//
// NOTE: setting renderer.shadowMap.enabled = false alone does NOT
// remove visible shadows; three.js still composites the existing
// shadow map. We also have to disable castShadow on the directional
// light (moon) which is the only shadow caster in this scene. Other
// lights are point/hemi/rim and don't cast shadows.
// ---------------------------------------------------------------------
let _shadowSnapshot = null;
export function disableShadows(renderer) {
  if (!renderer) return;
  if (_shadowSnapshot === null) {
    _shadowSnapshot = {
      enabled: renderer.shadowMap.enabled,
      moonCast: Scene && Scene.moon ? Scene.moon.castShadow : null,
    };
  }
  renderer.shadowMap.enabled = false;
  if (Scene && Scene.moon) Scene.moon.castShadow = false;
}
export function restoreShadows(renderer) {
  if (!renderer || _shadowSnapshot === null) return;
  renderer.shadowMap.enabled = _shadowSnapshot.enabled;
  if (Scene && Scene.moon && _shadowSnapshot.moonCast !== null) {
    Scene.moon.castShadow = _shadowSnapshot.moonCast;
  }
  _shadowSnapshot = null;
}

// ---------------------------------------------------------------------
// Fog toggle. Tutorial mode wants a flat, fully-visible arena — the
// chapter fog (near=30, far=85, dark color) crushes the perimeter
// into darkness which fights the vibrant rainbow floor and the
// "polar opposite from the game" tutorial direction. Push fog
// distances way past the arena diagonal so nothing reaches the
// falloff zone, then restore the original values on exit.
//
// We tweak near/far rather than null-out scene.fog because removing
// the fog object entirely can trigger Three.js material recompiles
// — and several modules (rain, hazards, particles) check fog
// presence at construction time. Keeping the object alive but
// effectively neutralized avoids that whole class of issue.
// ---------------------------------------------------------------------
let _fogSnapshot = null;
export function disableFog() {
  if (!scene) return;
  if (_fogSnapshot === null) {
    _fogSnapshot = {
      near: scene.fog ? scene.fog.near : null,
      far: scene.fog ? scene.fog.far : null,
      color: scene.fog ? scene.fog.color.getHex() : null,
      // scene.background is the SECOND fog source: the fogRing module
      // sets it to pure black so distant geometry past the player's
      // visibility ring fades to absolute dark. In tutorial mode that
      // black background bleeds into the perimeter and reads as "fog
      // is still here." Snapshot + restore both fog and bg so neither
      // leaks into the tutorial's bright, fully-lit look.
      bg: (scene.background && scene.background.getHex) ? scene.background.getHex() : null,
    };
  }
  if (scene.fog) {
    // Effectively kill fog by pushing the falloff well past anything
    // ever rendered. Arena diagonal is ~141u; 5000 is comfortably out.
    scene.fog.near = 5000;
    scene.fog.far = 5001;
    // Bright fog color in case any edge case still picks up the tint.
    scene.fog.color.setHex(0xffffff);
  }
  if (scene.background && scene.background.setHex) {
    // Bright sky so the tutorial's perimeter doesn't fade to black.
    // Picked a soft off-white that matches the tutorial's clean look
    // without being a glaring pure-white that overwhelms the arena's
    // saturated rainbow palette.
    scene.background.setHex(0xeeeeee);
  }
}
export function restoreFog() {
  if (!scene || _fogSnapshot === null) return;
  if (scene.fog && _fogSnapshot.near !== null) {
    scene.fog.near = _fogSnapshot.near;
    scene.fog.far = _fogSnapshot.far;
    scene.fog.color.setHex(_fogSnapshot.color);
  }
  if (scene.background && _fogSnapshot.bg !== null && scene.background.setHex) {
    scene.background.setHex(_fogSnapshot.bg);
  }
  _fogSnapshot = null;
}

// ---------------------------------------------------------------------
// Lighting boost. The scene's default lighting is tuned for the
// chapter mood — moody purple ambient, chapter-tinted hemi. That
// makes the meebit look DARK in tutorial because the strong rainbow
// floor steals visual attention while the meebit gets muted lighting.
//
// Strategy: snapshot ambient + hemi intensities/colors on tutorial
// entry, override them to bright neutral white at higher intensity,
// then restore on exit. The hemi gets a sky-up white and a slightly
// dimmer ground-down white so the meebit reads cleanly from both
// camera angles. Ambient pumps to nearly white so even bottom faces
// of the meebit stay readable — without this, parts of the meebit
// facing away from any direct light remained very dark.
//
// We do NOT touch the moon (DirectionalLight) because the rim
// lighting it provides is desirable for the meebit's silhouette;
// boosting the ambient/hemi alone gives us "no dark crevices" while
// keeping the moon's directional shape.
// ---------------------------------------------------------------------
let _lightingSnapshot = null;
export function boostTutorialLighting() {
  if (!Scene) return;
  if (_lightingSnapshot === null) {
    _lightingSnapshot = {
      ambientIntensity: Scene.ambient ? Scene.ambient.intensity : null,
      ambientColor: Scene.ambient ? Scene.ambient.color.getHex() : null,
      hemiIntensity: Scene.hemi ? Scene.hemi.intensity : null,
      hemiSky: Scene.hemi ? Scene.hemi.color.getHex() : null,
      hemiGround: Scene.hemi ? Scene.hemi.groundColor.getHex() : null,
    };
  }
  // Bright neutral ambient — pulls the meebit's dark sides up to
  // a clearly visible level. 1.2 is well above the default 0.55;
  // combined with white color (instead of dark purple #3a2850) the
  // baseline luminance roughly quadruples.
  if (Scene.ambient) {
    Scene.ambient.color.setHex(0xffffff);
    Scene.ambient.intensity = 1.2;
  }
  // Bright neutral hemi — sky white, ground a slightly warm off-white
  // so floor reflections feel grounded but don't push the meebit toward
  // any chapter-tinted hue.
  if (Scene.hemi) {
    Scene.hemi.color.setHex(0xffffff);
    Scene.hemi.groundColor.setHex(0xeeeeee);
    Scene.hemi.intensity = 1.0;
  }
}
export function restoreTutorialLighting() {
  if (!Scene || _lightingSnapshot === null) return;
  if (Scene.ambient && _lightingSnapshot.ambientIntensity !== null) {
    Scene.ambient.color.setHex(_lightingSnapshot.ambientColor);
    Scene.ambient.intensity = _lightingSnapshot.ambientIntensity;
  }
  if (Scene.hemi && _lightingSnapshot.hemiIntensity !== null) {
    Scene.hemi.color.setHex(_lightingSnapshot.hemiSky);
    Scene.hemi.groundColor.setHex(_lightingSnapshot.hemiGround);
    Scene.hemi.intensity = _lightingSnapshot.hemiIntensity;
  }
  _lightingSnapshot = null;
}
