// tutorialSecret.js — Secret unlock on the tutorial completion modal.
//
// When the player finishes wave 11 and the TUTORIAL COMPLETE modal
// shows, instead of clicking "RETURN TO MAIN SCREEN" they can press
// the Helldivers stratagem code:
//                ↑ → ↓ ↓ ↓
// to unlock and immediately start bonus waves 12, 13, 14, which
// teach the stratagem call-in system. The bonus waves grant
// temporary stratagem artifacts so the player can practice without
// having earned them in the main game.
//
// MOBILE INPUT:
//   Phones don't have arrow keys. armSecretListener() now ALSO injects
//   a small green-matrix-themed d-pad inside the tutorial complete
//   modal. The d-pad's 4 buttons call _pushArrow() the same way the
//   keyboard handler does, so there's exactly one input pipeline. The
//   d-pad uses the .stratagem-dpad CSS class defined in styles.css —
//   visually it matches the matrix-cursor / matrix-rain aesthetic.
//   On mobile-landscape an extra @media block in styles.css shrinks
//   the d-pad so it fits between the title text and the RETURN button.
//
// Public API:
//   armSecretListener(onUnlock)
//                              — call when the completion modal is
//                                shown. Listens for arrow key + arrow
//                                button events + the in-modal d-pad
//                                taps. onUnlock fires when the code
//                                is matched.
//   disarmSecretListener()     — cleanup; remove key handler + d-pad.

const SECRET_CODE = ['up', 'right', 'down', 'down', 'down'];

let _entered = [];
let _onUnlock = null;
let _keyHandler = null;
let _hintEl = null;
let _hintTimer = null;
let _dpadEl = null;          // injected matrix-green d-pad inside the modal

/**
 * Begin listening on the modal. The hint sprite at the bottom of the
 * screen shows the current input progress so the player can correct
 * a mis-key. Mismatch resets the buffer; a matched code calls onUnlock
 * and disarms the listener.
 */
export function armSecretListener(onUnlock) {
  if (_keyHandler) return;     // already armed
  _onUnlock = onUnlock;
  _entered = [];

  _keyHandler = (e) => {
    let dir = null;
    if (e.key === 'ArrowUp')    dir = 'up';
    else if (e.key === 'ArrowDown')  dir = 'down';
    else if (e.key === 'ArrowLeft')  dir = 'left';
    else if (e.key === 'ArrowRight') dir = 'right';
    if (!dir) return;
    e.preventDefault();
    _pushArrow(dir);
  };
  window.addEventListener('keydown', _keyHandler, true);

  // Inject the on-screen matrix-green d-pad inside the tutorial
  // complete modal. On desktop it's a redundant-but-friendly affordance
  // (some players don't realize they can type a code); on mobile it's
  // the ONLY way to enter the code since phones have no arrow keys.
  _ensureDpadInModal();

  _showHint('try anything');
}

export function disarmSecretListener() {
  if (_keyHandler) {
    window.removeEventListener('keydown', _keyHandler, true);
    _keyHandler = null;
  }
  _entered = [];
  _onUnlock = null;
  _hideHint();
  _removeDpad();
}

/**
 * Programmatically push an arrow — used by gamepad d-pad listener
 * wired in main.js so controller players can also enter the code.
 */
export function pushSecretArrow(dir) {
  if (!_keyHandler) return;     // listener not armed
  _pushArrow(dir);
}

function _pushArrow(dir) {
  _entered.push(dir);

  // Match check.
  let isPrefix = true;
  for (let i = 0; i < _entered.length; i++) {
    if (_entered[i] !== SECRET_CODE[i]) { isPrefix = false; break; }
  }
  if (!isPrefix) {
    // Wrong key — reset and give a quick visual cue.
    _entered = [];
    _showHint('reset', 0xff5520);
    return;
  }

  if (_entered.length === SECRET_CODE.length) {
    // Match.
    _showHint('UNLOCKED', 0x00ff66);
    const cb = _onUnlock;
    disarmSecretListener();
    if (cb) {
      try { cb(); } catch (e) { console.warn('[tutorial secret unlock]', e); }
    }
    return;
  }

  // Partial match — show progress.
  _showHint('partial');
}

// =====================================================================
// HINT UI — a faint floating glyph row at the bottom of the modal
// =====================================================================
function _ensureHint() {
  if (_hintEl) return _hintEl;
  const el = document.createElement('div');
  el.style.cssText = [
    'position: fixed',
    'bottom: 30px',
    'left: 50%',
    'transform: translateX(-50%)',
    'z-index: 10003',
    'font-family: Impact, monospace',
    'font-size: 28px',
    'letter-spacing: 16px',
    'color: rgba(255,255,255,0.18)',     // very faint — the hint is for players who already know
    'text-shadow: 0 0 8px rgba(255,255,255,0.10)',
    'pointer-events: none',
    'transition: color 0.25s ease, text-shadow 0.25s ease',
  ].join(';');
  document.body.appendChild(el);
  _hintEl = el;
  return el;
}

function _showHint(_kind, color) {
  const el = _ensureHint();
  const ARROW = { up: '↑', down: '↓', left: '←', right: '→' };
  const slots = SECRET_CODE.length;
  const parts = [];
  for (let i = 0; i < slots; i++) {
    if (i < _entered.length) parts.push(ARROW[_entered[i]]);
    else parts.push('·');
  }
  el.textContent = parts.join(' ');
  if (color != null) {
    const hex = '#' + color.toString(16).padStart(6, '0');
    el.style.color = hex;
    el.style.textShadow = `0 0 12px ${hex}`;
    if (_hintTimer) clearTimeout(_hintTimer);
    _hintTimer = setTimeout(() => {
      // Decay back to faint white if listener still armed.
      if (_hintEl) {
        _hintEl.style.color = 'rgba(255,255,255,0.18)';
        _hintEl.style.textShadow = '0 0 8px rgba(255,255,255,0.10)';
      }
    }, 600);
  }
}

function _hideHint() {
  if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = null; }
  if (_hintEl && _hintEl.parentNode) {
    _hintEl.parentNode.removeChild(_hintEl);
  }
  _hintEl = null;
}

// =====================================================================
// D-PAD UI — matrix-green directional input injected into the modal
// =====================================================================
// Built once per arm cycle. Lives inside #tutorial-complete-modal so
// the modal's flex centering positions it for free, and so the modal
// disposing it on close cleans up automatically (we still tear it
// down explicitly in disarmSecretListener for safety).
//
// The 4 buttons reuse the .stratagem-dpad-* classes from styles.css —
// same component the in-game stratagem call shares, so the player
// learns the input pattern once and reuses it.
function _ensureDpadInModal() {
  const modal = document.getElementById('tutorial-complete-modal');
  if (!modal) return;                      // modal not built yet — caller can re-arm later
  if (_dpadEl && _dpadEl.parentNode === modal) return;   // already attached

  const wrap = document.createElement('div');
  wrap.id = 'stratagem-dpad-modal';
  wrap.className = 'stratagem-dpad';

  const DIRS = [
    { dir: 'up',    cls: 'stratagem-dpad-up',    glyph: '↑' },
    { dir: 'right', cls: 'stratagem-dpad-right', glyph: '→' },
    { dir: 'down',  cls: 'stratagem-dpad-down',  glyph: '↓' },
    { dir: 'left',  cls: 'stratagem-dpad-left',  glyph: '←' },
  ];
  for (const { dir, cls, glyph } of DIRS) {
    const btn = document.createElement('div');
    btn.className = 'stratagem-dpad-btn ' + cls;
    btn.textContent = glyph;
    // Both touch and click — touchstart for snappy mobile feedback
    // (avoids the ~300ms click delay), click for desktop dev test.
    // We push the arrow on press-down (not release) to match the
    // keyboard handler which fires on keydown.
    const onPress = (e) => {
      if (!_keyHandler) return;            // listener disarmed — don't fire
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add('pressed');
      _pushArrow(dir);
    };
    const onRelease = (e) => {
      btn.classList.remove('pressed');
      if (e) e.stopPropagation();
    };
    btn.addEventListener('touchstart', onPress, { passive: false });
    btn.addEventListener('touchend', onRelease, { passive: false });
    btn.addEventListener('touchcancel', onRelease, { passive: false });
    btn.addEventListener('mousedown', onPress);
    btn.addEventListener('mouseup', onRelease);
    btn.addEventListener('mouseleave', onRelease);
    wrap.appendChild(btn);
  }

  // Insert before the RETURN button so it sits in the visual flow
  // between the XP badge and the CTA. If the button isn't found we
  // append at the end of the modal — still readable.
  const cta = modal.querySelector('#tutorial-complete-return');
  if (cta && cta.parentNode === modal) {
    modal.insertBefore(wrap, cta);
  } else {
    modal.appendChild(wrap);
  }
  _dpadEl = wrap;
}

function _removeDpad() {
  if (_dpadEl && _dpadEl.parentNode) {
    _dpadEl.parentNode.removeChild(_dpadEl);
  }
  _dpadEl = null;
}
