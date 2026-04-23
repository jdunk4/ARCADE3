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
import { LAYOUT } from './waveProps.js';

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
  // Instead of vanishing into an "oresCarried" counter, the ore now flies
  // straight to a free orbit slot on the depot and joins the ring. When
  // all 5 slots are filled the ring smashes together into a MEGA ORE on
  // the depot — the mining wave's visual payoff.
  ores.splice(idx, 1);
  S.oresCarried = (S.oresCarried || 0) + 1;
  // Celebratory burst at the pickup point (purely visual — the ore mesh
  // keeps living and flies to the depot).
  const pickupPos = new THREE.Vector3(ore.pos.x, 1.2, ore.pos.z);
  for (let b = 0; b < 3; b++) {
    const c = RAINBOW_COLORS[Math.floor(Math.random() * RAINBOW_COLORS.length)];
    hitBurst(pickupPos, c, 6);
  }
  Audio.pickup && Audio.pickup();
  if (UI && UI.toast) UI.toast('+1 ORE', '#ffd93d', 900);
  // Hand the ore mesh off to the depot-orbit system.
  _attachOreToDepot(ore);
}

// ---------------------------------------------------------------------------
// DEPOT ORBIT SYSTEM
//
// Picked-up ores fly to the depot and orbit it at a fixed radius. When the
// 5th ore arrives, all 5 converge to the depot center and merge into a
// mega ore crystal — the wave-1 visual payoff.
//
// orbitOres:     { mesh, slotIdx, flyT, startPos, startScale, state,
//                  convergeT, megaScale } array
// state transitions:
//   'flying'     — flying from pickup point to orbit slot (flyT 0..1)
//   'orbiting'   — parked at orbit slot, rotating with the ring
//   'converging' — all 5 flying inward to depot center (smash animation)
// ---------------------------------------------------------------------------
const ORBIT_RADIUS = 2.4;           // distance from depot center
const ORBIT_HEIGHT = 1.6;           // ore Y position while orbiting
const ORBIT_SPEED = 1.1;            // radians/sec for the shared ring spin
const FLY_TO_DEPOT_SEC = 0.6;       // fly-in animation duration
const CONVERGE_SEC = 0.5;           // smash-together animation duration
const orbitOres = [];
let _orbitAngle = 0;                // shared angular offset for the ring

// The mega ore that forms after all 5 ores converge. Stays on the depot
// briefly before the wave ends.
let _depotMegaOre = null;

function _attachOreToDepot(ore) {
  if (!depot) return;
  // Keep the ore mesh alive. Remove any magnetize-to-player state.
  // Move the mesh into the depot's orbital slot 0/1/2/3/4.
  const slotIdx = orbitOres.length;   // simple FIFO slot assignment

  // Capture starting world position (where the player picked it up) for
  // a smooth fly-in lerp.
  const startPos = new THREE.Vector3(ore.mesh.position.x, ore.mesh.position.y, ore.mesh.position.z);
  const startScale = ore.mesh.scale.x;

  orbitOres.push({
    mesh: ore.mesh,
    slotIdx,
    flyT: 0,
    startPos,
    startScale,
    state: 'flying',
    convergeT: 0,
    mergeBasePos: new THREE.Vector3(),   // set at converge-start
  });

  // When the 5th ore lands, the next tick flips the state machine to
  // 'converging'. No need to trigger it here.
}

/**
 * Compute the world position for orbit slot `slotIdx`, offset by the
 * shared `_orbitAngle`. 5 slots evenly spaced 72° apart.
 */
function _orbitSlotPos(slotIdx, angleOffset) {
  const slots = Math.max(5, orbitOres.length);
  const a = angleOffset + (slotIdx / slots) * Math.PI * 2;
  return {
    x: depot.pos.x + Math.cos(a) * ORBIT_RADIUS,
    z: depot.pos.z + Math.sin(a) * ORBIT_RADIUS,
  };
}

/**
 * Per-frame tick for every orbiting / flying / converging ore. Returns
 * true when the wave-1 smash-and-form-mega completes (caller uses this
 * to end the wave). Called from updateDepot().
 */
function _updateOrbitOres(dt, time) {
  if (!depot) return false;
  _orbitAngle += dt * ORBIT_SPEED;

  // Are we in the converging phase? If every ore is 'orbiting' AND we have
  // the full required count, flip them all to 'converging'.
  const allOrbiting =
    orbitOres.length >= depot.required &&
    orbitOres.every((o) => o.state === 'orbiting');
  if (allOrbiting && !_depotMegaOre) {
    for (const o of orbitOres) {
      o.state = 'converging';
      o.convergeT = 0;
      o.mergeBasePos.set(o.mesh.position.x, o.mesh.position.y, o.mesh.position.z);
    }
    // Soft rumble as they gather.
    shake(0.25, 0.25);
  }

  let allConvergedDone = orbitOres.length > 0;
  for (const o of orbitOres) {
    if (o.state === 'flying') {
      o.flyT = Math.min(1, o.flyT + dt / FLY_TO_DEPOT_SEC);
      const target = _orbitSlotPos(o.slotIdx, _orbitAngle);
      const targetY = ORBIT_HEIGHT;
      // Ease-out: 1 - (1-t)^2
      const e = 1 - (1 - o.flyT) * (1 - o.flyT);
      o.mesh.position.x = o.startPos.x + (target.x - o.startPos.x) * e;
      o.mesh.position.y = o.startPos.y + (targetY - o.startPos.y) * e;
      o.mesh.position.z = o.startPos.z + (target.z - o.startPos.z) * e;
      // Spin a little faster during the fly-in for drama.
      if (o.mesh.rotation) {
        o.mesh.rotation.y += dt * 6;
        o.mesh.rotation.x += dt * 3;
      }
      if (o.flyT >= 1) {
        o.state = 'orbiting';
      }
      allConvergedDone = false;
    } else if (o.state === 'orbiting') {
      // Parked at orbit slot, rotating with the shared ring angle.
      const p = _orbitSlotPos(o.slotIdx, _orbitAngle);
      o.mesh.position.x = p.x;
      o.mesh.position.z = p.z;
      o.mesh.position.y = ORBIT_HEIGHT + Math.sin(time * 3 + o.slotIdx) * 0.1;
      // Individual ore spin
      o.mesh.rotation.y += dt * 2.5;
      o.mesh.rotation.x += dt * 1.1;
      allConvergedDone = false;
    } else if (o.state === 'converging') {
      // Fly inward to the depot center over CONVERGE_SEC.
      o.convergeT = Math.min(1, o.convergeT + dt / CONVERGE_SEC);
      const e = o.convergeT * o.convergeT;
      const sx = o.mergeBasePos.x, sy = o.mergeBasePos.y, sz = o.mergeBasePos.z;
      const tx = depot.pos.x, ty = 1.4, tz = depot.pos.z;
      o.mesh.position.x = sx + (tx - sx) * e;
      o.mesh.position.y = sy + (ty - sy) * e;
      o.mesh.position.z = sz + (tz - sz) * e;
      // Shrink into the merge point.
      const s = Math.max(0.02, o.startScale * (1 - e * 0.9));
      o.mesh.scale.setScalar(s);
      // Faster spin as they converge.
      o.mesh.rotation.y += dt * (4 + e * 10);
      if (o.convergeT < 1) allConvergedDone = false;
    }
  }

  // When every converging ore has arrived, spawn the mega ore + burst.
  if (allConvergedDone && orbitOres.length > 0 && !_depotMegaOre) {
    _formDepotMegaOre();
    // Dispose the original 5 ore meshes — the mega ore replaces them.
    for (const o of orbitOres) {
      if (o.mesh && o.mesh.parent) scene.remove(o.mesh);
    }
    orbitOres.length = 0;
    return true;   // caller: wave complete
  }
  return false;
}

function _formDepotMegaOre() {
  if (!depot) return;
  // Big cascading burst at depot center (white → gold → chapter tint).
  const origin = new THREE.Vector3(depot.pos.x, 1.5, depot.pos.z);
  hitBurst(origin, 0xffffff, 36);
  hitBurst(origin, 0xffd93d, 32);
  setTimeout(() => hitBurst(origin, 0xffd93d, 20), 60);
  setTimeout(() => hitBurst(origin, depot.tint, 18), 140);
  shake(0.6, 0.45);
  try { Audio.levelup && Audio.levelup(); } catch (e) {}

  // The mega ore is a GIANT rainbow ore — same compound-of-6-cones shape
  // as the orbit ores, just scaled up dramatically. Reads as "the 5 orbs
  // are now one giant ore" because the color identity is preserved.
  const ore = _buildRainbowMesh();
  ore.scale.setScalar(5.0);
  ore.position.set(depot.pos.x, 1.5, depot.pos.z);
  scene.add(ore);

  // Gold halo sphere around the rainbow crystal.
  const haloGeo = new THREE.SphereGeometry(2.2, 16, 12);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xffd93d, transparent: true, opacity: 0.28, depthWrite: false,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.set(depot.pos.x, 1.5, depot.pos.z);
  scene.add(halo);

  _depotMegaOre = {
    ore, halo, haloGeo, haloMat,
    // The ore group shares cached cone geometry + rainbow materials — we
    // don't dispose them on teardown (cache stays warm for next wave).
    lifeT: 0,
    phase: 'hover',
    phaseT: 0,
    liftoffX: 0,
    liftoffZ: 0,
    sparkT: 0,
  };
  // Clear the carrying count — the ores are now represented by the
  // mega ore sitting on the depot.
  S.oresCarried = 0;
}

function _tickDepotMegaOre(dt, time) {
  if (!_depotMegaOre) return false;
  const m = _depotMegaOre;
  m.lifeT += dt;

  // Phase machine:
  //   'hover'    — sit on the depot revolving, ~3.5s; shows off the payoff
  //   'drive'    — horizontal flight to the silo, ~1.4s; leaves a trail
  //   'absorb'   — shrink into the silo with a fuel-absorbed burst
  //   'done'     — signals wave-complete; missile launch takes over
  // Default phase is 'hover'; _formDepotMegaOre sets m.phase = 'hover'.
  const HOVER_SEC = 3.5;
  const DRIVE_SEC = 1.4;
  const ABSORB_SEC = 0.35;
  const HOVER_Y = 1.5;

  // Follow depot position while still on it (hover). Once we leave hover
  // we lock to the liftoff xz for the drive animation's start point.
  const px = depot ? depot.pos.x : m.ore.position.x;
  const pz = depot ? depot.pos.z : m.ore.position.z;

  if (m.phase === 'hover') {
    // Revolve big, pulse bright. Sit on the depot.
    m.ore.rotation.y += dt * 1.8;
    m.ore.rotation.x += dt * 0.9;
    m.ore.position.x = px;
    m.ore.position.z = pz;
    m.ore.position.y = HOVER_Y + Math.sin(time * 2) * 0.18;
    m.halo.position.x = px;
    m.halo.position.z = pz;
    m.halo.position.y = m.ore.position.y;
    const pulse = 0.5 + 0.5 * Math.sin(time * 4);
    // Rainbow ore mesh: no single oreMat. Scale-pulse it for a "pulsing" read.
    const pulseScale = 5.0 + pulse * 0.3;
    m.ore.scale.setScalar(pulseScale);
    if (m.haloMat) m.haloMat.opacity = 0.22 + pulse * 0.14;

    // Ambient gold sparks every ~0.25s so the hover feels alive, not static.
    m.sparkT = (m.sparkT || 0) - dt;
    if (m.sparkT <= 0) {
      m.sparkT = 0.22;
      const a = Math.random() * Math.PI * 2;
      const r = 1.2 + Math.random() * 0.8;
      hitBurst(
        new THREE.Vector3(px + Math.cos(a) * r, HOVER_Y + Math.random() * 0.8, pz + Math.sin(a) * r),
        0xffd93d, 2
      );
    }

    if (m.lifeT >= HOVER_SEC) {
      m.phase = 'drive';
      m.phaseT = 0;
      m.liftoffX = px;
      m.liftoffZ = pz;
      // Lock the drive destination to wherever the silo is at this moment.
      // LAYOUT.silo is updated per-chapter, so we snapshot here rather
      // than re-reading each frame (silo doesn't move mid-wave, but this
      // is still the safer pattern).
      m.destX = LAYOUT.silo.x;
      m.destZ = LAYOUT.silo.z;
      // Liftoff cue: screen shake + audio + thrust burst beneath the ore.
      shake(0.35, 0.3);
      try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
      hitBurst(new THREE.Vector3(px, 1.0, pz), 0xffffff, 18);
      hitBurst(new THREE.Vector3(px, 1.0, pz), 0xffd93d, 22);
      hitBurst(new THREE.Vector3(px, 1.0, pz), depot ? depot.tint : 0xff6a1a, 12);
    }
  } else if (m.phase === 'drive') {
    // Drive horizontally from depot to silo at HOVER_Y. The ore is the
    // "fuel" for the missile — it delivers itself to the launcher and
    // vanishes into the silo, kicking off the EMP launch cinematic.
    m.phaseT += dt;
    const f = Math.min(1, m.phaseT / DRIVE_SEC);
    // Ease-in-out so the ore accelerates out of the depot, cruises,
    // then decelerates approaching the silo. smoothstep gives the
    // natural settle-in motion.
    const e = f * f * (3 - 2 * f);
    const x = m.liftoffX + (m.destX - m.liftoffX) * e;
    const z = m.liftoffZ + (m.destZ - m.liftoffZ) * e;
    // Subtle bob across the drive so it reads as "flying" not "sliding".
    const y = HOVER_Y + Math.sin(f * Math.PI) * 0.6;
    m.ore.position.set(x, y, z);
    m.halo.position.set(x, y, z);
    // Spin faster during transit for energy.
    m.ore.rotation.y += dt * (3 + f * 4);
    m.ore.rotation.x += dt * (2 + f * 3);
    m.ore.scale.setScalar(5.0);
    if (m.haloMat) m.haloMat.opacity = 0.3 + Math.sin(f * Math.PI) * 0.3;
    // Comet trail — gold sparks behind the ore. Density ramps with speed
    // (peaks mid-flight where the ease is fastest).
    if (Math.random() < 0.6 + 0.3 * Math.sin(f * Math.PI)) {
      hitBurst(new THREE.Vector3(x, y - 0.4, z), 0xffd93d, 2);
    }
    if (Math.random() < 0.3) {
      hitBurst(new THREE.Vector3(x, y - 0.6, z), 0xffffff, 1);
    }

    if (f >= 1) {
      m.phase = 'absorb';
      m.phaseT = 0;
    }
  } else if (m.phase === 'absorb') {
    // Shrink and sink into the silo. Silo is at (destX, destZ); we
    // collapse the ore to zero scale and drop it from HOVER_Y down to
    // silo base. The missile-launch sequence will take over once we
    // return true below.
    m.phaseT += dt;
    const f = Math.min(1, m.phaseT / ABSORB_SEC);
    const scaleRemaining = 5.0 * (1 - f);
    m.ore.scale.setScalar(Math.max(0.01, scaleRemaining));
    m.ore.position.y = HOVER_Y - f * 1.3;   // sink into the silo tube
    m.ore.position.x = m.destX;
    m.ore.position.z = m.destZ;
    m.halo.position.copy(m.ore.position);
    if (m.haloMat) m.haloMat.opacity = Math.max(0, 0.6 * (1 - f));
    // Extra spin at absorption.
    m.ore.rotation.y += dt * 12;
    m.ore.rotation.x += dt * 8;
    // Cued fuel-absorbed burst at the silo mouth a frame after start,
    // and a second impact at the base once fully absorbed.
    if (m.phaseT - dt <= 0) {
      const mouth = new THREE.Vector3(m.destX, HOVER_Y + 0.2, m.destZ);
      hitBurst(mouth, 0xffd93d, 26);
      hitBurst(mouth, 0xffffff, 14);
      hitBurst(mouth, depot ? depot.tint : 0xff6a1a, 18);
      try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
      shake(0.45, 0.3);
    }
    if (f >= 1) {
      // Final burst at absorption and dispose.
      const impact = new THREE.Vector3(m.destX, 0.6, m.destZ);
      hitBurst(impact, 0xffffff, 20);
      hitBurst(impact, depot ? depot.tint : 0xff6a1a, 14);
      _disposeDepotMegaOre();
      return true;    // signal: wave complete → missile launches
    }
  }

  return false;
}

function _disposeDepotMegaOre() {
  if (!_depotMegaOre) return;
  const m = _depotMegaOre;
  if (m.ore && m.ore.parent) scene.remove(m.ore);
  if (m.halo && m.halo.parent) scene.remove(m.halo);
  if (m.haloGeo) m.haloGeo.dispose();
  if (m.haloMat) m.haloMat.dispose();
  // Rainbow mesh uses cached geometry + materials (shared cache). Do NOT
  // dispose them here — next wave's ore spawns reuse the cache.
  _depotMegaOre = null;
}

export function clearAllOres() {
  for (const o of ores) {
    if (o.mesh && o.mesh.parent) scene.remove(o.mesh);
  }
  ores.length = 0;
  // Also dispose any orbit ring / depot mega ore — they're mining-wave-scoped.
  for (const o of orbitOres) {
    if (o.mesh && o.mesh.parent) scene.remove(o.mesh);
  }
  orbitOres.length = 0;
  _disposeDepotMegaOre();
  _orbitAngle = 0;
}

// --------- DEPOT ---------

// --------- DEPOT SHARED RESOURCES ---------
// v8: REFINERY VISUAL PASS.
// The depot is now a proper industrial refinery — hex platform, central
// crucible (where ores get crushed), tall chimney (with smoke puff FX
// later), catapult arm (for the mega-ore launch), 4 support legs, and
// progressive indicator bands that light up one-by-one as the player
// delivers ores.
//
// Geometries are shared globally; materials cached per chapter tint so
// each chapter's depot compiles exactly once.

// Platform (hex base, stepped)
const DEPOT_PLATE_GEO      = new THREE.CylinderGeometry(3.0, 3.3, 0.45, 6);
const DEPOT_PLATE_STEP_GEO = new THREE.CylinderGeometry(2.5, 2.8, 0.18, 6);
// Central crucible — wide cylinder with a thick rim (where ores get crushed)
const DEPOT_CRUCIBLE_GEO   = new THREE.CylinderGeometry(1.3, 1.5, 1.6, 16, 1, true);
const DEPOT_CRUCIBLE_RIM_GEO = new THREE.TorusGeometry(1.35, 0.14, 6, 20);
const DEPOT_CRUCIBLE_FLOOR_GEO = new THREE.CircleGeometry(1.25, 18);
// Chimney — 3-stage tapered stack
const DEPOT_CHIMNEY_LOW_GEO  = new THREE.CylinderGeometry(0.55, 0.7, 2.0, 10);
const DEPOT_CHIMNEY_MID_GEO  = new THREE.CylinderGeometry(0.42, 0.55, 1.8, 10);
const DEPOT_CHIMNEY_TOP_GEO  = new THREE.CylinderGeometry(0.35, 0.42, 1.4, 10);
const DEPOT_CHIMNEY_CAP_GEO  = new THREE.TorusGeometry(0.38, 0.08, 6, 16);
// Catapult: a boxy arm anchored to a cylinder pivot
const DEPOT_CATAPULT_PIVOT_GEO = new THREE.CylinderGeometry(0.2, 0.2, 0.6, 10);
const DEPOT_CATAPULT_ARM_GEO   = new THREE.BoxGeometry(0.3, 0.3, 3.2);
const DEPOT_CATAPULT_BUCKET_GEO = new THREE.CylinderGeometry(0.45, 0.5, 0.5, 10, 1, true);
// Support legs — 4 boxy legs tucked under the hex plate
const DEPOT_LEG_GEO = new THREE.BoxGeometry(0.28, 1.0, 0.28);
// Indicator bands on the chimney — 5 rings that light up per ore deposited
const DEPOT_IND_BAND_GEO = new THREE.TorusGeometry(0.62, 0.07, 6, 18);

// Legacy — still used for the flat-glow disk in the center and the
// upward-beacon effect. Kept so we don't delete working visuals mid-refactor.
const DEPOT_DISK_GEO = new THREE.CircleGeometry(1.8, 24);
const DEPOT_BEACON_GEO = new THREE.CylinderGeometry(0.35, 0.7, 14, 8, 1, true);

const _depotPlateMatCache    = new Map();
const _depotArmorMatCache    = new Map();
const _depotCrucibleMatCache = new Map();
const _depotIndicatorDimCache = new Map();
const _depotIndicatorLitCache = new Map();
const _depotDiskMatCache     = new Map();
const _depotBeaconMatCache   = new Map();

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

// Dark industrial armor — used for crucible shell, chimney stack, catapult.
// No tint, just a dark slightly-metallic body that reads as machinery.
function _getDepotArmorMat() {
  const key = 'armor';
  let m = _depotArmorMatCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x15151f,
      emissive: 0x0a0a12,
      emissiveIntensity: 0.15,
      metalness: 0.65,
      roughness: 0.55,
    });
    _depotArmorMatCache.set(key, m);
  }
  return m;
}

// Crucible INTERIOR — a hotter emissive material. Gets bumped brighter
// per ore deposited (see _updateDepotDepositVisuals). Clone per-depot
// so the emissive ramp is independent across chapters.
function _getDepotCrucibleMat(tint) {
  let m = _depotCrucibleMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.6,       // baseline at 0 deposits
      metalness: 0.4,
      roughness: 0.6,
      side: THREE.DoubleSide,
    });
    _depotCrucibleMatCache.set(tint, m);
  }
  return m;
}

// Indicator band — dim (unlit) and lit (ore delivered) variants.
function _getDepotIndDimMat(tint) {
  let m = _depotIndicatorDimCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x0a0a12,
      emissive: tint,
      emissiveIntensity: 0.05,      // very faint; reads as "not yet lit"
      metalness: 0.8, roughness: 0.4,
    });
    _depotIndicatorDimCache.set(tint, m);
  }
  return m;
}
function _getDepotIndLitMat(tint) {
  let m = _depotIndicatorLitCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 1.8,       // bright when lit
    });
    _depotIndicatorLitCache.set(tint, m);
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
  _getDepotArmorMat();
  _getDepotCrucibleMat(tint);
  _getDepotIndDimMat(tint);
  _getDepotIndLitMat(tint);
  _getDepotDiskMat(tint);
  _getDepotBeaconMat(tint);
}

/**
 * Build the depot for this mining wave. Placed at a random angle inside
 * the mining triangle. v8 builds a full refinery silhouette — hex
 * platform on support legs, central crucible (where ores crush), tall
 * 3-stage chimney with 5 indicator bands, and a catapult arm that will
 * launch the mega ore toward the silo.
 *
 * Returned depot object exposes refs to the animated pieces so the
 * update loop can drive:
 *   - crucibleMat.emissiveIntensity (brighter per deposit)
 *   - indicatorBands[0..4] swapping from dim→lit mat per deposit
 *   - chimney.position.y  (slight bob)
 *   - catapult.rotation.x (scoop → release swing)
 */
export function spawnDepot(chapterIdx) {
  clearDepot();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.lamp;
  const t = getTriangleFor('mining');
  const jitterA = (Math.random() - 0.5) * 0.4;
  const jitterR = (Math.random() - 0.5) * 6;
  const a = t.centerAngle + jitterA;
  const r = 22 + jitterR;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;

  const group = new THREE.Group();
  group.position.set(x, 0, z);
  // Rotate the depot so the catapult arm points toward the silo (arena
  // center). We use the angle from depot position to (0,0,0), which is
  // -a. Caller-facing: depot group's +Z axis now aims at silo.
  group.rotation.y = Math.atan2(-x, -z);

  // --- SUPPORT LEGS (4 corner boxes under the hex plate) ---
  for (let i = 0; i < 4; i++) {
    const la = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(DEPOT_LEG_GEO, _getDepotArmorMat());
    leg.position.set(Math.cos(la) * 2.1, 0.5, Math.sin(la) * 2.1);
    leg.castShadow = true;
    group.add(leg);
  }

  // --- PLATFORM (hex base, two-stepped) ---
  const plate = new THREE.Mesh(DEPOT_PLATE_GEO, _getDepotPlateMat(tint));
  plate.position.y = 1.15;       // lifted by the legs
  plate.castShadow = true;
  plate.receiveShadow = true;
  group.add(plate);

  const plateStep = new THREE.Mesh(DEPOT_PLATE_STEP_GEO, _getDepotArmorMat());
  plateStep.position.y = 1.5;
  plateStep.castShadow = true;
  group.add(plateStep);

  // --- GLOW DISK (chapter-tinted) on the top of the plate ---
  // Legacy element — keeps the "deposit here" affordance from before.
  const diskMat = _getDepotDiskMat(tint).clone();
  const disk = new THREE.Mesh(DEPOT_DISK_GEO, diskMat);
  disk.rotation.x = -Math.PI / 2;
  disk.position.y = 1.6;
  disk.scale.setScalar(0.85);    // slightly smaller to fit inside the crucible base
  group.add(disk);

  // --- CRUCIBLE (central chamber where ores get crushed) ---
  // Shell + rim + floor. Clone the crucible material per-depot so the
  // emissive ramp (brighter per deposit) doesn't bleed across chapters.
  const crucibleMat = _getDepotCrucibleMat(tint).clone();
  const crucibleShell = new THREE.Mesh(DEPOT_CRUCIBLE_GEO, crucibleMat);
  crucibleShell.position.y = 2.45;   // sits on the stepped plate
  group.add(crucibleShell);

  const crucibleRim = new THREE.Mesh(DEPOT_CRUCIBLE_RIM_GEO, _getDepotArmorMat());
  crucibleRim.position.y = 3.25;
  crucibleRim.rotation.x = Math.PI / 2;
  group.add(crucibleRim);

  // Floor of the crucible — a glowing disc that brightens with the
  // interior (same material as shell so they ramp in lockstep).
  const crucibleFloor = new THREE.Mesh(DEPOT_CRUCIBLE_FLOOR_GEO, crucibleMat);
  crucibleFloor.rotation.x = -Math.PI / 2;
  crucibleFloor.position.y = 1.66;
  group.add(crucibleFloor);

  // --- CHIMNEY (3-stage stack beside the crucible) ---
  // Offset to one side so the catapult has room on the other. Chimney
  // is structurally separate from the crucible — reads as an exhaust
  // stack, not part of the forge.
  const chimney = new THREE.Group();
  chimney.position.set(1.6, 1.65, 0);
  group.add(chimney);

  const chimneyLow = new THREE.Mesh(DEPOT_CHIMNEY_LOW_GEO, _getDepotArmorMat());
  chimneyLow.position.y = 1.0;
  chimneyLow.castShadow = true;
  chimney.add(chimneyLow);

  const chimneyMid = new THREE.Mesh(DEPOT_CHIMNEY_MID_GEO, _getDepotArmorMat());
  chimneyMid.position.y = 2.9;
  chimney.add(chimneyMid);

  const chimneyTop = new THREE.Mesh(DEPOT_CHIMNEY_TOP_GEO, _getDepotArmorMat());
  chimneyTop.position.y = 4.5;
  chimney.add(chimneyTop);

  const chimneyCap = new THREE.Mesh(DEPOT_CHIMNEY_CAP_GEO, _getDepotIndLitMat(tint));
  chimneyCap.position.y = 5.2;
  chimneyCap.rotation.x = Math.PI / 2;
  chimney.add(chimneyCap);

  // --- 5 INDICATOR BANDS (stacked on the chimney low stage) ---
  // Each band starts with the DIM material; when an ore is deposited,
  // updateDepotDepositVisuals() swaps it for the LIT material.
  const indicatorBands = [];
  for (let i = 0; i < 5; i++) {
    const band = new THREE.Mesh(DEPOT_IND_BAND_GEO, _getDepotIndDimMat(tint));
    band.position.y = 0.4 + i * 0.35;
    band.rotation.x = Math.PI / 2;
    chimney.add(band);
    indicatorBands.push(band);
  }

  // --- CATAPULT (pivot + arm + bucket, for the mega-ore launch) ---
  // Anchored to the OPPOSITE side of the crucible from the chimney, on
  // a tall pivot post. The arm rests "loaded" angle (-0.45 rad) — tip
  // lowered into the crucible mouth so at spawn time you can visually
  // tell the ore is about to be scooped. Launch animation will come in
  // Part B; for now the catapult just sits there looking ready.
  const catapult = new THREE.Group();
  catapult.position.set(-1.6, 1.65, 0);
  group.add(catapult);

  const pivot = new THREE.Mesh(DEPOT_CATAPULT_PIVOT_GEO, _getDepotArmorMat());
  pivot.position.y = 0.3;
  catapult.add(pivot);

  // The arm pivots around this inner group — rotating its X will swing
  // the arm end up (launch) or down (load). Positioned so the origin of
  // catapultArm is at the pivot top.
  const catapultArm = new THREE.Group();
  catapultArm.position.y = 0.6;
  catapultArm.rotation.x = -0.45;     // loaded/scoop pose
  catapult.add(catapultArm);

  const arm = new THREE.Mesh(DEPOT_CATAPULT_ARM_GEO, _getDepotArmorMat());
  arm.position.z = 1.4;               // arm extends forward along +Z
  arm.castShadow = true;
  catapultArm.add(arm);

  const bucket = new THREE.Mesh(DEPOT_CATAPULT_BUCKET_GEO, _getDepotArmorMat());
  bucket.position.set(0, 0.1, 2.85);  // at the tip of the arm
  catapultArm.add(bucket);

  // Tall beacon — kept from the original design so the depot reads
  // from across the arena. Moved to the chimney cap area so it plays
  // nice with the new silhouette.
  const beaconMat = _getDepotBeaconMat(tint).clone();
  const beacon = new THREE.Mesh(DEPOT_BEACON_GEO, beaconMat);
  beacon.position.set(0, 7, 0);        // centered above the whole rig
  group.add(beacon);

  const light = null;
  scene.add(group);

  depot = {
    obj: group,
    pos: group.position,
    // Legacy refs the update loop still uses
    plate, disk, beacon, diskMat, beaconMat, light,
    // v8 refinery refs
    crucibleShell, crucibleFloor, crucibleMat,
    chimney, chimneyCap,
    indicatorBands,
    catapult, catapultArm, bucket,
    tint,
    deposited: 0,
    required: MINING_CONFIG.oresRequired,
    pulsePhase: 0,
    active: false,
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

  // Tick orbiting ore ring + mega-ore reveal animation. The flow:
  //   pickup → fly to orbit slot → park → when all 5 parked → smash-merge →
  //   depot mega-ore forms → hover 3.5s → ascend 1s → explode → wave ends.
  // _updateOrbitOres handles the smash. _tickDepotMegaOre owns the full
  // hover-ascend-explode lifecycle and returns true on the frame the
  // explosion fires — THAT frame ends the wave.
  const time = performance.now() / 1000;
  _updateOrbitOres(dt, time);
  const megaExploded = _tickDepotMegaOre(dt, time);
  // depot.deposited mirrors orbit slot count so the "DELIVER ORES ·
  // X / 5" HUD reads from the visible ring. It counts orbiting/parked ores
  // (flying ones are in-transit).
  let parkedOrFlying = 0;
  for (const o of orbitOres) {
    if (o.state === 'flying' || o.state === 'orbiting' || o.state === 'converging') {
      parkedOrFlying++;
    }
  }
  // Count the merged mega ore as all required ores (for post-merge frames
  // before the wave-end handoff).
  const depositedLive = _depotMegaOre ? depot.required : parkedOrFlying;
  depot.deposited = Math.min(depot.required, depositedLive);

  // v8 PROGRESSIVE LIT-UP.
  // As ores arrive, light up indicator bands on the chimney one-by-one
  // and crank the crucible interior's emissive intensity brighter. Both
  // track depot.deposited so the visual state is always in sync with
  // the real count — if an ore gets lost somehow the bands dim back.
  _updateDepotDepositVisuals();

  // Wave completes the frame the mega ore's ascend-explosion finishes.
  if (megaExploded) return true;
  return false;
}

/**
 * Ramp the refinery visuals to match depot.deposited (0-5).
 *
 * Crucible emissive intensity: 0.6 (baseline) → 3.5 (full, all 5 ores).
 * Chimney cap intensity pulses with the crucible.
 * Indicator bands [0..N-1] swap from the DIM material to the LIT material
 * as each ore arrives; remaining bands stay DIM.
 *
 * Safe to call every frame — changing material.emissiveIntensity is
 * cheap, and we only reassign band.material when it actually differs.
 */
function _updateDepotDepositVisuals() {
  if (!depot || !depot.crucibleMat) return;
  const count = depot.deposited || 0;
  // Crucible: linear ramp from 0.6 → 3.5 across 0→5 ores, with a small
  // sine wobble so the "molten" glow doesn't read as a flat light.
  const base = 0.6 + (count / depot.required) * 2.9;
  const wobble = Math.sin((depot.pulsePhase || 0) * 3.5) * 0.15;
  depot.crucibleMat.emissiveIntensity = Math.max(0.3, base + wobble);

  // Indicator bands — swap materials per count. The DIM → LIT mats are
  // cached globally per tint so we can freely swap back and forth if
  // deposit count drops (shouldn't normally but the code is defensive).
  const litMat = _getDepotIndLitMat(depot.tint);
  const dimMat = _getDepotIndDimMat(depot.tint);
  if (depot.indicatorBands) {
    for (let i = 0; i < depot.indicatorBands.length; i++) {
      const shouldBeLit = i < count;
      const b = depot.indicatorBands[i];
      const wanted = shouldBeLit ? litMat : dimMat;
      if (b.material !== wanted) b.material = wanted;
    }
  }
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
