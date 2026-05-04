// ============================================================
// RUN REWARD — End-of-run progression screen on SIGNAL LOST.
//
// Replaces the #gameover overlay content with:
//   1. SIGNAL LOST header (preserved)
//   2. Segmented XP progress bar that fills animated
//   3. Star burst when the bar completes a level
//   4. Line-by-line stat tally with XP + ORE rewards
//   5. Three navigation buttons: REBOOT · AVATAR · MAIN MENU
//
// All state (level, XP, ores) persists in localStorage.
// ============================================================

const LS_KEY = 'mbs_player_meta_v1';
const SEGMENTS = 10;  // number of bar segments

// ---- XP CURVE ----
function xpForLevel(lvl) {
  if (lvl <= 1) return 100;
  return Math.floor(100 * Math.pow(1.22, lvl - 1));
}

// ---- PERSISTENCE ----
function _read() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { level: 1, xp: 0, ores: 0 };
    const d = JSON.parse(raw);
    return { level: d.level || 1, xp: d.xp || 0, ores: d.ores || 0 };
  } catch (e) { return { level: 1, xp: 0, ores: 0 }; }
}
function _write(d) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {}
}

// ---- PUBLIC GETTERS ----
export function getPlayerLevel() {
  const d = _read();
  return { level: d.level, xp: d.xp, xpNext: xpForLevel(d.level) };
}
export function getOreBalance() { return _read().ores || 0; }
export function spendOre(n) {
  const d = _read();
  if ((d.ores || 0) < n) return false;
  d.ores -= n; _write(d); return true;
}

// ---- INTERNAL AWARD ----
function _awardXP(amount) {
  const d = _read();
  d.xp += amount;
  let levelsGained = 0;
  let next = xpForLevel(d.level);
  while (next > 0 && d.xp >= next) {
    d.xp -= next;
    d.level++;
    levelsGained++;
    next = xpForLevel(d.level);
  }
  _write(d);
  return { ...d, levelsGained };
}
function _awardOres(n) {
  const d = _read();
  d.ores = (d.ores || 0) + n;
  _write(d);
}

// ---- XP FORMULA ----
function _computeRewards(stats) {
  const lines = [];
  let totalXP = 0;

  const scoreXP = Math.floor((stats.score || 0) / 500);
  if (scoreXP > 0) { lines.push({ label: 'SCORE', value: (stats.score||0).toLocaleString(), xp: scoreXP }); totalXP += scoreXP; }

  const killXP = (stats.kills || 0) * 2;
  if (killXP > 0) { lines.push({ label: 'KILLS', value: String(stats.kills||0), xp: killXP }); totalXP += killXP; }

  const waveXP = (stats.wave || 1) * 15;
  lines.push({ label: 'WAVES', value: String(stats.wave||1), xp: waveXP }); totalXP += waveXP;

  const chapXP = (stats.chapter || 0) * 50;
  if (chapXP > 0) { lines.push({ label: 'CHAPTERS', value: String(stats.chapter||0), xp: chapXP }); totalXP += chapXP; }

  const rescueXP = (stats.rescues || 0) * 10;
  if (rescueXP > 0) { lines.push({ label: 'RESCUES', value: String(stats.rescues||0), xp: rescueXP }); totalXP += rescueXP; }

  const stoneCount = typeof stats.shards === 'number' ? stats.shards : (stats.shards ? stats.shards.length : 0);
  const stoneXP = stoneCount * 25;
  if (stoneCount > 0) { lines.push({ label: 'AVATAR STONES', value: '\u2B21 ' + stoneCount, xp: stoneXP }); totalXP += stoneXP; }

  let oresEarned = Math.min(3, (stats.chapter || 0) + Math.floor((stats.kills || 0) / 100));
  if (oresEarned > 0) lines.push({ label: 'ORE MINED', value: '\u2B21 ' + oresEarned, xp: 0, isOre: true });

  return { lines, totalXP, oresEarned };
}

// ============================================================
// DOM + ANIMATION
// ============================================================

let _rewardEl = null;
let _animTimers = [];
let _onReboot = null;
let _onAvatar = null;
let _onMainMenu = null;

export function hideRunReward() {
  if (_rewardEl && _rewardEl.parentNode) _rewardEl.parentNode.removeChild(_rewardEl);
  _rewardEl = null;
  for (const t of _animTimers) clearTimeout(t);
  _animTimers = [];
}

/**
 * @param {object} stats - { score, kills, wave, chapter, rescues, shards }
 * @param {object} callbacks - { onReboot, onAvatar, onMainMenu }
 */
export function showRunReward(stats, callbacks = {}) {
  hideRunReward();
  _onReboot = callbacks.onReboot || null;
  _onAvatar = callbacks.onAvatar || null;
  _onMainMenu = callbacks.onMainMenu || null;

  const { lines, totalXP, oresEarned } = _computeRewards(stats);
  const before = _read();
  const beforeXPNext = xpForLevel(before.level);

  // Inject styles
  _injectStyles();

  // Build the reward overlay
  const el = document.createElement('div');
  el.id = 'rr-overlay';

  // Header
  el.innerHTML =
    '<div class="rr-header">' +
      '<div class="rr-title">SIGNAL LOST</div>' +
      '<div class="rr-sub">:: CONNECTION TERMINATED ::</div>' +
    '</div>';

  // Level + Bar section
  const barSection = document.createElement('div');
  barSection.className = 'rr-bar-section';

  const lvlBadge = document.createElement('div');
  lvlBadge.className = 'rr-level-badge';
  lvlBadge.id = 'rr-level-badge';
  lvlBadge.textContent = before.level;
  barSection.appendChild(lvlBadge);

  const barTrack = document.createElement('div');
  barTrack.className = 'rr-bar-track';
  // Build segments
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

  // XP text
  const xpText = document.createElement('div');
  xpText.className = 'rr-xp-text';
  xpText.id = 'rr-xp-text';
  xpText.textContent = before.xp + ' / ' + beforeXPNext + ' XP';
  el.appendChild(xpText);

  // Stars container (hidden until level up)
  const starsEl = document.createElement('div');
  starsEl.className = 'rr-stars';
  starsEl.id = 'rr-stars';
  el.appendChild(starsEl);

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
    '<button class="rr-btn rr-btn-menu" id="rr-btn-menu">\u2302 MAIN MENU</button>';
  el.appendChild(btnRow);

  // Hide original gameover content, inject ours
  const go = document.getElementById('gameover');
  if (go) {
    // Hide original children
    for (const child of go.children) {
      if (child.id !== 'rr-overlay') child.style.display = 'none';
    }
    go.appendChild(el);
  } else {
    document.body.appendChild(el);
  }
  _rewardEl = el;

  // Wire buttons
  const rebootBtn = el.querySelector('#rr-btn-reboot');
  const avatarBtn = el.querySelector('#rr-btn-avatar');
  const menuBtn = el.querySelector('#rr-btn-menu');
  if (rebootBtn) rebootBtn.addEventListener('click', () => {
    _teardownAndRestore();
    if (_onReboot) _onReboot();
    // Also click the original restart button for compatibility
    const orig = document.getElementById('restart-btn');
    if (orig && !_onReboot) orig.click();
  });
  if (avatarBtn) avatarBtn.addEventListener('click', () => {
    _teardownAndRestore();
    if (_onAvatar) _onAvatar();
  });
  if (menuBtn) menuBtn.addEventListener('click', () => {
    _teardownAndRestore();
    if (_onMainMenu) _onMainMenu();
  });

  // Set initial bar fill
  _fillSegments(before.xp, beforeXPNext);

  // ---- ANIMATE TALLY ----
  let delay = 500;
  let runningXP = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    _animTimers.push(setTimeout(() => {
      _addTallyLine(line);
      if (line.xp > 0) {
        runningXP += line.xp;
        _animateBarTo(before, runningXP);
      }
    }, delay));
    delay += 400;
  }

  // Final total + commit
  _animTimers.push(setTimeout(() => {
    // Total row
    const totalRow = document.createElement('div');
    totalRow.className = 'rr-tally-total';
    totalRow.textContent = '+' + totalXP + ' XP';
    if (oresEarned > 0) totalRow.textContent += '  \u00B7  \u2B21' + oresEarned + ' ORE';
    const tallyEl = document.getElementById('rr-tally');
    if (tallyEl) tallyEl.appendChild(totalRow);
    requestAnimationFrame(() => { totalRow.style.opacity = '1'; });

    // Commit
    if (oresEarned > 0) _awardOres(oresEarned);
    const after = _awardXP(totalXP);

    // Stars if leveled up
    if (after.levelsGained > 0) {
      _animTimers.push(setTimeout(() => _showStars(after.levelsGained, after.level), 500));
    }
  }, delay));
}

// ---- HELPERS ----

function _teardownAndRestore() {
  hideRunReward();
  const go = document.getElementById('gameover');
  if (go) {
    for (const child of go.children) child.style.display = '';
  }
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

function _segColor(i) {
  // Gradient from cyan → green → yellow → orange → red across segments
  const colors = ['#4ff7ff','#3de8cc','#2dd99a','#44ee66','#66ff44','#aaee22','#ddcc11','#eea822','#ee7733','#ee4444'];
  return colors[i % colors.length];
}

function _animateBarTo(before, addedXP) {
  let level = before.level;
  let xp = before.xp + addedXP;
  let next = xpForLevel(level);
  while (next > 0 && xp >= next) {
    xp -= next;
    level++;
    next = xpForLevel(level);
  }
  _fillSegments(xp, next);
  const xpTextEl = document.getElementById('rr-xp-text');
  if (xpTextEl) xpTextEl.textContent = xp + ' / ' + next + ' XP';
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
  if (line.isOre) {
    reward.className = 'rr-t-ore';
    reward.textContent = 'ORE';
  } else {
    reward.className = 'rr-t-xp';
    reward.textContent = '+' + line.xp;
  }

  row.appendChild(lbl);
  row.appendChild(val);
  row.appendChild(reward);
  tallyEl.appendChild(row);
  requestAnimationFrame(() => { row.style.opacity = '1'; row.style.transform = 'translateY(0)'; });
}

function _showStars(count, newLevel) {
  const starsEl = document.getElementById('rr-stars');
  if (!starsEl) return;
  starsEl.style.display = 'flex';

  // 3 stars — filled based on levels gained (1=1star, 2=2stars, 3+=3stars)
  const starCount = Math.min(3, count);
  for (let i = 0; i < 3; i++) {
    const star = document.createElement('div');
    star.className = 'rr-star';
    if (i < starCount) star.classList.add('rr-star-filled');
    star.style.animationDelay = (i * 200) + 'ms';
    starsEl.appendChild(star);
  }

  // Level up text
  const lvlText = document.createElement('div');
  lvlText.className = 'rr-levelup-text';
  lvlText.textContent = 'LEVEL ' + newLevel;
  starsEl.appendChild(lvlText);
}

// ---- STYLES ----
let _stylesInjected = false;
function _injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
#rr-overlay {
  display: flex; flex-direction: column; align-items: center;
  gap: 14px; width: 100%; max-width: 600px;
  font-family: 'Courier New', monospace;
}
.rr-header { text-align: center; margin-bottom: 4px; }
.rr-title {
  font-family: 'Impact', monospace;
  font-size: clamp(42px, 8vw, 72px);
  letter-spacing: 6px;
  color: #ff3cac;
  text-shadow: 0 0 16px #ff3cac, 0 0 40px rgba(255,60,172,0.7), 4px 4px 0 #000;
  line-height: 0.95;
}
.rr-sub {
  font-size: 14px; letter-spacing: 6px; color: #00ff66;
  text-shadow: 0 0 8px #00ff66; margin-top: 8px;
}

/* ---- BAR ---- */
.rr-bar-section {
  display: flex; align-items: center; gap: 10px;
  width: 100%; margin: 8px 0 2px;
}
.rr-level-badge, .rr-next-badge {
  width: 36px; height: 36px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-family: 'Impact', monospace;
  font-size: 18px; letter-spacing: 1px;
  color: #000; font-weight: bold;
  flex-shrink: 0;
}
.rr-level-badge {
  background: linear-gradient(135deg, #ffd93d, #ffaa00);
  box-shadow: 0 0 12px rgba(255,217,61,0.6);
  transition: transform 0.3s;
}
.rr-level-badge.rr-level-pop {
  animation: rr-pop 0.5s ease-out;
}
.rr-next-badge {
  background: rgba(255,255,255,0.12);
  color: #666; border: 1px solid #444;
}
.rr-bar-track {
  flex: 1; height: 22px;
  display: flex; gap: 3px;
  background: rgba(0,0,0,0.5);
  border: 2px solid #333;
  border-radius: 6px;
  padding: 3px;
  box-shadow: inset 0 2px 6px rgba(0,0,0,0.6);
}
.rr-seg {
  flex: 1;
  border-radius: 3px;
  background: rgba(255,255,255,0.06);
  transition: background 0.5s ease-out, box-shadow 0.5s ease-out;
}
.rr-xp-text {
  font-size: 11px; letter-spacing: 3px; color: #888;
  margin-top: -4px;
}

/* ---- STARS ---- */
.rr-stars {
  display: none; flex-direction: column; align-items: center;
  gap: 8px; margin: 6px 0;
}
.rr-stars > div:first-child { display: flex; gap: 6px; }
.rr-star {
  width: 28px; height: 28px;
  clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
  background: #333;
  transition: background 0.3s, filter 0.3s;
  animation: rr-star-in 0.5s ease-out backwards;
}
.rr-star-filled {
  background: linear-gradient(135deg, #ffd93d, #ffaa00);
  filter: drop-shadow(0 0 6px #ffd93d);
}
.rr-levelup-text {
  font-family: 'Impact', monospace;
  font-size: 22px; letter-spacing: 5px;
  color: #ffd93d;
  text-shadow: 0 0 12px #ffd93d, 0 0 24px rgba(255,217,61,0.4);
  animation: rr-pop 0.6s ease-out 0.6s backwards;
}

/* ---- TALLY ---- */
.rr-tally {
  display: flex; flex-direction: column; gap: 5px;
  width: 100%; max-width: 400px;
}
.rr-tally-row {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 3px 8px;
  font-size: 12px; letter-spacing: 2px;
  opacity: 0; transform: translateY(6px);
  transition: opacity 0.3s, transform 0.3s;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.rr-t-label { color: #888; flex: 1; }
.rr-t-value { color: #fff; font-weight: bold; margin-right: 12px; }
.rr-t-xp { color: #00ff66; text-shadow: 0 0 6px #00ff66; font-weight: bold; }
.rr-t-ore { color: #ffd93d; text-shadow: 0 0 6px #ffd93d; font-weight: bold; }
.rr-tally-total {
  text-align: center; margin-top: 8px; padding-top: 8px;
  border-top: 1px solid rgba(0,255,102,0.25);
  font-size: 15px; letter-spacing: 4px; font-weight: bold;
  color: #00ff66; text-shadow: 0 0 10px #00ff66;
  opacity: 0; transition: opacity 0.5s;
}

/* ---- BUTTONS ---- */
.rr-buttons {
  display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap;
  justify-content: center;
}
.rr-btn {
  font-family: 'Impact', monospace;
  font-size: 16px; letter-spacing: 4px;
  padding: 12px 28px;
  background: transparent;
  border: 2px solid;
  cursor: pointer;
  transition: all 0.2s;
  text-transform: uppercase;
}
.rr-btn:hover { transform: scale(1.05); }
.rr-btn-reboot {
  color: #4ff7ff; border-color: #4ff7ff;
  box-shadow: 0 0 12px rgba(79,247,255,0.3);
  animation: blink 1.2s ease-in-out infinite;
}
.rr-btn-reboot:hover { background: #4ff7ff; color: #000; }
.rr-btn-avatar {
  color: #ffd93d; border-color: #ffd93d;
  box-shadow: 0 0 12px rgba(255,217,61,0.2);
}
.rr-btn-avatar:hover { background: #ffd93d; color: #000; }
.rr-btn-menu {
  color: #888; border-color: #555;
}
.rr-btn-menu:hover { background: #333; color: #ccc; border-color: #888; }

@keyframes rr-pop {
  0% { transform: scale(0.6); opacity: 0; }
  60% { transform: scale(1.15); }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes rr-star-in {
  0% { transform: scale(0) rotate(-30deg); opacity: 0; }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
@media(max-width:500px) {
  .rr-title { font-size: 36px !important; }
  .rr-btn { font-size: 13px; padding: 10px 18px; }
  .rr-tally-row { font-size: 11px; }
}
`;
  document.head.appendChild(s);
}
