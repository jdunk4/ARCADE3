// chargeCubes.js — Chapter-1 wave-1 finisher items. After the crusher
// finisher animation, 4 chapter-tinted glowing cubes appear on the
// crusher pad. Player walks over each to pick it up. Wave 1 ends only
// when all 4 are collected. Each cube grants +1 to S.chargesCarried so
// wave 2 inherits the loaded state — no second trip to the depot.
//
// Visual:
//   - Solid cube ~0.55u edge length
//   - Chapter-tinted emissive material (pulses subtly)
//   - Slow yaw rotation + small vertical bob so they read as "alive"
//   - Glowing halo ring on the floor below each cube for visibility
//
// Pickup:
//   - Radius ~1.4u (generous so the player doesn't have to thread)
//   - Magnetize: when player is within ~3u, cube drifts toward them
//   - On pickup: cube vanishes with a chapter-tinted burst + brief
//     SFX (eggHit-style chime). S.chargesCarried bumps. Pickup count
//     tracked locally so chargeCubesRemaining() returns the live count.

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { S } from './state.js';
import { Audio } from './audio.js';

// ---- Geometry singletons ----
const CUBE_GEO  = new THREE.BoxGeometry(0.55, 0.55, 0.55);
const HALO_GEO  = new THREE.RingGeometry(0.4, 0.7, 16);

// ---- Tunables ----
const CUBE_HEIGHT = 1.6;            // hover Y above floor
const PICKUP_RADIUS = 3.0;          // enter this radius → magnet all
const MAGNET_RADIUS = 6.0;          // start drifting toward player
const MAGNET_SPEED = 14.0;          // u/s when fully magnetized (faster — collect-all feel)
const COLLECT_RADIUS = 0.9;         // actually picked up at this distance

// ---- Module state ----
let _cubes = [];
let _ringMesh = null;          // floor ring at cluster center (always visible)
let _ringMat = null;
let _ringPulseT = 0;
let _basePos = null;           // { x, z } cluster center
let _slots = [];               // 2×2 spawn slot offsets (4 entries — fill as cubes spawn)
let _chapterTint = 0xffffff;
let _allCollectionTriggered = false;   // once player enters PICKUP_RADIUS, magnet ALL

const RING_GEO = new THREE.RingGeometry(PICKUP_RADIUS - 0.25, PICKUP_RADIUS, 48);

function _cubeMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: tint, roughness: 0.3, metalness: 0.6,
    emissive: tint, emissiveIntensity: 1.4,
  });
}
function _haloMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false,
  });
}
function _ringFloorMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Set up the cube cluster: builds the chapter-tinted floor ring at
 *  (basePosX, basePosZ) and prepares 4 spawn slot offsets. NO cubes
 *  spawn yet — call addChargeCube(chapterIdx) once per crusher slam. */
export function spawnChargeCubeCluster(chapterIdx, basePosX, basePosZ) {
  clearChargeCubes();
  _chapterTint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  _basePos = { x: basePosX, z: basePosZ };
  _allCollectionTriggered = false;
  // 2x2 grid offsets — cubes spawn into these slots in order
  _slots = [
    { x: -0.55, z: -0.55, filled: false },
    { x:  0.55, z: -0.55, filled: false },
    { x: -0.55, z:  0.55, filled: false },
    { x:  0.55, z:  0.55, filled: false },
  ];
  // Build the visible floor ring at cluster center
  _ringMat = _ringFloorMat(_chapterTint);
  _ringMesh = new THREE.Mesh(RING_GEO, _ringMat);
  _ringMesh.rotation.x = -Math.PI / 2;
  _ringMesh.position.set(basePosX, 0.04, basePosZ);
  scene.add(_ringMesh);
  _ringPulseT = 0;
}

/** Spawn ONE cube in the next empty slot. Called once per crusher slam
 *  during the wave-1 finisher. Returns true if a cube was spawned. */
export function addChargeCube(chapterIdx) {
  if (!_basePos) return false;
  // Find next unfilled slot
  const slot = _slots.find(s => !s.filled);
  if (!slot) return false;
  slot.filled = true;
  const tint = _chapterTint;

  const cubeMat = _cubeMat(tint);
  const cube = new THREE.Mesh(CUBE_GEO, cubeMat);
  cube.position.set(_basePos.x + slot.x, CUBE_HEIGHT, _basePos.z + slot.z);
  cube.castShadow = true;
  scene.add(cube);

  // Floor halo (small, around individual cube — distinct from cluster ring)
  const haloMat = _haloMat(tint);
  const halo = new THREE.Mesh(HALO_GEO, haloMat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.set(_basePos.x + slot.x, 0.05, _basePos.z + slot.z);
  scene.add(halo);

  _cubes.push({
    mesh: cube,
    mat: cubeMat,
    halo, haloMat,
    restPos: new THREE.Vector3(_basePos.x + slot.x, CUBE_HEIGHT, _basePos.z + slot.z),
    bobSeed: _cubes.length * 0.7,
    yaw: _cubes.length * 0.5,
    collected: false,
    magnetActive: false,
  });
  // Spawn-in burst for visual punch
  try {
    hitBurst(cube.position.clone(), 0xffffff, 8);
    hitBurst(cube.position.clone(), tint, 14);
  } catch (e) {}
  return true;
}

/** Backward-compat wrapper: old call signature spawned 4 cubes at once.
 *  Delegate to spawnChargeCubeCluster + add 4 cubes immediately. */
export function spawnChargeCubes(chapterIdx, basePosX, basePosZ) {
  spawnChargeCubeCluster(chapterIdx, basePosX, basePosZ);
  for (let i = 0; i < 4; i++) addChargeCube(chapterIdx);
}

/** Per-frame update — animate bob/rotation/pulse, magnetize toward
 *  player, collection check. Returns number of cubes still uncollected. */
export function updateChargeCubes(dt, playerPos) {
  // Tick + drive the cluster ring animation regardless of cube count
  _ringPulseT += dt * 2.5;
  let playerInPickupRadius = false;
  if (_basePos && playerPos) {
    const bdx = playerPos.x - _basePos.x;
    const bdz = playerPos.z - _basePos.z;
    const bdist = Math.sqrt(bdx * bdx + bdz * bdz);
    playerInPickupRadius = bdist < PICKUP_RADIUS;
    // Once player enters pickup radius, trigger magnet-all flag.
    // It stays on after entry (cubes finish their flight even if
    // player walks back out — feels good).
    if (playerInPickupRadius) _allCollectionTriggered = true;
  }
  // Drive the cluster ring: brighter pulse when player in range
  if (_ringMesh && _ringMat) {
    const ringPulse = 0.5 + 0.5 * Math.sin(_ringPulseT);
    if (playerInPickupRadius) {
      _ringMat.opacity = 0.65 + ringPulse * 0.30;
    } else {
      _ringMat.opacity = 0.40 + ringPulse * 0.20;
    }
  }

  if (!_cubes.length) return 0;
  let remaining = 0;
  for (let i = _cubes.length - 1; i >= 0; i--) {
    const c = _cubes[i];
    if (c.collected) continue;
    remaining++;

    // Idle animation — yaw + small bob + emissive pulse
    c.bobSeed += dt;
    c.yaw += dt * 1.6;
    c.mesh.rotation.y = c.yaw;
    c.mesh.rotation.x = Math.sin(c.bobSeed * 0.8) * 0.18;
    const pulse = 1.2 + Math.sin(c.bobSeed * 3.0) * 0.4;
    c.mat.emissiveIntensity = pulse;
    if (c.haloMat) c.haloMat.opacity = 0.45 + Math.sin(c.bobSeed * 2.2) * 0.20;

    // Pickup / magnet logic
    if (playerPos) {
      const dx = playerPos.x - c.mesh.position.x;
      const dz = playerPos.z - c.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Collect when very close to player (or trigger fired and very close)
      if (dist < COLLECT_RADIUS) {
        c.collected = true;
        S.chargesCarried = (S.chargesCarried || 0) + 1;
        const tint = c.mat.color.getHex();
        const p = c.mesh.position.clone();
        hitBurst(p, 0xffffff, 12);
        hitBurst(p, tint, 24);
        try { Audio.eggHit && Audio.eggHit(); } catch (e) {}
        if (c.mesh && c.mesh.parent) scene.remove(c.mesh);
        if (c.mat && c.mat.dispose) c.mat.dispose();
        if (c.halo && c.halo.parent) scene.remove(c.halo);
        if (c.haloMat && c.haloMat.dispose) c.haloMat.dispose();
        _cubes.splice(i, 1);
        remaining--;
        continue;
      }

      // Magnet logic: when _allCollectionTriggered is set (player has
      // entered pickup radius), all cubes fly hard toward player. Use
      // distance-independent fast speed so they catch up quickly.
      // Otherwise: gentle drift if within MAGNET_RADIUS.
      if (_allCollectionTriggered && dist > 0.001) {
        // Hard magnet — fly at full speed toward player
        const inv = 1 / dist;
        const step = MAGNET_SPEED * dt;
        c.mesh.position.x += dx * inv * step;
        c.mesh.position.z += dz * inv * step;
        c.halo.position.x = c.mesh.position.x;
        c.halo.position.z = c.mesh.position.z;
      } else if (dist < MAGNET_RADIUS && dist > 0.001) {
        // Soft magnet — gentle drift if just close
        const t = 1 - (dist / MAGNET_RADIUS);
        const speed = MAGNET_SPEED * 0.4 * t * dt;
        const inv = 1 / dist;
        c.mesh.position.x += dx * inv * speed;
        c.mesh.position.z += dz * inv * speed;
        c.halo.position.x = c.mesh.position.x;
        c.halo.position.z = c.mesh.position.z;
      } else {
        // Drift back toward rest if no longer in any magnet range
        const rdx = c.restPos.x - c.mesh.position.x;
        const rdz = c.restPos.z - c.mesh.position.z;
        c.mesh.position.x += rdx * Math.min(1, dt * 2);
        c.mesh.position.z += rdz * Math.min(1, dt * 2);
        c.halo.position.x = c.mesh.position.x;
        c.halo.position.z = c.mesh.position.z;
      }
    }

    // Bob
    c.mesh.position.y = CUBE_HEIGHT + Math.sin(c.bobSeed * 1.4) * 0.18;
  }
  return remaining;
}

export function chargeCubesRemaining() {
  let n = 0;
  for (const c of _cubes) if (!c.collected) n++;
  return n;
}

export function hasChargeCubes() {
  return chargeCubesRemaining() > 0;
}

export function clearChargeCubes() {
  for (const c of _cubes) {
    if (c.mesh && c.mesh.parent) scene.remove(c.mesh);
    if (c.mat && c.mat.dispose) c.mat.dispose();
    if (c.halo && c.halo.parent) scene.remove(c.halo);
    if (c.haloMat && c.haloMat.dispose) c.haloMat.dispose();
  }
  _cubes = [];
  // Also remove cluster floor ring + reset slot state
  if (_ringMesh && _ringMesh.parent) scene.remove(_ringMesh);
  if (_ringMat && _ringMat.dispose) _ringMat.dispose();
  _ringMesh = null;
  _ringMat = null;
  _basePos = null;
  _slots = [];
  _allCollectionTriggered = false;
  _ringPulseT = 0;
}
