// endlessGlyphs.js — ENDLESS GLYPHS game mode
//
// A 30-wave survival mode unlocked after the player completes ATTACK
// THE AI (chapters 1-6). Per playtester redesign:
//
//   • Solo or hot-seat 2-3 player UI (only solo plays for now)
//   • Spawns the player into a tutorial-tile lobby grid
//   • Central locker — pick a weapon → 1-minute prep timer
//   • Tutorial tiles fade out, normal arena tiles fade in
//   • Wave 1 begins
//   • Every 5 waves: intermission, tiles fade back to lobby, lockers
//     reappear, weapon swap allowed, 1-minute timer, then next 5 waves
//   • Chapter→wave mapping:
//       waves  1-5  → ch1 enemies
//       waves  6-10 → ch2 enemies
//       waves 11-15 → ch3 enemies
//       waves 16-20 → ch4 enemies
//       waves 21-25 → ch5 enemies
//       waves 26-30 → ch6 enemies
//   • HP scaling: ×1.05 per wave (geometric)
//   • Wave 5 introduces the JUMPER boss (built in enemies.js); more
//     jumpers spawn as the run progresses
//   • Players bound to ONE weapon per 5-wave block (no mid-block
//     switching)
//   • Heals + grenades scattered as ground pickups (not at locker)
//   • Wave 30 = victory; cap, no waves 31+
//
// Phase 3a (this file's first stage): module skeleton, public API,
// run-state machine bones, lobby setup with rainbow tile floor,
// 1-minute prep timer, locker mesh placeholder. The wave runner
// (Phase 3b) and locker UI + pickups (Phase 3c) build on this.

import * as THREE from 'three';
import { scene, Scene } from './scene.js';
import { S, resetGame } from './state.js';
import { Audio } from './audio.js';
import { applyTutorialFloor, restoreNormalFloor, setTutorialActive } from './tutorial.js';
import { hitBurst } from './effects.js';
import { enemies, makeEnemy, clearAllEnemies } from './enemies.js';
import { player } from './player.js';
import { WEAPONS, CHAPTERS } from './config.js';
import { generateWallsForWave, clearWalls } from './endlessWalls.js';

// =====================================================================
// PUBLIC API
// =====================================================================

/**
 * Begin an Endless Glyphs run. Called by the title-screen player-count
 * picker modal in main.js (window.__startEndlessGlyphs is the bridge).
 *
 * @param {number} playerCount  1 (only supported value at this stage).
 *                              2/3 are reserved for future co-op.
 */
export function startEndlessGlyphs(playerCount = 1) {
  // Hot-seat / matchmaking room UI defaulted player to solo. Co-op
  // is future work — defensive guard here in case a downstream caller
  // passes 2 or 3 anyway, since the run won't actually be co-op.
  S.endlessPlayerCount = Math.max(1, Math.min(3, playerCount | 0));
  S.endlessGlyphs = true;
  S.endlessWave = 0;                    // wave 0 = lobby/prep, no enemies
  S.endlessPhase = 'LOBBY_PREP';        // see PHASES below
  S.endlessPhaseT = 0;                  // seconds into current phase
  S.endlessKills = 0;                   // total kills this run
  S.endlessVictory = false;

  // Clear any other run mode that might still be active (defensive —
  // main.js's mode-entry guards should already handle this, but the
  // second line of defense is cheap). Without this, switching from
  // tutorial → endless can leak the tutorial-tile floor + lesson
  // controller state.
  if (S.tutorialMode) {
    S.tutorialMode = false;
    setTutorialActive(false);
  }

  Audio.stopPhoneRing && Audio.stopPhoneRing();
  Audio.stopCDrone && Audio.stopCDrone();
  Audio.stopDeathMusic && Audio.stopDeathMusic();
  Audio.setMusicSection && Audio.setMusicSection('main');

  // Hide the title screen.
  const titleEl = document.getElementById('title');
  if (titleEl) titleEl.classList.add('hidden');
  // Show the game HUD.
  document.querySelectorAll('.hidden-ui').forEach(el => el.style.display = '');
  // Endless Glyphs hides the chapter/wave/kills HUD top bar (those
  // numbers don't apply here; we'll show our own wave indicator).
  // Future: replace with a custom #endless-hud overlay (Phase 3b).
  const _hudTop = document.getElementById('hud-top');
  if (_hudTop) _hudTop.style.display = 'none';

  resetGame();

  // resetGame() clears S.endlessGlyphs — re-seed our flags AFTER reset.
  // (Same trick startTutorial uses for S.tutorialMode.)
  S.endlessGlyphs = true;
  S.endlessPlayerCount = Math.max(1, Math.min(3, playerCount | 0));
  S.endlessWave = 0;
  S.endlessPhase = 'LOBBY_PREP';
  S.endlessPhaseT = 0;
  S.endlessKills = 0;
  S.endlessVictory = false;

  // Wipe everything that could leak in from a prior run or from
  // chapter-prop spawning that resetGame doesn't touch. Per
  // playtester: "for endless glyphs we need to clear all enemies fog
  // waveprops / hives shields etc. It needs to look like the tutorial
  // but with no obstacles."
  // The helper is a NEW function in main.js exposed via
  // window.__setupEndlessCleanArena — wraps a sweep of every clear*
  // / dispose* / disable* call in try/catch. Doesn't touch tutorial
  // or main-game setup paths.
  if (typeof window.__setupEndlessCleanArena === 'function') {
    try { window.__setupEndlessCleanArena(); }
    catch (e) { console.warn('[glyphs] clean arena', e); }
  }

  // Apply rainbow tile floor — the lobby visually matches the tutorial.
  // Per playtester: "The same rainbow tile grid that the tutorial uses."
  // setTutorialActive flips a flag that other systems (under-foot glow,
  // enemy color override) read; we WANT the rainbow color sampling but
  // NOT the enemy monochrome forcing. The wave runner in Phase 3b will
  // handle the override conflict. For the lobby phase (no enemies)
  // this is fine.
  applyTutorialFloor();
  setTutorialActive(true);

  // Build the locker mesh at the arena center — the player walks up
  // to interact with it. Phase 3c will add the proximity-trigger UI.
  _spawnLocker();
}

/**
 * Per-frame tick. Called from main.js animate loop when
 * S.endlessGlyphs is true. Drives the phase state machine + the
 * locker proximity highlight.
 *
 * @param {number} dt  delta time in seconds
 */
export function updateEndlessGlyphs(dt) {
  if (!S.endlessGlyphs) return;
  S.endlessPhaseT += dt;

  switch (S.endlessPhase) {
    case 'LOBBY_PREP':
      _tickLobbyPrep(dt);
      break;
    case 'TILES_TRANSITION':
      _tickTilesTransition(dt);
      break;
    case 'WAVE':
      _tickWave(dt);
      break;
    case 'INTERMISSION':
      _tickIntermission(dt);
      break;
    case 'VICTORY':
      _tickVictory(dt);
      break;
  }

  _tickLockerVisuals(dt);
}

/**
 * Cleanup when leaving Endless Glyphs (run ended, player quit, victory
 * dismissed). Restores the normal arena floor + clears mode flags.
 * Safe to call when not in the mode (no-op).
 */
export function exitEndlessGlyphs() {
  if (!S.endlessGlyphs) return;
  S.endlessGlyphs = false;
  S.endlessPhase = null;
  S.endlessWave = 0;
  S.endlessKills = 0;
  S.endlessVictory = false;

  restoreNormalFloor();
  _restoreWaveFloor();             // also restore in case wave was active
  setTutorialActive(false);
  clearWalls();
  _disposeLocker();
  _disposeWaveHUD();
  clearAllEnemies();

  // Restore fog / shadows / lighting so the next mode the player
  // picks doesn't inherit the lobby's flat no-fog look. Helper
  // exposed by main.js — see _teardownEndlessCleanArena.
  if (typeof window.__teardownEndlessCleanArena === 'function') {
    try { window.__teardownEndlessCleanArena(); }
    catch (e) { console.warn('[glyphs] teardown', e); }
  }
}

// =====================================================================
// PHASE TICKS
// =====================================================================

const LOBBY_PREP_DURATION = 60;        // seconds — per playtester spec

/**
 * LOBBY_PREP — player is in the rainbow-tile lobby. Locker is up,
 * player walks to it, picks a weapon (Phase 3c). Counts down 60s.
 * On expiry: tile transition begins.
 */
function _tickLobbyPrep(dt) {
  // HUD timer — countdown to wave 1.
  const remaining = Math.max(0, LOBBY_PREP_DURATION - S.endlessPhaseT);
  _setWaveHUD('WAVE 1 BEGINS IN', _fmtTimer(remaining));
  if (S.endlessPhaseT >= LOBBY_PREP_DURATION) {
    _enterTilesTransition();
  }
}

/**
 * TILES_TRANSITION — 1.5-second crossfade where the rainbow tutorial
 * tiles fade out and the normal arena tiles fade in. The locker
 * disappears (sinks into ground), the wave spawn loop begins
 * underneath the fading visuals so enemies start trickling in just
 * as the arena reveals.
 */
const TILES_TRANSITION_DURATION = 1.5;
function _enterTilesTransition() {
  S.endlessPhase = 'TILES_TRANSITION';
  S.endlessPhaseT = 0;
  // Floor swap is instant for now — a future polish pass can animate
  // the alpha crossfade between the rainbow texture + the regular grid.
  restoreNormalFloor();
  setTutorialActive(false);
  _disposeLocker();
  // Swap the arena floor to plain white during waves. Per playtester:
  // "When the rainbow tile fades and the grid arrives for wave 1 we
  // should make it white. The walls will really stand out as black
  // objects and the enemies will be in full color."
  _applyWaveWhiteFloor();
  // Pre-warm the wave so the spawn loop has its config ready when
  // _enterWave fires after the transition completes.
  _prepareWave(S.endlessWave + 1);
  // Generate the wave's procedural floorplan obstacles. Walls are
  // built immediately so they're visible during the GET READY beat —
  // gives the player a fraction of a second to scan the layout
  // before enemies start spawning.
  generateWallsForWave(_pendingWaveNum);
}
function _tickTilesTransition(dt) {
  _setWaveHUD('GET READY', '');
  if (S.endlessPhaseT >= TILES_TRANSITION_DURATION) {
    _enterWave(_pendingWaveNum);
  }
}

// =====================================================================
// WAVE RUNNER
// =====================================================================
// Per playtester: "we need to spawn enemies for wave 1." For Phase 3b
// I'm shipping a straightforward wave spawn loop. Per the design:
//
//   • Waves 1-5 use chapter 1 enemies (zomeeb / sprinter — visually
//     rendered as procedural box ants because S.chapter === 0)
//   • HP scales ×1.05 per wave (geometric)
//   • Spawns drip in from the arena edge at intervals
//   • Wave ends when all queued enemies are spawned AND killed
//
// Wave→chapter mapping for waves 6-30 is future work — for now only
// wave 1 actually runs, and after wave 1 we advance to the next
// (which will spawn the same wave-1 config again, scaled). Real
// chapter mapping comes in the next pass.
//
// Per-wave config:
//   _waveSpawnQueue   — number of enemies still to spawn
//   _waveSpawnTimer   — countdown to next spawn
//   _waveSpawnGap     — seconds between spawns (computed per wave)
//   _waveTotalCount   — how many total this wave (for HUD display)
//   _waveSpawnedSoFar — how many actually spawned (for HUD)
//   _pendingWaveNum   — wave number to enter on transition complete

let _waveSpawnQueue = 0;
let _waveSpawnTimer = 0;
let _waveSpawnGap = 2.5;
let _waveTotalCount = 0;
let _waveSpawnedSoFar = 0;
let _pendingWaveNum = 1;

/**
 * Compute the spawn config for a wave. Called by tile-transition
 * preparation so the wave is fully configured before the WAVE phase
 * begins.
 */
function _prepareWave(waveNum) {
  _pendingWaveNum = waveNum;
  // Wave 1 = 18 enemies, +2 per subsequent wave (rough escalation).
  // Caps at 60 by wave 22+ so the screen doesn't completely fill.
  const count = Math.min(60, 18 + (waveNum - 1) * 2);
  _waveTotalCount = count;
  _waveSpawnQueue = count;
  _waveSpawnedSoFar = 0;
  // Spawn cadence — early waves are slow drip, later waves stack
  // pressure. ~2.5s/spawn at wave 1, down to 0.6s by wave 30.
  const cadence = Math.max(0.6, 2.5 - (waveNum - 1) * 0.07);
  _waveSpawnGap = cadence;
  _waveSpawnTimer = 0.5;          // first spawn after a short delay
}

function _enterWave(waveNum) {
  S.endlessPhase = 'WAVE';
  S.endlessPhaseT = 0;
  S.endlessWave = waveNum;
  // _prepareWave was already called by the tile-transition; if some
  // path skipped it, prepare now defensively.
  if (_pendingWaveNum !== waveNum) _prepareWave(waveNum);
}

function _tickWave(dt) {
  // Spawn loop — drip-feed enemies from the arena edge until the
  // queue is empty.
  if (_waveSpawnQueue > 0) {
    _waveSpawnTimer -= dt;
    if (_waveSpawnTimer <= 0) {
      _spawnWaveEnemy();
      _waveSpawnQueue--;
      _waveSpawnedSoFar++;
      _waveSpawnTimer = _waveSpawnGap;
    }
  }

  // HUD: show remaining alive count when spawning is done, otherwise
  // show "spawned/total" + alive count.
  const aliveCount = enemies.length;
  _setWaveHUD(
    'WAVE ' + S.endlessWave,
    _waveSpawnQueue > 0
      ? aliveCount + ' ALIVE · ' + _waveSpawnQueue + ' INCOMING'
      : aliveCount + ' LEFT',
  );

  // Wave-end check: all spawned + nothing alive → next phase.
  if (_waveSpawnQueue === 0 && aliveCount === 0) {
    if (S.endlessWave >= 30) {
      _enterVictory();
    } else if (S.endlessWave % 5 === 0) {
      _enterIntermission();
    } else {
      // Roll directly into the next wave WITHOUT a tile transition
      // (transitions are reserved for the 5-wave intermission boundary).
      // Brief 2-second breather before the next spawn cycle.
      S.endlessPhase = 'WAVE';
      S.endlessPhaseT = 0;
      S.endlessWave += 1;
      _prepareWave(S.endlessWave);
    }
  }
}

/**
 * Spawn a single wave enemy at the arena edge. Spawn position is on
 * a circle around the player at distance ~16-22 units (just outside
 * normal sight) with a random angle. enemy type is rotated through
 * the chapter-1 pool (zomeeb / sprinter) — both render as box ants
 * because S.chapter === 0 triggers the mesh substitution.
 */
function _spawnWaveEnemy() {
  if (!player || !player.pos) return;
  const angle = Math.random() * Math.PI * 2;
  const dist = 16 + Math.random() * 6;
  // Clamp inside arena — arena half-extent is 50, leave a 2u buffer.
  const ARENA = 50;
  const px = player.pos.x;
  const pz = player.pos.z;
  const x = Math.max(-(ARENA - 2), Math.min(ARENA - 2, px + Math.cos(angle) * dist));
  const z = Math.max(-(ARENA - 2), Math.min(ARENA - 2, pz + Math.sin(angle) * dist));
  // Type roll — 70% zomeeb, 30% sprinter so the player sees both
  // movement profiles (steady walker vs faster rusher).
  const type = Math.random() < 0.7 ? 'zomeeb' : 'sprinter';
  // Chapter 1 tint (orange) — uniform across the run for visual
  // consistency. enemies.js's _useAntForChapter1 check on
  // (S.chapter === 0 && (zomeeb|sprinter)) substitutes the box-ant
  // mesh; resetGame at run-start guarantees S.chapter === 0.
  const tint = CHAPTERS[0].full.enemyTint;
  // HP scaling: ×1.05^(wave-1). Wave 1 = baseline (×1.0), wave 30 ≈
  // ×4.1. The hpMul kwarg is passed via the optional 4th arg to
  // makeEnemy; current factory signature is makeEnemy(typeKey, tint,
  // pos) — the `hpMul` is applied internally after consulting the
  // ENEMY_TYPES base. We emulate it by scaling the spawned enemy's
  // hp/hpMax inline.
  const e = makeEnemy(type, tint, new THREE.Vector3(x, 0, z));
  if (e) {
    const hpMul = Math.pow(1.05, S.endlessWave - 1);
    e.hp = Math.round(e.hp * hpMul);
    e.hpMax = Math.round(e.hpMax * hpMul);
    // Spawn-in flourish so the enemy doesn't just pop into existence.
    hitBurst(new THREE.Vector3(x, 1.4, z), tint, 6);
  }
}

/**
 * INTERMISSION — every 5 waves, fade arena tiles back to rainbow,
 * respawn the locker, give the player 60s to choose a new weapon /
 * pick up scattered heals + grenades. The actual heal/grenade
 * pickups are scattered DURING the wave (Phase 3c) so the player
 * has time to grab them; intermission is the choose-weapon window.
 */
function _enterIntermission() {
  S.endlessPhase = 'INTERMISSION';
  S.endlessPhaseT = 0;
  // Walls disappear instantly for Ship 1 — the autoglyph dissolve
  // animation comes in Ship 3.
  clearWalls();
  // Restore rainbow lobby tiles + lobby ambient lighting.
  _restoreWaveFloor();
  applyTutorialFloor();
  setTutorialActive(true);
  _spawnLocker();
  clearAllEnemies();
}
function _tickIntermission(dt) {
  const remaining = Math.max(0, LOBBY_PREP_DURATION - S.endlessPhaseT);
  _setWaveHUD('WAVE ' + (S.endlessWave + 1) + ' BEGINS IN', _fmtTimer(remaining));
  if (S.endlessPhaseT >= LOBBY_PREP_DURATION) {
    _enterTilesTransition();
  }
}

function _enterVictory() {
  S.endlessPhase = 'VICTORY';
  S.endlessPhaseT = 0;
  S.endlessVictory = true;
}
function _tickVictory(dt) {
  _setWaveHUD('VICTORY', '30 WAVES SURVIVED');
}

// =====================================================================
// WAVE HUD
// =====================================================================
// Top-center fixed banner showing current phase status. Two lines:
//   - title  (e.g. "WAVE 1 BEGINS IN" / "WAVE 1" / "GET READY")
//   - detail (e.g. "0:42" timer, "12 LEFT", "8 ALIVE · 4 INCOMING")
// Lazy-built on first call. Disposed by exitEndlessGlyphs / locker
// teardown so the HUD doesn't linger after the player quits.

let _waveHudEl = null;
let _waveHudTitleEl = null;
let _waveHudDetailEl = null;

function _ensureWaveHUD() {
  if (_waveHudEl) return;
  const root = document.createElement('div');
  root.id = 'glyphs-wave-hud';
  root.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:18px',
    'transform:translateX(-50%)',
    'min-width:240px',
    'padding:10px 18px 12px 18px',
    'background:rgba(8, 14, 22, 0.85)',
    'border:1.5px solid #66ccff',
    'border-radius:6px',
    'box-shadow:0 0 16px rgba(102, 204, 255, 0.35)',
    'color:#cfeaff',
    'font-family:monospace',
    'letter-spacing:2px',
    'text-align:center',
    'z-index:8400',
    'pointer-events:none',
    'user-select:none',
  ].join(';');

  const title = document.createElement('div');
  title.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:3px;color:#66ccff;text-shadow:0 0 6px rgba(102,204,255,0.7);margin-bottom:3px;';
  root.appendChild(title);

  const detail = document.createElement('div');
  detail.style.cssText = 'font-size:18px;font-weight:700;letter-spacing:2px;color:#ffffff;text-shadow:0 0 8px rgba(255,255,255,0.5);';
  root.appendChild(detail);

  document.body.appendChild(root);
  _waveHudEl = root;
  _waveHudTitleEl = title;
  _waveHudDetailEl = detail;
}

function _setWaveHUD(title, detail) {
  _ensureWaveHUD();
  if (_waveHudTitleEl && _waveHudTitleEl.textContent !== title) {
    _waveHudTitleEl.textContent = title;
  }
  if (_waveHudDetailEl && _waveHudDetailEl.textContent !== detail) {
    _waveHudDetailEl.textContent = detail;
  }
}

function _disposeWaveHUD() {
  if (_waveHudEl && _waveHudEl.parentNode) {
    _waveHudEl.parentNode.removeChild(_waveHudEl);
  }
  _waveHudEl = null;
  _waveHudTitleEl = null;
  _waveHudDetailEl = null;
}

/**
 * Format a seconds value as M:SS for the HUD countdown. Caps at 59:59
 * (we never get anywhere near that — max LOBBY_PREP_DURATION is 60s,
 * but defensive).
 */
function _fmtTimer(sec) {
  const total = Math.max(0, Math.ceil(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// =====================================================================
// WAVE FLOOR — white during combat
// =====================================================================
// Per playtester: "When the rainbow tile fades and the grid arrives
// for wave 1 we should make it white. The walls will really stand
// out as black objects and the enemies will be in full color."
//
// Mirrors the tutorial.js pattern: snapshot the ground material's
// current color/emissive/map state, swap in pure white, and restore
// on demand. Idempotent — multiple apply calls are safe; restore is a
// no-op if no snapshot was taken.

let _waveFloorSnapshot = null;

function _applyWaveWhiteFloor() {
  if (!Scene || !Scene.groundMat) return;
  if (_waveFloorSnapshot) return;        // already applied
  _waveFloorSnapshot = {
    color: Scene.groundMat.color.getHex(),
    emissive: Scene.groundMat.emissive ? Scene.groundMat.emissive.getHex() : 0x000000,
    emissiveIntensity: Scene.groundMat.emissiveIntensity || 0,
    emissiveMap: Scene.groundMat.emissiveMap || null,
    map: Scene.groundMat.map || null,
    roughness: Scene.groundMat.roughness,
    metalness: Scene.groundMat.metalness,
  };
  // Pure white floor — kill the chapter texture so we get a flat sheet.
  Scene.groundMat.map = null;
  Scene.groundMat.color.setHex(0xffffff);
  Scene.groundMat.emissive = new THREE.Color(0xeeeeee);
  Scene.groundMat.emissiveMap = null;
  // Self-illumination ~1.0 so the floor reads as bright white regardless
  // of ambient lighting (mirrors the tutorial-floor trick — the floor
  // is its own light source).
  Scene.groundMat.emissiveIntensity = 0.95;
  Scene.groundMat.roughness = 1.0;
  Scene.groundMat.metalness = 0.0;
  Scene.groundMat.needsUpdate = true;
}

function _restoreWaveFloor() {
  if (!_waveFloorSnapshot) return;
  if (!Scene || !Scene.groundMat) {
    _waveFloorSnapshot = null;
    return;
  }
  Scene.groundMat.color.setHex(_waveFloorSnapshot.color);
  if (Scene.groundMat.emissive) {
    Scene.groundMat.emissive.setHex(_waveFloorSnapshot.emissive);
  }
  Scene.groundMat.emissiveIntensity = _waveFloorSnapshot.emissiveIntensity;
  Scene.groundMat.emissiveMap = _waveFloorSnapshot.emissiveMap;
  Scene.groundMat.map = _waveFloorSnapshot.map;
  Scene.groundMat.roughness = _waveFloorSnapshot.roughness;
  Scene.groundMat.metalness = _waveFloorSnapshot.metalness;
  Scene.groundMat.needsUpdate = true;
  _waveFloorSnapshot = null;
}

// =====================================================================
// LOCKER MESH
// =====================================================================
// Central placeholder mesh — a tall white rectangle on a small
// platform, with a chapter-tinted glow strip. Player walks up to
// interact (Phase 3c adds the UI). Disposed when the wave starts;
// rebuilt at intermission.

let _lockerMesh = null;          // root group
let _lockerGlowMat = null;       // emissive strip material (animated)
let _lockerPulseT = 0;

function _spawnLocker() {
  if (_lockerMesh) return;       // idempotent — already spawned
  const root = new THREE.Group();
  root.position.set(0, 0, 0);

  // Platform base — short cylinder.
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a22, roughness: 0.65, metalness: 0.45,
  });
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 2.0, 0.3, 16),
    baseMat,
  );
  base.position.y = 0.15;
  root.add(base);

  // Locker body — tall rounded rectangle (use box for now; rounded
  // edges via slight scale on the face).
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2a3540, roughness: 0.55, metalness: 0.7,
  });
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 2.6, 0.7),
    bodyMat,
  );
  body.position.y = 1.6;
  root.add(body);

  // Trim accents on the front face — two horizontal lines.
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x4a5560, roughness: 0.45, metalness: 0.85,
  });
  for (const yOff of [-0.6, 0.6]) {
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(1.42, 0.05, 0.04),
      trimMat,
    );
    trim.position.set(0, 1.6 + yOff, 0.36);
    root.add(trim);
  }

  // Center glow strip — vertical emissive bar that pulses to draw
  // the player's eye toward the interact point. Chapter-tinted in
  // Phase 3c; for skeleton we use blueprint blue.
  _lockerGlowMat = new THREE.MeshBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(0.20, 1.4, 0.05),
    _lockerGlowMat,
  );
  glow.position.set(0, 1.6, 0.37);
  root.add(glow);

  // Ground beacon ring under the locker — telegraphs the interact
  // zone radius. Circle on the floor.
  const ringGeom = new THREE.RingGeometry(1.8, 2.0, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  root.add(ring);

  scene.add(root);
  _lockerMesh = root;
  _lockerPulseT = 0;

  // Spawn-in burst.
  hitBurst(new THREE.Vector3(0, 0.5, 0), 0x66ccff, 18);
  hitBurst(new THREE.Vector3(0, 1.6, 0), 0xffffff, 8);
}

// =====================================================================
// LOCKER PROXIMITY UI
// =====================================================================
// Per playtester: "When I go to endless glyphs I have no way to act on
// the locker. I think this should just open when in radius." The
// player walks up to the locker; an HTML panel auto-opens at the
// edge of the screen with one tile per armory-unlocked weapon. Click
// a tile → equip that weapon (S.currentWeapon swap + gun recolor +
// toast + audio cue), panel closes. Walking out of radius also
// hides the panel without picking anything.
//
// Movement is NOT blocked while the panel is open — the player can
// keep walking. The panel auto-hides when distance exceeds the
// radius again.

const LOCKER_INTERACT_RADIUS = 4.0;     // world units — comfortable but not generous
const LOCKER_INTERACT_HYSTERESIS = 0.5; // world units — close-only when noticeably outside

let _lockerPanelEl = null;              // <div> root of the picker panel
let _lockerPanelOpen = false;           // current visibility state
let _lockerPanelLastWeaponId = null;    // last-equipped — highlighted in UI

/**
 * Lazily build the locker HTML panel. Idempotent — first call creates
 * the element + listeners, subsequent calls re-render the tile grid
 * (in case the player's armory unlocks have changed since last open).
 */
function _ensureLockerPanel() {
  if (_lockerPanelEl) {
    _refreshLockerPanelTiles();
    return;
  }
  // Read armory unlocks. window.__armory is seeded by main.js's
  // applyArmoryToRunStart. If endless glyphs launched without a
  // proper armory record (corrupted save, dev cheat path), fall
  // back to pistol-only.
  const root = document.createElement('div');
  root.id = 'glyphs-locker-panel';
  // Inline styles so we don't have to add to styles.css. Pinned
  // bottom-center, dark blueprint-blue card with a header + tile
  // grid + hint text. Pointer-events on so click works; the rest
  // of the screen still gets player input.
  root.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:80px',
    'transform:translateX(-50%)',
    'min-width:380px',
    'max-width:680px',
    'padding:16px 20px 18px 20px',
    'background:rgba(8, 14, 22, 0.94)',
    'border:2px solid #66ccff',
    'border-radius:8px',
    'box-shadow:0 0 24px rgba(102, 204, 255, 0.45), inset 0 0 12px rgba(102, 204, 255, 0.18)',
    'color:#cfeaff',
    'font-family:monospace',
    'letter-spacing:1px',
    'z-index:8500',
    'pointer-events:auto',
    'user-select:none',
  ].join(';');

  const header = document.createElement('div');
  header.textContent = 'WEAPON LOCKER';
  header.style.cssText = [
    'font-size:13px',
    'font-weight:700',
    'letter-spacing:3px',
    'color:#66ccff',
    'text-align:center',
    'margin-bottom:10px',
    'text-shadow:0 0 8px rgba(102,204,255,0.7)',
  ].join(';');
  root.appendChild(header);

  const grid = document.createElement('div');
  grid.id = 'glyphs-locker-grid';
  grid.style.cssText = [
    'display:flex',
    'flex-wrap:wrap',
    'justify-content:center',
    'gap:8px',
  ].join(';');
  root.appendChild(grid);

  const hint = document.createElement('div');
  hint.textContent = 'CLICK A WEAPON TO EQUIP · WALK AWAY TO CLOSE';
  hint.style.cssText = [
    'font-size:9px',
    'letter-spacing:2px',
    'color:#5a7080',
    'text-align:center',
    'margin-top:10px',
  ].join(';');
  root.appendChild(hint);

  document.body.appendChild(root);
  _lockerPanelEl = root;
  _refreshLockerPanelTiles();
}

/**
 * Build the weapon-tile grid based on the player's current armory
 * unlocks. Called whenever the panel opens — the player COULD
 * theoretically gain unlocks mid-run (future drop / reward feature)
 * so we re-read every time instead of caching.
 */
function _refreshLockerPanelTiles() {
  if (!_lockerPanelEl) return;
  const grid = _lockerPanelEl.querySelector('#glyphs-locker-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const unlocked = (window.__armory && window.__armory.unlocked) || { pistol: true };

  // Show every weapon the player has unlocked, in catalog order. The
  // catalog order matches the display order in the armory screen so
  // the player can find what they expect at a glance.
  // Pistol is always present (defaultArmory guarantees it).
  const order = ['pistol', 'shotgun', 'smg', 'rocket', 'raygun', 'flamethrower'];
  for (const id of order) {
    if (!unlocked[id]) continue;
    if (!WEAPONS[id]) continue;
    const meta = WEAPONS[id];
    const tile = document.createElement('button');
    tile.dataset.weaponId = id;
    tile.style.cssText = [
      'flex:0 0 auto',
      'min-width:96px',
      'padding:12px 14px',
      'background:rgba(20, 32, 48, 0.85)',
      'border:1.5px solid #2a4055',
      'border-radius:6px',
      'color:#cfeaff',
      'font-family:monospace',
      'font-size:11px',
      'font-weight:700',
      'letter-spacing:2px',
      'cursor:pointer',
      'transition:transform 0.08s ease, border-color 0.08s ease, box-shadow 0.08s ease',
      'text-align:center',
    ].join(';');
    // Highlight the currently-equipped weapon so the player can see
    // their current selection. S.currentWeapon may be 'pickaxe'
    // mid-run; in that case nothing's highlighted.
    const isCurrent = (S.currentWeapon === id);
    if (isCurrent) {
      tile.style.borderColor = '#66ccff';
      tile.style.boxShadow = '0 0 12px rgba(102,204,255,0.55)';
    }
    const colorHex = '#' + meta.color.toString(16).padStart(6, '0');
    tile.innerHTML =
      '<div style="font-size:13px; color:' + colorHex + '; text-shadow:0 0 6px ' + colorHex + 'aa; margin-bottom:4px;">' +
        meta.name +
      '</div>' +
      '<div style="font-size:9px; color:#5a7080; letter-spacing:1px;">' +
        (isCurrent ? 'EQUIPPED' : 'EQUIP') +
      '</div>';
    // Hover effect — slight lift.
    tile.addEventListener('mouseenter', () => {
      if (!isCurrent) {
        tile.style.borderColor = '#4a7090';
        tile.style.transform = 'translateY(-2px)';
      }
    });
    tile.addEventListener('mouseleave', () => {
      if (!isCurrent) {
        tile.style.borderColor = '#2a4055';
        tile.style.transform = '';
      }
    });
    // Click → equip. Bridge is window.__equipWeapon set in main.js.
    tile.addEventListener('click', () => {
      if (typeof window.__equipWeapon === 'function') {
        const ok = window.__equipWeapon(id);
        if (ok) {
          _lockerPanelLastWeaponId = id;
          _refreshLockerPanelTiles();    // re-render so EQUIPPED highlight moves
        }
      }
    });
    grid.appendChild(tile);
  }
}

function _showLockerPanel() {
  if (_lockerPanelOpen) return;
  _ensureLockerPanel();
  if (_lockerPanelEl) _lockerPanelEl.style.display = 'block';
  _lockerPanelOpen = true;
}

function _hideLockerPanel() {
  if (!_lockerPanelOpen) return;
  if (_lockerPanelEl) _lockerPanelEl.style.display = 'none';
  _lockerPanelOpen = false;
}

function _disposeLockerPanel() {
  if (_lockerPanelEl && _lockerPanelEl.parentNode) {
    _lockerPanelEl.parentNode.removeChild(_lockerPanelEl);
  }
  _lockerPanelEl = null;
  _lockerPanelOpen = false;
}

function _tickLockerVisuals(dt) {
  if (!_lockerMesh || !_lockerGlowMat) return;
  _lockerPulseT += dt;
  // Slow vertical glow pulse — opacity oscillates 0.55 → 0.95.
  _lockerGlowMat.opacity = 0.55 + Math.sin(_lockerPulseT * 2.0) * 0.20;

  // ---- PROXIMITY UI ----
  // Show the picker panel when the player is within
  // LOCKER_INTERACT_RADIUS of the locker (centered at world 0,0,0).
  // Hysteresis prevents flicker when the player walks the boundary —
  // open at radius, close at radius + 0.5u.
  if (!player || !player.pos) return;
  const dx = player.pos.x;
  const dz = player.pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (!_lockerPanelOpen && dist <= LOCKER_INTERACT_RADIUS) {
    _showLockerPanel();
  } else if (_lockerPanelOpen && dist > LOCKER_INTERACT_RADIUS + LOCKER_INTERACT_HYSTERESIS) {
    _hideLockerPanel();
  }
}

function _disposeLocker() {
  if (!_lockerMesh) return;
  // Dispose all children.
  _lockerMesh.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        for (const m of obj.material) m.dispose();
      } else {
        obj.material.dispose();
      }
    }
  });
  if (_lockerMesh.parent) _lockerMesh.parent.remove(_lockerMesh);
  _lockerMesh = null;
  _lockerGlowMat = null;
  // Hide + dispose the proximity UI panel too.
  _disposeLockerPanel();
}
