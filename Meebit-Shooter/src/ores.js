// ============================================================================
// src/ores.js — NEW FILE
// ============================================================================
// Mining wave overhaul:
//   - Blocks take 100 hits to crack (every bullet = 1 damage, or pickaxe
//     for faster ~5 swings). See blocks.js for damage flow.
//   - When a block breaks it drops an ORE (icosahedron, chapter-tinted).
//   - Player walks over the ore → auto-magnetized pickup.
//   - Player delivers by stepping onto the DEPOT platform.
//   - 5 deposits = mining wave complete.
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { MINING_CONFIG, CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { S, shake } from './state.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { getTriangleFor } from './triangles.js';

export const ores = [];
export let depot = null;

// --------- ORE ---------

// Rainbow ore: a compound of 6 intersecting chapter-colored cones. Each ore
// visually encodes all 6 chapter palettes, reinforcing the "mine to progress
// through every chapter" feel. Replaces the older single-color icosahedron.
//
// Geometry: one cone primitive (reused across all 6 slices) plus 6 materials
// (one per chapter color). Rendering cost: 6 small draw calls per ore — the
// typical mining wave has <10 ores on the ground at once so the cost is
// negligible. Instancing would save a few microseconds but the code
// complexity isn't worth it.
const ORE_RADIUS = 0.45;
const ORE_CONE_GEO = new THREE.ConeGeometry(ORE_RADIUS * 0.55, ORE_RADIUS * 1.4, 5);  // 5-sided pyramid
const ORE_MAGNET_RADIUS = 3.0;
const ORE_PICKUP_RADIUS = 1.1;

// Chapter colors in the same order as config.CHAPTERS — orange, red, yellow,
// green, cyan, magenta. Used to tint each slice of the rainbow ore.
const RAINBOW_COLORS = [
  0xff6a1a,   // INFERNO  orange
  0xff2e4d,   // CRIMSON  red
  0xffd93d,   // SOLAR    yellow
  0x00ff66,   // TOXIC    green
  0x4ff7ff,   // ARCTIC   cyan
  0xe63aff,   // PARADISE magenta
];

// Cached material per chapter color. Cached so all ores share the same 6
// MeshStandardMaterial instances → one shader compile per color, ever.
const _rainbowMatCache = new Map();
function _getRainbowMat(tintHex) {
  let m = _rainbowMatCache.get(tintHex);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tintHex,
      emissive: tintHex,
      emissiveIntensity: 1.8,
      metalness: 0.6,
      roughness: 0.25,
    });
    _rainbowMatCache.set(tintHex, m);
  }
  return m;
}

/**
 * Build a rainbow ore mesh — a compound of 6 cone "spikes" arranged in 3D,
 * each tinted with a different chapter color. Looks like a colorful
 * geometric sculpture, clearly distinct from the one-color tinted blocks.
 */
function _buildRainbowMesh() {
  const group = new THREE.Group();
  for (let i = 0; i < RAINBOW_COLORS.length; i++) {
    const cone = new THREE.Mesh(ORE_CONE_GEO, _getRainbowMat(RAINBOW_COLORS[i]));
    cone.castShadow = true;

    // Distribute cones in 3D so they interpenetrate like the reference image.
    // Each cone points outward along a vector on a sphere, rotated so its
    // axis is aligned with that vector.
    const phi = (i / RAINBOW_COLORS.length) * Math.PI * 2;   // yaw around Y
    const theta = (i % 2 === 0) ? Math.PI / 3 : 2 * Math.PI / 3;  // alternate upper/lower
    const dirX = Math.sin(theta) * Math.cos(phi);
    const dirY = Math.cos(theta);
    const dirZ = Math.sin(theta) * Math.sin(phi);

    // Cone default points +Y. Orient cone axis to point along (dirX, dirY, dirZ).
    const dir = new THREE.Vector3(dirX, dirY, dirZ);
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    cone.quaternion.copy(quat);
    // Push each cone slightly out so tips stick out past center.
    cone.position.set(dirX * ORE_RADIUS * 0.35, dirY * ORE_RADIUS * 0.35, dirZ * ORE_RADIUS * 0.35);

    group.add(cone);
  }
  return group;
}

export function spawnOre(x, z, tintHex, chapterIdx) {
  // tintHex/chapterIdx are still accepted for API compatibility but
  // rainbow ores render the same regardless — the "all chapter colors
  // on every ore" request overrides per-wave tinting.
  const mesh = _buildRainbowMesh();
  mesh.position.set(x, 0.9, z);
  scene.add(mesh);

  const ore = {
    mesh,
    pos: mesh.position,
    tintHex,                 // kept for the pickup burst color
    chapterIdx: chapterIdx || 0,
    life: 60,
    picked: false,
    bobPhase: Math.random() * Math.PI * 2,
    // Per-ore random spin axis so no two ores look identical in flight.
    spinAxis: new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    ).normalize(),
    spinSpeed: 1.3 + Math.random() * 0.6,
  };
  ores.push(ore);
  return ore;
}

export function updateOres(dt, player) {
  for (let i = ores.length - 1; i >= 0; i--) {
    const o = ores[i];
    if (o.picked) continue;

    // Bob + 3D tumble. Each ore rotates around its own random axis so the
    // rainbow compound slowly cycles through color facings — one face, then
    // another — making it read as a shifting prism rather than a flat wheel.
    if (o.spinAxis) {
      o.mesh.rotateOnAxis(o.spinAxis, dt * o.spinSpeed);
    } else {
      // Legacy fallback for any ores built before spinAxis was added.
      o.mesh.rotation.y += dt * 2.5;
      o.mesh.rotation.x += dt * 1.1;
    }
    o.bobPhase += dt * 3;
    o.mesh.position.y = 0.9 + Math.sin(o.bobPhase) * 0.15;

    o.life -= dt;
    if (o.life <= 0) {
      scene.remove(o.mesh);
      ores.splice(i, 1);
      continue;
    }

    // Magnetize to player
    const dx = player.pos.x - o.pos.x;
    const dz = player.pos.z - o.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < ORE_MAGNET_RADIUS * ORE_MAGNET_RADIUS) {
      const d = Math.sqrt(d2) || 1;
      const pull = Math.max(0, (ORE_MAGNET_RADIUS - d) / ORE_MAGNET_RADIUS) * 10 * dt;
      o.pos.x += (dx / d) * pull;
      o.pos.z += (dz / d) * pull;
    }
    if (d2 < ORE_PICKUP_RADIUS * ORE_PICKUP_RADIUS) {
      pickupOre(o, i);
    }
  }
}

function pickupOre(ore, idx) {
  ore.picked = true;
  scene.remove(ore.mesh);
  ores.splice(idx, 1);
  S.oresCarried = (S.oresCarried || 0) + 1;
  // Rainbow celebration burst: three small bursts in three random chapter
  // colors so the pickup VFX mirrors the rainbow ore itself. Cheap — each
  // hitBurst only spawns a handful of particles.
  const pickupPos = new THREE.Vector3(ore.pos.x, 1.2, ore.pos.z);
  for (let b = 0; b < 3; b++) {
    const c = RAINBOW_COLORS[Math.floor(Math.random() * RAINBOW_COLORS.length)];
    hitBurst(pickupPos, c, 6);
  }
  Audio.pickup && Audio.pickup();
  if (UI && UI.toast) UI.toast('+1 ORE', '#ffd93d', 900);
}

export function clearAllOres() {
  for (const o of ores) {
    if (o.mesh && o.mesh.parent) scene.remove(o.mesh);
  }
  ores.length = 0;
}

// --------- DEPOT ---------

// --------- DEPOT SHARED RESOURCES ---------
// Geometries are shared globally; materials are cached per chapter tint
// so each chapter's depot compiles exactly once.
const DEPOT_PLATE_GEO = new THREE.CylinderGeometry(2.4, 2.6, 0.35, 6);
const DEPOT_DISK_GEO = new THREE.CircleGeometry(1.8, 24);
const DEPOT_BEACON_GEO = new THREE.CylinderGeometry(0.35, 0.7, 14, 8, 1, true);

const _depotPlateMatCache = new Map();
const _depotDiskMatCache = new Map();
const _depotBeaconMatCache = new Map();
function _getDepotPlateMat(tint) {
  let m = _depotPlateMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x1a1a2e, emissive: tint, emissiveIntensity: 0.6,
      metalness: 0.8, roughness: 0.35,
    });
    _depotPlateMatCache.set(tint, m);
  }
  return m;
}
function _getDepotDiskMat(tint) {
  let m = _depotDiskMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
    });
    _depotDiskMatCache.set(tint, m);
  }
  return m;
}
function _getDepotBeaconMat(tint) {
  let m = _depotBeaconMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.45, depthWrite: false,
    });
    _depotBeaconMatCache.set(tint, m);
  }
  return m;
}

// Exposed to prewarm so every chapter's depot shader is compiled up front.
export function prewarmDepotMats(tint) {
  _getDepotPlateMat(tint);
  _getDepotDiskMat(tint);
  _getDepotBeaconMat(tint);
}

/**
 * Build the depot for this mining wave. Placed at a random angle, at a
 * fixed distance from center so it's always reachable but varies run-to-run.
 */
export function spawnDepot(chapterIdx) {
  clearDepot();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.lamp;
  // Place the depot at the centroid of the mining triangle so wave 1
  // objectives live in their assigned arena wedge. Adds a small random
  // offset inside the wedge so the depot isn't in exactly the same spot
  // every chapter even when the same triangle is assigned twice in a row.
  const t = getTriangleFor('mining');
  const jitterA = (Math.random() - 0.5) * 0.4;  // ±0.2 rad along the wedge
  const jitterR = (Math.random() - 0.5) * 6;    // ±3 units along radius
  const a = t.centerAngle + jitterA;
  const r = 22 + jitterR;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;

  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Plate — shared material (color identical across all depots of a chapter)
  const plate = new THREE.Mesh(DEPOT_PLATE_GEO, _getDepotPlateMat(tint));
  plate.position.y = 0.18;
  plate.castShadow = true;
  plate.receiveShadow = true;
  group.add(plate);

  // Disk — clone cached material so this depot's opacity pulse is independent
  const diskMat = _getDepotDiskMat(tint).clone();
  const disk = new THREE.Mesh(DEPOT_DISK_GEO, diskMat);
  disk.rotation.x = -Math.PI / 2;
  disk.position.y = 0.36;
  group.add(disk);

  // Beacon — clone for same reason
  const beaconMat = _getDepotBeaconMat(tint).clone();
  const beacon = new THREE.Mesh(DEPOT_BEACON_GEO, beaconMat);
  beacon.position.y = 7;
  group.add(beacon);

  // Depot light removed — was another PointLight added per mining
  // wave start, contributing to wave-start recompile stalls. The
  // emissive plate + beacon + disk + crowd side lights give the
  // depot enough presence.
  const light = null;

  scene.add(group);

  depot = {
    obj: group,
    pos: group.position,
    plate, disk, beacon, diskMat, beaconMat, light,
    tint,
    deposited: 0,
    required: MINING_CONFIG.oresRequired,
    pulsePhase: 0,
    // Depot is visible from chapter start (dormant prop) but only ACCEPTS
    // deposits while the mining wave is active. waves.js flips this when
    // wave 1 starts / ends.
    active: false,

    // Drive-off animation state. After wave 1 completes, waves.js calls
    // startDepotDriveOff() which sets drivingOff=true. The updater below
    // ramps drivingOffT 0→1 over DRIVE_OFF_SEC, translating depot.obj
    // outward along the mining-triangle centerline past the arena edge.
    // When drivingOffT hits 1, the depot is removed from the scene.
    drivingOff: false,
    driveT: 0,
    driveStartX: 0,
    driveStartZ: 0,
    driveDirX: 0,
    driveDirZ: 0,
  };
  return depot;
}

/**
 * Enable/disable deposit acceptance. When inactive the depot still renders
 * but the beacon dims and the disk glow fades so it visually reads as
 * "standing by".
 */
export function setDepotActive(isActive) {
  if (!depot) return;
  depot.active = !!isActive;
  if (depot.beaconMat) {
    // Dim to a weak idle glow when inactive.
    depot.beaconMat.opacity = isActive ? 0.45 : 0.08;
  }
  if (depot.diskMat) {
    depot.diskMat.opacity = isActive ? 0.55 : 0.20;
  }
}

export function clearDepot() {
  if (depot && depot.obj && depot.obj.parent) scene.remove(depot.obj);
  depot = null;
}

/**
 * Update the depot each frame. Returns true if the required deposit count
 * was reached on this tick (so the caller can end the wave).
 */
export function updateDepot(dt, player) {
  if (!depot) return false;
  depot.pulsePhase += dt * 3;

  // --- Drive-off animation (wave 1 victory beat) ---
  if (depot.drivingOff) {
    depot.driveT = Math.min(1, depot.driveT + dt / DEPOT_DRIVE_OFF_SEC);
    // Ease-in: slow rumble at first, accelerating toward the wall.
    const eased = depot.driveT * depot.driveT;
    const dist = eased * DEPOT_DRIVE_OFF_DIST;
    depot.obj.position.x = depot.driveStartX + depot.driveDirX * dist;
    depot.obj.position.z = depot.driveStartZ + depot.driveDirZ * dist;
    // Subtle bobbing while driving — depot rocks back and forth.
    depot.obj.rotation.y = Math.sin(depot.driveT * Math.PI * 4) * 0.08;
    // Pitch forward as it speeds up — "leaning into the drive".
    depot.obj.rotation.x = -eased * 0.15;
    if (depot.driveT >= 1) {
      // Animation complete — remove the depot from scene. clearDepot()
      // tears down the group and nulls the module-level reference.
      clearDepot();
    }
    return false;
  }

  // When inactive (dormant prop on non-mining waves) the beacon stays
  // dim — a faint idle glow — and no deposits are accepted. Early-out
  // after the subtle pulse so we still animate but skip the player check.
  if (!depot.active) {
    const idlePulse = (Math.sin(depot.pulsePhase * 0.6) + 1) * 0.5; // 0..1
    depot.beaconMat.opacity = 0.04 + idlePulse * 0.06;
    depot.diskMat.opacity = 0.12 + idlePulse * 0.08;
    return false;
  }

  depot.beaconMat.opacity = 0.3 + Math.abs(Math.sin(depot.pulsePhase)) * 0.4;
  depot.diskMat.opacity = 0.55 + Math.abs(Math.sin(depot.pulsePhase * 1.3)) * 0.25;

  const dx = player.pos.x - depot.pos.x;
  const dz = player.pos.z - depot.pos.z;
  const d2 = dx * dx + dz * dz;
  const r = MINING_CONFIG.depotDepositRadius;

  // Stand on the depot while carrying ore → dump everything at once
  if (d2 < r * r && (S.oresCarried || 0) > 0) {
    while ((S.oresCarried || 0) > 0 && depot.deposited < depot.required) {
      depot.deposited++;
      S.oresCarried--;
      hitBurst(new THREE.Vector3(depot.pos.x, 1.0, depot.pos.z), depot.tint, 10);
      if (UI && UI.toast) {
        UI.toast('ORE DEPOSITED (' + depot.deposited + '/' + depot.required + ')', '#00ff66', 800);
      }
      Audio.levelup && Audio.levelup();
      shake(0.15, 0.1);
    }
    if (depot.deposited >= depot.required) return true;
  }
  return false;
}

// Drive-off tuning.
const DEPOT_DRIVE_OFF_SEC = 3.0;
const DEPOT_DRIVE_OFF_DIST = 60;  // distance past start — well past arena wall

/**
 * Begin the wave-1 victory drive-off. Depot rolls outward along the mining
 * triangle's centerline until it's past the arena wall, then self-removes.
 * Safe to call with no depot / already-driving-off depot (idempotent).
 */
export function startDepotDriveOff() {
  if (!depot || depot.drivingOff) return;
  depot.active = false;
  depot.drivingOff = true;
  depot.driveT = 0;
  depot.driveStartX = depot.obj.position.x;
  depot.driveStartZ = depot.obj.position.z;

  // Direction: along the mining triangle's centerline, outward from origin.
  const t = getTriangleFor('mining');
  depot.driveDirX = Math.cos(t.centerAngle);
  depot.driveDirZ = Math.sin(t.centerAngle);
}

export function depotStatus() {
  if (!depot) return null;
  return {
    deposited: depot.deposited,
    required: depot.required,
    pos: depot.pos,
  };
}
