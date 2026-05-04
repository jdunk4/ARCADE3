// ============================================================
// ASCII VISION v6 — BOLD green glyph clouds + one-shot kills
// + exploding glyph particles on death.
//
// When active:
//   - Enemy meshes hidden, replaced by clouds of ~120 bright
//     green ASCII characters shaped like the mesh
//   - ALL enemies die in one shot (any damage = instant kill)
//   - On death, the glyph cloud EXPLODES — each character becomes
//     a physics particle that flies outward, spins, and fades
//   - Explosion particles linger for ~1.5s then despawn
// ============================================================

import * as THREE from 'three';

let _active = false;
let _timer = 0;
let _enemies = null;
let _scene = null;
let _killEnemyFn = null;  // reference to killEnemy from main.js
let _styleEl = null;
const ASCII_DURATION = 15.0;

// Explosion particle pools
const _explosions = []; // { mesh: InstancedMesh, particles: [{vel, life}], timer }

// ---- GLYPH ATLAS ----
let _glyphTex = null;
const ATLAS_CHARS = '@#%&*+WVDPSXアイウエオカキクケコ0123456789';

function _buildGlyphAtlas() {
  if (_glyphTex) return _glyphTex;
  const cell = 128;  // high-res for bold rendering
  const cols = 8;
  const rows = Math.ceil(ATLAS_CHARS.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cell * cols;
  canvas.height = cell * rows;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < ATLAS_CHARS.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = col * cell + cell / 2;
    const cy = row * cell + cell / 2;

    // Outer glow
    ctx.shadowColor = '#00ff44';
    ctx.shadowBlur = 20;
    ctx.font = `900 ${cell - 10}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#00ff66';
    ctx.fillText(ATLAS_CHARS[i], cx, cy);
    ctx.fillText(ATLAS_CHARS[i], cx, cy); // double for intensity

    // Bright core
    ctx.shadowBlur = 6;
    ctx.shadowColor = '#aaffaa';
    ctx.fillStyle = '#eeffee';
    ctx.fillText(ATLAS_CHARS[i], cx, cy);
  }
  _glyphTex = new THREE.CanvasTexture(canvas);
  _glyphTex.minFilter = THREE.LinearFilter;
  _glyphTex.magFilter = THREE.LinearFilter;
  return _glyphTex;
}

// ---- MATERIALS ----
const _quadGeo = new THREE.PlaneGeometry(0.4, 0.4);
let _glyphMat = null;
let _hitMat = null;

function _getGlyphMaterial() {
  if (_glyphMat) return _glyphMat;
  _buildGlyphAtlas();
  _glyphMat = new THREE.MeshBasicMaterial({
    map: _glyphTex,
    transparent: true,
    alphaTest: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: 0x44ff88,  // bright green tint
  });
  return _glyphMat;
}

function _getHitMat() {
  if (_hitMat) return _hitMat;
  _buildGlyphAtlas();
  _hitMat = new THREE.MeshBasicMaterial({
    map: _glyphTex, transparent: true, alphaTest: 0.1,
    depthWrite: false, side: THREE.DoubleSide, color: 0xffffff,
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
      boxes.push({ box, size, vol: Math.max(0.001, size.x * size.y * size.z) });
    }
  });
  if (boxes.length === 0) {
    for (let i = 0; i < count; i++) {
      points.push(new THREE.Vector3(
        (Math.random() - 0.5) * 1.5, Math.random() * 3, (Math.random() - 0.5) * 1.5));
    }
    return points;
  }
  const totalVol = boxes.reduce((a, b) => a + b.vol, 0);
  const wp = new THREE.Vector3();
  group.getWorldPosition(wp);
  for (const { box, vol } of boxes) {
    const n = Math.max(3, Math.round(count * vol / totalVol));
    const min = box.min; const size = box.getSize(new THREE.Vector3());
    for (let i = 0; i < n; i++) {
      points.push(new THREE.Vector3(
        min.x + Math.random() * size.x - wp.x,
        min.y + Math.random() * size.y,
        min.z + Math.random() * size.z - wp.z));
    }
  }
  return points;
}

// ---- BUILD CLOUD ----
function _buildCloud(enemy) {
  const src = enemy.body || enemy.obj;
  if (!src) return null;
  const isBoss = enemy.isBoss;
  const count = isBoss ? 500 : (enemy.scale > 1.2 ? 200 : 120);
  const pts = _sampleMeshPoints(src, count);
  if (!pts.length) return null;

  const mat = _getGlyphMaterial();
  const inst = new THREE.InstancedMesh(_quadGeo, mat, pts.length);
  inst.frustumCulled = false;
  inst.renderOrder = 999;
  const d = new THREE.Object3D();
  for (let i = 0; i < pts.length; i++) {
    d.position.copy(pts[i]);
    d.rotation.set(0, Math.random() * 6.28, 0);
    const s = 0.8 + Math.random() * 0.5;
    d.scale.set(s, s, s);
    d.updateMatrix();
    inst.setMatrixAt(i, d.matrix);
    const b = 0.6 + Math.random() * 0.4;
    inst.setColorAt(i, new THREE.Color(b * 0.3, b, b * 0.4));
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.userData = { points: pts };
  return inst;
}

// ---- EXPLOSION ----
// When an enemy dies during ASCII mode, we take its cloud's instance
// positions, give each one a random outward velocity + spin, and
// animate them as fading particles.
function _spawnExplosion(enemy) {
  if (!enemy._asciiCloud || !_scene) return;
  const cloud = enemy._asciiCloud;
  const pts = cloud.userData.points;
  if (!pts || !pts.length) return;

  const count = pts.length;
  const origin = enemy.pos ? enemy.pos.clone() : new THREE.Vector3();

  // Create a new InstancedMesh for the explosion particles
  const mat = _getGlyphMaterial().clone();
  mat.transparent = true;
  const inst = new THREE.InstancedMesh(_quadGeo, mat, count);
  inst.frustumCulled = false;
  inst.renderOrder = 1000;

  const particles = [];
  const d = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const p = pts[i];
    d.position.set(origin.x + p.x, p.y, origin.z + p.z);
    d.rotation.set(0, Math.random() * 6.28, 0);
    const s = 1.0 + Math.random() * 0.4;
    d.scale.set(s, s, s);
    d.updateMatrix();
    inst.setMatrixAt(i, d.matrix);
    inst.setColorAt(i, new THREE.Color(0.3, 1.0, 0.4));

    // Random outward velocity
    const angle = Math.random() * Math.PI * 2;
    const upVel = 2 + Math.random() * 5;
    const outVel = 3 + Math.random() * 6;
    particles.push({
      x: origin.x + p.x,
      y: p.y,
      z: origin.z + p.z,
      vx: Math.cos(angle) * outVel,
      vy: upVel,
      vz: Math.sin(angle) * outVel,
      spin: (Math.random() - 0.5) * 10,
      life: 1.0 + Math.random() * 0.8,
    });
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

  _scene.add(inst);
  _explosions.push({ mesh: inst, mat, particles, timer: 0 });
}

function _updateExplosions(dt) {
  const gravity = 12;
  for (let e = _explosions.length - 1; e >= 0; e--) {
    const exp = _explosions[e];
    exp.timer += dt;
    let allDead = true;
    const d = _expDummy;

    for (let i = 0; i < exp.particles.length; i++) {
      const p = exp.particles[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      allDead = false;

      // Physics
      p.vy -= gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.1) { p.y = 0.1; p.vy *= -0.3; p.vx *= 0.8; p.vz *= 0.8; }

      d.position.set(p.x, p.y, p.z);
      d.rotation.y += p.spin * dt;
      const s = Math.max(0.1, p.life * 1.2);
      d.scale.set(s, s, s);
      d.updateMatrix();
      exp.mesh.setMatrixAt(i, d.matrix);

      // Fade color
      const fade = Math.max(0, p.life);
      exp.mesh.setColorAt(i, new THREE.Color(fade * 0.3, fade, fade * 0.4));
    }
    exp.mesh.instanceMatrix.needsUpdate = true;
    if (exp.mesh.instanceColor) exp.mesh.instanceColor.needsUpdate = true;

    // Fade material opacity
    exp.mat.opacity = Math.max(0, 1.0 - exp.timer * 0.5);

    if (allDead || exp.timer > 3) {
      _scene.remove(exp.mesh);
      exp.mesh.dispose();
      exp.mat.dispose();
      _explosions.splice(e, 1);
    }
  }
}

const _expDummy = new THREE.Object3D();

// ---- HIDE/SHOW MESH ----
function _hideEnemyMesh(e) {
  if (e.obj) e.obj.traverse(c => { c.visible = false; });
  if (e.body) e.body.traverse(c => { c.visible = false; });
  if (e.shieldMesh) e.shieldMesh.visible = false;
}
function _showEnemyMesh(e) {
  if (e.obj) e.obj.traverse(c => { c.visible = true; });
  if (e.body) e.body.traverse(c => { c.visible = true; });
  if (e.shieldMesh) e.shieldMesh.visible = true;
}

// ---- CSS ----
function _injectCSS() {
  if (_styleEl) return;
  _styleEl = document.createElement('style');
  _styleEl.textContent = `
#game.ascii-active > canvas { filter: contrast(1.5) brightness(0.75) saturate(0.15); }
#ascii-scanlines { position:absolute;inset:0;z-index:3;pointer-events:none;display:none;
  background:repeating-linear-gradient(0deg,transparent,transparent 1px,rgba(0,255,102,0.05) 1px,rgba(0,255,102,0.05) 3px); }
#game.ascii-active #ascii-scanlines { display:block; }
#ascii-timer-bar { position:absolute;top:0;left:0;height:4px;z-index:10;display:none;
  background:linear-gradient(90deg,#00ff66,#4ff7ff);box-shadow:0 0 12px #00ff66;transition:width .3s linear; }
#game.ascii-active #ascii-timer-bar { display:block; }
`;
  document.head.appendChild(_styleEl);
}

function _buildOverlayEls() {
  const g = document.getElementById('game');
  if (!g) return;
  ['ascii-grid','ascii-overlay','ascii-tint'].forEach(id => {
    const el = document.getElementById(id); if (el) el.remove();
  });
  g.querySelectorAll('.ascii-col').forEach(el => el.remove());
  ['ascii-scanlines','ascii-timer-bar'].forEach(id => {
    if (!document.getElementById(id)) { const el = document.createElement('div'); el.id = id; g.appendChild(el); }
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
  document.getElementById('game')?.classList.add('ascii-active');
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) bar.style.width = '100%';
  if (_enemies) for (const e of _enemies) _swapToAscii(e);
}

export function deactivateAsciiVision() {
  _active = false;
  _timer = 0;
  document.getElementById('game')?.classList.remove('ascii-active');
  if (_enemies) for (const e of _enemies) _restoreFromAscii(e);
  // Clean up remaining explosions
  for (const exp of _explosions) { _scene?.remove(exp.mesh); exp.mesh.dispose(); exp.mat.dispose(); }
  _explosions.length = 0;
}

export function isAsciiActive() { return _active; }

/**
 * Called from killEnemy — if ASCII is active, spawn explosion
 * and make enemy die instantly (caller handles the actual kill).
 */
export function onAsciiEnemyKill(enemy) {
  if (!_active) return;
  _spawnExplosion(enemy);
}

/**
 * Call from the damage path — if ASCII vision is active,
 * set enemy HP to 0 so any hit is a one-shot kill.
 */
export function asciiDamageOverride(enemy, damage) {
  if (!_active) return damage;
  // One-shot: return enough damage to kill
  return enemy.hp + 1;
}

const _dummy = new THREE.Object3D();

export function updateAsciiVision(dt) {
  if (!_active && _explosions.length === 0) return false;

  // Always update explosions even after deactivation
  _updateExplosions(dt);

  if (!_active) return false;

  _timer -= dt;
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) bar.style.width = Math.max(0, _timer / ASCII_DURATION * 100) + '%';
  if (_timer <= 0) { deactivateAsciiVision(); return false; }

  const time = performance.now() * 0.001;
  if (_enemies) {
    for (const e of _enemies) {
      if (!e._asciiCloud) _swapToAscii(e);
      if (e._asciiCloud && e.pos) {
        e._asciiCloud.position.set(e.pos.x, 0, e.pos.z);

        const cloud = e._asciiCloud;
        const pts = cloud.userData.points;
        const count = pts.length;
        const batch = Math.min(25, count);
        const start = Math.floor(time * 12) % count;

        for (let k = 0; k < batch; k++) {
          const i = (start + k) % count;
          const p = pts[i];
          _dummy.position.set(
            p.x + Math.sin(time * 2 + i * 0.4) * 0.06,
            p.y + Math.sin(time * 1.8 + i * 0.3) * 0.08,
            p.z + Math.cos(time * 2 + i * 0.4) * 0.06);
          _dummy.rotation.y = time * 0.4 + i;
          const s = 0.85 + Math.sin(time * 2.5 + i) * 0.15;
          _dummy.scale.set(s, s, s);
          _dummy.updateMatrix();
          cloud.setMatrixAt(i, _dummy.matrix);
        }
        cloud.instanceMatrix.needsUpdate = true;

        if (e.hitFlash > 0) { if (cloud.material !== _hitMat) cloud.material = _hitMat; }
        else { if (cloud.material !== _glyphMat) cloud.material = _glyphMat; }
        _hideEnemyMesh(e);
      }
    }
  }
  return true;
}

export function renderAsciiPass() {}
export function getAsciiTimeRemaining() { return Math.max(0, _timer); }

// ---- SWAP ----
function _swapToAscii(enemy) {
  if (enemy._asciiCloud || !_scene) return;
  const cloud = _buildCloud(enemy);
  if (!cloud) return;
  if (enemy.pos) cloud.position.set(enemy.pos.x, 0, enemy.pos.z);
  _scene.add(cloud);
  enemy._asciiCloud = cloud;
  _hideEnemyMesh(enemy);
}

function _restoreFromAscii(enemy) {
  if (!enemy._asciiCloud) return;
  _scene?.remove(enemy._asciiCloud);
  try { enemy._asciiCloud.dispose(); } catch (_) {}
  enemy._asciiCloud = null;
  _showEnemyMesh(enemy);
}
