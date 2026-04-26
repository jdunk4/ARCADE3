// serverWarehouse.js — Chapter 2 wave 2 prop. Replaces the missile
// silo with a large rectangular server warehouse. The front face has
// a 4x8 grid of small lit squares that come online progressively as
// the player charges the system. After full power: a laser charges
// (telegraph) then fires (sky-to-floor pillar of red light) covering
// the entire arena EXCEPT a small safe-pod radius. Anything outside
// the pod takes massive damage.
//
// Visual:
//   - Warehouse body — flat-roofed rectangular building, dark with
//     chapter-tinted accent strip running around the top
//   - Front face — large recessed panel with a 4x8 grid of small
//     emissive squares (the "system online" indicator). Squares dark
//     when offline; light up chapter-tinted as setSystemOnline(t) climbs.
//   - Roof — flat with a few antennae + a beacon
//   - Side windows — long horizontal strips with chapter-tinted glow
//
// Laser blast:
//   - 3s telegraph: red pillar grows in opacity from 0 → 0.4
//   - 1s blast: red pillar at full intensity + big shake + electric
//     crackle SFX
//   - Pillar is a tall cylinder mesh covering the entire arena except
//     a circular cutout at the safety pod (radius 6u). For simplicity
//     we render as one big cylinder — the safety pod's own bright
//     dome visually "carves out" its own safe zone.
//
// Public API:
//   spawnServerWarehouse(chapterIdx)
//   setSystemOnline(t)        // 0..1 grid fill
//   triggerLaserBlast()       // returns total duration in seconds
//   updateServerWarehouse(dt)
//   getChargingZonePos()      // {x, z} where player charges
//   isLaserActive()
//   isLaserBlasting()         // true during the lethal 1s phase
//   clearServerWarehouse()
//   hasServerWarehouse()

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { shake } from './state.js';
import { LAYOUT } from './waveProps.js';

// ---- Tunables ----
const LASER_TELEGRAPH_DURATION = 3.0;
const LASER_BLAST_DURATION = 1.0;
const TOTAL_LASER_DURATION = LASER_TELEGRAPH_DURATION + LASER_BLAST_DURATION;
const ARENA_HALF = 50;          // arena half-extent
const LASER_HEIGHT = 80;        // sky pillar height

// ---- Geometry ----
const BODY_GEO        = new THREE.BoxGeometry(8.0, 4.0, 6.0);
const ROOF_GEO        = new THREE.BoxGeometry(8.4, 0.4, 6.4);
const FRONT_PANEL_GEO = new THREE.PlaneGeometry(6.0, 2.4);
const SQUARE_GEO      = new THREE.PlaneGeometry(0.55, 0.45);
const SIDE_WIN_GEO    = new THREE.PlaneGeometry(5.4, 0.5);
const ANTENNA_GEO     = new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6);
const BEACON_GEO      = new THREE.SphereGeometry(0.18, 10, 8);

// Laser pillar — a cylinder so big it fills the visible arena. It's
// rendered with double-sided additive blending so it reads as a
// glowing column of light from above.
const LASER_GEO = new THREE.CylinderGeometry(ARENA_HALF * 1.5, ARENA_HALF * 1.5, LASER_HEIGHT, 32, 1, true);

// ---- Materials ----
function _bodyMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: 0x4a4f58, roughness: 0.55, metalness: 0.6,
    emissive: tint, emissiveIntensity: 0.35,
  });
}
function _roofMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: 0x383c44, roughness: 0.7, metalness: 0.3,
    emissive: tint, emissiveIntensity: 0.18,
  });
}
function _frontPanelMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: 0x1a2030, roughness: 0.5, metalness: 0.4,
    emissive: tint, emissiveIntensity: 0.35,
  });
}
function _squareDimMat() {
  return new THREE.MeshBasicMaterial({
    color: 0x444a58, transparent: true, opacity: 0.6,
    side: THREE.DoubleSide, depthWrite: false,
  });
}
function _squareLitMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 1.0,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}
function _windowMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
function _antennaMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x4a4d56, roughness: 0.5, metalness: 0.7,
  });
}
function _beaconMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, toneMapped: false,
  });
}
function _laserMat() {
  return new THREE.MeshBasicMaterial({
    color: 0xff2030, transparent: true, opacity: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ---- Module state ----
let _warehouse = null;

const GRID_COLS = 8;
const GRID_ROWS = 4;
const GRID_TOTAL = GRID_COLS * GRID_ROWS;

/** Build the warehouse at LAYOUT.silo position. Returns the warehouse
 *  state object. */
export function spawnServerWarehouse(chapterIdx) {
  if (_warehouse) clearServerWarehouse();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  const group = new THREE.Group();
  group.position.set(LAYOUT.silo.x, 0, LAYOUT.silo.z);

  // Orient so the front face points toward the arena origin (back of
  // arena). We want the front grid visible to the player who walks up.
  // Calculate yaw to face origin.
  const dx = -LAYOUT.silo.x;
  const dz = -LAYOUT.silo.z;
  if (Math.abs(dx) + Math.abs(dz) > 0.001) {
    group.rotation.y = Math.atan2(dx, dz);
  }

  // --- Body ---
  const body = new THREE.Mesh(BODY_GEO, _bodyMat(tint));
  body.position.y = 2.0;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // --- Roof slab ---
  const roof = new THREE.Mesh(ROOF_GEO, _roofMat(tint));
  roof.position.y = 4.2;
  roof.castShadow = true;
  group.add(roof);

  // --- Front recessed panel (where the grid lights live) ---
  const frontPanel = new THREE.Mesh(FRONT_PANEL_GEO, _frontPanelMat(tint));
  frontPanel.position.set(0, 2.2, 3.005);    // just in front of body's +Z face
  group.add(frontPanel);

  // --- 4x8 grid of indicator squares ---
  // Squares span ~5.6u wide x ~2.0u tall on the front panel.
  const squares = [];
  const totalW = 5.6;
  const totalH = 2.0;
  const colSpacing = totalW / GRID_COLS;
  const rowSpacing = totalH / GRID_ROWS;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const dimMat = _squareDimMat();
      const sq = new THREE.Mesh(SQUARE_GEO, dimMat);
      sq.position.set(
        -totalW * 0.5 + colSpacing * (c + 0.5),
        2.2 - totalH * 0.5 + rowSpacing * (r + 0.5),
        3.015,         // sit JUST in front of the panel
      );
      group.add(sq);
      squares.push({ mesh: sq, dimMat, lit: false, litMat: null });
    }
  }

  // --- Side windows (long horizontal strips for visual interest) ---
  const winL = new THREE.Mesh(SIDE_WIN_GEO, _windowMat(tint));
  winL.position.set(4.005, 2.6, 0);
  winL.rotation.y = Math.PI / 2;
  group.add(winL);
  const winR = new THREE.Mesh(SIDE_WIN_GEO, _windowMat(tint));
  winR.position.set(-4.005, 2.6, 0);
  winR.rotation.y = -Math.PI / 2;
  group.add(winR);

  // Lower side windows (smaller strip for layered detail)
  const winL2 = new THREE.Mesh(SIDE_WIN_GEO, _windowMat(tint));
  winL2.scale.y = 0.35;
  winL2.position.set(4.005, 1.4, 0);
  winL2.rotation.y = Math.PI / 2;
  group.add(winL2);
  const winR2 = new THREE.Mesh(SIDE_WIN_GEO, _windowMat(tint));
  winR2.scale.y = 0.35;
  winR2.position.set(-4.005, 1.4, 0);
  winR2.rotation.y = -Math.PI / 2;
  group.add(winR2);

  // Chapter-tinted ROOF-LINE accent strip running around the body just
  // beneath the roof. Bright additive ring so the warehouse silhouette
  // pops at any angle.
  const trimMat = new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.95,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  // Front edge of body (along Z = 3, height = 3.85)
  const trimFront = new THREE.Mesh(new THREE.BoxGeometry(8.05, 0.18, 0.05), trimMat);
  trimFront.position.set(0, 3.85, 3.005);
  group.add(trimFront);
  // Back edge of body
  const trimBack = new THREE.Mesh(new THREE.BoxGeometry(8.05, 0.18, 0.05), trimMat);
  trimBack.position.set(0, 3.85, -3.005);
  group.add(trimBack);
  // Left edge
  const trimLeft = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 6.05), trimMat);
  trimLeft.position.set(-4.005, 3.85, 0);
  group.add(trimLeft);
  // Right edge
  const trimRight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 6.05), trimMat);
  trimRight.position.set(4.005, 3.85, 0);
  group.add(trimRight);

  // Bottom edge accent — short tinted skirt around the base of the body
  const skirtMat = new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const skirtFront = new THREE.Mesh(new THREE.BoxGeometry(8.05, 0.10, 0.04), skirtMat);
  skirtFront.position.set(0, 0.15, 3.005);
  group.add(skirtFront);
  const skirtBack = new THREE.Mesh(new THREE.BoxGeometry(8.05, 0.10, 0.04), skirtMat);
  skirtBack.position.set(0, 0.15, -3.005);
  group.add(skirtBack);
  const skirtLeft = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.10, 6.05), skirtMat);
  skirtLeft.position.set(-4.005, 0.15, 0);
  group.add(skirtLeft);
  const skirtRight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.10, 6.05), skirtMat);
  skirtRight.position.set(4.005, 0.15, 0);
  group.add(skirtRight);

  // --- Antennae + beacon on roof ---
  const ant1 = new THREE.Mesh(ANTENNA_GEO, _antennaMat());
  ant1.position.set(2.5, 4.4 + 0.7, 0);
  group.add(ant1);
  const ant2 = new THREE.Mesh(ANTENNA_GEO, _antennaMat());
  ant2.position.set(-2.5, 4.4 + 0.7, 0);
  group.add(ant2);
  const beacon = new THREE.Mesh(BEACON_GEO, _beaconMat(tint));
  beacon.position.set(0, 4.4 + 0.4, 0);
  group.add(beacon);

  // --- Laser pillar (separate group, scene-level, not parented to warehouse) ---
  // Pillar covers the entire arena. We render it scene-wide (not as a
  // child of the warehouse) so its position doesn't track the
  // warehouse's local transform.
  const laserMat = _laserMat();
  const laser = new THREE.Mesh(LASER_GEO, laserMat);
  laser.position.set(0, LASER_HEIGHT * 0.5, 0);     // centered at arena
  laser.visible = false;
  scene.add(laser);

  scene.add(group);

  // Charging zone position — in the same wedge as the warehouse, but
  // offset slightly toward the arena center so the player approaches
  // the warehouse face naturally.
  const chargeZoneX = LAYOUT.silo.x * 0.6;
  const chargeZoneZ = LAYOUT.silo.z * 0.6;

  // --- VISIBLE CHARGING ZONE DISC (scene-level, separate group) ---
  // Outer ring + inner fill disc that grows with charge progress.
  // Hidden by default. waves.js drives via setChargeZoneVisible +
  // setChargeZoneProgress(t).
  const chargeZoneGroup = new THREE.Group();
  chargeZoneGroup.position.set(chargeZoneX, 0.05, chargeZoneZ);
  chargeZoneGroup.visible = false;
  // Outer ring — chapter-tinted, additive, pulses
  const czRingGeo = new THREE.RingGeometry(3.2, 3.5, 48);
  const czRingMat = new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const czRing = new THREE.Mesh(czRingGeo, czRingMat);
  czRing.rotation.x = -Math.PI / 2;
  chargeZoneGroup.add(czRing);
  // Inner fill disc — grows with progress
  const czFillGeo = new THREE.CircleGeometry(3.0, 48);
  const czFillMat = new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.35,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const czFill = new THREE.Mesh(czFillGeo, czFillMat);
  czFill.rotation.x = -Math.PI / 2;
  czFill.position.y = 0.005;
  czFill.scale.setScalar(0.0);             // start empty
  chargeZoneGroup.add(czFill);
  // Center "stand here" beacon — small bright dot that bobs vertically
  const czBeaconGeo = new THREE.SphereGeometry(0.18, 12, 10);
  const czBeaconMat = new THREE.MeshBasicMaterial({ color: tint, toneMapped: false });
  const czBeacon = new THREE.Mesh(czBeaconGeo, czBeaconMat);
  czBeacon.position.y = 0.6;
  chargeZoneGroup.add(czBeacon);
  scene.add(chargeZoneGroup);

  _warehouse = {
    group, body, roof, frontPanel, beacon, tint,
    squares,
    laser, laserMat,
    laserPhase: 'idle',          // 'idle' | 'telegraph' | 'blast' | 'cooldown'
    laserT: 0,
    systemOnline: 0,             // 0..1 - drives grid fill
    chargeZoneX, chargeZoneZ,
    chargeZoneGroup, czRingMat, czFillMat, czFill, czBeacon,
    chargeZoneT: 0,              // pulse timer
    pulseT: 0,
  };
  return _warehouse;
}

/** Show/hide the charging zone visual disc. */
export function setChargeZoneVisible(v) {
  if (!_warehouse) return;
  _warehouse.chargeZoneGroup.visible = !!v;
}

/** Drive the charging zone fill (0..1). Inner disc scales with progress. */
export function setChargeZoneProgress(t) {
  if (!_warehouse) return;
  const f = Math.max(0, Math.min(1, t));
  if (_warehouse.czFill) {
    _warehouse.czFill.scale.setScalar(f);
  }
}

/** Set system-online progress (0..1). Drives the grid fill: as t
 *  climbs, more squares light up chapter-tinted. */
export function setSystemOnline(t) {
  if (!_warehouse) return;
  _warehouse.systemOnline = Math.max(0, Math.min(1, t));
  const litCount = Math.round(_warehouse.systemOnline * GRID_TOTAL);
  for (let i = 0; i < _warehouse.squares.length; i++) {
    const sq = _warehouse.squares[i];
    const shouldLight = i < litCount;
    if (shouldLight && !sq.lit) {
      // Swap to lit material
      if (!sq.litMat) sq.litMat = _squareLitMat(_warehouse.tint);
      sq.mesh.material = sq.litMat;
      sq.lit = true;
    } else if (!shouldLight && sq.lit) {
      sq.mesh.material = sq.dimMat;
      sq.lit = false;
    }
  }
}

/** Trigger the laser blast. Telegraph for 3s then fire for 1s.
 *  Returns total duration in seconds. */
export function triggerLaserBlast() {
  if (!_warehouse) return 0;
  if (_warehouse.laserPhase !== 'idle') return TOTAL_LASER_DURATION;
  _warehouse.laserPhase = 'telegraph';
  _warehouse.laserT = 0;
  _warehouse.laser.visible = true;
  return TOTAL_LASER_DURATION;
}

/** True during the lethal 1s blast phase. Outside-pod entities
 *  should take damage / die during this phase. */
export function isLaserBlasting() {
  return !!(_warehouse && _warehouse.laserPhase === 'blast');
}

/** True for the entire telegraph + blast period. Useful for HUD. */
export function isLaserActive() {
  if (!_warehouse) return false;
  return _warehouse.laserPhase === 'telegraph' || _warehouse.laserPhase === 'blast';
}

/** Returns charging zone center {x, z}. */
export function getChargingZonePos() {
  if (!_warehouse) return null;
  return { x: _warehouse.chargeZoneX, z: _warehouse.chargeZoneZ };
}

/** Returns the warehouse's collision circles for the dynamic-props
 *  getter pattern. Warehouse body is ~8u wide × 6u deep, so a single
 *  circle is a poor fit. We use 2 overlapping circles offset along
 *  the warehouse's local front-back axis to approximate the rectangle.
 *  The warehouse's group rotates to face origin; we apply that rotation
 *  to put the circles at world positions matching the body. */
export function getServerCollisionCircles() {
  if (!_warehouse) return [];
  const yaw = _warehouse.group.rotation.y;
  const cx = _warehouse.group.position.x;
  const cz = _warehouse.group.position.z;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // Two circles — one toward the front (+Z local), one toward the back
  // (-Z local). Each ~3u radius. Together they cover ~7u along the
  // body axis with overlap in the middle.
  const FRONT_OFFSET = 1.6;
  const BACK_OFFSET = -1.6;
  const R = 3.2;
  // World position of front circle
  const fwx = cx + 0 * cosY + FRONT_OFFSET * sinY;
  const fwz = cz - 0 * sinY + FRONT_OFFSET * cosY;
  // World position of back circle
  const bwx = cx + 0 * cosY + BACK_OFFSET * sinY;
  const bwz = cz - 0 * sinY + BACK_OFFSET * cosY;
  return [
    { x: fwx, z: fwz, r: R },
    { x: bwx, z: bwz, r: R },
  ];
}

export function hasServerWarehouse() {
  return !!_warehouse;
}

/** Per-frame update — animate beacon pulse, laser phases, square pulses. */
export function updateServerWarehouse(dt) {
  if (!_warehouse) return;
  _warehouse.pulseT += dt * 2.0;
  _warehouse.chargeZoneT = (_warehouse.chargeZoneT || 0) + dt * 3.0;

  // Animate charging zone — pulse the ring + bob the beacon
  if (_warehouse.chargeZoneGroup && _warehouse.chargeZoneGroup.visible) {
    const pulse = 0.5 + 0.5 * Math.sin(_warehouse.chargeZoneT);
    if (_warehouse.czRingMat) _warehouse.czRingMat.opacity = 0.65 + pulse * 0.30;
    if (_warehouse.czBeacon) _warehouse.czBeacon.position.y = 0.6 + pulse * 0.25;
    if (_warehouse.czFillMat) _warehouse.czFillMat.opacity = 0.30 + pulse * 0.25;
  }

  // Beacon emissive pulse
  if (_warehouse.beacon && _warehouse.beacon.material) {
    // BasicMaterial doesn't have emissive — use color brightness via
    // a clamped scaling of the existing color.
    // Simpler: leave beacon alone visually, the additive material is bright.
  }

  // Lit squares pulse subtly so the "online" state reads as alive
  if (_warehouse.systemOnline > 0) {
    const pulseScale = 0.85 + 0.15 * Math.sin(_warehouse.pulseT * 1.7);
    for (const sq of _warehouse.squares) {
      if (sq.lit && sq.litMat) {
        sq.litMat.opacity = pulseScale;
      }
    }
  }

  // Laser phase machine
  if (_warehouse.laserPhase === 'telegraph') {
    _warehouse.laserT += dt;
    const f = Math.min(1, _warehouse.laserT / LASER_TELEGRAPH_DURATION);
    // Pillar opacity ramps from 0 → 0.4 — visible warning
    _warehouse.laserMat.opacity = f * 0.4;
    // Slight pulse on top of the ramp for telegraph urgency
    _warehouse.laserMat.opacity += Math.sin(_warehouse.laserT * 14) * 0.08;
    if (_warehouse.laserT >= LASER_TELEGRAPH_DURATION) {
      _warehouse.laserPhase = 'blast';
      _warehouse.laserT = 0;
      _warehouse.laserMat.opacity = 0.95;
      shake(2.0, 1.0);
    }
  } else if (_warehouse.laserPhase === 'blast') {
    _warehouse.laserT += dt;
    // Solid intense red for 1s
    _warehouse.laserMat.opacity = 0.85 + 0.15 * Math.sin(_warehouse.laserT * 30);
    if (_warehouse.laserT >= LASER_BLAST_DURATION) {
      _warehouse.laserPhase = 'cooldown';
      _warehouse.laserT = 0;
    }
  } else if (_warehouse.laserPhase === 'cooldown') {
    _warehouse.laserT += dt;
    const f = Math.min(1, _warehouse.laserT / 0.6);
    _warehouse.laserMat.opacity = 0.95 * (1 - f);
    if (f >= 1) {
      _warehouse.laser.visible = false;
      _warehouse.laserPhase = 'idle';
      _warehouse.laserMat.opacity = 0;
    }
  }
}

export function clearServerWarehouse() {
  if (!_warehouse) return;
  if (_warehouse.group && _warehouse.group.parent) scene.remove(_warehouse.group);
  if (_warehouse.chargeZoneGroup && _warehouse.chargeZoneGroup.parent) scene.remove(_warehouse.chargeZoneGroup);
  if (_warehouse.laser && _warehouse.laser.parent) scene.remove(_warehouse.laser);
  if (_warehouse.laserMat && _warehouse.laserMat.dispose) _warehouse.laserMat.dispose();
  for (const sq of _warehouse.squares) {
    if (sq.dimMat && sq.dimMat.dispose) sq.dimMat.dispose();
    if (sq.litMat && sq.litMat.dispose) sq.litMat.dispose();
  }
  _warehouse = null;
}
