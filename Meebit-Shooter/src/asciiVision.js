// ============================================================
// ASCII VISION — CSS-based matrix visual filter.
//
// Activates a combination of CSS effects on the game canvas:
//   1. Pixelation (via canvas downscaling + image-rendering: pixelated)
//   2. A green-tinted overlay with a repeating ASCII character grid
//   3. Scanlines
//   4. CRT curvature vignette
//
// This is ZERO per-frame JS cost — it's all CSS transforms, filters,
// and pseudo-elements. The WebGL renderer continues running normally.
//
// Press V to toggle. Lasts 15 seconds.
// ============================================================

let _active = false;
let _timer = 0;
let _styleEl = null;
let _overlayEl = null;
const ASCII_DURATION = 15.0;

function _injectCSS() {
  if (_styleEl) return;
  _styleEl = document.createElement('style');
  _styleEl.textContent = `
/* ASCII Vision — active state */
#game.ascii-active > canvas {
  filter: contrast(1.3) brightness(0.9) saturate(0.6);
  image-rendering: pixelated;
}
#ascii-grid {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  overflow: hidden;
  display: none;
  mix-blend-mode: screen;
}
#game.ascii-active #ascii-grid {
  display: block;
}
#ascii-grid .ascii-col {
  position: absolute;
  top: 0;
  width: 10px;
  font-family: monospace;
  font-size: 9px;
  line-height: 10px;
  color: rgba(0, 255, 102, 0.25);
  white-space: pre;
  writing-mode: vertical-lr;
  text-orientation: upright;
  animation: ascii-scroll linear infinite;
  will-change: transform;
}
@keyframes ascii-scroll {
  0% { transform: translateY(-50%); }
  100% { transform: translateY(0%); }
}
/* Scanlines */
#ascii-scanlines {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
  display: none;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.08) 2px,
    rgba(0, 0, 0, 0.08) 4px
  );
}
#game.ascii-active #ascii-scanlines {
  display: block;
}
/* Green tint overlay */
#ascii-tint {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  display: none;
  background: radial-gradient(ellipse at center, rgba(0,40,10,0.3) 0%, rgba(0,20,5,0.6) 100%);
  mix-blend-mode: multiply;
}
#game.ascii-active #ascii-tint {
  display: block;
}
/* Timer bar at top */
#ascii-timer-bar {
  position: absolute;
  top: 0; left: 0;
  height: 3px;
  background: #00ff66;
  box-shadow: 0 0 8px #00ff66;
  z-index: 10;
  transition: width 0.3s linear;
  display: none;
}
#game.ascii-active #ascii-timer-bar {
  display: block;
}
`;
  document.head.appendChild(_styleEl);
}

function _buildOverlay() {
  if (_overlayEl) return;
  const gameEl = document.getElementById('game');
  if (!gameEl) return;

  // Character grid
  const grid = document.createElement('div');
  grid.id = 'ascii-grid';
  const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789:.=-+*#%@';
  const colCount = Math.ceil(window.innerWidth / 10);
  for (let i = 0; i < colCount; i++) {
    const col = document.createElement('div');
    col.className = 'ascii-col';
    col.style.left = (i * 10) + 'px';
    col.style.animationDuration = (3 + Math.random() * 5) + 's';
    col.style.animationDelay = (-Math.random() * 5) + 's';
    col.style.opacity = (0.15 + Math.random() * 0.2).toFixed(2);
    let text = '';
    for (let j = 0; j < 120; j++) {
      text += CHARS[Math.floor(Math.random() * CHARS.length)];
    }
    col.textContent = text;
    grid.appendChild(col);
  }
  gameEl.appendChild(grid);

  // Scanlines
  const scanlines = document.createElement('div');
  scanlines.id = 'ascii-scanlines';
  gameEl.appendChild(scanlines);

  // Green tint
  const tint = document.createElement('div');
  tint.id = 'ascii-tint';
  gameEl.appendChild(tint);

  // Timer bar
  const timerBar = document.createElement('div');
  timerBar.id = 'ascii-timer-bar';
  gameEl.appendChild(timerBar);

  _overlayEl = grid;
}

// ---- PUBLIC API ----

export function initAsciiVision() {
  _injectCSS();
  _buildOverlay();
}

export function activateAsciiVision(duration) {
  _active = true;
  _timer = duration || ASCII_DURATION;
  const gameEl = document.getElementById('game');
  if (gameEl) gameEl.classList.add('ascii-active');
  // Set timer bar to full
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) { bar.style.width = '100%'; }
}

export function deactivateAsciiVision() {
  _active = false;
  _timer = 0;
  const gameEl = document.getElementById('game');
  if (gameEl) gameEl.classList.remove('ascii-active');
}

export function isAsciiActive() { return _active; }

export function updateAsciiVision(dt) {
  if (!_active) return false;
  _timer -= dt;
  // Update timer bar
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) {
    const pct = Math.max(0, _timer / ASCII_DURATION * 100);
    bar.style.width = pct + '%';
  }
  if (_timer <= 0) {
    deactivateAsciiVision();
    return false;
  }
  return true;
}

export function renderAsciiPass() {
  // No-op — everything is CSS-driven
}

export function getAsciiTimeRemaining() {
  return Math.max(0, _timer);
}
