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
  spawnCivilians, clearAllCivilians, civiliansAlive,
  buildCornerMarkers, clearCornerMarkers, updateCornerMarkers,
} from './civilians.js';
import { spawnDepot, clearDepot, clearAllOres, updateOres, updateDepot, depotStatus } from './ores.js';
import { spawnHazardsForWave, clearHazards } from './hazards.js';
import { recolorCrowd } from './crowd.js';
import {
  startBonusWave, updateBonusWave, endBonusWave, clearBonusWave,
  clearSavedPigs,
  isBonusWaveActive, prefetchNextHerd,
  preparePigPool,
} from './bonusWave.js';
import { resetSlowDripState } from './herdVrmLoader.js';

let waveDef = null;
let spawnCooldown = 0;
let intermissionActive = false;

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

  // Always clear corner markers at wave start. The civilian_rescue branch
  // below will rebuild them; every other wave type leaves them cleared.
  clearCornerMarkers(scene);

  applyTheme(S.chapter, S.localWave);
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

  // Floor hazards (tetromino lava) scale with localWave and reset at
  // each chapter boundary (localWave === 1).
  if (S.localWave === 1) clearHazards();
  if (!_isBonusWave) {
    spawnHazardsForWave(S.chapter, S.localWave);
  } else {
    clearHazards();
  }

  // Rain intensity scales with localWave (1=drizzle, 5=typhoon).
  // Color comes from the chapter theme.
  const _chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  applyRainTo(_chapter.full.grid1, S.localWave);

  // Chapter-tint the player's aura glow so player + civilians read clearly
  // and match the current theme.
  setPlayerGlowColor(_chapter.full.grid1);

  if (S.localWave === 1) {
    const chapterName = CHAPTERS[S.chapter % CHAPTERS.length].name;
    UI.toast('CHAPTER ' + (S.chapter + 1) + ': ' + chapterName, '#ffd93d', 2500);
  }

  if (waveDef.type === 'bonus') {
    // BONUS WAVE — "THE STAMPEDE". Pure chill, no enemies, 30s, proximity catch.
    const chapterForHerd = CHAPTERS[S.chapter % CHAPTERS.length];
    const herdDef = chapterForHerd.bonusHerd;
    S.bonusWaveActive = true;
    S.bonusCaughtThisWave = 0;
    // startBonusWave is async — it probes the asset folder to discover how
    // many VRMs exist, then cycles through them if < herdSize. Fire-and-forget;
    // the herd streams in once discovery + load resolves. UI info comes from
    // the config's herd def, which is always known synchronously.
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
    // Play the pre-boss cinematic first. The cinematic:
    //   - Shows a chapter-themed title card with the boss name
    //   - Fires off a safety-net preparePigPool(S.chapter) call in parallel —
    //     normally the matrix dive has already built every chapter's pool,
    //     but this guarantees Wave 6 spawn is freeze-free even if the dive
    //     was skipped or the pool got cleared for any reason.
    //   - When the cinematic ends, spawnBoss() + showBossBar() fire and the
    //     fight begins.
    // The cinematic is fire-and-forget from startWave's perspective: the
    // wave is already "type === boss" and waveActive is true, so enemy-spawn
    // loops won't try to run here (boss waves don't spawn filler enemies).
    _playBossCinematic(waveDef);
  } else if (waveDef.type === 'capture') {
    const angle = Math.random() * Math.PI * 2;
    const dist = 16;
    S.objectiveZone = makeCaptureZone(Math.cos(angle) * dist, Math.sin(angle) * dist);
    S.captureProgress = 0;
    S.captureTarget = waveDef.captureTime;
    S.captureRadius = CAPTURE_RADIUS;
    S.captureMissileLaunching = false;
    UI.showObjective(
      'CHARGE THE MISSILE SILO',
      'Stand in the golden zone. Kill enemies inside to accelerate.'
    );
  } else if (waveDef.type === 'mining') {
    S.miningActive = true;
    S.blockFallTimer = 1.0;
    S.blocksSpawned = 0;
    S.blocksToSpawn = waveDef.blockCount;
    S.oresCarried = 0;
    S.oresRequired = waveDef.oresRequired || 5;
    spawnDepot(S.chapter);
    UI.showObjective(
      'DELIVER 5 ORES TO THE DEPOT',
      'Shoot blocks (100 hits) or use [Q] pickaxe (5 swings). Drop ore at beacon.'
    );
  } else if (waveDef.type === 'rescue') {
    spawnRescueForCurrentWave();
    UI.showObjective('CAGED MEEBIT NEEDS HELP', 'Protect the cage — if it breaks the Meebit dies!');
  } else if (waveDef.type === 'civilian_rescue') {
    // Wave 1 of each chapter: escort N civilians to the corners.
    S.civilianRescueActive = true;
    S.civilianRescueTarget = waveDef.civilianRescueTarget || 5;
    S.civiliansRescuedThisWave = 0;
    const chapterForMarkers = CHAPTERS[S.chapter % CHAPTERS.length];
    buildCornerMarkers(scene, chapterForMarkers.full.grid1);
    UI.showObjective(
      'RESCUE ' + S.civilianRescueTarget + ' MEEBITS TO A ZONE',
      'Walk near them to recruit. Hold in a glowing zone to rescue everyone following you.'
    );
  } else if (waveDef.type === 'hive' || waveDef.type === 'spawners') {
    // 'spawners' kept as alias — the new canonical name is 'hive'
    S.spawnerWaveActive = true;
    S.hiveWaveActive = true;
    spawnAllPortals(S.chapter);
    S.spawnersLive = spawners.length;
    UI.showObjective(
      'DESTROY THE HIVES (' + spawners.length + ')',
      'Hives spawn at random each run. Find them and shut them down.'
    );
    UI.toast('HIVE PHASE ENGAGED', '#ff3cac', 2500);
  }

  UI.showWaveStart(waveNum);
  Audio.waveStart();
  shake(0.3, 0.3);

  // Spawn civilian Meebits ONLY on the civilian_rescue wave — they are the
  // objective there. All other waves have zero civilians for clarity.
  clearAllCivilians();
  if (waveDef.type === 'civilian_rescue') {
    const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
    const count = waveDef.civilianSpawnCount || 8;
    spawnCivilians(count, chapter.full.grid1);
  }
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
      S.bonusWaveActive = false;
      endWave();
    }
    return;  // short-circuit; no other wave logic runs during bonus
  }

  updateOrbs(dt);
  spawnCooldown -= dt;

  // Corner-rescue marker animation (pulse + fill arc) only on civilian_rescue waves.
  if (waveDef.type === 'civilian_rescue') {
    updateCornerMarkers(performance.now() / 1000);
  }

  // Boss pattern logic — runs every frame a boss is alive
  if (S.bossRef) {
    updateBossPattern(dt, S.bossRef);
  }

  const liveNonBosses = enemies.filter(e => !e.isBoss).length;

  if (waveDef.type === 'hive' || waveDef.type === 'spawners') {
    updateSpawners(dt);
    for (const s of spawners) {
      if (s.destroyed) continue;
      s.spawnCooldown -= dt;
      if (s.spawnCooldown <= 0 && s.enemiesAlive < HIVE_CONFIG.maxEnemiesPerPortal) {
        // Smaller jitter window because cadence is already fast
        s.spawnCooldown = HIVE_CONFIG.spawnIntervalSec * (0.8 + Math.random() * 0.4);
        spawnFromPortal(s, waveDef.enemies);
      }
    }
    if (livePortalCount() === 0) {
      endWave();
      return;
    }
    S.spawnersLive = livePortalCount();
    UI.showObjective(
      'DESTROY THE HIVES (' + S.spawnersLive + '/' + spawners.length + ')',
      'Shoot or melee the glowing rings. Each has health.'
    );
  } else if (waveDef.type !== 'boss' || liveNonBosses < 8) {
    const maxOnScreen = waveDef.type === 'boss' ? 10 : 40 + S.wave * 2;
    if (spawnCooldown <= 0 && liveNonBosses < maxOnScreen) {
      spawnCooldown = Math.max(0.15, 0.9 / waveDef.spawnRate);
      const count = Math.min(3, 1 + Math.floor(S.wave / 3));
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

  if (waveDef.type === 'capture' && S.objectiveZone && !S.captureMissileLaunching) {
    updateCaptureZone(dt);
  }

  if (waveDef.type === 'civilian_rescue') {
    // Live HUD update
    const rescued = S.civiliansRescuedThisWave;
    const target = S.civilianRescueTarget;
    const killsDone = S.waveKillsProgress >= S.waveKillTarget;
    const rescueDone = rescued >= target;

    // Wave-failure check: if we can't physically reach the target anymore
    // (not enough civilians left alive + already rescued), mercy-kill the
    // wave requirement so the player isn't softlocked. Kept generous —
    // only triggers when there literally aren't enough Meebits left.
    const stillAvailable = civiliansAlive() + rescued;
    if (!rescueDone && stillAvailable < target) {
      // Lower bar to whatever's actually reachable so the player can still
      // clear the wave by saving everyone they can.
      S.civilianRescueTarget = Math.max(rescued, stillAvailable);
      UI.toast('TOO MANY LOST — SAVE THE REST', '#ff2e4d', 2200);
    }

    const remainingKills = Math.max(0, S.waveKillTarget - S.waveKillsProgress);
    if (!rescueDone) {
      UI.showObjective(
        'RESCUE MEEBITS · ' + rescued + '/' + S.civilianRescueTarget,
        'Recruit (walk near) and hold in a zone · kills left: ' + remainingKills
      );
    } else if (!killsDone) {
      UI.showObjective(
        'MEEBITS SAFE · CLEAR ' + remainingKills + ' MORE',
        'Finish the horde to end the wave.'
      );
    }

    if (rescueDone && killsDone) {
      S.civilianRescueActive = false;
      endWave();
      return;
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
  const rewards = ['shotgun', 'smg', 'raygun'];
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
let _cinematicEl = null;   // currently-on-screen overlay, if any
let _cinematicTimer = 0;   // setTimeout id for the end-of-cinematic fire
let _cinematicSpawnTimer = 0; // setTimeout id for the mid-cinematic boss spawn
let _cinematicActive = false; // true while cinematic is up (also implies S.paused)

// True while the pre-boss cinematic is on screen. Other modules can consult
// this if they ever need to know whether input gating is cinematic-driven
// vs pause-menu-driven.
export function isBossCinematicActive() { return _cinematicActive; }

function _playBossCinematic(wd) {
  // If we're somehow replaying the cinematic (shouldn't happen in normal flow),
  // tear down any existing one first.
  _teardownBossCinematic();

  const chapter = CHAPTERS[S.chapter % CHAPTERS.length];
  const chapterNum = S.chapter + 1;
  const chapterName = chapter.name;
  const bossName = (wd.bossType || 'BOSS').replace(/_/g, ' ');
  const tintHex = chapter.full.grid1 || 0xffffff;
  const accentHex = chapter.full.orb || chapter.full.lamp || tintHex;
  // Convert 0xRRGGBB to CSS-friendly "#rrggbb"
  const cssTint = '#' + tintHex.toString(16).padStart(6, '0');
  const cssAccent = '#' + accentHex.toString(16).padStart(6, '0');

  // --- HARD PAUSE the game & clear input buffer. ---
  // Setting S.paused = true stops the entire update loop (movement, enemies,
  // projectiles, firing), so any heavy work we do during the cinematic
  // (boss spawn shader-compile, pool build) happens without competing with
  // a live game. Clearing mouse.down/keys prevents buffered input from
  // firing the instant the cinematic ends.
  _cinematicActive = true;
  S.paused = true;
  mouse.down = false;
  for (const k in keys) keys[k] = false;

  // --- Safety-net pool build in parallel (fire-and-forget). ---
  // If the pool is already built, this resolves instantly. If not, it spreads
  // clone + PSO-warm work across the cinematic's lifetime, which is exactly
  // the kind of "hidden loading" we want.
  try {
    preparePigPool(S.chapter, null, renderer, camera)
      .catch(err => console.warn('[cinematic] pool build (non-fatal):', err));
  } catch (err) {
    console.warn('[cinematic] pool build threw (non-fatal):', err);
  }

  // --- Build the overlay DOM. OPAQUE full-screen. ---
  // Background: heavy chapter tint radial (outer) + black interior. No alpha
  // in the outermost stop — nothing behind should be visible.
  const overlay = document.createElement('div');
  overlay.id = 'boss-cinematic';
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at center,
        #000000 0%,
        #000000 30%,
        ${_cssWithAlpha(cssTint, 0.55)} 75%,
        ${cssTint} 100%);
    z-index: 9500;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    opacity: 0;
    transition: opacity 0.4s ease-out;
    pointer-events: auto;
    overflow: hidden;
    font-family: monospace;
  `;
  // A secondary full-bleed layer with a subtle grid pattern in the tint —
  // sells the "chapter" feeling without needing textures. Purely decorative.
  const gridPattern = document.createElement('div');
  gridPattern.style.cssText = `
    position: absolute; inset: 0;
    background-image:
      linear-gradient(${_cssWithAlpha(cssTint, 0.22)} 1px, transparent 1px),
      linear-gradient(90deg, ${_cssWithAlpha(cssTint, 0.22)} 1px, transparent 1px);
    background-size: 56px 56px;
    mix-blend-mode: screen;
    opacity: 0.55;
    mask-image: radial-gradient(ellipse at center, transparent 20%, black 70%);
    -webkit-mask-image: radial-gradient(ellipse at center, transparent 20%, black 70%);
  `;
  overlay.appendChild(gridPattern);

  // Chapter line
  const chapLine = document.createElement('div');
  chapLine.style.cssText = `
    color: ${cssTint};
    font-size: clamp(22px, 2.8vw, 36px);
    font-weight: bold;
    letter-spacing: 12px;
    text-shadow: 0 0 12px ${cssTint}, 0 0 28px ${cssTint}, 0 0 48px ${_cssWithAlpha(cssTint, 0.8)};
    opacity: 0; transform: translateY(-20px);
    transition: opacity 0.6s ease-out, transform 0.6s ease-out;
    margin-bottom: 22px;
    z-index: 2;
  `;
  chapLine.textContent = `CHAPTER ${chapterNum} · ${chapterName}`;
  overlay.appendChild(chapLine);

  // Divider — thicker + fatter glow than before
  const divider = document.createElement('div');
  divider.style.cssText = `
    width: 46vw; height: 3px;
    background: linear-gradient(to right, transparent, ${cssTint} 20%, ${cssAccent} 50%, ${cssTint} 80%, transparent);
    box-shadow: 0 0 20px ${cssTint}, 0 0 40px ${_cssWithAlpha(cssTint, 0.6)};
    opacity: 0;
    transition: opacity 0.7s ease-out;
    margin-bottom: 28px;
    z-index: 2;
  `;
  overlay.appendChild(divider);

  // Boss name (big)
  const bossLine = document.createElement('div');
  bossLine.style.cssText = `
    color: #ffffff;
    font-size: clamp(48px, 8vw, 128px);
    font-weight: bold;
    letter-spacing: 10px;
    text-shadow:
      0 0 20px ${cssTint},
      0 0 44px ${cssTint},
      0 0 72px ${_cssWithAlpha(cssTint, 0.9)},
      0 0 120px ${_cssWithAlpha(cssAccent, 0.6)};
    opacity: 0; transform: scale(0.82);
    transition: opacity 0.7s ease-out 0.2s, transform 0.9s ease-out 0.2s;
    text-align: center;
    max-width: 92vw;
    z-index: 2;
  `;
  bossLine.textContent = bossName;
  overlay.appendChild(bossLine);

  // Flavor line
  const flavor = document.createElement('div');
  flavor.style.cssText = `
    color: ${cssTint};
    font-size: clamp(13px, 1.5vw, 17px);
    letter-spacing: 8px;
    margin-top: 36px;
    text-shadow: 0 0 12px ${cssTint};
    opacity: 0;
    transition: opacity 0.8s ease-out 0.5s;
    z-index: 2;
  `;
  flavor.textContent = '// INCOMING HOSTILE //';
  overlay.appendChild(flavor);

  // Sweeping horizontal scan bars (top & bottom) — cheap CSS animation,
  // gives motion without needing a canvas layer.
  const scanTop = document.createElement('div');
  scanTop.style.cssText = `
    position: absolute; left: -40%; top: 18%;
    width: 40%; height: 2px;
    background: linear-gradient(to right, transparent, ${cssTint}, transparent);
    box-shadow: 0 0 14px ${cssTint};
    opacity: 0.9;
    animation: boss-scan-h 3.2s ease-in-out infinite;
    z-index: 2;
  `;
  overlay.appendChild(scanTop);
  const scanBot = document.createElement('div');
  scanBot.style.cssText = `
    position: absolute; right: -40%; bottom: 18%;
    width: 40%; height: 2px;
    background: linear-gradient(to left, transparent, ${cssTint}, transparent);
    box-shadow: 0 0 14px ${cssTint};
    opacity: 0.9;
    animation: boss-scan-h-rev 3.2s ease-in-out infinite;
    z-index: 2;
  `;
  overlay.appendChild(scanBot);

  // Inject the scan-bar keyframes once per cinematic (cleaned up on teardown).
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

  document.body.appendChild(overlay);
  _cinematicEl = overlay;

  // --- Animate in ---
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    chapLine.style.opacity = '1'; chapLine.style.transform = 'translateY(0)';
    setTimeout(() => { divider.style.opacity = '1'; }, 200);
    setTimeout(() => {
      bossLine.style.opacity = '1';
      bossLine.style.transform = 'scale(1)';
    }, 400);
    setTimeout(() => { flavor.style.opacity = '0.95'; }, 900);
  });

  // --- Audio cue on entry ---
  try { Audio.waveStart(); } catch (e) {}

  // --- Spawn the boss MID-cinematic so its shader-compile freeze is masked. ---
  // The overlay is fully opaque at this point, so any stutter the renderer
  // hits compiling the boss's shader/PSO happens behind the curtain.
  // 1200ms in: far enough past fade-in that the overlay is 100% opaque and
  // the title has settled; far enough before fade-out (at 5400ms) that any
  // freeze finishes before the player is looking at gameplay again.
  _cinematicSpawnTimer = setTimeout(() => {
    try {
      spawnBoss();
      // Force an immediate eager shader/PSO compile for everything now in
      // the scene — notably the freshly-spawned boss. This is the key line
      // that pays the compile cost while the opaque overlay still hides it.
      // If this throws, the fallback is the normal first-frame compile path
      // (which would stutter, but the game wouldn't break).
      try {
        if (renderer && renderer.compile) renderer.compile(scene, camera);
      } catch (compileErr) {
        console.warn('[cinematic] eager compile failed (non-fatal):', compileErr);
      }
    } catch (err) {
      console.warn('[cinematic] spawnBoss error:', err);
    }
  }, 1200);

  // --- Schedule end-of-cinematic ---
  // Total on-screen time: ~6.0s (5.4s hold + 0.6s fade).
  const HOLD_MS = 5400;
  _cinematicTimer = setTimeout(() => {
    overlay.style.opacity = '0';
    setTimeout(() => {
      _teardownBossCinematic();
      // Unpause, reveal HUD, toast. Boss is already alive behind the overlay
      // and will start acting on the first resumed frame.
      S.paused = false;
      _cinematicActive = false;
      UI.showBossBar(bossName);
      UI.toast(bossName + ' APPROACHES', '#ff2e4d', 2000);
    }, 620);
  }, HOLD_MS);
}

function _teardownBossCinematic() {
  if (_cinematicTimer) { clearTimeout(_cinematicTimer); _cinematicTimer = 0; }
  if (_cinematicSpawnTimer) { clearTimeout(_cinematicSpawnTimer); _cinematicSpawnTimer = 0; }
  if (_cinematicEl && _cinematicEl.parentNode) _cinematicEl.parentNode.removeChild(_cinematicEl);
  _cinematicEl = null;
  const kf = document.getElementById('boss-cinematic-keyframes');
  if (kf && kf.parentNode) kf.parentNode.removeChild(kf);
  // If we're being torn down abruptly (reset), also make sure we don't leave
  // the game paused in cinematic-mode. The normal end-of-cinematic path
  // already handles this; this is the safety net for resetWaves().
  if (_cinematicActive) {
    _cinematicActive = false;
    S.paused = false;
  }
}

// Helper — takes a "#rrggbb" string and an alpha 0..1, returns "rgba(r,g,b,a)".
// Used in the cinematic for background gradients and glow compositing.
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
  return { pistol: 1, shotgun: 2, smg: 3, raygun: 4, rocket: 5 }[weaponId];
}

export function onEnemyKilled(enemy, killedInZone = false) {
  if (enemy.fromPortal && !enemy.fromPortal.destroyed) {
    enemy.fromPortal.enemiesAlive = Math.max(0, enemy.fromPortal.enemiesAlive - 1);
  }

  if (enemy.isBoss) {
    UI.hideBossBar();
    S.bossRef = null;
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
  // Grant in this order: shotgun -> smg -> raygun -> rocket
  const all = ['shotgun', 'smg', 'raygun', 'rocket'];
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
  if (S.miningActive) {
    S.miningActive = false;
    clearAllBlocks();
    clearAllOres();
    clearDepot();
    if (S.currentWeapon === 'pickaxe') {
      S.currentWeapon = S.previousCombatWeapon || 'pistol';
      UI.updateWeaponSlots();
    }
  }
  if (S.spawnerWaveActive) {
    S.spawnerWaveActive = false;
    S.hiveWaveActive = false;
    clearAllPortals();
    S.spawnersLive = 0;
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

  if (S.localWave === WAVES_PER_CHAPTER) {
    const saved = Save.onChapterComplete({
      chapter: S.chapter, wave: S.wave, score: S.score, rescuedIds: S.rescuedIds,
    });
    UI.toast(
      'CHAPTER ' + (S.chapter + 1) + ' COMPLETE · ' + saved.totalRescues + ' MEEBITS FREED FROM SIMULATION',
      '#ffd93d', 3000
    );
  }

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
  clearAllPortals();
  clearAllOrbs();
  clearBossCubes();
  clearAllCivilians();
  clearAllOres();
  clearDepot();
  clearBonusWave();
  // Tear down any in-flight boss cinematic so it doesn't fire spawnBoss()
  // into a post-reset state.
  _teardownBossCinematic();
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
