import * as THREE from 'three';
import { S, shake, updateChapterFromWave } from './state.js';
import { mouse, keys } from './state.js';
import {
  getWaveDef, WEAPONS, CHAPTERS, WAVES_PER_CHAPTER, MEEBIT_CONFIG,
  CAPTURE_RADIUS, CAPTURE_ENEMY_SLOWDOWN, CAPTURE_KILL_BONUS,
  SPAWNER_CONFIG, HIVE_CONFIG, ARENA,
} from './config.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { enemies, makeEnemy, makeBoss, clearAllEnemies, spawnEnemyProjectile } from './enemies.js';
import {
  makePickup, makeCaptureZone, removeCaptureZone, hitBurst,
  spawnBossCube, bossCubes, clearBossCubes,
  applyRainTo,
} from './effects.js';
import { applyTheme, scene, renderer, camera } from './scene.js';
import { isTutorialActive, tutorialEnemyColor, tutorialSpawnRateOverride } from './tutorial.js';
import { updateHeroHexagonStates } from './heroHexagons.js';
import { player, setPlayerGlowColor } from './player.js';
import {
  spawnRescueMeebit, updateRescueMeebit, removeRescueMeebit,
  pickNewMeebitId, damageCage,
} from './meebits.js';
import { spawnBlock, clearAllBlocks, blocks } from './blocks.js';
import { spawnEggsInDepotWedge, clearAllEggs } from './eggs.js';
import {
  hasCannon, getCannonOrigin, getCannonCooldown,
  loadChargeSlot, armCannon, aimCannonAt, tryFireCannon, forceFireCannon, setCannonChargeProgress,
  setCannonChargeZoneVisible,
  setActiveCannonCorner, setCannonCornerProgress, consumeCannonCorner, getCannonCornerPos,
  triggerCannonSink,
} from './cannon.js';
import {
  triggerCrusherSlam, triggerCrusherFinisher, triggerCrusherSink,
  setCrusherSlamCallback,
} from './crusher.js';
import {
  spawnChargeCubes, spawnChargeCubeCluster, addChargeCube,
  chargeCubesRemaining, clearChargeCubes,
} from './chargeCubes.js';
import {
  spawnEscortTruck, updateEscortTruck, getTruckPos, isTruckArrived,
  isTruckBlocked, isPlayerInEscortRadius, hasTruck, clearEscortTruck,
  triggerTruckSink,
} from './escortTruck.js';
import {
  spawnServerWarehouse, setSystemOnline, triggerLaserBlast,
  isLaserBlasting, isLaserActive, getChargingZonePos,
  setChargeZoneVisible, setChargeZoneProgress,
  triggerServerSink,
  hasServerWarehouse, clearServerWarehouse,
} from './serverWarehouse.js';
import {
  spawnHiveLasers, isHiveLasersDone, clearHiveLasers,
} from './hiveLasers.js';
import {
  spawnSafetyPod, setVisible as setPodVisible, setLaserActive as setPodLaserActive,
  isPlayerInPod, getPodPos, hasSafetyPod, clearSafetyPod,
  triggerPodDescent, triggerPodOpen,
} from './safetyPod.js';
import {
  spawnCockroachBoss, isCockroachDeadAndDone, hasCockroach, clearCockroachBoss,
} from './cockroachBoss.js';
import {
  getQueen, popQueenShield, queenShieldsRemaining,
  getNextDomePos, spawnCannonBeam,
} from './queenHive.js';
import {
  spawners, spawnAllPortals, updateSpawners, livePortalCount,
  pickActivePortal, clearAllPortals, spawnPortal,
} from './spawners.js';
import { spawnOrbs, updateOrbs, clearAllOrbs } from './orbs.js';
import { Save } from './save.js';
import {
  clearAllCivilians,
  clearCornerMarkers,
} from './civilians.js';
import { clearAllOres, updateOres, updateDepot, depotStatus, setDepotActive, setDepotRequired, setSuppressMegaOre, setOnAllOresConvergedHook } from './ores.js';
import * as OresModule from './ores.js';
import { spawnHazardsForWave, clearHazards, setHazardSpawningEnabled, tickHazardSpawning, setHazardRushMode } from './hazards.js';
import { paintFactionHazard, clearFactionPaint, getActivePaintCount } from './factionPaint.js';
import { spawnPuddle, clearAllPuddles } from './bossPuddles.js';
import {
  triggerFreezeCycle, isInsideAnyPod, getFreezePhase,
  didFreezeFireThisFrame, clearFreeze,
} from './bossFreeze.js';
import { spawnSolarFlare, clearAllFlares } from './bossSolarFlare.js';
import { setGalagaTargetCount, resetGalagaTargetCount, setGalagaOverdrive } from './hazardsGalaga.js';
import { setTetrisOverdrive } from './hazardsTetris.js';
import { setMinesweeperTargetCount, resetMinesweeperTargetCount, setMinesweeperOverdrive } from './hazardsMinesweeper.js';
import { recolorCrowd } from './crowd.js';
import {
  prepareChapter, teardownChapter, isChapterPrepared,
  removeHiveShields, updateHiveShields, buildShieldMaterials,
} from './dormantProps.js';
import {
  startPowerupWave, endPowerupWave, updatePowerupZones,
  getActiveZone, getActiveProgress, getCompletedCount, getZoneCount,
  spawnPowerupZones, clearPowerupZones, getChargingTurretStatus,
} from './powerupZones.js';
import {
  activateTurret, activateTurretsUpTo, deactivateAllTurrets, clearTurretBullets,
  clearAllTurrets,
  setTurretCharging,
} from './turrets.js';
import {
  setPowerplantLit, openSiloAndRaiseMissile, resetCompoundAnimations,
  registerLaunchHandler, triggerLaunch, startCompoundRetraction,
  openSiloHatchOnly, setMissileRaiseDirect, setLaunchSequenceActive,
  getSiloLaunchOrigin, setCh1Wave2PropsRemoved,
} from './waveProps.js';
import {
  buildWires, clearWires, setWiresLit, setWireCharge, setWireComplete,
  resetWireAnimations, startWireRetraction,
} from './empWires.js';
import { addFlingerCharge } from './flingers.js';
import {
  startLaunch, isLaunching, registerDetonationHandler, abortLaunch,
  forceClearEmpResidue,
} from './empLaunch.js';
import { fireShockwave, clearShockwaves } from './shockwave.js';
import { startDepotDriveOff } from './ores.js';
import { spawnPickup } from './pickups.js';
import { LAYOUT } from './waveProps.js';
import { startHiveRetraction, getLastHiveDeathPos, forceCompleteRetraction } from './spawners.js';
import {
  startBonusWave, updateBonusWave, endBonusWave, clearBonusWave,
  clearSavedPigs,
  isBonusWaveActive, prefetchNextHerd,
  preparePigPool,
} from './bonusWave.js';
import { resetSlowDripState } from './herdVrmLoader.js';
import { maybeShowChapterReward } from './powerups.js';
import { getCentroidFor } from './triangles.js';
import { showMissileArrow, hideMissileArrow } from './missileArrow.js';

// How long after RADIO completes before the missile auto-fires. Was the
// LAUNCH zone's 14-second hold — now it's a 10-second countdown toast
// + HUD waypoint arrow. 10s gives the player time to see the raise
// animation, the flashing missile, and track the strike target.
const AUTO_LAUNCH_COUNTDOWN = 10;

let waveDef = null;
let spawnCooldown = 0;
let intermissionActive = false;

// --- Stage 3b-2 / 3c wiring ---
//
// When the LAUNCH power-up zone completes (player held the zone at the
// base of the raised missile), waves.js calls triggerLaunch() which
// fires the registered handler — we call startLaunch() to begin the
// cinematic and mark powerupEmpFired so no further wave-2 logic tries
// to short-circuit.
//
// When the cinematic's detonation phase completes, empLaunch fires the
// registered detonation handler — we call _fireEmp() to run the normal
// EMP side-effects (turret shutdown, zone cleanup, wave end). Hive
// shields are already dropped by empLaunch's shockwave, so _fireEmp's
// removeHiveShields() call is idempotent.
registerLaunchHandler(() => {
  if (S.powerupEmpFired) return;
  S.powerupEmpFired = true;  // locks out HUD + other completion checks
  try { startLaunch(); } catch (err) { console.warn('[waves] startLaunch', err); }
});
registerDetonationHandler(() => {
  hideMissileArrow();
  try { _fireEmp(); } catch (err) { console.warn('[waves] detonation _fireEmp', err); }
});

export function getWaveDef_current() { return waveDef; }

// ---------------------------------------------------------------------
// Portal terminology — chapter-aware UI strings.
// ---------------------------------------------------------------------
// Portal type cycles every 3 chapters. The internal S.chapter index is
// 0-based (chapter 1 is S.chapter=0, chapter 7 is S.chapter=6) — this
// helper accepts the 1-BASED chapter number you see in the UI to keep
// callers readable (portalLabels(2) for chapter 2, not portalLabels(1)).
// Returns:
//   noun       — singular noun, lowercase ("hive" / "pyramid" / "ufo")
//   nounPlural — plural caps for headlines ("HIVES" / "PYRAMIDS" / "UFOS")
//   exposeToast — short toast fired when the wave-2 mechanism (laser /
//                 EMP / charge) drops shields and exposes the spawners
//                 for the player to attack
//   destroyTitle — objective bar title for the wave-3 attack phase
//   destroyDesc  — body text under the objective title
//   targetingToast — short toast when the wave-2 mechanism is mid-fire
//                    ("TARGETING ..." or equivalent)
//   empSuffix    — completion suffix for EMP-launch toast (chapters with
//                  the EMP wave-2 mechanic — hives + ufos)
function portalLabels(chapterNum) {
  // chapterNum is 1-BASED (1..7). If omitted, derive from S.chapter
  // which is 0-BASED. Keeps internal S.chapter consumers untouched
  // while letting callers pass the natural "chapter 2" number.
  if (chapterNum == null) chapterNum = (S.chapter || 0) + 1;
  const chapterIdx = chapterNum - 1;
  const slot = ((chapterIdx % 3) + 3) % 3;
  if (slot === 1) {
    // PYRAMIDS — chapters 2 & 5. Player request: "Opened the Pyramids"
    // for the expose, "Banish the Pyramids" for the objective.
    return {
      noun: 'pyramid',
      nounPlural: 'PYRAMIDS',
      exposeToast: 'OPENED THE PYRAMIDS',
      destroyTitle: 'BANISH THE PYRAMIDS',
      destroyDesc: 'Shields down. Take them out before they overrun you.',
      targetingToast: 'TARGETING PYRAMIDS',
      empSuffix: 'PYRAMIDS DISTURBED',     // unused — pyramid chapters use datacenter path, not EMP
    };
  }
  if (slot === 2) {
    // UFOS — chapters 3 & 6. Player request: "Access Granted" for the
    // expose, "Destroy the UFOs" for the objective.
    return {
      noun: 'ufo',
      nounPlural: 'UFOS',
      exposeToast: 'ACCESS GRANTED',
      destroyTitle: 'DESTROY THE UFOS',
      destroyDesc: 'Shields down. Knock them out of the sky.',
      targetingToast: 'TARGETING UFOS',
      empSuffix: 'UFOS REVEALED',
    };
  }
  // HIVES — chapters 1, 4, 7. Existing wording preserved.
  return {
    noun: 'hive',
    nounPlural: 'HIVES',
    exposeToast: 'HIVES EXPOSED',
    destroyTitle: 'DESTROY THE HIVES',
    destroyDesc: 'Shields down. Shoot the glowing rings — each has health.',
    targetingToast: 'TARGETING HIVES',
    empSuffix: 'HIVES ENRAGED',
  };
}

export function startWave(waveNum) {
  updateChapterFromWave(waveNum);
  // Hero hexagons HUD — light up the FLINGER/PIXL hexes at their
  // activation waves (2 and 5 within each chapter). Try/catch
  // because tutorial mode skips heroHexagon init entirely.
  try { updateHeroHexagonStates(S.localWave); } catch (e) {}
  waveDef = getWaveDef(waveNum);
  S.waveKillTarget = waveDef.killTarget || 0;
  S.waveKillsProgress = 0;
  S.waveActive = true;
  S.xpSinceWave = 0;
  spawnCooldown = 0;
  intermissionActive = false;
  // Per-wave HP multiplier — config.js sets waveDef.hpMul on waves
  // that should spawn fewer-but-tougher enemies (currently wave 3
  // across all chapters; see comments there). enemies.js makeEnemy
  // reads this flag and scales each spawn's hp/hpMax. Default 1
  // (no scaling). Reset every wave so the bonus + boss + later
  // waves spawn at baseline HP.
  S.activeWaveHpMul = (typeof waveDef.hpMul === 'number') ? waveDef.hpMul : 1;

  // Civilian-rescue wave removed — corner markers are no longer used by any
  // wave type. Clear defensively in case a save loaded into the middle of
  // one (unlikely, but cheap).
  clearCornerMarkers(scene);

  applyTheme(S.chapter, S.localWave);

  // --- DORMANT PROPS ---
  // On localWave === 1 we're entering a fresh chapter. Prepare the full set
  // of persistent chapter props (depot, shielded hives, turret platforms in
  // stage 2, etc). Later waves in the same chapter just flip state bits
  // rather than re-spawning anything.
  if (S.localWave === 1) {
    prepareChapter(S.chapter);
  } else if (!isChapterPrepared(S.chapter)) {
    // Defensive: if the player loaded into the middle of a chapter without
    // wave 1 running (shouldn't happen in normal flow), scaffold it now.
    prepareChapter(S.chapter);
  }

  // Bonus wave is a victory lap — no orbs, no hazards. Rain is NOT
  // suppressed here anymore; the wave-4 rain preset is now part of
  // the climbing typhoon curve (see rainIntensity in config.js).
  const _isBonusWave = waveDef.type === 'bonus';
  if (!_isBonusWave) {
    spawnOrbs(S.chapter, S.localWave);
  } else {
    clearAllOrbs();
  }
  // Re-tint the spectator crowd to match the current chapter. Cheap —
  // just updates instance color attribute, no teardown.
  const _chapterNow = CHAPTERS[S.chapter % CHAPTERS.length];
  recolorCrowd(_chapterNow.full.grid1);

  // Floor hazards — progressive drop system.
  //
  // Hazards now ACCUMULATE across waves 1-3 of each chapter. On wave 1
  // we clear the arena and start dropping. On waves 2 and 3 we keep the
  // existing tiles and continue adding more, so a player who turtles
  // and farms for XP visibly loses ground. Waves 4 (bonus) and 5 (boss)
  // disable dropping AND clear existing hazards — those waves are
  // hazard-free by design.
  //
  // The progressive drop itself happens in updateWaves → tickHazardSpawning
  // every frame. setHazardSpawningEnabled just arms/disarms the ticker.
  if (S.localWave === 1) clearHazards();
  const isHazardWave = waveDef.type === 'mining' || waveDef.type === 'powerup'
    || waveDef.type === 'hive' || waveDef.type === 'spawners'
    || waveDef.type === 'cannon-load' || waveDef.type === 'queen-cleanup'
    || waveDef.type === 'datacenter' || waveDef.type === 'twinhive'
    || waveDef.isEscortWave;
  if (isHazardWave && !S.hyperdriveActive) {
    // Gated by S.hyperdriveActive: during the 8s ATTACK-THE-AI prelude
    // the arena is fog-hidden. main.js re-enables hazard spawning at
    // the fog reveal.
    setHazardSpawningEnabled(true);
  } else {
    setHazardSpawningEnabled(false);
    if (!isHazardWave) clearHazards();  // wipe accumulated tiles for bonus/boss
  }

  // Rain intensity scales with localWave. Color comes from the chapter theme.
  const _chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  applyRainTo(_chapter.full.grid1, S.localWave);

  // Chapter-tint the player's aura glow.
  setPlayerGlowColor(_chapter.full.grid1);

  if (S.localWave === 1) {
    const chapterName = CHAPTERS[S.chapter % CHAPTERS.length].name;
    UI.toast('CHAPTER ' + (S.chapter + 1) + ': ' + chapterName, '#ffd93d', 2500);
  }

  if (waveDef.type === 'bonus') {
    // WAVE 4 — BONUS HERD LASER TAG. Pure chill, no enemies, 30s.
    // Belt-and-suspenders: force any lingering hive to finish retracting NOW.
    // Under normal conditions startHiveRetraction() + per-frame updateSpawners
    // ticks handle this, but if the tab was backgrounded between waves, or
    // the hive was destroyed at exactly the wave-flip frame, a straggler can
    // survive. This guarantees the arena is clean for laser-tag.
    forceCompleteRetraction();
    const chapterForHerd = CHAPTERS[S.chapter % CHAPTERS.length];
    const herdDef = chapterForHerd.bonusHerd;
    S.bonusWaveActive = true;
    S.bonusCaughtThisWave = 0;
    startBonusWave(S.chapter, chapterForHerd.full.grid1, _onBonusCaught)
      .catch(err => console.warn('[waves] bonus wave start failed:', err));
    UI.toast(
      'BONUS WAVE · ' + (herdDef.icon || '') + ' LASER TAG ' + herdDef.label,
      '#ffd93d', 2800
    );
    UI.showObjective(
      'TAG THE ' + herdDef.label,
      'Shoot each one 3 times to free them · 30 seconds'
    );
  } else if (waveDef.type === 'boss') {
    // WAVE 5 — BOSS. The pre-boss cinematic has ALREADY fired at the end
    // of wave 3 (so the herd had ~6s to stream in before wave 4 started).
    // We go straight to spawning the boss and showing the HP bar.
    console.info('[waves] boss wave starting — spawning boss directly');
    spawnBoss();
    // Record when the fight started so pixl pals can auto-deploy 10s
    // into the fight (see pixlPals.onBossWaveActive handling).
    S.bossFightStartTime = S.timeElapsed;
    if (S.bossRef) {
      const label = S.bossRef.name || (S.bossRef.type ? S.bossRef.type.replace(/_/g, ' ') : 'BOSS');
      // Chapter tint drives the boss bar color — lamp/grid hue matches the chapter palette.
      const chapterTint = CHAPTERS[S.chapter % CHAPTERS.length].full.grid1;
      UI.showBossBar(label, chapterTint);
      UI.toast(label + ' APPROACHES', '#ff2e4d', 2000);
    }
  } else if (waveDef.type === 'mining') {
    // WAVE 1 — MINING. Depot is ALREADY spawned by prepareChapter — just
    // activate it. The hives are also already spawned but shielded.
    setDepotActive(true);
    S.miningActive = true;
    S.blockFallTimer = 1.0;
    S.blocksSpawned = 0;
    S.blocksToSpawn = waveDef.blockCount;
    S.oresCarried = 0;
    S.oresRequired = waveDef.oresRequired || 5;
    if (waveDef.isEscortWave) {
      // CHAPTER 2 WAVE 1 — escort truck. Player walks alongside a
      // truck with a generator from the depot wedge to the silo
      // position. Truck moves only when (player in 8.5u radius) AND
      // (no enemies in 4u front-bumper). Wave ends when truck arrives
      // at silo with a decompression hiss.
      S.isEscortWave = true;
      S.isEggWave = false;
      // Clean up any chapter-1 reflow flags
      setSuppressMegaOre(false);
      setOnAllOresConvergedHook(null);
      // Spawn truck at depot position, oriented toward silo. Hide
      // the depot mesh — the truck IS the depot for this wave.
      const dPos = OresModule.depot && OresModule.depot.pos;
      if (dPos && OresModule.depot.obj) {
        OresModule.depot.obj.visible = false;
      }
      const fromPos = dPos ? { x: dPos.x, z: dPos.z } : { x: -15, z: 0 };
      // Destination: LAYOUT.powerplant — the same coordinate where the
      // chapter-2 wave-2 server warehouse spawns. The escort cargo is
      // a generator; it arrives at the powerplant slot and brings the
      // server online. Then in wave 2 the warehouse mesh appears at
      // the same location and the player engages its charging zone.
      // One position, one narrative beat across two waves.
      const toPos = { x: LAYOUT.powerplant.x, z: LAYOUT.powerplant.z };
      spawnEscortTruck(S.chapter || 0, fromPos, toPos);
      // Disable the depot's deposit logic — escort wave doesn't use
      // the deposit-counted wave-end. We end on truck arrival.
      setDepotActive(false);
      UI.showObjective(
        'ESCORT THE GENERATOR · stay close',
        'Truck moves while you stay within range and the path is clear.',
      );
      UI.toast('ESCORT MISSION', '#ffd93d', 1800);
    } else if (waveDef.isEggWave) {
      // Chapter 1 reflow — spawn 4 eggs in the depot wedge instead of
      // falling mining blocks. Eggs are placed (not falling) and use
      // the same blocks array so the existing bullet hit code targets
      // them. Each egg shatters into a charge ore on death.
      S.isEggWave = true;
      // Override the depot's required-deposit count from the default
      // 5 to match this wave's actual ore yield (4 eggs → 4 charges).
      // Without this the wave gets stuck — depot waits for a 5th ore
      // that will never exist.
      setDepotRequired(S.oresRequired);
      // CHAPTER 1 REFLOW — wave 1 finisher rework:
      //   Suppress the mega-ore catapult flow. When the 4 ores converge
      //   at the depot, fire the crusher finisher animation + spawn 4
      //   chapter-tinted cubes on the crusher pad. Wave 1 ends ONLY
      //   when the player has collected all 4 cubes (handled in tick).
      setSuppressMegaOre(true);
      setOnAllOresConvergedHook(() => {
        // Set up the cluster (floor ring + 4 empty slots) at the depot
        // position. NO cubes spawn yet — the crusher's slam callback
        // spawns one cube per slam (4 slams = 4 cubes, sequential).
        const dPos = OresModule.depot && OresModule.depot.pos;
        if (dPos) spawnChargeCubeCluster(S.chapter || 0, dPos.x, dPos.z);
        // Register slam callback BEFORE triggering the finisher so the
        // very first impact already has a callback wired.
        setCrusherSlamCallback((slamIdx) => {
          // Each slam impact spawns the next cube into the cluster.
          // slamIdx is 1..4 — we just call addChargeCube which fills
          // the next empty slot.
          addChargeCube(S.chapter || 0);
        });
        // Crusher does its 4-slam mega-finisher (one slam per cube)
        triggerCrusherFinisher();
        S._chargeCubesSpawned = true;
      });
      // Reset chargesCarried state — player will accumulate it back to
      // 4 by collecting the cubes. wave 2 uses chargesCarried=4 to skip
      // the depot-pickup phase.
      S.chargesCarried = 0;
      S._chargeCubesSpawned = false;
      spawnEggsInDepotWedge(S.chapter || 0, waveDef.eggCount || 4);
      UI.showObjective(
        'BREAK 4 EGGS · 0/4',
        'Shoot eggs (~20 hits each) — collect charges, drop at crusher.'
      );
    } else {
      S.isEggWave = false;
      // Clean up any chapter-1 reflow flags so other chapters use
      // the normal mega-ore + catapult flow.
      setSuppressMegaOre(false);
      setOnAllOresConvergedHook(null);
      UI.showObjective(
        'DELIVER 5 ORES TO THE DEPOT',
        'Shoot blocks (25 hits) or use [Q] pickaxe (5 swings). Drop ore at beacon.'
      );
    }
  } else if (waveDef.type === 'powerup') {
    // WAVE 2 — POWER-UP. Five stand-in-zone objectives:
    //   1. RESTORE POWER
    //   2. LOAD TURRETS A   → activates turret 0
    //   3. LOAD TURRETS B   → activates turrets 1 + 2
    //   4. ESTABLISH RADIO
    //   5. LAUNCH EMP       → drops hive shields, deactivates turrets,
    //                         ends the wave
    //
    // Zones are now wave-2 scoped: spawn them HERE, clear them in endWave.
    // Keeps the arena clean of floor disks during mining / hive / herd /
    // boss phases. spawnPowerupZones is idempotent — it clears any prior
    // set first.
    spawnPowerupZones(S.chapter);
    S.powerupActive = true;
    S.powerupStep = 0;
    S.powerupStepMax = getZoneCount();
    S.powerupChargeTime = 0;
    S.powerupChargeTarget = waveDef.zoneHoldTime || 3.5;
    S.powerupEmpFired = false;
    S._empStubTimer = undefined;
    // Reset the auto-launch countdown state so a stale value from a
    // previous wave doesn't fire the missile early.
    S.autoLaunchT = 0;
    // Reset the phased silo-launch sequence state. If a previous wave
    // 2 didn't fully complete (chapter skip, debug reload), siloLaunchT
    // and siloLaunchPhase could be left mid-sequence. Clear them so
    // the new wave 2 starts clean. setLaunchSequenceActive(false)
    // handled by resetCompoundAnimations called elsewhere.
    S.siloLaunchT = 0;
    S.siloLaunchPhase = null;
    S.siloLaunchIgnited = false;
    // Deactivate the depot — mining wave is over, it's now a dormant prop
    // again. The visual stays; only deposits are rejected.
    setDepotActive(false);
    startPowerupWave();
    UI.showObjective(
      'POWER-UP · STEP 1/' + S.powerupStepMax,
      'Stand in the glowing zone to restore power.',
    );
    UI.toast('POWER-UP PHASE', '#4ff7ff', 2200);
  } else if (waveDef.type === 'rescue') {
    // Legacy single-meebit rescue — still supported if any old wave def
    // happens to reference it; no longer used by the default getWaveDef.
    spawnRescueForCurrentWave();
    UI.showObjective('CAGED MEEBIT NEEDS HELP', 'Protect the cage — if it breaks the Meebit dies!');
  } else if (waveDef.type === 'hive' || waveDef.type === 'spawners') {
    // WAVE 3 — HIVES. Hives are ALREADY spawned (by prepareChapter) with
    // shields up. The EMP launch at the end of wave 2 called
    // removeHiveShields() to drop them. We just need to flip the "we're
    // now actively emitting enemies" flags and update the objective.
    S.spawnerWaveActive = true;
    S.hiveWaveActive = true;
    S.spawnersLive = 0;
    for (const s of spawners) {
      if (!s.destroyed) S.spawnersLive++;
    }
    // Per-chapter hazard-style overdrive — replicates the chapter-2
    // wave-3 galaga "swarm tightens around the player" feeling for the
    // chapters that use other hazard styles. Player feedback: the
    // chapter-2 wave-3 swarm is "very very nice" and should be
    // mirrored on chapter 1 (tetris) and chapter 3 (minesweeper).
    if (S.chapter === 0) {
      // Tetris — flip overdrive flag so drops bias 95% / ±4u toward
      // player. Drop interval is the standard one (already fast at
      // 1.2s after the tuning bump). Combined with the passive
      // ring-shrink already running, this produces the slow-trickle
      // tightening swarm the user described.
      setTetrisOverdrive(true);
    } else if (S.chapter === 2) {
      // Minesweeper — same overdrive pattern, plus a count bump
      // (12 → 16) so more pointers descend near the player at once.
      // Equivalent to galaga's wave-3 count bump (5 → 12) but
      // proportionally smaller since minesweeper already runs hot.
      setMinesweeperTargetCount(16);
      setMinesweeperOverdrive(true);
    }
    // Note: Chapter 2 hive wave is handled by a separate code path
    // further down (with the EMP laser drama), which already invokes
    // setGalagaOverdrive + setGalagaTargetCount + setHazardRushMode.
    const _lbl = portalLabels();
    UI.showObjective(
      _lbl.destroyTitle + ' (' + S.spawnersLive + ')',
      _lbl.destroyDesc
    );
    UI.toast(_lbl.exposeToast, '#ff3cac', 2500);
  } else if (waveDef.type === 'cannon-load') {
    // WAVE 2 (chapter 1 reflow) — charge delivery + cannon barrage.
    // Player picks up 4 charges from depot in one trip, walks to
    // cannon, loads them, then defends while the cannon auto-fires
    // 4 shots over 60s popping queen shield domes.
    S.cannonLoadActive = true;
    // Reveal the cannon charging-zone ring on the floor immediately so
    // the player can see where to go BEFORE approaching the cannon.
    setCannonChargeZoneVisible(true);
    // Reset cannon-charge state for this wave run.
    S.cannonChargeT = 0;
    S.cannonChargeStarted = false;
    S.cannonInserted = false;
    S.cannonLoadWaveT = 0;
    S.flingerRequested = false;
    // 4-CORNER CHARGING STATE — wave 2 reflow. Each shot fires from a
    // separate charging zone at one of the cannon's 4 corners. Player
    // charges corner N (4s standing in zone) → shot N fires → corner N
    // consumed → 1.5s reload → corner N+1 activates → repeat.
    S.cannonShotIdx = 0;              // 0..3 = current corner; 4 = all done
    S.cannonCornerChargeT = 0;        // 0..CORNER_CHARGE_DURATION
    S.cannonReloadT = 0;              // counts down during reload window
    S.cannonPhase = 'approach';       // 'approach' | 'corner-charging' | 'reload' | 'done'
    if ((S.chargesCarried || 0) < 4) S.chargesCarried = 4;
    S.chargesLoaded = 0;
    // Pandemonium ramp — wave 2 spawn rate escalates from 14 to 30
    // over the wave duration. Tracks wall-clock seconds since the
    // wave began. The cannon-load tick reads S.cannonLoadWaveT and
    // overrides waveDef.spawnRate per-frame so the spawn loop sees
    // the ramped value.
    S.cannonLoadWaveT = 0;
    // Activate all 3 defensive turrets ringed around the cannon. They
    // auto-fire at any enemy in range, helping the player survive the
    // 60-second barrage. Without them the cannon area is undefended
    // since chapter 1 doesn't have the standard powerup-zone flow
    // that brings turrets online progressively.
    activateTurretsUpTo(3);
    UI.showObjective(
      'DELIVER 4 CHARGES TO THE CANNON',
      'You have all 4 charges. Walk to the cannon to load them.'
    );
    UI.toast('TURRETS ONLINE', '#ffd93d', 1800);
  } else if (waveDef.type === 'datacenter') {
    // CHAPTER 2 WAVE 2 — datacenter onslaught (REWORKED).
    //   Phase A: warehouse-charging — player charges right-front of warehouse (5s) → calls pod
    //   Phase B: pod-descending — pod descends into hive zone center over 6s while enemies pour in
    //   Phase C: pod-charging — player charges the LANDED pod itself (5s) → calls hive lasers
    //   Phase D: hive-lasers — per-hive sky beams strike each hive (2.3s telegraph)
    //   Phase E: finale-laser — big arena laser fires (1s) — destroys hive shields
    //   Phase F: done → wave 3
    S.dcActive = true;
    S.dcPhase = 'warehouse-charging';
    S.dcChargeT = 0;
    S.dcPodChargeT = 0;
    S.dcSystemOnline = 0;
    S.dcLaserTriggered = false;
    S.dcShieldsDropped = false;
    S._dcPodDescentTriggered = false;
    S._dcPodOpenTriggered = false;
    S._dcHiveLasersSpawned = false;
    S._dcPlayerInPod = false;     // Turn 9: lock-in flag — set on entry, cleared on done
    // Ensure system online is at 0 so the grid starts dark
    setSystemOnline(0);
    // Reveal the warehouse charging zone disc
    setChargeZoneVisible(true);
    setChargeZoneProgress(0);
    // Pod placement: CENTER OF HIVE ZONE (chapter-2 hives are scattered
    // in the hive-triangle wedge; the centroid is the natural focal
    // point). Pod descends from sky and lands fully on ground there.
    const hiveCentroid = getCentroidFor('hive');
    if (hiveCentroid) {
      spawnSafetyPod(S.chapter || 0, hiveCentroid.x, hiveCentroid.z);
    } else {
      // Fallback — should not happen, but cover it
      spawnSafetyPod(S.chapter || 0, 0, 0);
    }
    UI.showObjective(
      'CHARGE THE DATACENTER',
      'Walk to the warehouse charging zone to call in the pod.',
    );
    UI.toast('SYSTEM OFFLINE', '#ffd93d', 1800);
  } else if (waveDef.type === 'queen-cleanup') {
    // WAVE 3 (chapter 1 reflow) — queen hive is shieldless from the
    // wave-2 cannon barrage. Player must destroy it with their gun.
    // We flag spawnerWaveActive + hiveWaveActive so the queen's
    // existing enemy-emission behavior kicks in.
    // Defensive: make sure turrets are off (wave 2 normally turns
    // them off but cover any debug-skip path).
    deactivateAllTurrets();
    S.spawnerWaveActive = true;
    S.hiveWaveActive = true;
    S.spawnersLive = 0;
    for (const s of spawners) {
      if (!s.destroyed) S.spawnersLive++;
    }
    UI.showObjective(
      'DESTROY THE QUEEN HIVE',
      'Shields down. Empty your gun — the swarms won\'t stop.'
    );
    UI.toast('QUEEN EXPOSED', '#ff3cac', 2500);
  } else if (waveDef.type === 'twinhive') {
    // CHAPTER 2 WAVE 3 — twin hives. The 4 chapter-2 hives are now
    // unshielded from wave 2's laser. Player shoots them until clear.
    // No cockroaches — they were too busy visually. Standard hive-clear
    // logic handles wave end via livePortalCount() === 0.
    deactivateAllTurrets();
    // Defensive: ensure all hive shields are down — also destroys the
    // dome meshes via removeHiveShields (cover any debug-skip path
    // where wave 2's laser didn't fire).
    removeHiveShields();
    // Bump galaga active-bug count so the chapter 2 hazard "fills in"
    // around the player during wave 3. 5 → 12 active bugs — many more
    // hazard tiles being painted around the player at once.
    setGalagaTargetCount(12);
    // Enable overdrive — bugs aggressively target near the player
    // (95% bias instead of 70%, tighter spread). Combined with the
    // count bump, hazard tiles "close in around the player."
    setGalagaOverdrive(true);
    // Activate hazard rush mode — 4x drop rate + active ring
    // auto-shrinks inward over time. "The walls are closing in."
    setHazardRushMode(true);
    S.spawnerWaveActive = true;
    S.hiveWaveActive = true;
    // Count live spawners (the existing chapter-2 hives)
    S.spawnersLive = 0;
    for (const s of spawners) {
      if (!s.destroyed) S.spawnersLive++;
    }
    const _twLbl = portalLabels();
    UI.showObjective(
      _twLbl.destroyTitle + ' (' + S.spawnersLive + ')',
      S.spawnersLive + ' ' + _twLbl.noun + 's exposed by the laser strike. Take them out.'
    );
    UI.toast(_twLbl.exposeToast, '#ff8826', 2500);
  }

  UI.showWaveStart(waveNum);
  Audio.waveStart();
  shake(0.3, 0.3);

  // Civilians no longer used in the default wave flow. Clear defensively.
  clearAllCivilians();
}

function spawnRescueForCurrentWave() {
  const id = pickNewMeebitId(S.rescuedIds);
  const angle = Math.random() * Math.PI * 2;
  const dist = 16 + Math.random() * 14;
  const x = Math.cos(angle) * dist;
  const z = Math.sin(angle) * dist;
  S.rescueMeebit = spawnRescueMeebit(x, z, id);
}

// Callback wired into bonusWave.js — fires every time the player's proximity
// auto-collect grabs a herd meebit. Tick score, bump the rescue collection,
// and flash a toast for the first few + every multiple of 25.
function _onBonusCaught(info) {
  S.bonusCaughtThisWave = (S.bonusCaughtThisWave || 0) + 1;
  S.score += 500;  // matches BONUS_WAVE_CONFIG.scorePerCatch
  // Persist the herd meebit's filename to the rescued-collection so it flows
  // into the player's 20K counter via Save.onChapterComplete at wave end.
  // We encode the tag as "herdId:filename" so it doesn't collide with
  // numeric public-Meebit IDs, and duplicate catches (cycled slots) dedupe.
  const tag = info.herdId + ':' + info.filename;
  if (!S.rescuedIds.includes(tag)) {
    S.rescuedIds.push(tag);
    S.rescuedCount++;
  }
  const n = S.bonusCaughtThisWave;
  if (n === 1 || n === 10 || n === 25 || n === 50 || n === 75 || n === 100 || n === 111) {
    UI.toast(n + ' ' + (info.herdLabel || 'MEEBITS') + ' FREED FROM SIMULATION', '#ffd93d', 1600);
  }
}

export function updateWaves(dt) {
  // Tutorial mode disables the wave system entirely. The tutorial
  // controller in tutorialLessons.js drives all spawns, props, and
  // objective state when S.tutorialMode is true, so updateWaves
  // would only fight it for control of S.* flags.
  if (S.tutorialMode) return;

  // Per-frame dormant-prop updates (shield pulse + drop animation).
  // MUST run before the `!S.waveActive` gate below — otherwise the shield
  // cascade's pending-drop timers and collapse animations freeze during
  // the wave-2→wave-3 intermission (which is 3.6s with S.waveActive=false).
  // That's what was causing all shields to appear to drop simultaneously
  // "right at wave 3 start": the per-hive scheduled delays were set at
  // EMP detonation time, but the delay countdown only advanced while
  // updateHiveShields was being called — which was never during
  // intermission. Wave 3 starts, shields unfreeze, they all complete
  // their animations back-to-back in a bunch instead of cascading as
  // the shockwave visibly passed.
  // Cheap, safe to always call — early-outs when _hiveShields is empty.
  updateHiveShields(dt, performance.now() / 1000);

  // Progressive hazard drops. Runs every frame (including during wave
  // intermissions) so any in-flight hovering blocks can still land
  // after the wave-end trigger, and so wave 1→2 and 2→3 transitions
  // don't lose the drop timer. When _spawningEnabled is false inside
  // hazards.js, this just advances animations and doesn't spawn new
  // pieces.
  //
  // Powerup zone protection — compute the zone positions from LAYOUT
  // (populated at chapter prepare time, well before wave 1 starts).
  // This is critical: we protect the zone positions starting at wave 1
  // even though the zones THEMSELVES don't spawn until wave 2. If we
  // only used live zones (getZones()), blocks would drop into the
  // future zone spots during wave 1 and still be there when the zones
  // try to spawn, blocking the player from standing in them.
  //
  // Wave 3 onward: zones are done. Let hazards fill that space freely —
  // the powerup wave is over and the compound is sinking anyway.
  {
    const protectZones = (S.localWave === 1 || S.localWave === 2);
    let zonePositions;
    if (protectZones && LAYOUT) {
      zonePositions = [
        { x: LAYOUT.powerplant.x, z: LAYOUT.powerplant.z },
        { x: LAYOUT.radioTower.x, z: LAYOUT.radioTower.z },
        { x: LAYOUT.turrets[0].x, z: LAYOUT.turrets[0].z },
        { x: LAYOUT.turrets[1].x, z: LAYOUT.turrets[1].z },
        { x: LAYOUT.turrets[2].x, z: LAYOUT.turrets[2].z },
      ];
    } else {
      zonePositions = [];
    }
    // Chapter 2 + Chapter 5 wave 2 reflow — also protect the charging
    // zone + pod landing position. Hazards never spawn on these so the
    // player can always reach the active gameplay zone. Also covers
    // the active/landed pod during the lock-in phase.
    if ((S.chapter === 1 || S.chapter === 4) && waveDef && waveDef.type === 'datacenter') {
      const cz = getChargingZonePos();
      if (cz) zonePositions.push({ x: cz.x, z: cz.z });
      const pp = getPodPos();
      if (pp) zonePositions.push({ x: pp.x, z: pp.z });
    }
    tickHazardSpawning(dt, S.chapter, player.pos, zonePositions);
  }

  if (!S.waveActive || !waveDef) return;

  // BONUS WAVE — totally separate update path. No enemy spawning, no hive
  // checks, no rescue logic. Just tick the herd and watch the timer.
  if (waveDef.type === 'bonus') {
    let state;
    try {
      state = updateBonusWave(dt, player);
    } catch (err) {
      // Last-resort guard: if the bonus wave update throws, we cannot let
      // the render loop die. Log, clean up, and advance to the next wave.
      console.error('[waves] updateBonusWave threw, ending wave:', err);
      try { endBonusWave(); } catch (e) {}
      S.bonusWaveActive = false;
      endWave();
      return;
    }
    // Live HUD update — no total shown per user direction. Just the
    // running freed count keeps the player focused on saving more
    // without a "ceiling" hint that lets them know when to stop.
    const t = Math.ceil(state.timeLeft);
    UI.showObjective(
      (state.herdLabel || 'HERD') + ' · ' + state.caught + ' FREED',
      'Time left: ' + t + 's · shoot each 3 times to free',
    );
    if (state.finished) {
      const final = endBonusWave();
      // Wave-end toast in the player-facing voice: "You freed X
      // meebits!" — celebratory, no total reference, matches the
      // hidden-ceiling design.
      UI.toast(
        'YOU FREED ' + final.caught + ' MEEBITS!',
        '#ffd93d', 3200
      );
      // PERFECT-RUN BONUS: if the player freed every meebit in the
      // herd, grant a tangible reward stack:
      //   - +25,000 score (significant — a normal full bonus wave
      //     scores ~55,500 from per-catch points alone, so this is
      //     a meaningful ~45% multiplier on top)
      //   - one free grenade pickup at the player's position
      //   - celebratory "PERFECT RESCUE" toast a beat after the
      //     count toast so the rewards read as separate beats
      // Total === 0 guard prevents the bonus from triggering on a
      // degenerate case where the herd never spawned (unlikely but
      // defensive).
      if (final.total > 0 && final.caught >= final.total) {
        S.score += 25000;
        try {
          if (player && player.pos) {
            spawnPickup('grenade', new THREE.Vector3(player.pos.x, 0.5, player.pos.z));
          }
        } catch (e) { console.warn('[bonus-perfect] grenade', e); }
        // Slight delay so the toast doesn't stack on top of the
        // YOU FREED N toast — visual breathing room between the
        // two beats.
        setTimeout(() => {
          try { UI.toast('PERFECT RESCUE · +25,000 BONUS', '#a8ff8c', 3000); } catch (e) {}
        }, 1200);
      }
      // Wave 4 victory beat: shockwave rings out from the player.
      if (player && player.pos) {
        fireShockwave({ x: player.pos.x, y: 0.2, z: player.pos.z });
      }
      S.bonusWaveActive = false;
      endWave();
    }
    return;  // short-circuit; no other wave logic runs during bonus
  }

  updateOrbs(dt);
  spawnCooldown -= dt;

  // Boss pattern logic — runs every frame a boss is alive
  if (S.bossRef) {
    updateBossPattern(dt, S.bossRef);
  }

  const liveNonBosses = enemies.filter(e => !e.isBoss).length;

  // --- SHIELDED HIVE TRICKLE (waves 1 and 2) ---
  // Before the hive wave starts, the hives are visible-but-shielded, but
  // they should still feel ominously alive — a small trickle of enemies
  // oozes out even with the shields up. This gives the player a reason
  // to care about the hives while they're doing mining / power-up
  // objectives, and it telegraphs that wave 3 will be the full rush.
  //
  // Rate is heavily throttled vs. wave-3 (5× slower interval, hard cap
  // on total live trickle-spawned enemies) so the trickle feels like
  // ambient pressure, not a second wave.
  if (
    waveDef.type !== 'hive' &&
    waveDef.type !== 'spawners' &&
    waveDef.type !== 'boss' &&
    waveDef.type !== 'bonus' &&
    spawners.length > 0
  ) {
    const TRICKLE_INTERVAL = HIVE_CONFIG.spawnIntervalSec * 5;   // ~4s between spawns per hive
    const TRICKLE_MAX_ALIVE = 5;                                  // global cap across all hives
    // Only count trickle-spawned enemies toward the cap, not ones left
    // over from other systems. We tag them below with e._trickle.
    let trickleAlive = 0;
    for (const e of enemies) if (e._trickle && !e.isBoss) trickleAlive++;
    // F8 debug pause — skip all spawn attempts when on. Cooldowns still
    // tick so resuming doesn't dump a flood of pent-up spawns; they just
    // don't fire while paused.
    if (S._debugSpawnsPaused || S.cinematicSpawnHold) {
      // no-op: drain cooldowns harmlessly so we don't burst when resumed
      for (const s of spawners) {
        if (!s.destroyed) s.spawnCooldown -= dt;
      }
    } else if (trickleAlive < TRICKLE_MAX_ALIVE) {
      for (const s of spawners) {
        if (s.destroyed) continue;
        // On waves 1-2 the hives are shielded. The shield doesn't gate
        // trickle spawns — enemies still emerge (lore: the shield is
        // protective against damage, not a containment field).
        s.spawnCooldown -= dt;
        if (s.spawnCooldown <= 0 && s.enemiesAlive < 2) {
          // Much smaller per-hive alive cap (2 vs 16) so trickle feels
          // like a drip, not a flood.
          s.spawnCooldown = TRICKLE_INTERVAL * (0.85 + Math.random() * 0.3);
          // waveDef.enemies may be undefined/empty on non-combat waves;
          // fall back to a basic enemy set so the trickle still spawns.
          const pool = (waveDef.enemies && waveDef.enemies.length)
            ? waveDef.enemies
            : ['zomeeb'];
          const spawned = spawnFromPortal(s, pool);
          if (spawned) spawned._trickle = true;
          trickleAlive++;
          if (trickleAlive >= TRICKLE_MAX_ALIVE) break;
        }
      }
    }
  }

  if (waveDef.type === 'hive' || waveDef.type === 'spawners' || waveDef.type === 'queen-cleanup' || waveDef.type === 'twinhive') {
    // updateSpawners is now ticked unconditionally from main.js — no call here.
    // F8 debug pause — drain cooldowns but skip actual spawn calls.
    if (S._debugSpawnsPaused || S.cinematicSpawnHold) {
      for (const s of spawners) {
        if (!s.destroyed) s.spawnCooldown -= dt;
      }
    } else {
      // Per-wave overrides — wave 3 (hive) was too overwhelming when
      // combined with chapter hazards (Galaga bugs, ghosts, mines, etc.)
      // Lower default per-portal cap and slower spawn interval bring
      // wave 3 closer to wave 2's enemy density. Wave defs that don't
      // specify these fields use the global HIVE_CONFIG defaults.
      const portalCap = (waveDef.maxEnemiesPerPortal != null)
        ? waveDef.maxEnemiesPerPortal
        : HIVE_CONFIG.maxEnemiesPerPortal;
      const spawnInterval = (waveDef.spawnIntervalSec != null)
        ? waveDef.spawnIntervalSec
        : HIVE_CONFIG.spawnIntervalSec;
      for (const s of spawners) {
        if (s.destroyed) continue;
        s.spawnCooldown -= dt;
        if (s.spawnCooldown <= 0 && s.enemiesAlive < portalCap) {
          // Smaller jitter window because cadence is already fast
          s.spawnCooldown = spawnInterval * (0.8 + Math.random() * 0.4);
          spawnFromPortal(s, waveDef.enemies);
        }
      }
    }
    if (livePortalCount() === 0) {
      // Wave 3 victory beat:
      //   All hives sink into the ground before wave 4 begins. The
      //   enemies that were spawned from them still need to die for
      //   the wave to feel resolved — endWave() below clears any that
      //   are still alive on the next tick via clearEnemies().
      //
      // The shockwave that used to ripple out from the last-hive-standing
      // was removed — it added visual noise at the tail of a wave that's
      // already busy (hive retraction animation, any lingering enemies,
      // sparks from the final destroy). The retraction alone reads as
      // "the hives are defeated" clearly enough.
      startHiveRetraction();

      // CH.7 FINALE — instead of ending the wave when hives die, VESSEL
      // ZERO spawns at the center of the arena. The run ends when SHE
      // dies, not when the hives die. Flag prevents re-spawn on the
      // (impossible) case of hive-clear firing twice.
      if (waveDef && waveDef.ch7 && waveDef.ch7Finale && !S.vesselZeroSpawned) {
        S.vesselZeroSpawned = true;
        const lastHivePos = getLastHiveDeathPos();
        _spawnVesselZeroFinale(lastHivePos);
        return;   // do NOT call endWave — she has to die first
      }

      endWave();
      return;
    }
    S.spawnersLive = livePortalCount();
    UI.showObjective(
      'DESTROY THE HIVES (' + S.spawnersLive + '/' + spawners.length + ')',
      'Shoot or melee the glowing rings. Each has health.'
    );
  } else if (waveDef.type !== 'boss' || liveNonBosses < 8) {
    // Per-chapter difficulty damper. Chapter 2 felt overwhelming after
    // the weapon ladder reorder (rocket/raygun now unlock later), so we
    // tone down its spawn density. Other chapters left at 1.0.
    // Index into this array by chapterIdx (S.chapter, 0-based).
    const CH_DENSITY = [1.0, 0.55, 1.0, 1.0, 1.0, 1.0];
    const density = CH_DENSITY[S.chapter % CH_DENSITY.length] ?? 1.0;
    const maxOnScreen = waveDef.type === 'boss'
      ? 10
      : (waveDef.type === 'cannon-load'
          ? 25               // softened from 40 to 25 for new-player accessibility
          : Math.max(10, Math.floor((40 + S.wave * 2) * density)));
    if (spawnCooldown <= 0 && liveNonBosses < maxOnScreen && !S.hyperdriveActive && (waveDef.spawnRate || 0) > 0) {
      // Cooldown between spawn batches — lower density stretches this out.
      // Gated by S.hyperdriveActive so that during the 8s ATTACK-THE-AI
      // prelude, no enemies spawn — the player can move/aim/fire in an
      // empty arena while the rain overlay plays.
      // Tutorial mode clamps the rate to 1..2/sec so the practice arena
      // never floods the player.
      let baseRate = waveDef.spawnRate;
      if (S.tutorialMode) baseRate = tutorialSpawnRateOverride(baseRate);
      const effRate = baseRate * density;
      spawnCooldown = Math.max(0.15, 0.9 / effRate);
      let baseCount = Math.min(3, 1 + Math.floor(S.wave / 3));
      // Cannon-load — softened from 3 to 2 per-batch for new-player
      // accessibility. Combined with the lower spawnRate (14→8) and
      // lower maxOnScreen (40→25) the wave is now meaningfully gentler.
      if (waveDef.type === 'cannon-load') {
        baseCount = 2;
      }
      // Tutorial mode also limits the per-batch count so the spawn-rate
      // clamp isn't undermined by 3-at-a-time bursts.
      if (S.tutorialMode) baseCount = 1;
      const count = Math.max(1, Math.round(baseCount * density));
      for (let i = 0; i < count; i++) spawnFromMix(waveDef.enemies);
    }
  }

  if (waveDef.type === 'mining' && S.miningActive) {
    // CHAPTER 2 WAVE 1 — escort branch. Intercepts the standard mining
    // tick before the block-spawn / ore-deposit logic. Escort wave
    // ends when the truck arrives at the silo position; no ores or
    // blocks involved. Enemies still spawn via the standard spawn loop
    // earlier in the tick.
    if (waveDef.isEscortWave && S.isEscortWave) {
      const justArrived = updateEscortTruck(dt, player.pos, enemies);

      // Phase-aware objective text
      const playerNear = isPlayerInEscortRadius(player.pos);
      const blocked = isTruckBlocked();
      if (justArrived || isTruckArrived()) {
        UI.showObjective(
          'GENERATOR DELIVERED',
          'Securing the silo...',
        );
      } else if (!playerNear) {
        UI.showObjective(
          'STAY CLOSE TO THE GENERATOR',
          'Move within range so the truck can advance.',
        );
      } else if (blocked) {
        UI.showObjective(
          'CLEAR THE PATH',
          'Enemies are blocking the truck. Take them out.',
        );
      } else {
        UI.showObjective(
          'ESCORT THE GENERATOR',
          'Stay close · keep the path clear · drive to the silo.',
        );
      }

      if (justArrived) {
        // Arrival beat — decompression hiss + chapter-tinted bursts
        // already emitted by updateEscortTruck on this frame.
        try { Audio.truckDecompression && Audio.truckDecompression(); } catch (e) {}
        // Sink the truck into the ground — wave 1 ends, truck retreats
        // before wave 2 begins (mirrors crusher/cannon sink pattern).
        triggerTruckSink();
        UI.toast('GENERATOR DOCKED', '#a8ff8c', 2400);
        endWave();
        return;
      }
      // Skip the normal mining + block-spawn flow. Standard spawn loop
      // earlier in the tick still runs and feeds enemies.
      return;
    }

    // Keep feeding blocks as long as we still need more ore deposits
    const status = depotStatus();
    const deposited = status ? status.deposited : 0;
    const stillNeedOre = deposited < S.oresRequired;
    const isEggWave = !!waveDef.isEggWave;

    // Egg wave: detect the transition from N to N+1 deposits and fire
    // the crusher slam animation each time. The crusher exists only
    // for chapter 1, so triggerCrusherSlam is a no-op otherwise.
    if (isEggWave) {
      const last = S._lastEggDeposited || 0;
      if (deposited > last) {
        const bumps = deposited - last;
        for (let i = 0; i < bumps; i++) {
          triggerCrusherSlam();
        }
        S._lastEggDeposited = deposited;
      }
    }

    S.blockFallTimer -= dt;
    // Egg wave: NO block-spawn loop. Eggs were placed once at wave init.
    if (!isEggWave && stillNeedOre && S.blockFallTimer <= 0 && S.blocksSpawned < S.blocksToSpawn && !S.hyperdriveActive) {
      // Gated by S.hyperdriveActive so blocks don't rain during the
      // 8s prelude — the player gets a clean, empty arena for the intro.
      spawnBlock(S.chapter);
      S.blocksSpawned++;
      S.blockFallTimer = waveDef.blockFallRate * (0.7 + Math.random() * 0.6);
    }
    // Safety valve: if every block broke but ores were wasted (fell into
    // geometry, despawned, etc.) let the player get more blocks.
    // Disabled for egg waves — eggs are deliberate placements, not respawnable.
    if (!isEggWave && stillNeedOre && blocks.length === 0 && S.blocksSpawned >= S.blocksToSpawn) {
      S.blocksSpawned = Math.max(0, S.blocksSpawned - 2);
    }

    updateOres(dt, player);
    const complete = updateDepot(dt, player);

    const carry = S.oresCarried || 0;
    if (isEggWave) {
      // Phase-aware objective text:
      //   - Eggs still on field → "BREAK EGGS"
      //   - Eggs all gone, cubes spawned → "COLLECT CUBES"
      //   - Cubes all collected → very brief "WAVE COMPLETE" before
      //     the wave-end fires
      const cubesRemain = chargeCubesRemaining();
      const eggsLive = (typeof blocks !== 'undefined') ? blocks.filter(b => b.kind === 'egg').length : 0;
      if (eggsLive > 0) {
        UI.showObjective(
          'BREAK EGGS · ' + deposited + '/' + S.oresRequired + (carry ? '   (carrying ' + carry + ')' : ''),
          '~20 hits per egg · collect charges · drop at crusher'
        );
      } else if (cubesRemain > 0 || S._chargeCubesSpawned) {
        const collected = S.chargesCarried || 0;
        UI.showObjective(
          'COLLECT CHARGES · ' + collected + '/4',
          'The crusher has refined the ore. Walk over the glowing cubes to collect them.'
        );
      }
    } else {
      UI.showObjective(
        'DELIVER ORES · ' + deposited + '/' + S.oresRequired + (carry ? '   (carrying ' + carry + ')' : ''),
        '25 hits per block · or [Q] pickaxe (5 swings) · drop at depot beacon'
      );
    }

    // CHAPTER 1 — wave 1 ends when player has collected all 4 cubes.
    // The deposit logic does NOT signal `complete` for chapter 1
    // (suppressMegaOre is on). We watch chargesCarried instead.
    if (isEggWave && S._chargeCubesSpawned && (S.chargesCarried || 0) >= 4) {
      // Reset trackers — eggs/cubes phase is complete.
      S._lastEggDeposited = 0;
      S._chargeCubesSpawned = false;
      // Sink the crusher into the ground — wave 1 victory beat,
      // mirrors how the depot drives off in chapters 2-7.
      triggerCrusherSink();
      // Clear the cube cluster ring + clear the depot (decals + collider)
      // so wave 2 doesn't have leftover ring on the floor or ghost
      // collision where the crusher used to sit.
      clearChargeCubes();
      try {
        OresModule.clearDepot && OresModule.clearDepot();
      } catch (e) {}
      UI.toast('CHARGES SECURED', '#a8ff8c', 1800);
      endWave();
      return;
    }

    if (complete) {
      // Wave 1 victory beat:
      //   1. Shockwave ripples from the SILO — that's where the mega
      //      ore lands after the depot's catapult launches it. The
      //      depot's "sealing up" pulse was the old placement; now it
      //      matches the actual impact site so the shockwave reads as
      //      the ore's landing detonation.
      //   2. Depot drives off along the mining-triangle centerline.
      // The shockwave is purely visual; endWave() runs normal cleanup.
      // (Chapter 1 never reaches here — its wave-1 end runs through the
      // chargeCubes-collected path above, which calls endWave() directly.
      // This branch only fires for chapters 2-7's standard mining flow.)
      fireShockwave({ x: LAYOUT.silo.x, y: 0.2, z: LAYOUT.silo.z });
      const d = OresModule.depot;
      if (d) {
        startDepotDriveOff();
      }
      endWave();
      return;
    }
  } else {
    // Keep updating the depot so its idle-pulse animation ticks on non-
    // mining waves. updateDepot() early-outs on deposit logic when inactive.
    updateDepot(dt, player);
  }

  // POWER-UP WAVE — 5 sequential stand-in-zone objectives.
  // updatePowerupZones returns the id of a zone that JUST completed this
  // frame (or null). We react to each:
  //   POWER      → lights up the powerplant + energizes the wires
  //   TURRETS_A/B/C → bring each turret online
  //   RADIO      → opens the silo cap and raises the missile
  //   LAUNCH     → fires the launch cinematic (player held the pad)
  if (waveDef.type === 'powerup' && S.powerupActive) {
    const completedId = updatePowerupZones(dt, player.pos, performance.now() / 1000);
    if (completedId) {
      S.powerupStep = getCompletedCount();
      if (completedId === 'POWER') {
        UI.toast('POWER RESTORED', '#4ff7ff', 1600);
        setPowerplantLit(true);
        // Energize the wires from powerplant → turrets + silo.
        setWiresLit(true);
        // Unlock the pending flinger deployment. flingers.js watches
        // this flag — the flinger arrives the moment the plant lights.
        S.powerplantLit = true;
      } else if (completedId === 'TURRETS_A') {
        activateTurret(0);
        UI.toast('TURRET A ONLINE', '#ffd93d', 1600);
      } else if (completedId === 'TURRETS_B') {
        activateTurret(1);
        UI.toast('TURRET B ONLINE', '#ffd93d', 1600);
      } else if (completedId === 'TURRETS_C') {
        activateTurret(2);
        UI.toast('TURRET C ONLINE', '#ffd93d', 1600);
      } else if (completedId === 'RADIO') {
        UI.toast('RADIO COMMS ESTABLISHED', '#4ff7ff', 1800);
        // Phased silo launch sequence — replaces the old 10s flat
        // countdown. The hatch opens, missile pauses 2s with hatch
        // open, then slowly ascends, ignites with a bright flash,
        // climbs offscreen, and finally hands off to triggerLaunch
        // for the cross-map cinematic.
        //
        // Phases (durations cumulative):
        //   A 0.0..1.5s  hatch open animation
        //   B 1.5..3.5s  2-second hold with missile resting in tube
        //   C 3.5..6.5s  slow ascent (missile rises out of silo)
        //   D 6.5..7.0s  ignition — bright flash + smoke + shake
        //   E 7.0..8.5s  fast climb offscreen
        //   F 8.5s+      triggerLaunch() → empLaunch.js cross-map flight
        //
        // We replace the autoLaunchT countdown with `S.siloLaunchT` —
        // a single cumulative timer the per-frame block below uses to
        // dispatch phase actions. Hidden in the HUD branch below to
        // avoid showing both a countdown and the cinematic.
        openSiloHatchOnly();
        setLaunchSequenceActive(true);
        S.siloLaunchT = 0;
        S.siloLaunchPhase = 'A';
        S.siloLaunchIgnited = false;
        // Clear old countdown state so HUD doesn't show stale "Launching in Ns"
        S.autoLaunchT = 0;
        UI.toast('SILO HATCH OPENING', '#ffd93d', 1800);
      }
    }

    // ---- PHASED SILO LAUNCH SEQUENCE ----
    // Drives the missile through phases A..E based on cumulative time
    // since RADIO completed. Each phase reads/writes the missile y
    // directly via setMissileRaiseDirect. Phase E ends by calling
    // triggerLaunch() which hands off to empLaunch.js for the rest.
    if (typeof S.siloLaunchT === 'number' && S.siloLaunchPhase && !S.powerupEmpFired) {
      S.siloLaunchT += dt;
      const t = S.siloLaunchT;

      // Phase A (0..1.5s) — hatch is opening (cap rotation tween in
      // updateCompound runs concurrently). No missile y change.
      if (t < 1.5 && S.siloLaunchPhase !== 'A') {
        S.siloLaunchPhase = 'A';
      }

      // Phase B (1.5..3.5s) — missile sits at rest y=1.8 with hatch open.
      // No missile-y action needed; the cap-open tween has finished and
      // the missile y is set to 1.8 by default.
      if (t >= 1.5 && t < 3.5 && S.siloLaunchPhase !== 'B') {
        S.siloLaunchPhase = 'B';
      }

      // Phase C (3.5..6.5s) — slow ascent from y=1.8 to y=6.5 over 3s.
      if (t >= 3.5 && t < 6.5) {
        const cT = (t - 3.5) / 3.0;     // 0..1 across phase
        // Ease-in cubic so it starts barely moving and accelerates
        const eased = cT * cT;
        const y = 1.8 + eased * (6.5 - 1.8);
        setMissileRaiseDirect(y);
        if (S.siloLaunchPhase !== 'C') {
          S.siloLaunchPhase = 'C';
          UI.toast('MISSILE ASCENDING', '#ffaa00', 1500);
        }
      }

      // Phase D (6.5..7.0s) — IGNITION. Bright flash + smoke + shake.
      // One-shot trigger guarded by siloLaunchIgnited so visuals fire
      // exactly once even if the frame timing wobbles.
      if (t >= 6.5 && t < 7.0) {
        if (!S.siloLaunchIgnited) {
          S.siloLaunchIgnited = true;
          // Big visual: chapter-tinted hot core + white outer flash + smoke
          const launchOrigin = getSiloLaunchOrigin();
          if (launchOrigin) {
            // White-hot center ignition flash
            for (let k = 0; k < 3; k++) {
              hitBurst(
                { x: launchOrigin.x, y: launchOrigin.y - 1.5 + k * 0.4, z: launchOrigin.z },
                0xffffff, 60,
              );
            }
            // Orange/red smoke billow at base of missile
            for (let k = 0; k < 5; k++) {
              const a = (k / 5) * Math.PI * 2;
              hitBurst(
                {
                  x: launchOrigin.x + Math.cos(a) * 1.5,
                  y: launchOrigin.y - 2.5,
                  z: launchOrigin.z + Math.sin(a) * 1.5,
                },
                0xff6622, 30,
              );
            }
          }
          shake(0.7, 0.5);
          try { Audio.shot('rocket'); } catch (e) {}
          S.siloLaunchPhase = 'D';
          UI.toast('IGNITION', '#ff4400', 1200);
        }
        // Hold missile at peak-of-silo while ignition plays
        setMissileRaiseDirect(6.5);
      }

      // Phase E (7.0..8.5s) — fast climb offscreen. Y rockets from 6.5
      // to ~60 with quadratic acceleration. By the end the missile is
      // well above camera frustum.
      if (t >= 7.0 && t < 8.5) {
        const cT = (t - 7.0) / 1.5;     // 0..1
        // Quadratic acceleration — slow at start of phase, very fast at end
        const eased = cT * cT;
        const y = 6.5 + eased * 53.5;   // 6.5 → 60
        setMissileRaiseDirect(y);
        // Trail particles along the way
        if (Math.random() < 0.6) {
          const launchOrigin = getSiloLaunchOrigin();
          if (launchOrigin) {
            hitBurst(
              { x: launchOrigin.x + (Math.random() - 0.5) * 0.4, y: y - 2.0, z: launchOrigin.z + (Math.random() - 0.5) * 0.4 },
              0xff8833, 8,
            );
          }
        }
        if (S.siloLaunchPhase !== 'E') {
          S.siloLaunchPhase = 'E';
        }
      }

      // Phase F — hand off to empLaunch.js for the cross-map cinematic.
      // triggerLaunch() spawns its own missile mesh at the silo origin
      // and hides the in-silo copy. Releasing setLaunchSequenceActive
      // returns the silo missile to default tween behavior (which won't
      // matter because hideSiloMissile() inside the launch handler
      // hides it anyway).
      if (t >= 8.5 && S.siloLaunchPhase !== 'F') {
        S.siloLaunchPhase = 'F';
        setLaunchSequenceActive(false);
        UI.toast('LAUNCH INITIATED', '#4ff7ff', 2000);
        triggerLaunch();
      }
    }

    // Arrow stays visible from the moment the sequence starts until the
    // detonation handler hides it. Covers:
    //   - silo launch sequence (phases A..E, S.siloLaunchT < 8.5s)
    //   - missile flight + on-ground detonation countdown (isLaunching())
    // registerDetonationHandler calls hideMissileArrow() at explosion.
    const sequenceActive = (typeof S.siloLaunchT === 'number'
      && S.siloLaunchPhase
      && S.siloLaunchPhase !== 'F');
    const arrowActive =
      sequenceActive ||
      (typeof S.autoLaunchT === 'number' && S.autoLaunchT > 0) ||
      isLaunching();
    if (arrowActive) {
      const impact = getCentroidFor('hive');
      if (impact) {
        showMissileArrow(impact.x, impact.z, 'INCOMING STRIKE');
      }
    }

    // Drive the charging-spin flag on whichever turret zones have progress.
    // Clear first so no turret keeps spinning after its zone completes.
    for (let i = 0; i < 3; i++) setTurretCharging(i, false);
    if (!S.powerupEmpFired) {
      const chargingTurrets = getChargingTurretStatus();
      for (const c of chargingTurrets) {
        setTurretCharging(c.turretIdx, true);
      }
    }

    // HUD update.
    if (!S.powerupEmpFired) {
      const az = getActiveZone();
      if (az) {
        const pct = Math.floor(getActiveProgress() * 100);
        UI.showObjective(
          'POWER-UP · STEP ' + (S.powerupStep + 1) + '/' + S.powerupStepMax + ' · ' + az.label,
          'Stand in the glowing zone · ' + pct + '%',
        );
      } else if (sequenceActive) {
        // Silo launch sequence — phase-aware HUD text. Each phase
        // gets a clear "what's happening now" line so the player
        // reads the cinematic as a sequence of beats rather than
        // a generic countdown.
        const phase = S.siloLaunchPhase;
        let header = 'MISSILE ARMED';
        let detail = 'Stand by';
        if (phase === 'A') {
          header = 'SILO HATCH';
          detail = 'Opening blast doors...';
        } else if (phase === 'B' || (phase === 'A' && S.siloLaunchT >= 1.5)) {
          header = 'MISSILE ARMED';
          detail = 'Pre-launch hold · standby';
        } else if (phase === 'C') {
          header = 'MISSILE ASCENDING';
          detail = 'Rising from silo';
        } else if (phase === 'D') {
          header = 'IGNITION';
          detail = 'Engines firing';
        } else if (phase === 'E') {
          header = 'LAUNCHING';
          detail = 'Climbing to altitude';
        }
        UI.showObjective(header, detail);
      } else if (typeof S.autoLaunchT === 'number' && S.autoLaunchT > 0) {
        // Legacy fallback — preserved in case any callers still flip
        // the old autoLaunchT variable. The phased sequence above is
        // the normal path post-RADIO.
        const left = Math.ceil(S.autoLaunchT);
        UI.showObjective(
          'MISSILE ARMED',
          'Launching in ' + left + 's · Survive the wait',
        );
      } else if (isLaunching()) {
        UI.showObjective('EMP MISSILE LAUNCHED', 'Survive until detonation.');
      }
    }
  }

  // CHAPTER 1 REFLOW — wave 2 (cannon-load) real flow.
  //
  // Phases:
  //   A) Player walks to the cannon (calm — no enemy spawning yet)
  //   B) Player stands within ~4.5u of the cannon → 5s AUTO-CHARGE.
  //      Progress accumulates while close, drains slowly when far.
  //      At 100% the charges insert and the cannon arms.
  //   C) Cannon ARMED — pandemonium begins. Spawn rate ramps 14→30,
  //      4 cannon shots fire over the next 60s, each pops one queen
  //      shield dome. Wave ends when 4th dome pops.
  if (waveDef.type === 'cannon-load' && S.cannonLoadActive) {
    const queen = getQueen();
    // Cannon proximity uses the cannon's FOOT (silo position).
    const cannonFootX = LAYOUT.silo.x;
    const cannonFootZ = LAYOUT.silo.z;

    // 4-CORNER CHARGING STATE MACHINE
    //   approach:        player walks toward cannon, no corners active yet.
    //                    First corner activates when within 6u of cannon foot.
    //   corner-charging: corner N's ring is active. Player stands on it
    //                    for CORNER_CHARGE_DURATION → fires shot N → pops
    //                    next shield. Consume corner N → enter reload phase.
    //   reload:          1.5s window. Corner N is consumed. Next corner
    //                    activates after delay. If shotIdx >= 4 → done.
    //   done:            All 4 shots fired, all shields popped. Wave end
    //                    triggers via the existing shields-down branch.

    const CORNER_CHARGE_DURATION = 4.0;
    const RELOAD_DURATION = 0.6;     // brief gap before next corner activates

    // Pandemonium spawn rate: ramp up once the FIRST corner activates
    // (player has reached the cannon, narrative is "going hot now").
    if (S.cannonPhase === 'approach') {
      waveDef.spawnRate = 0;     // calm during walk
    } else {
      waveDef.spawnRate = 14;    // BRING IT
    }

    // Aim the cannon at the next intact dome each frame
    if (queen && queen.pos) aimCannonAt(queen.pos);

    // PHASE: APPROACH
    if (S.cannonPhase === 'approach') {
      const cdx = player.pos.x - cannonFootX;
      const cdz = player.pos.z - cannonFootZ;
      const inRange = (cdx * cdx + cdz * cdz) < (6 * 6);
      if (inRange) {
        // Player has reached the cannon — arm it + activate first corner
        S.cannonPhase = 'corner-charging';
        S.cannonShotIdx = 0;
        S.cannonCornerChargeT = 0;
        // Load all charges into the cannon visually (the slot lights pop)
        const toLoad = S.chargesCarried || 4;
        for (let i = 0; i < toLoad; i++) loadChargeSlot();
        S.chargesLoaded = (S.chargesLoaded || 0) + toLoad;
        S.chargesCarried = 0;
        armCannon();
        // Activate corner 0 — visible chapter-tinted ring at NE corner
        setActiveCannonCorner(0);
        // Hide the central charge ring — corners take over now
        setCannonChargeZoneVisible(false);
        // Spawn flinger ally
        try {
          S.powerplantLit = true;
          addFlingerCharge(0);
          S.flingerRequested = true;
        } catch (e) {}
        UI.toast('CANNON ARMED — FIRE FROM CORNERS', '#ff5050', 2400);
      }
    }
    // PHASE: CORNER-CHARGING
    else if (S.cannonPhase === 'corner-charging') {
      const idx = S.cannonShotIdx;
      const cornerPos = getCannonCornerPos(idx);
      if (cornerPos) {
        const ddx = player.pos.x - cornerPos.x;
        const ddz = player.pos.z - cornerPos.z;
        const inCorner = (ddx * ddx + ddz * ddz) < (1.6 * 1.6);
        if (inCorner) {
          S.cannonCornerChargeT = Math.min(CORNER_CHARGE_DURATION, (S.cannonCornerChargeT || 0) + dt);
          // Charging tick SFX
          S._cannonCornerTickT = (S._cannonCornerTickT || 0) - dt;
          if (S._cannonCornerTickT <= 0) {
            S._cannonCornerTickT = 0.4;
            try { Audio.cannonChargingTick && Audio.cannonChargingTick(S.cannonCornerChargeT / CORNER_CHARGE_DURATION); } catch (e) {}
          }
        } else {
          // Slow drain when off corner
          S.cannonCornerChargeT = Math.max(0, (S.cannonCornerChargeT || 0) - dt * 0.3);
        }
        setCannonCornerProgress(S.cannonCornerChargeT / CORNER_CHARGE_DURATION);

        // Charge complete — FIRE THIS SHOT IMMEDIATELY
        if (S.cannonCornerChargeT >= CORNER_CHARGE_DURATION) {
          if (queen && queen.pos) {
            // forceFireCannon bypasses the 15s SHOT_INTERVAL cooldown
            // that tryFireCannon enforces — corner charging IS the
            // cooldown now. Each charge completion fires immediately.
            const fired = forceFireCannon(queen.pos);
            const muzzlePos = getCannonOrigin();
            const domePos = getNextDomePos();
            if (muzzlePos && domePos) spawnCannonBeam(muzzlePos, domePos);
            // Always pop a shield even if forceFireCannon returned
            // false (defensive — never leave the player stuck after
            // a successful corner charge).
            popQueenShield();
          }
          // Consume this corner + start reload
          consumeCannonCorner(idx);
          S.cannonShotIdx = idx + 1;
          S.cannonReloadT = RELOAD_DURATION;
          S.cannonPhase = 'reload';
          setActiveCannonCorner(-1);    // no corner active during reload

          // CASCADE: each successful corner charge brings another part
          // of the central compound online. Visually connects the
          // corner-charging-zone mechanic to the rest of the chapter
          // (powerplant + silo). Each call is idempotent — if the
          // system is already lit/open from a powerup zone earlier
          // in the chapter, the call is harmless.
          //   Shot 1 → light the powerplant (gives "the corner energy
          //            woke the plant up" feel).
          //   Shot 4 → open the silo hatch (the final shot triggers
          //            the launch sequence's first beat).
          // Shots 2 + 3 still feel meaningful because they pop queen
          // shields; we just don't add a separate compound effect for
          // them. Pacing wise the shots feel like beats: shot 1 lights
          // up the plant (audible whoosh from setPowerplantLit's
          // existing animation), shot 4 opens the silo (preparing the
          // finale). Shots 2-3 are pure combat beats.
          try {
            if (idx === 0) {
              setPowerplantLit(true);
              UI.toast && UI.toast('POWERPLANT ONLINE', '#ffd93d', 1400);
            } else if (idx === 3) {
              openSiloHatchOnly();
              UI.toast && UI.toast('SILO ARMED', '#ff6a1a', 1400);
            }
          } catch (e) { console.warn('[cannon-cascade]', e); }
        }
      }
    }
    // PHASE: RELOAD (between shots)
    else if (S.cannonPhase === 'reload') {
      S.cannonReloadT = Math.max(0, (S.cannonReloadT || 0) - dt);
      if (S.cannonReloadT <= 0) {
        if (S.cannonShotIdx >= 4) {
          // All 4 shots fired — done
          S.cannonPhase = 'done';
        } else {
          // Activate next corner
          S.cannonCornerChargeT = 0;
          setActiveCannonCorner(S.cannonShotIdx);
          S.cannonPhase = 'corner-charging';
        }
      }
    }

    // Wave end when all 4 domes are down (matches old logic)
    if (queenShieldsRemaining() === 0 && (S.chargesLoaded || 0) >= 4) {
      S.cannonLoadActive = false;
      deactivateAllTurrets();
      clearAllTurrets();
      triggerCannonSink();
      setCh1Wave2PropsRemoved(true);
      UI.toast('SHIELDS DOWN — QUEEN EXPOSED', '#ff3cac', 2200);
      endWave();
      return;
    }

    // Objective text — phase-aware
    if (S.cannonPhase === 'approach') {
      UI.showObjective(
        'WALK TO THE CANNON',
        'Approach the cannon to begin firing.',
      );
    } else if (S.cannonPhase === 'corner-charging') {
      const popped = 4 - queenShieldsRemaining();
      const pct = Math.round((S.cannonCornerChargeT / CORNER_CHARGE_DURATION) * 100);
      UI.showObjective(
        'CHARGE CORNER ' + (S.cannonShotIdx + 1) + '/4 · ' + pct + '%',
        'Stand on the lit corner to fire shot ' + (S.cannonShotIdx + 1) + ' · ' + popped + ' shield' + (popped !== 1 ? 's' : '') + ' down',
      );
    } else if (S.cannonPhase === 'reload') {
      const popped = 4 - queenShieldsRemaining();
      UI.showObjective(
        'RELOADING · ' + popped + '/4 shields down',
        'Next corner activates in ' + Math.ceil(S.cannonReloadT) + 's',
      );
    } else if (S.cannonPhase === 'done') {
      UI.showObjective(
        'BARRAGE COMPLETE',
        'All shields neutralized.',
      );
    }
  }

  // CHAPTER 2 WAVE 2 — datacenter onslaught state machine (REWORKED).
  if (waveDef.type === 'datacenter' && S.dcActive) {
    const chargeZone = getChargingZonePos();
    const podPos = getPodPos();

    // ── PHASE A — WAREHOUSE-CHARGING ──────────────────────────────
    // Player charges the right-front-of-warehouse zone for 5s. This
    // calls in the safety pod (descending from sky into hive zone).
    if (S.dcPhase === 'warehouse-charging') {
      // Suppress enemy spawns during the calm walk-to-zone
      waveDef.spawnRate = 0;
      const CHARGE_DURATION = 5.0;
      if (chargeZone) {
        const dx = player.pos.x - chargeZone.x;
        const dz = player.pos.z - chargeZone.z;
        const inZone = (dx * dx + dz * dz) < (3.5 * 3.5);
        if (inZone) {
          S.dcChargeT = Math.min(CHARGE_DURATION, (S.dcChargeT || 0) + dt);
          setSystemOnline(S.dcChargeT / CHARGE_DURATION);
          setChargeZoneProgress(S.dcChargeT / CHARGE_DURATION);
          // Charging tick SFX
          S._dcChargeTickT = (S._dcChargeTickT || 0) - dt;
          if (S._dcChargeTickT <= 0) {
            S._dcChargeTickT = 0.4;
            try { Audio.cannonChargingTick && Audio.cannonChargingTick(S.dcChargeT / CHARGE_DURATION); } catch (e) {}
          }
        } else {
          // Slow drain when off zone
          S.dcChargeT = Math.max(0, (S.dcChargeT || 0) - dt * 0.5);
          setSystemOnline(S.dcChargeT / CHARGE_DURATION);
          setChargeZoneProgress(S.dcChargeT / CHARGE_DURATION);
        }
      }
      // Drive wires from warehouse → each turret + silo. Charge fraction
      // climbs as the player powers up the datacenter — visual story:
      // "you're feeding power down the wires to the turrets."
      const chargeFrac = (S.dcChargeT || 0) / CHARGE_DURATION;
      for (let ti = 0; ti < 3; ti++) {
        setWireCharge(ti, chargeFrac);
      }
      // Charge complete? → call the pod + lock wires bright
      if (S.dcChargeT >= CHARGE_DURATION) {
        S.dcPhase = 'pod-descending';
        S.dcPhaseT = 0;
        setChargeZoneVisible(false);
        // Lock wires bright — turrets are now powered for the rest of
        // wave 2. setWiresLit handles the silo wire; setWireComplete
        // locks each turret wire individually.
        setWiresLit(true);
        for (let ti = 0; ti < 3; ti++) setWireComplete(ti);
        // Activate turrets, summon flinger, trigger pod descent
        activateTurretsUpTo(waveDef.turretCount || 3);
        try {
          S.powerplantLit = true;
          addFlingerCharge(0);
        } catch (e) {}
        try { Audio.serverOnline && Audio.serverOnline(); } catch (e) {}
        if (hasSafetyPod()) {
          triggerPodDescent();
          S._dcPodDescentTriggered = true;
        }
        UI.toast('SYSTEM ONLINE — POD INBOUND', '#a8ff8c', 2400);
      } else {
        const pct = Math.round((S.dcChargeT / CHARGE_DURATION) * 100);
        if (S.dcChargeT > 0) {
          UI.showObjective(
            'CHARGING DATACENTER · ' + pct + '%',
            'Stay in the charging zone.',
          );
        } else {
          UI.showObjective(
            'CHARGE THE DATACENTER',
            'Walk to the charging zone (right-front of warehouse).',
          );
        }
      }
    }
    // ── PHASE B — POD-DESCENDING ──────────────────────────────────
    // Pod is descending from sky into hive zone. Enemies spawn at full
    // intensity. Player must defend until pod lands + opens.
    else if (S.dcPhase === 'pod-descending') {
      S.dcPhaseT = (S.dcPhaseT || 0) + dt;
      waveDef.spawnRate = 14;
      // Open the pod once it's landed (safetyPod transitions to 'landed'
      // automatically after DESCENT_DURATION = 6s in pod's internal clock)
      if (hasSafetyPod() && !S._dcPodOpenTriggered) {
        // Open shortly after landing (allow visual to settle)
        if (S.dcPhaseT > 6.5) {
          S._dcPodOpenTriggered = true;
          triggerPodOpen();
          // Move to charging phase — pod now becomes its own charge station
          S.dcPhase = 'pod-charging';
          S.dcPhaseT = 0;
          UI.toast('POD READY — CHARGE TO FIRE', '#a8ff8c', 2400);
        }
      }
      UI.showObjective(
        'POD INBOUND',
        'Defend until the pod lands at the hive zone.',
      );
    }
    // ── PHASE C — POD-CHARGING ────────────────────────────────────
    // Player stands inside the open pod (at hive zone center) for 5s.
    // This calls the per-hive laser strike. Enemies still pouring in.
    else if (S.dcPhase === 'pod-charging') {
      waveDef.spawnRate = 14;
      const POD_CHARGE_DURATION = 5.0;
      if (podPos) {
        const dx = player.pos.x - podPos.x;
        const dz = player.pos.z - podPos.z;
        const inPod = (dx * dx + dz * dz) < (2.0 * 2.0);
        // Once player enters pod for the first time, set lock-in flag.
        // Player can't leave the pod until lasers complete (see main.js
        // for the clamp). Tells the player decisively: "you're committed."
        if (inPod && !S._dcPlayerInPod) {
          S._dcPlayerInPod = true;
          UI.toast('LOCKED IN — DEPLOYING LASERS', '#a8ff8c', 2000);
        }
        if (inPod) {
          S.dcPodChargeT = Math.min(POD_CHARGE_DURATION, (S.dcPodChargeT || 0) + dt);
          // Charging tick SFX (climbing pitch)
          S._dcPodChargeTickT = (S._dcPodChargeTickT || 0) - dt;
          if (S._dcPodChargeTickT <= 0) {
            S._dcPodChargeTickT = 0.4;
            try { Audio.cannonChargingTick && Audio.cannonChargingTick(S.dcPodChargeT / POD_CHARGE_DURATION); } catch (e) {}
          }
        } else {
          S.dcPodChargeT = Math.max(0, (S.dcPodChargeT || 0) - dt * 0.5);
        }
      }
      // Charge complete? → spawn per-hive lasers
      if (S.dcPodChargeT >= POD_CHARGE_DURATION) {
        S.dcPhase = 'hive-lasers';
        S.dcPhaseT = 0;
        // Spawn per-hive sky beams over each surviving spawner
        const livePositions = [];
        for (const s of spawners) {
          if (!s || s.destroyed) continue;
          if ((s.hp || 0) <= 0) continue;
          if (s.pos) livePositions.push({ x: s.pos.x, z: s.pos.z });
        }
        spawnHiveLasers(S.chapter || 0, livePositions);
        try { Audio.laserCharging && Audio.laserCharging(); } catch (e) {}
        UI.toast(portalLabels().targetingToast, '#ff8826', 2200);
      } else {
        const pct = Math.round((S.dcPodChargeT / POD_CHARGE_DURATION) * 100);
        if (S.dcPodChargeT > 0) {
          UI.showObjective(
            'CHARGING POD · ' + pct + '%',
            'Stand inside the pod to call lasers.',
          );
        } else {
          UI.showObjective(
            'GET TO THE POD',
            'Stand in the pod (hive zone) to call lasers.',
          );
        }
      }
    }
    // ── PHASE D — HIVE-LASERS ─────────────────────────────────────
    // Per-hive sky beams strike each hive (visual telegraph for the
    // incoming arena blast). Beams ramp + hold + fade. After they
    // finish, transition to finale-laser.
    else if (S.dcPhase === 'hive-lasers') {
      S.dcPhaseT = (S.dcPhaseT || 0) + dt;
      waveDef.spawnRate = 14;
      UI.showObjective(
        'LASERS LOCKING ON',
        'Stay in the pod — incoming blast.',
      );
      // hiveLasers handles its own ramp/hold/fade — wait for done
      if (isHiveLasersDone()) {
        clearHiveLasers();
        // Trigger the big arena laser
        S.dcPhase = 'finale-laser';
        S.dcPhaseT = 0;
        S.dcLaserTriggered = true;
        triggerLaserBlast();
        if (hasSafetyPod()) setPodLaserActive(true);
        UI.toast('GET TO SAFETY', '#ff3030', 3000);
        shake(1.2, 0.4);
      }
    }
    // ── PHASE E — FINALE-LASER ────────────────────────────────────
    // Big arena laser fires. Damages anyone outside pod, destroys
    // hive shields with cascade animation, kills all enemies on
    // ground (pod-shielded player survives).
    else if (S.dcPhase === 'finale-laser') {
      waveDef.spawnRate = 0;     // no new spawns during the kill
      const safe = isPlayerInPod(player.pos);
      // Lethal damage if outside pod
      if (!safe) {
        S.hp = Math.max(0, (S.hp || 100) - dt * 200);   // ~200/s damage
        try {
          S._dcBlastDamageTick = (S._dcBlastDamageTick || 0) - dt;
          if (S._dcBlastDamageTick <= 0) {
            S._dcBlastDamageTick = 0.05;
            UI.damageFlash && UI.damageFlash();
          }
        } catch (e) {}
      }
      // Kill all ground enemies — wide-area blast
      for (const e of enemies) {
        if (!e || e.dead || e.destroyed) continue;
        e.hp = 0;
      }
      // Destroy hive shields with the cascade powering-down animation
      // (sparks + collapse). This is the "cool animation" — it's already
      // implemented in dormantProps.js, we just trigger it here.
      if (!S.dcShieldsDropped && isLaserBlasting()) {
        S.dcShieldsDropped = true;
        removeHiveShields();
        try { Audio.laserBlast && Audio.laserBlast(); } catch (e) {}
      }
      UI.showObjective(
        'LASER FIRING',
        safe ? 'Hold inside the pod.' : 'GET TO THE POD!',
      );
      // When laser system reports done, advance to done phase
      if (!isLaserActive()) {
        S.dcPhase = 'done';
        if (hasSafetyPod()) setPodLaserActive(false);
      }
    }
    // ── PHASE F — DONE → end wave ─────────────────────────────────
    else if (S.dcPhase === 'done') {
      S.dcActive = false;
      // Cleanup: deactivate turrets so wave 3 is the player's fight
      deactivateAllTurrets();
      clearAllTurrets();
      // Sink the server warehouse — wave 2 ends
      triggerServerSink();
      // Clear safety pod — wave 3 doesn't need it
      clearSafetyPod();
      // Turn 9: clear pod lock-in flag — player free to move again
      S._dcPlayerInPod = false;
      // Turn 9: retract wires + reset wire animations so the lit wires
      // don't linger into wave 3 (player ran into "wires left over"
      // after wave 2). startWireRetraction triggers a brief retract
      // animation; resetWireAnimations clears any locked state.
      try { startWireRetraction(); } catch (e) {}
      // Turn 9: hard-clear chapter 1 wave 2 props flag, mirroring the
      // ch1 cleanup. Without this, residual collision logic against
      // the (hidden) silo + radio + powerplant LAYOUT positions can
      // leave ghost obstacles for the player after wave 2.
      setCh1Wave2PropsRemoved(true);
      UI.toast('GRID FRIED — ' + portalLabels().exposeToast, '#ff3cac', 2400);
      endWave();
      return;
    }
  }

  if (waveDef.type === 'rescue' && S.rescueMeebit) {
    if (!S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      applyCageDamage(dt);
    }
    updateRescueMeebit(
      S.rescueMeebit, dt, player.pos,
      (m) => {
        S.rescuedIds.push(m.meebitId);
        S.rescuedCount++;
        S.score += 2500;
        UI.toast('MEEBIT #' + m.meebitId + ' FREED! +2500', '#ffd93d', 2200);
        Audio.levelup();
      },
      (m) => { S.rescueMeebit = null; },
      (m) => {
        UI.toast('MEEBIT #' + m.meebitId + ' LOST TO THE HORDE', '#ff2e4d', 2500);
        Audio.damage();
        shake(0.5, 0.4);
      }
    );
    if (S.rescueMeebit && !S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      const prog = S.rescueMeebit.rescueProgress / S.rescueMeebit.rescueTarget;
      const cagePct = (S.rescueMeebit.cageHp / S.rescueMeebit.cageHpMax * 100).toFixed(0);
      if (prog > 0) {
        UI.showObjective('FREEING... ' + Math.round(prog * 100) + '%', 'Cage: ' + cagePct + '%');
      } else {
        UI.showObjective('PROTECT THE CAGE · ' + cagePct + '%', 'Stand near the cage to start rescue');
      }
    }
  }

  if (waveDef.type === 'rescue' && S.waveKillsProgress >= S.waveKillTarget) {
    if (S.rescueMeebit && !S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      UI.showObjective('ENEMIES CLEARED — FREE THE MEEBIT', 'Stand near the cage to free them');
      return;
    }
    endWave();
  }
}

// ============================================================================
// EMP handler — fires at the end of the power-up wave. Shakes the camera,
// blasts chapter-colored particles from every hive, calls removeHiveShields()
// to drop shields (enrages the hives), then ends the wave. Stage 2 will also
// deactivate the turrets here.
// ============================================================================
function _fireEmp() {
  UI.toast('EMP LAUNCHED — ' + portalLabels().empSuffix, '#4ff7ff', 2500);
  shake(0.8, 0.8);
  Audio.bigBoom && Audio.bigBoom();

  const tint = CHAPTERS[S.chapter % CHAPTERS.length].full.grid1;
  // Shockwave particle bursts at each hive — signals the shield drop.
  for (const h of spawners) {
    if (h.destroyed) continue;
    const pos = new THREE.Vector3(h.pos.x, 2.5, h.pos.z);
    hitBurst(pos, 0xffffff, 20);
    hitBurst(pos, tint, 18);
  }

  // Drop the shields — wave 3 can now damage the hives.
  removeHiveShields();

  // EMP also kills the turrets. They stay visible as dormant props for
  // the rest of the chapter (just like the hives-post-destruction). Clear
  // any in-flight turret bullets so nothing exits the EMP firing.
  deactivateAllTurrets();
  clearTurretBullets();

  // Power-up wave HUD cleanup before endWave.
  endPowerupWave();
  // Remove the floor disks — they're wave-2 scoped and shouldn't carry
  // into the hive / herd / boss waves that follow.
  clearPowerupZones();
  // Reset silo cap, missile, powerplant lighting so the next wave 2 in
  // a new chapter starts clean. Cheap flag flips — the compound teardown
  // on chapter end catches this too, but running it here keeps the
  // intra-chapter state consistent if anything ever re-enters wave 2.
  resetCompoundAnimations();
  resetWireAnimations();

  // Wave 2 victory beat: the whole compound (silo + powerplant + radio
  // tower + 3 turrets) retracts into the ground over ~2s. Lore: "safety
  // mechanisms retract when systems fail." The shockwave from the missile
  // detonation already fired at the hive-triangle centroid via empLaunch,
  // so we don't fire another here.
  startCompoundRetraction();
  // Wires connect powerplant → turrets/silo — they sink with the rest of
  // the compound so nothing dangles into wave 3. After retraction they're
  // fully removed from the scene; rebuilt on the next chapter's wave 2.
  startWireRetraction();

  // End the power-up wave; wave 3 (hive) picks up next.
  S.powerupActive = false;
  // Clear the powerplant-lit gate so the next chapter's wave 2 starts
  // with the flinger again waiting for POWER completion.
  S.powerplantLit = false;
  endWave();
}

// ============================================================================
// BOSS PATTERN LOGIC — summoner or cubestorm
// ============================================================================
function updateBossPattern(dt, boss) {
  // --- BROODMOTHER (VESSEL ZERO) — ch.7 final boss pattern ---
  // Instead of the single 50% HP trigger the other bosses use, VESSEL
  // ZERO has THREE escalating panic phases at 75%, 50%, and 25% HP.
  // Between phases she spawns continuous pressure: 3-5 infectors every
  // 2.5s + a roach swarm every 6s. She doesn't melee, doesn't ranged-
  // fire — her whole threat model is the flood.
  if (boss.pattern === 'broodmother') {
    const hpFrac = boss.hp / boss.hpMax;

    // ---- WAKE TRIGGER ----
    // She starts dormant — no spawning, no damage, just sleeping mass
    // at the center of the arena. Player drains her to 75% HP using
    // the lifedrainer or whatever. At that threshold she WAKES and
    // the real fight begins. This is a one-shot transition.
    if (boss.dormant && hpFrac < 0.75) {
      boss.dormant = false;
      boss.phase75Triggered = true;
      // Wake animation — big shake + toast. Future polish: an emissive
      // flash on the maw, a roar audio cue. For now: scoreboard event.
      try { shake(0.8, 0.6); } catch (e) {}
      UI.toast('THE BROODMOTHER AWAKENS', '#ff4466', 2500);
      // First swarm right away — flood the player who's been comfortably
      // chipping away at sleeping mass.
      _broodmotherPanic(boss, 12, 8);
    }

    // ---- DORMANT: skip spawning + cooldowns ----
    // While asleep she doesn't drip infectors or burst roaches. The
    // spawn cooldowns drain harmlessly so they don't all fire at once
    // when she wakes up.
    if (boss.dormant) {
      boss.infectorSpawnCd = Math.max(0, boss.infectorSpawnCd - dt);
      boss.roachSwarmCd = Math.max(0, boss.roachSwarmCd - dt);
      return;
    }

    // ---- AWAKE PHASE ESCALATIONS ----
    // 50% and 25% trigger additional panic bursts, layering on top of
    // the continuous drip. Phase75 was the wake event; she's been
    // active since then.
    if (!boss.phase50Triggered && hpFrac < 0.50) {
      boss.phase50Triggered = true;
      _broodmotherPanic(boss, 20, 15);
      UI.toast('THE FLOOD RISES', '#ff2233', 2500);
    }
    if (!boss.phase25Triggered && hpFrac < 0.25) {
      boss.phase25Triggered = true;
      _broodmotherPanic(boss, 25, 20);
      UI.toast('VESSEL ZERO RECLAIMS HER CHILDREN', '#aa0033', 3000);
    }

    // Continuous infector drip.
    boss.infectorSpawnCd -= dt;
    if (boss.infectorSpawnCd <= 0) {
      boss.infectorSpawnCd = 2.5;
      _broodmotherSpawnInfectors(boss, 3 + Math.floor(Math.random() * 3));
    }

    // Periodic roach burst — the flood-wave moment.
    boss.roachSwarmCd -= dt;
    if (boss.roachSwarmCd <= 0) {
      boss.roachSwarmCd = 6.0;
      _broodmotherSpawnRoaches(boss, 8 + Math.floor(Math.random() * 5));
    }

    return;   // broodmother doesn't run the standard summoner/cubestorm logic
  }

  // ---------------------------------------------------------------
  // FACTION PAINT CADENCE — applies to every faction boss (chapters
  // 1-6 wave 5). Per the boss rework spec: 4 X/Y/Z paint hazards
  // per fight, fired at HP thresholds 90 / 70 / 50 / 30%. Each fires
  // exactly once. Idempotent — flag-guarded with paint90/70/50/30.
  //
  // Faction letter comes from the boss type:
  //   X → BLAZE_WARDEN, TOXIC_MAW       (chapters 1, 4)
  //   Y → SCARLET_REAPER, GLACIER_WRAITH (chapters 2, 5)
  //   Z → SOLAR_TYRANT, NIGHT_HERALD     (chapters 3, 6)
  // VESSEL_ZERO (broodmother, chapter 7) returned above and never
  // reaches this code, so the null-letter case is handled.
  const _factionLetter = (() => {
    if (boss.type === 'BLAZE_WARDEN' || boss.type === 'TOXIC_MAW') return 'X';
    if (boss.type === 'SCARLET_REAPER' || boss.type === 'GLACIER_WRAITH') return 'Y';
    if (boss.type === 'SOLAR_TYRANT' || boss.type === 'NIGHT_HERALD') return 'Z';
    return null;
  })();
  if (_factionLetter) {
    const hpFracPaint = boss.hp / boss.hpMax;
    const tint = CHAPTERS[(S.chapter || 0) % CHAPTERS.length].full.grid1;
    // Min-spacing guard: at least 6s between paints so a fast-killing
    // player doesn't stack all 4 letters in the same second. The
    // threshold flag still tracks "paint X has been QUEUED" but we
    // wait for the spacing window before actually firing it.
    const PAINT_MIN_SPACING = 6.0;
    boss._paintCooldownT = Math.max(0, (boss._paintCooldownT || 0) - dt);
    const canPaint = boss._paintCooldownT <= 0;
    if (!boss.paint90 && hpFracPaint < 0.90 && canPaint) {
      boss.paint90 = true;
      boss._paintCooldownT = PAINT_MIN_SPACING;
      try { paintFactionHazard(_factionLetter, tint); } catch (e) {}
    }
    if (!boss.paint70 && hpFracPaint < 0.70 && canPaint && boss.paint90) {
      boss.paint70 = true;
      boss._paintCooldownT = PAINT_MIN_SPACING;
      try { paintFactionHazard(_factionLetter, tint); } catch (e) {}
    }
    if (!boss.paint50 && hpFracPaint < 0.50 && canPaint && boss.paint70) {
      boss.paint50 = true;
      boss._paintCooldownT = PAINT_MIN_SPACING;
      try { paintFactionHazard(_factionLetter, tint); } catch (e) {}
    }
    if (!boss.paint30 && hpFracPaint < 0.30 && canPaint && boss.paint50) {
      boss.paint30 = true;
      boss._paintCooldownT = PAINT_MIN_SPACING;
      try { paintFactionHazard(_factionLetter, tint); } catch (e) {}
    }
  }

  // BLAZE_WARDEN unique mechanic — one-shot 30-pumpkinhead burst,
  // staggered over ~1.5s so the spawns feel like a wave instead of
  // a single-frame teleport-in (and so 30 simultaneous enemy
  // creations don't spike the frame budget). Each tick spawns
  // 4 minions every 0.2s for ~7 ticks until the burst completes.
  if (boss.type === 'BLAZE_WARDEN') {
    if (!boss.blazeBurstStarted) {
      boss.blazeBurstStarted = true;
      boss.blazeBurstRemaining = 30;
      boss.blazeBurstNextAt = 0;       // fire first batch immediately
      UI.toast && UI.toast('PUMPKINHEAD BURST', '#ff6a1a', 2000);
    }
    if (boss.blazeBurstRemaining > 0) {
      boss.blazeBurstNextAt -= dt;
      if (boss.blazeBurstNextAt <= 0) {
        boss.blazeBurstNextAt = 0.2;
        const batch = Math.min(4, boss.blazeBurstRemaining);
        summonMinions(boss, batch, /*silent=*/true);
        boss.blazeBurstRemaining -= batch;
      }
    }
  }

  // ---------------------------------------------------------------
  // TOXIC_MAW unique mechanic — toxic puddles. Per spec: puddles
  // damage on touch, cap of 6 alive at once (FIFO eviction inside
  // bossPuddles.spawnPuddle so the cadence stays smooth), shrink
  // over time (built into the puddle lifecycle).
  //
  // Cadence: every ~4-5s drop a puddle 6-15u from the boss at a
  // random angle. Far enough that the player has space to engage
  // the boss without immediately stepping in fresh acid; close
  // enough that retreating to the arena edge doesn't escape it.
  if (boss.type === 'TOXIC_MAW') {
    boss.puddleCooldown = (boss.puddleCooldown == null) ? 2.0 : boss.puddleCooldown - dt;
    if (boss.puddleCooldown <= 0) {
      boss.puddleCooldown = 4.0 + Math.random() * 1.0;
      // Random position in a ring around the boss
      const angle = Math.random() * Math.PI * 2;
      const dist  = 6 + Math.random() * 9;
      const px = boss.pos.x + Math.cos(angle) * dist;
      const pz = boss.pos.z + Math.sin(angle) * dist;
      // Clamp inside arena (puddle radius 3, leave 1u safety margin)
      const lim = ARENA - 4;
      try {
        spawnPuddle(
          Math.max(-lim, Math.min(lim, px)),
          Math.max(-lim, Math.min(lim, pz)),
        );
      } catch (e) { console.warn('[TOXIC_MAW puddle]', e); }
    }
  }

  // ---------------------------------------------------------------
  // SCARLET_REAPER unique mechanic — two waves of 50 red devils.
  // Wave 1 fires at fight start, wave 2 fires when the boss drops
  // below 50% HP. Each wave staggers 5 devils every 0.3s for ~10
  // ticks (3 seconds of active spawning per wave) to avoid the
  // framerate spike of 50 simultaneous enemy creations and to read
  // as a flowing spawn rather than instantaneous teleport-in.
  //
  // The forceTypes=['red_devil'] override on summonMinions ensures
  // pure devils — without it we'd get the chapter-2 mix that
  // includes vampires + sprinters mixed in with the devils.
  if (boss.type === 'SCARLET_REAPER') {
    // Wave 1 — kickoff burst on first frame
    if (!boss.devilWave1Started) {
      boss.devilWave1Started = true;
      boss.devilWave1Remaining = 25;
      boss.devilWave1NextAt = 0;          // fire first batch immediately
      UI.toast && UI.toast('FIRST DEVIL SWARM · 25 INCOMING', '#ff2e4d', 2200);
    }
    if (boss.devilWave1Remaining > 0) {
      boss.devilWave1NextAt -= dt;
      if (boss.devilWave1NextAt <= 0) {
        boss.devilWave1NextAt = 0.3;
        const batch = Math.min(5, boss.devilWave1Remaining);
        summonMinions(boss, batch, /*silent=*/true, ['red_devil']);
        boss.devilWave1Remaining -= batch;
      }
    }
    // Wave 2 — 50% HP trigger. Same staggered cadence.
    if (!boss.devilWave2Started && boss.hp / boss.hpMax < 0.5) {
      boss.devilWave2Started = true;
      boss.devilWave2Remaining = 25;
      boss.devilWave2NextAt = 0;
      UI.toast && UI.toast('SECOND DEVIL SWARM · 25 MORE', '#ff2e4d', 2200);
    }
    if (boss.devilWave2Started && boss.devilWave2Remaining > 0) {
      boss.devilWave2NextAt -= dt;
      if (boss.devilWave2NextAt <= 0) {
        boss.devilWave2NextAt = 0.3;
        const batch = Math.min(5, boss.devilWave2Remaining);
        summonMinions(boss, batch, /*silent=*/true, ['red_devil']);
        boss.devilWave2Remaining -= batch;
      }
    }
  }

  // ---------------------------------------------------------------
  // GLACIER_WRAITH unique mechanic — telegraphed arena freeze with
  // multi-pod safety zones. Per spec: "telegraph freeze is coming.
  // Land a pod or two near the boss. Boss attacks. Killing everything
  // not in pod."
  //
  // Cycle: first freeze fires 8s into the fight (gives the player
  // time to learn the boss). Subsequent freezes every 12s.
  // Escalation: 1 pod first cycle, 2 pods after — second pod gives
  // the player options no matter which way they were running when
  // the warning hit.
  //
  // Damage rules (applied on the single frame the freeze fires):
  //   - Player outside any pod: -60 HP (heavy but not auto-OHKO so
  //     a near-miss isn't a one-shot run-ender)
  //   - Enemies outside any pod: instakill (matches "killing
  //     everything not in pod" spec)
  //   - Player inside any pod: no damage
  //   - Enemies inside any pod: no damage (rare; minions usually
  //     don't path into the safe zone but if they did, fair's fair)
  if (boss.type === 'GLACIER_WRAITH') {
    if (boss.freezeCooldown == null) {
      boss.freezeCooldown = 8.0;        // first cycle 8s in
      boss.freezeCycleCount = 0;
    }
    boss.freezeCooldown -= dt;
    if (boss.freezeCooldown <= 0 && getFreezePhase() === 'idle') {
      boss.freezeCycleCount++;
      // Escalation: cycle 1 = 1 pod, cycle 2+ = 2 pods
      const podCount = (boss.freezeCycleCount === 1) ? 1 : 2;
      try {
        triggerFreezeCycle({ x: boss.pos.x, z: boss.pos.z }, podCount);
      } catch (e) { console.warn('[GLACIER_WRAITH freeze]', e); }
      boss.freezeCooldown = 12.0;
    }

    // Damage application — exactly one frame per cycle.
    if (didFreezeFireThisFrame()) {
      // Player damage. Respects invuln (dash-frames pass through).
      // 60 HP — heavy but not auto-OHKO so a near-miss isn't a
      // one-shot run-ender.
      if (S.invulnTimer <= 0) {
        if (!isInsideAnyPod(player.pos.x, player.pos.z)) {
          S.hp -= 60;
          if (S.hp <= 0) S.hp = 0;
          if (UI && UI.damageFlash) UI.damageFlash();
          shake(0.4, 0.4);
        }
      }
      // Enemy genocide — kill anything outside a pod. Iterate
      // backward in case enemy death triggers splice in caller.
      // The boss itself is in the enemies array but we skip it
      // (don't want the boss to suicide on its own freeze).
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        if (!e || e === boss) continue;
        if (e.isBoss) continue;          // any sub-bosses
        if (!e.pos) continue;
        if (isInsideAnyPod(e.pos.x, e.pos.z)) continue;
        // Set HP to 0 — the regular enemy update path will detect
        // and dispose. Going through .hp instead of direct dispose
        // ensures kill-credit + score + XP land like normal kills.
        e.hp = 0;
      }
    }
  }
  // ---------------------------------------------------------------

  // ---------------------------------------------------------------
  // SOLAR_TYRANT unique mechanic — predictive AOE solar flares. Per
  // spec: every 4s, predict where the player will be 2s in the
  // future based on their current velocity, drop a 4u-radius flare
  // there. 1.5s telegraph then 0.5s active damage window.
  //
  // Gameplay teaching: punishes constant-velocity kiting. A player
  // moving in a straight line will land at the predicted point on
  // schedule and eat 35 damage. Standing still also gets punished
  // (zero velocity → flare drops on top of the player). Survival
  // requires changing direction OR speed during the 1.5s telegraph.
  if (boss.type === 'SOLAR_TYRANT') {
    // One-shot range override on first frame. The shared boss base
    // sets ranged=true / range=20, which means the boss STOPS moving
    // whenever the player is within 20u — that's most of the fight,
    // so the boss visibly camps in place. Drop SOLAR_TYRANT's range
    // to 6 so it aggressively closes distance and keeps repositioning.
    // Player observation: "the solar tyrant just stood still the
    // whole match."
    if (!boss._solarRangeOverridden) {
      boss._solarRangeOverridden = true;
      boss.range = 6;
    }
    boss.solarFlareCooldown = (boss.solarFlareCooldown == null) ? 3.0 : boss.solarFlareCooldown - dt;
    if (boss.solarFlareCooldown <= 0) {
      boss.solarFlareCooldown = 4.0;
      // Project 2s ahead from current velocity. player.vel is set
      // each frame in main.js's player update. Standing still →
      // velocity zero → AOE drops on the player's current position.
      const LEAD_TIME = 2.0;
      const px = player.pos.x + player.vel.x * LEAD_TIME;
      const pz = player.pos.z + player.vel.z * LEAD_TIME;
      try {
        spawnSolarFlare(px, pz);
      } catch (e) { console.warn('[SOLAR_TYRANT flare]', e); }
    }
  }
  // ---------------------------------------------------------------

  // ---------------------------------------------------------------
  // NIGHT_HERALD unique mechanic — shielded phase at 50% HP. Per
  // spec: "shield + summon hives at 50% HP - 3 hives - when hives
  // are destroyed so is their shield."
  //
  // Phase flow:
  //   1. Fight starts: boss takes damage normally
  //   2. Boss HP drops below 50%: enter SHIELDED phase. Spawn 3
  //      hives in a triangle around the boss. Boss becomes
  //      invulnerable (boss.shielded = true) — damage sites in
  //      main.js gate on this flag and play shield-hit feedback
  //      instead of dropping HP.
  //   3. Player kills hives one by one. Each kill is checked via
  //      livePortalCount() per frame.
  //   4. Last hive dies: shield drops, boss takes damage again.
  //
  // The shield is a translucent magenta sphere parented to boss.obj
  // so it follows the boss's position automatically. Created on
  // shield activation, disposed on shield break.
  if (boss.type === 'NIGHT_HERALD') {
    // Activation trigger — fires once when the boss first drops
    // below 50% HP.
    if (!boss.heraldShieldStarted && boss.hp / boss.hpMax < 0.5) {
      boss.heraldShieldStarted = true;
      boss.shielded = true;

      // Spawn 3 hives in a triangle around the boss (8u from boss,
      // 120° apart). Each hive is pushed to the spawners array so
      // it integrates with the existing hive update/damage system.
      const chapterIdx = (S.chapter || 0) % CHAPTERS.length;
      const triangleR = 8;
      const baseAngle = Math.random() * Math.PI * 2;
      for (let i = 0; i < 3; i++) {
        const angle = baseAngle + (i * (Math.PI * 2 / 3));
        const hx = boss.pos.x + Math.cos(angle) * triangleR;
        const hz = boss.pos.z + Math.sin(angle) * triangleR;
        // Clamp inside arena
        const lim = ARENA - 4;
        const cx = Math.max(-lim, Math.min(lim, hx));
        const cz = Math.max(-lim, Math.min(lim, hz));
        try {
          const hive = spawnPortal(cx, cz, chapterIdx);
          spawners.push(hive);
        } catch (e) { console.warn('[NIGHT_HERALD hive]', e); }
      }

      // Build the shield visual — translucent chapter-tinted sphere
      // wrapping the boss. Uses buildShieldMaterials so the boss shield
      // gets the same hex-pattern texture + halo glow treatment as
      // hive shields, and its color is sourced from the current chapter
      // tint (CHAPTERS[S.chapter].full.grid1) instead of being
      // hardcoded — auto-adapts if the boss is ever moved between
      // chapters. Parented to boss.obj so it inherits position. Mesh
      // is stored on boss._heraldShield so the break path can dispose it.
      try {
        const shieldGeom = new THREE.SphereGeometry(3.5, 32, 24);
        const _chapterTint = CHAPTERS[(S.chapter || 0) % CHAPTERS.length].full.grid1;
        const { core: shieldMat, halo: haloMat } = buildShieldMaterials(_chapterTint);
        // Boss shield's resting opacity is lower than hive shields
        // (0.30 core / 0.18 halo vs 0.55 / 0.35 for hives) so the
        // boss silhouette stays readable through the bubble — the
        // player needs to see the boss to dodge its attacks.
        shieldMat.opacity = 0.30;
        haloMat.opacity = 0.18;
        const shieldMesh = new THREE.Mesh(shieldGeom, shieldMat);
        shieldMesh.position.y = 1.5;     // center at boss torso height
        // Halo overlay — slightly larger sphere, back-side rendered.
        // Geometry is per-boss-shield (smaller than hive shields, so
        // can't share with hive halo geo).
        const haloGeom = new THREE.SphereGeometry(3.5 * 1.10, 32, 24);
        const haloMesh = new THREE.Mesh(haloGeom, haloMat);
        shieldMesh.add(haloMesh);
        boss.obj.add(shieldMesh);
        boss._heraldShield = {
          mesh: shieldMesh, geom: shieldGeom, mat: shieldMat,
          haloMesh, haloGeom, haloMat,
        };
      } catch (e) { console.warn('[NIGHT_HERALD shield mesh]', e); }

      UI.toast && UI.toast('SHIELD UP · DESTROY THE 3 ' + portalLabels().nounPlural, '#e63aff', 2500);
      try { Audio.shieldHit && Audio.shieldHit(); } catch (e) {}
      shake(0.3, 0.3);
    }

    // While shielded, animate the shield (gentle pulse) and watch
    // for hive count to hit zero so we can break the shield.
    if (boss.shielded && boss._heraldShield) {
      const tNow = performance.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(tNow * 2.0);
      // Drive both core and halo opacity. Halo follows at 60% so
      // the outer glow tracks the core's breathing without
      // overpowering it.
      const op = 0.25 + 0.20 * pulse;
      boss._heraldShield.mat.opacity = op;
      if (boss._heraldShield.haloMat) {
        boss._heraldShield.haloMat.opacity = op * 0.60;
      }
      // Slight breathing-scale on the shield for life
      const sc = 1.0 + 0.04 * Math.sin(tNow * 1.5);
      boss._heraldShield.mesh.scale.set(sc, sc, sc);

      // Hive emit cadence — every 3-4s, each living hive coughs up one
      // minion. Per playtester request: "enemies spawn out of those
      // hives." Scope is small (one per hive per cycle) so the player
      // isn't drowning while also trying to kill the hives.
      boss.heraldHiveEmitCd = (boss.heraldHiveEmitCd == null) ? 3.0 : boss.heraldHiveEmitCd - dt;
      if (boss.heraldHiveEmitCd <= 0) {
        boss.heraldHiveEmitCd = 3.0 + Math.random() * 1.0;
        const pool = ['zomeeb', 'sprinter'];
        for (const s of spawners) {
          if (s.destroyed) continue;
          if (s.enemiesAlive >= 3) continue;   // soft cap per hive
          try { spawnFromPortal(s, pool); } catch (e) {}
        }
      }

      if (livePortalCount() === 0) {
        // All 3 hives down — drop the shield.
        boss.shielded = false;
        // Dispose the shield mesh
        try {
          if (boss._heraldShield.mesh.parent) {
            boss._heraldShield.mesh.parent.remove(boss._heraldShield.mesh);
          }
          if (boss._heraldShield.geom) boss._heraldShield.geom.dispose();
          if (boss._heraldShield.mat)  boss._heraldShield.mat.dispose();
          // Halo overlay — parented to core mesh so it auto-detaches
          // when core is removed from scene; just need to dispose its
          // dedicated geometry + material.
          if (boss._heraldShield.haloGeom) boss._heraldShield.haloGeom.dispose();
          if (boss._heraldShield.haloMat)  boss._heraldShield.haloMat.dispose();
        } catch (e) {}
        boss._heraldShield = null;
        UI.toast && UI.toast('SHIELD DOWN · ATTACK!', '#ffffff', 2200);
        try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
        shake(0.5, 0.5);
      }
    }
  }
  // ---------------------------------------------------------------

  // Trigger at 50% HP one-time "panic" summon
  if (!boss.halfHpTriggered && boss.hp / boss.hpMax < 0.5) {
    boss.halfHpTriggered = true;
    if (boss.pattern === 'summoner') {
      summonMinions(boss, 4);
    } else if (boss.pattern === 'cubestorm') {
      rainCubes(boss, 5);
    }
  }

  if (boss.pattern === 'summoner') {
    boss.summonCooldown -= dt;
    if (boss.summonCooldown <= 0) {
      boss.summonCooldown = 6 + Math.random() * 2;
      summonMinions(boss, 2);
    }
  } else if (boss.pattern === 'cubestorm') {
    boss.cubeStormCooldown -= dt;
    if (boss.cubeStormCooldown <= 0) {
      boss.cubeStormCooldown = 5 + Math.random();
      rainCubes(boss, 2 + Math.floor(Math.random() * 2));
    }
  }
}

// ============================================================================
// BROODMOTHER HELPERS — spawn the flood
// ============================================================================
/**
 * Spawn N infectors in a ring around the boss. Infectors are the
 * parasite enemy type — they seek the player, possess meebits on
 * contact, etc. These count toward S.kills on death like normal
 * enemies. Maw pulse boost gives a visible "she's summoning" tell.
 */
function _broodmotherSpawnInfectors(boss, count) {
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  const tint = fullTheme.enemyTint;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.6;
    const r = 3.5 + Math.random() * 2.5;
    const x = boss.pos.x + Math.cos(a) * r;
    const z = boss.pos.z + Math.sin(a) * r;
    const e = makeEnemy('infector', tint, new THREE.Vector3(x, 0, z));
    if (e) {
      hitBurst(new THREE.Vector3(x, 1.5, z), 0xff4466, 6);
      hitBurst(new THREE.Vector3(x, 1.5, z), tint, 4);
    }
  }
  if (boss._vesselPulseBoost != null) boss._vesselPulseBoost = 1.0;
}

/**
 * Spawn N roaches in a tight swarm. Roaches are the smaller, faster
 * parasite — the flood-wave read. They emerge closer to the boss than
 * infectors so they read as "bursting out of her body."
 */
function _broodmotherSpawnRoaches(boss, count) {
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  const tint = fullTheme.enemyTint;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.8 + Math.random() * 1.6;
    const x = boss.pos.x + Math.cos(a) * r;
    const z = boss.pos.z + Math.sin(a) * r;
    const e = makeEnemy('roach', tint, new THREE.Vector3(x, 0, z));
    if (e) {
      hitBurst(new THREE.Vector3(x, 0.8, z), 0xff4466, 3);
    }
  }
  if (boss._vesselPulseBoost != null) boss._vesselPulseBoost = 1.3;
  shake(0.15, 0.2);
}

/**
 * Panic burst at an HP threshold. Big simultaneous spawn of infectors
 * AND roaches, screen shake, maw flashes bright. The player should feel
 * overwhelmed for 2-3 seconds after each one.
 */
function _broodmotherPanic(boss, infectorCount, roachCount) {
  _broodmotherSpawnInfectors(boss, infectorCount);
  _broodmotherSpawnRoaches(boss, roachCount);
  shake(0.5, 0.6);
  try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
  if (boss._vesselPulseBoost != null) boss._vesselPulseBoost = 2.5;
}

function summonMinions(boss, count, silent, forceTypes) {
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  const chapterIdx = S.chapter % CHAPTERS.length;
  // Caller can override the chapter-default minion types. Used by
  // SCARLET_REAPER's red-devil swarm spec to force `['red_devil']`
  // instead of the chapter-2 mix that includes vampires/sprinters.
  let minionTypes;
  if (Array.isArray(forceTypes) && forceTypes.length) {
    minionTypes = forceTypes;
  } else if (chapterIdx === 0) minionTypes = ['sprinter', 'pumpkin'];
  else if (chapterIdx === 1) minionTypes = ['vampire', 'red_devil', 'sprinter'];
  else if (chapterIdx === 2) minionTypes = ['wizard', 'sprinter'];
  else if (chapterIdx === 3) minionTypes = ['goospitter', 'sprinter'];
  else minionTypes = ['sprinter', 'zomeeb'];

  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 2;
    const x = boss.pos.x + Math.cos(a) * r;
    const z = boss.pos.z + Math.sin(a) * r;
    const type = minionTypes[Math.floor(Math.random() * minionTypes.length)];
    const e = makeEnemy(type, fullTheme.enemyTint, new THREE.Vector3(x, 0, z));
    if (e) {
      hitBurst(new THREE.Vector3(x, 1.5, z), fullTheme.enemyTint, 8);
    }
  }
  // Toast + audio + shake suppressed when the caller is fanning out
  // multiple staggered batches (e.g. BLAZE_WARDEN's 30-pumpkinhead
  // burst). The caller fires a single big toast outside the loop.
  if (!silent) {
    UI.toast('THE BOSS SUMMONS MINIONS', '#ff2e4d', 1500);
    shake(0.2, 0.2);
    Audio.waveStart();
  }
}

function rainCubes(boss, count) {
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  for (let i = 0; i < count; i++) {
    // Drop cubes near the player (not on top of them — offset a bit)
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 8;
    const x = Math.max(-46, Math.min(46, player.pos.x + Math.cos(a) * r));
    const z = Math.max(-46, Math.min(46, player.pos.z + Math.sin(a) * r));
    // 60% hatch into enemy, 40% explode and hurt player
    const mode = Math.random() < 0.6 ? 'hatch' : 'explode';
    spawnBossCube(x, z, fullTheme.enemyTint, mode);
  }
  UI.toast('CUBES INCOMING!', '#ffd93d', 1400);
  shake(0.15, 0.2);
}

function applyCageDamage(dt) {
  const m = S.rescueMeebit;
  const cageRadius = 2.0;
  for (const e of enemies) {
    if (e.isBoss) continue;
    const dx = e.pos.x - m.pos.x;
    const dz = e.pos.z - m.pos.z;
    if (dx * dx + dz * dz < cageRadius * cageRadius) {
      damageCage(m, MEEBIT_CONFIG.cageBreakDamage * dt);
    }
  }
}

function updateCaptureZone(dt) {
  const zone = S.objectiveZone;
  if (!zone) return;
  const dx = player.pos.x - zone.pos.x;
  const dz = player.pos.z - zone.pos.z;
  const inZone = dx * dx + dz * dz < S.captureRadius * S.captureRadius;
  if (inZone) {
    S.captureProgress = Math.min(S.captureTarget, S.captureProgress + dt);
  }
  const pct = S.captureProgress / S.captureTarget;
  // Update ring fill + missile raise visual
  if (zone.inner) zone.inner.scale.setScalar(Math.max(0.2, pct));
  if (zone.ring) zone.ring.rotation.z += dt * 2;
  if (S.captureProgress >= S.captureTarget) {
    S.captureMissileLaunching = true;
    launchCaptureMissile(zone);
  }
  UI.showObjective(
    'CHARGING MISSILE · ' + Math.floor(pct * 100) + '%',
    inZone ? 'Inside zone — charging' : 'Get in the golden circle'
  );
}

function launchCaptureMissile(zone) {
  UI.toast('MISSILE LAUNCHING', '#ffd93d', 2000);
  shake(0.6, 0.6);

  let t = 0;
  const dur = 1.0;
  const raiseInterval = setInterval(() => {
    t += 0.05;
    if (zone && zone.missile) {
      zone.missile.position.y += 0.8;
      zone.missile.rotation.y += 0.2;
    }
    if (t >= dur) {
      clearInterval(raiseInterval);
      if (zone && zone.missile) {
        const boomPos = new THREE.Vector3(zone.pos.x, 4, zone.pos.z);
        hitBurst(boomPos, 0xffffff, 30);
        setTimeout(() => hitBurst(boomPos, 0xffd93d, 30), 80);
        setTimeout(() => hitBurst(boomPos, 0xff3cac, 30), 160);
      }
      grantCaptureReward();
      endWave();
    }
  }, 50);
}

function grantCaptureReward() {
  const rewards = ['shotgun', 'smg', 'rocket', 'raygun', 'flamethrower'];
  const id = rewards[S.chapter % rewards.length];
  grantWeapon(id);
}

function spawnFromMix(mix) {
  let total = 0;
  for (const v of Object.values(mix)) total += v;
  let r = Math.random() * total;
  let type = 'zomeeb';
  for (const [k, v] of Object.entries(mix)) {
    if (r < v) { type = k; break; }
    r -= v;
  }
  const angle = Math.random() * Math.PI * 2;
  const dist = 28 + Math.random() * 12;
  const x = Math.max(-48, Math.min(48, player.pos.x + Math.cos(angle) * dist));
  const z = Math.max(-48, Math.min(48, player.pos.z + Math.sin(angle) * dist));
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  // Tutorial mode swaps in pure black/white instead of the chapter tint
  // so the meebits read clearly against the rainbow practice floor.
  const tint = S.tutorialMode
    ? tutorialEnemyColor(fullTheme.enemyTint)
    : fullTheme.enemyTint;
  makeEnemy(type, tint, new THREE.Vector3(x, 0, z));
}

function spawnFromPortal(portal, mix) {
  // Chapter 7 PARADISE FALLEN override — hives always emit infectors
  // regardless of the mix. This makes the infection truly dominant
  // without needing separate wave logic.
  const waveDef = getWaveDef(S.wave);
  if (waveDef && waveDef.hivesEmitInfectors) {
    const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
    const a = Math.random() * Math.PI * 2;
    const x = portal.pos.x + Math.cos(a) * 1.2;
    const z = portal.pos.z + Math.sin(a) * 1.2;
    // 85% infector, 15% roach — feels like an infection pulse
    const type = Math.random() < 0.85 ? 'infector' : 'roach';
    const e = makeEnemy(type, fullTheme.enemyTint, new THREE.Vector3(x, 0, z));
    if (e) {
      e.fromPortal = portal;
      portal.enemiesAlive++;
    }
    hitBurst(new THREE.Vector3(portal.pos.x, 2, portal.pos.z), portal.tint, 8);
    return e;
  }

  let total = 0;
  for (const v of Object.values(mix)) total += v;
  let r = Math.random() * total;
  let type = 'zomeeb';
  for (const [k, v] of Object.entries(mix)) {
    if (r < v) { type = k; break; }
    r -= v;
  }
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  const a = Math.random() * Math.PI * 2;
  const x = portal.pos.x + Math.cos(a) * 1.2;
  const z = portal.pos.z + Math.sin(a) * 1.2;
  const e = makeEnemy(type, fullTheme.enemyTint, new THREE.Vector3(x, 0, z));
  if (e) {
    e.fromPortal = portal;
    portal.enemiesAlive++;
  }
  hitBurst(new THREE.Vector3(portal.pos.x, 2, portal.pos.z), portal.tint, 8);
  return e;
}

// ============================================================================
// PRE-BOSS CINEMATIC
//
// Plays a short DOM-overlay cinematic before the boss appears. Purpose:
//   1. Dramatic beat — gives the boss reveal real weight instead of just
//      spawning into an already-cluttered arena.
//   2. LOADING MASK — runs preparePigPool(S.chapter) in parallel so the
//      bonus wave after the boss dies is guaranteed to be freeze-free.
//      (The matrix dive also does this upfront, but this is a belt-and-
//      suspenders layer in case the pool was cleared or the dive was skipped.)
//
// Visual: full-screen chapter-tinted overlay with
//   - huge "CHAPTER X · NAME" title on top line
//   - glyph divider
//   - huge BOSS NAME on bottom line
//   - two vignette scanning-line bars sweep across while the card is up
//
// Duration: ~6 seconds with fade in/out. Safe to call with no arguments beyond
// the wave def; uses S.chapter to resolve the chapter theme.
//
// Architecture: fire-and-forget. When the cinematic timer elapses, it calls
// spawnBoss() + UI.showBossBar() itself. This keeps startWave's boss branch
// clean and the game loop doesn't need any cinematic-aware gating because
// boss waves don't spawn filler enemies anyway.
// ============================================================================
// ============================================================================
// PRE-BOSS CINEMATIC
//
// Plays a full-screen OPAQUE cinematic before the boss appears. Purpose:
//   1. Dramatic beat — gives the boss reveal real weight.
//   2. FREEZE MASK — the cinematic is fully opaque and the game is paused
//      while it's up, so when we spawn the boss (and trigger the first-time
//      shader/PSO compile for that boss model), the freeze happens BEHIND the
//      overlay. Player sees smooth title card motion, not a gameplay stutter.
//   3. Safety-net pool build — if preparePigPool hasn't completed for this
//      chapter yet (shouldn't happen after the matrix dive, but defensive),
//      kicks off that work during the cinematic too.
//
// Strategy (in timeline order):
//   t=0     : pause game (S.paused=true), clear input buffer
//   t=0     : mount overlay, fade in opaque chapter-tinted background
//   t=300ms : start title animations
//   t=1200ms: spawn boss (first-render shader compile happens NOW, hidden)
//   t=5400ms: fade overlay out
//   t=6020ms: unpause, showBossBar, toast "APPROACHES"
//
// Visual tone:
//   - Fully opaque. NOT a transparent tint overlay — the arena behind must
//     not be visible because if we can see it, we can see the freeze.
//   - Heavy chapter-color presence. Ch.1 orange dominates Ch.1 cinematic;
//     Ch.2 crimson; Ch.3 gold; Ch.4 toxic green; Ch.5 arctic cyan; Ch.6 magenta.
//   - Black interior so text reads cleanly — color is in vignette + accents.
// ============================================================================
// ============================================================================
// Module state for the cinematic. Unlike the previous implementation, we now
// build the overlay DOM ONCE (lazily on first use, or eagerly at startup via
// prewarmBossCinematic) and reuse it every time a boss wave fires. This moves
// the ~30ms DOM/layout setup cost from "each wave 5" to "once at startup,"
// which was the last visible hitch at the moment the cinematic appeared.
// ============================================================================
let _cinematicTimer = 0;        // setTimeout id for the end-of-cinematic fire
let _cinematicSpawnTimer = 0;   // setTimeout id for the mid-cinematic boss spawn
let _cinematicActive = false;   // true while cinematic is up (also implies S.paused)

// Cached overlay structure — built once, reused for every cinematic.
// See _ensureCinematicDom() for what each handle points to.
let _cineDom = null;

// True while the pre-boss cinematic is on screen. Other modules can consult
// this if they ever need to know whether input gating is cinematic-driven
// vs pause-menu-driven.
export function isBossCinematicActive() { return _cinematicActive; }

/**
 * Eagerly build the cinematic overlay DOM and inject its keyframes so the
 * first use is zero-cost. Safe to call multiple times — idempotent.
 * Called by main.js at the end of prewarmShaders, which happens during the
 * player-avatar load phase, before gameplay starts.
 */
export function prewarmBossCinematic() {
  _ensureCinematicDom();
}

/**
 * Build the cinematic overlay DOM (once) and keep it detached from the body
 * until play time. On each play we just update text + colors and append.
 *
 * Returns the cached handles {root, gridPattern, chapLine, divider, bossLine,
 * flavor, scanTop, scanBot}.
 */
function _ensureCinematicDom() {
  if (_cineDom) return _cineDom;

  // Inject keyframes ONCE — they don't depend on per-cinematic values.
  if (!document.getElementById('boss-cinematic-keyframes')) {
    const styleTag = document.createElement('style');
    styleTag.id = 'boss-cinematic-keyframes';
    styleTag.textContent = `
      @keyframes boss-scan-h {
        0%   { left: -40%; }
        100% { left: 100%; }
      }
      @keyframes boss-scan-h-rev {
        0%   { right: -40%; }
        100% { right: 100%; }
      }
    `;
    document.head.appendChild(styleTag);
  }

  // --- Root overlay ---
  const root = document.createElement('div');
  root.id = 'boss-cinematic';
  root.style.cssText = `
    position: fixed; inset: 0;
    background: #000;
    z-index: 9500;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    opacity: 1;
    transition: opacity 0.4s ease-out;
    pointer-events: auto;
    overflow: hidden;
    font-family: monospace;
  `;

  const gridPattern = document.createElement('div');
  gridPattern.style.cssText = `
    position: absolute; inset: 0;
    mix-blend-mode: screen;
    opacity: 0.55;
    mask-image: radial-gradient(ellipse at center, transparent 20%, black 70%);
    -webkit-mask-image: radial-gradient(ellipse at center, transparent 20%, black 70%);
  `;
  root.appendChild(gridPattern);

  const chapLine = document.createElement('div');
  chapLine.style.cssText = `
    font-size: clamp(22px, 2.8vw, 36px);
    font-weight: bold;
    letter-spacing: 12px;
    transition: opacity 0.6s ease-out, transform 0.6s ease-out;
    margin-bottom: 22px;
    z-index: 2;
  `;
  root.appendChild(chapLine);

  const divider = document.createElement('div');
  divider.style.cssText = `
    width: 46vw; height: 3px;
    transition: opacity 0.7s ease-out;
    margin-bottom: 28px;
    z-index: 2;
  `;
  root.appendChild(divider);

  const bossLine = document.createElement('div');
  bossLine.style.cssText = `
    color: #ffffff;
    font-size: clamp(48px, 8vw, 128px);
    font-weight: bold;
    letter-spacing: 10px;
    transition: opacity 0.7s ease-out 0.2s, transform 0.9s ease-out 0.2s;
    text-align: center;
    max-width: 92vw;
    z-index: 2;
  `;
  root.appendChild(bossLine);

  const flavor = document.createElement('div');
  flavor.style.cssText = `
    font-size: clamp(13px, 1.5vw, 17px);
    letter-spacing: 8px;
    margin-top: 36px;
    transition: opacity 0.8s ease-out 0.5s;
    z-index: 2;
  `;
  flavor.textContent = '// INCOMING HOSTILE //';
  root.appendChild(flavor);

  const scanTop = document.createElement('div');
  scanTop.style.cssText = `
    position: absolute; left: -40%; top: 18%;
    width: 40%; height: 2px;
    animation: boss-scan-h 3.2s ease-in-out infinite;
    opacity: 0.9;
    z-index: 2;
  `;
  root.appendChild(scanTop);

  const scanBot = document.createElement('div');
  scanBot.style.cssText = `
    position: absolute; right: -40%; bottom: 18%;
    width: 40%; height: 2px;
    animation: boss-scan-h-rev 3.2s ease-in-out infinite;
    opacity: 0.9;
    z-index: 2;
  `;
  root.appendChild(scanBot);

  // Warm the layout engine once by attaching to body off-screen then removing.
  // This gets the browser's CSS parser + layout to process all the styles
  // NOW, instead of on first real use.
  root.style.visibility = 'hidden';
  root.style.pointerEvents = 'none';
  document.body.appendChild(root);
  // eslint-disable-next-line no-unused-expressions
  root.offsetHeight;  // force layout
  document.body.removeChild(root);
  root.style.visibility = '';
  root.style.pointerEvents = 'auto';

  _cineDom = { root, gridPattern, chapLine, divider, bossLine, flavor, scanTop, scanBot };
  return _cineDom;
}

// Apply per-cinematic color/text parameters to the cached DOM handles.
// Cheap — just attribute writes, no re-layout cost from tree surgery.
function _configureCinematic(dom, cssTint, cssAccent, chapterNum, chapterName, bossName) {
  const tintA55 = _cssWithAlpha(cssTint, 0.55);
  const tintA22 = _cssWithAlpha(cssTint, 0.22);
  const tintA80 = _cssWithAlpha(cssTint, 0.8);
  const tintA90 = _cssWithAlpha(cssTint, 0.9);
  const tintA60 = _cssWithAlpha(cssTint, 0.6);
  const accentA60 = _cssWithAlpha(cssAccent, 0.6);

  dom.root.style.background = `
    radial-gradient(ellipse at center,
      #000000 0%,
      #000000 30%,
      ${tintA55} 75%,
      ${cssTint} 100%)
  `;

  dom.gridPattern.style.backgroundImage = `
    linear-gradient(${tintA22} 1px, transparent 1px),
    linear-gradient(90deg, ${tintA22} 1px, transparent 1px)
  `;
  dom.gridPattern.style.backgroundSize = '56px 56px';

  dom.chapLine.style.color = cssTint;
  dom.chapLine.style.textShadow = `0 0 12px ${cssTint}, 0 0 28px ${cssTint}, 0 0 48px ${tintA80}`;
  dom.chapLine.textContent = `CHAPTER ${chapterNum} · ${chapterName}`;
  dom.chapLine.style.opacity = '0';
  dom.chapLine.style.transform = 'translateY(-20px)';

  dom.divider.style.background = `linear-gradient(to right, transparent, ${cssTint} 20%, ${cssAccent} 50%, ${cssTint} 80%, transparent)`;
  dom.divider.style.boxShadow = `0 0 20px ${cssTint}, 0 0 40px ${tintA60}`;
  dom.divider.style.opacity = '0';

  dom.bossLine.textContent = bossName;
  dom.bossLine.style.textShadow = `
    0 0 20px ${cssTint},
    0 0 44px ${cssTint},
    0 0 72px ${tintA90},
    0 0 120px ${accentA60}
  `;
  dom.bossLine.style.opacity = '0';
  dom.bossLine.style.transform = 'scale(0.82)';

  dom.flavor.style.color = cssTint;
  dom.flavor.style.textShadow = `0 0 12px ${cssTint}`;
  dom.flavor.style.opacity = '0';

  dom.scanTop.style.background = `linear-gradient(to right, transparent, ${cssTint}, transparent)`;
  dom.scanTop.style.boxShadow = `0 0 14px ${cssTint}`;
  dom.scanBot.style.background = `linear-gradient(to left, transparent, ${cssTint}, transparent)`;
  dom.scanBot.style.boxShadow = `0 0 14px ${cssTint}`;

  dom.root.style.opacity = '1';
}

/**
 * Play the pre-boss cinematic between wave 3 and wave 4.
 *
 * Historical note: in the previous design this fired AT wave 5 start and
 * also handled spawning the boss mid-cinematic to mask the boss-model
 * shader compile. Under the new design the cinematic fires one wave earlier
 * — end of wave 3, before wave 4 (the bonus herd) — so the herd VRM stream
 * has ~6s to resolve during the cinematic. The boss fight is wave 5 now
 * and startWave() handles its spawn directly.
 *
 * @param {object} nextWaveDef    the wave def we're about to transition INTO
 *                                (used only for framing — the cinematic now
 *                                always previews the boss that follows the
 *                                bonus wave).
 * @param {Function} onComplete   optional — fires when the cinematic's
 *                                fade-out finishes. The caller wires this
 *                                to start the next wave.
 */
function _playBossCinematic(nextWaveDef, onComplete) {
  // If we're somehow replaying the cinematic (shouldn't happen in normal flow),
  // tear down any existing one first.
  _teardownBossCinematic();

  const t0 = performance.now();
  console.info('[cinematic] begin');

  const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  const chapterNum = S.chapter + 1;
  const chapterName = chapter.name;
  // The cinematic always previews the chapter boss (wave 5) regardless of
  // which wave we're transitioning into — its job is to frame the BONUS
  // wave as "save the civilians before the boss arrives." We look up the
  // wave-5 def for the current chapter to get the boss name.
  const bossWaveForChapter = getWaveDef(S.chapter * WAVES_PER_CHAPTER + 5);
  const bossName = (bossWaveForChapter && bossWaveForChapter.bossType
                     ? bossWaveForChapter.bossType
                     : 'BOSS').replace(/_/g, ' ');
  const tintHex = chapter.full.grid1 || 0xffffff;
  const accentHex = chapter.full.orb || chapter.full.lamp || tintHex;
  const cssTint = '#' + tintHex.toString(16).padStart(6, '0');
  const cssAccent = '#' + accentHex.toString(16).padStart(6, '0');

  // --- Flag cinematic active + clear input buffer. ---
  _cinematicActive = true;
  mouse.down = false;
  for (const k in keys) keys[k] = false;
  // Grant invulnerability for the full cinematic duration + grace.
  S.invulnTimer = Math.max(S.invulnTimer || 0, 6.5);

  // --- Get the cached overlay DOM, configure it for this chapter, mount it. ---
  const dom = _ensureCinematicDom();
  _configureCinematic(dom, cssTint, cssAccent, chapterNum, chapterName, bossName);
  // Flavor line — matches your "save civilians for upcoming boss" beat.
  if (dom.flavor) dom.flavor.textContent = '// SAVE THE CIVILIANS · BOSS APPROACHES //';
  document.body.appendChild(dom.root);

  // Force layout flush so the overlay is committed before anything else runs.
  // eslint-disable-next-line no-unused-expressions
  dom.root.offsetHeight;

  console.info(`[cinematic] overlay mounted at +${(performance.now() - t0).toFixed(1)}ms`);

  // --- Animate in the inner content on the NEXT paint. ---
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      console.info(`[cinematic] first paint at +${(performance.now() - t0).toFixed(1)}ms — starting heavy work`);
      dom.chapLine.style.opacity = '1';
      dom.chapLine.style.transform = 'translateY(0)';
      setTimeout(() => { dom.divider.style.opacity = '1'; }, 200);
      setTimeout(() => {
        dom.bossLine.style.opacity = '1';
        dom.bossLine.style.transform = 'scale(1)';
      }, 400);
      setTimeout(() => { dom.flavor.style.opacity = '0.95'; }, 900);

      // --- HERD VRM POOL PREFETCH ---
      // This is the main reason the cinematic fires BEFORE wave 4 in the
      // new design — to hide the herd VRM stream behind the title card.
      // preparePigPool is idempotent, so if the matrix dive already built
      // this chapter's pool we're a no-op.
      try {
        preparePigPool(S.chapter, null, renderer, camera)
          .catch(err => console.warn('[cinematic] pool build (non-fatal):', err));
      } catch (err) {
        console.warn('[cinematic] pool build threw (non-fatal):', err);
      }

      try { Audio.waveStart(); } catch (e) {}
    });
  });

  // --- Schedule end-of-cinematic ---
  const HOLD_MS = 5400;
  _cinematicTimer = setTimeout(() => {
    dom.root.style.opacity = '0';
    setTimeout(() => {
      _teardownBossCinematic();
      _cinematicActive = false;
      console.info(`[cinematic] end at +${(performance.now() - t0).toFixed(1)}ms`);
      // Hand off to the caller — they start the next wave.
      if (typeof onComplete === 'function') {
        try { onComplete(); }
        catch (err) { console.warn('[cinematic] onComplete threw:', err); }
      }
    }, 620);
  }, HOLD_MS);
}

function _teardownBossCinematic() {
  if (_cinematicTimer) { clearTimeout(_cinematicTimer); _cinematicTimer = 0; }
  if (_cinematicSpawnTimer) { clearTimeout(_cinematicSpawnTimer); _cinematicSpawnTimer = 0; }
  // Detach the cached overlay (but keep it cached for reuse). We DON'T destroy
  // the DOM here — that would undo the whole point of caching.
  if (_cineDom && _cineDom.root && _cineDom.root.parentNode) {
    _cineDom.root.parentNode.removeChild(_cineDom.root);
  }
  // The game was never paused; just clear the active flag so input gating
  // in main.js goes back to normal.
  _cinematicActive = false;
}

// Helper — takes a "#rrggbb" string and an alpha 0..1, returns "rgba(r,g,b,a)".
function _cssWithAlpha(hexCss, alpha) {
  const r = parseInt(hexCss.slice(1, 3), 16);
  const g = parseInt(hexCss.slice(3, 5), 16);
  const b = parseInt(hexCss.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function spawnBoss() {
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  const angle = Math.random() * Math.PI * 2;
  const pos = new THREE.Vector3(Math.cos(angle) * 18, 0, Math.sin(angle) * 18);
  S.bossRef = makeBoss(waveDef.bossType, fullTheme.enemyTint, pos);
}

// ============================================================================
// VESSEL ZERO FINALE SPAWN — ch.7 wave 3, after hives destroyed
// ============================================================================
/**
 * Dramatic entrance for the ch.7 final boss. Called from the hive-clear
 * path (NOT the normal spawnBoss() route, because ch.7 wave 3 has no
 * bossType in its waveDef — she's a post-hive spawn, not a wave-start
 * spawn).
 *
 * Places her at the arena center (where the hives were), fires the
 * standard boss-bar UI, seeds bossFightStartTime so the pixl pal
 * co-deploy timer would have worked (moot in ch.7 since pals are
 * force-deployed on wave 31 start, but harmless to set).
 *
 * @param {THREE.Vector3|null} lastHivePos — passed through from the
 *   hive-clear handler; we prefer it so VESSEL ZERO materializes from
 *   the exact spot the last hive died, keeping narrative continuity.
 *   Falls back to arena center if null.
 */
function _spawnVesselZeroFinale(lastHivePos) {
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  const pos = lastHivePos
    ? new THREE.Vector3(lastHivePos.x, 0, lastHivePos.z)
    : new THREE.Vector3(0, 0, 0);

  // Dramatic entrance — screen shake, big burst, audio slam, heavy toast.
  shake(1.5, 0.8);
  try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
  for (let i = 0; i < 4; i++) {
    setTimeout(() => {
      hitBurst(new THREE.Vector3(pos.x, 2 + i * 1.2, pos.z), 0xff4466, 32);
      hitBurst(new THREE.Vector3(pos.x, 2 + i * 1.2, pos.z), 0xffffff, 20);
      hitBurst(new THREE.Vector3(pos.x, 2 + i * 1.2, pos.z), fullTheme.enemyTint, 24);
    }, i * 150);
  }

  // Spawn her. makeBoss detects the VESSEL_ZERO key and routes to the
  // custom mesh builder.
  S.bossRef = makeBoss('VESSEL_ZERO', fullTheme.enemyTint, pos);
  S.bossFightStartTime = S.timeElapsed;

  // Toast + boss bar. Big names get a longer duration toast — this one
  // is the climax of the run, give the player a moment to read it.
  UI.toast('VESSEL ZERO: BROODMOTHER · THE FLOOD BEGINS', '#ff2233', 4500);
  if (S.bossRef && UI.showBossBar) {
    // showBossBar signature is (name, tintHex) — we pass the display
    // name and a deep crimson tint appropriate to the broodmother.
    UI.showBossBar(S.bossRef.name || 'VESSEL ZERO', 0xff2233);
  }
}

function grantWeapon(weaponId) {
  S.ownedWeapons.add(weaponId);
  S.currentWeapon = weaponId;
  S.previousCombatWeapon = weaponId;
  UI.updateWeaponSlots();
  UI.toast('+' + WEAPONS[weaponId].name + ' UNLOCKED! Press ' + weaponSlotKey(weaponId) + ' to equip', '#ffd93d', 3000);
  Audio.weaponGet();
}

function weaponSlotKey(weaponId) {
  return { pistol: 1, shotgun: 2, smg: 3, rocket: 4, raygun: 5, flamethrower: 6 }[weaponId];
}

export function onEnemyKilled(enemy, killedInZone = false) {
  if (enemy.fromPortal && !enemy.fromPortal.destroyed) {
    enemy.fromPortal.enemiesAlive = Math.max(0, enemy.fromPortal.enemiesAlive - 1);
  }

  if (enemy.isBoss) {
    UI.hideBossBar();
    // Wave 5 victory beat: shockwave rings out from the boss's death spot.
    if (enemy.pos) {
      fireShockwave({ x: enemy.pos.x, y: 0.2, z: enemy.pos.z });
    }
    // Wipe any active faction paint hazards. The boss can no longer
    // paint new ones; existing painted letters (the mid-fight ones
    // that landed earlier) shouldn't persist into the wave-end
    // celebration. Idempotent — chapter 7 boss has no paint, no-op.
    try { clearFactionPaint(); } catch (e) {}
    // Wipe TOXIC_MAW puddles too. Idempotent for other bosses.
    try { clearAllPuddles(); } catch (e) {}
    // Wipe GLACIER_WRAITH freeze pods + flash overlay. Idempotent
    // for non-glacier bosses.
    try { clearFreeze(); } catch (e) {}
    // Wipe SOLAR_TYRANT flares. Idempotent for non-solar bosses.
    try { clearAllFlares(); } catch (e) {}
    // Wipe NIGHT_HERALD shield mesh if the boss died while shielded
    // (shouldn't happen since damage is gated, but defensive).
    try {
      if (enemy._heraldShield) {
        if (enemy._heraldShield.mesh && enemy._heraldShield.mesh.parent) {
          enemy._heraldShield.mesh.parent.remove(enemy._heraldShield.mesh);
        }
        if (enemy._heraldShield.geom) enemy._heraldShield.geom.dispose();
        if (enemy._heraldShield.mat)  enemy._heraldShield.mat.dispose();
        enemy._heraldShield = null;
      }
    } catch (e) {}
    S.bossRef = null;
    S.bossFightStartTime = null;
    grantBossReward();
    endWave();
  } else {
    S.waveKillsProgress++;
    if (waveDef && waveDef.type === 'capture' && killedInZone && !S.captureMissileLaunching) {
      S.captureProgress = Math.min(S.captureTarget, S.captureProgress + CAPTURE_KILL_BONUS);
    }
  }
}

export function onBlockMined() {
  S.blocksMined++;
}

export function isInCaptureZone(pos) {
  if (!S.objectiveZone) return false;
  const dx = pos.x - S.objectiveZone.pos.x;
  const dz = pos.z - S.objectiveZone.pos.z;
  return dx * dx + dz * dz < S.captureRadius * S.captureRadius;
}

function grantBossReward() {
  // Grant in the new order: shotgun -> smg -> rocket -> raygun -> flamethrower.
  const all = ['shotgun', 'smg', 'rocket', 'raygun', 'flamethrower'];
  const missing = all.filter(w => !S.ownedWeapons.has(w));
  if (missing.length > 0) {
    grantWeapon(missing[0]);
  } else {
    S.score += 10000;
    UI.toast('+10,000 SCORE', '#ffd93d', 2000);
  }
}

function endWave() {
  if (intermissionActive) return;
  intermissionActive = true;
  S.waveActive = false;

  // Bonus wave already fired its celebratory confetti in endBonusWave(),
  // and there are no enemies to wipe out — skip the nuke effect entirely.
  const wasBonus = !!(waveDef && waveDef.type === 'bonus');
  if (!wasBonus) {
    triggerNuke();
  }

  // Defensive cleanup in case the bonus wave was torn down mid-flight.
  if (wasBonus) {
    clearBonusWave();
    S.bonusWaveActive = false;
  }

  if (S.objectiveZone) {
    removeCaptureZone(S.objectiveZone);
    S.objectiveZone = null;
  }

  // MINING end — blocks + loose ores are wave-scoped, they go. The depot
  // STAYS (dormant prop); we just flip it to inactive. clearDepot() will
  // happen when the chapter ends.
  if (S.miningActive) {
    S.miningActive = false;
    clearAllBlocks();
    clearAllOres();
    setDepotActive(false);
    if (S.currentWeapon === 'pickaxe') {
      S.currentWeapon = S.previousCombatWeapon || 'pistol';
      UI.updateWeaponSlots();
    }
  }
  // HIVE end — hives themselves are chapter-scoped (they get cleaned when
  // the chapter resets), but we clear the "wave is active" bits here.
  if (S.spawnerWaveActive) {
    S.spawnerWaveActive = false;
    S.hiveWaveActive = false;
    S.spawnersLive = 0;
  }
  // POWER-UP end — defensive clear of wave flags + zone/turret state.
  // _fireEmp() already called endPowerupWave + clearTurretBullets + zone
  // teardown when the EMP fired. This path covers edge cases (e.g. a
  // boss-wave early exit, game reset mid-wave) where we want to be sure
  // nothing leaks.
  if (S.powerupActive) {
    S.powerupActive = false;
    endPowerupWave();
    clearPowerupZones();
    clearTurretBullets();
  }
  clearBossCubes();
  clearCornerMarkers(scene);
  if (S.rescueMeebit) {
    if (!S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      removeRescueMeebit(S.rescueMeebit);
    }
    S.rescueMeebit = null;
  }
  UI.hideObjective();

  // CHAPTER 7 (PARADISE FALLEN) END — it's only 3 waves long, not 5.
  // Detect via the ch7 flag on the current waveDef + its localWave === 3.
  // This runs INSTEAD of the normal "next wave" transition. We show the
  // final "SIMULATION CLEANSED" toast, save the run, and drop the player
  // to the game-over screen so they see their final score.
  const ch7FinaleJustFinished =
    waveDef && waveDef.ch7 && waveDef.localWave === 3;
  if (ch7FinaleJustFinished) {
    // Different victory copy depending on whether VESSEL ZERO was
    // reached. If she spawned, the run was completed by killing her;
    // otherwise (hives cleared but boss spawn was somehow skipped,
    // e.g. debug fast-forward) fall back to the original toast.
    const victoryMsg = S.vesselZeroSpawned
      ? 'BROODMOTHER FELLED · SIMULATION CLEANSED'
      : 'SIMULATION CLEANSED';
    UI.toast(victoryMsg, '#ffffff', 5000);
    Save.onChapterComplete({
      chapter: S.chapter, wave: S.wave, score: S.score, rescuedIds: S.rescuedIds,
    });
    // Small delay so the player reads the toast before the overlay lands.
    setTimeout(() => {
      intermissionActive = false;
      // Trigger the normal game-over overlay (player survived, but the
      // run is over — final score + stats).
      S.running = false;
      S.phase = 'gameover';
      // The actual DOM-overlay flip happens in main.js gameOver(), which
      // we can't import cleanly from here. Fall back to a minimal inline
      // show — main.js listens on #restart-btn which is always wired.
      const goEl = document.getElementById('gameover');
      if (goEl) goEl.classList.remove('hidden');
      const fs = document.getElementById('final-score');
      if (fs) fs.textContent = S.score.toLocaleString();
      const fw = document.getElementById('final-wave');
      if (fw) fw.textContent = S.wave;
      const fk = document.getElementById('final-kills');
      if (fk) fk.textContent = S.kills;
    }, 2500);
    return;
  }

  // CHAPTER COMPLETE handling. At wave === WAVES_PER_CHAPTER (5) the boss
  // has fallen, so we tear down every chapter-scoped dormant prop (depot,
  // hives, etc) so the next chapter starts with a clean slate.
  let _chapterJustCompleted = false;
  let _completedChapterIdx = 0;
  if (S.localWave === WAVES_PER_CHAPTER) {
    const saved = Save.onChapterComplete({
      chapter: S.chapter, wave: S.wave, score: S.score, rescuedIds: S.rescuedIds,
    });
    UI.toast(
      'CHAPTER ' + (S.chapter + 1) + ' COMPLETE · ' + saved.totalRescues + ' MEEBITS FREED FROM SIMULATION',
      '#ffd93d', 3000
    );
    // Wipe every dormant prop that belonged to the completed chapter.
    teardownChapter();
    _chapterJustCompleted = true;
    _completedChapterIdx = S.chapter;
  }

  // PRE-BOSS CINEMATIC
  //
  // Fires between wave 3 (hive) and wave 4 (bonus). The cinematic:
  //   - Masks the VRM-streaming latency for the herd (the herd pool
  //     preload kicks off at cinematic start and resolves before the
  //     cinematic ends ~6s later).
  //   - Delivers the "Save all civilians for the upcoming Boss" beat
  //     you asked for — the herd is framed as the civilians and the
  //     cinematic previews that the boss follows wave 4.
  //
  // We take over the normal countdown→nextWave flow here: instead of the
  // 3-2-1 banner, the cinematic runs, then when it finishes it calls
  // startWave(S.wave + 1). Same entry point, different trigger.
  const nextWaveIsBonus =
    waveDef && waveDef.type === 'hive' && (S.localWave === 3);
  if (nextWaveIsBonus) {
    _playBossCinematic(getWaveDef(S.wave + 1), () => {
      intermissionActive = false;
      startWave(S.wave + 1);
    });
    return;
  }

  // The normal 3-2-1 countdown. Wrapped in a thunk so the chapter-reward
  // modal can gate it: when a chapter has just completed we show the
  // card picker first, and this thunk runs only after the player picks.
  const startCountdown = () => {
    let count = 3;
    UI.showWaveBanner(count);
    const tick = () => {
      Audio.countdown();
      count--;
      if (count <= 0) {
        UI.hideWaveBanner();
        // Defensive: hard-remove any lingering EMP mesh (flight missile,
        // mega-ore warhead casing, split fragments, DOM flash overlay).
        // The launch's own _teardown runs at the end of recover (3.2s
        // post-detonation), but the countdown is ~3.6s — timing is
        // close enough that a slow frame or tab defocus can leave
        // silver silo-phase geometry visible into wave 3. Idempotent
        // no-op outside the wave-2→wave-3 transition.
        forceClearEmpResidue();
        startWave(S.wave + 1);
      } else {
        UI.showWaveBanner(count);
        setTimeout(tick, 800);
      }
    };
    setTimeout(tick, 1200);
  };

  if (_chapterJustCompleted) {
    // Give the toast a beat to breathe before the cards appear.
    setTimeout(() => {
      maybeShowChapterReward(_completedChapterIdx, startCountdown);
    }, 1400);
    return;
  }

  startCountdown();
}

function triggerNuke() {
  shake(0.8, 0.8);
  Audio.bigBoom();
  const origin = new THREE.Vector3(player.pos.x, 1, player.pos.z);
  hitBurst(origin, 0xffffff, 30);
  setTimeout(() => hitBurst(origin, 0xffd93d, 30), 80);
  setTimeout(() => hitBurst(origin, 0xff3cac, 30), 160);
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.isBoss) continue;
    const epos = e.pos.clone(); epos.y = 1;
    hitBurst(epos, 0xff3cac, 4);
    S.score += Math.floor(e.scoreVal * 0.5);
    S.kills++;
    e.obj.parent && e.obj.parent.remove(e.obj);
    enemies.splice(i, 1);
  }
}

export function resetWaves() {
  clearAllEnemies();
  clearAllBlocks();
  // teardownChapter() clears the chapter-scoped dormant props (depot,
  // hives + their shield meshes). It's idempotent.
  teardownChapter();
  clearAllOrbs();
  clearBossCubes();
  clearAllCivilians();
  clearAllOres();
  clearBonusWave();
  // Tear down any in-flight boss cinematic so it doesn't fire spawnBoss()
  // into a post-reset state.
  _teardownBossCinematic();
  // Tear down any in-flight EMP launch cinematic so its ambient-dim
  // lighting + DOM overlays don't persist into a new run.
  try { abortLaunch(); } catch (e) {}
  try { clearShockwaves(); } catch (e) {}
  // Hard reset: wipe the persistent saved-pig perimeter formation. This is
  // only called on full game restart (player died → start new run), so the
  // trophy wall doesn't carry over between completely separate runs.
  clearSavedPigs();
  // Reset the herd slow-drip cursor so the new run starts preloading from
  // scratch (the caches themselves are preserved — no need to re-fetch VRMs
  // already downloaded this session).
  resetSlowDripState();
  S.bonusWaveActive = false;
  S.bonusCaughtThisWave = 0;
  if (S.objectiveZone) {
    removeCaptureZone(S.objectiveZone);
    S.objectiveZone = null;
  }
  if (S.rescueMeebit) {
    removeRescueMeebit(S.rescueMeebit);
    S.rescueMeebit = null;
  }
  UI.hideBossBar();
  UI.hideObjective();
  UI.hideWaveBanner();
  waveDef = null;
  spawnCooldown = 0;
  intermissionActive = false;
}

export function damageSpawnerAt(x, z) {
  for (const s of spawners) {
    if (s.destroyed) continue;
    const dx = s.pos.x - x;
    const dz = s.pos.z - z;
    if (dx * dx + dz * dz < 4) return s;
  }
  return null;
}
