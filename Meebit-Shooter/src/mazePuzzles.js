// ============================================================
// MAZE PUZZLES — wave-progress persistence for Endless Glyphs.
//
// In the slide-fill redesign, glyph state lives in the maze renderer
// (visited cells = coverage). This module just persists the highest
// wave the player has cleared, in localStorage.
//
// Public API:
//   getMazeProgress()          → { wave, chapter }
//   getMazeWave()              → next wave to play (highest cleared + 1)
//   saveMazeProgress(wave)
//   resetMazeProgress()
// ============================================================

const LS_KEY = 'mbs_maze_progress_v1';

function _readProgress() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : { wave: 0 };
  } catch (e) { return { wave: 0 }; }
}

function _writeProgress(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
}

export function getMazeProgress() {
  const d = _readProgress();
  return {
    wave: d.wave || 0,
    chapter: Math.floor((d.wave || 0) / 10),
  };
}

export function getMazeWave() {
  return (_readProgress().wave || 0) + 1;
}

export function saveMazeProgress(wave) {
  const d = _readProgress();
  if (wave > (d.wave || 0)) {
    d.wave = wave;
    _writeProgress(d);
  }
}

export function resetMazeProgress() {
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
}
