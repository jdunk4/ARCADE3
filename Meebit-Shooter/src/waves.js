import * as THREE from 'three';
import { S, shake, updateChapterFromWave } from './state.js';
import {
  getWaveDef, WEAPONS, CHAPTERS, WAVES_PER_CHAPTER, MEEBIT_CONFIG,
  CAPTURE_RADIUS, CAPTURE_ENEMY_SLOWDOWN, CAPTURE_KILL_BONUS,
} from './config.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { enemies, makeEnemy, makeBoss, clearAllEnemies } from './enemies.js';
import { makePickup, makeCaptureZone, removeCaptureZone, hitBurst } from './effects.js';
import { applyTheme } from './scene.js';
import { player } from './player.js';
import {
  spawnRescueMeebit, updateRescueMeebit, removeRescueMeebit,
  pickNewMeebitId, damageCage,
} from './meebits.js';
import { spawnBlock, clearAllBlocks, blocks } from './blocks.js';
import { Save } from './save.js';

let waveDef = null;
let spawnCooldown = 0;
let intermissionActive = false;

export function getWaveDef_current() { return waveDef; }

export function startWave(waveNum) {
  updateChapterFromWave(waveNum);
  waveDef = getWaveDef(waveNum);
  S.waveKillTarget = waveDef.killTarget;
  S.waveKillsProgress = 0;
  S.waveActive = true;
  S.xpSinceWave = 0;
  spawnCooldown = 0;
  intermissionActive = false;

  applyTheme(S.chapter, S.localWave);

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
      'Stand in the golden zone. Kill enemies inside to accelerate. Launch ends the wave.'
    );
  } else if (waveDef.type === 'mining') {
    S.miningActive = true;
    S.blockFallTimer = 1.0;
    S.blocksSpawned = 0;
    S.blocksToSpawn = waveDef.blockCount;
    UI.showObjective('BLOCKS INCOMING', 'Press [Q] for pickaxe — 3 whacks per block for bonus loot');
  } else if (waveDef.type === 'rescue') {
    spawnRescueForCurrentWave();
    UI.showObjective('CAGED MEEBIT NEEDS HELP', 'Protect the cage — if it breaks the Meebit dies!');
  }

  UI.showWaveStart(waveNum);
  Audio.waveStart();
  shake(0.3, 0.3);
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

  spawnCooldown -= dt;
  const liveNonBosses = enemies.filter(e => !e.isBoss).length;

  // Spawn enemies
  if (waveDef.type !== 'boss' || liveNonBosses < 8) {
    const maxOnScreen = waveDef.type === 'boss' ? 10 : 40 + S.wave * 2;
    if (spawnCooldown <= 0 && liveNonBosses < maxOnScreen) {
      spawnCooldown = Math.max(0.15, 0.9 / waveDef.spawnRate);
      const count = Math.min(3, 1 + Math.floor(S.wave / 3));
      for (let i = 0; i < count; i++) spawnFromMix(waveDef.enemies);
    }
  }

  // Mining
  if (waveDef.type === 'mining' && S.miningActive) {
    S.blockFallTimer -= dt;
    if (S.blockFallTimer <= 0 && S.blocksSpawned < S.blocksToSpawn) {
      spawnBlock(S.chapter);
      S.blocksSpawned++;
      S.blockFallTimer = waveDef.blockFallRate * (0.6 + Math.random() * 0.8);
    }
    if (S.blocksSpawned < S.blocksToSpawn) {
      UI.showObjective(
        'BLOCKS INCOMING (' + S.blocksSpawned + '/' + S.blocksToSpawn + ')',
        'Kill ' + Math.max(0, S.waveKillTarget - S.waveKillsProgress) + ' enemies · Q for pickaxe'
      );
    } else {
      UI.showObjective(
        'ALL BLOCKS DROPPED',
        'Kill ' + Math.max(0, S.waveKillTarget - S.waveKillsProgress) + ' more enemies to advance'
      );
    }
  }

  // Rescue
  if (waveDef.type === 'rescue' && S.rescueMeebit) {
    // Enemies touching the cage damage it
    if (!S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      applyCageDamage(dt);
    }

    updateRescueMeebit(
      S.rescueMeebit, dt, player.pos,
      (m) => {
        // Freed
        S.rescuedIds.push(m.meebitId);
        S.rescuedCount++;
        S.score += 2500;
        UI.toast('MEEBIT #' + m.meebitId + ' FREED! +2500', '#ffd93d', 2200);
        Audio.levelup();
      },
      (m) => {
        // Escaped off-screen
        S.rescueMeebit = null;
      },
      (m) => {
        // Killed — cage broke
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

  // Capture (reworked)
  if (waveDef.type === 'capture' && S.objectiveZone && !S.captureMissileLaunching) {
    updateCaptureZone(dt);
  }

  // Combat-style wave end check
  if ((waveDef.type === 'combat' || waveDef.type === 'rescue' || waveDef.type === 'mining')
      && S.waveKillsProgress >= S.waveKillTarget) {
    if (waveDef.type === 'rescue' && S.rescueMeebit && !S.rescueMeebit.freed && !S.rescueMeebit.killed) {
      UI.showObjective('ENEMIES CLEARED — FREE THE MEEBIT', 'Stand near the cage to free them');
      return;
    }
    endWave();
  }
}

// Enemies within cage radius damage it; we tick once every ~0.25s per enemy.
function applyCageDamage(dt) {
  const m = S.rescueMeebit;
  const cageRadius = 2.0;
  for (const e of enemies) {
    if (e.isBoss) continue;
    const dx = e.pos.x - m.pos.x;
    const dz = e.pos.z - m.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < cageRadius * cageRadius) {
      // Per-enemy cooldown reuses its touchCooldown counter
      if (e.cageAttackCooldown == null) e.cageAttackCooldown = 0;
      e.cageAttackCooldown -= dt;
      if (e.cageAttackCooldown <= 0) {
        e.cageAttackCooldown = 0.6;
        damageCage(m, MEEBIT_CONFIG.cageBreakDamage);
      }
    }
  }
}

function updateCaptureZone(dt) {
  const zone = S.objectiveZone;
  const now = performance.now();

  // Beam pulse
  zone.beam.scale.x = zone.beam.scale.z = 1 + Math.sin(S.timeElapsed * 4) * 0.1;
  zone.beam.material.opacity = 0.25 + Math.sin(S.timeElapsed * 5) * 0.1;

  // Count enemies in zone
  const r2 = S.captureRadius * S.captureRadius;
  let enemiesInZone = 0;
  for (const e of enemies) {
    if (e.isBoss) continue;
    const dx = e.pos.x - zone.pos.x;
    const dz = e.pos.z - zone.pos.z;
    if (dx * dx + dz * dz < r2) enemiesInZone++;
  }

  // Distance from player to zone center
  const pdx = player.pos.x - zone.pos.x;
  const pdz = player.pos.z - zone.pos.z;
  const distSq = pdx * pdx + pdz * pdz;
  const playerInside = distSq < r2;

  if (playerInside) {
    // Base rate: full speed if alone, slowed by enemy count
    const slow = Math.max(0.05, 1 - enemiesInZone * CAPTURE_ENEMY_SLOWDOWN);
    S.captureProgress += dt * slow;
  } else {
    S.captureProgress = Math.max(0, S.captureProgress - dt * 0.4);
  }

  // Update visual: inner disc fills based on progress %
  const progPct = Math.max(0, Math.min(1, S.captureProgress / S.captureTarget));
  zone.inner.material.opacity = 0.15 + 0.55 * progPct;

  // Rebuild progress ring arc to show charge %
  if (zone.ring) {
    zone.ring.geometry.dispose();
    zone.ring.geometry = new THREE.RingGeometry(
      CAPTURE_RADIUS + 0.3, CAPTURE_RADIUS + 0.6, 48, 1, 0, Math.PI * 2 * progPct
    );
    zone.ring.rotation.z = now * 0.001;
  }

  // Missile rises as charge progresses
  if (zone.missile) {
    const targetY = -5 + progPct * 8; // -5 (hidden) → +3 (fully risen)
    zone.missile.position.y += (targetY - zone.missile.position.y) * dt * 3;
    // Color intensity ramps
    if (zone.missileCone && zone.missileCone.material) {
      zone.missileCone.material.emissiveIntensity = 1 + progPct * 3;
    }
  }

  // UI
  const remainingS = Math.max(0, S.captureTarget - S.captureProgress).toFixed(1);
  if (playerInside) {
    if (enemiesInZone > 0) {
      UI.showObjective(
        'CHARGING... ' + Math.round(progPct * 100) + '% (SLOWED BY ' + enemiesInZone + ')',
        'Kill enemies in the zone to accelerate · ' + remainingS + 's'
      );
    } else {
      UI.showObjective(
        'CHARGING... ' + Math.round(progPct * 100) + '%',
        remainingS + 's remaining'
      );
    }
  } else {
    const d = Math.sqrt(distSq);
    UI.showObjective(
      'MISSILE SILO · ' + Math.round(progPct * 100) + '%',
      '→ ' + Math.round(d) + 'm away · enter zone to charge'
    );
  }

  // Launch!
  if (S.captureProgress >= S.captureTarget && !S.captureMissileLaunching) {
    launchMissile();
  }
}

function launchMissile() {
  S.captureMissileLaunching = true;
  const zone = S.objectiveZone;
  Audio.bigBoom();
  UI.toast('MISSILE LAUNCHED!', '#ffd93d', 2000);
  shake(0.6, 0.6);

  // Animate missile rising and exploding
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
      // Boom — clear all enemies in arena
      if (zone && zone.missile) {
        const boomPos = new THREE.Vector3(zone.pos.x, 4, zone.pos.z);
        hitBurst(boomPos, 0xffffff, 30);
        setTimeout(() => hitBurst(boomPos, 0xffd93d, 30), 80);
        setTimeout(() => hitBurst(boomPos, 0xff3cac, 30), 160);
      }
      // Grant the weapon reward for this chapter's capture wave
      grantCaptureReward();
      endWave();
    }
  }, 50);
}

function grantCaptureReward() {
  const rewards = ['shotgun', 'smg', 'sniper'];
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
  return { pistol: 1, shotgun: 2, smg: 3, sniper: 4 }[weaponId];
}

export function onEnemyKilled(enemy, killedInZone = false) {
  if (enemy.isBoss) {
    UI.hideBossBar();
    S.bossRef = null;
    grantBossReward();
    endWave();
  } else {
    S.waveKillsProgress++;
    // Capture wave: killing an enemy inside the zone gives a charge bonus
    if (waveDef && waveDef.type === 'capture' && killedInZone && !S.captureMissileLaunching) {
      S.captureProgress = Math.min(S.captureTarget, S.captureProgress + CAPTURE_KILL_BONUS);
    }
  }
}

// Used by main.js to check if an enemy is currently inside the capture zone.
// Returns true/false — used before killEnemy to pass the flag.
export function isInCaptureZone(pos) {
  if (!S.objectiveZone) return false;
  const dx = pos.x - S.objectiveZone.pos.x;
  const dz = pos.z - S.objectiveZone.pos.z;
  return dx * dx + dz * dz < S.captureRadius * S.captureRadius;
}

function grantBossReward() {
  const all = ['shotgun', 'smg', 'sniper'];
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
    if (S.currentWeapon === 'pickaxe') {
      S.currentWeapon = S.previousCombatWeapon || 'pistol';
      UI.updateWeaponSlots();
    }
  }
  if (S.rescueMeebit) {
    // If still caged, clean up
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
