// BONUS WAVE — "THE STAMPEDE"
//
// Triggered as wave 6 of every chapter, right after the boss falls.
// 111 themed Meebits pour into the arena. The player has 30 seconds to
// walk near as many as possible (proximity auto-collect). No enemies.
// No damage. Pure victory lap.
//
// Per-chapter herd (defined in config.CHAPTERS[i].bonusHerd):
//   Ch.1 INFERNO   → PIGS
//   Ch.2 CRIMSON   → ELEPHANTS
//   Ch.3 SOLAR     → SKELETONS
//   Ch.4 TOXIC     → ROBOTS
//   Ch.5 ARCTIC    → VISITORS
//   Ch.6 PARADISE  → DISSECTED
//
// Flow:
//   startBonusWave(chapterIdx)  — loads herd, spawns 111 over ~1.6s, starts 30s timer
//   updateBonusWave(dt, player) — timer tick, proximity checks, wander movement
//   endBonusWave()              — celebrates, clears herd, returns { caught, total }
//   isBonusWaveActive()         — bool

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA, BONUS_WAVE_CONFIG, CHAPTERS } from './config.js';
import {
  discoverHerd,
  getHerdMeshByFilename,
  getHerdVoxelFallback,
  prefetchHerd,
} from './herdVrmLoader.js';
import { hitBurst } from './effects.js';
import { attachMixer, animationsReady } from './animation.js';

// -- Module state --
const herd = [];
let active = false;
let timeLeft = 0;
let caughtCount = 0;
let currentHerdId = null;
let currentHerdLabel = null;
let currentChapterTint = 0xffffff;
let currentFilenames = [];      // filenames discovered for the current herd
let onCaughtCallback = null;

// Confetti for the end-of-wave celebration (spawned purely for visuals).
// Kept as simple particle bursts so we don't lug in a new particle system.
const CATCH_BURST_COLOR = 0xffd93d;

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
  onCaughtCallback = onCaught || null;

  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  const herdDef = chapter.bonusHerd;
  currentHerdId = herdDef.id;
  currentHerdLabel = herdDef.label;

  console.info(`[bonusWave] start — chapter ${chapterIdx}, herd: ${currentHerdId}`);

  // Discover the actual VRM filenames in the herd folder. Tries manifest.json
  // first, falls back to sequential 00001.vrm probe. 3s deadline so we can't
  // hang here.
  currentFilenames = await discoverHerd(currentHerdId);
  console.info(`[bonusWave] discovered ${currentFilenames.length} VRMs; will cycle to fill ${BONUS_WAVE_CONFIG.herdSize}`);

  // Wave may have been cancelled during discovery.
  if (!active) {
    console.info('[bonusWave] cancelled during discovery');
    return { herdId: currentHerdId, label: currentHerdLabel, icon: herdDef.icon };
  }

  // Spawn herdSize meebits. CRITICAL: stagger + concurrency gate, otherwise
  // 111 simultaneous material compiles freeze the browser.
  const size = BONUS_WAVE_CONFIG.herdSize;
  const stagger = BONUS_WAVE_CONFIG.spawnStagger;
  for (let slotIdx = 1; slotIdx <= size; slotIdx++) {
    // Pick the filename to use for this slot. Cycle through available files
    // if the herd has fewer VRMs than slots. If zero files available,
    // filename is null → voxel fallback path.
    const filename = currentFilenames.length > 0
      ? currentFilenames[(slotIdx - 1) % currentFilenames.length]
      : null;
    setTimeout(() => { _spawnOneGated(slotIdx, filename); }, (slotIdx - 1) * stagger);
  }

  return { herdId: currentHerdId, label: currentHerdLabel, icon: herdDef.icon };
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
      total: BONUS_WAVE_CONFIG.herdSize,
      finished: true,
      herdLabel: currentHerdLabel || 'HERD',
    };
  }

  timeLeft = Math.max(0, timeLeft - dt);

  const catchR2 = BONUS_WAVE_CONFIG.catchRadius * BONUS_WAVE_CONFIG.catchRadius;
  const wanderSpeed = BONUS_WAVE_CONFIG.wanderSpeed;
  const wanderChange = BONUS_WAVE_CONFIG.wanderChangeSec;
  const limit = ARENA - 2;

  for (let i = herd.length - 1; i >= 0; i--) {
    const h = herd[i];
    if (h.caught || !h.obj) continue;

    try {
      // Proximity auto-collect: walk near → caught.
      const pdx = player.pos.x - h.pos.x;
      const pdz = player.pos.z - h.pos.z;
      if (pdx * pdx + pdz * pdz < catchR2) {
        _catch(h, i);
        continue;
      }

      // Wander movement so the arena feels alive (not a static sticker-book).
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
        // Smooth-rotate toward wander target
        const targetAngle = Math.atan2(dx, dz);
        let diff = targetAngle - h.obj.rotation.y;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        h.obj.rotation.y += diff * Math.min(1, dt * 5);
      }

      // Animation — real mixer if VRM bones matched, procedural bob fallback.
      if (h.mixer) {
        h.mixer.setSpeed(Math.max(0.4, wanderSpeed / 2.0));
        h.mixer.update(dt);
      } else if (h.animRefs) {
        // Voxel fallback walk cycle
        h.walkPhase += dt * 9;
        const sw = Math.sin(h.walkPhase) * 0.5;
        if (h.animRefs.legL) h.animRefs.legL.rotation.x = sw;
        if (h.animRefs.legR) h.animRefs.legR.rotation.x = -sw;
        if (h.animRefs.armL) h.animRefs.armL.rotation.x = -sw * 0.6;
        if (h.animRefs.armR) h.animRefs.armR.rotation.x = sw * 0.6;
      } else if (h.obj) {
        // Real VRM with no mixer yet — small procedural bob so it doesn't read as frozen.
        h.walkPhase += dt * wanderSpeed * 2;
        const bob = Math.sin(h.walkPhase * 2) * 0.08;
        h.obj.position.y = bob;
      }
    } catch (err) {
      // Rare — malformed mesh or a mixer in a bad state. Mark the meebit as
      // caught so we don't keep tripping on it. One dead slot is invisible;
      // a killed render loop is not.
      console.warn('[bonusWave] per-herd update error, skipping:', err);
      h.caught = true;
      if (h.obj && h.obj.parent) scene.remove(h.obj);
    }
  }

  const finished = timeLeft <= 0 || caughtCount >= BONUS_WAVE_CONFIG.herdSize;
  return {
    active: true,
    timeLeft,
    caught: caughtCount,
    total: BONUS_WAVE_CONFIG.herdSize,
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
  const final = { caught: caughtCount, total: BONUS_WAVE_CONFIG.herdSize, herdLabel: currentHerdLabel };

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
export function clearBonusWave() {
  for (const h of herd) {
    if (h.mixer) { try { h.mixer.stop(); } catch (e) {} }
    if (h.obj && h.obj.parent) scene.remove(h.obj);
  }
  herd.length = 0;
  active = false;
  timeLeft = 0;
  caughtCount = 0;
  currentHerdId = null;
  currentHerdLabel = null;
  onCaughtCallback = null;
  // Drain the spawn gate — any queued spawns will resolve and immediately
  // bail on the !active check. Reset counters so the next wave starts clean.
  while (_spawnWaitQueue.length > 0) {
    const resolve = _spawnWaitQueue.shift();
    try { resolve(); } catch (e) {}
  }
  _inFlightSpawns = 0;
}

export function isBonusWaveActive() { return active; }

/**
 * Optional: warm the cache for the NEXT chapter's herd while the player
 * is still on the current chapter's boss. Non-blocking, errors suppressed.
 * Call this from waves.js when localWave === 5 starts.
 */
export function prefetchNextHerd(nextChapterIdx) {
  const chapter = CHAPTERS[nextChapterIdx % CHAPTERS.length];
  if (!chapter || !chapter.bonusHerd) return;
  // Prefetch a sample (first 30 of the herd). Loading all 111 eagerly would
  // over-commit the network; 30 is enough to guarantee some visible herd
  // meebits render instantly when the wave starts — the remaining 81 stream
  // in while the player is already catching the first batch.
  const sample = [];
  for (let i = 1; i <= 30; i++) sample.push(i);
  prefetchHerd(chapter.bonusHerd.id, sample);
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

  // No placeholder needed — we either build a voxel fallback synchronously
  // (zero files available) or await the VRM load and add it when ready.
  // Previously we used a placeholder Group but the async swap introduced a
  // stale-`h.pos` race where the update loop could write to the orphaned
  // placeholder after the mesh was swapped in. Simpler and safer to just
  // wait for the final mesh before registering it in the herd[] array.

  let mesh;
  if (!filename) {
    // Discovery found zero VRMs — go straight to voxel fallback, no network.
    mesh = getHerdVoxelFallback(currentChapterTint);
  } else {
    try {
      // getHerdMeshByFilename already returns a voxel fallback on its own
      // error path, so this try/catch is belt-and-suspenders.
      mesh = await getHerdMeshByFilename(currentHerdId, filename, currentChapterTint);
    } catch (err) {
      console.warn('[bonusWave] unexpected load error for', currentHerdId, filename, err);
      mesh = getHerdVoxelFallback(currentChapterTint);
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

  mesh.position.set(x, 0, z);
  scene.add(mesh);

  const h = {
    obj: mesh,
    pos: mesh.position,
    slotIdx,
    filename: filename || '__voxel__',
    herdId: currentHerdId,
    caught: false,
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

  herd.push(h);
}

function _catch(h, idx) {
  h.caught = true;
  caughtCount++;

  hitBurst(new THREE.Vector3(h.pos.x, 2, h.pos.z), CATCH_BURST_COLOR, 10);

  if (h.mixer) { try { h.mixer.stop(); } catch (e) {} }
  if (h.obj && h.obj.parent) scene.remove(h.obj);
  herd.splice(idx, 1);

  // Notify waves.js so it can tick HUD / score / save collection.
  // IMPORTANT: tag by filename (the actual VRM file), not slotIdx. Two
  // different slots that cycled to the same filename dedupe to one unique
  // collection entry — keeps the 20K counter honest.
  if (onCaughtCallback) {
    onCaughtCallback({
      herdId: h.herdId,
      filename: h.filename,     // unique-per-file — used for collection tag
      slotIdx: h.slotIdx,       // telemetry only
      herdLabel: currentHerdLabel,
    });
  }
}
