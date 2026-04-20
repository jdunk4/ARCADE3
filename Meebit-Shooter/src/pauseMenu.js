// Pause menu overlay. Toggled by Escape (wired from main.js). Exposes
// SFX volume, Music volume, and a mute toggle. Also displays RESUME /
// QUIT buttons.
//
// Markup is injected at runtime so no index.html changes are required
// beyond including this file in the module graph.

import { Audio } from './audio.js';

let rootEl = null;
let isVisible = false;
let onResumeFn = null;
let onQuitFn = null;

function buildMarkup() {
  const el = document.createElement('div');
  el.id = 'pause-menu';
  el.className = 'overlay hidden';
  el.innerHTML = `
    <div class="pause-panel">
      <h1>PAUSED</h1>
      <h2>SYSTEM HALTED</h2>

      <div class="pause-row">
        <label for="vol-music">\ud83c\udfb5 SOUNDTRACK</label>
        <input type="range" id="vol-music" min="0" max="100" step="1" />
        <span class="vol-readout" id="vol-music-pct">50%</span>
      </div>

      <div class="pause-row">
        <label for="vol-sfx">\ud83d\udd2b SOUND EFFECTS</label>
        <input type="range" id="vol-sfx" min="0" max="100" step="1" />
        <span class="vol-readout" id="vol-sfx-pct">70%</span>
      </div>

      <div class="pause-row pause-row-toggle">
        <label for="vol-mute">\ud83d\udd07 MUTE ALL</label>
        <input type="checkbox" id="vol-mute" />
      </div>

      <div class="pause-actions">
        <button class="cta pause-resume" id="pause-resume-btn">\u25b6 RESUME</button>
        <button class="cta pause-quit" id="pause-quit-btn">\u23f9 QUIT RUN</button>
      </div>

      <p class="pause-hint">Press ESC or click RESUME to continue</p>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

function injectStyles() {
  if (document.getElementById('pause-menu-styles')) return;
  const s = document.createElement('style');
  s.id = 'pause-menu-styles';
  s.textContent = `
    #pause-menu { z-index: 150; }
    #pause-menu .pause-panel {
      background: rgba(10, 4, 22, 0.92);
      border: 2px solid var(--matrix-green, #00ff66);
      box-shadow: 0 0 40px rgba(0,255,102,0.4), inset 0 0 40px rgba(0,255,102,0.08);
      padding: 40px 56px;
      max-width: 520px; width: 92%;
      display: flex; flex-direction: column; gap: 18px;
      align-items: stretch;
    }
    #pause-menu h1 {
      font-size: 72px; letter-spacing: 6px;
      color: var(--matrix-green, #00ff66);
      text-shadow: 0 0 14px var(--matrix-green, #00ff66), 4px 4px 0 #000;
      margin-bottom: 4px;
    }
    #pause-menu h2 {
      font-size: 14px; letter-spacing: 4px;
      color: var(--xp-yellow, #ffd93d);
      margin-bottom: 18px;
    }
    .pause-row {
      display: grid;
      grid-template-columns: 180px 1fr 48px;
      gap: 12px; align-items: center;
      padding: 10px 14px;
      background: rgba(0,0,0,0.4);
      border: 1px solid rgba(0,255,102,0.25);
    }
    .pause-row label {
      font-family: 'Impact', monospace;
      font-size: 13px; letter-spacing: 2px;
      color: #fff; text-align: left;
    }
    .pause-row input[type="range"] {
      -webkit-appearance: none; appearance: none;
      width: 100%; height: 6px;
      background: rgba(0,255,102,0.15);
      border: 1px solid var(--matrix-green, #00ff66);
      outline: none;
      cursor: pointer;
    }
    .pause-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 18px; height: 18px;
      background: var(--matrix-green, #00ff66);
      border: 2px solid #000;
      box-shadow: 0 0 8px var(--matrix-green, #00ff66);
      cursor: pointer;
    }
    .pause-row input[type="range"]::-moz-range-thumb {
      width: 18px; height: 18px;
      background: var(--matrix-green, #00ff66);
      border: 2px solid #000;
      box-shadow: 0 0 8px var(--matrix-green, #00ff66);
      cursor: pointer;
    }
    .pause-row .vol-readout {
      font-family: 'Courier New', monospace;
      font-size: 12px; letter-spacing: 1px;
      color: var(--matrix-green, #00ff66);
      text-align: right;
    }
    .pause-row-toggle {
      grid-template-columns: 180px 1fr;
    }
    .pause-row-toggle input[type="checkbox"] {
      justify-self: start;
      width: 20px; height: 20px;
      accent-color: var(--matrix-green, #00ff66);
      cursor: pointer;
    }
    .pause-actions {
      display: flex; gap: 14px; justify-content: center;
      margin-top: 14px;
    }
    #pause-menu .cta {
      margin-top: 0;
      font-size: 18px; padding: 10px 24px;
      letter-spacing: 3px;
      flex: 1;
    }
    #pause-menu .pause-quit {
      color: var(--hp-red, #ff2e4d);
      border-color: var(--hp-red, #ff2e4d);
    }
    #pause-menu .pause-quit:hover {
      background: var(--hp-red, #ff2e4d);
      color: #000;
    }
    .pause-hint {
      font-size: 11px; letter-spacing: 2px;
      color: #888; text-align: center;
      margin-top: 6px;
    }
    @media (max-width: 600px) {
      .pause-row { grid-template-columns: 130px 1fr 40px; }
      .pause-row-toggle { grid-template-columns: 130px 1fr; }
      #pause-menu .pause-panel { padding: 24px 20px; }
      #pause-menu h1 { font-size: 48px; }
      #pause-menu .cta { font-size: 14px; padding: 8px 12px; }
    }
  `;
  document.head.appendChild(s);
}

function wireInputs() {
  const musicSlider = document.getElementById('vol-music');
  const sfxSlider = document.getElementById('vol-sfx');
  const muteBox = document.getElementById('vol-mute');
  const musicPct = document.getElementById('vol-music-pct');
  const sfxPct = document.getElementById('vol-sfx-pct');
  const resumeBtn = document.getElementById('pause-resume-btn');
  const quitBtn = document.getElementById('pause-quit-btn');

  // Initial values from Audio engine (which already loaded prefs)
  musicSlider.value = Math.round(Audio.musicVolume * 100);
  sfxSlider.value = Math.round(Audio.sfxVolume * 100);
  muteBox.checked = Audio.muted;
  musicPct.textContent = musicSlider.value + '%';
  sfxPct.textContent = sfxSlider.value + '%';

  musicSlider.addEventListener('input', () => {
    const v = parseInt(musicSlider.value, 10) / 100;
    Audio.setMusicVolume(v);
    musicPct.textContent = musicSlider.value + '%';
  });
  sfxSlider.addEventListener('input', () => {
    const v = parseInt(sfxSlider.value, 10) / 100;
    Audio.setSfxVolume(v);
    sfxPct.textContent = sfxSlider.value + '%';
    // Play a small test click so the user can hear the change
    try { Audio.pickup(); } catch (e) {}
  });
  muteBox.addEventListener('change', () => {
    Audio.setMuted(muteBox.checked);
  });

  resumeBtn.addEventListener('click', () => {
    hide();
    if (onResumeFn) onResumeFn();
  });
  quitBtn.addEventListener('click', () => {
    if (!confirm('Quit this run and return to the title screen?')) return;
    hide();
    if (onQuitFn) onQuitFn();
  });
}

function ensureReady() {
  if (rootEl) return;
  injectStyles();
  rootEl = buildMarkup();
  wireInputs();
}

export function show() {
  ensureReady();
  // Refresh slider values in case the user changed things elsewhere
  const musicSlider = document.getElementById('vol-music');
  const sfxSlider = document.getElementById('vol-sfx');
  const muteBox = document.getElementById('vol-mute');
  const musicPct = document.getElementById('vol-music-pct');
  const sfxPct = document.getElementById('vol-sfx-pct');
  if (musicSlider) {
    musicSlider.value = Math.round(Audio.musicVolume * 100);
    musicPct.textContent = musicSlider.value + '%';
  }
  if (sfxSlider) {
    sfxSlider.value = Math.round(Audio.sfxVolume * 100);
    sfxPct.textContent = sfxSlider.value + '%';
  }
  if (muteBox) muteBox.checked = Audio.muted;

  rootEl.classList.remove('hidden');
  isVisible = true;
}

export function hide() {
  if (!rootEl) return;
  rootEl.classList.add('hidden');
  isVisible = false;
}

export function isOpen() { return isVisible; }

export function setHandlers({ onResume, onQuit }) {
  onResumeFn = onResume || null;
  onQuitFn = onQuit || null;
}
