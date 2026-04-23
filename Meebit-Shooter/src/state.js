import { PLAYER, WAVES_PER_CHAPTER, WEAPONS } from './config.js';

// Global mutable game state.
export const S = {
  phase: 'loading',
  running: false,
  paused: false,

  // Score & progression
  score: 0,
  kills: 0,
  wave: 1,
  chapter: 0,
  localWave: 1,
  waveKillTarget: 10,
  waveKillsProgress: 0,
  waveActive: true,
  timeElapsed: 0,

  // Player
  hp: PLAYER.hpMax,
  hpMax: PLAYER.hpMax,
  xp: 0,
  xpNext: 10,
  level: 1,
  playerSpeed: PLAYER.baseSpeed,

  // Weapons
  currentWeapon: 'pistol',
  previousCombatWeapon: 'pistol',
  ownedWeapons: new Set(['pistol', 'pickaxe']),
  fireCooldown: 0,

  // Abilities
  dashCooldown: 0,
  dashActive: 0,
  shields: 0,
  invulnTimer: 0,

  // Wave/boss refs
  bossRef: null,
  objectiveZone: null,
  captureProgress: 0,
  captureTarget: 0,
  captureRadius: 5.0,
  captureMissileLaunching: false,

  // Mining
  miningActive: false,
  blockFallTimer: 0,
  blocksSpawned: 0,
  blocksToSpawn: 0,
  blocksMined: 0,           // how many blocks the player has destroyed this wave
  blocksRequired: 5,        // legacy — kept for old save files
  oresCarried: 0,           // ores in player's hand (deposited at depot)
  oresRequired: 5,          // how many ores need to be delivered this wave

  // Spawners / Hive (destroy-hives wave)
  spawnerWaveActive: false,
  spawnersLive: 0,          // how many are still standing
  hiveWaveActive: false,    // alias in new code for readability
  // Hives are visible but SHIELDED on waves 1 and 2 (dormant props). The
  // EMP launch at the end of wave 2 enrages them — shields drop, they
  // become vulnerable, and wave 3 starts. This flag drives both the
  // visual shield mesh and the bullet-immunity check.
  hivesShielded: true,

  // Rescue
  rescueMeebit: null,
  rescuedCount: 0,
  rescuedIds: [],

  // Power-up wave (localWave 2 of each chapter). 5 sequential stand-in-zone
  // objectives: POWER → TURRETS_A → TURRETS_B → RADIO → EMP. Turrets come
  // online at each step and fire at enemies through the wave. Populated by
  // waves.js when the powerup wave starts; cleared at wave end.
  powerupActive: false,
  powerupStep: 0,           // 0..5 — how many zones completed
  powerupStepMax: 5,
  powerupChargeTime: 0,     // accumulated time in current zone
  powerupChargeTarget: 3.5, // seconds to complete each zone
  powerupEmpFired: false,   // set when the 5th zone (EMP) triggers
  // Flipped true the moment the POWER zone is cleared (setPowerplantLit).
  // Flingers read this as their deploy gate in wave 2 / 7 / 12 / 17 / 22 / 27.
  powerplantLit: false,

  // Bonus wave (localWave 4 — "THE STAMPEDE" herd laser-tag)
  bonusWaveActive: false,
  bonusCaughtThisWave: 0,

  // Player identity
  username: 'GUEST',
  playerMeebitId: 16801,
  playerMeebitOwned: false,
  playerMeebitDelegated: false,
  playerMeebitSource: 'random',    // 'owned' | 'delegated' | 'random'
  playerMeebitGlbUrl: null,         // signed Larva Labs ownerDownloadGLB url, if any
  walletAddress: null,

  // Visual polish
  shakeAmt: 0,
  shakeTime: 0,
  muzzleTimer: 0,
  recoilTimer: 0,

  xpClearThreshold: 50,
  xpSinceWave: 0,

  // Pixl Pal summon ability — earns a charge every 3 waves (see pixlPals.js).
  pixlPalCharges: 0,

  // Flinger ally — arrives on waves 2/7/12/17/22/27, auto-deploys on
  // arrival, sticks around for ~30 kills. See flingers.js.
  flingerCharges: 0,

  // Super Nuke — Chapter 7 only. One granted per ch.7 wave boundary, plus
  // a bonus on the finale wave. Press N to cleanse all infectors in the
  // arena. See infector.js triggerSuperNuke().
  superNukeCharges: 0,

  // Reference to player.pos kept on S so flinger/infector modules can
  // spawn near the player without coupling to the player module directly.
  playerPos: null,

  // Time (in S.timeElapsed coordinates) when the current boss wave's boss
  // was spawned. Pixl pals use this to auto-deploy 10 seconds into a
  // boss fight. Reset to null when no boss fight is active.
  bossFightStartTime: null,
};

export const keys = {};
export const mouse = { worldX: 0, worldZ: 0, down: false };
export const joyState = { active: false, dx: 0, dy: 0, cx: 0, cy: 0 };

export function resetGame() {
  S.phase = 'playing';
  S.running = true;
  S.paused = false;
  S.score = 0;
  S.kills = 0;
  S.wave = 1;
  S.chapter = 0;
  S.localWave = 1;
  S.waveKillTarget = 10;
  S.waveKillsProgress = 0;
  S.waveActive = true;
  S.timeElapsed = 0;
  S.hp = PLAYER.hpMax;
  S.hpMax = PLAYER.hpMax;
  S.xp = 0;
  S.xpNext = 10;
  S.level = 1;
  S.playerSpeed = PLAYER.baseSpeed;
  S.currentWeapon = 'pistol';
  S.previousCombatWeapon = 'pistol';
  S.ownedWeapons = new Set(['pistol', 'pickaxe']);
  S.fireCooldown = 0;
  S.dashCooldown = 0;
  S.dashActive = 0;
  S.shields = 0;
  S.invulnTimer = 1.0;
  S.bossRef = null;
  S.objectiveZone = null;
  S.captureProgress = 0;
  S.captureTarget = 0;
  S.captureMissileLaunching = false;
  S.miningActive = false;
  S.blockFallTimer = 0;
  S.blocksSpawned = 0;
  S.blocksToSpawn = 0;
  S.blocksMined = 0;
  S.blocksRequired = 5;
  S.oresCarried = 0;
  S.oresRequired = 5;
  S.spawnerWaveActive = false;
  S.spawnersLive = 0;
  S.hiveWaveActive = false;
  S.hivesShielded = true;
  S.rescueMeebit = null;
  S.rescuedCount = 0;
  S.rescuedIds = [];
  S.powerupActive = false;
  S.powerupStep = 0;
  S.powerupStepMax = 5;
  S.powerupChargeTime = 0;
  S.powerupChargeTarget = 3.5;
  S.powerupEmpFired = false;
  S.powerplantLit = false;
  S.bonusWaveActive = false;
  S.bonusCaughtThisWave = 0;
  S.shakeAmt = 0;
  S.shakeTime = 0;
  S.muzzleTimer = 0;
  S.recoilTimer = 0;
  S.xpSinceWave = 0;
  S.pixlPalCharges = 0;
  S.flingerCharges = 0;
  S.superNukeCharges = 0;
  S.playerPos = null;
  S.bossFightStartTime = null;
}

export function getWeapon() {
  return WEAPONS[S.currentWeapon];
}

export function shake(amt, time) {
  S.shakeAmt = Math.max(S.shakeAmt, amt);
  S.shakeTime = Math.max(S.shakeTime, time);
}

export function updateChapterFromWave(wave) {
  S.wave = wave;
  S.chapter = Math.floor((wave - 1) / WAVES_PER_CHAPTER);
  S.localWave = ((wave - 1) % WAVES_PER_CHAPTER) + 1;
}
