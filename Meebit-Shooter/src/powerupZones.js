// ============================================================================
// src/powerupZones.js — the 5 stand-in-zone objectives for wave 2.
//
// Flow:
//   1. POWER       — restore main power
//   2. TURRETS_A   — bring turret 0 online
//   3. TURRETS_B   — bring turrets 1 + 2 online
//   4. RADIO       — establish comms (no mechanical effect yet, just story)
//   5. EMP         — launch the EMP missile
//
// Each zone is a flat disk on the floor. Only the currently-active zone
// is "lit" (bright emissive + taller pillar beam + progress arc fill).
// All other zones are dim props — still visible so the player knows what's
// coming, but non-interactable.
//
// The player stands inside the active zone's radius to fill a hold timer.
// When the timer reaches the target, the zone "completes" (sparks, zone
// dims, next zone lights up).
//
// The module owns no wave-end logic — it reports completion of each zone
// to waves.js, which handles turret activation and the EMP fire.
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS, ARENA } from './config.js';
import { hitBurst } from './effects.js';
import { LAYOUT } from './waveProps.js';

// Zones in completion order. Each one sits DIRECTLY ON TOP of the prop
// it energizes. Positions MUST be read fresh on each spawn because
// LAYOUT mutates per chapter (triangulation system re-assigns the
// power-up compound to a different arena triangle each run).
//
// Stage-based zone progression:
//   Stage 0  POWER           — single zone on the powerplant
//   Stage 1  TURRETS_A/B/C   — three zones, all visible at once, any order
//   Stage 2  RADIO           — single zone on the radio tower
//   Stage 3  LAUNCH          — single zone at the base of the missile
//
// Each stage's zones spawn when the stage activates. Previous stage's
// zones tear down when all its zones complete. Zones from later stages
// don't exist yet until the prior stage finishes.
//
// This function is called fresh each time a new stage needs zones built;
// LAYOUT is read live so triangulation takes effect.
function _defsForStage(stageIdx) {
  switch (stageIdx) {
    case 0:
      return [
        { id: 'POWER', label: 'RESTORE POWER',
          x: LAYOUT.powerplant.x, z: LAYOUT.powerplant.z, turretIdx: -1 },
      ];
    case 1:
      return [
        { id: 'TURRETS_A', label: 'LOAD TURRET A',
          x: LAYOUT.turrets[0].x, z: LAYOUT.turrets[0].z, turretIdx: 0 },
        { id: 'TURRETS_B', label: 'LOAD TURRET B',
          x: LAYOUT.turrets[1].x, z: LAYOUT.turrets[1].z, turretIdx: 1 },
        { id: 'TURRETS_C', label: 'LOAD TURRET C',
          x: LAYOUT.turrets[2].x, z: LAYOUT.turrets[2].z, turretIdx: 2 },
      ];
    case 2:
      return [
        { id: 'RADIO', label: 'ESTABLISH RADIO COMMS',
          x: LAYOUT.radioTower.x, z: LAYOUT.radioTower.z, turretIdx: -1 },
      ];
    case 3:
      return [
        // Launch pad sits ON the silo at ground level so the player can
        // physically stand under the raised missile. The zone is OVERSIZED
        // (radius 6.0) so it reaches to the inner edge of the 3 turrets
        // (which sit 6u from the silo). Hold time is 4x the normal zones —
        // the launch is the big climactic commitment.
        { id: 'LAUNCH', label: 'LAUNCH EMP MISSILE',
          x: LAYOUT.silo.x, z: LAYOUT.silo.z, turretIdx: -1,
          radius: 6.0, holdTime: 14.0, isLaunch: true },
      ];
    default:
      return [];
  }
}

// Total number of stages the player completes during wave 2. Used by the
// HUD "STEP N/M" progress readout.
const STAGE_COUNT = 4;

// Zone tuning.
const ZONE_CFG = {
  radius: 3.0,                      // units — player is "in" the zone inside this
  radiusSq: 3.0 * 3.0,
  holdTime: 3.5,                    // seconds to complete each zone
  pulseHzDormant: 0.4,              // slow pulse when dim
  pulseHzActive: 1.8,               // fast pulse when lit
};

// ---------------------------------------------------------------------------
// SHARED GEO + MATERIALS
// ---------------------------------------------------------------------------
const DISK_GEO = new THREE.CircleGeometry(ZONE_CFG.radius, 32);
const RING_GEO = new THREE.RingGeometry(ZONE_CFG.radius * 0.95, ZONE_CFG.radius, 48);
// Skinnier beam than the original (was 0.25 top / 0.5 bottom). Still
// reads as a pillar of light from across the map, but doesn't block the
// player's view of whatever they're charging up (turret, silo missile,
// radio tower, etc.). Cut to ~1/3 of the original.
const BEAM_GEO = new THREE.CylinderGeometry(0.08, 0.16, 10, 8, 1, true);

const _diskDormantMatCache = new Map();
const _diskActiveMatCache = new Map();
const _ringMatCache = new Map();
const _beamDormantMatCache = new Map();
const _beamActiveMatCache = new Map();

// CHARGING COLOR — universal "energy / charging" cue, independent of the
// chapter palette so the player reads "you are actively charging this"
// instantly. Electric cyan pops against every chapter background.
const CHARGING_COLOR = 0x4ff7ff;
// Secondary "hot" color used in the pulsing core when charging — warm
// bright amber/white for the "about to tip over" read.
const CHARGING_CORE_COLOR = 0xfff08a;

let _diskChargingMat = null;
let _outlineChargingMat = null;
let _beamChargingMat = null;
function _getDiskChargingMat() {
  if (!_diskChargingMat) {
    _diskChargingMat = new THREE.MeshBasicMaterial({
      color: CHARGING_COLOR, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    });
  }
  return _diskChargingMat;
}
function _getOutlineChargingMat() {
  if (!_outlineChargingMat) {
    _outlineChargingMat = new THREE.MeshBasicMaterial({
      color: CHARGING_COLOR, transparent: true, opacity: 1.0, side: THREE.DoubleSide,
    });
  }
  return _outlineChargingMat;
}
function _getBeamChargingMat() {
  if (!_beamChargingMat) {
    _beamChargingMat = new THREE.MeshBasicMaterial({
      color: CHARGING_COLOR, transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthWrite: false,
    });
  }
  return _beamChargingMat;
}

function _getDiskDormantMat(tint) {
  let m = _diskDormantMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
    });
    _diskDormantMatCache.set(tint, m);
  }
  return m;
}
function _getDiskActiveMat(tint) {
  let m = _diskActiveMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    });
    _diskActiveMatCache.set(tint, m);
  }
  return m;
}
function _getRingMat(tint) {
  let m = _ringMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 1.0, side: THREE.DoubleSide,
    });
    _ringMatCache.set(tint, m);
  }
  return m;
}
function _getBeamDormantMat(tint) {
  let m = _beamDormantMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.25,
      side: THREE.DoubleSide, depthWrite: false,
    });
    _beamDormantMatCache.set(tint, m);
  }
  return m;
}
function _getBeamActiveMat(tint) {
  let m = _beamActiveMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    });
    _beamActiveMatCache.set(tint, m);
  }
  return m;
}

/** Pre-build each chapter's materials so the wave-2 start doesn't stall. */
export function prewarmPowerupMats(tint) {
  _getDiskDormantMat(tint);
  _getDiskActiveMat(tint);
  _getRingMat(tint);
  _getBeamDormantMat(tint);
  _getBeamActiveMat(tint);
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

// Zone objects built at chapter start — visible props in every wave even
// though they only accept charge in wave 2.
const zones = [];

export function getZones() { return zones; }

// Staged progression state.
//   stageIdx     — which stage is currently active (0..STAGE_COUNT-1). -1 = not running.
//   chapterIdx   — cached so we can rebuild zones at stage transitions without the caller re-passing.
//   stageTint    — the chapter-tinted color used for zone materials.
let stageIdx = -1;
let chapterIdx = 0;
let stageTint = 0xffffff;

// Per-zone progress while the player is standing on it. With parallel
// turret zones, each zone has its own .progress field stored on the zone
// object directly (see _buildZone). No single "activeProgress" anymore.

/**
 * Clear any existing zones. Called from dormantProps.teardownChapter
 * and as the first step inside every state-machine transition.
 * Does NOT change stageIdx — callers that want to restart the progression
 * must call startPowerupWave() after.
 */
export function spawnPowerupZones(chapterIdxArg) {
  clearPowerupZones();
  chapterIdx = chapterIdxArg;
  stageTint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  // Intentionally empty — zones spawn stage-by-stage via _buildStage().
}

export function clearPowerupZones() {
  for (const z of zones) {
    if (z.obj && z.obj.parent) scene.remove(z.obj);
  }
  zones.length = 0;
  stageIdx = -1;
}

/**
 * Start wave 2. Kicks off stage 0 (POWER zone).
 */
export function startPowerupWave() {
  stageIdx = 0;
  _buildStage(0);
}

/** Called when wave 2 ends (EMP fired). Dims every zone and clears. */
export function endPowerupWave() {
  stageIdx = -1;
  for (const z of zones) {
    if (z.active) _dimZone(z);
  }
  clearPowerupZones();
}

/**
 * Build the N zones for the given stage, auto-light them all, and append
 * to the `zones` array. Does NOT tear down prior stage's zones — callers
 * handle that because the "zone just completed" handler wants to burst
 * effects at the old position before the mesh vanishes.
 */
function _buildStage(stageIdxArg) {
  const defs = _defsForStage(stageIdxArg);
  for (let i = 0; i < defs.length; i++) {
    const z = _buildZone(zones.length, defs[i], stageTint);
    zones.push(z);
    // All zones in a stage auto-activate (unlike the old model where
    // only zone 0 lit and the rest stayed dim until their turn).
    _lightZone(zones.length - 1);
  }
}

// ---------------------------------------------------------------------------
// ZONE BUILDER
// ---------------------------------------------------------------------------

function _buildZone(idx, def, tint) {
  // Per-zone radius + holdTime overrides (see _defsForStage). Falls back to
  // the global ZONE_CFG defaults. Oversized zones (the launch zone) rebuild
  // their disk + outline geometry locally.
  const zoneR = typeof def.radius === 'number' ? def.radius : ZONE_CFG.radius;
  const zoneHold = typeof def.holdTime === 'number' ? def.holdTime : ZONE_CFG.holdTime;
  const isLaunch = !!def.isLaunch;

  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);

  // Disk — shared geometry for default-radius zones (cheap cache); custom
  // geometry for oversized zones (the launch zone). The per-zone geometry
  // is disposed in _tearDownStage.
  const diskGeo = (zoneR === ZONE_CFG.radius) ? DISK_GEO : new THREE.CircleGeometry(zoneR, 48);
  const disk = new THREE.Mesh(diskGeo, _getDiskDormantMat(tint));
  disk.rotation.x = -Math.PI / 2;
  disk.position.y = 0.04;
  group.add(disk);

  // Progress arc — a thin ring on top of the disk. We build it as a
  // RingGeometry with a custom thetaLength that we tween on update.
  // Starts at zero length (0 rads) so it's invisible until it fills.
  const progressRingGeo = new THREE.RingGeometry(
    zoneR * 0.75,
    zoneR * 0.85,
    64,
    1,
    0,
    0.0001
  );
  const progressRingMat = _getRingMat(tint).clone();
  progressRingMat.opacity = 0;
  const progressRing = new THREE.Mesh(progressRingGeo, progressRingMat);
  progressRing.rotation.x = -Math.PI / 2;
  progressRing.position.y = 0.06;
  group.add(progressRing);

  // Outer ring outline for readability.
  const outlineGeo = (zoneR === ZONE_CFG.radius)
    ? RING_GEO
    : new THREE.RingGeometry(zoneR * 0.95, zoneR, 64);
  const outline = new THREE.Mesh(outlineGeo, _getRingMat(tint));
  outline.rotation.x = -Math.PI / 2;
  outline.position.y = 0.05;
  group.add(outline);

  // Vertical pillar beam so the zone is visible from across the map.
  const beam = new THREE.Mesh(BEAM_GEO, _getBeamDormantMat(tint));
  beam.position.y = 5;
  group.add(beam);

  // --- CHARGING-STATE INDICATORS (all zones) ---
  // When the player is standing inside the zone, these meshes make it
  // UNMISTAKABLE that charging is happening. They sit invisible (opacity 0)
  // at rest and fade in immediately when `z.isCharging` flips true.
  //
  //   * chargingCore   — a bright inner disk that flashes when the player
  //                      steps on. Uses the CHARGING_CORE_COLOR (warm amber)
  //                      sitting on top of the cyan-flipped main disk.
  //                      Visual: "contact made, power flowing."
  //   * rippleRings    — three concentric torus rings expanding outward
  //                      from zone center on a 0.6s loop. Each ring is
  //                      staggered so there's always one mid-expansion.
  //   * uprightSparks  — three vertical lines at perimeter that flicker on
  //                      like contact arcs (as opacity, since line width
  //                      isn't reliably supported).
  //
  // None of these are per-stage — every zone gets them so the charging
  // feedback is consistent.
  const chargingCoreGeo = (zoneR === ZONE_CFG.radius)
    ? new THREE.CircleGeometry(zoneR * 0.55, 40)
    : new THREE.CircleGeometry(zoneR * 0.55, 48);
  const chargingCoreMat = new THREE.MeshBasicMaterial({
    color: CHARGING_CORE_COLOR, transparent: true, opacity: 0.0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const chargingCore = new THREE.Mesh(chargingCoreGeo, chargingCoreMat);
  chargingCore.rotation.x = -Math.PI / 2;
  chargingCore.position.y = 0.08;
  group.add(chargingCore);

  // Ripple rings — each has its own torus geometry sized for zoneR.
  // Per-ring material clone so opacity can tween independently. Torus
  // geometry is shared across the 3 rings in this zone — cheap.
  const rippleRings = [];
  const rippleGeo = new THREE.TorusGeometry(1.0, 0.08, 6, 40);
  const rippleMatBase = new THREE.MeshBasicMaterial({
    color: CHARGING_COLOR, transparent: true, opacity: 0.0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const rippleMats = [];  // collected for disposal
  for (let i = 0; i < 3; i++) {
    const rMat = rippleMatBase.clone();
    const r = new THREE.Mesh(rippleGeo, rMat);
    r.rotation.x = -Math.PI / 2;
    r.position.y = 0.12;
    r.scale.setScalar(0.1);
    r.userData.phaseOffset = (i / 3) * 1.0;   // staggered 0, 0.33, 0.66
    r.userData.phaseT = r.userData.phaseOffset;  // start at the stagger point
    group.add(r);
    rippleRings.push(r);
    rippleMats.push(rMat);
  }
  // Dispose the base template we cloned from — we only needed it to seed
  // the clones. Each ring now owns its own material.
  rippleMatBase.dispose();

  // --- LAUNCH ZONE PAYOFF VISUALS ---
  // Only built for the launch zone. These meshes animate with progress to
  // sell the climactic commitment the player is making:
  //   * energyColumn   — vertical bright tube that grows taller + brighter
  //                      as frac rises; represents the charge stored in the
  //                      silo
  //   * chargeOrbs     — N small orbs that orbit the zone, emissive,
  //                      tightening into a ring as charge fills
  //   * inRing / outRing — two contra-rotating wireframe rings above the pad
  //   * floorPulse     — a bright inner disk whose opacity pulses faster as
  //                      charge fills; "heartbeat" cue
  let energyColumn = null;
  let energyColumnMat = null;
  let chargeOrbs = null;
  let innerSpinRing = null, outerSpinRing = null;
  let innerSpinMat = null, outerSpinMat = null;
  let floorPulse = null;
  let floorPulseMat = null;
  if (isLaunch) {
    // Energy column — tall cylinder at zone center. Shrunk to 0 at rest.
    // Thin energy column so it doesn't block the missile silhouette. The
    // zone disk on the ground tells the player the radius; the column is
    // just the "energy routing into the missile" cue.
    const colGeo = new THREE.CylinderGeometry(0.18, 0.32, 16, 12, 1, true);
    energyColumnMat = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    energyColumn = new THREE.Mesh(colGeo, energyColumnMat);
    energyColumn.position.y = 0;                       // base at floor
    energyColumn.scale.y = 0.01;                       // invisible at start
    group.add(energyColumn);

    // Charge orbs — 6 small spheres orbiting at radius zoneR*0.75, pulled
    // inward as the charge fills.
    chargeOrbs = new THREE.Group();
    const orbGeo = new THREE.SphereGeometry(0.22, 10, 8);
    const orbMat = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.95,
    });
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(orbGeo, orbMat);
      const a = (i / 6) * Math.PI * 2;
      m.position.set(Math.cos(a) * zoneR * 0.75, 0.6, Math.sin(a) * zoneR * 0.75);
      m.userData.baseAngle = a;
      chargeOrbs.add(m);
    }
    group.add(chargeOrbs);

    // Two contra-rotating wireframe rings above the pad.
    const innerG = new THREE.RingGeometry(zoneR * 0.55, zoneR * 0.62, 32);
    const outerG = new THREE.RingGeometry(zoneR * 0.82, zoneR * 0.89, 48);
    innerSpinMat = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.0, side: THREE.DoubleSide,
    });
    outerSpinMat = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.0, side: THREE.DoubleSide,
    });
    innerSpinRing = new THREE.Mesh(innerG, innerSpinMat);
    outerSpinRing = new THREE.Mesh(outerG, outerSpinMat);
    innerSpinRing.position.y = 2.2;
    outerSpinRing.position.y = 2.2;
    innerSpinRing.rotation.x = -Math.PI / 2;
    outerSpinRing.rotation.x = -Math.PI / 2;
    group.add(innerSpinRing);
    group.add(outerSpinRing);

    // Floor pulse disk — bright inner disk on top of the zone disk.
    floorPulseMat = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.0, side: THREE.DoubleSide,
    });
    const fpGeo = new THREE.CircleGeometry(zoneR * 0.65, 48);
    floorPulse = new THREE.Mesh(fpGeo, floorPulseMat);
    floorPulse.rotation.x = -Math.PI / 2;
    floorPulse.position.y = 0.07;
    group.add(floorPulse);
  }

  scene.add(group);

  return {
    idx,
    def,
    obj: group,
    pos: group.position,
    disk,
    outline,
    beam,
    progressRing,
    progressRingMat,
    tint,
    // Per-zone config (overrides global ZONE_CFG for oversized zones).
    radius: zoneR,
    radiusSq: zoneR * zoneR,
    holdTime: zoneHold,
    isLaunch,
    // Payoff viz — only present for launch zones (null otherwise).
    energyColumn, energyColumnMat,
    chargeOrbs,
    innerSpinRing, outerSpinRing, innerSpinMat, outerSpinMat,
    floorPulse, floorPulseMat,
    lastPayoffBurstFrac: 0,     // how far we've progressed through the threshold bursts
    // Charging-state meshes (all zones). isChargingNow tracks whether the
    // player is currently standing on this zone so the material swap only
    // fires on transition frames (not every frame).
    chargingCore, chargingCoreMat, chargingCoreGeo,
    rippleRings, rippleGeo, rippleMats,
    isChargingNow: false,
    // Cache default disk/outline/beam materials so we can restore them
    // when the player leaves the zone.
    _defaultDiskMat: _getDiskActiveMat(tint),      // while active
    _defaultOutlineMat: _getRingMat(tint),
    _defaultBeamMat: _getBeamActiveMat(tint),
    // Flag so _tearDownStage disposes per-zone geometry we created.
    _ownGeoDisk: diskGeo !== DISK_GEO ? diskGeo : null,
    _ownGeoOutline: outlineGeo !== RING_GEO ? outlineGeo : null,
    active: false,
    completed: false,
    pulsePhase: Math.random() * Math.PI * 2,
  };
}

function _lightZone(idx) {
  const z = zones[idx];
  if (!z) return;
  z.active = true;
  z.disk.material = _getDiskActiveMat(z.tint);
  z.beam.material = _getBeamActiveMat(z.tint);
  z.beam.scale.y = 1.6;
  z.beam.position.y = 8;
  // Small welcome spark so the player sees the activation.
  hitBurst(new THREE.Vector3(z.pos.x, 0.2, z.pos.z), z.tint, 10);
  hitBurst(new THREE.Vector3(z.pos.x, 3.0, z.pos.z), 0xffffff, 6);
}

function _dimZone(z) {
  if (!z) return;
  z.active = false;
  z.disk.material = _getDiskDormantMat(z.tint);
  z.beam.material = _getBeamDormantMat(z.tint);
  z.beam.scale.y = 1.0;
  z.beam.position.y = 5;
}

function _completeZone(z) {
  z.completed = true;
  // Big celebration burst.
  hitBurst(new THREE.Vector3(z.pos.x, 0.3, z.pos.z), 0xffffff, 16);
  hitBurst(new THREE.Vector3(z.pos.x, 0.3, z.pos.z), z.tint, 20);
  hitBurst(new THREE.Vector3(z.pos.x, 3.0, z.pos.z), z.tint, 12);
  _dimZone(z);
  // Leave the progress ring fully filled at dim opacity as a "completed"
  // marker, so the player can visually track what's done.
  z.progressRingMat.opacity = 0.30;
  _setProgressArc(z, 1);
}

/**
 * Update the progress ring geometry to show `frac` (0..1) of a full circle.
 * We rebuild the RingGeometry each call — cheap (48 segments, one Mesh),
 * done only on the active zone so at most once per frame.
 */
function _setProgressArc(z, frac) {
  const theta = Math.max(0.0001, Math.min(1, frac)) * Math.PI * 2;
  if (z.progressRing.geometry) z.progressRing.geometry.dispose();
  z.progressRing.geometry = new THREE.RingGeometry(
    z.radius * 0.75,
    z.radius * 0.85,
    64, 1,
    -Math.PI / 2,   // start at "12 o'clock"
    theta,
  );
}

// ---------------------------------------------------------------------------
// PER-FRAME UPDATE
// ---------------------------------------------------------------------------

/**
 * Tick the power-up zones. Returns the ID of a zone that JUST completed
 * this frame, or null otherwise.
 *
 * Multi-zone stages (stage 1, the 3 turrets) are handled by giving each
 * zone its own .progress value; only the zone the player is standing on
 * accumulates. Stage 1 turrets can therefore be completed in any order.
 *
 * When a stage's zones are ALL complete, we tear them down and build
 * the next stage's zones. The STAGE transition fires after the
 * individual-zone completion return, so callers get the `completedId`
 * of the last zone in a stage on the same frame the stage advances.
 */
export function updatePowerupZones(dt, playerPos, time) {
  if (!zones.length) return null;

  // Figure out which zone (if any) the player is currently inside.
  // Uses per-zone radius so the oversized launch zone works correctly.
  let insideZone = null;
  if (playerPos) {
    for (const z of zones) {
      if (z.completed) continue;
      const dx = playerPos.x - z.pos.x;
      const dz = playerPos.z - z.pos.z;
      if (dx * dx + dz * dz < z.radiusSq) {
        insideZone = z;
        break;
      }
    }
  }

  let completedId = null;

  for (const z of zones) {
    if (z.completed) continue;
    z.pulsePhase += dt * 3;
    const pulse = 0.5 + 0.5 * Math.sin(z.pulsePhase * ZONE_CFG.pulseHzActive);
    z.beam.scale.y = 1.4 + pulse * 0.4;

    // --- CHARGING STATE MATERIAL SWAP ---
    // When the player first steps inside a zone, flip the disk + outline
    // + beam materials to the bright CHARGING_COLOR. When they step out,
    // restore the chapter-tint defaults. Only fires on transition frames
    // so material swaps don't happen every tick.
    const isCharging = (z === insideZone);
    if (isCharging !== z.isChargingNow) {
      z.isChargingNow = isCharging;
      if (isCharging) {
        z.disk.material = _getDiskChargingMat();
        z.outline.material = _getOutlineChargingMat();
        z.beam.material = _getBeamChargingMat();
      } else {
        z.disk.material = z._defaultDiskMat;
        z.outline.material = z._defaultOutlineMat;
        z.beam.material = z._defaultBeamMat;
      }
    }
    // Tick charging-state overlays (fade core in/out, expand ripples).
    _tickChargingFeedback(z, dt, isCharging, time);

    if (z === insideZone) {
      z.progress = Math.min(z.holdTime, (z.progress || 0) + dt);
    } else {
      // Launch zone drains slower than normal zones — losing a 14s charge
      // because you stepped off for a half-second would be brutal.
      const drainRate = z.isLaunch ? 0.12 : 0.5;
      z.progress = Math.max(0, (z.progress || 0) - dt * drainRate);
    }

    const frac = z.progress / z.holdTime;
    z.progressRingMat.opacity = 0.65 + pulse * 0.2;
    _setProgressArc(z, frac);

    // ---- LAUNCH ZONE VISUAL PAYOFF ----
    if (z.isLaunch) {
      _tickLaunchPayoff(z, dt, frac, pulse, time);
    }

    if (z.progress >= z.holdTime) {
      completedId = z.def.id;
      _completeZone(z);
      break;  // only one completion per frame
    }
  }

  // Stage transition — if every zone in the current stage is now done,
  // tear them all down and build the next stage's zones. This runs after
  // we've computed completedId so the caller still sees which zone id
  // finished last this frame.
  if (stageIdx >= 0 && zones.length > 0 && zones.every((z) => z.completed)) {
    // Small delay would look nicer, but keeping it synchronous for now —
    // side-effects like "TURRET A ONLINE" toasts already fire on their
    // own completion so the player has time to see each one.
    _tearDownStage();
    stageIdx++;
    if (stageIdx < STAGE_COUNT) {
      _buildStage(stageIdx);
    }
  }

  return completedId;
}

// ---------------------------------------------------------------------------
// LAUNCH-ZONE VISUAL PAYOFF
// ---------------------------------------------------------------------------
//
// The launch zone takes 4x as long to charge as the other zones. Without
// extra visual feedback that 14-second hold feels boring. This tick adds:
//   1. A vertical energy column that grows taller + brighter with frac
//   2. Orbiting charge orbs that spiral inward as frac fills
//   3. Two contra-rotating wireframe rings that speed up with frac
//   4. A floor "heartbeat" pulse that beats faster as frac rises
//   5. Discrete chapter-color bursts at 25/50/75/100% thresholds so the
//      player feels the charge hit checkpoints
//
// All these visuals are torn down when the zone completes or the stage
// rebuilds; _tearDownStage is the single exit point and already disposes
// group.children via scene.remove(group).
// ---------------------------------------------------------------------------
// CHARGING-STATE FEEDBACK (all zones)
// ---------------------------------------------------------------------------
//
// Called every frame for every zone. When `isCharging` is true the player
// is standing on this zone right now — the charging core fades in, the
// ripple rings expand + fade, and a subtle pulse modulation keeps the
// read lively. When `isCharging` is false everything fades back to 0.
//
// Per-zone material clones: chargingCoreMat + rippleMat are unique to each
// zone (not shared across zones), so independent opacity is fine.
function _tickChargingFeedback(z, dt, isCharging, time) {
  // Fade the inner "contact made" disk in/out. Holds a gentle pulse when
  // charging so the player sees the zone "breathing" with them.
  if (z.chargingCoreMat) {
    const targetOp = isCharging
      ? (0.35 + 0.25 * (0.5 + 0.5 * Math.sin(time * 6)))  // 0.35..0.60 pulse
      : 0.0;
    const cur = z.chargingCoreMat.opacity;
    z.chargingCoreMat.opacity = cur + (targetOp - cur) * Math.min(1, dt * 6);
  }

  // Ripple rings — expand outward from zone center in a 0.6s loop, fade
  // opacity 0.85 → 0 as they grow. When not charging, fade them out over
  // ~0.3s without advancing their phase (freezing them where they are).
  const RIPPLE_CYCLE = 0.6;
  const maxR = z.radius * 0.95;   // ripple reaches nearly the zone edge
  if (z.rippleRings && z.rippleRings.length) {
    for (const r of z.rippleRings) {
      if (isCharging) {
        // Advance phase; wrap in [0, 1).
        r.userData.phaseT = (r.userData.phaseT + dt / RIPPLE_CYCLE) % 1;
      }
      const t = r.userData.phaseT;
      // Scale grows 0.15 → maxR over the cycle.
      const scale = 0.15 + t * (maxR - 0.15);
      r.scale.set(scale, scale, 1);
      // Opacity fades 0.85 → 0 over the cycle when charging; otherwise
      // lerp toward 0 so the rings vanish cleanly on exit.
      if (isCharging) {
        const op = (1 - t) * 0.85;
        r.material.opacity = op;
      } else {
        r.material.opacity = Math.max(0, r.material.opacity - dt * 3);
      }
    }
  }
}


  // 1. Energy column — grow y-scale with frac (0..14 units tall), ramp opacity
  //    and a flicker from the pulse.
  if (z.energyColumn) {
    const targetScale = 0.01 + frac * 2.0;      // 0.01 → 2.01 (column is 16u, so effective ~32u at full)
    const cur = z.energyColumn.scale.y;
    z.energyColumn.scale.y = cur + (targetScale - cur) * Math.min(1, dt * 4);
    z.energyColumn.position.y = z.energyColumn.scale.y * 8;  // keep base planted at floor
    if (z.energyColumnMat) {
      z.energyColumnMat.opacity = Math.min(0.85, frac * 0.9 + pulse * 0.15);
    }
  }

  // 2. Charge orbs — spiral inward. At frac=0 they sit at radius * 0.75,
  //    at frac=1 they sit at radius * 0.15 (tight cluster). Also spin.
  if (z.chargeOrbs) {
    const baseR = z.radius * 0.75;
    const tightR = z.radius * 0.15;
    const r = baseR + (tightR - baseR) * frac;
    const spinSpeed = 1.2 + frac * 6.0;   // slow → blazing
    z.chargeOrbs.rotation.y += dt * spinSpeed;
    const bob = 0.6 + Math.sin(time * 4) * (0.1 + frac * 0.25);
    for (const m of z.chargeOrbs.children) {
      const a = m.userData.baseAngle;
      m.position.set(Math.cos(a) * r, bob, Math.sin(a) * r);
      // Individual orb bob offset
      m.position.y += Math.sin(time * 6 + a * 3) * 0.08;
    }
  }

  // 3. Spin rings — opacity ramps with frac; rotate in opposite directions.
  if (z.innerSpinRing && z.innerSpinMat) {
    z.innerSpinRing.rotation.z += dt * (1.5 + frac * 6);
    z.innerSpinMat.opacity = frac * 0.75 + pulse * 0.15;
  }
  if (z.outerSpinRing && z.outerSpinMat) {
    z.outerSpinRing.rotation.z -= dt * (1.0 + frac * 5);
    z.outerSpinMat.opacity = frac * 0.65 + pulse * 0.15;
  }

  // 4. Floor pulse heartbeat — pulse rate triples as charge fills.
  if (z.floorPulse && z.floorPulseMat) {
    const hzBase = 1.2;
    const hzMax = 4.5;
    const hz = hzBase + (hzMax - hzBase) * frac;
    const heart = 0.5 + 0.5 * Math.sin(time * hz * Math.PI * 2);
    z.floorPulseMat.opacity = 0.15 + frac * 0.4 + heart * 0.25;
    // Slight scale pulse
    const s = 1.0 + heart * 0.06 + frac * 0.05;
    z.floorPulse.scale.set(s, s, 1);
  }

  // 5. Threshold bursts — fire chapter-color bursts at 25/50/75/100%.
  const thresholds = [0.25, 0.5, 0.75, 1.0];
  for (const t of thresholds) {
    if (z.lastPayoffBurstFrac < t && frac >= t) {
      // Chapter-color burst ring around the zone perimeter.
      const nBursts = 6;
      for (let i = 0; i < nBursts; i++) {
        const a = (i / nBursts) * Math.PI * 2;
        const px = z.pos.x + Math.cos(a) * z.radius * 0.9;
        const pz = z.pos.z + Math.sin(a) * z.radius * 0.9;
        hitBurst(new THREE.Vector3(px, 0.4 + t * 2, pz), z.tint, 8);
      }
      hitBurst(new THREE.Vector3(z.pos.x, 0.4, z.pos.z), 0xffffff, 10);
      z.lastPayoffBurstFrac = t;
    }
  }
}

function _tearDownStage() {
  for (const z of zones) {
    if (z.obj && z.obj.parent) scene.remove(z.obj);
    if (z.progressRing && z.progressRing.geometry) z.progressRing.geometry.dispose();
    // Dispose any oversized per-zone geometry we built just for this zone
    // (launch zone disk + outline). Cached shared geos are NOT disposed.
    if (z._ownGeoDisk) z._ownGeoDisk.dispose();
    if (z._ownGeoOutline) z._ownGeoOutline.dispose();
    // Launch-zone payoff meshes — dispose their per-zone mats/geos.
    if (z.energyColumn && z.energyColumn.geometry) z.energyColumn.geometry.dispose();
    if (z.energyColumnMat) z.energyColumnMat.dispose();
    if (z.innerSpinRing && z.innerSpinRing.geometry) z.innerSpinRing.geometry.dispose();
    if (z.outerSpinRing && z.outerSpinRing.geometry) z.outerSpinRing.geometry.dispose();
    if (z.innerSpinMat) z.innerSpinMat.dispose();
    if (z.outerSpinMat) z.outerSpinMat.dispose();
    if (z.floorPulse && z.floorPulse.geometry) z.floorPulse.geometry.dispose();
    if (z.floorPulseMat) z.floorPulseMat.dispose();
    if (z.chargeOrbs) {
      for (const m of z.chargeOrbs.children) {
        if (m.geometry) m.geometry.dispose();
        if (m.material && m.material.dispose) m.material.dispose();
      }
    }
    // Charging-state meshes (present on every zone). Dispose per-zone
    // geo + per-zone material clones; the SHARED charging materials
    // (_diskChargingMat, _outlineChargingMat, _beamChargingMat) stay cached.
    if (z.chargingCoreGeo) z.chargingCoreGeo.dispose();
    if (z.chargingCoreMat) z.chargingCoreMat.dispose();
    if (z.rippleGeo) z.rippleGeo.dispose();
    if (z.rippleMats && z.rippleMats.length) {
      for (const rm of z.rippleMats) rm.dispose();
    }
  }
  zones.length = 0;
}

// ---------------------------------------------------------------------------
// QUERIES (for the HUD + objective arrows)
// ---------------------------------------------------------------------------

/** Returns info about the CLOSEST active (non-completed) zone, for the
 *  objective arrow + HUD. With parallel zones it's the closest to spawn
 *  point, but callers that want "where should the player go" are happy
 *  with any uncompleted zone. */
export function getActiveZone() {
  for (const z of zones) {
    if (z.completed) continue;
    return {
      id: z.def.id,
      label: z.def.label,
      pos: z.pos,
      turretIdx: (typeof z.def.turretIdx === 'number') ? z.def.turretIdx : -1,
    };
  }
  return null;
}

/** Progress 0..1 on the MAX-progress uncompleted zone. Useful for the
 *  HUD "stand in the zone" percentage readout. */
export function getActiveProgress() {
  let best = 0;
  for (const z of zones) {
    if (z.completed) continue;
    const p = (z.progress || 0) / z.holdTime;
    if (p > best) best = p;
  }
  return best;
}

/** Return an array of {turretIdx, progressFrac} for every active turret
 *  zone that currently has progress > 0. waves.js uses this to drive the
 *  charging-spin flag on the corresponding turrets, allowing all three
 *  turrets to spin simultaneously if the player hops between them. */
export function getChargingTurretStatus() {
  const out = [];
  for (const z of zones) {
    if (z.completed) continue;
    if (typeof z.def.turretIdx !== 'number' || z.def.turretIdx < 0) continue;
    const p = (z.progress || 0) / z.holdTime;
    if (p > 0.001) out.push({ turretIdx: z.def.turretIdx, progress: p });
  }
  return out;
}

/** How many stages the player has completed so far (0..STAGE_COUNT). */
export function getCompletedCount() {
  // Current stage index equals "number of stages completed" for stages
  // that have already been torn down. Plus 0 zones currently active means
  // we just rolled over and haven't built the next stage yet — return
  // stageIdx directly.
  return Math.max(0, stageIdx);
}

export function getZoneCount() {
  return STAGE_COUNT;
}

/** True if the player is currently inside ANY uncompleted zone's radius. */
export function isPlayerInActiveZone(playerPos) {
  if (!playerPos) return false;
  for (const z of zones) {
    if (z.completed) continue;
    const dx = playerPos.x - z.pos.x;
    const dz = playerPos.z - z.pos.z;
    if (dx * dx + dz * dz < z.radiusSq) return true;
  }
  return false;
}
