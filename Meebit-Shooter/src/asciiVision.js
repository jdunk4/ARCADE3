// ============================================================
// ASCII VISION — Enemies become clouds of ASCII glyphs shaped
// like their mesh silhouette.
//
// When active, each enemy's 3D body is hidden and replaced with
// an InstancedMesh of small quads textured with ASCII characters,
// positioned at sampled surface points of the original mesh. The
// result: a swarm of hundreds of green glyphs forming the shape
// of each enemy.
//
// Uses THREE.InstancedMesh for performance — one draw call per
// enemy cloud, not hundreds of individual meshes.
// ============================================================

import * as THREE from 'three';

let _active = false;
let _timer = 0;
let _enemies = null;
let _scene = null;
let _styleEl = null;
const ASCII_DURATION = 15.0;

// Glyph atlas — a texture with a grid of ASCII characters
let _glyphTex = null;
const ATLAS_COLS = 10;
const ATLAS_ROWS = 5;
const ATLAS_CHARS = '@#%&*+=-:.?!~^$WVGDPSJXRa0123456789ABCDEFHIKLMNOQTUYZアイウエオカキクケコ';

function _buildGlyphAtlas() {
  if (_glyphTex) return _glyphTex;
  const cellSize = 32;
  const canvas = document.createElement('canvas');
  canvas.width = cellSize * ATLAS_COLS;
  canvas.height = cellSize * ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `bold ${cellSize - 4}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < ATLAS_COLS * ATLAS_ROWS; i++) {
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
    const char = ATLAS_CHARS[i % ATLAS_CHARS.length];
    ctx.fillText(char, col * cellSize + cellSize / 2, row * cellSize + cellSize / 2);
  }
  _glyphTex = new THREE.CanvasTexture(canvas);
  _glyphTex.minFilter = THREE.LinearFilter;
  _glyphTex.magFilter = THREE.LinearFilter;
  return _glyphTex;
}

// Shared instanced geometry — small quad
const _quadGeo = new THREE.PlaneGeometry(0.18, 0.18);

// Shared material
let _glyphMat = null;
function _getGlyphMaterial() {
  if (_glyphMat) return _glyphMat;
  _buildGlyphAtlas();
  _glyphMat = new THREE.MeshBasicMaterial({
    map: _glyphTex,
    transparent: true,
    alphaTest: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: 0x00ff66,
    blending: THREE.AdditiveBlending,
  });
  return _glyphMat;
}

// ---- SURFACE SAMPLING ----
// Sample N points on the surface of an enemy's mesh hierarchy.
// Returns array of Vector3 in LOCAL space of the enemy's body group.
function _sampleMeshSurface(group, count) {
  const points = [];
  const meshes = [];

  // Collect all Mesh children
  group.traverse((child) => {
    if (child.isMesh && child.geometry) {
      meshes.push(child);
    }
  });

  if (meshes.length === 0) {
    // Fallback: generate a random box cloud
    for (let i = 0; i < count; i++) {
      points.push(new THREE.Vector3(
        (Math.random() - 0.5) * 1.5,
        Math.random() * 2.5,
        (Math.random() - 0.5) * 1.5,
      ));
    }
    return points;
  }

  // Distribute samples across meshes proportionally to their bounding box volume
  const volumes = meshes.map(m => {
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    return Math.max(0.001, size.x * size.y * size.z);
  });
  const totalVol = volumes.reduce((a, b) => a + b, 0);

  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi];
    const sampleCount = Math.max(2, Math.round(count * volumes[mi] / totalVol));
    const box = new THREE.Box3().setFromObject(mesh);
    const min = box.min;
    const size = box.getSize(new THREE.Vector3());

    // Generate points within the bounding box
    // We use rejection sampling — generate random points in the box
    for (let i = 0; i < sampleCount; i++) {
      const p = new THREE.Vector3(
        min.x + Math.random() * size.x,
        min.y + Math.random() * size.y,
        min.z + Math.random() * size.z,
      );
      // Transform from world space to group-local space
      group.worldToLocal(p);
      points.push(p);
    }
  }

  return points;
}

// ---- BUILD GLYPH CLOUD FOR ONE ENEMY ----
function _buildCloud(enemy) {
  if (!enemy.body) return null;

  // Determine point count based on enemy size
  const isBoss = enemy.isBoss;
  const pointCount = isBoss ? 400 : (enemy.scale > 1 ? 150 : 80);

  // Sample surface points
  const pts = _sampleMeshSurface(enemy.body, pointCount);
  const count = pts.length;
  if (count === 0) return null;

  const mat = _getGlyphMaterial();
  const instMesh = new THREE.InstancedMesh(_quadGeo, mat, count);
  instMesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const uvOffsets = new Float32Array(count); // store random UV offsets for variety

  for (let i = 0; i < count; i++) {
    dummy.position.copy(pts[i]);
    // Random rotation so glyphs face different directions
    dummy.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI,
    );
    // Slight size variation
    const s = 0.7 + Math.random() * 0.6;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    instMesh.setMatrixAt(i, dummy.matrix);

    // Random brightness per instance
    const brightness = 0.4 + Math.random() * 0.6;
    instMesh.setColorAt(i, new THREE.Color(0, brightness, brightness * 0.4));

    uvOffsets[i] = Math.random();
  }
  instMesh.instanceMatrix.needsUpdate = true;
  if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;

  // Store metadata for animation
  instMesh.userData = {
    points: pts,
    uvOffsets,
    baseScale: isBoss ? 1.0 : (enemy.scale || 0.55),
  };

  return instMesh;
}

// ---- CSS OVERLAY ----
function _injectCSS() {
  if (_styleEl) return;
  _styleEl = document.createElement('style');
  _styleEl.textContent = `
#game.ascii-active > canvas {
  filter: contrast(1.3) brightness(0.85) saturate(0.25);
}
#ascii-scanlines {
  position: absolute; inset: 0; z-index: 3;
  pointer-events: none; display: none;
  background: repeating-linear-gradient(
    0deg, transparent, transparent 2px,
    rgba(0,255,102,0.03) 2px, rgba(0,255,102,0.03) 4px
  );
}
#game.ascii-active #ascii-scanlines { display: block; }
#ascii-tint {
  position: absolute; inset: 0; z-index: 1;
  pointer-events: none; display: none;
  background: radial-gradient(ellipse at center,
    rgba(0,40,10,0.1) 0%, rgba(0,20,5,0.35) 100%);
  mix-blend-mode: multiply;
}
#game.ascii-active #ascii-tint { display: block; }
#ascii-timer-bar {
  position: absolute; top: 0; left: 0; height: 3px;
  background: #00ff66; box-shadow: 0 0 8px #00ff66;
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
  ['ascii-scanlines', 'ascii-tint', 'ascii-timer-bar'].forEach(id => {
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
}

export function activateAsciiVision(duration) {
  _active = true;
  _timer = duration || ASCII_DURATION;
  const gameEl = document.getElementById('game');
  if (gameEl) gameEl.classList.add('ascii-active');
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) bar.style.width = '100%';
  // Swap all current enemies
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

export function updateAsciiVision(dt) {
  if (!_active) return false;
  _timer -= dt;
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) bar.style.width = Math.max(0, _timer / ASCII_DURATION * 100) + '%';

  if (_timer <= 0) {
    deactivateAsciiVision();
    return false;
  }

  // Update clouds: follow enemy position + shimmer
  const time = performance.now() * 0.001;
  if (_enemies) {
    for (const e of _enemies) {
      // Swap newly spawned enemies
      if (!e._asciiCloud && e.body) _swapToAscii(e);

      if (e._asciiCloud && e.pos) {
        // Move cloud to enemy position
        e._asciiCloud.position.set(e.pos.x, 0, e.pos.z);

        // Shimmer: jitter each instance slightly
        const cloud = e._asciiCloud;
        const pts = cloud.userData.points;
        const dummy = _dummyObj;
        const count = pts.length;
        // Only update a subset each frame for performance
        const startIdx = Math.floor(time * 20) % count;
        const updateCount = Math.min(20, count);
        for (let k = 0; k < updateCount; k++) {
          const i = (startIdx + k) % count;
          const p = pts[i];
          dummy.position.set(
            p.x + Math.sin(time * 3 + i) * 0.04,
            p.y + Math.sin(time * 2.5 + i * 0.7) * 0.06,
            p.z + Math.cos(time * 3 + i) * 0.04,
          );
          dummy.rotation.y = time + i;
          dummy.rotation.x = Math.sin(time + i) * 0.3;
          const s = (0.7 + Math.random() * 0.6);
          dummy.scale.set(s, s, s);
          dummy.updateMatrix();
          cloud.setMatrixAt(i, dummy.matrix);
        }
        cloud.instanceMatrix.needsUpdate = true;

        // Pulse on hit
        if (e.hitFlash > 0 && cloud.material.color) {
          cloud.material = _hitMat;
        } else if (cloud.material !== _getGlyphMaterial()) {
          cloud.material = _getGlyphMaterial();
        }
      }
    }
  }
  return true;
}

export function renderAsciiPass() {}
export function getAsciiTimeRemaining() { return Math.max(0, _timer); }

// ---- REUSABLE OBJECTS ----
const _dummyObj = new THREE.Object3D();

// Hit flash material — bright white
let _hitMat = null;
function _getHitMat() {
  if (_hitMat) return _hitMat;
  _buildGlyphAtlas();
  _hitMat = new THREE.MeshBasicMaterial({
    map: _glyphTex,
    transparent: true,
    alphaTest: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: 0xffffff,
    blending: THREE.AdditiveBlending,
  });
  return _hitMat;
}

// ---- SWAP HELPERS ----

function _swapToAscii(enemy) {
  if (enemy._asciiCloud) return;
  if (!_scene || !enemy.body) return;

  // Make sure body is positioned before sampling
  if (enemy.obj) enemy.obj.updateMatrixWorld(true);

  const cloud = _buildCloud(enemy);
  if (!cloud) return;

  // Position at enemy
  if (enemy.pos) cloud.position.set(enemy.pos.x, 0, enemy.pos.z);

  _scene.add(cloud);
  enemy._asciiCloud = cloud;

  // Hide the 3D body
  if (enemy.body) enemy.body.visible = false;
  // Also hide shield meshes etc
  if (enemy.shieldMesh) enemy.shieldMesh.visible = false;

  // Init hit material
  _getHitMat();
}

function _restoreFromAscii(enemy) {
  if (!enemy._asciiCloud) return;
  if (_scene) _scene.remove(enemy._asciiCloud);
  enemy._asciiCloud.dispose();
  enemy._asciiCloud = null;

  if (enemy.body) enemy.body.visible = true;
  if (enemy.shieldMesh) enemy.shieldMesh.visible = true;
}
