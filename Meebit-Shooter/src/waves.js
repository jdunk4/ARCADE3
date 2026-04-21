import * as THREE from 'three';
import { S, shake, updateChapterFromWave } from './state.js';
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
import { applyTheme, scene } from './scene.js';
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
  spawnOrbs(S.chapter, S.localWave);
  // Re-tint the spectator crowd to match the current chapter. Cheap —
  // just updates instance color attribute, no teardown.
  const _chapterNow = CHAPTERS[S.chapter % CHAPTERS.length];
  recolorCrowd(_chapterNow.full.grid1);

  // Floor hazards (tetromino lava) scale with localWave and reset at
  // each chapter boundary (localWave === 1).
  if (S.localWave === 1) clearHazards();
  spawnHazardsForWave(S.chapter, S.localWave);

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

  if (waveDef.type === 'boss') {
    spawnBoss();
    UI.showBossBar(waveDef.bossType.replace(/_/g, ' '));
    UI.toast(waveDef.bossType.replace(/_/g, ' ') + ' APPROACHES', '#ff2e4d', 2000);
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

export function updateWaves(dt) {
  if (!S.waveActive || !waveDef) return;

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

  triggerNuke();

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
      'CHAPTER ' + (S.chapter + 1) + ' COMPLETE · ' + saved.totalRescues + ' MEEBITS COLLECTED',
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
