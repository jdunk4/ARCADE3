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
import { Scene } from './scene.js';

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

  // Build the color cells.
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
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      const px = BORDER_PX + col * CELL_PX;
      const py = BORDER_PX + row * CELL_PX;
      ctx.fillRect(px, py, CELL_PX, CELL_PX);
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

  // Thin grid lines between cells so the tiles still read as a grid
  // even in low-light wave themes.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= GRID_COLS; i++) {
    const x = BORDER_PX + i * CELL_PX;
    ctx.beginPath();
    ctx.moveTo(x, BORDER_PX);
    ctx.lineTo(x, TEX_H - BORDER_PX);
    ctx.stroke();
  }
  for (let i = 0; i <= GRID_ROWS; i++) {
    const y = BORDER_PX + i * CELL_PX;
    ctx.beginPath();
    ctx.moveTo(BORDER_PX, y);
    ctx.lineTo(TEX_W - BORDER_PX, y);
    ctx.stroke();
  }

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

  // Leave the chapter grid overlay at its native opacity. The texture
  // is sized so each rainbow tile is a 2×2 block of game grid cells —
  // letting the overlay draw on top adds a subtle subdivision that
  // visually anchors the floor to the same grid the rest of the game
  // uses for collisions and movement.
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
