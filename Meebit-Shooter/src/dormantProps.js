// ============================================================================
// src/dormantProps.js — chapter-scoped persistent prop scaffolding.
//
// Problem: the old wave system rebuilt the depot, the hives, and (in the
// new design) the turrets + radio tower + EMP silo on demand at the start
// of whichever wave used them. The new design requires ALL of these
// elements to be VISIBLE (but inert) from the start of the chapter, and
// to progressively "activate" on their designated wave. This gives the
// arena a persistent, worked-on feel — at chapter start you can already
// see the depot you'll mine ore toward (wave 1), the derelict turret
// platforms you'll power up (wave 2), the shielded hives you'll later
// destroy (wave 3), and the herd staging pens (wave 4) — and each wave
// simply flips a few state bits to bring the relevant props to life.
//
// This module doesn't OWN the props (they live in their original modules:
// ores.js for the depot, spawners.js for the hives, a new turrets.js in
// stage 2, etc.) — it's a coordination layer that decides WHEN to hand
// control to each owner.
//
// Lifecycle:
//   onChapterStart(chapterIdx) — called the FIRST TIME a wave in a new
//     chapter begins (localWave === 1). Spawns every dormant prop for
//     the chapter in its "inactive" visual state.
//   onChapterEnd()              — called when the chapter finishes (boss
//     dies, wave 5 complete). Tears down every prop so the next chapter
//     can rebuild from a clean slate. Also called on resetWaves().
//   isChapterPrepared()         — true if onChapterStart has run for the
//     current chapter and the teardown hasn't happened yet. waves.js uses
//     this to decide whether to call onChapterStart on wave 1 entry.
//
// Stage 1 scope: depot + hive shields. Turrets, radio tower, EMP silo,
// and herd pens come in stage 2 / 3.
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS, HIVE_CONFIG, ARENA } from './config.js';
import { spawnDepot, clearDepot } from './ores.js';
import { spawnAllPortals, clearAllPortals, spawners } from './spawners.js';

// Which chapter the current dormant-prop set belongs to. -1 means no set
// is live; when the current chapter changes, the owning props are torn
// down and rebuilt for the new chapter.
let _preparedChapter = -1;

// Shield meshes keyed by hive. Shared geometry; per-hive material so the
// alpha pulse can be independent.
const _hiveShields = new Map();
const _SHIELD_GEO = new THREE.SphereGeometry(2.4, 24, 16);

/**
 * Call this whenever a wave is about to start and you're not sure if the
 * chapter scaffolding is already up. Idempotent — bails out if the current
 * chapter is already prepared.
 *
 *  - Builds the depot (visible but only accepts ore during wave 1)
 *  - Spawns the hives in SHIELDED dormant form (invulnerable; emit nothing
 *    until wave 3 starts and removeHiveShields() fires)
 *  - TODO stage 2: spawns 3 dormant turret platforms
 *  - TODO stage 2: spawns the power/radio/EMP silo zone markers
 *  - TODO stage 3: herd staging pens
 */
export function prepareChapter(chapterIdx) {
  if (_preparedChapter === chapterIdx) return;
  // Clean any leftover state from a previous chapter before building anew.
  teardownChapter();

  // --- Depot (wave 1 target, but visible from chapter start) ---
  spawnDepot(chapterIdx);

  // --- Hives (wave 3 target; visible-but-shielded from chapter start) ---
  spawnAllPortals(chapterIdx);
  _applyShieldsToAllHives(chapterIdx);

  _preparedChapter = chapterIdx;
  console.info('[dormantProps] prepared chapter', chapterIdx);
}

/**
 * Called when the chapter ends (boss dies or a hard reset happens). Clears
 * every prop the chapter owned so the next chapter can lay down fresh ones.
 */
export function teardownChapter() {
  if (_preparedChapter === -1) return;
  _clearHiveShields();
  clearAllPortals();
  clearDepot();
  _preparedChapter = -1;
}

export function isChapterPrepared(chapterIdx) {
  return _preparedChapter === chapterIdx;
}

export function currentPreparedChapter() {
  return _preparedChapter;
}

// ----------------------------------------------------------------------------
// HIVE SHIELDS
//
// Wave 1 and 2 hives are decorative — they exist so the arena doesn't feel
// like pieces are teleporting in, and so the player can see "that's what
// we'll destroy in wave 3". A faint shield sphere wraps each hive, marked
// with the chapter color, and a `shielded` flag is stored on the hive
// object. The damage path in spawners.js should check this flag and skip
// all damage while true (done below in the shield helper).
// ----------------------------------------------------------------------------

function _applyShieldsToAllHives(chapterIdx) {
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  for (const h of spawners) {
    if (h.destroyed) continue;
    _addShieldToHive(h, tint);
  }
}

function _addShieldToHive(hive, tint) {
  // Each shield gets its own material so the per-hive pulse phase can
  // drift independently (looks less synthetic than every shield pulsing
  // in lockstep).
  const mat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const shield = new THREE.Mesh(_SHIELD_GEO, mat);
  shield.position.copy(hive.pos);
  shield.position.y = 2.0;
  shield.userData.pulseSeed = Math.random() * Math.PI * 2;
  shield.userData.tint = tint;
  scene.add(shield);

  hive.shielded = true;
  hive.shieldMesh = shield;
  _hiveShields.set(hive, shield);
}

/**
 * Call this when wave 2 ends (EMP fires). Drops every hive shield with a
 * quick flash and flips the `shielded` flag so wave 3 damage calls land.
 */
export function removeHiveShields() {
  for (const [hive, shield] of _hiveShields) {
    hive.shielded = false;
    // Flash + shrink the shield on the way out.
    shield.userData._dropping = true;
    shield.userData._dropT = 0;
  }
}

function _clearHiveShields() {
  for (const [hive, shield] of _hiveShields) {
    if (shield.parent) scene.remove(shield);
    if (hive) {
      hive.shielded = false;
      hive.shieldMesh = null;
    }
  }
  _hiveShields.clear();
}

/**
 * Per-frame shield update. Pulses intact shields, animates the drop for
 * shields that were released by removeHiveShields().
 *
 * Safe to call every frame regardless of wave type. If no shields exist
 * the loop is a single Map lookup and exits.
 */
export function updateHiveShields(dt, time) {
  if (!_hiveShields.size) return;
  const toRemove = [];
  for (const [hive, shield] of _hiveShields) {
    // Follow the hive in case its position ever drifts (it doesn't today,
    // but cheap safety).
    shield.position.x = hive.pos.x;
    shield.position.z = hive.pos.z;

    if (shield.userData._dropping) {
      // 0.8s collapse animation — shrink + fade to zero, then delete.
      shield.userData._dropT += dt;
      const t = Math.min(1, shield.userData._dropT / 0.8);
      const eased = 1 - (1 - t) * (1 - t);
      shield.scale.setScalar(1 + eased * 0.6);
      shield.material.opacity = 0.55 * (1 - eased);
      if (t >= 1) {
        if (shield.parent) scene.remove(shield);
        toRemove.push(hive);
      }
    } else {
      // Gentle pulse while intact. 0.12..0.24 opacity, seeded per-shield.
      const phase = (time || 0) * 1.6 + (shield.userData.pulseSeed || 0);
      shield.material.opacity = 0.18 + (Math.sin(phase) + 1) * 0.5 * 0.10;
      // Very slow rotation for a subtle "active field" feel.
      shield.rotation.y += dt * 0.25;
    }
  }
  for (const hive of toRemove) {
    _hiveShields.delete(hive);
    if (hive) hive.shieldMesh = null;
  }
}
