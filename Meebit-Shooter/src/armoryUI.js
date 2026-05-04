// armoryUI.js — Title-screen armory panel.
//
// Wires the static markup in index.html (#armory-overlay) to the
// data layer in armory.js + the persistence helpers in save.js.
// Render is fully data-driven: the catalog of weapons, stat tracks,
// and player tracks all comes from armory.js — adding a new track or
// weapon there is enough to make it appear here, no DOM tweaks.
//
// API:
//   initArmoryUI()           — call once at startup. Wires the title
//                              screen #armory-btn open + #armory-close-btn.
//   openArmory()             — programmatic open (for hotkey hooks).
//   closeArmory()            — programmatic close.
//
// All purchases call into armory.js's tryUnlockWeapon / tryUpgradeWeapon
// / tryUpgradePlayer helpers and persist via Save.writeArmory.

import { Save } from './save.js';
import { getOreBalance } from './runReward.js';
import { S } from './state.js';
import {
  ARMORY_WEAPON_IDS,
  ARMORY_WEAPON_META,
  WEAPON_TRACKS,
  PLAYER_TRACKS,
  WEAPON_BASE_CAPACITY,
  ARMORY_MAX_LEVEL,
  tryUnlockWeapon,
  tryUpgradeWeapon,
  tryUpgradePlayer,
} from './armory.js';
import { Audio } from './audio.js';

let _initialized = false;

// =====================================================================
// PUBLIC API
// =====================================================================
export function initArmoryUI() {
  if (_initialized) return;
  _initialized = true;

  // Belt-and-suspenders: force the overlay hidden at init. The static
  // markup has class="overlay hidden" + inline display:none, but
  // we re-apply both here in case any other code path (or a stale
  // cached HTML) leaves the overlay visible at startup. The user
  // should never see the armory until they explicitly click ARMORY.
  {
    const overlay = document.getElementById('armory-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.style.display = 'none';
    }
  }

  const btn = document.getElementById('armory-btn');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openArmory();
    });
  }
  // Game-over screen also exposes an ARMORY shortcut so players can
  // immediately spend the XP they just earned without backing out to
  // the title. We hide the game-over overlay while the armory is up,
  // and restore it on close (so REBOOT is still reachable).
  const goBtn = document.getElementById('gameover-armory-btn');
  if (goBtn) {
    goBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const go = document.getElementById('gameover');
      if (go) {
        go.classList.add('hidden');
        // Tag so closeArmory() knows to bring it back.
        go.dataset.armoryTookOver = '1';
      }
      openArmory();
    });
  }
  const closeBtn = document.getElementById('armory-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeArmory();
    });
  }
  // Esc closes armory if open.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _isOpen()) {
      e.preventDefault();
      closeArmory();
    }
  });
}

export function openArmory() {
  const overlay = document.getElementById('armory-overlay');
  if (!overlay) return;
  // Clear the inline display:none used as a FOUC guard in the static
  // markup, then remove .hidden so the .overlay flex display kicks in.
  overlay.style.display = '';
  overlay.classList.remove('hidden');
  // Force the armory to sit above EVERY other overlay regardless of
  // their inline z-index choices. The matrix-rain dive at first load
  // sets the title to z-index:9998 inline; an inline style with a
  // larger value here is the only way to reliably beat that without
  // touching the rest of the UI stacking. Using 2147483600 (just
  // under 32-bit signed int max) guarantees we win against anything.
  overlay.style.zIndex = '2147483600';
  // Solid black scrim so any underlying overlay (title rain, mode
  // cards, dive overlay) is fully masked. The armory's own CSS sets
  // an internal background on the frame; this ensures nothing bleeds
  // through from below regardless of stacking outcome.
  overlay.style.background = '#000';

  // Belt-and-suspenders: also hide the title overlay if it's
  // currently visible. This eliminates any chance of stacking-context
  // weirdness on first page load — the title screen has its own
  // inline z-index set by the matrix-rain dive sequence and we'd
  // rather just take it out of the layout entirely while armory is
  // open. We tag it so closeArmory can restore it if appropriate.
  const titleEl = document.getElementById('title');
  if (titleEl && !titleEl.classList.contains('hidden')) {
    titleEl.classList.add('hidden');
    titleEl.dataset.armoryTookOver = '1';
  }

  _render();
  // Inject chapter-tinted matrix rain into the armory background
  try {
    const rainEl = overlay.querySelector('.matrix-bg');
    if (rainEl) {
      const chapterIdx = (typeof S !== 'undefined' && S.chapter) ? S.chapter : 0;
      const chapterColors = ['#ff6a1a','#ff2e4d','#ffd93d','#00ff66','#4ff7ff','#e63aff','#eeeeee'];
      const tintColor = chapterColors[chapterIdx % chapterColors.length] || '#00ff66';
      rainEl.style.opacity = '0.12';
      if (!rainEl.dataset.populated) {
        rainEl.dataset.populated = '1';
        const RAIN_CHARS = '\u30A2\u30A4\u30A6\u30A8\u30AA\u30AB\u30AD\u30AF\u30B1\u30B3\u30B5\u30B7\u30B9\u30BB\u30BD01234ORE';
        const colCount = Math.max(12, Math.floor((overlay.clientWidth || 800) / 16));
        for (let i = 0; i < colCount; i++) {
          const col = document.createElement('div');
          col.className = 'matrix-col';
          col.style.left = (i * 16) + 'px';
          col.style.animationDuration = (2.5 + Math.random() * 4) + 's';
          col.style.animationDelay = (-Math.random() * 4) + 's';
          col.style.color = tintColor;
          col.style.textShadow = '0 0 4px ' + tintColor;
          let text = '';
          for (let j = 0; j < 30 + Math.random() * 20; j++) text += RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)] + '\n';
          col.textContent = text;
          rainEl.appendChild(col);
        }
      } else {
        for (const col of rainEl.querySelectorAll('.matrix-col')) {
          col.style.color = tintColor;
          col.style.textShadow = '0 0 4px ' + tintColor;
        }
      }
    }
  } catch (_) {}
  // Audio cue — repurpose the level-up chime as a "screen open" sound.
  // No dedicated armory open SFX yet; this is close enough sonically.
  try { Audio.levelup && Audio.levelup(); } catch (_) {}
}

export function closeArmory() {
  const overlay = document.getElementById('armory-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';     // belt-and-suspenders FOUC guard
    // Reset the inline overrides applied by openArmory so the
    // stylesheet rules apply again next time, and we're not leaving
    // an opaque black box in the layout that could confuse the
    // browser dev tools.
    overlay.style.zIndex = '';
    overlay.style.background = '';
  }
  // Restore the title screen if armory hid it on open.
  const titleEl = document.getElementById('title');
  if (titleEl && titleEl.dataset.armoryTookOver === '1') {
    titleEl.classList.remove('hidden');
    delete titleEl.dataset.armoryTookOver;
  }
  // If the armory was opened from the game-over screen, bring that
  // overlay back so REBOOT is reachable. Tag set in initArmoryUI's
  // gameover-armory-btn handler.
  const go = document.getElementById('gameover');
  if (go && go.dataset.armoryTookOver === '1') {
    go.classList.remove('hidden');
    delete go.dataset.armoryTookOver;
  }
}

function _isOpen() {
  const o = document.getElementById('armory-overlay');
  return o && !o.classList.contains('hidden');
}

// =====================================================================
// RENDER
// =====================================================================
// Re-renders the entire panel from the current Save.getArmory() state.
// Cheap (a handful of DOM nodes); we just re-render after every
// purchase rather than diffing.
function _render() {
  const armory = Save.getArmory();

  // Header XP.
  const xpEl = document.getElementById('armory-xp-amount');
  if (xpEl) xpEl.innerHTML = '<span style="display:inline-block;width:16px;height:16px;background:conic-gradient(#ff6a1a,#ff2e4d,#ffd93d,#00ff66,#4ff7ff,#e63aff,#ff6a1a);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);vertical-align:middle;margin-right:6px"></span>' + (getOreBalance() || 0).toLocaleString();

  // Player tracks.
  const playerEl = document.getElementById('armory-player-tracks');
  if (playerEl) {
    playerEl.innerHTML = '';
    for (const trackKey of Object.keys(PLAYER_TRACKS)) {
      const track = PLAYER_TRACKS[trackKey];
      const lvl = (armory.player && armory.player[trackKey]) || 0;
      const row = _makeTrackRow({
        label: track.label,
        level: lvl,
        maxLevel: track.maxLevel,
        cost: lvl < track.maxLevel ? track.cost(lvl) : 0,
        canAfford: getOreBalance() >= (lvl < track.maxLevel ? track.cost(lvl) : 0),
        onBuy: () => _handlePlayerBuy(trackKey),
      });
      playerEl.appendChild(row);
    }
  }

  // Weapons grid.
  const grid = document.getElementById('armory-weapons-grid');
  if (grid) {
    grid.innerHTML = '';
    for (const id of ARMORY_WEAPON_IDS) {
      grid.appendChild(_makeWeaponCard(armory, id));
    }
  }
}

// =====================================================================
// COMPONENTS
// =====================================================================
// Single track row. Used both for player tracks and weapon stat
// tracks. The pip lights + buy button render the same way; what
// differs is the click handler the caller supplies.
function _makeTrackRow({ label, level, maxLevel, cost, canAfford, onBuy }) {
  const row = document.createElement('div');
  row.className = 'armory-track';

  const labelEl = document.createElement('div');
  labelEl.className = 'armory-track-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const pipsEl = document.createElement('div');
  pipsEl.className = 'armory-track-pips';
  for (let i = 0; i < maxLevel; i++) {
    const pip = document.createElement('div');
    pip.className = 'pip' + (i < level ? ' filled' : '');
    pipsEl.appendChild(pip);
  }
  row.appendChild(pipsEl);

  const buy = document.createElement('button');
  buy.type = 'button';
  buy.className = 'armory-track-buy';
  if (level >= maxLevel) {
    buy.classList.add('maxed');
    buy.textContent = 'MAX';
    buy.disabled = true;
  } else {
    buy.textContent = `+UPGRADE  ${cost.toLocaleString()} ORE`;
    buy.disabled = !canAfford;
    buy.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onBuy();
    });
  }
  row.appendChild(buy);
  return row;
}

// Weapon card. Two states:
//   1) Locked → shows the blurb + a single UNLOCK button.
//   2) Unlocked → shows the blurb + 3 stat tracks (DAMAGE / FIRE
//      RATE / CAPACITY).
function _makeWeaponCard(armory, id) {
  const meta = ARMORY_WEAPON_META[id];
  const card = document.createElement('div');
  card.className = 'armory-weapon-card';
  if (meta && meta.color) card.style.setProperty('--card-color', meta.color);

  // Coloured edge glow behind the card content.
  const glow = document.createElement('div');
  glow.className = 'armory-weapon-card-glow';
  card.appendChild(glow);

  // Head row (name + chapter tag).
  const head = document.createElement('div');
  head.className = 'armory-weapon-head';
  const name = document.createElement('div');
  name.className = 'armory-weapon-name';
  name.textContent = meta ? meta.label : id.toUpperCase();
  head.appendChild(name);
  const chap = document.createElement('div');
  chap.className = 'armory-weapon-chapter';
  chap.textContent = meta ? `CHAPTER ${meta.chapter}` : '';
  head.appendChild(chap);
  card.appendChild(head);

  // Blurb.
  const blurb = document.createElement('div');
  blurb.className = 'armory-weapon-blurb';
  blurb.textContent = meta ? meta.blurb : '';
  card.appendChild(blurb);

  const isUnlocked = !!(armory.unlocked && armory.unlocked[id]);
  if (!isUnlocked) {
    card.classList.add('locked');
    const cost = (meta && meta.unlockCost) || 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'armory-weapon-unlock';
    const canAfford = getOreBalance() >= cost;
    btn.textContent = `🔒 UNLOCK  ${cost.toLocaleString()} ORE`;
    btn.disabled = !canAfford;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _handleWeaponUnlock(id);
    });
    card.appendChild(btn);
    return card;
  }

  // Tracks.
  const tracksWrap = document.createElement('div');
  tracksWrap.className = 'armory-weapon-tracks';
  for (const trackKey of Object.keys(WEAPON_TRACKS)) {
    const track = WEAPON_TRACKS[trackKey];
    const lvl = (armory.weapons && armory.weapons[id] && armory.weapons[id][trackKey]) || 0;
    const cost = lvl < track.maxLevel ? track.cost(lvl) : 0;
    const row = _makeTrackRow({
      label: track.label,
      level: lvl,
      maxLevel: track.maxLevel,
      cost,
      canAfford: getOreBalance() >= cost,
      onBuy: () => _handleWeaponBuy(id, trackKey),
    });
    tracksWrap.appendChild(row);
  }
  card.appendChild(tracksWrap);
  return card;
}

// =====================================================================
// PURCHASE HANDLERS
// =====================================================================
// Each handler mutates persistent state via Save.writeArmory and
// re-renders the panel. Audio feedback on success.

function _handleWeaponUnlock(id) {
  const cur = Save.getArmory();
  const next = tryUnlockWeapon(cur, id);
  if (!next) {
    // Insufficient XP or already unlocked — gentle no-op.
    return;
  }
  Save.writeArmory(next);
  // Audio — reuse the levelup ping for now; armory has no dedicated
  // SFX yet and levelup is a satisfying "you got something" chime.
  try { Audio.levelup && Audio.levelup(); } catch (_) {}
  _render();
}

function _handleWeaponBuy(id, trackKey) {
  const cur = Save.getArmory();
  const next = tryUpgradeWeapon(cur, id, trackKey);
  if (!next) return;
  Save.writeArmory(next);
  try { Audio.levelup && Audio.levelup(); } catch (_) {}
  _render();
}

function _handlePlayerBuy(trackKey) {
  const cur = Save.getArmory();
  const next = tryUpgradePlayer(cur, trackKey);
  if (!next) return;
  Save.writeArmory(next);
  try { Audio.levelup && Audio.levelup(); } catch (_) {}
  _render();
}
