// spawnerFx.js — Shared visual effects for damage/destruction states
// of structure-typed spawners (UFO, pyramid). Kept out of the
// individual spawner files so the FX primitives (crack texture,
// lightning bolt builder) can be reused without duplication.
//
// Public API:
//   getCrackTexture()        — lazy-built canvas crack overlay
//   buildLightningBolt(from, to, color)
//                            — short-lived jagged line segment between
//                              two THREE.Vector3 points, returned as a
//                              { mesh, life, ttl } record. Caller adds
//                              mesh to scene and ticks life until ttl.
//   tickLightningBolts(dt, list)
//                            — caller-owned list update; fades + removes.

import * as THREE from 'three';
import { scene } from './scene.js';

// ---- CRACK TEXTURE ----
// Lazy-built once at first use. A black canvas with semi-transparent
// jagged white lines forming a web pattern. Used as alphaMap on a
// transparent overlay material so cracks fade in over hull surfaces
// as damage progresses (overlay opacity ramps with 1-ratio).
let _crackTex = null;

function _drawJaggedLine(ctx, x1, y1, x2, y2, jitter, branches) {
  // Draw a jagged line from (x1,y1) to (x2,y2) with random
  // perpendicular offsets at 5 intermediate points. Branches
  // recursively spawn shorter side cracks at random midpoints.
  const segs = 8;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  let lastX = x1, lastY = y1;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    // Linear interp + perpendicular jitter
    const mx = x1 + (x2 - x1) * t;
    const my = y1 + (y2 - y1) * t;
    // Perpendicular direction
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const px = -dy / len, py = dx / len;
    const j = (Math.random() - 0.5) * jitter * (i < segs ? 1 : 0);
    const jx = mx + px * j;
    const jy = my + py * j;
    ctx.lineTo(jx, jy);
    // Spawn a branch from a random middle point.
    if (branches > 0 && i > 2 && i < segs - 1 && Math.random() < 0.4) {
      const blen = len * (0.15 + Math.random() * 0.20);
      const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.6;
      const bx = jx + Math.cos(angle) * blen;
      const by = jy + Math.sin(angle) * blen;
      // Stash current path state, draw branch separately, then resume.
      ctx.stroke();
      ctx.lineWidth = Math.max(1, ctx.lineWidth * 0.6);
      _drawJaggedLine(ctx, jx, jy, bx, by, jitter * 0.6, branches - 1);
      ctx.lineWidth = ctx.lineWidth / 0.6;
      ctx.beginPath();
      ctx.moveTo(jx, jy);
    }
    lastX = jx; lastY = jy;
  }
  ctx.stroke();
}

export function getCrackTexture() {
  if (_crackTex) return _crackTex;
  const SIZE = 512;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  // Black background — alphaMap reads the brightness, so black =
  // fully transparent overlay (no crack).
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SIZE, SIZE);
  // White jagged crack lines = visible overlay.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  // 6 main cracks radiating from random centers.
  for (let i = 0; i < 6; i++) {
    const cx = SIZE * (0.3 + Math.random() * 0.4);
    const cy = SIZE * (0.3 + Math.random() * 0.4);
    const angle = Math.random() * Math.PI * 2;
    const len = SIZE * (0.25 + Math.random() * 0.30);
    const ex = cx + Math.cos(angle) * len;
    const ey = cy + Math.sin(angle) * len;
    _drawJaggedLine(ctx, cx, cy, ex, ey, 28, 2);
  }
  // A dozen smaller hairline cracks scattered around for fine detail.
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 12; i++) {
    const x1 = Math.random() * SIZE;
    const y1 = Math.random() * SIZE;
    const angle = Math.random() * Math.PI * 2;
    const len = SIZE * (0.05 + Math.random() * 0.10);
    _drawJaggedLine(ctx, x1, y1, x1 + Math.cos(angle) * len, y1 + Math.sin(angle) * len, 8, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);   // tile so the pattern doesn't read as obviously uniform
  tex.anisotropy = 4;
  _crackTex = tex;
  return tex;
}

// ---- LIGHTNING BOLTS ----
// A jagged polyline drawn between two points using a thin
// LineSegments mesh with additive-blended bright tint. Bolt fades
// out over its TTL (default 0.18s) — the caller adds it to a list
// and ticks it.

const _BOLT_TTL = 0.20;

/**
 * Build a single jagged lightning bolt between two world-space
 * points. Returns a record the caller stores and ticks until
 * `life >= ttl`.
 *
 * The bolt is built as a sequence of line segments with perpendicular
 * jitter so it reads as electrical, not a straight beam.
 *
 * @param {THREE.Vector3} from World-space start
 * @param {THREE.Vector3} to   World-space end
 * @param {number}        color Hex color — defaults to electric cyan-white
 * @param {number}        thickness Segment count modifier
 * @returns {{mesh: THREE.Line, life: number, ttl: number, mat: THREE.Material}}
 */
export function buildLightningBolt(from, to, color = 0xc8f0ff, thickness = 1) {
  // Build a polyline with ~10 jittered intermediate points.
  const segs = 10;
  const pts = [];
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length() || 1;
  // Perpendicular vector — pick the smallest component of dir to
  // cross with for a stable up-axis.
  const up = new THREE.Vector3(0, 1, 0);
  const perp1 = new THREE.Vector3().crossVectors(dir, up).normalize();
  const perp2 = new THREE.Vector3().crossVectors(dir, perp1).normalize();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const px = from.x + dir.x * t;
    const py = from.y + dir.y * t;
    const pz = from.z + dir.z * t;
    // Endpoints stay locked, middle points jitter perpendicular.
    if (i === 0 || i === segs) {
      pts.push(new THREE.Vector3(px, py, pz));
    } else {
      // Jitter falls off near the ends so the bolt reads as anchored.
      const fall = Math.min(t, 1 - t) * 2;
      const jamt = len * 0.10 * fall;
      const j1 = (Math.random() - 0.5) * jamt;
      const j2 = (Math.random() - 0.5) * jamt;
      pts.push(new THREE.Vector3(
        px + perp1.x * j1 + perp2.x * j2,
        py + perp1.y * j1 + perp2.y * j2,
        pz + perp1.z * j1 + perp2.z * j2,
      ));
    }
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    linewidth: thickness,    // most browsers cap at 1, but we set anyway
  });
  const line = new THREE.Line(geo, mat);
  return { mesh: line, life: 0, ttl: _BOLT_TTL, mat, geo };
}

/**
 * Per-frame tick for a list of lightning bolts. Fades opacity, removes
 * expired bolts. Caller-owned list (push/splice) so multiple subsystems
 * can have independent bolt lists.
 *
 * @param {number} dt
 * @param {Array<{mesh,life,ttl,mat,geo}>} list
 */
export function tickLightningBolts(dt, list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    b.life += dt;
    const f = b.life / b.ttl;
    if (f >= 1) {
      if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
      if (b.mat) b.mat.dispose();
      if (b.geo) b.geo.dispose();
      list.splice(i, 1);
      continue;
    }
    // Snap-fade: bright for first half, fades over second half.
    b.mat.opacity = f < 0.5 ? 1.0 : 1.0 - (f - 0.5) * 2;
  }
}
