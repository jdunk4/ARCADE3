// matrixRain3D.js — three.js matrix-rain effect that falls *inside the
// arena* during chapter transitions. Sister to matrixRain.js, which is
// the 2D screen-overlay cascade. Both play simultaneously: the 2D
// overlay sells the screen flash, the 3D rain sells the world handover
// — glyphs streaming down past pillars, gravestones, hexagons,
// civilians, blocks, etc.
//
// Visual recipe:
//   1. Build a glyph atlas ONCE per module load — render every glyph
//      to its own canvas Texture, cache for reuse.
//   2. On play(), spawn STREAM_COUNT vertical streams scattered in a
//      wide square around the camera anchor (player). Each stream is
//      a column of N glyphs aligned vertically. Streams use Sprites so
//      glyphs always face the camera regardless of camera angle.
//   3. Per frame, the head of each stream descends. As glyphs fall
//      below ground level they recycle to the top with a new random
//      glyph. The head glyph is bright; trail glyphs progressively
//      fade out.
//   4. Whole effect fades in (~250ms), holds for the requested
//      duration, fades out (~750ms), then cleans up.
//
// The streams DON'T collide with arena geometry — they pass through
// pillars, walls, etc. — so the effect reads as a code overlay on the
// world rather than rain that bounces off things. (This is also how
// the canonical Matrix code rain works in the films — it's an
// information layer, not water.)
//
// Performance notes:
//   - One Texture per glyph, shared across all sprites that show that
//     glyph. ~50 textures total, each tiny (32×32px canvas).
//   - One SpriteMaterial per Sprite (Sprites can't share materials
//     because each one points at a specific glyph texture). ~700-1000
//     materials for ~3 seconds, all disposed on stop. This is fine on
//     mid-tier mobile — three.js handles thousands of sprites easily.
//   - Glyph cycling (sprite picks a new random glyph) happens at most
//     every CYCLE_INTERVAL seconds per sprite to avoid hammering the
//     material .map swaps.
//
// Public API:
//   play3DMatrixRain(tintHex, durationMs, anchorPos)
//                    → kick off a chapter transition. Tint is the
//                      chapter's grid1 color; duration is how long the
//                      hold phase lasts (default ~1800ms to match the
//                      2D rain). anchorPos is the world position the
//                      rain centers on (typically the player's pos).

import * as THREE from 'three';
import { scene } from './scene.js';

// ============================================================
// GLYPH ATLAS
// ============================================================
// Same character set as the 2D rain so the two effects feel like the
// same "code stream." Half-width katakana + digits + symbols.
const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789:.-=*+';
const GLYPH_TEX_SIZE = 64;          // each glyph rendered onto a 64×64 canvas
let _atlasTextures = null;          // lazily built — Array<THREE.Texture>, one per glyph

/**
 * Build the glyph texture atlas once. Each glyph is rendered onto its
 * own canvas with a green tint (the matrix base color), then wrapped
 * in a THREE.Texture. The actual color in-game is multiplied by the
 * SpriteMaterial's color, so even though the canvas is green we can
 * tint at runtime to any chapter color. Keeping the canvas green
 * gives us better perceived contrast vs starting from white (the eye
 * locks onto green-cast glyphs as "matrix code" instantly).
 */
function _buildGlyphAtlas() {
  if (_atlasTextures) return;
  _atlasTextures = [];
  for (let i = 0; i < GLYPHS.length; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = GLYPH_TEX_SIZE;
    canvas.height = GLYPH_TEX_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    // Transparent background — sprite blending will additively
    // compose against the scene.
    ctx.clearRect(0, 0, GLYPH_TEX_SIZE, GLYPH_TEX_SIZE);
    // Bright green canonical matrix glyph. We push opacity to 1.0
    // here and rely on SpriteMaterial.opacity for fade — this keeps
    // the rendered glyph crisp even at low total opacity.
    ctx.font = `bold ${GLYPH_TEX_SIZE * 0.85}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgb(255,255,255)';   // white base — color tint applied via material
    ctx.fillText(GLYPHS[i], GLYPH_TEX_SIZE / 2, GLYPH_TEX_SIZE / 2);
    const tex = new THREE.CanvasTexture(canvas);
    // No mipmaps — these are short-lived textures used at fixed size.
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    _atlasTextures.push(tex);
  }
}

function _randGlyphTexture() {
  return _atlasTextures[Math.floor(Math.random() * _atlasTextures.length)];
}

// ============================================================
// STATE
// ============================================================
// One active rain at a time. If play3DMatrixRain is called while
// another rain is still active, the prior is torn down and replaced.
let _active = null;

// ============================================================
// TUNING
// ============================================================
// All values in world units / seconds.
const STREAM_COUNT     = 80;       // how many simultaneous columns
const GLYPHS_PER_STREAM = 12;       // length of trail per column
const SCATTER_RADIUS   = 60;       // streams scattered in this radius around the anchor
const FALL_SPEED       = 14;       // world units per second (head moves DOWN)
const SPAWN_HEIGHT     = 30;       // world Y where new heads appear
const KILL_HEIGHT      = -2;       // world Y where heads recycle to the top
const GLYPH_SPACING    = 1.4;      // vertical world distance between adjacent glyphs in a stream
const SPRITE_SCALE     = 1.6;      // world-unit size of each glyph sprite
const CYCLE_INTERVAL   = 0.10;     // seconds between glyph swaps per sprite
const FADE_IN_MS       = 250;
const FADE_OUT_MS      = 750;

/**
 * Trigger the 3D matrix rain. Cleans up any prior cascade still in
 * flight, then runs a fresh one.
 *
 * @param {number}        tintHex     - chapter color (e.g. 0xff6a1a)
 * @param {number}        [durationMs] - hold-phase duration in ms (default 1800)
 * @param {THREE.Vector3} [anchorPos]  - center of the rain field (default origin).
 *                                       Streams scatter in a SCATTER_RADIUS
 *                                       square around this point. Pass the
 *                                       player's world position so the rain
 *                                       always covers what the camera sees.
 */
export function play3DMatrixRain(tintHex, durationMs, anchorPos) {
  // Ensure the atlas is built. Cheap if already built.
  _buildGlyphAtlas();

  // Tear down any in-flight rain. Don't trust callers to dedupe.
  if (_active) {
    _disposeActive();
  }

  const HOLD_MS = (typeof durationMs === 'number') ? durationMs : 1800;
  const TOTAL_MS = FADE_IN_MS + HOLD_MS + FADE_OUT_MS;

  const anchor = (anchorPos && typeof anchorPos.x === 'number')
    ? new THREE.Vector3(anchorPos.x, 0, anchorPos.z)
    : new THREE.Vector3(0, 0, 0);

  // Decompose tint hex to a THREE.Color we can apply per material.
  const tintColor = new THREE.Color(tintHex);

  // Build the streams. Each stream is an array of sprites stacked
  // vertically; the [0] sprite is the head (brightest). They share a
  // base XZ position; only Y varies per glyph.
  const streams = [];
  for (let s = 0; s < STREAM_COUNT; s++) {
    // Random scatter position around the anchor.
    const sx = anchor.x + (Math.random() - 0.5) * SCATTER_RADIUS * 2;
    const sz = anchor.z + (Math.random() - 0.5) * SCATTER_RADIUS * 2;
    // Head Y starts somewhere in the visible column — staggering by a
    // random fraction means streams don't all sync up. Some streams
    // start mid-fall, some near the top.
    const startY = SPAWN_HEIGHT + Math.random() * 8;
    // Each stream gets a slightly different fall speed so the field
    // doesn't feel like a uniform sheet — adds organic variation.
    const speed = FALL_SPEED * (0.75 + Math.random() * 0.6);

    const sprites = [];
    for (let g = 0; g < GLYPHS_PER_STREAM; g++) {
      const tex = _randGlyphTexture();
      // Head glyph (g=0) is brightest white; trail glyphs ramp toward
      // the chapter tint and progressively fade. The mix of white head
      // + tinted tail is the canonical Matrix visual.
      const t = g / GLYPHS_PER_STREAM;
      const headColor = new THREE.Color(0xffffff);
      const trailColor = tintColor.clone();
      const finalColor = headColor.clone().lerp(trailColor, Math.min(1, t * 1.2));
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: finalColor,
        // Opacity also ramps tail-down; we'll multiply this by the
        // global fade-in/fade-out factor each frame.
        opacity: Math.max(0.05, 1 - t),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,        // don't punch holes in depth — sprites overlap each other
        depthTest: true,           // BUT do test against scene depth so pillars occlude
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(SPRITE_SCALE, SPRITE_SCALE, SPRITE_SCALE);
      // Head Y minus g spacings — sprites stacked downward from the
      // head with a tail trailing UP-and-BEHIND (toward the top of
      // the world). As the head falls past y=0, tail glyphs follow.
      sprite.position.set(sx, startY + g * GLYPH_SPACING, sz);
      // Render order high so glyphs sort over most scene content.
      // Still respects depth test, just biases the painters' pass.
      sprite.renderOrder = 9000;
      scene.add(sprite);
      sprites.push({
        sprite,
        mat,
        baseOpacity: Math.max(0.05, 1 - t),
        cycleT: Math.random() * CYCLE_INTERVAL,    // stagger glyph swap timers
      });
    }

    streams.push({
      x: sx, z: sz,
      headY: startY,
      speed,
      sprites,
    });
  }

  _active = {
    streams,
    startTime: performance.now(),
    fadeInMs: FADE_IN_MS,
    holdMs: HOLD_MS,
    fadeOutMs: FADE_OUT_MS,
    totalMs: TOTAL_MS,
    tintColor,
  };
}

/**
 * Per-frame tick. Wire this from main.js's animate loop alongside
 * the other update*() calls. Cheap when no rain is active (single
 * null check).
 *
 * @param {number} dt - frame delta in seconds
 */
export function update3DMatrixRain(dt) {
  if (!_active) return;
  const a = _active;
  const elapsed = performance.now() - a.startTime;
  if (elapsed >= a.totalMs) {
    _disposeActive();
    return;
  }

  // Compute global fade factor — 0..1 based on the elapsed phase.
  let fade;
  if (elapsed < a.fadeInMs) {
    fade = elapsed / a.fadeInMs;
  } else if (elapsed < a.fadeInMs + a.holdMs) {
    fade = 1;
  } else {
    const fadeOutT = elapsed - a.fadeInMs - a.holdMs;
    fade = 1 - (fadeOutT / a.fadeOutMs);
  }
  fade = Math.max(0, Math.min(1, fade));

  for (const stream of a.streams) {
    // Head moves down at the stream's per-instance speed.
    stream.headY -= stream.speed * dt;
    // If the head fell below ground, recycle to the top — re-randomize
    // the X/Z scatter position so streams visit different parts of the
    // arena over the lifetime of the rain.
    if (stream.headY < KILL_HEIGHT) {
      stream.headY = SPAWN_HEIGHT + Math.random() * 6;
      // Optionally jiggle the column so re-emerging streams scatter
      // around. Subtle: only ±2 units so the column reads as "the
      // same column moved a bit" not as a teleport.
      stream.x += (Math.random() - 0.5) * 4;
      stream.z += (Math.random() - 0.5) * 4;
    }

    // Update each sprite in the stream.
    for (let g = 0; g < stream.sprites.length; g++) {
      const slot = stream.sprites[g];
      // Sprite g=0 is at headY; g=1 is one spacing above (trail), etc.
      slot.sprite.position.x = stream.x;
      slot.sprite.position.y = stream.headY + g * GLYPH_SPACING;
      slot.sprite.position.z = stream.z;

      // Glyph cycling — each sprite occasionally swaps to a new random
      // glyph. The HEAD swaps fastest (every CYCLE_INTERVAL); trail
      // glyphs swap less often so they read as "settled" history.
      slot.cycleT -= dt;
      if (slot.cycleT <= 0) {
        slot.cycleT = CYCLE_INTERVAL * (1 + g * 0.5);
        // Only swap with some probability so the head doesn't strobe
        // too aggressively — adds visual calm.
        if (Math.random() < 0.6) {
          slot.mat.map = _randGlyphTexture();
          slot.mat.needsUpdate = true;
        }
      }

      // Apply the global fade × the sprite's base opacity.
      slot.mat.opacity = slot.baseOpacity * fade;
    }
  }
}

/**
 * Force-stop and clean up any active rain. Used internally on phase
 * end and by the public clearMatrixRain3D() (e.g. on level reset).
 */
function _disposeActive() {
  if (!_active) return;
  for (const stream of _active.streams) {
    for (const slot of stream.sprites) {
      if (slot.sprite && slot.sprite.parent) {
        slot.sprite.parent.remove(slot.sprite);
      }
      // Materials are per-sprite; dispose to avoid leaking GPU memory
      // since rain spawns ~960 fresh materials each call. The shared
      // textures (the atlas) are intentionally NOT disposed here —
      // they're reused across calls.
      if (slot.mat) {
        slot.mat.dispose();
      }
    }
  }
  _active = null;
}

/** Public hard-stop. Used on level reset / restart so a rain in flight
 *  doesn't continue running across game boundaries. */
export function clearMatrixRain3D() {
  _disposeActive();
}
