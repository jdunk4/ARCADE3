// ============================================================
// ASCII VISION v5 — Enemies become clouds of large, bright
// ASCII glyphs shaped like their mesh silhouette.
//
// Fixes from v4:
//   - Cleans up residual DOM from previous versions on init
//   - Glyphs are 3x larger and fully opaque green
//   - Enemy body hidden via traverse (all children set invisible)
//   - Uses NormalBlending instead of Additive for solid visibility
// ============================================================

import * as THREE from 'three';

let _active = false;
let _timer = 0;
let _enemies = null;
let _scene = null;
let _styleEl = null;
const ASCII_DURATION = 15.0;

// Glyph atlas
let _glyphTex = null;
const ATLAS_CHARS = '@#%&*+=-:.WVGDPSJXRaアイウエオカキクケコサシスセソ0123456789';
const ATLAS_COLS = 10;
const ATLAS_ROWS = Math.ceil(ATLAS_CHARS.length / 10);

function _buildGlyphAtlas() {
  if (_glyphTex) return _glyphTex;
  const cell = 64;
  const canvas = document.createElement('canvas');
  canvas.width = cell * ATLAS_COLS;
  canvas.height = cell * ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `bold ${cell - 6}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < ATLAS_CHARS.length; i++) {
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
    // Green glow layers
    ctx.shadowColor = '#00ff44';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#00ff66';
    ctx.fillText(ATLAS_CHARS[i], col * cell + cell / 2, row * cell + cell / 2);
    // Bright core
    ctx.shadowBlur = 2;
    ctx.fillStyle = '#ccffdd';
    ctx.fillText(ATLAS_CHARS[i], col * cell + cell / 2, row * cell + cell / 2);
  }
  _glyphTex = new THREE.CanvasTexture(canvas);
  _glyphTex.minFilter = THREE.LinearFilter;
  _glyphTex.magFilter = THREE.LinearFilter;
  return _glyphTex;
}

// Shared geometry — billboard quad, larger
const _quadGeo = new THREE.PlaneGeometry(0.35, 0.35);

// Materials
let _glyphMat = null;
let _hitMat = null;

function _getGlyphMaterial() {
  if (_glyphMat) return _glyphMat;
  _buildGlyphAtlas();
  _glyphMat = new THREE.MeshBasicMaterial({
    map: _glyphTex,
    transparent: true,
    alphaTest: 0.15,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    color: 0x00ff66,
  });
  return _glyphMat;
}

function _getHitMat() {
  if (_hitMat) return _hitMat;
  _buildGlyphAtlas();
  _hitMat = new THREE.MeshBasicMaterial({
    map: _glyphTex,
    transparent: true,
    alphaTest: 0.15,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: 0xffffff,
  });
  return _hitMat;
}

// ---- SURFACE SAMPLING ----
function _sampleMeshPoints(group, count) {
  const points = [];
  const boxes = [];

  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const box = new THREE.Box3().setFromObject(child);
      const size = box.getSize(new THREE.Vector3());
      const vol = Math.max(0.001, size.x * size.y * size.z);
      boxes.push({ box, size, vol });
    }
  });

  if (boxes.length === 0) {
    // Fallback: random humanoid shape
    for (let i = 0; i < count; i++) {
      points.push(new THREE.Vector3(
        (Math.random() - 0.5) * 1.2,
        Math.random() * 3.0,
        (Math.random() - 0.5) * 1.2,
      ));
    }
    return points;
  }

  const totalVol = boxes.reduce((a, b) => a + b.vol, 0);
  const groupWorldPos = new THREE.Vector3();
  group.getWorldPosition(groupWorldPos);

  for (const { box, vol } of boxes) {
    const n = Math.max(3, Math.round(count * vol / totalVol));
    const min = box.min;
    const size = box.getSize(new THREE.Vector3());
    for (let i = 0; i < n; i++) {
      const p = new THREE.Vector3(
        min.x + Math.random() * size.x - groupWorldPos.x,
        min.y + Math.random() * size.y,
        min.z + Math.random() * size.z - groupWorldPos.z,
      );
      points.push(p);
    }
  }
  return points;
}

// ---- BUILD CLOUD ----
function _buildCloud(enemy) {
  if (!enemy.body && !enemy.obj) return null;
  const meshSource = enemy.body || enemy.obj;

  const isBoss = enemy.isBoss;
  const pointCount = isBoss ? 500 : (enemy.scale > 1.2 ? 200 : 120);
  const pts = _sampleMeshPoints(meshSource, pointCount);
  if (pts.length === 0) return null;

  const mat = _getGlyphMaterial();
  const count = pts.length;
  const instMesh = new THREE.InstancedMesh(_quadGeo, mat, count);
  instMesh.frustumCulled = false;
  instMesh.renderOrder = 999; // render on top

  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    dummy.position.copy(pts[i]);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    const s = 0.8 + Math.random() * 0.5;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    instMesh.setMatrixAt(i, dummy.matrix);

    // Per-instance green with brightness variation
    const b = 0.5 + Math.random() * 0.5;
    instMesh.setColorAt(i, new THREE.Color(b * 0.2, b, b * 0.3));
  }
  instMesh.instanceMatrix.needsUpdate = true;
  if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;

  instMesh.userData = { points: pts };
  return instMesh;
}

// ---- HIDE/SHOW ENEMY MESH ----
function _hideEnemyMesh(enemy) {
  // Traverse ALL children and set visible = false
  if (enemy.obj) {
    enemy.obj.traverse((child) => { child.visible = false; });
    enemy.obj.visible = false;
  }
  if (enemy.body) {
    enemy.body.traverse((child) => { child.visible = false; });
    enemy.body.visible = false;
  }
  if (enemy.shieldMesh) enemy.shieldMesh.visible = false;
}

function _showEnemyMesh(enemy) {
  if (enemy.obj) {
    enemy.obj.traverse((child) => { child.visible = true; });
    enemy.obj.visible = true;
  }
  if (enemy.body) {
    enemy.body.traverse((child) => { child.visible = true; });
    enemy.body.visible = true;
  }
  if (enemy.shieldMesh) enemy.shieldMesh.visible = true;
}

// ---- CSS ----
function _injectCSS() {
  if (_styleEl) return;
  _styleEl = document.createElement('style');
  _styleEl.textContent = `
#game.ascii-active > canvas {
  filter: contrast(1.4) brightness(0.8) saturate(0.2);
}
#ascii-scanlines {
  position: absolute; inset: 0; z-index: 3;
  pointer-events: none; display: none;
  background: repeating-linear-gradient(
    0deg, transparent, transparent 1px,
    rgba(0,255,102,0.04) 1px, rgba(0,255,102,0.04) 3px
  );
}
#game.ascii-active #ascii-scanlines { display: block; }
#ascii-timer-bar {
  position: absolute; top: 0; left: 0; height: 4px;
  background: linear-gradient(90deg, #00ff66, #4ff7ff);
  box-shadow: 0 0 12px #00ff66;
  z-index: 10; display: none;
  transition: width 0.3s linear;
}
#game.ascii-active #ascii-timer-bar { display: block; }
`;
  document.head.appendChild(_styleEl);
}

function _buildOverlayEls() {
  const gameEl = document.getElementById('game');
  if (!gameEl) return;

  // CLEANUP: Remove residual overlay divs from previous versions
  ['ascii-grid', 'ascii-overlay', 'ascii-tint'].forEach(id => {
    const old = document.getElementById(id);
    if (old) old.parentNode.removeChild(old);
  });
  // Also remove any stray .ascii-col elements
  gameEl.querySelectorAll('.ascii-col').forEach(el => el.remove());

  // Build fresh overlays
  ['ascii-scanlines', 'ascii-timer-bar'].forEach(id => {
    if (!document.getElementById(id)) {
      const el = document.createElement('div');
      el.id = id;
      gameEl.appendChild(el);
    }
  });
}

// ---- PUBLIC API ----

export function initAsciiVision(sceneRef, enemiesRef) {
  _scene = sceneRef;
  _enemies = enemiesRef;
  _injectCSS();
  _buildOverlayEls();
  _buildGlyphAtlas();
  _getGlyphMaterial();
  _getHitMat();
}

export function activateAsciiVision(duration) {
  _active = true;
  _timer = duration || ASCII_DURATION;
  const gameEl = document.getElementById('game');
  if (gameEl) gameEl.classList.add('ascii-active');
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) bar.style.width = '100%';
  if (_enemies) {
    for (const e of _enemies) _swapToAscii(e);
  }
}

export function deactivateAsciiVision() {
  _active = false;
  _timer = 0;
  const gameEl = document.getElementById('game');
  if (gameEl) gameEl.classList.remove('ascii-active');
  if (_enemies) {
    for (const e of _enemies) _restoreFromAscii(e);
  }
}

export function isAsciiActive() { return _active; }

const _dummy = new THREE.Object3D();

export function updateAsciiVision(dt) {
  if (!_active) return false;
  _timer -= dt;
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) bar.style.width = Math.max(0, _timer / ASCII_DURATION * 100) + '%';

  if (_timer <= 0) {
    deactivateAsciiVision();
    return false;
  }

  const time = performance.now() * 0.001;

  if (_enemies) {
    for (const e of _enemies) {
      if (!e._asciiCloud) _swapToAscii(e);

      if (e._asciiCloud && e.pos) {
        e._asciiCloud.position.set(e.pos.x, 0, e.pos.z);

        // Shimmer animation — rotate a batch of glyphs each frame
        const cloud = e._asciiCloud;
        const pts = cloud.userData.points;
        const count = pts.length;
        const batchSize = Math.min(30, count);
        const startIdx = Math.floor(time * 15) % count;

        for (let k = 0; k < batchSize; k++) {
          const i = (startIdx + k) % count;
          const p = pts[i];
          _dummy.position.set(
            p.x + Math.sin(time * 2.5 + i * 0.5) * 0.05,
            p.y + Math.sin(time * 2 + i * 0.3) * 0.07,
            p.z + Math.cos(time * 2.5 + i * 0.5) * 0.05,
          );
          _dummy.rotation.y = time * 0.5 + i;
          const s = 0.8 + Math.sin(time * 3 + i) * 0.15;
          _dummy.scale.set(s, s, s);
          _dummy.updateMatrix();
          cloud.setMatrixAt(i, _dummy.matrix);
        }
        cloud.instanceMatrix.needsUpdate = true;

        // Hit flash — swap material
        if (e.hitFlash > 0) {
          if (cloud.material !== _hitMat) cloud.material = _hitMat;
        } else {
          if (cloud.material !== _glyphMat) cloud.material = _glyphMat;
        }

        // Keep enemy mesh hidden (new children might appear)
        _hideEnemyMesh(e);
      }
    }
  }
  return true;
}

export function renderAsciiPass() {}
export function getAsciiTimeRemaining() { return Math.max(0, _timer); }

// ---- SWAP HELPERS ----

function _swapToAscii(enemy) {
  if (enemy._asciiCloud) return;
  if (!_scene) return;

  const cloud = _buildCloud(enemy);
  if (!cloud) return;

  if (enemy.pos) cloud.position.set(enemy.pos.x, 0, enemy.pos.z);
  _scene.add(cloud);
  enemy._asciiCloud = cloud;
  _hideEnemyMesh(enemy);
}

function _restoreFromAscii(enemy) {
  if (!enemy._asciiCloud) return;
  if (_scene) _scene.remove(enemy._asciiCloud);
  try { enemy._asciiCloud.dispose(); } catch (_) {}
  enemy._asciiCloud = null;
  _showEnemyMesh(enemy);
}
