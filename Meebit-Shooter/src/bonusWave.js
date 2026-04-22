// BONUS WAVE — "THE STAMPEDE"
//
// Triggered as wave 6 of every chapter, right after the boss falls.
// Themed Meebits pour into the arena. The player has 30 seconds to laser-tag
// each one (shooting them 3-15 times depending on chapter — no damage to them,
// just a "free them from the simulation" animation). Meebits fire HEALING
// pulses back at the player — dodging is optional; the pulses restore HP.
//
// Per-chapter herd (defined in config.CHAPTERS[i].bonusHerd):
//   Ch.1 INFERNO   → PIGS       (51, normal, 6 shots each)
//   Ch.2 CRIMSON   → ELEPHANTS  (38, normal, 6 shots each)
//   Ch.3 SOLAR     → SKELETONS  (59, normal, 6 shots each)
//   Ch.4 TOXIC     → ROBOTS     (74, normal, 6 shots each)
//   Ch.5 ARCTIC    → VISITORS   (18, normal, 6 shots each)
//   Ch.6 PARADISE  → DISSECTED  (6 super-bosses, 2.5x scale, 15 shots each)
//
// Flow:
//   startBonusWave(chapterIdx)  — loads herd, spawns N over ~N*stagger ms, starts 30s timer
//   updateBonusWave(dt, player) — timer tick, proximity checks, wander movement, heal-fire
//   endBonusWave()              — celebrates, clears herd, returns { caught, total }
//   isBonusWaveActive()         — bool
//   getHealingProjectiles()     — array of {pos, vel, life, heal, mesh} for main.js to tick
//   consumeHealingProjectile(p) — called by main.js when a heal-pulse hits player

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA, BONUS_WAVE_CONFIG, CHAPTERS } from './config.js';
import {
  discoverHerd,
  getHerdMeshByFilename,
  getHerdVoxelFallback,
  prefetchHerd,
  prewarmHerd,
} from './herdVrmLoader.js';
import { hitBurst } from './effects.js';
import { attachMixer, animationsReady } from './animation.js';
import { Audio } from './audio.js';

// -- Module state --
const herd = [];                 // live, un-saved meebits
const savedPigs = [];            // meebits who've been fully saved — decorative, standing on ring
const healingProjectiles = [];   // in-flight heal pulses the meebits are firing at the player

// -- Pig pools (one per chapter, all pre-built during matrix dive) --
// Map<chapterIdx, PoolEntry[]>. Each PoolEntry is
//   { obj: Object3D, herdId: string, filename: string, inUse: boolean }
// All 6 chapter pools are built upfront during the matrix dive preload. By
// the time gameplay starts, every chapter's Wave 6 herd is already cloned,
// in the scene (hidden at y = POOL_STASH_Y), PSO-warmed. Wave 6 spawn is a
// pure teleport operation — zero freeze.
const pigPools = new Map();

let active = false;
let timeLeft = 0;
let caughtCount = 0;
let currentHerdId = null;
let currentHerdLabel = null;
let currentChapterTint = 0xffffff;
let currentChapterIdx = 0;       // which chapter the current bonus wave belongs to
let currentFilenames = [];
// Per-wave config pulled from the current chapter's bonusHerd at startBonusWave.
// Captured here so damageHerdAt / spawn / heal-fire all agree on the same values.
let currentHerdSize = 0;
let currentHerdScale = 1.5;
let currentShotsToSave = 6;
let currentBossTier = false;
let onCaughtCallback = null;
// Shuffled bag of available perimeter slots. When a pig is saved, we pull
// the next slot from this bag — so early saves scatter across all 4 sides
// of the square instead of clumping at slots 0, 1, 2... of the north side.
let _slotBag = null;
let _slotBagCursor = 0;
// Chapter of the most-recently-active bonus wave.
let _latestSaveChapter = -1;

// Where pre-warmed pigs wait until Wave 6. Below the floor, out of frustum.
const POOL_STASH_Y = -1000;

// Confetti for the end-of-wave celebration (spawned purely for visuals).
const CATCH_BURST_COLOR = 0xffd93d;

// ---- LASER TAG tuning ----
// Player shoots each meebit currentShotsToSave times to "save" them (6 for
// normal chapters, 15 for dissected super-bosses — see currentShotsToSave
// above). First shot triggers panic flee (3 second window) — classic chase
// dynamic. Saved meebits teleport to an evenly-spaced square formation around
// the arena perimeter, facing inward, playing a random idle animation.
// Note: SHOTS_TO_SAVE is no longer a constant — it's per-herd (currentShotsToSave).
const PANIC_FLEE_DURATION = 3.0;   // seconds pig runs after being grazed
const HIT_FLASH_DURATION = 0.2;    // seconds of red tint on hit

// ---- Saved-pig square formation ----
// Arena is 50x50 (from config.ARENA). Spectator crowd sits at ±58 (ARENA+8).
// Place saved pigs in the 8-unit gap between arena floor edge and crowd, at
// radius ~54 from center. Laid out as a square ring (not a circle) — 4 sides,
// each side is a row of pigs facing inward.
const SAVE_RING_OFFSET = 4;        // distance from arena edge (ARENA + 4 = 54)
const SAVE_SPACING = 2.2;          // units between adjacent pigs in formation
const SAVE_ROW_STEP = 2.4;         // back-to-front row depth (if we need row 2)
// Four slots per side at the corners are reserved so the formation "squares off"
// cleanly. Total base slots per row = 4 sides × (ARENA*2 / SAVE_SPACING) ≈ 180.
// Plenty of room for 6 chapters × 111 = 666 saved pigs in 3-4 rows.
const SAVE_SIDE_HALF = 46;         // pigs fill side from -46 to +46 (leaves corner gap)

// ---- Ambient flee tuning (panic speed when a pig gets grazed) ----
const FLEE_SPEED = 4.5;
const FLEE_EDGE_BOUNCE = 0.85;

// ---- CLONE SHIELDS ----
// Each pig is flanked by 2 chapter-tinted mesh clones that act as visual
// shields (damage-immune). They orbit the pig at a small offset, staying
// "very near the meebit origin" so shots have to get past them. When the
// pig is fully tagged (hp=0), the clones animate inward to the pig's
// current position over CLONE_CONVERGE_SEC, then both clones + pig fade
// out together; after that, the pig is placed into the saved formation.
const CLONE_COUNT = 2;
const CLONE_ORBIT_RADIUS = 0.9;     // offset from pig center (x/z plane)
const CLONE_ORBIT_SPEED = 1.6;      // radians/sec (slow rotation around pig)
const CLONE_BOB_AMP = 0.12;         // subtle vertical bob
const CLONE_CONVERGE_SEC = 0.55;    // time for clones to fly into pig on save
const CLONE_FADE_SEC = 0.25;        // post-merge fade-to-nothing window

// Detached clones that belong to already-saved pigs — they still need to
// finish their converge+fade animation after the pig has been teleported
// out. Each entry is { clones: [...], targetX, targetZ }. The target is
// the pig's position at the moment of save (converge anchor), captured so
// the anim doesn't snap when we shuffle the pig to its formation slot.
const _decayingClones = [];

// Shared geometry for clone shields — cheap to reuse across every pig.
// A slightly squashed box silhouette reads as "Meebit" at a glance
// without needing to clone the VRM (which would be heavy).
const CLONE_GEO = new THREE.BoxGeometry(0.55, 1.1, 0.55);
CLONE_GEO.translate(0, 0.55, 0);

// Per-clone materials are created per-pig so we can fade opacity individually
// without touching other pigs' clones.

function _makeCloneMesh(tintHex) {
  const mat = new THREE.MeshBasicMaterial({
    color: tintHex,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,   // so overlapping clones don't punch holes in each other
  });
  const mesh = new THREE.Mesh(CLONE_GEO, mat);
  // Wireframe outline child to give the clone a bit of "ghost Meebit" texture
  // without a second draw of the full geometry. Cheap.
  const outlineMat = new THREE.MeshBasicMaterial({
    color: tintHex,
    wireframe: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const outline = new THREE.Mesh(CLONE_GEO, outlineMat);
  outline.scale.setScalar(1.02);
  mesh.add(outline);
  mesh.userData.outlineMat = outlineMat;
  mesh.userData.fillMat = mat;
  return mesh;
}

function _spawnClonesFor(h, tintHex) {
  const clones = [];
  for (let i = 0; i < CLONE_COUNT; i++) {
    const mesh = _makeCloneMesh(tintHex);
    // Scale clones down a bit relative to the full-size pig so they read as
    // "smaller guardian echoes" rather than identical twins. Uses the current
    // herd scale so dissected super-bosses still get proportionate clones.
    const s = currentHerdScale * 0.75;
    mesh.scale.setScalar(s);
    // Spaced opposite each other around the pig initially.
    const initAngle = (i / CLONE_COUNT) * Math.PI * 2;
    mesh.position.set(
      h.pos.x + Math.cos(initAngle) * CLONE_ORBIT_RADIUS,
      0,
      h.pos.z + Math.sin(initAngle) * CLONE_ORBIT_RADIUS,
    );
    scene.add(mesh);
    clones.push({
      obj: mesh,
      angle: initAngle,
      converging: false,
      convergeT: 0,
      fading: false,
      fadeT: 0,
    });
  }
  return clones;
}

function _updateClones(h, dt, time) {
  if (!h.clones || h.clones.length === 0) return;
  _tickCloneList(h.clones, h.pos.x, h.pos.z, h.obj ? h.obj.rotation.y : 0, dt, time);
}

// Shared ticker — walks a clone list with a target (x,z) to orbit/converge
// around. `facingY` is only used by orbiting clones (converging clones ignore
// it, and fading clones have already arrived).
function _tickCloneList(list, tx, tz, facingY, dt, time) {
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (!c.obj) continue;

    if (c.fading) {
      // Fading out after converge — tick opacity to 0, then remove.
      c.fadeT += dt;
      const t = Math.min(1, c.fadeT / CLONE_FADE_SEC);
      const baseOp = 0.62 * (1 - t);
      if (c.obj.userData.fillMat) c.obj.userData.fillMat.opacity = baseOp;
      if (c.obj.userData.outlineMat) c.obj.userData.outlineMat.opacity = 0.9 * (1 - t);
      // Also shrink into the pig for a "fuse" feel.
      const s = (currentHerdScale * 0.75) * (1 - t * 0.6);
      c.obj.scale.setScalar(s);
      if (t >= 1) {
        if (c.obj.parent) c.obj.parent.remove(c.obj);
        if (c.obj.userData.fillMat) c.obj.userData.fillMat.dispose();
        if (c.obj.userData.outlineMat) c.obj.userData.outlineMat.dispose();
        list.splice(i, 1);
      }
      continue;
    }

    if (c.converging) {
      // Animate from current position toward the anchor target over
      // CLONE_CONVERGE_SEC. When we arrive, flip to fading.
      c.convergeT += dt;
      const t = Math.min(1, c.convergeT / CLONE_CONVERGE_SEC);
      // Ease-in: t^2 so the clones accelerate into the pig.
      const e = t * t;
      const sx = c._fromX, sz = c._fromZ;
      c.obj.position.x = sx + (tx - sx) * e;
      c.obj.position.z = sz + (tz - sz) * e;
      c.obj.position.y = (1 - e) * CLONE_BOB_AMP;
      if (t >= 1) {
        c.converging = false;
        c.fading = true;
        c.fadeT = 0;
        // Small merge burst in chapter color at the target position.
        hitBurst(new THREE.Vector3(tx, 1.2, tz), currentChapterTint, 6);
      }
      continue;
    }

    // Normal orbit — slow rotation around the target with subtle bob.
    c.angle += dt * CLONE_ORBIT_SPEED;
    const ox = Math.cos(c.angle) * CLONE_ORBIT_RADIUS;
    const oz = Math.sin(c.angle) * CLONE_ORBIT_RADIUS;
    c.obj.position.x = tx + ox;
    c.obj.position.z = tz + oz;
    c.obj.position.y = Math.sin(time * 2 + c.angle) * CLONE_BOB_AMP;
    c.obj.rotation.y = facingY;
  }
}

// Tick detached clone groups (their pig has already been saved — they're
// just playing out the converge+fade animation). When a group finishes,
// remove it from the list. Called from updateBonusWave each frame.
function _tickDecayingClones(dt, time) {
  for (let i = _decayingClones.length - 1; i >= 0; i--) {
    const g = _decayingClones[i];
    _tickCloneList(g.clones, g.targetX, g.targetZ, 0, dt, time);
    if (g.clones.length === 0) {
      _decayingClones.splice(i, 1);
    }
  }
}

// Trigger the converge-then-fade animation for every clone on a pig. Called
// from _save() right before the pig teleports to the perimeter formation.
function _triggerCloneConverge(h) {
  if (!h.clones || h.clones.length === 0) return;
  for (const c of h.clones) {
    if (c.converging || c.fading) continue;
    c.converging = true;
    c.convergeT = 0;
    c._fromX = c.obj.position.x;
    c._fromZ = c.obj.position.z;
  }
}

// Immediate teardown (no animation). Used by clearBonusWave for pigs that
// never reached the save state.
function _disposeClones(h) {
  if (!h.clones) return;
  for (const c of h.clones) {
    if (c.obj && c.obj.parent) c.obj.parent.remove(c.obj);
    if (c.obj && c.obj.userData) {
      if (c.obj.userData.fillMat) c.obj.userData.fillMat.dispose();
      if (c.obj.userData.outlineMat) c.obj.userData.outlineMat.dispose();
    }
  }
  h.clones.length = 0;
}


// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Kick off the bonus wave for the given chapter. Spawns `herdSize` meebits
 * scattered across the arena, starts the 30-second timer, and returns the
 * herd info so the caller (waves.js) can drive UI.
 *
 * Now async — awaits a one-time herd-size discovery (HEAD-probes the asset
 * folder to see how many VRMs are actually present). If the folder has
 * fewer than herdSize files, the wave CYCLES through them to keep the
 * stampede at full density.
 */
export async function startBonusWave(chapterIdx, chapterTintHex, onCaught) {
  clearBonusWave();

  active = true;
  timeLeft = BONUS_WAVE_CONFIG.duration;
  caughtCount = 0;
  currentChapterTint = chapterTintHex;
  currentChapterIdx = chapterIdx;
  _latestSaveChapter = chapterIdx;    // newest chapter's pigs will animate live
  onCaughtCallback = onCaught || null;

  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  const herdDef = chapter.bonusHerd;
  currentHerdId = herdDef.id;
  currentHerdLabel = herdDef.label;
  // Pull per-herd tuning from the chapter def — no more global herdSize.
  currentHerdSize = herdDef.size || 0;
  currentHerdScale = herdDef.scale || 1.5;
  currentShotsToSave = herdDef.shotsToSave || 6;
  currentBossTier = !!herdDef.bossTier;

  console.info(
    `[bonusWave] start — chapter ${chapterIdx}, herd: ${currentHerdId}, ` +
    `size: ${currentHerdSize}, scale: ${currentHerdScale}, shots: ${currentShotsToSave}, boss: ${currentBossTier}`
  );

  // Discover the actual VRM filenames in the herd folder. Tries manifest.json
  // first, falls back to sequential 00001.vrm probe. 3s deadline so we can't
  // hang here.
  currentFilenames = await discoverHerd(currentHerdId);
  console.info(`[bonusWave] discovered ${currentFilenames.length} VRMs for ${currentHerdId} (target size ${currentHerdSize})`);

  // Wave may have been cancelled during discovery.
  if (!active) {
    console.info('[bonusWave] cancelled during discovery');
    return { herdId: currentHerdId, label: currentHerdLabel, icon: herdDef.icon };
  }

  // Spawn exactly currentHerdSize meebits — NO cycling. The size matches
  // the number of unique VRMs in the folder. If the folder has fewer files
  // than expected (shouldn't happen), cap the spawn count accordingly.
  const size = Math.min(currentHerdSize, Math.max(currentFilenames.length, 1));
  const stagger = BONUS_WAVE_CONFIG.spawnStagger;
  for (let slotIdx = 1; slotIdx <= size; slotIdx++) {
    // One VRM per slot, no cycling. Fall back to voxel if filename missing.
    const filename = currentFilenames.length > 0
      ? currentFilenames[(slotIdx - 1) % currentFilenames.length]
      : null;
    setTimeout(() => { _spawnOneGated(slotIdx, filename); }, (slotIdx - 1) * stagger);
  }

  return { herdId: currentHerdId, label: currentHerdLabel, icon: herdDef.icon, size };
}

// ----------------------------------------------------------------------------
// Concurrency-gated spawn pool
// ----------------------------------------------------------------------------
// Each spawn does: HEAD-probe (free if cached) → fetch VRM → parse GLTF →
// scene.add() which forces a material compile. The compile is the expensive
// step; doing N of them in the same frame ruins everything. We cap how many
// spawns can be running their async path at once.

let _inFlightSpawns = 0;
const _spawnWaitQueue = [];  // FIFO of pending spawn tickets

function _acquireSpawnSlot() {
  return new Promise(resolve => {
    if (_inFlightSpawns < BONUS_WAVE_CONFIG.maxConcurrentSpawns) {
      _inFlightSpawns++;
      resolve();
    } else {
      _spawnWaitQueue.push(resolve);
    }
  });
}

function _releaseSpawnSlot() {
  if (_spawnWaitQueue.length > 0) {
    const next = _spawnWaitQueue.shift();
    next();  // keeps _inFlightSpawns the same (hands off the slot)
  } else {
    _inFlightSpawns = Math.max(0, _inFlightSpawns - 1);
  }
}

async function _spawnOneGated(slotIdx, filename) {
  if (!active) return;
  await _acquireSpawnSlot();
  if (!active) { _releaseSpawnSlot(); return; }
  try {
    await _spawnOne(slotIdx, filename);
  } catch (err) {
    console.warn('[bonusWave] spawn ticket error:', err);
  } finally {
    _releaseSpawnSlot();
  }
}

/**
 * Tick. Call once per frame with dt (sec) and the player object (needs .pos).
 * Returns:
 *   { active, timeLeft, caught, total, finished }
 * When finished === true, the caller should invoke endBonusWave() and
 * transition out.
 */
export function updateBonusWave(dt, player) {
  // If the wave was ended externally (e.g. game reset) but updateWaves is
  // still calling us because waveDef hasn't been cleared yet, report
  // `finished: true` so the caller triggers a normal endWave transition.
  if (!active) {
    return {
      active: false,
      timeLeft: 0,
      caught: caughtCount,
      total: currentHerdSize,
      finished: true,
      herdLabel: currentHerdLabel || 'HERD',
    };
  }

  timeLeft = Math.max(0, timeLeft - dt);

  const wanderSpeed = BONUS_WAVE_CONFIG.wanderSpeed;
  const wanderChange = BONUS_WAVE_CONFIG.wanderChangeSec;
  const limit = ARENA - 2;

  // --- Live herd update (unsaved pigs) ---
  for (let i = herd.length - 1; i >= 0; i--) {
    const h = herd[i];
    if (h.caught || !h.obj) continue;

    try {
      // Decrement hit-flash and panic timers regardless of state.
      if (h.hitFlashTimer > 0) {
        h.hitFlashTimer = Math.max(0, h.hitFlashTimer - dt);
      }
      if (h.panicTimer > 0) {
        h.panicTimer = Math.max(0, h.panicTimer - dt);
        if (h.panicTimer === 0) {
          // Panic wore off — back to wander.
          h.state = 'wander';
          if (h.mixer) { try { h.mixer.playWalk(); } catch (e) {} }
        }
      }

      // Laser tag mode: pigs do NOT passively flee from the player. They
      // only panic after being shot. Panic timer drives flee behavior.
      const panicking = h.state === 'panic' && h.panicTimer > 0;

      let movingSpeed;
      if (panicking) {
        // Flee directly away from the player (direction captured at shot time).
        const pdx = player.pos.x - h.pos.x;
        const pdz = player.pos.z - h.pos.z;
        const distToPlayer = Math.sqrt(pdx * pdx + pdz * pdz) || 1;
        let fx = -pdx / distToPlayer;
        let fz = -pdz / distToPlayer;

        // Edge bounce — if fleeing would hit the wall, divert to a tangent.
        const projX = h.pos.x + fx * FLEE_SPEED * dt * 2;
        const projZ = h.pos.z + fz * FLEE_SPEED * dt * 2;
        if (Math.abs(projX) > limit || Math.abs(projZ) > limit) {
          const sign = (h.slotIdx % 2 === 0) ? 1 : -1;
          const nx = -fz * sign;
          const nz =  fx * sign;
          fx = nx * FLEE_EDGE_BOUNCE + fx * (1 - FLEE_EDGE_BOUNCE);
          fz = nz * FLEE_EDGE_BOUNCE + fz * (1 - FLEE_EDGE_BOUNCE);
          const nrm = Math.sqrt(fx * fx + fz * fz) || 1;
          fx /= nrm; fz /= nrm;
        }

        h.pos.x = Math.max(-limit, Math.min(limit, h.pos.x + fx * FLEE_SPEED * dt));
        h.pos.z = Math.max(-limit, Math.min(limit, h.pos.z + fz * FLEE_SPEED * dt));

        const targetAngle = Math.atan2(fx, fz);
        let diff = targetAngle - h.obj.rotation.y;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        h.obj.rotation.y += diff * Math.min(1, dt * 8);

        movingSpeed = FLEE_SPEED;
        h.wanderTimer = 0;  // invalidate stale wander target
      } else {
        // Wander (slow roam around a drifting target)
        h.wanderTimer -= dt;
        if (h.wanderTimer <= 0) {
          h.wanderTimer = wanderChange + Math.random() * 1.5;
          const a = Math.random() * Math.PI * 2;
          const r = 3 + Math.random() * 6;
          h.wanderTarget.set(
            Math.max(-limit, Math.min(limit, h.pos.x + Math.cos(a) * r)),
            0,
            Math.max(-limit, Math.min(limit, h.pos.z + Math.sin(a) * r)),
          );
        }
        const dx = h.wanderTarget.x - h.pos.x;
        const dz = h.wanderTarget.z - h.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        if (d > 0.4) {
          h.pos.x += (dx / d) * wanderSpeed * dt;
          h.pos.z += (dz / d) * wanderSpeed * dt;
          const targetAngle = Math.atan2(dx, dz);
          let diff = targetAngle - h.obj.rotation.y;
          while (diff >  Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          h.obj.rotation.y += diff * Math.min(1, dt * 5);
        }
        movingSpeed = wanderSpeed;
      }

      // Animation tempo
      if (h.mixer) {
        h.mixer.setSpeed(Math.max(0.4, movingSpeed / 2.0));
        h.mixer.update(dt);
      } else if (h.animRefs) {
        h.walkPhase += dt * (panicking ? 14 : 9);
        const sw = Math.sin(h.walkPhase) * (panicking ? 0.7 : 0.5);
        if (h.animRefs.legL) h.animRefs.legL.rotation.x = sw;
        if (h.animRefs.legR) h.animRefs.legR.rotation.x = -sw;
        if (h.animRefs.armL) h.animRefs.armL.rotation.x = -sw * 0.6;
        if (h.animRefs.armR) h.animRefs.armR.rotation.x = sw * 0.6;
      } else if (h.obj) {
        h.walkPhase += dt * movingSpeed * 2;
        const bob = Math.sin(h.walkPhase * 2) * 0.08;
        h.obj.position.y = bob;
      }

      // Clone shield tick — orbit around the pig, or run converge/fade
      // animation if the pig was just saved. Uses `performance.now()/1000`
      // for the bob phase so clones don't pop between frames.
      _updateClones(h, dt, performance.now() * 0.001);
    } catch (err) {
      console.warn('[bonusWave] per-herd update error, skipping:', err);
      h.caught = true;
      if (h.obj && h.obj.parent) scene.remove(h.obj);
    }
  }

  // Saved pigs are updated by updateSavedPigs() in main.js every frame
  // regardless of wave type — not here. They persist across waves/chapters.

  // Tick any "detached" clone groups (their pig was saved but the clones
  // are still finishing their converge+fade animation).
  _tickDecayingClones(dt, performance.now() * 0.001);

  // --- Heal-fire tick: living meebits occasionally shoot healing pulses at player ---
  _tickHealFire(dt, player);

  const finished = timeLeft <= 0 || caughtCount >= currentHerdSize;
  return {
    active: true,
    timeLeft,
    caught: caughtCount,
    total: currentHerdSize,
    finished,
    herdLabel: currentHerdLabel,
  };
}

/**
 * End the bonus wave. Fires a celebratory burst volley, clears any remaining
 * herd meebits from the scene, and returns the final tally.
 */
export function endBonusWave() {
  if (!active) return { caught: 0, total: 0 };

  active = false;
  const final = { caught: caughtCount, total: currentHerdSize, herdLabel: currentHerdLabel };

  // Celebratory confetti across the arena (replaces the normal nuke effect).
  // Eight bursts at random positions in the chapter color — cheap and sells
  // the "you made it" moment.
  for (let i = 0; i < 8; i++) {
    setTimeout(() => {
      const a = Math.random() * Math.PI * 2;
      const r = 8 + Math.random() * 18;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      hitBurst(new THREE.Vector3(x, 3 + Math.random() * 2, z), currentChapterTint, 16);
    }, i * 90);
  }

  clearBonusWave();
  return final;
}

/**
 * Rip everything down. Called from endBonusWave (clean completion) and
 * from resetWaves (game over / restart).
 */
/**
 * Clear the current bonus wave but PRESERVE the saved-pig formation.
 * Saved pigs are persistent — they remain visible through subsequent waves
 * and chapters as a growing perimeter of "freed" Meebits. Only cleared on
 * full game restart (see clearSavedPigs below).
 */
export function clearBonusWave() {
  for (const h of herd) {
    if (h.mixer) { try { h.mixer.stop(); } catch (e) {} }
    // Clone shields — immediate teardown for any pig that's still alive.
    if (h.clones && h.clones.length > 0) {
      _disposeClones(h);
    }
    if (h.fromPool) {
      // Return to the pool: hide, park under floor, mark available.
      // Mesh stays in the scene so its PSO remains warm for re-play.
      // Pool lookup by the pig's own source chapter index.
      const pool = pigPools.get(h.poolChapter);
      if (pool) {
        const poolEntry = pool.find(e => e.obj === h.obj);
        if (poolEntry) poolEntry.inUse = false;
      }
      if (h.obj) {
        // Reset any scale we applied at spawn so the pooled mesh returns
        // to its stash state cleanly.
        h.obj.scale.set(1, 1, 1);
        h.obj.visible = false;
        h.obj.position.set(0, POOL_STASH_Y, 0);
        h.obj.matrixAutoUpdate = false;
        h.obj.updateMatrix();
      }
    } else {
      // Fallback-path mesh (not from pool): remove entirely.
      if (h.obj && h.obj.parent) scene.remove(h.obj);
    }
  }
  herd.length = 0;
  // Decaying clones (clones of already-saved pigs that were mid-animation).
  for (const g of _decayingClones) {
    for (const c of g.clones) {
      if (c.obj && c.obj.parent) c.obj.parent.remove(c.obj);
      if (c.obj && c.obj.userData) {
        if (c.obj.userData.fillMat) c.obj.userData.fillMat.dispose();
        if (c.obj.userData.outlineMat) c.obj.userData.outlineMat.dispose();
      }
    }
  }
  _decayingClones.length = 0;
  // Purge any in-flight healing projectiles — their meshes are owned here.
  for (const p of healingProjectiles) {
    if (p.mesh && p.mesh.parent) scene.remove(p.mesh);
  }
  healingProjectiles.length = 0;
  // Saved pigs deliberately NOT cleared — they persist across waves.
  active = false;
  timeLeft = 0;
  caughtCount = 0;
  currentHerdId = null;
  currentHerdLabel = null;
  currentHerdSize = 0;
  currentShotsToSave = 6;
  currentBossTier = false;
  onCaughtCallback = null;
  while (_spawnWaitQueue.length > 0) {
    const resolve = _spawnWaitQueue.shift();
    try { resolve(); } catch (e) {}
  }
  _inFlightSpawns = 0;
}

/**
 * Nuke every saved pig from the scene and reset the formation counter.
 * Called on full game reset (player died → restart). The visual trophy
 * wall of freed pigs should only accumulate within a single run.
 *
 * IMPORTANT: this does NOT clear the pig pools. Pools hold the pre-built,
 * PSO-warmed clone meshes for every chapter's bonus wave — they take ~3-6
 * seconds of shader-compile work to rebuild, which is the single biggest
 * freeze vector in the whole game. The pools are session-scoped and stay
 * valid across game-over/restart cycles: the underlying VRM cache survives,
 * the hidden meshes at y=-1000 don't interfere with the new run, and
 * bonusWave tracks in-use entries with `inUse` flags that get reset when
 * each wave ends anyway.
 *
 * Pools are only torn down when you genuinely want them gone (page reload,
 * or explicit call to clearPigPool()). The matrix dive builds them once;
 * they stick for the life of the tab.
 */
export function clearSavedPigs() {
  for (const s of savedPigs) {
    if (s.mixer) { try { s.mixer.stop(); } catch (e) {} }
    if (s.obj && s.obj.parent) scene.remove(s.obj);
  }
  savedPigs.length = 0;
  // Reset the shuffled-slot bag so the next run gets a fresh random layout.
  _slotBag = null;
  _slotBagCursor = 0;
  // NOTE: pools deliberately preserved. See doc comment above.
  // Reset inUse flags so a fresh run can pull from the pool cleanly —
  // stray "in use" markers from a previous run would otherwise leave
  // pool entries that can never be allocated.
  for (const pool of pigPools.values()) {
    for (const entry of pool) entry.inUse = false;
  }
}

/**
 * Per-frame tick for the saved-pig idle animations. Called every frame from
 * main.js regardless of wave type, so the trophy wall keeps breathing during
 * combat waves 1-5 of subsequent chapters.
 *
 * PERFORMANCE: only the most-recently-active chapter's saved pigs actually
 * get their mixers ticked. Pigs from older chapters are "frozen in pose" —
 * they stay on the perimeter looking like statues, but don't cost CPU/GPU
 * per frame. With 6 chapters × 111 pigs = 666 possible saved pigs, animating
 * them all would cost 5-10 ms/frame; freezing old ones keeps it cheap.
 */
export function updateSavedPigs(dt) {
  for (const s of savedPigs) {
    // Only animate pigs from the most recently completed bonus wave's chapter.
    if (s.mixer && s.chapterIdx === _latestSaveChapter) {
      s.mixer.update(dt);
    }
  }
}

export function isBonusWaveActive() { return active; }

/**
 * Warm the cache AND pre-compile shaders for the NEXT chapter's herd while
 * the player is on the current chapter's boss (localWave === 5). This is
 * what kills the Wave 6 spawn freeze: by the time the bonus wave starts,
 * every VRM is already fetched, parsed, and shader-compiled.
 *
 * @param {number} nextChapterIdx  — chapter whose herd to prewarm
 * @param {THREE.WebGLRenderer} [renderer]  — optional; enables shader compile
 * @param {THREE.Camera} [camera]  — optional; required alongside renderer
 */
export async function prefetchNextHerd(nextChapterIdx, renderer, camera) {
  const chapter = CHAPTERS[nextChapterIdx % CHAPTERS.length];
  if (!chapter || !chapter.bonusHerd) return;

  const herdId = chapter.bonusHerd.id;

  // Load ALL files (not just 30) so every slot in the bonus wave spawns
  // from cache with zero network I/O. A typical herd is 5-72 VRMs × ~50KB
  // = 250KB-3.6MB — well within budget for a background fetch during the
  // boss fight.
  await prefetchHerd(herdId);

  // Now pre-compile shaders. This can take ~0.5-2s of frame time on some
  // GPUs, but it's happening during the boss fight when the player is
  // shooting things, so it smears across combat instead of dumping into a
  // single Wave 6 freeze. Falls through if renderer/camera weren't supplied.
  if (renderer && camera) {
    prewarmHerd(herdId, renderer, camera);
  }
}

/**
 * PRE-CLONE THE HERD INTO A HIDDEN POOL so Wave 6 spawn has zero freeze.
 *
 * The issue: even after getHerdMeshByFilename() has cached a VRM and
 * prewarmHerd() has called renderer.compile() on its materials, the FIRST
 * time each clone is actually drawn in the live scene (with shadows,
 * directional light, fog, etc.) the driver recompiles the PSO for that
 * specific material+pipeline combination. That's 10-50 ms of frozen frame
 * per unique material × N pigs = seconds of freeze on Wave 6 start.
 *
 * Fix: create N clones during the matrix dive (or boss cinematic as a safety
 * net), add them to the live scene at y=-1000 (below the floor), render
 * them once via renderer.compile(sceneWithClones, camera), then hide them
 * with `visible = false`. This pays the PSO compile cost during a scripted
 * loading moment. When Wave 6 starts, the clones are pulled from the pool,
 * teleported up to y=0, and made visible — zero compile work, zero freeze.
 *
 * @param {number} chapterIdx    — chapter whose herd to build
 * @param {number} [countOverride] — optional override; defaults to chapter's bonusHerd.size
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Camera} camera
 * @param {(info:{chapterIdx:number,built:number,count:number})=>void} [onProgress]
 *        called after each clone is added (for the matrix-dive progress bar)
 */
// Tracks in-flight preparePigPool() calls by chapter so concurrent requests
// for the same chapter share the same Promise and don't double-build.
const _pigPoolBuildPromises = new Map();

export async function preparePigPool(chapterIdx, countOverride, renderer, camera, onProgress) {
  // If this chapter's pool is already built, no-op.
  const existing = pigPools.get(chapterIdx);
  if (existing && existing.length > 0) {
    if (onProgress) onProgress({ chapterIdx, built: existing.length, count: existing.length });
    return;
  }

  // CONCURRENT-BUILD GUARD. If another caller is already building this
  // chapter's pool, await that work instead of starting a duplicate build.
  // Without this guard, two near-simultaneous calls would both see an empty
  // pool and each kick off a 3-5 second clone+compile pass, blocking the
  // main thread twice.
  const inFlight = _pigPoolBuildPromises.get(chapterIdx);
  if (inFlight) {
    return inFlight;
  }

  const promise = _buildPigPool(chapterIdx, countOverride, renderer, camera, onProgress);
  _pigPoolBuildPromises.set(chapterIdx, promise);
  try {
    await promise;
  } finally {
    _pigPoolBuildPromises.delete(chapterIdx);
  }
}

// Internal builder — the actual work. Split out so the concurrent guard
// above can share a single Promise across callers without duplicating logic.
async function _buildPigPool(chapterIdx, countOverride, renderer, camera, onProgress) {
  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  if (!chapter || !chapter.bonusHerd) return;
  const herdId = chapter.bonusHerd.id;
  const tint = chapter.full.grid1 || 0xffffff;
  // Pool size = exact per-chapter herd count. No cycling.
  const targetCount = countOverride || chapter.bonusHerd.size || 0;
  if (targetCount <= 0) return;

  // Make sure the VRMs are fetched+cached before we try to clone them.
  await prefetchHerd(herdId);

  // Discover the available filenames (from manifest / sequential probe).
  let filenames = [];
  try {
    filenames = await discoverHerd(herdId);
  } catch (e) {
    return;
  }
  if (filenames.length === 0) return;

  // Clamp the build count to the actual number of available VRMs.
  const count = Math.min(targetCount, filenames.length);

  // Initialize this chapter's pool.
  const pool = [];
  pigPools.set(chapterIdx, pool);

  // Build the pool — one entry per unique VRM, no cycling. Each meebit in
  // Wave 6 is a distinct NFT.
  //
  // 3 clones per frame keeps the per-frame cost under the 16ms budget even
  // on mid-range GPUs. Dive is already visible so hitches are masked.
  const BATCH_PER_FRAME = 3;
  const tmpScene = new THREE.Scene();   // for the PSO-compile pass at the end

  for (let i = 0; i < count; i++) {
    const filename = filenames[i];
    let mesh;
    try {
      mesh = await getHerdMeshByFilename(herdId, filename, tint);
    } catch (e) {
      continue;
    }

    // Park under the floor, invisible. matrixAutoUpdate=false so the scene
    // graph traversal skips this subtree every frame.
    mesh.position.set(0, POOL_STASH_Y, 0);
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.traverse(o => {
      o.frustumCulled = false;
    });
    scene.add(mesh);
    tmpScene.add(mesh);    // also in temp scene for the compile pass

    pool.push({
      obj: mesh,
      herdId,
      filename,
      inUse: false,
    });

    if (onProgress) onProgress({ chapterIdx, built: pool.length, count });

    // Yield every BATCH_PER_FRAME clones so we don't stall a whole frame.
    if ((i + 1) % BATCH_PER_FRAME === 0) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }

  // PSO-warm this chapter's pool against the current camera. Compiles
  // the driver pipeline state so first-draw freeze is paid here.
  try {
    if (renderer && camera) {
      renderer.compile(tmpScene, camera);
    }
  } catch (err) {
    console.warn('[bonusWave] pool PSO-warm compile failed (non-fatal):', err);
  }

  // Re-parent clones back to the real scene.
  while (tmpScene.children.length > 0) {
    const m = tmpScene.children[0];
    tmpScene.remove(m);
    scene.add(m);
  }

  console.info(`[bonusWave] pool ready: ${pool.length} clones for chapter ${chapterIdx} (${herdId})`);
}

/**
 * Build pools for EVERY chapter in one pass — called from the matrix dive
 * after network preload finishes. Each chapter's pool is sized by its own
 * bonusHerd.size. Total clones across all chapters ≈ 246 (51+38+59+74+18+6).
 *
 * Progress callback fires after each clone is added so the dive's progress
 * bar can smoothly fill across both phases.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Camera} camera
 * @param {(info:{totalBuilt:number,totalTarget:number})=>void} [onProgress]
 */
export async function prepareAllPools(renderer, camera, onProgress) {
  // Total target = sum of per-chapter herd sizes.
  let totalTarget = 0;
  for (const ch of CHAPTERS) {
    if (ch && ch.bonusHerd) totalTarget += (ch.bonusHerd.size || 0);
  }
  let totalBuilt = 0;
  for (let ch = 0; ch < CHAPTERS.length; ch++) {
    await preparePigPool(
      ch, null, renderer, camera,
      () => {
        totalBuilt++;
        if (onProgress) onProgress({ totalBuilt, totalTarget });
      },
    );
  }
}

/**
 * Drop all pool entries that weren't consumed by a bonus wave. Called when
 * we move to a new chapter's pool or on full game reset.
 *
 * Pool entries that ARE in-use (pulled into the active herd) are left alone;
 * they're owned by the wave now and get cleaned up by clearBonusWave.
 */
export function clearPigPool() {
  for (const pool of pigPools.values()) {
    for (const entry of pool) {
      if (entry.inUse) continue;
      if (entry.obj && entry.obj.parent) scene.remove(entry.obj);
    }
  }
  pigPools.clear();
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

async function _spawnOne(slotIdx, filename) {
  if (!active) return;

  // Scatter across the arena in a ring around the center.
  const angle = Math.random() * Math.PI * 2;
  const minR = BONUS_WAVE_CONFIG.spawnRingMin;
  const maxR = BONUS_WAVE_CONFIG.spawnRingMax;
  const dist = minR + Math.random() * (maxR - minR);
  const x = Math.cos(angle) * dist;
  const z = Math.sin(angle) * dist;

  // POOL PATH — find a pool entry for this chapter that's not yet in use.
  // Pool was built upfront during the matrix dive, so this is a zero-freeze
  // operation: mesh already in scene with shaders + PSOs compiled, so
  // "spawning" is just toggling visible=true and teleporting. No GLTF parse,
  // no clone, no shader compile.
  let pooled = null;
  const pool = pigPools.get(currentChapterIdx);
  if (pool) {
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.inUse && e.herdId === currentHerdId) {
        pooled = e;
        e.inUse = true;
        break;
      }
    }
  }

  let mesh;
  let actualFilename;
  if (pooled) {
    mesh = pooled.obj;
    actualFilename = pooled.filename;
    // Un-hide, re-enable matrix updates (it's about to move every frame).
    mesh.visible = true;
    mesh.matrixAutoUpdate = true;
  } else {
    // FALLBACK PATH — pool wasn't built (first Chapter 1 play, or pool
    // exhausted). Do it the slow way: getHerdMeshByFilename + safeClone.
    // This path still works; it's just the freeze-prone one the pool exists
    // to avoid.
    if (!filename) {
      mesh = getHerdVoxelFallback(currentChapterTint);
      actualFilename = '__voxel__';
    } else {
      try {
        mesh = await getHerdMeshByFilename(currentHerdId, filename, currentChapterTint);
        actualFilename = filename;
      } catch (err) {
        console.warn('[bonusWave] unexpected load error for', currentHerdId, filename, err);
        mesh = getHerdVoxelFallback(currentChapterTint);
        actualFilename = '__voxel__';
      }
    }

    // Wave may have ended while we awaited.
    if (!active) {
      if (mesh && mesh.traverse) {
        mesh.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
            else o.material.dispose();
          }
        });
      }
      return;
    }

    scene.add(mesh);
  }

  mesh.position.set(x, 0, z);
  // Apply per-herd mesh scale (normal herds 1.5×; dissected super-bosses 2.5×).
  // Applied on every spawn so pooled meshes also get the correct size — and
  // clearBonusWave() resets scale back to 1 when returning to the pool.
  mesh.scale.set(currentHerdScale, currentHerdScale, currentHerdScale);

  // Per-herd heal-fire cadence
  const hf = BONUS_WAVE_CONFIG.healFire;
  const fireMin = currentBossTier ? hf.fireIntervalMinBoss : hf.fireIntervalMin;
  const fireMax = currentBossTier ? hf.fireIntervalMaxBoss : hf.fireIntervalMax;

  const h = {
    obj: mesh,
    pos: mesh.position,
    slotIdx,
    filename: actualFilename,
    herdId: currentHerdId,
    caught: false,
    state: 'wander',           // 'wander' | 'panic' — drives flee behavior
    fromPool: !!pooled,        // tag so clearBonusWave knows how to dispose
    poolChapter: pooled ? currentChapterIdx : -1,   // which chapter's pool owns this mesh
    // --- Laser tag ---
    hp: currentShotsToSave,    // per-herd shots-to-save (6 normal, 15 dissected)
    hpMax: currentShotsToSave, // cached so UI can show % tagged if we ever want that
    hitFlashTimer: 0,
    panicTimer: 0,
    // --- Heal-fire ---
    // Stagger initial cooldowns so all meebits don't fire simultaneously on t=0.
    healFireCooldown: fireMin + Math.random() * (fireMax - fireMin),
    // --- Wander state ---
    wanderTarget: new THREE.Vector3(x, 0, z),
    wanderTimer: Math.random() * BONUS_WAVE_CONFIG.wanderChangeSec,
    walkPhase: Math.random() * Math.PI * 2,
    mixer: null,
    animRefs: null,
  };

  if (mesh.userData && mesh.userData.isFallback && mesh.userData.animRefs) {
    h.animRefs = mesh.userData.animRefs;
  } else if (animationsReady()) {
    try {
      h.mixer = attachMixer(mesh);
      h.mixer.playWalk();
    } catch (err) {
      h.mixer = null;
    }
  }

  // Spawn 2 chapter-tinted clone shields that orbit the pig. Damage-immune
  // (damageHerdAt never touches them); they converge into the pig and fade
  // on save (_save calls _triggerCloneConverge then _disposeClones-later).
  h.clones = _spawnClonesFor(h, currentChapterTint);

  herd.push(h);
}

/**
 * Build (or rebuild) the shuffled slot bag. The bag contains every possible
 * formation slot index in the first 3 rows (~500 total slots). Fisher-Yates
 * shuffle so the next-slot pick is uniformly random and guaranteed to
 * distribute across all 4 sides instead of clustering.
 */
function _buildSlotBag() {
  const sideHalf = SAVE_SIDE_HALF;
  const sideLen = sideHalf * 2;
  const slotsPerSide = Math.max(1, Math.floor(sideLen / SAVE_SPACING));
  const slotsPerRow = slotsPerSide * 4;
  const totalSlots = slotsPerRow * 3;   // 3 rows deep — plenty for 666 saves

  const bag = new Array(totalSlots);
  for (let i = 0; i < totalSlots; i++) bag[i] = i;

  // Fisher-Yates shuffle.
  for (let i = totalSlots - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }

  return bag;
}

/**
 * Pull the next slot from the shuffled bag. Lazily initializes and refills
 * if exhausted (pathological case — would need 1500+ saves in one run).
 */
function _nextSlot() {
  if (_slotBag === null || _slotBagCursor >= _slotBag.length) {
    _slotBag = _buildSlotBag();
    _slotBagCursor = 0;
  }
  return _slotBag[_slotBagCursor++];
}

/**
 * Compute the world position + inward-facing rotation for a saved pig, given
 * its slot index in the perimeter square. Slots are distributed:
 *   - North (top) side: slots 0..N-1, left-to-right at z = +radius
 *   - East side: slots N..2N-1, front-to-back at x = +radius
 *   - South side: slots 2N..3N-1, right-to-left at z = -radius
 *   - West side: slots 3N..4N-1, back-to-front at x = -radius
 * When we run out of slots in row 1, we wrap to row 2 (one deeper outward).
 */
function _placeInSquare(slotIdx) {
  const sideHalf = SAVE_SIDE_HALF;
  const sideLen = sideHalf * 2;
  // How many pigs fit along one side of a row
  const slotsPerSide = Math.max(1, Math.floor(sideLen / SAVE_SPACING));
  const slotsPerRow = slotsPerSide * 4;

  const row = Math.floor(slotIdx / slotsPerRow);
  const withinRow = slotIdx % slotsPerRow;
  const side = Math.floor(withinRow / slotsPerSide);   // 0..3
  const alongSlot = withinRow % slotsPerSide;          // 0..slotsPerSide-1

  // Position along the side: spread evenly from -sideHalf to +sideHalf.
  const alongPos = -sideHalf + (alongSlot + 0.5) * (sideLen / slotsPerSide);
  // Perpendicular distance from arena edge — rows step outward.
  const perpDist = ARENA + SAVE_RING_OFFSET + row * SAVE_ROW_STEP;

  let x, z, facingY;
  switch (side) {
    case 0:  // North side: z = +perp, pigs face -z (toward center)
      x = alongPos;  z =  perpDist;  facingY = Math.PI;   break;
    case 1:  // East side: x = +perp, pigs face -x
      x =  perpDist; z = alongPos;   facingY = -Math.PI / 2; break;
    case 2:  // South side: z = -perp, pigs face +z
      x = alongPos;  z = -perpDist;  facingY = 0;         break;
    case 3:  // West side: x = -perp, pigs face +x
    default:
      x = -perpDist; z = alongPos;   facingY = Math.PI / 2; break;
  }
  return { x, z, facingY };
}

/**
 * Called from main.js when a bullet/rocket/beam touches any point in the arena.
 * Walks the herd, damages any pig within `radius` of (x, z), and returns true
 * if at least one was hit (so the caller can consume the bullet).
 *
 * Each hit:
 *   - decrements pig hp by 1
 *   - applies a hit flash
 *   - triggers panic flee for PANIC_FLEE_DURATION seconds
 *   - at hp=0, calls _save() to move the pig to the perimeter ring
 */
export function damageHerdAt(x, z, radius) {
  if (!active) return false;
  const r2 = radius * radius;
  let anyHit = false;
  for (let i = herd.length - 1; i >= 0; i--) {
    const h = herd[i];
    if (h.caught || !h.obj) continue;
    const dx = h.pos.x - x;
    const dz = h.pos.z - z;
    if (dx * dx + dz * dz >= r2) continue;

    // HIT!
    anyHit = true;
    h.hp = Math.max(0, h.hp - 1);
    h.hitFlashTimer = HIT_FLASH_DURATION;
    h.panicTimer = PANIC_FLEE_DURATION;

    // Switch to run animation on first grazed shot (if not already).
    if (h.state !== 'panic') {
      h.state = 'panic';
      if (h.mixer) { try { h.mixer.playRun(); } catch (e) {} }
    }

    // Small hit burst so the player can see they hit.
    hitBurst(new THREE.Vector3(h.pos.x, 1.5, h.pos.z), 0xff6a1a, 4);

    if (h.hp <= 0) {
      _save(h, i);
    }
  }
  return anyHit;
}

/**
 * Save a pig — teleport it to the next available ring slot at the arena
 * perimeter, rotate to face inward (toward center), swap to a random idle
 * animation, and park it there for the rest of the wave.
 */
function _save(h, idx) {
  h.caught = true;
  caughtCount++;

  // Remove from live herd; it now lives in savedPigs for the rest of the run.
  herd.splice(idx, 1);

  // CLONE SHIELDS — trigger converge animation using the pig's CURRENT
  // position as the anchor, then hand the clones off to the decaying list
  // so they finish animating even after the pig teleports to its formation
  // slot below. "The clones and pig disappear after being saved" — the fade
  // of the clones is the visual confirmation of the save.
  if (h.clones && h.clones.length > 0) {
    const anchorX = h.pos.x;
    const anchorZ = h.pos.z;
    _triggerCloneConverge(h);
    _decayingClones.push({
      clones: h.clones,
      targetX: anchorX,
      targetZ: anchorZ,
    });
    h.clones = [];
  }

  // If this was a pool-owned mesh, remove its pool entry. It's now a saved
  // pig and no longer belongs to the pool (won't be recycled on replay).
  if (h.fromPool) {
    const pool = pigPools.get(h.poolChapter);
    if (pool) {
      const poolIdx = pool.findIndex(e => e.obj === h.obj);
      if (poolIdx >= 0) pool.splice(poolIdx, 1);
    }
  }

  // Pick a random free slot from the pre-shuffled bag.
  const slot = _nextSlot();
  const placement = _placeInSquare(slot);

  // Small position jitter so the square doesn't look mechanically perfect —
  // ±0.25u along the line, ±0.15u in depth. Preserves the grid feel while
  // adding life.
  const jitterAlong = (Math.random() - 0.5) * 0.5;
  const jitterDepth = (Math.random() - 0.5) * 0.3;
  const isNSside = Math.abs(placement.z) > Math.abs(placement.x);
  const finalX = placement.x + (isNSside ? jitterAlong : jitterDepth);
  const finalZ = placement.z + (isNSside ? jitterDepth : jitterAlong);

  // Celebratory burst at the ORIGINAL position before teleporting.
  hitBurst(new THREE.Vector3(h.pos.x, 2, h.pos.z), CATCH_BURST_COLOR, 10);
  try { if (Audio && Audio.bonusCatch) Audio.bonusCatch(); } catch (e) {}

  // Teleport to the formation slot.
  h.pos.set(finalX, 0, finalZ);
  h.obj.rotation.y = placement.facingY;

  // Switch to a random idle animation (variants 2/3/4 from your Standing Idle GLBs).
  if (h.mixer) {
    const variant = 2 + Math.floor(Math.random() * 3);
    try { h.mixer.playIdle(variant); } catch (e) {}
    h.mixer.setSpeed(1.0);
  } else if (h.animRefs) {
    if (h.animRefs.legL) h.animRefs.legL.rotation.x = 0;
    if (h.animRefs.legR) h.animRefs.legR.rotation.x = 0;
    if (h.animRefs.armL) h.animRefs.armL.rotation.x = 0;
    if (h.animRefs.armR) h.animRefs.armR.rotation.x = 0;
  }

  // Move into the persistent savedPigs pool. These survive across wave
  // transitions within a run — only cleared on full game reset.
  const saved = {
    obj: h.obj,
    pos: h.pos,
    mixer: h.mixer,
    slotIdx: h.slotIdx,
    formationSlot: slot,
    filename: h.filename,
    herdId: h.herdId,
    chapterIdx: currentChapterIdx,   // which chapter saved this pig (for anim freeze policy)
  };
  savedPigs.push(saved);

  // Notify waves.js.
  if (onCaughtCallback) {
    onCaughtCallback({
      herdId: h.herdId,
      filename: h.filename,
      slotIdx: h.slotIdx,
      herdLabel: currentHerdLabel,
    });
  }
}

// ============================================================================
// FRIENDLY HEAL-FIRE
//
// Living (un-saved) meebits occasionally fire a soft glowing pulse toward the
// player. These pulses do NO damage — they HEAL on impact. This inverts the
// usual combat dynamic: getting close and taking hits is a reward, not a
// punishment. Dissected super-bosses fire stronger pink pulses more often.
//
// Flow:
//   _tickHealFire(dt, player) — called from updateBonusWave every frame.
//     For each living meebit:
//       - decrement cooldown
//       - if cooldown hit 0 and meebit isn't panicking and player is in range,
//         spawn a heal projectile pointed at the player, then re-roll cooldown.
//   getHealingProjectiles() — returns the live array (main.js ticks positions
//     and handles player collision). Mutating the array (e.g. splice on hit)
//     is fine — main.js is the owner of projectile lifecycles.
//   consumeHealingProjectile(p) — convenience: remove + dispose a projectile.
//   clearHealingProjectiles() — hard reset (called from clearBonusWave).
// ============================================================================

// Shared geometry for heal pulses — a small low-poly sphere. Cheap to instance
// and looks like a soft orb, which matches the "healing" feel better than a
// cube or beam. Cached module-wide so all projectiles share the same geometry.
let _HEAL_GEO = null;
function _getHealGeo() {
  if (!_HEAL_GEO) _HEAL_GEO = new THREE.SphereGeometry(1, 10, 8);
  return _HEAL_GEO;
}

// Spawn a heal-pulse mesh from (fromX,fromZ) aimed at the player's current pos.
function _spawnHealProjectile(fromX, fromZ, player) {
  const hf = BONUS_WAVE_CONFIG.healFire;
  const color = currentBossTier ? hf.projectileColorBoss : hf.projectileColor;
  const heal  = currentBossTier ? hf.healPerHitBoss     : hf.healPerHit;
  const size  = hf.projectileSize;

  // Emissive material so the orb glows even in dark chapters (INFERNO, PARADISE).
  // Reusing a new material per projectile is cheap compared to the VRM compile
  // cost, and letting each be independently tinted keeps the color system simple.
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
  });
  const mesh = new THREE.Mesh(_getHealGeo(), mat);
  mesh.scale.set(size, size, size);
  // Fire from ~chest height so the pulses arc across the arena at a readable height.
  mesh.position.set(fromX, 1.4, fromZ);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // Velocity vector toward the player's position (XZ plane only).
  const dx = player.pos.x - fromX;
  const dz = player.pos.z - fromZ;
  const dist = Math.sqrt(dx * dx + dz * dz) || 1;
  const speed = hf.projectileSpeed;

  healingProjectiles.push({
    mesh,
    vx: (dx / dist) * speed,
    vz: (dz / dist) * speed,
    life: hf.projectileLife,
    heal,
    color,
  });
}

// Per-frame heal-fire tick. Called from updateBonusWave.
// IMPORTANT: this only walks the LIVING herd (saved meebits don't shoot).
// It does NOT tick the projectile positions themselves — main.js does that
// every frame so projectile/player collision lines up with the shooting loop.
function _tickHealFire(dt, player) {
  const hf = BONUS_WAVE_CONFIG.healFire;
  if (!hf || !hf.enabled) return;
  if (!player || !player.pos) return;

  const maxDist2 = hf.maxFireDistance * hf.maxFireDistance;
  const fireMin = currentBossTier ? hf.fireIntervalMinBoss : hf.fireIntervalMin;
  const fireMax = currentBossTier ? hf.fireIntervalMaxBoss : hf.fireIntervalMax;

  for (let i = 0; i < herd.length; i++) {
    const h = herd[i];
    if (h.caught || !h.obj) continue;
    // Panicking meebits are busy fleeing — they don't fire this cycle.
    if (h.state === 'panic') continue;

    h.healFireCooldown -= dt;
    if (h.healFireCooldown > 0) continue;

    // Range gate: too far from player → just reset cooldown (short) and skip.
    // Avoids off-screen meebits firing at a player they can't plausibly see.
    const dx = player.pos.x - h.pos.x;
    const dz = player.pos.z - h.pos.z;
    if (dx * dx + dz * dz > maxDist2) {
      h.healFireCooldown = 0.5 + Math.random() * 0.5; // try again soon
      continue;
    }

    // Fire!
    _spawnHealProjectile(h.pos.x, h.pos.z, player);
    // Re-roll cooldown for next shot.
    h.healFireCooldown = fireMin + Math.random() * (fireMax - fireMin);
  }
}

/**
 * Returns the live array of in-flight heal projectiles. main.js ticks these
 * every frame and checks player collision. Each entry is:
 *   { mesh, vx, vz, life, heal, color }
 * where `life` is remaining seconds before auto-despawn. main.js should
 * decrement life and call consumeHealingProjectile(entry) on player hit or
 * life-out.
 */
export function getHealingProjectiles() {
  return healingProjectiles;
}

/**
 * Remove and dispose a single heal projectile. Safe to call from main.js
 * while iterating the array — pass the entry object directly. Returns true
 * if the entry was found and removed.
 */
export function consumeHealingProjectile(entry) {
  const idx = healingProjectiles.indexOf(entry);
  if (idx < 0) return false;
  if (entry.mesh) {
    if (entry.mesh.parent) scene.remove(entry.mesh);
    if (entry.mesh.material) entry.mesh.material.dispose();
  }
  healingProjectiles.splice(idx, 1);
  return true;
}

/**
 * Nuke every in-flight heal projectile. Called from clearBonusWave on wave
 * end / game reset. Also called by main.js defensively if it ever wants to
 * clear the field (e.g. pause menu, unusual transitions).
 */
export function clearHealingProjectiles() {
  for (const p of healingProjectiles) {
    if (p.mesh) {
      if (p.mesh.parent) scene.remove(p.mesh);
      if (p.mesh.material) p.mesh.material.dispose();
    }
  }
  healingProjectiles.length = 0;
}

/**
 * PREWARM the heal-projectile shader.
 *
 * Heal projectiles use a MeshBasicMaterial + SphereGeometry pair that the GPU
 * has never seen until the first meebit fires in wave 6. On Ch.1 first play,
 * this causes a brief shader-compile stutter the very first time a pulse
 * leaves a meebit's gun.
 *
 * Fix: call this once during the general prewarmShaders() pass (prewarm.js).
 * Spawns one green pulse + one pink pulse offscreen, lets renderer.compile()
 * bake their shader programs, then removes them. After this runs, heal-fire
 * in wave 6 is freeze-free.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Camera} camera
 */
export function prewarmHealProjectiles(renderer, camera) {
  const hf = BONUS_WAVE_CONFIG.healFire;
  if (!hf) return;
  const tmp = new THREE.Scene();
  const probes = [];

  // Two variants — normal (green) and boss-tier (pink) — because they're
  // different color uniforms, which in some three.js builds produces distinct
  // compiled programs.
  const variants = [hf.projectileColor, hf.projectileColorBoss];
  for (const color of variants) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95,
    });
    const mesh = new THREE.Mesh(_getHealGeo(), mat);
    mesh.position.set(0, -900, 0);  // far below the floor, invisible
    mesh.scale.set(hf.projectileSize, hf.projectileSize, hf.projectileSize);
    tmp.add(mesh);
    probes.push({ mesh, mat });
  }

  try {
    if (renderer && renderer.compile && camera) {
      renderer.compile(tmp, camera);
    }
  } catch (err) {
    console.warn('[bonusWave] heal-projectile prewarm failed (non-fatal):', err);
  }

  // Clean up — the shader is compiled and cached on the driver side, so we
  // don't need these meshes to stick around.
  for (const p of probes) {
    tmp.remove(p.mesh);
    p.mat.dispose();
  }
}
