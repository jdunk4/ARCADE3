// ============================================================
// AVATAR SHARDS — Collectible unlock system for alternate avatars.
//
// Each non-default avatar requires 4 "data shards" to unlock.
// Shards spawn in-game as glowing pickups — one per chapter,
// easy to miss if you're not exploring. Progress persists in
// localStorage across sessions.
//
// Public API:
//   getShardProgress(avatarId) → { collected: number, total: 4 }
//   isAvatarUnlocked(avatarId) → boolean
//   awardShard(avatarId)       → { newTotal, justUnlocked }
//   getRunShards()             → [{ avatarId, chapter }...]
//   clearRunShards()
//   getAllProgress()           → { [avatarId]: number }
//   resetAllProgress()        → void (dev/debug)
// ============================================================

const LS_KEY = 'mbs_avatar_shards_v1';
const SHARDS_REQUIRED = 4;

// Which avatar can drop shards in which chapters (0-indexed).
// Each avatar has 4 eligible chapters; a shard drops in ONE of
// those per run (random), so it takes multiple runs to unlock.
// Meebit (index 0) is always unlocked — no shards needed.
const SHARD_SCHEDULE = {
  'pixlpal-928':    [0, 1, 2, 3],   // INFERNO, CRIMSON, SOLAR, TOXIC
  'gob-406':        [1, 2, 3, 4],   // CRIMSON, SOLAR, TOXIC, ARCTIC
  'flinger-yellow': [2, 3, 4, 5],   // SOLAR, TOXIC, ARCTIC, PARADISE
  'gob-1004':       [0, 2, 4, 5],   // INFERNO, SOLAR, ARCTIC, PARADISE
  'pixlpal-108':    [1, 3, 4, 5],   // CRIMSON, TOXIC, ARCTIC, PARADISE
  'flinger-purple': [0, 1, 4, 5],   // INFERNO, CRIMSON, ARCTIC, PARADISE
};

// Per-run state — tracks which shards the player found THIS run.
// Tallied at end-of-run (game over screen) so the player sees
// what they earned.
let _runShards = [];

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

function _readAll() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function _writeAll(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/** How many shards the player has collected for this avatar. */
export function getShardProgress(avatarId) {
  if (avatarId === 'meebit') return { collected: SHARDS_REQUIRED, total: SHARDS_REQUIRED };
  const all = _readAll();
  return { collected: all[avatarId] || 0, total: SHARDS_REQUIRED };
}

/** Whether the avatar is playable (default or fully collected). */
export function isAvatarUnlocked(avatarId) {
  if (avatarId === 'meebit') return true;
  const all = _readAll();
  return (all[avatarId] || 0) >= SHARDS_REQUIRED;
}

/** Award one shard. Returns { newTotal, justUnlocked }. Caps at SHARDS_REQUIRED. */
export function awardShard(avatarId) {
  if (avatarId === 'meebit') return { newTotal: SHARDS_REQUIRED, justUnlocked: false };
  const all = _readAll();
  const prev = all[avatarId] || 0;
  if (prev >= SHARDS_REQUIRED) return { newTotal: SHARDS_REQUIRED, justUnlocked: false };
  const next = Math.min(SHARDS_REQUIRED, prev + 1);
  all[avatarId] = next;
  _writeAll(all);
  return { newTotal: next, justUnlocked: next >= SHARDS_REQUIRED };
}

/** Get shards found during the current run (for end-of-run screen). */
export function getRunShards() { return _runShards.slice(); }

/** Clear per-run state (called at run start). */
export function clearRunShards() { _runShards = []; }

/** Record a shard pickup during the current run. */
export function recordRunShard(avatarId, chapterIdx) {
  _runShards.push({ avatarId, chapter: chapterIdx });
}

/** Full progress map for all avatars. */
export function getAllProgress() {
  const all = _readAll();
  const result = {};
  for (const id of Object.keys(SHARD_SCHEDULE)) {
    result[id] = all[id] || 0;
  }
  return result;
}

/** Dev helper — wipe all shard data. */
export function resetAllProgress() {
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
}

/**
 * Given the current chapter index, pick which avatar shard (if any)
 * should spawn this chapter. Returns avatarId or null.
 *
 * Logic: for each avatar that still needs shards, check if this
 * chapter is in its schedule. If multiple qualify, pick one at
 * random. Returns null ~40% of the time even when eligible (sparse).
 */
export function pickShardForChapter(chapterIdx) {
  const all = _readAll();
  const candidates = [];
  for (const [avatarId, chapters] of Object.entries(SHARD_SCHEDULE)) {
    if ((all[avatarId] || 0) >= SHARDS_REQUIRED) continue; // already unlocked
    if (chapters.includes(chapterIdx)) candidates.push(avatarId);
  }
  if (candidates.length === 0) return null;
  // ~60% chance to spawn when eligible — keeps it sparse
  if (Math.random() > 0.60) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Constants for external use. */
export const SHARDS_PER_AVATAR = SHARDS_REQUIRED;
export { SHARD_SCHEDULE };
