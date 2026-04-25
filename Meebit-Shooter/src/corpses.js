// corpses.js — Drained-color dead enemy bodies scattered across the
// arena at chapter 7 entry. Environmental storytelling: chapters 1-6
// happened, the population fought, they LOST. Their bodies remain.
//
// Design choices:
//   - We use simplified box-stack humanoid silhouettes (head + body +
//     limbs) rather than the full enemies.js humanoid builder, which
//     is heavier and tied to game logic. Corpses are pure decoration.
//   - All corpses use a single shared grey/desaturated material so we
//     can spawn 30+ without GPU stress.
//   - Corpses are laid FLAT on the floor (rotation.x = -π/2 on the
//     group, with the body parts arranged so that "lying down" reads
//     correctly from a top-down camera).
//   - Spawn positions are random within the arena, but kept clear of
//     the spawn point (player start) and outside the safe radius so
//     they don't visually clutter combat zones.
//
// Public API:
//   scatterCorpses(count = 35)   — spawn corpses across the arena.
//   clearCorpses()                — remove all corpse meshes from scene.

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA } from './config.js';

const corpses = [];     // array of THREE.Group

// Drained palette — desaturated muted greys with a tiny purple tint so
// they don't read as pure neutral grey (which can look like
// placeholder geometry).
const CORPSE_BODY_COLOR = 0x3a3640;
const CORPSE_HEAD_COLOR = 0x4a4550;
const CORPSE_LIMB_COLOR = 0x2e2a34;

const _bodyMat = new THREE.MeshStandardMaterial({
  color: CORPSE_BODY_COLOR,
  roughness: 0.95,
  metalness: 0.0,
});
const _headMat = new THREE.MeshStandardMaterial({
  color: CORPSE_HEAD_COLOR,
  roughness: 0.95,
  metalness: 0.0,
});
const _limbMat = new THREE.MeshStandardMaterial({
  color: CORPSE_LIMB_COLOR,
  roughness: 0.95,
  metalness: 0.0,
});

// Shared geometries for cheap repeated spawns
const _torsoGeo = new THREE.BoxGeometry(0.7, 1.0, 0.4);
const _headGeo  = new THREE.BoxGeometry(0.5, 0.5, 0.5);
const _limbGeo  = new THREE.BoxGeometry(0.22, 0.7, 0.22);

// Spawn-keep-clear radius around origin (player start)
const KEEP_CLEAR_RADIUS = 6.0;

/** Build a single corpse group laid flat on the floor. The "head"
 * is offset along +Z (so when laid flat, head points "up" on the
 * floor — looks like a body lying on its back). Limbs are offset
 * akimbo to read as a sprawled corpse rather than a tidy stack. */
function _buildCorpse() {
  const group = new THREE.Group();

  // Torso — centered on origin
  const torso = new THREE.Mesh(_torsoGeo, _bodyMat);
  torso.position.y = 0.05;     // slightly off floor to avoid z-fighting
  group.add(torso);

  // Head — forward of torso (+Z) and slightly above
  const head = new THREE.Mesh(_headGeo, _headMat);
  head.position.set(0, 0.05, 0.7);
  group.add(head);

  // Arms — off to the sides at akimbo angles. Each arm is rotated
  // slightly outward to read as sprawled.
  const armL = new THREE.Mesh(_limbGeo, _limbMat);
  armL.position.set(-0.55, 0.05, 0.15);
  armL.rotation.z = Math.PI / 2 + 0.4;     // pointing out
  group.add(armL);
  const armR = new THREE.Mesh(_limbGeo, _limbMat);
  armR.position.set(0.55, 0.05, 0.15);
  armR.rotation.z = -Math.PI / 2 - 0.4;
  group.add(armR);

  // Legs — pointing back (-Z), slightly splayed
  const legL = new THREE.Mesh(_limbGeo, _limbMat);
  legL.position.set(-0.18, 0.05, -0.65);
  legL.rotation.x = Math.PI / 2;
  legL.rotation.z = 0.15;
  group.add(legL);
  const legR = new THREE.Mesh(_limbGeo, _limbMat);
  legR.position.set(0.18, 0.05, -0.65);
  legR.rotation.x = Math.PI / 2;
  legR.rotation.z = -0.15;
  group.add(legR);

  // Whole group laid flat: tip the body forward so it's on its back
  // on the ground rather than standing up. We do this by rotating the
  // GROUP around the X axis so the body's vertical (Y) axis becomes
  // horizontal (along world Z).
  group.rotation.x = -Math.PI / 2;

  return group;
}

/** Spawn `count` corpses at random arena positions with random yaw.
 * Idempotent in the sense that calling twice scatters even more
 * corpses, but typical use is "call once at chapter 7 entry."
 * Returns the number actually spawned. */
export function scatterCorpses(count = 35) {
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    // Pick a position somewhere in the arena, NOT too close to the
    // player spawn (origin) so the corpses are environmental rather
    // than claustrophobic.
    let x, z;
    let attempts = 0;
    do {
      x = (Math.random() * 2 - 1) * (ARENA - 5);
      z = (Math.random() * 2 - 1) * (ARENA - 5);
      attempts++;
    } while (
      x * x + z * z < KEEP_CLEAR_RADIUS * KEEP_CLEAR_RADIUS
      && attempts < 8
    );

    const corpse = _buildCorpse();
    corpse.position.set(x, 0, z);
    // Random yaw around the world Y axis — we already rotated the
    // group around X to lay it flat, so the world-space Y rotation
    // is achieved via rotation.z on the already-rotated group (since
    // rotation.x = -π/2 maps the group's local Z to world Y).
    corpse.rotation.z = Math.random() * Math.PI * 2;
    scene.add(corpse);
    corpses.push(corpse);
    spawned++;
  }
  return spawned;
}

/** Remove all corpses from the scene. Called on game reset and on
 * chapter 7 exit (if such an exit is ever triggered). */
export function clearCorpses() {
  for (const c of corpses) {
    if (c.parent) scene.remove(c);
  }
  corpses.length = 0;
}
