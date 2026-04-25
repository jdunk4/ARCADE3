// Pickups — world items that drop from enemies on death and are
// collected by the player walking over them.
//
// Two kinds:
//   POTION   — heals the player on pickup if HP < max, otherwise
//              banks into S.potions slot (cap 3). Bound to H key
//              to use one when desired.
//   GRENADE  — adds to S.grenadeCharges (cap 3). Throw with G as
//              before.
//
// Drops happen probabilistically inside killEnemy (see main.js).
// Bosses always drop a potion + grenade. Regular enemies have a
// small chance per kill.
//
// Pickup geometry is cheap: a flask shape for potions (small flat
// cylinder + cone neck) and a tinted sphere for grenades. Both
// hover and bob slightly so they read as world items vs decoration,
// and have a colored ring beneath them for visual readability over
// hazards/grass.

import * as THREE from 'three';
import { scene } from './scene.js';
import { S } from './state.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';

// ----- TUNING -----
export const POTION_MAX        = 3;          // max held by player
export const GRENADE_MAX       = 3;          // max held by player
export const POTION_HEAL       = 50;          // HP restored per use
export const POTION_DROP_CHANCE = 0.06;      // 6% per regular enemy kill
export const GRENADE_DROP_CHANCE = 0.05;     // 5% per regular enemy kill
const PICKUP_RADIUS_SQ = 1.6 * 1.6;          // player must be within this dist
const HOVER_AMPLITUDE = 0.15;                 // bob height
const HOVER_FREQUENCY = 2.4;                  // bob speed (rad/sec)
const SPAWN_POP_DURATION = 0.35;              // initial scale-in animation

// ----- GEOMETRY (shared, allocated once) -----
const POTION_BOTTLE_GEO = new THREE.CylinderGeometry(0.22, 0.28, 0.45, 10);
const POTION_NECK_GEO   = new THREE.CylinderGeometry(0.10, 0.10, 0.18, 8);
const POTION_CAP_GEO    = new THREE.CylinderGeometry(0.13, 0.13, 0.08, 8);
const GRENADE_BODY_GEO  = new THREE.SphereGeometry(0.28, 12, 10);
const GRENADE_PIN_GEO   = new THREE.TorusGeometry(0.08, 0.025, 6, 12);
const GRENADE_LEVER_GEO = new THREE.BoxGeometry(0.10, 0.35, 0.05);
const RING_GEO          = new THREE.RingGeometry(0.45, 0.55, 24);

// ----- MATERIALS (shared) -----
const _potionGlass = new THREE.MeshStandardMaterial({
  color: 0xff3366,
  emissive: 0xff1144,
  emissiveIntensity: 0.6,
  transparent: true,
  opacity: 0.85,
  metalness: 0.1,
  roughness: 0.3,
});
const _potionCorkMat = new THREE.MeshStandardMaterial({
  color: 0x6b4422,
  metalness: 0.2,
  roughness: 0.8,
});
const _grenadeBodyMat = new THREE.MeshStandardMaterial({
  color: 0x4a6b35,
  emissive: 0x2a3a18,
  emissiveIntensity: 0.3,
  metalness: 0.6,
  roughness: 0.5,
});
const _grenadePinMat = new THREE.MeshStandardMaterial({
  color: 0xc8c8a8,
  metalness: 0.9,
  roughness: 0.2,
});
const _potionRingMat = new THREE.MeshBasicMaterial({
  color: 0xff3366,
  transparent: true,
  opacity: 0.55,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const _grenadeRingMat = new THREE.MeshBasicMaterial({
  color: 0x88ff55,
  transparent: true,
  opacity: 0.55,
  side: THREE.DoubleSide,
  depthWrite: false,
});

// ----- STATE -----
const pickups = [];   // { obj, kind: 'potion'|'grenade', pos, age, spawnT }

// ---------------------------------------------------------------------
// SPAWN
// ---------------------------------------------------------------------

/**
 * Build a potion mesh — small bottle with neck + cap + glowing ground ring.
 */
function _buildPotionMesh() {
  const g = new THREE.Group();
  const bottle = new THREE.Mesh(POTION_BOTTLE_GEO, _potionGlass);
  bottle.position.y = 0.225;
  g.add(bottle);
  const neck = new THREE.Mesh(POTION_NECK_GEO, _potionGlass);
  neck.position.y = 0.54;
  g.add(neck);
  const cork = new THREE.Mesh(POTION_CAP_GEO, _potionCorkMat);
  cork.position.y = 0.66;
  g.add(cork);
  const ring = new THREE.Mesh(RING_GEO, _potionRingMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  g.add(ring);
  return g;
}

/**
 * Build a grenade mesh — pineapple-style body with safety pin/lever
 * detail + glowing green ground ring.
 */
function _buildGrenadeMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(GRENADE_BODY_GEO, _grenadeBodyMat);
  body.position.y = 0.28;
  // Slight squish to make it more "pineapple grenade" shaped
  body.scale.y = 1.05;
  g.add(body);
  const pin = new THREE.Mesh(GRENADE_PIN_GEO, _grenadePinMat);
  pin.position.set(0.08, 0.55, 0);
  pin.rotation.x = Math.PI / 2;
  g.add(pin);
  const lever = new THREE.Mesh(GRENADE_LEVER_GEO, _grenadePinMat);
  lever.position.set(0.18, 0.42, 0);
  lever.rotation.z = -0.3;
  g.add(lever);
  const ring = new THREE.Mesh(RING_GEO, _grenadeRingMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  g.add(ring);
  return g;
}

/**
 * Drop a pickup at the given world position. Called from killEnemy in
 * main.js when the per-enemy drop rolls succeed. The position should
 * be the enemy's last known pos (clone before they're removed).
 *
 * @param {'potion'|'grenade'} kind
 * @param {THREE.Vector3} pos
 */
export function spawnPickup(kind, pos) {
  const mesh = (kind === 'potion') ? _buildPotionMesh() : _buildGrenadeMesh();
  mesh.position.copy(pos);
  mesh.position.y = 0;
  // Initial scale 0 — pops up to 1 over SPAWN_POP_DURATION via the
  // update loop. Cheap visual telegraph that something just dropped.
  mesh.scale.setScalar(0.001);
  scene.add(mesh);
  pickups.push({
    obj: mesh,
    kind,
    pos: mesh.position,
    age: 0,
    spawnT: 0,    // 0..1 over SPAWN_POP_DURATION
  });
}

// ---------------------------------------------------------------------
// PICKUP COLLECTION
// ---------------------------------------------------------------------

/**
 * Apply the effect of a potion. If HP is below max, restore POTION_HEAL
 * (capped at hpMax). If HP is full, increment S.potions slot (capped at
 * POTION_MAX).
 *
 * Returns true if the potion was consumed/banked, false if both HP and
 * potion slots were already maxed (in which case the pickup is wasted —
 * we still consume it from the world but don't apply any effect).
 */
function _applyPotionPickup() {
  if (S.hp < S.hpMax) {
    S.hp = Math.min(S.hpMax, S.hp + POTION_HEAL);
    Audio.levelup && Audio.levelup();
    if (UI && UI.toast) UI.toast('+' + POTION_HEAL + ' HP', '#ff3366', 1100);
    return true;
  }
  if ((S.potions || 0) < POTION_MAX) {
    S.potions = (S.potions || 0) + 1;
    Audio.pickup && Audio.pickup();
    if (UI && UI.toast) UI.toast('POTION ' + S.potions + '/' + POTION_MAX, '#ff3366', 1100);
    return true;
  }
  if (UI && UI.toast) UI.toast('POTIONS FULL', '#aaaaaa', 800);
  return false;
}

function _applyGrenadePickup() {
  if ((S.grenadeCharges || 0) < GRENADE_MAX) {
    S.grenadeCharges = (S.grenadeCharges || 0) + 1;
    Audio.pickup && Audio.pickup();
    if (UI && UI.toast) UI.toast('GRENADE ' + S.grenadeCharges + '/' + GRENADE_MAX, '#88ff55', 1100);
    return true;
  }
  if (UI && UI.toast) UI.toast('GRENADES FULL', '#aaaaaa', 800);
  return false;
}

/**
 * Player-actuated potion use (bound to H key in main.js). Heals the
 * player if they have a potion in inventory and aren't already at
 * full HP. No-op if no potions or already full.
 */
export function tryUsePotion() {
  if ((S.potions || 0) <= 0) {
    if (UI && UI.toast) UI.toast('NO POTIONS', '#aaaaaa', 700);
    return false;
  }
  if (S.hp >= S.hpMax) {
    if (UI && UI.toast) UI.toast('HP IS FULL', '#aaaaaa', 700);
    return false;
  }
  S.potions -= 1;
  S.hp = Math.min(S.hpMax, S.hp + POTION_HEAL);
  Audio.levelup && Audio.levelup();
  if (UI && UI.toast) UI.toast('+' + POTION_HEAL + ' HP', '#ff3366', 1000);
  if (UI && UI.updateHUD) UI.updateHUD();
  return true;
}

// ---------------------------------------------------------------------
// PER-FRAME UPDATE
// ---------------------------------------------------------------------

/**
 * Called from main.js update loop. Animates pickup hover + spawn pop,
 * checks player collision, applies effects + cleans up consumed items.
 */
export function updatePickups(dt, playerPos) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.age += dt;

    // Spawn pop animation — scale eases from 0 to 1 over SPAWN_POP_DURATION.
    if (p.spawnT < 1) {
      p.spawnT = Math.min(1, p.spawnT + dt / SPAWN_POP_DURATION);
      // Overshoot easing for a satisfying pop
      const t = p.spawnT;
      const eased = t < 0.7 ? (t / 0.7) * 1.15 : 1.15 - ((t - 0.7) / 0.3) * 0.15;
      p.obj.scale.setScalar(eased);
    }

    // Hover bob — independent y offset so it stays above the ground ring
    const bobY = HOVER_AMPLITUDE * (Math.sin(p.age * HOVER_FREQUENCY) + 1) * 0.5;
    p.obj.position.y = bobY;
    // Slow rotation for visual flair
    p.obj.rotation.y += dt * 0.7;

    // Pickup collision — only after the spawn pop is done so the
    // player can't accidentally pick up an item that just spawned at
    // their feet during the pop animation. Once popped, any contact
    // attempts pickup. If the slot is full and HP is full, nothing
    // happens — pickup stays on the ground (allowing the player to
    // grab it later when they need it).
    if (p.spawnT >= 1 && playerPos) {
      const dx = p.pos.x - playerPos.x;
      const dz = p.pos.z - playerPos.z;
      if (dx * dx + dz * dz < PICKUP_RADIUS_SQ) {
        const consumed = (p.kind === 'potion')
          ? _applyPotionPickup()
          : _applyGrenadePickup();
        if (consumed) {
          // Tiny burst to visualize collection
          // (intentionally not importing hitBurst here to avoid
          // a cycle with main.js — the toast + sound is enough
          // feedback.)
          scene.remove(p.obj);
          pickups.splice(i, 1);
          if (UI && UI.updateHUD) UI.updateHUD();
        }
        // If !consumed (slot+HP full), leave it on the ground.
      }
    }
  }
}

/** Wipe every pickup from the scene. Called at game over / reset. */
export function clearAllPickups() {
  for (const p of pickups) {
    if (p.obj.parent) scene.remove(p.obj);
  }
  pickups.length = 0;
}

/** Roll for a potion drop on enemy kill. Returns true if the drop
 * succeeded (caller should then spawnPickup at the death position). */
export function rollPotionDrop(isBoss) {
  if (isBoss) return true;   // bosses always drop a potion
  return Math.random() < POTION_DROP_CHANCE;
}

/** Roll for a grenade drop on enemy kill. */
export function rollGrenadeDrop(isBoss) {
  if (isBoss) return true;   // bosses always drop a grenade
  return Math.random() < GRENADE_DROP_CHANCE;
}
