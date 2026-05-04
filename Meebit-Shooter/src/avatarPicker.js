// ============================================================
// AVATAR PICKER — fullscreen 3D preview with GLB loading,
// matrix rain backdrop, and collectible shard unlock system.
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { swapAvatarGLB } from './player.js';
import { S } from './state.js';
import { getShardProgress, isAvatarUnlocked, SHARDS_PER_AVATAR, getStoneInventory, spendStoneOnAvatar, addStones } from './avatarShards.js';
import { getOreBalance, spendOre } from './runReward.js';

const AVATARS = [
  { id: 'meebit',          name: 'MEEBIT',         url: 'assets/16801_original.vrm',                    color: '#ffffff', type: 'DEFAULT' },
  { id: 'pixlpal-928',     name: 'PIXLPAL #928',   url: 'assets/civilians/pixlpal/voxlpal-928.glb',     color: '#ff8844', type: 'PIXLPAL' },
  { id: 'gob-406',         name: 'GOB #406',        url: 'assets/civilians/gobs/406.glb',                color: '#ff3344', type: 'GOB' },
  { id: 'flinger-yellow',  name: 'FLINGER YELLOW',  url: 'assets/civilians/flingers/FlingerYELLOW.glb',  color: '#ffdd44', type: 'FLINGER' },
  { id: 'gob-1004',        name: 'GOB #1004',       url: 'assets/civilians/gobs/1004.glb',               color: '#44ff66', type: 'GOB' },
  { id: 'pixlpal-108',     name: 'PIXLPAL #108',    url: 'assets/civilians/pixlpal/voxlpal-108.glb',     color: '#44aaff', type: 'PIXLPAL' },
  { id: 'flinger-purple',  name: 'FLINGER PURPLE',  url: 'assets/civilians/flingers/FlingerPURPLE.glb',  color: '#bb44ff', type: 'FLINGER' },
];

let _overlay = null;
let _currentIdx = 0;
let _isOpen = false;
let _onClose = null;

// 3D preview
let _pvScene = null, _pvCamera = null, _pvRenderer = null;
let _pvModel = null, _pvRaf = 0, _pvCanvas = null;
const _pvCache = new Map();

// Matrix rain state
let _rainCanvas = null, _rainCtx = null, _rainDrops = null;
let _rainRGB = '255,255,255';

const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789:.-=*+';
function _randGlyph() { return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]; }

function _hexToRGB(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  const n = parseInt(h, 16);
  return `${(n>>16)&0xff},${(n>>8)&0xff},${n&0xff}`;
}

// ============================================================
// 3D PREVIEW
// ============================================================

function _initPreview() {
  if (_pvScene) return;
  _pvScene = new THREE.Scene();
  _pvScene.background = null; // transparent — rain canvas shows through

  _pvCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  _pvCamera.position.set(0, 1.8, 6.5);
  _pvCamera.lookAt(0, 1.0, 0);

  _pvScene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(2, 4, 3); _pvScene.add(key);
  const fill = new THREE.DirectionalLight(0x88ccff, 0.6);
  fill.position.set(-2, 2, -1); _pvScene.add(fill);
  const rim = new THREE.DirectionalLight(0x44ff88, 0.4);
  rim.position.set(0, 1, -3); _pvScene.add(rim);

  const grid = new THREE.GridHelper(6, 12, 0x00ff66, 0x003311);
  grid.material.opacity = 0.3; grid.material.transparent = true;
  _pvScene.add(grid);
}

function _ensureRenderer() {
  if (_pvRenderer) return;
  _pvCanvas = document.getElementById('ap-3d-canvas');
  if (!_pvCanvas) return;
  _pvRenderer = new THREE.WebGLRenderer({ canvas: _pvCanvas, antialias: true, alpha: true });
  _pvRenderer.setClearColor(0x000000, 0);
  _pvRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _pvRenderer.outputColorSpace = THREE.SRGBColorSpace;
  _pvRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  _pvRenderer.toneMappingExposure = 1.2;
  _resizePreview();
}

function _resizePreview() {
  if (!_pvRenderer || !_pvCanvas) return;
  const c = _pvCanvas.parentElement;
  if (!c) return;
  _pvRenderer.setSize(c.clientWidth, c.clientHeight);
  _pvCamera.aspect = c.clientWidth / c.clientHeight;
  _pvCamera.updateProjectionMatrix();
  _resizeRainCanvas();
}

// ============================================================
// MATRIX RAIN
// ============================================================

function _initRainCanvas() {
  _rainCanvas = document.getElementById('ap-rain-canvas');
  if (!_rainCanvas) return;
  _rainCtx = _rainCanvas.getContext('2d');
  _resizeRainCanvas();
}

function _resizeRainCanvas() {
  if (!_rainCanvas) return;
  const c = _rainCanvas.parentElement;
  if (!c) return;
  _rainCanvas.width = c.clientWidth;
  _rainCanvas.height = c.clientHeight;
  const FONT_SIZE = 14;
  const colCount = Math.ceil(_rainCanvas.width / FONT_SIZE);
  _rainDrops = new Array(colCount);
  for (let i = 0; i < colCount; i++) {
    _rainDrops[i] = { y: -Math.random() * 30, trail: [] };
  }
}

function _setRainColor(colorHex) {
  _rainRGB = _hexToRGB(colorHex);
}

function _tickRain() {
  if (!_rainCtx || !_rainDrops || !_rainCanvas) return;
  const w = _rainCanvas.width;
  const h = _rainCanvas.height;
  if (w === 0 || h === 0) return;
  const FONT_SIZE = 14;
  const TRAIL_LEN = 16;
  const ctx = _rainCtx;

  ctx.fillStyle = 'rgba(0, 4, 2, 0.12)';
  ctx.fillRect(0, 0, w, h);
  ctx.font = FONT_SIZE + 'px monospace';

  for (let i = 0; i < _rainDrops.length; i++) {
    const d = _rainDrops[i];
    const x = i * FONT_SIZE;
    d.y += 0.6 + Math.random() * 0.3;
    d.trail.unshift({ y: d.y, glyph: _randGlyph() });
    if (d.trail.length > TRAIL_LEN) d.trail.pop();

    for (let t = 0; t < d.trail.length; t++) {
      const entry = d.trail[t];
      const py = entry.y * FONT_SIZE;
      if (py < -FONT_SIZE || py > h + FONT_SIZE) continue;
      const alpha = t === 0 ? 0.95 : 0.7 * Math.pow(0.82, t);
      ctx.fillStyle = 'rgba(' + _rainRGB + ',' + alpha.toFixed(3) + ')';
      ctx.fillText(entry.glyph, x, py);
    }

    if (d.y * FONT_SIZE > h && Math.random() > 0.975) {
      d.y = -Math.random() * 10;
      d.trail.length = 0;
    }
  }
}

// ============================================================
// MODEL LOADING
// ============================================================

function _loadModel(av) {
  _updateUI('LOADING...');
  if (_pvModel) { _pvScene.remove(_pvModel); _pvModel = null; }
  _setRainColor(av.color);

  if (_pvCache.has(av.id)) {
    _placeModel(_pvCache.get(av.id).clone(), av);
    return;
  }

  const loader = new GLTFLoader();
  loader.load(av.url, (gltf) => {
    const model = gltf.scene;
    _pvCache.set(av.id, model.clone());
    _placeModel(model, av);
  }, undefined, (err) => {
    console.warn('[avatar] load fail:', av.url, err);
    _updateUI('ASSET NOT FOUND');
  });
}

function _placeModel(model, av) {
  model.position.set(0, 0, 0);
  model.scale.setScalar(1);
  model.rotation.set(0, 0, 0);

  let isVRM = av.url.endsWith('.vrm');
  if (!isVRM) {
    model.traverse((o) => {
      if (o.isBone && o.name === 'HipsBone') isVRM = true;
    });
  }
  if (isVRM) model.rotation.y = Math.PI;

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  model.scale.setScalar(2.0 / maxDim);

  const wrapper = new THREE.Group();
  const box2 = new THREE.Box3().setFromObject(model);
  const center2 = box2.getCenter(new THREE.Vector3());
  const min2 = box2.min;
  model.position.x = -center2.x;
  model.position.z = -center2.z;
  model.position.y = -min2.y;

  wrapper.add(model);
  _pvScene.add(wrapper);
  _pvModel = wrapper;
  _updateUI('');
}

// ============================================================
// RENDER LOOP
// ============================================================

function _renderLoop() {
  _pvRaf = requestAnimationFrame(_renderLoop);
  _tickRain();
  if (!_pvRenderer) return;
  if (_pvModel) _pvModel.rotation.y += 0.008;
  _pvRenderer.render(_pvScene, _pvCamera);
}

// ============================================================
// UI
// ============================================================

function _updateUI(loadText) {
  if (!_overlay) return;
  const av = AVATARS[_currentIdx];
  const el = (id) => _overlay.querySelector('#' + id);

  const preview = el('ap-preview');
  if (preview) {
    preview.style.borderColor = av.color;
    preview.style.boxShadow = '0 0 30px ' + av.color + '22, inset 0 0 60px ' + av.color + '08';
  }
  _overlay.querySelectorAll('.ap-corner-tl,.ap-corner-tr,.ap-corner-bl,.ap-corner-br').forEach(c => {
    c.style.borderColor = av.color;
  });

  const name = el('ap-name');
  if (name) { name.textContent = av.name; name.style.color = av.color; }
  const type = el('ap-type');
  if (type) type.textContent = av.type;
  const idx = el('ap-idx');
  if (idx) idx.textContent = (_currentIdx+1) + ' / ' + AVATARS.length;
  const ld = el('ap-loading');
  if (ld) ld.textContent = loadText || '';

  // Shard progress diamonds
  const unlocked = isAvatarUnlocked(av.id);
  const progress = getShardProgress(av.id);
  const shardRow = el('ap-shards');
  if (shardRow) {
    if (av.id === 'meebit') {
      shardRow.style.display = 'none';
    } else {
      shardRow.style.display = 'flex';
      const diamonds = shardRow.querySelectorAll('.ap-shard');
      for (let i = 0; i < diamonds.length; i++) {
        if (i < progress.collected) {
          diamonds[i].classList.add('filled');
          diamonds[i].style.color = av.color;
          diamonds[i].style.textShadow = '0 0 8px ' + av.color;
        } else {
          diamonds[i].classList.remove('filled');
          diamonds[i].style.color = '#333';
          diamonds[i].style.textShadow = 'none';
        }
      }
    }
  }

  // Lock overlay + rain z-index swap
  const lockEl = el('ap-lock');
  const previewEl = el('ap-preview');
  if (lockEl) lockEl.style.display = unlocked ? 'none' : 'flex';
  if (previewEl) {
    if (unlocked || av.id === 'meebit') {
      previewEl.classList.remove('locked');
    } else {
      previewEl.classList.add('locked');
    }
  }

  // Corner stones — light up based on shard progress (4 stones = 4 shards)
  for (let i = 0; i < 4; i++) {
    const stone = el('ap-stone-' + i);
    if (!stone) continue;
    if (av.id === 'meebit') {
      // Default avatar — all stones lit in white
      stone.className = 'ap-stone ap-stone-' + ['tl','tr','bl','br'][i] + ' lit';
      stone.style.background = 'rgba(255,255,255,0.7)';
      stone.style.boxShadow = '0 0 10px rgba(255,255,255,0.5), 0 0 20px rgba(255,255,255,0.2)';
    } else if (i < progress.collected) {
      // Collected shard — lit in avatar color
      stone.className = 'ap-stone ap-stone-' + ['tl','tr','bl','br'][i] + ' lit';
      stone.style.background = av.color;
      stone.style.boxShadow = '0 0 10px ' + av.color + ', 0 0 24px ' + av.color + '66';
    } else {
      // Not yet collected — dim
      stone.className = 'ap-stone ap-stone-' + ['tl','tr','bl','br'][i] + ' dim';
      stone.style.background = 'rgba(255,255,255,0.08)';
      stone.style.boxShadow = 'none';
    }
  }

  // Select button
  const selectBtn = el('ap-select');
  if (selectBtn) {
    if (unlocked) {
      selectBtn.disabled = false;
      selectBtn.style.opacity = '1';
      selectBtn.style.cursor = 'pointer';
      selectBtn.textContent = 'SELECT';
    } else {
      selectBtn.disabled = true;
      selectBtn.style.opacity = '0.35';
      selectBtn.style.cursor = 'not-allowed';
      selectBtn.textContent = 'LOCKED (' + progress.collected + '/' + progress.total + ')';
    }
  }

  // Inventory display
  const inv = el('ap-inventory');
  const stoneCount = getStoneInventory();
  const oreCount = getOreBalance();
  if (inv) {
    if (av.id === 'meebit') {
      inv.textContent = '';
    } else {
      inv.textContent = '\u2B21 STONES: ' + stoneCount + '  \u00B7  ORE: ' + oreCount;
    }
  }

  // CRACK ORE button — converts 1 ore into 1 stone
  const crackBtn = el('ap-crack');
  if (crackBtn) {
    if (av.id === 'meebit' || unlocked) {
      crackBtn.style.display = 'none';
    } else {
      crackBtn.style.display = '';
      if (oreCount > 0) {
        crackBtn.disabled = false;
        crackBtn.textContent = '\u2B21 CRACK ORE (' + oreCount + ')';
      } else {
        crackBtn.disabled = true;
        crackBtn.textContent = '\u2B21 NO ORE';
      }
    }
  }

  // USE STONE button — show only for locked avatars with stones available
  const spendBtn = el('ap-spend');
  if (spendBtn) {
    if (av.id === 'meebit' || unlocked) {
      spendBtn.style.display = 'none';
    } else {
      spendBtn.style.display = '';
      if (stoneCount > 0) {
        spendBtn.disabled = false;
        spendBtn.textContent = '\u2B21 USE STONE (' + stoneCount + ')';
      } else {
        spendBtn.disabled = true;
        spendBtn.textContent = '\u2B21 NO STONES';
      }
    }
  }
}

function _navigate(dir) {
  _currentIdx = (_currentIdx + dir + AVATARS.length) % AVATARS.length;
  if (_rainCtx && _rainCanvas) {
    _rainCtx.fillStyle = 'rgba(0, 4, 2, 1)';
    _rainCtx.fillRect(0, 0, _rainCanvas.width, _rainCanvas.height);
  }
  if (_rainDrops) {
    for (const d of _rainDrops) { d.y = -Math.random() * 30; d.trail.length = 0; }
  }
  _updateUI('');
  _loadModel(AVATARS[_currentIdx]);
}

function _crackOre() {
  if (getOreBalance() < 1) return;
  if (!spendOre(1)) return;
  addStones(1);
  _updateUI('ORE CRACKED \u2192 +1 STONE');
}

function _spendStone() {
  const av = AVATARS[_currentIdx];
  if (av.id === 'meebit') return;
  const result = spendStoneOnAvatar(av.id);
  if (!result.success) return;

  // Visual feedback — update the UI to reflect the new stone state
  _updateUI('');

  // If just unlocked, show a celebratory message
  if (result.justUnlocked) {
    _updateUI(av.name + ' UNLOCKED!');
  }
}

function _selectCurrent() {
  const av = AVATARS[_currentIdx];
  if (!isAvatarUnlocked(av.id)) return;
  _updateUI('APPLYING...');
  try { localStorage.setItem('simvoid_avatar_url', av.url); } catch(e) {}
  S.avatarUrl = av.url;

  swapAvatarGLB(av.url, () => {
    _updateUI('AVATAR LOADED ✓');
    setTimeout(closeAvatarPicker, 500);
  }, (err) => {
    console.warn('[avatar] swap fail:', err);
    _updateUI('FAILED — TRY ANOTHER');
  });
}

// ============================================================
// BUILD DOM
// ============================================================

function _buildUI() {
  if (_overlay) return _overlay;
  const el = document.createElement('div');
  el.id = 'avatar-picker';

  let shardDiamonds = '';
  for (let i = 0; i < SHARDS_PER_AVATAR; i++) shardDiamonds += '<span class="ap-shard">\u25C6</span>';

  el.innerHTML = '<style>' +
'#avatar-picker{position:fixed;inset:0;z-index:10000;background:rgba(0,4,2,0.96);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:"Courier New",monospace;color:#00ff66;opacity:0;transition:opacity .3s}' +
'#avatar-picker.visible{opacity:1}' +
'.ap-title{font-family:"Impact","Arial Black",sans-serif;font-size:clamp(24px,4vw,36px);letter-spacing:6px;color:#6dff95;text-shadow:0 0 16px rgba(0,255,102,.5);margin-bottom:4px}' +
'.ap-sub{font-size:11px;letter-spacing:4px;color:#6effaa;opacity:.7;margin-bottom:16px}' +
'.ap-main{display:flex;align-items:center;gap:16px;width:90vw;max-width:800px;height:clamp(300px,58vh,600px)}' +
'.ap-arrow{font-size:clamp(36px,5vw,56px);cursor:pointer;color:#00ff66;user-select:none;transition:transform .15s,color .15s;text-shadow:0 0 12px rgba(0,255,102,.4);flex-shrink:0}' +
'.ap-arrow:hover{transform:scale(1.2);color:#fff}' +
'.ap-preview{flex:1;height:100%;border:2px solid #00ff66;border-radius:16px;position:relative;overflow:hidden;background:#020a05}' +
'.ap-preview canvas{display:block}' +
'#ap-rain-canvas{position:absolute;inset:0;width:100%!important;height:100%!important;z-index:0;transition:z-index 0s}' +
'#ap-3d-canvas{position:absolute;inset:0;width:100%!important;height:100%!important;z-index:1}' +
'.ap-preview.locked #ap-rain-canvas{z-index:2}' +
'.ap-preview.locked #ap-3d-canvas{z-index:0}' +
'.ap-info{position:absolute;bottom:0;left:0;right:0;padding:16px 20px;background:linear-gradient(transparent,rgba(0,0,0,.85));text-align:center;z-index:5}' +
'.ap-type{font-size:10px;letter-spacing:5px;opacity:.6;margin-bottom:4px}' +
'.ap-name{font-size:clamp(18px,3vw,26px);letter-spacing:4px;font-weight:bold}' +
'.ap-idx{font-size:11px;opacity:.4;margin-top:4px}' +
'.ap-corner-tl,.ap-corner-tr,.ap-corner-bl,.ap-corner-br{position:absolute;width:20px;height:20px;border-color:#00ff66;border-style:solid;z-index:6}' +
'.ap-corner-tl{top:8px;left:8px;border-width:2px 0 0 2px}' +
'.ap-corner-tr{top:8px;right:8px;border-width:2px 2px 0 0}' +
'.ap-corner-bl{bottom:8px;left:8px;border-width:0 0 2px 2px}' +
'.ap-corner-br{bottom:8px;right:8px;border-width:0 2px 2px 0}' +
'.ap-stone{position:absolute;width:18px;height:18px;z-index:7;transform:rotate(45deg);border-radius:3px;transition:background .5s,box-shadow .5s}' +
'.ap-stone-tl{top:14px;left:14px}' +
'.ap-stone-tr{top:14px;right:14px}' +
'.ap-stone-bl{bottom:14px;left:14px}' +
'.ap-stone-br{bottom:14px;right:14px}' +
'.ap-stone.lit{animation:ap-stone-pulse 1.8s ease-in-out infinite}' +
'.ap-stone.dim{background:rgba(255,255,255,0.08);box-shadow:none}' +
'@keyframes ap-stone-pulse{0%,100%{filter:brightness(1);transform:rotate(45deg) scale(1)}50%{filter:brightness(1.4);transform:rotate(45deg) scale(1.15)}}' +
'.ap-shards{display:flex;gap:8px;justify-content:center;margin-top:8px;font-size:16px;letter-spacing:2px}' +
'.ap-shard{color:#333;transition:color .3s,text-shadow .3s}' +
'.ap-shard.filled{color:#00ff66;text-shadow:0 0 8px rgba(0,255,102,.6)}' +
'.ap-lock{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}' +
'.ap-lock-icon{font-size:48px;margin-bottom:8px;opacity:.6;filter:drop-shadow(0 0 12px rgba(0,0,0,.8))}' +
'.ap-lock-text{font-size:12px;letter-spacing:4px;color:#aaa;text-transform:uppercase;text-shadow:0 2px 8px rgba(0,0,0,.9)}' +
'.ap-actions{display:flex;gap:16px;margin-top:20px}' +
'.ap-btn{font-family:"Impact","Arial Black",sans-serif;font-size:18px;letter-spacing:4px;padding:14px 40px;background:transparent;color:#00ff66;border:2px solid #00ff66;cursor:pointer;box-shadow:0 0 12px rgba(0,255,102,.3);transition:all .2s}' +
'.ap-btn:hover:not(:disabled){background:#00ff66;color:#000;box-shadow:0 0 30px rgba(0,255,102,.7);transform:scale(1.05)}' +
'.ap-btn:disabled{cursor:not-allowed}' +
'.ap-btn-cancel{border-color:#444;color:#888;box-shadow:none}' +
'.ap-btn-cancel:hover{background:#222;color:#ccc;border-color:#666;box-shadow:none}' +
'.ap-btn-spend{border-color:#ffd93d;color:#ffd93d;box-shadow:0 0 12px rgba(255,217,61,.3)}' +
'.ap-btn-spend:hover:not(:disabled){background:#ffd93d;color:#000;box-shadow:0 0 30px rgba(255,217,61,.7);transform:scale(1.05)}' +
'.ap-btn-spend:disabled{border-color:#555;color:#555;box-shadow:none;cursor:not-allowed;opacity:.4}' +
'.ap-btn-crack{border-color:#ff6a1a;color:#ff6a1a;box-shadow:0 0 12px rgba(255,106,26,.3)}' +
'.ap-btn-crack:hover:not(:disabled){background:#ff6a1a;color:#000;box-shadow:0 0 30px rgba(255,106,26,.7);transform:scale(1.05)}' +
'.ap-btn-crack:disabled{border-color:#555;color:#555;box-shadow:none;cursor:not-allowed;opacity:.4}' +
'.ap-inventory{font-size:12px;letter-spacing:3px;color:#ffd93d;text-shadow:0 0 6px rgba(255,217,61,.4);margin-top:6px;min-height:18px;text-align:center}' +
'.ap-loading{font-size:13px;color:#ffdd44;letter-spacing:3px;margin-top:10px;min-height:20px;text-align:center}' +
'@media(max-width:600px){.ap-main{height:clamp(250px,50vh,400px)}.ap-btn{font-size:14px;padding:10px 24px}}' +
'</style>' +
'<div class="ap-title">SWITCH AVATAR</div>' +
'<div class="ap-sub">:: SELECT YOUR OPERATIVE ::</div>' +
'<div class="ap-main">' +
'  <div class="ap-arrow" id="ap-prev">\u25C0</div>' +
'  <div class="ap-preview" id="ap-preview">' +
'    <div class="ap-corner-tl"></div><div class="ap-corner-tr"></div>' +
'    <div class="ap-corner-bl"></div><div class="ap-corner-br"></div>' +
'    <div class="ap-stone ap-stone-tl dim" id="ap-stone-0"></div>' +
'    <div class="ap-stone ap-stone-tr dim" id="ap-stone-1"></div>' +
'    <div class="ap-stone ap-stone-bl dim" id="ap-stone-2"></div>' +
'    <div class="ap-stone ap-stone-br dim" id="ap-stone-3"></div>' +
'    <canvas id="ap-rain-canvas"></canvas>' +
'    <canvas id="ap-3d-canvas"></canvas>' +
'    <div class="ap-lock" id="ap-lock">' +
'      <div class="ap-lock-icon">\uD83D\uDD12</div>' +
'      <div class="ap-lock-text">COLLECT DATA SHARDS TO UNLOCK</div>' +
'    </div>' +
'    <div class="ap-info">' +
'      <div class="ap-type" id="ap-type"></div>' +
'      <div class="ap-name" id="ap-name"></div>' +
'      <div class="ap-shards" id="ap-shards">' + shardDiamonds + '</div>' +
'      <div class="ap-idx" id="ap-idx"></div>' +
'    </div>' +
'  </div>' +
'  <div class="ap-arrow" id="ap-next">\u25B6</div>' +
'</div>' +
'<div class="ap-actions">' +
'  <button class="ap-btn ap-btn-cancel" id="ap-cancel">CANCEL</button>' +
'  <button class="ap-btn ap-btn-crack" id="ap-crack">\u2B21 CRACK ORE</button>' +
'  <button class="ap-btn ap-btn-spend" id="ap-spend">\u2B21 USE STONE</button>' +
'  <button class="ap-btn" id="ap-select">SELECT</button>' +
'</div>' +
'<div class="ap-inventory" id="ap-inventory"></div>' +
'<div class="ap-loading" id="ap-loading"></div>';

  el.querySelector('#ap-prev').addEventListener('click', () => _navigate(-1));
  el.querySelector('#ap-next').addEventListener('click', () => _navigate(1));
  el.querySelector('#ap-cancel').addEventListener('click', closeAvatarPicker);
  el.querySelector('#ap-select').addEventListener('click', _selectCurrent);
  el.querySelector('#ap-spend').addEventListener('click', _spendStone);
  el.querySelector('#ap-crack').addEventListener('click', _crackOre);

  let tx = 0;
  el.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 40) _navigate(dx < 0 ? 1 : -1);
  }, { passive: true });

  window.addEventListener('keydown', e => {
    if (!_isOpen) return;
    if (e.key === 'ArrowLeft') _navigate(-1);
    if (e.key === 'ArrowRight') _navigate(1);
    if (e.key === 'Enter') _selectCurrent();
    if (e.key === 'Escape') closeAvatarPicker();
  });

  _overlay = el;
  return el;
}

// ============================================================
// PUBLIC API
// ============================================================

export function openAvatarPicker(onCloseCb) {
  if (_isOpen) return;
  _isOpen = true;
  _onClose = onCloseCb || null;

  const el = _buildUI();
  if (!el.parentNode) document.body.appendChild(el);
  _initPreview();
  requestAnimationFrame(() => {
    el.classList.add('visible');
    _initRainCanvas();
    _ensureRenderer();
    _resizePreview();
    _setRainColor(AVATARS[_currentIdx].color);
    _updateUI('');
    _loadModel(AVATARS[_currentIdx]);
    _pvRaf = requestAnimationFrame(_renderLoop);
  });
  window.addEventListener('resize', _resizePreview);
}

export function closeAvatarPicker() {
  if (!_isOpen || !_overlay) return;
  _isOpen = false;
  cancelAnimationFrame(_pvRaf);
  _rainCanvas = null; _rainCtx = null; _rainDrops = null;
  window.removeEventListener('resize', _resizePreview);
  _overlay.classList.remove('visible');
  setTimeout(() => { if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay); }, 300);
  if (_pvRenderer) { _pvRenderer.dispose(); _pvRenderer = null; _pvCanvas = null; }
  if (_onClose) { _onClose(); _onClose = null; }
}

export function isAvatarPickerOpen() { return _isOpen; }

export function getStoredAvatarUrl() {
  try { return localStorage.getItem('simvoid_avatar_url') || null; } catch(e) { return null; }
}

export { AVATARS };
