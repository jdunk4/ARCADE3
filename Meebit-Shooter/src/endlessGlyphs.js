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
import { scene, Scene, enterChapter7Atmosphere, exitChapter7Atmosphere, updateFlashlight } from './scene.js';
import { S, resetGame } from './state.js';
import { Audio } from './audio.js';
import { applyTutorialFloor, restoreNormalFloor, setTutorialActive, boostTutorialLighting, restoreTutorialLighting } from './tutorial.js';
import { hitBurst } from './effects.js';
import { clearAllEnemies } from './enemies.js';
import { player } from './player.js';
import { WEAPONS, CHAPTERS } from './config.js';
import { startDissolve, tickDissolve, cancelDissolve } from './endlessDissolve.js';
import { startAssemble, tickAssemble, cancelAssemble } from './endlessAssemble.js';
import { grantArtifact } from './stratagems.js';
import { generateMaze, cellToWorld, worldToCell } from './mazeGenerator.js';
import {
  buildMaze, clearMaze, updateMazeFx,
  markCellVisited, getCoverage, isKillZoneCell, isCellBlocked,
  getMazeWallEntries, isBlockedByWall as mazeIsBlocked,
} from './mazeRenderer.js';
import { saveMazeProgress, getMazeWave } from './mazePuzzles.js';
import { UI } from './ui.js';

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
  // Per playtester: "For the endless glyphs soundtrack can we cycle
  // xian, yomi, and zion music queues?" The 'endless_glyphs' section
  // is defined in audio.js MUSIC_SECTIONS and rotates indices 5,6,7
  // (XIAN.mp3, YOMI.mp3, ZION.mp3) — high-energy combat tracks
  // matching the wave structure.
  //
  // CRITICAL: setMusicSection alone does NOT start playback if
  // _musicOn is false (which it always is when entering endless from
  // the title screen — title plays CDrone, not the music playlist).
  // We have to follow up with startMusic(1) to actually kick the
  // first track. Without this, the section flag is set correctly
  // but no audio plays for the entire run. Mirrors what startGame()
  // does for main runs (it calls startMusic(1) ~3s after launch).
  Audio.setMusicSection && Audio.setMusicSection('endless_glyphs');
  try { Audio.startMusic && Audio.startMusic(1); } catch (e) {}

  // Hide ALL overlays that could be blocking the game view.
  const titleEl = document.getElementById('title');
  if (titleEl) titleEl.classList.add('hidden');
  // Loading screen ("0-100% INITIALIZING")
  const loadEl = document.getElementById('loading');
  if (loadEl) loadEl.style.display = 'none';
  // Matrix dive ("100% READY · ATTACK THE AI")
  const diveEl = document.getElementById('matrix-dive');
  if (diveEl) { diveEl.style.display = 'none'; diveEl.remove(); }
  // Hyperdrive overlay (from previous main game run)
  const hypeEl = document.getElementById('hyperdrive-overlay');
  if (hypeEl) { hypeEl.style.display = 'none'; hypeEl.remove(); }
  // Initiate protocol ("SIMVOID >> BEGIN <<")
  const ipEl = document.getElementById('initiate-protocol');
  if (ipEl) { ipEl.style.display = 'none'; ipEl.remove(); }

  // UNDER CONSTRUCTION — show the placeholder and return early.
  _savedPlayerCount = playerCount;
  _showConstructionOverlay();
  return;
}

let _savedPlayerCount = 1;

/** The real game startup — called when the hidden code is entered. */
function _realStartEndlessGlyphs(playerCount) {
  // Clear any other mode
  if (S.tutorialMode) { S.tutorialMode = false; setTutorialActive(false); }

  Audio.stopPhoneRing && Audio.stopPhoneRing();
  Audio.stopCDrone && Audio.stopCDrone();
  Audio.stopDeathMusic && Audio.stopDeathMusic();
  Audio.setMusicSection && Audio.setMusicSection('endless_glyphs');
  try { Audio.startMusic && Audio.startMusic(1); } catch (e) {}

  // Hide ALL overlays
  ['title','loading'].forEach(id => { const e = document.getElementById(id); if (e) { e.classList.add('hidden'); e.style.display = 'none'; } });
  ['matrix-dive','hyperdrive-overlay','initiate-protocol'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });

  // Reset game state (weapons, HP, ammo, etc.)
  resetGame();

  // resetGame() clears our flags — re-seed AFTER reset
  S.endlessGlyphs = true;
  S.running = true;
  S.endlessPlayerCount = Math.max(1, Math.min(3, playerCount | 0));
  S.endlessWave = 0;
  S.endlessPhase = 'LOBBY_PREP';
  S.endlessPhaseT = 0;
  S.endlessKills = 0;
  S.endlessVictory = false;

  // Clean arena
  if (typeof window.__setupEndlessCleanArena === 'function') {
    try { window.__setupEndlessCleanArena(); } catch (e) {}
  }

  // Grant all stratagems
  try {
    grantArtifact('turret', 99);
    grantArtifact('mines', 99);
    grantArtifact('mech', 99);
    grantArtifact('thermonuclear', 99);
  } catch (e) {}

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
  S.running = true;  // CRITICAL: game loop gates everything behind S.running
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

  // Grant all stratagem artifacts for the endless run. Per playtester:
  // "Can we make sure all turret and mine strategems are available
  // for endless glyphs?" Granting the full set (turret + mines + mech
  // + thermonuclear) so the player has all combat tools through the
  // 30-wave run. Count of 99 each = effectively unlimited; endless is
  // an arcade sandbox, not a resource management mode.
  // resetStratagems() (called inside __setupEndlessCleanArena) clears
  // active beacons/mechs but does NOT clear S.stratagemArtifacts —
  // grants here persist through the run until exitEndlessGlyphs.
  try {
    grantArtifact('turret', 99);
    grantArtifact('mines', 99);
    grantArtifact('mech', 99);
    grantArtifact('thermonuclear', 99);
  } catch (e) { console.warn('[glyphs] grant artifacts', e); }

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
    case 'WAVE_ASSEMBLE':
      _tickWaveAssemble(dt);
      break;
    case 'WAVE_DISSOLVE':
      _tickWaveDissolve(dt);
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
  S.endlessTopDown = false;
  S.running = false;
  S.endlessPhase = null;
  S.endlessWave = 0;
  S.endlessKills = 0;
  S.endlessVictory = false;
  _slide = null;
  _mazeBuilt = false;
  _activeMazeData = null;
  _hideEmojiAvatar();
  _popFog();

  restoreNormalFloor();
  _restoreWaveFloor();
  setTutorialActive(false);
  cancelDissolve();
  cancelAssemble();
  _exitDarkMode();
  clearMaze(scene);
  // (no spawners/portals in slide-fill mode)
  _disposeLocker();
  _disposeWaveHUD();
  clearAllEnemies();
  _removeConstructionOverlay();

  if (typeof window.__teardownEndlessCleanArena === 'function') {
    try { window.__teardownEndlessCleanArena(); }
    catch (e) { console.warn('[glyphs] teardown', e); }
  }

  // Return to main menu — show the title screen
  const titleEl = document.getElementById('title');
  if (titleEl) { titleEl.classList.remove('hidden'); titleEl.style.display = ''; }
  // Stop music
  Audio.stopPhoneRing && Audio.stopPhoneRing();
  Audio.stopCDrone && Audio.stopCDrone();
  try { Audio.stopMusic && Audio.stopMusic(); } catch (_) {}
}

// ---- UNDER CONSTRUCTION OVERLAY ----
let _constructionEl = null;

function _showConstructionOverlay() {
  _removeConstructionOverlay();
  const el = document.createElement('div');
  el.id = 'endless-construction';
  el.innerHTML = `
    <style>
      #endless-construction {
        position: fixed; inset: 0; z-index: 99998;
        background: rgba(0,0,0,0.88);
        display: flex; align-items: center; justify-content: center;
        flex-direction: column; font-family: 'Courier New', monospace;
      }
      #endless-construction .ec-icon { font-size: 80px; margin-bottom: 20px; }
      #endless-construction h1 {
        font-family: 'Impact','Arial Black',sans-serif;
        font-size: 42px; letter-spacing: 6px; color: #ffd93d;
        text-shadow: 0 0 20px rgba(255,217,61,0.5);
        margin: 0 0 12px 0;
      }
      #endless-construction .ec-sub {
        font-size: 14px; letter-spacing: 3px; color: #88c0ff;
        margin-bottom: 8px; text-align: center; max-width: 500px;
      }
      #endless-construction .ec-detail {
        font-size: 11px; letter-spacing: 2px; color: #666;
        margin-bottom: 40px; text-align: center; max-width: 440px; line-height: 1.6;
      }
      #endless-construction .ec-btn {
        font-family: 'Impact','Arial Black',sans-serif;
        font-size: 18px; letter-spacing: 4px; padding: 16px 48px;
        background: transparent; color: #4ff7ff; border: 2px solid #4ff7ff;
        cursor: pointer; box-shadow: 0 0 12px rgba(79,247,255,0.3);
        transition: all 0.15s;
      }
      #endless-construction .ec-btn:hover {
        background: #4ff7ff; color: #000;
        box-shadow: 0 0 30px rgba(79,247,255,0.6);
      }
    </style>
    <div class="ec-icon">🚧</div>
    <h1>UNDER CONSTRUCTION</h1>
    <div class="ec-sub">ENDLESS GLYPHS — MAZE ESCAPE MODE</div>
    <div class="ec-detail">
      60 PROCEDURAL MAZE WAVES · 6 CHAPTERS<br>
      COLLECT GLYPHS · SOLVE PUZZLES · ESCAPE THE MAZE<br>
      ENEMIES PATROL · BOSSES EVERY 10 WAVES<br>
      PROGRESS SAVES AFTER EACH WAVE
    </div>
    <button class="ec-btn" id="ec-back-btn">↩ MAIN MENU</button>
  `;
  document.body.appendChild(el);
  _constructionEl = el;

  document.getElementById('ec-back-btn').addEventListener('click', () => {
    exitEndlessGlyphs();
  });

  // Hidden stratagem code: ↑ ↑ ↓ ↓ ← → (arrow keys)
  // Visual feedback appears at bottom when player starts entering arrows,
  // same style as the in-game stratagem code display.
  const SECRET_SEQ = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  const ARROW_DISPLAY = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  let seqIdx = 0;

  // Create the arrow display element (hidden until first arrow press)
  const arrowDisplay = document.createElement('div');
  arrowDisplay.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);' +
    'font-family:"Courier New",monospace;font-size:28px;letter-spacing:12px;color:#333;' +
    'z-index:999999;display:none;text-align:center;';
  document.body.appendChild(arrowDisplay);

  function _updateArrowDisplay() {
    let html = '';
    for (let i = 0; i < SECRET_SEQ.length; i++) {
      const arrow = ARROW_DISPLAY[SECRET_SEQ[i]];
      if (i < seqIdx) {
        html += '<span style="color:#00ff66;text-shadow:0 0 8px #00ff66;">' + arrow + '</span>';
      } else {
        html += '<span style="color:#333;">' + arrow + '</span>';
      }
    }
    arrowDisplay.innerHTML = html;
  }

  function _onCodeKey(e) {
    // Only respond to arrow keys
    if (!ARROW_DISPLAY[e.key]) return;

    // Show the display on first arrow press
    if (arrowDisplay.style.display === 'none') {
      arrowDisplay.style.display = 'block';
      _updateArrowDisplay();
    }

    if (e.key === SECRET_SEQ[seqIdx]) {
      seqIdx++;
      _updateArrowDisplay();
      if (seqIdx >= SECRET_SEQ.length) {
        // Code complete — flash green then bypass
        arrowDisplay.style.color = '#00ff66';
        setTimeout(() => {
          document.removeEventListener('keydown', _onCodeKey);
          arrowDisplay.remove();
          _removeConstructionOverlay();
          _realStartEndlessGlyphs(_savedPlayerCount || 1);
        }, 400);
      }
    } else {
      // Wrong key — flash red, reset
      seqIdx = 0;
      arrowDisplay.style.transition = 'none';
      for (const span of arrowDisplay.querySelectorAll('span')) {
        span.style.color = '#ff2e4d';
      }
      setTimeout(() => {
        _updateArrowDisplay();
      }, 300);
    }
  }
  document.addEventListener('keydown', _onCodeKey);
  el._cleanupCode = () => { document.removeEventListener('keydown', _onCodeKey); if (arrowDisplay.parentNode) arrowDisplay.remove(); };
}

function _removeConstructionOverlay() {
  if (_constructionEl) {
    _constructionEl.remove();
    _constructionEl = null;
  }
  const stale = document.getElementById('endless-construction');
  if (stale) stale.remove();
}

// =====================================================================
// PHASE TICKS
// =====================================================================

// Lobby + intermission window — same duration. Per playtester:
// "Can we reduce the lobby/intermission time from 1 min to 15
// seconds?" Was 60s; the longer prep window encouraged dawdling
// without adding meaningful planning beats. 15s is enough to glance
// at the locker, pick a weapon if desired, and brace for the wave.
const LOBBY_PREP_DURATION = 15;

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
  // Walls are generated by _enterWaveAssemble (the next phase) so
  // the assemble animation can run on them. We don't generate here.
}
function _tickTilesTransition(dt) {
  _setWaveHUD('GET READY', '');
  if (S.endlessPhaseT >= TILES_TRANSITION_DURATION) {
    _enterWaveAssemble(_pendingWaveNum);
  }
}

// =====================================================================
// WAVE RUNNER (slide-fill)
// =====================================================================
// Each wave generates a maze that fills the arena, places mining
// gates and kill zones per the wave config, and gives the player one
// minute to slide-cover every cell. Hitting a kill zone or running
// out of time retries the wave with the same seed.

let _pendingWaveNum = 1;
let _mazeBuilt = false;
let _activeMazeData = null;

// Slide-fill state.
const SLIDE_CELLS_PER_SEC = 12;
const WAVE_TIME_LIMIT = 60;          // seconds per wave

let _slide = null;                   // { startX, startZ, tx, tz, t, duration, cells, idx, willKill }
let _facingDir = { dx: 1, dz: 0 };   // last move direction (used for fire aim)
let _waveTimer = WAVE_TIME_LIMIT;

// Emoji avatar — a billboarded sprite that stands in for the Meebit
// in the top-down slide-fill view. Built lazily in _enterWaveAssemble.
let _emojiSprite = null;
const EMOJI_CHAR = '😀';

function _ensureEmojiSprite() {
  if (_emojiSprite) return _emojiSprite;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  ctx.font = '210px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(EMOJI_CHAR, 128, 138);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.2, 3.2, 1);
  sprite.renderOrder = 999;            // always on top
  _emojiSprite = sprite;
  return sprite;
}

function _showEmojiAvatar() {
  const s = _ensureEmojiSprite();
  if (!s.parent) scene.add(s);
  s.visible = true;
  if (player && player.obj) player.obj.visible = false;
}

function _hideEmojiAvatar() {
  if (_emojiSprite) {
    _emojiSprite.visible = false;
    if (_emojiSprite.parent) _emojiSprite.parent.remove(_emojiSprite);
  }
  if (player && player.obj) player.obj.visible = true;
}

function _updateEmojiAvatar(dt) {
  if (!_emojiSprite || !_emojiSprite.visible || !player || !player.pos) return;
  const t = performance.now() * 0.001;
  _emojiSprite.position.set(player.pos.x, 1.6 + Math.sin(t * 4) * 0.08, player.pos.z);
}

function _prepareWave(waveNum) {
  _pendingWaveNum = waveNum;
  _waveTimer = WAVE_TIME_LIMIT;
}

/**
 * WAVE_ASSEMBLE — particles emerge from the floor and converge onto
 * the wall positions while the walls fade in. Bridges TILES_TRANSITION
 * (or post-dissolve) → WAVE. Per playtester (Ship 3C "Full" assembly
 * polish): "particles emerge from the floor at random grid positions,
 * fly to wall surfaces, walls become visible only when particles
 * arrive."
 *
 * The walls are GENERATED at this phase entry (so they exist as
 * scene objects); their materials are flipped to transparent +
 * opacity 0 by startAssemble; the per-frame tick fades them in.
 * Enemies do NOT spawn during this phase — the wave hasn't started
 * yet from the player's perspective.
 */
function _enterWaveAssemble(waveNum) {
  S.endlessPhase = 'WAVE_ASSEMBLE';
  S.endlessPhaseT = 0;
  // Keep the bright lobby lighting — slide-fill uses a top-down view
  // at y=92 and the chapter-7 fog (used by the old shooter mode)
  // would hide the entire maze from this height.
  _exitDarkMode();
  // Default scene fog ends at 85 — the top-down camera is at 92, so
  // the whole maze sits in fog. Push fog out of view for the duration
  // of the wave; restored in _enterWaveDissolve / _enterIntermission /
  // exitEndlessGlyphs.
  _pushFog();

  // Generate + render the maze. The assemble animation fades the
  // wall materials in over ~2s; the meshes have to exist in the
  // scene first.
  const chapterIdx = _waveToChapterIdx(waveNum);
  const fillTint = _waveFillTint(waveNum);
  const mazeData = generateMaze(waveNum);
  buildMaze(mazeData, scene, fillTint);
  _mazeBuilt = true;
  _activeMazeData = mazeData;

  startAssemble(getMazeWallEntries());

  // Teleport player to spawn cell, mark that cell as visited.
  const spawnWorld = cellToWorld(mazeData.spawn.col, mazeData.spawn.row, mazeData.cols, mazeData.rows);
  if (player && player.pos) {
    player.pos.x = spawnWorld.x;
    player.pos.z = spawnWorld.z;
  }
  markCellVisited(mazeData.spawn.col, mazeData.spawn.row);
  _slide = null;
  _facingDir = { dx: 1, dz: 0 };
  S.endlessTopDown = true;
  _showEmojiAvatar();

  _setWaveHUD('WAVE ' + waveNum, 'ASSEMBLING');
}

/** Chapter fill-tint follows the wave's mapped chapter. */
function _waveFillTint(waveNum) {
  const idx = _waveToChapterIdx(waveNum);
  return CHAPTERS[idx].full.enemyTint;
}

function _tickWaveAssemble(dt) {
  const stillAnimating = tickAssemble(dt);
  if (stillAnimating) return;
  // Animation done — slide into the actual WAVE phase.
  _enterWave(_pendingWaveNum);
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
  if (!_mazeBuilt) return;
  updateMazeFx(dt);
  _updateEmojiAvatar(dt);

  // Slide animation tick.
  _tickSlide(dt);

  // 1-minute wave timer. Running out is treated as a kill — the wave
  // restarts from a clean state.
  _waveTimer = Math.max(0, _waveTimer - dt);
  if (_waveTimer <= 0) {
    _retryWave('TIME OUT');
    return;
  }

  // HUD — coverage % + timer.
  const cov = getCoverage();
  const pct = cov.total > 0 ? Math.floor((cov.filled / cov.total) * 100) : 0;
  const t = Math.ceil(_waveTimer);
  const mm = Math.floor(t / 60), ss = t - mm * 60;
  const timeStr = mm + ':' + (ss < 10 ? '0' + ss : ss);
  _setWaveHUD('WAVE ' + S.endlessWave, pct + '% · ' + timeStr);

  // Win check — every cell visited.
  if (cov.total > 0 && cov.filled >= cov.total) {
    saveMazeProgress(S.endlessWave);
    try { Audio.shot && Audio.shot('raygun'); } catch (_) {}
    UI.toast('WAVE ' + S.endlessWave + ' CLEARED', '#4ff7ff', 1800);
    _enterWaveDissolve();
  }
}

/**
 * WAVE_DISSOLVE — wave just ended. Particles spawn from the wall
 * AABBs, fly to autoglyph positions on the floor, hold, then sink.
 * This phase replaces the previous instant wall-vanish behavior
 * with a thematic transformation visible to the player.
 */
function _enterWaveDissolve() {
  S.endlessPhase = 'WAVE_DISSOLVE';
  S.endlessPhaseT = 0;
  // Snapshot the maze wall AABBs for the particle source, then clear
  // the meshes.
  const wallSnapshot = getMazeWallEntries().map(w => ({ x: w.x, z: w.z, w: w.w, h: w.h }));
  clearMaze(scene);
  _mazeBuilt = false;
  _activeMazeData = null;
  _slide = null;
  S.endlessTopDown = false;
  _hideEmojiAvatar();
  _popFog();
  startDissolve(wallSnapshot, S.endlessWave);
  _setWaveHUD('WAVE ' + S.endlessWave + ' COMPLETE', 'DISSOLVING');
}

function _tickWaveDissolve(dt) {
  const stillAnimating = tickDissolve(dt);
  if (stillAnimating) return;
  // Animation finished — advance the run state machine.
  // Intermission every 10 waves (end of chapter). Victory at wave 60.
  // After 60, cycles endlessly (no victory cap).
  if (S.endlessWave >= 60) {
    _enterVictory();
  } else if (S.endlessWave % 10 === 0) {
    // Chapter complete — intermission with ore reward
    _enterIntermission();
  } else {
    // Next wave in the same chapter — roll directly into assembly.
    S.endlessWave += 1;
    _prepareWave(S.endlessWave);
    _enterWaveAssemble(S.endlessWave);
  }
}

/**
 * Endless Glyphs wave → chapter mapping. 10 waves per chapter:
 *   waves  1-10  → ch0 INFERNO (orange, tetris, zomeebs + sprinters)
 *   waves 11-20  → ch1 CRIMSON (red, galaga, + vampires + red_devils)
 *   waves 21-30  → ch2 SOLAR   (yellow, minesweeper, + wizards)
 *   waves 31-40  → ch3 TOXIC   (green, pacman, + goospitters)
 *   waves 41-50  → ch4 ARCTIC  (blue, pong, + ghosts)
 *   waves 51-60  → ch5 PARADISE(purple, donkey kong, + mixed)
 * After wave 60, cycles back to ch0 with scaled-up difficulty.
 *
 * @param {number} waveNum  endless wave number, 1-30
 * @returns {number}        chapter index 0-5 for use with CHAPTERS
 *                           and waveEnemyMix
 */
function _waveToChapterIdx(waveNum) {
  // 10 waves per chapter: waves 1-10 → 0, 11-20 → 1, ..., 51-60 → 5
  // Cycles back after 60 for infinite play
  return Math.floor((waveNum - 1) / 10) % 6;
}

// =====================================================================
// SLIDE-FILL MOVEMENT
// =====================================================================
//
// On a directional input, walk cells in that direction until either a
// wall stops us or a kill zone is the next cell. Enqueue an animation
// that moves the player through those cells at SLIDE_CELLS_PER_SEC,
// marking each cell visited as we cross it. If the slide ends in a
// kill zone the wave is retried.

/**
 * Begin a slide. dx, dz must each be -1, 0, or +1 (and exactly one
 * non-zero). No-op when not in WAVE phase, the maze isn't built, or
 * a slide is already in progress.
 */
export function endlessSlide(dx, dz) {
  if (!S.endlessGlyphs || S.endlessPhase !== 'WAVE') return;
  if (!_mazeBuilt || !_activeMazeData) return;
  if (_slide) return;
  if ((dx === 0) === (dz === 0)) return;   // require exactly one axis

  _facingDir = { dx, dz };
  if (player && player.obj) {
    player.obj.rotation.y = Math.atan2(dx, dz);
  }

  const md = _activeMazeData;
  const start = worldToCell(player.pos.x, player.pos.z, md.cols, md.rows);
  const cells = [];
  let col = start.col, row = start.row;
  let willKill = false;

  // Walk forward until either:
  //   • a wall blocks the next step,
  //   • the next cell holds an un-broken mining block (slide stops
  //     in front; player must shoot to clear it), OR
  //   • the next cell is a kill zone (slide continues INTO it, then
  //     the wave retries on slide-end).
  while (true) {
    const dir = dx > 0 ? 'E' : dx < 0 ? 'W' : dz > 0 ? 'S' : 'N';
    if (_isCellBlockedToward(col, row, dir)) break;
    const nc = col + dx;
    const nr = row + dz;
    if (nc < 0 || nc >= md.cols || nr < 0 || nr >= md.rows) break;
    if (isCellBlocked(nc, nr)) break;        // mining block in path
    col = nc; row = nr;
    cells.push({ col, row });
    if (isKillZoneCell(col, row)) { willKill = true; break; }
  }

  if (cells.length === 0) {
    // Nothing to do — player tapped into a wall. Soft thud feedback.
    try { Audio.shot && Audio.shot('shieldHit'); } catch (_) {}
    return;
  }

  const last = cells[cells.length - 1];
  const target = cellToWorld(last.col, last.row, md.cols, md.rows);
  const duration = cells.length / SLIDE_CELLS_PER_SEC;
  _slide = {
    startX: player.pos.x, startZ: player.pos.z,
    tx: target.x, tz: target.z,
    t: 0, duration,
    cells, idx: 0, willKill,
  };
}

function _isCellBlockedToward(col, row, dir) {
  if (!_activeMazeData) return true;
  const { cols, cells } = _activeMazeData;
  const cell = cells[row * cols + col];
  if (!cell) return true;
  const flag =
    dir === 'N' ? 1 :         // WALL_N
    dir === 'E' ? 2 :         // WALL_E
    dir === 'S' ? 4 :         // WALL_S
                  8;          // WALL_W
  return (cell.walls & flag) !== 0;
}

function _tickSlide(dt) {
  if (!_slide) return;
  _slide.t += dt;
  const u = Math.min(1, _slide.t / _slide.duration);
  player.pos.x = _slide.startX + (_slide.tx - _slide.startX) * u;
  player.pos.z = _slide.startZ + (_slide.tz - _slide.startZ) * u;

  // Mark cells as we cross them.
  const md = _activeMazeData;
  if (md) {
    while (_slide.idx < _slide.cells.length) {
      const targetU = (_slide.idx + 1) / _slide.cells.length;
      if (u < targetU) break;
      const c = _slide.cells[_slide.idx];
      markCellVisited(c.col, c.row);
      _slide.idx++;
    }
  }

  if (u >= 1) {
    const willKill = _slide.willKill;
    _slide = null;
    if (willKill) _retryWave('KILLED');
  }
}

/**
 * Fire a bullet from the player in the current facing direction. Used
 * by the main.js input handlers (mouse / space) when in WAVE phase.
 * Aimed at the next mining gate / wall so the bullet either damages
 * the gate or splashes against the wall.
 */
export function endlessFire() {
  if (!S.endlessGlyphs || S.endlessPhase !== 'WAVE') return;
  if (typeof window.__endlessFireBullet === 'function') {
    try { window.__endlessFireBullet(_facingDir.dx, _facingDir.dz); } catch (_) {}
  }
}

/**
 * Retry the current wave from a clean state. Triggered by hitting a
 * kill zone or running out the 1-minute timer.
 */
function _retryWave(reason) {
  cancelAssemble();
  cancelDissolve();
  _slide = null;
  clearMaze(scene);
  _mazeBuilt = false;
  _activeMazeData = null;
  _hideEmojiAvatar();
  _popFog();
  UI.toast(reason + ' · RETRY WAVE ' + S.endlessWave, '#ff2e4d', 1500);
  try { Audio.shot && Audio.shot('shieldHit'); } catch (_) {}
  // Re-enter assembly with the same wave number — the seed is
  // deterministic so the layout matches.
  _enterWaveAssemble(S.endlessWave);
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
  S.endlessTopDown = false;
  _popFog();
  // Maze meshes already cleared by _enterWaveDissolve. Cancel any
  // lingering dissolve / assemble particles in case the animation
  // was still mid-flight when the wave-10 boundary triggered.
  cancelDissolve();
  cancelAssemble();
  // Dark mode off — intermission returns to the bright tutorial
  // lobby aesthetic so the player can comfortably scan the locker
  // and weapon options.
  _exitDarkMode();
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
 * (we never get anywhere near that — max LOBBY_PREP_DURATION is 15s,
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
  // White floor — pure white color (not textured) so the flashlight
  // cone reads as a bright illuminated patch against the dim arena.
  // The floor is NOT self-illuminating (emissiveIntensity 0) — that
  // would drown out the dark atmosphere we just turned on. Instead
  // the SpotLight illuminates the cone area; outside the cone the
  // floor sits at the ambient level (dark grey under DARK_AMBIENT
  // ≈ 0.08). Reads as a real flashlight game where the player can
  // only see what they're pointing at.
  Scene.groundMat.map = null;
  Scene.groundMat.color.setHex(0xffffff);
  Scene.groundMat.emissive = new THREE.Color(0x000000);
  Scene.groundMat.emissiveMap = null;
  Scene.groundMat.emissiveIntensity = 0;
  // High roughness so the floor doesn't show specular highlights
  // from the flashlight (those would look like puddles). Pure
  // diffuse response.
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
// DARK MODE — chapter-7-style dim arena + player flashlight
// =====================================================================
// Per playtester: "It might be nice to turn the arena dark like
// Chapter 7 of the main game. Would love to create a glow on
// flashlight shine where the enemies color amplifies when under
// the light - kind of like glow in the dark."
//
// Reuses the existing chapter-7 atmosphere infrastructure in
// scene.js (enterChapter7Atmosphere / exitChapter7Atmosphere /
// updateFlashlight). The "glow under light" is the same mechanic
// as ch7's "forbidden species reveal" — main.js per-frame enemy
// update tests each enemy against the flashlight cone and amps
// emissive intensity when in cone. We extend that gate to fire
// in endless mode too (see main.js — gate now reads
// `S.chapter === PARADISE_FALLEN_CHAPTER_IDX || S.endlessGlyphs`).
//
// Phase rules:
//   LOBBY_PREP / TILES_TRANSITION / INTERMISSION → bright tutorial
//                                                  lighting
//   WAVE_ASSEMBLE / WAVE / WAVE_DISSOLVE         → dark + flashlight
//   VICTORY                                       → dark (so the
//                                                   victory glyph
//                                                   reads against
//                                                   the dim arena)

let _darkModeActive = false;

// ---- FOG STASH ----
// The default scene fog (configured in scene.js for the chase-camera
// shooter) renders the slide-fill top-down view as a black screen.
// We snapshot the original near/far values when entering the wave
// and restore them on dissolve/exit so the rest of the game looks
// unchanged.
let _fogStash = null;
function _pushFog() {
  if (_fogStash) return;
  if (!scene.fog) return;
  _fogStash = { near: scene.fog.near, far: scene.fog.far };
  scene.fog.near = 200;
  scene.fog.far = 400;
}
function _popFog() {
  if (!_fogStash || !scene.fog) return;
  scene.fog.near = _fogStash.near;
  scene.fog.far = _fogStash.far;
  _fogStash = null;
}

function _enterDarkMode() {
  if (_darkModeActive) return;
  // The tutorial lighting boost (applied in _setupEndlessCleanArena
  // to make the lobby readable) needs to come off before we can
  // actually go dark. Without this, the dark atmosphere snapshot
  // would capture the BOOSTED values, then "exit" restores them
  // back to the boosted state — defeating the purpose.
  try { restoreTutorialLighting(); } catch (e) {}
  try { enterChapter7Atmosphere(); } catch (e) {}
  // Tell main.js's update loop the flashlight + glow logic should
  // run this frame onward.
  S.chapter7Atmosphere = true;
  _darkModeActive = true;
}

function _exitDarkMode() {
  if (!_darkModeActive) return;
  try { exitChapter7Atmosphere(); } catch (e) {}
  S.chapter7Atmosphere = false;
  // Restore the tutorial brightness so the lobby/intermission
  // reads correctly under the rainbow-tile floor again.
  try { boostTutorialLighting(); } catch (e) {}
  _darkModeActive = false;
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
  // Roll a fresh 3-weapon random sample for this locker session.
  // Per playtester: random options each visit so the player makes a
  // tactical decision rather than always picking their best.
  _resetLockerWeaponSample();
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
// Cached random sample of 3 weapon IDs for the current locker
// session. Built once per locker spawn (in _spawnLocker via
// _resetLockerWeaponSample), reused across re-renders so clicking a
// weapon doesn't reshuffle the offered options. Per playtester:
// "Can we provide the player 3 weapon options at random when going
// to the locker?"
let _lockerWeaponSample = null;

function _resetLockerWeaponSample() {
  const unlocked = (window.__armory && window.__armory.unlocked) || { pistol: true };
  // Build the unlocked pool. Pistol is always present.
  const pool = [];
  const order = ['pistol', 'shotgun', 'smg', 'rocket', 'raygun', 'flamethrower'];
  for (const id of order) {
    if (unlocked[id] && WEAPONS[id]) pool.push(id);
  }
  // If the player has 3 or fewer unlocks, show all of them — random
  // sampling would just reorder the same options.
  if (pool.length <= 3) {
    _lockerWeaponSample = pool.slice();
    return;
  }
  // Sample 3 distinct weapons via Fisher-Yates partial shuffle.
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  _lockerWeaponSample = shuffled.slice(0, 3);
}

function _refreshLockerPanelTiles() {
  if (!_lockerPanelEl) return;
  const grid = _lockerPanelEl.querySelector('#glyphs-locker-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Use the cached random sample (built when the locker spawned).
  // Defensive: if the sample wasn't built (race on first render),
  // build it now.
  if (!_lockerWeaponSample) _resetLockerWeaponSample();
  const ids = _lockerWeaponSample || ['pistol'];

  for (const id of ids) {
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

// =====================================================================
// DEV CHEAT — unlock Endless Glyphs from the browser console.
// Type: window.__unlockGlyphs() in the console, then refresh.
// Also: press Shift+G on the title screen to unlock instantly.
// =====================================================================
window.__unlockGlyphs = function () {
  try {
    localStorage.setItem('mbs_attack_completed_v1', '1');
    const card = document.getElementById('mode-card-glyphs');
    if (card) card.classList.remove('locked');
    console.log('[DEV] Endless Glyphs UNLOCKED. Refresh if the card is still locked.');
  } catch (e) { console.warn(e); }
};

// Shift+G shortcut on title screen
document.addEventListener('keydown', (e) => {
  if (e.key === 'G' && e.shiftKey) {
    window.__unlockGlyphs();
  }
});

// Bridge for inline HTML script — must be set at module level
window.__startEndlessGlyphs = startEndlessGlyphs;
