// ============================================================
// AVATAR STONES — Universal collectible unlock currency.
//
// Stones are earned during gameplay runs (sparse, ~1 per chapter
// cleared, easy to miss). They go into a universal INVENTORY.
// The player then visits the avatar picker and CHOOSES which
// avatar to spend them on. Each avatar needs 4 stones to unlock.
//
// Two separate persisted values:
//   - Stone inventory count (how many unspent stones the player has)
//   - Per-avatar unlock progress (how many stones spent on each)
//
// Public API:
//   getStoneInventory()            → number
//   addStones(n)                   → newTotal
//   spendStoneOnAvatar(avatarId)   → { success, newProgress, justUnlocked }
//   getAvatarProgress(avatarId)    → { spent: number, total: 4 }
//   isAvatarUnlocked(avatarId)     → boolean
//   getRunStones()                 → number (stones found this run)
//   clearRunStones()
//   recordRunStone()
//   shouldDropStone(chapterIdx)    → boolean
//   resetAll()                     → void (dev/debug)
// ============================================================

const LS_KEY = 'mbs_avatar_stones_v2';
const STONES_REQUIRED = 4;

let _runStones = 0;

function _read() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { inventory: 0, spent: {} };
    const d = JSON.parse(raw);
    return { inventory: d.inventory || 0, spent: d.spent || {} };
  } catch (e) { return { inventory: 0, spent: {} }; }
}

function _write(d) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {}
}

/** How many unspent stones the player has. */
export function getStoneInventory() { return _read().inventory; }

/** Add stones to inventory. Returns new total. */
export function addStones(n) {
  const d = _read();
  d.inventory = (d.inventory || 0) + n;
  _write(d);
  return d.inventory;
}

/** How many stones spent on this avatar + total needed. */
export function getAvatarProgress(avatarId) {
  if (avatarId === 'meebit') return { spent: STONES_REQUIRED, total: STONES_REQUIRED };
  const d = _read();
  return { spent: d.spent[avatarId] || 0, total: STONES_REQUIRED };
}

/** Whether the avatar is playable. */
export function isAvatarUnlocked(avatarId) {
  if (avatarId === 'meebit') return true;
  const d = _read();
  return (d.spent[avatarId] || 0) >= STONES_REQUIRED;
}

/** Spend 1 stone from inventory on an avatar. */
export function spendStoneOnAvatar(avatarId) {
  if (avatarId === 'meebit') return { success: false, newProgress: STONES_REQUIRED, justUnlocked: false };
  const d = _read();
  const currentSpent = d.spent[avatarId] || 0;
  if (currentSpent >= STONES_REQUIRED) return { success: false, newProgress: currentSpent, justUnlocked: false };
  if ((d.inventory || 0) <= 0) return { success: false, newProgress: currentSpent, justUnlocked: false };
  d.inventory -= 1;
  d.spent[avatarId] = currentSpent + 1;
  _write(d);
  return { success: true, newProgress: d.spent[avatarId], justUnlocked: d.spent[avatarId] >= STONES_REQUIRED };
}

export function getRunStones() { return _runStones; }
export function clearRunStones() { _runStones = 0; }
export function recordRunStone() { _runStones++; }

/** Should a stone drop this chapter? Always on ch1, 50% on others. */
export function shouldDropStone(chapterIdx) {
  if (chapterIdx === 0) return true;
  return Math.random() < 0.50;
}

/** Backward compat alias for avatarPicker. */
export function getShardProgress(avatarId) {
  const p = getAvatarProgress(avatarId);
  return { collected: p.spent, total: p.total };
}

export function resetAll() {
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
}

export const SHARDS_PER_AVATAR = STONES_REQUIRED;
export const STONES_PER_AVATAR = STONES_REQUIRED;
