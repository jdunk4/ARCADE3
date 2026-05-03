// ============================================================
// AVATAR PICKER — swipeable character selection on title screen
//
// Displays a horizontal carousel of avatar options. Player swipes
// or clicks arrows to browse. Selecting an avatar calls
// swapAvatarGLB to load the chosen GLB as the player character.
//
// Avatars: PixlPals (orange #928, blue #108), Gobs (red #406,
// green #1004), Flingers (yellow, purple), and the default Meebit.
// ============================================================

import { swapAvatarGLB } from './player.js';
import { Save } from './save.js';
import { S } from './state.js';

const AVATARS = [
  { id: 'meebit',         name: 'MEEBIT',          url: 'assets/16801_original.vrm', color: '#00ff66', type: 'DEFAULT' },
  { id: 'pixlpal-928',    name: 'PIXLPAL #928',     url: 'assets/civilians/pixlpal/voxlpal-928.glb',  color: '#ff8844', type: 'PIXLPAL' },
  { id: 'pixlpal-108',    name: 'PIXLPAL #108',     url: 'assets/civilians/pixlpal/voxlpal-108.glb',  color: '#44aaff', type: 'PIXLPAL' },
  { id: 'gob-406',        name: 'GOB #406',          url: 'assets/civilians/gobs/406.glb',             color: '#ff3344', type: 'GOB' },
  { id: 'gob-1004',       name: 'GOB #1004',         url: 'assets/civilians/gobs/1004.glb',            color: '#44ff66', type: 'GOB' },
  { id: 'flinger-yellow',  name: 'FLINGER YELLOW',   url: 'assets/civilians/flingers/FlingerYELLOW.glb', color: '#ffdd44', type: 'FLINGER' },
  { id: 'flinger-purple',  name: 'FLINGER PURPLE',   url: 'assets/civilians/flingers/FlingerPURPLE.glb', color: '#bb44ff', type: 'FLINGER' },
];

let _overlay = null;
let _currentIdx = 0;
let _isOpen = false;
let _onClose = null;

function _buildUI() {
  if (_overlay) return _overlay;

  const el = document.createElement('div');
  el.id = 'avatar-picker';
  el.innerHTML = `
    <style>
      #avatar-picker {
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(0,0,0,0.92);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        font-family: 'Courier New', monospace;
        color: #00ff66;
        opacity: 0; transition: opacity 0.3s ease;
      }
      #avatar-picker.visible { opacity: 1; }

      #avatar-picker .ap-title {
        font-family: 'Impact', 'Arial Black', sans-serif;
        font-size: 28px; letter-spacing: 6px;
        margin-bottom: 8px; color: #6dff95;
        text-shadow: 0 0 12px rgba(0,255,102,0.5);
      }
      #avatar-picker .ap-sub {
        font-size: 12px; letter-spacing: 4px;
        color: #6effaa; opacity: 0.7; margin-bottom: 30px;
      }

      #avatar-picker .ap-carousel {
        display: flex; align-items: center; gap: 20px;
        margin-bottom: 30px;
      }
      #avatar-picker .ap-arrow {
        font-size: 48px; cursor: pointer; color: #00ff66;
        user-select: none; -webkit-user-select: none;
        transition: transform 0.15s, color 0.15s;
        text-shadow: 0 0 12px rgba(0,255,102,0.4);
      }
      #avatar-picker .ap-arrow:hover {
        transform: scale(1.2); color: #fff;
      }

      #avatar-picker .ap-card {
        width: 220px; height: 280px;
        border: 2px solid #00ff66;
        border-radius: 12px;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        background: rgba(0,20,10,0.6);
        box-shadow: 0 0 20px rgba(0,255,102,0.2);
        transition: border-color 0.3s, box-shadow 0.3s;
        position: relative; overflow: hidden;
      }
      #avatar-picker .ap-card .ap-type {
        position: absolute; top: 10px; left: 0; right: 0;
        text-align: center; font-size: 10px;
        letter-spacing: 4px; opacity: 0.6;
      }
      #avatar-picker .ap-card .ap-icon {
        font-size: 80px; margin-bottom: 12px;
        filter: drop-shadow(0 0 8px currentColor);
      }
      #avatar-picker .ap-card .ap-name {
        font-size: 16px; letter-spacing: 3px;
        font-weight: bold;
      }
      #avatar-picker .ap-card .ap-idx {
        font-size: 11px; opacity: 0.5; margin-top: 6px;
      }

      #avatar-picker .ap-actions {
        display: flex; gap: 16px;
      }
      #avatar-picker .ap-btn {
        font-family: 'Impact', 'Arial Black', sans-serif;
        font-size: 18px; letter-spacing: 4px;
        padding: 14px 40px;
        background: transparent; color: #00ff66;
        border: 2px solid #00ff66; cursor: pointer;
        box-shadow: 0 0 12px rgba(0,255,102,0.3);
        transition: all 0.2s;
      }
      #avatar-picker .ap-btn:hover {
        background: #00ff66; color: #000;
        box-shadow: 0 0 30px rgba(0,255,102,0.7);
        transform: scale(1.05);
      }
      #avatar-picker .ap-btn-cancel {
        border-color: #666; color: #999;
        box-shadow: none;
      }
      #avatar-picker .ap-btn-cancel:hover {
        background: #333; color: #fff;
        border-color: #999; box-shadow: none;
      }
      #avatar-picker .ap-loading {
        font-size: 13px; color: #ffdd44;
        letter-spacing: 3px; margin-top: 12px;
        min-height: 20px;
      }

      @media (max-width: 600px) {
        #avatar-picker .ap-card { width: 170px; height: 220px; }
        #avatar-picker .ap-card .ap-icon { font-size: 56px; }
        #avatar-picker .ap-arrow { font-size: 36px; }
        #avatar-picker .ap-btn { font-size: 14px; padding: 10px 24px; }
      }
    </style>

    <div class="ap-title">SWITCH AVATAR</div>
    <div class="ap-sub">:: SELECT YOUR OPERATIVE ::</div>

    <div class="ap-carousel">
      <div class="ap-arrow" id="ap-prev">◀</div>
      <div class="ap-card" id="ap-card">
        <div class="ap-type" id="ap-type"></div>
        <div class="ap-icon" id="ap-icon"></div>
        <div class="ap-name" id="ap-name"></div>
        <div class="ap-idx" id="ap-idx"></div>
      </div>
      <div class="ap-arrow" id="ap-next">▶</div>
    </div>

    <div class="ap-actions">
      <button class="ap-btn ap-btn-cancel" id="ap-cancel">CANCEL</button>
      <button class="ap-btn" id="ap-select">SELECT</button>
    </div>
    <div class="ap-loading" id="ap-loading"></div>
  `;

  // Wire events
  el.querySelector('#ap-prev').addEventListener('click', () => _navigate(-1));
  el.querySelector('#ap-next').addEventListener('click', () => _navigate(1));
  el.querySelector('#ap-cancel').addEventListener('click', closeAvatarPicker);
  el.querySelector('#ap-select').addEventListener('click', _selectCurrent);

  // Swipe support
  let touchStartX = 0;
  el.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) _navigate(dx < 0 ? 1 : -1);
  }, { passive: true });

  // Keyboard
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') _navigate(-1);
    if (e.key === 'ArrowRight') _navigate(1);
    if (e.key === 'Enter') _selectCurrent();
    if (e.key === 'Escape') closeAvatarPicker();
  });

  _overlay = el;
  return el;
}

const ICONS = {
  DEFAULT: '🤖',
  PIXLPAL: '🟦',
  GOB:     '👹',
  FLINGER: '🔨',
};

function _render() {
  const av = AVATARS[_currentIdx];
  const card = _overlay.querySelector('#ap-card');
  const icon = _overlay.querySelector('#ap-icon');
  const name = _overlay.querySelector('#ap-name');
  const type = _overlay.querySelector('#ap-type');
  const idx = _overlay.querySelector('#ap-idx');

  card.style.borderColor = av.color;
  card.style.boxShadow = `0 0 24px ${av.color}44`;
  icon.textContent = ICONS[av.type] || '?';
  icon.style.color = av.color;
  name.textContent = av.name;
  name.style.color = av.color;
  type.textContent = av.type;
  idx.textContent = `${_currentIdx + 1} / ${AVATARS.length}`;
  _overlay.querySelector('#ap-loading').textContent = '';
}

function _navigate(dir) {
  _currentIdx = (_currentIdx + dir + AVATARS.length) % AVATARS.length;
  _render();
  // Quick card bounce
  const card = _overlay.querySelector('#ap-card');
  card.style.transform = `translateX(${dir * -20}px)`;
  requestAnimationFrame(() => {
    card.style.transition = 'transform 0.2s ease-out';
    card.style.transform = '';
    setTimeout(() => { card.style.transition = ''; }, 200);
  });
}

function _selectCurrent() {
  const av = AVATARS[_currentIdx];
  const loading = _overlay.querySelector('#ap-loading');
  loading.textContent = 'LOADING...';

  // Save selection
  const rec = Save.load();
  rec.avatarId = av.id;
  rec.avatarUrl = av.url;
  Save.save(rec);

  // Store on state for immediate use
  S.avatarId = av.id;
  S.avatarUrl = av.url;

  swapAvatarGLB(av.url,
    () => {
      loading.textContent = 'LOADED ✓';
      setTimeout(closeAvatarPicker, 400);
    },
    (err) => {
      console.warn('[avatar-picker] load failed:', err);
      loading.textContent = 'FAILED — TRY ANOTHER';
    }
  );
}

export function openAvatarPicker(onCloseCb) {
  if (_isOpen) return;
  _isOpen = true;
  _onClose = onCloseCb || null;

  const el = _buildUI();
  if (!el.parentNode) document.body.appendChild(el);
  _render();
  requestAnimationFrame(() => el.classList.add('visible'));
  el.focus();
}

export function closeAvatarPicker() {
  if (!_isOpen || !_overlay) return;
  _isOpen = false;
  _overlay.classList.remove('visible');
  setTimeout(() => {
    if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
  }, 300);
  if (_onClose) { _onClose(); _onClose = null; }
}

export function isAvatarPickerOpen() { return _isOpen; }
