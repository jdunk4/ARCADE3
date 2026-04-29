// mushroomCloud.js — Animated mushroom-cloud explosion effect.
//
// Used by ufoSpawner's destroy path (and any other caller that wants
// a full nuclear-style explosion). The cloud is built from a few
// dozen additive-blended puff spheres clustered into stem + cap
// shapes, animated through four phases:
//
//   1. FLASH    (0.00 – 0.20s) — bright white-hot dome appears at
//                                 ground level; ground shockwave
//                                 ring expands outward.
//   2. STEM     (0.10 – 1.50s) — vertical column of puffs rises
//                                 from the ground, each puff scaling
//                                 up as it ascends.
//   3. CAP      (0.80 – 2.20s) — the mushroom cap forms at the top
//                                 of the stem and blooms outward
//                                 into the iconic torus-dome shape.
//   4. DISSIPATE (2.00 – 3.80s) — entire cloud drifts upward, scales
//                                 outward, fades to transparent.
//                                 Phase overlaps with CAP so the
//                                 transition reads as a continuous
//                                 dissipation.
//
// All puffs share a small set of cached geometries and per-cloud
// materials. A single MushroomCloud instance owns its mesh group;
// caller is responsible for instantiating, ticking, and waiting for
// the .done flag before disposing.
//
// Public API:
//   spawnMushroomCloud(pos, color)   → MushroomCloud instance
//   updateMushroomClouds(dt)         → tick all active clouds
//   clearMushroomClouds()            → tear down (used on level reset)

import * as THREE from 'three';
import { scene } from './scene.js';

// Single shared sphere geometry for cloud puffs. Low-poly: each puff
// is small, additive-blended, and aggregates with neighbors so
// individual puff facets never read clearly. 12 segs is plenty.
const _PUFF_GEO = new THREE.SphereGeometry(1, 12, 8);

// Shockwave ring geometry — flat disc on the ground at t=0 that
// expands outward.
const _RING_GEO = new THREE.RingGeometry(0.8, 1.0, 48);

// Total lifetime in seconds. Cloud is removed from the scene once
// time exceeds this.
const _CLOUD_LIFE = 3.8;

// Active clouds — caller-agnostic global list, ticked by
// updateMushroomClouds(dt).
const _activeClouds = [];

/**
 * Build and add one mushroom cloud to the scene.
 * @param {THREE.Vector3} pos  World-space ground position (the
 *                             origin point of the explosion).
 * @param {number}        tint Hex color — chapter tint that will be
 *                             mixed into the warm core of the cloud.
 *                             The outer puffs stay neutral grey/white
 *                             so the silhouette reads as smoke, not
 *                             colored fog.
 * @returns {object} Cloud handle (caller doesn't usually keep it,
 *                   but exposed for testing).
 */
export function spawnMushroomCloud(pos, tint = 0xffaa00) {
  const root = new THREE.Group();
  root.position.copy(pos);
  // Render order high so puffs draw over geometry behind them
  // without depth-sorting against the saucer collapse.
  root.renderOrder = 5;

  // ---- MATERIALS ----
  // Three tints across the puff cloud:
  //   - core:   white-hot (very bright, additive)
  //   - warm:   chapter-tinted lerped 70/30 with white — the visible
  //             "color" of the explosion; e.g. red on inferno chapter.
  //   - smoke:  neutral grey-brown — outer puffs that read as billowing
  //             smoke rather than fire. Less additive opacity so they
  //             read as solid volumes against the sky.
  const cWhite = new THREE.Color(0xffffff);
  const cTint  = new THREE.Color(tint);
  const cWarm  = cWhite.clone().lerp(cTint, 0.7);
  const cSmoke = new THREE.Color(0x3a2a22);

  // Each puff gets its own material so we can individually fade them.
  // Small allocation cost (~30 materials) but lets us drive per-puff
  // opacity curves without shared-state surprises.
  function makePuffMat(color, additive, baseOpacity) {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: baseOpacity,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
    });
  }

  // ---- INITIAL FLASH DOME ----
  // Bright white-hot hemisphere at the explosion center. Scales up
  // briefly during phase 1 then fades out as the stem starts rising.
  const flashMat = makePuffMat(cWhite, true, 1.0);
  const flash = new THREE.Mesh(_PUFF_GEO, flashMat);
  flash.scale.setScalar(0.5);
  flash.position.y = 1.5;
  root.add(flash);

  // ---- GROUND SHOCKWAVE RING ----
  // Flat disc on the ground that expands outward + fades. Drives the
  // "explosion just happened" beat at the ground level.
  const ringMat = new THREE.MeshBasicMaterial({
    color: cWarm,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(_RING_GEO, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  root.add(ring);

  // ---- STEM PUFFS ----
  // Column of puffs rising vertically. Each has its own:
  //   y0      — starting Y (most start at 0 = ground level)
  //   yMax    — final Y (column height)
  //   tStart  — seconds into the cloud's life when this puff starts
  //             rising (staggered so the stem builds bottom-up)
  //   scale0  — initial scale (small)
  //   scale1  — peak scale during rise
  //   wobbleR — small horizontal jitter radius (procedural twist)
  //   matWarm — true if tinted warm (most stem puffs are warm; a few
  //             at the top are smoke-tinted as the stem cools off).
  const stem = [];
  const STEM_HEIGHT = 8.0;
  const STEM_PUFFS = 9;
  for (let i = 0; i < STEM_PUFFS; i++) {
    const f = i / (STEM_PUFFS - 1);                // 0..1 along stem
    // Bottom puffs are warm-tinted (closer to the fireball), top
    // puffs are smoke-tinted (the stem is cooling as it rises).
    const isWarm = f < 0.55;
    const matCol = isWarm ? cWarm : cSmoke;
    const isAdd  = isWarm;
    const baseOp = isWarm ? 0.95 : 0.90;
    const mat = makePuffMat(matCol, isAdd, baseOp);
    const puff = new THREE.Mesh(_PUFF_GEO, mat);
    // Initial size: small ball at ground.
    puff.scale.setScalar(0.6);
    puff.position.y = 0;
    root.add(puff);
    stem.push({
      mesh: puff, mat,
      y0: 0,
      yMax: f * STEM_HEIGHT + 0.5,
      tStart: 0.10 + f * 0.35,                     // ~0.1..0.45s lift-off staggered
      tRise:  0.85 + Math.random() * 0.20,         // duration of rise phase
      scale0: 0.6 + Math.random() * 0.3,
      scale1: 1.4 + Math.random() * 0.6,
      wobbleR: 0.15 + Math.random() * 0.25,
      wobblePhase: Math.random() * Math.PI * 2,
      isWarm,
    });
  }

  // ---- CAP PUFFS ----
  // The iconic mushroom cap — a torus-dome cluster of puffs at the top
  // of the stem. Built from N puffs arranged on a horizontal ring +
  // a center cluster on top. Outer cap puffs are big and smoke-tinted;
  // inner-top puffs are smaller + bright (the sunlit top of the cloud).
  const cap = [];
  const CAP_BASE_Y = STEM_HEIGHT + 0.5;
  const CAP_RADIUS = 4.5;
  // Outer ring of cap puffs.
  const CAP_RING_PUFFS = 14;
  for (let i = 0; i < CAP_RING_PUFFS; i++) {
    const a = (i / CAP_RING_PUFFS) * Math.PI * 2;
    const r = CAP_RADIUS * (0.85 + Math.random() * 0.25);
    const mat = makePuffMat(cSmoke, false, 0.92);
    const puff = new THREE.Mesh(_PUFF_GEO, mat);
    puff.scale.setScalar(0.4);
    puff.position.set(Math.cos(a) * 0.5, CAP_BASE_Y - 0.5, Math.sin(a) * 0.5);
    root.add(puff);
    cap.push({
      mesh: puff, mat,
      anchorX: Math.cos(a) * r,
      anchorZ: Math.sin(a) * r,
      anchorY: CAP_BASE_Y + (Math.random() - 0.5) * 0.8,
      tStart: 0.80 + Math.random() * 0.25,         // cap forms ~0.8s in
      tBloom: 0.75 + Math.random() * 0.30,         // bloom-out duration
      scale0: 0.4,
      scale1: 1.6 + Math.random() * 0.8,
      isWarm: false,
    });
  }
  // Top crown of cap puffs — bright, smaller, sit above the ring at
  // the very top of the cap. These are the warm-tinted glowing tops.
  const CAP_CROWN_PUFFS = 7;
  for (let i = 0; i < CAP_CROWN_PUFFS; i++) {
    const a = (i / CAP_CROWN_PUFFS) * Math.PI * 2;
    const r = CAP_RADIUS * 0.55 * Math.random();
    const mat = makePuffMat(cWarm, true, 0.95);
    const puff = new THREE.Mesh(_PUFF_GEO, mat);
    puff.scale.setScalar(0.3);
    puff.position.set(Math.cos(a) * 0.3, CAP_BASE_Y, Math.sin(a) * 0.3);
    root.add(puff);
    cap.push({
      mesh: puff, mat,
      anchorX: Math.cos(a) * r,
      anchorZ: Math.sin(a) * r,
      anchorY: CAP_BASE_Y + 1.2 + Math.random() * 0.4,
      tStart: 0.70 + Math.random() * 0.20,
      tBloom: 0.85,
      scale0: 0.3,
      scale1: 1.2 + Math.random() * 0.5,
      isWarm: true,
    });
  }

  // ---- BASE CLOUD PUFFS ----
  // Smoke billowing outward at the ground level — the spreading
  // dust ring left at the foot of the column. Reads as the "skirt"
  // around the explosion base.
  const baseCloud = [];
  const BASE_PUFFS = 10;
  for (let i = 0; i < BASE_PUFFS; i++) {
    const a = (i / BASE_PUFFS) * Math.PI * 2 + Math.random() * 0.4;
    const r = 1.5 + Math.random() * 1.5;
    const mat = makePuffMat(cSmoke, false, 0.85);
    const puff = new THREE.Mesh(_PUFF_GEO, mat);
    puff.scale.setScalar(0.4);
    puff.position.set(0, 0.2, 0);
    root.add(puff);
    baseCloud.push({
      mesh: puff, mat,
      anchorX: Math.cos(a) * r * 1.8,
      anchorZ: Math.sin(a) * r * 1.8,
      anchorY: 0.6 + Math.random() * 0.6,
      tStart: 0.05 + Math.random() * 0.15,
      tBloom: 0.40 + Math.random() * 0.20,
      scale0: 0.4,
      scale1: 1.3 + Math.random() * 0.5,
      isWarm: false,
    });
  }

  scene.add(root);

  const cloud = {
    root,
    flash, flashMat,
    ring, ringMat,
    stem,
    cap,
    baseCloud,
    t: 0,
    done: false,
    tint,
  };
  _activeClouds.push(cloud);
  return cloud;
}

// Smoothstep helper — eases in/out cleanly for scale and opacity
// curves. Avoids the harshness of linear ramps.
function _smooth(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Per-frame tick. Walks the active-clouds list, animates every puff
 * through its phase curve, removes finished clouds.
 *
 * Caller: spawners.js updateSpawners (or any animate-loop driver).
 */
export function updateMushroomClouds(dt) {
  for (let i = _activeClouds.length - 1; i >= 0; i--) {
    const c = _activeClouds[i];
    c.t += dt;
    const t = c.t;

    // Cloud-wide done check.
    if (t >= _CLOUD_LIFE) {
      _disposeCloud(c);
      _activeClouds.splice(i, 1);
      continue;
    }

    // ---- FLASH (0..0.20s) ----
    // Initial bright dome scales up quickly then fades out.
    if (t < 0.35) {
      const f = _smooth(t / 0.20);
      c.flash.scale.setScalar(0.5 + f * 3.5);
      // Opacity: 1.0 → 0 over 0.0..0.35s (slight overshoot beyond
      // 0.20 for a softer fade). Holds bright at peak then fades.
      const op = t < 0.20 ? 1.0 : 1.0 - (t - 0.20) / 0.15;
      c.flashMat.opacity = Math.max(0, op);
    } else if (c.flashMat.opacity > 0) {
      c.flashMat.opacity = 0;
      c.flash.visible = false;
    }

    // ---- SHOCKWAVE RING (0..0.50s) ----
    // Flat disc expands outward + fades. Bigger and slower than the
    // flash so it reads as a separate ground-shockwave beat.
    if (t < 0.50) {
      const f = _smooth(t / 0.50);
      c.ring.scale.setScalar(1 + f * 6);
      c.ringMat.opacity = 0.85 * (1 - f);
    } else if (c.ringMat.opacity > 0) {
      c.ringMat.opacity = 0;
      c.ring.visible = false;
    }

    // ---- STEM PUFFS (rise + grow) ----
    for (const p of c.stem) {
      const elapsed = t - p.tStart;
      if (elapsed < 0) continue;          // not yet started
      const f = _smooth(Math.min(1, elapsed / p.tRise));
      // Position: rise from y0 to yMax with horizontal wobble.
      const wob = p.wobbleR * Math.sin(t * 2.0 + p.wobblePhase);
      p.mesh.position.x = wob;
      p.mesh.position.y = p.y0 + (p.yMax - p.y0) * f;
      p.mesh.position.z = wob * 0.5;
      // Scale: ramp from scale0 to scale1.
      p.mesh.scale.setScalar(p.scale0 + (p.scale1 - p.scale0) * f);
      // Dissipate: after CLOUD_LIFE - 1.5s, fade to zero.
      const fadeStart = _CLOUD_LIFE - 1.5;
      if (t > fadeStart) {
        const ff = (t - fadeStart) / 1.5;
        p.mat.opacity = (p.isWarm ? 0.95 : 0.90) * (1 - ff);
        // Drift upward slightly during dissipate.
        p.mesh.position.y += ff * 1.5;
      }
    }

    // ---- CAP PUFFS (bloom outward) ----
    for (const p of c.cap) {
      const elapsed = t - p.tStart;
      if (elapsed < 0) continue;
      const f = _smooth(Math.min(1, elapsed / p.tBloom));
      // Position: lerp from origin (0, base, 0) to anchor.
      p.mesh.position.x = p.anchorX * f;
      p.mesh.position.z = p.anchorZ * f;
      p.mesh.position.y = p.anchorY * 0.85 + (p.anchorY - p.anchorY * 0.85) * f;
      p.mesh.scale.setScalar(p.scale0 + (p.scale1 - p.scale0) * f);
      // Dissipate: cap fades + drifts outward more than stem.
      const fadeStart = _CLOUD_LIFE - 1.6;
      if (t > fadeStart) {
        const ff = (t - fadeStart) / 1.6;
        p.mat.opacity = (p.isWarm ? 0.95 : 0.92) * (1 - ff);
        p.mesh.position.x = p.anchorX * (1 + ff * 0.3);
        p.mesh.position.z = p.anchorZ * (1 + ff * 0.3);
        p.mesh.position.y += ff * 1.2;
      }
    }

    // ---- BASE CLOUD PUFFS (skirt expansion) ----
    for (const p of c.baseCloud) {
      const elapsed = t - p.tStart;
      if (elapsed < 0) continue;
      const f = _smooth(Math.min(1, elapsed / p.tBloom));
      p.mesh.position.x = p.anchorX * f;
      p.mesh.position.z = p.anchorZ * f;
      p.mesh.position.y = 0.2 + p.anchorY * f;
      p.mesh.scale.setScalar(p.scale0 + (p.scale1 - p.scale0) * f);
      // Base cloud dissipates earlier than the cap — it's settling
      // dust, not the rising plume. Fade starts at half-life.
      const fadeStart = _CLOUD_LIFE - 2.0;
      if (t > fadeStart) {
        const ff = (t - fadeStart) / 2.0;
        p.mat.opacity = 0.85 * (1 - ff);
      }
    }
  }
}

function _disposeCloud(c) {
  if (c.root.parent) scene.remove(c.root);
  // Dispose materials (geometry is shared, don't dispose).
  if (c.flashMat) c.flashMat.dispose();
  if (c.ringMat) c.ringMat.dispose();
  for (const p of c.stem) if (p.mat) p.mat.dispose();
  for (const p of c.cap) if (p.mat) p.mat.dispose();
  for (const p of c.baseCloud) if (p.mat) p.mat.dispose();
  c.done = true;
}

/**
 * Tear down all active clouds. Called on level reset / game restart
 * so leftover clouds don't persist into a new run.
 */
export function clearMushroomClouds() {
  for (const c of _activeClouds) _disposeCloud(c);
  _activeClouds.length = 0;
}
