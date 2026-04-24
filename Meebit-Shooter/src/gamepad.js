// Gamepad / controller support.
//
// Polls the Gamepad API every frame (controllers don't dispatch events the
// way keyboards do — you have to poll navigator.getGamepads() from the game
// loop). Feeds state into the same `mouse`/`keys`/`joyState` structures the
// existing input handlers read from so the rest of the game doesn't need
// to know a gamepad exists.
//
// In-game mapping (standard xbox-style layout):
//   Left stick / D-pad → movement (joyState-style dx/dy)
//   Right stick        → aim direction, writes mouse.worldX/Z projected forward
//   Right trigger (RT) → fire (mouse.down)
//   A button           → dash (Space)
//   X button           → toggle pickaxe (Q)
//   B button           → throw grenade (G)
//   LB / RB            → previous / next weapon
//   Start              → pause (Escape)
//
// Title-screen mode (when setTitleMode(true) is active):
//   D-pad / stick      → move focus between buttons (ATTACK AI, etc). The
//                        wallet-connect button is DELIBERATELY SKIPPED in
//                        focus cycling because wallet linking requires a
//                        browser extension popup that can't be operated by
//                        controller anyway — the button stays visible so
//                        mouse users see it, but tab order avoids it.
//   A / Start          → click the focused button
//
// Also manages a small on-screen indicator that appears briefly the first
// time a controller is connected, so the player knows the game saw it.

import * as THREE from 'three';
import { keys, mouse, joyState, S } from './state.js';

const DEADZONE = 0.18;            // ignore tiny stick drift
const TRIGGER_THRESHOLD = 0.35;   // how far the trigger must press to count as "down"
const AIM_DISTANCE = 12;          // how far in front of the player the aim point lives

// Diagnostic hint table — what each standard-mapping index is expected to
// be. Shown next to the press log so when the user presses a button we
// can immediately tell whether it lined up with the standard layout or
// if it's firing at a different index than expected.
const _BUTTON_HINTS = {
  0: 'A (dash)',
  1: 'B (grenade)',
  2: 'X (pickaxe)',
  3: 'Y',
  4: 'LB (prev weapon)',
  5: 'RB (next weapon)',
  6: 'LT',
  7: 'RT (fire)',
  8: 'Back/Select',
  9: 'Start (pause)',
  10: 'LS click',
  11: 'RS click',
  12: 'D-pad Up',
  13: 'D-pad Down',
  14: 'D-pad Left',
  15: 'D-pad Right',
};

let _connected = false;
let _prevButtons = [];            // edge-detection for button presses
let _indicatorEl = null;
let _indicatorTimer = 0;
let _player = null;               // injected reference so we can compute aim world position
let _onDash = null;
let _onTogglePickaxe = null;
let _onGrenade = null;
let _onCycleWeapon = null;        // (direction) => void, 1 or -1
let _onPause = null;
let _onDirectWeapon = null;       // unused slot kept for future per-button weapon binds

// Pad indices we've decided to ignore — headsets, single-button accessibility
// pads, or anything else that enumerated as a gamepad but doesn't have
// enough buttons/axes to actually be one. Populated at connect time, read
// in the poll loop. Cleared on disconnect.
const _ignoredPadIndices = new Set();

// --- TITLE-SCREEN NAV STATE ---
// When _titleMode === true, the in-game handlers above are skipped and
// stick/dpad input instead moves focus between title-screen buttons.
let _titleMode = false;
let _titleButtons = [];           // array of HTMLElement, populated by setTitleMode(true)
let _titleFocusIdx = 0;           // which title button is currently highlighted
let _titleRepeatTimer = 0;        // debounce for d-pad focus navigation

/**
 * Initialize gamepad support. Wires up the connect/disconnect events and
 * creates the on-screen indicator DOM. Call once at startup.
 */
export function initGamepad(opts = {}) {
  _player = opts.player || null;
  _onDash = opts.onDash || null;
  _onTogglePickaxe = opts.onTogglePickaxe || null;
  _onGrenade = opts.onGrenade || null;
  _onCycleWeapon = opts.onCycleWeapon || null;
  _onPause = opts.onPause || null;
  _onDirectWeapon = opts.onDirectWeapon || null;

  window.addEventListener('gamepadconnected', (e) => {
    const pad = e.gamepad;
    // Full inventory dump — we need the mapping type and exact button count
    // to diagnose why certain buttons might not be firing. "standard" mapping
    // puts face buttons at 0-3, shoulders at 4-5, triggers at 6-7, etc. Any
    // other mapping (empty string, "linux", "xbox-wireless", etc.) means the
    // button indices may not line up with our expectations.
    const CORAL = '#cc785c';
    console.info(
      '%c[gamepad]%c connected · %c' + pad.id + '%c · mapping=%c"' + pad.mapping + '"%c · buttons=%c' + pad.buttons.length + '%c · axes=%c' + pad.axes.length,
      'color:#888', 'color:inherit',
      `color:${CORAL}; font-weight:bold;`, 'color:inherit',
      `color:${CORAL};`, 'color:inherit',
      `color:${CORAL};`, 'color:inherit',
      `color:${CORAL};`,
    );

    // Reject non-controller devices that Windows/macOS enumerate as
    // gamepads. The most common culprits: gaming headsets (e.g. Turtle
    // Beach Stealth 600X) expose mute/volume/voice-chat buttons as a
    // "game controller" HID device. They typically have < 10 buttons
    // and 0-1 axes. A real controller has 16-17 buttons (face + d-pad +
    // shoulders + triggers + stick clicks + home) and 4 axes (two sticks).
    // Filtering by counts is more portable than maintaining an id
    // denylist that'd break with the next headset model.
    if (pad.buttons.length < 10 || pad.axes.length < 2) {
      console.warn(
        '[gamepad] IGNORING "' + pad.id + '" — looks like a headset or non-controller device ' +
        '(buttons=' + pad.buttons.length + ', axes=' + pad.axes.length + ', need ≥10 buttons and ≥2 axes). ' +
        'Its inputs won\'t drive the game.'
      );
      _ignoredPadIndices.add(pad.index);
      return;
    }

    if (pad.mapping !== 'standard') {
      console.warn(
        '[gamepad] NON-STANDARD mapping "' + pad.mapping + '" — button indices may differ from Xbox layout. ' +
        'Press each button; it will log its index. Report which physical button fires which index so the mapping can be adjusted.'
      );
    }
    // Log initial axis values so we can see resting-position drift.
    const axDump = [];
    for (let i = 0; i < pad.axes.length; i++) {
      axDump.push('A' + i + '=' + (pad.axes[i] || 0).toFixed(2));
    }
    console.info('[gamepad] initial axes: ' + axDump.join(' '));
    _connected = true;
    _showIndicator('CONTROLLER CONNECTED', 2.5);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    console.info('[gamepad] disconnected:', e.gamepad.id);
    _ignoredPadIndices.delete(e.gamepad.index);
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let anyStill = false;
    for (const p of pads) {
      if (p && p.connected && !_ignoredPadIndices.has(p.index)) { anyStill = true; break; }
    }
    _connected = anyStill;
    if (!anyStill) _showIndicator('CONTROLLER DISCONNECTED', 2.0);
  });

  _ensureIndicator();
}

/**
 * Switch between title-screen nav mode and in-game mode.
 *
 * When entering title mode, pass the list of focusable buttons in the
 * desired tab order. Pass an empty array or omit to exit title mode.
 *
 * The wallet-connect button must be LEFT OUT of this list — gamepad
 * focus will skip it, but it stays visually present for mouse users.
 */
export function setTitleMode(isOn, focusableButtons) {
  _titleMode = !!isOn;
  _titleButtons = isOn && Array.isArray(focusableButtons) ? focusableButtons : [];
  _titleFocusIdx = 0;
  _titleRepeatTimer = 0;
  _renderTitleFocus();
}

/**
 * Call once per frame from the main game loop BEFORE input-consuming code
 * runs. Reads the first connected pad, writes into joyState/mouse/keys and
 * fires edge-triggered callbacks for the buttons.
 */
export function updateGamepad(dt) {
  if (_indicatorTimer > 0) {
    _indicatorTimer -= dt;
    if (_indicatorTimer <= 0 && _indicatorEl) _indicatorEl.style.opacity = '0';
  }

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  if (!pads) return;

  let pad = null;
  for (const p of pads) {
    if (p && p.connected && !_ignoredPadIndices.has(p.index)) { pad = p; break; }
  }
  _updateDebugOverlay(pad);
  if (!pad) {
    // No pad — leave everything alone. If we had been feeding joyState, clear
    // it so residual stick values don't keep the player walking.
    if (joyState._gamepadDriven) {
      joyState.active = false;
      joyState.dx = 0;
      joyState.dy = 0;
      joyState._gamepadDriven = false;
    }
    // Clear trigger-driven fire if the pad just vanished
    if (mouse._gamepadFire) {
      mouse.down = false;
      mouse._gamepadFire = false;
    }
    return;
  }

  // Check mapping. Standard gamepads are most common but some controllers
  // (older / non-brand / bluetooth) report mapping === "" which means the
  // button-index layout below may differ. The code works as-is for standard
  // mappings; non-standard ones will get the same treatment and any buttons
  // that don't line up will just be silent.
  const btn = pad.buttons || [];
  const axes = pad.axes || [];

  // --- ROUTE: title-screen focus nav ---
  if (_titleMode) {
    _updateTitleNav(dt, pad);
    // Save button states for next frame's edge detection (we still want
    // edge detection in title mode for A/Start).
    for (let i = 0; i < btn.length; i++) {
      _prevButtons[i] = btn[i] && btn[i].pressed;
    }
    return;
  }

  // --- In-game input below ---

  // --- Left stick OR D-pad → movement ---
  // We always check both. Left stick gives analog movement; d-pad gives
  // discrete ±1 values. D-pad is the fallback for controllers whose
  // analog sticks are being read as axes at unexpected indices, AND it's
  // a genuine player preference on some pads.
  const lx_stick = _deadzone(axes[0] || 0);
  const ly_stick = _deadzone(axes[1] || 0);
  // D-pad Up=12, Down=13, Left=14, Right=15 on standard mapping
  let lx_dpad = 0, ly_dpad = 0;
  if (btn[14] && btn[14].pressed) lx_dpad -= 1;
  if (btn[15] && btn[15].pressed) lx_dpad += 1;
  if (btn[12] && btn[12].pressed) ly_dpad -= 1;
  if (btn[13] && btn[13].pressed) ly_dpad += 1;
  const lx = lx_dpad !== 0 ? lx_dpad : lx_stick;
  const ly = ly_dpad !== 0 ? ly_dpad : ly_stick;

  if (lx !== 0 || ly !== 0) {
    joyState.active = true;
    joyState.dx = lx;
    joyState.dy = ly;
    joyState._gamepadDriven = true;
  } else if (joyState._gamepadDriven) {
    joyState.active = false;
    joyState.dx = 0;
    joyState.dy = 0;
    joyState._gamepadDriven = false;
  }

  // --- Right stick → aim ---
  const rx = _deadzone(axes[2] || 0);
  const ry = _deadzone(axes[3] || 0);
  if ((rx !== 0 || ry !== 0) && _player && _player.pos) {
    const mag = Math.sqrt(rx * rx + ry * ry);
    const dx = rx / mag;
    const dz = ry / mag;
    mouse.worldX = _player.pos.x + dx * AIM_DISTANCE;
    mouse.worldZ = _player.pos.z + dz * AIM_DISTANCE;
    mouse._gamepadAiming = true;
  }

  // --- Right trigger → fire ---
  // RT is buttons[7] on standard mapping. It has an analog `value` (0..1).
  // Some older bindings treat it as a pure pressed/not-pressed button, in
  // which case `value` is 0 or 1 and `pressed` is the boolean. We check
  // BOTH so either API shape works.
  const rtBtn = btn[7];
  const rt = rtBtn ? (typeof rtBtn.value === 'number' ? rtBtn.value : (rtBtn.pressed ? 1 : 0)) : 0;
  const rtDown = rt > TRIGGER_THRESHOLD || (rtBtn && rtBtn.pressed);
  if (rtDown) {
    mouse.down = true;
    mouse._gamepadFire = true;
  } else if (mouse._gamepadFire) {
    mouse.down = false;
    mouse._gamepadFire = false;
  }

  // --- Buttons (edge-triggered) ---
  // Standard mapping:
  //   0=A 1=B 2=X 3=Y 4=LB 5=RB 6=LT 7=RT 8=Back 9=Start 10=LS 11=RS
  //   12=Up 13=Down 14=Left 15=Right
  const pressedThisFrame = (i) => btn[i] && btn[i].pressed && !_prevButtons[i];

  // DIAGNOSTIC — log every button press with its index. Critical for
  // debugging non-standard mappings: the user presses each physical button
  // one at a time and we see exactly which index fires. Default on; set
  // window.__noGamepadLog = true in DevTools to silence. Only logs
  // press events (not releases) to avoid doubling the noise.
  if (!(typeof window !== 'undefined' && window.__noGamepadLog === true)) {
    for (let i = 0; i < btn.length; i++) {
      if (btn[i] && btn[i].pressed && !_prevButtons[i]) {
        const v = typeof btn[i].value === 'number' ? btn[i].value.toFixed(2) : '1.00';
        const hint = _BUTTON_HINTS[i] || '?';
        console.info(
          '%c[gamepad]%c button ' + i + ' pressed (value=' + v + ') · expected: ' + hint,
          'color:#888', 'color:inherit',
        );
      }
    }
  }

  if (pressedThisFrame(0) && _onDash) _onDash();
  if (pressedThisFrame(1) && _onGrenade) _onGrenade();
  if (pressedThisFrame(2) && _onTogglePickaxe) _onTogglePickaxe();
  if (pressedThisFrame(9) && _onPause) _onPause();
  if (pressedThisFrame(4) && _onCycleWeapon) _onCycleWeapon(-1);
  if (pressedThisFrame(5) && _onCycleWeapon) _onCycleWeapon(+1);

  for (let i = 0; i < btn.length; i++) {
    _prevButtons[i] = btn[i] && btn[i].pressed;
  }
}

export function gamepadConnected() {
  return _connected;
}

// ----------------------------------------------------------------------------
//  DEBUG OVERLAY
// ----------------------------------------------------------------------------
// Add `?debug-gamepad` to the page URL to show a small overlay listing the
// pad's id, button count, axis count, and every currently-pressed button
// index + any non-zero axis value. Only runs when the flag is set so
// there's no production cost.

let _debugEl = null;
const _DEBUG_GAMEPAD = typeof window !== 'undefined'
  && typeof window.location !== 'undefined'
  && /[?&]debug-gamepad\b/.test(window.location.search || '');

function _updateDebugOverlay(pad) {
  if (!_DEBUG_GAMEPAD) return;
  if (!_debugEl) {
    _debugEl = document.createElement('div');
    _debugEl.id = 'gamepad-debug';
    _debugEl.style.cssText = [
      'position: fixed',
      'right: 8px',
      'bottom: 8px',
      'padding: 8px 12px',
      'background: rgba(0,0,0,0.8)',
      'color: #00ff66',
      'font-family: monospace',
      'font-size: 11px',
      'line-height: 1.4',
      'z-index: 10000',
      'pointer-events: none',
      'max-width: 360px',
      'white-space: pre',
    ].join(';');
    document.body.appendChild(_debugEl);
  }
  if (!pad) {
    _debugEl.textContent = 'GAMEPAD: (no pad connected)';
    return;
  }
  const lines = [];
  lines.push('id: ' + pad.id);
  lines.push('mapping: "' + pad.mapping + '"  buttons:' + pad.buttons.length + '  axes:' + pad.axes.length);
  // Show any pressed button index + trigger values
  const pressed = [];
  for (let i = 0; i < pad.buttons.length; i++) {
    const b = pad.buttons[i];
    if (!b) continue;
    const v = typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0);
    if (v > 0.02) pressed.push('B' + i + '=' + v.toFixed(2));
  }
  lines.push('pressed: ' + (pressed.join(' ') || '(none)'));
  // Show each axis that's non-zero past deadzone
  const axStr = [];
  for (let i = 0; i < pad.axes.length; i++) {
    const v = pad.axes[i] || 0;
    if (Math.abs(v) > 0.1) axStr.push('A' + i + '=' + v.toFixed(2));
  }
  lines.push('axes: ' + (axStr.join(' ') || '(neutral)'));
  _debugEl.textContent = lines.join('\n');
}

// ----------------------------------------------------------------------------
//  TITLE-SCREEN NAVIGATION
// ----------------------------------------------------------------------------
// When _titleMode is on, stick/dpad input moves focus between the list of
// buttons passed to setTitleMode(). A or Start activates the focused
// button (via its click()).

function _updateTitleNav(dt, pad) {
  if (!_titleButtons.length) return;
  const btn = pad.buttons || [];
  const axes = pad.axes || [];

  // Figure out a ±1 "direction" pressed this frame. We combine d-pad
  // up/down with the left stick's Y axis so either works.
  let dir = 0;
  if (btn[13] && btn[13].pressed) dir = 1;          // D-pad down
  else if (btn[12] && btn[12].pressed) dir = -1;    // D-pad up
  else {
    const ly = _deadzone(axes[1] || 0);
    if (ly > 0.5) dir = 1;
    else if (ly < -0.5) dir = -1;
  }

  // Auto-repeat: once every 0.22s while the direction is held. Fast enough
  // to feel responsive when walking through a list; slow enough that a
  // quick tap moves exactly one step.
  if (dir !== 0) {
    _titleRepeatTimer -= dt;
    if (_titleRepeatTimer <= 0) {
      _titleFocusIdx = (_titleFocusIdx + dir + _titleButtons.length) % _titleButtons.length;
      _titleRepeatTimer = 0.22;
      _renderTitleFocus();
    }
  } else {
    _titleRepeatTimer = 0;   // reset on release so the next press is instant
  }

  // A button (index 0) or Start (index 9) clicks the focused button. Use
  // edge detection so holding A doesn't fire repeatedly.
  const aDown = btn[0] && btn[0].pressed && !_prevButtons[0];
  const startDown = btn[9] && btn[9].pressed && !_prevButtons[9];
  if (aDown || startDown) {
    const el = _titleButtons[_titleFocusIdx];
    if (el) {
      try { el.click(); } catch (e) { /* swallow */ }
    }
  }
}

function _renderTitleFocus() {
  if (!_titleButtons.length) return;
  // Add a 'gp-focus' class to the focused button, remove from all others.
  // Styling for .gp-focus is injected below so no CSS file edits are
  // required — this keeps the title-mode feature self-contained.
  _ensureTitleFocusStyle();
  for (let i = 0; i < _titleButtons.length; i++) {
    if (_titleButtons[i]) _titleButtons[i].classList.toggle('gp-focus', i === _titleFocusIdx);
  }
}

let _titleFocusStyleInjected = false;
function _ensureTitleFocusStyle() {
  if (_titleFocusStyleInjected) return;
  _titleFocusStyleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .gp-focus {
      outline: 3px solid #00ff66 !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 20px rgba(0,255,102,0.6), 0 0 40px rgba(0,255,102,0.3) !important;
      transform: scale(1.04) !important;
      transition: transform 0.1s !important;
    }
  `;
  document.head.appendChild(style);
}

// ----------------------------------------------------------------------------
//  HELPERS
// ----------------------------------------------------------------------------

function _deadzone(v) {
  if (Math.abs(v) < DEADZONE) return 0;
  const sign = v < 0 ? -1 : 1;
  return sign * ((Math.abs(v) - DEADZONE) / (1 - DEADZONE));
}

function _ensureIndicator() {
  if (_indicatorEl) return;
  _indicatorEl = document.createElement('div');
  _indicatorEl.id = 'gamepad-indicator';
  _indicatorEl.style.cssText = [
    'position: fixed',
    'left: 50%',
    'top: 80px',
    'transform: translateX(-50%)',
    'padding: 8px 18px',
    'background: rgba(0,20,10,0.85)',
    'border: 2px solid #00ff66',
    'color: #00ff66',
    'font-family: "Impact", monospace',
    'font-size: 14px',
    'letter-spacing: 3px',
    'text-shadow: 0 0 6px #00ff66',
    'box-shadow: 0 0 20px rgba(0,255,102,0.4)',
    'z-index: 50',
    'opacity: 0',
    'transition: opacity 0.3s',
    'pointer-events: none',
  ].join(';');
  document.body.appendChild(_indicatorEl);
}

function _showIndicator(text, seconds) {
  _ensureIndicator();
  _indicatorEl.textContent = '🎮 ' + text;
  _indicatorEl.style.opacity = '1';
  _indicatorTimer = seconds;
}
