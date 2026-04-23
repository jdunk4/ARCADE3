// ============================================================================
// src/flingers.js — summonable Flinger allies.
//
// DESIGN
//  - Flingers are the sibling system to Pixl Pals. Same HUD-badge + charge
//    pattern, but they arrive on a FIXED WAVE SCHEDULE (2, 7, 12, 17, 22, 27)
//    so they stagger with Pixl Pals (which grant every 3 waves). This gives
//    the player two distinct help beats through a run.
//
//  - Visually they use the 6 FlingerCOLOR.glb meshes in
//    assets/civilians/flingers/. One picked at random per summon.
//
//  - SIGNATURE MOVE: rather than shooting, flingers FLING enemies.
//    They target a group of nearby enemies and launch them up + away
//    at high speed. On landing, enemies take big impact damage and
//    knock down any other enemies they collide with. Great for clearing
//    bunches quickly.
//
//  - Each summoned flinger sticks around until ~30 enemies have been
//    killed (via the flinger OR otherwise) OR its lifetime expires.
//    This matches the user's "stick around for 30 kills" brief.
//
//  - Bosses are resistant to flinging: they take 1/6 damage and are
//    NOT physically tossed (too heavy). Normal enemies are launched.
//
// INTEGRATION
//  - main.js imports updateFlingers / clearAllFlingers / onWaveStartedForFlingers
//    and wires them the same way pixlPals is wired.
//  - A kill handler is registered so flinger-caused kills flow through
//    the normal score/XP/loot pipeline.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { scene } from './scene.js';
import { ARENA } from './config.js';
import { hitBurst } from './effects.js';
import { enemies } from './enemies.js';
import { Audio } from './audio.js';
import { S, shake } from './state.js';
import { UI } from './ui.js';
import { attachMixer, animationsReady, applyGunHoldPose, GUN_HOLD_EXCLUDE_BONES, IDLE_HIP_EXCLUDE_BONES } from './animation.js';

// -----------------------------------------------------------------------------
// ASSETS / CONSTANTS
// -----------------------------------------------------------------------------

// The 6 Flinger GLB color variants in assets/civilians/flingers/.
const FLINGER_GLB_NAMES = [
  'FlingerBLUE',
  'FlingerGREEN',
  'FlingerORANGE',
  'FlingerPURPLE',
  'FlingerRED',
  'FlingerYELLOW',
];

// Aura tint per variant (matches the name).
const FLINGER_TINTS = {
  FlingerBLUE:   0x4ff7ff,
  FlingerGREEN:  0x00ff66,
  FlingerORANGE: 0xff8800,
  FlingerPURPLE: 0xe63aff,
  FlingerRED:    0xff2e4d,
  FlingerYELLOW: 0xffd93d,
};

// Per-chapter flinger assignment (chapter index → GLB name).
//   Ch.0 INFERNO   → ORANGE
//   Ch.1 CRIMSON   → RED
//   Ch.2 SOLAR     → YELLOW
//   Ch.3 TOXIC     → GREEN
//   Ch.4 ARCTIC    → BLUE
//   Ch.5 PARADISE  → PURPLE
//   Ch.6 PARADISE FALLEN → fallback (no flinger arrives; ch.7 uses infectors)
const FLINGER_BY_CHAPTER = [
  'FlingerORANGE',  // 0 INFERNO
  'FlingerRED',     // 1 CRIMSON
  'FlingerYELLOW',  // 2 SOLAR
  'FlingerGREEN',   // 3 TOXIC
  'FlingerBLUE',    // 4 ARCTIC
  'FlingerPURPLE',  // 5 PARADISE
];

// WAVE SCHEDULE — flingers arrive on these waves. Stays staggered with
// the pixl pal cadence. These are each chapter's wave 2 (POWERUP wave).
// They don't deploy the moment the wave starts — they wait until the
// POWER zone is cleared (S.powerplantLit = true), see the pending-grant
// path in onWaveStartedForFlingers + updateFlingers.
const FLINGER_WAVE_SCHEDULE = new Set([2, 7, 12, 17, 22, 27]);

// Maximum flingers active on the field at once.
const MAX_CONCURRENT = 3;

// Maximum stockpile of unused charges (player might skip their arrival
// waves without summoning, we cap so it doesn't snowball).
const MAX_CHARGES = 3;

// Boss damage scale — flinger hits on bosses deal only this fraction.
const BOSS_DAMAGE_SCALE = 1 / 6;

// How long a flinger may remain before it auto-despawns (hard cap).
const FLINGER_MAX_LIFETIME_SEC = 40;

// Despawn when the flinger has witnessed this many enemy deaths
// since it was summoned. Matches the user brief ("stick around for
// like 30 enemy kills"). The counter ticks on ANY kill, not just the
// flinger's own — this is about arena presence, not K/D.
const KILLS_TO_DESPAWN = 30;

// Tuning — flinging.
const FLING_RANGE = 20;              // max grab distance
const FLING_COOLDOWN_SEC = 1.1;      // between grab attempts
const FLING_GROUP_RADIUS = 4.5;      // radius around primary target also tossed
const FLING_INITIAL_SPEED = 22;      // horizontal speed at launch
const FLING_UP_SPEED = 16;           // vertical speed at launch
const FLING_GRAVITY = 42;            // downward accel
const FLING_IMPACT_DAMAGE = 120;     // damage on landing hit
const FLING_AOE_DAMAGE = 55;         // damage to enemies the flung one smashes into
const FLING_AOE_RADIUS = 2.6;

const FLINGER_MOVE_SPEED = 7.8;      // chasing between tosses
const FLINGER_STANDOFF = 6.5;        // distance to hold from target
const FLINGER_KEEP_NEAR_PLAYER = 16;

const FLINGER_SPAWN_OFFSET = 5.0;    // drop-in offset from player

// Animation-phase cues.
const WINDUP_SEC = 0.35;             // visual wind-up before release
const RECOVERY_SEC = 0.45;           // post-release idle

// -----------------------------------------------------------------------------
// MODULE STATE
// -----------------------------------------------------------------------------

const flingers = [];             // currently active flingers
const flungEnemies = [];         // enemies mid-flight (airborne)

let lastWaveAwarded = 0;         // last wave for which we granted a charge
let _killHandler = null;         // main.js registers a hook that routes kills
let _lastKnownKillCount = 0;     // tracks S.kills deltas to advance KILLS_TO_DESPAWN

// Pending flinger — on the scheduled wave we queue one here and only
// actually deploy it after S.powerplantLit flips true. This means the
// flinger "arrives" in wave 2 but visibly waits for the POWER zone to
// be cleared — matches the brief: "delay the flingers appearance
// until the power plant is powered up in wave 2."
let _pendingDeploy = false;
let _pendingDeployWave = 0;      // which wave the pending deploy was issued for

const gltfLoader = new GLTFLoader();
const glbCache = new Map();      // name -> Promise<gltf>

// Reusable scratch
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export function registerFlingerKillHandler(fn) {
  _killHandler = fn;
}

/**
 * Called by main.js when a new wave starts. Grants a charge whenever the
 * wave number is in the FLINGER_WAVE_SCHEDULE. Instead of auto-deploying
 * immediately, we stash the intent as a "pending" flag — actual deploy
 * waits until S.powerplantLit is true (set by waves.js when the POWER
 * zone is cleared in the wave-2 powerup sequence).
 *
 * Safe to call multiple times for the same wave.
 */
export function onWaveStartedForFlingers(waveNum) {
  if (waveNum <= lastWaveAwarded) return;
  if (FLINGER_WAVE_SCHEDULE.has(waveNum)) {
    S.flingerCharges = Math.min(MAX_CHARGES, (S.flingerCharges || 0) + 1);
    _pendingDeploy = true;
    _pendingDeployWave = waveNum;
    UI.toast && UI.toast('FLINGER STANDING BY · POWER THE PLANT', '#ff8800', 2600);
    _syncHUD();
  }
  lastWaveAwarded = waveNum;
}

/**
 * Manually add a charge — exposed for future pickups/debug parity with
 * the pixl pal module.
 */
export function addFlingerCharge(n = 1) {
  S.flingerCharges = Math.min(MAX_CHARGES, (S.flingerCharges || 0) + n);
  _syncHUD();
  _tryConsumePendingDeploy();
}

/**
 * Clear all flingers + in-flight enemies + reset state.
 * Call from the game-reset path.
 */
export function clearAllFlingers() {
  for (const f of flingers) {
    if (f.mixer) { try { f.mixer.stop && f.mixer.stop(); } catch (e) {} f.mixer = null; }
    if (f.obj && f.obj.parent) scene.remove(f.obj);
  }
  flingers.length = 0;

  // In-flight enemies drop back to normal state (don't delete them —
  // they're real enemies in the main enemies[] array; we just release
  // our hold).
  for (const fe of flungEnemies) {
    if (fe.enemy) {
      fe.enemy.flingLock = false;
      fe.enemy.pos.y = 0;
    }
  }
  flungEnemies.length = 0;

  lastWaveAwarded = 0;
  S.flingerCharges = 0;
  _lastKnownKillCount = 0;
  _pendingDeploy = false;
  _pendingDeployWave = 0;
  _syncHUD();
}

/**
 * Main per-frame update — called from main.js animate() alongside
 * updatePixlPals.
 */
export function updateFlingers(dt, playerPos) {
  // Pending deploy — fired on the scheduled wave, but held until the POWER
  // zone is cleared in the wave-2 powerup sequence. waves.js sets
  // S.powerplantLit = true at that moment.
  _tryConsumePendingDeploy();

  // Track kill deltas so each flinger's "30 kills → leave" counter
  // advances globally (not just for kills it personally caused).
  if (typeof S.kills === 'number') {
    if (_lastKnownKillCount === 0) _lastKnownKillCount = S.kills;
    const delta = S.kills - _lastKnownKillCount;
    if (delta > 0) {
      for (const f of flingers) f.killsSinceSummon += delta;
    }
    _lastKnownKillCount = S.kills;
  }

  // --- Flingers ---
  for (let i = flingers.length - 1; i >= 0; i--) {
    const f = flingers[i];
    if (!f.ready) continue;

    f.life += dt;

    // Despawn conditions.
    if (!f.despawning && (
        f.life >= f.maxLife ||
        f.killsSinceSummon >= KILLS_TO_DESPAWN
    )) {
      f.despawning = true;
      f.despawnTimer = 0.45;
      UI.toast && UI.toast('FLINGER EXTRACT', '#ff8800', 1000);
    }

    if (f.despawning) {
      f.despawnTimer -= dt;
      if (f.obj && f.obj.scale) {
        const s = Math.max(0.01, f.despawnTimer / 0.45);
        f.obj.scale.setScalar(s);
      }
      if (f.despawnTimer <= 0) {
        _flingerSpawnFx(f.pos, f.tint);
        if (f.mixer) { try { f.mixer.stop && f.mixer.stop(); } catch (e) {} f.mixer = null; }
        scene.remove(f.obj);
        flingers.splice(i, 1);
        continue;
      }
    }

    // --- Phase state machine: IDLE → WINDUP → RELEASE → RECOVERY → IDLE ---
    if (f.phase === 'idle') {
      f.cooldown -= dt;
      // Retarget periodically
      f.rescanCd -= dt;
      if (f.rescanCd <= 0 || !_enemyAlive(f.targetEnemy) || f.targetEnemy.flingLock) {
        f.rescanCd = 0.2;
        f.targetEnemy = _findFlingTarget(f.pos);
      }

      // Move toward target to get in range, or drift near player when idle.
      let moveTo = null;
      if (f.targetEnemy) {
        moveTo = f.targetEnemy.pos;
      } else if (playerPos) {
        _v.copy(playerPos).sub(f.pos);
        if (_v.lengthSq() > FLINGER_KEEP_NEAR_PLAYER * FLINGER_KEEP_NEAR_PLAYER) {
          moveTo = playerPos;
        }
      }

      if (moveTo) {
        _v.copy(moveTo).sub(f.pos);
        _v.y = 0;
        const dist = _v.length();
        if (dist > 0.001) {
          _v.multiplyScalar(1 / dist);
          const desired = f.targetEnemy ? FLINGER_STANDOFF : 0;
          if (dist > desired) {
            f.pos.x += _v.x * FLINGER_MOVE_SPEED * dt;
            f.pos.z += _v.z * FLINGER_MOVE_SPEED * dt;
            f._movedThisFrame = true;
          } else {
            f._movedThisFrame = false;
          }
          if (f.obj) f.obj.rotation.y = Math.atan2(_v.x, _v.z);
        }
        const lim = ARENA * 0.95;
        if (f.pos.x >  lim) f.pos.x =  lim;
        if (f.pos.x < -lim) f.pos.x = -lim;
        if (f.pos.z >  lim) f.pos.z =  lim;
        if (f.pos.z < -lim) f.pos.z = -lim;
      } else {
        f._movedThisFrame = false;
      }

      // If we have a target within grab range AND cooldown is done, wind up.
      if (!f.despawning && f.cooldown <= 0 && f.targetEnemy && _enemyAlive(f.targetEnemy)) {
        const dx = f.targetEnemy.pos.x - f.pos.x;
        const dz = f.targetEnemy.pos.z - f.pos.z;
        if (dx * dx + dz * dz < FLING_RANGE * FLING_RANGE) {
          f.phase = 'windup';
          f.phaseTime = WINDUP_SEC;
          f._movedThisFrame = false;
          Audio.shot && Audio.shot('pickaxe');
        }
      }
    } else if (f.phase === 'windup') {
      f.phaseTime -= dt;
      // Small shake + glow lift for telegraph
      if (f.obj) {
        f.obj.position.y = Math.abs(Math.sin(f.life * 30)) * 0.12;
      }
      if (f.phaseTime <= 0) {
        _doFling(f);
        f.phase = 'recovery';
        f.phaseTime = RECOVERY_SEC;
      }
    } else if (f.phase === 'recovery') {
      f.phaseTime -= dt;
      if (f.phaseTime <= 0) {
        f.phase = 'idle';
        f.cooldown = FLING_COOLDOWN_SEC;
      }
    }

    // Animation drive (mixer, walk-bob fallback — same as pixlPals)
    if (f.mixer) {
      if (f._movedThisFrame) {
        f.mixer.playWalk();
        f.mixer.setSpeed(1.2);
      } else {
        f.mixer.playIdle(2);
        f.mixer.setSpeed(1.0);
      }
      f.mixer.update(dt);
      applyGunHoldPose(f.obj);
    }

    f.walkPhase += dt * 10;
    if (f.obj && !f.despawning && f.phase !== 'windup') {
      f.obj.position.y = Math.abs(Math.sin(f.walkPhase)) * 0.06;
    }
  }

  // --- In-flight flung enemies — ballistic arc + landing AoE ---
  for (let i = flungEnemies.length - 1; i >= 0; i--) {
    const fe = flungEnemies[i];
    const e = fe.enemy;
    if (!e || e.hp <= 0 || enemies.indexOf(e) < 0) {
      // Enemy died mid-air (or got cleared); drop it from the list
      flungEnemies.splice(i, 1);
      continue;
    }
    // Ballistic motion
    fe.vel.y -= FLING_GRAVITY * dt;
    e.pos.x += fe.vel.x * dt;
    e.pos.z += fe.vel.z * dt;
    e.pos.y += fe.vel.y * dt;
    if (e.obj) e.obj.position.copy(e.pos);

    // Landing — when we cross back below ground
    if (e.pos.y <= 0) {
      e.pos.y = 0;
      if (e.obj) e.obj.position.y = 0;
      e.flingLock = false;

      // Impact: direct damage to this enemy
      e.hp -= FLING_IMPACT_DAMAGE;
      e.hitFlash = 0.25;
      hitBurst(new THREE.Vector3(e.pos.x, 0.5, e.pos.z), fe.tint, 18);
      hitBurst(new THREE.Vector3(e.pos.x, 1.2, e.pos.z), 0xffffff, 8);
      shake(0.15, 0.12);

      // AoE — smash nearby enemies with the landing body
      for (let j = enemies.length - 1; j >= 0; j--) {
        const o = enemies[j];
        if (o === e) continue;
        const dx = o.pos.x - e.pos.x;
        const dz = o.pos.z - e.pos.z;
        if (dx * dx + dz * dz < FLING_AOE_RADIUS * FLING_AOE_RADIUS) {
          const dmg = o.isBoss ? FLING_AOE_DAMAGE * BOSS_DAMAGE_SCALE : FLING_AOE_DAMAGE;
          o.hp -= dmg;
          o.hitFlash = 0.2;
          if (o.hp <= 0) _onFlingKill(o);
        }
      }
      // And handle this enemy's own death
      if (e.hp <= 0) _onFlingKill(e);

      flungEnemies.splice(i, 1);
    }
  }
}

// -----------------------------------------------------------------------------
// INTERNAL: SUMMON / FLING
// -----------------------------------------------------------------------------

/**
 * Consume a pending deploy once the powerplant lights. No-op if nothing
 * is pending or the plant isn't lit yet. Called from updateFlingers each
 * frame so the moment S.powerplantLit flips, the flinger drops in.
 */
function _tryConsumePendingDeploy() {
  if (!_pendingDeploy) return;
  if (!S.running || S.paused) return;
  if (!S.powerplantLit) return;
  // Guard — don't re-deploy if charges have already been spent somehow.
  if ((S.flingerCharges || 0) <= 0) {
    _pendingDeploy = false;
    _pendingDeployWave = 0;
    return;
  }
  _pendingDeploy = false;
  _pendingDeployWave = 0;
  UI.toast && UI.toast('FLINGER INCOMING!', '#ff8800', 2200);
  _tryAutoSummon();
}

function _tryAutoSummon() {
  if (!S.running || S.paused) return;
  if ((S.flingerCharges || 0) <= 0) return;
  if (flingers.length >= MAX_CONCURRENT) return;

  S.flingerCharges -= 1;
  _syncHUD();

  // Chapter-specific color. Chapter index 0-5 → ORANGE/RED/YELLOW/GREEN/BLUE/PURPLE.
  // Chapter 6 (PARADISE FALLEN) doesn't have a flinger in the schedule
  // anyway (infector finale), but guard with a fallback random pick just
  // in case charges leak through.
  const ch = Math.max(0, Math.min(FLINGER_BY_CHAPTER.length - 1, S.chapter | 0));
  const glbName = FLINGER_BY_CHAPTER[ch] ||
    FLINGER_GLB_NAMES[Math.floor(Math.random() * FLINGER_GLB_NAMES.length)];
  const tint = FLINGER_TINTS[glbName] || 0xff8800;

  // Spawn offset just beside the player, within arena bounds.
  const ang = Math.random() * Math.PI * 2;
  const px = (S.playerPos && S.playerPos.x) || 0;
  const pz = (S.playerPos && S.playerPos.z) || 0;
  const spawnX = px + Math.cos(ang) * FLINGER_SPAWN_OFFSET;
  const spawnZ = pz + Math.sin(ang) * FLINGER_SPAWN_OFFSET;

  const placeholder = new THREE.Group();
  placeholder.position.set(spawnX, 0, spawnZ);
  scene.add(placeholder);

  _flingerSpawnFx(placeholder.position, tint);
  Audio.levelup && Audio.levelup();
  shake(0.2, 0.15);

  const f = {
    obj: placeholder,
    pos: placeholder.position,
    ready: false,
    glbName,
    tint,
    phase: 'idle',
    phaseTime: 0,
    cooldown: 0.6,
    rescanCd: 0,
    targetEnemy: null,
    life: 0,
    maxLife: FLINGER_MAX_LIFETIME_SEC,
    killsSinceSummon: 0,
    despawning: false,
    walkPhase: Math.random() * Math.PI * 2,
  };
  flingers.push(f);

  UI.toast && UI.toast('FLINGER · ' + glbName.replace('Flinger', ''),
                       '#' + tint.toString(16).padStart(6, '0'), 1600);

  _loadFlingerMesh(glbName).then(mesh => {
    if (!flingers.includes(f)) return;
    scene.remove(f.obj);
    mesh.position.copy(f.pos);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    _applyFlingerHighlight(mesh, tint);
    scene.add(mesh);
    f.obj = mesh;
    f.pos = mesh.position;
    f.ready = true;

    if (animationsReady()) {
      try {
        f.mixer = attachMixer(mesh, {
          excludeBones: {
            default: GUN_HOLD_EXCLUDE_BONES,
            idle2:   IDLE_HIP_EXCLUDE_BONES,
            idle3:   IDLE_HIP_EXCLUDE_BONES,
            idle4:   IDLE_HIP_EXCLUDE_BONES,
          },
        });
        f.mixer.playIdle(2);
      } catch (e) {
        console.warn('[Flinger] attachMixer failed', e);
      }
    }
  }).catch(err => {
    console.warn('[Flinger] GLB load failed for', glbName, err);
    _buildFallbackVoxel(f.obj, tint);
    f.ready = true;
  });
}

function _doFling(flinger) {
  const target = flinger.targetEnemy;
  if (!_enemyAlive(target)) return;

  // Bosses can't be launched — just hit them.
  if (target.isBoss) {
    target.hp -= FLING_IMPACT_DAMAGE * BOSS_DAMAGE_SCALE;
    target.hitFlash = 0.2;
    hitBurst(new THREE.Vector3(target.pos.x, 1.2, target.pos.z), flinger.tint, 14);
    if (target.hp <= 0) _onFlingKill(target);
    return;
  }

  // Collect the target + any enemies within FLING_GROUP_RADIUS.
  const victims = [target];
  for (const e of enemies) {
    if (e === target) continue;
    if (e.isBoss) continue;
    if (e.flingLock) continue;
    const dx = e.pos.x - target.pos.x;
    const dz = e.pos.z - target.pos.z;
    if (dx * dx + dz * dz < FLING_GROUP_RADIUS * FLING_GROUP_RADIUS) {
      victims.push(e);
      if (victims.length >= 5) break; // cap
    }
  }

  // Direction to fling: away from the flinger (roughly).
  const dirX = target.pos.x - flinger.pos.x;
  const dirZ = target.pos.z - flinger.pos.z;
  const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
  const baseX = dirX / dirLen;
  const baseZ = dirZ / dirLen;

  for (const v of victims) {
    if (v.flingLock) continue;
    v.flingLock = true;
    // Slight per-victim jitter so they fan out in the air
    const jitter = (Math.random() - 0.5) * 0.4;
    const jx = baseX * Math.cos(jitter) - baseZ * Math.sin(jitter);
    const jz = baseX * Math.sin(jitter) + baseZ * Math.cos(jitter);
    flungEnemies.push({
      enemy: v,
      vel: new THREE.Vector3(
        jx * FLING_INITIAL_SPEED,
        FLING_UP_SPEED + Math.random() * 2,
        jz * FLING_INITIAL_SPEED,
      ),
      tint: flinger.tint,
    });
  }

  // Muzzle / release FX at the flinger
  hitBurst(new THREE.Vector3(flinger.pos.x, 1.5, flinger.pos.z), flinger.tint, 16);
  hitBurst(new THREE.Vector3(flinger.pos.x, 1.5, flinger.pos.z), 0xffffff, 8);
  shake(0.18, 0.14);
  Audio.bigBoom && Audio.bigBoom();
}

// -----------------------------------------------------------------------------
// INTERNAL: KILL ATTRIBUTION
// -----------------------------------------------------------------------------

function _onFlingKill(enemy) {
  const idx = enemies.indexOf(enemy);
  if (idx < 0) return;
  if (_killHandler) _killHandler(idx);
}

function _enemyAlive(e) {
  return !!e && e.hp > 0 && enemies.indexOf(e) >= 0;
}

function _findFlingTarget(fromPos) {
  // Prefer the enemy with the most neighbors nearby — flings work best
  // when they launch a group. Falls back to nearest.
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.isBoss) continue;
    if (e.flingLock) continue;
    const dx = e.pos.x - fromPos.x;
    const dz = e.pos.z - fromPos.z;
    const dsq = dx * dx + dz * dz;
    if (dsq > FLING_RANGE * FLING_RANGE) continue;
    // Score = neighbor count within group radius + (closer is better, small weight)
    let neighbors = 0;
    for (let j = 0; j < enemies.length; j++) {
      if (j === i) continue;
      const o = enemies[j];
      if (o.isBoss) continue;
      const ox = o.pos.x - e.pos.x;
      const oz = o.pos.z - e.pos.z;
      if (ox * ox + oz * oz < FLING_GROUP_RADIUS * FLING_GROUP_RADIUS) neighbors++;
    }
    const score = neighbors * 10 - dsq * 0.01;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  if (best) return best;
  // No non-boss in range — fall through.
  return null;
}

// -----------------------------------------------------------------------------
// INTERNAL: GLB LOAD / CACHE
// -----------------------------------------------------------------------------

function _loadFlingerMesh(glbName) {
  if (!glbCache.has(glbName)) {
    const url = `assets/civilians/flingers/${glbName}.glb`;
    glbCache.set(glbName, new Promise((resolve, reject) => {
      gltfLoader.load(url, resolve, undefined, reject);
    }));
  }
  return glbCache.get(glbName).then(gltf => {
    const clone = skeletonClone(gltf.scene);
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.y > 0.01 && isFinite(size.y)) {
      const s = 2.2 / size.y;
      clone.scale.setScalar(s);
      clone.updateMatrixWorld(true);
    }
    const box2 = new THREE.Box3().setFromObject(clone);
    if (isFinite(box2.min.y)) {
      clone.position.y -= box2.min.y;
    }
    clone.traverse(obj => {
      if (obj.isMesh || obj.isSkinnedMesh) {
        obj.frustumCulled = false;
        obj.castShadow = true;
      }
    });
    return clone;
  });
}

function _applyFlingerHighlight(mesh, tint) {
  const tintColor = new THREE.Color(tint);
  mesh.traverse(obj => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.emissive) {
          m.emissive = m.emissive.clone().add(tintColor.clone().multiplyScalar(0.25));
          m.emissiveIntensity = Math.max(0.3, m.emissiveIntensity || 0.3);
          m.needsUpdate = true;
        }
      }
    }
  });
  // Aura ring at the feet — flingers get a wider, more intense ring
  // than pixl pals because they're a more "intense" ally.
  const auraGeo = new THREE.RingGeometry(1.1, 1.7, 28);
  const auraMat = new THREE.MeshBasicMaterial({
    color: tint,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.6,
  });
  const aura = new THREE.Mesh(auraGeo, auraMat);
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.05;
  mesh.add(aura);

  // Secondary inner ring for extra glow
  const innerGeo = new THREE.RingGeometry(0.7, 0.95, 20);
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.35,
  });
  const inner = new THREE.Mesh(innerGeo, innerMat);
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.06;
  mesh.add(inner);
}

function _buildFallbackVoxel(placeholder, tint) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: tint,
    emissiveIntensity: 0.9,
    roughness: 0.4,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.6, 0.6), mat);
  body.position.y = 1.0;
  placeholder.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), mat);
  head.position.y = 2.2;
  placeholder.add(head);
}

function _flingerSpawnFx(pos, tint) {
  hitBurst(pos, tint, 30);
  hitBurst(pos, 0xffffff, 14);
}

// -----------------------------------------------------------------------------
// HUD INDICATOR
// -----------------------------------------------------------------------------

function _syncHUD() {
  let el = document.getElementById('flinger-indicator');
  const charges = S.flingerCharges || 0;
  if (!el) {
    el = document.createElement('div');
    el.id = 'flinger-indicator';
    el.style.cssText = [
      'position:fixed',
      'top:120px',                   // below the pixl pal badge
      'right:16px',
      'z-index:15',
      'padding:8px 12px',
      'border:2px solid #ff8800',
      'border-radius:6px',
      'background:rgba(24,12,2,0.7)',
      'color:#ff8800',
      "font-family:'Impact',monospace",
      'font-size:14px',
      'letter-spacing:2px',
      'box-shadow:0 0 14px rgba(255,136,0,0.4)',
      'pointer-events:none',
      'user-select:none',
      'transition:opacity 0.2s',
    ].join(';');
    document.body.appendChild(el);
  }
  if (charges <= 0 && flingers.length === 0) {
    el.style.opacity = '0.35';
    el.innerHTML = 'FLINGER · <b>0</b>';
  } else if (flingers.length > 0 && charges <= 0) {
    el.style.opacity = '1';
    el.innerHTML = 'FLINGER · <b style="color:#fff">LIVE</b>';
  } else {
    el.style.opacity = '1';
    el.innerHTML = 'FLINGER · <b style="color:#fff">' + charges + '</b>';
  }
}

/** Create the HUD badge. Idempotent. */
export function initFlingerHUD() {
  _syncHUD();
}
