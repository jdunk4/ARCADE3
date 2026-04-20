import { S } from './state.js';
import { WEAPONS, CHAPTERS, WAVES_PER_CHAPTER } from './config.js';

export const UI = {
  updateHUD() {
    document.getElementById('score').textContent = S.score.toLocaleString();
    document.getElementById('wave-num').textContent = S.wave;
    document.getElementById('kill-num').textContent = S.kills;

    const m = Math.floor(S.timeElapsed / 60);
    const s = Math.floor(S.timeElapsed % 60);
    document.getElementById('time-num').textContent = m + ':' + (s < 10 ? '0' : '') + s;

    document.getElementById('hp-fill').style.width = Math.max(0, (S.hp / S.hpMax) * 100) + '%';
    document.getElementById('xp-fill').style.width = (S.xp / S.xpNext) * 100 + '%';
    document.getElementById('lvl-num').textContent = S.level;
    document.getElementById('weapon-name').textContent = WEAPONS[S.currentWeapon].name;

    // Chapter readout
    const chapEl = document.getElementById('chapter-readout');
    if (chapEl) {
      const chapName = CHAPTERS[S.chapter % CHAPTERS.length].name;
      chapEl.textContent = 'CH.' + (S.chapter + 1) + ' · ' + chapName + ' · W' + S.localWave + '/' + WAVES_PER_CHAPTER;
    }

    // Rescued count
    const rescEl = document.getElementById('rescue-count');
    if (rescEl) rescEl.textContent = S.rescuedCount;
  },

  updateWeaponSlots() {
    document.querySelectorAll('.slot').forEach(el => {
      const slot = el.dataset.slot;
      if (!slot) return;
      el.classList.toggle('owned', S.ownedWeapons.has(slot));
      el.classList.toggle('active', slot === S.currentWeapon);
    });
  },

  toast(text, color = '#ffd93d', duration = 1400) {
    const t = document.getElementById('toast');
    t.textContent = text;
    t.style.color = color;
    t.style.textShadow = `0 0 12px ${color}, 3px 3px 0 #000`;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), duration);
  },

  flashLevelUp() {
    const el = document.getElementById('levelup');
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 900);
  },

  damageFlash() {
    const f = document.getElementById('damage-flash');
    f.style.opacity = '1';
    clearTimeout(f._t);
    f._t = setTimeout(() => f.style.opacity = '0', 120);
  },

  showBossBar(name) {
    document.getElementById('boss-name').textContent = name;
    document.getElementById('boss-bar-fill').style.width = '100%';
    document.getElementById('boss-bar').classList.remove('hidden');
  },

  updateBossBar(pct) {
    document.getElementById('boss-bar-fill').style.width = (pct * 100) + '%';
  },

  hideBossBar() {
    document.getElementById('boss-bar').classList.add('hidden');
  },

  showObjective(title, sub) {
    document.getElementById('obj-title').textContent = title;
    document.getElementById('obj-sub').textContent = sub;
    document.getElementById('objective').classList.remove('hidden');
  },

  hideObjective() {
    document.getElementById('objective').classList.add('hidden');
  },

  showWaveBanner(countdown, subText = 'PREPARE YOURSELF') {
    const b = document.getElementById('wave-banner');
    document.getElementById('wave-banner-title').textContent = 'NEXT WAVE IN';
    document.getElementById('wave-banner-countdown').textContent = countdown;
    document.getElementById('wave-banner-sub').textContent = subText;
    b.classList.remove('hidden');
  },

  showWaveStart(waveNum) {
    const b = document.getElementById('wave-banner');
    document.getElementById('wave-banner-title').textContent = '';
    document.getElementById('wave-banner-countdown').textContent = 'WAVE ' + waveNum;
    document.getElementById('wave-banner-sub').textContent = 'BEGIN';
    b.classList.remove('hidden');
    setTimeout(() => b.classList.add('hidden'), 1500);
  },

  hideWaveBanner() {
    document.getElementById('wave-banner').classList.add('hidden');
  },

  // Show the saved-data panel on the title screen
  populateTitleStats(savedData) {
    const hiEl = document.getElementById('title-highscore');
    const chapEl = document.getElementById('title-highchap');
    const collEl = document.getElementById('title-collection');
    if (hiEl) hiEl.textContent = (savedData.highScore || 0).toLocaleString();
    if (chapEl) chapEl.textContent = (savedData.highestChapter + 1) + ' · Wave ' + (savedData.highestWave || 1);
    if (collEl) collEl.textContent = savedData.rescuedCollection.length + ' / 20000';
  },
};
