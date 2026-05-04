// ============================================================
// ASCII VISION — Enemy meshes become floating ASCII glyphs.
//
// When active:
//   - Each enemy's .body group is hidden
//   - A THREE.Sprite with a canvas-rendered ASCII character is
//     added to the scene at the enemy's position
//   - Sprites are bright green, emissive, billboard-facing
//   - A CSS overlay adds scanlines + green tint to the canvas
//   - New enemies spawned during the effect also get swapped
//
// Press V to activate. Lasts 15 seconds.
// ============================================================

import * as THREE from 'three';

let _active = false;
let _timer = 0;
let _enemies = null;       // reference to the game's enemies array
let _scene = null;         // reference to the game scene
let _styleEl = null;
const ASCII_DURATION = 15.0;

// Map enemy type → ASCII character
const TYPE_GLYPHS = {
  zomeeb:     '@',
  sprinter:   '%',
  brute:      '#',
  spider:     '*',
  pumpkin:    'P',
  ghost:      'G',
  vampire:    'V',
  red_devil:  'D',
  wizard:     'W',
  goospitter: 'S',
  jumper:     'J',
  infector:   'X',
  roach:      'R',
  ant:        'a',
};
const DEFAULT_GLYPH = '@';

// Sprite texture cache — one per unique glyph
const _texCache = new Map();

function _makeGlyphTexture(char) {
  if (_texCache.has(char)) return _texCache.get(char);
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.font = 'bold 52px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Glow layers
  ctx.shadowColor = '#00ff66';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#00ff66';
  ctx.fillText(char, size / 2, size / 2);
  // Sharper layer on top
  ctx.shadowBlur = 4;
  ctx.fillStyle = '#aaffcc';
  ctx.fillText(char, size / 2, size / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  _texCache.set(char, tex);
  return tex;
}

function _makeSprite(char) {
  const tex = _makeGlyphTexture(char);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 2.2, 1);
  return sprite;
}

// ---- CSS OVERLAY ----
function _injectCSS() {
  if (_styleEl) return;
  _styleEl = document.createElement('style');
  _styleEl.textContent = `
#game.ascii-active > canvas {
  filter: contrast(1.4) brightness(0.85) saturate(0.3);
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
    rgba(0,40,10,0.15) 0%, rgba(0,20,5,0.45) 100%);
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
  if (!document.getElementById('ascii-scanlines')) {
    const sl = document.createElement('div');
    sl.id = 'ascii-scanlines';
    gameEl.appendChild(sl);
  }
  if (!document.getElementById('ascii-tint')) {
    const t = document.createElement('div');
    t.id = 'ascii-tint';
    gameEl.appendChild(t);
  }
  if (!document.getElementById('ascii-timer-bar')) {
    const b = document.createElement('div');
    b.id = 'ascii-timer-bar';
    gameEl.appendChild(b);
  }
}

// ---- PUBLIC API ----

export function initAsciiVision(sceneRef, enemiesRef) {
  _scene = sceneRef;
  _enemies = enemiesRef;
  _injectCSS();
  _buildOverlayEls();
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
  // Restore all enemies
  if (_enemies) {
    for (const e of _enemies) _restoreFromAscii(e);
  }
}

export function isAsciiActive() { return _active; }

export function updateAsciiVision(dt) {
  if (!_active) return false;
  _timer -= dt;
  // Timer bar
  const bar = document.getElementById('ascii-timer-bar');
  if (bar) bar.style.width = Math.max(0, _timer / ASCII_DURATION * 100) + '%';

  if (_timer <= 0) {
    deactivateAsciiVision();
    return false;
  }

  // Swap any newly-spawned enemies that don't have sprites yet
  if (_enemies) {
    for (const e of _enemies) {
      if (!e._asciiSprite) _swapToAscii(e);
      // Update sprite position + bob
      if (e._asciiSprite && e.pos) {
        e._asciiSprite.position.set(
          e.pos.x,
          1.5 + Math.sin(performance.now() * 0.003 + e.pos.x) * 0.2,
          e.pos.z,
        );
        // Pulse scale on hit
        const s = e.hitFlash > 0 ? 2.8 : 2.2;
        e._asciiSprite.scale.set(s, s, 1);
      }
    }
  }
  return true;
}

// Render pass — no-op, sprites are in the scene and render with normal pass
export function renderAsciiPass() {}

export function getAsciiTimeRemaining() { return Math.max(0, _timer); }

// ---- SWAP HELPERS ----

function _swapToAscii(enemy) {
  if (enemy._asciiSprite) return;  // already swapped
  if (!_scene) return;

  const glyph = TYPE_GLYPHS[enemy.typeKey] || DEFAULT_GLYPH;

  // Boss gets a bigger, different glyph
  const char = enemy.isBoss ? '\u2588' : glyph;  // █ for bosses
  const sprite = _makeSprite(char);

  if (enemy.pos) {
    sprite.position.set(enemy.pos.x, 1.5, enemy.pos.z);
  }
  if (enemy.isBoss) sprite.scale.set(4.5, 4.5, 1);

  _scene.add(sprite);
  enemy._asciiSprite = sprite;

  // Hide the 3D body
  if (enemy.body) enemy.body.visible = false;
}

function _restoreFromAscii(enemy) {
  if (!enemy._asciiSprite) return;
  if (_scene) _scene.remove(enemy._asciiSprite);
  enemy._asciiSprite.material.dispose();
  enemy._asciiSprite = null;

  // Restore the 3D body
  if (enemy.body) enemy.body.visible = true;
}
