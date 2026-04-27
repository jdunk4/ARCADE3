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
import { notifyPotionConsumed as _tutPotionConsumed } from './tutorialLessons.js';

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
// Lifetime — pickups despawn after this many seconds if not collected.
// Long enough that the player can finish a fight and walk over to grab
// them, short enough that the floor doesn't accumulate orphan pickups
// over a long chapter.
const PICKUP_LIFETIME = 12.0;
// Fade-out window — pickup pulses faster + fades opacity in the last
// FADE_DURATION seconds of its life, telegraphing imminent despawn.
const FADE_DURATION = 1.5;

// ----- GEOMETRY (shared, allocated once) -----
const POTION_BOTTLE_GEO = new THREE.CylinderGeometry(0.22, 0.28, 0.45, 10);
const POTION_NECK_GEO   = new THREE.CylinderGeometry(0.10, 0.10, 0.18, 8);
const POTION_CAP_GEO    = new THREE.CylinderGeometry(0.13, 0.13, 0.08, 8);
const GRENADE_BODY_GEO  = new THREE.SphereGeometry(0.28, 12, 10);
const GRENADE_PIN_GEO   = new THREE.TorusGeometry(0.08, 0.025, 6, 12);
const GRENADE_LEVER_GEO = new THREE.BoxGeometry(0.10, 0.35, 0.05);
const RING_GEO          = new THREE.RingGeometry(0.45, 0.55, 24);

// ----- MATERIALS (shared) -----
// Potion glass — bright glowing blue ("mana potion" energy). Higher
// emissive than typical materials so the bottle reads as "lit from
// within" against dark arena backdrops. The semi-transparent layer
// gives a subtle inner glow when light passes through.
const _potionGlass = new THREE.MeshStandardMaterial({
  color: 0x33aaff,
  emissive: 0x2266ff,
  emissiveIntensity: 1.1,
  transparent: true,
  opacity: 0.85,
  metalness: 0.1,
  roughness: 0.25,
});
const _potionCorkMat = new THREE.MeshStandardMaterial({
  color: 0x6b4422,
  metalness: 0.2,
  roughness: 0.8,
});
// Grenade body — glowing green ORB. Previous version used a darker
// pineapple-style metallic green; this is a cleaner sci-fi energy-
// orb look to match the user's "glowing green orbs" spec. Kept the
// pin + lever attachments so it still reads as "grenade" not just
// "ball".
const _grenadeBodyMat = new THREE.MeshStandardMaterial({
  color: 0x44ff66,
  emissive: 0x22dd44,
  emissiveIntensity: 1.0,
  metalness: 0.2,
  roughness: 0.35,
});
const _grenadePinMat = new THREE.MeshStandardMaterial({
  color: 0xc8c8a8,
  metalness: 0.9,
  roughness: 0.2,
});
const _potionRingMat = new THREE.MeshBasicMaterial({
  color: 0x33aaff,
  transparent: true,
  opacity: 0.55,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const _grenadeRingMat = new THREE.MeshBasicMaterial({
  color: 0x44ff66,
  transparent: true,
  opacity: 0.55,
  side: THREE.DoubleSide,
  depthWrite: false,
});

// ----- STATE -----
export const pickups = [];   // { obj, kind: 'potion'|'grenade', pos, age, spawnT }

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
    if (UI && UI.toast) UI.toast('+' + POTION_HEAL + ' HP', '#33aaff', 1100);
    // Tutorial: count this pickup-heal as "potion consumed" so the
    // heal lesson can complete. Without this, a player who gets hit
    // before reaching the potion would auto-heal on touch (the
    // potion never enters inventory, so pressing H is impossible)
    // and the lesson would never advance — the bug the user
    // hit. Same notify fires from tryUsePotion for the H-key path,
    // so either flow advances the lesson.
    if (S.tutorialMode) { try { _tutPotionConsumed(); } catch (e) {} }
    return true;
  }
  if ((S.potions || 0) < POTION_MAX) {
    S.potions = (S.potions || 0) + 1;
    Audio.pickup && Audio.pickup();
    if (UI && UI.toast) UI.toast('POTION ' + S.potions + '/' + POTION_MAX, '#33aaff', 1100);
    return true;
  }
  if (UI && UI.toast) UI.toast('POTIONS FULL', '#aaaaaa', 800);
  return false;
}

function _applyGrenadePickup() {
  if ((S.grenadeCharges || 0) < GRENADE_MAX) {
    S.grenadeCharges = (S.grenadeCharges || 0) + 1;
    Audio.pickup && Audio.pickup();
    if (UI && UI.toast) UI.toast('GRENADE ' + S.grenadeCharges + '/' + GRENADE_MAX, '#44ff66', 1100);
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
  if (UI && UI.toast) UI.toast('+' + POTION_HEAL + ' HP', '#33aaff', 1000);
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

    // Lifetime expiration — pickup despawns after PICKUP_LIFETIME.
    // In the last FADE_DURATION seconds we fade opacity to zero AND
    // speed up the bob, signaling "this is about to vanish."
    if (p.age >= PICKUP_LIFETIME) {
      scene.remove(p.obj);
      pickups.splice(i, 1);
      continue;
    }
    const fadeStart = PICKUP_LIFETIME - FADE_DURATION;
    if (p.age > fadeStart) {
      const fadeT = (p.age - fadeStart) / FADE_DURATION;     // 0 → 1
      const opacity = Math.max(0, 1 - fadeT);
      // Walk all child meshes and dim their materials. Materials are
      // already transparent (potion glass) or get marked transparent
      // for fade. We only need to touch .opacity on a small handful
      // of materials per pickup so this is cheap.
      p.obj.traverse(child => {
        if (child.material) {
          if (Array.isArray(child.material)) {
            for (const m of child.material) {
              m.transparent = true;
              m.opacity = opacity * (m.userData.baseOpacity != null ? m.userData.baseOpacity : 1.0);
            }
          } else {
            child.material.transparent = true;
            child.material.opacity = opacity * (child.material.userData.baseOpacity != null ? child.material.userData.baseOpacity : 1.0);
          }
        }
      });
    }

    // Spawn pop animation — scale eases from 0 to 1 over SPAWN_POP_DURATION.
    if (p.spawnT < 1) {
      p.spawnT = Math.min(1, p.spawnT + dt / SPAWN_POP_DURATION);
      // Overshoot easing for a satisfying pop
      const t = p.spawnT;
      const eased = t < 0.7 ? (t / 0.7) * 1.15 : 1.15 - ((t - 0.7) / 0.3) * 0.15;
      p.obj.scale.setScalar(eased);
    }

    // Hover bob — speeds up during the fade so the imminent-despawn
    // telegraph is more obvious.
    const fadeFreq = (p.age > fadeStart) ? 5.0 : HOVER_FREQUENCY;
    const bobY = HOVER_AMPLITUDE * (Math.sin(p.age * fadeFreq) + 1) * 0.5;
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
