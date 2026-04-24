// ============================================================================
// src/empWires.js — powerplant-to-compound wire network.
//
// Wires connect the powerplant to each of the three turrets and to the silo.
// Each wire has two visual states:
//
//   DORMANT — a thin dim line. No animation.
//   CHARGING — while the player is standing in the matching turret's
//              charge zone, the wire visually "fills" with energy from the
//              powerplant end toward the turret end. The fill progress
//              matches the zone's own progress so the player reads the
//              wire as the charge meter.
//   LIT (stuck-on) — once the turret completes, the wire stays fully
//              bright as a permanent "this turret is powered" telegraph.
//
// The old pulse-sphere system (3 glowing orbs sliding back and forth
// along every wire) was removed — it fought for visual real estate with
// the actual turret projectiles and made the scene feel noisy during
// wave 2. The fill-charge visual ties the wire directly to the zone
// the player is currently holding, so "where to go / what progress you've
// made" is legible at a glance.
//
// Lifecycle:
//   buildWires(chapterIdx) — 4 wires created: 3 to turrets + 1 to silo.
//   setWiresLit(isLit)     — flipped true when POWER completes; sets the
//                            baseline dim-but-active state. Turret wires
//                            then fill individually based on zone charge.
//   setWireCharge(turretIdx, frac01) — called every frame from waves.js
//                            with the matching zone's progress fraction.
//   setWireComplete(turretIdx) — locks that wire to fully-lit.
//   updateWires(dt, time)  — per-frame glow pulse on the filled portion.
//   clearWires()           — called from teardownChapter.
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { LAYOUT } from './waveProps.js';

const WIRE_HEIGHT = 0.8;            // y-offset so wires don't clip into ground
const WIRE_RADIUS_DIM = 0.05;
const WIRE_RADIUS_LIT = 0.10;       // lit/filled wire is thicker for legibility
const WIRE_RADIAL_SEGMENTS = 8;

// Cached wire materials per chapter tint.
const _wireDimCache = new Map();
const _wireLitCache = new Map();

function _getWireDim(tint) {
  let m = _wireDimCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.22,
    });
    _wireDimCache.set(tint, m);
  }
  return m;
}
function _getWireLit(tint) {
  let m = _wireLitCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.95,
    });
    _wireLitCache.set(tint, m);
  }
  return m;
}

export function prewarmWireMats(tint) {
  _getWireDim(tint);
  _getWireLit(tint);
}

// ---------------------------------------------------------------------------

const wires = [];

// --- Wire retraction state ---
//
// When wave 2 ends, we sink all wires into the ground over 2s to match the
// compound retraction timing. This removes them from view without any hard
// pop, in sync with the silo/powerplant/turrets. After the sink completes
// we clear them from the scene entirely so they don't come back on wave 3
// restart or chapter re-entry.
let _wireRetractActive = false;
let _wireRetractT = 0;
const WIRE_RETRACT_DURATION = 2.0;
const WIRE_RETRACT_SINK = 6.0;   // units to drop — matches compound sink
let _basePowerLit = false;   // POWER zone complete — wires are dormant but visible

/**
 * Build one wire from (ax,az) to (bx,bz). The dim tube is always visible.
 * On top we layer a LIT tube scaled from 0..length to show the fill. The
 * lit tube is anchored at the powerplant end so scaling grows it toward
 * the turret end.
 */
function _buildWire(ax, az, bx, bz, tint, kind, turretIdx) {
  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.sqrt(dx * dx + dz * dz);
  if (length < 0.001) return null;

  // DIM base tube — always visible at low opacity, spans the full length.
  const dimGeo = new THREE.CylinderGeometry(
    WIRE_RADIUS_DIM, WIRE_RADIUS_DIM, length,
    WIRE_RADIAL_SEGMENTS, 1, false,
  );
  const dimTube = new THREE.Mesh(dimGeo, _getWireDim(tint));
  // Position halfway along the wire, rotated into the XZ plane.
  const midX = (ax + bx) / 2;
  const midZ = (az + bz) / 2;
  dimTube.position.set(midX, WIRE_HEIGHT, midZ);
  dimTube.rotation.z = Math.PI / 2;
  dimTube.rotation.y = -Math.atan2(dz, dx);
  scene.add(dimTube);

  // LIT fill tube — unit length, scaled on Y to represent fill progress.
  // Unit length so `scale.y = frac * length` gives the right world length.
  // We anchor the tube at the powerplant end by offsetting its pivot
  // along the local Y axis (cylinder's Y is its length axis before we
  // rotate it flat into XZ).
  const litGeo = new THREE.CylinderGeometry(
    WIRE_RADIUS_LIT, WIRE_RADIUS_LIT, 1,
    WIRE_RADIAL_SEGMENTS, 1, false,
  );
  // Shift vertices so the cylinder grows from y=0 up to y=1 instead of
  // y=-0.5..+0.5. This makes the A-end the pivot.
  litGeo.translate(0, 0.5, 0);
  const litTube = new THREE.Mesh(litGeo, _getWireLit(tint));
  // Position at A end (powerplant), rotated along the wire direction.
  litTube.position.set(ax, WIRE_HEIGHT, az);
  litTube.rotation.z = Math.PI / 2;
  litTube.rotation.y = -Math.atan2(dz, dx);
  // Start empty — will be scaled each frame based on charge.
  litTube.scale.y = 0.0001;
  litTube.visible = false;
  scene.add(litTube);

  return {
    ax, az, bx, bz, length,
    dimTube, litTube, tint,
    kind,              // 'turret' | 'silo'
    turretIdx,         // 0/1/2 for turret wires, -1 for the silo wire
    charge: 0,         // 0..1 — current fill fraction
    locked: false,     // true once the zone completes; stays at full
  };
}

/**
 * Build all 4 wires for the current chapter: powerplant→turret0/1/2 and
 * powerplant→silo.
 */
export function buildWires(chapterIdx) {
  clearWires();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  const pp = LAYOUT.powerplant;

  for (let i = 0; i < LAYOUT.turrets.length; i++) {
    const t = LAYOUT.turrets[i];
    const w = _buildWire(pp.x, pp.z, t.x, t.z, tint, 'turret', i);
    if (w) wires.push(w);
  }
  const ws = _buildWire(pp.x, pp.z, LAYOUT.silo.x, LAYOUT.silo.z, tint, 'silo', -1);
  if (ws) wires.push(ws);
}

export function clearWires() {
  for (const w of wires) {
    if (w.dimTube && w.dimTube.parent) scene.remove(w.dimTube);
    if (w.litTube && w.litTube.parent) scene.remove(w.litTube);
    if (w.litTube && w.litTube.geometry) w.litTube.geometry.dispose();
  }
  wires.length = 0;
  _basePowerLit = false;
}

/**
 * Called when POWER completes. Flips the dim tubes to a slightly brighter
 * state (barely perceptible — the real "filling" is still per-wire). The
 * SILO wire lights fully immediately since there's no zone for it.
 */
export function setWiresLit(isLit) {
  _basePowerLit = !!isLit;
  for (const w of wires) {
    if (w.kind === 'silo') {
      // Silo wire lights up the moment POWER is restored — there's no
      // staged zone for it. Lock it to "complete" from here on.
      w.charge = isLit ? 1 : 0;
      w.locked = isLit;
      w.litTube.visible = isLit;
      w.litTube.scale.y = isLit ? w.length : 0.0001;
    }
  }
}

/**
 * Set a turret wire's charge fraction (0..1). Called every frame from the
 * power-up wave update when a turret zone is progressing (or draining).
 * Safe no-op for locked wires.
 */
export function setWireCharge(turretIdx, frac) {
  for (const w of wires) {
    if (w.kind !== 'turret') continue;
    if (w.turretIdx !== turretIdx) continue;
    if (w.locked) return;
    w.charge = Math.max(0, Math.min(1, frac));
    const len = w.charge * w.length;
    w.litTube.scale.y = Math.max(0.0001, len);
    w.litTube.visible = w.charge > 0.001;
    return;
  }
}

/**
 * Lock a turret wire to fully-lit. Called when the corresponding zone
 * completes. The wire stays fully bright for the rest of the wave — a
 * permanent "turret powered" telegraph. Drain logic won't run on it.
 */
export function setWireComplete(turretIdx) {
  for (const w of wires) {
    if (w.kind !== 'turret') continue;
    if (w.turretIdx !== turretIdx) continue;
    w.charge = 1;
    w.locked = true;
    w.litTube.scale.y = w.length;
    w.litTube.visible = true;
    return;
  }
}

/** Reset every wire back to dormant (called from the EMP teardown path). */
export function resetWireAnimations() {
  for (const w of wires) {
    w.charge = 0;
    w.locked = false;
    w.litTube.scale.y = 0.0001;
    w.litTube.visible = false;
  }
  _basePowerLit = false;
}

/**
 * Begin sinking every wire into the ground over WIRE_RETRACT_DURATION.
 * Called from waves.js at the end of wave 2 so wires disappear in sync
 * with the compound retraction. When the sink completes, wires are
 * removed from the scene — call buildWires() again before the next
 * wave 2 if you need them back.
 *
 * Idempotent — double-calls just reset the timer.
 */
export function startWireRetraction() {
  _wireRetractActive = true;
  _wireRetractT = 0;
}

/**
 * Per-frame pulse on the lit portion of each wire. Currently just drives
 * a subtle opacity breathe so filled wires don't look static. Keeps the
 * shared material so all wires breathe in unison — much calmer than the
 * old per-sphere pulse-train chaos.
 */
export function updateWires(dt, time) {
  // --- Retraction tick ---
  // Runs alongside the normal breathe, but takes over whenever active. At
  // f=1 we wipe the wires from the scene so the game doesn't have to
  // remember they're there for the remainder of the chapter.
  if (_wireRetractActive) {
    _wireRetractT = Math.min(WIRE_RETRACT_DURATION, _wireRetractT + dt);
    const f = _wireRetractT / WIRE_RETRACT_DURATION;
    const eased = f * f;  // ease-in matches the compound's ease-in
    // Sink FROM the wires' original WIRE_HEIGHT offset, not from 0.
    // Previously we wrote `sinkY = -eased * WIRE_RETRACT_SINK` directly
    // to position.y, which had the side effect of teleporting wires from
    // y=0.8 to y=0 on retraction start (visible single-frame jump) before
    // continuing down. Now we lerp from WIRE_HEIGHT down to
    // WIRE_HEIGHT - WIRE_RETRACT_SINK, so the motion starts from the
    // rest position and smoothly descends.
    const sinkY = WIRE_HEIGHT - eased * WIRE_RETRACT_SINK;
    for (const w of wires) {
      if (w.dimTube) w.dimTube.position.y = sinkY;
      if (w.litTube) w.litTube.position.y = sinkY;
    }
    if (f >= 1) {
      _wireRetractActive = false;
      // Remove everything from the scene; they'll be rebuilt next chapter.
      clearWires();
    }
    return;  // skip the normal breathe while retracting
  }
  if (!_basePowerLit || wires.length === 0) return;
  const breathe = 0.75 + 0.25 * Math.sin(time * 3.5);
  for (const w of wires) {
    if (!w.litTube.visible) continue;
    // Locked wires breathe slightly; charging wires breathe a bit stronger
    // so the player's eye tracks the active one.
    const mat = w.litTube.material;
    if (mat && mat.opacity !== undefined) {
      mat.opacity = w.locked ? (0.85 + 0.10 * Math.sin(time * 2.0)) : breathe;
    }
  }
}
