// cannon.js — Chapter-1 reflow CANNON prop. Replaces the silo for
// chapter 1 only (other chapters keep the silo + powerup flow).
//
// Visual:
//   - Heavy concrete pad (square)
//   - Cylindrical base (rotates)
//   - Tilted barrel rising from base, pointing up at ~45°
//   - 4 charge-slot indicator lights along the base ring — start dim
//     grey, light up bright green as the player loads each charge
//   - Targeting reticle disc on top of base (rotates slowly)
//   - Glow ring at barrel tip (charges up + flashes on fire)
//
// State machine:
//   IDLE     — 0 slots loaded, no animation
//   LOADING  — some slots loaded, slot lights green, reticle spinning
//   ARMED    — all 4 slots loaded, barrel hum + glow ramp
//   FIRING   — auto-fires every 15s; brief muzzle flash + beam
//                                                + slot light dim back to grey
//   SPENT    — all 4 shots fired, base smoking
//
// Public API:
//   spawnCannon(chapterIdx)               — build and add to scene
//   clearCannon()                         — remove from scene + dispose
//   loadChargeSlot()                      — light up next dim slot
//   isCannonLoaded()                      — true if all 4 slots filled
//   armCannon()                           — transition to ARMED state
//   tryFireCannon(targetPos)              — fire if cooldown ready, returns true
//   updateCannon(dt)                      — per-frame animation
//   getCannonOrigin()                     — Vector3 muzzle position
//   cannonShotsFired()                    — int 0..4

import * as THREE from 'three';
import { scene } from './scene.js';
import { LAYOUT } from './waveProps.js';
import { CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { shake, S } from './state.js';
import { Audio } from './audio.js';

// ---- Geometry (shared singletons) ----
const PAD_GEO        = new THREE.BoxGeometry(5.0, 0.3, 5.0);
const BASE_GEO       = new THREE.CylinderGeometry(1.6, 1.8, 1.2, 16);
const TURRET_GEO     = new THREE.CylinderGeometry(1.0, 1.2, 0.6, 16);    // top of base
const BARREL_GEO     = new THREE.CylinderGeometry(0.36, 0.45, 4.0, 14);
const BARREL_TIP_GEO = new THREE.CylinderGeometry(0.55, 0.36, 0.5, 14);  // wider muzzle
const RETICLE_GEO    = new THREE.RingGeometry(0.55, 0.85, 24);
const RETICLE_HAIR_GEO = new THREE.BoxGeometry(1.7, 0.04, 0.04);
const SLOT_GEO       = new THREE.SphereGeometry(0.18, 10, 8);
const GLOW_DISC_GEO  = new THREE.CircleGeometry(0.55, 20);

// ---- Materials (chapter-tinted) ----
function _padMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x2a2c34, roughness: 0.9, metalness: 0.1,
    emissive: 0x1a1c24, emissiveIntensity: 0.1,
  });
}
function _baseMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: 0x4a5060, roughness: 0.5, metalness: 0.7,
    emissive: tint, emissiveIntensity: 0.18,
  });
}
function _barrelMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x3a4050, roughness: 0.45, metalness: 0.85,
    emissive: 0x222730, emissiveIntensity: 0.2,
  });
}
function _slotDimMat() {
  return new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.85 });
}
function _slotLitMat() {
  return new THREE.MeshBasicMaterial({ color: 0x66ff66, transparent: false, toneMapped: false });
}
function _reticleMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, toneMapped: false,
  });
}
function _glowMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.0,
    side: THREE.DoubleSide, toneMapped: false,
  });
}

// ---- Module state (single cannon instance) ----
let _cannon = null;
//
// Shape:
// {
//   group, base, turret, barrel, barrelTip, reticle, glowDisc,
//   slotMeshes: [Mesh x4], slotLitMats: [Material x4],
//   slotsLoaded: 0..4, shotsFired: 0..4,
//   state: 'IDLE'|'LOADING'|'ARMED'|'FIRING'|'SPENT',
//   fireCooldown: 0..1, hum: 0..1, fireFlash: 0..1,
//   reticleSpin: 0..2π,
// }

const SHOT_INTERVAL = 15.0;     // 15s between cannon shots — user spec

/** Build the cannon at the silo position. Replaces the silo for chapter 1. */
export function spawnCannon(chapterIdx) {
  if (_cannon) return _cannon;
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  const group = new THREE.Group();
  group.position.set(LAYOUT.silo.x, 0, LAYOUT.silo.z);

  // --- Pad ---
  const pad = new THREE.Mesh(PAD_GEO, _padMat());
  pad.position.y = 0.15;
  pad.receiveShadow = true;
  group.add(pad);

  // --- Base + Turret (rotates with reticle) ---
  const base = new THREE.Mesh(BASE_GEO, _baseMat(tint));
  base.position.y = 0.30 + 0.6;
  base.castShadow = true;
  group.add(base);

  // 4 charge-slot lights around the base ring — visible from above
  const slotMeshes = [];
  const slotLitMats = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 - Math.PI / 2;     // start at +Z
    const slot = new THREE.Mesh(SLOT_GEO, _slotDimMat());
    slot.position.set(Math.cos(a) * 1.7, 0.30 + 1.25, Math.sin(a) * 1.7);
    group.add(slot);
    slotMeshes.push(slot);
    // Pre-build the lit material for each slot so we can swap quickly
    slotLitMats.push(_slotLitMat());
  }

  // Turret + barrel + reticle live inside a YAW GROUP so we can
  // rotate them together to aim the cannon at a target. The yaw group
  // is centered at the base column's vertical axis so rotation
  // pivots cleanly. Pad + base + slot lights stay outside (don't yaw).
  const yawGroup = new THREE.Group();
  group.add(yawGroup);

  // Turret head — small cylinder on top of base, holds the barrel + reticle
  const turret = new THREE.Mesh(TURRET_GEO, _baseMat(tint));
  turret.position.y = 0.30 + 1.5;
  turret.castShadow = true;
  yawGroup.add(turret);

  // Barrel — tilted up at ~45°, anchored to turret
  const barrel = new THREE.Mesh(BARREL_GEO, _barrelMat());
  // Tilt: rotate around X so the cylinder (which is +Y by default)
  // tips forward toward +Z. Then offset upward + forward.
  barrel.rotation.x = -Math.PI / 4;   // 45° tilt forward
  // After tilt, barrel center should be just above turret, slightly +Z.
  // Half-length = 2.0; tilted projects to (0, 2.0/√2, 2.0/√2) from anchor.
  barrel.position.set(0, 0.30 + 1.5 + 1.4, 1.4);
  barrel.castShadow = true;
  yawGroup.add(barrel);

  // Barrel tip (muzzle) — wider flare at the front
  const barrelTip = new THREE.Mesh(BARREL_TIP_GEO, _barrelMat());
  barrelTip.rotation.x = -Math.PI / 4;
  // Tip sits at the +Z end of the barrel
  const tipDist = 2.05 + 0.25;     // half barrel + half tip
  barrelTip.position.set(0,
    0.30 + 1.5 + Math.cos(Math.PI / 4) * tipDist,
    Math.sin(Math.PI / 4) * tipDist,
  );
  yawGroup.add(barrelTip);

  // Glow disc at the muzzle — flat plane facing the barrel direction
  const glowDisc = new THREE.Mesh(GLOW_DISC_GEO, _glowMat(tint));
  glowDisc.rotation.x = -Math.PI / 4;
  const glowDist = tipDist + 0.3;
  glowDisc.position.set(0,
    0.30 + 1.5 + Math.cos(Math.PI / 4) * glowDist,
    Math.sin(Math.PI / 4) * glowDist,
  );
  yawGroup.add(glowDisc);

  // Reticle — flat ring lying on top of turret, faces up. Slow spin.
  const reticle = new THREE.Mesh(RETICLE_GEO, _reticleMat(tint));
  reticle.rotation.x = -Math.PI / 2;
  reticle.position.y = 0.30 + 1.82;
  yawGroup.add(reticle);
  // Crosshair — 2 thin bars across the reticle
  const reticleMat = _reticleMat(tint);
  const hair1 = new THREE.Mesh(RETICLE_HAIR_GEO, reticleMat);
  hair1.rotation.x = -Math.PI / 2;
  hair1.position.y = 0.30 + 1.83;
  yawGroup.add(hair1);
  const hair2 = new THREE.Mesh(RETICLE_HAIR_GEO, reticleMat);
  hair2.rotation.x = -Math.PI / 2;
  hair2.rotation.z = Math.PI / 2;
  hair2.position.y = 0.30 + 1.83;
  yawGroup.add(hair2);

  scene.add(group);

  _cannon = {
    group, yawGroup, base, turret, barrel, barrelTip, reticle, glowDisc,
    hair1, hair2,
    slotMeshes, slotLitMats,
    tint,
    slotsLoaded: 0,
    shotsFired: 0,
    state: 'IDLE',
    fireCooldown: 0,
    hum: 0,
    fireFlash: 0,
    reticleSpin: 0,
  };
  return _cannon;
}

/** Light up the next dim slot. Called when a charge is delivered. */
export function loadChargeSlot() {
  if (!_cannon) return false;
  if (_cannon.slotsLoaded >= 4) return false;
  const idx = _cannon.slotsLoaded;
  // Swap the slot's material from dim to lit. Visual flash burst on
  // the slot for feedback.
  _cannon.slotMeshes[idx].material = _cannon.slotLitMats[idx];
  hitBurst(
    new THREE.Vector3(
      _cannon.group.position.x + _cannon.slotMeshes[idx].position.x,
      _cannon.slotMeshes[idx].position.y,
      _cannon.group.position.z + _cannon.slotMeshes[idx].position.z,
    ),
    0x66ff66, 14,
  );
  _cannon.slotsLoaded++;
  if (_cannon.state === 'IDLE') _cannon.state = 'LOADING';
  return true;
}

/** True when all 4 slots are filled. Caller can transition to wave 3
 *  arming flow. */
export function isCannonLoaded() {
  return !!_cannon && _cannon.slotsLoaded >= 4;
}

/** Transition to ARMED — barrel hum + glow ramp begins. The first shot
 *  will auto-fire after the standard 15s cooldown. */
export function armCannon() {
  if (!_cannon || _cannon.state === 'ARMED' || _cannon.state === 'FIRING') return;
  _cannon.state = 'ARMED';
  _cannon.fireCooldown = SHOT_INTERVAL;     // first shot after 15s
}

/** Try to fire the cannon. Returns true if a shot fired this tick.
 *  Caller passes the target position so the cannon can play a beam
 *  visual toward the queen hive. */
export function tryFireCannon(targetPos) {
  if (!_cannon) return false;
  if (_cannon.state !== 'ARMED' && _cannon.state !== 'FIRING') return false;
  if (_cannon.fireCooldown > 0) return false;
  if (_cannon.shotsFired >= 4) return false;

  // Fire!
  _cannon.shotsFired++;
  _cannon.fireFlash = 1.0;     // 1.0 → 0 over the next ~0.5s
  _cannon.hum = 0;             // reset hum after firing
  _cannon.fireCooldown = SHOT_INTERVAL;
  _cannon.state = 'FIRING';

  // Dim one slot light back to grey (visual: charge consumed)
  const slotIdx = _cannon.shotsFired - 1;
  if (_cannon.slotMeshes[slotIdx]) {
    _cannon.slotMeshes[slotIdx].material = _slotDimMat();
  }

  // Muzzle flash — big chapter-tinted burst at the barrel tip
  const muzzle = _muzzleWorldPos();
  hitBurst(muzzle, 0xffffff, 20);
  hitBurst(muzzle, _cannon.tint, 35);
  hitBurst(muzzle, 0xff8800, 14);
  shake(0.7, 0.4);
  try { Audio.cannonFire && Audio.cannonFire(); } catch (e) {}

  // Spent-state transition once 4 shots fired
  if (_cannon.shotsFired >= 4) {
    _cannon.state = 'SPENT';
  }

  return true;
}

/** Rotate the cannon's turret + barrel to aim at a target XZ position.
 *  The barrel's natural facing (when yaw=0) is along +Z. We compute
 *  atan2(dx, dz) so the +Z direction rotates onto the target vector. */
export function aimCannonAt(targetPos) {
  if (!_cannon || !targetPos) return;
  const dx = targetPos.x - _cannon.group.position.x;
  const dz = targetPos.z - _cannon.group.position.z;
  if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
  const yaw = Math.atan2(dx, dz);
  _cannon.yawGroup.rotation.y = yaw;
}

/** Per-frame update — animate reticle spin, barrel hum, fire flash, glow disc. */
export function updateCannon(dt) {
  if (!_cannon) return;

  // Reticle spins continuously regardless of state — telegraphs "system online"
  _cannon.reticleSpin += dt * 0.6;
  if (_cannon.reticle) _cannon.reticle.rotation.z = _cannon.reticleSpin;
  if (_cannon.hair1) _cannon.hair1.rotation.z = _cannon.reticleSpin;
  if (_cannon.hair2) _cannon.hair2.rotation.z = _cannon.reticleSpin + Math.PI / 2;

  // Cooldown countdown
  if (_cannon.fireCooldown > 0) _cannon.fireCooldown -= dt;

  // Hum builds during ARMED state — barrel base emissive ramps up as
  // the next shot approaches. Resets after firing.
  if (_cannon.state === 'ARMED') {
    const cdNorm = 1 - Math.max(0, _cannon.fireCooldown) / SHOT_INTERVAL;
    _cannon.hum = cdNorm;
  }

  // Glow disc opacity: ramps with hum, flashes white on fire
  if (_cannon.glowDisc && _cannon.glowDisc.material) {
    const m = _cannon.glowDisc.material;
    m.opacity = Math.max(_cannon.hum * 0.6, _cannon.fireFlash);
  }

  // Fire flash decays
  if (_cannon.fireFlash > 0) {
    _cannon.fireFlash = Math.max(0, _cannon.fireFlash - dt * 2);
  }

  // Barrel emissive matches hum
  if (_cannon.barrel && _cannon.barrel.material) {
    _cannon.barrel.material.emissiveIntensity = 0.2 + _cannon.hum * 0.6 + _cannon.fireFlash * 1.5;
  }
}

/** World position of the muzzle (for VFX origin). */
function _muzzleWorldPos() {
  if (!_cannon) return new THREE.Vector3();
  const p = new THREE.Vector3();
  _cannon.barrelTip.getWorldPosition(p);
  return p;
}

/** Public muzzle origin for callers wiring beam VFX. */
export function getCannonOrigin() {
  return _muzzleWorldPos();
}

/** How many cannon shots have fired so far this run (0..4). */
export function cannonShotsFired() {
  return _cannon ? _cannon.shotsFired : 0;
}

/** Cannon state string for HUD/debug. */
export function getCannonState() {
  return _cannon ? _cannon.state : null;
}

/** Time remaining until next shot (seconds, or 0 if not in ARMED state). */
export function getCannonCooldown() {
  if (!_cannon || _cannon.state !== 'ARMED') return 0;
  return Math.max(0, _cannon.fireCooldown);
}

/** True if a cannon is currently in the scene. */
export function hasCannon() {
  return !!_cannon;
}

/** Remove the cannon from the scene. Called on chapter exit / reset. */
export function clearCannon() {
  if (!_cannon) return;
  if (_cannon.group && _cannon.group.parent) scene.remove(_cannon.group);
  // Materials are mostly small singletons — the engine GC handles them.
  // We don't dispose to keep the cache warm for a re-spawn.
  _cannon = null;
}
