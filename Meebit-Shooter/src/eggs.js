// eggs.js — Green everlasting gobstopper EGG spawning for the
// chapter-1 reflow. Replaces the falling mining blocks with 4 eggs
// hand-loaded into the depot wedge. Player shoots each egg ~20 times
// to crack and shatter it, dropping a charge pickup the player walks
// over to collect.
//
// Design choices:
//   - Eggs join the existing `blocks` array as objects with kind:'egg'.
//     Why: the bullet → block hit code in main.js already iterates
//     blocks for every weapon (pistol, smg, shotgun, rocket, raygun,
//     flame, lifedrainer). Adding kind='egg' lets us reuse all that
//     hit detection without touching 6+ weapon code paths.
//   - Egg-kind blocks override the visual mesh (green emissive ovoid
//     with a thin gold band) but use the standard hp/scale/hitFlash
//     fields so existing damageBlock logic runs unchanged.
//   - On shatter, eggs drop a single ore (the "charge" residue). They
//     do NOT trigger the block AoE explosion handler — that's a
//     mining-block flavor and would feel wrong for eggs.
//
// Public API:
//   spawnEggsInDepotWedge(chapterIdx, count = 4)  — place 4 eggs
//   isEgg(block)                                  — true if kind:'egg'
//   shouldEggDropOre(block)                       — true once for the egg
//   onEggDestroyed(block)                         — called from blocks.js
//                                                  when an egg's hp drops
//                                                  to 0; returns ore drop pos

import * as THREE from 'three';
import { scene } from './scene.js';
import { BLOCK_CONFIG, ARENA } from './config.js';
import { hitBurst } from './effects.js';
import { shake } from './state.js';
import { blocks } from './blocks.js';
import { spawnOre, depot } from './ores.js';
import { getTriangleFor } from './triangles.js';

// ---- Visuals ----
// Egg radius — slightly larger than block half-size so the egg reads
// as a similar volume to a mining block. Ovoid: scaled along Y so it's
// taller than wide, like an actual egg.
const EGG_RADIUS = 0.85;
const EGG_HEIGHT_SCALE = 1.15;        // y-stretch factor — eggs are ovoid
const EGG_HP = 20;                    // ~20 shots per user spec
const EGG_GREEN = 0x66ff66;           // bright green
const EGG_GREEN_DEEP = 0x44cc44;      // deeper green for body
const EGG_BAND_GOLD = 0xffd633;       // gold band for accent

const _eggBodyGeo = new THREE.SphereGeometry(EGG_RADIUS, 20, 14);
const _eggBandGeo = new THREE.TorusGeometry(EGG_RADIUS * 0.78, EGG_RADIUS * 0.10, 8, 24);

function _getEggBodyMat() {
  // Cached singleton — all 4 eggs share the same material. We'll clone
  // per-instance only if we need per-egg hitFlash animation (we do —
  // existing damageBlock code mutates emissiveIntensity).
  return new THREE.MeshStandardMaterial({
    color: EGG_GREEN_DEEP,
    emissive: EGG_GREEN,
    emissiveIntensity: 0.5,
    roughness: 0.35,
    metalness: 0.1,
  });
}

function _getEggBandMat() {
  return new THREE.MeshStandardMaterial({
    color: EGG_BAND_GOLD,
    emissive: EGG_BAND_GOLD,
    emissiveIntensity: 0.7,
    roughness: 0.4,
    metalness: 0.6,
  });
}

/** Build a single egg group: ovoid green body + thin gold equatorial band.
 *  The band is a child mesh so it tracks any hitFlash scale animation
 *  on the parent group. */
function _buildEgg() {
  const group = new THREE.Group();

  // Body — sphere stretched along Y for ovoid shape
  const bodyMat = _getEggBodyMat().clone();    // clone for per-egg flash anim
  const body = new THREE.Mesh(_eggBodyGeo, bodyMat);
  body.scale.y = EGG_HEIGHT_SCALE;
  body.castShadow = true;
  group.add(body);
  group.userData.body = body;
  group.userData.bodyMat = bodyMat;

  // Equatorial gold band — encircles the egg at its widest point
  const bandMat = _getEggBandMat();
  const band = new THREE.Mesh(_eggBandGeo, bandMat);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0;
  group.add(band);

  return group;
}

/** Pick 4 positions clustered in the depot wedge, spaced apart. The
 *  depot wedge is the triangle sector containing the depot beacon.
 *  We cluster the eggs in the OUTER half of that wedge (away from the
 *  depot itself) so the player can mine them and then walk inward to
 *  the beacon to deliver. */
function _pickEggPositions(count) {
  const t = getTriangleFor('mining');     // depot is in the mining wedge
  const halfWidth = (t.maxAngle - t.minAngle) / 2;
  const positions = [];
  const MIN_SEPARATION = 4.0;
  const MIN_SEPARATION_SQ = MIN_SEPARATION * MIN_SEPARATION;

  for (let i = 0; i < count; i++) {
    let x = 0, z = 0;
    let placed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      // Sample within the wedge, biased toward the OUTER half
      // (radius 14-26) so eggs aren't on top of the depot beacon.
      const angle = t.centerAngle + (Math.random() - 0.5) * 1.8 * halfWidth;
      const radius = 14 + Math.random() * 12;
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
      // Keep eggs at least MIN_SEPARATION apart from each other
      let tooClose = false;
      for (const p of positions) {
        const ddx = x - p.x, ddz = z - p.z;
        if (ddx * ddx + ddz * ddz < MIN_SEPARATION_SQ) { tooClose = true; break; }
      }
      if (tooClose) continue;
      // Keep eggs at least 3.5u from the depot itself
      if (depot && depot.pos) {
        const ddx = x - depot.pos.x, ddz = z - depot.pos.z;
        if (ddx * ddx + ddz * ddz < 3.5 * 3.5) continue;
      }
      placed = true;
      break;
    }
    positions.push({ x, z, placed });
  }
  return positions;
}

/** Spawn `count` eggs in the depot wedge. Each egg is added to the
 *  shared `blocks` array with kind:'egg' so the existing bullet hit
 *  detection treats them as targetable objects. Returns the spawned
 *  egg objects. */
export function spawnEggsInDepotWedge(chapterIdx, count = 4) {
  const positions = _pickEggPositions(count);
  const spawned = [];
  for (const p of positions) {
    const group = _buildEgg();
    const restY = EGG_RADIUS * EGG_HEIGHT_SCALE;
    group.position.set(p.x, restY, p.z);
    scene.add(group);

    // Push onto the shared blocks array so all bullet code finds it.
    // Mark with kind:'egg' so blocks.js / main.js code can branch on
    // egg-specific behavior (no AoE on death, drop charge ore, etc).
    const egg = {
      mesh: group,
      shadow: null,           // eggs don't have a falling shadow
      pos: group.position,
      targetY: restY,
      hp: EGG_HP,
      hpMax: EGG_HP,
      falling: false,         // eggs are placed, not falling
      hitFlash: 0,
      chapterIdx,
      color: EGG_GREEN,
      kind: 'egg',
      targetScale: 1.0,
      currentScale: 1.0,
    };
    blocks.push(egg);
    spawned.push(egg);
  }
  return spawned;
}

/** True if a block-array entry is an egg (kind:'egg'). */
export function isEgg(block) {
  return block && block.kind === 'egg';
}

/** Called from blocks.js damageBlock when an egg's hp hits 0. Spawns
 *  a charge ore at the egg's position, plays the shatter VFX, and
 *  removes the egg mesh from the scene. Returns true so blocks.js
 *  knows to skip its normal block-explosion + ore-spawn path. */
export function destroyEgg(egg) {
  // Shatter VFX — green burst + gold sparkle + small shake
  const burstPos = new THREE.Vector3(egg.pos.x, egg.pos.y + 0.3, egg.pos.z);
  hitBurst(burstPos, EGG_GREEN, 28);
  hitBurst(burstPos, EGG_BAND_GOLD, 10);
  shake(0.30, 0.18);

  // Drop a charge ore at the egg position. spawnOre uses rainbow
  // visual regardless of tint, so the player sees a familiar
  // collectable. The tint argument is kept for API compat.
  spawnOre(egg.pos.x, egg.pos.z, EGG_GREEN, egg.chapterIdx || 0);

  // Remove the mesh from scene
  if (egg.mesh && egg.mesh.parent) scene.remove(egg.mesh);

  return true;
}

/** Clear all live eggs (e.g. on game reset). The shared blocks array
 *  is cleaned by blocks.js's clearAllBlocks(); here we just have to
 *  remove egg meshes from the scene if any survived. */
export function clearAllEggs() {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'egg') {
      if (b.mesh && b.mesh.parent) scene.remove(b.mesh);
      blocks.splice(i, 1);
    }
  }
}
