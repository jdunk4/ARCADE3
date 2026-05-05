// ============================================================
// MAZE PUZZLES — State management for Endless Glyphs maze mode.
//
// Tracks glyph collection, exit activation, wave completion.
// Saves progress to localStorage after each cleared wave.
//
// Public API:
//   initMazePuzzle(mazeData)
//   tickMazePuzzle(playerPos, dt) → { collected, allFound, exitReached }
//   getMazeProgress()  → { wave, chapter }
//   saveMazeProgress(wave)
//   resetMazeProgress()
//   getMazeWave() → number
// ============================================================

import { getGlyphWorldPositions, collectGlyph, isNearExit, areAllGlyphsCollected, getCollectedCount, getGlyphCount } from './mazeRenderer.js';

const LS_KEY = 'mbs_maze_progress_v1';
const GLYPH_PICKUP_RADIUS = 1.8;  // world units

let _active = false;
let _justCollected = -1;  // index of last collected glyph this frame
let _exitReached = false;

export function initMazePuzzle(mazeData) {
  _active = true;
  _justCollected = -1;
  _exitReached = false;
}

/**
 * Tick the puzzle — check player proximity to glyphs and exit.
 * Call every frame when maze mode is active.
 *
 * @param {{x:number, z:number}} playerPos
 * @param {number} dt
 * @returns {{ collected: number|null, allFound: boolean, exitReached: boolean, total: number, found: number }}
 */
export function tickMazePuzzle(playerPos, dt) {
  if (!_active) return { collected: null, allFound: false, exitReached: false, total: 0, found: 0 };

  _justCollected = -1;
  const glyphs = getGlyphWorldPositions();

  // Check glyph pickups
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    if (g.collected) continue;
    const dx = playerPos.x - g.x;
    const dz = playerPos.z - g.z;
    if (dx * dx + dz * dz < GLYPH_PICKUP_RADIUS * GLYPH_PICKUP_RADIUS) {
      const allNow = collectGlyph(i);
      _justCollected = i;
      break;  // one pickup per frame
    }
  }

  // Check exit
  const allFound = areAllGlyphsCollected();
  if (allFound && !_exitReached) {
    _exitReached = isNearExit(playerPos);
  }

  return {
    collected: _justCollected >= 0 ? _justCollected : null,
    allFound,
    exitReached: _exitReached,
    total: getGlyphCount(),
    found: getCollectedCount(),
  };
}

export function isMazePuzzleActive() { return _active; }
export function deactivateMazePuzzle() { _active = false; }

// ---- PERSISTENCE ----

function _readProgress() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : { wave: 0 };
  } catch (e) { return { wave: 0 }; }
}

function _writeProgress(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
}

/** Get the highest wave the player has cleared. */
export function getMazeProgress() {
  const d = _readProgress();
  return {
    wave: d.wave || 0,
    chapter: Math.floor((d.wave || 0) / 10),
  };
}

/** Current wave to play (highest cleared + 1). */
export function getMazeWave() {
  return (_readProgress().wave || 0) + 1;
}

/** Save progress after clearing a wave. */
export function saveMazeProgress(wave) {
  const d = _readProgress();
  if (wave > (d.wave || 0)) {
    d.wave = wave;
    _writeProgress(d);
  }
}

/** Reset all maze progress (dev/debug). */
export function resetMazeProgress() {
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
}
