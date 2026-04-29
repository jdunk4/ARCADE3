// =====================================================================
// TUTORIAL LESSON CONTROLLER
// =====================================================================
// The tutorial is a sequenced checklist of single-objective lessons.
// Each lesson knows how to (a) set up the arena for itself, (b) detect
// its own completion, and (c) tear itself down before the next lesson
// activates. Lessons run one at a time; the checklist UI on the right
// side of the screen shows pending/active/done state for all of them
// at once.
//
// This module is deliberately self-contained — it doesn't run inside
// the wave system. When S.tutorialMode is true, main.js bypasses
// updateWaves and calls tickTutorialController(dt) instead.
//
// Lesson contract:
//   {
//     id:           string identifier
//     label:        short name shown in the checklist row
//     hint:         longer description shown when lesson is active
//     onActivate:   () => void   // arena setup, spawn props/enemies
//     onUpdate:     (dt) => void // per-frame tick (optional)
//     isComplete:   () => boolean
//     onComplete:   () => void   // teardown, prep for next
//     progress?:    () => string // optional "2/3" style text shown
//                                  next to the active row
//   }
// =====================================================================

import * as THREE from 'three';
import { S } from './state.js';
import { player } from './player.js';
import { enemies, makeEnemy } from './enemies.js';
import { WEAPONS, ARENA, CHAPTERS } from './config.js';
import { hitBurst, makePickup } from './effects.js';
import { scene } from './scene.js';
import { Audio } from './audio.js';
import { tutorialEnemyColor } from './tutorial.js';

// Real game systems — tutorial lessons drive these directly so the
// player learns the actual mechanics rather than tutorial-flavored
// mocks.
import {
  spawnCannon, clearCannon, armCannon,
  setActiveCannonCorner, setCannonCornerProgress, consumeCannonCorner,
  getCannonCornerPos, forceFireCannon, getCannonOrigin, hasCannon,
} from './cannon.js';
import {
  spawnQueenHive, clearQueenHive, popQueenShield,
  queenShieldsRemaining, getQueen, getNextDomePos,
  spawnCannonBeam,
} from './queenHive.js';
import {
  spawnEscortTruck, clearEscortTruck, getTruckPos,
  isTruckArrived, hasTruck, isPlayerInEscortRadius,
} from './escortTruck.js';
import { spawnBlock, blocks } from './blocks.js';
import { updateOres, clearAllOres } from './ores.js';
import { spawnPickup, pickups } from './pickups.js';
import { grantArtifact as grantStratagemArtifact } from './stratagems.js';

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let _lessons = [];
let _activeIdx = -1;
let _doneCallback = null;          // fired when the whole list completes
let _waitingForNext = 0;           // small delay between lessons (sec)
let _enemyKillCount = 0;           // counters incremented by hooks
let _enemyKillCountAtActivate = 0;
let _shotCount = 0;
let _shotCountAtActivate = 0;
let _walkDistance = 0;
let _walkDistanceAtActivate = 0;
let _lastPlayerPos = null;
let _dashCount = 0;
let _dashCountAtActivate = 0;
let _weaponsTried = new Set();     // weapon keys fired during the weapons lesson
let _hazardHits = 0;
let _hazardHitsAtActivate = 0;
// Tracks INSTA-KILL hazard contacts only (Minesweeper bombs +
// Pacman ghosts). Lesson 11 (DODGE THE DEADLY) requires the player
// to actually trigger the death/respawn cycle, not just take chip
// damage. Driven by notifyDeadlyHazardHit() from main.js, which
// fires only when a hit drops HP from positive to <=0.
let _deadlyHazardHits = 0;
let _deadlyHazardHitsAtActivate = 0;
let _potionsConsumed = 0;
let _potionsConsumedAtActivate = 0;
let _grenadesThrown = 0;
let _grenadesThrownAtActivate = 0;

// References to lesson-spawned props so they can be torn down.
let _activeProps = [];
let _activeEnemies = new Set();    // enemies the lesson spawned

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------
export function isTutorialControllerActive() { return _activeIdx >= 0; }
export function getActiveLessonIdx() { return _activeIdx; }
export function getLessons() { return _lessons; }

export function startTutorialController(opts) {
  _lessons = buildLessonList();
  _activeIdx = -1;
  _doneCallback = (opts && opts.onAllDone) || null;
  _waitingForNext = 0;
  _enemyKillCount = 0;
  _shotCount = 0;
  _walkDistance = 0;
  _dashCount = 0;
  _weaponsTried.clear();
  _hazardHits = 0;
  _deadlyHazardHits = 0;
  _potionsConsumed = 0;
  _grenadesThrown = 0;
  _activeProps.length = 0;
  _activeEnemies.clear();
  _lastPlayerPos = player && player.pos ? player.pos.clone() : null;
  _advance();
  renderChecklist();
}

export function stopTutorialController() {
  _teardownActive();
  _activeIdx = -1;
  _lessons = [];
  const el = document.getElementById('tutorial-checklist');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// ---------------------------------------------------------------------
// Hooks called from main.js / waves.js / etc. so lessons can react to
// gameplay events without polling.
// ---------------------------------------------------------------------
export function notifyEnemyKilled(enemyRef) {
  _enemyKillCount++;
  if (enemyRef) _activeEnemies.delete(enemyRef);
}
export function notifyShotFired(weaponKey) {
  _shotCount++;
  if (weaponKey) _weaponsTried.add(weaponKey);
}
export function notifyDashed() {
  _dashCount++;
}
export function notifyHazardHit() {
  _hazardHits++;
}
// Fires only when a hazard contact drops the player's HP from
// positive to ≤0 (insta-kill bombs / ghosts). Driven from main.js's
// hazard-tick path. Used by the DODGE THE DEADLY lesson which only
// completes on actual death+respawn events.
export function notifyDeadlyHazardHit() {
  _deadlyHazardHits++;
}
export function notifyPotionConsumed() {
  _potionsConsumed++;
}
// Fires when the player throws a grenade (S.grenadeCharges decrements
// inside tryThrowGrenade in main.js). Used by the expanded heal lesson
// which requires the player to USE both a potion AND a grenade.
export function notifyGrenadeThrown() {
  _grenadesThrown++;
}

// ---------------------------------------------------------------------
// Tick — called from main.js render loop when S.tutorialMode is on.
// ---------------------------------------------------------------------
export function tickTutorialController(dt) {
  if (_activeIdx < 0 || _activeIdx >= _lessons.length) return;

  // Track walked distance for the move lesson.
  if (player && player.pos) {
    if (_lastPlayerPos) {
      const dx = player.pos.x - _lastPlayerPos.x;
      const dz = player.pos.z - _lastPlayerPos.z;
      _walkDistance += Math.sqrt(dx * dx + dz * dz);
    }
    _lastPlayerPos = player.pos.clone();
  }

  const lesson = _lessons[_activeIdx];

  // Per-lesson update tick.
  if (lesson.onUpdate) {
    try { lesson.onUpdate(dt); } catch (e) { console.warn('[tutorial] onUpdate', e); }
  }

  // Inter-lesson delay so the player can read the checklist update.
  if (_waitingForNext > 0) {
    _waitingForNext -= dt;
    if (_waitingForNext <= 0) {
      _waitingForNext = 0;
      _advance();
      renderChecklist();
    }
    return;
  }

  // Completion check.
  let done = false;
  try { done = !!lesson.isComplete(); } catch (e) { done = false; }
  if (done) {
    try { lesson.onComplete && lesson.onComplete(); } catch (e) {}
    _teardownActive();
    // Two-tone confirmation chime so finishing a task FEELS rewarding
    // — same audible cue the user described as "payment went through."
    // Wrapped in try/catch in case Audio isn't initialized for any
    // reason (it almost always is by tutorial start).
    try { Audio.taskComplete && Audio.taskComplete(); } catch (e) {}
    _waitingForNext = 1.5;     // pause so the checkmark animation lands
    renderChecklist(true);
  } else {
    // Update the progress label on the active row if it has one.
    renderChecklist();
  }
}

// ---------------------------------------------------------------------
// Internal — advance / teardown
// ---------------------------------------------------------------------
function _advance() {
  _activeIdx++;
  if (_activeIdx >= _lessons.length) {
    _activeIdx = _lessons.length;       // sentinel "all done"
    if (_doneCallback) {
      try { _doneCallback(); } catch (e) {}
    }
    return;
  }
  const lesson = _lessons[_activeIdx];
  // Snapshot per-counter baselines so each lesson measures its own
  // progress relative to its activation time.
  _enemyKillCountAtActivate = _enemyKillCount;
  _shotCountAtActivate = _shotCount;
  _walkDistanceAtActivate = _walkDistance;
  _dashCountAtActivate = _dashCount;
  _hazardHitsAtActivate = _hazardHits;
  _deadlyHazardHitsAtActivate = _deadlyHazardHits;
  _potionsConsumedAtActivate = _potionsConsumed;
  _grenadesThrownAtActivate = _grenadesThrown;
  _weaponsTried.clear();
  // Clear any arrows the previous lesson may have left up; the new
  // lesson will repopulate them in onActivate or onUpdate if needed.
  S.tutorialArrows = [];
  if (lesson.onActivate) {
    try { lesson.onActivate(); } catch (e) { console.warn('[tutorial] onActivate', e); }
  }
}

function _teardownActive() {
  // Remove any leftover props this lesson spawned.
  for (const p of _activeProps) {
    if (p && p.parent) p.parent.remove(p);
  }
  _activeProps.length = 0;
  // Don't forcibly remove enemies — let them play out / be killed.
  // We'll just stop tracking them.
  _activeEnemies.clear();
  // Wipe arrows; next lesson sets its own.
  S.tutorialArrows = [];
}

// ---------------------------------------------------------------------
// Helpers shared by lessons
// ---------------------------------------------------------------------
function _spawnTutorialEnemy(angleRad, dist, type) {
  type = type || 'zomeeb';
  const x = Math.cos(angleRad) * dist;
  const z = Math.sin(angleRad) * dist;
  // Black/white tint per usual tutorial rules.
  const tint = tutorialEnemyColor(0xffffff);
  const e = makeEnemy(type, tint, new THREE.Vector3(x, 0, z));
  if (e) {
    // Slow them down so the lesson is forgiving.
    e.speed = (e.speed || 2) * 0.55;
    _activeEnemies.add(e);
  }
  return e;
}

function _alivePlayerSpawnedEnemies() {
  let n = 0;
  for (const e of _activeEnemies) {
    if (e && e.hp > 0) n++;
  }
  return n;
}

function _spawnTutorialZone(x, z, radius, color) {
  // Glowing ring on the floor + a soft column of light. Just visual —
  // logic that uses the zone reads (x,z,radius) directly.
  const ringGeo = new THREE.RingGeometry(radius - 0.25, radius + 0.05, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color: color || 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.06, z);
  scene.add(ring);
  _activeProps.push(ring);

  // Inner translucent disc.
  const discGeo = new THREE.CircleGeometry(radius, 36);
  const discMat = new THREE.MeshBasicMaterial({
    color: color || 0xffffff, transparent: true, opacity: 0.18,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(x, 0.05, z);
  scene.add(disc);
  _activeProps.push(disc);

  return { x, z, radius, ring, disc };
}

function _isPlayerInZone(zone) {
  if (!player || !player.pos || !zone) return false;
  const dx = player.pos.x - zone.x;
  const dz = player.pos.z - zone.z;
  return dx * dx + dz * dz < zone.radius * zone.radius;
}

// ---------------------------------------------------------------------
// LESSONS
// ---------------------------------------------------------------------
function buildLessonList() {
  const list = [];

  // ----- 1. BASICS — move + shoot, all in one lesson -----
  // Two sub-objectives gate completion. Each ticks independently
  // and the lesson finishes when both are met. Progress label
  // shows whichever sub-objective hasn't been met yet (or "all done"
  // briefly before advance).
  // Dash was previously a third gated requirement here. Removed —
  // dash is still a valid game mechanic (SPACE works) but tutorial
  // progress no longer waits on it, so players who don't naturally
  // dash can still complete the basics lesson.
  list.push({
    id: 'basics',
    label: 'MOVE · SHOOT',
    hint: 'Walk with WASD · hold LEFT MOUSE to fire your pistol.',
    _moveDone: false,
    _shootDone: false,
    onActivate() {
      this._moveDone = false;
      this._shootDone = false;
    },
    onUpdate() {
      // Re-check each sub-objective every frame so the progress label
      // and the eventual isComplete() agree on a single source of
      // truth.
      this._moveDone = (_walkDistance - _walkDistanceAtActivate) >= 12;
      this._shootDone = (_shotCount - _shotCountAtActivate) >= 5;
    },
    isComplete() {
      return this._moveDone && this._shootDone;
    },
    progress() {
      // Compose a tiny status line so the player sees which parts
      // they've already cleared. Checked items get a ✓; pending
      // ones show their counter.
      const move = this._moveDone
        ? '✓ MOVE'
        : ('MOVE ' + Math.min(12, Math.round(Math.max(0, _walkDistance - _walkDistanceAtActivate))) + '/12');
      const shoot = this._shootDone
        ? '✓ SHOOT'
        : ('SHOOT ' + Math.min(5, Math.max(0, _shotCount - _shotCountAtActivate)) + '/5');
      return move + ' · ' + shoot;
    },
  });

  // (was 4) ----- 2. DEFEAT 3 ENEMIES -----
  list.push({
    id: 'kill',
    label: 'DEFEAT 3 ENEMIES',
    hint: 'Three enemies will approach. Take them down with your pistol.',
    _spawned: 0,
    onActivate() {
      this._spawned = 0;
      _spawnTutorialEnemy(Math.random() * Math.PI * 2, 16);
      setTimeout(() => _spawnTutorialEnemy(Math.random() * Math.PI * 2, 16), 1500);
      setTimeout(() => _spawnTutorialEnemy(Math.random() * Math.PI * 2, 16), 3000);
    },
    onUpdate() {
      // Point an arrow at the nearest live tutorial-spawned enemy so
      // the player always knows where to look.
      let nearest = null, bestD2 = Infinity;
      for (const e of _activeEnemies) {
        if (!e || e.hp <= 0) continue;
        const dx = e.pos.x - player.pos.x;
        const dz = e.pos.z - player.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; nearest = e; }
      }
      S.tutorialArrows = nearest
        ? [{ x: nearest.pos.x, z: nearest.pos.z, label: 'ENEMY' }]
        : [];
    },
    isComplete: () => (_enemyKillCount - _enemyKillCountAtActivate) >= 3,
    progress: () => {
      const n = Math.max(0, _enemyKillCount - _enemyKillCountAtActivate);
      return Math.min(3, n) + ' / 3';
    },
  });

  // ----- 5. LEVEL UP -----
  list.push({
    id: 'levelup',
    label: 'REACH LEVEL 2',
    hint: 'Defeat more enemies to earn XP and level up. Killing enemies drops health and shield pickups too.',
    _spawned: 0,
    _lastSpawnAt: 0,
    onActivate() { this._spawned = 0; this._lastSpawnAt = 0; },
    onUpdate(dt) {
      // Slow trickle: 1 enemy at a time until the player levels up.
      const nowMs = performance.now();
      if (_alivePlayerSpawnedEnemies() === 0 && nowMs - this._lastSpawnAt > 1800) {
        _spawnTutorialEnemy(Math.random() * Math.PI * 2, 18);
        this._lastSpawnAt = nowMs;
        this._spawned++;
      }
      // Arrow → nearest enemy
      let nearest = null, bestD2 = Infinity;
      for (const e of _activeEnemies) {
        if (!e || e.hp <= 0) continue;
        const dx = e.pos.x - player.pos.x;
        const dz = e.pos.z - player.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; nearest = e; }
      }
      S.tutorialArrows = nearest
        ? [{ x: nearest.pos.x, z: nearest.pos.z, label: 'ENEMY' }]
        : [];
    },
    isComplete: () => (S.level || 1) >= 2,
  });

  // ----- 6. SWITCH WEAPONS -----
  // Grants every combat weapon and asks the player to fire each one.
  // The notifyShotFired hook tracks which weapon keys appear in
  // _weaponsTried; we need 5 distinct (shotgun, smg, rocket, raygun,
  // flamethrower).
  const REQUIRED_WEAPONS = ['shotgun', 'smg', 'rocket', 'raygun', 'flamethrower'];
  list.push({
    id: 'weapons',
    label: 'TRY ALL WEAPONS',
    hint: 'Press 2 / 3 / 4 / 5 / 6 to cycle weapons. Fire each one at least once.',
    onActivate: () => {
      // Grant every combat weapon in case they weren't already owned.
      for (const w of ['shotgun', 'smg', 'rocket', 'raygun', 'flamethrower']) {
        S.ownedWeapons.add(w);
      }
    },
    onUpdate() {
      if (_alivePlayerSpawnedEnemies() < 2 && Math.random() < 0.02) {
        _spawnTutorialEnemy(Math.random() * Math.PI * 2, 14);
      }
    },
    isComplete: () => REQUIRED_WEAPONS.every(w => _weaponsTried.has(w)),
    progress: () => {
      const tried = REQUIRED_WEAPONS.filter(w => _weaponsTried.has(w)).length;
      return tried + ' / ' + REQUIRED_WEAPONS.length;
    },
  });

  // ----- 7. BREAK BLOCKS / COLLECT ORES -----
  // Uses the real spawnBlock + ore systems. The block-mined hook in
  // main.js bumps S.blocksMined whenever a player destroys a block,
  // and the existing block-destroy code in blocks.js spawns ores
  // automatically. We just need to drop blocks and watch the count.
  // updateOres needs to be ticked too — that's wired in main.js's
  // animate loop via S.tutorialMode (see Phase 2 wiring in main.js).
  list.push({
    id: 'mining',
    label: 'BREAK 3 BLOCKS',
    hint: 'Falling blocks contain ore. Shoot the blocks until they shatter, then watch the ore fly toward you.',
    _baseline: 0,
    _spawned: 0,
    _lastSpawnAt: 0,
    onActivate() {
      // Snapshot S.blocksMined so we count only blocks broken during
      // THIS lesson.
      this._baseline = S.blocksMined || 0;
      this._spawned = 0;
      this._lastSpawnAt = 0;
      // Mining mode flag — main.js gates pickaxe-style mining + bullet
      // collisions with blocks behind it. (Player has no pickaxe in
      // tutorial; bullets do the job.)
      S.miningActive = true;
    },
    onUpdate(dt) {
      // Spawn one block every ~1.5s until we've dropped 4 (one extra
      // for slack). Each block falls from the sky into the mining
      // triangle.
      const nowMs = performance.now();
      if (this._spawned < 4 && nowMs - this._lastSpawnAt > 1500) {
        try { spawnBlock(0); this._spawned++; this._lastSpawnAt = nowMs; }
        catch (e) { console.warn('[tutorial] spawnBlock', e); }
      }
      // Tick ores so they animate toward the player (auto-collect).
      try { updateOres(dt, player); } catch (e) {}
      // Arrows on every active block — both falling and grounded — so
      // the player can spot them through the floor texture's busy
      // colors. blocks is the live array exported from blocks.js;
      // each entry has .pos (x, z) and .destroyed. We cap at 6 arrows
      // so the screen doesn't fill if multiple spawn at once.
      const arrows = [];
      for (const b of blocks) {
        if (!b || b.destroyed) continue;
        arrows.push({ x: b.pos.x, z: b.pos.z, label: 'ORE' });
        if (arrows.length >= 6) break;
      }
      S.tutorialArrows = arrows;
    },
    isComplete() {
      return (S.blocksMined - this._baseline) >= 3;
    },
    onComplete() {
      // Leave miningActive on — having S.miningActive true outside of
      // a wave is harmless, but reset it so subsequent lessons don't
      // get block-collision branches wrongly.
      S.miningActive = false;
    },
    progress() {
      const n = Math.max(0, (S.blocksMined - this._baseline));
      return Math.min(3, n) + ' / 3';
    },
  });

  // ----- 8. ESCORT THE GENERATOR -----
  // Spawns the real escortTruck. updateEscortTruck is already called
  // every frame from main.js's animate loop with real player+enemies
  // args when S.tutorialMode is true. The truck moves when player is
  // nearby and the path is clear; we spawn one stationary blocker
  // enemy in the middle so the player has to fight to advance.
  list.push({
    id: 'escort',
    label: 'ESCORT THE GENERATOR',
    hint: 'Stay close to the truck and clear the path. Defeat the enemy blocking it from reaching the silo.',
    _blocker: null,
    _blockerSpawned: false,
    _goalRing: null,
    onActivate() {
      this._blocker = null;
      this._blockerSpawned = false;
      // Truck path: short and clear. Halved from the earlier (-22..22)
      // version so the lesson doesn't drag.
      const FROM = { x: -10, z: 0 };
      const TO   = { x:  10, z: 0 };
      try {
        spawnEscortTruck(0, FROM, TO);
        S.isEscortWave = true;
      } catch (e) { console.warn('[tutorial] escort', e); }

      // Spawn the blocker IMMEDIATELY, right in front of the truck
      // (x=-7, just 3u ahead of the FROM point at -10). Stationary
      // so the player has to engage and clear it before the truck
      // can advance. Earlier this spawn was deferred to the first
      // onUpdate frame which gave the truck time to start rolling
      // BEFORE encountering resistance — the user wanted the
      // conflict to start at frame zero.
      try {
        const tint = tutorialEnemyColor(0xffffff);
        const e = makeEnemy('zomeeb', tint, new THREE.Vector3(-7, 0, 0));
        if (e) {
          e.speed = 0;
          this._blocker = e;
          this._blockerSpawned = true;
          _activeEnemies.add(e);
        }
      } catch (err) { console.warn('[tutorial] escort blocker', err); }

      // Visible goal ring at the destination so the player has a
      // concrete "deliver here" target. Tinted with the chapter
      // color so it matches the rest of the tutorial palette.
      const tint2 = CHAPTERS[(S.chapter || 0) % CHAPTERS.length].full.grid1;
      const ringGeo = new THREE.RingGeometry(2.0, 2.4, 48);
      const ringMat = new THREE.MeshBasicMaterial({
        color: tint2, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(TO.x, 0.06, TO.z);
      scene.add(ring);
      this._goalRing = ring;
      _activeProps.push(ring);
      // Inner translucent disc so the ring reads as a "pad" not a
      // floating outline.
      const discGeo = new THREE.CircleGeometry(2.0, 36);
      const discMat = new THREE.MeshBasicMaterial({
        color: tint2, transparent: true, opacity: 0.18,
      });
      const disc = new THREE.Mesh(discGeo, discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(TO.x, 0.05, TO.z);
      scene.add(disc);
      _activeProps.push(disc);
    },
    onUpdate(dt) {
      // Pulse the goal ring so it reads as "alive" — same blink we
      // use on cannon corner pads.
      if (this._goalRing && this._goalRing.material) {
        this._goalRing.material.opacity = 0.65 + 0.30 * Math.sin(performance.now() * 0.005);
      }
      // Arrow → truck (or blocker if alive). Blocker is spawned in
      // onActivate now, no first-frame deferral needed.
      const arrows = [];
      const blockerAlive = this._blocker && this._blocker.hp > 0;
      if (blockerAlive) {
        arrows.push({ x: this._blocker.pos.x, z: this._blocker.pos.z, label: 'ENEMY', panic: true });
      }
      const tp = getTruckPos();
      if (tp) arrows.push({ x: tp.x, z: tp.z, label: 'TRUCK' });
      S.tutorialArrows = arrows;
    },
    isComplete() {
      return isTruckArrived();
    },
    onComplete() {
      // Defensive audio cue — the escortTruck module also fires
      // Audio.truckDecompression() on arrival, but in tutorial mode
      // that path has been observed to miss occasionally (possibly
      // because the truck arrives within a single frame between the
      // updateEscortTruck call and the lesson's isComplete poll).
      // Calling it again here is idempotent — it's a one-shot cue
      // — and guarantees the player hears the delivery the moment
      // the lesson advances. Worst case: it fires twice, which the
      // human ear reads as one big arrival rather than a doubled
      // sound.
      try { Audio.truckDecompression && Audio.truckDecompression(); } catch (e) {}
      try { clearEscortTruck(); } catch (e) {}
      S.isEscortWave = false;
    },
  });

  // ----- 9. CHARGE CANNON · DESTROY HIVE SHIELDS -----
  // Uses the REAL cannon module + queen hive. We mirror the corner-
  // charging loop from waves.js: 4 corner zones, stand on one to
  // charge it, fire the cannon, pop a hive shield, move to next
  // corner. Done when all 4 shields are popped.
  //
  // CORNER_CHARGE_DURATION here matches the value used in waves.js
  // (1.6s). _spawnTutorialZone is reused for visible glowing pads
  // OVER the cannon's actual corner positions — gives the tutorial
  // a brighter target than the cannon's native corner mesh while
  // still using the cannon's real spatial layout.
  const CORNER_CHARGE_DURATION = 1.6;
  list.push({
    id: 'cannon',
    label: 'CHARGE CANNON · DROP SHIELDS',
    hint: 'Stand on each glowing CORNER pad to charge the cannon. Each charge fires a shot that pops a hive shield. 4 shields = done.',
    _shotIdx: 0,
    _chargeT: 0,
    _phase: 'corner-charging',     // 'corner-charging' | 'reload' | 'done'
    _reloadT: 0,
    _bigZones: [],                  // visible bigger ring overlays for clarity
    onActivate() {
      this._shotIdx = 0;
      this._chargeT = 0;
      this._phase = 'corner-charging';
      this._reloadT = 0;
      this._bigZones = [];
      try {
        spawnCannon(0);
        spawnQueenHive(0);
        // Transition cannon IDLE → ARMED so forceFireCannon() passes
        // its state guard. Without this the function early-returns
        // false and Audio.cannonFire() never plays. Discovered while
        // chasing missing tutorial audio.
        armCannon();
      } catch (e) { console.warn('[tutorial] cannon/queen', e); }
      // Activate the first cannon corner so the cannon module shows
      // its native ring there; we add a bigger bright overlay too.
      try { setActiveCannonCorner(0); } catch (e) {}
      this._refreshOverlay();
    },
    _refreshOverlay() {
      // Tear down old overlay rings.
      for (const z of this._bigZones) {
        if (z.ring && z.ring.parent) z.ring.parent.remove(z.ring);
        if (z.disc && z.disc.parent) z.disc.parent.remove(z.disc);
      }
      this._bigZones = [];
      // Spawn one big bright zone over the active corner. Single
      // uniform color across all four corners — the chapter's grid
      // tint, matching the look the user wants extended into the
      // main game's cannon visuals too.
      const idx = this._shotIdx;
      if (idx >= 4) return;
      let pos = null;
      try { pos = getCannonCornerPos(idx); } catch (e) {}
      if (!pos) return;
      const tint = CHAPTERS[(S.chapter || 0) % CHAPTERS.length].full.grid1;
      const big = _spawnTutorialZone(pos.x, pos.z, 3.0, tint);
      this._bigZones.push(big);
    },
    onUpdate(dt) {
      // Arrow → active corner (or queen hive if all corners done).
      const arrows = [];
      if (this._phase === 'corner-charging') {
        const idx = this._shotIdx;
        let cp = null;
        try { cp = getCannonCornerPos(idx); } catch (e) {}
        if (cp) arrows.push({ x: cp.x, z: cp.z, label: 'CHARGE' });
      } else {
        const q = getQueen && getQueen();
        if (q && q.pos) arrows.push({ x: q.pos.x, z: q.pos.z, label: 'HIVE', panic: true });
      }
      S.tutorialArrows = arrows;

      // PHASE: corner-charging
      if (this._phase === 'corner-charging') {
        const idx = this._shotIdx;
        let cornerPos = null;
        try { cornerPos = getCannonCornerPos(idx); } catch (e) {}
        if (cornerPos) {
          const ddx = player.pos.x - cornerPos.x;
          const ddz = player.pos.z - cornerPos.z;
          // Bigger acceptance radius (3.0) matches the bigger overlay
          // ring so the player gets credit standing on the glowing pad.
          const inCorner = (ddx * ddx + ddz * ddz) < (3.0 * 3.0);
          if (inCorner) {
            this._chargeT = Math.min(CORNER_CHARGE_DURATION, this._chargeT + dt);
            // Periodic charging audio — short ascending hum every
            // ~0.4s so the player audibly hears the charge climbing.
            // Pitched higher as progress climbs (Audio.cannonChargingTick
            // takes a 0..1 progress value). Without this the corner-
            // charge phase felt silent in tutorial; the production
            // game gets the same cue from waves.js.
            this._chargeAudioT = (this._chargeAudioT || 0) - dt;
            if (this._chargeAudioT <= 0) {
              this._chargeAudioT = 0.40;
              try {
                Audio.cannonChargingTick && Audio.cannonChargingTick(
                  this._chargeT / CORNER_CHARGE_DURATION
                );
              } catch (e) {}
            }
          } else {
            this._chargeT = Math.max(0, this._chargeT - dt * 0.3);
            // Reset the audio timer when player leaves the pad so the
            // next time they step in, the cue fires immediately rather
            // than after a stale gap.
            this._chargeAudioT = 0;
          }
          try { setCannonCornerProgress(this._chargeT / CORNER_CHARGE_DURATION); } catch (e) {}
          // Animate the big overlay ring/disc to track progress.
          const t = this._chargeT / CORNER_CHARGE_DURATION;
          const big = this._bigZones[0];
          if (big) {
            if (big.disc && big.disc.material) big.disc.material.opacity = 0.18 + t * 0.5;
            if (big.ring && big.ring.material) big.ring.material.opacity = 0.6 + 0.4 * Math.sin(performance.now() * 0.01);
          }
          // Fire on full charge.
          if (this._chargeT >= CORNER_CHARGE_DURATION) {
            try {
              const q = getQueen && getQueen();
              if (q && q.pos) {
                forceFireCannon(q.pos);
                const muzzle = getCannonOrigin && getCannonOrigin();
                const dome = getNextDomePos && getNextDomePos();
                if (muzzle && dome) spawnCannonBeam(muzzle, dome);
              }
              popQueenShield();
              consumeCannonCorner(idx);
            } catch (e) { console.warn('[tutorial] cannon fire', e); }
            // Visual: green pop on the corner.
            hitBurst(new THREE.Vector3(cornerPos.x, 1, cornerPos.z), 0x55ff77, 12);
            this._shotIdx = idx + 1;
            this._chargeT = 0;
            this._reloadT = 0.8;            // shorter reload for tutorial
            this._phase = 'reload';
            try { setActiveCannonCorner(-1); } catch (e) {}
          }
        }
      }
      // PHASE: reload
      else if (this._phase === 'reload') {
        this._reloadT = Math.max(0, this._reloadT - dt);
        if (this._reloadT <= 0) {
          if (this._shotIdx >= 4) {
            this._phase = 'done';
          } else {
            this._phase = 'corner-charging';
            try { setActiveCannonCorner(this._shotIdx); } catch (e) {}
            this._refreshOverlay();
          }
        }
      }
    },
    isComplete() {
      // Done when all 4 shields are popped (queen shields = 0)
      // OR phase advanced to done (defensive fallback).
      try { return queenShieldsRemaining() === 0; }
      catch (e) { return this._phase === 'done'; }
    },
    onComplete() {
      try { clearCannon(); } catch (e) {}
      try { clearQueenHive(); } catch (e) {}
      // Tear down our overlay rings.
      for (const z of this._bigZones) {
        if (z.ring && z.ring.parent) z.ring.parent.remove(z.ring);
        if (z.disc && z.disc.parent) z.disc.parent.remove(z.disc);
      }
      this._bigZones = [];
    },
    progress() {
      let remaining = 4;
      try { remaining = queenShieldsRemaining(); } catch (e) {}
      const popped = 4 - remaining;
      return popped + ' / 4 shields';
    },
  });

  // ----- 10. TAKE DAMAGE — Tetris + Galaga (non-lethal) -----
  // The user said: walk to the EDGE of the map for hazards. We use
  // the real hazard system but cycle only through Tetris and Galaga
  // here — both deal damage but don't insta-kill. The tutorial-no-die
  // gameOver respawn safety still catches anything weird.
  list.push({
    id: 'hazard_damage',
    label: 'TAKE A HAZARD HIT',
    hint: 'Walk toward the edge of the arena. Tetris and Galaga hazards will rain down — let one hit you.',
    onActivate() {
      // Tells main.js's animate loop to start cycling hazards. In
      // this lesson we restrict the cycle to non-lethal styles.
      S.tutorialHazardCycle = 'damage';        // 'damage' or 'deadly'
    },
    onUpdate() {
      // Suggest a direction: arrow points toward the nearest edge.
      const px = player.pos.x, pz = player.pos.z;
      // Pick whichever edge the player is closest to
      const edges = [
        { x: ARENA - 4, z: pz, d: ARENA - px },
        { x: -ARENA + 4, z: pz, d: ARENA + px },
        { x: px, z: ARENA - 4, d: ARENA - pz },
        { x: px, z: -ARENA + 4, d: ARENA + pz },
      ];
      edges.sort((a, b) => a.d - b.d);
      S.tutorialArrows = [{ x: edges[0].x, z: edges[0].z, label: 'EDGE' }];
    },
    isComplete: () => (_hazardHits - _hazardHitsAtActivate) >= 1,
    onComplete() {
      // Don't turn off the cycle yet — next lesson uses it too. Just
      // change the mode tag; main.js handles the style selection.
      // We leave S.tutorialHazardCycle on the value the next lesson
      // sets in its onActivate.
    },
  });

  // ----- 11. AVOID DEADLY HAZARDS — Minesweeper + Pacman (insta-kill, no-die respawn) -----
  // These hazards insta-kill in the real game. In tutorial the
  // gameOver helper respawns the player at center. The lesson only
  // completes when the player ACTUALLY DIES — chip-damage from a
  // surviving Tetris/Galaga remnant doesn't count, only a real
  // bomb-or-ghost contact that snaps HP to 0. The intent is teaching
  // "these instakill — feel that" so we'd rather force the player
  // to experience the death+respawn cycle than let them dodge through.
  list.push({
    id: 'hazard_deadly',
    label: 'DODGE THE DEADLY',
    hint: 'These hazards INSTANTLY KILL. Walk into a Minesweeper bomb or a Pacman ghost — you respawn in tutorial, but in the real game you would not.',
    onActivate() {
      S.tutorialHazardCycle = 'deadly';
    },
    onUpdate() {
      const px = player.pos.x, pz = player.pos.z;
      const edges = [
        { x: ARENA - 4, z: pz, d: ARENA - px },
        { x: -ARENA + 4, z: pz, d: ARENA + px },
        { x: px, z: ARENA - 4, d: ARENA - pz },
        { x: px, z: -ARENA + 4, d: ARENA + pz },
      ];
      edges.sort((a, b) => a.d - b.d);
      S.tutorialArrows = [{ x: edges[0].x, z: edges[0].z, label: 'EDGE' }];
    },
    // Counter is only bumped by main.js when HP drops from positive
    // to ≤0 — i.e., a true insta-kill from a bomb tile or ghost.
    isComplete: () => (_deadlyHazardHits - _deadlyHazardHitsAtActivate) >= 1,
    onComplete() {
      S.tutorialHazardCycle = false;
    },
    progress() {
      const n = _deadlyHazardHits - _deadlyHazardHitsAtActivate;
      return n > 0 ? '✓' : 'walk into a bomb or ghost';
    },
  });

  // ----- 12. HEAL & THROW — pick up a potion + grenade, use both -----
  // Expanded from a simple "use a potion" task. Lesson 11 (DODGE THE
  // DEADLY) almost certainly killed the player at least once — they
  // respawned at center via the tutorial's no-die handler. Now we
  // spawn a potion AND a grenade pickup right where they respawned,
  // forcing them to walk over both, pick them up, and USE both
  // (H for potion, G for grenade). Teaches the full healing /
  // explosive-utility loop in one beat.
  //
  // Why we zero out S.potions and S.grenadeCharges on activate:
  // the spawned pickups need to be REQUIRED. If the player already
  // has a potion or grenade in their inventory from earlier wave
  // drops, the lesson's progression becomes ambiguous (did they
  // pick up the new ones, or use a stockpile?). Forcing zero starts
  // them on a clean slate.
  // ----- 12. HEAL & THROW — pick up a potion + grenade, use both -----
  // Expanded from a simple "use a potion" task. Lesson 11 (DODGE THE
  // DEADLY) almost certainly killed the player at least once — they
  // respawned at center via the tutorial's no-die handler. Now we
  // spawn a potion AND a grenade pickup right at center, forcing
  // them to walk over both, pick them up, and USE both.
  //
  // Two things make this lesson resilient:
  //   1. Picking up a potion auto-heals the player if they're hurt.
  //      That auto-heal counts as "potion used" for lesson progress
  //      (notify wired in pickups.js — fires from BOTH the auto-heal
  //      branch and the H-key tryUsePotion branch). Without that, a
  //      player with low HP would auto-heal on touch and the potion
  //      would never enter inventory, leaving the lesson stuck.
  //   2. Pickups respawn every ~6s if they've been collected. Player
  //      can't get stuck even if they wander away or accidentally
  //      pick up only one item.
  //
  // Why we zero out S.potions and S.grenadeCharges on activate: the
  // spawned pickups need to be REQUIRED. If the player already had
  // a potion or grenade in their inventory from earlier wave drops,
  // the lesson's progression becomes ambiguous (did they pick up the
  // new ones, or use a stockpile?). Drops are also blocked from
  // enemies during early lessons (see main.js's drop-suppress check)
  // so this scenario is mostly defensive.
  list.push({
    id: 'heal',
    label: 'PICK UP & USE POTION + GRENADE',
    hint: 'Walk over the items at center. Press H to heal, G to throw the grenade.',
    _respawnTimer: 0,
    _spawnX: 0,
    _spawnZ: 0,
    onActivate() {
      // Clear inventory so pickups are required, not optional.
      S.potions = 0;
      S.grenadeCharges = 0;
      // Drop HP so the potion actually does something (tryUsePotion
      // refuses if HP is full).
      if (S.hp >= S.hpMax) {
        S.hp = Math.max(1, Math.floor(S.hpMax * 0.5));
      }
      this._spawnX = 0;
      this._spawnZ = 0;
      this._respawnTimer = 0;
      this._spawnHealPair();
    },
    _spawnHealPair() {
      // Spawn both pickups at center. Slight separation so the
      // meshes don't visually overlap.
      try {
        spawnPickup('potion', new THREE.Vector3(this._spawnX - 1.2, 0.5, this._spawnZ));
        spawnPickup('grenade', new THREE.Vector3(this._spawnX + 1.2, 0.5, this._spawnZ));
      } catch (e) { console.warn('[tutorial] heal pickups', e); }
    },
    _hasPickupOfKind(kind) {
      // Scan the live pickups array. Used to detect which kinds
      // have been collected so we only respawn the missing ones.
      try {
        for (const p of pickups) {
          if (p && p.kind === kind) return true;
        }
      } catch (e) {}
      return false;
    },
    onUpdate(dt) {
      // Respawn any missing pickup every ~6 seconds. We check kind
      // individually so if the player only collected the potion,
      // the existing grenade is left alone instead of getting a
      // duplicate spawned next to it.
      this._respawnTimer -= dt;
      if (this._respawnTimer <= 0) {
        this._respawnTimer = 6.0;
        try {
          if (!this._hasPickupOfKind('potion')) {
            spawnPickup('potion', new THREE.Vector3(this._spawnX - 1.2, 0.5, this._spawnZ));
          }
          if (!this._hasPickupOfKind('grenade')) {
            spawnPickup('grenade', new THREE.Vector3(this._spawnX + 1.2, 0.5, this._spawnZ));
          }
        } catch (e) {}
      }
      // Arrows → unused pickups. Arrow points at the spawn anchor
      // because the pickup auto-magnet pull will draw the player in
      // once they're close.
      const cx = this._spawnX;
      const cz = this._spawnZ;
      const arrows = [];
      const potionUsed = (_potionsConsumed - _potionsConsumedAtActivate) >= 1;
      const grenadeUsed = (_grenadesThrown - _grenadesThrownAtActivate) >= 1;
      if (!potionUsed) arrows.push({ x: cx - 1.2, z: cz, label: 'POTION' });
      if (!grenadeUsed) arrows.push({ x: cx + 1.2, z: cz, label: 'GRENADE' });
      S.tutorialArrows = arrows;
    },
    isComplete() {
      const potionUsed = (_potionsConsumed - _potionsConsumedAtActivate) >= 1;
      const grenadeUsed = (_grenadesThrown - _grenadesThrownAtActivate) >= 1;
      return potionUsed && grenadeUsed;
    },
    progress() {
      const potionUsed = (_potionsConsumed - _potionsConsumedAtActivate) >= 1;
      const grenadeUsed = (_grenadesThrown - _grenadesThrownAtActivate) >= 1;
      const a = potionUsed ? '✓ POTION' : 'POTION';
      const b = grenadeUsed ? '✓ GRENADE' : 'GRENADE';
      return a + ' · ' + b;
    },
  });

  // ----- 13. OVERDRIVE — 25-streak triggers overdrive (HORDE MODE) -----
  // Wave-6 finale. Floods the arena with enemies so the player can
  // realistically chain 25 kills. Earlier versions trickled one enemy
  // at a time and felt empty; this version spawns enemies in BATCHES
  // and ramps the batch size + max-alive cap aggressively. The intent
  // matches the user's direction: "BRING IT ON. Forget the slow
  // trickle." By streak 10 the screen should already feel busy; by
  // streak 25 it's a swarm.
  //
  // Batch spawn pattern: each spawn tick drops `batchSize` enemies in
  // a fan around the player, distributed across a 360° spread so they
  // don't all funnel from one direction. Distance jittered 12–18u
  // (always within the player's screen, never offscreen).
  list.push({
    id: 'overdrive',
    label: 'OVERDRIVE · 25 KILL STREAK',
    hint: 'CHAIN 25 KILLS without breaking your streak. The hordes are coming. Hit 25 → OVERDRIVE.',
    _streakAtActivate: 0,
    _spawnTimer: 0,
    onActivate() {
      // Snapshot streak so existing kills don't pre-fill progress.
      this._streakAtActivate = S.killstreak || 0;
      this._spawnTimer = 0;
      // Seed the arena IMMEDIATELY with a starter batch — no awkward
      // "where are the enemies?" pause after the lesson activates.
      const seedCount = 6;
      for (let i = 0; i < seedCount; i++) {
        const ang = (i / seedCount) * Math.PI * 2 + Math.random() * 0.4;
        const dist = 13 + Math.random() * 5;
        _spawnTutorialEnemy(ang, dist);
      }
    },
    onUpdate(dt) {
      // Streak progress 0..25.
      const progress = Math.max(0, (S.killstreak || 0) - this._streakAtActivate);
      // HORDE ramp — wide-open caps and short intervals from the
      // start, climbing into chaos by 25.
      //
      //   progress  0 → maxAlive  8, batch 2, interval 0.50s
      //   progress  5 → maxAlive 14, batch 3, interval 0.35s
      //   progress 10 → maxAlive 20, batch 4, interval 0.22s
      //   progress 15 → maxAlive 25, batch 5, interval 0.15s
      //   progress 20 → maxAlive 28, batch 6, interval 0.12s
      //   progress 25 → maxAlive 30, batch 6, interval 0.10s
      //
      // Linear lerp between the two anchor points the progress sits
      // between. batchSize is rounded UP so a partial-progress bump
      // promotes early. maxAlive caps the on-screen total so the
      // browser doesn't choke even at peak swarm.
      const ramp = [
        { p:  0, max:  8, batch: 2, interval: 0.50 },
        { p:  5, max: 14, batch: 3, interval: 0.35 },
        { p: 10, max: 20, batch: 4, interval: 0.22 },
        { p: 15, max: 25, batch: 5, interval: 0.15 },
        { p: 20, max: 28, batch: 6, interval: 0.12 },
        { p: 25, max: 30, batch: 6, interval: 0.10 },
      ];
      let maxAlive = ramp[ramp.length - 1].max;
      let batchSize = ramp[ramp.length - 1].batch;
      let spawnInterval = ramp[ramp.length - 1].interval;
      for (let i = 0; i < ramp.length - 1; i++) {
        const a = ramp[i], b = ramp[i + 1];
        if (progress >= a.p && progress < b.p) {
          const t = (progress - a.p) / (b.p - a.p);
          maxAlive = a.max + (b.max - a.max) * t;
          batchSize = a.batch + (b.batch - a.batch) * t;
          spawnInterval = a.interval + (b.interval - a.interval) * t;
          break;
        }
      }
      maxAlive = Math.floor(maxAlive);
      batchSize = Math.ceil(batchSize);

      this._spawnTimer -= dt;
      if (this._spawnTimer <= 0) {
        this._spawnTimer = spawnInterval;
        // Spawn the batch as a fan around the player. Don't blow past
        // maxAlive — clip the batch to the remaining headroom.
        const alive = _alivePlayerSpawnedEnemies();
        const room = Math.max(0, maxAlive - alive);
        const drop = Math.min(batchSize, room);
        const spreadStart = Math.random() * Math.PI * 2;   // randomize fan rotation each tick
        for (let i = 0; i < drop; i++) {
          const ang = spreadStart + (i / Math.max(1, drop)) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
          const dist = 12 + Math.random() * 6;
          _spawnTutorialEnemy(ang, dist);
        }
      }
      // Arrow → nearest enemy so the player can find prey fast.
      let nearest = null, bestD2 = Infinity;
      for (const e of _activeEnemies) {
        if (!e || e.hp <= 0) continue;
        const dx = e.pos.x - player.pos.x;
        const dz = e.pos.z - player.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; nearest = e; }
      }
      S.tutorialArrows = nearest
        ? [{ x: nearest.pos.x, z: nearest.pos.z, label: 'CHAIN' }]
        : [];
      // Streak check — once we cross 25 since activation, fire the
      // overdrive request. main.js consumes the flag in the same
      // frame and clears it.
      if (progress >= 25 && !S.overdriveActive) {
        S.tutorialRequestOverdrive = true;
      }
    },
    isComplete() {
      // Lesson completes the moment overdrive engages.
      return !!S.overdriveActive;
    },
    onComplete() {
      S.tutorialRequestOverdrive = false;
      S.tutorialArrows = [];
    },
    progress() {
      const n = Math.max(0, (S.killstreak || 0) - this._streakAtActivate);
      return Math.min(25, n) + ' / 25';
    },
  });

  return list;
}

// =====================================================================
// BONUS STRATAGEM LESSONS — appended on tutorial completion via the
// Helldivers ↑→↓↓↓ secret code. tutorialSecret.js calls
// appendBonusStratagemLessons(); the controller's _activeIdx remains
// pointed at the current lesson, but _lessons now has 14 entries
// instead of 11, and waves 12-14 fire when the player advances past
// 11 (overdrive). Each bonus lesson grants a temporary stratagem
// artifact at activation so the player can practice without having
// earned it via the (yet-unbuilt) chapter-7 pickup.
// =====================================================================
// Called from main.js after appendBonusStratagemLessons() has run.
// _advance() set _activeIdx to the sentinel "all done" value when the
// last regular lesson finished; we now have new lessons to play, so
// roll _activeIdx back to the first bonus lesson and fire its
// onActivate hook so the lesson registers its observer callbacks.
export function resumeIntoBonusLessons() {
  if (!_lessons || !_lessons.length) return false;
  // Find the first bonus (strat_*) lesson and set _activeIdx to it.
  for (let i = 0; i < _lessons.length; i++) {
    if (_lessons[i] && _lessons[i].id && _lessons[i].id.startsWith('strat_')) {
      _activeIdx = i;
      // Reset per-lesson baselines so the bonus lessons measure
      // progress relative to "now" rather than tutorial start.
      _enemyKillCountAtActivate = _enemyKillCount;
      _shotCountAtActivate = _shotCount;
      _walkDistanceAtActivate = _walkDistance;
      _dashCountAtActivate = _dashCount;
      _hazardHitsAtActivate = _hazardHits;
      _deadlyHazardHitsAtActivate = _deadlyHazardHits;
      _potionsConsumedAtActivate = _potionsConsumed;
      _grenadesThrownAtActivate = _grenadesThrown;
      _weaponsTried.clear();
      const lesson = _lessons[i];
      if (lesson.onActivate) {
        try { lesson.onActivate(); } catch (e) { console.warn('[bonus onActivate]', e); }
      }
      renderChecklist();
      return true;
    }
  }
  return false;
}

export function appendBonusStratagemLessons() {
  if (!_lessons || !_lessons.length) return;
  // Idempotent — bail if bonus lessons already in the list.
  for (const l of _lessons) {
    if (l && l.id && l.id.startsWith('strat_')) return;
  }
  // Wrap the imported artifact granter in a try so a single failure
  // doesn't break lesson activation.
  const grantArtifact = (id, n) => {
    try { grantStratagemArtifact(id, n); }
    catch (e) { console.warn('[bonus lesson] grantArtifact', e); }
  };

  // Helper: a per-lesson enemy spawn ticker. Each bonus lesson
  // creates one of these in onActivate and ticks it from onUpdate.
  // Spawns enemies in a slow trickle from random arena edge points
  // so the player has live targets to practice their stratagem on
  // — but the trickle is gentle enough that the player can't be
  // overwhelmed while they fumble with codes.
  const _bonusSpawner = (interval, type, maxAlive) => {
    return {
      _t: 0.0,
      _interval: interval,
      _type: type || 'zomeeb',
      _maxAlive: maxAlive || 5,
      tick(dt) {
        // Don't spawn while the stratagem menu is open — slow-mo will
        // still tick this clock but giving the player a fresh enemy
        // mid-code-entry feels punitive. (Slow-mo already eases the
        // pressure; we don't need to compound it.)
        this._t += dt;
        if (this._t < this._interval) return;
        this._t -= this._interval;
        if (_alivePlayerSpawnedEnemies() >= this._maxAlive) return;
        // Random angle from arena edge.
        const a = Math.random() * Math.PI * 2;
        const dist = 11 + Math.random() * 3;
        _spawnTutorialEnemy(a, dist, this._type);
      },
    };
  };

  // ---- 12. SENTRY TURRET ----
  // Single turret code; player picks variant via 1/2/3/4 in the
  // stratagem menu before releasing RMB. Slow zomeeb trickle so the
  // turret has something to chew on.
  _lessons.push({
    id: 'strat_turret',
    label: 'STRATAGEM · TURRET',
    hint: 'Hold RIGHT MOUSE · press 1-4 to pick MG/TESLA/FLAME/ANTITANK · enter ↓↑→↓↑ · release.',
    _called: false,
    _spawner: null,
    onActivate() {
      this._called = false;
      grantArtifact('turret', 3);
      this._spawner = _bonusSpawner(2.4, 'zomeeb', 4);
      if (typeof window !== 'undefined') {
        window.__bonusObserve = window.__bonusObserve || {};
        window.__bonusObserve.onCall = (id) => { if (id === 'turret') this._called = true; };
      }
    },
    onUpdate(dt) {
      if (this._spawner) this._spawner.tick(dt);
    },
    onComplete() {
      if (typeof window !== 'undefined' && window.__bonusObserve) {
        window.__bonusObserve.onCall = null;
      }
    },
    isComplete() { return this._called; },
    progress() {
      if (this._called) return '✓ TURRET DEPLOYED';
      return '↓↑→↓↑';
    },
  });

  // ---- 13. MINE FIELD ----
  // One code, in-menu picker (1/2/3 = explosion/fire/poison) — same
  // pattern as mech and turret. Faster zomeeb trickle so the player
  // gets enough enemies to trip the mines on.
  _lessons.push({
    id: 'strat_mines',
    label: 'STRATAGEM · MINE FIELD',
    hint: 'Hold RIGHT MOUSE · press 1-3 to pick HE/INCEND/TOX · enter ↓→→↓ · release.',
    _called: false,
    _spawner: null,
    onActivate() {
      this._called = false;
      grantArtifact('mines', 3);
      this._spawner = _bonusSpawner(1.8, 'zomeeb', 6);
      if (typeof window !== 'undefined') {
        window.__bonusObserve = window.__bonusObserve || {};
        window.__bonusObserve.onCall = (id) => { if (id === 'mines') this._called = true; };
      }
    },
    onUpdate(dt) {
      if (this._spawner) this._spawner.tick(dt);
    },
    onComplete() {
      if (typeof window !== 'undefined' && window.__bonusObserve) {
        window.__bonusObserve.onCall = null;
      }
    },
    isComplete() { return this._called; },
    progress() {
      if (this._called) return '✓ MINES DEPLOYED';
      return '↓→→↓';
    },
  });

  // ---- 14. EXOSUIT + THERMONUCLEAR ----
  // Final bonus wave teaches the two heavy-hitters together. The
  // lesson clears once the player has both called the mech (and
  // entered it briefly) AND detonated a thermonuclear. Bigger swarm
  // so the nuke and the mech feel impactful.
  _lessons.push({
    id: 'strat_finale',
    label: 'STRATAGEM · EXOSUIT + NUKE',
    hint: 'EXOSUIT: ↓↑→→↑ (1/2/3 picks weapon). THERMONUCLEAR: ↑→↓↓↓.',
    _mechCalled: false,
    _mechEntered: false,
    _nukeDetonated: false,
    _spawner: null,
    onActivate() {
      this._mechCalled = false;
      this._mechEntered = false;
      this._nukeDetonated = false;
      grantArtifact('mech', 2);
      grantArtifact('thermonuclear', 2);
      this._spawner = _bonusSpawner(1.4, 'zomeeb', 9);
      if (typeof window !== 'undefined') {
        window.__bonusObserve = window.__bonusObserve || {};
        window.__bonusObserve.onCall = (id) => {
          if (id === 'mech') this._mechCalled = true;
        };
        window.__bonusObserve.onMechEnter = () => { this._mechEntered = true; };
        window.__bonusObserve.onDetonate = (id) => {
          if (id === 'thermonuclear') this._nukeDetonated = true;
        };
      }
    },
    onUpdate(dt) {
      if (this._spawner) this._spawner.tick(dt);
    },
    onComplete() {
      if (typeof window !== 'undefined' && window.__bonusObserve) {
        window.__bonusObserve.onCall = null;
        window.__bonusObserve.onMechEnter = null;
        window.__bonusObserve.onDetonate = null;
      }
    },
    isComplete() {
      return this._mechEntered && this._nukeDetonated;
    },
    progress() {
      const mechOk = this._mechEntered ? '✓ MECH' :
                     (this._mechCalled ? 'walk to mech' : 'MECH');
      const nukeOk = this._nukeDetonated ? '✓ NUKE' : 'NUKE';
      return mechOk + ' · ' + nukeOk;
    },
  });
}

// ---------------------------------------------------------------------
// Checklist UI
// ---------------------------------------------------------------------
let _checklistEl = null;

function _ensureChecklistEl() {
  if (_checklistEl && _checklistEl.parentNode) return _checklistEl;
  const el = document.createElement('div');
  el.id = 'tutorial-checklist';
  el.style.cssText = [
    'position: fixed',
    'top: 80px',
    'right: 20px',
    'width: 320px',
    'padding: 18px 20px',
    'background: rgba(8, 4, 18, 0.78)',
    'border: 1px solid rgba(255, 217, 61, 0.35)',
    'box-shadow: 0 0 24px rgba(255, 217, 61, 0.15)',
    'font-family: \'Impact\', monospace',
    'color: #ddd',
    'z-index: 50',
    'pointer-events: none',
    'user-select: none',
  ].join(';');
  document.body.appendChild(el);
  _checklistEl = el;
  return el;
}

export function renderChecklist(_pulseLatestDone) {
  const el = _ensureChecklistEl();
  if (_lessons.length === 0) { el.style.display = 'none'; return; }
  el.style.display = '';

  // Detect mobile (narrow viewport OR coarse pointer). On mobile we
  // render a compact view: only the active lesson + a "X / Y"
  // progress counter, so the panel doesn't cover most of the
  // playscreen. Desktop keeps the full rolling checklist.
  const isMobile = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;

  // Swap desktop keyboard/mouse language to mobile touch language
  // when rendering the mobile view. Per playtester: "tap the icons"
  // instead of "press H/G", "joystick" instead of "WASD", "press
  // FIRE" instead of "hold LEFT MOUSE". Phrase-level swaps so we
  // don't have to fork all lesson definitions. Only the public-
  // facing hints get rewritten; lesson labels and progress strings
  // stay as authored.
  function _localizeHint(text) {
    if (!isMobile || !text) return text;
    return text
      // Movement
      .replace(/Walk with WASD/gi, 'Walk with the joystick')
      .replace(/\bWASD\b/g, 'joystick')
      // Fire
      .replace(/hold LEFT MOUSE/gi, 'press FIRE')
      .replace(/HOLD LEFT MOUSE/g, 'PRESS FIRE')
      .replace(/LEFT MOUSE/g, 'FIRE')
      // Weapon cycling
      .replace(/Press 2 \/ 3 \/ 4 \/ 5 \/ 6 to cycle weapons\./gi,
               'Tap a weapon slot on the wheel to switch.')
      .replace(/Press 2 \/ 3 \/ 4 \/ 5 \/ 6/gi, 'Tap a weapon slot')
      // Heal / grenade
      .replace(/Press H to heal/gi, 'Tap the potion icon to heal')
      .replace(/[Pp]ress H\b/g, 'tap the potion icon')
      .replace(/G to throw the grenade/gi, 'tap the grenade icon to throw it')
      .replace(/[Pp]ress G\b/g, 'tap the grenade icon')
      // Dash (Space) — keep simple swap in case future lessons mention it
      .replace(/SPACE to dash/gi, 'tap the joystick edge to dash')
      .replace(/[Pp]ress SPACE\b/g, 'tap the joystick edge');
  }

  if (isMobile) {
    // Compact mobile view — single active lesson + progress count.
    const total = _lessons.length;
    const done = Math.min(_activeIdx, total);
    const active = _lessons[_activeIdx];
    let html = '<div style="font-size:10px;letter-spacing:2px;color:#ffd93d;margin-bottom:4px;">' +
      'TUTORIAL · ' + done + ' / ' + total + '</div>';
    if (active) {
      html += '<div style="font-size:11px;letter-spacing:1.5px;color:#ffd93d;line-height:1.25;">';
      html += '<span style="color:#ffd93d;">▶</span> ' + active.label;
      if (active.progress) {
        try {
          const p = active.progress();
          html += ' <span style="color:#fff;float:right;">' + p + '</span>';
        } catch (e) {}
      }
      html += '</div>';
      if (active.hint) {
        html += '<div style="margin:4px 0 0 0;font-size:10px;color:#aaa;letter-spacing:0.5px;line-height:1.35;font-family:Arial,sans-serif;">';
        html += _localizeHint(active.hint);
        html += '</div>';
      }
    } else if (_activeIdx >= total) {
      html += '<div style="font-size:12px;color:#7af797;">TUTORIAL COMPLETE</div>';
    }
    el.innerHTML = html;
    return;
  }

  // Desktop full view.
  let html = '<div style="font-size:12px;letter-spacing:3px;color:#ffd93d;margin-bottom:12px;">' +
    'TUTORIAL · OBJECTIVES</div>';
  for (let i = 0; i < _lessons.length; i++) {
    const lesson = _lessons[i];
    const isActive = i === _activeIdx;
    const isDone = i < _activeIdx;
    let labelColor = '#666';
    let prefix = '<span style="color:#444;">○</span>';
    let labelStyle = '';
    if (isDone) {
      labelColor = '#7af797';
      prefix = '<span style="color:#7af797;">✓</span>';
      labelStyle = 'text-decoration: line-through; opacity: 0.6;';
    } else if (isActive) {
      labelColor = '#ffd93d';
      prefix = '<span style="color:#ffd93d;">▶</span>';
    }
    html += `<div style="margin:8px 0;font-size:13px;letter-spacing:1.5px;color:${labelColor};${labelStyle}">`;
    html += `${prefix} &nbsp; ${lesson.label}`;
    if (isActive && lesson.progress) {
      try {
        const p = lesson.progress();
        html += ` <span style="float:right;color:#fff;">${p}</span>`;
      } catch (e) {}
    }
    html += '</div>';
    if (isActive && lesson.hint) {
      html += `<div style="margin:0 0 8px 22px;font-size:11px;color:#aaa;letter-spacing:1px;line-height:1.5;font-family:Arial,sans-serif;">${lesson.hint}</div>`;
    }
  }
  if (_activeIdx >= _lessons.length) {
    html += '<div style="margin-top:16px;font-size:14px;letter-spacing:2px;color:#7af797;text-align:center;">TUTORIAL COMPLETE</div>';
  }
  el.innerHTML = html;
}
