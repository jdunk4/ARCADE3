// ch7Blueprints.js — Blueprint hunt system for chapter 7.
//
// Wave 1 of chapter 7 introduces a paced narrative phase before the
// flood arrives. The player must:
//   1. Walk to a BLUEPRINT pillar (one side of the arena), stand
//      near it for a couple seconds → captures the blueprint.
//      A slow trickle of enemies begins.
//   2. Walk to a GLYPHSTONE in the cemetery (other side), stand
//      near it for a couple seconds → unlocks the captured blueprint
//      as an endless stratagem with a short cooldown.
//   3. The screen shakes and a giant white "THEY'RE COMING... PREPARE"
//      overlay appears. Any input (keyboard / controller / on-screen
//      tap) dismisses it. Trickle is PAUSED while the overlay is up.
//   4. 30-second prep timer runs. Player lays mines (or whatever
//      stratagem the blueprint unlocked). Slow trickle resumes.
//   5. The flood begins — full spawn rate. Player survives 90 seconds.
//   6. Wave ends. Future waves repeat the system with different
//      blueprints (4 total across chapter 7, scaffolded for 2-4).
//
// Per playtester:
//   - Endless quantity + 5s cooldown on stratagems
//   - Build a new monochrome cemetery cluster + custom glyph stone
//   - 4 blueprints total — HUD shows captured count
//   - Pause trickle while "THEY'RE COMING" overlay is up
//   - Scaffold for waves 2-4 (data-only future expansion)
//
// PUBLIC API:
//   prepareBlueprintForWave(waveNum)
//     Called from waves.js on chapter-7 startWave. Spawns blueprint
//     pillar + glyphstone for the wave's blueprint config (if any).
//     No-op for chapters/waves without a blueprint.
//
//   updateBlueprints(dt, playerPos)
//     Per-frame tick. Runs the state machine, checks proximity,
//     fires events. Cheap when no blueprint is active.
//
//   clearBlueprints()
//     Hard teardown. Removes all meshes, clears overlay, resets state.
//     Called on game reset / chapter exit.
//
//   getCapturedCount()
//     For HUD: how many of the 4 blueprints have been captured this run.
//
//   getSpawnRateMultiplier()
//     Returns 0..1 multiplier waves.js can apply to its base spawnRate.
//     0 during overlay (paused), 0.10 during slow trickle, 1.0 during
//     flood. Returns 1.0 for any non-blueprint wave.
//
//   shouldEndWave1Now()
//     Returns true once the 90s flood has completed. waves.js polls
//     this for ch7 wave 1 completion instead of using kill target.
//
//   isOverlayUp()
//     For input handling — when true, any key/click/tap should dismiss
//     the overlay rather than triggering normal gameplay actions.
//
//   dismissOverlay()
//     Called by main.js's input handlers when isOverlayUp() is true.

import * as THREE from 'three';
import { S, shake } from './state.js';
import { scene } from './scene.js';
import { UI } from './ui.js';
import { Audio } from './audio.js';
import { setStratagemEndless } from './stratagems.js';

// =========================================================================
// BLUEPRINT CATALOG — one entry per blueprint in chapter 7
// =========================================================================
// Currently only wave 1 is implemented. Waves 2-4 are scaffolded —
// adding more blueprints is data-only (just push more entries here)
// once the gameplay for those waves is designed.
//
// `waveNum` is the global wave number (chapter 7 starts at wave 31
// in normal play, but the dev cheat lets the player jump there
// directly). The system keys off the global wave number so dev jumps
// trigger the right blueprint.
const BLUEPRINTS = [
  {
    id: 'wave1_mines',
    waveNum: 31,                          // chapter 7 wave 1
    label: 'MINEFIELD BLUEPRINT',
    stratagemId: 'mines',                 // matches _STRATAGEMS in stratagems.js
    stratagemLabel: 'MINEFIELD',
    blueprintPos: { x: -36, z: -22 },     // side A (south-west)
    glyphstonePos: { x: 36, z: 22 },      // side B (north-east cemetery)
    captureRadius: 4,                     // proximity radius for both pickup + glyphstone
    captureSeconds: 2.0,                  // stand-near-it duration
  },
  // Wave 2 (waveNum 32), Wave 3 (waveNum 33), and a fourth slot are
  // scaffolded by the system. Add entries here once those waves are
  // designed. Required fields: id, waveNum, label, stratagemId,
  // stratagemLabel, blueprintPos {x,z}, glyphstonePos {x,z},
  // captureRadius, captureSeconds.
];

const TOTAL_BLUEPRINTS = 4;     // HUD denominator — show "1/4" not "1/1"

// =========================================================================
// STATE
// =========================================================================
// Lifecycle states for the active blueprint. The player progresses
// through these in order (no skipping). A wave ends in COMPLETE.
const PHASE = {
  DORMANT: 'DORMANT',                   // chapter just loaded, blueprint not yet prepared
  AWAIT_BLUEPRINT: 'AWAIT_BLUEPRINT',   // pillar visible, glyphstone visible-but-inert, no enemies
  TRICKLE: 'TRICKLE',                   // blueprint captured, slow enemy spawn, glyphstone activatable
  OVERLAY: 'OVERLAY',                   // glyphstone activated, "THEY'RE COMING" up, spawning paused
  PREP: 'PREP',                         // overlay dismissed, 30s prep timer running, slow trickle
  FLOOD: 'FLOOD',                       // 30s done, full spawn rate, 90s survival
  COMPLETE: 'COMPLETE',                 // 90s done, wave ready to end
};

let _activeBlueprint = null;   // current blueprint config (from BLUEPRINTS) or null
let _phase = PHASE.DORMANT;
let _phaseT = 0;               // elapsed time in current phase

// Capture progress 0..1 for blueprint pillar + glyphstone. Updated
// when player is within capture radius. Decays to 0 when they leave.
let _blueprintCaptureProgress = 0;
let _glyphstoneCaptureProgress = 0;

// Visible meshes — null when not spawned. Cleared by clearBlueprints.
let _blueprintMesh = null;     // the pickup pillar at side A
let _glyphstoneMesh = null;    // the glyph stone at side B
let _cemeteryGroup = null;     // tombstone cluster around the glyphstone
let _blueprintRing = null;     // proximity ring under the pillar
let _glyphstoneRing = null;    // proximity ring under the glyphstone

// Ring fill mesh for showing capture progress (a circular sector
// that grows from 0 to full circle as the player stands in range).
let _blueprintFillRing = null;
let _glyphstoneFillRing = null;

// Overlay DOM element + state.
let _overlayEl = null;
let _overlayDismissed = false;

// HUD captured-count badge.
let _hudBadgeEl = null;
let _capturedSet = new Set();     // ids of captured blueprints, persists across waves

// Animation phase counters for mesh wobbles + glow pulses.
let _animPhase = 0;

// =========================================================================
// PUBLIC API
// =========================================================================

/**
 * Look up the blueprint config for the given global wave number.
 * Returns null for waves without a blueprint.
 */
function _findBlueprintForWave(waveNum) {
  for (const bp of BLUEPRINTS) {
    if (bp.waveNum === waveNum) return bp;
  }
  return null;
}

/**
 * Called from waves.js startWave() when a chapter-7 wave starts.
 * Spawns the blueprint pillar + glyphstone for the wave's blueprint
 * if one is configured. No-op otherwise.
 *
 * Idempotent — calling it again with the same wave is safe (it
 * tears down any prior wave's meshes first).
 */
export function prepareBlueprintForWave(waveNum) {
  // Tear down any prior wave's setup.
  _disposeMeshes();
  _hideOverlay();

  const bp = _findBlueprintForWave(waveNum);
  if (!bp) {
    _activeBlueprint = null;
    _phase = PHASE.DORMANT;
    _ensureHudBadge();
    return;
  }

  _activeBlueprint = bp;
  _phase = PHASE.AWAIT_BLUEPRINT;
  _phaseT = 0;
  _blueprintCaptureProgress = 0;
  _glyphstoneCaptureProgress = 0;
  _overlayDismissed = false;

  // Build meshes.
  _blueprintMesh = _buildBlueprintPillar(bp.blueprintPos.x, bp.blueprintPos.z);
  scene.add(_blueprintMesh);
  _blueprintRing = _buildProximityRing(bp.blueprintPos.x, bp.blueprintPos.z, bp.captureRadius, 0xffffff);
  scene.add(_blueprintRing);
  _blueprintFillRing = _buildFillRing(bp.blueprintPos.x, bp.blueprintPos.z, bp.captureRadius);
  scene.add(_blueprintFillRing);

  _cemeteryGroup = _buildCemetery(bp.glyphstonePos.x, bp.glyphstonePos.z);
  scene.add(_cemeteryGroup);
  _glyphstoneMesh = _buildGlyphStone(bp.glyphstonePos.x, bp.glyphstonePos.z);
  scene.add(_glyphstoneMesh);
  _glyphstoneRing = _buildProximityRing(bp.glyphstonePos.x, bp.glyphstonePos.z, bp.captureRadius, 0x666666);
  scene.add(_glyphstoneRing);
  _glyphstoneFillRing = _buildFillRing(bp.glyphstonePos.x, bp.glyphstonePos.z, bp.captureRadius);
  scene.add(_glyphstoneFillRing);

  // Initial HUD nudge.
  _ensureHudBadge();
  _updateHudBadge();

  // Surface a brief intro toast so the player knows what to look for.
  try {
    UI.toast && UI.toast('FIND THE BLUEPRINT', '#ffffff', 3000);
  } catch (e) {}
}

/**
 * Per-frame tick. Runs the state machine, updates capture progress,
 * advances phase timers. Called from main.js's animate loop.
 */
export function updateBlueprints(dt, playerPos) {
  _animPhase += dt;
  if (!_activeBlueprint || _phase === PHASE.DORMANT || _phase === PHASE.COMPLETE) {
    _tickAnimations(dt);
    return;
  }
  _phaseT += dt;
  const bp = _activeBlueprint;

  // ---- Proximity capture progress ----
  // Player must stand within captureRadius of the active marker for
  // captureSeconds. Progress decays when player leaves so they can't
  // skip-tap from across the arena.
  const distToBlueprint = playerPos
    ? Math.hypot(playerPos.x - bp.blueprintPos.x, playerPos.z - bp.blueprintPos.z)
    : 999;
  const distToGlyphstone = playerPos
    ? Math.hypot(playerPos.x - bp.glyphstonePos.x, playerPos.z - bp.glyphstonePos.z)
    : 999;

  // Phase: AWAIT_BLUEPRINT — only the pillar is capturable.
  if (_phase === PHASE.AWAIT_BLUEPRINT) {
    if (distToBlueprint < bp.captureRadius) {
      _blueprintCaptureProgress = Math.min(1, _blueprintCaptureProgress + dt / bp.captureSeconds);
    } else {
      _blueprintCaptureProgress = Math.max(0, _blueprintCaptureProgress - dt * 0.5);
    }
    if (_blueprintCaptureProgress >= 1) {
      _onBlueprintCaptured(bp);
    }
  }

  // Phase: TRICKLE — only the glyphstone is capturable. Blueprint is
  // captured already and its mesh hides itself in _onBlueprintCaptured.
  if (_phase === PHASE.TRICKLE) {
    if (distToGlyphstone < bp.captureRadius) {
      // First-touch toast — fire once when the player enters range.
      if (_glyphstoneCaptureProgress <= 0.001) {
        try { UI.toast && UI.toast('A GLYPHSTONE', '#ffffff', 1800); } catch (e) {}
      }
      _glyphstoneCaptureProgress = Math.min(1, _glyphstoneCaptureProgress + dt / bp.captureSeconds);
    } else {
      _glyphstoneCaptureProgress = Math.max(0, _glyphstoneCaptureProgress - dt * 0.5);
    }
    if (_glyphstoneCaptureProgress >= 1) {
      _onGlyphstoneActivated(bp);
    }
  }

  // Phase: OVERLAY — wait for player input. _phaseT advances but
  // _overlayDismissed is set externally by dismissOverlay() when input
  // arrives. Trickle paused via getSpawnRateMultiplier() returning 0.
  if (_phase === PHASE.OVERLAY && _overlayDismissed) {
    _phase = PHASE.PREP;
    _phaseT = 0;
  }

  // Phase: PREP — 30s timer.
  if (_phase === PHASE.PREP && _phaseT >= 30) {
    _phase = PHASE.FLOOD;
    _phaseT = 0;
    try { UI.toast && UI.toast('THE FLOOD HAS ARRIVED', '#ff2030', 3000); } catch (e) {}
    try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
  }

  // Phase: FLOOD — 90s timer.
  if (_phase === PHASE.FLOOD && _phaseT >= 90) {
    _phase = PHASE.COMPLETE;
    _phaseT = 0;
    // Wave end is signalled to waves.js via shouldEndWave1Now().
  }

  // Animations + visual updates.
  _tickAnimations(dt);
  _updateRingFills();
}

function _onBlueprintCaptured(bp) {
  _phase = PHASE.TRICKLE;
  _phaseT = 0;
  _blueprintCaptureProgress = 1;

  // Hide the pillar — capture animation could go here later, but
  // for now just flick it invisible.
  if (_blueprintMesh) _blueprintMesh.visible = false;
  if (_blueprintRing) _blueprintRing.visible = false;
  if (_blueprintFillRing) _blueprintFillRing.visible = false;

  try {
    UI.toast && UI.toast('BLUEPRINT ACQUIRED · FIND THE GLYPHSTONE', '#ffffff', 3500);
  } catch (e) {}
  try { Audio.pickup && Audio.pickup(); } catch (e) {}
}

function _onGlyphstoneActivated(bp) {
  _phase = PHASE.OVERLAY;
  _phaseT = 0;
  _glyphstoneCaptureProgress = 1;
  _overlayDismissed = false;

  // Mark blueprint captured (HUD badge counter).
  _capturedSet.add(bp.id);
  _updateHudBadge();

  // Unlock the stratagem as endless.
  try {
    setStratagemEndless(bp.stratagemId, true);
    // Also seed an artifact so the HUD strip shows the stratagem
    // before the player calls it (UI uses arts[id] > 0 as a "show"
    // trigger; setting it to a high number with endless mode active
    // means the count never decrements anyway).
    if (!S.stratagemArtifacts) S.stratagemArtifacts = {};
    if (!S.stratagemArtifacts[bp.stratagemId]) {
      S.stratagemArtifacts[bp.stratagemId] = 1;
    }
  } catch (e) {
    console.warn('[ch7Blueprints] setStratagemEndless failed:', e);
  }

  // Camera shake (heavy) — uses state.js's shake function directly.
  try {
    shake(2.5, 1.0);
  } catch (e) {}
  try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}

  // Fade glyphstone to "decoded" appearance.
  if (_glyphstoneMesh) {
    _glyphstoneMesh.userData._decoded = true;
  }
  if (_glyphstoneRing) _glyphstoneRing.visible = false;
  if (_glyphstoneFillRing) _glyphstoneFillRing.visible = false;

  // Show the overlay. Dismissal handled via dismissOverlay() called
  // from main.js's input listeners.
  _showOverlay(bp);
}

/**
 * Spawn-rate multiplier waves.js applies to its base spawnRate.
 *   0    — no spawning (overlay phase)
 *   0.10 — slow trickle (post-blueprint, pre-flood)
 *   1.0  — full flood
 *   1.0  — any non-blueprint wave / phase before blueprint capture
 *          NOTE: AWAIT_BLUEPRINT returns 0 too — no enemies until the
 *          player picks up the blueprint, per design.
 */
export function getSpawnRateMultiplier() {
  if (!_activeBlueprint) return 1.0;
  switch (_phase) {
    case PHASE.AWAIT_BLUEPRINT: return 0;       // empty arena until pickup
    case PHASE.TRICKLE:         return 0.10;    // slow drip
    case PHASE.OVERLAY:         return 0;       // PAUSED while text up
    case PHASE.PREP:            return 0.10;    // slow drip during prep
    case PHASE.FLOOD:           return 1.0;     // full speed
    case PHASE.COMPLETE:        return 0;       // wave wrapping up
    default:                    return 1.0;
  }
}

/**
 * Wave 1 ends when the flood phase has completed (90s after dismiss).
 * waves.js polls this each frame for ch7 wave 1 completion. Returns
 * false for any other wave.
 */
export function shouldEndWaveNow() {
  return _activeBlueprint && _phase === PHASE.COMPLETE;
}

/**
 * True when "THEY'RE COMING" overlay is up. main.js consults this to
 * route any input as a dismissal rather than a normal gameplay action.
 */
export function isOverlayUp() {
  return _phase === PHASE.OVERLAY && !_overlayDismissed;
}

/**
 * Dismisses the overlay and starts the 30s prep timer. Idempotent —
 * subsequent calls during PREP/FLOOD are no-ops.
 */
export function dismissOverlay() {
  if (_phase !== PHASE.OVERLAY) return;
  _overlayDismissed = true;
  _hideOverlay();
}

export function getCapturedCount() {
  return _capturedSet.size;
}

export function getActivePhase() {
  return _phase;
}

export function getPhaseTime() {
  return _phaseT;
}

/**
 * Hard teardown. Removes all meshes + overlay + HUD badge, resets
 * state. Called on game reset, chapter exit, or restart.
 */
export function clearBlueprints() {
  _disposeMeshes();
  _hideOverlay();
  _activeBlueprint = null;
  _phase = PHASE.DORMANT;
  _phaseT = 0;
  _blueprintCaptureProgress = 0;
  _glyphstoneCaptureProgress = 0;
  _overlayDismissed = false;
  _capturedSet.clear();
  if (_hudBadgeEl) {
    _hudBadgeEl.style.display = 'none';
  }
}

// =========================================================================
// MESH BUILDERS
// =========================================================================
// Monochrome aesthetic — white/grey with subtle emissive glow. All
// meshes use `MeshStandardMaterial` so they respond to the chapter 7
// dim lighting + flashlight.

function _buildBlueprintPillar(x, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Pedestal — squat dark cylinder.
  const pedMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a, roughness: 0.9, metalness: 0.1,
  });
  const ped = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.1, 0.4, 12),
    pedMat,
  );
  ped.position.y = 0.2;
  group.add(ped);

  // The blueprint itself — a flat rectangle floating above the
  // pedestal, glowing white so it's visible in the dim ch7 lighting.
  const sheetMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1.2,
    roughness: 0.4,
  });
  const sheet = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.04, 1.3),
    sheetMat,
  );
  sheet.position.y = 1.2;
  sheet.userData._isFloat = true;     // tagged for tick animation
  group.add(sheet);

  // Verticle support post connecting pedestal to sheet — thin and
  // dark so it reads as background structure, not the focal element.
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6),
    pedMat,
  );
  post.position.y = 0.8;
  group.add(post);

  // Light beam shooting up from pedestal to telegraph the pickup
  // from across the arena. Tall, semi-transparent, additive blending.
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.7, 30, 12, 1, true),
    beamMat,
  );
  beam.position.y = 15;
  group.add(beam);

  group.userData._floatSheet = sheet;
  return group;
}

function _buildGlyphStone(x, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // The stone — tall obelisk with carved glyphs. Dark outer, glowing
  // inner glyphs (white emissive).
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a3a, roughness: 0.95, metalness: 0.0,
  });
  const stone = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 3.2, 0.5),
    stoneMat,
  );
  stone.position.y = 1.6;
  group.add(stone);

  // Top cap — small pyramid on the stone.
  const cap = new THREE.Mesh(
    new THREE.ConeGeometry(0.7, 0.5, 4),
    stoneMat,
  );
  cap.position.y = 3.4;
  cap.rotation.y = Math.PI / 4;
  group.add(cap);

  // Carved glyphs — three small glowing rectangles on the front face.
  // Stored on userData so we can pulse their emissive intensity.
  const glyphMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1.5,
    roughness: 0.3,
  });
  const glyphs = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.18, 0.04),
      glyphMat.clone(),
    );
    g.position.set(0, 1.0 + i * 0.7, 0.27);
    group.add(g);
    glyphs.push(g);
  }
  group.userData._glyphs = glyphs;

  // Light beam (smaller than blueprint's, dimmer) so it reads from
  // across the arena but doesn't compete with the blueprint's beam.
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xcccccc,
    transparent: true,
    opacity: 0.10,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.9, 22, 10, 1, true),
    beamMat,
  );
  beam.position.y = 11;
  group.add(beam);
  group.userData._beam = beam;

  return group;
}

function _buildCemetery(cx, cz) {
  // Cluster of 6 tombstones around the glyphstone — 4 on the cardinal
  // sides at varying distances, 2 in random offsets for organic feel.
  const group = new THREE.Group();
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x444444, roughness: 0.95, metalness: 0.0,
  });

  const positions = [
    { x: cx - 3.2, z: cz, rot: 0.1 },
    { x: cx + 3.2, z: cz - 0.5, rot: -0.05 },
    { x: cx, z: cz - 3.5, rot: 0.2 },
    { x: cx, z: cz + 3.0, rot: -0.15 },
    { x: cx - 2.0, z: cz + 2.6, rot: 0.3 },
    { x: cx + 2.6, z: cz + 2.4, rot: -0.2 },
  ];

  for (const p of positions) {
    const t = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.9 + Math.random() * 0.3, 0.18),
      stoneMat,
    );
    t.position.set(p.x, 0.45 + Math.random() * 0.1, p.z);
    t.rotation.y = p.rot + (Math.random() - 0.5) * 0.2;
    // Tilt some forward/back so they look weathered.
    t.rotation.z = (Math.random() - 0.5) * 0.12;
    group.add(t);

    // A few get a small cross top.
    if (Math.random() < 0.5) {
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.10, 0.10),
        stoneMat,
      );
      arm.position.set(p.x, 1.0, p.z);
      arm.rotation.y = p.rot;
      group.add(arm);
    }
  }
  return group;
}

function _buildProximityRing(x, z, radius, colorHex) {
  // Outer ring marking the proximity zone — non-filled, just a circle
  // outline so the player knows where to stand.
  const ringMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const geo = new THREE.RingGeometry(radius - 0.08, radius, 48);
  const ring = new THREE.Mesh(geo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.05, z);
  return ring;
}

function _buildFillRing(x, z, radius) {
  // Inner fill ring — grows from 0 sweep to full circle as the player
  // stands in the zone. We modify its theta-length each frame in
  // _updateRingFills() based on capture progress.
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.30,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  // Initially full circle but invisible (opacity-driven by progress).
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0, radius - 0.1, 48, 1, 0, 0.0001),
    ringMat,
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.04, z);
  ring.userData._radius = radius;
  return ring;
}

// =========================================================================
// PER-FRAME ANIMATION + FILL RING UPDATES
// =========================================================================

function _tickAnimations(dt) {
  // Float the blueprint sheet up and down + slow rotation.
  if (_blueprintMesh && _blueprintMesh.userData._floatSheet) {
    const sheet = _blueprintMesh.userData._floatSheet;
    sheet.position.y = 1.2 + Math.sin(_animPhase * 1.5) * 0.10;
    sheet.rotation.y = _animPhase * 0.4;
  }
  // Pulse the glyphstone glyphs — slow breathing emission. Stronger
  // when the glyphstone is "decoded" (fully captured).
  if (_glyphstoneMesh && _glyphstoneMesh.userData._glyphs) {
    const decoded = !!_glyphstoneMesh.userData._decoded;
    const baseIntensity = decoded ? 2.5 : 1.5;
    const pulseAmp = decoded ? 0.6 : 0.3;
    const intensity = baseIntensity + Math.sin(_animPhase * 2.0) * pulseAmp;
    for (const g of _glyphstoneMesh.userData._glyphs) {
      if (g.material) g.material.emissiveIntensity = intensity;
    }
  }
}

function _updateRingFills() {
  if (_blueprintFillRing && _blueprintFillRing.visible) {
    _setRingProgress(_blueprintFillRing, _blueprintCaptureProgress);
  }
  if (_glyphstoneFillRing && _glyphstoneFillRing.visible) {
    _setRingProgress(_glyphstoneFillRing, _glyphstoneCaptureProgress);
  }
}

function _setRingProgress(ring, progress) {
  // Replace the geometry with a new RingGeometry whose theta-length
  // matches progress. Cheap because RingGeometry is small (48 segments).
  const old = ring.geometry;
  if (old) old.dispose();
  const radius = ring.userData._radius || 4;
  const theta = Math.max(0.0001, progress * Math.PI * 2);
  ring.geometry = new THREE.RingGeometry(0, radius - 0.1, 48, 1, -Math.PI / 2, theta);
}

// =========================================================================
// "THEY'RE COMING" OVERLAY
// =========================================================================

function _showOverlay(bp) {
  if (!_overlayEl) {
    const el = document.createElement('div');
    el.id = 'ch7-blueprint-overlay';
    el.style.cssText = [
      'position: fixed',
      'inset: 0',
      'z-index: 8500',                  // above HUD, below pause menu
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: center',
      'background: radial-gradient(circle at center, rgba(20,4,40,0.0), rgba(0,0,0,0.45))',
      'pointer-events: auto',
      'cursor: pointer',
      'user-select: none',
      '-webkit-user-select: none',
    ].join(';');
    el.innerHTML = `
      <div id="ch7-blueprint-overlay-title" style="
        font-family: 'Impact', 'Arial Black', sans-serif;
        font-size: clamp(48px, 9vw, 120px);
        letter-spacing: 8px;
        color: #ffffff;
        text-shadow: 0 0 24px rgba(255,255,255,0.6),
                     0 0 48px rgba(255,255,255,0.4),
                     0 0 96px rgba(255,255,255,0.2);
        animation: ch7BlueprintPulse 1.6s ease-in-out infinite;
        text-align: center;
        margin-bottom: 24px;
      ">THEY'RE COMING...</div>
      <div style="
        font-family: 'Impact', 'Arial Black', sans-serif;
        font-size: clamp(28px, 5vw, 72px);
        letter-spacing: 12px;
        color: #ffffff;
        text-shadow: 0 0 16px rgba(255,255,255,0.5);
        margin-bottom: 36px;
        text-align: center;
      ">PREPARE</div>
      <div style="
        font-family: 'Courier New', monospace;
        font-size: 13px;
        letter-spacing: 4px;
        color: #aaa;
        animation: ch7BlueprintBlink 1.4s ease-in-out infinite;
      ">▸ PRESS ANY KEY ◂</div>
    `;
    // Inject keyframes (idempotent — only added once).
    if (!document.getElementById('ch7-blueprint-overlay-style')) {
      const style = document.createElement('style');
      style.id = 'ch7-blueprint-overlay-style';
      style.textContent = `
        @keyframes ch7BlueprintPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50%      { transform: scale(1.04); opacity: 0.85; }
        }
        @keyframes ch7BlueprintBlink {
          0%, 100% { opacity: 0.4; }
          50%      { opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }
    document.body.appendChild(el);
    _overlayEl = el;

    // Click/tap on the overlay also dismisses (covers mobile).
    el.addEventListener('click', () => dismissOverlay());
    el.addEventListener('touchstart', (e) => { e.preventDefault(); dismissOverlay(); }, { passive: false });
  }
  _overlayEl.style.display = 'flex';
}

function _hideOverlay() {
  if (_overlayEl) _overlayEl.style.display = 'none';
}

// =========================================================================
// HUD BADGE (top-left captured-blueprint counter)
// =========================================================================

function _ensureHudBadge() {
  if (_hudBadgeEl) return;
  const el = document.createElement('div');
  el.id = 'ch7-blueprints-badge';
  el.style.cssText = [
    'position: fixed',
    'top: 84px',
    'left: 16px',
    'z-index: 60',
    'padding: 6px 12px',
    'background: rgba(8, 8, 8, 0.78)',
    'border: 2px solid #ffffff',
    'color: #ffffff',
    "font-family: 'Impact', monospace",
    'font-size: 13px',
    'letter-spacing: 3px',
    'box-shadow: 0 0 12px rgba(255, 255, 255, 0.25)',
    'pointer-events: none',
    'user-select: none',
    'display: none',
  ].join(';');
  document.body.appendChild(el);
  _hudBadgeEl = el;
}

function _updateHudBadge() {
  if (!_hudBadgeEl) return;
  const have = _capturedSet.size;
  _hudBadgeEl.textContent = `BLUEPRINTS · ${have}/${TOTAL_BLUEPRINTS}`;
  _hudBadgeEl.style.display = '';
}

// =========================================================================
// CLEANUP
// =========================================================================

function _disposeMeshes() {
  for (const m of [
    _blueprintMesh,
    _glyphstoneMesh,
    _cemeteryGroup,
    _blueprintRing,
    _glyphstoneRing,
    _blueprintFillRing,
    _glyphstoneFillRing,
  ]) {
    if (m && m.parent) m.parent.remove(m);
    if (m) {
      m.traverse && m.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            for (const mat of child.material) mat.dispose();
          } else {
            child.material.dispose();
          }
        }
      });
    }
  }
  _blueprintMesh = null;
  _glyphstoneMesh = null;
  _cemeteryGroup = null;
  _blueprintRing = null;
  _glyphstoneRing = null;
  _blueprintFillRing = null;
  _glyphstoneFillRing = null;
}
