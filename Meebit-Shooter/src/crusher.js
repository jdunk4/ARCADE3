// crusher.js — Chapter-1 reflow industrial-press prop. Visually
// replaces the depot for chapter 1: same world position, same
// gameplay role (deposit ores), but a much more legible "crush
// the ore" verb than the depot's rocket-launcher silhouette.
//
// Visual:
//   - Heavy concrete/metal base block
//   - Two pillars rising up + crossbeam at the top
//   - Hammer head on a vertical piston that slams down between pillars
//   - Glowing impact zone (anvil) where ores get crushed
//   - Conveyor input strip on one side, output chute on the other
//   - Chapter-tinted accents matching the cannon
//
// Animation:
//   - Idle: hammer hovers at rest position, slow piston exhale (subtle)
//   - Slam (per ore deposit): hammer rises briefly + slams down
//     hard with shake + chapter-tinted impact burst at the anvil
//   - Finisher (wave-1 end): 3 rapid slams + huge sparks + glow flare
//
// The underlying game logic still uses depot.deposited etc. via
// ores.js; this module is purely visual. spawnDepot still runs but
// we hide depot.obj when the crusher takes over.
//
// Public API:
//   spawnCrusher(chapterIdx, posX, posZ)
//   clearCrusher()
//   hasCrusher()
//   triggerCrusherSlam()       — call once per ore deposited
//   triggerCrusherFinisher()   — call at wave-1 end (mega crush)
//   updateCrusher(dt)          — per-frame animation tick

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { shake } from './state.js';
import { Audio } from './audio.js';

// ---- Geometry singletons ----
const BASE_GEO        = new THREE.BoxGeometry(4.0, 0.6, 3.0);
const PILLAR_GEO      = new THREE.BoxGeometry(0.4, 4.5, 0.5);
const CROSSBEAM_GEO   = new THREE.BoxGeometry(4.0, 0.5, 0.6);
const PISTON_GEO      = new THREE.CylinderGeometry(0.18, 0.18, 3.0, 12);
const HAMMER_HEAD_GEO = new THREE.BoxGeometry(2.6, 0.8, 1.6);
const ANVIL_GEO       = new THREE.BoxGeometry(2.2, 0.3, 1.4);
const ANVIL_GLOW_GEO  = new THREE.PlaneGeometry(2.2, 1.4);
const CONVEYOR_GEO    = new THREE.BoxGeometry(2.0, 0.15, 1.0);
const CONVEYOR_TRIM_GEO = new THREE.BoxGeometry(2.0, 0.05, 0.08);
const SPARKS_PORT_GEO = new THREE.SphereGeometry(0.18, 10, 8);

// ---- Materials ----
function _heavyMetalMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x4a4d56, roughness: 0.55, metalness: 0.85,
    emissive: 0x1a1d24, emissiveIntensity: 0.15,
  });
}
function _baseMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x2a2c34, roughness: 0.95, metalness: 0.1,
  });
}
function _hammerMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: 0x5a5d68, roughness: 0.4, metalness: 0.9,
    emissive: tint, emissiveIntensity: 0.18,
  });
}
function _anvilMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x252830, roughness: 0.5, metalness: 0.7,
    emissive: 0x301010, emissiveIntensity: 0.25,
  });
}
function _anvilGlowMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.0,    // off when idle
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
function _conveyorMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x1a1c22, roughness: 0.95, metalness: 0.05,
  });
}
function _trimMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: tint, emissive: tint, emissiveIntensity: 0.7,
    roughness: 0.4, metalness: 0.6,
  });
}

// ---- Module state ----
let _crusher = null;
//
// Shape:
// {
//   group, hammer, piston, anvilGlowMat, sparkMats: [Material x4],
//   tint, hammerRestY, hammerSlamY,
//   slamPhase: 'idle' | 'rising' | 'slamming' | 'recover',
//   slamT: number,
//   finisherActive: boolean, finisherSlamsLeft: number,
//   idleT: number,
// }

const HAMMER_REST_Y = 4.8;             // resting height of hammer head
const HAMMER_SLAM_Y = 1.05;            // hammer head meets anvil at y ≈ 1.05
const SLAM_RISE_DURATION = 0.18;
const SLAM_DROP_DURATION = 0.10;       // fast drop — heavy hit
const SLAM_RECOVER_DURATION = 0.45;    // slow back up to rest

/** Build the crusher prop at the given world XZ position. */
export function spawnCrusher(chapterIdx, posX, posZ) {
  if (_crusher) clearCrusher();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  const group = new THREE.Group();
  group.position.set(posX, 0, posZ);

  // --- Concrete base pad ---
  const base = new THREE.Mesh(BASE_GEO, _baseMat());
  base.position.y = 0.30;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // --- Anvil — heavy metal block ON the base where ores get crushed ---
  const anvil = new THREE.Mesh(ANVIL_GEO, _anvilMat());
  anvil.position.set(0, 0.75, 0);
  anvil.castShadow = true;
  group.add(anvil);

  // --- Anvil glow disc — flat plane on top of anvil that flashes
  //     chapter-tinted on each slam ---
  const anvilGlowMat = _anvilGlowMat(tint);
  const anvilGlow = new THREE.Mesh(ANVIL_GLOW_GEO, anvilGlowMat);
  anvilGlow.rotation.x = -Math.PI / 2;
  anvilGlow.position.set(0, 0.92, 0);     // just above anvil top
  group.add(anvilGlow);

  // --- 2 vertical pillars — one each side of the anvil ---
  const pillarLeft = new THREE.Mesh(PILLAR_GEO, _heavyMetalMat());
  pillarLeft.position.set(-1.7, 0.6 + 2.25, 0);
  pillarLeft.castShadow = true;
  group.add(pillarLeft);
  const pillarRight = new THREE.Mesh(PILLAR_GEO, _heavyMetalMat());
  pillarRight.position.set(1.7, 0.6 + 2.25, 0);
  pillarRight.castShadow = true;
  group.add(pillarRight);

  // --- Crossbeam at the top connecting the pillars ---
  const crossbeam = new THREE.Mesh(CROSSBEAM_GEO, _heavyMetalMat());
  crossbeam.position.set(0, 0.6 + 4.5 + 0.25, 0);
  crossbeam.castShadow = true;
  group.add(crossbeam);

  // --- Piston — vertical cylinder hanging from crossbeam down to hammer ---
  const piston = new THREE.Mesh(PISTON_GEO, _heavyMetalMat());
  piston.position.set(0, HAMMER_REST_Y + 1.0, 0);     // mid-piston above hammer
  group.add(piston);

  // --- Hammer head — slabs of heavy metal that slams down ---
  const hammer = new THREE.Mesh(HAMMER_HEAD_GEO, _hammerMat(tint));
  hammer.position.set(0, HAMMER_REST_Y, 0);
  hammer.castShadow = true;
  group.add(hammer);

  // --- Conveyor strip on the input side (-X direction) ---
  const conveyor = new THREE.Mesh(CONVEYOR_GEO, _conveyorMat());
  conveyor.position.set(-3.0, 0.68, 0);
  conveyor.castShadow = true;
  group.add(conveyor);
  // Conveyor accent trim — chapter-tinted strips along the edges
  const conveyorTrim1 = new THREE.Mesh(CONVEYOR_TRIM_GEO, _trimMat(tint));
  conveyorTrim1.position.set(-3.0, 0.78, 0.50);
  group.add(conveyorTrim1);
  const conveyorTrim2 = new THREE.Mesh(CONVEYOR_TRIM_GEO, _trimMat(tint));
  conveyorTrim2.position.set(-3.0, 0.78, -0.50);
  group.add(conveyorTrim2);

  // --- Output chute on opposite side (+X) — angled box ---
  const chute = new THREE.Mesh(CONVEYOR_GEO, _conveyorMat());
  chute.position.set(3.0, 0.50, 0);
  chute.rotation.z = -0.25;     // angled down for "discharge" feel
  group.add(chute);
  // Chute trim
  const chuteTrim = new THREE.Mesh(CONVEYOR_TRIM_GEO, _trimMat(tint));
  chuteTrim.position.set(3.0, 0.62, 0.5);
  chuteTrim.rotation.z = -0.25;
  group.add(chuteTrim);

  // --- Spark ports — 4 small tinted spheres ringing the anvil base
  //     that flash on slam ---
  const sparkMats = [];
  const sparkPositions = [
    { x: -1.0, z: 0.6 },
    { x:  1.0, z: 0.6 },
    { x: -1.0, z: -0.6 },
    { x:  1.0, z: -0.6 },
  ];
  for (const sp of sparkPositions) {
    const sparkMat = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.2,
      toneMapped: false,
    });
    const spark = new THREE.Mesh(SPARKS_PORT_GEO, sparkMat);
    spark.position.set(sp.x, 0.78, sp.z);
    group.add(spark);
    sparkMats.push(sparkMat);
  }

  scene.add(group);

  _crusher = {
    group, hammer, piston, anvil, anvilGlow, anvilGlowMat,
    sparkMats, tint, posX, posZ,
    slamPhase: 'idle',
    slamT: 0,
    finisherActive: false,
    finisherSlamsLeft: 0,
    finisherDelay: 0,
    idleT: 0,
  };
}

/** True when a crusher is in the scene. */
export function hasCrusher() {
  return !!_crusher;
}

/** Trigger a single slam — hammer rises briefly then slams down on
 *  the anvil with a tinted impact burst + shake. Called once per
 *  ore deposited at the depot during chapter 1 wave 1. */
export function triggerCrusherSlam() {
  if (!_crusher) return;
  // Don't interrupt a finisher; just queue if needed (drop the request)
  if (_crusher.finisherActive) return;
  _crusher.slamPhase = 'rising';
  _crusher.slamT = 0;
}

/** Trigger the wave-1-end mega-crush finisher: 3 rapid slams + huge
 *  sparks + glow flare. Called once when the player completes wave 1. */
export function triggerCrusherFinisher() {
  if (!_crusher) return;
  _crusher.finisherActive = true;
  _crusher.finisherSlamsLeft = 3;
  _crusher.finisherDelay = 0;
  _crusher.slamPhase = 'rising';
  _crusher.slamT = 0;
}

/** Per-frame update — animate slam phases, idle piston exhale. */
export function updateCrusher(dt) {
  if (!_crusher) return;
  _crusher.idleT += dt;

  // Idle piston exhale — subtle vertical bob when no slam is active
  if (_crusher.slamPhase === 'idle') {
    const bob = Math.sin(_crusher.idleT * 1.2) * 0.04;
    _crusher.hammer.position.y = HAMMER_REST_Y + bob;
    _crusher.piston.position.y = HAMMER_REST_Y + 1.0 + bob;
    // Glow disc fades out after a slam
    if (_crusher.anvilGlowMat.opacity > 0) {
      _crusher.anvilGlowMat.opacity = Math.max(0, _crusher.anvilGlowMat.opacity - dt * 1.8);
    }
    // Spark ports dim back to idle
    for (const sm of _crusher.sparkMats) {
      if (sm.opacity > 0.2) sm.opacity = Math.max(0.2, sm.opacity - dt * 1.5);
    }
    return;
  }

  _crusher.slamT += dt;

  if (_crusher.slamPhase === 'rising') {
    // Hammer lifts up slightly preparing to slam
    const f = Math.min(1, _crusher.slamT / SLAM_RISE_DURATION);
    const eased = f * f;
    const RISE_ABOVE_REST = 0.6;
    const y = HAMMER_REST_Y + RISE_ABOVE_REST * eased;
    _crusher.hammer.position.y = y;
    _crusher.piston.position.y = y + 1.0;
    if (f >= 1) {
      _crusher.slamPhase = 'slamming';
      _crusher.slamT = 0;
    }
  } else if (_crusher.slamPhase === 'slamming') {
    // Hammer slams DOWN fast onto the anvil
    const f = Math.min(1, _crusher.slamT / SLAM_DROP_DURATION);
    const eased = 1 - (1 - f) * (1 - f);     // ease-out (heavy gravity)
    const startY = HAMMER_REST_Y + 0.6;
    const y = startY + (HAMMER_SLAM_Y - startY) * eased;
    _crusher.hammer.position.y = y;
    _crusher.piston.position.y = y + 1.0;
    if (f >= 1) {
      // IMPACT! Big flash + burst + shake
      const worldX = _crusher.posX;
      const worldZ = _crusher.posZ;
      const isFinisher = _crusher.finisherActive;
      const intensity = isFinisher ? 2.0 : 1.0;
      // Tinted core flash + white hot center
      hitBurst(new THREE.Vector3(worldX, 1.1, worldZ), 0xffffff, Math.round(20 * intensity));
      hitBurst(new THREE.Vector3(worldX, 1.1, worldZ), _crusher.tint, Math.round(34 * intensity));
      // Anvil glow disc flares chapter-tinted
      _crusher.anvilGlowMat.opacity = isFinisher ? 1.0 : 0.85;
      // Spark ports flash
      for (const sm of _crusher.sparkMats) sm.opacity = isFinisher ? 1.0 : 0.85;
      shake(isFinisher ? 0.7 : 0.45, isFinisher ? 0.4 : 0.25);
      try { Audio.crusherSlam && Audio.crusherSlam(); } catch (e) {}
      _crusher.slamPhase = 'recover';
      _crusher.slamT = 0;
    }
  } else if (_crusher.slamPhase === 'recover') {
    // Hammer slowly rises back to rest position
    const f = Math.min(1, _crusher.slamT / SLAM_RECOVER_DURATION);
    const eased = f * f;
    const startY = HAMMER_SLAM_Y;
    const y = startY + (HAMMER_REST_Y - startY) * eased;
    _crusher.hammer.position.y = y;
    _crusher.piston.position.y = y + 1.0;
    // Glow disc fades during recover
    _crusher.anvilGlowMat.opacity = Math.max(0, _crusher.anvilGlowMat.opacity - dt * 1.5);
    if (f >= 1) {
      // Recovered. If we're in a finisher and have more slams queued,
      // start the next one. Otherwise return to idle.
      if (_crusher.finisherActive && _crusher.finisherSlamsLeft > 1) {
        _crusher.finisherSlamsLeft--;
        _crusher.slamPhase = 'rising';
        _crusher.slamT = 0;
      } else {
        _crusher.finisherActive = false;
        _crusher.finisherSlamsLeft = 0;
        _crusher.slamPhase = 'idle';
        _crusher.slamT = 0;
      }
    }
  }
}

/** Remove the crusher from the scene (chapter exit / reset). */
export function clearCrusher() {
  if (!_crusher) return;
  if (_crusher.group && _crusher.group.parent) scene.remove(_crusher.group);
  if (_crusher.anvilGlowMat && _crusher.anvilGlowMat.dispose) _crusher.anvilGlowMat.dispose();
  for (const sm of _crusher.sparkMats || []) {
    if (sm && sm.dispose) sm.dispose();
  }
  _crusher = null;
}
