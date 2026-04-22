// Edge-of-screen objective arrows.
//
// Shows a pulsing arrow along the viewport edge for every off-screen
// target that matters this wave. Each arrow is labelled with the
// target type (ORE, HIVE, DEPOT, BOSS) and the distance from the
// player.
//
// Target set per wave type:
//   mining   — nearest grounded blocks (up to 5). While the player is
//              carrying ores, replaced by the depot arrow so the drop-
//              off becomes the next objective.
//   powerup  — stage 1 stub: no arrows (zones are coming in stage 2).
//   hive     — every live hive. Shielded hives are invulnerable but
//              still worth pointing at so the player knows they exist.
//   bonus    — no arrows (herd + proximity catching is self-guiding).
//   boss     — the boss (always panic-styled).
//
// VISUAL THEME
//   Arrows are tinted to the CURRENT CHAPTER's signature color. Targets
//   flagged `panic` (the boss) render in red, overriding the chapter tint.
//
// DOM strategy: pool of 8 arrow elements created once, reused per frame.

import * as THREE from 'three';
import { enemies } from './enemies.js';
import { spawners } from './spawners.js';
import { blocks } from './blocks.js';
import { depot as currentDepot } from './ores.js';
import { CHAPTERS } from './config.js';

const POOL_SIZE = 8;
const PANIC_COLOR = '#ff2e4d';   // always-red override for dangerous targets

const _v3 = new THREE.Vector3();
let _layer = null;
let _pool = [];
let _stylesInjected = false;

// Scratch array for per-frame target collection — reused, no alloc.
const _targets = [];

/** Convert 0xRRGGBB integer to '#rrggbb' CSS string. */
function _hex(n) {
  return '#' + n.toString(16).padStart(6, '0');
}

/** Inject structural CSS once (layout, animations). Per-arrow COLORS
 *  are applied inline in updateObjectiveArrows so chapter tint can
 *  change at runtime without touching the stylesheet. */
function _injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const css = `
    #objective-arrow-layer {
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 13;
    }
    .obj-arrow {
      position: absolute;
      display: none;
      flex-direction: column;
      align-items: center;
      transform-origin: center;
      pointer-events: none;
      /* filter (drop-shadow glow) is set inline per-frame so it
         matches the chapter / panic tint */
    }
    .obj-arrow .obj-arrow-head {
      font-size: 34px;
      line-height: 1;
      animation: obj-arrow-pulse 0.9s ease-in-out infinite;
      /* color + text-shadow set inline */
    }
    .obj-arrow .obj-arrow-meta {
      font-family: 'Impact', monospace;
      font-size: 10px;
      letter-spacing: 2px;
      margin-top: 2px;
      white-space: nowrap;
      /* color + text-shadow set inline */
    }
    .obj-arrow.panic .obj-arrow-head {
      animation: obj-arrow-panic 0.3s ease-in-out infinite;
    }
    @keyframes obj-arrow-pulse {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.15); }
    }
    @keyframes obj-arrow-panic {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.3); }
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

/** Lazy-create the pool on first update. */
function _ensurePool() {
  if (_layer) return;
  _injectStyles();
  _layer = document.createElement('div');
  _layer.id = 'objective-arrow-layer';
  document.body.appendChild(_layer);

  for (let i = 0; i < POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'obj-arrow';
    const head = document.createElement('div');
    head.className = 'obj-arrow-head';
    head.textContent = '➤';
    const meta = document.createElement('div');
    meta.className = 'obj-arrow-meta';
    meta.textContent = '';
    el.appendChild(head);
    el.appendChild(meta);
    _layer.appendChild(el);
    _pool.push({ el, head, meta });
  }
}

/** Hide every arrow (wave end, game over, etc). */
export function clearObjectiveArrows() {
  if (!_pool.length) return;
  for (const p of _pool) p.el.style.display = 'none';
}

/**
 * Apply a color to one arrow. Updates the head glyph, the meta
 * label, and the wrapper's drop-shadow glow so the whole unit reads
 * as one tinted object.
 */
function _setArrowColor(p, colorStr) {
  p.head.style.color = colorStr;
  p.head.style.textShadow = `0 0 10px ${colorStr}`;
  p.meta.style.color = colorStr;
  p.meta.style.textShadow = `0 0 6px ${colorStr}, 1px 1px 0 #000`;
  p.el.style.filter = `drop-shadow(0 0 8px ${colorStr})`;
}

/** Collect (x, z, label, panic) entries for the current wave. */
function _collectTargets(S, waveDef, playerPos) {
  _targets.length = 0;
  if (!waveDef) return;

  const px = playerPos ? playerPos.x : 0;
  const pz = playerPos ? playerPos.z : 0;

  switch (waveDef.type) {
    case 'mining': {
      const carrying = S.oresCarried || 0;
      if (carrying > 0 && currentDepot) {
        _targets.push({
          x: currentDepot.pos.x, z: currentDepot.pos.z,
          label: 'DEPOT', panic: false,
        });
      } else {
        const grounded = [];
        for (const b of blocks) {
          if (b.falling || b.destroyed) continue;
          const dx = b.pos.x - px;
          const dz = b.pos.z - pz;
          grounded.push({ b, d2: dx * dx + dz * dz });
        }
        grounded.sort((a, b) => a.d2 - b.d2);
        const limit = Math.min(5, grounded.length);
        for (let i = 0; i < limit; i++) {
          const b = grounded[i].b;
          _targets.push({
            x: b.pos.x, z: b.pos.z,
            label: 'ORE', panic: false,
          });
        }
        if (grounded.length === 0 && currentDepot) {
          _targets.push({
            x: currentDepot.pos.x, z: currentDepot.pos.z,
            label: 'DEPOT', panic: false,
          });
        }
      }
      break;
    }
    case 'capture': {
      // Legacy wave type, no longer in the default flow. If a save ever
      // references it, just skip — no targets to draw.
      break;
    }
    case 'powerup': {
      // Stage 1 stub — no arrows yet. Stage 2 will point at the currently-
      // active zone in the power-up sequence.
      break;
    }
    case 'hive':
    case 'spawners': {
      for (const s of spawners) {
        if (s.destroyed) continue;
        _targets.push({
          x: s.pos.x, z: s.pos.z,
          label: s.shielded ? 'SHIELDED HIVE' : 'HIVE',
          panic: false,
        });
      }
      break;
    }
    case 'bonus': {
      // Herd is self-guiding — no edge arrows.
      break;
    }
    case 'boss': {
      for (const e of enemies) {
        if (e.isBoss) {
          _targets.push({
            x: e.pos.x, z: e.pos.z,
            label: 'BOSS', panic: true,
          });
          break;
        }
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Per-frame update.
 *
 * @param {object} S       state module
 * @param {THREE.Camera} camera
 * @param {object} waveDef current wave definition (null OK, arrows hide)
 * @param {{x:number,z:number}} playerPos player world position
 */
export function updateObjectiveArrows(S, camera, waveDef, playerPos) {
  _ensurePool();

  // Resolve the chapter tint once per frame — used for every non-panic arrow.
  const chapter = CHAPTERS[(S.chapter || 0) % CHAPTERS.length];
  const chapterColor = _hex(chapter.full.grid1);

  _collectTargets(S, waveDef, playerPos);

  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const margin = 0.88;

  const limit = Math.min(_targets.length, POOL_SIZE);
  for (let i = 0; i < limit; i++) {
    const t = _targets[i];
    const p = _pool[i];

    _v3.set(t.x, 1.5, t.z);
    _v3.project(camera);
    let x = _v3.x;
    let y = _v3.y;
    const behind = _v3.z > 1;

    // On-screen? Hide.
    if (!behind && Math.abs(x) < 0.85 && Math.abs(y) < 0.85) {
      p.el.style.display = 'none';
      continue;
    }

    // Behind camera — mirror so the arrow points the right way.
    if (behind) { x = -x; y = -y; }

    const max = Math.max(Math.abs(x), Math.abs(y));
    if (max > margin) {
      x = (x / max) * margin;
      y = (y / max) * margin;
    }

    const sx = (x + 1) * 0.5 * vpW;
    const sy = (-y + 1) * 0.5 * vpH;
    const angle = Math.atan2(-y, x);

    const dx = t.x - (playerPos ? playerPos.x : 0);
    const dz = t.z - (playerPos ? playerPos.z : 0);
    const dist = Math.round(Math.sqrt(dx * dx + dz * dz));

    p.el.style.display = 'flex';
    p.el.style.left = sx + 'px';
    p.el.style.top = sy + 'px';
    p.el.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    p.meta.textContent = `${t.label} · ${dist}m`;
    p.meta.style.transform = `rotate(${-angle}rad)`;

    // Color: panic targets are always red (universally readable as
    // danger). Everything else is chapter-tinted.
    const color = t.panic ? PANIC_COLOR : chapterColor;
    _setArrowColor(p, color);
    p.el.classList.toggle('panic', !!t.panic);
  }

  for (let i = limit; i < POOL_SIZE; i++) {
    _pool[i].el.style.display = 'none';
  }
}
