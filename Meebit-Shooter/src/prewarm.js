// ============================================================
//  SHADER PREWARM
//
//  First-time use of any material/geometry pair triggers a
//  shader-compile stall on the GPU. For this game that stall
//  showed up as two freezes:
//
//    • A stutter on the first frame of gameplay (every weapon,
//      enemy and effect gets compiled one by one as it first
//      appears on screen).
//    • A bigger hitch at wave 6 — the start of the RED chapter —
//      because vampires, red devils, and their fireball
//      projectiles had never been rendered before.
//
//  This module runs once at game start. It spawns one off-screen
//  invisible instance of every enemy, every boss, every
//  projectile type, and every weapon's bullet, then asks the
//  renderer to compile all shader permutations. After this
//  returns, nothing in the combat loop can trigger a compile.
//
//  Cost: roughly 50–120 ms one time, paid during the title →
//  game transition when the player expects a brief "LOADING"
//  moment anyway. Saves every subsequent hitch.
// ============================================================

import * as THREE from 'three';
import { scene, camera } from './scene.js';
import { ENEMY_TYPES, BOSSES, WEAPONS, CHAPTERS } from './config.js';
import { makeEnemy, makeBoss, spawnEnemyProjectile, enemies, enemyProjectiles } from './enemies.js';
import { spawnBullet, spawnRocket, bullets, rockets, makePickup, pickups, hitBurst } from './effects.js';

// Y-offset far below the ground plane so nothing is visible even for a
// single frame. Distance is large enough to be outside the scene.fog range.
const HIDE_Y = -500;

let prewarmed = false;

function _hideObj(obj) {
  if (obj && obj.position) obj.position.y = HIDE_Y;
}

/**
 * Prewarm every shader permutation the game can produce.
 * Safe to call multiple times — only runs work on the first call.
 *
 * @param {THREE.WebGLRenderer} renderer - the active renderer
 */
export function prewarmShaders(renderer) {
  if (prewarmed) return;
  prewarmed = true;

  const startLen = {
    enemies: enemies.length,
    bullets: bullets.length,
    rockets: rockets.length,
    pickups: pickups.length,
    projectiles: enemyProjectiles.length,
  };

  // -----------------------------------------------------------------
  // 1. One of every enemy type, tinted with every chapter color.
  //    Different chapter tints produce different material color values
  //    but share the same shader, so iterating every chapter is cheap
  //    and guarantees the color-mutation path is exercised.
  // -----------------------------------------------------------------
  const warmPos = new THREE.Vector3(0, HIDE_Y, 0);
  for (const typeKey of Object.keys(ENEMY_TYPES)) {
    for (const chapter of CHAPTERS) {
      try {
        const e = makeEnemy(typeKey, chapter.full.enemyTint, warmPos);
        _hideObj(e.obj);
      } catch (err) {
        // Never let a prewarm failure break the game.
        console.warn('[prewarm] enemy', typeKey, err);
      }
    }
  }

  // -----------------------------------------------------------------
  // 2. One of every boss.
  // -----------------------------------------------------------------
  for (const bossKey of Object.keys(BOSSES)) {
    for (const chapter of CHAPTERS.slice(0, 2)) {
      try {
        const b = makeBoss(bossKey, chapter.full.enemyTint, warmPos);
        _hideObj(b.obj);
      } catch (err) {
        console.warn('[prewarm] boss', bossKey, err);
      }
    }
  }

  // -----------------------------------------------------------------
  // 3. One bullet per weapon that fires bullets. Rockets and raygun
  //    (beam) and pickaxe are excluded from the bullet path.
  // -----------------------------------------------------------------
  const origin = new THREE.Vector3(0, HIDE_Y, 0);
  for (const key of Object.keys(WEAPONS)) {
    const w = WEAPONS[key];
    if (w.isBeam || w.isMining || w.isHoming) continue;
    try {
      spawnBullet(origin, 0, w);
    } catch (err) {
      console.warn('[prewarm] bullet', key, err);
    }
  }

  // -----------------------------------------------------------------
  // 4. One rocket (homing missile).
  // -----------------------------------------------------------------
  try {
    spawnRocket(origin, 0, WEAPONS.rocket, null);
  } catch (err) {
    console.warn('[prewarm] rocket', err);
  }

  // -----------------------------------------------------------------
  // 5. One of every enemy projectile type/color combination that the
  //    game can produce. This is what actually fixes wave 6's
  //    fireball/bolt stall.
  // -----------------------------------------------------------------
  const projCombos = [
    ['box',      0x00ff66],  // zomeeb spit (toxic green) — generic box default
    ['box',      0xff2e4d],  // vampire bolt (red chapter)
    ['fireball', 0xff2e4d],  // red devil fireball
    ['fireball', 0xff4400],  // red devil fireball alt
    ['triangle', 0xffd93d],  // wizard triangle (yellow)
    ['box',      0x00ff44],  // goospitter (green)
  ];
  const target = new THREE.Vector3(0, HIDE_Y, 1);
  for (const [projType, color] of projCombos) {
    try {
      spawnEnemyProjectile(origin, target, 10, 0, color, projType);
    } catch (err) {
      console.warn('[prewarm] projectile', projType, color.toString(16), err);
    }
  }

  // -----------------------------------------------------------------
  // 6. One of every pickup type (xp, health, speed, shield).
  // -----------------------------------------------------------------
  for (const pickupType of ['xp', 'health', 'speed', 'shield']) {
    try {
      makePickup(pickupType, 0, 0);
    } catch (err) {
      console.warn('[prewarm] pickup', pickupType, err);
    }
  }
  // Move pickups below the floor too.
  for (let i = startLen.pickups; i < pickups.length; i++) {
    _hideObj(pickups[i].obj);
  }

  // -----------------------------------------------------------------
  // 7. Hit-burst particles in the common colors so the particle
  //    shader is warm.
  // -----------------------------------------------------------------
  const particleColors = [0xffffff, 0xff2e4d, 0x00ff66, 0xffd93d, 0x4ff7ff, 0xff8800];
  const burstPos = new THREE.Vector3(0, HIDE_Y, 0);
  for (const c of particleColors) {
    try { hitBurst(burstPos, c, 2); } catch (err) { console.warn('[prewarm] burst', err); }
  }

  // -----------------------------------------------------------------
  // 8. Ask the renderer to compile everything we just added.
  //    renderer.compile walks the scene graph and compiles any
  //    program+material+geometry combination it hasn't seen.
  // -----------------------------------------------------------------
  try {
    renderer.compile(scene, camera);
  } catch (err) {
    console.warn('[prewarm] compile', err);
  }

  // -----------------------------------------------------------------
  // 9. Tear down the decoy instances.
  //    We only clean up what we added, not what existed before, so
  //    this is safe even if prewarm is called after other spawns.
  // -----------------------------------------------------------------
  // Enemies (includes bosses — both live in `enemies`)
  for (let i = enemies.length - 1; i >= startLen.enemies; i--) {
    scene.remove(enemies[i].obj);
    enemies.splice(i, 1);
  }
  for (let i = bullets.length - 1; i >= startLen.bullets; i--) {
    scene.remove(bullets[i]);
    bullets.splice(i, 1);
  }
  for (let i = rockets.length - 1; i >= startLen.rockets; i--) {
    scene.remove(rockets[i]);
    rockets.splice(i, 1);
  }
  for (let i = enemyProjectiles.length - 1; i >= startLen.projectiles; i--) {
    scene.remove(enemyProjectiles[i]);
    enemyProjectiles.splice(i, 1);
  }
  for (let i = pickups.length - 1; i >= startLen.pickups; i--) {
    scene.remove(pickups[i].obj);
    pickups.splice(i, 1);
  }
  // Particles clean themselves up on a normal timer via updateParticles(dt),
  // and they're already off-screen, so we leave them alone.
}
