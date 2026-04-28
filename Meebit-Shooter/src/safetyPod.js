// safetyPod.js — Chapter 2 wave 2 protective zone. The player must
// stand inside this pod when the laser fires or take massive damage.
// Pod is hidden at wave start, revealed during the laser-telegraph
// phase (player has 3s to run to it before the laser fires).
//
// Visual:
//   - Flat circular base disc on the floor (chapter-tinted glow)
//   - Transparent dome cap (shield-style sphere half)
//   - Inner glow ring + outer warning ring
//   - Bright pulsing "beacon" sphere atop the dome
//
// Public API:
//   spawnSafetyPod(chapterIdx, x, z)
//   setVisible(v)             // initial state is hidden
//   setLaserActive(v)         // bumps glow intensity during laser
//   isPlayerInPod(playerPos)  // proximity test
//   getPodPos()
//   getPodRadius()
//   updateSafetyPod(dt)
//   clearSafetyPod()
//   hasSafetyPod()

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';

// ---- Tunables ----
// User spec: "pretty big but not too big. Enough for 5 players."
// Player ~0.4u radius. 5 players in a circle = ~2u radius cluster.
// Pod radius 3.5u gives a clear safe zone with margin.
const POD_RADIUS = 3.5;

// ---- Geometry ----
const BASE_GEO  = new THREE.CircleGeometry(POD_RADIUS, 32);
// Dome: radius 1.2x the base disc so the hemisphere flares OUT past
// the safe-zone footprint, reading as a bubble rather than a flat
// disc. Player feedback wanted a bigger, more visible dome on all
// pods (chapter 2 wave 2 + GLACIER_WRAITH freeze).
const DOME_GEO  = new THREE.SphereGeometry(POD_RADIUS * 1.2, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
const RING_GEO  = new THREE.RingGeometry(POD_RADIUS - 0.15, POD_RADIUS, 48);
const OUTER_RING_GEO = new THREE.RingGeometry(POD_RADIUS + 0.6, POD_RADIUS + 0.85, 48);
const BEACON_GEO = new THREE.SphereGeometry(0.35, 12, 10);

// ---- Materials ----
function _baseMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.45,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
function _domeMat(tint) {
  // Bumped opacity 0.30 → 0.50 so the dome reads more solidly. User
  // feedback: "make the top not quite so transparent." Emissive
  // intensity unchanged so the inner glow is preserved.
  return new THREE.MeshStandardMaterial({
    color: tint, transparent: true, opacity: 0.50,
    emissive: tint, emissiveIntensity: 0.7,
    roughness: 0.4, metalness: 0.1,
    side: THREE.DoubleSide, depthWrite: false,
  });
}
function _ringMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
function _outerRingMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
function _beaconMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, toneMapped: false,
  });
}
// Thruster — bright additive cone pointing downward from pod underside
function _thrusterMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}
const THRUSTER_GEO = new THREE.ConeGeometry(0.7, 3.0, 12);

const POD_SPAWN_Y = 40;          // pod starts in the sky
const DESCENT_DURATION = 10.0;   // fly-down time
const OPEN_DURATION = 5.0;       // dome-open animation

// ---- Module state ----
let _pod = null;

/** Build the pod at world (x, z). Pod is created but hidden + parked
 *  in the sky. Call triggerPodDescent() to start the fly-down. */
export function spawnSafetyPod(chapterIdx, x, z) {
  if (_pod) clearSafetyPod();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  const group = new THREE.Group();
  group.position.set(x, POD_SPAWN_Y, z);

  const baseMat = _baseMat(tint);
  const base = new THREE.Mesh(BASE_GEO, baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.06;
  group.add(base);

  const ringMat = _ringMat(tint);
  const ring = new THREE.Mesh(RING_GEO, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.07;
  group.add(ring);

  const outerRingMat = _outerRingMat(tint);
  const outerRing = new THREE.Mesh(OUTER_RING_GEO, outerRingMat);
  outerRing.rotation.x = -Math.PI / 2;
  outerRing.position.y = 0.08;
  group.add(outerRing);

  const domeMat = _domeMat(tint);
  const dome = new THREE.Mesh(DOME_GEO, domeMat);
  dome.position.y = 0.1;
  group.add(dome);

  const beaconMat = _beaconMat(tint);
  const beacon = new THREE.Mesh(BEACON_GEO, beaconMat);
  beacon.position.y = POD_RADIUS + 0.1;
  group.add(beacon);

  // Thruster cones beneath the pod — 4 thrusters pointing down
  const thrusterMat = _thrusterMat(tint);
  const thrusters = [];
  const thrusterPositions = [
    { x:  POD_RADIUS * 0.7, z:  POD_RADIUS * 0.7 },
    { x: -POD_RADIUS * 0.7, z:  POD_RADIUS * 0.7 },
    { x:  POD_RADIUS * 0.7, z: -POD_RADIUS * 0.7 },
    { x: -POD_RADIUS * 0.7, z: -POD_RADIUS * 0.7 },
  ];
  for (const tp of thrusterPositions) {
    const th = new THREE.Mesh(THRUSTER_GEO, thrusterMat);
    th.position.set(tp.x, -1.5, tp.z);
    th.rotation.x = Math.PI;            // cone tip points down
    group.add(th);
    thrusters.push(th);
  }

  group.visible = false;            // hidden until triggerPodDescent
  scene.add(group);

  _pod = {
    group, base, baseMat, dome, domeMat, ring, ringMat,
    outerRing, outerRingMat, beacon, beaconMat,
    thrusters, thrusterMat,
    tint, x, z,
    visible: false, laserActive: false,
    pulseT: 0,
    phase: 'parked',                // 'parked' | 'descending' | 'landed' | 'open'
    phaseT: 0,
    domeOpacity: 0.30,              // sealed
  };
  return _pod;
}

export function setVisible(v) {
  if (!_pod) return;
  _pod.visible = !!v;
  _pod.group.visible = !!v;
}

/** Start the fly-down. Pod becomes visible + falls from sky to ground
 *  over DESCENT_DURATION (10s). Thrusters animate at full blast. */
export function triggerPodDescent() {
  if (!_pod) return;
  if (_pod.phase !== 'parked') return;
  _pod.phase = 'descending';
  _pod.phaseT = 0;
  _pod.visible = true;
  _pod.group.visible = true;
  _pod.group.position.y = POD_SPAWN_Y;
}

/** Open the dome — player can now enter. Triggered last 5s of telegraph
 *  per spec. The dome opacity drops + base ring brightens for visual
 *  "the door is open" feedback. */
export function triggerPodOpen() {
  if (!_pod) return;
  if (_pod.phase === 'open') return;
  _pod.phase = 'open';
  _pod.phaseT = 0;
}

/** Returns the pod's current phase ('parked' | 'descending' | 'landed' | 'open'). */
export function getPodPhase() {
  return _pod ? _pod.phase : 'parked';
}

/** When laser is active, pump the brightness up dramatically so the
 *  pod reads as a "shielded safe zone" amid the lethal red beam. */
export function setLaserActive(v) {
  if (!_pod) return;
  _pod.laserActive = !!v;
}

/** True if playerPos is inside the pod's protected radius AND pod is
 *  open. Player can't shelter in a closed/descending pod. */
export function isPlayerInPod(playerPos) {
  if (!_pod || !_pod.visible || !playerPos) return false;
  if (_pod.phase !== 'open') return false;
  const dx = playerPos.x - _pod.x;
  const dz = playerPos.z - _pod.z;
  return dx * dx + dz * dz < POD_RADIUS * POD_RADIUS;
}

export function getPodPos() {
  if (!_pod) return null;
  return { x: _pod.x, z: _pod.z };
}

export function getPodRadius() {
  return POD_RADIUS;
}

/** Returns enemy-only collision circles for the pod. Active during
 *  open phase + landed phase so enemies can't enter while player is
 *  trying to shelter. Returns empty when pod not built or in
 *  parked/descending phase (pod isn't down yet so no shield needed). */
export function getPodCollisionCircles() {
  if (!_pod) return [];
  if (_pod.phase !== 'open' && _pod.phase !== 'landed') return [];
  return [{
    x: _pod.x,
    z: _pod.z,
    r: POD_RADIUS,
  }];
}

export function hasSafetyPod() {
  return !!_pod;
}

/** Per-frame update — pulse brightness, animate beacon, drive descent + open phases. */
export function updateSafetyPod(dt) {
  if (!_pod || !_pod.visible) return;
  _pod.pulseT += dt;
  _pod.phaseT += dt;
  const pulse = 0.5 + 0.5 * Math.sin(_pod.pulseT * 3.5);

  // --- DESCENT phase: pod falls from sky over 10s ---
  if (_pod.phase === 'descending') {
    const f = Math.min(1, _pod.phaseT / DESCENT_DURATION);
    // Ease-out cubic: faster at start, slower at landing
    const eased = 1 - Math.pow(1 - f, 3);
    _pod.group.position.y = POD_SPAWN_Y * (1 - eased);
    // Thrusters max-bright, scale pumping
    if (_pod.thrusterMat) {
      _pod.thrusterMat.opacity = 0.85 + Math.sin(_pod.phaseT * 18) * 0.12;
    }
    for (const th of _pod.thrusters) {
      const flicker = 1.0 + Math.sin(_pod.phaseT * 22 + th.position.x) * 0.30;
      th.scale.set(flicker, flicker, flicker);
    }
    // Land — transition to landed (closed)
    if (f >= 1) {
      _pod.phase = 'landed';
      _pod.phaseT = 0;
      _pod.group.position.y = 0;
    }
  }
  // --- LANDED phase: thrusters fade, pod sits closed (player can't enter yet) ---
  else if (_pod.phase === 'landed') {
    if (_pod.thrusterMat) {
      // Fade thrusters out over 1s
      _pod.thrusterMat.opacity = Math.max(0, 0.85 - _pod.phaseT * 0.85);
    }
  }
  // --- OPEN phase: dome opens over 5s. Door is now in service. ---
  else if (_pod.phase === 'open') {
    // Hide thrusters
    if (_pod.thrusterMat) _pod.thrusterMat.opacity = 0;
    // Dome opacity drops 0.30 → 0.05 — visual "door open"
    const f = Math.min(1, _pod.phaseT / OPEN_DURATION);
    _pod.domeOpacity = 0.30 - f * 0.25;
    // Base + ring brighten
  }

  // Boost levels when laser is active (the pod is the "anchor" the player
  // can spot from anywhere in the arena even through the red haze)
  const boost = _pod.laserActive ? 1.6 : 1.0;
  // Phase-aware brightness boost: pod really needs to pop during open
  const phaseBoost = _pod.phase === 'open' ? 1.8 : 1.0;
  if (_pod.baseMat) _pod.baseMat.opacity = (0.40 + pulse * 0.20) * boost * phaseBoost;
  if (_pod.ringMat) _pod.ringMat.opacity = (0.75 + pulse * 0.20) * boost * phaseBoost;
  if (_pod.outerRingMat) _pod.outerRingMat.opacity = (0.40 + pulse * 0.30) * boost * phaseBoost;
  if (_pod.domeMat) {
    // During open phase: use the lerping domeOpacity. Otherwise: pulse with base.
    if (_pod.phase === 'open') {
      _pod.domeMat.opacity = _pod.domeOpacity;
    } else {
      _pod.domeMat.opacity = (0.25 + pulse * 0.20) * boost;
    }
    _pod.domeMat.emissiveIntensity = (0.6 + pulse * 0.5) * boost;
  }
  // Beacon scales with pulse too
  const beaconScale = 1.0 + pulse * 0.4 * boost;
  _pod.beacon.scale.setScalar(beaconScale);
}

export function clearSafetyPod() {
  if (!_pod) return;
  if (_pod.group && _pod.group.parent) scene.remove(_pod.group);
  for (const m of [_pod.baseMat, _pod.domeMat, _pod.ringMat, _pod.outerRingMat, _pod.beaconMat, _pod.thrusterMat]) {
    if (m && m.dispose) m.dispose();
  }
  _pod = null;
}
