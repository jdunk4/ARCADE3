// Persistent save via localStorage.
// Stored data:
//   mbs_save = {
//     highScore: number,
//     highestChapter: number,    // 0-indexed highest chapter reached
//     highestWave: number,       // absolute highest wave reached
//     totalRescues: number,      // lifetime count across all runs
//     rescuedCollection: number[], // unique meebit IDs ever rescued
//     lastRun: { score, wave, chapter, rescuedIds, timestamp },
//     selectedMeebitId: number,  // player's chosen avatar id (wallet or picked)
//   }

const KEY = 'mbs_save_v1';

function readSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const parsed = JSON.parse(raw);
    // Ensure shape
    return { ...defaultSave(), ...parsed };
  } catch (e) {
    console.warn('[save] read failed', e);
    return defaultSave();
  }
}

function writeSave(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[save] write failed', e);
  }
}

function defaultSave() {
  return {
    highScore: 0,
    highestChapter: 0,
    highestWave: 0,
    totalRescues: 0,
    rescuedCollection: [],
    lastRun: null,
    selectedMeebitId: 16801,
  };
}

export const Save = {
  load() { return readSave(); },

  onChapterComplete({ chapter, wave, score, rescuedIds }) {
    const s = readSave();
    s.highScore = Math.max(s.highScore, score);
    s.highestChapter = Math.max(s.highestChapter, chapter);
    s.highestWave = Math.max(s.highestWave, wave);
    // Merge rescued collection (dedupe)
    const set = new Set(s.rescuedCollection);
    for (const id of rescuedIds) set.add(id);
    s.rescuedCollection = Array.from(set).sort((a, b) => a - b);
    s.totalRescues = s.rescuedCollection.length;
    s.lastRun = { score, wave, chapter, rescuedIds: [...rescuedIds], timestamp: Date.now() };
    writeSave(s);
    return s;
  },

  onGameOver({ score, wave, chapter, rescuedIds }) {
    const s = readSave();
    s.highScore = Math.max(s.highScore, score);
    s.highestWave = Math.max(s.highestWave, wave);
    // Game over — only permanent rescues already committed at chapter-end count.
    // But save the current run snapshot.
    s.lastRun = { score, wave, chapter, rescuedIds: [...rescuedIds], timestamp: Date.now() };
    writeSave(s);
    return s;
  },

  setSelectedMeebitId(id) {
    const s = readSave();
    s.selectedMeebitId = id;
    writeSave(s);
  },

  clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  },
};
