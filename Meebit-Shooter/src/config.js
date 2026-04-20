// Shared configuration.

export const ARENA = 50;

// -------- CHAPTERS (orange -> red -> yellow -> green -> blue -> purple) --------
export const CHAPTERS = [
  {
    name: 'INFERNO',
    full: { fog: 0x200806, ground: 0x2a0a08, grid1: 0xff6a1a, grid2: 0x4a1808, hemi1: 0xff6a1a, hemi2: 0x220400, lamp: 0xff6a1a, sky: 0x200806, enemyTint: 0xff6a1a, orb: 0xff9a2a },
    signatureEnemy: 'pumpkin',
  },
  {
    name: 'CRIMSON',
    full: { fog: 0x1a0408, ground: 0x24080c, grid1: 0xff2e4d, grid2: 0x3a0818, hemi1: 0xff2e4d, hemi2: 0x200004, lamp: 0xff2e4d, sky: 0x1a0408, enemyTint: 0xff2e4d, orb: 0xff5070 },
    signatureEnemy: 'pumpkin',
  },
  {
    name: 'SOLAR',
    full: { fog: 0x2a2000, ground: 0x2a2408, grid1: 0xffd93d, grid2: 0x4a3810, hemi1: 0xffd93d, hemi2: 0x221800, lamp: 0xffd93d, sky: 0x2a2000, enemyTint: 0xffbb00, orb: 0xffee55 },
    signatureEnemy: 'spider',
  },
  {
    name: 'TOXIC',
    full: { fog: 0x041a0a, ground: 0x0d2a12, grid1: 0x00ff66, grid2: 0x104020, hemi1: 0x00ff66, hemi2: 0x002211, lamp: 0x00ff66, sky: 0x041a0a, enemyTint: 0x00ff44, orb: 0x66ff88 },
    signatureEnemy: 'spider',
  },
  {
    name: 'ARCTIC',
    full: { fog: 0x0a1428, ground: 0x102238, grid1: 0x4ff7ff, grid2: 0x123a5a, hemi1: 0x4ff7ff, hemi2: 0x001122, lamp: 0x4ff7ff, sky: 0x0a1428, enemyTint: 0x4ff7ff, orb: 0x88ffff },
    signatureEnemy: 'ghost',
  },
  {
    name: 'PARADISE',
    full: { fog: 0x1a0830, ground: 0x220c3c, grid1: 0xe63aff, grid2: 0x4a1866, hemi1: 0xe63aff, hemi2: 0x0a0020, lamp: 0xe63aff, sky: 0x1a0830, enemyTint: 0xbb00ff, orb: 0xff88ff },
    signatureEnemy: 'ghost',
  },
];

// Muted base — wave 1 of each chapter mixes from here toward full palette.
export const CHAPTER_BASE = {
  fog: 0x0a0a14, ground: 0x181828, grid1: 0x444466, grid2: 0x222234,
  hemi1: 0x5a5a7a, hemi2: 0x101018, lamp: 0x9090aa, sky: 0x0a0a14, enemyTint: 0x7070a0,
};

export const WAVES_PER_CHAPTER = 5;
export const THEMES = CHAPTERS.map(c => ({ name: c.name, ...c.full }));

// Intensity per wave (1..5): controls orbs, bloom, emissive boost.
// Wave 1 = 0.25, wave 5 = 1.0.
export function intensityForWave(localWave) {
  return 0.25 + ((localWave - 1) / 4) * 0.75;
}

// How many orbs drift around during a given wave.
export function orbCountForWave(localWave) {
  // W1: 0, W2: 3, W3: 6, W4: 10, W5: 18
  return [0, 3, 6, 10, 18][localWave - 1] || 0;
}

// -------- WEAPONS --------
export const WEAPONS = {
  pistol:  { name: 'PISTOL',  fireRate: 0.16, damage: 25,  bullets: 1, spread: 0.04, speed: 40, slot: 'pistol',  color: 0x4ff7ff },
  shotgun: { name: 'SHOTGUN', fireRate: 0.55, damage: 18,  bullets: 6, spread: 0.28, speed: 36, slot: 'shotgun', color: 0xff8800 },
  smg:     { name: 'SMG',     fireRate: 0.07, damage: 14,  bullets: 1, spread: 0.12, speed: 44, slot: 'smg',     color: 0xff3cac },
  sniper:  { name: 'SNIPER',  fireRate: 0.9,  damage: 180, bullets: 1, spread: 0,    speed: 90, slot: 'sniper',  color: 0x00ff66 },
  pickaxe: {
    name: 'PICKAXE', fireRate: 0.32, damage: 20, bullets: 0, spread: 0, speed: 0,
    slot: 'pickaxe', color: 0xffd93d, isMining: true, reach: 2.4,
  },
};

// -------- WAVE STRUCTURE (per chapter) --------
// W1 = rescue (free caged Meebit)
// W2 = spawners (destroy 4 portals to end)
// W3 = capture (missile silo)
// W4 = mining (mine 5 blocks to advance)
// W5 = boss
export function getWaveDef(wave) {
  const localWave = ((wave - 1) % WAVES_PER_CHAPTER) + 1;
  const chapterIdx = Math.floor((wave - 1) / WAVES_PER_CHAPTER);

  if (localWave === 5) {
    return {
      type: 'boss',
      killTarget: 1,
      enemies: { zomeeb: 0.6, sprinter: 0.25, [CHAPTERS[chapterIdx % CHAPTERS.length].signatureEnemy]: 0.15 },
      spawnRate: 1.4,
      bossType: ['MEGA_ZOMEEB', 'BRUTE_KING', 'VOID_LORD', 'SOLAR_TYRANT'][chapterIdx % 4],
      localWave, chapterIdx,
    };
  }
  if (localWave === 3) {
    const rewards = ['shotgun', 'smg', 'sniper'];
    return {
      type: 'capture',
      killTarget: 8 + wave * 2,
      enemies: waveEnemyMix(wave, chapterIdx),
      spawnRate: Math.min(3.5, 1 + wave * 0.2),
      captureTime: 8,
      captureRadius: CAPTURE_RADIUS,
      reward: rewards[chapterIdx % rewards.length],
      localWave, chapterIdx,
    };
  }
  if (localWave === 4) {
    return {
      type: 'mining',
      blocksRequired: 5,          // mine 5 to advance
      enemies: waveEnemyMix(wave, chapterIdx),
      spawnRate: Math.min(2.0, 0.5 + wave * 0.12),
      blockFallRate: 3.0,         // one every ~3s
      blockCount: 12,             // up to 12 blocks spawned (enough buffer if some are mined fast)
      localWave, chapterIdx,
    };
  }
  if (localWave === 2) {
    return {
      type: 'spawners',
      spawnerCount: 4,            // 4 portals at the corners
      spawnerHp: 180,             // takes real effort to destroy each
      enemies: waveEnemyMix(wave, chapterIdx),
      spawnRate: Math.min(3.5, 1 + wave * 0.2),
      localWave, chapterIdx,
    };
  }
  // localWave === 1
  return {
    type: 'rescue',
    killTarget: 10 + wave * 2,
    enemies: waveEnemyMix(wave, chapterIdx),
    spawnRate: Math.min(4, 1 + wave * 0.22),
    hasMeebitRescue: true,
    localWave, chapterIdx,
  };
}

function waveEnemyMix(wave, chapterIdx) {
  const sig = CHAPTERS[chapterIdx % CHAPTERS.length].signatureEnemy;
  const base = {};
  if (wave <= 2) base.zomeeb = 1.0;
  else if (wave <= 4) { base.zomeeb = 0.65; base.sprinter = 0.25; base[sig] = 0.10; }
  else if (wave <= 6) { base.zomeeb = 0.45; base.sprinter = 0.25; base.brute = 0.10; base[sig] = 0.20; }
  else if (wave <= 9) { base.zomeeb = 0.35; base.sprinter = 0.25; base.brute = 0.15; base.spitter = 0.10; base[sig] = 0.15; }
  else { base.zomeeb = 0.25; base.sprinter = 0.25; base.brute = 0.15; base.spitter = 0.15; base.phantom = 0.05; base[sig] = 0.15; }
  return base;
}

// -------- ENEMY TYPES --------
export const ENEMY_TYPES = {
  zomeeb:   { speed: 2.2, hp: 55,  xp: 3, score: 400,  scale: 1.0,  damage: 12, name: 'ZOMEEB' },
  sprinter: { speed: 4.0, hp: 30,  xp: 2, score: 250,  scale: 0.85, damage: 10, name: 'SPRINTER' },
  brute:    { speed: 1.2, hp: 180, xp: 6, score: 1200, scale: 1.45, damage: 22, name: 'BRUTE' },
  spitter:  { speed: 1.8, hp: 65,  xp: 4, score: 700,  scale: 1.05, damage: 8,  name: 'SPITTER', ranged: true, range: 14 },
  phantom:  { speed: 3.2, hp: 45,  xp: 5, score: 900,  scale: 1.0,  damage: 15, name: 'PHANTOM', phases: true },
  spider:   { speed: 3.6, hp: 40,  xp: 3, score: 500,  scale: 1.1,  damage: 11, name: 'SPIDER' },
  pumpkin:  { speed: 1.6, hp: 90,  xp: 5, score: 850,  scale: 1.1,  damage: 18, name: 'PUMPKIN', explodes: true },
  ghost:    { speed: 2.4, hp: 55,  xp: 4, score: 700,  scale: 1.0,  damage: 13, name: 'GHOST',   phases: true },
};

// -------- BOSSES --------
export const BOSSES = {
  MEGA_ZOMEEB: { hp: 1500, speed: 1.1, damage: 30, xp: 40, score: 15000, scale: 3.2, name: 'MEGA ZOMEEB' },
  BRUTE_KING:  { hp: 2800, speed: 0.9, damage: 40, xp: 60, score: 25000, scale: 3.8, name: 'BRUTE KING' },
  VOID_LORD:   { hp: 4000, speed: 1.5, damage: 35, xp: 80, score: 40000, scale: 3.4, name: 'VOID LORD' },
  SOLAR_TYRANT:{ hp: 6000, speed: 1.3, damage: 45, xp: 100, score: 60000, scale: 4.0, name: 'SOLAR TYRANT' },
};

// -------- PLAYER --------
export const PLAYER = {
  scale: 1.8, baseSpeed: 7, dashSpeed: 3.2,
  dashDuration: 0.18, dashCooldown: 1.6, hpMax: 100,
};

// -------- MINING BLOCKS --------
export const BLOCK_CONFIG = {
  size: 1.8,
  hp: 5,                     // 5 swings per block (up from 3)
  fallHeight: 30,
  fallSpeed: 18,
  impactShake: 0.15,
};

// -------- CAPTURE ZONE --------
export const CAPTURE_RADIUS = 5.0;
export const CAPTURE_ENEMY_SLOWDOWN = 0.5;
export const CAPTURE_KILL_BONUS = 0.8;

// -------- SPAWNERS (destroy-portals wave) --------
export const SPAWNER_CONFIG = {
  corners: [                 // 4 fixed positions near arena corners
    { x: -32, z: -32 },
    { x:  32, z: -32 },
    { x: -32, z:  32 },
    { x:  32, z:  32 },
  ],
  spawnIntervalSec: 2.5,     // each portal spits out one enemy every 2.5s
  maxEnemiesPerPortal: 4,
};

// -------- MEEBIT RESCUE --------
export const MEEBIT_CONFIG = {
  portraitUrl: (id) => `https://meebits.app/meebitimages/characterimage?index=${id}&type=portrait&imageType=png`,
  fullUrl: (id) => `https://meebits.app/meebitimages/characterimage?index=${id}&type=full&imageType=png`,
  fallbackUrl: 'assets/meebit_fallback.png',
  totalSupply: 20000,
  rescueHoldTime: 2.0,
  cageHp: 50,
  cageBreakDamage: 6,
};

// -------- GUEST AVATAR --------
// If this file exists in /assets/, player.js uses it for non-signed users
// instead of the built-in voxel fallback.
export const GUEST_AVATAR_URL = 'assets/16801_larvalabs.glb';
