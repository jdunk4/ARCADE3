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
import { ARENA, CHAPTERS, PARADISE_FALLEN_CHAPTER_IDX } from './config.js';
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
//   Ch.0 INFERNO         → ORANGE
//   Ch.1 CRIMSON         → RED
//   Ch.2 SOLAR           → YELLOW
//   Ch.3 TOXIC           → GREEN
//   Ch.4 ARCTIC          → BLUE
//   Ch.5 PARADISE        → PURPLE
//   Ch.6 PARADISE FALLEN → PURPLE (final chapter — re-uses PURPLE; pals
//                                 and flingers spawn together here)
const FLINGER_BY_CHAPTER = [
  'FlingerORANGE',  // 0 INFERNO
  'FlingerRED',     // 1 CRIMSON
  'FlingerYELLOW',  // 2 SOLAR
  'FlingerGREEN',   // 3 TOXIC
  'FlingerBLUE',    // 4 ARCTIC
  'FlingerPURPLE',  // 5 PARADISE
  'FlingerPURPLE',  // 6 PARADISE FALLEN — monochrome ally
];

// WAVE SCHEDULE — flingers arrive on these waves. Stays staggered with
// the pixl pal cadence. These are each chapter's wave 2 (POWERUP wave).
// They don't deploy the moment the wave starts — they wait until the
// POWER zone is cleared (S.powerplantLit = true), see the pending-grant
// path in onWaveStartedForFlingers + updateFlingers.
//
// Chapter 7 (PARADISE FALLEN) has no powerup zone since ch7 only has
// 3 waves (mining / hive / finale). Wave 31 is the ch7 opener; a flinger
// deploys at the start of it alongside a co-deployed pixl pal. See
// onWaveStartedForFlingers for the ch7 special-case.
const FLINGER_WAVE_SCHEDULE = new Set([2, 7, 12, 17, 22, 27, 31]);

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

// Hidden mesh pool — prebuilt during matrix dive by preloadFlingerGLBs().
// Mirrors the pixl-pal pool pattern. Zero-jank first arrival.
const flingerPoolEntries = [];

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
 * Preload all flinger GLBs into the internal Promise cache during the
 * matrix dive. Same pattern as preloadPixlPalGLBs — populates glbCache
 * so the first flinger arrival in a run is zero-jank.
 *
 * Discovery order:
 *   1. `assets/civilians/flingers/manifest.json` (array of "FlingerX.glb" strings)
 *   2. Fallback to hardcoded FLINGER_GLB_NAMES above.
 *
 * Flingers are chunky (~7 MB each), so prefetching these during the dive
 * is where this helper saves the most visible jank in gameplay.
 */
const FLINGER_POOL_STASH_Y = -1000;
const FLINGER_POOL_BATCH_PER_FRAME = 2;

export async function preloadFlingerGLBs(onProgress, renderer, camera) {
  let names = FLINGER_GLB_NAMES.slice();

  // --- Discover names from manifest ---
  try {
    const res = await fetch('assets/civilians/flingers/manifest.json', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        const parsed = [];
        for (const entry of data) {
          if (typeof entry !== 'string') continue;
          const clean = entry.replace(/\.glb$/i, '').trim();
          if (/^Flinger[A-Z]+$/i.test(clean)) parsed.push(clean);
        }
        if (parsed.length > 0) {
          names = parsed;
          console.log(`[flinger] manifest found (${names.length} files)`);
        }
      }
    } else {
      console.log('[flinger] no manifest, using hardcoded list (' + names.length + ' files)');
    }
  } catch (e) {
    console.log('[flinger] manifest fetch failed, using hardcoded list');
  }

  const total = names.length;
  let loaded = 0;

  // --- Phase A: fetch all GLBs ---
  // Throttled to 2 workers — flinger GLBs are 4-7 MB each, chunkier than
  // the pixl pal GLBs, so we stay conservative to avoid 503 rate limits
  // from static hosts (GitHub Pages etc). Each fetch auto-retries on 5xx
  // with exponential backoff.
  await _runWithConcurrency(names, 2, async (glbName) => {
    if (!glbCache.has(glbName)) {
      const url = `assets/civilians/flingers/${glbName}.glb`;
      glbCache.set(glbName, _loadGLBWithRetry(url));
    }
    try { await glbCache.get(glbName); } catch (e) { /* non-fatal */ }
  });
  // [flinger] fetched log suppressed — the manifest-found line above
  // already confirms the file count; the fetch completion is implied.

  // --- Phase B: build mesh pool (clones parked at y=-1000, ALWAYS VISIBLE) ---
  // CRITICAL: meshes stay visible=true at all times, matching the herd
  // VRM pattern. The renderer only compiles shaders for meshes it
  // actually DRAWS. Setting visible=false skips the mesh entirely —
  // no draw call, no shader compile, no GPU cache entry. When the
  // mesh later becomes visible, the GPU has to compile from scratch
  // (the 1-3 second freeze). Herd VRMs avoid this by never hiding —
  // they're parked at y=-1000 (below camera) but visible=true, so
  // the renderer draws them every frame and their shaders stay warm.
  // We do the same here.
  for (let i = 0; i < names.length; i++) {
    const glbName = names[i];
    try {
      const mesh = await _loadFlingerMesh(glbName);
      mesh.position.set(0, FLINGER_POOL_STASH_Y, 0);
      // STAY VISIBLE — renderer draws them every frame at stash Y.
      // frustumCulled=false ensures they're drawn even below camera.
      mesh.visible = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.traverse(o => { o.frustumCulled = false; });
      scene.add(mesh);
      flingerPoolEntries.push({ name: glbName, obj: mesh, inUse: false });
    } catch (err) {
      console.warn('[flinger] pool build failed for', glbName, err);
    }
    loaded++;
    if (onProgress) onProgress({ loaded, total, name: glbName });
    if ((i + 1) % FLINGER_POOL_BATCH_PER_FRAME === 0) {
      await new Promise(r => requestAnimationFrame(r));
    }
  }

  console.log(`[flinger] ✓ pool ready — ${loaded}/${total} prewarmed`);
  return { loaded, total };
}

/**
 * Acquire a flinger pool mesh by NAME (so we always get the chapter's
 * color). Returns null if no matching entry is free or the pool is empty.
 */
function _acquireFlingerPoolMesh(glbName) {
  for (let i = 0; i < flingerPoolEntries.length; i++) {
    const e = flingerPoolEntries[i];
    if (!e.inUse && e.name === glbName) {
      e.inUse = true;
      return e.obj;
    }
  }
  return null;
}

function _releaseFlingerPoolMesh(mesh, mixer) {
  if (!mesh) return;
  if (mixer) { try { mixer.stop && mixer.stop(); } catch (e) {} }
  for (let i = 0; i < flingerPoolEntries.length; i++) {
    const e = flingerPoolEntries[i];
    if (e.obj === mesh) {
      e.inUse = false;
      _resetFlingerHighlight(mesh);
      // DON'T set visible=false — keep it visible at stash Y so the
      // renderer keeps drawing it and the shader cache stays warm.
      mesh.matrixAutoUpdate = false;
      mesh.position.set(0, FLINGER_POOL_STASH_Y, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.setScalar(1);
      mesh.updateMatrix();
      return;
    }
  }
  if (mesh.parent) scene.remove(mesh);
}

/**
 * Called by main.js when a new wave starts. Grants a charge whenever the
 * wave number is in the FLINGER_WAVE_SCHEDULE.
 *
 *   - Normal chapters (waves 2/7/12/17/22/27): charge is queued as
 *     _pendingDeploy and deployed only after S.powerplantLit flips true
 *     (power-zone cleared in the wave-2 powerup sequence).
 *   - Chapter 7 (wave 31): there's no powerup wave, so the flinger
 *     deploys IMMEDIATELY. Pairs with a pixl pal that's also force-
 *     deployed at ch7 start — both allies escort the player through the
 *     finale.
 *
 * Safe to call multiple times for the same wave.
 */
export function onWaveStartedForFlingers(waveNum) {
  if (waveNum <= lastWaveAwarded) return;
  if (FLINGER_WAVE_SCHEDULE.has(waveNum)) {
    S.flingerCharges = Math.min(MAX_CHARGES, (S.flingerCharges || 0) + 1);
    const ch7Wave = (S.chapter === PARADISE_FALLEN_CHAPTER_IDX);
    if (ch7Wave) {
      // Ch 7 — skip the power-plant gate; deploy right away.
      UI.toast && UI.toast('FLINGER DEPLOYED', '#ff8800', 2200);
      _tryAutoSummon();
    } else {
      _pendingDeploy = true;
      _pendingDeployWave = waveNum;
      UI.toast && UI.toast('FLINGER STANDING BY · POWER THE PLANT', '#ff8800', 2600);
    }
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
    _releaseFlingerPoolMesh(f.obj, f.mixer);
    f.mixer = null;
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

    // Despawn conditions — skipped in chapter 7 (PARADISE FALLEN) where
    // flingers + pals are summoned together and stay to the end of the run.
    const isCh7 = S.chapter === PARADISE_FALLEN_CHAPTER_IDX;
    if (!f.despawning && !isCh7 && (
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
        _releaseFlingerPoolMesh(f.obj, f.mixer);
        f.mixer = null;
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

    // Animation drive — always play walk, never idle. Rationale:
    // Flingers use an Unreal skeleton whose bone names don't match our
    // VRM-style GUN_HOLD_POSE, so the Mixamo "rifle aim" idle-style poses
    // were sneaking in and producing a sideways lean. Plain walk has clean
    // pelvis/leg data and reads as "active combatant" even when the
    // flinger is standing still for a beat between throws.
    if (f.mixer) {
      f.mixer.playWalk();
      f.mixer.setSpeed(f._movedThisFrame ? 1.2 : 1.0);
      f.mixer.update(dt);
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

  // Smart spawn position: try 8 angles, prefer positions away from
  // arena center (where cannons/silos sit) and away from other flingers.
  const px = (S.playerPos && S.playerPos.x) || 0;
  const pz = (S.playerPos && S.playerPos.z) || 0;
  let spawnX = 0, spawnZ = 0;
  {
    const halfArena = (typeof ARENA !== 'undefined' ? ARENA / 2 : 50) - 2;
    let bestScore = -Infinity;
    let bestX = px + FLINGER_SPAWN_OFFSET, bestZ = pz;
    for (let i = 0; i < 8; i++) {
      const ang = (Math.PI * 2 * i) / 8 + Math.random() * 0.3;
      const cx = px + Math.cos(ang) * FLINGER_SPAWN_OFFSET;
      const cz = pz + Math.sin(ang) * FLINGER_SPAWN_OFFSET;
      if (Math.abs(cx) > halfArena || Math.abs(cz) > halfArena) continue;
      let score = Math.sqrt(cx * cx + cz * cz);
      for (const other of flingers) {
        if (!other.pos) continue;
        const dx = cx - other.pos.x, dz = cz - other.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 3) score -= (3 - d) * 4;
      }
      if (score > bestScore) { bestScore = score; bestX = cx; bestZ = cz; }
    }
    spawnX = bestX; spawnZ = bestZ;
  }

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

  // --- POOL PATH — find the prebuilt flinger for this chapter's color ---
  // Pool was built during the matrix dive by preloadFlingerGLBs(). All
  // six color variants are pre-cloned + PSO-warmed, so first-arrival is
  // zero-jank.
  const pooledMesh = _acquireFlingerPoolMesh(glbName);
  if (pooledMesh) {
    scene.remove(f.obj);
    // Mesh is already visible (never hidden — herd pattern). Just
    // teleport from stash Y to spawn position.
    pooledMesh.matrixAutoUpdate = true;
    pooledMesh.position.copy(f.pos);
    pooledMesh.rotation.y = Math.random() * Math.PI * 2;
    _resetFlingerHighlight(pooledMesh);
    _applyFlingerHighlight(pooledMesh, tint);
    f.obj = pooledMesh;
    f.pos = pooledMesh.position;
    f.ready = true;

    if (animationsReady()) {
      try {
        // No excludeBones — flingers are on an Unreal rig, so the VRM-named
        // gun-hold pose never took effect anyway. Let the walk clip drive
        // every bone (pelvis, legs, arms, head) for a clean natural cycle.
        f.mixer = attachMixer(pooledMesh, {});
        f.mixer.playWalk();
      } catch (e) {
        console.warn('[Flinger] attachMixer failed', e);
      }
    }
    return;
  }

  // --- FALLBACK PATH — pool missing / exhausted. Slow path (will jank). ---
  console.warn('[Flinger] pool miss — falling back to on-demand load');
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
        f.mixer = attachMixer(mesh, {});
        f.mixer.playWalk();
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
    glbCache.set(glbName, _loadGLBWithRetry(url));
  }
  return glbCache.get(glbName).then(gltf => {
    const clone = skeletonClone(gltf.scene);
    // Rebind clone materials to the original's — same pattern as the
    // herd VRM loader. SkeletonUtils.clone deep-copies materials,
    // giving each clone unique instances. Rebinding means all pool
    // entries share the original's materials, so shader compilation
    // for ONE entry covers them ALL.
    const origMeshes = [];
    gltf.scene.traverse(obj => {
      if (obj.isMesh || obj.isSkinnedMesh) origMeshes.push(obj);
    });
    let meshIdx = 0;
    clone.traverse(obj => {
      if (obj.isMesh || obj.isSkinnedMesh) {
        const origObj = origMeshes[meshIdx++];
        if (origObj && origObj.material) {
          obj.material = origObj.material;
        }
      }
    });
    // ROBUST HEIGHT MEASUREMENT — same approach as pixlPals. Walk each
    // mesh's geometry.boundingBox (vertex-data-derived, unaffected by
    // skeleton bind-pose quirks) and union them to get the real height.
    clone.updateMatrixWorld(true);
    const combinedBox = new THREE.Box3();
    let foundAny = false;
    clone.traverse((obj) => {
      if ((obj.isMesh || obj.isSkinnedMesh) && obj.geometry) {
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        if (obj.geometry.boundingBox) {
          const b = obj.geometry.boundingBox.clone();
          b.applyMatrix4(obj.matrixWorld);
          if (!foundAny) { combinedBox.copy(b); foundAny = true; }
          else combinedBox.union(b);
        }
      }
    });
    let measuredY = 0;
    if (foundAny) {
      const sz = new THREE.Vector3();
      combinedBox.getSize(sz);
      measuredY = sz.y;
    } else {
      const fb = new THREE.Box3().setFromObject(clone);
      const sz = new THREE.Vector3();
      fb.getSize(sz);
      measuredY = sz.y;
    }
    // Normalize to 2.9 units tall — matches the pixl pal size so pals
    // and flingers read as peers on-screen.
    if (measuredY > 0.01 && isFinite(measuredY)) {
      // Same normalization target as pixl pals (3.6u) so the two ally
      // types read as uniform peers in the arena. Both sit just under
      // the player's ~4u height.
      const s = 3.6 / measuredY;
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

// -----------------------------------------------------------------------------
// INTERNAL: NETWORK HELPERS (concurrency + retry)
// -----------------------------------------------------------------------------

/**
 * Run an async task over `items` with at most `limit` in flight at once.
 * Prevents us from slamming the host with all N parallel requests — GitHub
 * Pages in particular rate-limits with 503 when we go too hard.
 */
async function _runWithConcurrency(items, limit, taskFn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try { await taskFn(item); } catch (e) { /* task-level errors already swallowed */ }
    }
  }
  const workers = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
}

/**
 * Wrap GLTFLoader.load in a Promise with retry-on-503. HEAD-probes the
 * URL on error to check for 5xx; if so, backs off exponentially and
 * retries. Three attempts total. Resolves with the gltf or rejects with
 * the last error.
 */
function _loadGLBWithRetry(url, maxAttempts = 3) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryLoad = () => {
      attempt++;
      gltfLoader.load(
        url,
        (gltf) => resolve(gltf),
        undefined,
        (err) => {
          if (attempt >= maxAttempts) {
            reject(err);
            return;
          }
          fetch(url, { method: 'HEAD' }).then(res => {
            if (res.status >= 500 && res.status < 600) {
              const delay = Math.min(5000, 1000 * Math.pow(2, attempt - 1));
              console.info(`[flinger] ${url} got ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
              setTimeout(tryLoad, delay);
            } else {
              reject(err);
            }
          }).catch(() => {
            const delay = Math.min(5000, 1000 * Math.pow(2, attempt - 1));
            setTimeout(tryLoad, delay);
          });
        },
      );
    };
    tryLoad();
  });
}

function _applyFlingerHighlight(mesh, tint) {
  // No-op. Removed chapter tint + aura rings per playtester request
  // AND to eliminate the m.needsUpdate=true cascade that forced
  // shader recompilation on every material in the GLB.
  void mesh; void tint;
}

function _resetFlingerHighlight(mesh) {
  // No-op — _applyFlingerHighlight no longer applies anything.
  void mesh;
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
  // FLINGER chip REMOVED per playtester feedback — see pixlPals.js
  // _syncHUD comment for the same rationale. Hero hexagons HUD now
  // covers chapter-ally theming visually. Strip any leftover element.
  const el = document.getElementById('flinger-indicator');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/** Create the HUD badge. Idempotent. */
export function initFlingerHUD() {
  _syncHUD();
}
