import * as THREE from 'three';
import { S, mouse } from './state.js';
import { WEAPONS, CHAPTERS, WAVES_PER_CHAPTER, BLOCK_CONFIG, PARADISE_FALLEN_CHAPTER_IDX, CH7_WAVE_COUNT } from './config.js';
import { getWaveDef_current } from './waves.js';
import { Audio } from './audio.js';

// Reusable scratch vectors
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();

export const UI = {
  updateHUD() {
    // Chapter 7 (PARADISE_FALLEN_CHAPTER_IDX === 6) flips the weapon UI:
    // standard revolver slots hidden, rainbow charge port shown instead.
    // Cached at top so all later sections can reference it.
    const inCh7 = (S.chapter === 6);

    document.getElementById('score').textContent = S.score.toLocaleString();
    // Wave slot — now shows "{localWave}/{total}" instead of the raw
    // global wave number, since the dropped #chapter-readout used to
    // carry that ratio. CREDITS wave (post-ch7 finale) shows the
    // word "CREDITS" instead of a numeric ratio.
    {
      const waveEl = document.getElementById('wave-num');
      if (waveEl) {
        const curDef = (typeof getWaveDef_current === 'function') ? getWaveDef_current() : null;
        if (curDef && curDef.creditsWave) {
          waveEl.textContent = 'CREDITS';
        } else {
          const waveMax = (S.chapter === PARADISE_FALLEN_CHAPTER_IDX) ? CH7_WAVE_COUNT : WAVES_PER_CHAPTER;
          waveEl.textContent = (S.localWave || 1) + '/' + waveMax;
        }
      }
    }
    document.getElementById('kill-num').textContent = S.kills;

    // Killstreak — only displayed when active (>0). The element is
    // created lazily on first update so existing HUDs without it
    // upgrade transparently. Shows "x123" with brighter color the
    // higher the streak goes.
    let ksEl = document.getElementById('killstreak');
    if (!ksEl) {
      ksEl = document.createElement('div');
      ksEl.id = 'killstreak';
      ksEl.style.cssText = [
        'position: fixed',
        'top: 16px',
        'left: 16px',
        'font-family: "VT323", "Courier New", monospace',
        'font-weight: bold',
        'pointer-events: none',
        'text-shadow: 0 0 8px currentColor, 0 2px 4px rgba(0,0,0,0.8)',
        'z-index: 51',
        'transition: opacity 0.25s ease-out',
        'opacity: 0',
      ].join(';');
      document.body.appendChild(ksEl);
    }
    if ((S.killstreak || 0) > 0) {
      // Color ramp: white → yellow → orange → red as the streak grows
      let color = '#ffffff';
      let scale = 1.0;
      const ks = S.killstreak;
      if (ks >= 25)      { color = '#ff3030'; scale = 1.6; }
      else if (ks >= 15) { color = '#ff8800'; scale = 1.4; }
      else if (ks >= 8)  { color = '#ffd040'; scale = 1.25; }
      else if (ks >= 4)  { color = '#ffffff'; scale = 1.1; }
      const sizePx = Math.round(28 * scale);
      ksEl.style.color = color;
      ksEl.style.fontSize = sizePx + 'px';
      ksEl.textContent = 'x' + String(ks).padStart(3, '0');
      ksEl.style.opacity = '1';
    } else {
      ksEl.style.opacity = '0';
    }

    // ----- OVERDRIVE TIMER BAR -----
    // Lazy-created golden bar that appears below the killstreak counter
    // when overdrive is active. Fills right-to-left as the 8-second
    // timer drains. Pulses faster in the final 2s as a "running out"
    // cue. Hidden when overdrive isn't active.
    let odEl = document.getElementById('overdrive-bar');
    if (!odEl) {
      odEl = document.createElement('div');
      odEl.id = 'overdrive-bar';
      odEl.style.cssText = [
        'position: fixed',
        'top: 64px',                 // sits below the killstreak counter
        'left: 16px',
        'width: 220px',
        'height: 18px',
        'border: 2px solid #ffd060',
        'border-radius: 3px',
        'background: rgba(40, 24, 4, 0.85)',
        'box-shadow: 0 0 14px rgba(255,208,96,0.55)',
        'pointer-events: none',
        'z-index: 51',
        'opacity: 0',
        'transition: opacity 0.2s',
        'overflow: hidden',
      ].join(';');
      const fill = document.createElement('div');
      fill.id = 'overdrive-bar-fill';
      fill.style.cssText = [
        'position: absolute',
        'top: 0', 'left: 0', 'bottom: 0',
        'width: 100%',
        'background: linear-gradient(to right, #ffaa00, #ffe680, #ffd060)',
        'box-shadow: inset 0 0 10px rgba(255,255,200,0.7)',
        'transition: width 0.06s linear',
      ].join(';');
      odEl.appendChild(fill);
      const label = document.createElement('div');
      label.id = 'overdrive-bar-label';
      label.style.cssText = [
        'position: absolute',
        'top: 0', 'left: 0', 'right: 0', 'bottom: 0',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'color: #2a1a00',
        'font-family: "VT323", "Courier New", monospace',
        'font-size: 14px',
        'font-weight: bold',
        'letter-spacing: 2px',
        'text-shadow: 0 1px 0 rgba(255,255,255,0.4)',
      ].join(';');
      label.textContent = '⚡ OVERDRIVE ⚡';
      odEl.appendChild(label);
      document.body.appendChild(odEl);
    }
    if (S.overdriveActive && S.overdriveTimer > 0) {
      odEl.style.opacity = '1';
      const fill = document.getElementById('overdrive-bar-fill');
      const pct = Math.max(0, Math.min(1, S.overdriveTimer / 8.0));
      fill.style.width = (pct * 100) + '%';
      // Pulse the box-shadow faster in the final 2 seconds for urgency.
      // Outside that window the shadow is steady.
      if (S.overdriveTimer < 2.0) {
        const pulse = 0.6 + 0.4 * Math.abs(Math.sin(performance.now() * 0.012));
        odEl.style.boxShadow = `0 0 ${10 + pulse * 14}px rgba(255,208,96,${0.5 + pulse * 0.4})`;
      } else {
        odEl.style.boxShadow = '0 0 14px rgba(255,208,96,0.55)';
      }
    } else {
      odEl.style.opacity = '0';
    }

    // ----- LIFEDRAINER CHARGE METER (top-center) -----
    // Only visible when lifedrainer weapon is equipped (chapter 7 native
    // gun). Bar fills with green emissive glow as charge accrues from
    // draining enemies. When charge hits 1.0 the bar pulses bright and
    // text changes to "READY" — telegraph that next click fires the
    // 50-projectile swarm.
    let ldEl = document.getElementById('lifedrain-meter');
    if (!ldEl) {
      ldEl = document.createElement('div');
      ldEl.id = 'lifedrain-meter';
      ldEl.style.cssText = [
        'position: fixed',
        'top: 60px',
        'left: 50%',
        'transform: translateX(-50%)',
        'width: 280px',
        'height: 26px',
        'border: 2px solid #00ff66',
        'border-radius: 4px',
        'background: rgba(0,30,12,0.7)',
        'box-shadow: 0 0 14px rgba(0,255,102,0.45)',
        'pointer-events: none',
        'z-index: 50',
        'opacity: 0',
        'transition: opacity 0.2s',
        'overflow: hidden',
      ].join(';');
      // Inner fill bar
      const fill = document.createElement('div');
      fill.id = 'lifedrain-fill';
      fill.style.cssText = [
        'position: absolute',
        'top: 0', 'left: 0', 'bottom: 0',
        'width: 0%',
        'background: linear-gradient(to right, #00aa44, #66ff88)',
        'box-shadow: inset 0 0 12px rgba(150,255,180,0.6)',
        'transition: width 0.05s linear',
      ].join(';');
      ldEl.appendChild(fill);
      // Text label centered on top
      const label = document.createElement('div');
      label.id = 'lifedrain-label';
      label.style.cssText = [
        'position: absolute',
        'top: 0', 'left: 0', 'right: 0', 'bottom: 0',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'color: #ffffff',
        'font-family: "VT323", "Courier New", monospace',
        'font-size: 18px',
        'font-weight: bold',
        'letter-spacing: 2px',
        'text-shadow: 0 0 4px #000, 0 1px 2px rgba(0,0,0,0.9)',
      ].join(';');
      ldEl.appendChild(label);
      document.body.appendChild(ldEl);
    }
    if (S.currentWeapon === 'lifedrainer' && !inCh7) {
      // Show the simple top-center bar only when lifedrainer is equipped
      // OUTSIDE chapter 7 (e.g. dev console testing). In chapter 7 the
      // rainbow port below replaces this UI.
      ldEl.style.opacity = '1';
      const fill = document.getElementById('lifedrain-fill');
      const label = document.getElementById('lifedrain-label');
      const charge = Math.max(0, Math.min(1, S.lifedrainCharge || 0));
      fill.style.width = (charge * 100) + '%';
      if (charge >= 1.0) {
        label.textContent = '⚡ READY ⚡';
        ldEl.style.boxShadow = '0 0 22px rgba(150,255,180,0.95), 0 0 8px #fff';
        ldEl.style.borderColor = '#aaffcc';
      } else {
        label.textContent = 'DRAIN ' + Math.round(charge * 100) + '%';
        ldEl.style.boxShadow = '0 0 14px rgba(0,255,102,0.45)';
        ldEl.style.borderColor = '#00ff66';
      }
    } else {
      ldEl.style.opacity = '0';
    }

    // ----- INVENTORY WIDGET (top-left): potions + grenades -----
    // Two-row floating panel showing held potions + grenade charges
    // alongside small SVG icons. Lazy-created on first update so we
    // don't have to touch index.html. Each row is a flex container
    // with: icon, count text "n/3", and a faint pulse when count > 0.
    //
    // Designed to sit above the existing player-name + HP/XP panel
    // (which is bottom-left) without overlapping any other HUD.
    let invEl = document.getElementById('inv-widget');
    if (!invEl) {
      invEl = document.createElement('div');
      invEl.id = 'inv-widget';
      invEl.style.cssText = [
        'position: fixed',
        'top: 80px',
        'left: 16px',
        'display: flex',
        'flex-direction: column',
        'gap: 8px',
        'pointer-events: none',
        'z-index: 50',
        'font-family: "VT323", "Courier New", monospace',
      ].join(';');

      // Potion row
      const potionRow = document.createElement('div');
      potionRow.id = 'inv-row-potion';
      potionRow.style.cssText = [
        'display: flex',
        'align-items: center',
        'gap: 8px',
        'padding: 6px 10px 6px 6px',
        'background: rgba(0, 0, 0, 0.55)',
        'border: 2px solid rgba(51, 170, 255, 0.65)',
        'border-radius: 8px',
        'box-shadow: 0 0 12px rgba(51, 170, 255, 0.3)',
        'transition: opacity 0.25s ease-out, box-shadow 0.25s ease-out',
      ].join(';');
      // Inline SVG bottle icon — small flask with a cork. Filled with
      // glowing blue gradient. Wrapped in a span so the count text
      // can flex next to it.
      const potionIcon = document.createElement('span');
      potionIcon.style.cssText = 'display: inline-block; width: 28px; height: 28px; flex-shrink: 0;';
      potionIcon.innerHTML = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" width="28" height="28">'
        + '<defs><radialGradient id="potG" cx="50%" cy="60%" r="50%">'
        + '<stop offset="0%" stop-color="#88ddff" stop-opacity="1"/>'
        + '<stop offset="100%" stop-color="#2266ff" stop-opacity="1"/>'
        + '</radialGradient></defs>'
        // Cork
        + '<rect x="13" y="3" width="6" height="3" fill="#6b4422" rx="1"/>'
        // Neck
        + '<rect x="14" y="6" width="4" height="4" fill="#4488bb"/>'
        // Bottle body
        + '<path d="M 11 10 L 21 10 L 23 14 L 23 27 Q 23 29 21 29 L 11 29 Q 9 29 9 27 L 9 14 Z" '
        + 'fill="url(#potG)" stroke="#aaeeff" stroke-width="1"/>'
        // Inner highlight
        + '<ellipse cx="13" cy="18" rx="2" ry="5" fill="#ffffff" fill-opacity="0.35"/>'
        + '</svg>';
      const potionText = document.createElement('span');
      potionText.id = 'inv-potion-text';
      potionText.style.cssText = [
        'color: #88ccff',
        'font-size: 24px',
        'text-shadow: 0 0 6px rgba(51, 170, 255, 0.8)',
        'min-width: 38px',
        'text-align: center',
      ].join(';');
      potionRow.appendChild(potionIcon);
      potionRow.appendChild(potionText);
      invEl.appendChild(potionRow);

      // Grenade row
      const grenadeRow = document.createElement('div');
      grenadeRow.id = 'inv-row-grenade';
      grenadeRow.style.cssText = [
        'display: flex',
        'align-items: center',
        'gap: 8px',
        'padding: 6px 10px 6px 6px',
        'background: rgba(0, 0, 0, 0.55)',
        'border: 2px solid rgba(68, 255, 102, 0.65)',
        'border-radius: 8px',
        'box-shadow: 0 0 12px rgba(68, 255, 102, 0.3)',
        'transition: opacity 0.25s ease-out, box-shadow 0.25s ease-out',
      ].join(';');
      const grenadeIcon = document.createElement('span');
      grenadeIcon.style.cssText = 'display: inline-block; width: 28px; height: 28px; flex-shrink: 0;';
      // Inline SVG grenade — glowing green orb with a metallic top piece + pin ring
      grenadeIcon.innerHTML = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" width="28" height="28">'
        + '<defs><radialGradient id="grenG" cx="40%" cy="55%" r="55%">'
        + '<stop offset="0%" stop-color="#aaffbb" stop-opacity="1"/>'
        + '<stop offset="60%" stop-color="#44ff66" stop-opacity="1"/>'
        + '<stop offset="100%" stop-color="#118833" stop-opacity="1"/>'
        + '</radialGradient></defs>'
        // Body — orb
        + '<circle cx="16" cy="19" r="10" fill="url(#grenG)" stroke="#ccffcc" stroke-width="1"/>'
        // Highlight
        + '<ellipse cx="12" cy="15" rx="3" ry="4" fill="#ffffff" fill-opacity="0.45"/>'
        // Top metal cap
        + '<rect x="13" y="6" width="6" height="4" fill="#aaaaaa" stroke="#666666" stroke-width="0.5"/>'
        // Pin ring
        + '<circle cx="22" cy="6" r="2.5" fill="none" stroke="#dddddd" stroke-width="1.5"/>'
        + '<line x1="19" y1="7" x2="14" y2="7" stroke="#aaaaaa" stroke-width="1"/>'
        + '</svg>';
      const grenadeText = document.createElement('span');
      grenadeText.id = 'inv-grenade-text';
      grenadeText.style.cssText = [
        'color: #aaffaa',
        'font-size: 24px',
        'text-shadow: 0 0 6px rgba(68, 255, 102, 0.8)',
        'min-width: 38px',
        'text-align: center',
      ].join(';');
      grenadeRow.appendChild(grenadeIcon);
      grenadeRow.appendChild(grenadeText);
      invEl.appendChild(grenadeRow);

      // ----- Pause button (mobile-friendly) -----
      // Tap-to-pause for mobile players who don't have an Escape key.
      // Also visible on desktop — harmless extra button. Dispatches a
      // 'mw:toggle-pause' event main.js listens for to invoke the
      // existing _togglePauseKey() entry point.
      const pauseRow = document.createElement('div');
      pauseRow.id = 'inv-row-pause';
      pauseRow.style.cssText = [
        'display: flex',
        'align-items: center',
        'gap: 8px',
        'padding: 6px 10px 6px 6px',
        'background: rgba(0, 0, 0, 0.55)',
        'border: 2px solid rgba(200, 200, 200, 0.55)',
        'border-radius: 8px',
        'box-shadow: 0 0 10px rgba(200, 200, 200, 0.20)',
        'cursor: pointer',
        'pointer-events: auto',
        '-webkit-tap-highlight-color: transparent',
        'user-select: none',
      ].join(';');
      const pauseIcon = document.createElement('span');
      pauseIcon.style.cssText = 'display: inline-block; width: 28px; height: 28px; flex-shrink: 0;';
      pauseIcon.innerHTML = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" width="28" height="28">'
        + '<rect x="9"  y="6" width="5" height="20" rx="1" fill="#dddddd" stroke="#888" stroke-width="0.5"/>'
        + '<rect x="18" y="6" width="5" height="20" rx="1" fill="#dddddd" stroke="#888" stroke-width="0.5"/>'
        + '</svg>';
      const pauseText = document.createElement('span');
      pauseText.style.cssText = [
        'color: #cccccc',
        'font-size: 14px',
        'letter-spacing: 2px',
        'font-family: \'Impact\', monospace',
        'min-width: 38px',
        'text-align: center',
      ].join(';');
      pauseText.textContent = 'PAUSE';
      pauseRow.appendChild(pauseIcon);
      pauseRow.appendChild(pauseText);
      // Tap handler — dispatch an event main.js listens for. Mirrors
      // the potion / grenade tap pattern below.
      const onPauseTap = (ev) => {
        window.dispatchEvent(new CustomEvent('mw:toggle-pause'));
        if (ev) ev.preventDefault();
      };
      pauseRow.addEventListener('touchstart', onPauseTap, { passive: false });
      pauseRow.addEventListener('click', onPauseTap);
      invEl.appendChild(pauseRow);

      // ----- Make potion + grenade chips tappable -----
      // The inv-widget container has pointer-events:none so it doesn't
      // intercept bullets clicking through it on desktop; we re-enable
      // on the individual rows. Tap dispatches a custom event main.js
      // listens for to invoke tryUsePotion / tryThrowGrenade — same
      // entry points as the H / G keyboard handlers. Mobile players
      // can now heal and throw grenades with just taps.
      potionRow.style.cursor = 'pointer';
      potionRow.style.pointerEvents = 'auto';
      potionRow.style.webkitTapHighlightColor = 'transparent';
      grenadeRow.style.cursor = 'pointer';
      grenadeRow.style.pointerEvents = 'auto';
      grenadeRow.style.webkitTapHighlightColor = 'transparent';
      const onPotionTap = (ev) => {
        window.dispatchEvent(new CustomEvent('mw:use-potion'));
        if (ev) ev.preventDefault();
      };
      const onGrenadeTap = (ev) => {
        window.dispatchEvent(new CustomEvent('mw:throw-grenade'));
        if (ev) ev.preventDefault();
      };
      potionRow.addEventListener('touchstart', onPotionTap, { passive: false });
      potionRow.addEventListener('click', onPotionTap);
      grenadeRow.addEventListener('touchstart', onGrenadeTap, { passive: false });
      grenadeRow.addEventListener('click', onGrenadeTap);

      document.body.appendChild(invEl);
    }

    // Update counts. POTION_MAX and GRENADE_MAX are 3 — hardcoded
    // here to avoid an import cycle with pickups.js (ui.js shouldn't
    // depend on pickups, since pickups.js already depends on ui.js
    // for the toast helper).
    const POTION_MAX = 3;
    const GRENADE_MAX = 3;
    const potionCount = S.potions || 0;
    const grenadeCount = S.grenadeCharges || 0;
    const potionTextEl = document.getElementById('inv-potion-text');
    const grenadeTextEl = document.getElementById('inv-grenade-text');
    const potionRow = document.getElementById('inv-row-potion');
    const grenadeRow = document.getElementById('inv-row-grenade');
    if (potionTextEl) potionTextEl.textContent = potionCount + '/' + POTION_MAX;
    if (grenadeTextEl) grenadeTextEl.textContent = grenadeCount + '/' + GRENADE_MAX;
    // Dim the row when empty so a player at-a-glance can tell what's
    // available. Full inventory: full opacity; partial: full opacity;
    // empty: 0.45 opacity (greyed out but still visible).
    if (potionRow) potionRow.style.opacity = potionCount > 0 ? '1' : '0.45';
    if (grenadeRow) grenadeRow.style.opacity = grenadeCount > 0 ? '1' : '0.45';

    const m = Math.floor(S.timeElapsed / 60);
    const s = Math.floor(S.timeElapsed % 60);
    document.getElementById('time-num').textContent = m + ':' + (s < 10 ? '0' : '') + s;

    document.getElementById('hp-fill').style.width = Math.max(0, (S.hp / S.hpMax) * 100) + '%';
    document.getElementById('xp-fill').style.width = (S.xp / S.xpNext) * 100 + '%';
    document.getElementById('lvl-num').textContent = S.level;
    document.getElementById('weapon-name').textContent = WEAPONS[S.currentWeapon].name;

    // ---- AMMO + RELOAD HUD ----
    // Show "current/max" for the active weapon. If the weapon is not
    // reloadable (lifedrainer / pickaxe) hide the row entirely. While
    // S.reloading is true, show the reload progress bar instead of
    // "X/Y" — the bar sweeps from 0 to 100% over S.reloadDur.
    {
      const id = S.currentWeapon;
      const ammoRow   = document.getElementById('ammo-row');
      const ammoCount = document.getElementById('ammo-count');
      const reloadLbl = document.getElementById('ammo-reload-label');
      const reloadBar = document.getElementById('ammo-reload-bar');
      const reloadFill = document.getElementById('ammo-reload-fill');
      // Reloadable iff S.maxAmmo[id] is set (initialized in
      // applyArmoryToRunStart for the canonical chapter 1-6 weapons).
      const max = (S.maxAmmo && S.maxAmmo[id]) || 0;
      const isReloadable = max > 0;
      if (ammoRow) ammoRow.style.display = isReloadable ? 'flex' : 'none';
      if (isReloadable) {
        const cur = (S.ammo && S.ammo[id]) || 0;
        if (ammoCount) {
          ammoCount.textContent = cur + '/' + max;
          // Color hint: red when near-empty (<= 25% mag) so the
          // player knows a reload is imminent.
          ammoCount.style.color = (!S.reloading && cur <= Math.max(1, Math.floor(max * 0.25)))
            ? '#ff5b5b' : 'var(--neon-cyan)';
        }
        if (S.reloading) {
          if (reloadLbl) reloadLbl.style.display = '';
          if (reloadBar) reloadBar.style.display = '';
          if (reloadFill) {
            const pct = S.reloadDur > 0
              ? Math.min(100, (S.reloadT / S.reloadDur) * 100)
              : 0;
            reloadFill.style.width = pct + '%';
          }
        } else {
          if (reloadLbl) reloadLbl.style.display = 'none';
          if (reloadBar) reloadBar.style.display = 'none';
        }
      }
    }

    // Redraw the ammo arcs around every weapon slot. The method is
    // cheap when nothing has changed (just class swaps on existing
    // <line>/<path> children). We deliberately call this every
    // frame inside updateHUD so the arc reflects the current ammo
    // state in lock-step with the HUD's "X/Y" readout — calling it
    // only on weapon-switch would lag behind in-mag spending and
    // reload progress.
    this.updateAmmoArcs();

    // Chapter slot in the stats row (id "chap-num"). Replaces the
    // separate #chapter-readout line that used to sit underneath.
    // Format: "{n} {NAME}" — e.g. "2 CRIMSON". Wave info lives in
    // its own slot in the row so we don't repeat it here. The
    // CREDITS wave (post-ch7 finale) shows the chapter as usual;
    // the wave slot will display "CREDITS" via wave-num write
    // (handled below).
    const chapNumEl = document.getElementById('chap-num');
    if (chapNumEl) {
      const chapName = CHAPTERS[S.chapter % CHAPTERS.length].name;
      chapNumEl.textContent = (S.chapter + 1) + ' ' + chapName;
    }
    // Legacy #chapter-readout element — preserved for cached HTMLs
    // that still have it. New HTML drops the element; the guard
    // makes this a safe no-op when missing.
    const chapEl = document.getElementById('chapter-readout');
    if (chapEl) {
      const chapName = CHAPTERS[S.chapter % CHAPTERS.length].name;
      const curDef = (typeof getWaveDef_current === 'function') ? getWaveDef_current() : null;
      if (curDef && curDef.creditsWave) {
        chapEl.textContent = 'CH.' + (S.chapter + 1) + ' · ' + chapName + ' · CREDITS';
      } else {
        const waveMax = (S.chapter === PARADISE_FALLEN_CHAPTER_IDX) ? CH7_WAVE_COUNT : WAVES_PER_CHAPTER;
        chapEl.textContent = 'CH.' + (S.chapter + 1) + ' · ' + chapName + ' · W' + S.localWave + '/' + waveMax;
      }
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

  /**
   * Per-frame redraw of the ammo arcs around each weapon slot in
   * the revolver. The arc lives in a child SVG layer that we lazy-
   * build on first call per slot, then mutate cheaply on every
   * frame thereafter (text content + class name swaps; no
   * attribute churn that triggers reflow).
   *
   * Behaviour by weapon kind:
   *   • Pip-mode  (pistol / shotgun / smg / rocket) — N pips drawn
   *     along the bottom semicircle, where N = magazine capacity.
   *     Filled = remaining shots, dimmed = spent. Pips have rounded
   *     stroke caps so they read like little bullets.
   *   • Bar-mode (raygun / flamethrower) — a single continuous
   *     arc. Background arc is the full semicircle (faint),
   *     foreground arc fills proportionally to current/max ammo.
   *   • Skipped entirely — pickaxe (no reload), grenade (separate
   *     count display), and anything else without a S.maxAmmo entry.
   *
   * Weapons not currently owned by the player still get an arc, but
   * its scale follows the parent slot's opacity so dimmed slots
   * don't visually shout. Reloading slots get a pulse class so the
   * arc dims rhythmically while the magazine swaps.
   */
  updateAmmoArcs() {
    if (!S.maxAmmo) return;
    const slots = document.querySelectorAll('#inventory .slot');
    slots.forEach((slot) => {
      const id = slot.dataset.slot;
      if (!id) return;
      const max = S.maxAmmo[id];
      if (!max) {
        // Weapon has no magazine (pickaxe, grenade, or armory hasn't
        // initialized yet) — make sure any stale arc from a previous
        // chapter isn't lingering. Removing it is rare so the cost
        // here is negligible.
        const stale = slot.querySelector('.slot-ammo-arc');
        if (stale) stale.remove();
        return;
      }
      const cur = (S.ammo && S.ammo[id]) || 0;
      const w = WEAPONS[id];
      const isBar = !!(w && (w.isBeam || w.isFlame));

      // Lazy-build the SVG arc layer the first time this slot
      // shows up with a magazine.
      let arc = slot.querySelector('.slot-ammo-arc');
      if (!arc) {
        const SVG_NS = 'http://www.w3.org/2000/svg';
        arc = document.createElementNS(SVG_NS, 'svg');
        arc.setAttribute('class', 'slot-ammo-arc');
        // 100×100 viewBox keeps math simple — center at 50,50.
        arc.setAttribute('viewBox', '0 0 100 100');
        slot.appendChild(arc);
      }

      // Reload pulse class — driven from S.reloading + the active
      // weapon. We only animate the arc on the slot that is actually
      // being reloaded (S.currentWeapon === id) so other slots stay
      // calm. Spectator slots' last known mag state stays static
      // while a different slot is reloading.
      const isReloading = !!S.reloading && S.currentWeapon === id;
      arc.classList.toggle('reloading', isReloading);

      // ---- BAR MODE ----
      if (isBar) {
        // Build (or reuse) two arc paths.
        let bg = arc.querySelector('.ammo-bar-bg');
        let fg = arc.querySelector('.ammo-bar-fg');
        if (!bg) {
          const SVG_NS = 'http://www.w3.org/2000/svg';
          // Bottom half-circle path, drawn from the 9 o'clock point
          // (-x axis) down through 6 o'clock and up to 3 o'clock.
          // This is the half "closest to the player" when the slot
          // sits in the bottom-right HUD corner.
          const half = 'M 8 50 A 42 42 0 0 0 92 50';
          bg = document.createElementNS(SVG_NS, 'path');
          bg.setAttribute('class', 'ammo-bar-bg');
          bg.setAttribute('d', half);
          bg.setAttribute('fill', 'none');
          bg.setAttribute('stroke-width', '5');
          bg.setAttribute('stroke-linecap', 'round');
          arc.appendChild(bg);
          fg = document.createElementNS(SVG_NS, 'path');
          fg.setAttribute('class', 'ammo-bar-fg');
          fg.setAttribute('d', half);
          fg.setAttribute('fill', 'none');
          fg.setAttribute('stroke-width', '5');
          fg.setAttribute('stroke-linecap', 'round');
          arc.appendChild(fg);
        }
        // Arc length: a 42-radius half-circle is π * r ≈ 132. We
        // round-up the constant slightly (133) to avoid sub-pixel
        // gap at full draw.
        const ARC_LEN = 133;
        const filled = isReloading ? 0 : Math.max(0, Math.min(1, cur / max));
        const drawn = ARC_LEN * filled;
        fg.setAttribute('stroke-dasharray', `${drawn} ${ARC_LEN}`);
        // Tear down any pip children the slot had previously (e.g.
        // weapon swapped between modes — shouldn't happen but
        // defensive cleanup is cheap).
        arc.querySelectorAll('.ammo-pip-filled, .ammo-pip-spent').forEach(n => n.remove());
        return;
      }

      // ---- PIP MODE ----
      // Number of pips = magazine capacity. We draw one short
      // <line> per pip, evenly spaced along the bottom semicircle.
      // Pips are rebuilt only when the count actually changes —
      // typical usage is "N stays constant during a run", so this
      // is essentially a one-time cost per magazine.
      const want = max | 0;
      const have = arc.querySelectorAll('line').length;
      if (have !== want) {
        // Replace pip set wholesale.
        arc.innerHTML = '';
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const cx = 50, cy = 50;
        // Outer + inner radii for the pip line. Tip slightly outside
        // the slot, base slightly inside the slot edge.
        const rOut = 47, rIn = 39;
        // Distribute pips along the bottom semicircle, but inset
        // slightly from the endpoints so the first and last pips
        // don't crowd the side of the slot. With N pips we want
        // angles between (180-pad)° and (360+pad)°-360 (i.e.
        // mirrored). We use degrees: 180→360 covers the bottom
        // half (canvas Y grows downward). pad keeps margins.
        const pad = want > 1 ? 8 : 0;
        for (let i = 0; i < want; i++) {
          const t = want === 1 ? 0.5 : i / (want - 1);
          const angDeg = 180 + pad + t * (180 - 2 * pad);
          const ang = angDeg * Math.PI / 180;
          const x1 = cx + Math.cos(ang) * rIn;
          const y1 = cy + Math.sin(ang) * rIn;
          const x2 = cx + Math.cos(ang) * rOut;
          const y2 = cy + Math.sin(ang) * rOut;
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('x1', x1.toFixed(2));
          line.setAttribute('y1', y1.toFixed(2));
          line.setAttribute('x2', x2.toFixed(2));
          line.setAttribute('y2', y2.toFixed(2));
          line.setAttribute('stroke-width', '3');
          line.setAttribute('stroke-linecap', 'round');
          arc.appendChild(line);
        }
      }
      // Update fill state on each pip. We treat the "first" pip
      // (leftmost on the arc) as the round about to be fired next
      // — it stays filled until cur drops below 1, then dims.
      // Reloading: hide all pips (zero fills) until reload completes,
      // then they snap back on.
      const lines = arc.querySelectorAll('line');
      const filled = isReloading ? 0 : Math.max(0, Math.min(want, cur | 0));
      lines.forEach((line, i) => {
        const isFilled = i < filled;
        line.setAttribute('class', isFilled ? 'ammo-pip-filled' : 'ammo-pip-spent');
      });
    });
  },

  updateWeaponSlots() {
    // Chapter 7 (PARADISE_FALLEN_CHAPTER_IDX === 6) flips the weapon UI:
    // standard revolver slots hidden, rainbow charge port shown instead.
    // Cached at top so the rainbow-port + slot-visibility blocks below
    // can both reference it. (Earlier this only existed in updateHUD;
    // the references here threw a ReferenceError that bailed startGame
    // before startWave(1) could run — leaving the arena empty.)
    const inCh7 = (S.chapter === 6);

    // Inject the revolver CSS once on first call. We do it from JS
    // (rather than editing styles.css) so this redesign drops in as
    // a single ui.js change without touching index.html or any
    // stylesheet. The injected rules:
    //
    //   - Move the #inventory container to the bottom-right corner
    //   - Hide the pickaxe slot (game logic still uses pickaxe internally
    //     for mining; it just doesn't appear in the revolver)
    //   - Hide the grenade slot (now shown in the top-left inv widget)
    //   - Lay out the 6 remaining combat weapons (.slot[data-slot] for
    //     pistol, shotgun, smg, rocket, raygun, flame) in a circular
    //     arrangement around an invisible center, with the active
    //     weapon at the bottom-center of the wheel
    //   - Smooth rotation animation when the active weapon changes
    //
    // The revolver consists of all .slot elements EXCEPT pickaxe and
    // grenade, in a circle. Each .slot gets transform: rotate around
    // a shared center; the .active one is offset to the BOTTOM-CENTER
    // (the "highlighted" slot the user can see clearly).
    //
    // Revolver radius and slot size are tuned to look reasonable
    // regardless of the existing .slot CSS (which gives it a card-like
    // appearance with weapon name + icon).
    if (!document.getElementById('revolver-css')) {
      const style = document.createElement('style');
      style.id = 'revolver-css';
      style.textContent = `
        /* The original styles.css enables .mobile-only elements on
           any (pointer: coarse) device. We force-hide them here on
           DESKTOP so a touchscreen laptop or hybrid device that
           reports coarse pointer doesn't get redundant mobile
           controls layered over a desktop revolver. The media query
           guards this so REAL mobile devices (phones, tablets, narrow
           viewports) DO get .mobile-only displayed — joystick, fire
           button, and the new revolver-center fire button.
           Affects: #fire-btn, #pick-btn, #pal-btn, #joystick, plus
           the inline ".mobile-only" hint text in the controls panel. */
        @media (pointer: fine) and (hover: hover) and (min-width: 901px) {
          .mobile-only {
            display: none !important;
          }
        }

        /* DEFENSE IN DEPTH — physically reposition the mobile buttons
           to the LEFT side of the screen as a safety net on DESKTOP.
           Even though .mobile-only is force-hidden above, this prevents
           any future leak (browser quirk, debug toggle, etc.) from
           causing FIRE or PICKAXE to appear ON TOP OF the desktop
           revolver wheel. Original styles.css positioned them at
           right:20px which collides directly with the revolver. We
           move them to left:20px so they sit harmlessly in the
           bottom-left corner if they ever reappear, where they
           overlap nothing important.

           CRITICAL — wrapped in the SAME desktop-only media query as
           the .mobile-only force-hide. Without this guard, the rules
           applied to mobile too and overrode the proper bottom-right
           fire-button positioning from styles.css, burying the fire
           button under the joystick. That's what caused the "we lost
           the fire button" bug. */
        @media (pointer: fine) and (hover: hover) and (min-width: 901px) {
          #fire-btn {
            left: 20px !important;
            right: auto !important;
          }
          #pick-btn {
            left: 20px !important;
            right: auto !important;
          }
          #pal-btn {
            left: 20px !important;
            right: auto !important;
          }
        }

        /* Hide pickaxe + grenade slots from the revolver — game logic
           still uses both internally (pickaxe for mining auto-switch,
           grenades thrown via G key), but they don't appear in the
           visible weapon wheel. Grenades have their own top-left
           inventory widget. */
        .slot[data-slot="pickaxe"],
        .slot[data-slot="grenade"] {
          display: none !important;
        }

        /* Container — sit in bottom-right corner on DESKTOP. The
           mobile MQ further down overrides this. CRITICAL — wrapped
           in the desktop guard (matching the .mobile-only force-hide)
           so that on mobile devices that don't trigger the mobile MQ
           for any reason (e.g., large phone in landscape exceeding
           900px while reporting pointer:fine) this desktop rule
           doesn't leak through and put the wheel at the wrong
           position. */
        @media (pointer: fine) and (hover: hover) and (min-width: 901px) {
          #inventory {
            position: fixed !important;
            bottom: 24px !important;
            right: 24px !important;
            left: auto !important;
            transform: none !important;
            width: 240px !important;
            height: 240px !important;
            background: none !important;
            padding: 0 !important;
            gap: 0 !important;
            display: block !important;
            pointer-events: none;
            z-index: 40;
          }
        }
        /* Mobile / fallback baseline — applies when the desktop MQ
           above doesn't match. Mirrors the desktop layout for
           layout-agnostic properties (background, padding, display)
           but leaves position open for the mobile MQ to set. */
        #inventory {
          position: fixed !important;
          left: auto !important;
          transform: none !important;
          background: none !important;
          padding: 0 !important;
          gap: 0 !important;
          display: block !important;
          pointer-events: none;
          z-index: 40;
        }

        /* Each weapon slot becomes one position on the wheel. The
           common base CSS positions every visible slot at the wheel's
           CENTER; the .revolver-pos-N classes added by JS rotate them
           outward and around. Active slot is highlighted with a glow
           and scaled up.

           Animation curve: cubic-bezier(0.22, 1, 0.36, 1) is the
           "ease-out-quart" curve — fast start, gentle settle, no
           overshoot. The previous bezier with a 1.4 endpoint had a
           visible bounce that read as "off" on a wheel that's
           supposed to rotate smoothly. Duration bumped to 0.5s so the
           rotation feels deliberate and the player's eye can track
           which slot is moving where. */
        #inventory .slot {
          position: absolute !important;
          left: 50% !important;
          top: 50% !important;
          width: 64px !important;
          height: 64px !important;
          margin: 0 !important;
          transform: translate(-50%, -50%) rotate(var(--revolver-angle, 0deg)) translateY(-90px) rotate(calc(-1 * var(--revolver-angle, 0deg))) !important;
          transition: transform 0.50s cubic-bezier(0.22, 1, 0.36, 1),
                      opacity 0.30s ease-out,
                      box-shadow 0.30s ease-out;
          pointer-events: auto;
          /* Reset any margins/padding from the base .slot rule */
          flex: none !important;
        }

        /* Active slot — bigger, glowing, lifted forward from the wheel.
           Pop animation runs once on activation: a quick punch up to
           1.65× then settles to 1.5×, giving the player a clear "this
           one just popped out" cue when scrolling. */
        #inventory .slot.active {
          transform: translate(-50%, -50%) rotate(var(--revolver-angle, 0deg)) translateY(-90px) rotate(calc(-1 * var(--revolver-angle, 0deg))) scale(1.5) !important;
          box-shadow: 0 0 32px rgba(255, 215, 80, 1.0),
                      0 0 14px rgba(255, 230, 100, 1.0),
                      0 0 4px rgba(255, 255, 200, 1.0) !important;
          z-index: 2 !important;
          animation: revolver-active-pulse 1.6s ease-in-out infinite,
                     revolver-pop 0.32s ease-out 1;
        }
        @keyframes revolver-active-pulse {
          0%, 100% { box-shadow: 0 0 32px rgba(255, 215, 80, 1.0),
                                 0 0 14px rgba(255, 230, 100, 1.0),
                                 0 0 4px rgba(255, 255, 200, 1.0); }
          50%      { box-shadow: 0 0 44px rgba(255, 220, 100, 1.0),
                                 0 0 20px rgba(255, 230, 100, 1.0),
                                 0 0 6px rgba(255, 255, 200, 1.0); }
        }
        /* One-shot "pop" played whenever a slot newly gains .active.
           Filter is layered on top of the base transform via animation;
           we only animate filter+filter-like properties so we don't
           fight the rotation transition. (Animating transform here
           would override the per-slot --revolver-angle math.) */
        @keyframes revolver-pop {
          0%   { filter: brightness(2.0) saturate(1.4); }
          60%  { filter: brightness(1.3) saturate(1.1); }
          100% { filter: brightness(1.0) saturate(1.0); }
        }

        /* Owned but inactive slots — visible, slightly dimmed */
        #inventory .slot.owned:not(.active) {
          opacity: 0.85;
        }

        /* Unowned slots — heavily dimmed but still visible so the
           player can see their roster of unlockable weapons. Dotted
           border hints "not yet acquired." */
        #inventory .slot:not(.owned) {
          opacity: 0.30;
          filter: grayscale(0.7);
        }

        /* ============================================================
           CENTER FIRE BUTTON (mobile only)
           ============================================================
           A small circular fire button planted IN THE CENTER of the
           revolver wheel. Always visible on mobile so the player can
           scroll/change weapons AND fire without lifting their thumb
           off the wheel area. Coexists with the bigger bottom-right
           #fire-btn for two-thumb play.
           Built at runtime in updateWeaponSlots — see _ensureCenterFire.
           Default state on desktop is hidden via the .mobile-only
           rule that the desktop @media block above honors.
           ============================================================ */
        #revolver-fire {
          position: absolute !important;
          left: 50% !important;
          top: 50% !important;
          transform: translate(-50%, -50%) !important;
          width: 56px !important;
          height: 56px !important;
          border-radius: 50% !important;
          background: radial-gradient(circle,
            rgba(79,247,255,0.50),
            rgba(0,0,0,0.75)) !important;
          border: 2px solid var(--neon-cyan, #4ff7ff) !important;
          box-shadow: 0 0 16px rgba(79,247,255,0.65),
                      inset 0 0 8px rgba(79,247,255,0.30) !important;
          color: var(--neon-cyan, #4ff7ff) !important;
          font-family: 'Impact', monospace !important;
          font-size: 14px !important;
          letter-spacing: 1.5px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          z-index: 41 !important;          /* above slots (z-index 2) */
          touch-action: none !important;
          user-select: none !important;
          -webkit-user-select: none !important;
          -webkit-tap-highlight-color: transparent !important;
          pointer-events: auto !important;
          cursor: pointer;
        }
        /* Briefly punch the button visual when held — gives the player
           tactile feedback that the press registered. Class toggled by
           touchstart/touchend wiring in updateWeaponSlots. */
        #revolver-fire.firing {
          background: radial-gradient(circle,
            rgba(255,235,150,0.75),
            rgba(0,0,0,0.6)) !important;
          border-color: #ffe6a0 !important;
          color: #fff8c0 !important;
          box-shadow: 0 0 24px rgba(255,235,150,0.95),
                      inset 0 0 12px rgba(255,255,200,0.5) !important;
          transform: translate(-50%, -50%) scale(0.94) !important;
        }

        /* ============================================================
           MOBILE MEDIA QUERY — shrinks the wheel and reflow the HUD
           so the playscreen isn't smooshed.
           Trigger is INCLUSIVE: any of these means "treat as mobile."
             - (pointer: coarse)         — primary touch device
             - (any-pointer: coarse)     — has any touch surface
             - (max-width: 1024px)       — narrow viewport, even on landscape phones
             - (hover: none)             — can't hover (touch-only)
             - (max-height: 600px)       — short viewports (landscape phones)
           Without this breadth, large landscape phones (e.g., iPhone
           Pro Max ~932px wide) could fail the original (max-width:
           900px) AND report pointer:fine in some browser configs,
           leaking desktop CSS to mobile.
           ============================================================ */
        @media (pointer: coarse),
               (any-pointer: coarse),
               (max-width: 1024px),
               (hover: none),
               (max-height: 600px) {
          /* Wheel container — slightly smaller than the desktop 240px,
             still bottom-right but lifted clear of the big fire button
             which sits CENTERED on the wheel as the centerpiece per
             playtester request. Position is anchored at the BOTTOM
             RIGHT corner — bottom:16 right:14 puts the wheel snug
             against the screen corner so the player can rest their
             thumb naturally on the fire button without reaching. */
          #inventory {
            bottom: 16px !important;
            right: 14px !important;
            width: 130px !important;
            height: 130px !important;
          }

          /* Slot size — wheel container is 130px so radius drops to
             48px to keep slots inside. Slots themselves shrink to 34
             so they don't spill outside the smaller wheel. */
          #inventory .slot {
            width: 34px !important;
            height: 34px !important;
            font-size: 14px !important;
            transform: translate(-50%, -50%)
              rotate(var(--revolver-angle, 0deg))
              translateY(-48px)
              rotate(calc(-1 * var(--revolver-angle, 0deg))) !important;
          }
          #inventory .slot.active {
            transform: translate(-50%, -50%)
              rotate(var(--revolver-angle, 0deg))
              translateY(-48px)
              rotate(calc(-1 * var(--revolver-angle, 0deg)))
              scale(1.35) !important;
          }

          /* Center fire button stub — REPLACED by the main #fire-btn
             which now sits as the wheel centerpiece on mobile. The
             stub element is hidden so it doesn't render an extra
             control on top of the actual fire button. */
          #revolver-fire {
            display: none !important;
          }
        }
      `;
      document.head.appendChild(style);
    }

    // Standard owned/active class toggling — same as before.
    document.querySelectorAll('.slot').forEach(el => {
      const slot = el.dataset.slot;
      if (!slot) return;
      el.classList.toggle('owned', S.ownedWeapons.has(slot));
      el.classList.toggle('active', slot === S.currentWeapon);

      // Tap-select on mobile (and click on desktop). Wire ONCE per
      // slot — the _tapWired flag is a one-time guard so re-running
      // updateWeaponSlots doesn't stack handlers. Dispatches a
      // 'mw:select-weapon' custom event main.js listens for to do the
      // full weapon-switch path (recolorGun, _syncWeaponCursor, toast,
      // updateWeaponSlots). This avoids a circular import between
      // ui.js and main.js while keeping the tap path identical to
      // the existing keyboard-1..6 path.
      if (!el._tapWired) {
        const onSelect = (e) => {
          // Only owned weapons are selectable. Tapping an unowned/dim
          // slot should be a no-op so the player doesn't get a
          // confusing "selected then snapped back" flash.
          if (!S.ownedWeapons.has(slot)) return;
          window.dispatchEvent(new CustomEvent('mw:select-weapon', { detail: slot }));
          if (e) e.preventDefault();
        };
        el.addEventListener('touchstart', onSelect, { passive: false });
        el.addEventListener('click', onSelect);
        el._tapWired = true;
      }
    });

    // ----- CENTER FIRE BUTTON (mobile) -----
    // Build the small circular fire button planted in the wheel
    // center. Idempotent — only the FIRST call creates and wires the
    // element; subsequent calls are no-ops. .mobile-only class hides
    // it on desktop via the existing media query in this CSS block.
    //
    // Tap behavior mirrors the bigger bottom-right #fire-btn: hold
    // for continuous fire (sets mouse.down=true), release to stop.
    // Both buttons can coexist; either one held will keep firing.
    const inv = document.getElementById('inventory');
    if (inv && !document.getElementById('revolver-fire')) {
      const cf = document.createElement('div');
      cf.id = 'revolver-fire';
      cf.className = 'mobile-only';
      cf.textContent = 'FIRE';
      // touchstart sets the same mouse.down flag the bottom-right
      // fire button uses — preventDefault stops the browser from
      // turning a long-press into a context menu / selection.
      cf.addEventListener('touchstart', (e) => {
        mouse.down = true;
        cf.classList.add('firing');
        try { Audio.resume(); } catch (err) {}
        e.preventDefault();
      }, { passive: false });
      cf.addEventListener('touchend', () => {
        mouse.down = false;
        cf.classList.remove('firing');
      });
      cf.addEventListener('touchcancel', () => {
        mouse.down = false;
        cf.classList.remove('firing');
      });
      // Mouse fallback for hybrid devices / desktop dev testing —
      // never used in production but stops the button feeling dead
      // if someone clicks it with a trackpad.
      cf.addEventListener('mousedown', (e) => {
        mouse.down = true;
        cf.classList.add('firing');
        try { Audio.resume(); } catch (err) {}
        e.preventDefault();
      });
      const _stopFire = () => {
        mouse.down = false;
        cf.classList.remove('firing');
      };
      cf.addEventListener('mouseup', _stopFire);
      cf.addEventListener('mouseleave', _stopFire);
      inv.appendChild(cf);
    }

    // ----- CHAPTER 7 RAINBOW CHARGE PORT -----
    // In chapter 7, the lifedrainer is the only available weapon — no
    // wheel needed. We hide ALL weapon slots and overlay a circular
    // rainbow charge port on top of the inventory area. The port:
    //   • shows a conic-gradient rainbow ring whose visible arc
    //     corresponds to current charge (0..1)
    //   • blinks via CSS animation when charge >= 1.0 (READY)
    //   • emits a green inner glow that intensifies with charge
    //   • depletes back to empty after the swarm fires (charge → 0)
    //
    // Lazy-created on first chapter 7 frame so we don't pay the cost
    // outside chapter 7. Hidden in other chapters. (`inCh7` is defined
    // at the top of updateHUD.)
    let portEl = document.getElementById('lifedrain-port');
    if (!portEl) {
      portEl = document.createElement('div');
      portEl.id = 'lifedrain-port';
      // Sized + positioned to occupy the same area as the revolver wheel
      // (bottom-right of screen). Conic-gradient gives the rainbow ring;
      // a mask-image clips it to a doughnut shape with a hollow center.
      portEl.style.cssText = [
        'position: fixed',
        'right: 60px',
        'bottom: 60px',
        'width: 200px',
        'height: 200px',
        'border-radius: 50%',
        'pointer-events: none',
        'z-index: 49',
        'opacity: 0',
        'transition: opacity 0.25s',
      ].join(';');
      // Outer rainbow ring — full conic gradient masked into a doughnut
      const rainbow = document.createElement('div');
      rainbow.id = 'lifedrain-rainbow';
      rainbow.style.cssText = [
        'position: absolute',
        'inset: 0',
        'border-radius: 50%',
        'background: conic-gradient(from 0deg, #ff3030, #ff8800, #ffd040, #44ff44, #00ddff, #4060ff, #aa44ff, #ff3030)',
        // Reveal arc grows with --charge custom prop (0..360deg)
        '-webkit-mask: conic-gradient(black 0deg, black var(--charge-deg, 0deg), transparent var(--charge-deg, 0deg))',
        'mask: conic-gradient(black 0deg, black var(--charge-deg, 0deg), transparent var(--charge-deg, 0deg))',
        'transition: filter 0.15s',
      ].join(';');
      portEl.appendChild(rainbow);
      // Inner doughnut hole — dark disk to make the rainbow read as a ring
      const hole = document.createElement('div');
      hole.style.cssText = [
        'position: absolute',
        'inset: 28px',
        'border-radius: 50%',
        'background: radial-gradient(circle, rgba(20,40,30,0.85) 60%, rgba(0,0,0,0.95) 100%)',
        'box-shadow: 0 0 22px rgba(0,255,102,0.45) inset',
        'display: flex',
        'align-items: center',
        'justify-content: center',
      ].join(';');
      const label = document.createElement('div');
      label.id = 'lifedrain-port-label';
      label.style.cssText = [
        'color: #ffffff',
        'font-family: "VT323", "Courier New", monospace',
        'font-size: 24px',
        'font-weight: bold',
        'letter-spacing: 2px',
        'text-shadow: 0 0 8px #00ff66, 0 1px 2px rgba(0,0,0,0.9)',
        'text-align: center',
        'line-height: 1.1',
      ].join(';');
      hole.appendChild(label);
      portEl.appendChild(hole);
      document.body.appendChild(portEl);
      // Inject CSS for the ready-pulse animation once.
      if (!document.getElementById('lifedrain-port-css')) {
        const sty = document.createElement('style');
        sty.id = 'lifedrain-port-css';
        sty.textContent = `
          @keyframes lifedrain-ready-pulse {
            0%, 100% { filter: brightness(1.2) drop-shadow(0 0 12px #aaffcc); transform: scale(1.0); }
            50%      { filter: brightness(2.0) drop-shadow(0 0 28px #ffffff); transform: scale(1.06); }
          }
          #lifedrain-port.ready { animation: lifedrain-ready-pulse 0.6s ease-in-out infinite; }
        `;
        document.head.appendChild(sty);
      }
    }
    if (inCh7) {
      portEl.style.opacity = '1';
      const charge = Math.max(0, Math.min(1, S.lifedrainCharge || 0));
      const rainbow = document.getElementById('lifedrain-rainbow');
      const label = document.getElementById('lifedrain-port-label');
      // Map charge 0..1 to 0..360 degrees
      rainbow.style.setProperty('--charge-deg', (charge * 360) + 'deg');
      // Brightness scales with charge
      rainbow.style.filter = 'brightness(' + (0.6 + charge * 0.6) + ')';
      if (charge >= 1.0) {
        portEl.classList.add('ready');
        label.innerHTML = '⚡<br>READY';
        label.style.color = '#ffffff';
      } else {
        portEl.classList.remove('ready');
        label.innerHTML = Math.round(charge * 100) + '%<br><span style="font-size:14px;opacity:0.8">DRAIN</span>';
        label.style.color = '#aaffcc';
      }
      // Hide the standard revolver slots in chapter 7 — there's only one
      // weapon (lifedrainer) and the rainbow port replaces the wheel UI.
      document.querySelectorAll('.slot').forEach(el => {
        const slot = el.dataset.slot;
        if (!slot) return;
        if (slot === 'pickaxe' || slot === 'grenade') return;     // these aren't part of the wheel
        el.style.visibility = 'hidden';
      });
    } else {
      portEl.style.opacity = '0';
      portEl.classList.remove('ready');
      // Restore standard revolver slot visibility outside chapter 7.
      document.querySelectorAll('.slot').forEach(el => {
        const slot = el.dataset.slot;
        if (!slot) return;
        if (slot === 'pickaxe' || slot === 'grenade') return;
        el.style.visibility = '';
      });
    }

    // Position each visible weapon slot around the wheel. The wheel
    // has 6 positions (pistol, shotgun, smg, rocket, raygun, flame),
    // arranged so the ACTIVE weapon sits at the bottom (180° from the
    // top, measuring clockwise from "north"). When the player switches
    // weapons, the wheel rotates so the new active weapon is at the
    // bottom — visually like a revolver cylinder turning.
    //
    // Order in the wheel (going clockwise starting from bottom):
    //   pistol → shotgun → smg → rocket → raygun → flame → (back to pistol)
    // The slot index times 60° gives its angular offset. We then
    // subtract the active weapon's angular position so it lands at
    // the bottom (0°, since translateY(-90px) at angle 0 is bottom).
    //
    // Wait — translateY(-90px) is UP in screen coords. We want the
    // active weapon at the BOTTOM. Solution: bake the wheel's base
    // rotation into the math: if angle 0° = top, then for the
    // active slot to sit at the bottom we offset by 180°. We
    // pre-compute each slot's effective angle so the active one
    // ends up at +180° (which is "down" in the wheel).
    const REVOLVER_ORDER = ['pistol', 'shotgun', 'smg', 'rocket', 'raygun', 'flamethrower'];
    const activeIdx = REVOLVER_ORDER.indexOf(S.currentWeapon);
    // If current weapon isn't in the revolver (e.g. pickaxe is
    // active during mining), we keep the wheel rotation from before
    // so it doesn't snap. Cache the last known active idx.
    if (activeIdx >= 0) {
      this._revolverActiveIdx = activeIdx;
    }
    const lastActive = (this._revolverActiveIdx != null) ? this._revolverActiveIdx : 0;
    const SLOT_SPACING = 360 / REVOLVER_ORDER.length;   // 60°
    // Active slot anchor angle — was 180° (bottom); user requested
    // top-left. With our coord system (0° = top, 90° = right, 180° =
    // bottom, 270° = left), top-left is 315°. The active slot is the
    // closest to the player's avatar (which sits to the upper-left of
    // the revolver wheel) so this reads as "your equipped weapon is
    // right next to you."
    const ACTIVE_ANGLE = 315;

    // Per-slot continuous angle tracking. CSS rotation transitions
    // interpolate LINEARLY through numerical angle values — so if a
    // slot's --revolver-angle jumps from 15° to 315°, CSS animates
    // 15→100→200→315 (300° the long way), instead of the visually
    // correct 15→0→315 (60° the short way).
    //
    // Fix: each slot tracks its current angle as an unbounded
    // continuous value. On each switch we compute the SHORT delta
    // (between -180° and +180°) from the slot's current angle to the
    // new target, and add that delta to the running angle. The
    // resulting CSS angle isn't clamped to [0, 360) — could be 720°,
    // -45°, etc — which is fine because rotate() handles unbounded
    // values correctly. Browsers happily transition rotate(720deg)
    // to rotate(780deg) as 60° of clockwise turn.
    if (!this._revolverSlotAngles) {
      this._revolverSlotAngles = {};
    }
    const angles = this._revolverSlotAngles;

    REVOLVER_ORDER.forEach((slotName, i) => {
      const el = document.querySelector('.slot[data-slot="' + slotName + '"]');
      if (!el) return;
      // Target angle this slot should land at, given the new active
      // index. Range [0, 360) before delta math.
      const target = (((i - lastActive) * SLOT_SPACING + ACTIVE_ANGLE) % 360 + 360) % 360;
      // Current accumulated angle (unbounded). First-call init: snap
      // to target so the very first paint doesn't animate from 0.
      if (angles[slotName] == null) {
        angles[slotName] = target;
        el.style.setProperty('--revolver-angle', target + 'deg');
        return;
      }
      // Compute the short delta. Reduce the current angle modulo 360
      // for comparison, then pick the direction that takes ≤ 180°.
      const currentMod = ((angles[slotName] % 360) + 360) % 360;
      let delta = target - currentMod;
      if (delta > 180) delta -= 360;
      else if (delta < -180) delta += 360;
      // Apply the short delta to the unbounded running angle. The
      // CSS will transition from old → new linearly across exactly
      // |delta| degrees in the right direction.
      angles[slotName] += delta;
      el.style.setProperty('--revolver-angle', angles[slotName] + 'deg');
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

  showBossBar(name, tintHex) {
    document.getElementById('boss-name').textContent = name;
    const fill = document.getElementById('boss-bar-fill');
    fill.style.width = '100%';
    // Apply chapter tint to the bar, label, and outer glow. When no tint is
    // provided we fall back to the default CSS (hp-red) so legacy calls still
    // render correctly.
    if (typeof tintHex === 'number') {
      const hex = '#' + tintHex.toString(16).padStart(6, '0');
      // Brighter mid-stop for the gradient's "sheen" highlight.
      const lighter = this._lighten(tintHex, 0.35);
      fill.style.background = `linear-gradient(90deg, ${hex}, ${lighter}, ${hex})`;
      fill.style.boxShadow = `0 0 10px ${hex}`;
      const outer = document.querySelector('#boss-bar .boss-bar-outer');
      if (outer) {
        outer.style.borderColor = hex;
        outer.style.boxShadow = `0 0 14px ${hex}`;
      }
      const label = document.getElementById('boss-name');
      if (label) {
        label.style.color = hex;
        label.style.textShadow = `0 0 12px ${hex}, 2px 2px 0 #000`;
      }
    }
    document.getElementById('boss-bar').classList.remove('hidden');
    // Tag the body so CSS can react — used to hide the score row on
    // mobile when the boss bar is up (the two stack on top of each
    // other and clobber each other's readability on a phone).
    document.body.classList.add('boss-active');
  },

  // Blend a hex color toward white by `amt` (0..1). Used for boss-bar gradient sheen.
  _lighten(hex, amt) {
    const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
    const lr = Math.min(255, Math.round(r + (255 - r) * amt));
    const lg = Math.min(255, Math.round(g + (255 - g) * amt));
    const lb = Math.min(255, Math.round(b + (255 - b) * amt));
    return '#' + ((lr << 16) | (lg << 8) | lb).toString(16).padStart(6, '0');
  },

  updateBossBar(pct) {
    document.getElementById('boss-bar-fill').style.width = (pct * 100) + '%';
  },

  hideBossBar() {
    document.getElementById('boss-bar').classList.add('hidden');
    document.body.classList.remove('boss-active');
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
