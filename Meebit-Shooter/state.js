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

  // Hyperdrive prelude — true for 8 seconds after ATTACK THE AI click.
  // When true, updateWaves gates enemy + block spawns so the player
  // gets an empty arena for the ATTACK THE AI cinematic. main.js owns
  // the flag's lifecycle (sets true on click, clears false at t=8s).
  hyperdriveActive: false,

  // Tutorial mode — set true when the player picks START TUTORIAL on
  // the title screen instead of ATTACK THE AI. While true:
  //   - the floor is replaced with the rainbow numbered-tile texture
  //   - all enemies spawn black or white regardless of chapter tint
  //   - spawn rate is clamped to 1..2/sec for a chill practice pace
  //   - the player owns every weapon from the first frame
  // Cleared on game-over / restart so a normal run after a tutorial
  // doesn't inherit the practice settings.
  tutorialMode: false,

  // Chapter 7 (PARADISE FALLEN) intro spawn hold. Set to true when the
  // player enters chapter 7; cleared after a few seconds so the wave
  // can begin properly. While true, both the trickle path and the hive
  // path in waves.js skip enemy spawns (cooldowns drain harmlessly).
  // Also used by future cinematic moments that need a clean arena.
  cinematicSpawnHold: false,

  // Chapter 7 atmosphere — dark arena + player flashlight + scattered
  // corpses. Set to true at chapter-7 entry, cleared on game reset. UI
  // and scene lighting react to this flag's transitions.
  chapter7Atmosphere: false,

  // Lifedrainer weapon charge meter. Range 0..1. Filled by holding fire
  // while enemies are in the drain cone (charge accrues per-frame for
  // every enemy currently being drained). When >= 1 the gun is READY
  // — the next fire press triggers the swarm release and resets the
  // meter to 0.
  lifedrainCharge: 0,

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
  // Ch.7 finale one-shot: prevents re-triggering the VESSEL ZERO spawn
  // if the hive-clear event somehow fires twice in the same run.
  vesselZeroSpawned: false,

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

  // Grenade — universal utility throw, 3 charges restocked each wave.
  // Pressing G or controller-B throws forward. See tryThrowGrenade() in
  // main.js and the grenade entry in WEAPONS.
  grenadeCharges: 3,
  grenadeCooldown: 0,

  // Potions — pickup-driven healing inventory. Drop probabilistically
  // from killed enemies (see rollPotionDrop in pickups.js). On pickup:
  // if HP < hpMax, heals immediately; else banks into this slot up to
  // POTION_MAX (=3). Press H to consume one and heal POTION_HEAL HP.
  // NOT auto-restocked at wave start — a hoarded potion in slot 3
  // persists across waves and chapters.
  potions: 0,

  // Killstreak — chains kills that happen within KILLSTREAK_WINDOW
  // (1.0s) of each other. Each consecutive kill in the window
  // increments killstreak. After the window expires without a kill,
  // killstreak resets to 0. See bumpKillstreak() and tickKillstreak()
  // in main.js. Displayed on the HUD as xNNN.
  killstreak: 0,
  killstreakTimer: 0,         // seconds remaining before streak resets
  killstreakBest: 0,          // peak streak this run (for end-of-run stats)

  // ---- OVERDRIVE ----
  // Triggered when killstreak hits 100 (one-shot per streak). For 8
  // seconds: player scales 2.5x, can crush enemies by walking into
  // them, can damage hives the same way, is invulnerable to projectile
  // and contact damage. Bosses are immune to crush. See bumpKillstreak,
  // updateOverdrive, and the crush sweep in updateEnemies.
  overdriveActive: false,
  overdriveTimer: 0,                   // counts 8.0 → 0; 0 = inactive
  overdriveScale: 1,                   // 1..2.5 lerped scale, drives mesh + crush radius
  overdriveTriggeredThisStreak: false, // reset when killstreak hits 0 again

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
  S.vesselZeroSpawned = false;
  S.miningActive = false;
  S.blockFallTimer = 0;
  S.blocksSpawned = 0;
  S.blocksToSpawn = 0;
  S.blocksMined = 0;
  S.blocksRequired = 5;
  S.oresCarried = 0;
  S.oresRequired = 5;
  // Chapter 1 reflow state
  S.isEggWave = false;
  S.isEscortWave = false;       // chapter 2 wave 1
  // Chapter 2 wave 2 datacenter state (Turn 7 reflow — 6 phases)
  S.dcActive = false;
  S.dcPhase = 'warehouse-charging';   // 'warehouse-charging' | 'pod-descending' | 'pod-charging' | 'hive-lasers' | 'finale-laser' | 'done'
  S.dcChargeT = 0;              // warehouse charge progress (5s)
  S.dcPodChargeT = 0;           // pod charge progress (5s)
  S.dcPhaseT = 0;               // generic phase timer for pod-descending + hive-lasers
  S.dcOnslaughtT = 0;           // legacy — kept for any leftover refs
  S.dcSystemOnline = 0;
  S.dcLaserTriggered = false;
  S.dcShieldsDropped = false;
  S._dcPodDescentTriggered = false;
  S._dcPodOpenTriggered = false;
  S._dcHiveLasersSpawned = false;
  S.cannonLoadActive = false;
  S.cannonLoadStubT = 0;
  S.cannonLoadStubMax = 0;
  S.cannonLoadWaveT = 0;       // pandemonium ramp clock (14→30)
  S.cannonChargeT = 0;         // 5s charge progress at cannon (legacy single-zone)
  S.cannonChargeStarted = false;
  S.cannonInserted = false;    // gate for pandemonium ramp + barrage
  // Turn 6 reflow — 4-corner charging mechanic for chapter 1 wave 2.
  // Each shot fires from a separate charging zone at one of the cannon's
  // 4 corners. Player charges corner N → shot N fires → consumed → reload
  // → corner N+1 activates. Phase machine: 'approach' → 'corner-charging'
  // → 'reload' → ... → 'done'.
  S.cannonShotIdx = 0;          // 0..3 = current corner; 4 = all done
  S.cannonCornerChargeT = 0;    // 0..CORNER_CHARGE_DURATION
  S.cannonReloadT = 0;          // reload window countdown
  S.cannonPhase = 'approach';   // 'approach' | 'corner-charging' | 'reload' | 'done'
  S._cannonCornerTickT = 0;     // sfx tick timer
  S.flingerRequested = false;
  S.chargesCarried = 0;        // charges player picked up at depot
  S.chargesLoaded = 0;         // charges delivered to cannon
  S.queenCleanupActive = false;
  S._lastEggDeposited = 0;     // tracks deposit-count transitions for crusher slam triggers
  S._chargeCubesSpawned = false;
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
  S.grenadeCharges = 3;
  S.grenadeCooldown = 0;
  S.potions = 0;
  S.killstreak = 0;
  S.killstreakTimer = 0;
  S.killstreakBest = 0;
  // Overdrive state — clear so a previous-run leftover doesn't make
  // the new run start mid-overdrive.
  S.overdriveActive = false;
  S.overdriveTimer = 0;
  S.overdriveScale = 1;
  S.overdriveTriggeredThisStreak = false;
  // Chapter 7 (PARADISE FALLEN) state — must be cleared on every new
  // run. If a previous run reached chapter 7 and then died, these
  // flags would persist and poison the next run (e.g. cinematicSpawnHold
  // stuck true → no enemies spawn at all in chapter 0 wave 1).
  S.cinematicSpawnHold = false;
  S.chapter7Atmosphere = false;
  S.siloLaunchT = 0;
  S.siloLaunchPhase = null;
  S.siloLaunchIgnited = false;
  S._preCh7Weapon = null;
  S.lifedrainCharge = 0;
  S.playerPos = null;
  S.bossFightStartTime = null;
  // Tutorial mode is reset by default. startTutorial() in main.js
  // re-sets it to true after resetGame() runs.
  S.tutorialMode = false;
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
