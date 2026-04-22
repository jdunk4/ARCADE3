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
        // Launch pad sits right next to the silo at ground level so the
        // player can physically stand at the base of the raised missile.
        { id: 'LAUNCH', label: 'LAUNCH EMP MISSILE',
          x: LAYOUT.silo.x, z: LAYOUT.silo.z + 3.5, turretIdx: -1 },
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
const BEAM_GEO = new THREE.CylinderGeometry(0.25, 0.5, 10, 10, 1, true);

const _diskDormantMatCache = new Map();
const _diskActiveMatCache = new Map();
const _ringMatCache = new Map();
const _beamDormantMatCache = new Map();
const _beamActiveMatCache = new Map();

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
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);

  const disk = new THREE.Mesh(DISK_GEO, _getDiskDormantMat(tint));
  disk.rotation.x = -Math.PI / 2;
  disk.position.y = 0.04;
  group.add(disk);

  // Progress arc — a thin ring on top of the disk. We build it as a
  // RingGeometry with a custom thetaLength that we tween on update.
  // Starts at zero length (0 rads) so it's invisible until it fills.
  const progressRingGeo = new THREE.RingGeometry(
    ZONE_CFG.radius * 0.75,
    ZONE_CFG.radius * 0.85,
    48,
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
  const outline = new THREE.Mesh(RING_GEO, _getRingMat(tint));
  outline.rotation.x = -Math.PI / 2;
  outline.position.y = 0.05;
  group.add(outline);

  // Vertical pillar beam so the zone is visible from across the map.
  const beam = new THREE.Mesh(BEAM_GEO, _getBeamDormantMat(tint));
  beam.position.y = 5;
  group.add(beam);

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
    ZONE_CFG.radius * 0.75,
    ZONE_CFG.radius * 0.85,
    48, 1,
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
  let insideZone = null;
  if (playerPos) {
    for (const z of zones) {
      if (z.completed) continue;
      const dx = playerPos.x - z.pos.x;
      const dz = playerPos.z - z.pos.z;
      if (dx * dx + dz * dz < ZONE_CFG.radiusSq) {
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

    if (z === insideZone) {
      z.progress = Math.min(ZONE_CFG.holdTime, (z.progress || 0) + dt);
    } else {
      z.progress = Math.max(0, (z.progress || 0) - dt * 0.5);
    }

    const frac = z.progress / ZONE_CFG.holdTime;
    z.progressRingMat.opacity = 0.65 + pulse * 0.2;
    _setProgressArc(z, frac);

    if (z.progress >= ZONE_CFG.holdTime) {
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

function _tearDownStage() {
  for (const z of zones) {
    if (z.obj && z.obj.parent) scene.remove(z.obj);
    if (z.progressRing && z.progressRing.geometry) z.progressRing.geometry.dispose();
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
    const p = (z.progress || 0) / ZONE_CFG.holdTime;
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
    const p = (z.progress || 0) / ZONE_CFG.holdTime;
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
    if (dx * dx + dz * dz < ZONE_CFG.radiusSq) return true;
  }
  return false;
}
