// ============================================================================
// src/shockwave.js — reusable expanding-ring shockwave effect.
//
// Originally lived inline in empLaunch.js as part of the EMP detonation.
// Extracted so every wave-end can reuse it (wave 1 depot, wave 2 missile
// hit, wave 3 last hive, wave 4 player, wave 5 boss).
//
// API:
//   fireShockwave(origin, opts) — spawn a shockwave from a world-space point.
//   updateShockwaves(dt)        — tick all active shockwaves. Called from main.js.
//   clearShockwaves()           — remove every active shockwave from the scene.
//
// opts:
//   tint            — hex color; default = current chapter grid1
//   maxRadius       — default 55
//   durationSec     — default 1.2
//   onRadius(r)     — callback fired every frame with current radius (used
//                     by empLaunch.js to drop hive shields as the ring passes)
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { S } from './state.js';
import { CHAPTERS } from './config.js';

const RING_SEGMENTS = 64;

const _active = [];

/**
 * Spawn a shockwave at the given world-space origin (Vector3 or {x, y, z}).
 * Returns the entry object (for callers that want to track it).
 */
export function fireShockwave(origin, opts = {}) {
  const tint = opts.tint || CHAPTERS[S.chapter % CHAPTERS.length].full.grid1;
  const maxRadius = opts.maxRadius || 55;
  const durationSec = opts.durationSec || 1.2;

  // Ring geometry that we rescale each frame. Start radius is tiny.
  const geo = new THREE.RingGeometry(0.5, 1.0, RING_SEGMENTS);
  const mat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  const ox = (origin.x !== undefined) ? origin.x : 0;
  const oy = (origin.y !== undefined) ? origin.y : 0.2;
  const oz = (origin.z !== undefined) ? origin.z : 0;
  mesh.position.set(ox, Math.max(0.15, oy), oz);
  scene.add(mesh);

  const entry = {
    mesh, mat, maxRadius, durationSec,
    elapsed: 0,
    onRadius: opts.onRadius || null,
  };
  _active.push(entry);
  return entry;
}

/** Tick every active shockwave; remove finished ones. */
export function updateShockwaves(dt) {
  for (let i = _active.length - 1; i >= 0; i--) {
    const sw = _active[i];
    sw.elapsed += dt;
    const f = Math.min(1, sw.elapsed / sw.durationSec);
    const r = 1 + f * sw.maxRadius;
    sw.mesh.scale.set(r, r, 1);
    sw.mat.opacity = 0.85 * (1 - f * 0.6);

    if (sw.onRadius) {
      try { sw.onRadius(r); } catch (err) { /* swallow */ }
    }

    if (f >= 1) {
      if (sw.mesh.parent) scene.remove(sw.mesh);
      if (sw.mesh.geometry) sw.mesh.geometry.dispose();
      _active.splice(i, 1);
    }
  }
}

/** Tear down every active shockwave (called on chapter teardown / reset). */
export function clearShockwaves() {
  for (const sw of _active) {
    if (sw.mesh.parent) scene.remove(sw.mesh);
    if (sw.mesh.geometry) sw.mesh.geometry.dispose();
  }
  _active.length = 0;
}
