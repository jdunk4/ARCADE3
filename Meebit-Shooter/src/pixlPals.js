// ============================================================================
// src/pixlPals.js — summonable Pixl Pal allies.
//
// DESIGN
//  - Pixl Pals AUTO-DEPLOY 10 seconds into every boss fight (wave 5 of any
//    chapter). No E-key, no stockpile needed — the moment a boss has been
//    on-screen for ~10s, a pal drops in to help clear adds and soften up
//    the boss (bosses still take 1/4 damage from pal shots, so they can't
//    steal the kill).
//  - Waves 1-4 grant nothing. The pal is a boss-fight assist.
//  - A summoned Pixl Pal is a GLB-loaded ally picked at random from the
//    10 voxlpal-*.glb files in assets/civilians/pixlpal/. It is assigned
//    a random combat weapon (pistol/shotgun/smg/rocket/raygun).
//  - The pal auto-targets the nearest enemy inside range and fires bullets
//    at a max-output cadence so it clears the arena quickly. Its mission:
//    eliminate ~3/4 of the enemies that were alive at the moment of summon,
//    then wave goodbye.
//  - Pal bullets deal max damage vs normal enemies. Vs bosses: ONE-QUARTER
//    damage (boss kills still belong to the player).
//  - Pal bullets DO NOT hit mining blocks, hives (spawners), civilians, or
//    the player. They only hurt enemies and bosses.
//
// INTEGRATION
//  - main.js registers a kill handler at startup (registerPixlPalKillHandler)
//    so kills flow through the existing score/XP/loot pipeline.
//  - main.js calls updatePixlPals(dt) every frame from animate(), and
//    clearAllPixlPals() from the game reset path.
//  - onWaveStarted() remains exported for backward compat but is now a
//    no-op — the auto-deploy timer lives in updatePixlPals(). main.js
//    still calls it harmlessly via its existing wiring.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { scene } from './scene.js';
import { ARENA, WEAPONS, CHAPTERS, PARADISE_FALLEN_CHAPTER_IDX } from './config.js';
import { hitBurst } from './effects.js';
import { enemies } from './enemies.js';
import { Audio } from './audio.js';
import { S, shake } from './state.js';
import { UI } from './ui.js';
import { attachMixer, animationsReady, applyGunHoldPose, GUN_HOLD_EXCLUDE_BONES, IDLE_HIP_EXCLUDE_BONES } from './animation.js';

// -----------------------------------------------------------------------------
// ASSETS / CONSTANTS
// -----------------------------------------------------------------------------

// The 10 GLB files that live in assets/civilians/pixlpal/.
// Add to this list if more pals get added later.
const PIXLPAL_GLB_IDS = [14, 108, 776, 928, 1281, 1394, 1898, 2360, 2609, 2843];

// Which weapons a pal can be assigned. Pickaxe is a mining tool so it's
// excluded; pals need a combat weapon.
const PIXLPAL_WEAPONS = ['pistol', 'shotgun', 'smg', 'rocket', 'raygun'];

// Gate: one charge every this-many completed waves.
const CHARGE_EVERY_N_WAVES = 3;

// Maximum stockpile of charges.
const MAX_CHARGES = 3;

// Boss damage scale — pal bullets only deal this fraction of their
// normal damage to bosses. Pal helps, but can't steal boss kills easily.
const BOSS_DAMAGE_SCALE = 0.25;

// How long a pal may remain on the field before it auto-despawns.
// Prevents a pal sitting forever if the wave empties out on its own.
const PAL_MAX_LIFETIME_SEC = 16;

// Clear-goal: kill this fraction of enemies alive at summon time, then leave.
const CLEAR_FRACTION = 0.75;

// AI / firing tuning — "max output" for quick field clearing.
// Each weapon has its own base fire rate in WEAPONS; we multiply it down so
// the pal is noticeably faster than the player, and its damage is multiplied
// up so it actually melts groups. Bosses still see normal damage * 0.25.
const PAL_DAMAGE_MULT = 1.75;
const PAL_FIRE_RATE_MULT = 0.55;   // lower = faster shots

const PAL_RANGE = 28;
const PAL_MOVE_SPEED = 8.5;        // chases/repositions between shots
const PAL_HITRADIUS_DEFAULT = 1.0;
const PAL_BULLET_LIFE = 1.8;

// Keep pals from bunching up with the player too tightly.
const PAL_KEEP_NEAR_PLAYER = 14;

const PAL_SPAWN_OFFSET = 5.0;      // drop in this far from the player

// -----------------------------------------------------------------------------
// MODULE STATE
// -----------------------------------------------------------------------------

const pals = [];         // currently active Pixl Pals
const palBullets = [];   // bullets fired by pals (separate pipe)

// Hidden mesh pool — prebuilt during the matrix dive by preloadPixlPalGLBs().
// Each entry: { id, obj, inUse }. Stashed at y=-1000, visible=false. On
// summon we pull a not-in-use entry, flip it visible, teleport into place.
// Zero-jank because the clone + shader-compile cost was paid up front.
const poolEntries = [];

let lastWaveAwarded = 0; // last wave on which we awarded a charge
let _killHandler = null; // registered by main.js — wires kills to score/XP

// GLB loader + cache. Clones meshes per-summon so multiple pals can use
// the same GLB simultaneously without interfering.
const gltfLoader = new GLTFLoader();
const glbCache = new Map();   // id -> Promise<gltf>

// Reusable scratch
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export function registerPixlPalKillHandler(fn) {
  _killHandler = fn;
}

/**
 * Preload + PRE-CLONE all pixl pal GLBs into a hidden mesh pool during the
 * matrix dive. This mirrors the bonus-wave herd pool pattern:
 *
 *   1. Fetch every GLB (network + parse — expensive)
 *   2. SkeletonUtils.clone each one (skeleton rebind — expensive)
 *   3. Park the clone at y=-1000, visible=false, matrixAutoUpdate=false
 *      (invisible to the player, skipped in the render loop)
 *   4. renderer.compile() the whole set (PSO / shader warm — expensive)
 *
 * After this runs, trySummonPixlPal() becomes a zero-jank operation: it
 * finds a ready pool entry, flips visible=true, matrixAutoUpdate=true,
 * and teleports the mesh into position. No clone, no compile, no parse.
 *
 * Discovery order:
 *   1. Try `assets/civilians/pixlpal/manifest.json` (array of
 *      voxlpal-*.glb names).
 *   2. Fallback to hardcoded PIXLPAL_GLB_IDS.
 */
const POOL_STASH_Y = -1000;
const POOL_BATCH_PER_FRAME = 2;   // clone this many per frame, yield between batches

export async function preloadPixlPalGLBs(onProgress, renderer, camera) {
  let ids = PIXLPAL_GLB_IDS.slice();

  // --- Discover IDs from manifest ---
  try {
    const res = await fetch('assets/civilians/pixlpal/manifest.json', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        const parsed = [];
        for (const name of data) {
          if (typeof name !== 'string') continue;
          const m = name.match(/voxlpal-(\d+)\.glb$/i);
          if (m) parsed.push(parseInt(m[1], 10));
        }
        if (parsed.length > 0) {
          ids = parsed;
          console.log(`[pixlPal] manifest found (${ids.length} files)`);
        }
      }
    } else {
      console.log('[pixlPal] no manifest, using hardcoded list (' + ids.length + ' files)');
    }
  } catch (e) {
    console.log('[pixlPal] manifest fetch failed, using hardcoded list');
  }

  const total = ids.length;
  let loaded = 0;

  // --- Phase A: fetch all GLBs (populates glbCache as Promise<gltf>) ---
  // Throttled via a 3-worker queue (not all-in-parallel) so we don't
  // slam the host with 10 simultaneous chunky GLB requests alongside
  // whatever Phase 1 (herd VRMs) is doing. GitHub Pages in particular
  // rate-limits aggressive parallelism with 503s. Each fetch also
  // auto-retries up to 3 times on 5xx with exponential backoff.
  await _runWithConcurrency(ids, 3, async (id) => {
    if (!glbCache.has(id)) {
      const url = `assets/civilians/pixlpal/voxlpal-${id}.glb`;
      glbCache.set(id, _loadGLBWithRetry(url));
    }
    try { await glbCache.get(id); } catch (e) { /* non-fatal */ }
  });
  // [pixlPal] fetched log suppressed — see [flinger] rationale above.

  // --- Phase B: build the hidden mesh pool (clones, parked at y=-1000) ---
  const tmpScene = new THREE.Scene();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const mesh = await _loadPalMesh(id);    // fetches-or-returns-cached
      // _loadPalMesh returns a fresh clone; we keep it as our pool entry.
      mesh.position.set(0, POOL_STASH_Y, 0);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.traverse(o => { o.frustumCulled = false; });
      scene.add(mesh);
      tmpScene.add(mesh);
      poolEntries.push({ id, obj: mesh, inUse: false });
    } catch (err) {
      console.warn('[pixlPal] pool build failed for', id, err);
    }
    loaded++;
    if (onProgress) onProgress({ loaded, total, id });

    // Yield between batches so the dive's render loop stays responsive.
    if ((i + 1) % POOL_BATCH_PER_FRAME === 0) {
      await new Promise(r => requestAnimationFrame(r));
    }
  }

  // --- Phase C: PSO / shader warm for the whole set ---
  try {
    if (renderer && camera) {
      renderer.compile(tmpScene, camera);
    }
  } catch (err) {
    console.warn('[pixlPal] renderer.compile failed (non-fatal):', err);
  }
  // Re-parent clones back to the real scene (they were attached to
  // tmpScene temporarily for the compile pass).
  while (tmpScene.children.length > 0) {
    const m = tmpScene.children[0];
    tmpScene.remove(m);
    scene.add(m);
  }
  console.log(`[pixlPal] ✓ pool ready — ${loaded}/${total} prewarmed`);
  return { loaded, total };
}

// Tracks whether we've already deployed THIS boss fight's pal. Reset on
// boss death / reset. We only ever deploy ONE pal per boss fight — the
// moment the timer hits 10s, we drop a pal and mark this flag so we
// don't spam. The pal's own despawn logic handles everything after that.
let _bossPalDeployed = false;

// Tracks whether we've deployed the ch7 pal yet. Ch7 has no boss — the
// pal is force-deployed the first update tick in ch7 and persists until
// the run ends. Reset when leaving ch7 (via the ch7 check in
// updatePixlPals) and on clearAllPixlPals.
let _ch7PalDeployed = false;

/**
 * Back-compat stub. The old system awarded a charge every 3 waves; the
 * new system auto-deploys a pal 10 seconds into every boss fight (wave 5
 * of each chapter). main.js still calls this on every wave transition —
 * we keep it exported to avoid an import break but it does nothing.
 * The deploy logic lives in updatePixlPals() below.
 */
export function onWaveStarted(waveNum) {
  // Reset the per-boss-fight dedupe flag when a non-boss wave starts. The
  // actual "10s into boss fight" check runs in updatePixlPals().
  _bossPalDeployed = false;
  // Keep lastWaveAwarded in sync so the HUD doesn't get stuck stale.
  lastWaveAwarded = waveNum;
}

/**
 * Manually add a charge (for debug or future pickups). Kept exported for
 * parity; not used by the current deploy path.
 */
export function addPixlPalCharge(n = 1) {
  S.pixlPalCharges = Math.min(MAX_CHARGES, (S.pixlPalCharges || 0) + n);
  _syncHUD();
}

/**
 * Attempt to summon a pal. Returns true if a pal was actually summoned.
 * No-op if no charges are available or if the game isn't running.
 */
export function trySummonPixlPal(playerPos) {
  if (!S.running || S.paused) return false;
  if ((S.pixlPalCharges || 0) <= 0) return false;
  S.pixlPalCharges -= 1;
  _syncHUD();

  const glbId = PIXLPAL_GLB_IDS[Math.floor(Math.random() * PIXLPAL_GLB_IDS.length)];
  const weaponKey = PIXLPAL_WEAPONS[Math.floor(Math.random() * PIXLPAL_WEAPONS.length)];
  const weapon = WEAPONS[weaponKey];

  // Snapshot the enemy count so we can compute "cleared 75%" later.
  const enemiesAlreadyOnField = enemies.length;

  // Spawn location: just beside the player, offset along their facing so
  // they drop in visibly rather than materializing on top of the player.
  const ang = Math.random() * Math.PI * 2;
  const spawnX = (playerPos ? playerPos.x : 0) + Math.cos(ang) * PAL_SPAWN_OFFSET;
  const spawnZ = (playerPos ? playerPos.z : 0) + Math.sin(ang) * PAL_SPAWN_OFFSET;

  const placeholder = new THREE.Group();
  placeholder.position.set(spawnX, 0, spawnZ);
  scene.add(placeholder);

  // Warp-in flash
  _palSpawnFx(placeholder.position);
  Audio.levelup && Audio.levelup();
  shake(0.2, 0.15);

  const pal = {
    obj: placeholder,
    pos: placeholder.position,
    ready: false,
    weaponKey,
    weapon,
    fireCd: 0.3,           // small delay before first shot
    rescanCd: 0,
    targetEnemy: null,
    life: 0,
    maxLife: PAL_MAX_LIFETIME_SEC,
    killsThisSummon: 0,
    enemiesAtSummon: enemiesAlreadyOnField,
    killsGoal: Math.max(3, Math.ceil(enemiesAlreadyOnField * CLEAR_FRACTION)),
    despawning: false,
    walkPhase: Math.random() * Math.PI * 2,
    glbId,
  };
  pals.push(pal);

  // Tell the player which weapon this pal got.
  const color = '#' + weapon.color.toString(16).padStart(6, '0');
  UI.toast && UI.toast('PIXL PAL · ' + weapon.name, color, 1600);

  // --- POOL PATH — find a prebuilt, hidden mesh and teleport it. ---
  // This is the zero-jank path: no GLB parse, no SkeletonUtils.clone, no
  // shader compile. All paid during the matrix dive. Pool was seeded by
  // preloadPixlPalGLBs(). Ring tint comes from the current chapter.
  const chapterTint = CHAPTERS[S.chapter % CHAPTERS.length].full.grid1;
  const pooledMesh = _acquirePoolMesh();
  if (pooledMesh) {
    pal.glbId = pooledMesh.userData && pooledMesh.userData.__palId;
    scene.remove(pal.obj);
    pooledMesh.visible = true;
    pooledMesh.matrixAutoUpdate = true;
    pooledMesh.position.copy(pal.pos);
    pooledMesh.rotation.y = Math.random() * Math.PI * 2;
    // Reset per-summon ring (remove any stale aura from a previous use,
    // then attach a fresh one in the current chapter's tint).
    _resetPalHighlight(pooledMesh);
    _applyPalHighlight(pooledMesh, chapterTint);
    pal.obj = pooledMesh;
    pal.pos = pooledMesh.position;
    pal.ready = true;

    if (animationsReady()) {
      try {
        // No excludeBones — pixlpals are on an Unreal rig, the VRM gun-hold
        // pose never hit them, and the idle2/idle3 clips had a sideways
        // lean baked in. Plain walk on all bones reads clean and natural.
        pal.mixer = attachMixer(pooledMesh, {});
        pal.mixer.playWalk();
      } catch (e) {
        console.warn('[PixlPal] attachMixer failed', e);
      }
    }
    return true;
  }

  // --- FALLBACK PATH — pool was never built (first-run crash path) or
  // exhausted. Do it the slow way: fetch/clone on-demand. Will jank.
  console.warn('[PixlPal] pool miss — falling back to on-demand load');
  _loadPalMesh(glbId).then(mesh => {
    if (!pals.includes(pal)) return;
    scene.remove(pal.obj);
    mesh.position.copy(pal.pos);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    _applyPalHighlight(mesh, chapterTint);
    scene.add(mesh);
    pal.obj = mesh;
    pal.pos = mesh.position;
    pal.ready = true;
    if (animationsReady()) {
      try {
        pal.mixer = attachMixer(mesh, {});
        pal.mixer.playWalk();
      } catch (e) {
        console.warn('[PixlPal] attachMixer failed', e);
      }
    }
  }).catch(err => {
    console.warn('[PixlPal] GLB load failed for', glbId, err);
    _buildFallbackVoxel(pal.obj, weapon.color);
    pal.ready = true;
  });

  return true;
}

/**
 * Clear all pals + pal bullets. Call from the game-reset path.
 */
export function clearAllPixlPals() {
  for (const p of pals) {
    _releasePoolMesh(p.obj, p.mixer);
    p.mixer = null;
  }
  pals.length = 0;
  for (const b of palBullets) {
    if (b && b.parent) scene.remove(b);
  }
  palBullets.length = 0;
  lastWaveAwarded = 0;
  S.pixlPalCharges = 0;
  _bossPalDeployed = false;
  _ch7PalDeployed = false;
  _syncHUD();
}

/**
 * Main per-frame update. Called from main.js animate().
 *
 * @param {number} dt            seconds since last frame
 * @param {THREE.Vector3} playerPos  used to keep pals roughly near player
 */
export function updatePixlPals(dt, playerPos) {
  // --- AUTO-DEPLOY: 10 seconds into a boss fight ---
  // When a boss is active AND we haven't yet deployed a pal for THIS
  // boss fight AND the fight has been running for >= 10 seconds, drop
  // one pal in. S.bossFightStartTime is set by waves.js when the boss
  // spawns and cleared when the boss dies.
  if (!_bossPalDeployed &&
      S.bossRef &&
      S.bossFightStartTime != null &&
      S.running && !S.paused) {
    const fightElapsed = (S.timeElapsed || 0) - S.bossFightStartTime;
    if (fightElapsed >= 10) {
      _bossPalDeployed = true;
      // Grant a charge in-place and summon. No HUD charge grind — the
      // player didn't earn it, the fight did.
      S.pixlPalCharges = Math.max(1, S.pixlPalCharges || 1);
      trySummonPixlPal(playerPos);
      UI.toast && UI.toast('PIXL PAL INBOUND', '#00ff66', 2000);
    }
  }
  // If the boss just died (or we're in a non-boss wave), reset the dedupe
  // flag so the next boss fight can deploy.
  if (!S.bossRef) {
    _bossPalDeployed = false;
  }

  // (Legacy ch7 force-deploy + persistence was removed when pixl pals
  // were disabled entirely in chapter 7. Per playtester: "Can we get
  // rid of the flinger and pixl pal in chapter 7?")
  // Reset the ch7 dedupe flag whenever we leave ch7 just so it stays
  // tidy across runs.
  if (S.chapter !== PARADISE_FALLEN_CHAPTER_IDX) {
    _ch7PalDeployed = false;
  }

  // --- Pals ---
  for (let i = pals.length - 1; i >= 0; i--) {
    const p = pals[i];
    if (!p.ready) continue;

    p.life += dt;

    // Standard despawn conditions — lifetime expired or kill cap reached.
    // (Legacy ch7 persistence flag was removed when pals were disabled
    // entirely in chapter 7; any pal still alive in ch7 is a leftover
    // from an earlier chapter and should despawn.)
    if (!p.despawning && (
        p.life >= p.maxLife ||
        p.killsThisSummon >= p.killsGoal
    )) {
      p.despawning = true;
      p.despawnTimer = 0.45;
      UI.toast && UI.toast('PIXL PAL EXTRACT', '#00ff66', 1000);
    }

    if (p.despawning) {
      p.despawnTimer -= dt;
      if (p.obj && p.obj.scale) {
        const s = Math.max(0.01, p.despawnTimer / 0.45);
        p.obj.scale.setScalar(s);
      }
      if (p.despawnTimer <= 0) {
        _palSpawnFx(p.pos);
        _releasePoolMesh(p.obj, p.mixer);
        p.mixer = null;
        pals.splice(i, 1);
        continue;
      }
    }

    // --- Retarget (cheap periodic rescan) ---
    p.rescanCd -= dt;
    if (p.rescanCd <= 0 || !_enemyAlive(p.targetEnemy)) {
      p.rescanCd = 0.25;
      p.targetEnemy = _findNearestEnemy(p.pos, PAL_RANGE);
    }

    // --- Movement: chase current target, or drift back toward player ---
    let moveTo = null;
    if (p.targetEnemy) {
      moveTo = p.targetEnemy.pos;
    } else if (playerPos) {
      // Idle near the player
      _v.copy(playerPos).sub(p.pos);
      if (_v.lengthSq() > PAL_KEEP_NEAR_PLAYER * PAL_KEEP_NEAR_PLAYER) {
        moveTo = playerPos;
      }
    }

    if (moveTo) {
      _v.copy(moveTo).sub(p.pos);
      _v.y = 0;
      const dist = _v.length();
      if (dist > 0.001) {
        _v.multiplyScalar(1 / dist);
        // Stand off ~6 units from targets so we don't faceplant into them
        const desired = p.targetEnemy ? 6 : 0;
        if (dist > desired) {
          p.pos.x += _v.x * PAL_MOVE_SPEED * dt;
          p.pos.z += _v.z * PAL_MOVE_SPEED * dt;
          p._movedThisFrame = true;
        } else {
          p._movedThisFrame = false;
        }
        // Face the move direction
        if (p.obj) p.obj.rotation.y = Math.atan2(_v.x, _v.z);
      }
      // Clamp inside arena
      const lim = ARENA * 0.95;
      if (p.pos.x > lim) p.pos.x = lim;
      if (p.pos.x < -lim) p.pos.x = -lim;
      if (p.pos.z > lim) p.pos.z = lim;
      if (p.pos.z < -lim) p.pos.z = -lim;
    } else {
      p._movedThisFrame = false;
    }

    // Always drive the walk clip — idle clips have a sideways-lean bake-in
    // that reads badly on the Unreal pixlpal rig. Walk keeps pelvis/legs
    // centered and reads fine even when the pal is standing still between
    // shots. Speed scales slightly up when actually moving.
    if (p.mixer) {
      p.mixer.playWalk();
      p.mixer.setSpeed(p._movedThisFrame ? 1.2 : 1.0);
      p.mixer.update(dt);
    }

    // Subtle walk bob — keeps pals visually alive regardless of whether the
    // mixer's tracks match their rig. Harmless when the mixer is driving
    // the bones (they'll just override the y position anyway).
    p.walkPhase += dt * 10;
    if (p.obj && !p.despawning) {
      p.obj.position.y = Math.abs(Math.sin(p.walkPhase)) * 0.06;
    }

    // --- Shooting ---
    p.fireCd -= dt;
    if (!p.despawning && p.fireCd <= 0 && p.targetEnemy && _enemyAlive(p.targetEnemy)) {
      _firePalShot(p, p.targetEnemy);
      // Weapon-specific base rate, then global pal speed multiplier
      const baseRate = p.weapon.fireRate || 0.3;
      p.fireCd = Math.max(0.05, baseRate * PAL_FIRE_RATE_MULT);
    }
  }

  // --- Pal bullets ---
  for (let i = palBullets.length - 1; i >= 0; i--) {
    const b = palBullets[i];
    const ud = b.userData;
    // Homing for rockets (same logic as player rockets — just turn toward target)
    if (ud.homing && _enemyAlive(ud.homingTarget)) {
      _v.copy(ud.homingTarget.pos).sub(b.position);
      _v.y = 0;
      if (_v.lengthSq() > 0.001) {
        _v.normalize();
        const cur = ud.vel.clone().normalize();
        // Lerp toward target direction
        const turn = Math.min(1, ud.homingStrength * dt);
        cur.lerp(_v, turn).normalize();
        const spd = ud.vel.length();
        ud.vel.copy(cur).multiplyScalar(spd);
      }
    }
    b.position.addScaledVector(ud.vel, dt);
    ud.life -= dt;
    if (ud.life <= 0 ||
        Math.abs(b.position.x) > ARENA ||
        Math.abs(b.position.z) > ARENA) {
      if (ud.explodes) _palExplosion(b.position, ud);
      scene.remove(b);
      palBullets.splice(i, 1);
      continue;
    }
    // Enemy hit check — THIS IS THE ONLY COLLISION PATH.
    // Pal bullets intentionally skip blocks, hives/spawners, civilians,
    // and the player. Bosses are regular enemies in the `enemies` array
    // except bossRef flag on them.
    let hitIdx = -1;
    let hitRadius = ud.hitRadius;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const r = e.isBoss ? hitRadius * 2.5 : hitRadius;
      const dx = e.pos.x - b.position.x;
      const dz = e.pos.z - b.position.z;
      if (dx * dx + dz * dz < r * r) { hitIdx = j; break; }
    }
    if (hitIdx >= 0) {
      const e = enemies[hitIdx];
      _applyPalDamage(e, ud.damage, hitIdx);
      if (ud.explodes) {
        _palExplosion(b.position, ud);
      } else {
        hitBurst(b.position, ud.color, 5);
      }
      scene.remove(b);
      palBullets.splice(i, 1);
    }
  }
}

// -----------------------------------------------------------------------------
// INTERNAL: FIRING
// -----------------------------------------------------------------------------

function _firePalShot(pal, target) {
  const w = pal.weapon;
  // Fire origin: muzzle height over the pal
  const origin = new THREE.Vector3(pal.pos.x, 1.3, pal.pos.z);
  // Aim at target with a small lead
  _v.copy(target.pos).sub(origin);
  _v.y = 0;
  const dist = _v.length();
  if (dist < 0.001) return;
  _v.normalize();

  const baseDmg = (w.damage || 20) * PAL_DAMAGE_MULT;

  if (w.isBeam) {
    // RAYGUN: instant hitscan tick. Damage all enemies inside a narrow cone
    // along the aim ray up to beamRange.
    const beamRange = w.beamRange || 22;
    const beamWidth = (w.beamWidth || 0.35) * 1.4;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const ex = e.pos.x - origin.x;
      const ez = e.pos.z - origin.z;
      const along = ex * _v.x + ez * _v.z;
      if (along < 0 || along > beamRange) continue;
      const perp = Math.abs(ex * _v.z - ez * _v.x);
      const r = e.isBoss ? beamWidth + 1.2 : beamWidth + 0.5;
      if (perp < r) {
        _applyPalDamage(e, baseDmg, j);
      }
    }
    // Visual: a brief line segment shown via particles at segments.
    for (let k = 0; k < 10; k++) {
      const t = k / 9;
      const px = origin.x + _v.x * beamRange * t;
      const pz = origin.z + _v.z * beamRange * t;
      hitBurst(new THREE.Vector3(px, 1.2, pz), w.color, 1);
    }
    return;
  }

  if (w.isHoming) {
    // ROCKET — single homing projectile with AoE at end-of-life.
    _spawnPalBullet(origin, _v, {
      speed: w.speed,
      damage: baseDmg,
      color: w.color,
      hitRadius: 1.1,
      homing: true,
      homingTarget: target,
      homingStrength: w.homingStrength || 5,
      explodes: true,
      explosionRadius: w.explosionRadius || 3.5,
      explosionDamage: (w.explosionDamage || 60) * PAL_DAMAGE_MULT,
      life: 2.4,
    });
    return;
  }

  // PISTOL / SHOTGUN / SMG — straight-line projectile(s).
  const nShots = w.bullets || 1;
  const spread = w.spread || 0;
  for (let k = 0; k < nShots; k++) {
    const ang = Math.atan2(_v.x, _v.z);
    const jitter = (nShots > 1)
      ? (k / (nShots - 1) - 0.5) * spread * 2 + (Math.random() - 0.5) * spread * 0.5
      : (Math.random() - 0.5) * spread;
    const theta = ang + jitter;
    const dir = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
    _spawnPalBullet(origin, dir, {
      speed: w.speed,
      damage: baseDmg / (nShots > 1 ? 1 : 1),    // shotgun pellets already split at weapon-def time
      color: w.color,
      hitRadius: PAL_HITRADIUS_DEFAULT,
      life: PAL_BULLET_LIFE,
    });
  }
}

function _spawnPalBullet(origin, dir, opts) {
  const geo = opts.explodes
    ? new THREE.SphereGeometry(0.35, 8, 8)
    : new THREE.BoxGeometry(0.22, 0.22, 0.55);
  const mat = new THREE.MeshBasicMaterial({
    color: opts.color,
    transparent: true,
    opacity: 0.95,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(origin);
  if (!opts.explodes) {
    m.lookAt(origin.x + dir.x, origin.y, origin.z + dir.z);
  }
  m.userData = {
    vel: dir.clone().multiplyScalar(opts.speed),
    life: opts.life,
    damage: opts.damage,
    color: opts.color,
    hitRadius: opts.hitRadius,
    homing: !!opts.homing,
    homingTarget: opts.homingTarget || null,
    homingStrength: opts.homingStrength || 0,
    explodes: !!opts.explodes,
    explosionRadius: opts.explosionRadius || 0,
    explosionDamage: opts.explosionDamage || 0,
  };
  scene.add(m);
  palBullets.push(m);
}

function _palExplosion(pos, ud) {
  hitBurst(pos, ud.color, 24);
  shake(0.15, 0.12);
  const r = ud.explosionRadius;
  const dmg = ud.explosionDamage;
  for (let j = enemies.length - 1; j >= 0; j--) {
    const e = enemies[j];
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    if (dx * dx + dz * dz < r * r) {
      _applyPalDamage(e, dmg, j);
    }
  }
}

// -----------------------------------------------------------------------------
// INTERNAL: DAMAGE
// -----------------------------------------------------------------------------

function _applyPalDamage(enemy, dmg, enemyIdx) {
  if (!enemy) return;
  // Bosses take only a quarter of the pal's damage so the player still
  // has to do the real work.
  if (enemy.isBoss) dmg *= BOSS_DAMAGE_SCALE;
  enemy.hp -= dmg;
  enemy.hitFlash = 0.18;
  if (enemy.hp <= 0) {
    // Locate the enemy's current index (may have shifted if other bullets
    // were processed in the same frame).
    let idx = enemyIdx;
    if (idx == null || idx < 0 || enemies[idx] !== enemy) {
      idx = enemies.indexOf(enemy);
    }
    if (idx >= 0 && _killHandler) {
      // Attribute the kill to the pal's summoner.
      _onPalKill();
      _killHandler(idx);
    }
  }
}

function _onPalKill() {
  // Credit the most-recent still-alive pal. If multiple pals are up,
  // crediting the first one is fine — they're all expendable.
  for (const p of pals) {
    if (!p.despawning) {
      p.killsThisSummon++;
      break;
    }
  }
}

function _enemyAlive(e) {
  return !!e && e.hp > 0 && enemies.indexOf(e) >= 0;
}

// -----------------------------------------------------------------------------
// INTERNAL: POOL ACQUIRE / RELEASE
// -----------------------------------------------------------------------------

/**
 * Find a pool entry that isn't currently in use and return its mesh.
 * Returns null if the pool is empty (preload didn't run) or exhausted
 * (every entry is already deployed — shouldn't happen; we only ever
 * have one live pal at a time).
 */
function _acquirePoolMesh() {
  for (let i = 0; i < poolEntries.length; i++) {
    const e = poolEntries[i];
    if (!e.inUse) {
      e.inUse = true;
      // Tag with its own id so we can identify it on release.
      if (e.obj) {
        if (!e.obj.userData) e.obj.userData = {};
        e.obj.userData.__palId = e.id;
      }
      return e.obj;
    }
  }
  return null;
}

/**
 * Return a previously-acquired mesh back to the pool. Hides it, freezes
 * its matrix, resets the highlight, detaches the mixer, moves it back
 * to y=-1000. Safe to call if the mesh isn't actually in the pool
 * (e.g. a fallback voxel) — it just silently no-ops.
 */
function _releasePoolMesh(mesh, mixer) {
  if (!mesh) return;
  if (mixer) {
    try { mixer.stop && mixer.stop(); } catch (e) {}
  }
  for (let i = 0; i < poolEntries.length; i++) {
    const e = poolEntries[i];
    if (e.obj === mesh) {
      e.inUse = false;
      _resetPalHighlight(mesh);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.position.set(0, POOL_STASH_Y, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.setScalar(1);
      mesh.updateMatrix();
      return;
    }
  }
  // Not a pool mesh — remove it from the scene normally.
  if (mesh.parent) scene.remove(mesh);
}

function _findNearestEnemy(fromPos, maxRange) {
  let best = null;
  let bestDsq = maxRange * maxRange;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const dx = e.pos.x - fromPos.x;
    const dz = e.pos.z - fromPos.z;
    const dsq = dx * dx + dz * dz;
    if (dsq < bestDsq) { bestDsq = dsq; best = e; }
  }
  return best;
}

// -----------------------------------------------------------------------------
// INTERNAL: GLB LOAD / CACHE
// -----------------------------------------------------------------------------

function _loadPalMesh(id) {
  if (!glbCache.has(id)) {
    const url = `assets/civilians/pixlpal/voxlpal-${id}.glb`;
    glbCache.set(id, _loadGLBWithRetry(url));
  }
  return glbCache.get(id).then(gltf => {
    // CRITICAL: these GLBs are rigged (SkinnedMesh + Skin + 80-bone rig).
    // THREE.Object3D.clone() does NOT properly clone rigs — the cloned
    // SkinnedMeshes still reference the original scene graph's bones,
    // so when the clone is inserted into our scene they render at the
    // identity transform (collapsed / invisible).
    //
    // SkeletonUtils.clone is the standard Three.js fix — it rebinds the
    // skeleton to the cloned bones so the mesh renders correctly.
    const clone = skeletonClone(gltf.scene);

    // Pal avatars import with Z-up or mis-scaled; normalize to ~2.9 units tall
    // so they read close to the player's apparent size (player = PLAYER.scale
    // 1.8 on a raw Meebit VRM ≈ 4 units). Pals sit a touch smaller than the
    // player — they're allies, not peers.
    // setFromObject can return an invalid box on SkinnedMeshes because
    // their geometry's bounding volumes are relative to bind pose. We
    // ROBUST HEIGHT MEASUREMENT. setFromObject(clone) on a SkinnedMesh
    // returns a bounding box based on the skeleton's bind pose — which
    // varies WILDLY between pal GLBs (some import with Z-up, some with
    // offset pelvises, etc). That variance is why some pals were
    // rendering 2× the size of others even though every one was
    // "normalized" to 2.9u.
    //
    // Instead we walk every mesh, union their geometry.boundingBox
    // (which is vertex-data-derived, not transform-derived), and take
    // the world-space Y extent of that combined box. Consistent across
    // all variants.
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
      // Fallback to the scene-graph box if no geometries had bounding
      // boxes (shouldn't happen but be safe).
      const fb = new THREE.Box3().setFromObject(clone);
      const sz = new THREE.Vector3();
      fb.getSize(sz);
      measuredY = sz.y;
    }
    if (measuredY > 0.01 && isFinite(measuredY)) {
      // Normalize to ~3.6 units tall. Previously 2.9 → pals read as
      // noticeably smaller than the player (player ~4u) and small next
      // to flingers. 3.6 puts pals and flingers at the same height and
      // just a touch shorter than the player so they still read as
      // allies rather than rivals.
      const s = 3.6 / measuredY;
      clone.scale.setScalar(s);
      clone.updateMatrixWorld(true);
    }

    // Drop them feet-on-ground. Recompute box after rescale.
    const box2 = new THREE.Box3().setFromObject(clone);
    if (isFinite(box2.min.y)) {
      clone.position.y -= box2.min.y;
    }

    // Disable frustum culling for skinned meshes. Their bounding volume
    // is bind-pose based and often sits offset from the rendered pose,
    // causing sporadic invisibility at glancing camera angles.
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
 * Wrap GLTFLoader.load in a Promise with retry-on-503. Detects 5xx by
 * fetching HEAD first (cheap); if 5xx, backs off 1s/2s/4s and retries.
 * Three total attempts before giving up. Resolves with the gltf or
 * rejects with the last error.
 *
 * Uses a plain fetch probe rather than parsing GLTFLoader's error codes
 * because three.js doesn't expose the HTTP status on load errors.
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
          // Probe the URL to see if it's a transient 5xx. If HEAD returns
          // 2xx/3xx, the error was something else (parse error, CORS) and
          // retry won't help.
          fetch(url, { method: 'HEAD' }).then(res => {
            if (res.status >= 500 && res.status < 600) {
              const delay = Math.min(5000, 1000 * Math.pow(2, attempt - 1));
              console.info(`[pixlPal] ${url} got ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
              setTimeout(tryLoad, delay);
            } else {
              // Non-transient — give up.
              reject(err);
            }
          }).catch(() => {
            // HEAD also failed → network issue. Retry anyway.
            const delay = Math.min(5000, 1000 * Math.pow(2, attempt - 1));
            setTimeout(tryLoad, delay);
          });
        },
      );
    };
    tryLoad();
  });
}

function _applyPalHighlight(mesh, tintColor) {
  // Subtle emissive lift in the chapter tint so it reads as an ally
  // from across the arena. We STORE the pre-tint emissive values on a
  // userData marker so _resetPalHighlight can undo them cleanly when
  // the mesh returns to the pool.
  const tint = new THREE.Color(tintColor);
  mesh.traverse(obj => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.emissive) {
          if (!m.userData) m.userData = {};
          if (!m.userData.__palOrigEmissive) {
            m.userData.__palOrigEmissive = m.emissive.clone();
            m.userData.__palOrigIntensity = m.emissiveIntensity || 0;
          }
          m.emissive = m.userData.__palOrigEmissive.clone()
            .add(tint.clone().multiplyScalar(0.2));
          m.emissiveIntensity = Math.max(0.25, m.userData.__palOrigIntensity);
          m.needsUpdate = true;
        }
      }
    }
  });
  // Aura ring at the feet. Named so _resetPalHighlight can find and
  // remove it before the next chapter's summon applies a new color.
  const auraGeo = new THREE.RingGeometry(0.9, 1.3, 24);
  const auraMat = new THREE.MeshBasicMaterial({
    color: tintColor,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.55,
  });
  const aura = new THREE.Mesh(auraGeo, auraMat);
  aura.name = 'pixlpal-aura';
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.05;
  mesh.add(aura);
}

/**
 * Undo whatever _applyPalHighlight did to this mesh. Called right before
 * a re-used pool mesh gets its new chapter-tint ring applied, so the ring
 * from its last use doesn't linger.
 */
function _resetPalHighlight(mesh) {
  // Remove any stale aura rings (named children added by _applyPalHighlight).
  for (let i = mesh.children.length - 1; i >= 0; i--) {
    const c = mesh.children[i];
    if (c && c.name === 'pixlpal-aura') {
      mesh.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }
  // Restore original emissive state on every material we touched.
  mesh.traverse(obj => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.userData && m.userData.__palOrigEmissive) {
          m.emissive.copy(m.userData.__palOrigEmissive);
          m.emissiveIntensity = m.userData.__palOrigIntensity;
          m.needsUpdate = true;
        }
      }
    }
  });
}

function _buildFallbackVoxel(placeholder, weaponColor) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: weaponColor,
    emissiveIntensity: 0.8,
    roughness: 0.4,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.6), mat);
  body.position.y = 1.0;
  placeholder.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat);
  head.position.y = 2.2;
  placeholder.add(head);
}

function _palSpawnFx(pos) {
  // Bright burst + quick shake for the arrival / departure warp
  hitBurst(pos, 0x00ff66, 30);
  hitBurst(pos, 0xffffff, 12);
}

// -----------------------------------------------------------------------------
// HUD INDICATOR
// -----------------------------------------------------------------------------

// Lightweight DOM indicator — REMOVED per playtester feedback. The
// chapter-ally hero hexagons HUD (heroHexagons.js) now communicates
// pal/flinger/gob status visually in the top-left, so the text chip
// is redundant clutter. _syncHUD is kept as a no-op to avoid having
// to find and prune every call site; it now also strips any chip
// that may have been created by a previous version (hot-reload path).
function _syncHUD() {
  const el = document.getElementById('pixlpal-indicator');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// Call periodically — pals.length changes during updatePixlPals, so we
// refresh the HUD at spawn/despawn. Exported in case main.js wants to
// force a refresh after chapter transitions.
export function refreshPixlPalHUD() { _syncHUD(); }

// Initialize the HUD once the DOM is ready. Safe to call multiple times.
export function initPixlPalHUD() {
  _syncHUD();
}
