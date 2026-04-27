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
import { WEAPONS, ARENA } from './config.js';
import { hitBurst, makePickup } from './effects.js';
import { scene } from './scene.js';
import { tutorialEnemyColor } from './tutorial.js';

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
let _potionsConsumed = 0;
let _potionsConsumedAtActivate = 0;

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
  _potionsConsumed = 0;
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
export function notifyPotionConsumed() {
  _potionsConsumed++;
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
  _potionsConsumedAtActivate = _potionsConsumed;
  _weaponsTried.clear();
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

  // ----- 1. MOVE -----
  list.push({
    id: 'move',
    label: 'MOVE',
    hint: 'Use WASD to walk around the arena.',
    onActivate: () => {},
    isComplete: () => (_walkDistance - _walkDistanceAtActivate) >= 12,
    progress: () => {
      const d = Math.max(0, _walkDistance - _walkDistanceAtActivate);
      return Math.min(12, Math.round(d)) + ' / 12 m';
    },
  });

  // ----- 2. DASH -----
  list.push({
    id: 'dash',
    label: 'DASH',
    hint: 'Press SPACE to dash forward.',
    isComplete: () => (_dashCount - _dashCountAtActivate) >= 1,
  });

  // ----- 3. SHOOT -----
  list.push({
    id: 'shoot',
    label: 'SHOOT',
    hint: 'Hold the LEFT MOUSE BUTTON to fire your pistol.',
    isComplete: () => (_shotCount - _shotCountAtActivate) >= 5,
    progress: () => {
      const n = Math.max(0, _shotCount - _shotCountAtActivate);
      return Math.min(5, n) + ' / 5 shots';
    },
  });

  // ----- 4. KILL 3 -----
  list.push({
    id: 'kill',
    label: 'DEFEAT 3 MEEBITS',
    hint: 'Three meebits will approach. Take them down with your pistol.',
    onActivate: () => {
      _spawnTutorialEnemy(Math.random() * Math.PI * 2, 16);
      setTimeout(() => _spawnTutorialEnemy(Math.random() * Math.PI * 2, 16), 1500);
      setTimeout(() => _spawnTutorialEnemy(Math.random() * Math.PI * 2, 16), 3000);
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
    hint: 'Defeat more meebits to earn XP and level up. Killing meebits drops health and shield pickups too.',
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
      // Spawn a steady stream of dummies so the player has something
      // to shoot at — driven by onUpdate below.
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

  // ----- 7. CANNON CHARGE -----
  // Stub: spawn 4 charge zones at the four cardinal corners of a
  // small ring around the arena center; require the player to stand
  // in each one for ~2 seconds. We don't reuse the real cannon module
  // here — too tangled with chapter/wave state — but the experience
  // mirrors it.
  list.push({
    id: 'cannon',
    label: 'CHARGE THE CANNON',
    hint: 'Stand on each glowing corner pad to charge the cannon. 4 corners = full charge.',
    _zones: [],
    _filled: [false, false, false, false],
    _chargeT: [0, 0, 0, 0],
    _chargeNeeded: 1.6,
    _cannonProp: null,
    onActivate() {
      this._zones = [];
      this._filled = [false, false, false, false];
      this._chargeT = [0, 0, 0, 0];
      // Cannon prop in the middle — a simple boxy stand-in so the
      // player has a focal point. (We don't import the real cannon
      // module to keep this lesson independent.)
      const cannonGroup = new THREE.Group();
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1.5, 1.8, 1.0, 24),
        new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x0a0a0a, emissiveIntensity: 0.6 }),
      );
      base.position.y = 0.5;
      cannonGroup.add(base);
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.55, 3.5, 16),
        new THREE.MeshStandardMaterial({ color: 0x444444, emissive: 0xffaa33, emissiveIntensity: 0.4 }),
      );
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(0, 1.4, 0);
      cannonGroup.add(barrel);
      cannonGroup.position.set(0, 0, 0);
      scene.add(cannonGroup);
      this._cannonProp = cannonGroup;
      _activeProps.push(cannonGroup);
      // Four corner zones at offsets.
      const offs = [[-6, -6], [6, -6], [-6, 6], [6, 6]];
      const colors = [0xff5555, 0xffdd33, 0x55ddff, 0xdd55ff];
      for (let i = 0; i < 4; i++) {
        const z = _spawnTutorialZone(offs[i][0], offs[i][1], 1.6, colors[i]);
        this._zones.push(z);
      }
    },
    onUpdate(dt) {
      for (let i = 0; i < 4; i++) {
        if (this._filled[i]) continue;
        if (_isPlayerInZone(this._zones[i])) {
          this._chargeT[i] = Math.min(this._chargeNeeded, this._chargeT[i] + dt);
          // Pulse the ring color as it fills.
          const t = this._chargeT[i] / this._chargeNeeded;
          this._zones[i].ring.material.opacity = 0.5 + 0.5 * Math.sin(performance.now() * 0.01);
          this._zones[i].disc.material.opacity = 0.18 + t * 0.4;
          if (this._chargeT[i] >= this._chargeNeeded) {
            this._filled[i] = true;
            this._zones[i].disc.material.color.setHex(0x55ff77);
            this._zones[i].ring.material.color.setHex(0x55ff77);
            // Visual pop + a bigger disc to read as "charged".
            hitBurst(new THREE.Vector3(this._zones[i].x, 1, this._zones[i].z), 0x55ff77, 12);
          }
        }
      }
      // When all four are filled, do a satisfying flash on the cannon.
      if (this._filled.every(Boolean) && this._cannonProp && !this._fired) {
        this._fired = true;
        hitBurst(new THREE.Vector3(0, 1.5, 0), 0xffaa33, 32);
      }
    },
    isComplete() { return !!this._fired; },
    progress() {
      const n = this._filled.filter(Boolean).length;
      return n + ' / 4 corners';
    },
  });

  // ----- 8. ESCORT -----
  // Simple version: spawn a glowing waypoint that walks slowly from
  // one side of the arena to the other. Player has to stay near it
  // (within 8 units) and kill any enemy that spawns between it and
  // the destination. Once the waypoint reaches the goal, complete.
  list.push({
    id: 'escort',
    label: 'ESCORT THE GENERATOR',
    hint: 'Stay close to the generator and clear the path. Kill the meebit blocking the way.',
    _truck: null,
    _truckTargetX: 16,
    _blocker: null,
    _blockerSpawned: false,
    _arrived: false,
    onActivate() {
      // Truck stand-in: an emissive cube on a sled.
      const truck = new THREE.Mesh(
        new THREE.BoxGeometry(2.0, 1.4, 3.0),
        new THREE.MeshStandardMaterial({ color: 0xeeee44, emissive: 0xffcc00, emissiveIntensity: 0.55 }),
      );
      truck.position.set(-16, 0.7, 0);
      scene.add(truck);
      this._truck = truck;
      _activeProps.push(truck);
      // Goal beacon at +16, 0.
      const goal = new THREE.Mesh(
        new THREE.CylinderGeometry(1.4, 1.4, 0.2, 24),
        new THREE.MeshBasicMaterial({ color: 0x00ff66, transparent: true, opacity: 0.5 }),
      );
      goal.position.set(this._truckTargetX, 0.1, 0);
      scene.add(goal);
      _activeProps.push(goal);
      this._arrived = false;
      this._blockerSpawned = false;
    },
    onUpdate(dt) {
      if (!this._truck) return;
      // Spawn one blocker enemy in front of the truck once at start.
      if (!this._blockerSpawned) {
        this._blockerSpawned = true;
        // Block at midpoint.
        const tint = tutorialEnemyColor(0xffffff);
        const e = makeEnemy('zomeeb', tint, new THREE.Vector3(0, 0, 0));
        if (e) {
          e.speed = 0;     // stationary blocker for tutorial clarity
          this._blocker = e;
          _activeEnemies.add(e);
        }
      }
      // Truck advances when player is within 8u and no live blocker.
      if (this._arrived) return;
      const px = player && player.pos ? player.pos.x : 0;
      const pz = player && player.pos ? player.pos.z : 0;
      const dx = px - this._truck.position.x;
      const dz = pz - this._truck.position.z;
      const playerNear = (dx * dx + dz * dz) < 64;        // 8u
      const blockerAlive = this._blocker && this._blocker.hp > 0;
      if (playerNear && !blockerAlive) {
        const dirX = this._truckTargetX - this._truck.position.x;
        if (Math.abs(dirX) > 0.1) {
          const step = Math.min(2.4 * dt, Math.abs(dirX));
          this._truck.position.x += Math.sign(dirX) * step;
        } else {
          this._arrived = true;
          hitBurst(new THREE.Vector3(this._truck.position.x, 1.5, 0), 0x00ff66, 24);
        }
      }
    },
    isComplete() { return !!this._arrived; },
  });

  // ----- 9. MINING — break blocks and collect ore -----
  // Spawn 3 simple "ore blocks" the player has to shoot down. Each
  // destroyed block awards an ore visually; collecting 3 completes
  // the lesson. We use plain meshes with health and intercept hits
  // via raycasts on player fire — but to keep this simple and
  // independent we'll just track a "hits taken" count per block.
  list.push({
    id: 'mining',
    label: 'BREAK 3 BLOCKS',
    hint: 'Shoot the orange ore blocks until they shatter.',
    _oreBlocks: [],
    _broken: 0,
    onActivate() {
      this._oreBlocks = [];
      this._broken = 0;
      // Three ore blocks at known positions.
      const positions = [[-10, -8], [10, -8], [0, 12]];
      for (const [x, z] of positions) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(1.6, 1.6, 1.6),
          new THREE.MeshStandardMaterial({
            color: 0xff7733, emissive: 0xff5500, emissiveIntensity: 0.6,
          }),
        );
        mesh.position.set(x, 0.8, z);
        mesh.userData.tutorialOreHp = 4;        // shots to break
        mesh.userData.tutorialOre = true;
        scene.add(mesh);
        this._oreBlocks.push(mesh);
        _activeProps.push(mesh);
      }
    },
    onUpdate(dt) {
      // Per-frame: detect bullets nearby and damage blocks.
      for (const block of this._oreBlocks) {
        if (!block.parent || block.userData.tutorialOreHp <= 0) continue;
        // Cheap: any of the active bullets close enough on this frame?
        // We can't import bullets cleanly without circular dep risk,
        // so we use a simple proximity check on enemy projectiles? No
        // — those don't exist here. Instead, we use a ray-style hack:
        // when the player is firing and the player's aim points at
        // this block within range, count a hit. Each hit ticks down.
        // The hit cadence is gated by the weapon's fire rate via the
        // _shotCount counter — only count one "block-hit" per shot.
        const dx = player.pos.x - block.position.x;
        const dz = player.pos.z - block.position.z;
        const dist2 = dx * dx + dz * dz;
        if (dist2 > 36 * 36) continue;                // too far
        // Aim direction from player → block:
        const aimX = -dx, aimZ = -dz;
        const aimLen = Math.sqrt(aimX * aimX + aimZ * aimZ);
        if (aimLen < 0.1) continue;
        // Player firing direction: lifted from mouse world coords.
        // We don't have direct access here; cheat via _shotCount
        // delta and proximity. If the player has fired since we last
        // checked AND the block is roughly in front of them, hit it.
        const lastShot = block.userData._lastShotSeen || 0;
        if (_shotCount > lastShot) {
          // Compare player facing — use aimLen normalized vs the
          // mouse position carried on the `mouse` import. We avoid
          // importing mouse directly to keep lesson modules thin;
          // instead we approximate: if the player's nearest enemy
          // (or block) is within 35° of straight ahead, it counts.
          // For simplicity we just count one-block-per-shot if the
          // shot fired and the block is the CLOSEST tutorial ore.
          let closestDist2 = Infinity;
          let closest = null;
          for (const b of this._oreBlocks) {
            if (b.userData.tutorialOreHp <= 0) continue;
            const d2 = (player.pos.x - b.position.x) ** 2 + (player.pos.z - b.position.z) ** 2;
            if (d2 < closestDist2) { closestDist2 = d2; closest = b; }
          }
          if (closest === block) {
            block.userData.tutorialOreHp -= 1;
            block.userData._lastShotSeen = _shotCount;
            // Visual hit reaction.
            hitBurst(new THREE.Vector3(block.position.x, block.position.y, block.position.z), 0xffaa33, 6);
            if (block.userData.tutorialOreHp <= 0) {
              this._broken++;
              hitBurst(new THREE.Vector3(block.position.x, 1, block.position.z), 0xff7733, 18);
              scene.remove(block);
              // Drop a visible ore pickup so the lesson shows the
              // collect step too.
              try {
                makePickup('xp', block.position.x, block.position.z);
              } catch (e) {}
            }
          } else {
            block.userData._lastShotSeen = _shotCount;
          }
        }
      }
    },
    isComplete() { return this._broken >= 3; },
    progress() { return this._broken + ' / 3'; },
  });

  // ----- 10. HAZARDS — cycle through Tetris/Galaga/Minesweeper/Pacman -----
  // We rotate the active hazard style every few seconds and the
  // lesson completes when the player has taken damage from any one
  // of them. The notifyHazardHit hook drives completion.
  list.push({
    id: 'hazards',
    label: 'TAKE A HAZARD HIT',
    hint: 'Hazards rain down in waves. Walk into one to feel the damage. (You will be healed at the next lesson.)',
    _t: 0,
    _styleIdx: 0,
    onActivate() {
      this._t = 0;
      this._styleIdx = 0;
      // Tutorial-mode hazards are driven from main.js by setting the
      // current hazard style and enabling spawning. We expose a hint
      // here that main.js reads to drive the style cycle. We don't
      // import the modules directly — keeps this file decoupled.
      S.tutorialHazardCycle = true;
    },
    onUpdate(dt) {
      this._t += dt;
    },
    isComplete: () => (_hazardHits - _hazardHitsAtActivate) >= 1,
    onComplete() {
      S.tutorialHazardCycle = false;
    },
  });

  // ----- 11. HEAL -----
  list.push({
    id: 'heal',
    label: 'USE A POTION',
    hint: 'Press H to drink a potion and heal your wounds.',
    onActivate() {
      // Make sure the player has at least one potion. main.js exposes
      // S.potions; we just bump it.
      if ((S.potions || 0) < 1) S.potions = 1;
    },
    isComplete: () => (_potionsConsumed - _potionsConsumedAtActivate) >= 1,
  });

  return list;
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
