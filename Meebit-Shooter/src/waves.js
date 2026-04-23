import * as THREE from 'three';
import { S, shake, updateChapterFromWave } from './state.js';
import { mouse, keys } from './state.js';
import {
  getWaveDef, WEAPONS, CHAPTERS, WAVES_PER_CHAPTER, MEEBIT_CONFIG,
  CAPTURE_RADIUS, CAPTURE_ENEMY_SLOWDOWN, CAPTURE_KILL_BONUS,
  SPAWNER_CONFIG, HIVE_CONFIG,
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
import { player, setPlayerGlowColor } from './player.js';
import {
  spawnRescueMeebit, updateRescueMeebit, removeRescueMeebit,
  pickNewMeebitId, damageCage,
} from './meebits.js';
import { spawnBlock, clearAllBlocks, blocks } from './blocks.js';
import {
  spawners, spawnAllPortals, updateSpawners, livePortalCount,
  pickActivePortal, clearAllPortals,
} from './spawners.js';
import { spawnOrbs, updateOrbs, clearAllOrbs } from './orbs.js';
import { Save } from './save.js';
import {
  clearAllCivilians,
  clearCornerMarkers,
} from './civilians.js';
import { clearAllOres, updateOres, updateDepot, depotStatus, setDepotActive } from './ores.js';
import * as OresModule from './ores.js';
import { spawnHazardsForWave, clearHazards } from './hazards.js';
import { recolorCrowd } from './crowd.js';
import {
  prepareChapter, teardownChapter, isChapterPrepared,
  removeHiveShields, updateHiveShields,
} from './dormantProps.js';
import {
  startPowerupWave, endPowerupWave, updatePowerupZones,
  getActiveZone, getActiveProgress, getCompletedCount, getZoneCount,
  spawnPowerupZones, clearPowerupZones, getChargingTurretStatus,
} from './powerupZones.js';
import {
  activateTurret, deactivateAllTurrets, clearTurretBullets,
  setTurretCharging,
} from './turrets.js';
import {
  setPowerplantLit, openSiloAndRaiseMissile, resetCompoundAnimations,
  registerLaunchHandler, triggerLaunch, startCompoundRetraction,
} from './waveProps.js';
import {
  buildWires, clearWires, setWiresLit, resetWireAnimations,
} from './empWires.js';
import {
  startLaunch, isLaunching, registerDetonationHandler, abortLaunch,
} from './empLaunch.js';
import { fireShockwave, clearShockwaves } from './shockwave.js';
import { startDepotDriveOff } from './ores.js';
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

export function startWave(waveNum) {
  updateChapterFromWave(waveNum);
  waveDef = getWaveDef(waveNum);
  S.waveKillTarget = waveDef.killTarget || 0;
  S.waveKillsProgress = 0;
  S.waveActive = true;
  S.xpSinceWave = 0;
  spawnCooldown = 0;
  intermissionActive = false;

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

  // Bonus wave is a victory lap — no orbs, no hazards, minimal rain.
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

  // Floor hazards scale with localWave and reset each chapter boundary.
  if (S.localWave === 1) clearHazards();
  if (!_isBonusWave) {
    spawnHazardsForWave(S.chapter, S.localWave);
  } else {
    clearHazards();
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
    UI.showObjective(
      'DELIVER 5 ORES TO THE DEPOT',
      'Shoot blocks (100 hits) or use [Q] pickaxe (5 swings). Drop ore at beacon.'
    );
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
    UI.showObjective(
      'DESTROY THE HIVES (' + S.spawnersLive + ')',
      'Shields down. Shoot the glowing rings — each has health.'
    );
    UI.toast('HIVE PHASE ENGAGED', '#ff3cac', 2500);
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
  if (!S.waveActive || !waveDef) return;

  // Per-frame dormant-prop updates (shield pulse + drop animation). Cheap
  // and safe to call every frame regardless of wave type — it early-outs
  // when no shields exist.
  updateHiveShields(dt, performance.now() / 1000);

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
    // Live HUD update
    const t = Math.ceil(state.timeLeft);
    UI.showObjective(
      (state.herdLabel || 'HERD') + ' · ' + state.caught + ' / ' + state.total + ' FREED',
      'Time left: ' + t + 's · shoot each 3 times to free',
    );
    if (state.finished) {
      const final = endBonusWave();
      UI.toast(
        'BONUS WAVE COMPLETE · ' + final.caught + ' / ' + final.total + ' FREED FROM SIMULATION',
        '#ffd93d', 3200
      );
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

  if (waveDef.type === 'hive' || waveDef.type === 'spawners') {
    // updateSpawners is now ticked unconditionally from main.js — no call here.
    for (const s of spawners) {
      if (s.destroyed || s.shielded) continue;  // shielded hives don't emit
      s.spawnCooldown -= dt;
      if (s.spawnCooldown <= 0 && s.enemiesAlive < HIVE_CONFIG.maxEnemiesPerPortal) {
        // Smaller jitter window because cadence is already fast
        s.spawnCooldown = HIVE_CONFIG.spawnIntervalSec * (0.8 + Math.random() * 0.4);
        spawnFromPortal(s, waveDef.enemies);
      }
    }
    if (livePortalCount() === 0) {
      // Wave 3 victory beat:
      //   1. Shockwave ripples out from the last-hive-standing's death spot
      //   2. All hive groups sink into the ground before wave 4 begins
      const lastHivePos = getLastHiveDeathPos();
      if (lastHivePos) {
        fireShockwave(lastHivePos);
      }
      startHiveRetraction();
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
      : Math.max(10, Math.floor((40 + S.wave * 2) * density));
    if (spawnCooldown <= 0 && liveNonBosses < maxOnScreen) {
      // Cooldown between spawn batches — lower density stretches this out.
      const effRate = waveDef.spawnRate * density;
      spawnCooldown = Math.max(0.15, 0.9 / effRate);
      const baseCount = Math.min(3, 1 + Math.floor(S.wave / 3));
      const count = Math.max(1, Math.round(baseCount * density));
      for (let i = 0; i < count; i++) spawnFromMix(waveDef.enemies);
    }
  }

  if (waveDef.type === 'mining' && S.miningActive) {
    // Keep feeding blocks as long as we still need more ore deposits
    const status = depotStatus();
    const deposited = status ? status.deposited : 0;
    const stillNeedOre = deposited < S.oresRequired;

    S.blockFallTimer -= dt;
    if (stillNeedOre && S.blockFallTimer <= 0 && S.blocksSpawned < S.blocksToSpawn) {
      spawnBlock(S.chapter);
      S.blocksSpawned++;
      S.blockFallTimer = waveDef.blockFallRate * (0.7 + Math.random() * 0.6);
    }
    // Safety valve: if every block broke but ores were wasted (fell into
    // geometry, despawned, etc.) let the player get more blocks.
    if (stillNeedOre && blocks.length === 0 && S.blocksSpawned >= S.blocksToSpawn) {
      S.blocksSpawned = Math.max(0, S.blocksSpawned - 2);
    }

    updateOres(dt, player);
    const complete = updateDepot(dt, player);

    const carry = S.oresCarried || 0;
    UI.showObjective(
      'DELIVER ORES · ' + deposited + '/' + S.oresRequired + (carry ? '   (carrying ' + carry + ')' : ''),
      '100 shots per block · or [Q] pickaxe (5 swings) · drop at depot beacon'
    );
    if (complete) {
      // Wave 1 victory beat:
      //   1. Shockwave ripples from the depot (its "sealing up" pulse)
      //   2. Depot drives off along the mining-triangle centerline
      // The shockwave is purely visual; endWave() runs normal cleanup.
      const d = OresModule.depot;
      if (d) {
        fireShockwave({ x: d.pos.x, y: 0.2, z: d.pos.z });
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
        openSiloAndRaiseMissile();
        // Kick off the 10-second auto-launch timer. The LAUNCH zone was
        // removed — the missile fires automatically once the raise
        // animation has finished playing.
        S.autoLaunchT = AUTO_LAUNCH_COUNTDOWN;
        S.autoLaunchToastedAt = -1;
        UI.toast('MISSILE LAUNCHING IN ' + AUTO_LAUNCH_COUNTDOWN + 's', '#ffd93d', 1600);
      }
    }

    // Auto-launch countdown — after RADIO completes, tick the timer down
    // and fire triggerLaunch() when it hits 0. Runs independent of zone
    // charging. Show the HUD waypoint arrow as soon as the countdown
    // starts so the player sees where the strike is coming.
    if (typeof S.autoLaunchT === 'number' && S.autoLaunchT > 0 && !S.powerupEmpFired) {
      S.autoLaunchT -= dt;
      if (S.autoLaunchT <= 0) {
        S.autoLaunchT = 0;
        UI.toast('LAUNCH INITIATED', '#4ff7ff', 2000);
        triggerLaunch();
      }
    }

    // Arrow stays visible from the moment the countdown starts until the
    // detonation handler hides it. This covers:
    //   - pre-launch countdown (S.autoLaunchT > 0)
    //   - missile flight + on-ground detonation countdown (isLaunching())
    // registerDetonationHandler calls hideMissileArrow() at explosion.
    const arrowActive =
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
      } else if (typeof S.autoLaunchT === 'number' && S.autoLaunchT > 0) {
        // Post-RADIO: countdown until the missile auto-fires.
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
  UI.toast('EMP LAUNCHED — HIVES ENRAGED', '#4ff7ff', 2500);
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

function summonMinions(boss, count) {
  const fullTheme = CHAPTERS[S.chapter % CHAPTERS.length].full;
  const chapterIdx = S.chapter % CHAPTERS.length;
  // Pick a minion type appropriate to the chapter
  let minionTypes;
  if (chapterIdx === 0) minionTypes = ['sprinter', 'pumpkin'];
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
  UI.toast('THE BOSS SUMMONS MINIONS', '#ff2e4d', 1500);
  shake(0.2, 0.2);
  Audio.waveStart();
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
  makeEnemy(type, fullTheme.enemyTint, new THREE.Vector3(x, 0, z));
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
    return;
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
    UI.toast('SIMULATION CLEANSED', '#ffffff', 5000);
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
