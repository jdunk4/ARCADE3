// ============================================================
// RUN REWARD — End-of-run animated XP tally + level progress bar.
//
// Injected into the #gameover overlay. Shows a top-anchored level
// bar that fills as XP from the run's stats is counted up, plus
// a line-by-line animated tally of what earned the XP. Ores are
// shown as a universal currency that can substitute for avatar
// shards or armory upgrades.
//
// Public API:
//   showRunReward(stats)   — build + animate the reward panel
//   hideRunReward()        — tear down (called on REBOOT)
//   getPlayerLevel()       → { level, xp, xpNext }
//   getOreBalance()        → number
//   spendOre(n)            → boolean (deducts if enough)
// ============================================================

const LS_KEY = 'mbs_player_meta_v1';

// ---- XP TABLE ----
// XP required per level. Grows ~25% per level. Level 1 starts at 0 XP.
function xpForLevel(lvl) {
  if (lvl <= 1) return 0;
  return Math.floor(100 * Math.pow(1.25, lvl - 2));
}

// ---- PERSISTENCE ----
function _read() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : { level: 1, xp: 0, ores: 0 };
  } catch (e) { return { level: 1, xp: 0, ores: 0 }; }
}
function _write(d) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {}
}

// ---- PUBLIC GETTERS ----

export function getPlayerLevel() {
  const d = _read();
  return { level: d.level, xp: d.xp, xpNext: xpForLevel(d.level + 1) };
}

export function getOreBalance() {
  return _read().ores || 0;
}

export function spendOre(n) {
  const d = _read();
  if ((d.ores || 0) < n) return false;
  d.ores -= n;
  _write(d);
  return true;
}

// ---- XP AWARD (internal) ----
function _awardXP(amount) {
  const d = _read();
  d.xp += amount;
  // Level up loop
  let next = xpForLevel(d.level + 1);
  while (next > 0 && d.xp >= next) {
    d.xp -= next;
    d.level++;
    next = xpForLevel(d.level + 1);
  }
  _write(d);
  return d;
}

function _awardOres(n) {
  const d = _read();
  d.ores = (d.ores || 0) + n;
  _write(d);
}

// ---- XP FORMULA ----
// Each stat category earns XP. Returns { lines: [{label, value, xp}], totalXP, oresEarned }
function _computeRewards(stats) {
  const lines = [];
  let totalXP = 0;

  // Score: 1 XP per 500 score
  const scoreXP = Math.floor((stats.score || 0) / 500);
  if (scoreXP > 0) lines.push({ label: 'SCORE', value: (stats.score || 0).toLocaleString(), xp: scoreXP });
  totalXP += scoreXP;

  // Kills: 2 XP per kill
  const killXP = (stats.kills || 0) * 2;
  if (killXP > 0) lines.push({ label: 'KILLS', value: String(stats.kills || 0), xp: killXP });
  totalXP += killXP;

  // Waves survived: 15 XP per wave
  const waveXP = (stats.wave || 1) * 15;
  lines.push({ label: 'WAVES', value: String(stats.wave || 1), xp: waveXP });
  totalXP += waveXP;

  // Chapters completed: 50 XP per chapter
  const chapXP = (stats.chapter || 0) * 50;
  if (chapXP > 0) lines.push({ label: 'CHAPTERS', value: String(stats.chapter || 0), xp: chapXP });
  totalXP += chapXP;

  // Rescues: 10 XP per rescue
  const rescueXP = (stats.rescues || 0) * 10;
  if (rescueXP > 0) lines.push({ label: 'RESCUES', value: String(stats.rescues || 0), xp: rescueXP });
  totalXP += rescueXP;

  // Shards collected: 25 XP per shard
  const shardCount = stats.shards ? stats.shards.length : 0;
  const shardXP = shardCount * 25;
  if (shardXP > 0) lines.push({ label: 'DATA SHARDS', value: String(shardCount), xp: shardXP });
  totalXP += shardXP;

  // Ores: 1 ore per chapter completed + 1 per 100 kills (capped at 3 per run)
  let oresEarned = Math.min(3, (stats.chapter || 0) + Math.floor((stats.kills || 0) / 100));
  if (oresEarned > 0) lines.push({ label: 'ORES MINED', value: '⬡ ' + oresEarned, xp: 0, isOre: true });

  return { lines, totalXP, oresEarned };
}

// ============================================================
// DOM CONSTRUCTION + ANIMATION
// ============================================================

let _rewardEl = null;
let _animTimers = [];

export function hideRunReward() {
  if (_rewardEl && _rewardEl.parentNode) _rewardEl.parentNode.removeChild(_rewardEl);
  _rewardEl = null;
  for (const t of _animTimers) clearTimeout(t);
  _animTimers = [];
}

/**
 * Show the animated end-of-run reward tally.
 * @param {object} stats — { score, kills, wave, chapter, rescues, shards: [] }
 */
export function showRunReward(stats) {
  hideRunReward();

  const { lines, totalXP, oresEarned } = _computeRewards(stats);
  const before = getPlayerLevel();

  // Build DOM
  const el = document.createElement('div');
  el.id = 'run-reward';
  el.style.cssText = [
    'position:absolute', 'top:0', 'left:0', 'right:0',
    'display:flex', 'flex-direction:column', 'align-items:center',
    'padding:18px 24px 14px',
    'background:linear-gradient(180deg,rgba(0,0,0,0.85) 0%,transparent 100%)',
    'font-family:"Courier New",monospace',
    'z-index:5', 'pointer-events:none',
  ].join(';');

  // Level label
  const lvlLabel = document.createElement('div');
  lvlLabel.style.cssText = 'font-size:11px;letter-spacing:5px;color:#888;margin-bottom:6px;';
  lvlLabel.textContent = 'LEVEL ' + before.level;
  lvlLabel.id = 'rr-level';
  el.appendChild(lvlLabel);

  // Bar container
  const barWrap = document.createElement('div');
  barWrap.style.cssText = [
    'width:min(80vw,500px)', 'height:14px',
    'border:1px solid #00ff66', 'border-radius:7px',
    'background:rgba(0,20,10,0.6)', 'overflow:hidden',
    'position:relative', 'margin-bottom:10px',
  ].join(';');
  const barFill = document.createElement('div');
  barFill.id = 'rr-bar';
  barFill.style.cssText = [
    'height:100%', 'border-radius:7px',
    'background:linear-gradient(90deg,#00ff66,#4ff7ff)',
    'box-shadow:0 0 10px #00ff66',
    'transition:width 0.6s ease-out',
    'width:' + (before.xpNext > 0 ? Math.min(100, (before.xp / before.xpNext) * 100) : 100) + '%',
  ].join(';');
  barWrap.appendChild(barFill);
  // XP text on top of bar
  const barText = document.createElement('div');
  barText.id = 'rr-bar-text';
  barText.style.cssText = [
    'position:absolute', 'inset:0',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font-size:9px', 'letter-spacing:2px', 'color:#fff',
    'text-shadow:0 1px 2px #000',
  ].join(';');
  barText.textContent = before.xp + ' / ' + before.xpNext + ' XP';
  barWrap.appendChild(barText);
  el.appendChild(barWrap);

  // Tally lines container
  const tally = document.createElement('div');
  tally.id = 'rr-tally';
  tally.style.cssText = 'display:flex;flex-direction:column;gap:4px;align-items:center;';
  el.appendChild(tally);

  // Inject into #gameover
  const go = document.getElementById('gameover');
  if (go) {
    go.style.position = 'relative';
    go.appendChild(el);
  }
  _rewardEl = el;

  // ---- ANIMATE ----
  let delay = 600; // initial pause
  let runningXP = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    _animTimers.push(setTimeout(() => {
      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'gap:12px', 'align-items:baseline',
        'font-size:12px', 'letter-spacing:3px',
        'opacity:0', 'transform:translateY(8px)',
        'transition:opacity .3s,transform .3s',
      ].join(';');

      const lbl = document.createElement('span');
      lbl.style.color = '#888';
      lbl.textContent = line.label;

      const val = document.createElement('span');
      val.style.cssText = 'color:#fff;font-weight:bold;';
      val.textContent = line.value;

      const xpSpan = document.createElement('span');
      if (line.isOre) {
        xpSpan.style.cssText = 'color:#ffd93d;text-shadow:0 0 6px #ffd93d;';
        xpSpan.textContent = 'ORE';
      } else {
        xpSpan.style.cssText = 'color:#00ff66;text-shadow:0 0 6px #00ff66;';
        xpSpan.textContent = '+' + line.xp + ' XP';
      }

      row.appendChild(lbl);
      row.appendChild(val);
      row.appendChild(xpSpan);
      tally.appendChild(row);

      // Trigger CSS transition
      requestAnimationFrame(() => {
        row.style.opacity = '1';
        row.style.transform = 'translateY(0)';
      });

      // Update bar for this line's XP
      if (line.xp > 0) {
        runningXP += line.xp;
        _updateBar(before, runningXP);
      }
    }, delay));
    delay += 350;
  }

  // Final: total line + commit XP + ores
  _animTimers.push(setTimeout(() => {
    // Total row
    const totalRow = document.createElement('div');
    totalRow.style.cssText = [
      'margin-top:8px', 'padding-top:6px',
      'border-top:1px solid rgba(0,255,102,0.3)',
      'font-size:14px', 'letter-spacing:4px', 'font-weight:bold',
      'color:#00ff66', 'text-shadow:0 0 10px #00ff66',
      'opacity:0', 'transition:opacity .4s',
    ].join(';');
    totalRow.textContent = 'TOTAL +' + totalXP + ' XP';
    if (oresEarned > 0) totalRow.textContent += '  ·  ⬡' + oresEarned + ' ORE';
    tally.appendChild(totalRow);
    requestAnimationFrame(() => { totalRow.style.opacity = '1'; });

    // Actually commit
    if (oresEarned > 0) _awardOres(oresEarned);
    const after = _awardXP(totalXP);

    // Flash level-up if it happened
    if (after.level > before.level) {
      _animTimers.push(setTimeout(() => {
        const lvlUp = document.createElement('div');
        lvlUp.style.cssText = [
          'margin-top:10px',
          'font-family:"Impact",sans-serif',
          'font-size:28px', 'letter-spacing:6px',
          'color:#ffd93d', 'text-shadow:0 0 16px #ffd93d,0 0 32px rgba(255,217,61,0.5)',
          'animation:rr-pulse 0.8s ease-in-out',
        ].join(';');
        lvlUp.textContent = 'LEVEL ' + after.level + '!';
        tally.appendChild(lvlUp);
        lvlLabel.textContent = 'LEVEL ' + after.level;
      }, 600));
    }
  }, delay));
}

// ---- BAR UPDATE (smooth fill during tally) ----
function _updateBar(before, addedXP) {
  const barFill = document.getElementById('rr-bar');
  const barText = document.getElementById('rr-bar-text');
  const lvlLabel = document.getElementById('rr-level');
  if (!barFill) return;

  // Simulate XP addition without committing
  let level = before.level;
  let xp = before.xp + addedXP;
  let next = xpForLevel(level + 1);
  while (next > 0 && xp >= next) {
    xp -= next;
    level++;
    next = xpForLevel(level + 1);
  }

  const pct = next > 0 ? Math.min(100, (xp / next) * 100) : 100;
  barFill.style.width = pct + '%';
  if (barText) barText.textContent = xp + ' / ' + next + ' XP';
  if (lvlLabel && level > before.level) lvlLabel.textContent = 'LEVEL ' + level;
}

// Inject keyframe animation for level-up pulse
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = '@keyframes rr-pulse{0%{transform:scale(0.8);opacity:0}50%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}';
  document.head.appendChild(style);
}
