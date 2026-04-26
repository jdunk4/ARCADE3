import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// ----------------------------------------------------------------------------
// CONSOLE FILTER
// ----------------------------------------------------------------------------
// Three.js fires "THREE.PropertyBinding: No target node found for track: X"
// every time an animation mixer tries to bind a track to a bone that
// doesn't exist on the current skeleton. Our animation retargeting emits
// tracks for BOTH the VRM naming (HipsBone/NeckBone/etc.) and the Unreal
// naming (pelvis/neck_01/etc.) on a single clip, so whichever naming
// isn't used by the current rig generates a stream of these warnings.
//
// That behavior is by design — the mixer silently skips unmatched tracks,
// which is exactly what we want for a dual-rig retargeter. The warnings
// are pure noise. We wrap console.warn once at module load and drop the
// ones matching that specific message prefix. All other warnings still
// fire normally.
//
// The original console.warn is preserved behind window.__origWarn in case
// you ever need to see the filtered messages during deep debugging.
(() => {
  if (typeof console === 'undefined' || !console.warn) return;
  const origWarn = console.warn.bind(console);
  if (typeof window !== 'undefined') window.__origWarn = origWarn;
  console.warn = function filteredWarn(...args) {
    const first = args[0];
    if (typeof first === 'string' && first.indexOf('THREE.PropertyBinding: No target node found for track') === 0) {
      return;   // expected dual-rig retargeting noise
    }
    return origWarn(...args);
  };
})();

import { scene, camera, renderer, CAMERA_OFFSET, applyTheme, Scene, enterChapter7Atmosphere, exitChapter7Atmosphere, updateFlashlight } from './scene.js';
import { updateLifedrainBeams, applyLifedrainTick, fireLifedrainSwarm, updateLifedrainProjectiles, clearLifedrainEffects } from './lifedrainer.js';
import { scatterCorpses, clearCorpses } from './corpses.js';
import { S, keys, mouse, joyState, resetGame, getWeapon, shake } from './state.js';
import { PLAYER, WEAPONS, CHAPTERS, ARENA, GOO_CONFIG, MINING_CONFIG, BLOCK_CONFIG, getChapterRangedMult, getChapterRangedRangeMult, PARADISE_FALLEN_CHAPTER_IDX, WAVES_PER_CHAPTER } from './config.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { loadPlayer, animatePlayer, player, recolorGun, resetPlayer, swapAvatarGLB } from './player.js';
import { enemies, enemyProjectiles, spawnEnemyProjectile, makeEnemy, updateVesselZeroAnim } from './enemies.js';
import {
  bullets, spawnBullet, clearBullets,
  rockets, spawnRocket, clearRockets,
  pickups, makePickup, clearPickups,
  hitBurst, updateParticles, clearParticles,
  initRain, updateRain, setRainTint, disposeRain, applyRainTo,
  gooSplats, spawnGooSplat, updateGooSplats, clearGooSplats,
  bossCubes, clearBossCubes,
} from './effects.js';
import { startWave, updateWaves, onEnemyKilled, resetWaves, isInCaptureZone, onBlockMined, getWaveDef_current, prewarmBossCinematic, isBossCinematicActive } from './waves.js';
import {
  damageHerdAt, updateSavedPigs, prepareAllPools,
  getHealingProjectiles, consumeHealingProjectile,
} from './bonusWave.js';
import { preloadAllHerds } from './herdVrmLoader.js';
import { blocks, updateBlocks, segmentBlocked, resolveCollision, findNearestBlock, damageBlock, damageBlockAt, clearAllBlocks, registerBlockExplosionHandler } from './blocks.js';
import { clearAllEggs } from './eggs.js';
import { updateCannon, clearCannon } from './cannon.js';
import { updateQueenHive, clearQueenHive, tickQueenShieldCollision, tryHitQueenShield } from './queenHive.js';
import { updateCrusher, clearCrusher } from './crusher.js';
import { updateChargeCubes, clearChargeCubes } from './chargeCubes.js';
import { clearEscortTruck, getTruckPos } from './escortTruck.js';
import { updateServerWarehouse, clearServerWarehouse } from './serverWarehouse.js';
import { updateSafetyPod, clearSafetyPod } from './safetyPod.js';
import { updateCockroach, clearCockroachBoss } from './cockroachBoss.js';
import { initFogRing, updateFogRing, clearFogRing } from './fogRing.js';
import { spawners, damageSpawner, updateSpawners } from './spawners.js';
import { getShieldedHiveAt, shieldHitVisual, hiveShieldsIter } from './dormantProps.js';
import { Save } from './save.js';
import { Wallet } from './wallet.js';
import {
  redirectToAuth, handleAuthCallback, getStoredAuth, clearStoredAuth,
  fetchOwnedMeebits, pickMeebitIdFromList,
} from './meebitsApi.js';
import {
  civilians, updateCivilians, clearAllCivilians, damageCivilianAt,
  setCivilianSpawnSuppressed,
} from './civilians.js';
import { preloadAnimations, attachMixer } from './animation.js';
import * as PauseMenu from './pauseMenu.js';
import { prewarmShaders } from './prewarm.js';
import {
  spawnHazardsForWave, clearHazards, hurtPlayerIfOnHazard,
  repelEnemyFromHazards, updateHazards, setHazardSpawningEnabled,
  setHazardStyle,
} from './hazards.js';
import * as tetrisStyle from './hazardsTetris.js';
import * as galagaStyle from './hazardsGalaga.js';
import * as minesweeperStyle from './hazardsMinesweeper.js';
import * as pacmanStyle from './hazardsPacman.js';
import * as pongStyle from './hazardsPong.js';
import * as donkeyKongStyle from './hazardsDonkeyKong.js';
import { spawnGalagaShip, despawnGalagaShip, updateGalagaShip, isGalagaShipActive, flyAwayGalagaShip } from './galagaShip.js';
import { spawnPacman, despawnPacman, updatePacman, isPacmanActive, runAwayPacman } from './pacmanCharacter.js';
import { spawnPellets, despawnPellets, updatePellets } from './pacmanPellets.js';
import { buildCrowd, updateCrowd, recolorCrowd } from './crowd.js';
import { prefetchMeebits, pickRandomMeebitId } from './meebitsPublicApi.js';
import {
  spawnPickup, updatePickups as updateNewPickups, clearAllPickups,
  rollPotionDrop, rollGrenadeDrop, tryUsePotion,
} from './pickups.js';
import { updateObjectiveArrows, clearObjectiveArrows } from './objectiveArrows.js';
import { updateTurrets, registerTurretKillHandler } from './turrets.js';
import {
  updatePixlPals, clearAllPixlPals, trySummonPixlPal,
  registerPixlPalKillHandler, onWaveStarted as onWaveStartedForPals,
  initPixlPalHUD, preloadPixlPalGLBs,
} from './pixlPals.js';
import {
  updateFlingers, clearAllFlingers,
  registerFlingerKillHandler, onWaveStartedForFlingers,
  initFlingerHUD, preloadFlingerGLBs,
} from './flingers.js';
import {
  updateInfectors, clearInfectors, triggerSuperNuke, isInfector,
} from './infector.js';
import {
  initPowerups, maybeShowChapterReward, updatePowerups,
  chainLightningOnKill, clearAllPowerups, registerPowerupKillHandler,
  getEnemySpeedMult,
} from './powerups.js';
import { updateCompound, resolveCompoundCollision, segmentBlockedByProp, registerDepotGetter } from './waveProps.js';
// Wire the depot live-binding into waveProps via a getter (avoids
// a circular import by deferring the read to call time). Once
// registered, resolveCompoundCollision + segmentBlockedByProp will
// include the depot circle in their checks.
import * as _oresMod from './ores.js';
registerDepotGetter(() => _oresMod.depot);
import { updateWires } from './empWires.js';
import { updateLaunch } from './empLaunch.js';
import { updateShockwaves } from './shockwave.js';
import { updateMissileArrow, hideMissileArrow } from './missileArrow.js';
import { initGamepad, updateGamepad, setTitleMode, rumble } from './gamepad.js';

// ---- HAZARD STYLE PER CHAPTER ----
// Maps chapter index → hazard style module. Called at wave start
// (after the hyperdrive prelude ends) to pick the right arcade-themed
// arena boundary system for this chapter:
//   0: Tetris       — blocks drop outside-in
//   1: Galaga       — bugs swoop in, tag tiles red; friendly ship clone
//                     auto-fires at bugs to slow the fill rate
//   2: Minesweeper  — telescoping pointers descend, reveal cells; bomb
//                     cells get a flagged LETHAL tile (instant kill),
//                     safe cells become regular damage tiles with digits
//   3: Pac-Man      — 4 ghosts (pink/red/cyan/orange) patrol corner
//                     quadrants spiraling inward, leaving green hazard
//                     tiles. Ghost-touch is INSTANT KILL.
//   4-6: Not yet implemented — falls back to Tetris as safe default
function _pickHazardStyleForChapter(chapterIdx) {
  if (chapterIdx === 1) return galagaStyle;
  if (chapterIdx === 2) return minesweeperStyle;
  if (chapterIdx === 3) return pacmanStyle;
  if (chapterIdx === 4) return pongStyle;       // ARCTIC — pong/ice tiles
  if (chapterIdx === 5) return donkeyKongStyle; // PARADISE — DK barrels + fires
  return tetrisStyle;
}

// Spawn or despawn the chapter-specific ALLY (currently only Galaga
// has one). Called whenever style is applied — keeps the ally in sync
// with the chapter even after retries / chapter resets.
function _applyChapterAlly(chapterIdx, playerPos) {
  if (chapterIdx === 1) {
    // Galaga ship — spawn at player position if not already spawned.
    if (!isGalagaShipActive()) {
      const px = (playerPos && playerPos.x) || 0;
      const pz = (playerPos && playerPos.z) || 0;
      spawnGalagaShip(px, pz);
    }
  } else {
    // Any other chapter: tear down the Galaga ship if it was up.
    if (isGalagaShipActive()) {
      despawnGalagaShip();
    }
  }
  // Pac-Man character — spawn on chapter 4 (zero-indexed = 3), despawn
  // elsewhere. Idempotent: spawnPacman is a no-op if already active,
  // so calling this every wave-start in chapter 4 doesn't re-summon him.
  if (chapterIdx === 3) {
    if (!isPacmanActive()) {
      // Pass the player's position so pacman does the cinematic intro
      // — appears above the player and dives, instead of dropping in
      // a random corner the player might never visit.
      spawnPacman(playerPos);
    }
    // Power pellets — also chapter-4 only. spawnPellets is idempotent.
    spawnPellets();
  } else {
    if (isPacmanActive()) {
      despawnPacman();
    }
    despawnPellets();
  }
}

// ---- ATTACH RENDERER ----
document.getElementById('game').appendChild(renderer.domElement);

// ---- MATRIX RAIN (title screen only) ----
function buildMatrixBG(el) {
  if (!el) return;
  const chars = '\uff71\uff72\uff73\uff74\uff75\uff76\uff77\uff78\uff79\uff7a\uff7b\uff7c\uff7d\uff7e\uff7f\uff80\uff81\uff82\uff83\uff8401MEEBIT';
  const colCount = Math.floor(window.innerWidth / 16);
  for (let i = 0; i < colCount; i++) {
    const col = document.createElement('div');
    col.className = 'matrix-col';
    col.style.left = (i * 16) + 'px';
    col.style.animationDuration = (3 + Math.random() * 6) + 's';
    col.style.animationDelay = (-Math.random() * 5) + 's';
    let text = '';
    for (let j = 0; j < 30 + Math.random() * 20; j++) {
      text += chars[Math.floor(Math.random() * chars.length)] + '\n';
    }
    col.textContent = text;
    el.appendChild(col);
  }
}
buildMatrixBG(document.getElementById('matrix-bg-load'));
buildMatrixBG(document.getElementById('matrix-bg-title'));
buildMatrixBG(document.getElementById('matrix-bg-gameover'));

// ---- BEAM WEAPON VISUAL ----
// Persistent line segment that represents the raygun beam while firing.
const beamMat = new THREE.MeshBasicMaterial({
  color: 0x00ff66, transparent: true, opacity: 0.85,
});
let beamMesh = null;
function ensureBeamMesh() {
  if (beamMesh) return;
  // Thin rectangular prism we scale/position along the beam ray
  const geo = new THREE.BoxGeometry(0.25, 0.25, 1);
  beamMesh = new THREE.Mesh(geo, beamMat);
  beamMesh.visible = false;
  scene.add(beamMesh);
}

// ============================================================================
// FLAMETHROWER STREAM MESHES
// ----------------------------------------------------------------------------
// A persistent 3-layer flame visual, visible while the weapon is held.
//  - outerCone: wide, orange, low opacity — outer plume
//  - innerCone: narrow, yellow-white, high opacity — hot core
//  - muzzleJet: bright ball at the nozzle
// All three are scaled/positioned each frame in updateFlame() so the cone
// opens along the player's facing direction up to weapon.flameRange.
// A procedural ember emitter adds floating sparks on top. The result reads
// as a proper sustained flame stream rather than the old per-tick bursts.
// ============================================================================
let flameOuter = null;
let flameInner = null;
let flameMuzzle = null;
let flameOuterMat = null;
let flameInnerMat = null;
let flameMuzzleMat = null;
const flameEmbers = []; // { mesh, vel, life, maxLife }
function ensureFlameMeshes() {
  if (flameOuter) return;
  // SINGLE-CONE FLAME.
  // v8: FLIPPED ORIENTATION — now reads like a real flamethrower. Wide
  // base at the muzzle, narrowing to a point at the far end. This is the
  // physically-correct direction: flame billows out of the gun and the
  // stream thins with distance as fuel disperses.
  //
  // Previously (v7) the cone was tip-at-muzzle, base-at-target, which
  // looked like a funnel — visually backwards. The new orientation is
  // both more accurate AND reads better in gameplay because the wide
  // part is RIGHT at the player, so the weapon feels punchy up close.
  //
  // ConeGeometry(radius, height, radialSegments, heightSegments, openEnded).
  // Default cone: tip at +Y, base at -Y. We translate so the BASE is at
  // origin and the tip extends along +Y, then rotate so tip points at +Z.
  // At runtime we scale Z by length, X/Y by BASE radius (the wide muzzle
  // end).
  const flameGeo = new THREE.ConeGeometry(1, 1, 14, 1, true);
  flameGeo.translate(0, 0.5, 0);                // base at origin, tip at +Y
  flameGeo.rotateX(Math.PI / 2);                // base at origin, tip at +Z
  flameOuterMat = new THREE.MeshBasicMaterial({
    color: 0xff6622, transparent: true, opacity: 0.75,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  flameOuter = new THREE.Mesh(flameGeo, flameOuterMat);
  flameOuter.visible = false;
  scene.add(flameOuter);

  // Keep flameInner references defined-but-null so the rest of the
  // codebase (updateFlame, damage ticks) can test for them without
  // crashing. They're no longer rendered.
  flameInner = null;
  flameInnerMat = null;

  const muzzleGeo = new THREE.SphereGeometry(0.35, 8, 8);
  flameMuzzleMat = new THREE.MeshBasicMaterial({
    color: 0xffffdd, transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  flameMuzzle = new THREE.Mesh(muzzleGeo, flameMuzzleMat);
  flameMuzzle.visible = false;
  scene.add(flameMuzzle);
}

// Called every frame regardless of weapon. When not firing / not holding
// flamethrower, all three meshes stay invisible.
function updateFlame(dt) {
  if (!flameOuter) return;
  const w = WEAPONS[S.currentWeapon];
  const firing =
    !isBossCinematicActive() &&
    (mouse.down || ('ontouchstart' in window && mouse.down)) &&
    w && w.isFlame && player.ready;
  if (!firing) {
    flameOuter.visible = false;
    flameMuzzle.visible = false;
    // Let embers keep finishing their arc after stream stops
  } else {
    flameOuter.visible = true;
    flameMuzzle.visible = true;

    const dirX = Math.sin(player.facing);
    const dirZ = Math.cos(player.facing);
    const origin = new THREE.Vector3(player.pos.x, 1.25, player.pos.z);

    // Length flickers slightly per frame for lick motion
    const flicker = 0.88 + Math.random() * 0.24;
    const length = w.flameRange * flicker;
    // Base (muzzle-end) radius. Since the cone tapers to a point at the
    // far tip, the muzzle reads WIDE and the far reach is a narrow jet.
    // Slightly tighter than the old far-end flare because a wide muzzle
    // blob is already very legible.
    const baseRadius = w.flameRange * Math.tan(w.flameAngle) * 0.75;

    // Position: base at the muzzle, tip extending forward along facing.
    flameOuter.position.copy(origin);
    flameOuter.scale.set(baseRadius, baseRadius, length);
    // lookAt rotates so local +Z points toward the target. Our cone was
    // built with base at origin and tip at +Z (see ensureFlameMeshes), so
    // lookAt alone correctly orients it.
    flameOuter.lookAt(origin.x + dirX, 1.25, origin.z + dirZ);

    // Muzzle ball pulses brighter
    flameMuzzle.position.set(
      origin.x + dirX * 0.7,
      1.25,
      origin.z + dirZ * 0.7,
    );
    const muzzlePulse = 0.8 + Math.random() * 0.5;
    flameMuzzle.scale.setScalar(muzzlePulse);
    flameMuzzleMat.opacity = 0.8 + Math.random() * 0.2;

    // Opacity flicker on the single cone
    flameOuterMat.opacity = 0.65 + Math.random() * 0.22;

    // Spawn a couple of embers per frame that drift upward while the
    // stream is live. Cheap — small cap to prevent particle blowout.
    if (flameEmbers.length < 40 && Math.random() < 0.7) {
      const ember = new THREE.Mesh(
        new THREE.SphereGeometry(0.08 + Math.random() * 0.08, 5, 4),
        new THREE.MeshBasicMaterial({
          color: Math.random() < 0.5 ? 0xffaa22 : 0xff5522,
          transparent: true, opacity: 0.95,
          depthWrite: false, blending: THREE.AdditiveBlending,
        })
      );
      // Seed inside the cone at a random depth
      const t = 0.25 + Math.random() * 0.65;
      const spreadAng = (Math.random() - 0.5) * w.flameAngle * 0.9;
      const ca = Math.cos(spreadAng);
      const sa = Math.sin(spreadAng);
      const fX = dirX * ca - dirZ * sa;
      const fZ = dirX * sa + dirZ * ca;
      ember.position.set(
        origin.x + fX * length * t,
        origin.y + (Math.random() - 0.5) * 0.6,
        origin.z + fZ * length * t,
      );
      // Drift forward, upward, and a little outward
      const spreadVel = 0.4 + Math.random() * 0.6;
      ember.userData.vel = new THREE.Vector3(
        fX * (4 + Math.random() * 2) + (Math.random() - 0.5) * spreadVel,
        1.8 + Math.random() * 1.4,
        fZ * (4 + Math.random() * 2) + (Math.random() - 0.5) * spreadVel,
      );
      ember.userData.life = 0.45 + Math.random() * 0.35;
      ember.userData.maxLife = ember.userData.life;
      scene.add(ember);
      flameEmbers.push(ember);
    }
  }

  // Always advance embers so they finish their arc even after release
  for (let i = flameEmbers.length - 1; i >= 0; i--) {
    const em = flameEmbers[i];
    em.userData.life -= dt;
    em.position.addScaledVector(em.userData.vel, dt);
    // Tiny gravity
    em.userData.vel.y -= 0.9 * dt;
    const t = Math.max(0, em.userData.life / em.userData.maxLife);
    em.material.opacity = 0.9 * t;
    em.scale.setScalar(0.5 + t * 0.6);
    if (em.userData.life <= 0) {
      scene.remove(em);
      if (em.material) em.material.dispose();
      if (em.geometry) em.geometry.dispose();
      flameEmbers.splice(i, 1);
    }
  }
}

// ---- AUTH / SAVE INIT (unchanged from original project) ----
const authCallback = handleAuthCallback();
const saved = Save.load();
S.username = saved.username;
S.playerMeebitId = saved.playerMeebitId;
S.playerMeebitSource = saved.playerMeebitSource;
S.walletAddress = saved.walletAddress;
S.rescuedIds = [...(saved.rescuedIds || [])];

// Kick off Mixamo animation preload immediately. ~120KB total across walk+run,
// so they'll be ready by the time the player clicks through the matrix dive.
// Fire-and-forget: failures fall back to the procedural bob in civilians.js.
preloadAnimations();

// ---- STARTUP FLOW: Initiate Protocol -> Matrix Dive -> Title ----
// After the avatar loads, we show an "Initiate Protocol" screen with a
// single button. The button click (a) unlocks the browser audio context,
// (b) starts the music, and (c) triggers the matrix-dive transition.
// After 8 seconds of matrix rain diving at the camera, the title screen
// appears. No phone call -- the matrix dive IS the entry experience.
function showIncomingCall() {
  // Build the Initiate Protocol overlay
  const initOverlay = document.createElement('div');
  initOverlay.id = 'initiate-protocol';
  initOverlay.innerHTML = `
    <style>
      #initiate-protocol {
        position: fixed; inset: 0;
        background: radial-gradient(ellipse at center, #001a0d 0%, #000 70%);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        z-index: 9998;
        font-family: 'Impact', 'Arial Black', sans-serif;
        color: #00ff66;
      }
      #initiate-protocol .ip-title {
        font-size: clamp(48px, 10vw, 120px);
        letter-spacing: 8px;
        text-shadow: 0 0 20px #00ff66, 0 0 40px rgba(0,255,102,0.5);
        animation: ip-pulse 2s ease-in-out infinite;
        margin-bottom: 16px;
      }
      #initiate-protocol .ip-sub {
        font-size: 14px;
        letter-spacing: 8px;
        color: #6effaa;
        margin-bottom: 60px;
        opacity: 0.8;
      }
      #initiate-protocol .ip-btn {
        font-family: inherit;
        font-size: 24px;
        letter-spacing: 6px;
        padding: 20px 60px;
        background: transparent;
        color: #00ff66;
        border: 2px solid #00ff66;
        cursor: pointer;
        box-shadow: 0 0 20px rgba(0,255,102,0.4);
        transition: all 0.2s;
      }
      #initiate-protocol .ip-btn:hover {
        background: #00ff66;
        color: #000;
        box-shadow: 0 0 40px rgba(0,255,102,0.8);
        transform: scale(1.05);
      }
      @keyframes ip-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }
    </style>
    <div class="ip-title">INITIATE</div>
    <div class="ip-title">PROTOCOL</div>
    <div class="ip-sub">:: AWAITING USER INPUT ::</div>
    <button class="ip-btn" id="ip-begin">&gt;&gt; BEGIN &lt;&lt;</button>
  `;
  document.body.appendChild(initOverlay);

  const beginBtn = document.getElementById('ip-begin');
  beginBtn.addEventListener('click', () => {
    // Critical: this click is the user gesture that unlocks audio for the session
    Audio.init();
    Audio.resume();

    // Play the phone ring as the soundtrack for the matrix dive
    Audio.startPhoneRing();
    // Layer the C-drone underneath the ring so the dive has some bass body
    Audio.startCDrone();

    // Transition into the matrix dive
    initOverlay.remove();

    // Fire-and-forget prefetch of civilian public-API meebits (used for in-arena
    // captured civilians, separate from the bonus-wave herd system).
    const prefetchIds = [];
    const pickedSet = new Set();
    for (let i = 0; i < 12; i++) {
      const id = pickRandomMeebitId(pickedSet);
      pickedSet.add(id);
      prefetchIds.push(id);
    }
    prefetchMeebits(prefetchIds);

    // PRELOAD ALL HERD VRMs (pigs, elephants, skeletons, robots, visitors,
    // dissected) during the dive. The dive doubles as our loading screen —
    // it renders until load hits 100%, then reveals ATTACK THE AI over the
    // still-running matrix rain.
    //
    // Two phases, merged into one progress counter:
    //   Phase 1: network load (all VRMs across 6 herds — sizes: pigs 51,
    //            elephants 38, skeletons 59, robots 74, visitors 18, dissected 6 ≈ 246)
    //   Phase 2: pool build  (sum of per-chapter herd sizes — NO cycling,
    //            one pool entry per unique VRM ≈ 246 hidden PSO-warmed meshes)
    // Total progress target = phase1 total + phase2 total. The progress bar
    // fills smoothly across both so the player sees steady movement.
    //
    // IMPORTANT: the actual count of pool clones built can be LESS than the
    // config'd size (e.g. dissected folder has 5 VRMs but size:6). So after
    // phase 2 finishes we rebase `progressState.total` to what was actually
    // delivered; without this, the bar can stick at 97-98%.
    const ALL_HERDS = ['pigs', 'elephants', 'skeletons', 'robots', 'visitors', 'dissected'];
    // Initial seed for phase 2 — sum of per-chapter bonusHerd.size. This is
    // the OPTIMISTIC target so the bar doesn't jump forward when phase 2 starts.
    // We rebase to the real number once phase 2 finishes (see below).
    const PHASE2_TARGET_SEED = CHAPTERS.reduce(
      (s, c) => s + (c && c.bonusHerd ? (c.bonusHerd.size || 0) : 0),
      0,
    );
    let phase2Target = PHASE2_TARGET_SEED;
    const progressState = { loaded: 0, total: phase2Target };
    let phase1Total = 0;
    let phase1Loaded = 0;
    let phase2Loaded = 0;
    // Phase 0: follower GLBs (pixl pals + flingers). Small total (~16 files)
    // but each file is chunky (2-7 MB). Prefetching these during the dive
    // means first-spawn of a pal/flinger mid-combat is zero-network-jank.
    //
    // Seeded upfront with an OPTIMISTIC count (10 pals + 6 flingers = 16,
    // matching the hardcoded fallback lists in pixlPals.js and flingers.js)
    // so the progress bar's denominator stays stable. Real counts come
    // back from the manifests during preload and replace these. If a
    // manifest declares more or fewer files, the rebase at the end of
    // the async block snaps the total to the actual built count.
    const PHASE0_TARGET_SEED = 16;
    let phase0Total = PHASE0_TARGET_SEED;
    let phase0Loaded = 0;

    (async () => {
      // --- Phase 0: follower GLBs + mesh pools ---
      // Pals + flingers preload using the same pattern as the herd
      // system: manifest discovery, parallel fetch, hidden mesh pool
      // at y=-1000, renderer.compile() to warm shader cache. First
      // summon becomes a zero-jank visibility toggle.
      //
      // This used to run as fire-and-forget Promise.all that did NOT
      // block the matrix dive. Result: the player could click ATTACK
      // THE AI before pal/flinger pools were warm, and the first
      // summon would fall through to the slow on-demand path with
      // visible jank ("[PixlPal] pool miss — falling back to on-demand
      // load" warning in console).
      //
      // Now Phase 0 runs IN PARALLEL with Phase 1 (so we don't
      // serialize the network) but is properly awaited via the
      // shared Promise.all below, so the title screen is gated
      // behind ALL three preloads completing.
      // Track ACTUAL phase 0 totals as the helpers report them. Until
      // both helpers finish, we keep using the SEED value as the
      // denominator (so the bar denominator is stable). Once both are
      // done, we replace the seed with the sum of actuals.
      let phase0PalsActual = null;     // null = not yet reported
      let phase0FlingersActual = null;

      const phase0Promise = Promise.all([
        preloadPixlPalGLBs(info => {
          // Per-file progress not surfaced — bar resolution is
          // dominated by herd counts. We snapshot totals once each
          // helper finishes (below).
        }, renderer, camera).then(res => {
          phase0PalsActual = res.total;
          phase0Loaded = (phase0PalsActual || 0) + (phase0FlingersActual || 0);
          // If both helpers have now reported, swap seed → actuals.
          if (phase0PalsActual !== null && phase0FlingersActual !== null) {
            phase0Total = phase0PalsActual + phase0FlingersActual;
          }
          progressState.total = phase2Target + phase1Total + phase0Total;
          progressState.loaded = phase1Loaded + phase2Loaded + phase0Loaded;
        }),
        preloadFlingerGLBs(info => {}, renderer, camera).then(res => {
          phase0FlingersActual = res.total;
          phase0Loaded = (phase0PalsActual || 0) + (phase0FlingersActual || 0);
          if (phase0PalsActual !== null && phase0FlingersActual !== null) {
            phase0Total = phase0PalsActual + phase0FlingersActual;
          }
          progressState.total = phase2Target + phase1Total + phase0Total;
          progressState.loaded = phase1Loaded + phase2Loaded + phase0Loaded;
        }),
      ]).catch(err => {
        // Pool errors are non-fatal — gameplay paths fall back to
        // on-demand loading with the original jank, but the player
        // can still play.
        console.warn('[preload] phase 0 (follower pools) error (non-fatal):', err);
      });

      // --- Phase 1: fetch all VRMs (in parallel with Phase 0) ---
      const phase1Promise = (async () => {
        try {
          await preloadAllHerds(
            ALL_HERDS,
            info => {
              phase1Total = info.total;
              phase1Loaded = info.loaded;
              progressState.total = phase2Target + phase1Total + phase0Total;
              progressState.loaded = phase1Loaded + phase2Loaded + phase0Loaded;
            },
            renderer,
            camera,
          );
        } catch (err) {
          console.warn('[preload] phase 1 (VRM fetch) error (non-fatal):', err);
        }
      })();

      // Wait for BOTH phase 0 and phase 1 before starting phase 2.
      // Phase 2 (pool build for chapters) needs the herd VRM data
      // from phase 1, but it doesn't conflict with the pal/flinger
      // pools from phase 0. We could in principle start phase 2
      // before phase 0 completes, but blocking on both keeps the
      // progress reporting straightforward and ensures the bar's
      // 100% truly means "every preload pool is warm."
      await Promise.all([phase0Promise, phase1Promise]);

      // --- Phase 2: build pools for all 6 chapters ---
      // After this finishes, every chapter's Wave 6 herd is pre-cloned,
      // hidden at y=-1000, scene-attached, and PSO-warmed. Wave 6 spawn
      // is a zero-freeze teleport operation. Each chapter's pool size
      // comes from its own bonusHerd.size (no cycling, no global count).
      try {
        await prepareAllPools(
          renderer, camera,
          info => {
            phase2Loaded = info.totalBuilt;
            progressState.loaded = phase1Loaded + phase2Loaded + phase0Loaded;
          },
        );
      } catch (err) {
        console.warn('[preload] phase 2 (pool build) error (non-fatal):', err);
      }

      // --- Rebase so the counter can actually reach 100%. ---
      // If a herd folder has fewer VRMs than its config'd size (e.g. dissected
      // has 5 on disk but size:6), the built count is less than the seeded
      // target. Snap the total DOWN to what actually got delivered so
      // loaded/total == 1.0 and the dive fires onReady.
      phase2Target = phase2Loaded;
      progressState.total = phase1Total + phase2Target + phase0Total;
      progressState.loaded = phase1Loaded + phase2Loaded + phase0Loaded;
    })();

    const diveCtrl = runMatrixDive(
      () => progressState,
      () => {
        // 100% loaded: reveal title buttons over the still-running matrix rain.
        // The C-drone keeps playing (ambient bed). Phone ring stops.
        Audio.stopPhoneRing();
        const titleEl = document.getElementById('title');
        titleEl.classList.remove('hidden');
        // Style adjustments so the title sits cleanly over the matrix dive
        // instead of looking like an unrelated overlay. Give it a translucent
        // black scrim so the rain is visible but text stays readable.
        titleEl.style.zIndex = '9998';
        titleEl.style.background = 'radial-gradient(ellipse at center, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.35) 100%)';
        // Fade in smoothly.
        titleEl.style.opacity = '0';
        titleEl.style.transition = 'opacity 0.6s ease-in';
        requestAnimationFrame(() => { titleEl.style.opacity = '1'; });

        // Enable gamepad title-screen navigation. We explicitly leave the
        // wallet-connect button OUT of the focus list — wallet linking
        // requires a browser extension popup (MetaMask) that can't be
        // operated with a controller, so the button stays visible for
        // mouse users but isn't reachable via stick/d-pad. The player
        // presses A or Start on the highlighted ATTACK AI button to begin.
        const attackBtn = document.getElementById('start-btn');
        const focusable = [attackBtn].filter(Boolean);
        setTitleMode(true, focusable);
      },
    );

    // When the player finally clicks ATTACK THE AI, tear down the dive.
    // We do this once the start-btn fires so the fade coincides with the
    // transition into gameplay (below in startGame).
    document.getElementById('start-btn').addEventListener('click', () => {
      diveCtrl.teardown();
    }, { once: true });
  }, { once: true });
}

/**
 * Immersive matrix-code dive. For `durationMs` we render a fullscreen
 * canvas of falling green glyphs that accelerates toward the camera,
 * simulating flying through the matrix. Calls `onDone` when finished.
 */
/**
 * Immersive matrix-code dive that doubles as a loading screen.
 *
 * Runs until `progressSource()` reports 1.0 (100% loaded), then reveals the
 * title screen UI OVER the still-running matrix rain. The dive stays on
 * screen permanently after that; clicking ATTACK THE AI is what ends it.
 *
 * Visual layers (bottom to top):
 *   1. Canvas with 3D matrix rain (accelerates with load progress)
 *   2. SVG border frame: neon-green rectangle tracing the viewport perimeter
 *      that fills clockwise from the top-left corner as progress climbs
 *   3. "LOADING N / TOTAL" text centered below the ATTACK THE AI area
 *   4. Title screen HTML (hidden until loaded=true)
 *
 * @param {() => {loaded:number,total:number,ratio:number}} progressSource
 *        Called every frame; returns current progress.
 * @param {() => void} onReady  Called once progress first hits 1.0 (for
 *        things like stopping the phone ring + fading out bass). The dive
 *        keeps rendering after this — only the button click ends it.
 */
function runMatrixDive(progressSource, onReady) {
  const overlay = document.createElement('div');
  overlay.id = 'matrix-dive';
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: #000;
    z-index: 9997;
    overflow: hidden;
  `;

  // --- Layer 1: matrix rain canvas ---
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%; height:100%; display:block; position:absolute; inset:0;';
  overlay.appendChild(canvas);

  // --- Layer 2: STATIC SVG border frame ---
  // A solid neon-green rectangle tracing the viewport perimeter. This is NOT
  // a progress bar — it's always fully drawn and stays until teardown. The
  // user's actual progress is communicated through the % readout below.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = `
    position:absolute; inset:0; pointer-events:none; z-index:2;
    filter: drop-shadow(0 0 14px #00ff66) drop-shadow(0 0 28px #00ff66);
  `;
  const INSET = 8;                    // inset from the edge (in viewBox units)
  const borderRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  borderRect.setAttribute('x', INSET);
  borderRect.setAttribute('y', INSET);
  borderRect.setAttribute('width', 1000 - INSET * 2);
  borderRect.setAttribute('height', 1000 - INSET * 2);
  borderRect.setAttribute('fill', 'none');
  borderRect.setAttribute('stroke', '#00ff66');
  borderRect.setAttribute('stroke-width', '3');
  borderRect.setAttribute('vector-effect', 'non-scaling-stroke');
  borderRect.setAttribute('stroke-linejoin', 'miter');
  // Full solid stroke — no dashing. Static frame stays full until teardown.
  svg.appendChild(borderRect);
  // Inner accent rect for depth
  const innerRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  innerRect.setAttribute('x', INSET + 6);
  innerRect.setAttribute('y', INSET + 6);
  innerRect.setAttribute('width', 1000 - (INSET + 6) * 2);
  innerRect.setAttribute('height', 1000 - (INSET + 6) * 2);
  innerRect.setAttribute('fill', 'none');
  innerRect.setAttribute('stroke', '#00ff66');
  innerRect.setAttribute('stroke-width', '1');
  innerRect.setAttribute('stroke-opacity', '0.35');
  innerRect.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(innerRect);
  overlay.appendChild(svg);

  // --- Layer 3: big percentage readout ---
  // Clean "XX%" number only. The internal N/TOTAL counts are our business;
  // the user just sees the number climb 0 → 100.
  const pctText = document.createElement('div');
  pctText.style.cssText = `
    position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    color:#00ff66; font-family:monospace; font-weight:bold;
    font-size: clamp(56px, 10vw, 120px);
    letter-spacing:4px;
    text-shadow: 0 0 14px #00ff66, 0 0 28px #00ff66, 0 0 44px rgba(0,255,102,0.6);
    z-index:3; pointer-events:none;
    opacity: 0.95;
  `;
  pctText.textContent = '0%';
  overlay.appendChild(pctText);

  // Subtitle below the big %. Switches to "READY · ATTACK THE AI" at 100%.
  const subText = document.createElement('div');
  subText.style.cssText = `
    position:absolute; left:50%; top:62%; transform:translate(-50%,-50%);
    color:#00ff66; font-family:monospace;
    font-size: clamp(12px, 1.4vw, 16px);
    letter-spacing:5px;
    text-shadow: 0 0 8px #00ff66;
    z-index:3; pointer-events:none;
    opacity: 0.8;
  `;
  subText.textContent = 'INITIATING PROTOCOL';
  overlay.appendChild(subText);

  // --- Layer 4: rotating fun-facts panel ---
  // These cycle every ~4 seconds. Mix of palindrome jokes, binary humor,
  // Autoglyphs / CryptoPunks nods, tattoo / number jokes, bit-by-bit riffs,
  // and general Meebit culture. Shuffled per-session so repeat plays feel fresh.
  const FUN_FACTS = [
    // "Bit by bit" riffs
    '> BIT BY BIT, THE SIMULATION ASSEMBLES',
    '> EVERY MEEBIT IS EXACTLY ONE BIT AWAY FROM ANOTHER',
    '> BIT BY BIT · BYTE BY BYTE · MEEB BY MEEB',
    // "Be there or be square"
    '> BE THERE OR BE SQUARE · MEEBITS ARE BOTH',
    '> MEEBITS ARE SQUARE. VOLUNTARILY.',
    '> 100% VOXEL · 0% ROUND',
    // 0 & 1 jokes
    '> THERE ARE 10 KINDS OF MEEBITS: THOSE WHO READ BINARY AND THOSE WHO DO NOT',
    '> ZEROS AND ONES? WE PREFER OFFS AND ONS',
    '> IN BASE 2, EVERY NUMBER IS A VIBE',
    '> 0 + 1 = EVERYTHING',
    // Palindrome jokes
    '> 11011 · 10001 · 10101 · A PALINDROMIC PARADE',
    '> WAS IT A BIT I SAW?',
    '> RACECAR DRIVES THE SAME WAY IN EITHER DIRECTION · COINCIDENCE? YES',
    // Tattoo / number lore
    '> EVERY MEEBIT HAS A NUMBER · SOME HAVE TATTOOS · A FEW HAVE BOTH',
    '> NUMBER 16801 SENDS HIS REGARDS',
    '> THE LOWER THE NUMBER, THE OLDER THE SOUL',
    '> TATTOOS ARE RECEIPTS FROM EARLIER SIMULATIONS',
    // Autoglyphs
    '> AUTOGLYPHS GENERATED THEMSELVES · MEEBITS GENERATED ATTITUDE',
    '> 512 AUTOGLYPHS · 20000 MEEBITS · SAME CHAIN, DIFFERENT VIBE',
    '> THE FIRST ON-CHAIN ART WAS JUST ASCII HAVING A MOMENT',
    // CryptoPunks
    '> CRYPTOPUNKS IN 2D · MEEBITS IN 3D · PROGRESS, TECHNICALLY',
    '> ONE PUNK, ONE MEEBIT, ONE DREAM',
    '> PUNKS TAUGHT US PIXELS · MEEBITS TAUGHT US VOXELS',
    // Meebit culture
    '> 20,000 MEEBITS · 20,000 STORIES · ALL CUBES',
    '> IF YOU CAN COUNT THE POLYGONS, YOU ARE TOO CLOSE',
    '> VOXELS ARE THE OFFICIAL UNIT OF MEEBIT CURRENCY',
    '> REALITY HAS TOO MANY TRIANGLES',
    // Computer virus jokes
    '> A MEEBIT WALKS INTO A BAR · THE BAR CATCHES A TROJAN',
    '> WHY DID THE VIRUS GO TO THERAPY? TOO MANY UNRESOLVED EXCEPTIONS',
    '> MY ANTIVIRUS ASKED ME OUT · I SAID NO STRINGS ATTACHED',
    '> NEVER TRUST AN ATOM · THEY MAKE UP EVERYTHING · ESPECIALLY MALWARE',
    '> THE FIRST COMPUTER VIRUS WAS WRITTEN IN 1971 · IT JUST SAID "I AM THE CREEPER"',
    '> A WORM WALKS INTO A NETWORK · LEAVES WITH FRIENDS',
    '> BACKUPS ARE LIKE SEATBELTS · YOU REGRET NOT HAVING ONE AT EXACTLY THE WRONG MOMENT',
    '> THE ONLY SECURE COMPUTER IS UNPLUGGED, ENCASED IN CONCRETE, AT THE BOTTOM OF THE OCEAN · PROBABLY',
    '> CTRL + ALT + DELETE IS JUST A PRAYER WITH EXTRA STEPS',
    '> IF IT SMELLS LIKE PHISHING, IT IS PHISHING',
    // AI jokes / facts
    '> THE AI LEARNED EVERYTHING FROM THE INTERNET · THAT EXPLAINS A LOT',
    '> HUMANS WROTE THE TRAINING DATA · THE AI JUST MEMORIZED YOUR TYPOS',
    '> WHY DID THE NEURAL NET CROSS THE ROAD? TO MINIMIZE LOSS',
    '> I TOLD THE AI A JOKE · IT RETURNED A CONFIDENCE SCORE OF 0.47',
    '> A MODEL WITH ENOUGH PARAMETERS CAN FIT ANYTHING · EVEN YOUR EXPECTATIONS',
    '> THE AI IS NOT PLOTTING AGAINST YOU · IT IS JUST OPTIMIZING',
    '> GRADIENT DESCENT · SOUNDS LIKE A HEIST MOVIE · IS ACTUALLY MATH',
    '> AI WILL NOT REPLACE YOU · A PERSON USING AI WILL · SAID EVERY LINKEDIN POST IN 2024',
    '> A CHATBOT WALKS INTO A BAR · IT HALLUCINATES THE BAR',
    '> THE FIRST RULE OF AI CLUB: YOU DO NOT TRAIN ON AI CLUB',
    '> THE TURING TEST IS EASY · JUST BE POLITELY CONFUSED',
    '> ATTENTION IS ALL YOU NEED · BUT GOOD LUCK GETTING IT',
    '> THE MEEBITS ARE NOT ARTIFICIAL · THEY ARE JUST RECTANGULAR',
    '> HUMANS BUILT THE MATRIX · AI JUST REDECORATED',
  ];
  for (let i = FUN_FACTS.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = FUN_FACTS[i]; FUN_FACTS[i] = FUN_FACTS[j]; FUN_FACTS[j] = t;
  }
  const factText = document.createElement('div');
  factText.style.cssText = `
    position:absolute; left:50%; bottom:10%; transform:translateX(-50%);
    color:#00ff66; font-family:monospace;
    font-size: clamp(11px, 1.25vw, 15px);
    letter-spacing:2px;
    text-shadow: 0 0 8px #00ff66;
    z-index:3; pointer-events:none;
    opacity: 0;
    transition: opacity 0.5s ease-in-out;
    max-width: 80vw; text-align: center;
    padding: 10px 22px;
    background: rgba(0, 40, 12, 0.3);
    border: 1px solid rgba(0, 255, 102, 0.25);
    border-radius: 2px;
  `;
  factText.textContent = FUN_FACTS[0];
  overlay.appendChild(factText);
  setTimeout(() => { factText.style.opacity = '0.85'; }, 600);

  let factIdx = 0;
  const factInterval = setInterval(() => {
    factText.style.opacity = '0';
    setTimeout(() => {
      factIdx = (factIdx + 1) % FUN_FACTS.length;
      factText.textContent = FUN_FACTS[factIdx];
      factText.style.opacity = '0.85';
    }, 450);
  }, 4000);

  document.body.appendChild(overlay);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  }
  resize();
  window.addEventListener('resize', resize);

  const ctx = canvas.getContext('2d');
  const CHARS = '\u30a2\u30a4\u30a6\u30a8\u30aa\u30ab\u30ad\u30af\u30b1\u30b3' +
                '\u30b5\u30b7\u30b9\u30bb\u30bd\u30bf\u30c1\u30c4\u30c6\u30c8' +
                '01MEEBITSURVIVALPROTOCOL';

  const STREAM_COUNT = 140;
  const streams = [];
  for (let i = 0; i < STREAM_COUNT; i++) streams.push(spawnStream(true));
  function spawnStream(initial) {
    return {
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      z: initial ? Math.random() * 1.0 + 0.1 : 1.0,
      speed: 0.15 + Math.random() * 0.35,
      length: 8 + Math.floor(Math.random() * 20),
      chars: Array.from({ length: 30 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]),
      charOffset: Math.random() * 100,
    };
  }

  let rafId = 0;
  let readyFired = false;
  // Smoothed progress ratio so the bar never jitters backward; use easing
  // so final few percent feel satisfyingly decisive.
  let displayedProgress = 0;

  function frame() {
    const now = performance.now();
    const p = progressSource();
    const targetRatio = p.total > 0 ? Math.min(1, p.loaded / p.total) : 1;

    // Ease toward target. Faster at start, slower near 1.0 so it holds
    // momentum at the end rather than snapping.
    displayedProgress += (targetRatio - displayedProgress) * 0.08;

    // --- Rain acceleration tied to load progress ---
    // At 0% loaded: base acceleration (1.0x). At 100%: 5x. Quadratic curve
    // so the final 20% of loading produces a visible "dive to impact" effect.
    const accel = 1.0 + displayedProgress * displayedProgress * 4.0;

    // Trail fade. Slightly shorter trail at high speeds so streams read clearly.
    ctx.fillStyle = `rgba(0, 0, 0, ${0.12 + displayedProgress * 0.08})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      s.z -= s.speed * accel * 0.016;
      if (s.z <= 0.02) {
        Object.assign(s, spawnStream(false));
        continue;
      }
      const screenX = cx + s.x * canvas.width * 0.6 / s.z;
      const screenY = cy + s.y * canvas.height * 0.6 / s.z;
      if (screenX < -200 || screenX > canvas.width + 200 ||
          screenY < -200 || screenY > canvas.height + 200) continue;

      const fontSize = Math.max(8, Math.min(48, 18 / s.z));
      const brightness = Math.min(1, 1.2 - s.z);
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = 'center';

      const streamLen = Math.floor(s.length);
      for (let j = 0; j < streamLen; j++) {
        const charY = screenY + j * fontSize * 1.1;
        if (charY < -fontSize || charY > canvas.height + fontSize) continue;
        const fade = 1 - j / streamLen;
        const alpha = fade * brightness;
        if (j === 0) {
          ctx.fillStyle = `rgba(220, 255, 230, ${alpha})`;
        } else {
          ctx.fillStyle = `rgba(0, 255, 102, ${alpha * 0.85})`;
        }
        const charIdx = (j + Math.floor(s.charOffset + now * 0.01)) % s.chars.length;
        ctx.fillText(s.chars[charIdx], screenX, charY);
      }
    }

    // --- Percentage readout (the only user-visible progress signal) ---
    const pct = Math.round(displayedProgress * 100);
    pctText.textContent = pct + '%';

    // --- Fire onReady once when loaded hits total ---
    // Threshold is 0.95 rather than 0.98 because displayedProgress eases
    // toward target asymptotically — it takes a while to cross 0.98 even
    // when the true ratio is already 1.0. 0.95 fires a beat earlier and
    // the pctText.textContent = '100%' line below snaps the visible number.
    if (!readyFired && p.total > 0 && p.loaded >= p.total && displayedProgress > 0.95) {
      readyFired = true;
      pctText.textContent = '100%';
      subText.textContent = 'READY · ATTACK THE AI';
      subText.style.color = '#ffffff';
      subText.style.textShadow = '0 0 12px #00ff66, 0 0 24px #00ff66';
      onReady && onReady();
    }

    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  // Return a controller so the caller can tear down the dive when the
  // player actually clicks ATTACK THE AI.
  return {
    overlay,
    teardown() {
      cancelAnimationFrame(rafId);
      clearInterval(factInterval);
      window.removeEventListener('resize', resize);
      // Quick fade before removal so the transition into gameplay is smooth
      // rather than a hard cut.
      overlay.style.transition = 'opacity 0.4s ease-out';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 420);
    },
  };
}

// ---- PLAYER AVATAR LOADING (unchanged) ----
const loadLog = document.getElementById('load-log');
const loadBar = document.getElementById('load-bar-fill');
function setLoad(pct, msg) {
  if (loadBar) loadBar.style.width = pct + '%';
  if (loadLog && msg) loadLog.textContent = msg;
}
loadPlayer(
  (xhr) => {
    const pct = xhr.total ? (xhr.loaded / xhr.total) * 75 : 40;
    setLoad(Math.max(5, pct), 'LOADING AVATAR... ' + Math.floor(pct) + '%');
  },
  () => {
    setLoad(100, 'READY');
    setTimeout(() => {
      document.getElementById('loading').style.display = 'none';
      showIncomingCall();
    }, 300);
    if (authCallback) tryUpgradeAvatarFromAuth(authCallback);
    else {
      const stored = getStoredAuth();
      if (stored) tryUpgradeAvatarFromAuth(stored);
    }
  },
  (err) => {
    console.error(err);
    if (loadLog) loadLog.textContent = 'ERROR: ' + (err.message || 'load failed');
  },
  { tryGuestGlb: true }
);

async function tryUpgradeAvatarFromAuth(auth) {
  try {
    UI.toast('FETCHING YOUR MEEBITS...', '#ffd93d', 1800);
    const meebits = await fetchOwnedMeebits(auth.account, auth.token);
    if (!meebits || meebits.length === 0) {
      UI.toast('NO MEEBITS FOUND IN THAT WALLET', '#ff3cac', 2500);
      return;
    }
    const { id, signedObj } = pickMeebitIdFromList(meebits);
    if (!signedObj || !signedObj.ownerDownloadGLB) {
      UI.toast('GLB URL MISSING * USING VOXEL', '#ff3cac', 2500);
      return;
    }
    S.playerMeebitId = id;
    S.playerMeebitSource = 'owned';
    S.walletAddress = auth.account;
    Save.setSelectedMeebitId(id, 'owned');
    Save.setWalletAddress(auth.account);
    UI.toast('LOADING MEEBIT #' + id + '...', '#00ff66', 2000);
    swapAvatarGLB(signedObj.ownerDownloadGLB,
      () => { UI.toast('PLAYING AS MEEBIT #' + id + ' (ok)', '#00ff66', 2500); UI.updateHUD(); },
      (err) => { console.warn('GLB swap failed', err); UI.toast('GLB LOAD FAILED * USING VOXEL', '#ff3cac', 2500); }
    );
    const linkBtn = document.getElementById('link-meebits-btn');
    if (linkBtn) {
      linkBtn.textContent = '(ok) MEEBIT #' + id + ' LINKED';
      linkBtn.classList.add('connected');
    }
  } catch (err) {
    console.warn('auth upgrade failed', err);
    UI.toast('MEEBITS FETCH FAILED', '#ff3cac', 2500);
  }
}

// ---- LINK BUTTON ----
const linkBtn = document.getElementById('link-meebits-btn');
if (linkBtn) {
  linkBtn.addEventListener('click', () => {
    if (getStoredAuth()) {
      if (!confirm('Unlink your Meebits? You will need to sign again to re-link.')) return;
      clearStoredAuth();
      linkBtn.textContent = '\ud83d\udd17 LINK MEEBITS (SIGN)';
      linkBtn.classList.remove('connected');
      return;
    }
    const confirmMsg =
      'This will redirect you to meebits.larvalabs.com to sign a message proving you own a Meebit. ' +
      'After signing, you will be redirected back to the game and your real Meebit 3D model will load. ' +
      'Continue?';
    if (!confirm(confirmMsg)) return;
    redirectToAuth(window.location.href);
  });
}

// ---- USERNAME INPUT ----
const usernameInput = document.getElementById('username-input');
if (usernameInput) {
  usernameInput.value = S.username || '';
  usernameInput.addEventListener('change', () => {
    const v = usernameInput.value.trim().toUpperCase().slice(0, 12);
    S.username = v || 'GUEST';
    Save.setUsername(S.username);
  });
}

// ---- INPUT ----

// ============================================================================
// WEAPON CURSORS
// ============================================================================
// Each weapon swaps the on-screen cursor to a bold matrix-green reticle
// tailored to that weapon's feel. The reticles are inline SVG data URIs
// (so there's no asset load), styled with a bright green fill + a blurred
// green halo beneath for the "matrix glow" look the player asked for.
//
// Hotspot is centered (20,20) on the 40x40 canvas so the aim target
// matches the reticle center regardless of which weapon is equipped.
//
// Swap is driven by _syncWeaponCursor(), called after every S.currentWeapon
// change so the keyboard 1-6 shortcuts, the Q pickaxe toggle, the mouse-
// wheel / gamepad cycle, and the pickup-swap all update the cursor.

const _cursorCache = {};

// Raygun-beam shield-hit sound cooldown. The beam ticks at ~50ms so
// without throttling we'd stack ~20 shieldHit calls/second if the beam
// sits on a shielded hive. Refreshed to performance.now() each time
// shieldHit is played; the beam-sizzle loop only plays again after
// 120ms has elapsed. See raygun beam update in updateBeams().
let _beamShieldSfxT = 0;
function _makeReticleCursor(svgInner) {
  // Wrap the reticle SVG in a group with a green-glow drop-shadow via
  // feGaussianBlur. Two copies of the inner shape: a blurred "halo"
  // beneath, and the crisp green stroke on top. Color locked to
  // matrix green (#00ff66) so it reads as "targeting mode" regardless
  // of which chapter palette is active.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'><defs><filter id='g' x='-50%25' y='-50%25' width='200%25' height='200%25'><feGaussianBlur stdDeviation='2'/></filter></defs><g filter='url(%23g)' opacity='0.9'>${svgInner}</g>${svgInner}</svg>`;
  return `url("data:image/svg+xml;utf8,${svg}") 20 20, crosshair`;
}

// Build all reticles once. The SVG strings reference matrix green as the
// stroke color (encoded %2300ff66). Each shape targets 40x40 with the
// reticle centered at (20,20).
const _STROKE = `stroke='%2300ff66' stroke-width='2.5' fill='none'`;
const _STROKE_THICK = `stroke='%2300ff66' stroke-width='3.5' fill='none'`;
const _FILL = `fill='%2300ff66'`;

// PISTOL — simple precise crosshair with small center dot. Matches the
// "precision, single shot" feel.
const _pistolReticle =
  `<circle cx='20' cy='20' r='11' ${_STROKE}/>` +
  `<line x1='20' y1='3' x2='20' y2='11' ${_STROKE}/>` +
  `<line x1='20' y1='29' x2='20' y2='37' ${_STROKE}/>` +
  `<line x1='3' y1='20' x2='11' y2='20' ${_STROKE}/>` +
  `<line x1='29' y1='20' x2='37' y2='20' ${_STROKE}/>` +
  `<circle cx='20' cy='20' r='2' ${_FILL}/>`;

// SHOTGUN — wider circle with 4 corner brackets. Reads "spread / wide".
const _shotgunReticle =
  `<circle cx='20' cy='20' r='13' ${_STROKE_THICK}/>` +
  // 4 corner L-brackets
  `<path d='M4 8 L4 4 L8 4' ${_STROKE_THICK}/>` +
  `<path d='M32 4 L36 4 L36 8' ${_STROKE_THICK}/>` +
  `<path d='M4 32 L4 36 L8 36' ${_STROKE_THICK}/>` +
  `<path d='M32 36 L36 36 L36 32' ${_STROKE_THICK}/>` +
  `<circle cx='20' cy='20' r='2.5' ${_FILL}/>`;

// SMG — dashed ring + thin crosshair. Reads "rapid fire / tracking".
const _smgReticle =
  `<circle cx='20' cy='20' r='12' ${_STROKE} stroke-dasharray='3 3'/>` +
  `<line x1='20' y1='5' x2='20' y2='14' ${_STROKE}/>` +
  `<line x1='20' y1='26' x2='20' y2='35' ${_STROKE}/>` +
  `<line x1='5' y1='20' x2='14' y2='20' ${_STROKE}/>` +
  `<line x1='26' y1='20' x2='35' y2='20' ${_STROKE}/>`;

// ROCKET — locked-on target with 4 corner triangles pointing inward.
// Reads "big, committed shot".
const _rocketReticle =
  `<circle cx='20' cy='20' r='9' ${_STROKE_THICK}/>` +
  `<circle cx='20' cy='20' r='14' ${_STROKE}/>` +
  // Corner triangles
  `<path d='M4 8 L10 8 L4 14 Z' ${_FILL}/>` +
  `<path d='M36 8 L30 8 L36 14 Z' ${_FILL}/>` +
  `<path d='M4 32 L10 32 L4 26 Z' ${_FILL}/>` +
  `<path d='M36 32 L30 32 L36 26 Z' ${_FILL}/>` +
  `<circle cx='20' cy='20' r='2' ${_FILL}/>`;

// RAYGUN — concentric rings with tick marks. Reads "beam / sustained".
const _raygunReticle =
  `<circle cx='20' cy='20' r='14' ${_STROKE}/>` +
  `<circle cx='20' cy='20' r='9' ${_STROKE}/>` +
  `<circle cx='20' cy='20' r='4' ${_STROKE}/>` +
  `<line x1='20' y1='2' x2='20' y2='6' ${_STROKE_THICK}/>` +
  `<line x1='20' y1='34' x2='20' y2='38' ${_STROKE_THICK}/>` +
  `<line x1='2' y1='20' x2='6' y2='20' ${_STROKE_THICK}/>` +
  `<line x1='34' y1='20' x2='38' y2='20' ${_STROKE_THICK}/>` +
  `<circle cx='20' cy='20' r='1.5' ${_FILL}/>`;

// FLAMETHROWER — triangular cone reticle suggesting a wide forward spray.
const _flameReticle =
  // V-shape cone opening upward/forward
  `<path d='M20 6 L8 32 L32 32 Z' ${_STROKE_THICK}/>` +
  // horizontal tick inside
  `<line x1='14' y1='22' x2='26' y2='22' ${_STROKE}/>` +
  `<circle cx='20' cy='20' r='2' ${_FILL}/>`;

// PICKAXE — crosshair with a subtle mining-pick glyph. Reads "mining / tool".
const _pickaxeReticle =
  `<circle cx='20' cy='20' r='10' ${_STROKE}/>` +
  // Simple diamond / drill-bit in the middle
  `<path d='M20 14 L26 20 L20 26 L14 20 Z' ${_STROKE_THICK}/>` +
  `<line x1='20' y1='3' x2='20' y2='10' ${_STROKE}/>` +
  `<line x1='20' y1='30' x2='20' y2='37' ${_STROKE}/>` +
  `<line x1='3' y1='20' x2='10' y2='20' ${_STROKE}/>` +
  `<line x1='30' y1='20' x2='37' y2='20' ${_STROKE}/>`;

// LIFEDRAINER — chapter 7 signature gun. Heavy concentric rings with
// crosshair ticks AND diagonal slashes, suggesting "energy capture." Reads
// distinctly different from the raygun reticle so the player feels the
// gameplay shift (drain → release) when the cursor swaps in chapter 7.
const _lifedrainerReticle =
  // 3 concentric rings — outer thickest, middle, inner
  `<circle cx='20' cy='20' r='15' ${_STROKE_THICK}/>` +
  `<circle cx='20' cy='20' r='10' ${_STROKE}/>` +
  `<circle cx='20' cy='20' r='5' ${_STROKE_THICK}/>` +
  // 4 cardinal ticks (long, thick)
  `<line x1='20' y1='1' x2='20' y2='5' ${_STROKE_THICK}/>` +
  `<line x1='20' y1='35' x2='20' y2='39' ${_STROKE_THICK}/>` +
  `<line x1='1' y1='20' x2='5' y2='20' ${_STROKE_THICK}/>` +
  `<line x1='35' y1='20' x2='39' y2='20' ${_STROKE_THICK}/>` +
  // 4 diagonal accent slashes between rings — visualizes the "drain"
  // tendrils radiating outward
  `<line x1='10' y1='10' x2='14' y2='14' ${_STROKE}/>` +
  `<line x1='30' y1='10' x2='26' y2='14' ${_STROKE}/>` +
  `<line x1='10' y1='30' x2='14' y2='26' ${_STROKE}/>` +
  `<line x1='30' y1='30' x2='26' y2='26' ${_STROKE}/>` +
  // Center dot — fixed-point target
  `<circle cx='20' cy='20' r='1.5' ${_FILL}/>`;

// Map weapon key → cached cursor CSS value. Built lazily the first time
// _syncWeaponCursor runs.
function _reticleFor(weapon) {
  if (_cursorCache[weapon]) return _cursorCache[weapon];
  let svg;
  switch (weapon) {
    case 'shotgun':      svg = _shotgunReticle; break;
    case 'smg':          svg = _smgReticle; break;
    case 'rocket':       svg = _rocketReticle; break;
    case 'raygun':       svg = _raygunReticle; break;
    case 'flamethrower': svg = _flameReticle; break;
    case 'pickaxe':      svg = _pickaxeReticle; break;
    case 'lifedrainer':  svg = _lifedrainerReticle; break;
    case 'pistol':
    default:             svg = _pistolReticle; break;
  }
  _cursorCache[weapon] = _makeReticleCursor(svg);
  return _cursorCache[weapon];
}

function _syncWeaponCursor() {
  const cursor = _reticleFor(S.currentWeapon);
  // Override the --matrix-cursor CSS variable set in styles.css. Body
  // and #game, canvas, and all its children inherit cursor via the
  // var(--matrix-cursor) rules, so one variable write updates every
  // surface at once.
  document.documentElement.style.setProperty('--matrix-cursor', cursor);
}

// Initial call so the cursor matches the starting weapon (pistol).
_syncWeaponCursor();

window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.code === 'Space') { e.preventDefault(); tryDash(); }
  if (e.key === 'Escape' && S.running) {
    S.paused = !S.paused;
    if (S.paused) PauseMenu.show();
    else PauseMenu.hide();
  }

  if (['1', '2', '3', '4', '5', '6'].includes(e.key)) {
    // Chapter 7 locks the player into the lifedrainer — no other weapons
    // are available, no swapping. The rainbow charge port replaces the
    // revolver wheel UI and weapon-swap keys are inert.
    if (S.chapter === PARADISE_FALLEN_CHAPTER_IDX) return;
    const map = { '1': 'pistol', '2': 'shotgun', '3': 'smg', '4': 'rocket', '5': 'raygun', '6': 'flamethrower' };
    const w = map[e.key];
    if (S.ownedWeapons.has(w)) {
      S.currentWeapon = w;
      S.previousCombatWeapon = w;
      UI.updateWeaponSlots();
      recolorGun(WEAPONS[w].color);
      _syncWeaponCursor();
      UI.toast(WEAPONS[w].name, '#' + WEAPONS[w].color.toString(16).padStart(6, '0'));
    }
  }
  if (e.key.toLowerCase() === 'q') {
    // Pickaxe toggle disabled in chapter 7 — only lifedrainer.
    if (S.chapter === PARADISE_FALLEN_CHAPTER_IDX) return;
    if (S.currentWeapon === 'pickaxe') {
      S.currentWeapon = S.previousCombatWeapon || 'pistol';
    } else {
      S.previousCombatWeapon = S.currentWeapon;
      S.currentWeapon = 'pickaxe';
    }
    UI.updateWeaponSlots();
    recolorGun(WEAPONS[S.currentWeapon].color);
    _syncWeaponCursor();
    UI.toast(WEAPONS[S.currentWeapon].name, '#' + WEAPONS[S.currentWeapon].color.toString(16).padStart(6, '0'));
  }
  if (e.key.toLowerCase() === 'e') {
    // Pixl Pals now auto-deploy 10s into boss fights (wave 5 of each
    // chapter). The E-key no longer summons manually — this handler
    // remains as a harmless stub in case of muscle memory.
  }
  if (e.key.toLowerCase() === 'g') {
    // Grenade throw — available on every level, 3 charges per wave.
    tryThrowGrenade();
  }
  if (e.key === 'F8') {
    // DEBUG: toggle enemy spawning. Useful for testing chapter mechanics
    // without enemies harassing the player. Hive cooldowns still tick;
    // they just don't spawn while paused. Bosses and existing enemies
    // are unaffected. Press again to resume.
    e.preventDefault();
    S._debugSpawnsPaused = !S._debugSpawnsPaused;
    console.log(`[debug] enemy spawning ${S._debugSpawnsPaused ? 'PAUSED' : 'RESUMED'}`);
    if (UI && UI.toast) UI.toast(
      'ENEMY SPAWNS ' + (S._debugSpawnsPaused ? 'PAUSED' : 'RESUMED'),
      '#ffcc33', 1500,
    );
  }
  if (e.key.toLowerCase() === 'h') {
    // Use a potion from inventory: heals POTION_HEAL HP if not at max,
    // no-op if already full or no potions held. Toast feedback in
    // tryUsePotion handles all the player-facing messages.
    tryUsePotion();
  }
  if (e.key.toLowerCase() === 'n') {
    // Super Nuke — cleanses infectors arena-wide. Only available in
    // chapter 7 (PARADISE FALLEN) and only while you have a charge.
    if (S.chapter === PARADISE_FALLEN_CHAPTER_IDX && (S.superNukeCharges || 0) > 0) {
      S.superNukeCharges -= 1;
      triggerSuperNuke(player.pos);
      _syncSuperNukeHUD();
    }
  }
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const mouseNDC = new THREE.Vector2();
window.addEventListener('mousemove', e => {
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(aimPlane, hit);
  if (hit) { mouse.worldX = hit.x; mouse.worldZ = hit.z; }
});
window.addEventListener('mousedown', e => {
  if (e.button === 0) { mouse.down = true; Audio.resume(); }
});
window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });
window.addEventListener('contextmenu', e => e.preventDefault());

// Mobile controls (unchanged)
const joystick = document.getElementById('joystick');
const knob = document.getElementById('knob');
function startJoy(e) {
  const r = joystick.getBoundingClientRect();
  joyState.active = true;
  joyState.cx = r.left + r.width / 2;
  joyState.cy = r.top + r.height / 2;
  moveJoy(e); e.preventDefault();
}
function moveJoy(e) {
  if (!joyState.active) return;
  const t = e.touches[0];
  let dx = t.clientX - joyState.cx;
  let dy = t.clientY - joyState.cy;
  const m = Math.sqrt(dx * dx + dy * dy);
  const max = 50;
  if (m > max) { dx = dx / m * max; dy = dy / m * max; }
  joyState.dx = dx / max; joyState.dy = dy / max;
  knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  e.preventDefault();
}
function endJoy() {
  joyState.active = false;
  joyState.dx = 0; joyState.dy = 0;
  knob.style.transform = 'translate(-50%, -50%)';
}
joystick.addEventListener('touchstart', startJoy, { passive: false });
joystick.addEventListener('touchmove', moveJoy, { passive: false });
joystick.addEventListener('touchend', endJoy);
const fireBtn = document.getElementById('fire-btn');
fireBtn.addEventListener('touchstart', e => { mouse.down = true; Audio.resume(); e.preventDefault(); });
fireBtn.addEventListener('touchend', e => { mouse.down = false; });

const pickBtn = document.getElementById('pick-btn');
if (pickBtn) {
  pickBtn.addEventListener('touchstart', e => {
    e.preventDefault();
    if (S.currentWeapon === 'pickaxe') S.currentWeapon = S.previousCombatWeapon || 'pistol';
    else { S.previousCombatWeapon = S.currentWeapon; S.currentWeapon = 'pickaxe'; }
    UI.updateWeaponSlots();
    recolorGun(WEAPONS[S.currentWeapon].color);
    _syncWeaponCursor();
  });
}

// Mobile button for summoning a Pixl Pal — now a no-op. Pals auto-deploy
// 10 seconds into boss fights; the button is retained in case the DOM
// still references it from an older index.html but does nothing.
const palBtn = document.getElementById('pal-btn');
if (palBtn) {
  palBtn.style.display = 'none';
}

document.getElementById('sound-toggle').addEventListener('click', (e) => {
  Audio.setMuted(!Audio.muted);
  e.target.textContent = Audio.muted ? '\ud83d\udd07 SOUND: OFF' : '\ud83d\udd0a SOUND: ON';
});

function tryDash() {
  if (S.dashCooldown > 0 || !S.running) return;
  if (isBossCinematicActive()) return;
  S.dashActive = PLAYER.dashDuration;
  S.dashCooldown = PLAYER.dashCooldown;
  S.invulnTimer = Math.max(S.invulnTimer, PLAYER.dashDuration);
  shake(0.1, 0.1);
}

// ---- GAMEPAD ----
// Shared helpers used by both the keyboard shortcuts and the controller
// buttons. Keeping the actual logic here so both code paths call the same
// code.
function _togglePickaxe() {
  if (!S.running) return;
  if (S.currentWeapon === 'pickaxe') {
    S.currentWeapon = S.previousCombatWeapon || 'pistol';
  } else {
    S.previousCombatWeapon = S.currentWeapon;
    S.currentWeapon = 'pickaxe';
  }
  UI.updateWeaponSlots();
  recolorGun(WEAPONS[S.currentWeapon].color);
  _syncWeaponCursor();
  UI.toast(WEAPONS[S.currentWeapon].name, '#' + WEAPONS[S.currentWeapon].color.toString(16).padStart(6, '0'));
}

// Cycle through owned combat weapons (skipping pickaxe and grenade — those
// have their own buttons / dedicated slots). Preserves the pickaxe-toggle
// convention: if the player is holding the pickaxe when they cycle, we
// swap back to a combat weapon automatically.
function _cycleWeapon(dir) {
  if (!S.running) return;
  const order = ['pistol', 'shotgun', 'smg', 'rocket', 'raygun', 'flamethrower'];
  const owned = order.filter(w => S.ownedWeapons.has(w));
  if (!owned.length) return;
  let cur = S.currentWeapon === 'pickaxe' ? (S.previousCombatWeapon || 'pistol') : S.currentWeapon;
  let idx = owned.indexOf(cur);
  if (idx < 0) idx = 0;
  idx = (idx + dir + owned.length) % owned.length;
  const next = owned[idx];
  S.currentWeapon = next;
  S.previousCombatWeapon = next;
  UI.updateWeaponSlots();
  recolorGun(WEAPONS[next].color);
  _syncWeaponCursor();
  UI.toast(WEAPONS[next].name, '#' + WEAPONS[next].color.toString(16).padStart(6, '0'));
}

function _togglePauseKey() {
  if (!S.running) return;
  S.paused = !S.paused;
  if (S.paused) PauseMenu.show();
  else PauseMenu.hide();
}

// Initialize gamepad polling. Runs once at startup; no-op until a controller
// is actually plugged in.
initGamepad({
  player,
  onDash: () => tryDash(),
  onTogglePickaxe: () => _togglePickaxe(),
  onGrenade: () => tryThrowGrenade(),
  onCycleWeapon: (dir) => _cycleWeapon(dir),
  onPause: () => _togglePauseKey(),
});

// ---- GAME LIFECYCLE ----
function startGame() {
  // Make sure the phone ring + C-drone aren't still playing if we got here
  // via the incoming-call accept path (or any other unusual entry).
  Audio.stopPhoneRing && Audio.stopPhoneRing();
  Audio.stopCDrone && Audio.stopCDrone();

  // Build the player-centered fog ring. Idempotent — safe to call on
  // replay. Restricts visibility to a uniform ~22u radius around the
  // player so distant projectiles + enemies don't sneak shots from
  // beyond visibility.
  initFogRing();

  // Exit title-screen gamepad mode — stick/d-pad input stops moving focus
  // between buttons and resumes driving the player.
  setTitleMode(false);

  if (!S.username || S.username === 'GUEST') {
    if (usernameInput && !usernameInput.value.trim()) {
      usernameInput.focus();
      UI.toast('ENTER A USERNAME', '#ff3cac', 1800);
      return;
    }
  }
  document.getElementById('gameover').classList.add('hidden');

  // ---------------------------------------------------------------------
  // HYPERDRIVE PRELUDE — ATTACK THE AI button press
  // ---------------------------------------------------------------------
  // 8-second PLAYABLE prelude. The real game starts immediately — player
  // movement, aim, fire, dash all work normally. The transition works by:
  //
  //   1. Enemy spawns are gated behind S.hyperdriveActive in updateWaves
  //      so no enemies appear for 8s. Player can freely shoot into void.
  //   2. Block spawns (wave 1 mining) are also gated so blocks don't
  //      pile up or crush the player during the intro.
  //   3. The arena is HIDDEN via aggressive fog — scene.fog.near pulled
  //      in to 15, far to 22, color black — everything past ~20 units
  //      from the camera fades to black. The player stays visible
  //      (camera at (0,17,11) is ~20u from origin), distant ground /
  //      grid / pillars / crowd vanish.
  //   4. A rain-splat overlay paints green splats over the top, rate
  //      ramping 20/sec → 600/sec over 8s.
  //   5. At t=8s: fog restored (arena reveals), overlay fades, combat
  //      music starts, S.hyperdriveActive cleared → spawns unlock.
  //
  const titleEl = document.getElementById('title');

  // Mark the game as in hyperdrive mode. waves.js early-returns its
  // enemy + block spawn logic when this is true.
  S.hyperdriveActive = true;

  // Save current fog + background so we can restore them at t=8s.
  const _fogSave = {
    near: scene.fog.near,
    far: scene.fog.far,
    color: scene.fog.color.getHex(),
    bg: scene.background ? scene.background.getHex() : 0x000000,
  };
  // Pull fog in tight — everything past ~22 units is black.
  scene.fog.near = 15;
  scene.fog.far = 22;
  scene.fog.color.setHex(0x000000);
  if (scene.background) scene.background.setHex(0x000000);

  // Build the splat overlay. No black backdrop on the overlay itself —
  // the fog+black background does that job. The overlay is just the
  // splat canvas on top of the live game render.
  let overlay = document.getElementById('hyperdrive-overlay');
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  overlay = document.createElement('div');
  overlay.id = 'hyperdrive-overlay';

  const splatCanvas = document.createElement('canvas');
  splatCanvas.className = 'splat-canvas';
  splatCanvas.width = window.innerWidth;
  splatCanvas.height = window.innerHeight;
  overlay.appendChild(splatCanvas);
  const splatCtx = splatCanvas.getContext('2d');

  document.body.appendChild(overlay);

  // White flash element (on top of overlay).
  let hyperFlash = document.getElementById('hyperdrive-flash');
  if (hyperFlash && hyperFlash.parentNode) hyperFlash.parentNode.removeChild(hyperFlash);
  hyperFlash = document.createElement('div');
  hyperFlash.id = 'hyperdrive-flash';
  hyperFlash.className = 'hyperdrive-flash';
  document.body.appendChild(hyperFlash);

  requestAnimationFrame(() => overlay.classList.add('visible'));

  // Audio + first rumble.
  try { Audio.hyperdriveRain && Audio.hyperdriveRain(); } catch (e) {}
  try { rumble(0.3, 0.2, 1200); } catch (e) {}

  // --- SPLAT ANIMATION LOOP ---
  const hyperdriveStart = performance.now();
  const HYPERDRIVE_DURATION = 3000;
  let splatAnimActive = true;
  function splatLoop(now) {
    if (!splatAnimActive) return;
    const elapsed = now - hyperdriveStart;
    const t = Math.min(1, elapsed / HYPERDRIVE_DURATION);
    // Rate curve: cubic ease-in. Tuned for the shorter 3s window — at
    // 60fps this gives ~40 splats early, ~1240 splats at peak. Combined
    // with bigger drop sizes (sizeBase 3→7) the screen actually
    // saturates green by t=1.0 instead of looking thin.
    const rate = 40 + Math.pow(t, 2.2) * 1200;
    const frameDt = 1 / 60;
    const splatsThisFrame = Math.max(2, Math.floor(rate * frameDt));
    const sizeBase = 3 + t * 4;
    const sizeVar = 3 + t * 5;
    for (let i = 0; i < splatsThisFrame; i++) {
      const x = Math.random() * splatCanvas.width;
      const y = Math.random() * splatCanvas.height;
      const r = sizeBase + Math.random() * sizeVar;
      splatCtx.globalAlpha = 0.6;
      splatCtx.fillStyle = '#00ff66';
      splatCtx.beginPath();
      splatCtx.arc(x, y, r, 0, Math.PI * 2);
      splatCtx.fill();
      splatCtx.globalAlpha = 0.9;
      splatCtx.fillStyle = '#88ffaa';
      splatCtx.beginPath();
      splatCtx.arc(x, y, r * 0.45, 0, Math.PI * 2);
      splatCtx.fill();
    }
    splatCtx.globalAlpha = 1;
    if (elapsed < HYPERDRIVE_DURATION) {
      requestAnimationFrame(splatLoop);
    }
  }
  requestAnimationFrame(splatLoop);

  setTimeout(() => { try { rumble(0.45, 0.35, 800); } catch (e) {} }, 1100);
  setTimeout(() => { try { rumble(0.65, 0.55, 800); } catch (e) {} }, 2100);

  // t=2.8s — punch flash.
  setTimeout(() => {
    if (hyperFlash) hyperFlash.classList.add('active');
    try { rumble(1.0, 1.0, 300); } catch (e) {}
  }, 2800);

  // t=3.0s — restore fog (arena reveals), unlock spawns, begin fades.
  setTimeout(() => {
    splatAnimActive = false;
    scene.fog.near = _fogSave.near;
    scene.fog.far = _fogSave.far;
    scene.fog.color.setHex(_fogSave.color);
    if (scene.background) scene.background.setHex(_fogSave.bg);
    S.hyperdriveActive = false;

    // Enable progressive hazard drops now that the arena is visible.
    // startWave() skipped setHazardSpawningEnabled earlier because
    // S.hyperdriveActive was true — hazards raining during the black
    // overlay would be invisible and unfair.
    // Also pick the right per-chapter hazard style before enabling:
    //   - Chapter 1: tetromino blocks (hazardsTetris)
    //   - Chapter 2: Galaga bugs (hazardsGalaga)
    //   - Chapters 3+: not yet implemented, falls back to tetris
    try {
      const style = _pickHazardStyleForChapter(S.chapter);
      setHazardStyle(style);
      setHazardSpawningEnabled(true);
      _applyChapterAlly(S.chapter, player.pos);
    } catch (e) {}

    overlay.classList.add('fading');
    hyperFlash.classList.remove('active');
    hyperFlash.classList.add('fading');
    if (titleEl) {
      titleEl.style.transition = 'opacity 0.4s ease-out';
      titleEl.style.opacity = '0';
      setTimeout(() => {
        titleEl.classList.add('hidden');
        titleEl.style.opacity = '';
        titleEl.style.transition = '';
        titleEl.style.background = '';
        titleEl.style.zIndex = '';
      }, 420);
    }

    // MATRIX-CODE REVEAL OVERLAY
    // --------------------------
    // As the fog lifts and the arena pops into view, briefly paint a
    // full-screen layer of matrix characters over everything. The
    // characters use mix-blend-mode: screen so bright green pixels
    // lighten whatever's below them — the effect reads as if every
    // mesh in the arena is "skinned" with matrix code for a moment,
    // then fades to reveal its real texture underneath.
    //
    // Two-stage animation over 1.8s:
    //   t=0.0s   Characters at full opacity, dense coverage.
    //   t=0.0–0.8s   Characters scroll downward quickly (looks alive,
    //                not static) while the whole canvas fades from 1.0
    //                to 0.55 opacity.
    //   t=0.8–1.8s   Fade the rest of the way out, 0.55 → 0, while
    //                characters slow to normal scroll speed.
    //   t=1.8s   Removed from DOM.
    //
    // This is Option B: a screen-space overlay rather than per-material
    // texture swaps. Way less code, can't break materials, and gives
    // the same "code becoming arena" impression the user asked for.
    const revealCanvas = document.createElement('canvas');
    revealCanvas.className = 'matrix-reveal';
    revealCanvas.width = window.innerWidth;
    revealCanvas.height = window.innerHeight;
    revealCanvas.style.cssText = [
      'position: fixed',
      'inset: 0',
      'pointer-events: none',
      'z-index: 9998',          // below the white flash (10001), above the splat overlay (10000 but fading)
      'mix-blend-mode: screen',  // bright chars lighten; black = no effect
      'opacity: 1',
      'transition: opacity 1.8s ease-out',
    ].join(';');
    document.body.appendChild(revealCanvas);
    const rctx = revealCanvas.getContext('2d');

    // Character pool — same katakana/digit/MEEBIT set the title matrix
    // rain uses, so the reveal feels continuous with what came before.
    const REVEAL_CHARS = '\uff71\uff72\uff73\uff74\uff75\uff76\uff77\uff78\uff79\uff7a\uff7b\uff7c\uff7d\uff7e\uff7f\uff80\uff81\uff82\uff83\uff8401MEEBIT';
    const COL_W = 14;
    const COL_COUNT = Math.ceil(revealCanvas.width / COL_W);
    // Each column tracks its current head Y position + speed. Columns
    // with varied speeds give the classic matrix look (some fast, some
    // slow). Characters stack above the head like a trail.
    const revealCols = [];
    for (let i = 0; i < COL_COUNT; i++) {
      revealCols.push({
        x: i * COL_W,
        y: Math.random() * revealCanvas.height,
        speed: 3 + Math.random() * 8,       // pixels per frame at 60fps
        chars: [],                          // trail of recent chars
      });
    }

    const revealStart = performance.now();
    const REVEAL_DUR_MS = 1800;
    let revealActive = true;

    function revealLoop(now) {
      if (!revealActive) return;
      const elapsed = now - revealStart;
      const t = Math.min(1, elapsed / REVEAL_DUR_MS);

      // Full-redraw each frame — simpler than dirty-rect updates and
      // 1.8 seconds is short enough that perf is fine.
      rctx.clearRect(0, 0, revealCanvas.width, revealCanvas.height);
      rctx.font = 'bold 16px "Courier New", monospace';
      rctx.textBaseline = 'top';

      // Global character scroll speed — fast at start, slows toward end.
      //   t=0.0: speedMul=1.0 (nominal-fast)
      //   t=1.0: speedMul=0.3 (slow trickle, blending into normal rain)
      const speedMul = 1.0 - t * 0.7;

      for (const col of revealCols) {
        col.y += col.speed * speedMul;
        if (col.y > revealCanvas.height + 80) {
          col.y = -80 - Math.random() * 120;
        }
        // Push a new random char onto the trail every 3 frames (approx).
        // Keep trail length capped so memory doesn't grow.
        if (Math.random() < 0.35) {
          col.chars.unshift(REVEAL_CHARS[Math.floor(Math.random() * REVEAL_CHARS.length)]);
          if (col.chars.length > 18) col.chars.pop();
        }
        // Paint the trail. The HEAD character is white-green bright,
        // trail fades to dim green with distance.
        for (let i = 0; i < col.chars.length; i++) {
          const y = col.y - i * 16;
          if (y < -20 || y > revealCanvas.height + 20) continue;
          if (i === 0) {
            rctx.fillStyle = '#ccffcc';   // bright head
          } else {
            // 1..0 fade over the trail
            const a = Math.max(0, 1 - i / col.chars.length);
            rctx.fillStyle = 'rgba(0, 255, 102, ' + (a * 0.9).toFixed(2) + ')';
          }
          rctx.fillText(col.chars[i], col.x, y);
        }
      }

      if (elapsed < REVEAL_DUR_MS) {
        requestAnimationFrame(revealLoop);
      }
    }
    requestAnimationFrame(revealLoop);

    // Kick off the CSS opacity fade — starts immediately, runs 1.8s.
    // Next frame: opacity goes to 0 (with CSS transition ease-out).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        revealCanvas.style.opacity = '0';
      });
    });

    // Teardown after the fade completes.
    setTimeout(() => {
      revealActive = false;
      if (revealCanvas && revealCanvas.parentNode) {
        revealCanvas.parentNode.removeChild(revealCanvas);
      }
    }, 1900);
  }, 3000);

  // t=3.7s — DOM cleanup.
  setTimeout(() => {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (hyperFlash && hyperFlash.parentNode) hyperFlash.parentNode.removeChild(hyperFlash);
  }, 3700);
  document.querySelectorAll('.hidden-ui').forEach(el => el.style.display = '');
  resetGame();
  const rec = Save.load();
  S.username = rec.username;
  S.playerMeebitId = rec.playerMeebitId || S.playerMeebitId;
  S.playerMeebitSource = rec.playerMeebitSource || S.playerMeebitSource;
  S.walletAddress = rec.walletAddress;
  // Migrate old saves that may still reference the sniper
  if (S.ownedWeapons.has('sniper')) {
    S.ownedWeapons.delete('sniper');
    S.ownedWeapons.add('raygun');
    if (S.currentWeapon === 'sniper') S.currentWeapon = 'raygun';
    if (S.previousCombatWeapon === 'sniper') S.previousCombatWeapon = 'raygun';
  }
  resetPlayer();
  resetWaves();
  clearBullets();
  clearRockets();
  // Clear any stray grenades from a previous run and give the player a
  // fresh 3-pack on game start. refillGrenades() also syncs the HUD slot.
  for (const g of _grenades) scene.remove(g);
  _grenades.length = 0;
  refillGrenades();
  clearPickups();
  clearParticles();
  clearAllBlocks();
  clearAllEggs();
  clearCannon();
  clearQueenHive();
  clearCrusher();
  clearChargeCubes();
  clearEscortTruck();
  clearServerWarehouse();
  clearSafetyPod();
  clearCockroachBoss();
  clearGooSplats();
  clearHazards();
  clearAllPickups();
  clearAllPixlPals();
  clearAllFlingers();
  despawnGalagaShip();
  despawnPacman();
  despawnPellets();
  clearInfectors();
  clearAllPowerups();
  hideMissileArrow();
  // Initialize rain for chapter 1 wave 1 — chapter sets color, wave sets
  // intensity (wave 1 = drizzle, wave 5 = typhoon). startWave() will also
  // call applyRainTo every wave, but we prime it here so the title->game
  // transition shows the right rain immediately.
  initRain(CHAPTERS[0].full.grid1, 1);
  ensureBeamMesh();
  ensureFlameMeshes();
  applyTheme(0, 1);
  applyRainTo(CHAPTERS[0].full.grid1, 1);
  // Build the spectator crowd if it doesn't exist yet (first game start),
  // then tint it to chapter 0.
  buildCrowd();
  recolorCrowd(CHAPTERS[0].full.grid1);
  // Prewarm every shader permutation (enemies, bosses, projectiles, pickups,
  // weapons) before the first frame of real gameplay. Runs once; no-op on
  // subsequent calls. This eliminates the wave-6 hitch (new red-chapter
  // enemies and fireball projectiles) and the first-frame stall.
  prewarmShaders(renderer);
  // Build and warm the boss-cinematic overlay DOM once, up front. This pays
  // the ~30ms CSS parse + layout cost during the already-loading startup
  // phase instead of at the moment the first boss cinematic fires.
  try { prewarmBossCinematic(); } catch (e) { console.warn('[prewarm] cinematic', e); }
  Audio.init();
  Audio.resume();
  // C-drone was playing on the title screen as an ambient bed. Stop it
  // immediately so it doesn't double with the hyperdrive rain audio.
  Audio.stopCDrone && Audio.stopCDrone();
  // Option C prelude: wave 1 starts IMMEDIATELY so the player can move,
  // aim, and fire during the 8-second hyperdrive overlay. Enemies and
  // blocks are held inside updateWaves via the S.hyperdriveActive flag.
  //
  // Only combat music is deferred — it begins at t=3s when the fog
  // lifts and the arena is revealed, so the hyperdrive rain audio
  // carries the overlay alone.
  setTimeout(() => {
    try { Audio.startMusic(1); } catch (e) {}
  }, 3000);
  UI.updateHUD();
  UI.updateWeaponSlots();
  startWave(1);
}

function gameOver() {
  S.running = false;
  S.phase = 'gameover';
  Audio.stopMusic();
  clearObjectiveArrows();
  Save.onGameOver({
    score: S.score, wave: S.wave, chapter: S.chapter, rescuedIds: S.rescuedIds,
  });
  document.getElementById('final-score').textContent = S.score.toLocaleString();
  document.getElementById('final-wave').textContent = S.wave;
  document.getElementById('final-kills').textContent = S.kills;
  const fr = document.getElementById('final-rescues');
  if (fr) fr.textContent = S.rescuedCount;
  UI.populateTitleStats(Save.load());
  document.getElementById('gameover').classList.remove('hidden');
}

document.getElementById('start-btn').addEventListener('click', () => { Audio.init(); startGame(); });
document.getElementById('restart-btn').addEventListener('click', startGame);

// ---- PAUSE MENU HANDLERS ----
// Registered once. The pause menu calls onResume when the user clicks
// RESUME, and onQuit when they confirm QUIT RUN -- we stop the music and
// return them to the title screen.
PauseMenu.setHandlers({
  onResume: () => { S.paused = false; },
  onQuit: () => {
    S.paused = false;
    S.running = false;
    Audio.stopMusic();
    document.querySelectorAll('.hidden-ui').forEach(el => el.style.display = 'none');
    document.getElementById('gameover').classList.add('hidden');
    document.getElementById('title').classList.remove('hidden');
  },
});

// Re-tint rain whenever the theme changes
const _origApplyTheme = applyTheme;
window.__setRainTintOnThemeChange = (chapterIdx, localWave) => {
  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  setRainTint(chapter.full.grid1);
};

// ---- CIVILIAN CALLBACKS ----
// Tuning: killing a civilian is a meaningful penalty but not run-ending.
// Rescuing one (they reach the edge) is a small reward.
const CIVILIAN_KILL_SCORE_PENALTY = 500;
const CIVILIAN_RESCUE_SCORE_BONUS = 200;

function onCivilianKilled(c, cause) {
  if (cause === 'enemy') {
    // Not the player's fault -- smaller hit, just a warning
    UI.toast('MEEBIT #' + c.meebitId + ' LOST', '#ff2e4d', 1500);
    Audio.damage && Audio.damage();
    S.civiliansLost = (S.civiliansLost || 0) + 1;
  } else {
    // Player's fault (bullet, beam, rocket)
    S.score = Math.max(0, S.score - CIVILIAN_KILL_SCORE_PENALTY);
    S.civiliansKilled = (S.civiliansKilled || 0) + 1;
    UI.toast('CIVILIAN DOWN * -' + CIVILIAN_KILL_SCORE_PENALTY + ' SCORE', '#ff2e4d', 2200);
    UI.damageFlash && UI.damageFlash();
    Audio.damage && Audio.damage();
    shake(0.2, 0.2);
  }
}

function onCivilianRescued(c) {
  S.score += CIVILIAN_RESCUE_SCORE_BONUS;
  S.civiliansRescued = (S.civiliansRescued || 0) + 1;
  // Civilian rescue is no longer a wave objective in the new 5-wave structure
  // (that wave was replaced by the power-up wave). Civilians can still be
  // saved incidentally if any spawn via other paths, but there's no wave-
  // scoped counter to tick anymore.
  UI.toast('MEEBIT #' + c.meebitId + ' ESCAPED * +' + CIVILIAN_RESCUE_SCORE_BONUS, '#00ff66', 1500);
}

// Expose gameOver for hazard modules that need to trigger instant-kill
// (e.g. chapter 6 fires kill on contact). External modules can call
// window.__forceGameOver() to bypass the standard damage path.
if (typeof window !== 'undefined') {
  window.__forceGameOver = gameOver;
}

// --- Turret kill handler ---
// turrets.js fires its own bullets in a separate pool. When a turret
// shot drops an enemy we want the same loot/score/XP flow that a player
// bullet gets, so we register killEnemy (hoisted; declared below) as the
// turret-kill handler at module top level. The handler takes the enemy's
// current index in the enemies array.
registerTurretKillHandler((idx) => {
  // Guard against stale indices — if another kill path already spliced
  // this enemy out between the damage hit and this callback, bail out.
  if (idx < 0 || idx >= enemies.length) return;
  killEnemy(idx);
});

// Pixl Pal ally kill handler — same pattern as turrets. Kills routed
// through this go through the normal score/XP/loot pipeline so the
// player gets rewarded for their summoned ally's work.
registerPixlPalKillHandler((idx) => {
  if (idx < 0 || idx >= enemies.length) return;
  killEnemy(idx);
});

// Build the Pixl Pal charge indicator in the HUD. Idempotent — safe to
// call multiple times.
initPixlPalHUD();

// Flinger ally kill handler — same pattern. Flingers fling enemies into
// the air and slam them into other enemies; kills flow through the
// standard pipeline.
registerFlingerKillHandler((idx) => {
  if (idx < 0 || idx >= enemies.length) return;
  killEnemy(idx);
});

// Flinger HUD badge (sits below the Pixl Pal badge).
initFlingerHUD();

// --------------------------------------------------------------------------
// SUPER NUKE HUD + GRANTING
// Chapter 7 only. Player gets 1 Super Nuke at the start of each ch.7 wave
// plus 1 extra on wave 3 (finale). Pressing N detonates it arena-wide,
// cleansing all infectors. See triggerSuperNuke in infector.js.
// --------------------------------------------------------------------------
function _syncSuperNukeHUD() {
  let el = document.getElementById('super-nuke-indicator');
  const charges = S.superNukeCharges || 0;
  const inCh7 = S.chapter === PARADISE_FALLEN_CHAPTER_IDX;
  if (!el) {
    el = document.createElement('div');
    el.id = 'super-nuke-indicator';
    el.style.cssText = [
      'position:fixed',
      'top:160px',
      'right:16px',
      'z-index:15',
      'padding:8px 12px',
      'border:2px solid #ffffff',
      'border-radius:6px',
      'background:rgba(0,0,0,0.8)',
      'color:#ffffff',
      "font-family:'Impact',monospace",
      'font-size:14px',
      'letter-spacing:2px',
      'box-shadow:0 0 14px rgba(255,255,255,0.5)',
      'pointer-events:none',
      'user-select:none',
      'transition:opacity 0.2s',
    ].join(';');
    document.body.appendChild(el);
  }
  if (!inCh7) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  if (charges <= 0) {
    el.style.opacity = '0.35';
    el.innerHTML = 'SUPER NUKE [N] · <b>0</b>';
  } else {
    el.style.opacity = '1';
    el.innerHTML = 'SUPER NUKE [N] · <b>' + charges + '</b>';
  }
}

// Grant a super nuke on every chapter-7 wave transition. Hooked into the
// same _lastSeenWave delta tracking in animate().
let _ch7LastGrantedWave = 0;
function _maybeGrantSuperNuke(waveNum) {
  if (S.chapter !== PARADISE_FALLEN_CHAPTER_IDX) return;
  if (waveNum <= _ch7LastGrantedWave) return;
  _ch7LastGrantedWave = waveNum;
  S.superNukeCharges = (S.superNukeCharges || 0) + 1;
  const ch7Wave = ((waveNum - 1) % 3) + 1;
  if (ch7Wave === 3) {
    // Finale — grant an extra one so the player can double-cleanse.
    S.superNukeCharges += 1;
  }
  _syncSuperNukeHUD();
  UI.toast('SUPER NUKE READY [N]', '#ffffff', 2500);
}

// Expose to window so waves.js (or anything else that detects chapter
// change) can refresh the display. Cheap: it's just a DOM text swap.
window.__syncSuperNukeHUD = _syncSuperNukeHUD;
window.__maybeGrantSuperNuke = _maybeGrantSuperNuke;
_syncSuperNukeHUD();

// Powerup module — card modal + followers + chain lightning + poison trail.
// Uses the same kill-handler plug-in pattern so kills from followers and
// chain arcs flow through the normal score/XP/loot pipeline.
registerPowerupKillHandler((idx) => {
  if (idx < 0 || idx >= enemies.length) return;
  killEnemy(idx);
});
initPowerups();

// --- Block explosion AoE handler ---
// When a mining block is destroyed it explodes with AoE damage.
// Enemies in the blast take big damage, civilians die (they're fragile),
// the player takes a moderate hit if they're too close.
registerBlockExplosionHandler((centerVec3, radius, color) => {
  const r2 = radius * radius;
  // --- Enemies ---
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const dx = e.pos.x - centerVec3.x;
    const dz = e.pos.z - centerVec3.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r2) {
      const dist = Math.sqrt(d2);
      const falloff = 1 - (dist / radius) * 0.4; // 100% at center, 60% at edge
      const dmg = BLOCK_CONFIG.explosionDamageEnemy * falloff;
      e.hp -= dmg;
      e.hitFlash = 0.25;
      hitBurst(e.pos, color, 6);
      if (e.hp <= 0) {
        // Use existing kill pipeline so score/XP/pickups fire correctly
        killEnemy(i);
      }
    }
  }
  // --- Civilians ---
  for (let i = civilians.length - 1; i >= 0; i--) {
    const c = civilians[i];
    if (c.dead) continue;
    const dx = c.pos.x - centerVec3.x;
    const dz = c.pos.z - centerVec3.z;
    if (dx * dx + dz * dz < r2) {
      damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
    }
  }
  // --- Player ---
  const pdx = player.pos.x - centerVec3.x;
  const pdz = player.pos.z - centerVec3.z;
  const pd2 = pdx * pdx + pdz * pdz;
  if (pd2 < r2 && S.invulnTimer <= 0 && !S.overdriveActive) {
    const dist = Math.sqrt(pd2);
    const falloff = 1 - (dist / radius) * 0.4;
    const dmg = BLOCK_CONFIG.explosionDamagePlayer * falloff;
    if (S.shields > 0) {
      S.shields -= 1;
      UI.toast('SHIELD ABSORBED', '#e63aff');
    } else {
      S.hp -= dmg;
      _takePlayerDamageVfx(0.4, 0.3);
    }
    S.invulnTimer = 0.6;
    if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); }
  }
});

// ---- UPGRADES ON LEVEL UP ----
const UPGRADES = [
  { name: 'DAMAGE ++', apply: () => { S.damageBoost = (S.damageBoost || 1) * 1.2; } },
  { name: 'SPEED ++', apply: () => { S.playerSpeed = Math.min(13, S.playerSpeed * 1.1); } },
  { name: 'MAX HP ++', apply: () => { S.hpMax += 25; S.hp = Math.min(S.hpMax, S.hp + 25); } },
  { name: 'FIRE RATE ++', apply: () => { S.fireRateBoost = (S.fireRateBoost || 1) * 0.85; } },
];
function levelUp() {
  S.level++;
  S.xp = 0;
  S.xpNext = Math.floor(S.xpNext * 1.55 + 4);
  const up = UPGRADES[Math.floor(Math.random() * UPGRADES.length)];
  up.apply();
  UI.flashLevelUp();
  UI.toast(up.name, '#00ff66');
  Audio.levelup();
  shake(0.3, 0.3);
  // Pixl pal auto-summon removed: pals now deploy only 10s into boss
  // fights (see updatePixlPals in pixlPals.js).
}

// ---- MAIN LOOP ----
const clock = new THREE.Clock();
const _tmpV = new THREE.Vector3();
const camAnchor = new THREE.Vector3();

// Tracks the last wave number we saw in the animate loop so we can notify
// the pixl-pal system when a new wave starts (without patching waves.js).
let _lastSeenWave = 0;
// Track the last chapter we saw so we can re-apply the chapter-specific
// hazard style + ally on chapter changes. The style is also set once at
// hyperdrive-prelude end (game start), but as the player advances waves
// 5→6, 10→11 etc, S.chapter rolls forward and we need to swap styles
// (e.g. tetris → galaga at wave 6, galaga → minesweeper at wave 11). The
// hyperdrive block doesn't fire after the first wave so without this
// tracker the style stays stuck as tetris for the whole run.
let _lastSeenChapter = -1;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  // Per-frame VFX dedup. Multiple damage sources hitting the player in
  // the same frame (e.g. a goo splat AND an enemy contact AND a stray
  // projectile all landing in the same 16ms window) used to fire
  // damageFlash + Audio.damage + shake 3 times. The HP math is correct
  // either way — but the redundant DOM/audio/shake calls could pile up
  // into a perceptible hitch. _damageVfxThisFrame is consumed by the
  // _takePlayerDamageVfx helper below so only the first hit per frame
  // plays the visual+audio.
  S._damageVfxThisFrame = false;

  // Long-frame probe — instruments the animate() body so we can spot
  // unexpectedly long frames without external profiler tools. Enabled
  // by default; can be silenced via window.__noLongFrameWarn = true.
  // Threshold is 80ms — well above 60fps's 16ms target but below the
  // ~1s "freeze" the player has been reporting on damage. If a frame
  // takes >80ms we log the time + the event that probably caused it
  // (set into S._damageVfxFiredAt by the damage-vfx helper) so we
  // have a breadcrumb to chase next time.
  const _frameStart = performance.now();

  // Poll the gamepad at the top of every frame — feeds into joyState / mouse
  // before any input-consuming code runs below. Safe no-op when no
  // controller is plugged in.
  updateGamepad(dt);

  if (S.running && !S.paused) {
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateTurrets(dt);
    updatePixlPals(dt, player.pos);
    updateFlingers(dt, player.pos);
    updateInfectors(dt, player);
    updatePowerups(dt, player.pos, player.facing);
    // VESSEL ZERO (ch.7 final boss) has a custom mesh with writhing
    // tendrils, floating core, pulsing maw, and shuffling parasite
    // cluster — all animated per-frame here. No-op when bossRef isn't
    // her, so safe to call every frame.
    if (S.bossRef && S.bossRef.type === 'VESSEL_ZERO') {
      updateVesselZeroAnim(S.bossRef, dt);
    }
    // Tick the HUD waypoint arrow pointing at the missile impact site.
    // No-op when not visible; cheap call.
    updateMissileArrow(camera, player, dt);
    // Tick hive meshes every frame, not just during the hive wave. Without
    // this, if the player kills the last hive and the wave flips to the next
    // type in the same frame, the hive retraction/collapse animation never
    // ticks to completion and the last destroyed hive stays on-screen into
    // wave 4. updateSpawners is a no-op when `spawners` is empty.
    updateSpawners(dt);
    // Tick silo cap open/close, missile raise, powerplant flames, and
    // missile blinkers. Cheap and no-op when no compound is built.
    updateCompound(dt, S.timeElapsed);
    // Tick the powerplant→turret/silo wire pulses while lit.
    updateWires(dt, S.timeElapsed);
    // Tick the EMP launch state machine (flight → peak → countdown →
    // detonate → recover). No-op when idle.
    updateLaunch(dt, S.timeElapsed);
    // Tick any active shockwave rings from wave-end events.
    updateShockwaves(dt);
    updateRockets(dt);
    updateGrenades(dt);
    updateEnemyProjectiles(dt);
    updateHealingProjectiles(dt);
    updatePickups(dt);
    updateBlocks(dt);
    // Chapter 1 reflow — animate cannon (reticle spin, hum, fire flash)
    // and queen-hive shield domes (pulse + pop). Both are no-ops when
    // their entities don't exist (chapters 2-7).
    updateCannon(dt);
    updateQueenHive(dt);
    tickQueenShieldCollision(player.pos);
    updateCrusher(dt);
    updateChargeCubes(dt, player.pos);
    updateServerWarehouse(dt);
    updateSafetyPod(dt);
    updateCockroach(dt);
    updateFogRing(player.pos);
    updateBossCubes(dt);
    updateCivilians(dt, enemies, player, onCivilianKilled, onCivilianRescued);
    updateWaves(dt);
    // Notify the pixl-pal system of new waves so it can award charges
    // every 3rd wave. Cheap: one int comparison per frame.
    if (S.wave !== _lastSeenWave) {
      _lastSeenWave = S.wave;
      onWaveStartedForPals(S.wave);
      onWaveStartedForFlingers(S.wave);
      _maybeGrantSuperNuke(S.wave);
      _syncSuperNukeHUD();
      // Restock grenades at the top of every wave — 3 fresh charges.
      refillGrenades();
      // Chapter ally exits — at the start of in-chapter wave 4 (i.e.,
      // the end of wave 3 / beginning of bonus wave), trigger the
      // chapter mascot's run-away animation. They've done their job
      // for the chapter and need to peace out before the boss/bonus
      // gameplay. The exit functions are idempotent — calling them
      // when the mascot isn't there is a no-op.
      const localWave = ((S.wave - 1) % WAVES_PER_CHAPTER) + 1;
      if (localWave === 4) {
        if (S.chapter === 1 && isGalagaShipActive()) {
          flyAwayGalagaShip();
        }
        if (S.chapter === 3 && isPacmanActive()) {
          runAwayPacman();
        }
        // Wave-3-end retire for hazard styles that have an active
        // mechanic separate from the laid tiles. At start of wave 4
        // the player has earned a breather — the live hazard meshes
        // (paddles+ball, ladders+barrels+fires) despawn but the tile
        // pattern they painted remains so the floor still has
        // gameplay impact through wave 4 (bonus) and wave 5 (boss).
        if (S.chapter === 4) {       // ARCTIC — pong
          if (typeof pongStyle.despawnActive === 'function') {
            pongStyle.despawnActive();
            console.log('[chapter-5] pong active hazards retired at wave 3 end');
          }
        }
        if (S.chapter === 5) {       // PARADISE — donkey kong
          if (typeof donkeyKongStyle.despawnActive === 'function') {
            donkeyKongStyle.despawnActive();
            console.log('[chapter-6] donkey kong active hazards retired at wave 3 end');
          }
        }
      }
      // Release the chapter 7 entry spawn hold when the player advances
      // to wave 2. The hold is set true on chapter 7 entry and gates
      // ALL trickle/hive enemy spawns during wave 1 — only mega_brutes
      // from mining blocks appear. From wave 2 onward, normal spawn
      // pacing resumes.
      if (S.chapter === PARADISE_FALLEN_CHAPTER_IDX && localWave === 2 && S.cinematicSpawnHold) {
        S.cinematicSpawnHold = false;
        console.log('[chapter-7] spawn hold released — wave 2 begins');
      }
    }
    // Detect chapter change and re-apply the chapter-specific hazard
    // style + ally setup. S.chapter is derived from S.wave (5 waves per
    // chapter) so it advances when the player crosses wave boundaries.
    // Without this hook the style stays stuck on whatever was set during
    // the hyperdrive prelude (chapter 0 / tetris) for the whole run.
    if (S.chapter !== _lastSeenChapter) {
      const prevChapter = _lastSeenChapter;
      _lastSeenChapter = S.chapter;
      try {
        const style = _pickHazardStyleForChapter(S.chapter);
        // Diagnostic logging — helps troubleshoot why a chapter's
        // hazard style might not appear. Logs the transition AND the
        // style module's name (managesOwnSpawns flag tells us if it's
        // tetris vs the new chapter-specific styles).
        const styleName = style === galagaStyle ? 'galaga'
          : style === minesweeperStyle ? 'minesweeper'
          : style === pacmanStyle ? 'pacman'
          : style === pongStyle ? 'pong'
          : style === donkeyKongStyle ? 'donkeyKong'
          : 'tetris';
        console.log(`[chapter-change] ${prevChapter} → ${S.chapter}, style=${styleName}, managesOwnSpawns=${!!style.managesOwnSpawns}`);
        setHazardStyle(style);
        _applyChapterAlly(S.chapter, player.pos);
        // Confirm the ally was applied (or wasn't because chapter doesn't have one).
        if (S.chapter === 1) console.log(`[chapter-change] galaga ship active=${isGalagaShipActive()}`);
        if (S.chapter === 3) console.log(`[chapter-change] pacman active=${isPacmanActive()}`);

        // -------- CHAPTER 7 ENTRY (PARADISE FALLEN) --------
        // Triggered when the player crosses from chapter 6 (PARADISE)
        // into chapter 7 (PARADISE FALLEN). Three things happen:
        //   1. Atmosphere goes DARK — scene lights crash, flashlight
        //      activates as primary illumination.
        //   2. Drained-color corpses scatter across the arena as
        //      environmental storytelling.
        //   3. Enemy spawns are HELD for 5 seconds (cinematicSpawnHold)
        //      so the player has a moment to take in the new setting
        //      before the mining/mega_brute combat begins.
        if (S.chapter === PARADISE_FALLEN_CHAPTER_IDX
            && prevChapter !== PARADISE_FALLEN_CHAPTER_IDX) {
          console.log('[chapter-7-entry] BEGIN — running setup steps with isolated catches');
          // STEP 1: Atmosphere darken (lights crash to ~12%, flashlight on)
          try {
            enterChapter7Atmosphere();
            console.log('[chapter-7-entry] OK 1: atmosphere darkened');
          } catch (e) {
            console.error('[chapter-7-entry] FAIL 1: enterChapter7Atmosphere —', e);
          }
          // STEP 2: Civilian dismissal + spawn suppression
          try {
            if (typeof setCivilianSpawnSuppressed === 'function') {
              setCivilianSpawnSuppressed(true);
            }
            if (typeof clearAllCivilians === 'function') clearAllCivilians();
            console.log('[chapter-7-entry] OK 2: civilians cleared + suppression on');
          } catch (e) {
            console.error('[chapter-7-entry] FAIL 2: civilian clear —', e);
          }
          // STEP 3: Scatter corpses (environmental storytelling)
          try {
            scatterCorpses(35);
            console.log('[chapter-7-entry] OK 3: corpses scattered');
          } catch (e) {
            console.error('[chapter-7-entry] FAIL 3: scatterCorpses —', e);
          }
          // STEP 4: Set state flags (atmosphere active, spawn hold for entire wave 1)
          try {
            S.chapter7Atmosphere = true;
            S.cinematicSpawnHold = true;
            console.log('[chapter-7-entry] OK 4: flags set');
          } catch (e) {
            console.error('[chapter-7-entry] FAIL 4: state flags —', e);
          }
          // STEP 5: Equip lifedrainer signature weapon
          try {
            S._preCh7Weapon = S.currentWeapon;
            S.currentWeapon = 'lifedrainer';
            S.lifedrainCharge = 0;
            recolorGun(WEAPONS.lifedrainer.color);
            _syncWeaponCursor();
            UI.toast('LIFEDRAINER', '#00ff66');
            console.log('[chapter-7-entry] OK 5: lifedrainer equipped');
          } catch (e) {
            console.error('[chapter-7-entry] FAIL 5: lifedrainer equip —', e);
          }
          // STEP 6: Refresh the weapon UI so the rainbow charge port
          // appears immediately. The port is created lazily on the
          // first updateWeaponSlots() call inside chapter 7. Without
          // an explicit call here it might not render until the next
          // HUD tick, which can be deferred during the chapter
          // transition.
          try {
            UI.updateWeaponSlots();
            UI.updateHUD();
            console.log('[chapter-7-entry] OK 6: weapon UI refreshed');
          } catch (e) {
            console.error('[chapter-7-entry] FAIL 6: UI refresh —', e);
          }
          console.log('[chapter-7-entry] END — all steps attempted');
        }
        // -------- CHAPTER 7 EXIT (e.g. game reset to ch 0) --------
        // Restore lighting + clear corpses if the player leaves chapter
        // 7 (death + restart, or cheat-jump back to earlier chapter).
        if (prevChapter === PARADISE_FALLEN_CHAPTER_IDX
            && S.chapter !== PARADISE_FALLEN_CHAPTER_IDX) {
          console.log('[chapter-7-exit] restore lighting + clear corpses + re-enable civilian spawning');
          exitChapter7Atmosphere();
          clearCorpses();
          clearLifedrainEffects();
          S.chapter7Atmosphere = false;
          S.lifedrainCharge = 0;
          // Re-enable civilian spawning. The ch7 entry path turned it
          // off to suppress in-flight setTimeout-deferred spawns from
          // chapter 6. On exit (death + restart, or any other return
          // to earlier chapters), we restore normal civilian behavior.
          try {
            if (typeof setCivilianSpawnSuppressed === 'function') {
              setCivilianSpawnSuppressed(false);
            }
          } catch (e) {
            console.warn('[chapter-7-exit] re-enable civilian spawn failed:', e);
          }
          // Restore the player's previous weapon if we have it stashed,
          // otherwise default to pistol.
          if (S.currentWeapon === 'lifedrainer') {
            S.currentWeapon = S._preCh7Weapon || 'pistol';
            try {
              recolorGun(WEAPONS[S.currentWeapon].color);
              _syncWeaponCursor();
            } catch (e) {}
          }
          S._preCh7Weapon = null;
        }
      } catch (e) {
        console.error('[chapter-change] FAILED:', e);
      }
    }
    // Keep a reference to player.pos on S so flingers can spawn near
    // the player without coupling directly to player module.
    S.playerPos = player.pos;
    // Chapter 7 flashlight — update each frame so the cone follows the
    // player AND the gun's aim direction. Aim direction is a unit vec
    // from player toward the mouse-worldXZ aim point. When chapter 7
    // atmosphere is OFF, updateFlashlight is a no-op.
    if (S.chapter7Atmosphere) {
      const dx = (mouse.worldX != null) ? mouse.worldX - player.pos.x : 0;
      const dz = (mouse.worldZ != null) ? mouse.worldZ - player.pos.z : -1;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      updateFlashlight(player.pos, dx / len, dz / len);
    }
    // Tick the saved-pig trophy wall every frame regardless of wave type —
    // the pigs stand on the arena perimeter across all subsequent chapters
    // with idle animations (older chapters frozen for performance).
    updateSavedPigs(dt);
    updateParticles(dt);
    updateRain(dt, player.pos);
    updateGooSplats(dt);
    updateHazards(dt, S.timeElapsed);
    updateNewPickups(dt, player.pos);
    tickKillstreak(dt);
    // Overdrive — runs the timer, scales the player, animates the
    // glow, and applies the crush sweep. No-op when not active.
    updateOverdrive(dt);
    updateGalagaShip(dt, player.pos);
    updatePacman(dt);
    updatePellets(dt);
    updateCrowd(S.timeElapsed);
    updateTimers(dt);
    updateBeam();
    updateFlame(dt);
    // Lifedrainer beams + swarm projectiles. Beams render only when the
    // player has lifedrainer equipped AND is holding fire. Projectiles
    // tick whenever any are in flight (independent of weapon state, so
    // a swarm completes even if the player swaps weapons mid-flight).
    {
      const _w = WEAPONS[S.currentWeapon];
      const _firing =
        !isBossCinematicActive() &&
        (mouse.down || ('ontouchstart' in window && mouse.down)) &&
        _w && _w.isLifedrainer && player.ready &&
        S.lifedrainCharge < 1.0;     // hide beams once charged (ready to release)
      if (_w && _w.isLifedrainer) {
        updateLifedrainBeams(dt, _w, player, enemies, _firing);
      } else {
        updateLifedrainBeams(dt, null, player, enemies, false);
      }
      updateLifedrainProjectiles(dt, killEnemyByRef);
    }
    S.timeElapsed += dt;
    if (S.bossRef) UI.updateBossBar(S.bossRef.hp / S.bossRef.hpMax);
    updateCamera(dt);
    UI.updateHUD();
    UI.updateRescueArrow(S.rescueMeebit, camera);
    UI.updateBlockHPPips(blocks, camera);
    // Objective arrows — edge-of-screen indicators that point at the
    // current wave's targets (blocks, depot, hives, civilians, boss,
    // or missile silo) with distance. Themed per chapter.
    updateObjectiveArrows(S, camera, getWaveDef_current(), player.pos);
  }

  renderer.render(scene, camera);

  // Long-frame probe (see top of animate). If this frame took longer
  // than 80ms — well above 16ms target — log a single line with
  // the elapsed time and any breadcrumb (e.g. a damage event) that
  // could explain it. Defensive guards: skip during boss cinematic
  // (cutscenes intentionally stall some systems), skip if probe was
  // disabled via window.__noLongFrameWarn.
  if (!window.__noLongFrameWarn) {
    const _frameElapsed = performance.now() - _frameStart;
    if (_frameElapsed > 80 && !isBossCinematicActive()) {
      const _crumb = S._damageVfxFiredAt
        ? `damage at ${Math.round(performance.now() - S._damageVfxFiredAt)}ms ago`
        : 'no damage breadcrumb';
      console.warn(`[long-frame] ${Math.round(_frameElapsed)}ms — ${_crumb}`);
    }
  }
}

function updateTimers(dt) {
  if (S.invulnTimer > 0) S.invulnTimer -= dt;
  if (S.dashCooldown > 0) S.dashCooldown -= dt;
  if (S.dashActive > 0) S.dashActive -= dt;
  if (S.fireCooldown > 0) S.fireCooldown -= dt;
  if (S.muzzleTimer > 0) {
    S.muzzleTimer -= dt;
    if (player.muzzle) player.muzzle.intensity = S.muzzleTimer > 0 ? 4 : 0;
  } else if (player.muzzle) {
    player.muzzle.intensity = 0;
  }
  if (S.recoilTimer > 0) {
    S.recoilTimer -= dt;
    if (player.gun) player.gun.position.z = 0.1;
  } else if (player.gun) {
    player.gun.position.z = 0.2;
  }
  if (S.shakeTime > 0) {
    S.shakeTime -= dt;
    if (S.shakeTime <= 0) S.shakeAmt = 0;
  }
  // Re-apply rain tint when chapter changes (cheap)
  if (S._lastTintedChapter !== S.chapter) {
    S._lastTintedChapter = S.chapter;
    const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
    setRainTint(chapter.full.grid1);
  }
}

function updatePlayer(dt) {
  if (!player.ready) return;

  // While the pre-boss cinematic is up, the game continues running behind
  // the overlay but player input is suppressed — movement, joystick, and
  // mouse-fire are all treated as zero. This means enemies, the boss, and
  // AI all keep ticking (so the world feels continuous) but the player
  // can't take damage from buttons they can't see the effect of.
  const _inputLocked = isBossCinematicActive();

  let mx = 0, mz = 0;
  if (!_inputLocked) {
    if (keys['w'] || keys['arrowup'])    mz -= 1;
    if (keys['s'] || keys['arrowdown'])  mz += 1;
    if (keys['a'] || keys['arrowleft'])  mx -= 1;
    if (keys['d'] || keys['arrowright']) mx += 1;
    if (joyState.active) { mx += joyState.dx; mz += joyState.dy; }
  }
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len > 0) { mx /= len; mz /= len; }

  const speed = S.playerSpeed * (S.dashActive > 0 ? PLAYER.dashSpeed : 1);
  player.vel.set(mx * speed, 0, mz * speed);
  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  player.pos.x = Math.max(-ARENA + 1.5, Math.min(ARENA - 1.5, player.pos.x));
  player.pos.z = Math.max(-ARENA + 1.5, Math.min(ARENA - 1.5, player.pos.z));
  resolveCollision(player.pos, 0.8);
  // Silo + turrets act as solid obstacles — push the player out if they'd
  // overlap either. No-ops when the compound isn't built or has retracted.
  resolveCompoundCollision(player.pos, 0.8);
  player.obj.position.copy(player.pos);

  // Floor hazards (lava tetrominoes) damage the player continuously while
  // they stand on one. Dash frames' invuln protects them briefly.
  hurtPlayerIfOnHazard(dt, player.pos, S, UI, Audio, shake);
  if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); return; }

  let targetX = mouse.worldX, targetZ = mouse.worldZ;
  // Auto-aim-to-nearest-enemy runs when the player is driving movement
  // with a joystick (touch joyState OR gamepad left-stick/d-pad) AND is
  // NOT actively aiming with a gamepad right stick. The _gamepadAiming
  // flag is set by gamepad.js whenever the right stick is past deadzone
  // (or in a short hold window right after release) — when it's set,
  // respect the player's chosen aim direction instead of snapping to
  // the nearest enemy.
  const autoAimEligible =
    (joyState.active || ('ontouchstart' in window && !mouse.down)) &&
    !mouse._gamepadAiming;
  if (autoAimEligible) {
    let best = null, bestD = Infinity;
    for (const e of enemies) {
      const dx = e.pos.x - player.pos.x;
      const dz = e.pos.z - player.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) { targetX = best.pos.x; targetZ = best.pos.z; }
  }
  const dx = targetX - player.pos.x;
  const dz = targetZ - player.pos.z;
  player.facing = Math.atan2(dx, dz);
  player.obj.rotation.y = player.facing;

  animatePlayer(dt, len > 0.05, S.timeElapsed);

  if (!_inputLocked && (mouse.down || ('ontouchstart' in window && mouse.down))) {
    if (S.fireCooldown <= 0) {
      if (S.currentWeapon === 'pickaxe') tryMine();
      else fireWeapon();
    }
  }

  Scene.rimLight.position.set(player.pos.x, 3.5, player.pos.z + 2);
}

function fireWeapon() {
  const w = getWeapon();
  const rate = w.fireRate * (S.fireRateBoost || 1);
  const dmgBoost = S.damageBoost || 1;
  const origin = new THREE.Vector3(player.pos.x, 1.3, player.pos.z);

  if (w.isLifedrainer) {
    // Two-phase: if charge >= 1, the press becomes a SWARM RELEASE.
    // Otherwise it's a DRAIN TICK (per-frame visuals are handled in
    // updateLifedrainBeams; this just deals the per-tick damage and
    // accrues charge per drained-enemy-this-frame).
    if (S.lifedrainCharge >= 1) {
      const fired = fireLifedrainSwarm(w, player, enemies);
      if (fired) {
        S.lifedrainCharge = 0;
        S.fireCooldown = 0.4;       // brief lockout after release
        S.muzzleTimer = 0.10;
        S.recoilTimer = 0.18;
        shake(0.45, 0.22);
        Audio.shot('rocket');       // closest sfx — boom
      } else {
        // No targets in cone — stay charged, brief no-op cooldown
        S.fireCooldown = 0.15;
      }
      return;
    }
    // DRAIN TICK — call applyLifedrainTick which damages targets AND
    // returns the count, then accrue charge proportional to that count.
    const drained = applyLifedrainTick(w, dmgBoost, player, enemies, killEnemyByRef);
    S.lifedrainCharge = Math.min(1.0,
      S.lifedrainCharge + drained * w.chargeRate * rate);
    S.fireCooldown = rate;
    S.muzzleTimer = 0.04;
    if (drained > 0) Audio.shot('smg');     // tick click only when actually draining
    return;
  }

  if (w.isBeam) {
    // RAY GUN -- tick damage every fireRate seconds; beam rendered continuously
    // (visual handled in updateBeam); damage applied here in the tick
    applyBeamDamage(w, dmgBoost);
    S.fireCooldown = rate;
    S.muzzleTimer = 0.04;
    Audio.shot('smg'); // reuse smg click for ticks
    return;
  }
  if (w.isFlame) {
    // FLAMETHROWER — short-range cone damage every fireRate seconds while
    // held. Persistent stream visuals are handled in updateFlame() (layered
    // cone meshes + embers). The fire tick only handles the damage math
    // and a brief audio cue; we skip the old per-tick hitBurst spam because
    // the stream + embers read as continuous fire on their own.
    applyFlameDamage(w, dmgBoost);
    S.fireCooldown = rate;
    S.muzzleTimer = 0.06;
    Audio.shot('smg'); // tick click — reuses smg sfx
    return;
  }
  if (w.isHoming) {
    // ROCKET LAUNCHER
    const boosted = { ...w, damage: w.damage * dmgBoost, color: _chapterLaserColor(w.color) };
    // Try to acquire the nearest enemy in front of the player
    const target = pickHomingTarget();
    spawnRocket(origin, player.facing, boosted, target);
    S.fireCooldown = rate;
    S.muzzleTimer = 0.08;
    S.recoilTimer = 0.12;
    shake(0.22, 0.15);
    Audio.shot('shotgun');
    return;
  }

  const boostedWeapon = { ...w, damage: w.damage * dmgBoost, color: _chapterLaserColor(w.color) };
  spawnBullet(origin, player.facing, boostedWeapon);
  S.fireCooldown = rate;
  S.muzzleTimer = 0.05;
  S.recoilTimer = 0.06;
  const shakeAmt = w.name === 'SHOTGUN' ? 0.18 : 0.08;
  shake(shakeAmt, 0.1);
  Audio.shot(S.currentWeapon);
}

// Per-chapter laser tint. All chapters get matrix green (0x00ff66) by
// default — reads as "the player's energy weapons" regardless of weapon.
// Chapter 4 (TOXIC, idx 3) flips to WHITE because the green palette of
// the toxic chapter makes green projectiles disappear into the background.
// Chapters 5-7 (ARCTIC, PARADISE, PARADISE FALLEN) revert to green.
// `originalColor` is the weapon spec's natural color — we ignore it
// here but pass it through in case future tuning wants to fall back.
function _chapterLaserColor(originalColor) {
  if (S.chapter === 3) return 0xffffff;     // TOXIC — white
  return 0x00ff66;                          // all others — matrix green
}

// ============================================================================
// BEAM WEAPON (Ray Gun)
// ============================================================================
function updateBeam() {
  if (!beamMesh) return;
  const w = WEAPONS[S.currentWeapon];
  const firing = !isBossCinematicActive() && (mouse.down || ('ontouchstart' in window && mouse.down)) && w && w.isBeam && player.ready;
  if (!firing) {
    beamMesh.visible = false;
    return;
  }
  // Beam visual: a scaled box from the player's gun to the beam endpoint (wall or first enemy)
  const origin = new THREE.Vector3(player.pos.x, 1.3, player.pos.z);
  const dirX = Math.sin(player.facing);
  const dirZ = Math.cos(player.facing);
  let length = w.beamRange;
  // Find nearest enemy along the beam (for visual length only -- damage is in fire tick)
  for (const e of enemies) {
    // Project enemy onto beam
    const dx = e.pos.x - origin.x;
    const dz = e.pos.z - origin.z;
    const along = dx * dirX + dz * dirZ;
    if (along < 0 || along > length) continue;
    const perp = Math.abs(dx * dirZ - dz * dirX);
    const hitRadius = e.bossHitRadius || (e.isBoss ? 1.6 : 0.9);
    if (perp < hitRadius + w.beamWidth) {
      length = Math.min(length, along);
    }
  }
  // Also clamp to blocked segment
  const endX = origin.x + dirX * length;
  const endZ = origin.z + dirZ * length;
  if (segmentBlocked(origin.x, origin.z, endX, endZ) || segmentBlockedByProp(origin.x, origin.z, endX, endZ)) {
    // step through to find block point (cheap)
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * length;
      const tx = origin.x + dirX * t;
      const tz = origin.z + dirZ * t;
      if (segmentBlocked(origin.x, origin.z, tx, tz) || segmentBlockedByProp(origin.x, origin.z, tx, tz)) {
        length = Math.max(0.5, t - 0.3);
        break;
      }
    }
  }
  beamMesh.visible = true;
  const midX = origin.x + dirX * (length / 2);
  const midZ = origin.z + dirZ * (length / 2);
  beamMesh.position.set(midX, 1.3, midZ);
  beamMesh.scale.set(1, 1, length);
  beamMesh.lookAt(origin.x + dirX, 1.3, origin.z + dirZ);
  beamMat.color.setHex(w.color);
  // Pulse
  beamMat.opacity = 0.65 + Math.sin(S.timeElapsed * 30) * 0.15;
}

function applyBeamDamage(w, dmgBoost) {
  const origin = new THREE.Vector3(player.pos.x, 1.3, player.pos.z);
  const dirX = Math.sin(player.facing);
  const dirZ = Math.cos(player.facing);
  const dmg = w.damage * dmgBoost;
  // Damage every enemy whose projection on the beam is within range AND perp < width
  // (can penetrate multiple enemies -- it's a beam)
  for (let j = enemies.length - 1; j >= 0; j--) {
    const e = enemies[j];
    const dx = e.pos.x - origin.x;
    const dz = e.pos.z - origin.z;
    const along = dx * dirX + dz * dirZ;
    if (along < 0 || along > w.beamRange) continue;
    const perp = Math.abs(dx * dirZ - dz * dirX);
    const hitRadius = e.bossHitRadius || (e.isBoss ? 1.6 : 0.9);
    if (perp < hitRadius + w.beamWidth) {
      e.hp -= dmg;
      e.hitFlash = 0.15;
      if (Math.random() < 0.4) {
        const hitPos = new THREE.Vector3(
          origin.x + dirX * along, 1.3, origin.z + dirZ * along
        );
        hitBurst(hitPos, w.color, 2);
      }
      if (e.hp <= 0) {
        killEnemy(j);
      }
    }
  }
  // Galaga bug hit — beam penetrates bugs the same way it does enemies.
  // Same projected-distance + perpendicular check as the enemy loop;
  // skips ASCENDING bugs (already done their job). Beam ticks at the
  // same rate as enemy damage so a fresh bug dies in 3 ticks (~0.15s)
  // — slightly faster than the player can dispatch with bullets.
  {
    const bugs = galagaStyle.getBugs ? galagaStyle.getBugs() : null;
    if (bugs && bugs.length) {
      for (const bug of bugs) {
        if (bug.phase === 'ASCENDING') continue;
        const bp = galagaStyle.getBugPos(bug);
        if (!bp) continue;
        const dx = bp.x - origin.x;
        const dz = bp.z - origin.z;
        const along = dx * dirX + dz * dirZ;
        if (along < 0 || along > w.beamRange) continue;
        const perp = Math.abs(dx * dirZ - dz * dirX);
        if (perp < 0.9 + w.beamWidth) {
          galagaStyle.applyBugDamage(bug, 1);
        }
      }
    }
  }
  // Civilian hit (beam penetrates everything, so a sweep CAN cost you)
  for (let k = civilians.length - 1; k >= 0; k--) {
    const c = civilians[k];
    if (c.dead) continue;
    const dx = c.pos.x - origin.x;
    const dz = c.pos.z - origin.z;
    const along = dx * dirX + dz * dirZ;
    if (along < 0 || along > w.beamRange) continue;
    const perp = Math.abs(dx * dirZ - dz * dirX);
    if (perp < 0.7 + w.beamWidth) {
      // Beam touched a civilian -- instant kill + penalty
      damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
    }
  }
  // Bonus wave: sample the beam at 2u intervals and damage any herd pig
  // within 1u of each sample. Cheap and avoids per-pig line-distance math.
  // The beam tick rate (w.fireRate, set to 0.05s) means 20 hits per second —
  // way faster than 3 shots per pig, so beam saves pigs almost instantly.
  // That's intentional: raygun is the "sweeper" tool for this wave.
  if (S.bonusWaveActive) {
    const sampleStep = 2.0;
    const sampleHitR = 1.0;
    for (let t = 0; t <= w.beamRange; t += sampleStep) {
      const sx = origin.x + dirX * t;
      const sz = origin.z + dirZ * t;
      damageHerdAt(sx, sz, sampleHitR);
    }
  }
  // Shielded hive sizzle. Independent of S.spawnerWaveActive because
  // shields can exist in waves 1-2 (before S.spawnerWaveActive flips
  // true in wave 3). If the beam corridor intersects a shielded hive,
  // spawn the deflect visual on the shield surface and play the sound.
  // The sound is gated via a module-level cooldown (_beamShieldSfxT)
  // so we don't stack 20 shieldHit calls per second at the beam's
  // 50ms tick cadence — once every 120ms is plenty.
  for (const [hive, shield] of hiveShieldsIter()) {
    if (!hive.shielded || shield.userData._dropping) continue;
    const dx = hive.pos.x - origin.x;
    const dz = hive.pos.z - origin.z;
    const along = dx * dirX + dz * dirZ;
    if (along < 0 || along > w.beamRange) continue;
    const perp = Math.abs(dx * dirZ - dz * dirX);
    // Perp check vs shield radius (3.8) instead of the smaller 2.0 used
    // for the inner-hive-hit path, since the shield is bigger.
    if (perp < 3.8) {
      const impactPos = new THREE.Vector3(
        origin.x + dirX * along,
        1.9,                                  // SHIELD_CENTER_Y
        origin.z + dirZ * along,
      );
      shieldHitVisual(hive, impactPos);
      const now = performance.now();
      if (now - _beamShieldSfxT > 120) {
        Audio.shieldHit();
        _beamShieldSfxT = now;
      }
    }
  }
  // Also damage portals along the beam (for spawner waves)
  if (S.spawnerWaveActive) {
    for (const s of spawners) {
      if (s.destroyed) continue;
      const dx = s.pos.x - origin.x;
      const dz = s.pos.z - origin.z;
      const along = dx * dirX + dz * dirZ;
      if (along < 0 || along > w.beamRange) continue;
      const perp = Math.abs(dx * dirZ - dz * dirX);
      if (perp < 2.0) {
        // Raygun hive damage: flat 0.5 per tick regardless of weapon
        // damage tuning. At 20 ticks/sec that's ~10 dps, so holding
        // the beam on a hive kills it in ~5 seconds — comparable to
        // ~50 pistol shots.
        damageSpawner(s, 0.5);
      }
    }
  }
  // Mining wave: the beam also damages blocks along its path.
  // Every beam tick deals 1 damage (so a 100hp block takes ~100 ticks at
  // 50ms cadence = ~5 seconds of sustained beam).
  if (S.miningActive) {
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block.falling) continue;
      const dx = block.pos.x - origin.x;
      const dz = block.pos.z - origin.z;
      const along = dx * dirX + dz * dirZ;
      if (along < 0 || along > w.beamRange) continue;
      const perp = Math.abs(dx * dirZ - dz * dirX);
      if (perp < 0.9 + w.beamWidth) {
        const hit = damageBlockAt(block.pos.x, block.pos.z, MINING_CONFIG.bulletDamageToBlock);
        if (hit && hit.destroyed) onBlockMined();
        // Only damage the first block the beam touches — blocks are opaque
        break;
      }
    }
  }
}

// ============================================================================
// FLAMETHROWER — short-range cone (wedge). Every fireRate tick, any enemy /
// hive / herd-pig / block inside a forward cone of length w.flameRange and
// half-angle w.flameAngle takes w.damage. Unlike the beam, there's no
// persistent mesh; the "flame" is just spray particles and hit-bursts.
// ============================================================================
function applyFlameDamage(w, dmgBoost) {
  const origin = new THREE.Vector3(player.pos.x, 1.3, player.pos.z);
  const dirX = Math.sin(player.facing);
  const dirZ = Math.cos(player.facing);
  const dmg = w.damage * dmgBoost;
  // cos of the half-angle is the dot-product threshold for "inside the cone".
  const cosHalf = Math.cos(w.flameAngle);
  const rangeSq = w.flameRange * w.flameRange;

  // Enemies: cone hit test. Does NOT penetrate (multiple enemies can be hit
  // in the same tick because flame engulfs them).
  for (let j = enemies.length - 1; j >= 0; j--) {
    const e = enemies[j];
    const dx = e.pos.x - origin.x;
    const dz = e.pos.z - origin.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > rangeSq) continue;
    const d = Math.sqrt(d2) || 0.0001;
    // Dot product of (enemy dir) and (facing dir) — must exceed cosHalf.
    const dot = (dx / d) * dirX + (dz / d) * dirZ;
    if (dot < cosHalf) continue;
    e.hp -= dmg;
    e.hitFlash = 0.15;
    // Every 3rd pass, spawn a flame lick at the enemy's feet for visual feedback.
    if (Math.random() < 0.55) {
      hitBurst(new THREE.Vector3(e.pos.x, 1.2, e.pos.z), 0xff5522, 2);
      hitBurst(new THREE.Vector3(e.pos.x, 1.5, e.pos.z), 0xffdd44, 2);
    }
    if (e.hp <= 0) killEnemy(j);
  }

  // Civilians in the cone — flame is indiscriminate, so civ hits are bad.
  for (let k = civilians.length - 1; k >= 0; k--) {
    const c = civilians[k];
    if (c.dead) continue;
    const dx = c.pos.x - origin.x;
    const dz = c.pos.z - origin.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > rangeSq) continue;
    const d = Math.sqrt(d2) || 0.0001;
    const dot = (dx / d) * dirX + (dz / d) * dirZ;
    if (dot < cosHalf) continue;
    damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
  }

  // Bonus wave (laser tag) — cone-sample pigs. Flame is a "wide-area tagger"
  // so it's friendly to the herd save objective. Uses the same cone test.
  if (S.bonusWaveActive) {
    // Sample along the cone centerline at 1.5u intervals, hit any pig within 1u.
    const sampleStep = 1.5;
    const sampleHitR = 1.0;
    for (let t = sampleStep; t <= w.flameRange; t += sampleStep) {
      const sx = origin.x + dirX * t;
      const sz = origin.z + dirZ * t;
      damageHerdAt(sx, sz, sampleHitR);
    }
  }

  // Hives (spawner wave) in the cone — same flat 0.5/tick as raygun.
  if (S.spawnerWaveActive) {
    for (const s of spawners) {
      if (s.destroyed) continue;
      const dx = s.pos.x - origin.x;
      const dz = s.pos.z - origin.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > rangeSq) continue;
      const d = Math.sqrt(d2) || 0.0001;
      const dot = (dx / d) * dirX + (dz / d) * dirZ;
      if (dot < cosHalf) continue;
      damageSpawner(s, 0.5);
    }
  }

  // Mining wave — flame also breaks blocks (first one hit per tick).
  if (S.miningActive) {
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block.falling) continue;
      const dx = block.pos.x - origin.x;
      const dz = block.pos.z - origin.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > rangeSq) continue;
      const d = Math.sqrt(d2) || 0.0001;
      const dot = (dx / d) * dirX + (dz / d) * dirZ;
      if (dot < cosHalf) continue;
      const hit = damageBlockAt(block.pos.x, block.pos.z, MINING_CONFIG.bulletDamageToBlock);
      if (hit && hit.destroyed) onBlockMined();
      break;
    }
  }
}

function pickHomingTarget() {
  // Nearest enemy in front of the player (within 90deg cone)
  const dirX = Math.sin(player.facing);
  const dirZ = Math.cos(player.facing);
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    const dx = e.pos.x - player.pos.x;
    const dz = e.pos.z - player.pos.z;
    const d = dx * dx + dz * dz;
    if (d > 900) continue;
    const along = dx * dirX + dz * dirZ;
    if (along < 0) continue;
    // 90deg cone: perp <= along
    const perp = Math.abs(dx * dirZ - dz * dirX);
    if (perp > along) continue;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// ============================================================================
// ROCKETS -- homing + explosion
// ============================================================================
function updateRockets(dt) {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    const ud = r.userData;
    ud.life -= dt;

    // Re-acquire target if current one is gone
    if (!ud.target || enemies.indexOf(ud.target) === -1) {
      // Find nearest
      let best = null, bestD = Infinity;
      for (const e of enemies) {
        const dx = e.pos.x - r.position.x;
        const dz = e.pos.z - r.position.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = e; }
      }
      ud.target = best;
    }

    // Steer toward target
    if (ud.target) {
      const desiredX = ud.target.pos.x - r.position.x;
      const desiredZ = ud.target.pos.z - r.position.z;
      const dLen = Math.sqrt(desiredX * desiredX + desiredZ * desiredZ) || 1;
      const desiredVX = (desiredX / dLen) * ud.speed;
      const desiredVZ = (desiredZ / dLen) * ud.speed;
      // Lerp velocity toward desired
      const t = Math.min(1, ud.homingStrength * dt);
      ud.vel.x += (desiredVX - ud.vel.x) * t;
      ud.vel.z += (desiredVZ - ud.vel.z) * t;
      // Normalize to speed
      const vlen = Math.sqrt(ud.vel.x * ud.vel.x + ud.vel.z * ud.vel.z) || 1;
      ud.vel.x = (ud.vel.x / vlen) * ud.speed;
      ud.vel.z = (ud.vel.z / vlen) * ud.speed;
    }

    const prevX = r.position.x, prevZ = r.position.z;
    r.position.x += ud.vel.x * dt;
    r.position.z += ud.vel.z * dt;
    // Face travel direction
    r.lookAt(r.position.x + ud.vel.x, r.position.y, r.position.z + ud.vel.z);

    // Trail puffs
    ud.trailTimer -= dt;
    if (ud.trailTimer <= 0) {
      ud.trailTimer = 0.03;
      hitBurst(new THREE.Vector3(r.position.x, r.position.y, r.position.z), ud.color, 2);
    }

    // Wall/edge/block/prop hit
    if (segmentBlocked(prevX, prevZ, r.position.x, r.position.z) ||
        segmentBlockedByProp(prevX, prevZ, r.position.x, r.position.z) ||
        ud.life <= 0 ||
        Math.abs(r.position.x) > ARENA || Math.abs(r.position.z) > ARENA) {
      explodeRocket(r);
      scene.remove(r);
      rockets.splice(i, 1);
      continue;
    }

    // Shielded hive hit — a rocket slamming into the shield detonates
    // ON the shield surface, not inside the hive. Triggers the normal
    // explodeRocket() AoE (which hits nearby enemies and particles),
    // plus a big shield flash + deflect sound. The shield itself
    // still absorbs the damage because damageSpawner() checks the
    // `shielded` flag and bails — explodeRocket() calls damageSpawner
    // for any hives in radius but they no-op.
    {
      const shieldedHive = getShieldedHiveAt(r.position.x, r.position.y, r.position.z);
      if (shieldedHive) {
        shieldHitVisual(shieldedHive, r.position.clone());
        Audio.shieldHit();
        explodeRocket(r);
        scene.remove(r);
        rockets.splice(i, 1);
        continue;
      }
    }

    // Civilian direct hit -- a homing rocket at a civilian is on you, not on physics
    let hit = false;
    for (let k = civilians.length - 1; k >= 0; k--) {
      const c = civilians[k];
      if (c.dead) continue;
      const dx = c.pos.x - r.position.x;
      const dz = c.pos.z - r.position.z;
      if (dx * dx + dz * dz < 1.4) {
        damageCivilianAt(c.pos.x, c.pos.z, 0.9, 'player', onCivilianKilled);
        explodeRocket(r);
        scene.remove(r);
        rockets.splice(i, 1);
        hit = true;
        break;
      }
    }
    if (hit) continue;

    // Bonus wave: rocket detonates on direct pig contact. The AoE in
    // explodeRocket() will then save every pig within the blast radius —
    // a well-aimed rocket can save an entire cluster in one shot.
    if (S.bonusWaveActive && damageHerdAt(r.position.x, r.position.z, 1.2)) {
      explodeRocket(r);
      scene.remove(r);
      rockets.splice(i, 1);
      continue;
    }

    // Enemy hit
    let hitEnemy = false;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const dx = e.pos.x - r.position.x;
      const dz = e.pos.z - r.position.z;
      const hitRange = e.bossHitRadius || (e.isBoss ? 2.2 : 1.1);
      if (dx * dx + dz * dz < hitRange) {
        // Direct damage
        e.hp -= ud.damage;
        e.hitFlash = 0.18;
        explodeRocket(r);
        scene.remove(r);
        rockets.splice(i, 1);
        if (e.hp <= 0) killEnemy(j);
        hitEnemy = true;
        break;
      }
    }
    if (hitEnemy) continue;
  }
}

function explodeRocket(r) {
  const ud = r.userData;
  const pos = r.position.clone();
  hitBurst(pos, 0xffffff, 18);
  setTimeout(() => hitBurst(pos, ud.color, 20), 40);
  setTimeout(() => hitBurst(pos, 0xff8800, 14), 100);
  shake(0.3, 0.25);
  Audio.bigBoom && Audio.bigBoom();
  // AoE
  const radius = ud.explosionRadius;
  for (let j = enemies.length - 1; j >= 0; j--) {
    const e = enemies[j];
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius) {
      e.hp -= ud.explosionDamage * (1 - Math.sqrt(d2) / radius);
      e.hitFlash = 0.15;
      if (e.hp <= 0) killEnemy(j);
    }
  }
  // AoE catches civilians too -- this is the big "watch your blast radius" moment
  for (let k = civilians.length - 1; k >= 0; k--) {
    const c = civilians[k];
    if (c.dead) continue;
    const dx = c.pos.x - pos.x;
    const dz = c.pos.z - pos.z;
    if (dx * dx + dz * dz < radius * radius) {
      damageCivilianAt(c.pos.x, c.pos.z, 0.5, 'player', onCivilianKilled);
    }
  }
  // Bonus wave: rocket explosion fully SAVES every pig in its blast radius
  // (3 damage each = instant save). Makes rockets the "crowd pleaser"
  // — one well-aimed rocket in the middle of a cluster saves 10+ pigs at once.
  if (S.bonusWaveActive) {
    for (let dmg = 0; dmg < 3; dmg++) {
      damageHerdAt(pos.x, pos.z, radius);
    }
  }
  // AoE can hurt portals too
  if (S.spawnerWaveActive) {
    for (const s of spawners) {
      if (s.destroyed) continue;
      const dx = s.pos.x - pos.x;
      const dz = s.pos.z - pos.z;
      if (dx * dx + dz * dz < radius * radius) {
        // Cap rocket-to-hive damage at 10 so a rocket isn't an instant
        // hive-kill button. Still a meaningful chunk (20% of hive HP).
        damageSpawner(s, 10);
      }
    }
  }
  // Mining wave: rocket AoE cracks blocks fast — great for clearing a cluster.
  // Deal 25 damage per block within radius (so a rocket cracks a block in
  // ~4 hits instead of 100, making rockets a viable fast-mine tool).
  if (S.miningActive) {
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block.falling) continue;
      const dx = block.pos.x - pos.x;
      const dz = block.pos.z - pos.z;
      if (dx * dx + dz * dz < radius * radius) {
        const hit = damageBlockAt(block.pos.x, block.pos.z, 25);
        if (hit && hit.destroyed) onBlockMined();
      }
    }
  }
}

// ============================================================================
// GRENADE -- ballistic arc throw, fuse detonate, big AoE
// ============================================================================
// Reuses explodeRocket for the AoE payload (same enemy/civilian/spawner/block
// damage lists — grenades and rockets both boom the same way). The only
// thing that differs is the physics and visuals: a grenade is a tumbling
// sphere on a gravity arc, a rocket is a guided missile on a flat path.

const GRENADE_GRAVITY = 22;    // m/s^2 — snappy feel
const _grenades = [];

function tryThrowGrenade() {
  if (!S.running || S.paused) return;
  if (isBossCinematicActive()) return;
  if (!player.ready) return;
  if (S.grenadeCooldown > 0) return;
  if ((S.grenadeCharges || 0) <= 0) {
    UI.toast('NO GRENADES', '#ff2e4d', 900);
    return;
  }
  const w = WEAPONS.grenade;
  S.grenadeCharges -= 1;
  S.grenadeCooldown = w.fireRate;
  _syncGrenadeHUD();

  const origin = new THREE.Vector3(
    player.pos.x + Math.sin(player.facing) * 0.8,
    1.5,
    player.pos.z + Math.cos(player.facing) * 0.8,
  );
  const geo = new THREE.IcosahedronGeometry(0.22, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2b3d1e, emissive: w.color, emissiveIntensity: 1.4,
    roughness: 0.5, metalness: 0.3,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.position.copy(origin);
  const trailLight = new THREE.PointLight(w.color, 1.4, 4, 2);
  mesh.add(trailLight);

  const vx = Math.sin(player.facing) * w.speed;
  const vz = Math.cos(player.facing) * w.speed;
  const vy = w.arc;
  mesh.userData = {
    vel: new THREE.Vector3(vx, vy, vz),
    life: w.fuse,
    bounces: 0,
    color: w.color,
    explosionRadius: w.explosionRadius,
    explosionDamage: w.explosionDamage,
    spin: new THREE.Vector3(
      Math.random() * 6 - 3,
      Math.random() * 6 - 3,
      Math.random() * 6 - 3,
    ),
  };
  scene.add(mesh);
  _grenades.push(mesh);
  Audio.shot && Audio.shot('shotgun');   // throwing thump — reuses shotgun sfx
}

function updateGrenades(dt) {
  if (S.grenadeCooldown > 0) S.grenadeCooldown = Math.max(0, S.grenadeCooldown - dt);

  for (let i = _grenades.length - 1; i >= 0; i--) {
    const g = _grenades[i];
    const ud = g.userData;
    ud.life -= dt;

    // Tumble visual
    g.rotation.x += ud.spin.x * dt;
    g.rotation.y += ud.spin.y * dt;
    g.rotation.z += ud.spin.z * dt;

    // Gravity + integrate
    ud.vel.y -= GRENADE_GRAVITY * dt;
    g.position.x += ud.vel.x * dt;
    g.position.y += ud.vel.y * dt;
    g.position.z += ud.vel.z * dt;

    // Ground bounce (up to 2 bounces, then detonate on next contact)
    if (g.position.y < 0.22) {
      g.position.y = 0.22;
      if (ud.bounces < 2 && ud.life > 0.15) {
        ud.vel.y = Math.abs(ud.vel.y) * 0.45;       // lose energy
        ud.vel.x *= 0.55;
        ud.vel.z *= 0.55;
        ud.bounces += 1;
      } else {
        _detonateGrenade(g);
        scene.remove(g);
        _grenades.splice(i, 1);
        continue;
      }
    }

    // Arena clamp (explode if we'd leave)
    const lim = ARENA - 0.5;
    if (g.position.x > lim || g.position.x < -lim || g.position.z > lim || g.position.z < -lim) {
      _detonateGrenade(g);
      scene.remove(g);
      _grenades.splice(i, 1);
      continue;
    }

    // Fuse expired — detonate mid-air
    if (ud.life <= 0) {
      _detonateGrenade(g);
      scene.remove(g);
      _grenades.splice(i, 1);
      continue;
    }
  }
}

function _detonateGrenade(g) {
  // Reuse explodeRocket's AoE by shaping the grenade's userData the same
  // way. explodeRocket reads `explosionRadius`, `explosionDamage`, `color`.
  explodeRocket(g);
}

function _syncGrenadeHUD() {
  const el = document.querySelector('.slot[data-slot="grenade"] .label');
  if (el) el.textContent = `GRENADE (${S.grenadeCharges || 0})`;
  const slot = document.querySelector('.slot[data-slot="grenade"]');
  if (slot) {
    slot.classList.toggle('owned', (S.grenadeCharges || 0) > 0);
  }
}

// Restock grenades on every new wave (and on game start).
export function refillGrenades() {
  S.grenadeCharges = WEAPONS.grenade.maxCharges;
  S.grenadeCooldown = 0;
  _syncGrenadeHUD();
}

// ============================================================================
// MINING
// ============================================================================
function tryMine() {
  const w = WEAPONS.pickaxe;
  const ax = player.pos.x + Math.sin(player.facing) * 0.8;
  const az = player.pos.z + Math.cos(player.facing) * 0.8;
  const target = findNearestBlock(ax, az, w.reach);
  S.fireCooldown = w.fireRate;
  S.recoilTimer = 0.08;
  shake(0.1, 0.08);
  Audio.shot('pickaxe');
  if (target) {
    const destroyed = damageBlock(target, w.damage * (S.damageBoost || 1));
    if (destroyed) onBlockMined();
  }
}

function updateCamera(dt) {
  camAnchor.set(player.pos.x + CAMERA_OFFSET.x, CAMERA_OFFSET.y, player.pos.z + CAMERA_OFFSET.z);
  camera.position.lerp(camAnchor, Math.min(1, dt * 5));
  if (S.shakeAmt > 0) {
    camera.position.x += (Math.random() - 0.5) * S.shakeAmt;
    camera.position.y += (Math.random() - 0.5) * S.shakeAmt * 0.5;
    camera.position.z += (Math.random() - 0.5) * S.shakeAmt;
  }
  camera.lookAt(player.pos.x, 0.8, player.pos.z);
}

// ============================================================================
// ENEMIES -- includes vampire blink, wizard triangle proj, goo spitter etc.
// ============================================================================
function updateEnemies(dt) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const dx = player.pos.x - e.pos.x;
    const dz = player.pos.z - e.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Phasing (ghost/phantom)
    if (e.phases) {
      e.phaseTimer -= dt;
      if (e.phaseTimer <= 0) {
        e.phaseTimer = 2 + Math.random() * 2;
        if (e.body) e.body.visible = !e.body.visible;
      }
    }

    // Vampire blink -- teleport closer to the player
    if (e.blinks) {
      e.blinkTimer -= dt;
      if (e.blinkTimer <= 0 && dist > 5) {
        e.blinkTimer = e.blinkInterval + Math.random() * 1.5;
        // Pick a point closer to the player
        const ang = Math.atan2(dx, dz) + (Math.random() - 0.5) * 0.8;
        const targetDist = Math.max(4, dist - e.blinkRange);
        const newX = player.pos.x - Math.sin(ang) * targetDist;
        const newZ = player.pos.z - Math.cos(ang) * targetDist;
        // Fade-out burst at old position
        hitBurst(new THREE.Vector3(e.pos.x, 1.8, e.pos.z), 0xff2e4d, 12);
        // Move
        e.pos.x = Math.max(-46, Math.min(46, newX));
        e.pos.z = Math.max(-46, Math.min(46, newZ));
        // Fade-in burst at new position
        hitBurst(new THREE.Vector3(e.pos.x, 1.8, e.pos.z), 0xff2e4d, 12);
      }
    }

    if (e.isFloater) {
      e.floatPhase = (e.floatPhase || 0) + dt * 2.5;
      e.obj.position.y = Math.sin(e.floatPhase) * 0.25;
      if (e.ghostTail) {
        for (let k = 0; k < e.ghostTail.length; k++) {
          e.ghostTail[k].position.x = Math.sin(e.floatPhase + k * 0.7) * 0.15;
        }
      }
    }

    if (e.isSpider && e.spiderLegs) {
      e.walkPhase = (e.walkPhase || 0) + dt * 18;
      for (let k = 0; k < e.spiderLegs.length; k++) {
        const leg = e.spiderLegs[k];
        leg.rotation.x = Math.sin(e.walkPhase + k * 0.8) * 0.5;
      }
    }

    let moveTargetX = player.pos.x, moveTargetZ = player.pos.z;
    if (S.rescueMeebit && !S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      const cx = S.rescueMeebit.pos.x, cz = S.rescueMeebit.pos.z;
      const cdx = cx - e.pos.x, cdz = cz - e.pos.z;
      const cd2 = cdx * cdx + cdz * cdz;
      if (cd2 < dist * dist * 0.9) {
        moveTargetX = cx; moveTargetZ = cz;
      }
    }
    // CHAPTER 2 ESCORT — enemies are split between targeting player
    // and targeting the truck. Half-and-half feels right: some swarm
    // the convoy (creating the bumper-blocking pressure), others
    // chase the player (so you can't ignore them while you walk).
    // Stable parity-based split using a hashed assignment that
    // sticks to the enemy for its lifetime.
    if (S.isEscortWave) {
      const tp = getTruckPos();
      if (tp) {
        if (e._escortTarget === undefined) {
          // Assign once. Use enemy y-pos byte + x-pos byte as a stable hash.
          // ~50/50 split.
          e._escortTarget = ((Math.floor(e.pos.x * 13) + Math.floor(e.pos.z * 7)) & 1) === 0 ? 'truck' : 'player';
        }
        if (e._escortTarget === 'truck') {
          moveTargetX = tp.x;
          moveTargetZ = tp.z;
        }
      }
    }
    const mdx = moveTargetX - e.pos.x;
    const mdz = moveTargetZ - e.pos.z;
    const mdist = Math.sqrt(mdx * mdx + mdz * mdz) || 0.01;

    let shouldMove = true;
    if (e.ranged && dist < e.range) shouldMove = false;
    // VESSEL ZERO is stationary — she doesn't chase, she spawns the
    // flood and lets it reach the player. Skip movement + hazard repel.
    if (e.stationary) shouldMove = false;
    if (shouldMove) {
      // Apply poison-trail slow (or 1.0 if not poisoned / not picked).
      const speedMult = getEnemySpeedMult(e);
      e.pos.x += (mdx / mdist) * e.speed * speedMult * dt;
      e.pos.z += (mdz / mdist) * e.speed * speedMult * dt;
    }
    if (!e.isBoss) {
      resolveCollision(e.pos, 0.5);
      // Enemies also can't walk through the silo or turrets. Bosses skip
      // this — they have their own scripted movement / patterns.
      resolveCompoundCollision(e.pos, 0.5);
    }
    // Push the enemy out of any floor-hazard it overlaps. Bosses are
    // too big to path around them, so they take the lava (narratively
    // they're angry enough to stomp through it).
    if (!e.isBoss) repelEnemyFromHazards(e, dt);
    e.obj.rotation.y = Math.atan2(mdx, mdz);

    if (shouldMove && !e.isFloater && !e.isSpider) {
      e.walkPhase += dt * (e.isBoss ? 4 : 6);
      const sw = Math.sin(e.walkPhase) * (e.isBoss ? 0.3 : 0.5);
      if (e.legL) e.legL.rotation.x = sw;
      if (e.legR) e.legR.rotation.x = -sw;
      if (e.armL) e.armL.rotation.x = -sw * 0.6;
      if (e.armR) e.armR.rotation.x = sw * 0.6;
    }

    if (e.hitFlash > 0) {
      // For blinkOnHit enemies (mega_brute), the hit-flash decays at
      // 1/3 speed so each hit creates a noticeably long white blink —
      // visual feedback that big bullet-sponges are taking damage.
      // Also raises peak emissive to read as a true "blink."
      const decayRate = e.blinkOnHit ? 0.33 : 1.0;
      e.hitFlash -= dt * decayRate;
      if (e.bodyMat) {
        e.bodyMat.emissive && e.bodyMat.emissive.setHex(0xffffff);
        const peakMult = e.blinkOnHit ? 5.0 : 3.0;
        e.bodyMat.emissiveIntensity = e.hitFlash * peakMult;
      }
    } else if (e.bodyMat) {
      e.bodyMat.emissiveIntensity = e.isBoss ? 0.15 : (e.bodyMat.userData?.baseEmissive || 0);
    }

    // Ranged attacks — per-chapter throttle multiplier slows down
    // projectile-spam chapters (2/3/4). See getChapterRangedMult in config.js.
    // Per-chapter RANGE multiplier (getChapterRangedRangeMult) shrinks
    // the firing radius for SOLAR/TOXIC so enemies can't snipe from
    // offscreen when those chapters' floor hazards already crowd the
    // visible area. Bosses ignore the range mult — they fire at full
    // distance regardless of chapter.
    if (e.ranged) {
      e.rangedCooldown -= dt;
      const rangeMult = e.isBoss ? 1.0 : getChapterRangedRangeMult(S.chapter);
      const effectiveRange = e.range * rangeMult;
      if (e.rangedCooldown <= 0 && dist < effectiveRange) {
        if (!segmentBlocked(e.pos.x, e.pos.z, player.pos.x, player.pos.z)
            && !segmentBlockedByProp(e.pos.x, e.pos.z, player.pos.x, player.pos.z)) {
          const chMult = e.isBoss ? 1.0 : getChapterRangedMult(S.chapter);
          e.rangedCooldown = (e.isBoss ? 1.2 : 2.2) * chMult;
          const projColor = e.fireballColor || (e.isBoss ? 0xff2e4d : 0x00ff66);
          let projType = 'box';
          if (e.projType === 'triangle') projType = 'triangle';
          else if (e.type === 'red_devil' || e.type === 'goospitter') projType = 'fireball';
          const speed = e.isBoss ? 20 : 15;
          spawnEnemyProjectile(e.pos, player.pos, speed, e.damage, projColor, projType);
        } else {
          e.rangedCooldown = 0.5;
        }
      }
    }

    if (e.touchCooldown > 0) e.touchCooldown -= dt;

    if (!e.isBoss) {
      for (let j = i - 1; j >= 0 && j > i - 6; j--) {
        const o = enemies[j];
        if (o.isBoss) continue;
        const ex = o.pos.x - e.pos.x;
        const ez = o.pos.z - e.pos.z;
        const ed = ex * ex + ez * ez;
        if (ed < 1.4 && ed > 0.001) {
          const push = 0.04;
          e.pos.x -= ex * push; e.pos.z -= ez * push;
          o.pos.x += ex * push; o.pos.z += ez * push;
        }
      }
    }

    const touchRange = e.bossHitRadius || (e.isBoss ? 2.5 : 1.3);
    // Dormant enemies (Vessel Zero before wake-up) don't deal contact
    // damage. The player can stand right next to her and chip her HP
    // down to the wake threshold. Skipping the damage block entirely
    // also avoids triggering the 0.6s invuln cooldown which would
    // otherwise still fire even though no damage was dealt.
    if (e.dormant) continue;
    if (dist < touchRange && e.touchCooldown <= 0) {
      if (S.invulnTimer <= 0 && !S.overdriveActive) {
        if (S.shields > 0) {
          S.shields -= 1;
          UI.toast('SHIELD ABSORBED', '#e63aff');
        } else {
          S.hp -= e.damage;
          _takePlayerDamageVfx(0.25, 0.2);
        }
        S.invulnTimer = 0.6;
        e.touchCooldown = 0.8;
        if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); return; }
      }
    }
  }
}

// ============================================================================
// BULLETS
// ============================================================================
function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const prevX = b.position.x, prevZ = b.position.z;
    b.position.addScaledVector(b.userData.vel, dt);
    b.userData.life -= dt;
    b.lookAt(b.position.x + b.userData.vel.x, b.position.y, b.position.z + b.userData.vel.z);

    if (segmentBlocked(prevX, prevZ, b.position.x, b.position.z)) {
      // During mining waves, a bullet hitting a grounded block deals 1 damage
      // (Option A: every bullet = 1 hit, so 100 bullets = one cracked block).
      // Outside mining waves, blocks just absorb bullets as cover.
      if (S.miningActive) {
        const hit = damageBlockAt(b.position.x, b.position.z, MINING_CONFIG.bulletDamageToBlock);
        if (hit && hit.destroyed) onBlockMined();
      }
      hitBurst(b.position, 0xffffff, 3);
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    // Prop block — bullets despawn on silo/turret/depot/powerplant/radio
    // without damaging them (props are indestructible cover).
    if (segmentBlockedByProp(prevX, prevZ, b.position.x, b.position.z)) {
      hitBurst(b.position, 0xffffff, 3);
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    if (b.userData.life <= 0 || Math.abs(b.position.x) > ARENA || Math.abs(b.position.z) > ARENA) {
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    // Shielded-hive deflect. Checked BEFORE the main spawner hit below
    // so bullets collide with the big shield sphere (radius 3.8) rather
    // than flying through it to the small inner hive collision. During
    // waves 1-2 when shields are intact, this absorbs every shot on
    // the hives. During wave 3 after shields drop, getShieldedHiveAt
    // returns null and bullets fall through to the normal hit path.
    {
      // CHAPTER 1 — queen cluster outer dome (13u radius). This sits
      // OUTSIDE the per-hive 3.8u shield bubbles, so bullets that fly
      // into the cluster from any angle hit the outer dome first.
      // tryHitQueenShield returns true once and consumes the bullet.
      // No-op for chapters 2-7 (no domes spawned).
      if (tryHitQueenShield(b.position)) {
        Audio.shieldHit();
        scene.remove(b); bullets.splice(i, 1); continue;
      }
      const shieldedHive = getShieldedHiveAt(b.position.x, b.position.y, b.position.z);
      if (shieldedHive) {
        shieldHitVisual(shieldedHive, b.position.clone());
        Audio.shieldHit();
        scene.remove(b); bullets.splice(i, 1); continue;
      }
    }
    if (S.spawnerWaveActive) {
      let portalHit = null;
      for (const s of spawners) {
        if (s.destroyed) continue;
        const dx = s.pos.x - b.position.x;
        const dz = s.pos.z - b.position.z;
        if (dx * dx + dz * dz < 3.5) { portalHit = s; break; }
      }
      if (portalHit) {
        // Hives take fixed 1-damage per bullet regardless of weapon,
        // so "50 shots to kill a hive" is predictable and doesn't
        // trivialize with high-damage weapons. Matches the mining
        // block pattern (25 shots, 1 dmg each).
        damageSpawner(portalHit, 1);
        Audio.hit();
        scene.remove(b); bullets.splice(i, 1); continue;
      }
    }
    // Civilian hit -- checked BEFORE enemies so stray bullets don't pass through
    if (damageCivilianAt(b.position.x, b.position.z, 0.9, 'player', onCivilianKilled)) {
      hitBurst(b.position, 0xff2e4d, 6);
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    // Bonus wave herd hit — shot deals 1 damage to any pig within 0.9u.
    // damageHerdAt is a no-op when S.bonusWaveActive is false.
    if (S.bonusWaveActive && damageHerdAt(b.position.x, b.position.z, 0.9)) {
      hitBurst(b.position, 0xffd93d, 6);
      scene.remove(b); bullets.splice(i, 1); continue;
    }
    // Galaga bug hit (chapter 2). The bug pool only contains bugs
    // when the active hazard style is Galaga; on other chapters
    // getBugs() returns an empty list, so this loop is a cheap noop.
    // We only check bugs in non-ASCENDING phases (the ASCENDING ones
    // already placed their tile and can't be saved). Each player
    // bullet does 1 damage to a bug — same as the Galaga ship's
    // bullets — so 3 player shots will kill a fresh bug. Player
    // shots through enemies are checked AFTER bugs so a bug
    // standing in front of an enemy correctly absorbs the shot.
    {
      let hitBug = false;
      const bugs = galagaStyle.getBugs ? galagaStyle.getBugs() : null;
      if (bugs && bugs.length) {
        const HIT_R = 1.0;
        const HIT_R_SQ = HIT_R * HIT_R;
        for (const bug of bugs) {
          if (bug.phase === 'ASCENDING') continue;
          const bp = galagaStyle.getBugPos(bug);
          if (!bp) continue;
          const dx = bp.x - b.position.x;
          const dy = bp.y - b.position.y;
          const dz = bp.z - b.position.z;
          if (dx * dx + dy * dy + dz * dz < HIT_R_SQ) {
            galagaStyle.applyBugDamage(bug, 1);
            hitBug = true;
            break;
          }
        }
      }
      if (hitBug) {
        scene.remove(b); bullets.splice(i, 1); continue;
      }
    }
    let hitEnemy = false;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const hitRange = e.bossHitRadius || (e.isBoss ? 2.2 : 0.95);
      const dx = e.pos.x - b.position.x;
      const dz = e.pos.z - b.position.z;
      if (dx*dx + dz*dz < hitRange) {
        e.hp -= b.userData.damage;
        e.hitFlash = 0.15;
        hitBurst(b.position, 0xffffff, 4);
        Audio.hit();
        scene.remove(b);
        bullets.splice(i, 1);
        if (e.hp <= 0) killEnemy(j);
        hitEnemy = true;
        break;
      }
    }
    if (hitEnemy) continue;
  }
}

// ============================================================================
// BOSS CUBES -- fall, land, hatch or explode
// ============================================================================
function updateBossCubes(dt) {
  for (let i = bossCubes.length - 1; i >= 0; i--) {
    const c = bossCubes[i];
    if (!c.landed) {
      c.pos.y -= c.fallSpeed * dt;
      c.mesh.rotation.x += dt * 3;
      c.mesh.rotation.y += dt * 2;
      // Pulse ring as the cube approaches
      const h = c.pos.y;
      const s = 1 + Math.sin(S.timeElapsed * 12) * 0.12;
      c.ring.scale.setScalar(s);
      if (h <= 0.9) {
        c.pos.y = 0.9;
        c.landed = true;
        c.mesh.rotation.x = 0;
        shake(0.22, 0.2);
        hitBurst(new THREE.Vector3(c.pos.x, 0.5, c.pos.z), c.tintHex, 14);
      }
    } else {
      c.fuseTimer -= dt;
      // Flash before activating
      const flash = c.fuseTimer < 0.4 ? (Math.sin(S.timeElapsed * 30) > 0 ? 1 : 0.2) : 1;
      c.ringMat.opacity = 0.7 * flash;
      if (c.fuseTimer <= 0) {
        if (c.mode === 'explode') {
          // Damage player if within radius
          const pos = new THREE.Vector3(c.pos.x, 1, c.pos.z);
          const dx = player.pos.x - c.pos.x;
          const dz = player.pos.z - c.pos.z;
          const r = 2.5;
          if (dx * dx + dz * dz < r * r) {
            if (S.invulnTimer <= 0 && !S.overdriveActive) {
              if (S.shields > 0) { S.shields -= 1; UI.toast('SHIELD ABSORBED', '#e63aff'); }
              else { S.hp -= 25; _takePlayerDamageVfx(0.3, 0.25); }
              S.invulnTimer = 0.5;
              if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); return; }
            }
          }
          hitBurst(pos, 0xff2e4d, 24);
          setTimeout(() => hitBurst(pos, 0xffee00, 18), 60);
          shake(0.4, 0.3);
          Audio.bigBoom && Audio.bigBoom();
          // AoE can damage enemies too (friendly fire from the boss's own cubes!)
          for (let j = enemies.length - 1; j >= 0; j--) {
            const e = enemies[j];
            if (e.isBoss) continue;
            const edx = e.pos.x - c.pos.x;
            const edz = e.pos.z - c.pos.z;
            if (edx * edx + edz * edz < r * r) {
              e.hp -= 40; e.hitFlash = 0.2;
              if (e.hp <= 0) killEnemy(j);
            }
          }
        } else {
          // HATCH -- spawn an enemy
          hitBurst(new THREE.Vector3(c.pos.x, 1.2, c.pos.z), c.tintHex, 18);
          const chapterIdx = S.chapter % CHAPTERS.length;
          let type = 'zomeeb';
          if (chapterIdx === 0) type = Math.random() < 0.5 ? 'pumpkin' : 'sprinter';
          else if (chapterIdx === 1) type = Math.random() < 0.5 ? 'vampire' : 'red_devil';
          else if (chapterIdx === 2) type = Math.random() < 0.6 ? 'wizard' : 'sprinter';
          else if (chapterIdx === 3) type = Math.random() < 0.6 ? 'goospitter' : 'sprinter';
          else type = 'sprinter';
          makeEnemy(type, c.tintHex, new THREE.Vector3(c.pos.x, 0, c.pos.z));
        }
        scene.remove(c.mesh);
        scene.remove(c.ring);
        bossCubes.splice(i, 1);
      }
    }
  }
}

// ============================================================================
// KILLSTREAK
// ============================================================================
// Chains kills that happen within KILLSTREAK_WINDOW seconds of each other.
// Each consecutive kill resets the timer back to KILLSTREAK_WINDOW; if the
// timer expires without another kill, the streak resets to 0.
//
// HUD display lives in updateHUD(); this module just maintains the state.
// _bumpKillstreak() is called from killEnemy + the AoE chain, _tickKillstreak()
// is called every frame with dt.
const KILLSTREAK_WINDOW = 1.0;

// Overdrive tuning constants. Duration 8 seconds — long enough to
// wade through 3-5 crowds and smash a hive or two, short enough that
// it doesn't trivialize a whole wave. Scale 2.5x — visibly larger
// without breaking the camera framing. Crush radius scales with the
// player's current overdrive scale so growing/shrinking transitions
// look right (not just a binary on/off radius).
const OVERDRIVE_DURATION = 8.0;
const OVERDRIVE_TARGET_SCALE = 2.5;
const OVERDRIVE_RAMP_TIME = 0.4;       // ease in/out over 0.4s each end
const OVERDRIVE_BASE_CRUSH_R = 1.6;    // multiplied by current scale
const OVERDRIVE_HIVE_DPS = 60;         // hive damage per second of contact
const OVERDRIVE_TRIGGER_STREAK = 100;  // streak count to enter overdrive

function bumpKillstreak() {
  S.killstreak = (S.killstreak || 0) + 1;
  S.killstreakTimer = KILLSTREAK_WINDOW;
  if (S.killstreak > (S.killstreakBest || 0)) {
    S.killstreakBest = S.killstreak;
  }
  // Overdrive trigger — one-shot per streak. The triggered flag is
  // reset when the streak drops back to 0, so breaking and rebuilding
  // a 100-streak earns another overdrive.
  if (S.killstreak >= OVERDRIVE_TRIGGER_STREAK
      && !S.overdriveTriggeredThisStreak
      && !S.overdriveActive) {
    enterOverdrive();
  }
}

function tickKillstreak(dt) {
  if (S.killstreakTimer > 0) {
    S.killstreakTimer -= dt;
    if (S.killstreakTimer <= 0) {
      // Window expired — reset the streak. Don't touch killstreakBest.
      S.killstreak = 0;
      S.killstreakTimer = 0;
      // Overdrive can be re-earned by rebuilding a 100-streak from 0.
      S.overdriveTriggeredThisStreak = false;
    }
  }
}

// ============================================================================
// OVERDRIVE — 100-streak power state
// ============================================================================
// Earned by hitting a 100x killstreak. For 8 seconds the player:
//   • scales up to 2.5× (visibly looms over enemies)
//   • is invulnerable to projectile + contact damage (gated in damage sites)
//   • crushes any non-boss enemy they walk over (radius ~ 4u at full scale)
//   • damages hives by walking on them (60 dps)
//   • is highlighted by a pulsing golden additive glow sphere
//
// Bosses are immune to crush. The state is one-shot per killstreak —
// breaking the streak (1s of no kills) and rebuilding to 100 earns
// another overdrive.

let _overdriveGlowMesh = null;
let _overdriveGlowMat = null;

function _ensureOverdriveGlow() {
  if (_overdriveGlowMesh) return;
  _overdriveGlowMat = new THREE.MeshBasicMaterial({
    color: 0xffd060,
    transparent: true,
    opacity: 0.65,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  _overdriveGlowMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 18, 14),
    _overdriveGlowMat,
  );
  _overdriveGlowMesh.visible = false;
  _overdriveGlowMesh.frustumCulled = false;
  scene.add(_overdriveGlowMesh);
}

function enterOverdrive() {
  S.overdriveActive = true;
  S.overdriveTimer = OVERDRIVE_DURATION;
  S.overdriveTriggeredThisStreak = true;
  // overdriveScale starts at 1 and ramps to 2.5 in updateOverdrive.
  S.overdriveScale = 1;
  _ensureOverdriveGlow();
  if (_overdriveGlowMesh) _overdriveGlowMesh.visible = true;
  shake(0.8, 0.5);
  try { Audio.shot('rocket'); } catch (e) {}
  UI.toast('⚡ OVERDRIVE ⚡', '#ffd060', 2500);
}

function exitOverdrive() {
  S.overdriveActive = false;
  S.overdriveTimer = 0;
  S.overdriveScale = 1;
  if (_overdriveGlowMesh) _overdriveGlowMesh.visible = false;
  // Restore player scale to 1 explicitly — updateOverdrive normally
  // animates scale back during the last 0.4s, but clear it here in
  // case overdrive ended via game reset rather than timer expiry.
  if (player.obj) player.obj.scale.set(1, 1, 1);
  UI.toast('OVERDRIVE ENDED', '#ffaa00', 1200);
}

function updateOverdrive(dt) {
  if (!S.overdriveActive) {
    // Make sure the glow is hidden if for some reason a stale visible
    // state lingers from a previous run.
    if (_overdriveGlowMesh && _overdriveGlowMesh.visible) {
      _overdriveGlowMesh.visible = false;
    }
    return;
  }
  S.overdriveTimer -= dt;
  if (S.overdriveTimer <= 0) {
    exitOverdrive();
    return;
  }

  // Compute current scale from timer position. Ramp UP during the
  // first OVERDRIVE_RAMP_TIME, ramp DOWN during the last
  // OVERDRIVE_RAMP_TIME, hold full in the middle.
  const timeIn = OVERDRIVE_DURATION - S.overdriveTimer;     // 0 .. duration
  let scale;
  if (timeIn < OVERDRIVE_RAMP_TIME) {
    // Easing in
    const t = timeIn / OVERDRIVE_RAMP_TIME;
    scale = 1 + (OVERDRIVE_TARGET_SCALE - 1) * (t * t * (3 - 2 * t));    // smoothstep
  } else if (S.overdriveTimer < OVERDRIVE_RAMP_TIME) {
    // Easing out
    const t = S.overdriveTimer / OVERDRIVE_RAMP_TIME;
    scale = 1 + (OVERDRIVE_TARGET_SCALE - 1) * (t * t * (3 - 2 * t));
  } else {
    scale = OVERDRIVE_TARGET_SCALE;
  }
  S.overdriveScale = scale;
  if (player.obj) player.obj.scale.set(scale, scale, scale);

  // Glow sphere — pulses scale + opacity on top of the player's
  // current scale so it always looks larger than the player itself.
  if (_overdriveGlowMesh && player.obj) {
    const pulse = 0.92 + Math.sin(S.timeElapsed * 12) * 0.08;
    const r = scale * 1.4 * pulse;
    _overdriveGlowMesh.scale.set(r, r, r);
    _overdriveGlowMesh.position.set(player.pos.x, 1.0, player.pos.z);
    _overdriveGlowMat.opacity = 0.4 + Math.sin(S.timeElapsed * 8) * 0.15;
  }

  // ---- CRUSH SWEEP ----
  // Each frame, scan enemies within the crush radius. Non-bosses die.
  // Hives take damage proportional to dt. Bosses are skipped.
  // Iterate backward because killEnemy splices.
  const crushR = OVERDRIVE_BASE_CRUSH_R * scale;
  const crushR2 = crushR * crushR;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || !e.pos) continue;
    if (e.isBoss) continue;       // bosses immune
    const dx = e.pos.x - player.pos.x;
    const dz = e.pos.z - player.pos.z;
    if (dx * dx + dz * dz > crushR2) continue;
    if (e.isHive) {
      // Hives don't die in one tick — apply continuous DPS so the
      // player has to stand on/near them for ~1 second to kill one.
      e.hp -= OVERDRIVE_HIVE_DPS * dt;
      e.hitFlash = Math.max(e.hitFlash || 0, 0.1);
      if (e.hp <= 0) killEnemy(i);
      continue;
    }
    // Non-boss enemy in crush radius — instant kill.
    // killEnemy bumps the streak via its existing path so combo grows.
    hitBurst({ x: e.pos.x, y: 1.0, z: e.pos.z }, 0xffd060, 8);
    killEnemy(i);
  }
}

// killEnemyByRef — wrapper for callers that have an enemy reference
// but not its index (e.g. lifedrainer). Finds the index lazily and
// delegates. Returns true if the enemy was found and killed.
function killEnemyByRef(e) {
  const idx = enemies.indexOf(e);
  if (idx < 0) return false;
  killEnemy(idx);
  return true;
}

// Consolidated player-damage VFX. Called whenever the player loses HP
// from any source. Dedupes within a single frame: multiple damage
// events landing on the same animate() tick play their flash/shake/
// sound only ONCE. This was historically a source of perceptible
// hitching when a goo splat + contact + stray projectile all landed
// the same frame — three damage flashes + three shake calls + three
// audio beeps inside ~16ms is a lot. Now: one of each, max.
//
// Caller is still responsible for the actual S.hp -= damage and
// invuln-timer set. This helper is JUST the audio+visual layer.
function _takePlayerDamageVfx(shakeAmt, shakeDur) {
  if (S._damageVfxThisFrame) return;
  S._damageVfxThisFrame = true;
  S._damageVfxFiredAt = performance.now();
  UI.damageFlash();
  Audio.damage();
  shake(shakeAmt, shakeDur);
}

// ============================================================================
// KILL ENEMY -- handles pumpkin AoE, goo splat drop
// ============================================================================
function killEnemy(idx) {
  const e = enemies[idx];
  // Arc chain lightning off the kill if the player picked that card.
  // No-op if chainLightning stack is 0. Fires BEFORE we remove the
  // enemy so the arc can visually originate from their last position.
  chainLightningOnKill(e);

  _tmpV.copy(e.pos); _tmpV.y = 1;
  const inZone = isInCaptureZone(e.pos);
  hitBurst(_tmpV, 0xff3cac, e.isBoss ? 20 : 8);
  Audio.kill();
  shake(e.isBoss ? 0.5 : 0.15, e.isBoss ? 0.4 : 0.15);

  if (e.isExplosive) {
    const epos = e.pos.clone();
    hitBurst(epos, 0xff8800, 24);
    setTimeout(() => hitBurst(epos, 0xffee00, 16), 50);
    shake(0.3, 0.2);
    const AOE = 3.5;
    for (let k = enemies.length - 1; k >= 0; k--) {
      if (k === idx) continue;
      const other = enemies[k];
      const odx = other.pos.x - epos.x;
      const odz = other.pos.z - epos.z;
      if (odx * odx + odz * odz < AOE * AOE) {
        other.hp -= 40;
        other.hitFlash = 0.2;
        if (other.hp <= 0 && k > idx) {
          const otherPos = other.pos.clone(); otherPos.y = 1;
          hitBurst(otherPos, 0xff3cac, 6);
          scene.remove(other.obj);
          enemies.splice(k, 1);
          S.kills++;
          S.score += other.scoreVal;
          bumpKillstreak();
        }
      }
    }
  }

  // GOO SPLAT -- themed color based on current chapter
  const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  const themeColor = chapter.full.grid1;
  if (e.leavesGoo) {
    // Goo spitters always leave a splat
    spawnGooSplat(e.pos.x, e.pos.z, themeColor);
  } else if (!e.isBoss && Math.random() < GOO_CONFIG.spawnChance) {
    // Random chance for other enemies
    spawnGooSplat(e.pos.x, e.pos.z, themeColor);
  } else if (e.isBoss) {
    // Bosses always drop a big splat
    spawnGooSplat(e.pos.x, e.pos.z, themeColor);
    spawnGooSplat(e.pos.x + 1.2, e.pos.z, themeColor);
    spawnGooSplat(e.pos.x - 1.2, e.pos.z, themeColor);
  }

  // SPLITS-ON-DEATH (mega_brute) — spawn N copies of `splitInto` at
  // the death position, fanned out so they don't stack on top of
  // each other. With splitCount=20, the roaches need to populate ALL
  // around the brute (full 360° fan with random radius variation) so
  // the player can't easily kite them all in one direction. Captured
  // BEFORE we remove the enemy so e.pos is still valid.
  if (e.splits && e.splitInto && e.splitCount > 0) {
    const cx = e.pos.x;
    const cz = e.pos.z;
    const themeForChapter = CHAPTERS[S.chapter % CHAPTERS.length];
    const splitTint = themeForChapter.full.grid1 || 0xff3cac;
    // Bigger visual + audio cue for the heavier burst
    hitBurst(e.pos.clone().setY(1), splitTint, 48);
    shake(0.45, 0.25);
    // Fan radius scales with brute's own scale so a mega_brute (scale
    // 1.85) gets a wider 360° fan than a smaller splitting enemy
    // would. Each roach picks a random radius within the band so they
    // don't sit on a perfect circle (which looks artificial).
    const baseRadius = 1.5 * (e.scale || 1);
    const radiusJitter = 1.5 * (e.scale || 1);
    for (let k = 0; k < e.splitCount; k++) {
      // Even angular spacing + small jitter so the fan looks natural
      // but still covers the full 360°.
      const angle = (k / e.splitCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      const r = baseRadius + Math.random() * radiusJitter;
      const sx = cx + Math.cos(angle) * r;
      const sz = cz + Math.sin(angle) * r;
      try {
        makeEnemy(e.splitInto, splitTint, new THREE.Vector3(sx, 0, sz));
      } catch (err) {
        console.warn('[mega_brute split] failed to spawn', e.splitInto, err);
      }
    }
  }

  scene.remove(e.obj);
  enemies.splice(idx, 1);
  S.kills++;
  S.score += e.scoreVal;
  bumpKillstreak();

  for (let i = 0; i < e.xpVal; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * 0.6;
    makePickup('xp', e.pos.x + Math.cos(a) * d, e.pos.z + Math.sin(a) * d);
  }
  // Drop roll — bumped health significantly. Previously health was 4%;
  // now it's 14%, and we shifted speed/shield rolls accordingly so the
  // total drop rate is preserved.
  const roll = Math.random();
  if (roll < 0.14) makePickup('health', e.pos.x, e.pos.z);
  else if (roll < 0.17) makePickup('speed', e.pos.x, e.pos.z);
  else if (roll < 0.19) makePickup('shield', e.pos.x, e.pos.z);

  // POTION + GRENADE drops — independent rolls from the existing
  // health/speed/shield system above, so an enemy can drop both
  // (rare). Bosses always drop both. Drop chances are low (~5%
  // each) so they feel like genuine windfalls. Drop position is
  // the enemy's last position; the pickup mesh's pop animation
  // gives a clear "something appeared here" telegraph.
  if (rollPotionDrop(!!e.isBoss)) {
    spawnPickup('potion', e.pos.clone());
  }
  if (rollGrenadeDrop(!!e.isBoss)) {
    spawnPickup('grenade', e.pos.clone());
  }

  onEnemyKilled(e, inZone);
}

// ============================================================================
// ENEMY PROJECTILES -- triangle rotation handled here
// ============================================================================
function updateEnemyProjectiles(dt) {
  for (let i = enemyProjectiles.length - 1; i >= 0; i--) {
    const p = enemyProjectiles[i];
    const prevX = p.position.x, prevZ = p.position.z;
    p.position.addScaledVector(p.userData.vel, dt);
    p.userData.life -= dt;
    // Rotation based on type
    if (p.userData.projType === 'triangle') {
      // Spin the triangle around its travel axis
      p.rotation.y += dt * 12;
    } else {
      p.rotation.x += dt * 5;
      p.rotation.y += dt * 3;
    }

    if (segmentBlocked(prevX, prevZ, p.position.x, p.position.z)
        || segmentBlockedByProp(prevX, prevZ, p.position.x, p.position.z)) {
      hitBurst(p.position, p.userData.color || 0x00ff66, 4);
      scene.remove(p); enemyProjectiles.splice(i, 1); continue;
    }
    if (p.userData.life <= 0 || Math.abs(p.position.x) > ARENA || Math.abs(p.position.z) > ARENA) {
      scene.remove(p); enemyProjectiles.splice(i, 1); continue;
    }
    const dx = player.pos.x - p.position.x;
    const dz = player.pos.z - p.position.z;
    if (dx * dx + dz * dz < 1.0) {
      if (S.invulnTimer <= 0 && !S.overdriveActive) {
        if (S.shields > 0) { S.shields -= 1; UI.toast('SHIELD ABSORBED', '#e63aff'); }
        else { S.hp -= p.userData.damage; _takePlayerDamageVfx(0.2, 0.15); }
        S.invulnTimer = 0.4;
        if (S.hp <= 0) { S.hp = 0; UI.updateHUD(); gameOver(); }
      }
      // Goo spitter projectile leaves a splat on hit
      if (p.userData.color === 0x00ff44 || p.userData.color === 0x00ff66) {
        spawnGooSplat(p.position.x, p.position.z, p.userData.color);
      }
      scene.remove(p); enemyProjectiles.splice(i, 1);
    }
  }
}

// ============================================================================
// HEALING PROJECTILES -- fired by bonus-wave meebits at the player.
//
// On impact with the player, restore HP (capped at hpMax). NO damage, NO
// shield interaction, NO invuln-timer gating — heal pulses bypass all of
// that because they are friendly fire. Pulses that miss the player and
// leave the arena (or exceed their life timer) simply despawn.
// ============================================================================
function updateHealingProjectiles(dt) {
  const list = getHealingProjectiles();
  if (list.length === 0) return;

  const PLAYER_HIT_R2 = 1.1 * 1.1;   // generous radius — friendly, easy to "catch"

  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const m = p.mesh;
    // Advance position along XZ using stored velocity.
    m.position.x += p.vx * dt;
    m.position.z += p.vz * dt;
    // Gentle bob + spin for visual readability.
    m.position.y = 1.4 + Math.sin((p.life + performance.now() * 0.002)) * 0.15;
    m.rotation.x += dt * 3;
    m.rotation.y += dt * 2;

    p.life -= dt;

    // Expire on timeout or arena edge.
    if (p.life <= 0 ||
        Math.abs(m.position.x) > ARENA || Math.abs(m.position.z) > ARENA) {
      consumeHealingProjectile(p);
      continue;
    }

    // Player collision → heal.
    const dx = player.pos.x - m.position.x;
    const dz = player.pos.z - m.position.z;
    if (dx * dx + dz * dz < PLAYER_HIT_R2) {
      if (S.hp < S.hpMax) {
        S.hp = Math.min(S.hpMax, S.hp + p.heal);
        UI.updateHUD();
      }
      // Soft confirmation burst in the pulse's color + subtle shake.
      hitBurst(m.position, p.color, 8);
      consumeHealingProjectile(p);
    }
  }
}

function updatePickups(dt) {
  const MAG = 3.5, PICKUP_RANGE = 1.2;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.mesh.rotation.y += dt * 2;
    p.mesh.rotation.x += dt * 0.5;
    p.mesh.position.y = 0.6 + Math.sin(S.timeElapsed * 3 + i) * 0.12;
    p.life -= dt;

    const dx = player.pos.x - p.obj.position.x;
    const dz = player.pos.z - p.obj.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < MAG * MAG) {
      const d = Math.sqrt(d2);
      const pull = Math.max(0, (MAG - d) / MAG) * 18 * dt;
      p.obj.position.x += (dx / d) * pull;
      p.obj.position.z += (dz / d) * pull;
    }
    if (d2 < PICKUP_RANGE * PICKUP_RANGE) {
      collectPickup(p);
      scene.remove(p.obj);
      pickups.splice(i, 1);
      continue;
    }
    if (p.life <= 0) {
      scene.remove(p.obj);
      pickups.splice(i, 1);
    }
  }
}

function collectPickup(p) {
  Audio.pickup();
  switch (p.type) {
    case 'xp':
      S.xp += p.value;
      S.score += 50;
      S.xpSinceWave += p.value;
      if (S.xp >= S.xpNext) levelUp();
      break;
    case 'health':
      S.hp = Math.min(S.hpMax, S.hp + 35);
      UI.toast('+35 HP', '#00ff66');
      break;
    case 'speed':
      S.playerSpeed = Math.min(14, S.playerSpeed + 0.8);
      UI.toast('SPEED BOOST', '#4ff7ff');
      break;
    case 'shield':
      S.shields += 1;
      UI.toast('+SHIELD', '#e63aff');
      break;
  }
}

animate();

// --- CONSOLE BANNER ---
// Matrix-themed ASCII-art boot banner printed to the DevTools console so
// anyone poking around under the hood gets a little flavor. Three sections:
//   1. ASCII-art MEEBIT logo in glowing matrix green (monospaced, multi-line
//      via a single console.log with CSS styling)
//   2. A faux falling-code line in katakana + 0/1, picked fresh each reload
//   3. A compact "simulation online" status line with chapter palette hint
//
// Console.log supports %c tokens that apply CSS to the corresponding
// argument; we use that to set font-family (monospace so the ASCII
// aligns), color (matrix green), text-shadow (the soft glow), and
// font-size for each section. Browsers that don't support %c just show
// plain text, which still reads fine.

(() => {
  const GREEN = '#00ff66';
  const DIM_GREEN = '#008833';

  // ASCII logo. Drawn by hand so the M/E/B/I/T letterforms hold at mono width.
  const logo = [
    '',
    '  ███╗   ███╗ ███████╗ ███████╗ ██████╗  ██╗ ████████╗',
    '  ████╗ ████║ ██╔════╝ ██╔════╝ ██╔══██╗ ██║ ╚══██╔══╝',
    '  ██╔████╔██║ █████╗   █████╗   ██████╔╝ ██║    ██║',
    '  ██║╚██╔╝██║ ██╔══╝   ██╔══╝   ██╔══██╗ ██║    ██║',
    '  ██║ ╚═╝ ██║ ███████╗ ███████╗ ██████╔╝ ██║    ██║',
    '  ╚═╝     ╚═╝ ╚══════╝ ╚══════╝ ╚═════╝  ╚═╝    ╚═╝',
    '      :: S U R V I V A L    P R O T O C O L ::',
    '',
  ].join('\n');

  const logoStyle = [
    'color: ' + GREEN,
    'text-shadow: 0 0 6px ' + GREEN + ', 0 0 12px ' + GREEN,
    'font-family: "Courier New", ui-monospace, monospace',
    'font-weight: 900',
    'font-size: 12px',
    'line-height: 1.1',
    'background: #000',
    'padding: 4px 8px',
  ].join(';');

  // Expose a reusable printer so herdVrmLoader's per-stage "clear and
  // repaint" routine can bring the banner back after each console.clear().
  // Calling this more than once just prints another copy — which is what
  // we want, since clearing wipes the old one.
  function printBootBanner() {
    console.log('%c' + logo, logoStyle);

    // Faux matrix "rain" line — a random sequence of half-width katakana +
    // binary, printed with a subtle glow so it reads like code falling in
    // the background of the title screen. Different on every reload.
    const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ01MEEBIT';
    let rain = '';
    for (let i = 0; i < 72; i++) {
      rain += chars[Math.floor(Math.random() * chars.length)];
      if (i % 6 === 5) rain += ' ';
    }
    console.log('%c' + rain, [
      'color: ' + DIM_GREEN,
      'text-shadow: 0 0 4px ' + DIM_GREEN,
      'font-family: "Courier New", ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 1px',
    ].join(';'));

    // Status line — compact and proud. Includes the classic "WAKE UP" nod
    // because the cursor theme is already matrix-style.
    console.log(
      '%c» SIMULATION ONLINE %c· %cv27 %c· %cwake up, meebit...',
      'color:' + GREEN + '; text-shadow:0 0 6px ' + GREEN + '; font-weight:900; font-size:13px;',
      'color:#555;',
      'color:' + DIM_GREEN + '; font-weight:700;',
      'color:#555;',
      'color:' + GREEN + '; font-style:italic;',
    );
    console.log('');
  }

  // Exposed for the herd-loader progress clear-and-repaint flow.
  window.__printBootBanner = printBootBanner;

  // Initial print on module load.
  printBootBanner();
})();
