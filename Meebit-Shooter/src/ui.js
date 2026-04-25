import * as THREE from 'three';
import { S } from './state.js';
import { WEAPONS, CHAPTERS, WAVES_PER_CHAPTER, BLOCK_CONFIG, PARADISE_FALLEN_CHAPTER_IDX, CH7_WAVE_COUNT } from './config.js';
import { getWaveDef_current } from './waves.js';

// Reusable scratch vectors
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();

export const UI = {
  updateHUD() {
    document.getElementById('score').textContent = S.score.toLocaleString();
    document.getElementById('wave-num').textContent = S.wave;
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
        'top: 86px',
        'left: 50%',
        'transform: translateX(-50%)',
        'font-family: "VT323", "Courier New", monospace',
        'font-weight: bold',
        'pointer-events: none',
        'text-shadow: 0 0 8px currentColor, 0 2px 4px rgba(0,0,0,0.8)',
        'z-index: 50',
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
        'top: 16px',
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

    const chapEl = document.getElementById('chapter-readout');
    if (chapEl) {
      const chapName = CHAPTERS[S.chapter % CHAPTERS.length].name;
      // CREDITS WAVE — a boss-into-credits sequence that plays after the
      // ch7 finale. It's not part of the chapter's wave count, so we show
      // "CREDITS" in place of the W{n}/{total} readout. Driven by the
      // `creditsWave` flag on the active wave def (getWaveDef_current).
      const curDef = (typeof getWaveDef_current === 'function') ? getWaveDef_current() : null;
      if (curDef && curDef.creditsWave) {
        chapEl.textContent = 'CH.' + (S.chapter + 1) + ' · ' + chapName + ' · CREDITS';
      } else {
        // Ch.7 only has 3 waves; show "/3" instead of "/5" so the HUD is
        // honest about the shorter finale chapter.
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

  updateWeaponSlots() {
    // Inject the revolver CSS once on first call. We do it from JS
    // (rather than editing styles.css) so this redesign drops in as
    // a single ui.js change without touching index.html or any
    // stylesheet. The injected rules:
    //
    //   - Move the #weapon-slots container to the bottom-right corner
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
        /* Hide pickaxe + grenade slots — game logic still uses both
           internally, but they don't appear in the visible revolver.
           Pickaxe is auto-toggled when mining; grenades have their own
           top-left inventory widget. */
        .slot[data-slot="pickaxe"],
        .slot[data-slot="grenade"] {
          display: none !important;
        }

        /* Container — sit in bottom-right corner, big enough to hold
           the revolver wheel. Pointer-events stays auto so clicking
           a slot still works to switch weapons. */
        #weapon-slots {
          position: fixed !important;
          bottom: 130px !important;     /* above the FIRE button on mobile */
          right: 130px !important;
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
        @media (min-width: 900px) {
          /* On desktop the FIRE button is hidden, so we can tuck the
             revolver into the corner without leaving room for it. */
          #weapon-slots {
            bottom: 24px !important;
            right: 24px !important;
          }
        }

        /* Each weapon slot becomes one position on the wheel. The
           common base CSS positions every visible slot at the wheel's
           CENTER; the .revolver-pos-N classes added by JS rotate them
           outward and around. Active slot is highlighted with a glow
           and scaled up. */
        #weapon-slots .slot {
          position: absolute !important;
          left: 50% !important;
          top: 50% !important;
          width: 64px !important;
          height: 64px !important;
          margin: 0 !important;
          /* Translate -50% -50% to center the slot on the position,
             then a per-slot transform layered via CSS variable handles
             the angular placement. The variable is set inline by JS
             whenever the wheel rotates. */
          transform: translate(-50%, -50%) rotate(var(--revolver-angle, 0deg)) translateY(-90px) rotate(calc(-1 * var(--revolver-angle, 0deg))) !important;
          transition: transform 0.4s cubic-bezier(0.5, 0, 0.2, 1.4),
                      opacity 0.3s ease-out,
                      box-shadow 0.3s ease-out;
          pointer-events: auto;
          /* Reset any margins/padding from the base .slot rule */
          flex: none !important;
        }

        /* Active slot — bigger, glowing, lifted forward from the wheel.
           CSS variables make this composable with the angular position
           transform above. */
        #weapon-slots .slot.active {
          transform: translate(-50%, -50%) rotate(var(--revolver-angle, 0deg)) translateY(-90px) rotate(calc(-1 * var(--revolver-angle, 0deg))) scale(1.35) !important;
          box-shadow: 0 0 24px rgba(255, 215, 80, 0.85),
                      0 0 8px rgba(255, 215, 80, 1) !important;
          z-index: 2 !important;
        }

        /* Owned but inactive slots — visible, slightly dimmed */
        #weapon-slots .slot.owned:not(.active) {
          opacity: 0.85;
        }

        /* Unowned slots — heavily dimmed but still visible so the
           player can see their roster of unlockable weapons. Dotted
           border hints "not yet acquired." */
        #weapon-slots .slot:not(.owned) {
          opacity: 0.30;
          filter: grayscale(0.7);
        }

        /* Hide weapon-name text on mobile to declutter the wheel */
        @media (max-width: 600px) {
          #weapon-slots .slot .label {
            font-size: 9px !important;
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
    });

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
    const REVOLVER_ORDER = ['pistol', 'shotgun', 'smg', 'rocket', 'raygun', 'flame'];
    const activeIdx = REVOLVER_ORDER.indexOf(S.currentWeapon);
    // If current weapon isn't in the revolver (e.g. pickaxe is
    // active during mining), we keep the wheel rotation from before
    // so it doesn't snap. Cache the last known active idx.
    if (activeIdx >= 0) {
      this._revolverActiveIdx = activeIdx;
    }
    const lastActive = (this._revolverActiveIdx != null) ? this._revolverActiveIdx : 0;
    const SLOT_SPACING = 360 / REVOLVER_ORDER.length;   // 60°
    REVOLVER_ORDER.forEach((slotName, i) => {
      const el = document.querySelector('.slot[data-slot="' + slotName + '"]');
      if (!el) return;
      // Angle offset from the active position (which sits at bottom).
      // The bottom is angle 180° in our coord system (0° = top, 90° = right).
      // We compute (i - lastActive) * SLOT_SPACING — this is the slot's
      // angular distance from the active one — then add 180° so the
      // active slot lands at the bottom.
      const rel = ((i - lastActive) * SLOT_SPACING + 180 + 360) % 360;
      el.style.setProperty('--revolver-angle', rel + 'deg');
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
