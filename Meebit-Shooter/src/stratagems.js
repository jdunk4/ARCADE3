// stratagems.js — Helldivers-style call-in system.
//
// Player holds RMB (or D-pad-LB on controller — wired in main.js
// gamepad code) to OPEN the stratagem menu, then taps arrow keys
// (or D-pad directions) to enter a code. Match a known code and the
// player throws a beacon to the cursor target; 10 seconds later the
// payload deploys at the beacon position.
//
// AVAILABLE STRATAGEMS (codes match Helldivers conventions where
// reasonable; new ones use short distinctive sequences):
//   • EAGLE 500KG BOMB         ↑→↓↓↓     (one-shot massive AoE)
//   • RESUPPLY MECH            ↓↑→→↑     (drops a pilotable mech)
//   • MINE FIELD               ↓→→↓     (scatters anti-personnel mines)
//
// ARTIFACT GATING:
// Each stratagem requires a corresponding artifact count > 0 in
// S.stratagemArtifacts. Tutorial bonus waves grant temporary
// artifacts so the player can practice; main-game pickups (chapter
// 7+) will increment the counts permanently. A stratagem CONSUMES
// one artifact per call.
//
// Public API:
//   beginStratagemInput()           — call on RMB/L1 down
//   endStratagemInput()             — call on RMB/L1 up. If a valid
//                                     code is held, throws the beacon.
//   pushStratagemArrow(dir)         — 'up' | 'down' | 'left' | 'right'
//   updateStratagems(dt)            — per-frame tick (also ticks
//                                     active beacons + mech)
//   isStratagemMenuOpen()           — UI helper
//   stratagemHudHtml()              — string for HUD overlay
//   grantArtifact(id, n)            — bump a stratagem's artifact count
//   resetStratagems()               — full reset (game start, restart)

import * as THREE from 'three';
import { S, mouse } from './state.js';
import { camera, scene } from './scene.js';
import { spawnStratagemBeacon, updateStratagemBeacons, clearStratagemBeacons } from './stratagemBeacon.js';
import { spawnMech, updateMechs, clearMechs } from './mech.js';

// =====================================================================
// STRATAGEM CATALOG
// =====================================================================
// Each entry:
//   id        — unique key, also used as artifact key in
//               S.stratagemArtifacts
//   label     — display name in menu / HUD
//   code      — array of arrow direction strings; matched left-to-right
//   payload   — function(beaconPos, tint) called on deploy completion
//   armTime   — seconds between beacon landing and payload firing
//   icon      — single-char shorthand for the menu (cheap visual)
//   variant   — when truthy, this stratagem has multiple variants
//               selectable via UI sub-pick or in-menu cycle keys.
//               Catalog entry stores the *list* of variants for HUD
//               rendering; live selection is in S (mech) or local
//               state (turret).
const _STRATAGEMS = [
  {
    // THERMONUCLEAR — single massive AoE detonation. Was previously
    // labeled "500KG BOMB"; renamed to fit the chapter-7 sci-fi tone.
    id: 'thermonuclear',
    label: 'THERMONUCLEAR',
    code: ['up', 'right', 'down', 'down', 'down'],
    armTime: 10.0,
    icon: '☢',
    payload: (pos, tint) => _firePayloadThermonuclear(pos, tint),
  },
  {
    // Single MECH stratagem; variant chosen via the sticky
    // S.stratagemMechVariant flag set by the picker UI (digit keys
    // 1/2/3 while menu is open). Default = 'minigun'.
    id: 'mech',
    label: 'EXOSUIT',
    code: ['down', 'up', 'right', 'right', 'up'],
    armTime: 10.0,
    icon: '⚙',
    variant: ['minigun', 'rocket', 'flame'],
    payload: (pos, tint) => _firePayloadMech(pos, tint),
  },
  // ---- MINES ----
  // Single code. Variant (HE / incendiary / toxic) is picked via the
  // in-menu 1/2/3 cycle key (S.stratagemMineVariant). Mirrors the
  // mech sub-picker UX so the player has one consistent pattern.
  {
    id: 'mines',
    label: 'MINE FIELD',
    code: ['down', 'right', 'right', 'down'],
    armTime: 8.0,
    icon: '◆',
    variant: ['explosion', 'fire', 'poison'],
    payload: (pos, tint) => _firePayloadMines(pos, tint),
  },
  // ---- TURRET ----
  // Single code; variant cycled by digit keys 1/2/3/4 while menu is
  // open. Live selection lives in S.stratagemTurretVariant.
  {
    id: 'turret',
    label: 'SENTRY TURRET',
    code: ['down', 'up', 'right', 'down', 'up'],
    armTime: 6.0,
    icon: '⊞',
    variant: ['mg', 'tesla', 'flame', 'antitank'],
    payload: (pos, tint) => _firePayloadTurret(pos, tint),
  },
];

// Lookup table for fast code matching: stringified code → entry.
const _CODE_LOOKUP = new Map();
for (const s of _STRATAGEMS) {
  _CODE_LOOKUP.set(s.code.join(','), s);
}

// =====================================================================
// MENU STATE
// =====================================================================
let _menuOpen = false;
let _enteredCode = [];        // arrows pressed since menu opened
let _matchedStratagem = null; // non-null when current input matches a code

export function isStratagemMenuOpen() { return _menuOpen; }

export function beginStratagemInput() {
  if (_menuOpen) return;
  _menuOpen = true;
  _enteredCode = [];
  _matchedStratagem = null;
}

export function endStratagemInput() {
  if (!_menuOpen) return;
  // If the player released the menu key with a matching code, fire it.
  if (_matchedStratagem) {
    _attemptCallIn(_matchedStratagem);
  }
  _menuOpen = false;
  _enteredCode = [];
  _matchedStratagem = null;
}

// Variant selection while menu is open. Digit keys 1-4 cycle the
// variant of whichever stratagem is currently matched, OR — if no
// match yet — they cycle the LAST-MATCHED stratagem's variant
// (sticky between calls). Only respects digits within the variant
// list length.
//
// Routed from main.js's keydown handler when isStratagemMenuOpen().
export function pushStratagemVariantKey(digit) {
  if (!_menuOpen) return;
  // Determine which stratagem the player is selecting variants for.
  // If they've matched a code mid-typing, use that. Otherwise default
  // to whichever variant-supporting stratagem they have artifacts for
  // — preferring 'mech' first, then 'turret'.
  let target = _matchedStratagem;
  if (!target || !target.variant) {
    const arts = S.stratagemArtifacts || {};
    for (const s of _STRATAGEMS) {
      if (!s.variant) continue;
      if ((arts[s.id] || 0) > 0) { target = s; break; }
    }
  }
  if (!target || !target.variant) return;
  const idx = digit - 1;
  if (idx < 0 || idx >= target.variant.length) return;
  if (target.id === 'mech') {
    S.stratagemMechVariant = target.variant[idx];
  } else if (target.id === 'turret') {
    S.stratagemTurretVariant = target.variant[idx];
  } else if (target.id === 'mines') {
    S.stratagemMineVariant = target.variant[idx];
  }
}

export function pushStratagemArrow(dir) {
  if (!_menuOpen) return;
  _enteredCode.push(dir);
  // Match against catalog.
  const key = _enteredCode.join(',');
  const exact = _CODE_LOOKUP.get(key);
  if (exact) {
    _matchedStratagem = exact;
    return;
  }
  // Prefix check — does any catalog code start with what's entered?
  // If not, the code is invalid; shake/clear so the player can retry.
  let isPrefix = false;
  for (const s of _STRATAGEMS) {
    if (s.code.length < _enteredCode.length) continue;
    let ok = true;
    for (let i = 0; i < _enteredCode.length; i++) {
      if (s.code[i] !== _enteredCode[i]) { ok = false; break; }
    }
    if (ok) { isPrefix = true; break; }
  }
  if (!isPrefix) {
    // Wrong code — clear so the player can start over.
    _enteredCode = [];
    _matchedStratagem = null;
  } else {
    _matchedStratagem = null;
  }
}

// =====================================================================
// CALL-IN
// =====================================================================
// Called when the player releases the menu with a matched code. We
// check the artifact count, decrement it, and throw a beacon at the
// cursor's ground intersection.
function _attemptCallIn(stratagem) {
  const arts = S.stratagemArtifacts || {};
  const count = arts[stratagem.id] || 0;
  if (count <= 0) {
    // No artifacts — show a brief feedback. We'd hook UI.toast here
    // but to avoid a circular import we surface the failure via a
    // global hook that main.js wires to UI on first use.
    if (typeof window !== 'undefined' && window.__stratagemNoArtifact) {
      window.__stratagemNoArtifact(stratagem);
    }
    return;
  }
  // Spend one artifact and throw the beacon.
  arts[stratagem.id] = count - 1;
  const target = _resolveCursorGround();
  if (!target) return;
  // Tint comes from the chapter's lamp color so beacons match the
  // chapter palette. Fallback to red if no chapter context yet.
  const tint = (typeof window !== 'undefined' && window.__stratagemTint) || 0xff5520;
  spawnStratagemBeacon(target, stratagem, tint);
  // Notify any tutorial observer (bonus lessons listen for specific
  // stratagem ids to mark their "called" sub-step done).
  if (typeof window !== 'undefined' && window.__bonusObserve && window.__bonusObserve.onCall) {
    try { window.__bonusObserve.onCall(stratagem.id); } catch (e) {}
  }
}

// Compute the ground point under the player's cursor by raycasting
// from the camera through the cursor (mouse.x/y in NDC) onto the
// horizontal plane at y=0. Returns a Vector3 or null if the ray
// misses (which shouldn't happen for a downward camera).
const _scratchRaycaster = new THREE.Raycaster();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _scratchVec3 = new THREE.Vector3();
function _resolveCursorGround() {
  // mouse.x/y are NDC in [-1..1] (set in main.js mousemove handler).
  const mx = (mouse && typeof mouse.x === 'number') ? mouse.x : 0;
  const my = (mouse && typeof mouse.y === 'number') ? mouse.y : 0;
  _scratchRaycaster.setFromCamera({ x: mx, y: my }, camera);
  const hit = _scratchRaycaster.ray.intersectPlane(_groundPlane, _scratchVec3);
  if (!hit) return null;
  return hit.clone();
}

// =====================================================================
// PAYLOADS
// =====================================================================
// Each payload deploys at the beacon position when the timer expires.
// They're free functions (not closures over per-instance state) so
// the catalog table stays simple.

function _firePayloadThermonuclear(pos, tint) {
  // Massive AoE. We delegate to a global hook to avoid coupling
  // stratagems.js to effects.js + enemies.js. Hook name preserved
  // (window.__stratagemFireNuke) for clarity; the host wires it.
  if (typeof window !== 'undefined' && window.__stratagemFireNuke) {
    window.__stratagemFireNuke(pos, tint);
  }
}

function _firePayloadMech(pos, tint) {
  // Variant chosen by the in-menu picker (digit keys 1/2/3 while
  // menu was open). Default to 'minigun' if no pick was made.
  const variant = S.stratagemMechVariant || 'minigun';
  spawnMech(pos, tint, variant);
}

function _firePayloadMines(pos, tint) {
  // Variant chosen by the in-menu picker (digit keys 1/2/3 — same
  // pattern as mech). Default to 'explosion' if no pick was made.
  const variant = S.stratagemMineVariant || 'explosion';
  if (typeof window !== 'undefined' && window.__stratagemDeployMines) {
    window.__stratagemDeployMines(pos, tint, variant);
  }
}

function _firePayloadTurret(pos, tint) {
  // Variant chosen by the in-menu cycle (digit keys 1-4). Default
  // to 'mg' if nothing was set (the picker defaults to mg too).
  const variant = S.stratagemTurretVariant || 'mg';
  if (typeof window !== 'undefined' && window.__stratagemDeployTurret) {
    window.__stratagemDeployTurret(pos, tint, variant);
  }
}

// =====================================================================
// PER-FRAME TICK
// =====================================================================
// Called from main.js animate loop. Cascades to beacon and mech ticks
// so the host code only has one entry point.
export function updateStratagems(dt) {
  updateStratagemBeacons(dt);
  updateMechs(dt);
}

// =====================================================================
// HUD
// =====================================================================
// Returns a lightweight HTML string for an overlay panel showing the
// menu state. main.js owns rendering; we just produce content.
export function stratagemHudHtml() {
  if (!_menuOpen) {
    // Closed — show artifact counts as a small status strip.
    const arts = S.stratagemArtifacts || {};
    const parts = [];
    for (const s of _STRATAGEMS) {
      const n = arts[s.id] || 0;
      if (n > 0) {
        parts.push(`<span style="color:#ffd93d;">${s.icon}×${n}</span>`);
      }
    }
    if (!parts.length) return '';
    return `<div style="font-size:11px;letter-spacing:2px;color:#888;">STRATAGEMS · ${parts.join(' · ')}</div>`;
  }
  // Open menu — show entered code + matched stratagem (if any).
  const ARROW = { up: '↑', down: '↓', left: '←', right: '→' };
  const entered = _enteredCode.map((d) => ARROW[d] || '?').join(' ');
  let line2;
  if (_matchedStratagem) {
    line2 = `<div style="color:#7af797;font-size:14px;letter-spacing:2px;">↳ ${_matchedStratagem.icon} ${_matchedStratagem.label} · RELEASE TO CALL</div>`;
  } else {
    // List available stratagem codes as hints (only those the player
    // has artifacts for).
    const arts = S.stratagemArtifacts || {};
    const hints = [];
    for (const s of _STRATAGEMS) {
      const n = arts[s.id] || 0;
      if (n <= 0) continue;
      const codeStr = s.code.map((d) => ARROW[d]).join(' ');
      hints.push(`<span style="color:#aaa;">${s.icon} ${s.label}: <span style="color:#ffd93d;">${codeStr}</span></span>`);
    }
    line2 = `<div style="font-size:11px;line-height:1.6;letter-spacing:1px;">${hints.join('<br>')}</div>`;
  }
  // Variant picker — shown for any variant-supporting stratagem the
  // player has artifacts for. Lists "1 ▸ minigun · 2 ▸ rocket · 3 ▸ flame"
  // with the active pick highlighted. Player presses 1/2/3/4 while
  // the menu is open to cycle.
  const arts = S.stratagemArtifacts || {};
  let picker = '';
  for (const s of _STRATAGEMS) {
    if (!s.variant) continue;
    if ((arts[s.id] || 0) <= 0) continue;
    const liveKey = s.id === 'mech' ? 'stratagemMechVariant'
                  : s.id === 'turret' ? 'stratagemTurretVariant'
                  : s.id === 'mines' ? 'stratagemMineVariant'
                  : null;
    if (!liveKey) continue;
    const active = S[liveKey] || s.variant[0];
    const opts = s.variant.map((v, i) => {
      const isActive = v === active;
      const color = isActive ? '#7af797' : '#aaa';
      const weight = isActive ? 'bold' : 'normal';
      return `<span style="color:${color};font-weight:${weight};">${i + 1}▸${v}</span>`;
    }).join(' · ');
    picker += `<div style="margin-top:6px;font-size:11px;color:#888;letter-spacing:1px;">${s.icon} ${s.label}: ${opts}</div>`;
  }
  return `
    <div style="
      position: fixed; right: 20px; bottom: 80px;
      background: rgba(7,3,13,0.85);
      border: 1px solid #ffd93d;
      padding: 12px 18px;
      font-family: Impact, monospace;
      color: #fff;
      letter-spacing: 2px;
      pointer-events: none;
      z-index: 9000;
    ">
      <div style="font-size:11px;color:#ffd93d;letter-spacing:3px;margin-bottom:6px;">STRATAGEM</div>
      <div style="font-size:22px;letter-spacing:6px;color:#ffd93d;margin-bottom:8px;min-height:26px;">${entered || '_'}</div>
      ${line2}
      ${picker}
    </div>`;
}

// =====================================================================
// ARTIFACT MANAGEMENT
// =====================================================================
export function grantArtifact(id, n = 1) {
  if (!S.stratagemArtifacts) S.stratagemArtifacts = {};
  S.stratagemArtifacts[id] = (S.stratagemArtifacts[id] || 0) + n;
}

export function resetStratagems() {
  _menuOpen = false;
  _enteredCode = [];
  _matchedStratagem = null;
  clearStratagemBeacons();
  clearMechs();
}

// =====================================================================
// CATALOG ACCESS (for tutorial / debug UI)
// =====================================================================
export function getStratagemCatalog() {
  return _STRATAGEMS.map((s) => ({
    id: s.id,
    label: s.label,
    code: s.code.slice(),
    icon: s.icon,
    armTime: s.armTime,
  }));
}
