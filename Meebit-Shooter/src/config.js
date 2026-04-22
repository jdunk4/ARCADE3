// Shared configuration.

export const ARENA = 50;

// -------- CHAPTERS (orange -> red -> yellow -> green -> blue -> purple) --------
//
// Each chapter's bonusHerd now carries the full "recipe" for its Wave 6:
//   id          — folder under assets/civilians/
//   label, icon — UI text
//   size        — how many VRMs to spawn (matches the actual count in the folder;
//                 NO cycling — each VRM is unique)
//   scale       — mesh scale multiplier (normal herds are 1.5× for presence;
//                 dissected super-bosses are 2.5×)
//   shotsToSave — laser-tag HP per meebit (6 for normal, 15 for super boss)
//   bossTier    — true for dissected: fewer, bigger, tankier, shoot more often
export const CHAPTERS = [
  {
    name: 'INFERNO',
    full: { fog: 0x200806, ground: 0x2a0a08, grid1: 0xff6a1a, grid2: 0x4a1808, hemi1: 0xff6a1a, hemi2: 0x220400, lamp: 0xff6a1a, sky: 0x200806, enemyTint: 0xff6a1a, orb: 0xff9a2a },
    signatureEnemy: 'pumpkin',
    bonusHerd: { id: 'pigs',       label: 'PIGS',       icon: '🐷', size: 51, scale: 1.5, shotsToSave: 2,  bossTier: false },
  },
  {
    name: 'CRIMSON',
    full: { fog: 0x1a0408, ground: 0x24080c, grid1: 0xff2e4d, grid2: 0x3a0818, hemi1: 0xff2e4d, hemi2: 0x200004, lamp: 0xff2e4d, sky: 0x1a0408, enemyTint: 0xff2e4d, orb: 0xff5070 },
    // Crimson has two signature enemies — vampires everywhere, devils from wave 6+
    signatureEnemy: 'vampire',
    bonusHerd: { id: 'elephants',  label: 'ELEPHANTS',  icon: '🐘', size: 38, scale: 1.5, shotsToSave: 6,  bossTier: false },
  },
  {
    name: 'SOLAR',
    full: { fog: 0x2a2000, ground: 0x2a2408, grid1: 0xffd93d, grid2: 0x4a3810, hemi1: 0xffd93d, hemi2: 0x221800, lamp: 0xffd93d, sky: 0x2a2000, enemyTint: 0xffbb00, orb: 0xffee55 },
    signatureEnemy: 'wizard',
    bonusHerd: { id: 'skeletons',  label: 'SKELETONS',  icon: '💀', size: 59, scale: 1.5, shotsToSave: 6,  bossTier: false },
  },
  {
    name: 'TOXIC',
    full: { fog: 0x041a0a, ground: 0x0d2a12, grid1: 0x00ff66, grid2: 0x104020, hemi1: 0x00ff66, hemi2: 0x002211, lamp: 0x00ff66, sky: 0x041a0a, enemyTint: 0x00ff44, orb: 0x66ff88 },
    signatureEnemy: 'goospitter',
    bonusHerd: { id: 'robots',     label: 'ROBOTS',     icon: '🤖', size: 74, scale: 1.5, shotsToSave: 6,  bossTier: false },
  },
  {
    name: 'ARCTIC',
    full: { fog: 0x0a1428, ground: 0x102238, grid1: 0x4ff7ff, grid2: 0x123a5a, hemi1: 0x4ff7ff, hemi2: 0x001122, lamp: 0x4ff7ff, sky: 0x0a1428, enemyTint: 0x4ff7ff, orb: 0x88ffff },
    signatureEnemy: 'ghost',
    bonusHerd: { id: 'visitors',   label: 'VISITORS',   icon: '👽', size: 18, scale: 1.5, shotsToSave: 6,  bossTier: false },
  },
  {
    name: 'PARADISE',
    full: { fog: 0x1a0830, ground: 0x220c3c, grid1: 0xe63aff, grid2: 0x4a1866, hemi1: 0xe63aff, hemi2: 0x0a0020, lamp: 0xe63aff, sky: 0x1a0830, enemyTint: 0xbb00ff, orb: 0xff88ff },
    signatureEnemy: 'ghost',
    // Ch.6 PARADISE — only 6 DISSECTED meebits, but they're super-bosses.
    // Bigger, tankier, more aggressive healing fire. Real final-chapter flavor.
    bonusHerd: { id: 'dissected',  label: 'DISSECTED',  icon: '🫀', size: 6,  scale: 2.5, shotsToSave: 15, bossTier: true  },
  },
];

// Muted base — wave 1 of each chapter mixes from here toward full palette.
export const CHAPTER_BASE = {
  fog: 0x0a0a14, ground: 0x181828, grid1: 0x444466, grid2: 0x222234,
  hemi1: 0x5a5a7a, hemi2: 0x101018, lamp: 0x9090aa, sky: 0x0a0a14, enemyTint: 0x7070a0,
};

// NEW wave structure (5 waves per chapter):
//   1 MINING    — dormant props visible, mine ores → depot
//   2 POWERUP   — 5 sequential stand-in-zones: power / turrets A / turrets B
//                 / radio / EMP. Turrets fire at enemies while you work.
//                 EMP launch enrages hives (drops shields) and deactivates
//                 turrets going into wave 3.
//   3 HIVE      — shielded hives from ch start are now vulnerable; destroy
//                 them. Secondary enemy flow continues while you work.
//   4 BONUS     — herd laser-tag (formerly wave 6). Pre-boss cinematic
//                 fires just before this wave starts, giving the herd VRMs
//                 time to stream in during the cinematic.
//   5 BOSS      — final fight.
export const WAVES_PER_CHAPTER = 5;
export const THEMES = CHAPTERS.map(c => ({ name: c.name, ...c.full }));

// Intensity curve. Boss (5) stays at peak. Bonus (4) rides high for the
// victory lap. Power-up (2) and hive (3) ramp combat intensity.
export function intensityForWave(localWave) {
  if (localWave >= 5) return 1.0;          // boss
  if (localWave === 4) return 0.95;        // bonus herd
  return 0.30 + ((localWave - 1) / 3) * 0.60;
}

// Orb counts per wave. No orbs on the bonus wave — herd catching is the
// only objective. Power-up + hive scale up normally.
export function orbCountForWave(localWave) {
  return [2, 6, 10, 0, 0][localWave - 1] || 0;
}

// -------- BONUS WAVE (localWave === 4) --------
//
// NOTE: herdSize is NO LONGER fixed. Each chapter's bonusHerd.size determines
// how many VRMs spawn. Helper getBonusHerdSize(chapterIdx) below.
export const BONUS_WAVE_CONFIG = {
  duration: 30,                  // seconds
  catchRadius: 2.8,              // player proximity auto-collect
  scorePerCatch: 500,            // score awarded per caught civilian
  // Stagger between individual spawns. Herd sizes are smaller now (5-74 instead
  // of 111), and pools are built during the matrix dive AND boss cinematic, so
  // spawns are effectively teleport-only. Tight stagger = herd is on-screen fast.
  spawnStagger: 80,              // ms between individual spawns
  // Up to 3 concurrent spawns in flight (pool path is cheap — pure visibility
  // toggles — so we don't need heavy serialization here).
  maxConcurrentSpawns: 3,
  spawnRingMin: 10,              // herd spawn ring inner radius
  spawnRingMax: ARENA - 3,       // herd spawn ring outer radius
  wanderSpeed: 2.2,              // how fast they mosey around
  wanderChangeSec: 3.5,          // how often they pick a new direction

  // ---- FRIENDLY LASER TAG FIRE ----
  // Meebits in the bonus wave fire back at the player — but their "bullets"
  // are HEALING pulses, not damage. On hit, the player's HP ticks up. This
  // turns Wave 6 into a cozy, restorative victory lap where dodging is
  // optional and tagging meebits is the only objective.
  healFire: {
    enabled: true,
    // Normal herds: 1 shot per meebit every ~3-6 seconds on average.
    // Super-boss herd (dissected): 1 shot per meebit every ~1.2-2.4 seconds.
    fireIntervalMin: 3.0,        // seconds (normal herds)
    fireIntervalMax: 6.0,
    fireIntervalMinBoss: 1.2,    // seconds (dissected super-bosses)
    fireIntervalMaxBoss: 2.4,
    projectileSpeed: 14,         // units/sec — slow enough to read/dodge
    projectileLife: 2.8,         // seconds before despawn
    healPerHit: 5,               // HP restored to player per heal-pulse hit
    healPerHitBoss: 12,          // dissected heal pulses are stronger
    projectileColor: 0x66ff99,   // soft green — reads as friendly/healing
    projectileColorBoss: 0xff66cc, // dissected super-bosses: pink heal pulses
    projectileSize: 0.35,        // visual scale
    // Firing requires line-of-sight distance to player: meebits too far away
    // don't bother. Keeps the "close to the action = get healed" dynamic.
    maxFireDistance: 28,
    // Meebit won't fire while panicking (laser-tag already hit them this cycle).
  },

  // VRM assets live in assets/civilians/{herdId}/<filename>.vrm — filenames
  // come from manifest.json in each herd folder (see herdVrmLoader.js).
  assetPathFor: (herdId, filename) => `assets/civilians/${herdId}/${filename}`,
};

// Convenience lookup for the herd size of a given chapter.
export function getBonusHerdSize(chapterIdx) {
  const ch = CHAPTERS[chapterIdx % CHAPTERS.length];
  return ch && ch.bonusHerd ? (ch.bonusHerd.size || 0) : 0;
}

// -------- WEAPONS --------
// Slot ordering (UI + keys 1-6): pistol, shotgun, smg, rocket, raygun, flamethrower.
// Pickaxe is the mining tool (toggled via Q, not in the 1-6 slot row).
export const WEAPONS = {
  pistol:  { name: 'PISTOL',  fireRate: 0.16, damage: 25,  bullets: 1, spread: 0.04, speed: 40, slot: 'pistol',  color: 0x4ff7ff },
  shotgun: { name: 'SHOTGUN', fireRate: 0.55, damage: 18,  bullets: 6, spread: 0.28, speed: 36, slot: 'shotgun', color: 0xff8800 },
  smg:     { name: 'SMG',     fireRate: 0.07, damage: 14,  bullets: 1, spread: 0.12, speed: 44, slot: 'smg',     color: 0xff3cac },
  rocket:  {
    name: 'ROCKET',
    fireRate: 0.85,
    damage: 120,                // direct-hit damage; AoE adds more
    bullets: 1, spread: 0,
    speed: 28,
    slot: 'rocket',
    color: 0xffaa00,
    isHoming: true,
    homingStrength: 6.0,        // radians/sec turn rate
    explosionRadius: 4.0,
    explosionDamage: 80,
  },
  raygun:  {
    name: 'RAY GUN',
    // Beam ticks damage while held. fireRate controls damage-tick cadence.
    fireRate: 0.05,
    damage: 12,                 // per tick (every 50ms) → ~240 dps sustained
    bullets: 0, spread: 0, speed: 0,
    slot: 'raygun',
    color: 0x00ff66,
    isBeam: true,
    beamRange: 30,
    beamWidth: 0.35,
  },
  flamethrower: {
    name: 'FLAMETHROWER',
    // Short-range cone that ticks damage every fireRate seconds while held.
    // Much shorter than raygun but hits a wedge of enemies in front.
    fireRate: 0.08,             // damage-tick cadence (~125ms)
    damage: 10,                 // per-tick per-enemy
    bullets: 0, spread: 0, speed: 0,
    slot: 'flamethrower',
    color: 0xff5522,
    isFlame: true,
    flameRange: 11,             // units forward
    flameAngle: 0.55,           // half-angle of the cone (radians) → ~63° wedge
  },
  pickaxe: {
    name: 'PICKAXE', fireRate: 0.32, damage: 20, bullets: 0, spread: 0, speed: 0,
    slot: 'pickaxe', color: 0xffd93d, isMining: true, reach: 2.4,
  },
};

// -------- WAVE STRUCTURE (per chapter) --------
//
// Wave order within each chapter:
//   1 MINING    → mine ores, deliver to depot
//   2 POWERUP   → 5 stand-in-zone objectives culminating in EMP launch.
//                 Rewards: live turrets firing at enemies through the wave.
//                 EMP at the end enrages hives + deactivates turrets.
//   3 HIVE      → destroy shielded-then-enraged hives
//   4 BONUS     → herd laser-tag (victory-lap cadence, heal-fire from meebits)
//   5 BOSS      → final fight (cinematic fires BEFORE wave 4 so VRMs stream in)
export function getWaveDef(wave) {
  const localWave = ((wave - 1) % WAVES_PER_CHAPTER) + 1;
  const chapterIdx = Math.floor((wave - 1) / WAVES_PER_CHAPTER);

  if (localWave === 1) {
    // Wave 1 — MINING. Dormant hives + turrets visible but inert.
    return {
      type: 'mining',
      oresRequired: 5,
      enemies: waveEnemyMix(wave, chapterIdx),
      spawnRate: Math.min(2.0, 0.5 + wave * 0.12),
      blockFallRate: 4.0,
      blockCount: 8,
      localWave, chapterIdx,
    };
  }
  if (localWave === 2) {
    // Wave 2 — POWER-UP. 5 sequential zones: power → turrets A → turrets B
    // → radio → EMP missile launch. Turrets come online at each step and
    // auto-fire at enemies. EMP at the end ends the wave + drops hive shields.
    return {
      type: 'powerup',
      enemies: waveEnemyMix(wave, chapterIdx),
      spawnRate: Math.min(3.0, 1 + wave * 0.18),
      // Each zone takes ~3.5s standing in it to complete.
      zoneHoldTime: 3.5,
      // Stage 2 will implement the 5 zones + 3 turrets. For Stage 1 this
      // is a clean stub — the zone count / turret count are stated here
      // so the dormant-props pass can lay down the right visuals up front.
      zones: ['POWER', 'TURRETS_A', 'TURRETS_B', 'RADIO', 'EMP'],
      turretCount: 3,
      localWave, chapterIdx,
    };
  }
  if (localWave === 3) {
    // Wave 3 — HIVES. Shields were up in waves 1-2; EMP just enraged them.
    // Now destroyable. Secondary enemy flow continues from offscreen spawns.
    return {
      type: 'hive',
      hiveCount: 4,
      hiveHp: 12,
      enemies: waveEnemyMix(wave, chapterIdx),
      spawnRate: Math.min(3.5, 1 + wave * 0.2),
      localWave, chapterIdx,
    };
  }
  if (localWave === 4) {
    // Wave 4 — BONUS (herd laser-tag). The pre-boss cinematic fires at the
    // END of wave 3, transitioning into this wave. That gives the VRM
    // prefetch ~6s to resolve before the herd pours in.
    const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
    return {
      type: 'bonus',
      herd: chapter.bonusHerd,
      duration: BONUS_WAVE_CONFIG.duration,
      herdSize: chapter.bonusHerd.size,
      localWave, chapterIdx,
    };
  }
  // localWave === 5 — BOSS.
  return {
    type: 'boss',
    killTarget: 1,
    enemies: { zomeeb: 0.6, sprinter: 0.25, [CHAPTERS[chapterIdx % CHAPTERS.length].signatureEnemy]: 0.15 },
    spawnRate: 1.4,
    bossType: ['MEGA_ZOMEEB', 'BRUTE_KING', 'VOID_LORD', 'SOLAR_TYRANT'][chapterIdx % 4],
    localWave, chapterIdx,
  };
}

// Per-chapter enemy mix — respects your rules:
//   Ch.0 (waves 1-5, ORANGE): pumpkinhead + zomeeb/sprinter/brute
//   Ch.1 (waves 6-10, RED):   vampire + red_devil (from wave 6+) + base
//   Ch.2 (waves 11-15, YEL):  wizard + base
//   Ch.3 (waves 16-20, GRN):  goospitter + base
//   Ch.4+ fallback: ghost + base
function waveEnemyMix(wave, chapterIdx) {
  const base = { zomeeb: 0.4, sprinter: 0.25 };

  if (chapterIdx === 0) {
    // ORANGE — pumpkinheads appear only here
    if (wave <= 2) { base.zomeeb = 0.9; base.sprinter = 0.1; }
    else {
      base.pumpkin = 0.25;
      base.brute = 0.10;
    }
  } else if (chapterIdx === 1) {
    // RED — vampires, plus red devils waves 6-10
    base.vampire = 0.25;
    base.red_devil = 0.20;
    base.brute = 0.10;
  } else if (chapterIdx === 2) {
    // YELLOW — wizards with triangle projectiles
    base.wizard = 0.25;
    base.brute = 0.10;
    base.phantom = 0.05;
  } else if (chapterIdx === 3) {
    // GREEN — long lanky goo spitters
    base.goospitter = 0.25;
    base.brute = 0.10;
    base.phantom = 0.05;
  } else {
    // Later chapters keep their signature
    const sig = CHAPTERS[chapterIdx % CHAPTERS.length].signatureEnemy;
    base[sig] = 0.20;
    base.brute = 0.10;
    base.phantom = 0.05;
  }
  return base;
}

// -------- ENEMY TYPES --------
export const ENEMY_TYPES = {
  zomeeb:     { speed: 2.2, hp: 55,  xp: 3, score: 400,  scale: 1.0,  damage: 12, name: 'ZOMEEB' },
  sprinter:   { speed: 4.0, hp: 30,  xp: 2, score: 250,  scale: 0.85, damage: 10, name: 'SPRINTER' },
  brute:      { speed: 1.2, hp: 180, xp: 6, score: 1200, scale: 1.45, damage: 22, name: 'BRUTE' },
  spitter:    { speed: 1.8, hp: 65,  xp: 4, score: 700,  scale: 1.05, damage: 8,  name: 'SPITTER', ranged: true, range: 14 },
  phantom:    { speed: 3.2, hp: 45,  xp: 5, score: 900,  scale: 1.0,  damage: 15, name: 'PHANTOM', phases: true },
  spider:     { speed: 3.6, hp: 40,  xp: 3, score: 500,  scale: 1.1,  damage: 11, name: 'SPIDER' },
  pumpkin:    { speed: 1.6, hp: 90,  xp: 5, score: 850,  scale: 1.1,  damage: 18, name: 'PUMPKIN HEAD', explodes: true },
  ghost:      { speed: 2.4, hp: 55,  xp: 4, score: 700,  scale: 1.0,  damage: 13, name: 'GHOST',   phases: true },

  // NEW ENEMIES
  vampire:    {
    speed: 3.0, hp: 70,  xp: 5, score: 900,  scale: 1.0,  damage: 16,
    name: 'VAMPIRE',
    blinks: true,            // teleports closer to player periodically
    blinkInterval: 3.5,
    blinkRange: 6,
  },
  red_devil:  {
    speed: 2.8, hp: 85,  xp: 6, score: 1100, scale: 1.05, damage: 18,
    name: 'RED DEVIL',
    ranged: true,
    range: 16,
    fireballColor: 0xff2e4d,
  },
  wizard:     {
    speed: 1.6, hp: 70,  xp: 5, score: 950,  scale: 1.05, damage: 14,
    name: 'WIZARD',
    ranged: true,
    range: 18,
    projType: 'triangle',    // triangle projectiles
    fireballColor: 0xffd93d,
  },
  goospitter: {
    speed: 1.5, hp: 110, xp: 6, score: 1100, scale: 1.3,  damage: 10,
    name: 'GOO SPITTER',
    ranged: true,
    range: 18,
    lanky: true,             // tall & narrow proportions
    leavesGoo: true,         // ground goo pools on hit
    fireballColor: 0x00ff44,
  },
};

// -------- BOSSES --------
export const BOSSES = {
  MEGA_ZOMEEB: { hp: 1500, speed: 1.1, damage: 30, xp: 40, score: 15000, scale: 3.2, name: 'MEGA ZOMEEB', pattern: 'summoner' },
  BRUTE_KING:  { hp: 2800, speed: 0.9, damage: 40, xp: 60, score: 25000, scale: 3.8, name: 'BRUTE KING',  pattern: 'cubestorm' },
  VOID_LORD:   { hp: 4000, speed: 1.5, damage: 35, xp: 80, score: 40000, scale: 3.4, name: 'VOID LORD',   pattern: 'summoner' },
  SOLAR_TYRANT:{ hp: 6000, speed: 1.3, damage: 45, xp: 100, score: 60000, scale: 4.0, name: 'SOLAR TYRANT', pattern: 'cubestorm' },
};

// -------- PLAYER --------
export const PLAYER = {
  scale: 1.8, baseSpeed: 7, dashSpeed: 3.2,
  dashDuration: 0.18, dashCooldown: 1.6, hpMax: 100,
};

// -------- MINING BLOCKS --------
// hp: 25 — every bullet deals exactly 1 damage regardless of weapon.
// Pickaxe deals its full damage (20/swing = 2 swings/block).
// Blocks grow as they take damage and EXPLODE with AoE on destruction.
export const BLOCK_CONFIG = {
  size: 1.8, hp: 25, fallHeight: 30, fallSpeed: 18, impactShake: 0.15,
  explosionRadius: 4.5,          // AoE radius of the explosion
  explosionDamageEnemy: 80,      // direct damage to any enemy in the blast
  explosionDamagePlayer: 18,     // player takes this if they're in the blast
  explosionDamageCivilian: 999,  // civilians die in one hit
  growMaxScale: 1.55,            // at 0 hp the block is this much bigger than at full hp
  blinkStartRatio: 0.2,          // blink starts when hp/hpMax falls below this (last 5 hp)
};

// -------- MINING CONFIG (ore + depot flow) --------
export const MINING_CONFIG = {
  oresRequired: 5,
  blockCount: 8,                 // fewer blocks — each one is a real commitment
  blockFallRate: 4.0,
  depotOffsetFromCenter: 22,
  depotDepositRadius: 2.8,
  bulletDamageToBlock: 1,        // every bullet = 1 damage (Option A, literal 100 shots)
};

// -------- CAPTURE ZONE --------
export const CAPTURE_RADIUS = 5.0;
export const CAPTURE_ENEMY_SLOWDOWN = 0.5;
export const CAPTURE_KILL_BONUS = 0.8;

// -------- HIVES (formerly SPAWNERS / "destroy portals") --------
// Renamed to "hive phase". Positions are now randomized each run (see
// pickRandomHivePositions in spawners.js). Throughput boosted ~10× by
// cutting spawn interval (2.5s → 0.8s) and raising per-hive cap (4 → 16).
// Export kept as SPAWNER_CONFIG so existing imports don't break.
export const SPAWNER_CONFIG = {
  corners: null,                   // no longer used — kept for legacy imports
  hiveCount: 4,
  spawnIntervalSec: 0.8,           // was 2.5 → ~3.1× more often
  maxEnemiesPerPortal: 16,         // was 4  → 4× higher cap
  spawnerHp: 12,                   // ~12 shots to kill with pistol (1 dmg each)
  minPairwiseDist: 22,             // hives can't spawn too close to each other
  minDistFromCenter: 14,           // hives can't spawn on top of player start
};
// Alias for readability in new code — identical reference
export const HIVE_CONFIG = SPAWNER_CONFIG;

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

// -------- WEATHER / RAIN --------
// Baseline geometry values used by the rain system at init. The per-wave
// intensity comes from rainIntensity() below — chapter sets the HUE, wave
// sets the INTENSITY (drizzle → typhoon).
export const RAIN_CONFIG = {
  dropCount: 300,
  area: 60,            // spawn area radius
  speedY: -24,         // vertical fall speed
  speedX: 10,          // diagonal drift
  height: 30,
};

/**
 * Per-wave rain intensity curve. Color comes from the chapter theme — these
 * values control only intensity knobs (drop count, speed, opacity, wind,
 * lightning, typhoon).
 *   wave 1 MINING  : drizzle (atmospheric)
 *   wave 2 POWERUP : steady rain
 *   wave 3 HIVE    : downpour
 *   wave 4 BONUS   : storm has cleared — victory-lap drizzle
 *   wave 5 BOSS    : TYPHOON
 */
export function rainIntensity(localWave) {
  const w = Math.max(1, Math.min(5, localWave || 1));
  const presets = {
    1: { dropCount: 80,   speedY: -14, speedX: 4,   opacity: 0.25, wind: 0.05, lightning: false, typhoon: false, fogBoost: 0.00 },
    2: { dropCount: 260,  speedY: -20, speedX: 8,   opacity: 0.40, wind: 0.15, lightning: false, typhoon: false, fogBoost: 0.10 },
    3: { dropCount: 600,  speedY: -32, speedX: 14,  opacity: 0.55, wind: 0.30, lightning: false, typhoon: false, fogBoost: 0.25 },
    // Bonus wave: storm clears for the victory lap. Minimal drizzle.
    4: { dropCount: 40,   speedY: -10, speedX: 2,   opacity: 0.15, wind: 0.02, lightning: false, typhoon: false, fogBoost: 0.00 },
    // Boss wave: full typhoon returns.
    5: { dropCount: 1800, speedY: -56, speedX: 36,  opacity: 0.80, wind: 1.00, lightning: true,  typhoon: true,  fogBoost: 0.70 },
  };
  return presets[w];
}

// -------- GOO SPLATS --------
export const GOO_CONFIG = {
  lifetimeSec: 60,     // disappear after 1 minute
  size: 0.9,
  spawnChance: 0.35,   // chance a kill leaves a splat
};

// -------- GUEST AVATAR --------
export const GUEST_AVATAR_URL = 'assets/16801_larvalabs.glb';
