// armory.js — Persistent weapon & player upgrades.
//
// Currency: ORE (from runReward.js). Players earn ore from runs and
// spend it here on weapon unlocks, weapon stat upgrades, and player
// stat upgrades. The old armory.xp field is kept for save compat but
// all cost checks now read from the shared ore balance.
//
// Design rules:
//   • Only six weapons appear here — the canonical chapter 1-6
//     weapons. The chapter 7 lifedrainer is excluded.
//   • Pistol is always unlocked. The other five must be unlocked
//     once via ORE, then their stat tracks become spendable.
//   • Each weapon has 3 upgradeable stat tracks: DAMAGE, FIRE RATE,
//     CAPACITY (magazine size for the new reload mechanic).
//   • Player has 2 tracks: SPEED, HEALTH.
//   • Each track has a fixed number of levels with rising cost.
//
// Reading the data: combat code calls getEffectiveWeaponStats(id)
// to get the current resolved values, which take into account
// armory levels. The PER-RUN level-up boosts (S.damageBoost,
// S.fireRateBoost) are applied on top of these elsewhere.

// =====================================================================
// CATALOG
// =====================================================================
import { getOreBalance, spendOre } from './runReward.js';

// Six weapons — matches chapter 1..6 progression. Pistol is the
// chapter 1 baseline, the others unlock as you progress in the game.
// Order here is the order they appear in the armory grid.
export const ARMORY_WEAPON_IDS = [
  'pistol',
  'shotgun',
  'smg',
  'rocket',
  'raygun',
  'flamethrower',
];

// Display data per weapon. Keep this minimal — full weapon stats
// live in config.js WEAPONS. This is just for the armory UI.
export const ARMORY_WEAPON_META = {
  pistol: {
    label: 'PISTOL',
    chapter: 1,
    blurb: 'Reliable starter sidearm. Balanced damage and fire rate.',
    color: '#4ff7ff',
    unlockCost: 0,           // free / always unlocked
  },
  shotgun: {
    label: 'SHOTGUN',
    chapter: 2,
    blurb: 'Wide spread of pellets. High damage at point-blank range.',
    color: '#ff8800',
    unlockCost: 800,
  },
  smg: {
    label: 'SMG',
    chapter: 3,
    blurb: 'High rate of fire. Spreads a steady stream of damage.',
    color: '#ff3cac',
    unlockCost: 1500,
  },
  rocket: {
    label: 'ROCKET',
    chapter: 4,
    blurb: 'Homing rockets with splash damage. Slow but devastating.',
    color: '#ffaa00',
    unlockCost: 2400,
  },
  raygun: {
    label: 'RAY GUN',
    chapter: 5,
    blurb: 'Continuous beam. Highest single-target DPS in the game.',
    color: '#00ff66',
    unlockCost: 3500,
  },
  flamethrower: {
    label: 'FLAMETHROWER',
    chapter: 6,
    blurb: 'Short-range cone. Hits a whole wedge of enemies at once.',
    color: '#ff5522',
    unlockCost: 5000,
  },
};

// =====================================================================
// UPGRADE TRACKS
// =====================================================================
// Each track has MAX_LEVEL upgrade steps. cost(level) returns the XP
// cost to go from `level` (current) to `level+1`. effect(level) is
// the multiplier or flat value applied AT that level (level 0 = no
// upgrade, baseline). We keep MAX_LEVEL the same across tracks so
// the UI is uniform — 5 pip lights.
const MAX_LEVEL = 5;

// Cost curve for stat tracks — geometric ramp. Tuned so the first
// level is cheap (encourages investment) but level 5 is a real
// commitment (~3 runs of XP).
function _stdCost(level) {
  // level 0 → level 1: 200
  // level 1 → level 2: 400
  // level 2 → level 3: 800
  // level 3 → level 4: 1600
  // level 4 → level 5: 3200
  return 200 * Math.pow(2, level);
}

// Per-weapon stat tracks. The same track schema applies to all
// weapons; the effect numbers are tuned to be meaningful but not
// game-breaking. effectMul(level) returns the multiplier to apply
// to the weapon's BASE stat from config.js WEAPONS.
export const WEAPON_TRACKS = {
  damage: {
    key: 'damage',
    label: 'DAMAGE',
    desc: 'Increases base damage per shot.',
    maxLevel: MAX_LEVEL,
    cost: _stdCost,
    effectMul: (level) => 1 + level * 0.10,   // +10% per level → +50% at L5
  },
  fireRate: {
    key: 'fireRate',
    label: 'FIRE RATE',
    desc: 'Decreases time between shots.',
    maxLevel: MAX_LEVEL,
    cost: _stdCost,
    // Lower fireRate seconds = faster fire. We multiply so each
    // level shaves 8% off the cooldown → ~34% faster at L5.
    effectMul: (level) => Math.pow(0.92, level),
  },
  capacity: {
    key: 'capacity',
    label: 'CAPACITY',
    desc: 'Increases magazine size before reload.',
    maxLevel: MAX_LEVEL,
    cost: _stdCost,
    // Capacity is a flat addition; the base capacity comes from
    // WEAPON_BASE_CAPACITY below. +2 rounds per level → +10 at L5.
    effectAdd: (level) => level * 2,
  },
};

// Player tracks — applied to S.hpMax / S.playerSpeed once at run
// start (in resetGame, after the field is set to baseline).
export const PLAYER_TRACKS = {
  health: {
    key: 'health',
    label: 'MAX HEALTH',
    desc: 'Increases starting and maximum HP.',
    maxLevel: MAX_LEVEL,
    cost: _stdCost,
    // Flat HP adds. +20 per level → +100 at L5.
    effectAdd: (level) => level * 20,
  },
  speed: {
    key: 'speed',
    label: 'SPEED',
    desc: 'Increases base movement speed.',
    maxLevel: MAX_LEVEL,
    cost: _stdCost,
    // Flat speed adds. +0.4/level → +2.0 at L5 (vs ~7-9 base).
    effectAdd: (level) => level * 0.4,
  },
};

// =====================================================================
// WEAPON BASE CAPACITY + RELOAD TIME
// =====================================================================
// Magazine sizes for the new reload mechanic. Tuned per weapon so
// each one has its own rhythm:
//   • pistol: medium mag, fast reload
//   • shotgun: small mag, longer reload (pump-action feel)
//   • smg: huge mag, slow reload (drum mag)
//   • rocket: tiny mag, slow reload (each shell is a missile)
//   • raygun / flamethrower: time-limited "battery" emptied by
//     continuous firing, slow reload
//
// raygun + flamethrower are continuous-tick weapons, not per-shot.
// For those, "capacity" = battery units consumed per fireRate tick;
// the gun fires until battery hits 0 then must reload.
export const WEAPON_BASE_CAPACITY = {
  pistol:       12,
  shotgun:      6,
  smg:          30,
  rocket:       4,
  raygun:       100,    // beam ticks at 0.05s = 5s of continuous fire
  flamethrower: 80,     // flame ticks at 0.08s = ~6.4s of continuous fire
};

// Reload duration per weapon, in seconds.
export const WEAPON_BASE_RELOAD = {
  pistol:       1.2,
  shotgun:      1.8,
  smg:          2.2,
  rocket:       2.5,
  raygun:       2.8,
  flamethrower: 2.5,
};

// =====================================================================
// PERSISTENT STATE SHAPE
// =====================================================================
// The shape stored in localStorage (via save.js) is:
//   {
//     xp: 0,                              // current spendable XP balance
//     unlocked: { pistol: true, ... },    // per-weapon unlock map
//     weapons: {
//       pistol:  { damage: L, fireRate: L, capacity: L },
//       shotgun: { damage: L, fireRate: L, capacity: L },
//       ...
//     },
//     player: { health: L, speed: L },
//   }
//
// L = integer 0..MAX_LEVEL. Default state: pistol unlocked, all
// levels 0, xp 0.

export function defaultArmory() {
  const weapons = {};
  for (const id of ARMORY_WEAPON_IDS) {
    weapons[id] = { damage: 0, fireRate: 0, capacity: 0 };
  }
  const unlocked = {};
  for (const id of ARMORY_WEAPON_IDS) unlocked[id] = (id === 'pistol');
  return {
    xp: 0,
    unlocked,
    weapons,
    player: { health: 0, speed: 0 },
  };
}

// Normalize an armory record loaded from disk so missing fields
// (e.g. from older saves) get filled with defaults. Mutates a copy.
export function normalizeArmory(loaded) {
  const def = defaultArmory();
  if (!loaded || typeof loaded !== 'object') return def;
  const out = {
    xp: typeof loaded.xp === 'number' ? Math.max(0, loaded.xp) : 0,
    unlocked: { ...def.unlocked, ...(loaded.unlocked || {}) },
    weapons: {},
    player: { ...def.player, ...(loaded.player || {}) },
  };
  // Pistol is ALWAYS unlocked, even if a corrupted save says
  // otherwise. The combat loop assumes the player can always shoot.
  out.unlocked.pistol = true;
  for (const id of ARMORY_WEAPON_IDS) {
    const w = (loaded.weapons || {})[id] || {};
    out.weapons[id] = {
      damage:   _clampLvl(w.damage),
      fireRate: _clampLvl(w.fireRate),
      capacity: _clampLvl(w.capacity),
    };
  }
  out.player.health = _clampLvl(out.player.health);
  out.player.speed  = _clampLvl(out.player.speed);
  return out;
}

function _clampLvl(v) {
  v = Math.floor(Number(v) || 0);
  if (v < 0) return 0;
  if (v > MAX_LEVEL) return MAX_LEVEL;
  return v;
}

// =====================================================================
// EFFECTIVE STATS RESOLVER
// =====================================================================
// Given an armory record + a weapon id + the base WEAPON entry from
// config.js, return resolved values reflecting the armory upgrades.
// Combat code then layers per-run boosts (S.damageBoost,
// S.fireRateBoost) on top of these.
export function getEffectiveWeaponStats(armory, weaponId, baseWeapon) {
  const lvls = (armory && armory.weapons && armory.weapons[weaponId])
    || { damage: 0, fireRate: 0, capacity: 0 };
  const damageMul = WEAPON_TRACKS.damage.effectMul(lvls.damage);
  const fireRateMul = WEAPON_TRACKS.fireRate.effectMul(lvls.fireRate);
  const baseCap = WEAPON_BASE_CAPACITY[weaponId] || 12;
  const capacity = baseCap + WEAPON_TRACKS.capacity.effectAdd(lvls.capacity);
  const reloadTime = WEAPON_BASE_RELOAD[weaponId] || 1.5;
  return {
    damage: baseWeapon.damage * damageMul,
    fireRate: baseWeapon.fireRate * fireRateMul,
    capacity,
    reloadTime,
    levels: lvls,
  };
}

// Player effective stats. Caller passes in a baseline (PLAYER from
// config) and we return resolved hpMax + speed.
export function getEffectivePlayerStats(armory, baseHpMax, baseSpeed) {
  const lvls = (armory && armory.player) || { health: 0, speed: 0 };
  return {
    hpMax: baseHpMax + PLAYER_TRACKS.health.effectAdd(lvls.health),
    speed: baseSpeed + PLAYER_TRACKS.speed.effectAdd(lvls.speed),
    levels: lvls,
  };
}

// =====================================================================
// PURCHASE HELPERS (used by armory UI)
// =====================================================================
// Each helper returns a NEW armory object (immutable update) or
// null if the purchase is invalid. The UI calls Save.writeArmory()
// with the result.

export function tryUnlockWeapon(armory, weaponId) {
  if (!ARMORY_WEAPON_META[weaponId]) return null;
  if (armory.unlocked[weaponId]) return null;     // already unlocked
  const cost = ARMORY_WEAPON_META[weaponId].unlockCost;
  if (getOreBalance() < cost) return null;
  if (!spendOre(cost)) return null;
  const next = _clone(armory);
  next.unlocked[weaponId] = true;
  return next;
}

export function tryUpgradeWeapon(armory, weaponId, trackKey) {
  if (!armory.unlocked[weaponId]) return null;
  const track = WEAPON_TRACKS[trackKey];
  if (!track) return null;
  const cur = armory.weapons[weaponId][trackKey] || 0;
  if (cur >= track.maxLevel) return null;
  const cost = track.cost(cur);
  if (getOreBalance() < cost) return null;
  if (!spendOre(cost)) return null;
  const next = _clone(armory);
  next.weapons[weaponId][trackKey] = cur + 1;
  return next;
}

export function tryUpgradePlayer(armory, trackKey) {
  const track = PLAYER_TRACKS[trackKey];
  if (!track) return null;
  const cur = armory.player[trackKey] || 0;
  if (cur >= track.maxLevel) return null;
  const cost = track.cost(cur);
  if (getOreBalance() < cost) return null;
  if (!spendOre(cost)) return null;
  const next = _clone(armory);
  next.player[trackKey] = cur + 1;
  return next;
}

function _clone(armory) {
  return {
    xp: armory.xp,
    unlocked: { ...armory.unlocked },
    weapons: Object.fromEntries(
      Object.entries(armory.weapons).map(([k, v]) => [k, { ...v }]),
    ),
    player: { ...armory.player },
  };
}

// =====================================================================
// END-OF-RUN XP GRANT
// =====================================================================
// Convert a finished run into armory XP. The formula is intentionally
// generous in early levels and modest later — encourages experimenting
// with new builds without making post-game grinding required.
//
// Inputs:
//   score        — final score
//   runXP        — total in-run XP earned (from killEnemy etc)
//   chapter      — highest chapter reached (0..N)
//   wave         — last wave number reached
//   isComplete   — true if the run ended in a chapter-complete (vs game-over)
//
// Returns: integer XP to add to the persistent armory balance.
export function computeRunArmoryXP({ score, runXP, chapter, wave, isComplete }) {
  // Base from in-run XP. Quarter is generous — typical run earns
  // 800-2000 in-run XP, so 200-500 armory XP per run.
  let armoryXP = Math.floor((runXP || 0) * 0.25);
  // Chapter bonus — completing higher chapters is worth more.
  if (chapter > 0) armoryXP += chapter * 75;
  // Completion bonus — finishing a chapter (not just dying mid-wave).
  if (isComplete) armoryXP += 150;
  // Wave bonus — small flat per wave reached.
  if (wave > 0) armoryXP += wave * 8;
  // Score bonus — tiny.
  armoryXP += Math.floor((score || 0) / 100);
  return Math.max(0, armoryXP);
}

export const ARMORY_MAX_LEVEL = MAX_LEVEL;
