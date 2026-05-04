// ============================================================
// RUN REWARD — End-of-run SIGNAL LOST screen with ORE economy.
//
// ORE is the single universal currency:
//   - Earned from run stats (kills, waves, chapters, rescues)
//   - Fills a persistent level bar → level-ups grant bonus ore
//   - Spent on armory upgrades OR cracked into avatar stones
//
// The tally counts up ore earned per stat category. The segmented
// bar fills as ore is awarded. On level-up, stars burst + bonus
// ore is granted.
//
// Public API:
//   showRunReward(stats, callbacks)
//   hideRunReward()
//   getPlayerLevel()  → { level, xp, xpNext }
//   getOreBalance()   → number
//   spendOre(n)       → boolean
//   addOre(n)         → newBalance
// ============================================================

const LS_KEY = 'mbs_player_meta_v2';
const SEGMENTS = 10;

// ---- LEVEL CURVE ----
function xpForLevel(lvl) {
  if (lvl <= 1) return 6;  // 6 ore to hit level 2
  return Math.floor(6 * Math.pow(1.20, lvl - 1));
}

// Bonus ore granted per level-up
function levelUpOreBonus(lvl) {
  return Math.min(5, 1 + Math.floor(lvl / 3));
}

// ---- PERSISTENCE ----
function _read() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { level: 1, xp: 0, ore: 0 };
    const d = JSON.parse(raw);
    return { level: d.level || 1, xp: d.xp || 0, ore: d.ore || 0 };
  } catch (e) { return { level: 1, xp: 0, ore: 0 }; }
}
function _write(d) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {}
}

// ---- PUBLIC GETTERS ----
export function getPlayerLevel() {
  const d = _read();
  return { level: d.level, xp: d.xp, xpNext: xpForLevel(d.level) };
}
export function getOreBalance() { return _read().ore || 0; }
export function spendOre(n) {
  const d = _read();
  if ((d.ore || 0) < n) return false;
  d.ore -= n; _write(d); return true;
}
export function addOre(n) {
  const d = _read();
  d.ore = (d.ore || 0) + n;
  _write(d);
  return d.ore;
}

// ---- INTERNAL: AWARD ORE + LEVEL ----
// Ore earned fills the level bar. Each "ore point" is 1 unit of bar progress.
// Level-ups grant BONUS ore to the player's spendable balance.
function _processOreReward(oreEarned) {
  const d = _read();
  const before = { level: d.level, xp: d.xp, ore: d.ore };
  let levelsGained = 0;
  let bonusOre = 0;

  // Add ore to balance
  d.ore += oreEarned;

  // Fill bar
  d.xp += oreEarned;
  let next = xpForLevel(d.level);
  while (next > 0 && d.xp >= next) {
    d.xp -= next;
    d.level++;
    levelsGained++;
    const bonus = levelUpOreBonus(d.level);
    bonusOre += bonus;
    d.ore += bonus;
    next = xpForLevel(d.level);
  }

  _write(d);
  return { ...d, levelsGained, bonusOre, before };
}

// ---- ORE FORMULA ----
// Returns { lines[], totalOre }
function _computeRewards(stats) {
  const lines = [];
  let totalOre = 0;

  // Score: 1 ore per 1000 score
  const scoreOre = Math.floor((stats.score || 0) / 1000);
  if (scoreOre > 0) { lines.push({ label: 'SCORE', value: (stats.score||0).toLocaleString(), ore: scoreOre }); totalOre += scoreOre; }

  // Kills: 1 ore per 25 kills
  const killOre = Math.floor((stats.kills || 0) / 25);
  if (killOre > 0) { lines.push({ label: 'KILLS', value: String(stats.kills||0), ore: killOre }); totalOre += killOre; }

  // Waves: 1 ore per 2 waves
  const waveOre = Math.floor((stats.wave || 1) / 2);
  if (waveOre > 0) { lines.push({ label: 'WAVES', value: String(stats.wave||1), ore: waveOre }); totalOre += waveOre; }

  // Chapters: 2 ore per chapter completed
  const chapOre = (stats.chapter || 0) * 2;
  if (chapOre > 0) { lines.push({ label: 'CHAPTERS', value: String(stats.chapter||0), ore: chapOre }); totalOre += chapOre; }

  // Rescues: 1 ore per 5 rescues
  const rescueOre = Math.floor((stats.rescues || 0) / 5);
  if (rescueOre > 0) { lines.push({ label: 'RESCUES', value: String(stats.rescues||0), ore: rescueOre }); totalOre += rescueOre; }

  // Avatar stones found (from in-game drops)
  const stones = typeof stats.shards === 'number' ? stats.shards : 0;
  if (stones > 0) { lines.push({ label: 'STONES FOUND', value: '\u2B21 ' + stones, ore: 0, isStone: true }); }

  // Minimum 1 ore per run (participation)
  if (totalOre === 0) { totalOre = 1; lines.push({ label: 'PARTICIPATION', value: '-', ore: 1 }); }

  return { lines, totalOre };
}

// ============================================================
// DOM + ANIMATION
// ============================================================

let _rewardEl = null;
let _animTimers = [];

export function hideRunReward() {
  if (_rewardEl && _rewardEl.parentNode) _rewardEl.parentNode.removeChild(_rewardEl);
  _rewardEl = null;
  for (const t of _animTimers) clearTimeout(t);
  _animTimers = [];
}

export function showRunReward(stats, callbacks = {}) {
  hideRunReward();
  _injectStyles();

  const { lines, totalOre } = _computeRewards(stats);
  const before = _read();
  const beforeXPNext = xpForLevel(before.level);

  const el = document.createElement('div');
  el.id = 'rr-overlay';

  // Header
  el.innerHTML =
    '<div class="rr-header">' +
      '<div class="rr-title">SIGNAL LOST</div>' +
      '<div class="rr-sub">:: CONNECTION TERMINATED ::</div>' +
    '</div>';

  // Level + Bar
  const barSection = document.createElement('div');
  barSection.className = 'rr-bar-section';

  const lvlBadge = document.createElement('div');
  lvlBadge.className = 'rr-level-badge';
  lvlBadge.id = 'rr-level-badge';
  lvlBadge.textContent = before.level;
  barSection.appendChild(lvlBadge);

  const barTrack = document.createElement('div');
  barTrack.className = 'rr-bar-track';
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = document.createElement('div');
    seg.className = 'rr-seg';
    seg.id = 'rr-seg-' + i;
    barTrack.appendChild(seg);
  }
  barSection.appendChild(barTrack);

  const nextBadge = document.createElement('div');
  nextBadge.className = 'rr-next-badge';
  nextBadge.id = 'rr-next-badge';
  nextBadge.textContent = before.level + 1;
  barSection.appendChild(nextBadge);
  el.appendChild(barSection);

  // Bar text
  const xpText = document.createElement('div');
  xpText.className = 'rr-xp-text';
  xpText.id = 'rr-xp-text';
  xpText.textContent = before.xp + ' / ' + beforeXPNext + ' ORE';
  el.appendChild(xpText);

  // Stars container
  const starsEl = document.createElement('div');
  starsEl.className = 'rr-stars';
  starsEl.id = 'rr-stars';
  el.appendChild(starsEl);

  // Ore balance
  const balEl = document.createElement('div');
  balEl.className = 'rr-balance';
  balEl.id = 'rr-balance';
  balEl.innerHTML = '<span class="rr-ore-icon"></span> ' + before.ore + ' ORE';
  el.appendChild(balEl);

  // Tally
  const tally = document.createElement('div');
  tally.className = 'rr-tally';
  tally.id = 'rr-tally';
  el.appendChild(tally);

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'rr-buttons';
  btnRow.innerHTML =
    '<button class="rr-btn rr-btn-reboot" id="rr-btn-reboot">\u21BB REBOOT</button>' +
    '<button class="rr-btn rr-btn-avatar" id="rr-btn-avatar">\u263A AVATAR</button>' +
    '<button class="rr-btn rr-btn-armory" id="rr-btn-armory">\u2699 ARMORY</button>' +
    '<button class="rr-btn rr-btn-menu" id="rr-btn-menu">\u2302 MAIN MENU</button>';
  el.appendChild(btnRow);

  // Inject into #gameover
  const go = document.getElementById('gameover');
  if (go) {
    for (const child of go.children) {
      if (child.id !== 'rr-overlay') child.style.display = 'none';
    }
    go.appendChild(el);
  }
  _rewardEl = el;

  // Wire buttons
  el.querySelector('#rr-btn-reboot').addEventListener('click', () => {
    _teardownAndRestore();
    if (callbacks.onReboot) callbacks.onReboot();
    else { const orig = document.getElementById('restart-btn'); if (orig) orig.click(); }
  });
  el.querySelector('#rr-btn-avatar').addEventListener('click', () => {
    // Don't teardown — keep the reward overlay in the DOM. The callback
    // hides #gameover; when the avatar picker closes it re-shows gameover
    // and the reward overlay is still there.
    if (callbacks.onAvatar) callbacks.onAvatar();
  });
  el.querySelector('#rr-btn-armory').addEventListener('click', () => {
    // Same as avatar — don't teardown. Armory close returns to gameover.
    if (callbacks.onArmory) callbacks.onArmory();
  });
  el.querySelector('#rr-btn-menu').addEventListener('click', () => {
    _teardownAndRestore();
    if (callbacks.onMainMenu) callbacks.onMainMenu();
  });

  // Set initial bar
  _fillSegments(before.xp, beforeXPNext);

  // ---- ANIMATE TALLY ----
  let delay = 500;
  let runningOre = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    _animTimers.push(setTimeout(() => {
      _addTallyLine(line);
      if (line.ore > 0) {
        runningOre += line.ore;
        _animateBarTo(before, runningOre);
      }
    }, delay));
    delay += 400;
  }

  // Final commit
  _animTimers.push(setTimeout(() => {
    const totalRow = document.createElement('div');
    totalRow.className = 'rr-tally-total';
    totalRow.innerHTML = '<span class="rr-ore-icon"></span> +' + totalOre + ' ORE';
    const tallyEl = document.getElementById('rr-tally');
    if (tallyEl) tallyEl.appendChild(totalRow);
    requestAnimationFrame(() => { totalRow.style.opacity = '1'; });

    const result = _processOreReward(totalOre);

    // Update balance display
    const bal = document.getElementById('rr-balance');
    if (bal) bal.innerHTML = '<span class="rr-ore-icon"></span> ' + result.ore + ' ORE';

    if (result.levelsGained > 0) {
      _animTimers.push(setTimeout(() => _showStars(result.levelsGained, result.level, result.bonusOre), 500));
    }
  }, delay));
}

// ---- HELPERS ----

function _teardownAndRestore() {
  hideRunReward();
  const go = document.getElementById('gameover');
  if (go) { for (const child of go.children) child.style.display = ''; }
}

function _fillSegments(xp, xpNext) {
  const frac = xpNext > 0 ? Math.min(1, xp / xpNext) : 1;
  const filled = Math.floor(frac * SEGMENTS);
  const partial = (frac * SEGMENTS) - filled;
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = document.getElementById('rr-seg-' + i);
    if (!seg) continue;
    if (i < filled) {
      seg.style.background = _segColor(i);
      seg.style.boxShadow = '0 0 8px ' + _segColor(i);
    } else if (i === filled && partial > 0.05) {
      seg.style.background = 'linear-gradient(90deg, ' + _segColor(i) + ' ' + (partial*100) + '%, rgba(255,255,255,0.06) ' + (partial*100) + '%)';
      seg.style.boxShadow = 'none';
    } else {
      seg.style.background = 'rgba(255,255,255,0.06)';
      seg.style.boxShadow = 'none';
    }
  }
}

// Rainbow ore colors matching the 6 chapter palette, spread across 10 segments
function _segColor(i) {
  return '#ffd93d';
}

function _animateBarTo(before, addedOre) {
  let level = before.level;
  let xp = before.xp + addedOre;
  let next = xpForLevel(level);
  while (next > 0 && xp >= next) { xp -= next; level++; next = xpForLevel(level); }
  _fillSegments(xp, next);
  const xpTextEl = document.getElementById('rr-xp-text');
  if (xpTextEl) xpTextEl.textContent = xp + ' / ' + next + ' ORE';
  const badge = document.getElementById('rr-level-badge');
  if (badge && parseInt(badge.textContent) !== level) {
    badge.textContent = level;
    badge.classList.add('rr-level-pop');
    setTimeout(() => badge.classList.remove('rr-level-pop'), 600);
  }
  const nextB = document.getElementById('rr-next-badge');
  if (nextB) nextB.textContent = level + 1;
}

function _addTallyLine(line) {
  const tallyEl = document.getElementById('rr-tally');
  if (!tallyEl) return;
  const row = document.createElement('div');
  row.className = 'rr-tally-row';

  const lbl = document.createElement('span');
  lbl.className = 'rr-t-label';
  lbl.textContent = line.label;

  const val = document.createElement('span');
  val.className = 'rr-t-value';
  val.textContent = line.value;

  const reward = document.createElement('span');
  if (line.isStone) {
    reward.className = 'rr-t-stone';
    reward.textContent = 'STONE';
  } else {
    reward.className = 'rr-t-ore';
    reward.innerHTML = '<span class="rr-ore-icon-sm"></span>+' + line.ore;
  }

  row.appendChild(lbl);
  row.appendChild(val);
  row.appendChild(reward);
  tallyEl.appendChild(row);
  requestAnimationFrame(() => { row.style.opacity = '1'; row.style.transform = 'translateY(0)'; });
}

function _showStars(count, newLevel, bonusOre) {
  const starsEl = document.getElementById('rr-stars');
  if (!starsEl) return;
  starsEl.style.display = 'flex';

  const starRow = document.createElement('div');
  starRow.style.cssText = 'display:flex;gap:6px;';
  const starCount = Math.min(3, count);
  for (let i = 0; i < 3; i++) {
    const star = document.createElement('div');
    star.className = 'rr-star' + (i < starCount ? ' rr-star-filled' : '');
    star.style.animationDelay = (i * 200) + 'ms';
    starRow.appendChild(star);
  }
  starsEl.appendChild(starRow);

  const lvlText = document.createElement('div');
  lvlText.className = 'rr-levelup-text';
  lvlText.textContent = 'LEVEL ' + newLevel;
  starsEl.appendChild(lvlText);

  if (bonusOre > 0) {
    const bonusText = document.createElement('div');
    bonusText.className = 'rr-bonus-ore';
    bonusText.innerHTML = '<span class="rr-ore-icon"></span> +' + bonusOre + ' BONUS ORE';
    starsEl.appendChild(bonusText);
  }
}

// ---- STYLES ----
let _stylesInjected = false;
function _injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
#rr-overlay{display:flex;flex-direction:column;align-items:center;gap:12px;width:100%;max-width:600px;font-family:'Courier New',monospace}
.rr-header{text-align:center;margin-bottom:4px}
.rr-title{font-family:'Impact',monospace;font-size:clamp(42px,8vw,72px);letter-spacing:6px;color:#ff3cac;text-shadow:0 0 16px #ff3cac,0 0 40px rgba(255,60,172,.7),4px 4px 0 #000;line-height:.95}
.rr-sub{font-size:14px;letter-spacing:6px;color:#00ff66;text-shadow:0 0 8px #00ff66;margin-top:8px}
.rr-bar-section{display:flex;align-items:center;gap:10px;width:100%;margin:8px 0 2px}
.rr-level-badge,.rr-next-badge{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-family:'Impact',monospace;font-size:18px;letter-spacing:1px;font-weight:bold;flex-shrink:0}
.rr-level-badge{background:linear-gradient(135deg,#ffd93d,#ffaa00);color:#000;box-shadow:0 0 12px rgba(255,217,61,.6);transition:transform .3s}
.rr-level-badge.rr-level-pop{animation:rr-pop .5s ease-out}
.rr-next-badge{background:rgba(255,255,255,.12);color:#666;border:1px solid #444}
.rr-bar-track{flex:1;height:22px;display:flex;gap:3px;background:rgba(0,0,0,.5);border:2px solid #665520;border-radius:6px;padding:3px;box-shadow:inset 0 2px 6px rgba(0,0,0,.6)}
.rr-seg{flex:1;border-radius:3px;background:rgba(255,255,255,.06);transition:background .5s ease-out,box-shadow .5s ease-out}
.rr-xp-text{font-size:11px;letter-spacing:3px;color:#888;margin-top:-4px}
.rr-balance{font-size:14px;letter-spacing:4px;color:#ffd93d;text-shadow:0 0 8px rgba(255,217,61,.4);display:flex;align-items:center;gap:6px}
.rr-ore-icon{display:inline-block;width:16px;height:16px;background:conic-gradient(#ff6a1a,#ff2e4d,#ffd93d,#00ff66,#4ff7ff,#e63aff,#ff6a1a);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);vertical-align:middle}
.rr-ore-icon-sm{display:inline-block;width:12px;height:12px;background:conic-gradient(#ff6a1a,#ff2e4d,#ffd93d,#00ff66,#4ff7ff,#e63aff,#ff6a1a);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);vertical-align:middle;margin-right:3px}
.rr-stars{display:none;flex-direction:column;align-items:center;gap:8px;margin:6px 0}
.rr-star{width:28px;height:28px;clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%);background:#333;animation:rr-star-in .5s ease-out backwards}
.rr-star-filled{background:linear-gradient(135deg,#ffd93d,#ffaa00);filter:drop-shadow(0 0 6px #ffd93d)}
.rr-levelup-text{font-family:'Impact',monospace;font-size:22px;letter-spacing:5px;color:#ffd93d;text-shadow:0 0 12px #ffd93d,0 0 24px rgba(255,217,61,.4);animation:rr-pop .6s ease-out .6s backwards}
.rr-bonus-ore{font-size:13px;letter-spacing:3px;color:#ffd93d;text-shadow:0 0 6px rgba(255,217,61,.3);display:flex;align-items:center;gap:4px;animation:rr-pop .5s ease-out .9s backwards}
.rr-tally{display:flex;flex-direction:column;gap:5px;width:100%;max-width:400px}
.rr-tally-row{display:flex;justify-content:space-between;align-items:baseline;padding:3px 8px;font-size:12px;letter-spacing:2px;opacity:0;transform:translateY(6px);transition:opacity .3s,transform .3s;border-bottom:1px solid rgba(255,255,255,.05)}
.rr-t-label{color:#888;flex:1}
.rr-t-value{color:#fff;font-weight:bold;margin-right:12px}
.rr-t-ore{color:#ffd93d;text-shadow:0 0 6px #ffd93d;font-weight:bold;display:flex;align-items:center;gap:2px}
.rr-t-stone{color:#e63aff;text-shadow:0 0 6px #e63aff;font-weight:bold}
.rr-tally-total{text-align:center;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,217,61,.25);font-size:15px;letter-spacing:4px;font-weight:bold;color:#ffd93d;text-shadow:0 0 10px #ffd93d;opacity:0;transition:opacity .5s;display:flex;align-items:center;justify-content:center;gap:6px}
.rr-buttons{display:flex;gap:12px;margin-top:16px;flex-wrap:wrap;justify-content:center}
.rr-btn{font-family:'Impact',monospace;font-size:16px;letter-spacing:4px;padding:12px 28px;background:transparent;border:2px solid;cursor:pointer;transition:all .2s;text-transform:uppercase}
.rr-btn:hover{transform:scale(1.05)}
.rr-btn-reboot{color:#4ff7ff;border-color:#4ff7ff;box-shadow:0 0 12px rgba(79,247,255,.3);animation:blink 1.2s ease-in-out infinite}
.rr-btn-reboot:hover{background:#4ff7ff;color:#000}
.rr-btn-avatar{color:#ffd93d;border-color:#ffd93d;box-shadow:0 0 12px rgba(255,217,61,.2)}
.rr-btn-avatar:hover{background:#ffd93d;color:#000}
.rr-btn-armory{color:#ff8800;border-color:#ff8800;box-shadow:0 0 12px rgba(255,136,0,.2)}
.rr-btn-armory:hover{background:linear-gradient(135deg,#ff8800,#ff3cac);color:#fff;border-color:#ff8800}
.rr-btn-menu{color:#888;border-color:#555}
.rr-btn-menu:hover{background:#333;color:#ccc;border-color:#888}
@keyframes rr-pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
@keyframes rr-star-in{0%{transform:scale(0) rotate(-30deg);opacity:0}100%{transform:scale(1) rotate(0deg);opacity:1}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.6}}
@media(max-width:500px){.rr-title{font-size:36px!important}.rr-btn{font-size:13px;padding:10px 18px}.rr-tally-row{font-size:11px}}
`;
  document.head.appendChild(s);
}
