// Persistent save via localStorage.
// Keyed per-username so multiple players on the same browser each have a slot.
// Additionally a "shared" block holds the currently-active player.

const KEY_ACTIVE = 'mbs_active_v1';       // currently-selected username
const KEY_PLAYERS = 'mbs_players_v1';     // { [username]: playerSave }

function readAll() {
  try {
    const raw = localStorage.getItem(KEY_PLAYERS);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch (e) {
    console.warn('[save] read failed', e);
    return {};
  }
}

function writeAll(data) {
  try {
    localStorage.setItem(KEY_PLAYERS, JSON.stringify(data));
  } catch (e) {
    console.warn('[save] write failed', e);
  }
}

function getActiveUsername() {
  try { return localStorage.getItem(KEY_ACTIVE) || null; } catch (e) { return null; }
}

function setActiveUsername(name) {
  try { localStorage.setItem(KEY_ACTIVE, name); } catch (e) {}
}

function defaultPlayer(username) {
  return {
    username,
    highScore: 0,
    highestChapter: 0,
    highestWave: 0,
    totalRescues: 0,
    rescuedCollection: [],
    lastRun: null,
    playerMeebitId: null,          // null until random-assigned or wallet-assigned
    playerMeebitSource: 'random',  // 'owned' | 'delegated' | 'random'
    walletAddress: null,
    createdAt: Date.now(),
    lastPlayed: Date.now(),
  };
}

function readPlayer(username) {
  const all = readAll();
  if (!all[username]) all[username] = defaultPlayer(username);
  // Ensure any added fields exist on older saves
  all[username] = { ...defaultPlayer(username), ...all[username], username };
  return all[username];
}

function writePlayer(player) {
  const all = readAll();
  all[player.username] = { ...player, lastPlayed: Date.now() };
  writeAll(all);
  return all[player.username];
}

export const Save = {
  /** Returns the currently-active player's save. Creates a GUEST if none is set. */
  load() {
    let active = getActiveUsername();
    if (!active) {
      active = 'GUEST';
      setActiveUsername(active);
    }
    return readPlayer(active);
  },

  /** Returns all player saves (for showing a profile picker). */
  listPlayers() {
    const all = readAll();
    return Object.values(all).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  },

  /**
   * Sets the active username. Creates a new save slot if this username is new.
   * Returns the loaded player record.
   */
  setUsername(username) {
    username = (username || '').trim().toUpperCase().slice(0, 16);
    if (!username) username = 'GUEST';
    setActiveUsername(username);
    const p = readPlayer(username);
    writePlayer(p); // ensure it's persisted with correct shape
    return p;
  },

  onChapterComplete({ chapter, wave, score, rescuedIds }) {
    const p = this.load();
    p.highScore = Math.max(p.highScore, score);
    p.highestChapter = Math.max(p.highestChapter, chapter);
    p.highestWave = Math.max(p.highestWave, wave);
    const set = new Set(p.rescuedCollection);
    for (const id of rescuedIds) set.add(id);
    p.rescuedCollection = Array.from(set).sort((a, b) => a - b);
    p.totalRescues = p.rescuedCollection.length;
    p.lastRun = { score, wave, chapter, rescuedIds: [...rescuedIds], timestamp: Date.now() };
    return writePlayer(p);
  },

  onGameOver({ score, wave, chapter, rescuedIds }) {
    const p = this.load();
    p.highScore = Math.max(p.highScore, score);
    p.highestWave = Math.max(p.highestWave, wave);
    p.lastRun = { score, wave, chapter, rescuedIds: [...rescuedIds], timestamp: Date.now() };
    return writePlayer(p);
  },

  setSelectedMeebitId(id, source = 'random') {
    const p = this.load();
    p.playerMeebitId = id;
    p.playerMeebitSource = source;
    return writePlayer(p);
  },

  setWalletAddress(addr) {
    const p = this.load();
    p.walletAddress = addr;
    return writePlayer(p);
  },

  clearActive() {
    const p = this.load();
    const all = readAll();
    delete all[p.username];
    writeAll(all);
    setActiveUsername('GUEST');
  },
};
