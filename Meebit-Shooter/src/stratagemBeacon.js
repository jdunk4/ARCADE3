// stratagemBeacon.js — Visual beacon prop for stratagem call-ins.
//
// When a player calls in a stratagem, a beacon spawns at the cursor
// ground position. The beacon:
//   • is a glowing tinted post with a pulsing top light
//   • shows a 10-second countdown above it
//   • emits a column of light upward (so the player can find it
//     across the arena)
//   • triggers its stratagem's payload when the timer hits zero
//   • removes itself from the scene shortly after deploy
//
// Beacons live in their own active-list, ticked by updateStratagemBeacons()
// from stratagems.js (which itself is ticked by main.js).

import * as THREE from 'three';
import { scene } from './scene.js';
import { Audio } from './audio.js';

// Shared geometries — built once at module load.
const _POST_GEO   = new THREE.CylinderGeometry(0.15, 0.20, 1.6, 10);
const _LIGHT_GEO  = new THREE.SphereGeometry(0.30, 14, 10);
const _RING_GEO   = new THREE.RingGeometry(0.85, 1.05, 36);
// Light column — open cylinder pointing upward. Reads as a vertical
// beam locating the beacon from across the arena.
const _COLUMN_GEO = new THREE.CylinderGeometry(0.40, 0.28, 14.0, 16, 1, true);

const _activeBeacons = [];

/**
 * Spawn a beacon at world position pos. stratagem is the catalog
 * entry from stratagems.js; tint is the chapter color.
 * Returns the beacon record (caller doesn't usually keep it).
 */
export function spawnStratagemBeacon(pos, stratagem, tint) {
  const root = new THREE.Group();
  root.position.copy(pos);
  root.position.y = 0;

  const tintColor = new THREE.Color(tint);

  // Post — gunmetal cylinder with a chapter-tinted emissive seam.
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x2a2c34,
    emissive: tintColor,
    emissiveIntensity: 0.4,
    roughness: 0.55,
    metalness: 0.70,
  });
  const post = new THREE.Mesh(_POST_GEO, postMat);
  post.position.y = 0.8;
  post.castShadow = true;
  root.add(post);

  // Top light — bright pulsing sphere.
  const lightMat = new THREE.MeshBasicMaterial({
    color: tintColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const light = new THREE.Mesh(_LIGHT_GEO, lightMat);
  light.position.y = 1.7;
  root.add(light);

  // Ground ring — flat halo on the floor showing the deploy radius.
  const ringMat = new THREE.MeshBasicMaterial({
    color: tintColor,
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(_RING_GEO, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  root.add(ring);

  // Light column — visible from across the arena.
  const columnMat = new THREE.MeshBasicMaterial({
    color: tintColor,
    transparent: true,
    opacity: 0.32,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const column = new THREE.Mesh(_COLUMN_GEO, columnMat);
  column.position.y = 7.0;
  root.add(column);

  // Countdown text — drawn on a CanvasTexture sprite that we update
  // each frame as the timer ticks down. Smaller text canvas keeps
  // updates cheap.
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  const labelMat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const label = new THREE.Sprite(labelMat);
  label.scale.set(2.4, 1.2, 1);
  label.position.y = 3.2;
  root.add(label);

  scene.add(root);

  const beacon = {
    root, post, postMat,
    light, lightMat,
    ring, ringMat,
    column, columnMat,
    label, labelMat, tex, canvas,
    stratagem,
    tint,
    tintColor,
    armTime: stratagem.armTime,
    t: 0,
    fired: false,
    despawnAt: stratagem.armTime + 0.8,    // brief lingering glow after deploy
  };
  _activeBeacons.push(beacon);
  _drawCountdownLabel(beacon);
  return beacon;
}

// Draw the current remaining countdown onto the beacon's sprite canvas.
function _drawCountdownLabel(beacon) {
  const ctx = beacon.canvas.getContext('2d');
  ctx.clearRect(0, 0, beacon.canvas.width, beacon.canvas.height);
  const remaining = Math.max(0, beacon.armTime - beacon.t);
  // Title line.
  ctx.font = 'bold 28px Impact, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Name above the timer; tint color.
  const tHex = '#' + beacon.tintColor.getHexString();
  ctx.fillStyle = tHex;
  ctx.shadowColor = tHex;
  ctx.shadowBlur = 16;
  ctx.fillText(beacon.stratagem.label, 128, 36);
  // Big timer.
  ctx.font = 'bold 56px Impact, monospace';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = tHex;
  ctx.shadowBlur = 24;
  const txt = remaining.toFixed(1) + 's';
  ctx.fillText(txt, 128, 92);
  beacon.tex.needsUpdate = true;
}

/**
 * Per-frame tick. Called from updateStratagems() in stratagems.js.
 */
export function updateStratagemBeacons(dt) {
  for (let i = _activeBeacons.length - 1; i >= 0; i--) {
    const b = _activeBeacons[i];
    const wasT = b.t;
    b.t += dt;

    // Beacon landing — fire once on the first frame the beacon ticks.
    // Lock-in chirp lets the player know the throw was registered.
    if (!b._landed) {
      b._landed = true;
      try { Audio.beaconLand(); } catch (_) {}
    }

    // Refresh countdown label every 0.1s so we don't redraw the
    // canvas every frame. Sprite texture invalidation is the most
    // expensive op in the per-beacon tick.
    if (Math.floor(b.t * 10) !== Math.floor((b.t - dt) * 10)) {
      _drawCountdownLabel(b);
    }

    // Beep on each whole-second tick. The pitch rises with urgency
    // (0..1 across the arm window) so the audio cue actually feels
    // tense in the final couple of seconds.
    {
      const wasSec = Math.floor(wasT);
      const nowSec = Math.floor(b.t);
      if (nowSec !== wasSec && b.t < b.armTime) {
        const urgency = b.t / b.armTime;
        try { Audio.beaconCountdown(urgency); } catch (_) {}
      }
    }

    // Pulse light intensity — speeds up as the timer counts down.
    const remaining = Math.max(0, b.armTime - b.t);
    const urgency = 1 - remaining / b.armTime;          // 0..1 across timer
    const pulseHz = 1.5 + urgency * 6;
    const pulse = 0.5 + 0.5 * Math.sin(b.t * pulseHz * Math.PI * 2);
    b.lightMat.opacity = 0.6 + pulse * 0.4;
    b.postMat.emissiveIntensity = 0.3 + pulse * 0.5 + urgency * 0.6;
    b.columnMat.opacity = 0.25 + pulse * 0.10;
    b.ringMat.opacity = 0.45 + pulse * 0.20;

    // Slow rotation on the column for movement.
    b.column.rotation.y += dt * 0.3;
    b.ring.rotation.z += dt * 0.4;

    // Fire payload at zero.
    if (!b.fired && b.t >= b.armTime) {
      b.fired = true;
      try {
        b.stratagem.payload(b.root.position.clone(), b.tint);
      } catch (e) { console.warn('[stratagem payload]', e); }
      // Hide the column + ring more aggressively post-fire so the
      // player knows it's done; the post itself fades over the
      // remaining despawn window.
      b.columnMat.opacity = 0;
      b.column.visible = false;
    }

    // Despawn after the post-fire lingering window.
    if (b.t >= b.despawnAt) {
      _disposeBeacon(b);
      _activeBeacons.splice(i, 1);
    }
  }
}

function _disposeBeacon(b) {
  if (b.root.parent) scene.remove(b.root);
  if (b.postMat) b.postMat.dispose();
  if (b.lightMat) b.lightMat.dispose();
  if (b.ringMat) b.ringMat.dispose();
  if (b.columnMat) b.columnMat.dispose();
  if (b.labelMat) b.labelMat.dispose();
  if (b.tex) b.tex.dispose();
}

/**
 * Tear down all active beacons (game reset).
 */
export function clearStratagemBeacons() {
  for (const b of _activeBeacons) _disposeBeacon(b);
  _activeBeacons.length = 0;
}
