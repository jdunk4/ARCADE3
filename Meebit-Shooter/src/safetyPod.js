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
const DOME_GEO  = new THREE.SphereGeometry(POD_RADIUS, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
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
  return new THREE.MeshStandardMaterial({
    color: tint, transparent: true, opacity: 0.30,
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

// ---- Module state ----
let _pod = null;

/** Build the pod at world (x, z). Initially hidden — call setVisible(true)
 *  to reveal during laser telegraph. */
export function spawnSafetyPod(chapterIdx, x, z) {
  if (_pod) clearSafetyPod();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  const group = new THREE.Group();
  group.position.set(x, 0, z);

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

  group.visible = false;            // hidden until setVisible(true)
  scene.add(group);

  _pod = {
    group, base, baseMat, dome, domeMat, ring, ringMat,
    outerRing, outerRingMat, beacon, beaconMat,
    tint, x, z,
    visible: false, laserActive: false,
    pulseT: 0,
  };
  return _pod;
}

export function setVisible(v) {
  if (!_pod) return;
  _pod.visible = !!v;
  _pod.group.visible = !!v;
}

/** When laser is active, pump the brightness up dramatically so the
 *  pod reads as a "shielded safe zone" amid the lethal red beam. */
export function setLaserActive(v) {
  if (!_pod) return;
  _pod.laserActive = !!v;
}

/** True if playerPos is inside the pod's protected radius. */
export function isPlayerInPod(playerPos) {
  if (!_pod || !_pod.visible || !playerPos) return false;
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

export function hasSafetyPod() {
  return !!_pod;
}

/** Per-frame update — pulse brightness, animate beacon. */
export function updateSafetyPod(dt) {
  if (!_pod || !_pod.visible) return;
  _pod.pulseT += dt;
  const pulse = 0.5 + 0.5 * Math.sin(_pod.pulseT * 3.5);
  // Boost levels when laser is active (the pod is the "anchor" the player
  // can spot from anywhere in the arena even through the red haze)
  const boost = _pod.laserActive ? 1.6 : 1.0;
  if (_pod.baseMat) _pod.baseMat.opacity = (0.40 + pulse * 0.20) * boost;
  if (_pod.ringMat) _pod.ringMat.opacity = (0.75 + pulse * 0.20) * boost;
  if (_pod.outerRingMat) _pod.outerRingMat.opacity = (0.40 + pulse * 0.30) * boost;
  if (_pod.domeMat) {
    _pod.domeMat.opacity = (0.25 + pulse * 0.20) * boost;
    _pod.domeMat.emissiveIntensity = (0.6 + pulse * 0.5) * boost;
  }
  // Beacon scales with pulse too
  const beaconScale = 1.0 + pulse * 0.4 * boost;
  _pod.beacon.scale.setScalar(beaconScale);
}

export function clearSafetyPod() {
  if (!_pod) return;
  if (_pod.group && _pod.group.parent) scene.remove(_pod.group);
  for (const m of [_pod.baseMat, _pod.domeMat, _pod.ringMat, _pod.outerRingMat, _pod.beaconMat]) {
    if (m && m.dispose) m.dispose();
  }
  _pod = null;
}
