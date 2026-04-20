import * as THREE from 'three';
import { S } from './state.js';
import { WEAPONS, CHAPTERS, WAVES_PER_CHAPTER, BLOCK_CONFIG } from './config.js';

// Reusable scratch vectors
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();

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

    const chapEl = document.getElementById('chapter-readout');
    if (chapEl) {
      const chapName = CHAPTERS[S.chapter % CHAPTERS.length].name;
      chapEl.textContent = 'CH.' + (S.chapter + 1) + ' · ' + chapName + ' · W' + S.localWave + '/' + WAVES_PER_CHAPTER;
    }

    const rescEl = document.getElementById('rescue-count');
    if (rescEl) rescEl.textContent = S.rescuedCount;

    // Username in player panel
    const unEl = document.getElementById('player-name');
    if (unEl) {
      let txt = S.username || 'GUEST';
      if (S.playerMeebitId != null) txt += ' · MEEBIT #' + S.playerMeebitId;
      if (S.playerMeebitSource === 'owned') txt += ' ✓';
      else if (S.playerMeebitSource === 'delegated') txt += ' ⇆';
      unEl.textContent = txt;
    }
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

  populateTitleStats(savedData) {
    const hiEl = document.getElementById('title-highscore');
    const chapEl = document.getElementById('title-highchap');
    const collEl = document.getElementById('title-collection');
    const unEl = document.getElementById('title-username');
    if (hiEl) hiEl.textContent = (savedData.highScore || 0).toLocaleString();
    if (chapEl) chapEl.textContent = (savedData.highestChapter + 1) + ' · Wave ' + (savedData.highestWave || 1);
    if (collEl) collEl.textContent = savedData.rescuedCollection.length + ' / 20000';
    if (unEl) unEl.textContent = savedData.username || 'GUEST';
  },

  // -------------------------------------------------------------------
  // RESCUE ARROW — DOM element that points at the rescue meebit when
  // they are off-screen. Hides when they are visible.
  // -------------------------------------------------------------------
  updateRescueArrow(meebit, camera) {
    const arrow = document.getElementById('rescue-arrow');
    if (!arrow) return;
    if (!meebit || meebit.removed || meebit.freed || meebit.killed) {
      arrow.style.display = 'none';
      return;
    }
    _v3.set(meebit.pos.x, 1.5, meebit.pos.z);
    _v3.project(camera);
    // If inside viewport margin, hide the arrow
    if (Math.abs(_v3.x) < 0.85 && Math.abs(_v3.y) < 0.85 && _v3.z < 1) {
      arrow.style.display = 'none';
      return;
    }

    // Clamp to viewport edge
    const margin = 0.9;
    let x = _v3.x;
    let y = _v3.y;
    // Behind camera — invert so it points correctly
    if (_v3.z > 1) { x = -x; y = -y; }

    const max = Math.max(Math.abs(x), Math.abs(y));
    if (max > margin) {
      x = (x / max) * margin;
      y = (y / max) * margin;
    }

    const sx = (x + 1) * 0.5 * window.innerWidth;
    const sy = (-y + 1) * 0.5 * window.innerHeight;
    const angle = Math.atan2(-y, x);

    arrow.style.display = 'flex';
    arrow.style.left = sx + 'px';
    arrow.style.top = sy + 'px';
    arrow.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;

    // Cage HP on the arrow
    const hpPct = Math.max(0, meebit.cageHp / meebit.cageHpMax);
    const hpEl = document.getElementById('rescue-arrow-hp');
    if (hpEl) hpEl.style.width = (hpPct * 100) + '%';
    // Progress (yellow fill) on the arrow
    const prEl = document.getElementById('rescue-arrow-progress');
    if (prEl) {
      const progPct = meebit.rescueTarget > 0
        ? Math.min(1, meebit.rescueProgress / meebit.rescueTarget)
        : 0;
      prEl.style.width = (progPct * 100) + '%';
    }

    // Panic color when cage is low
    arrow.classList.toggle('panic', hpPct < 0.33);
  },

  // -------------------------------------------------------------------
  // BLOCK HP PIPS — small indicator floating over each mineable block.
  // We pool/reuse DOM nodes; one element per block.
  // -------------------------------------------------------------------
  updateBlockHPPips(blocksArr, camera) {
    const layer = document.getElementById('block-hp-layer');
    if (!layer) return;

    // Ensure child count matches blocksArr length (create or hide extras)
    const grounded = blocksArr.filter(b => !b.falling);
    while (layer.children.length < grounded.length) {
      const pip = document.createElement('div');
      pip.className = 'block-hp-pip';
      pip.innerHTML = '<span></span><span></span><span></span>';
      layer.appendChild(pip);
    }
    for (let i = layer.children.length - 1; i >= grounded.length; i--) {
      layer.removeChild(layer.children[i]);
    }

    grounded.forEach((b, i) => {
      const pip = layer.children[i];
      _v3b.set(b.pos.x, b.pos.y + BLOCK_CONFIG.size * 0.75, b.pos.z);
      _v3b.project(camera);
      if (_v3b.z > 1 || Math.abs(_v3b.x) > 1.2 || Math.abs(_v3b.y) > 1.2) {
        pip.style.display = 'none';
        return;
      }
      const sx = (_v3b.x + 1) * 0.5 * window.innerWidth;
      const sy = (-_v3b.y + 1) * 0.5 * window.innerHeight;
      pip.style.display = 'flex';
      pip.style.left = sx + 'px';
      pip.style.top = sy + 'px';
      // Render HP dots
      const kids = pip.children;
      for (let k = 0; k < kids.length; k++) {
        kids[k].classList.toggle('filled', k < b.hp);
      }
    });
  },

  // Called by main.js after the user sets/changes their username
  setUsernameDisplay(username) {
    const unEl = document.getElementById('player-name');
    if (unEl) unEl.textContent = username;
    const tEl = document.getElementById('title-username');
    if (tEl) tEl.textContent = username;
  },
};
