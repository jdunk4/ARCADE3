// escortTruck.js — Chapter 2 wave 1 escort vehicle. Big truck with a
// huge power generator on the back. Drives along a straight-line path
// from the depot wedge to the silo position. Player must stay within
// ESCORT_RADIUS (8u) of the truck for it to move. Truck stops if any
// enemy is within FRONT_BUMPER_RADIUS (4u) directly in front. On
// arrival within ARRIVAL_RADIUS (2u) of the target: signals wave-end
// and emits a decompression hiss.
//
// Visual:
//   - Heavy chassis (low dark rectangular box)
//   - Cab at the front (smaller box with chapter-tinted accent + windows)
//   - Cargo bed (open rectangular frame)
//   - Generator on bed: vertical cylinder + cooling fins + emissive top + spinning beacon
//   - 4 wheel slabs along the sides
//   - Chapter-tinted trim + flashing beacon on cab roof
//
// Public API:
//   spawnEscortTruck(chapterIdx, fromPos, toPos)
//   updateEscortTruck(dt, playerPos, enemies)
//   getTruckPos()
//   isTruckArrived()
//   hasTruck()
//   getEscortRadius()
//   clearEscortTruck()

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { shake } from './state.js';
import { Audio } from './audio.js';

// ---- Tunables ----
const ESCORT_RADIUS = 12.0;         // player must stay within this (u) — bumped from 8.5
const FRONT_BUMPER_RADIUS = 2.5;    // any enemy within this in front blocks (smaller = more forgiving)
const TRUCK_SPEED = 1.4;            // u/s base
const ARRIVAL_RADIUS = 4.0;         // bumped from 2.0 — auto-completes when "close enough"
const BEACON_SPIN_SPEED = 4.5;      // rad/s
const TRUCK_COLLIDE_R = 2.4;        // bullet/walking collision radius around truck center

// ---- Geometry ----
const CHASSIS_GEO     = new THREE.BoxGeometry(3.0, 0.45, 6.5);
const CAB_GEO         = new THREE.BoxGeometry(2.4, 1.6, 1.8);
const CAB_WINDOW_GEO  = new THREE.PlaneGeometry(2.0, 0.9);
const BED_FRAME_GEO   = new THREE.BoxGeometry(2.6, 0.28, 3.6);
const BED_RAIL_GEO    = new THREE.BoxGeometry(0.22, 0.55, 3.6);
const GEN_BODY_GEO    = new THREE.CylinderGeometry(1.0, 1.1, 2.0, 14);
const GEN_FINS_GEO    = new THREE.TorusGeometry(1.05, 0.08, 8, 24);
const GEN_TOP_GEO     = new THREE.CylinderGeometry(0.85, 1.0, 0.4, 14);
const GEN_GLOW_GEO    = new THREE.CircleGeometry(0.85, 16);
const BEACON_BASE_GEO = new THREE.CylinderGeometry(0.18, 0.22, 0.18, 10);
const BEACON_LIGHT_GEO = new THREE.SphereGeometry(0.28, 12, 10);
const WHEEL_GEO       = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14);
const HEADLIGHT_GEO   = new THREE.CircleGeometry(0.25, 12);
const TRIM_GEO        = new THREE.BoxGeometry(3.0, 0.06, 0.08);

// ---- Materials ----
function _chassisMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x2c2f37, roughness: 0.5, metalness: 0.75,
    // Bumped 0.10 → 0.30 for the "shiny truck" pass — reads as
    // polished gunmetal catching ambient light rather than dull paint.
    emissive: 0x222730, emissiveIntensity: 0.30,
  });
}
function _cabMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: 0x3d4250, roughness: 0.4, metalness: 0.75,
    // Chapter-tinted glow on the cab — bumped 0.15 → 0.50 so the cab
    // reads as the clear silhouette focal point of the truck.
    emissive: tint, emissiveIntensity: 0.50,
  });
}
function _windowMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: 0x111620, roughness: 0.15, metalness: 0.85,
    emissive: tint, emissiveIntensity: 0.4,
    side: THREE.DoubleSide,
  });
}
function _genBodyMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x4a4d56, roughness: 0.3, metalness: 0.90,
    // Generator body bumped 0.18 → 0.45 so it reads as a powered piece
    // of equipment rather than a dull box on the truck bed.
    emissive: 0x33373f, emissiveIntensity: 0.45,
  });
}
function _genTopMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: tint, roughness: 0.3, metalness: 0.6,
    emissive: tint, emissiveIntensity: 1.4,
  });
}
function _genGlowMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
function _beaconLightMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint,
    toneMapped: false,
  });
}
function _trimMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: tint, emissive: tint, emissiveIntensity: 0.7,
    roughness: 0.4, metalness: 0.6,
  });
}
function _wheelMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x141518, roughness: 0.95, metalness: 0.05,
  });
}
function _headlightMat() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffcc, transparent: true, opacity: 0.9,
    side: THREE.DoubleSide, depthWrite: false,
  });
}

// ---- Module state ----
let _truck = null;

/**
 * Build the truck prop and place it at fromPos, oriented to face toPos.
 * fromPos and toPos are { x, z } objects (Y is computed). Returns the
 * built _truck object.
 */
export function spawnEscortTruck(chapterIdx, fromPos, toPos) {
  if (_truck) clearEscortTruck();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  const group = new THREE.Group();

  // --- Chassis (low body) ---
  const chassis = new THREE.Mesh(CHASSIS_GEO, _chassisMat());
  chassis.position.y = 0.65;
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  group.add(chassis);

  // Trim strip running along the side (chapter-tinted accent)
  const trimL = new THREE.Mesh(TRIM_GEO, _trimMat(tint));
  trimL.position.set(0, 0.45, 1.55);
  trimL.scale.z = 6.5 / 0.08;        // stretch to length of chassis
  trimL.scale.x = 0.13;              // narrow strip
  trimL.position.set(1.55, 0.45, 0);
  trimL.rotation.y = Math.PI / 2;
  group.add(trimL);

  const trimR = new THREE.Mesh(TRIM_GEO, _trimMat(tint));
  trimR.scale.z = 6.5 / 0.08;
  trimR.scale.x = 0.13;
  trimR.position.set(-1.55, 0.45, 0);
  trimR.rotation.y = Math.PI / 2;
  group.add(trimR);

  // --- Cab at front (positive Z is "forward") ---
  const cab = new THREE.Mesh(CAB_GEO, _cabMat(tint));
  cab.position.set(0, 0.65 + 0.225 + 0.8, 2.3);     // chassis top + cab half-height
  cab.castShadow = true;
  group.add(cab);

  // Windshield + side windows (single plane on the front face)
  const winFront = new THREE.Mesh(CAB_WINDOW_GEO, _windowMat(tint));
  winFront.position.set(0, 0.65 + 0.225 + 0.95, 2.3 + 0.91);    // just in front of cab
  group.add(winFront);

  // Headlights — 2 small bright discs on the front of the cab
  const hl1 = new THREE.Mesh(HEADLIGHT_GEO, _headlightMat());
  hl1.position.set(-0.85, 0.65 + 0.225 + 0.4, 2.3 + 0.91);
  group.add(hl1);
  const hl2 = new THREE.Mesh(HEADLIGHT_GEO, _headlightMat());
  hl2.position.set(0.85, 0.65 + 0.225 + 0.4, 2.3 + 0.91);
  group.add(hl2);

  // --- Bed frame (rear cargo platform) ---
  const bed = new THREE.Mesh(BED_FRAME_GEO, _chassisMat());
  bed.position.set(0, 0.65 + 0.225 + 0.14, -0.5);
  bed.castShadow = true;
  group.add(bed);

  // Bed side rails
  const railL = new THREE.Mesh(BED_RAIL_GEO, _chassisMat());
  railL.position.set(1.30, 0.65 + 0.225 + 0.42, -0.5);
  group.add(railL);
  const railR = new THREE.Mesh(BED_RAIL_GEO, _chassisMat());
  railR.position.set(-1.30, 0.65 + 0.225 + 0.42, -0.5);
  group.add(railR);

  // --- Generator on the bed ---
  // Body cylinder
  const genGroup = new THREE.Group();
  genGroup.position.set(0, 0.65 + 0.225 + 0.28 + 1.0, -0.5);    // bed top + body half-height
  group.add(genGroup);

  const genBody = new THREE.Mesh(GEN_BODY_GEO, _genBodyMat());
  genBody.castShadow = true;
  genGroup.add(genBody);

  // Cooling fins (3 toruses stacked on the body)
  const fin1 = new THREE.Mesh(GEN_FINS_GEO, _genBodyMat());
  fin1.rotation.x = Math.PI / 2;
  fin1.position.y = -0.5;
  genGroup.add(fin1);
  const fin2 = new THREE.Mesh(GEN_FINS_GEO, _genBodyMat());
  fin2.rotation.x = Math.PI / 2;
  fin2.position.y = 0.0;
  genGroup.add(fin2);
  const fin3 = new THREE.Mesh(GEN_FINS_GEO, _genBodyMat());
  fin3.rotation.x = Math.PI / 2;
  fin3.position.y = 0.5;
  genGroup.add(fin3);

  // Top cap + emissive glow disc
  const genTop = new THREE.Mesh(GEN_TOP_GEO, _genTopMat(tint));
  genTop.position.y = 1.2;
  genGroup.add(genTop);
  const genGlow = new THREE.Mesh(GEN_GLOW_GEO, _genGlowMat(tint));
  genGlow.rotation.x = -Math.PI / 2;
  genGlow.position.y = 1.41;
  genGroup.add(genGlow);

  // --- Beacon on top of cab (rotating chapter-tinted spinner) ---
  const beaconGroup = new THREE.Group();
  beaconGroup.position.set(0, 0.65 + 0.225 + 1.6 + 0.10, 2.3);
  group.add(beaconGroup);
  const beaconBase = new THREE.Mesh(BEACON_BASE_GEO, _trimMat(tint));
  beaconGroup.add(beaconBase);
  const beaconLight = new THREE.Mesh(BEACON_LIGHT_GEO, _beaconLightMat(tint));
  beaconLight.position.y = 0.18;
  beaconGroup.add(beaconLight);

  // --- Wheels (4 slabs along the sides) ---
  const wheelMat = _wheelMat();
  const wheelPositions = [
    { x:  1.55, z:  2.0 },
    { x: -1.55, z:  2.0 },
    { x:  1.55, z: -2.0 },
    { x: -1.55, z: -2.0 },
  ];
  for (const wp of wheelPositions) {
    const w = new THREE.Mesh(WHEEL_GEO, wheelMat);
    w.rotation.z = Math.PI / 2;     // cylinder axis along X
    w.position.set(wp.x, 0.55, wp.z);
    w.castShadow = true;
    group.add(w);
  }

  // --- ESCORT RADIUS RING (green, on the floor, parented to truck) ---
  // Always visible; opacity bumps when player is INSIDE radius (active).
  // Player sees "green ring on floor → stay inside it."
  const ringGeo = new THREE.RingGeometry(ESCORT_RADIUS - 0.25, ESCORT_RADIUS, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x55ff7c,                       // bright green
    transparent: true, opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const escortRing = new THREE.Mesh(ringGeo, ringMat);
  escortRing.rotation.x = -Math.PI / 2;
  escortRing.position.y = 0.04;            // just above floor
  group.add(escortRing);

  // --- BUMPER WARNING ZONE (red disc in front of truck, blocked state) ---
  // Hidden by default; visible when an enemy is in the front bumper zone.
  // Sits at the bumper position (3.5u in front of truck center).
  const bumperGeo = new THREE.CircleGeometry(FRONT_BUMPER_RADIUS, 32);
  const bumperMat = new THREE.MeshBasicMaterial({
    color: 0xff3030,                       // bright red
    transparent: true, opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const bumperZone = new THREE.Mesh(bumperGeo, bumperMat);
  bumperZone.rotation.x = -Math.PI / 2;
  bumperZone.position.set(0, 0.05, 3.5);   // local +Z = forward
  bumperZone.visible = false;
  group.add(bumperZone);

  // Compute path direction + initial yaw
  const dx = toPos.x - fromPos.x;
  const dz = toPos.z - fromPos.z;
  const pathLen = Math.sqrt(dx * dx + dz * dz);
  // If path is degenerate, default to facing +Z
  const dirX = pathLen > 0.001 ? dx / pathLen : 0;
  const dirZ = pathLen > 0.001 ? dz / pathLen : 1;

  group.position.set(fromPos.x, 0, fromPos.z);
  // Yaw — orient the cab (which is at +Z in local space) toward the
  // path direction. atan2 gives the world-space angle to face.
  group.rotation.y = Math.atan2(dirX, dirZ);

  scene.add(group);

  _truck = {
    group,
    cab, chassis, bed,
    genGroup, genBody, genTop, genGlow,
    beaconGroup, beaconLight,
    escortRing, ringMat,
    bumperZone, bumperMat,
    tint,
    fromPos: { x: fromPos.x, z: fromPos.z },
    toPos: { x: toPos.x, z: toPos.z },
    dirX, dirZ,
    pathLen,
    progress: 0,                 // 0..pathLen — accumulated distance
    arrived: false,
    arrivalT: 0,                 // animation timer for arrival hiss
    bobT: Math.random() * Math.PI * 2,
    beaconSpin: 0,
    enemiesBlocking: false,      // set externally each frame
    moving: false,               // for outside callers / HUD
    playerInRadius: false,
    speed: TRUCK_SPEED,
    ringPulseT: 0,
    // Engine rumble cooldown — counts down each tick. When it hits
    // zero, Audio.truckEngine() fires and we reset to a small
    // randomized interval. Faster cadence while the truck is rolling
    // (~0.5s) than when idling (~1.2s) so the player audibly hears
    // motion. Initial value 0.4 so the first rumble plays shortly
    // after spawn rather than waiting a full interval.
    engineRumbleT: 0.4,
    // Tracks the previous frame's canMove state so we can detect
    // false→true transitions (truck unstuck and starting to roll
    // again) and play a one-shot Audio.truckRollStart() cue.
    // Default false so spawn → first move triggers the cue once
    // the player gets in radius.
    lastCanMove: false,
  };
  // Truck startup — chuffed engine ignition at spawn so the player
  // hears the truck "come online" alongside the visual. Defensive
  // wrap in case Audio isn't initialized yet (it usually is by the
  // time waves have started, but tutorial paths spawn sooner).
  try { Audio.truckStart && Audio.truckStart(); } catch (e) {}
  return _truck;
}

/** Test whether any enemy is within FRONT_BUMPER_RADIUS in front of
 *  the truck. enemies is an iterable of objects with .pos { x, z }
 *  and .destroyed/.dead boolean (we skip dead). */
function _isAnyEnemyInFront(enemies) {
  if (!_truck || !enemies) return false;
  // Front-bumper world position — half a chassis-length ahead of group center
  const FRONT_OFFSET = 3.5;
  const fx = _truck.group.position.x + _truck.dirX * FRONT_OFFSET;
  const fz = _truck.group.position.z + _truck.dirZ * FRONT_OFFSET;
  for (const e of enemies) {
    if (!e || e.destroyed || e.dead) continue;
    if (!e.pos) continue;
    const ex = e.pos.x - fx;
    const ez = e.pos.z - fz;
    if (ex * ex + ez * ez < FRONT_BUMPER_RADIUS * FRONT_BUMPER_RADIUS) return true;
  }
  return false;
}

/**
 * Per-frame update.
 *   - Animates beacon spin + idle bob always
 *   - If arrived: continues a small landing/decompression flourish
 *   - Else: advances progress along the path if (player in radius)
 *     AND (no enemy in front bumper)
 *   - Returns true on the frame the truck FIRST arrives (caller fires
 *     the "wave complete" beat). False afterward.
 */
export function updateEscortTruck(dt, playerPos, enemies) {
  if (!_truck) return false;

  // Beacon spin always
  _truck.beaconSpin += dt * BEACON_SPIN_SPEED;
  _truck.beaconGroup.rotation.y = _truck.beaconSpin;
  // Beacon light pulse — color intensity bobs
  if (_truck.beaconLight && _truck.beaconLight.material) {
    const pulse = 0.7 + 0.3 * Math.sin(_truck.beaconSpin * 2.0);
    _truck.beaconLight.material.opacity = pulse;
  }

  // Generator emissive pulse (reads as "live power")
  if (_truck.genTop && _truck.genTop.material) {
    _truck.genTop.material.emissiveIntensity = 1.2 + 0.4 * Math.sin(_truck.bobT * 2.5);
  }

  if (_truck.arrived) {
    // Small post-arrival settle — gentle compress + relax
    _truck.arrivalT += dt;
    const f = Math.min(1, _truck.arrivalT / 0.6);
    const compress = 1 - 0.04 * Math.sin(f * Math.PI);
    _truck.group.scale.y = compress;
    // Sink animation — runs after the arrival settle, when triggerTruckSink
    // has been called externally (at wave 1 end). Lerps Y → -10 over 1.4s
    // with ease-in. Hides the truck visually for waves 2+.
    if (_truck.sinking) {
      _truck.sinkT += dt;
      const sf = Math.min(1, _truck.sinkT / _truck.sinkDuration);
      const eased = sf * sf;
      _truck.group.position.y = _truck.sinkStartY + (_truck.sinkTargetY - _truck.sinkStartY) * eased;
    }
    return false;
  }

  // Below this point: movement + block detection. Skip if called with
  // null playerPos (e.g. unconditional per-frame tick from main.js
  // outside the escort wave). The early returns above still animate
  // beacons + sink for arrived trucks — that's the goal of this path.
  if (!playerPos) return false;

  // Compute distance from player to truck center
  const px = (playerPos && playerPos.x) || 0;
  const pz = (playerPos && playerPos.z) || 0;
  const tx = _truck.group.position.x;
  const tz = _truck.group.position.z;
  const dxp = px - tx;
  const dzp = pz - tz;
  const playerInRadius = (dxp * dxp + dzp * dzp) < (ESCORT_RADIUS * ESCORT_RADIUS);
  _truck.playerInRadius = playerInRadius;

  // Test enemies in front
  const enemyBlocking = _isAnyEnemyInFront(enemies);
  _truck.enemiesBlocking = enemyBlocking;

  const canMove = playerInRadius && !enemyBlocking;
  _truck.moving = canMove;
  // Transition cue — false → true is "truck just got unstuck and is
  // rolling forward again." Plays a one-shot gear-shift + engine
  // engage sound. We don't fire this on every frame canMove holds
  // true; only on the rising edge.
  if (canMove && !_truck.lastCanMove) {
    try { Audio.truckRollStart && Audio.truckRollStart(); } catch (e) {}
  }
  _truck.lastCanMove = canMove;

  // --- DRIVE RING + BUMPER-ZONE VISUALS ---
  _truck.ringPulseT += dt * 2.5;
  const ringPulse = 0.5 + 0.5 * Math.sin(_truck.ringPulseT);
  if (_truck.ringMat) {
    if (playerInRadius) {
      // Player in range — bright pulsing green (active state)
      _truck.ringMat.color.setHex(0x55ff7c);
      _truck.ringMat.opacity = 0.55 + ringPulse * 0.30;
    } else {
      // Player out of range — dim red ring (warning: get back in!)
      _truck.ringMat.color.setHex(0xff5555);
      _truck.ringMat.opacity = 0.40 + ringPulse * 0.20;
    }
  }
  if (_truck.bumperZone && _truck.bumperMat) {
    _truck.bumperZone.visible = !!enemyBlocking;
    if (enemyBlocking) {
      // Pulse the red zone for urgency
      _truck.bumperMat.opacity = 0.45 + ringPulse * 0.30;
    }
  }

  if (canMove) {
    const step = _truck.speed * dt;
    _truck.progress = Math.min(_truck.pathLen, _truck.progress + step);
    _truck.group.position.x = _truck.fromPos.x + _truck.dirX * _truck.progress;
    _truck.group.position.z = _truck.fromPos.z + _truck.dirZ * _truck.progress;
    // Subtle vertical bob from movement (jostle)
    _truck.bobT += dt * 5.5;
    _truck.group.position.y = Math.abs(Math.sin(_truck.bobT * 0.5)) * 0.04;
  } else {
    // Idle bob — slow vertical bob even when stopped (engine running)
    _truck.bobT += dt * 1.2;
    _truck.group.position.y = Math.abs(Math.sin(_truck.bobT * 0.6)) * 0.025;
  }

  // Engine rumble — recurring sound that sells the escort being
  // an active vehicle. Faster cadence while moving (~0.5s) than
  // when idling (~1.2s); not played at all once arrived. Volume
  // is handled inside Audio.truckEngine() (kept low so it sits
  // under combat sounds without dominating).
  if (!_truck.arrived) {
    _truck.engineRumbleT -= dt;
    if (_truck.engineRumbleT <= 0) {
      try { Audio.truckEngine && Audio.truckEngine(canMove); } catch (e) {}
      // Randomize interval slightly so the rumble doesn't feel like
      // a metronome.
      _truck.engineRumbleT = canMove
        ? (0.45 + Math.random() * 0.18)
        : (1.10 + Math.random() * 0.30);
    }
  }

  // Arrival check
  const remaining = _truck.pathLen - _truck.progress;
  if (remaining < ARRIVAL_RADIUS && !_truck.arrived) {
    _truck.arrived = true;
    _truck.arrivalT = 0;
    // Big settle burst — chapter-tinted dust at the wheels
    try {
      for (let k = 0; k < 8; k++) {
        hitBurst(
          new THREE.Vector3(
            _truck.group.position.x + (Math.random() - 0.5) * 3.0,
            0.3 + Math.random() * 0.4,
            _truck.group.position.z + (Math.random() - 0.5) * 3.0,
          ),
          _truck.tint, 14,
        );
      }
    } catch (e) {}
    shake(0.5, 0.4);
    // Truck arrival decompression — pneumatic hiss + heavy thud +
    // metallic clank from the dock connector. Audio method already
    // exists in audio.js; this is the call site that activates it.
    try { Audio.truckDecompression && Audio.truckDecompression(); } catch (e) {}
    return true;       // signal: just arrived this frame
  }
  return false;
}

export function getTruckPos() {
  if (!_truck) return null;
  return {
    x: _truck.group.position.x,
    z: _truck.group.position.z,
  };
}

export function isTruckArrived() {
  return _truck ? !!_truck.arrived : false;
}

export function hasTruck() {
  return !!_truck;
}

export function getEscortRadius() {
  return ESCORT_RADIUS;
}

/** Returns true if player is currently in the escort radius (HUD/UI use). */
export function isPlayerInEscortRadius(playerPos) {
  if (!_truck || !playerPos) return false;
  const dx = playerPos.x - _truck.group.position.x;
  const dz = playerPos.z - _truck.group.position.z;
  return dx * dx + dz * dz < ESCORT_RADIUS * ESCORT_RADIUS;
}

/** Returns true if the truck is currently blocked by enemies in front. */
export function isTruckBlocked() {
  return _truck ? !!_truck.enemiesBlocking : false;
}

/** Returns the truck's collision circles for the dynamic-props pass.
 *  Used by waveProps to block bullets + walking against the truck body
 *  while it's on the field. Skipped post-arrival so the player can walk
 *  freely once the wave-end animation begins. */
export function getTruckCollisionCircles() {
  if (!_truck || _truck.arrived) return [];
  return [{
    x: _truck.group.position.x,
    z: _truck.group.position.z,
    r: TRUCK_COLLIDE_R,
  }];
}

/** Sink the truck into the ground. Called at wave 1 end so the truck
 *  visually retreats from the arena before wave 2 begins. Idempotent. */
export function triggerTruckSink() {
  if (!_truck) return;
  if (_truck.sinking) return;
  _truck.sinking = true;
  _truck.sinkT = 0;
  _truck.sinkStartY = _truck.group.position.y;
  _truck.sinkTargetY = -10;
  _truck.sinkDuration = 1.4;
}

export function clearEscortTruck() {
  if (!_truck) return;
  if (_truck.group && _truck.group.parent) scene.remove(_truck.group);
  _truck = null;
}
