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
import { scene } from './scene.js';
import { S, resetGame } from './state.js';
import { Audio } from './audio.js';
import { applyTutorialFloor, restoreNormalFloor, setTutorialActive } from './tutorial.js';
import { hitBurst } from './effects.js';
import { clearAllEnemies } from './enemies.js';

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
  setTutorialActive(false);
  _disposeLocker();
  clearAllEnemies();
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
  if (S.endlessPhaseT >= LOBBY_PREP_DURATION) {
    _enterTilesTransition();
  }
  // Phase 3c: surface a HUD timer + locker proximity hint.
}

/**
 * TILES_TRANSITION — 1.5-second crossfade where the rainbow tutorial
 * tiles fade out and the normal arena tiles fade in. The locker
 * disappears (sinks into ground), the wave 1 spawn loop begins
 * underneath the fading visuals so enemies start trickling in just
 * as the arena reveals.
 */
const TILES_TRANSITION_DURATION = 1.5;
function _enterTilesTransition() {
  S.endlessPhase = 'TILES_TRANSITION';
  S.endlessPhaseT = 0;
  // Floor swap is instant for now — Phase 3b will animate the alpha
  // crossfade between the rainbow texture + the regular grid. For
  // skeleton purposes we just call restore.
  restoreNormalFloor();
  setTutorialActive(false);
  _disposeLocker();
  // TODO Phase 3b: kick off wave 1 enemy spawn loop here.
}
function _tickTilesTransition(dt) {
  if (S.endlessPhaseT >= TILES_TRANSITION_DURATION) {
    _enterWave(1);
  }
}

/**
 * WAVE — active combat. Wave runner spawns enemies on a schedule
 * proportional to the wave number, scaling HP ×1.05^wave. When the
 * kill target is met (or all spawns dead), advance to next wave or
 * to intermission every 5th wave.
 *
 * Phase 3a stub: just transitions immediately to the next phase
 * after a placeholder duration so the state machine flows end-to-end
 * during testing. Phase 3b replaces this with real combat logic.
 */
function _enterWave(waveNum) {
  S.endlessPhase = 'WAVE';
  S.endlessPhaseT = 0;
  S.endlessWave = waveNum;
  // Phase 3b: spawn loop, HP scaling, jumper introduction at wave 5+.
}
function _tickWave(dt) {
  // Phase 3a stub — auto-completes after 8s for end-to-end flow test.
  // Phase 3b replaces with real wave logic.
  if (S.endlessPhaseT >= 8) {
    if (S.endlessWave >= 30) {
      _enterVictory();
    } else if (S.endlessWave % 5 === 0) {
      _enterIntermission();
    } else {
      _enterWave(S.endlessWave + 1);
    }
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
  applyTutorialFloor();
  setTutorialActive(true);
  _spawnLocker();
  clearAllEnemies();
}
function _tickIntermission(dt) {
  if (S.endlessPhaseT >= LOBBY_PREP_DURATION) {
    _enterTilesTransition();
  }
}

function _enterVictory() {
  S.endlessPhase = 'VICTORY';
  S.endlessPhaseT = 0;
  S.endlessVictory = true;
  // Phase 3c: full victory screen with stats. For now just stash
  // the flag so external code can detect.
}
function _tickVictory(dt) {
  // Wait for player input or auto-exit after 10s. Phase 3c handles.
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

function _tickLockerVisuals(dt) {
  if (!_lockerMesh || !_lockerGlowMat) return;
  _lockerPulseT += dt;
  // Slow vertical glow pulse — opacity oscillates 0.55 → 0.95.
  _lockerGlowMat.opacity = 0.55 + Math.sin(_lockerPulseT * 2.0) * 0.20;
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
}
