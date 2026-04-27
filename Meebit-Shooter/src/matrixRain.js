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

  // Per-column trail buffer. Each column remembers its last N head
  // positions (and the glyph drawn at each). On render we draw all of
  // them at decreasing alpha — newest glyph bright at the head,
  // older glyphs faded as a trail going up. This recreates the
  // canonical matrix trail look WITHOUT ever putting black pixels
  // on the canvas: previous versions used a per-frame semi-transparent
  // black fill that compounded to opaque black behind the glyphs over
  // the ~1.8s hold, blocking the game scene underneath. With the
  // trail buffer approach, the canvas stays fully transparent except
  // for the glyph pixels themselves — game shows through cleanly.
  const TRAIL_LENGTH = 14;
  const trails = new Array(colCount);
  for (let i = 0; i < colCount; i++) {
    trails[i] = [];   // [{ y: rowIdx, glyph: char }, ...] head first
  }

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

    // CLEAR the canvas to fully transparent every frame. No black
    // accumulation — the game scene underneath shows through.
    ctx.clearRect(0, 0, w, h);

    // Update + render every column.
    for (let i = 0; i < colCount; i++) {
      const x = i * FONT_SIZE;
      // Advance the drop position
      drops[i] += 0.6 + Math.random() * 0.4;
      const headRow = Math.floor(drops[i]);
      // Append a new head glyph if the drop has moved a whole row.
      // Compare to last entry's row to avoid drawing duplicates if the
      // drop hasn't advanced enough this frame.
      const trail = trails[i];
      const lastEntry = trail[0];
      if (!lastEntry || lastEntry.y !== headRow) {
        trail.unshift({ y: headRow, glyph: _randGlyph() });
        if (trail.length > TRAIL_LENGTH) trail.pop();
      }
      // Draw every entry in the trail at alpha that decreases with age.
      for (let t = 0; t < trail.length; t++) {
        const entry = trail[t];
        const y = entry.y * FONT_SIZE;
        if (y < 0 || y > h + FONT_SIZE) continue;
        // Head glyph (t=0) at near-full alpha; trail glyphs fade
        // exponentially with index. The 0.85 base is bright enough
        // to read against any background; pow(0.78, t) gives a
        // smooth ~14-glyph trail that fades to invisible by the end.
        const alpha = 0.85 * Math.pow(0.78, t);
        ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
        ctx.fillText(entry.glyph, x, y);
      }
      // Reset to top with random jitter when the head falls off the
      // bottom — staggers re-entry so the cascade doesn't sync up.
      if (drops[i] * FONT_SIZE > h && Math.random() > 0.975) {
        drops[i] = -Math.random() * 10;
        trail.length = 0;       // clear the old trail
      }
    }

    _activeRAF = requestAnimationFrame(tick);
  }

  _activeRAF = requestAnimationFrame(tick);
}
