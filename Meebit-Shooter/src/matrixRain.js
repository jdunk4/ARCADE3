// matrixRain.js — Brief full-screen matrix-style cascade played on
// chapter transitions. Tinted with the incoming chapter's grid1 color
// so the player feels the hand-off into the new aesthetic.
//
// Visual recipe:
//   1. Fixed-position transparent canvas covers the whole viewport.
//   2. Vertical streams of katakana/digit glyphs fall column-by-column
//      from the top edge.
//   3. Lead glyph at the head of each stream is brighter; tail dims
//      down to fully transparent.
//   4. Whole effect fades in (~250ms), holds (~1.8s), fades out
//      (~750ms). Total ~2.8s.
//
// Self-disposing — calls cancelAnimationFrame and removes the DOM
// element when complete. Safe to trigger repeatedly even if a
// previous transition is still in flight (the prior canvas is killed
// and replaced).
//
// Public API:
//   playMatrixRain(tintHex) — kick off a transition. Tint is the
//                              chapter's grid1 color (e.g. CRIMSON
//                              red, INFERNO orange).

let _activeCanvas = null;
let _activeRAF = 0;

// Glyph alphabet — half-width katakana + a few digits + symbols. Same
// vibe the original Matrix used. Real Matrix decoders use mirror-image
// katakana but the regular forms read the same to the eye and are
// easier to render with a standard font.
const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789:.-=*+';
function _randGlyph() {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
}

// Convert hex int to "rgb(r,g,b)" string for canvas use.
function _rgb(hex) {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `${r},${g},${b}`;
}

/**
 * Trigger a chapter-transition matrix rain. Cleans up any prior
 * cascade still in flight, then runs a fresh one.
 *
 * @param {number} tintHex - chapter color (e.g. 0xff6a1a for INFERNO)
 */
export function playMatrixRain(tintHex) {
  // Kill any in-flight cascade. Defensive — should be rare since
  // chapter changes are not back-to-back, but if a player skips
  // chapters via cheats we don't want to leak canvases.
  if (_activeCanvas && _activeCanvas.parentNode) {
    _activeCanvas.parentNode.removeChild(_activeCanvas);
  }
  if (_activeRAF) {
    cancelAnimationFrame(_activeRAF);
    _activeRAF = 0;
  }

  const canvas = document.createElement('canvas');
  canvas.style.position = 'fixed';
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.width = '100vw';
  canvas.style.height = '100vh';
  // z-index 9000 — above the game canvas (which sits at z-index <100)
  // but below the pause menu / tutorial modal (10000+). The rain is
  // ambient flavor, not interactive — nothing should block it from
  // clicks etc.
  canvas.style.zIndex = '9000';
  canvas.style.pointerEvents = 'none';
  canvas.style.opacity = '0';
  // CSS transition handles fade in/out — simpler than driving alpha
  // in code. Initial 0 → animate to target via inline style writes.
  canvas.style.transition = 'opacity 250ms ease-out';

  // Match canvas pixel resolution to the viewport. We don't bother
  // with devicePixelRatio scaling because the rain glyphs read fine
  // at 1× and the perf cost of 2× scaling on large displays would
  // be wasteful for a 3-second one-shot.
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w;
  canvas.height = h;
  document.body.appendChild(canvas);
  _activeCanvas = canvas;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2D context — bail without raining. Should never happen on
    // any browser this game runs on but be defensive.
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    _activeCanvas = null;
    return;
  }

  // Column setup. 14px font width per column gives a dense cascade
  // without overwhelming the viewport. h/14 streams running.
  const FONT_SIZE = 14;
  ctx.font = `${FONT_SIZE}px monospace`;
  const colCount = Math.ceil(w / FONT_SIZE);
  // Each column tracks its current Y (in glyph rows) and per-column
  // randomness. Negative initial Y means "off the top" — staggers
  // the start so streams don't all begin at row 0 simultaneously.
  const drops = new Array(colCount);
  for (let i = 0; i < colCount; i++) {
    // Stagger by random rows; some start mid-fall, some off-top.
    drops[i] = -Math.random() * 30;
  }

  const rgb = _rgb(tintHex);
  const startTime = performance.now();
  const FADE_IN = 250;
  const HOLD = 1800;
  const FADE_OUT = 750;
  const TOTAL = FADE_IN + HOLD + FADE_OUT;

  // Trigger fade-in via inline style (matches CSS transition).
  // Defer to next frame so the transition catches the change.
  requestAnimationFrame(() => {
    if (canvas === _activeCanvas) canvas.style.opacity = '1';
  });

  function tick(now) {
    const elapsed = now - startTime;
    if (elapsed >= TOTAL || canvas !== _activeCanvas) {
      // Done — clean up.
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      if (_activeCanvas === canvas) {
        _activeCanvas = null;
        _activeRAF = 0;
      }
      return;
    }
    // Trigger fade-out at the right moment.
    if (elapsed >= FADE_IN + HOLD && canvas.style.transition.indexOf('750ms') === -1) {
      canvas.style.transition = 'opacity 750ms ease-in';
      canvas.style.opacity = '0';
    }

    // Fade trail — semi-transparent black overlay each frame so old
    // glyphs darken progressively toward black. The 0.08 alpha is a
    // tradeoff: lower values = longer trails (more "dripping" feel),
    // higher values = shorter, snappier trails. 0.08 matches the
    // canonical matrix look.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(0, 0, w, h);

    // Draw each column's current glyph.
    for (let i = 0; i < colCount; i++) {
      const x = i * FONT_SIZE;
      const y = drops[i] * FONT_SIZE;
      // Lead glyph — bright tinted with chapter color
      if (y > 0 && y < h + FONT_SIZE) {
        ctx.fillStyle = `rgba(${rgb}, 0.95)`;
        ctx.fillText(_randGlyph(), x, y);
        // Glow trail — second glyph one row up, dimmer. Uses an
        // offset draw rather than a true blur (cheaper).
        if (y - FONT_SIZE > 0) {
          ctx.fillStyle = `rgba(${rgb}, 0.55)`;
          ctx.fillText(_randGlyph(), x, y - FONT_SIZE);
        }
      }
      // Advance the drop. Reset to top with random jitter when it
      // falls off the bottom — staggers re-entry so the cascade
      // doesn't sync up over time.
      drops[i] += 0.6 + Math.random() * 0.4;
      if (drops[i] * FONT_SIZE > h && Math.random() > 0.975) {
        drops[i] = -Math.random() * 10;
      }
    }

    _activeRAF = requestAnimationFrame(tick);
  }

  _activeRAF = requestAnimationFrame(tick);
}
