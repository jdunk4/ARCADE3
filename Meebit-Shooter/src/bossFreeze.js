// bossFreeze.js — GLACIER_WRAITH's per-boss mechanic. Cycles a
// telegraphed arena-wide freeze attack with multi-pod safety zones.
//
// Per the boss rework spec for GLACIER_WRAITH:
//   - Telegraphed freeze
//   - Land a pod or two near the boss
//   - Boss attacks (the freeze)
//   - Killing everything not in pod
//
// Cycle timing:
//   1. TELEGRAPH (3s): pods spawn + descend, on-screen warning
//   2. FREEZE (instant): all enemies + player outside pod radius take
//      damage; player damage is heavy (60 HP) but not auto-instakill
//      so a near-miss isn't a one-shot run-ender. Enemies outside pods
//      are instakilled per spec ("killing everything not in pod").
//   3. THAW (3s): pods linger so the player can see they survived,
//      then disappear. Cycle resets.
//
// Multiple pods: the freeze always lands at least 1 pod; subsequent
// cycles can land 2 (escalation). Pods are parented to the scene
// directly via this module — chapter-2 wave-2's existing safetyPod.js
// uses a SINGLE pod and lives on its own; we keep that module
// untouched to avoid breaking that wave's flow.

import * as THREE from 'three';
import { scene } from './scene.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { ARENA, CHAPTERS } from './config.js';

// ---- TUNING ----

// Pod safe radius — same scale as chapter-2 wave-2 pods so the
// "shelter inside the pod" mechanic feels familiar. 3.5u radius
// gives enough space for the player + a comfort margin.
const POD_RADIUS = 3.5;

// Cycle timing
const TELEGRAPH_TIME = 3.0;   // pods descend + warning on screen
const THAW_TIME      = 3.0;   // pods linger after freeze, then despawn

// Damage values
const PLAYER_DAMAGE_OUTSIDE_POD = 60;   // significant but not auto-OHKO
// Enemies caught outside pods die instantly via direct hp = 0 set;
// no separate constant needed.

// Visual — frozen-cyan tint everywhere. Stays cyan regardless of
// chapter palette since "freeze" should always read as ice/cold.
const FREEZE_COLOR = 0x4ff7ff;

// ---- STATE ----

// Cycle state. One active cycle at a time — boss pattern dispatch
// only kicks off a new one when the previous one is done (THAW
// completed and pods despawned).
const _state = {
  phase: 'idle',       // 'idle' | 'telegraph' | 'frozen' | 'thaw'
  phaseT: 0,
  pods: [],            // [{ group, baseMat, ringMat, beaconMat, x, z }]
  flashOverlay: null,  // DOM div for the full-screen freeze flash
  bossPos: null,       // {x, z} captured at trigger time — suction target
  debris: [],          // [{ mesh, mat, vel, life, maxLife }] — telegraph particles
};

// ---- POD GEOMETRY (cached) ----
const _BASE_GEO   = new THREE.CircleGeometry(POD_RADIUS, 32);
const _RING_GEO   = new THREE.RingGeometry(POD_RADIUS - 0.20, POD_RADIUS, 48);
const _BEACON_GEO = new THREE.SphereGeometry(0.30, 12, 10);
// Dome geometry: radius 1.2x the base disc so the dome flares OUT
// from the safe-zone footprint. The original geometry was POD_RADIUS,
// matching the disc exactly — visually flat-looking from overhead.
// 1.2x makes the dome read as a hemisphere bubble with a clear
// outer rim catching light from any angle.
const _DOME_GEO   = new THREE.SphereGeometry(POD_RADIUS * 1.2, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2);

function _makePod(x, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const baseMat = new THREE.MeshBasicMaterial({
    color: FREEZE_COLOR, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const base = new THREE.Mesh(_BASE_GEO, baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.07;
  group.add(base);

  const ringMat = new THREE.MeshBasicMaterial({
    color: FREEZE_COLOR, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const ring = new THREE.Mesh(_RING_GEO, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  group.add(ring);

  // Dome cap — bigger + less transparent than the original. Switched
  // from AdditiveBlending to NormalBlending so the dome reads as a
  // solid translucent SHELL rather than additive haze that blends
  // into the bright floor disc and disappears.
  // Player feedback: "I think we need to give it a bigger dome.
  // Make the top not quite so transparent."
  const domeMat = new THREE.MeshBasicMaterial({
    color: FREEZE_COLOR, transparent: true, opacity: 0.45,
    side: THREE.FrontSide, depthWrite: false,
    blending: THREE.NormalBlending, toneMapped: false,
  });
  const dome = new THREE.Mesh(_DOME_GEO, domeMat);
  dome.position.y = 0.1;
  group.add(dome);

  const beaconMat = new THREE.MeshBasicMaterial({
    color: FREEZE_COLOR, toneMapped: false,
  });
  const beacon = new THREE.Mesh(_BEACON_GEO, beaconMat);
  beacon.position.y = POD_RADIUS + 0.2;
  group.add(beacon);

  scene.add(group);
  return {
    group, base, baseMat, ring, ringMat, dome, domeMat, beacon, beaconMat,
    x, z,
  };
}

function _disposePod(pod) {
  if (pod.group && pod.group.parent) pod.group.parent.remove(pod.group);
  if (pod.baseMat)   pod.baseMat.dispose();
  if (pod.ringMat)   pod.ringMat.dispose();
  if (pod.domeMat)   pod.domeMat.dispose();
  if (pod.beaconMat) pod.beaconMat.dispose();
}

// ---- FULL-SCREEN FLASH (DOM overlay) ----
//
// When the freeze fires, briefly flash a cyan vignette across the
// whole viewport. Pure visual — sells the "the world just froze"
// moment. Self-disposing.

function _spawnFreezeFlash() {
  if (_state.flashOverlay) return;
  const el = document.createElement('div');
  el.style.cssText = [
    'position: fixed', 'inset: 0',
    'background: radial-gradient(circle, rgba(79, 247, 255, 0.0) 30%, rgba(79, 247, 255, 0.55) 100%)',
    'pointer-events: none',
    'z-index: 9100',
    'opacity: 1',
    'transition: opacity 800ms ease-out',
  ].join(';');
  document.body.appendChild(el);
  _state.flashOverlay = el;
  // Fade out shortly after so the player can see the world again.
  requestAnimationFrame(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (_state.flashOverlay === el) _state.flashOverlay = null;
    }, 850);
  });
}

// ---- PUBLIC API ----

/**
 * Kick off a freeze cycle: spawn pods near the boss, telegraph for
 * 3 seconds, then fire the freeze attack. Caller (boss pattern
 * dispatch) tracks cooldown between cycles.
 *
 * @param {{x: number, z: number}} bossPos - center to position pods around
 * @param {number} podCount - 1 or 2 pods this cycle
 */
export function triggerFreezeCycle(bossPos, podCount) {
  if (_state.phase !== 'idle') return;   // ignore during active cycle
  // Position pods near the boss but not on top — 8u away at random
  // angles. If 2 pods, separate them by 180° so they cover opposite
  // sides of the boss (player has options no matter which way they
  // were running). 1 pod: just one random angle.
  const baseAngle = Math.random() * Math.PI * 2;
  const podDist = 8;
  for (let i = 0; i < Math.max(1, Math.min(2, podCount)); i++) {
    const angle = baseAngle + (i * Math.PI);
    const px = bossPos.x + Math.cos(angle) * podDist;
    const pz = bossPos.z + Math.sin(angle) * podDist;
    // Clamp inside arena
    const lim = ARENA - 5;
    const cx = Math.max(-lim, Math.min(lim, px));
    const cz = Math.max(-lim, Math.min(lim, pz));
    _state.pods.push(_makePod(cx, cz));
  }
  _state.phase = 'telegraph';
  _state.phaseT = 0;
  _state.bossPos = { x: bossPos.x, z: bossPos.z };   // suction target — locked at trigger time

  try {
    UI.toast && UI.toast('FREEZE INCOMING · GET TO A POD', '#4ff7ff', TELEGRAPH_TIME * 1000);
  } catch (e) {}
  try { Audio.radioBeep && Audio.radioBeep(); } catch (e) {}
}

/**
 * True if (px, pz) is inside any active pod's safe radius. Caller
 * uses this on the FREEZE phase tick to decide who lives and who
 * dies. Always returns false during 'idle' phase.
 */
export function isInsideAnyPod(px, pz) {
  if (_state.pods.length === 0) return false;
  for (const pod of _state.pods) {
    const dx = px - pod.x;
    const dz = pz - pod.z;
    if (dx * dx + dz * dz < POD_RADIUS * POD_RADIUS) return true;
  }
  return false;
}

/** Returns the current freeze phase. */
export function getFreezePhase() {
  return _state.phase;
}

/**
 * True only on the single frame the freeze actually fires — the
 * transition from 'telegraph' to 'frozen'. Used by the boss pattern
 * dispatch to apply damage to player + enemies exactly once per
 * cycle (instead of every frame during the frozen phase).
 */
export function didFreezeFireThisFrame() {
  return _state.phase === 'frozen' && _state.phaseT === 0;
}

/**
 * During telegraph phase, modify the player's velocity in-place to
 * add an inward pull toward the boss. Caller is main.js's player
 * update — gets called after WASD input has already set player.vel
 * but before player.pos is integrated. Outside telegraph: no-op.
 *
 * The pull is a velocity ADDITION (not a replacement) so player
 * input still works at full magnitude — this just biases drift
 * toward the boss when the player isn't actively pushing away.
 *
 * Pull strength ramps with telegraph progress:
 *   - First 1s: gentle (1.5 u/s)
 *   - Last 2s: stronger (4.5 u/s, comparable to ~50% of player speed)
 * That ramp gives the player time to react to the warning and start
 * moving toward a pod before the suction becomes hard to fight.
 */
export function applySuctionToVelocity(playerPos, vel) {
  if (_state.phase !== 'telegraph' || !_state.bossPos) return;
  const dx = _state.bossPos.x - playerPos.x;
  const dz = _state.bossPos.z - playerPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz) || 0.0001;
  // Ramp strength based on telegraph progress
  const t = _state.phaseT / TELEGRAPH_TIME;
  const pullSpeed = 1.5 + 3.0 * t;     // u/s — 1.5 → 4.5 over 3s
  // Add inward velocity toward the boss
  vel.x += (dx / dist) * pullSpeed;
  vel.z += (dz / dist) * pullSpeed;
}

/**
 * Wipe the current cycle and despawn all pods. Call on boss death +
 * chapter teardown. Idempotent.
 */
export function clearFreeze() {
  for (const pod of _state.pods) _disposePod(pod);
  _state.pods.length = 0;
  // Dispose any in-flight debris particles
  for (const d of _state.debris) {
    if (d.mesh && d.mesh.parent) d.mesh.parent.remove(d.mesh);
    d.geom && d.geom.dispose();
    d.mat && d.mat.dispose();
  }
  _state.debris.length = 0;
  _state.bossPos = null;
  _state.phase = 'idle';
  _state.phaseT = 0;
  if (_state.flashOverlay && _state.flashOverlay.parentNode) {
    _state.flashOverlay.parentNode.removeChild(_state.flashOverlay);
    _state.flashOverlay = null;
  }
}

/**
 * Per-frame update — drive phase transitions + animate pod pulse.
 * Damage application is NOT done here; the boss pattern dispatch
 * checks didFreezeFireThisFrame() and applies damage itself, since
 * it has access to the player + enemies arrays.
 */
export function updateFreeze(dt) {
  if (_state.phase === 'idle') return;
  const tNow = performance.now() / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(tNow * 4.0);

  // Per-pod animation — pulse opacity + bob beacon. Only animates
  // during telegraph / frozen / thaw phases (not idle).
  for (const pod of _state.pods) {
    pod.ringMat.opacity   = 0.65 + 0.30 * pulse;
    pod.baseMat.opacity   = 0.45 + 0.20 * pulse;
    pod.beacon.position.y = (POD_RADIUS + 0.2) + 0.15 * Math.sin(tNow * 3.0);
  }

  // Debris particles — visual half of the suction effect. During
  // telegraph, spawn small cyan shards at the arena perimeter and
  // drift them toward the locked boss position. Each particle is a
  // tiny tinted box that shrinks + fades as it approaches the boss,
  // disposing when life expires. Player sees a swirl of cyan being
  // pulled into the boss from all sides — reinforces "the boss is
  // sucking the world inward" while the player feels it on their
  // own velocity.
  if (_state.phase === 'telegraph' && _state.bossPos) {
    // Spawn rate ramps with telegraph progress so the visual
    // intensifies the same way the suction strength does.
    const tProg = _state.phaseT / TELEGRAPH_TIME;
    const spawnsPerFrame = 1 + Math.floor(tProg * 3);    // 1 → 4 per frame
    for (let i = 0; i < spawnsPerFrame; i++) {
      // Random angle around the boss, distance near the arena edge
      const angle = Math.random() * Math.PI * 2;
      const dist = ARENA - 6 - Math.random() * 8;        // 6-14u inside the edge
      const sx = _state.bossPos.x + Math.cos(angle) * dist;
      const sz = _state.bossPos.z + Math.sin(angle) * dist;
      const sy = 0.4 + Math.random() * 1.6;
      const debrisGeo = new THREE.BoxGeometry(0.18, 0.18, 0.18);
      const debrisMat = new THREE.MeshBasicMaterial({
        color: FREEZE_COLOR, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(debrisGeo, debrisMat);
      mesh.position.set(sx, sy, sz);
      // Velocity pointing toward the boss with random tangential noise
      const dx = _state.bossPos.x - sx;
      const dz = _state.bossPos.z - sz;
      const d = Math.sqrt(dx * dx + dz * dz) || 0.0001;
      // Tangent direction (perpendicular) for orbital swirl
      const tx = -dz / d;
      const tz =  dx / d;
      const inwardSpeed   = 6 + Math.random() * 4;
      const tangentialSpd = (Math.random() - 0.5) * 4;
      const vx = (dx / d) * inwardSpeed + tx * tangentialSpd;
      const vz = (dz / d) * inwardSpeed + tz * tangentialSpd;
      const vy = -1.0 + Math.random() * 0.5;             // gentle fall
      const life = 0.7 + Math.random() * 0.4;
      scene.add(mesh);
      _state.debris.push({
        mesh, mat: debrisMat, geom: debrisGeo,
        vel: { x: vx, y: vy, z: vz },
        life, maxLife: life,
      });
    }
  }

  // Tick debris regardless of phase — particles spawned during
  // telegraph keep finishing their arc into the freeze flash.
  for (let i = _state.debris.length - 1; i >= 0; i--) {
    const d = _state.debris[i];
    d.life -= dt;
    if (d.life <= 0) {
      // Dispose
      if (d.mesh && d.mesh.parent) d.mesh.parent.remove(d.mesh);
      d.geom && d.geom.dispose();
      d.mat && d.mat.dispose();
      _state.debris.splice(i, 1);
      continue;
    }
    d.mesh.position.x += d.vel.x * dt;
    d.mesh.position.y += d.vel.y * dt;
    d.mesh.position.z += d.vel.z * dt;
    // Tiny gravity
    d.vel.y -= 1.5 * dt;
    // Shrink + fade with life
    const lifeT = d.life / d.maxLife;
    const sc = 0.4 + 0.6 * lifeT;
    d.mesh.scale.set(sc, sc, sc);
    d.mat.opacity = 0.85 * lifeT;
  }

  // Phase machine. phaseT tracks "this frame is the first frame of
  // the new phase" by comparing prev-phase to current — but simpler
  // is to just fire transitions in-place and let didFreezeFireThisFrame
  // observe phaseT === 0 as the trigger.
  if (_state.phase === 'telegraph') {
    _state.phaseT += dt;
    if (_state.phaseT >= TELEGRAPH_TIME) {
      _state.phase  = 'frozen';
      _state.phaseT = 0;     // didFreezeFireThisFrame sees phaseT === 0
      _spawnFreezeFlash();
      try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
      // RETURN here — leave phaseT at exactly 0 so this is the
      // single frame on which boss pattern dispatch can read
      // didFreezeFireThisFrame() and apply damage. Without this
      // return, the same updateFreeze call would fall into the
      // 'frozen' branch below and bump phaseT off zero, making
      // the trigger window invisibly small.
      return;
    }
  } else if (_state.phase === 'frozen') {
    // Second frame in 'frozen' — transition to 'thaw'. By the time
    // this branch executes, the boss pattern dispatch has already
    // had a frame to read didFreezeFireThisFrame() and apply damage.
    _state.phase = 'thaw';
    _state.phaseT = 0;
  } else if (_state.phase === 'thaw') {
    _state.phaseT += dt;
    if (_state.phaseT >= THAW_TIME) {
      // Cycle complete — despawn pods, reset to idle.
      for (const pod of _state.pods) _disposePod(pod);
      _state.pods.length = 0;
      _state.phase = 'idle';
      _state.phaseT = 0;
    }
  }
}
