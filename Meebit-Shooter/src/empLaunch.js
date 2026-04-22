// ============================================================================
// src/empLaunch.js — EMP missile launch cinematic.
//
// When the generator's charge hits 100%, this module takes over:
//
//   PHASE 1 — FLIGHT (0..0.8s)
//     A new missile mesh is spawned at the silo launch origin. It flies
//     straight up at increasing speed, leaves a chapter-tinted exhaust
//     trail, and triggers a screen shake.
//
//   PHASE 2 — PEAK FLASH (0.8..1.2s)
//     The missile disappears from the world. A DOM overlay flashes a
//     missile-streak across the viewport for the "across-your-screen" beat.
//
//   PHASE 3 — COUNTDOWN (1.2..21.2s, i.e. 20s of detonation wait)
//     HUD shows "EMP DETONATION · Ns" big on center screen. Gameplay
//     continues normally — turrets fire, enemies keep spawning (including
//     from the shielded hives, which are still immune). Player plays on.
//
//   PHASE 4 — DETONATION (21.2s)
//     Full-screen white flash for 80ms, then arena lighting drops hard
//     (ambient + hemi intensity fall ~85%, fog density 2x). Enemies +
//     player keep their glow because emissive materials bypass ambient.
//     A chapter-tinted shockwave ring mesh expands outward from silo
//     over ~1.2s. When shockwave reaches each hive, that hive's shield
//     drops (sequential via per-hive radius check). After ring passes
//     OUTER_RADIUS, lighting recovers over 2s back to the post-EMP
//     baseline. Then we fire the normal _fireEmp() flow which wraps
//     wave 2.
//
// Interface:
//   startLaunch()  — begin the cinematic. Called from waves.js via the
//                    generator's launch handler.
//   updateLaunch(dt, time) — per-frame tick. Called every frame from
//                    main.js unconditionally; no-ops when inactive.
//   isLaunching()  — true while phases 1-4 are running. waves.js checks
//                    this to suppress the old auto-EMP stub.
//   endLaunch()    — called by updateLaunch when phase 4 completes; fires
//                    the existing _fireEmp hook passed in at init.
// ============================================================================

import * as THREE from 'three';
import { scene, renderer } from './scene.js';
import { CHAPTERS } from './config.js';
import { S, shake } from './state.js';
import { UI } from './ui.js';
import { Audio } from './audio.js';
import { hitBurst } from './effects.js';
import { getSiloLaunchOrigin, hideSiloMissile, LAYOUT } from './waveProps.js';
import { spawners } from './spawners.js';
import { removeHiveShields } from './dormantProps.js';
import { getCentroidFor } from './triangles.js';
import { fireShockwave } from './shockwave.js';

// Phase durations.
const FLIGHT_SEC = 1.4;       // longer now — missile arcs across the map
const PEAK_SEC = 0.3;
const COUNTDOWN_SEC = 5.0;    // shorter — was 20, player asked for 5
const FLASH_SEC = 0.08;
const DARKEN_SEC = 1.2;
const LIGHT_RECOVER_SEC = 2.0;

const SHOCKWAVE_MAX_R = 55;

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

let _phase = 'idle';    // 'idle' | 'flight' | 'peak' | 'countdown' | 'detonate' | 'recover'
let _phaseT = 0;        // seconds into current phase
let _active = false;

// Per-launch scene objects (created in startLaunch, cleaned in teardown)
let _missileMesh = null;
let _exhaustBursts = 0;
let _flightStart = null;   // THREE.Vector3 silo origin
let _flightTarget = null;  // THREE.Vector3 hive triangle centroid
let _shockwaveHitHives = null;
let _domOverlay = null;
let _hudCountdown = null;
let _ambientSaved = null;
let _onDetonation = null;

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/** Register the callback fired when detonation completes. waves.js wires
 *  this to its own _fireEmp() wrapper (minus shield-drop, which the
 *  shockwave does via removeHiveShields()). */
export function registerDetonationHandler(fn) {
  _onDetonation = fn;
}

export function isLaunching() {
  return _active;
}

/** Start the launch cinematic. Idempotent — re-entrant calls are ignored. */
export function startLaunch() {
  if (_active) return;
  _active = true;
  _phase = 'flight';
  _phaseT = 0;
  _shockwaveHitHives = new Set();

  const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  const tint = chapter.full.grid1;

  // Spawn the flight missile at the silo top and hide the in-silo copy.
  const origin = getSiloLaunchOrigin();
  if (origin) {
    _missileMesh = _buildFlightMissile(tint);
    _missileMesh.position.copy(origin);
    scene.add(_missileMesh);
    _flightStart = origin.clone();
  } else {
    // Fallback — shouldn't happen in practice.
    _flightStart = new THREE.Vector3(LAYOUT.silo.x, 6.5, LAYOUT.silo.z);
  }
  hideSiloMissile();

  // Flight target: centroid of the hive triangle. The missile arcs from
  // the silo toward the hives and detonates directly over them, so the
  // shockwave ripples outward from the hives instead of from the silo.
  const hiveCentroid = getCentroidFor('hive');
  _flightTarget = new THREE.Vector3(hiveCentroid.x, 0.5, hiveCentroid.z);

  // Initial ignition burst + shake.
  if (origin) {
    hitBurst(origin, 0xffffff, 18);
    hitBurst(origin, 0xffaa00, 22);
  }
  shake(0.6, 0.4);
  try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}

  UI.toast('EMP MISSILE LAUNCHED', '#4ff7ff', 2200);
}

// ---------------------------------------------------------------------------
// BUILDERS
// ---------------------------------------------------------------------------

function _buildFlightMissile(tint) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    emissive: tint,
    emissiveIntensity: 0.5,
    metalness: 0.8,
    roughness: 0.3,
  });
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 3.2, 10),
    bodyMat,
  );
  g.add(body);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.55, 1.1, 10),
    bodyMat,
  );
  nose.position.y = 2.15;
  g.add(nose);
  // Exhaust cone pointing down
  const exhaustMat = new THREE.MeshBasicMaterial({
    color: 0xffaa00,
    transparent: true,
    opacity: 0.9,
  });
  const exhaust = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.6, 8),
    exhaustMat,
  );
  exhaust.position.y = -2.4;
  exhaust.rotation.x = Math.PI;
  g.add(exhaust);
  return g;
}

// ---------------------------------------------------------------------------
// DOM overlays (flash + countdown)
// ---------------------------------------------------------------------------

function _ensureDomOverlay() {
  if (_domOverlay) return;
  _domOverlay = document.createElement('div');
  _domOverlay.id = 'emp-flash';
  _domOverlay.style.cssText = `
    position: fixed; inset: 0; pointer-events: none;
    background: #ffffff;
    opacity: 0;
    z-index: 9200;
    transition: opacity 0.12s ease-out;
  `;
  document.body.appendChild(_domOverlay);
}

function _showPeakStreak(tint) {
  _ensureDomOverlay();
  const cssTint = '#' + tint.toString(16).padStart(6, '0');
  // Use the overlay as a canvas-like gradient streak for the peak flash.
  _domOverlay.style.background =
    `linear-gradient(115deg, transparent 35%, ${cssTint} 48%, #ffffff 52%, ${cssTint} 56%, transparent 70%)`;
  _domOverlay.style.opacity = '0.9';
  // Fade after ~0.35s
  setTimeout(() => {
    if (_domOverlay) _domOverlay.style.opacity = '0';
  }, 350);
}

function _showDetonationFlash() {
  _ensureDomOverlay();
  _domOverlay.style.background = '#ffffff';
  _domOverlay.style.opacity = '1';
  setTimeout(() => {
    if (_domOverlay) _domOverlay.style.opacity = '0';
  }, FLASH_SEC * 1000);
}

function _ensureHudCountdown() {
  if (_hudCountdown) return;
  _hudCountdown = document.createElement('div');
  _hudCountdown.id = 'emp-countdown';
  _hudCountdown.style.cssText = `
    position: fixed;
    top: 18%;
    left: 50%;
    transform: translateX(-50%);
    font-family: 'Impact', monospace;
    font-size: clamp(32px, 5vw, 64px);
    letter-spacing: 6px;
    color: #4ff7ff;
    text-shadow: 0 0 18px #4ff7ff, 0 0 36px #4ff7ff, 2px 2px 0 #000;
    pointer-events: none;
    z-index: 15;
    opacity: 0;
    transition: opacity 0.3s ease-out;
  `;
  document.body.appendChild(_hudCountdown);
}
function _setCountdownText(secLeft) {
  _ensureHudCountdown();
  const txt = `EMP DETONATION · ${Math.ceil(secLeft)}s`;
  _hudCountdown.textContent = txt;
  _hudCountdown.style.opacity = '1';
}
function _hideCountdown() {
  if (_hudCountdown) _hudCountdown.style.opacity = '0';
}

// ---------------------------------------------------------------------------
// LIGHTING DARKEN / RESTORE
// ---------------------------------------------------------------------------

function _darkenArena() {
  // Cache every scene light's current intensity so we can restore later.
  _ambientSaved = [];
  scene.traverse((obj) => {
    if (obj.isLight && obj.intensity !== undefined) {
      _ambientSaved.push({ light: obj, orig: obj.intensity });
      obj.intensity = obj.intensity * 0.15;
    }
  });
  // Ramp fog density if present.
  if (scene.fog && scene.fog.density !== undefined) {
    _fogSaved = scene.fog.density;
    scene.fog.density = _fogSaved * 2.5;
  } else if (scene.fog && scene.fog.far !== undefined) {
    _fogSaved = scene.fog.far;
    scene.fog.far = _fogSaved * 0.4;  // Closer far = more fog
  }
}
let _fogSaved = null;

function _restoreLighting(frac) {
  // frac 0..1 — how much back toward normal.
  if (_ambientSaved) {
    for (const entry of _ambientSaved) {
      entry.light.intensity = entry.orig * (0.15 + 0.85 * frac);
    }
  }
  if (_fogSaved !== null && scene.fog) {
    if (scene.fog.density !== undefined) {
      scene.fog.density = _fogSaved * (2.5 - 1.5 * frac);
    } else if (scene.fog.far !== undefined) {
      scene.fog.far = _fogSaved * (0.4 + 0.6 * frac);
    }
  }
}

function _fullyRestoreLighting() {
  _restoreLighting(1);
  _ambientSaved = null;
  _fogSaved = null;
}

// ---------------------------------------------------------------------------
// PER-FRAME TICK
// ---------------------------------------------------------------------------

export function updateLaunch(dt, time) {
  if (!_active) return;
  _phaseT += dt;
  const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  const tint = chapter.full.grid1;

  if (_phase === 'flight') {
    // Parabolic arc from silo origin to hive-triangle centroid. Peak
    // height scales with horizontal distance so the arc feels right even
    // when the two points are close.
    const f = Math.min(1, _phaseT / FLIGHT_SEC);
    if (_missileMesh && _flightStart && _flightTarget) {
      // Lerp xz linearly; y = lerp + parabola kick at mid-flight.
      const x = _flightStart.x + (_flightTarget.x - _flightStart.x) * f;
      const z = _flightStart.z + (_flightTarget.z - _flightStart.z) * f;
      const baseY = _flightStart.y + (_flightTarget.y - _flightStart.y) * f;
      // Parabola: peak height = 0.7× horizontal distance, so a long flight
      // arcs higher than a short one.
      const horizDist = Math.hypot(
        _flightTarget.x - _flightStart.x,
        _flightTarget.z - _flightStart.z
      );
      const peakKick = Math.max(6, horizDist * 0.7);
      const arcY = 4 * peakKick * f * (1 - f);  // classic 4·h·t·(1-t)
      _missileMesh.position.set(x, baseY + arcY, z);

      // Orient along velocity. Derivative of the arc:
      //   dx/df, dz/df = (target-start) constants
      //   dy/df = lerpDy + 4*peak*(1 - 2f)
      const lerpDy = _flightTarget.y - _flightStart.y;
      const vx = _flightTarget.x - _flightStart.x;
      const vz = _flightTarget.z - _flightStart.z;
      const vy = lerpDy + 4 * peakKick * (1 - 2 * f);
      const horizLen = Math.hypot(vx, vz);
      // Pitch: angle above horizontal.
      const pitch = Math.atan2(vy, horizLen);
      // Yaw: direction of travel in XZ.
      const yaw = Math.atan2(vx, vz);
      _missileMesh.rotation.set(pitch - Math.PI / 2, yaw, 0, 'YXZ');

      // Exhaust burst every other frame.
      _exhaustBursts++;
      if (_exhaustBursts % 2 === 0) {
        // Spawn exhaust slightly behind the missile along velocity.
        const back = _missileMesh.position.clone();
        const vLen = Math.hypot(vx, vy, vz) || 1;
        back.x -= (vx / vLen) * 1.6;
        back.y -= (vy / vLen) * 1.6;
        back.z -= (vz / vLen) * 1.6;
        hitBurst(back, 0xffaa00, 4);
        hitBurst(back, 0xffffff, 2);
      }
    }

    if (_phaseT >= FLIGHT_SEC) {
      // Transition to peak. Missile vanishes; DOM streak carries the beat.
      _phase = 'peak';
      _phaseT = 0;
      if (_missileMesh && _missileMesh.parent) scene.remove(_missileMesh);
      _missileMesh = null;
      _showPeakStreak(tint);
    }
  }
  else if (_phase === 'peak') {
    if (_phaseT >= PEAK_SEC) {
      _phase = 'countdown';
      _phaseT = 0;
      UI.toast('HOLD THE LINE — EMP DETONATES IN 20 SECONDS', '#4ff7ff', 3000);
    }
  }
  else if (_phase === 'countdown') {
    const left = Math.max(0, COUNTDOWN_SEC - _phaseT);
    _setCountdownText(left);
    if (_phaseT >= COUNTDOWN_SEC) {
      _phase = 'detonate';
      _phaseT = 0;
      _hideCountdown();
      _showDetonationFlash();
      _darkenArena();
      shake(1.2, 0.8);
      try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
      // Shockwave originates from the hive-triangle centroid — where
      // the missile detonated — not the silo. As the ring passes each
      // hive, drop that hive's shield via the onRadius callback.
      const origin = _flightTarget || { x: 0, y: 0.2, z: 0 };
      fireShockwave(
        { x: origin.x, y: 0.2, z: origin.z },
        {
          maxRadius: SHOCKWAVE_MAX_R,
          durationSec: DARKEN_SEC,
          onRadius: (r) => {
            for (const h of spawners) {
              if (!h.shielded || _shockwaveHitHives.has(h)) continue;
              const dx = h.pos.x - origin.x;
              const dz = h.pos.z - origin.z;
              const d = Math.sqrt(dx * dx + dz * dz);
              if (r >= d) {
                _shockwaveHitHives.add(h);
                hitBurst(new THREE.Vector3(h.pos.x, 2.5, h.pos.z), 0xffffff, 16);
                const tintNow = CHAPTERS[S.chapter % CHAPTERS.length].full.grid1;
                hitBurst(new THREE.Vector3(h.pos.x, 2.5, h.pos.z), tintNow, 14);
              }
            }
          },
        },
      );
    }
  }
  else if (_phase === 'detonate') {
    // Shared shockwave module handles the ring expansion + hive-shield
    // drop-as-ring-passes via the onRadius callback registered above.
    if (_phaseT >= DARKEN_SEC) {
      _phase = 'recover';
      _phaseT = 0;
      // Safety net: drop every remaining hive shield in case the
      // shockwave missed any (e.g. a hive sitting outside SHOCKWAVE_MAX_R).
      removeHiveShields();
    }
  }
  else if (_phase === 'recover') {
    // Fade lighting back up over LIGHT_RECOVER_SEC.
    const f = Math.min(1, _phaseT / LIGHT_RECOVER_SEC);
    _restoreLighting(f);
    if (_phaseT >= LIGHT_RECOVER_SEC) {
      _fullyRestoreLighting();
      _phase = 'idle';
      _phaseT = 0;
      _active = false;
      _teardown();
      // Hand off to waves.js to finish wave 2.
      if (_onDetonation) {
        try { _onDetonation(); }
        catch (err) { console.warn('[empLaunch] onDetonation threw:', err); }
      }
    }
  }
}

function _teardown() {
  if (_missileMesh && _missileMesh.parent) scene.remove(_missileMesh);
  _missileMesh = null;
  _hideCountdown();
  if (_domOverlay) _domOverlay.style.opacity = '0';
  _shockwaveHitHives = null;
  _exhaustBursts = 0;
  _flightStart = null;
  _flightTarget = null;
}

/** Hard reset for game-over / chapter teardown. */
export function abortLaunch() {
  if (!_active) return;
  _fullyRestoreLighting();
  _teardown();
  _phase = 'idle';
  _phaseT = 0;
  _active = false;
}
