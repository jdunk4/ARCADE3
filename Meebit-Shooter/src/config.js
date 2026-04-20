// Shared configuration: tune values live here, no game logic.

export const ARENA = 50; // half-size, world is -ARENA..ARENA on X/Z

// -------- CHAPTERS (themes stretch across 5 waves) --------
// Each chapter = 5 waves. Wave 1 of chapter is 20% tinted, wave 5 is 100%.
// Theme colors interpolate from a muted base toward the full theme color.
export const CHAPTERS = [
  { name: 'TOXIC',    full: { fog: 0x041a0a, ground: 0x0d2a12, grid1: 0x00ff66, grid2: 0x104020, hemi1: 0x00ff66, hemi2: 0x002211, lamp: 0x00ff66, sky: 0x041a0a, enemyTint: 0x00ff44 } },
  { name: 'ARCTIC',   full: { fog: 0x0a1428, ground: 0x102238, grid1: 0x4ff7ff, grid2: 0x123a5a, hemi1: 0x4ff7ff, hemi2: 0x001122, lamp: 0x4ff7ff, sky: 0x0a1428, enemyTint: 0x4ff7ff } },
  { name: 'PARADISE', full: { fog: 0x1a0830, ground: 0x220c3c, grid1: 0xe63aff, grid2: 0x4a1866, hemi1: 0xe63aff, hemi2: 0x0a0020, lamp: 0xe63aff, sky: 0x1a0830, enemyTint: 0xbb00ff } },
  { name: 'CEMETERY', full: { fog: 0x0a0614, ground: 0x1a0c2e, grid1: 0xff3cac, grid2: 0x3a1050, hemi1: 0xff3cac, hemi2: 0x110022, lamp: 0xff3cac, sky: 0x0a0614, enemyTint: 0xff3cac } },
  { name: 'INFERNO',  full: { fog: 0x200806, ground: 0x2a0a08, grid1: 0xff6a1a, grid2: 0x4a1808, hemi1: 0xff6a1a, hemi2: 0x220400, lamp: 0xff6a1a, sky: 0x200806, enemyTint: 0xff4422 } },
  { name: 'SOLAR',    full: { fog: 0x2a2000, ground: 0x2a2408, grid1: 0xffd93d, grid2: 0x4a3810, hemi1: 0xffd93d, hemi2: 0x221800, lamp: 0xffd93d, sky: 0x2a2000, enemyTint: 0xffbb00 } },
  { name: 'MATRIX',   full: { fog: 0x001a08, ground: 0x001a0c, grid1: 0x00ff44, grid2: 0x002211, hemi1: 0x00ff44, hemi2: 0x001100, lamp: 0x00ff44, sky: 0x001a08, enemyTint: 0x00ffaa } },
];

// Muted "base" tint that every chapter starts from (wave 1 of chapter = 20% toward full)
export const CHAPTER_BASE = {
  fog: 0x0a0a14, ground: 0x181828, grid1: 0x444466, grid2: 0x222234,
  hemi1: 0x5a5a7a, hemi2: 0x101018, lamp: 0x9090aa, sky: 0x0a0a14, enemyTint: 0x7070a0
};

export const WAVES_PER_CHAPTER = 5;

// Kept for back-compat with legacy code that references THEMES — now returns per-chapter full palettes.
export const THEMES = CHAPTERS.map(c => ({ name: c.name, ...c.full }));

// -------- WEAPONS --------
export const WEAPONS = {
  pistol: {
    name: 'PISTOL',
    fireRate: 0.16, damage: 25, bullets: 1, spread: 0.04, speed: 40,
    slot: 'pistol', color: 0x4ff7ff,
  },
  shotgun: {
    name: 'SHOTGUN',
    fireRate: 0.55, damage: 18, bullets: 6, spread: 0.28, speed: 36,
    slot: 'shotgun', color: 0xff8800,
  },
  smg: {
    name: 'SMG',
    fireRate: 0.07, damage: 14, bullets: 1, spread: 0.12, speed: 44,
    slot: 'smg', color: 0xff3cac,
  },
  sniper: {
    name: 'SNIPER',
    fireRate: 0.9, damage: 180, bullets: 1, spread: 0, speed: 90,
    slot: 'sniper', color: 0x00ff66,
  },
  // Pickaxe is a "weapon" slot but mines blocks instead of shooting.
  pickaxe: {
    name: 'PICKAXE',
    fireRate: 0.35, damage: 34, bullets: 0, spread: 0, speed: 0,
    slot: 'pickaxe', color: 0xffd93d, isMining: true, reach: 2.2,
  },
};

// -------- WAVE DEFINITIONS --------
// Each chapter is 5 waves with fixed flavors:
//   wave 1 of chapter = 'rescue'  (combat + caged meebit to free)
//   wave 2 of chapter = 'combat'
//   wave 3 of chapter = 'capture' (weapon reward)
//   wave 4 of chapter = 'mining'  (blocks fall, bullets blocked, pickaxe needed)
//   wave 5 of chapter = 'boss'
export function getWaveDef(wave) {
  const localWave = ((wave - 1) % WAVES_PER_CHAPTER) + 1; // 1..5
  const chapterIdx = Math.floor((wave - 1) / WAVES_PER_CHAPTER);

  if (localWave === 5) {
    return {
      type: 'boss',
      killTarget: 1,
      enemies: { zomeeb: 0.7, sprinter: 0.3 },
      spawnRate: 1.4,
      bossType: ['MEGA_ZOMEEB', 'BRUTE_KING', 'VOID_LORD', 'SOLAR_TYRANT'][chapterIdx % 4],
      reward: null,
      localWave, chapterIdx,
    };
  }
  if (localWave === 3) {
    const weaponRewards = ['shotgun', 'smg', 'sniper'];
    return {
      type: 'capture',
      killTarget: 8 + wave * 2,
      enemies: waveEnemyMix(wave),
      spawnRate: Math.min(3.5, 1 + wave * 0.2),
      captureTime: 6,
      reward: weaponRewards[chapterIdx % weaponRewards.length],
      localWave, chapterIdx,
    };
  }
  if (localWave === 4) {
    return {
      type: 'mining',
      killTarget: 8 + wave * 2,
      enemies: waveEnemyMix(wave),
      spawnRate: Math.min(2.5, 0.7 + wave * 0.15), // slightly reduced - player busy mining
      blockFallRate: 2.2, // seconds between block drops
      blockCount: 18 + chapterIdx * 2,
      localWave, chapterIdx,
    };
  }
  if (localWave === 1) {
    return {
      type: 'rescue',
      killTarget: 10 + wave * 2,
      enemies: waveEnemyMix(wave),
      spawnRate: Math.min(4, 1 + wave * 0.22),
      hasMeebitRescue: true,
      localWave, chapterIdx,
    };
  }
  // localWave === 2: pure combat
  return {
    type: 'combat',
    killTarget: 10 + wave * 3 + wave * wave * 0.3 | 0,
    enemies: waveEnemyMix(wave),
    spawnRate: Math.min(4, 1 + wave * 0.22),
    reward: null,
    localWave, chapterIdx,
  };
}

function waveEnemyMix(wave) {
  if (wave <= 2) return { zomeeb: 1.0 };
  if (wave <= 4) return { zomeeb: 0.75, sprinter: 0.25 };
  if (wave <= 6) return { zomeeb: 0.55, sprinter: 0.30, brute: 0.15 };
  if (wave <= 9) return { zomeeb: 0.40, sprinter: 0.30, brute: 0.20, spitter: 0.10 };
  return { zomeeb: 0.30, sprinter: 0.30, brute: 0.20, spitter: 0.15, phantom: 0.05 };
}

// -------- ENEMY TYPES --------
export const ENEMY_TYPES = {
  zomeeb:   { speed: 2.2, hp: 55,  xp: 3, score: 400,  scale: 1.0,  damage: 12, name: 'ZOMEEB' },
  sprinter: { speed: 4.0, hp: 30,  xp: 2, score: 250,  scale: 0.85, damage: 10, name: 'SPRINTER' },
  brute:    { speed: 1.2, hp: 180, xp: 6, score: 1200, scale: 1.45, damage: 22, name: 'BRUTE' },
  spitter:  { speed: 1.8, hp: 65,  xp: 4, score: 700,  scale: 1.05, damage: 8,  name: 'SPITTER', ranged: true, range: 14 },
  phantom:  { speed: 3.2, hp: 45,  xp: 5, score: 900,  scale: 1.0,  damage: 15, name: 'PHANTOM', phases: true },
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
  scale: 1.8,
  baseSpeed: 7,
  dashSpeed: 3.2,
  dashDuration: 0.18,
  dashCooldown: 1.6,
  hpMax: 100,
};

// -------- MINING BLOCKS --------
export const BLOCK_CONFIG = {
  size: 1.8,          // world units (cube side)
  hp: 3,              // swings to break
  fallHeight: 30,     // starting y
  fallSpeed: 18,      // units per second
  impactShake: 0.15,
  // Colors follow the chapter's tint — set dynamically.
};

// -------- MEEBITS (rescue NPCs) --------
// Chapter-agnostic. Rescued meebits persist in save.
export const MEEBIT_CONFIG = {
  portraitUrl: (id) => `https://meebits.app/meebitimages/characterimage?index=${id}&type=portrait&imageType=png`,
  fullUrl: (id) => `https://meebits.app/meebitimages/characterimage?index=${id}&type=full&imageType=png`,
  // Fallback if the external API is unreachable we use local bundled portrait:
  fallbackUrl: 'assets/meebit_fallback.png',
  totalSupply: 20000,
  rescueHoldTime: 2.0, // seconds to free
  cageHp: 3,
};
