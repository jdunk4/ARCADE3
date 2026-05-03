// ============================================================
// AVATAR PICKER — fullscreen 3D preview with GLB loading
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { swapAvatarGLB } from './player.js';
import { S } from './state.js';

const AVATARS = [
  { id: 'meebit',          name: 'MEEBIT',         url: 'assets/16801_original.vrm',                    color: '#00ff66', type: 'DEFAULT',  scale: 1.0 },
  { id: 'pixlpal-928',     name: 'PIXLPAL #928',   url: 'assets/civilians/pixlpal/voxlpal-928.glb',     color: '#ff8844', type: 'PIXLPAL',  scale: 2.5 },
  { id: 'pixlpal-108',     name: 'PIXLPAL #108',   url: 'assets/civilians/pixlpal/voxlpal-108.glb',     color: '#44aaff', type: 'PIXLPAL',  scale: 2.5 },
  { id: 'gob-406',         name: 'GOB #406',        url: 'assets/civilians/gobs/406.glb',                color: '#ff3344', type: 'GOB',      scale: 2.0 },
  { id: 'gob-1004',        name: 'GOB #1004',       url: 'assets/civilians/gobs/1004.glb',               color: '#44ff66', type: 'GOB',      scale: 2.0 },
  { id: 'flinger-yellow',  name: 'FLINGER YELLOW',  url: 'assets/civilians/flingers/FlingerYELLOW.glb',  color: '#ffdd44', type: 'FLINGER',  scale: 1.8 },
  { id: 'flinger-purple',  name: 'FLINGER PURPLE',  url: 'assets/civilians/flingers/FlingerPURPLE.glb',  color: '#bb44ff', type: 'FLINGER',  scale: 1.8 },
];

let _overlay = null;
let _currentIdx = 0;
let _isOpen = false;
let _onClose = null;

// 3D preview
let _pvScene = null, _pvCamera = null, _pvRenderer = null;
let _pvModel = null, _pvRaf = 0, _pvCanvas = null;
const _pvCache = new Map();

function _initPreview() {
  if (_pvScene) return;
  _pvScene = new THREE.Scene();
  _pvScene.background = new THREE.Color(0x050f08);

  _pvCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  _pvCamera.position.set(0, 1.2, 4.5);
  _pvCamera.lookAt(0, 0.8, 0);

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
}

function _loadModel(av) {
  _updateUI('LOADING...');
  if (_pvModel) { _pvScene.remove(_pvModel); _pvModel = null; }

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
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = (2.2 / maxDim) * (av.scale || 1);
  model.scale.setScalar(s);

  const box2 = new THREE.Box3().setFromObject(model);
  const c2 = box2.getCenter(new THREE.Vector3());
  model.position.sub(c2);
  model.position.y += box2.getSize(new THREE.Vector3()).y / 2;

  _pvScene.add(model);
  _pvModel = model;
  _updateUI('');
}

function _renderLoop() {
  _pvRaf = requestAnimationFrame(_renderLoop);
  if (!_pvRenderer) return;
  if (_pvModel) _pvModel.rotation.y += 0.008;
  _pvRenderer.render(_pvScene, _pvCamera);
}

function _updateUI(loadText) {
  if (!_overlay) return;
  const av = AVATARS[_currentIdx];
  const el = (id) => _overlay.querySelector('#' + id);
  const preview = el('ap-preview');
  if (preview) {
    preview.style.borderColor = av.color;
    preview.style.boxShadow = '0 0 30px ' + av.color + '22, inset 0 0 60px ' + av.color + '08';
  }
  const name = el('ap-name');
  if (name) { name.textContent = av.name; name.style.color = av.color; }
  const type = el('ap-type');
  if (type) type.textContent = av.type;
  const idx = el('ap-idx');
  if (idx) idx.textContent = (_currentIdx+1) + ' / ' + AVATARS.length;
  const ld = el('ap-loading');
  if (ld) ld.textContent = loadText || '';
}

function _navigate(dir) {
  _currentIdx = (_currentIdx + dir + AVATARS.length) % AVATARS.length;
  _updateUI('');
  _loadModel(AVATARS[_currentIdx]);
}

function _selectCurrent() {
  const av = AVATARS[_currentIdx];
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

function _buildUI() {
  if (_overlay) return _overlay;
  const el = document.createElement('div');
  el.id = 'avatar-picker';
  el.innerHTML = `
<style>
#avatar-picker{position:fixed;inset:0;z-index:10000;background:rgba(0,4,2,0.96);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Courier New',monospace;color:#00ff66;opacity:0;transition:opacity .3s}
#avatar-picker.visible{opacity:1}
.ap-title{font-family:'Impact','Arial Black',sans-serif;font-size:clamp(24px,4vw,36px);letter-spacing:6px;color:#6dff95;text-shadow:0 0 16px rgba(0,255,102,.5);margin-bottom:4px}
.ap-sub{font-size:11px;letter-spacing:4px;color:#6effaa;opacity:.7;margin-bottom:16px}
.ap-main{display:flex;align-items:center;gap:16px;width:90vw;max-width:800px;height:clamp(300px,58vh,600px)}
.ap-arrow{font-size:clamp(36px,5vw,56px);cursor:pointer;color:#00ff66;user-select:none;transition:transform .15s,color .15s;text-shadow:0 0 12px rgba(0,255,102,.4);flex-shrink:0}
.ap-arrow:hover{transform:scale(1.2);color:#fff}
.ap-preview{flex:1;height:100%;border:2px solid #00ff66;border-radius:16px;position:relative;overflow:hidden;background:radial-gradient(ellipse at 50% 80%,#051a0d,#020a05)}
.ap-preview canvas{width:100%!important;height:100%!important;display:block}
.ap-info{position:absolute;bottom:0;left:0;right:0;padding:16px 20px;background:linear-gradient(transparent,rgba(0,0,0,.85));text-align:center}
.ap-type{font-size:10px;letter-spacing:5px;opacity:.6;margin-bottom:4px}
.ap-name{font-size:clamp(18px,3vw,26px);letter-spacing:4px;font-weight:bold}
.ap-idx{font-size:11px;opacity:.4;margin-top:4px}
.ap-corner-tl,.ap-corner-tr,.ap-corner-bl,.ap-corner-br{position:absolute;width:20px;height:20px;border-color:#00ff66;border-style:solid}
.ap-corner-tl{top:8px;left:8px;border-width:2px 0 0 2px}
.ap-corner-tr{top:8px;right:8px;border-width:2px 2px 0 0}
.ap-corner-bl{bottom:8px;left:8px;border-width:0 0 2px 2px}
.ap-corner-br{bottom:8px;right:8px;border-width:0 2px 2px 0}
.ap-actions{display:flex;gap:16px;margin-top:20px}
.ap-btn{font-family:'Impact','Arial Black',sans-serif;font-size:18px;letter-spacing:4px;padding:14px 40px;background:transparent;color:#00ff66;border:2px solid #00ff66;cursor:pointer;box-shadow:0 0 12px rgba(0,255,102,.3);transition:all .2s}
.ap-btn:hover{background:#00ff66;color:#000;box-shadow:0 0 30px rgba(0,255,102,.7);transform:scale(1.05)}
.ap-btn-cancel{border-color:#444;color:#888;box-shadow:none}
.ap-btn-cancel:hover{background:#222;color:#ccc;border-color:#666;box-shadow:none}
.ap-loading{font-size:13px;color:#ffdd44;letter-spacing:3px;margin-top:10px;min-height:20px;text-align:center}
@media(max-width:600px){.ap-main{height:clamp(250px,50vh,400px)}.ap-btn{font-size:14px;padding:10px 24px}}
</style>
<div class="ap-title">SWITCH AVATAR</div>
<div class="ap-sub">:: SELECT YOUR OPERATIVE ::</div>
<div class="ap-main">
  <div class="ap-arrow" id="ap-prev">◀</div>
  <div class="ap-preview" id="ap-preview">
    <div class="ap-corner-tl"></div><div class="ap-corner-tr"></div>
    <div class="ap-corner-bl"></div><div class="ap-corner-br"></div>
    <canvas id="ap-3d-canvas"></canvas>
    <div class="ap-info">
      <div class="ap-type" id="ap-type"></div>
      <div class="ap-name" id="ap-name"></div>
      <div class="ap-idx" id="ap-idx"></div>
    </div>
  </div>
  <div class="ap-arrow" id="ap-next">▶</div>
</div>
<div class="ap-actions">
  <button class="ap-btn ap-btn-cancel" id="ap-cancel">CANCEL</button>
  <button class="ap-btn" id="ap-select">SELECT</button>
</div>
<div class="ap-loading" id="ap-loading"></div>`;

  el.querySelector('#ap-prev').addEventListener('click', () => _navigate(-1));
  el.querySelector('#ap-next').addEventListener('click', () => _navigate(1));
  el.querySelector('#ap-cancel').addEventListener('click', closeAvatarPicker);
  el.querySelector('#ap-select').addEventListener('click', _selectCurrent);

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

export function openAvatarPicker(onCloseCb) {
  if (_isOpen) return;
  _isOpen = true;
  _onClose = onCloseCb || null;

  const el = _buildUI();
  if (!el.parentNode) document.body.appendChild(el);
  _initPreview();
  requestAnimationFrame(() => {
    el.classList.add('visible');
    _ensureRenderer();
    _resizePreview();
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
