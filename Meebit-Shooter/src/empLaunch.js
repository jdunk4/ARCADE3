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
import { CHAPTERS, getWaveDef } from './config.js';
import { S, shake } from './state.js';
import { UI } from './ui.js';
import { Audio } from './audio.js';
import { hitBurst } from './effects.js';
import { getSiloLaunchOrigin, hideSiloMissile, LAYOUT } from './waveProps.js';
import { spawners } from './spawners.js';
import { removeHiveShields, dropHiveShield } from './dormantProps.js';
import { getCentroidFor } from './triangles.js';
import { fireShockwave } from './shockwave.js';
import { makeEnemy } from './enemies.js';

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
let _detonationFired = false;  // idempotency — don't run the wave-end flow twice
let _megaOre = null;           // landed mega-ore group (spawned at peak)

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
  _detonationFired = false;
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
// MEGA ORE REVEAL
//
// After the missile peaks and vanishes, a "landed" warhead casing is
// planted tip-down at the detonation target. During the countdown the
// casing cracks open around a huge gold ore crystal inside — reinforcing
// the lore that the mining and the EMP launch are the same payoff.
// At detonation the crystal shatters in a big chapter-tinted burst.
//
// All geometry/materials are owned by _megaOre so _teardown() can dispose
// them cleanly whether the detonation played out normally or was aborted.
// ---------------------------------------------------------------------------

function _spawnMegaOre() {
  if (!_flightTarget) return;
  // Remove any lingering ore from a previous launch (e.g. abortLaunch in
  // the middle of a prior countdown).
  _disposeMegaOre();

  const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  const tint = chapter.full.grid1;
  // Gold is the "mega ore" signature color — the rainbow crystal inside
  // the casing matches the wave-1 giant rainbow ore so the lore link
  // ("mining → EMP payoff") is visible.
  const goldColor = 0xffd93d;

  const group = new THREE.Group();
  group.position.set(_flightTarget.x, 0, _flightTarget.z);

  // --- Warhead casing (two half-shells) ---
  const casingMat = new THREE.MeshStandardMaterial({
    color: 0x888888,
    emissive: tint,
    emissiveIntensity: 0.45,
    metalness: 0.85,
    roughness: 0.35,
  });
  const bodyGeo = new THREE.CylinderGeometry(1.4, 1.0, 3.6, 14);
  const body = new THREE.Mesh(bodyGeo, casingMat);
  body.position.y = 1.6;
  group.add(body);
  body.rotation.z = 0.12;
  body.rotation.x = -0.08;

  // --- Blinker lights on the landed warhead body ---
  // Port of the pre-launch silo missile's blinker lights so the landed
  // warhead has the same "beautiful blinking lights" on its casing while
  // the countdown ticks. Each light is a glowing sphere on the body
  // surface; 4 sides x 3 rings for 12 lights total. A per-light material
  // clone lets each one tween its own opacity so the rolling-spiral
  // pattern reads clearly.
  //
  // We parent the lights to `body` so they inherit the casing's tilt +
  // position. Local coords: the body is a cylinder of radius ~1.2 (at
  // mid-height) and height 3.6; rings sit at y = -0.9, 0, +0.9.
  const BLINK_GEO = new THREE.SphereGeometry(0.18, 10, 8);
  const blinkMatBase = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.2,
    toneMapped: false,
  });
  const blinkerLights = [];
  for (let side = 0; side < 4; side++) {
    const angle = side * (Math.PI / 2);
    // Slightly outside the body surface so the spheres sit proud of the
    // casing rather than half-buried.
    const r = 1.22;
    const bx = Math.cos(angle) * r;
    const bz = Math.sin(angle) * r;
    for (let ring = 0; ring < 3; ring++) {
      const perMat = blinkMatBase.clone();
      const light = new THREE.Mesh(BLINK_GEO, perMat);
      // Rings at y = -0.9 (bottom), 0 (mid), +0.9 (top) relative to body center.
      light.position.set(bx, -0.9 + ring * 0.9, bz);
      light.userData.side = side;
      light.userData.ring = ring;
      body.add(light);
      blinkerLights.push(light);
    }
  }
  blinkMatBase.dispose(); // cloned per-light; base template not used directly

  const halfGeo = new THREE.CylinderGeometry(1.42, 1.42, 2.0, 14, 1, false, 0, Math.PI);
  const halfA = new THREE.Mesh(halfGeo, casingMat);
  const halfB = new THREE.Mesh(halfGeo, casingMat);
  const pivotA = new THREE.Group();
  const pivotB = new THREE.Group();
  pivotA.position.set(0, 3.5, 0);
  pivotB.position.set(0, 3.5, 0);
  halfA.position.y = 0;
  halfB.position.y = 0;
  halfB.rotation.y = Math.PI;
  pivotA.add(halfA);
  pivotB.add(halfB);
  group.add(pivotA);
  group.add(pivotB);

  // --- CORE: the mega ore is an ATOM. ---
  // Nucleus: giant rainbow crystal (same shape as wave-1 orbs / depot mega
  // ore, preserving the identity). Electrons: 3 orbital rings of small
  // tint-colored spheres at different tilts, each with its own orbit speed.
  // Floats upward during countdown.
  //
  // atomGroup owns everything that belongs to the atom so it can be lifted
  // as one unit. Starts at the casing tip (y=3.5) and drifts up.
  const atomGroup = new THREE.Group();
  atomGroup.position.y = 3.5;
  group.add(atomGroup);

  // Nucleus — giant rainbow ore compound (6 cones). Scaled up.
  const nucleus = _buildRainbowNucleus();
  nucleus.scale.setScalar(0.01);   // starts tiny, grows as casing opens
  atomGroup.add(nucleus);

  // Electron rings — 3 orbital planes, each a Group so we can tilt + spin.
  // Each ring has 2 electron spheres 180° apart.
  const electrons = [];
  const electronMat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const electronGeo = new THREE.SphereGeometry(0.18, 10, 8);
  const trailMat = new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.35, depthWrite: false,
  });
  const ringTilts = [
    { x: 0,          z: 0         },
    { x: Math.PI/3,  z: Math.PI/4 },
    { x: -Math.PI/4, z: Math.PI/3 },
  ];
  for (let r = 0; r < 3; r++) {
    const ring = new THREE.Group();
    ring.rotation.x = ringTilts[r].x;
    ring.rotation.z = ringTilts[r].z;
    // Orbit radius grows for outer rings.
    const orbR = 1.6 + r * 0.55;
    for (let e = 0; e < 2; e++) {
      const es = new THREE.Mesh(electronGeo, electronMat);
      const a = e * Math.PI;
      es.position.set(Math.cos(a) * orbR, 0, Math.sin(a) * orbR);
      // Orbit trail — small ring geometry that catches the electron path.
      ring.add(es);
    }
    // Static trail ring as a faint glowing orbit path.
    const trailGeo = new THREE.TorusGeometry(orbR, 0.025, 6, 48);
    const trail = new THREE.Mesh(trailGeo, trailMat);
    ring.add(trail);
    atomGroup.add(ring);
    electrons.push({ group: ring, orbR, speedBase: 2.4 - r * 0.4 });
  }

  // Halo sphere around the nucleus — gold glow that fades in.
  const haloGeo = new THREE.SphereGeometry(1.9, 16, 12);
  const haloMat = new THREE.MeshBasicMaterial({
    color: goldColor, transparent: true, opacity: 0.0, depthWrite: false,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  atomGroup.add(halo);

  // --- Crater ring on the ground ---
  const ringGeo = new THREE.RingGeometry(2.2, 2.8, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  group.add(ring);

  scene.add(group);

  _megaOre = {
    obj: group,
    body, bodyGeo, casingMat,
    pivotA, pivotB, halfGeo,
    atomGroup,
    nucleus,
    electrons,
    electronGeo, electronMat, trailMat,
    halo, haloGeo, haloMat,
    ring, ringGeo, ringMat,
    blinkerLights,
    blinkGeo: BLINK_GEO,
    sparkTimer: 0,
    tint,
    goldColor,
    // Atom float state — starts at casing tip (y = 3.5), drifts up to ~8.5
    // over the countdown. Captured separately so the atom can decouple
    // from the (tilted) casing body.
    floatBaseY: 3.5,
    floatMaxY:  8.5,
  };

  // Landing impact burst + screen shake.
  const origin = new THREE.Vector3(_flightTarget.x, 0.3, _flightTarget.z);
  hitBurst(origin, 0xffffff, 20);
  hitBurst(origin, 0xffaa00, 18);
  hitBurst(origin, tint, 14);
  shake(0.4, 0.3);
}

// Rainbow nucleus — same compound-of-6-cones logic as the in-game ore. We
// inline it here so empLaunch doesn't have to import from ores.js (risk of
// circular imports). Uses cached geometry; materials are per-color.
const _NUCLEUS_CONE_GEO = new THREE.ConeGeometry(0.65, 1.6, 5);
const _NUCLEUS_COLORS = [
  0xff6a1a, 0xff2e4d, 0xffd93d, 0x00ff66, 0x4ff7ff, 0xe63aff,
];
const _nucleusMatCache = new Map();
function _getNucleusMat(c) {
  let m = _nucleusMatCache.get(c);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: c, emissive: c, emissiveIntensity: 1.4,
      metalness: 0.3, roughness: 0.2,
    });
    _nucleusMatCache.set(c, m);
  }
  return m;
}
function _buildRainbowNucleus() {
  const g = new THREE.Group();
  for (let i = 0; i < _NUCLEUS_COLORS.length; i++) {
    const cone = new THREE.Mesh(_NUCLEUS_CONE_GEO, _getNucleusMat(_NUCLEUS_COLORS[i]));
    const phi = (i / _NUCLEUS_COLORS.length) * Math.PI * 2;
    const theta = (i % 2 === 0) ? Math.PI / 3 : 2 * Math.PI / 3;
    const dirX = Math.sin(theta) * Math.cos(phi);
    const dirY = Math.cos(theta);
    const dirZ = Math.sin(theta) * Math.sin(phi);
    const dir = new THREE.Vector3(dirX, dirY, dirZ);
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    cone.quaternion.copy(quat);
    cone.position.set(dirX * 0.4, dirY * 0.4, dirZ * 0.4);
    g.add(cone);
  }
  return g;
}

function _tickMegaOre(dt, frac, time) {
  if (!_megaOre) return;
  const m = _megaOre;

  // Casing halves crack open — rotate outward from 0 to ~95° over the
  // first 50% of the countdown. Past 50% they sit open.
  const openFrac = Math.min(1, frac / 0.5);
  const openAngle = openFrac * (Math.PI * 0.52);  // ~95°
  if (m.pivotA) m.pivotA.rotation.x = -openAngle;
  if (m.pivotB) m.pivotB.rotation.x =  openAngle;

  // Atom floats upward slowly over the countdown (atom about to split).
  // Ease-out so it surges up at first and settles near the top.
  const riseE = 1 - (1 - frac) * (1 - frac);
  if (m.atomGroup) {
    m.atomGroup.position.y = m.floatBaseY + (m.floatMaxY - m.floatBaseY) * riseE;
  }

  // Nucleus grows from tiny to full scale in first 60%.
  const growFrac = Math.min(1, frac / 0.6);
  const targetScale = 0.01 + growFrac * 1.1;
  const cur = m.nucleus.scale.x;
  const next = cur + (targetScale - cur) * Math.min(1, dt * 3);
  m.nucleus.scale.setScalar(next);

  // Nucleus rotation — spins on its own axis. Much faster near the end
  // (critical mass).
  const criticalKick = frac > 0.8 ? (frac - 0.8) * 5 : 0;   // extra speed in last 20%
  const nucSpin = 1.2 + frac * 2.5 + criticalKick * 4;
  m.nucleus.rotation.y += dt * nucSpin;
  m.nucleus.rotation.x += dt * nucSpin * 0.6;

  // Electron rings — each ring spins on its own plane. Speed ramps with
  // frac; in the final 20% they go chaotic (eccentric wobble added).
  for (let i = 0; i < m.electrons.length; i++) {
    const e = m.electrons[i];
    // Rotate the group around its local Y (perpendicular to the orbit plane).
    const spin = e.speedBase * (0.8 + frac * 3.5) + criticalKick * 6;
    e.group.rotation.y += dt * spin;
    // Chaotic wobble in the final 20% — precess the tilt.
    if (frac > 0.8) {
      const wob = (frac - 0.8) * 2;
      e.group.rotation.x += Math.sin(time * 5 + i) * dt * wob;
      e.group.rotation.z += Math.cos(time * 5 + i * 1.3) * dt * wob;
    }
  }

  // Halo fades in with nucleus growth, pulses throughout.
  if (m.haloMat) {
    const pulse = 0.5 + 0.5 * Math.sin(time * (3 + frac * 8));
    m.haloMat.opacity = growFrac * 0.4 + pulse * 0.15 + criticalKick * 0.1;
  }

  // Crater ring heartbeat.
  if (m.ringMat) {
    const hb = 0.5 + 0.5 * Math.sin(time * (1.5 + frac * 4) * Math.PI * 2);
    m.ringMat.opacity = 0.3 + frac * 0.4 + hb * 0.2;
  }

  // --- Blinker lights on the casing body ---
  // Same rolling-spiral pattern as the silo missile blinkers (see
  // waveProps.js:606), but with a speed ramp so the blinks get more
  // frantic as detonation approaches. frac = 0 → 4.5 rad/s (matches
  // pre-launch); frac = 1 → ~12 rad/s (strobe-urgency).
  if (m.blinkerLights && m.blinkerLights.length) {
    const phaseSpeed = 4.5 + frac * 7.5;
    const phase = time * phaseSpeed;
    // In the last 15%, flip the "off" pixels to a dimmer red glow so
    // the whole casing looks like it's about to explode.
    const critical = frac > 0.85;
    for (let i = 0; i < m.blinkerLights.length; i++) {
      const light = m.blinkerLights[i];
      const side = light.userData.side || 0;   // 0..3
      const ring = light.userData.ring || 0;   // 0..2
      const local = Math.sin(phase - side * (Math.PI / 2) - ring * 0.6);
      light.material.opacity = local > 0.2 ? 1.0 : (critical ? 0.35 : 0.12);
      if (critical) {
        // Lerp the color toward a hot red-orange during the final
        // seconds so the read is "imminent detonation".
        light.material.color.setHex(0xff3a1a);
      }
    }
  }

  // Ambient sparks — drip some gold/tint sparks UP from the atom at an
  // accelerating rate. When critical (>80%), they also burst OUT from the
  // orbital rings to sell the "splitting" moment.
  m.sparkTimer -= dt;
  if (m.sparkTimer <= 0) {
    m.sparkTimer = 0.35 - frac * 0.3;
    const atomX = m.obj.position.x;
    const atomZ = m.obj.position.z;
    const atomY = (m.atomGroup ? m.atomGroup.position.y : 3.5);
    // Rising spark above the atom.
    hitBurst(new THREE.Vector3(
      atomX + (Math.random() - 0.5) * 0.8,
      atomY + 0.5 + Math.random() * 0.6,
      atomZ + (Math.random() - 0.5) * 0.8,
    ), m.goldColor, 2);
    // Orbital spark in critical phase — shoot out sideways from the
    // rings like a split-nucleus particle.
    if (frac > 0.8 && Math.random() < 0.6) {
      const a = Math.random() * Math.PI * 2;
      const r = 2.2;
      hitBurst(new THREE.Vector3(
        atomX + Math.cos(a) * r,
        atomY + (Math.random() - 0.5) * 1.5,
        atomZ + Math.sin(a) * r,
      ), m.tint, 3);
    }
  }
}

function _detonateMegaOre() {
  if (!_megaOre) return;
  const m = _megaOre;
  const atomY = m.atomGroup ? m.atomGroup.position.y : 3.5;
  const origin = new THREE.Vector3(m.obj.position.x, atomY, m.obj.position.z);

  // SUPERNOVA central burst — big multi-stage pop.
  hitBurst(origin, 0xffffff, 50);
  hitBurst(origin, m.goldColor, 44);
  setTimeout(() => hitBurst(origin, m.goldColor, 30), 50);
  setTimeout(() => hitBurst(origin, m.tint,       26), 120);
  setTimeout(() => hitBurst(origin, 0xffffff,     18), 210);
  shake(1.1, 0.7);

  // Fire the fragment projectiles — 6 crystal fragments in a 60° spread
  // around the atom, each shooting outward across the arena. They hit
  // the far walls after ~1.2s and secondary-burst on impact.
  _spawnSplitFragments(origin, m);

  // Immediately remove the atom group (casing halves stay briefly for
  // the "empty shell" read — they'll be disposed by _teardown at recover).
  if (m.atomGroup && m.atomGroup.parent) {
    m.atomGroup.parent.remove(m.atomGroup);
  }
  // Keep the crater ring + casing body visible for the fade; they dispose
  // in _disposeMegaOre / _teardown when the phase finishes.
  m.atomGroup = null;
  m.nucleus = null;
  m.electrons = null;
  m.halo = null;

  // Half-dispose — nuke only the atom parts. Casing/body stay for the
  // remaining detonate/recover phases, then _teardown cleans the rest.
}

// --- Split fragment system ---
// After atom detonation, 6 crystal fragments shoot outward in a 360°
// spread at slight upward angle, trail bright particles, fly ~25 units,
// then burst on impact. Each fragment carries its own state — ticked
// in _tickFragments called from updateLaunch's detonate/recover phases.
const _fragments = [];

function _spawnSplitFragments(origin, m) {
  const FRAGMENT_COUNT = 6;
  const FRAGMENT_SPEED = 22;    // units/sec
  const FRAGMENT_LIFE = 1.4;    // seconds before auto-burst
  const fragGeo = new THREE.OctahedronGeometry(0.6, 0);
  const fragMat = new THREE.MeshStandardMaterial({
    color: m.goldColor,
    emissive: m.goldColor,
    emissiveIntensity: 3.0,
    metalness: 0.3,
    roughness: 0.3,
  });
  // Shared geo/mat across this batch — disposed once when the last
  // fragment finishes in _tickFragments.
  _fragmentsShared = { fragGeo, fragMat };
  for (let i = 0; i < FRAGMENT_COUNT; i++) {
    const a = (i / FRAGMENT_COUNT) * Math.PI * 2 + Math.random() * 0.2;
    const mesh = new THREE.Mesh(fragGeo, fragMat);
    mesh.position.copy(origin);
    scene.add(mesh);
    _fragments.push({
      mesh,
      vel: new THREE.Vector3(
        Math.cos(a) * FRAGMENT_SPEED,
        2 + Math.random() * 3,
        Math.sin(a) * FRAGMENT_SPEED,
      ),
      life: FRAGMENT_LIFE,
      tint: m.tint,
      color: m.goldColor,
    });
  }
}

function _tickFragments(dt) {
  if (_fragments.length === 0) return;
  for (let i = _fragments.length - 1; i >= 0; i--) {
    const f = _fragments[i];
    f.mesh.position.addScaledVector(f.vel, dt);
    // Gravity pulls them down a bit so they arc rather than laser-straight.
    f.vel.y -= 9 * dt;
    // Tumble.
    f.mesh.rotation.x += dt * 8;
    f.mesh.rotation.y += dt * 6;
    f.mesh.rotation.z += dt * 5;
    // Trail particles.
    hitBurst(f.mesh.position, f.color, 2);
    if (Math.random() < 0.3) hitBurst(f.mesh.position, f.tint, 1);

    f.life -= dt;
    const outOfBounds =
      Math.abs(f.mesh.position.x) > 55 ||
      Math.abs(f.mesh.position.z) > 55 ||
      f.mesh.position.y < 0.1;
    if (f.life <= 0 || outOfBounds) {
      // Impact burst.
      const p = f.mesh.position.clone();
      p.y = Math.max(p.y, 0.4);
      hitBurst(p, 0xffffff, 16);
      hitBurst(p, f.color, 14);
      hitBurst(p, f.tint, 10);
      if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
      _fragments.splice(i, 1);
    }
  }
  // Dispose shared geo/mat when last fragment clears.
  if (_fragments.length === 0 && _fragmentsShared) {
    _fragmentsShared.fragGeo.dispose();
    _fragmentsShared.fragMat.dispose();
    _fragmentsShared = null;
  }
}

let _fragmentsShared = null;

function _disposeMegaOre() {
  if (!_megaOre) return;
  const m = _megaOre;
  if (m.obj && m.obj.parent) scene.remove(m.obj);
  if (m.bodyGeo) m.bodyGeo.dispose();
  if (m.halfGeo) m.halfGeo.dispose();
  if (m.haloGeo) m.haloGeo.dispose();
  if (m.ringGeo) m.ringGeo.dispose();
  if (m.casingMat) m.casingMat.dispose();
  if (m.haloMat) m.haloMat.dispose();
  if (m.ringMat) m.ringMat.dispose();
  // Blinker lights — each light has its own cloned material, plus a
  // shared geometry owned by this launch. Dispose both so we don't leak
  // 12 materials per missile across a long session.
  if (m.blinkerLights && m.blinkerLights.length) {
    for (const light of m.blinkerLights) {
      if (light.material && light.material.dispose) light.material.dispose();
    }
  }
  if (m.blinkGeo) m.blinkGeo.dispose();
  // Atom parts — owned materials/geos we created per-launch.
  if (m.electronGeo) m.electronGeo.dispose();
  if (m.electronMat) m.electronMat.dispose();
  if (m.trailMat) m.trailMat.dispose();
  // Electrons' trail ring TorusGeometries are disposed via the parent
  // scene.remove + their own geometry references. We created them inline
  // in _spawnMegaOre — walk the atomGroup (if still present) to dispose.
  if (m.atomGroup) {
    m.atomGroup.traverse((o) => {
      if (o.geometry && o.geometry !== m.electronGeo) {
        // Torus trails and any other per-launch geos — dispose. Skip the
        // shared nucleus cone geometry (cached across launches).
        const g = o.geometry;
        if (g.type === 'TorusGeometry') g.dispose();
      }
    });
  }
  // Nucleus cone geometry + rainbow materials are cached (see
  // _NUCLEUS_CONE_GEO / _nucleusMatCache) — do NOT dispose.
  _megaOre = null;
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
      UI.toast('HOLD THE LINE — EMP DETONATES IN ' + Math.ceil(COUNTDOWN_SEC) + ' SECONDS', '#4ff7ff', 3000);
      // Spawn the "landed missile → mega ore" reveal at the detonation
      // target. The casing animates open during the countdown and the
      // mega ore pulses brighter every second.
      _spawnMegaOre();
    }
  }
  else if (_phase === 'countdown') {
    const left = Math.max(0, COUNTDOWN_SEC - _phaseT);
    _setCountdownText(left);
    // Countdown progress 0..1 — drives mega-ore animation (casing opens,
    // crystal pulses harder, emissive ramps up).
    const frac = Math.min(1, _phaseT / COUNTDOWN_SEC);
    _tickMegaOre(dt, frac, time);
    if (_phaseT >= COUNTDOWN_SEC) {
      _phase = 'detonate';
      _phaseT = 0;
      _hideCountdown();
      _showDetonationFlash();
      _darkenArena();
      shake(1.2, 0.8);
      try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
      // Shockwave originates from the hive-triangle centroid — where
      // the missile detonated. The ring is purely cosmetic now; the
      // shield cascade below drives the actual "shockwave-is-passing"
      // telegraph via timed delays matched to hive distance.
      const origin = _flightTarget || { x: 0, y: 0.2, z: 0 };
      fireShockwave(
        { x: origin.x, y: 0.2, z: origin.z },
        { maxRadius: SHOCKWAVE_MAX_R, durationSec: DARKEN_SEC },
      );

      // SHIELD CASCADE — drop every hive shield with a delay proportional
      // to its distance from the explosion origin. The old approach used
      // fireShockwave's onRadius callback + a distance check per frame,
      // but (a) if a hive sat outside SHOCKWAVE_MAX_R the callback never
      // reached it and (b) the safety-net removeHiveShields() at the end
      // of DARKEN_SEC then caught everything simultaneously, producing
      // the "all shields drop at once after the shockwave" look the
      // player reported.
      //
      // Instead: compute each hive's distance NOW and schedule its drop
      // with a delay that mirrors the shockwave's visual arrival time.
      // Shockwave expands from r=0 to r=SHOCKWAVE_MAX_R over DARKEN_SEC,
      // so arrival time for a hive at distance d = (d / SHOCKWAVE_MAX_R)
      // * DARKEN_SEC, capped at DARKEN_SEC for hives outside the ring.
      // Nearest hive drops almost immediately; farthest hive drops right
      // as the ring would have reached it. Reliable regardless of
      // triangle geometry.
      const tintNow = CHAPTERS[S.chapter % CHAPTERS.length].full.grid1;
      for (const h of spawners) {
        if (!h.shielded || _shockwaveHitHives.has(h)) continue;
        const dx = h.pos.x - origin.x;
        const dz = h.pos.z - origin.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const delaySec = Math.min(DARKEN_SEC, (d / SHOCKWAVE_MAX_R) * DARKEN_SEC);
        _shockwaveHitHives.add(h);
        // Schedule the shield to drop after `delaySec`. dormantProps
        // handles the pending-timer → flash-up → burst → collapse
        // animation internally — empLaunch just fires the schedule.
        dropHiveShield(h, delaySec);
        // Queue the per-hive particle burst + starter population for
        // the same moment the shield starts dropping. setTimeout fires
        // on the main thread; 4-6 timers across 0..1.2s is fine.
        setTimeout(() => {
          if (h.destroyed) return;
          hitBurst(new THREE.Vector3(h.pos.x, 2.5, h.pos.z), 0xffffff, 16);
          hitBurst(new THREE.Vector3(h.pos.x, 2.5, h.pos.z), tintNow, 14);
          _spawnStarterPopulation(h, tintNow);
        }, delaySec * 1000);
      }

      // Mega ore pop — the big pulsing crystal erupts and scatters chunks.
      _detonateMegaOre();

      // Fire the detonation handler (wave-end work) AT THE EXPLOSION,
      // not after lighting recovery. The user wants the next-wave
      // countdown to kick in immediately on explosion. The recover
      // phase (lighting fade-back) still runs for visual continuity but
      // the wave-end flow no longer waits on it.
      if (_onDetonation && !_detonationFired) {
        _detonationFired = true;
        try { _onDetonation(); }
        catch (err) { console.warn('[empLaunch] onDetonation threw:', err); }
      }
    }
  }
  else if (_phase === 'detonate') {
    // Shared shockwave module handles the ring expansion + hive-shield
    // drop-as-ring-passes via the onRadius callback registered above.
    // Also tick any split-fragment projectiles flying out from the atom.
    _tickFragments(dt);
    if (_phaseT >= DARKEN_SEC) {
      _phase = 'recover';
      _phaseT = 0;
      // Safety net: drop every remaining hive shield in case the
      // shockwave missed any (e.g. a hive sitting outside SHOCKWAVE_MAX_R).
      removeHiveShields();
    }
  }
  else if (_phase === 'recover') {
    // Fade lighting back up over LIGHT_RECOVER_SEC. No more onDetonation
    // fire here — it already fired on explosion entry.
    _tickFragments(dt);   // finish any still-flying fragments
    const f = Math.min(1, _phaseT / LIGHT_RECOVER_SEC);
    _restoreLighting(f);
    if (_phaseT >= LIGHT_RECOVER_SEC) {
      _fullyRestoreLighting();
      _phase = 'idle';
      _phaseT = 0;
      _active = false;
      _teardown();
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
  // Mega ore cleanup — normally already disposed by _detonateMegaOre, but
  // idempotent _disposeMegaOre handles the abort-mid-countdown case.
  _disposeMegaOre();
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

/**
 * Defensive cleanup called at the END of the wave-2→wave-3 countdown,
 * right before startWave(3) fires. Hard-removes every mesh that
 * empLaunch/the missile cinematic spawned and could still be visible in
 * the scene.
 *
 * Why this exists: the normal lifecycle has _teardown() run at the end
 * of the recover phase (3.2s after detonation). The wave 3 countdown is
 * ~3.6s — cutting it close — and some meshes (mega-ore casing halves,
 * flight missile, casing body) render until _teardown fires. On a slow
 * frame, paused tab, or any timing edge case, those meshes can persist
 * into wave 3 start and read as "wave 2 pieces still on the arena."
 *
 * forceClearEmpResidue() is idempotent — safe to call at any time,
 * including when the launch state is already idle. Walks every tracked
 * mesh and removes it from the scene, then resets all state.
 */
export function forceClearEmpResidue() {
  // Flight missile (the one that flies from silo to hive centroid).
  if (_missileMesh && _missileMesh.parent) scene.remove(_missileMesh);
  _missileMesh = null;
  // Mega-ore warhead casing, halves, atom parts, blinker lights, crater ring.
  _disposeMegaOre();
  // Split fragments (if any are still flying).
  for (const f of _fragments) {
    if (f.mesh && f.mesh.parent) f.mesh.parent.remove(f.mesh);
  }
  _fragments.length = 0;
  if (_fragmentsShared) {
    _fragmentsShared.fragGeo.dispose();
    _fragmentsShared.fragMat.dispose();
    _fragmentsShared = null;
  }
  // DOM overlay (detonation flash / darken layer).
  if (_domOverlay) _domOverlay.style.opacity = '0';
  _hideCountdown();
  _fullyRestoreLighting();
  // Reset state so a future launch starts clean.
  _shockwaveHitHives = null;
  _exhaustBursts = 0;
  _flightStart = null;
  _flightTarget = null;
  _detonationFired = false;
  _phase = 'idle';
  _phaseT = 0;
  _active = false;
}

// ----------------------------------------------------------------------------
// STARTER POPULATION
// ----------------------------------------------------------------------------
/**
 * Spawn 2-3 enemies around a single hive as its shield drops during the
 * missile detonation. Gives wave 3 a visible starting population so the
 * arena doesn't feel empty while hives ramp their emission cadence.
 *
 * Enemy types are picked from the upcoming (wave 3) mix so the starter
 * set matches what the hive would emit naturally. Falls back to a
 * 70/30 zomeeb/sprinter mix if no mix is defined.
 *
 * Each enemy lands on a small ring around the hive (2-3 units out) and
 * gets a small burst FX so it reads as "emerging from the hive."
 */
function _spawnStarterPopulation(hive, tint) {
  if (!hive || hive.destroyed) return;

  // Probe the upcoming wave def (wave 3 — the hive wave we're unlocking)
  // for its enemy mix. This runs mid-detonation so S.wave is still the
  // powerup wave (wave 2 of the chapter); wave+1 gets us the hive wave.
  let mix = null;
  try {
    const nextDef = getWaveDef(S.wave + 1);
    if (nextDef && nextDef.enemies) mix = nextDef.enemies;
  } catch (e) { /* fall through to default */ }
  if (!mix) mix = { zomeeb: 0.7, sprinter: 0.3 };

  const count = 2 + ((Math.random() < 0.5) ? 0 : 1); // 2 or 3
  for (let i = 0; i < count; i++) {
    // Ring placement so the enemies fan out around the hive rather than
    // piling on top of it.
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const r = 2.2 + Math.random() * 1.2;
    const x = hive.pos.x + Math.cos(a) * r;
    const z = hive.pos.z + Math.sin(a) * r;

    // Pick a type from the weighted mix
    let total = 0;
    for (const v of Object.values(mix)) total += v;
    let roll = Math.random() * total;
    let type = 'zomeeb';
    for (const [k, v] of Object.entries(mix)) {
      if (roll < v) { type = k; break; }
      roll -= v;
    }

    try {
      const e = makeEnemy(type, tint, new THREE.Vector3(x, 0, z));
      if (e) {
        e.fromPortal = hive;
        if (typeof hive.enemiesAlive === 'number') hive.enemiesAlive++;
      }
    } catch (err) {
      // Silently skip — makeEnemy failure shouldn't abort the shockwave
      // visual.
    }
    // Small emergence burst
    hitBurst(new THREE.Vector3(x, 0.8, z), tint, 6);
    hitBurst(new THREE.Vector3(x, 0.8, z), 0xffffff, 3);
  }
}
