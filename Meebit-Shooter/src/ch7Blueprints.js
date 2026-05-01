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
    id: 'wave1_turret',
    waveNum: 31,                          // chapter 7 wave 1
    label: 'TURRET BLUEPRINT',
    stratagemId: 'turret',                // matches _STRATAGEMS in stratagems.js
    stratagemLabel: 'TURRET',
    blueprintPos: { x: -36, z: -22 },     // side A (south-west)
    glyphstonePos: { x: 36, z: 22 },      // side B (north-east cemetery)
    captureRadius: 4,                     // proximity radius for both pickup + glyphstone
    captureSeconds: 2.0,                  // stand-near-it duration
    schematicType: 'turret',              // which SVG to render in the pickup overlay
  },
  // Wave 2 (waveNum 32), Wave 3 (waveNum 33), and a fourth slot are
  // scaffolded by the system. Add entries here once those waves are
  // designed. Required fields: id, waveNum, label, stratagemId,
  // stratagemLabel, blueprintPos {x,z}, glyphstonePos {x,z},
  // captureRadius, captureSeconds, schematicType.
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
  SCHEMATIC: 'SCHEMATIC',               // blueprint just picked up — schematic overlay shown, player dismisses to continue
  TRICKLE: 'TRICKLE',                   // schematic dismissed, slow enemy spawn, glyphstone activatable
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

// Hot-air balloon mesh — only spawned when the FLOOD phase begins
// (= "balloon ascend defense"). Built once on phase entry, animated
// to rise + carry the glyphstone with it, removed on phase end.
// Per playtester: "A literal hot-air balloon mesh appears above the
// glyphstone, the basket attaches to the stone, and they rise
// together?"
let _balloonMesh = null;
let _ascendStartY = 0;          // initial glyphstone y for the rise animation
const ASCEND_PEAK_Y = 22;       // target altitude (out of normal camera reach)

// Overlay DOM elements + dismiss state.
//   _overlayEl       — "THEY'RE COMING... PREPARE" (glyphstone activation)
//   _schematicEl     — schematic preview (blueprint pickup) showing the
//                      reward's diagram. Dismissed same as overlay.
// Both are dismissed by any input (key/click/tap/gamepad button).
let _overlayEl = null;
let _overlayDismissed = false;
let _schematicEl = null;
let _schematicDismissed = false;

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
  _hideSchematicOverlay();

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
  _schematicDismissed = false;

  // Build meshes.
  _blueprintMesh = _buildBlueprintPillar(bp.blueprintPos.x, bp.blueprintPos.z);
  scene.add(_blueprintMesh);
  _blueprintRing = _buildProximityRing(bp.blueprintPos.x, bp.blueprintPos.z, bp.captureRadius, 0x4aa8ff);
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

  // Phase: SCHEMATIC — schematic preview overlay is up. Wait for
  // the player to dismiss with any input, then advance to TRICKLE
  // (slow enemy spawning + glyphstone activatable). Trickle is
  // paused while SCHEMATIC is up too (see getSpawnRateMultiplier).
  if (_phase === PHASE.SCHEMATIC && _schematicDismissed) {
    _phase = PHASE.TRICKLE;
    _phaseT = 0;
    try {
      UI.toast && UI.toast('FIND THE GLYPHSTONE', '#cccccc', 3000);
    } catch (e) {}
  }

  // Phase: OVERLAY — wait for player input. _phaseT advances but
  // _overlayDismissed is set externally by dismissOverlay() when input
  // arrives. Trickle paused via getSpawnRateMultiplier() returning 0.
  if (_phase === PHASE.OVERLAY && _overlayDismissed) {
    _phase = PHASE.PREP;
    _phaseT = 0;
  }

  // Phase: PREP — 60s timer (was 30s; player wanted more setup time).
  // Slow trickle continues while the player lays defenses.
  if (_phase === PHASE.PREP && _phaseT >= 60) {
    _phase = PHASE.FLOOD;
    _phaseT = 0;
    _onAscendBegin();
    try { UI.toast && UI.toast('PROTECT THE BEACON', '#33ff44', 3000); } catch (e) {}
    try { Audio.bigBoom && Audio.bigBoom(); } catch (e) {}
  }

  // Phase: FLOOD — 60s balloon-ascend defense. The glyphstone is
  // lifting on a hot-air balloon, illuminating the arena and revealing
  // enemies (via the reveal dome). Player must defend the launch
  // point until the balloon clears the arena. Was 90s pure flood.
  if (_phase === PHASE.FLOOD) {
    _tickAscend(dt);
    if (_phaseT >= 60) {
      _phase = PHASE.COMPLETE;
      _phaseT = 0;
      _onAscendEnd();
      try { UI.toast && UI.toast('BEACON ASCENDED', '#ffffff', 3000); } catch (e) {}
    }
  }

  // Animations + visual updates.
  _tickAnimations(dt);
  _updateRingFills();
}

function _onBlueprintCaptured(bp) {
  _phase = PHASE.SCHEMATIC;
  _phaseT = 0;
  _blueprintCaptureProgress = 1;
  _schematicDismissed = false;

  // Hide the pillar — capture animation could go here later, but
  // for now just flick it invisible.
  if (_blueprintMesh) _blueprintMesh.visible = false;
  if (_blueprintRing) _blueprintRing.visible = false;
  if (_blueprintFillRing) _blueprintFillRing.visible = false;

  try {
    UI.toast && UI.toast('BLUEPRINT ACQUIRED', '#4aa8ff', 2200);
  } catch (e) {}
  try { Audio.blueprintSnap && Audio.blueprintSnap(); } catch (e) {}

  // Show the schematic preview overlay. Player dismisses with any
  // input (handled by dismissOverlay → which routes to whichever
  // overlay is currently up). Once dismissed, the state machine
  // advances to TRICKLE in updateBlueprints.
  _showSchematicOverlay(bp);
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
    case PHASE.SCHEMATIC:       return 0;       // schematic preview up — paused
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
 * True when ANY overlay (schematic preview OR "THEY'RE COMING") is up.
 * main.js consults this to route any input as a dismissal rather than
 * a normal gameplay action.
 */
export function isOverlayUp() {
  if (_phase === PHASE.SCHEMATIC && !_schematicDismissed) return true;
  if (_phase === PHASE.OVERLAY && !_overlayDismissed) return true;
  return false;
}

/**
 * Dismisses whichever overlay is up. Idempotent — subsequent calls
 * during TRICKLE/PREP/FLOOD are no-ops.
 */
export function dismissOverlay() {
  // Dismiss the schematic preview if that's what's up, else dismiss
  // the THEY'RE-COMING overlay. Idempotent; safe to call from any
  // phase (no-op outside the two overlay phases).
  if (_phase === PHASE.SCHEMATIC && !_schematicDismissed) {
    _schematicDismissed = true;
    _hideSchematicOverlay();
    return;
  }
  if (_phase === PHASE.OVERLAY && !_overlayDismissed) {
    _overlayDismissed = true;
    _hideOverlay();
    return;
  }
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
  _hideSchematicOverlay();
  _activeBlueprint = null;
  _phase = PHASE.DORMANT;
  _phaseT = 0;
  _blueprintCaptureProgress = 0;
  _glyphstoneCaptureProgress = 0;
  _overlayDismissed = false;
  _schematicDismissed = false;
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
  // pedestal, glowing blueprint-blue (cyan/azure) so it reads as a
  // technical schematic, not a generic pickup. Per playtester:
  // "Can we make the blueprint glow blue?" — color matched to the
  // classic blueprint reference image (white-on-blue grid).
  const BLUEPRINT_BLUE = 0x4aa8ff;
  const sheetMat = new THREE.MeshStandardMaterial({
    color: BLUEPRINT_BLUE,
    emissive: BLUEPRINT_BLUE,
    emissiveIntensity: 1.4,
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
  // from across the arena. Tinted blueprint-blue to match the sheet,
  // tall and semi-transparent with additive blending.
  const beamMat = new THREE.MeshBasicMaterial({
    color: BLUEPRINT_BLUE,
    transparent: true,
    opacity: 0.22,
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

// =========================================================================
// HOT-AIR BALLOON (balloon ascend phase)
// =========================================================================

/**
 * Build a hot-air-balloon mesh. Pieces:
 *   - Bulb (sphere) — large, glowing green from inside (the
 *     "burner" lights up the envelope)
 *   - Crown ring at the top
 *   - Ropes (4 tilted lines) connecting the bulb to a basket
 *   - Basket (small wooden box) — sits at y=0 at build time;
 *     parents to the glyphstone at ascend time
 *
 * Returns a Group positioned above the glyphstone. The group's local
 * y is bumped during the ascend animation (the basket "lifts" the
 * glyphstone with it — see _tickAscend).
 */
function _buildBalloon(cx, cz) {
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);

  // -- BULB --
  // Large sphere, green-tinted material with bright emissive interior
  // so it reads as a glowing beacon in the dim ch7 atmosphere.
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xddffdd,
    emissive: 0x33ff44,
    emissiveIntensity: 1.6,
    roughness: 0.5,
    metalness: 0.0,
  });
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 20, 14),
    bulbMat,
  );
  bulb.position.y = 9.4;
  bulb.scale.set(1, 1.15, 1);    // slight egg-shape stretch
  group.add(bulb);
  group.userData._bulb = bulb;
  group.userData._bulbMat = bulbMat;

  // Vertical ribs (8 around the bulb) for that iconic balloon panel
  // look. Thin dark cylinders draped over the bulb.
  const ribMat = new THREE.MeshStandardMaterial({
    color: 0x2a4a2a, roughness: 0.8,
  });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rib = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 5.5, 6),
      ribMat,
    );
    rib.position.set(Math.cos(a) * 2.5, 9.4, Math.sin(a) * 2.5);
    rib.lookAt(0, 9.4 + 3, 0);
    rib.rotateX(Math.PI / 2);    // align cylinder length with rib direction
    group.add(rib);
  }

  // Crown ring at top of bulb.
  const crownMat = new THREE.MeshStandardMaterial({
    color: 0x88ff99, emissive: 0x33ff44, emissiveIntensity: 0.8,
  });
  const crown = new THREE.Mesh(
    new THREE.TorusGeometry(0.45, 0.10, 8, 16),
    crownMat,
  );
  crown.position.y = 12.6;
  crown.rotation.x = Math.PI / 2;
  group.add(crown);

  // -- ROPES --
  // 4 tilted lines from underside of bulb down to the basket corners.
  const ropeMat = new THREE.MeshStandardMaterial({
    color: 0x553322, roughness: 0.95,
  });
  const ropePositions = [
    { dx: 0.9, dz: 0.9 },
    { dx: -0.9, dz: 0.9 },
    { dx: 0.9, dz: -0.9 },
    { dx: -0.9, dz: -0.9 },
  ];
  for (const p of ropePositions) {
    const rope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 4.5, 6),
      ropeMat,
    );
    // Position at midpoint between bulb-bottom (y≈7.0) and basket-top
    // (y≈4.0). Tilt toward basket corner.
    rope.position.set(p.dx * 0.55, 5.6, p.dz * 0.55);
    rope.lookAt(p.dx, 4.2, p.dz);
    rope.rotateX(Math.PI / 2);
    group.add(rope);
  }

  // -- BASKET --
  // Simple boxy basket. The glyphstone slides inside this and rises
  // with the balloon. Wood-like dark material.
  const basketMat = new THREE.MeshStandardMaterial({
    color: 0x6a4220, roughness: 0.85, metalness: 0.0,
  });
  const basket = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 1.4, 2.0),
    basketMat,
  );
  basket.position.y = 4.0;
  group.add(basket);

  // Hollow look — top rim cap (the basket has a hollow opening top).
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x442817, roughness: 0.9,
  });
  for (let s = 0; s < 4; s++) {
    const isSide = s % 2 === 0;
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(isSide ? 2.05 : 0.10, 0.10, isSide ? 0.10 : 2.05),
      rimMat,
    );
    const dx = (s === 0) ? 0 : (s === 2) ? 0 : (s === 1 ? 1.0 : -1.0);
    const dz = (s === 0) ? 1.0 : (s === 2) ? -1.0 : 0;
    rim.position.set(dx, 4.7, dz);
    group.add(rim);
  }

  // Burner — small bright glow under the bulb opening.
  const burner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.6, 0.4, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffaa44, emissive: 0xff7722, emissiveIntensity: 2.4,
      roughness: 0.4,
    }),
  );
  burner.position.y = 5.0;
  group.add(burner);

  return group;
}

// Phase entry: spawn the balloon, glow the glyphstone green, set
// reveal-dome global so the per-enemy update can light up nearby
// enemies in green. Called by updateBlueprints when PREP→FLOOD flips.
function _onAscendBegin() {
  if (!_activeBlueprint) return;
  const bp = _activeBlueprint;

  // Build the balloon at the glyphstone position.
  _balloonMesh = _buildBalloon(bp.glyphstonePos.x, bp.glyphstonePos.z);
  scene.add(_balloonMesh);
  _ascendStartY = (_glyphstoneMesh && _glyphstoneMesh.position.y) || 0;

  // Glyphstone glows GREEN now (was white when dormant). The carved
  // glyphs were already pulsing; just retint them green and crank the
  // intensity. _tickAnimations keeps the pulse animation going.
  if (_glyphstoneMesh && _glyphstoneMesh.userData._glyphs) {
    for (const g of _glyphstoneMesh.userData._glyphs) {
      if (g.material && g.material.emissive) {
        g.material.emissive.setHex(0x33ff44);
      }
    }
  }
  if (_glyphstoneMesh && _glyphstoneMesh.userData._beam) {
    const beamMat = _glyphstoneMesh.userData._beam.material;
    if (beamMat && beamMat.color) beamMat.color.setHex(0x33ff44);
    if (beamMat) beamMat.opacity = 0.35;     // brighter than the dormant beam
  }

  // Set reveal-dome global so main.js's per-enemy green-glow check
  // catches any enemy near the beacon. Radius 18u — large enough to
  // reveal anything attacking the launch point.
  window.__ch7GlyphReveal = {
    x: bp.glyphstonePos.x,
    z: bp.glyphstonePos.z,
    radius: 18,
  };
}

// Per-frame ascend animation. Lifts the balloon + glyphstone together
// from their start position to ASCEND_PEAK_Y over the 60s phase.
// _phaseT is the phase elapsed time (set externally in updateBlueprints).
function _tickAscend(dt) {
  if (!_balloonMesh) return;
  // Eased lift: ease-in for the first 25% (the balloon "fills"), then
  // linear rise. Player has time to defend at ground level before the
  // beacon clears their head.
  const t01 = Math.min(1, _phaseT / 60);
  const eased = t01 < 0.25
    ? (t01 / 0.25) * 0.05               // 0% to 5% over first 25% of time
    : 0.05 + ((t01 - 0.25) / 0.75) * 0.95;
  const y = _ascendStartY + eased * (ASCEND_PEAK_Y - _ascendStartY);
  _balloonMesh.position.y = y;
  // Lift the glyphstone WITH the balloon — they're attached.
  if (_glyphstoneMesh) {
    _glyphstoneMesh.position.y = y;
  }
  // Reveal-dome height tracks the glyphstone, but we keep the radius
  // fixed at ground level (XZ only is checked in main.js). No update
  // needed — the global was set at phase start.

  // Subtle bob + sway on the balloon as it rises (looks more alive).
  if (_balloonMesh.userData._bulb) {
    const bulb = _balloonMesh.userData._bulb;
    bulb.position.x = Math.sin(_animPhase * 0.6) * 0.15;
    bulb.position.z = Math.cos(_animPhase * 0.5) * 0.15;
  }
  // Burner flicker — pulse the bulb's emissive so it reads as flames.
  if (_balloonMesh.userData._bulbMat) {
    const flicker = 1.4 + Math.sin(_animPhase * 12) * 0.25 + Math.random() * 0.15;
    _balloonMesh.userData._bulbMat.emissiveIntensity = flicker;
  }
}

// Phase exit: clear the reveal dome. The balloon mesh stays in scene
// (it's at peak altitude, may even leave the camera frustum naturally)
// and gets disposed in clearBlueprints when the wave actually ends.
function _onAscendEnd() {
  window.__ch7GlyphReveal = null;
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
// SCHEMATIC OVERLAY (blueprint pickup preview)
// =========================================================================
// Shown immediately when the player captures a blueprint pickup. Renders
// a styled SVG schematic of the unlocked stratagem (turret, mines, etc.)
// on a blueprint-blue background, with white technical-drawing lines.
// Player dismisses with any input (key/click/tap/gamepad button).

function _showSchematicOverlay(bp) {
  if (!_schematicEl) {
    const el = document.createElement('div');
    el.id = 'ch7-schematic-overlay';
    el.style.cssText = [
      'position: fixed',
      'inset: 0',
      'z-index: 8400',                   // just below "THEY'RE COMING" overlay
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: center',
      'background: rgba(8, 30, 70, 0.92)', // deep blueprint blue wash
      'pointer-events: auto',
      'cursor: pointer',
      'user-select: none',
      '-webkit-user-select: none',
    ].join(';');
    document.body.appendChild(el);
    _schematicEl = el;

    // Click/tap on the overlay also dismisses (covers mobile).
    el.addEventListener('click', () => dismissOverlay());
    el.addEventListener('touchstart', (e) => {
      e.preventDefault(); dismissOverlay();
    }, { passive: false });
  }

  // Populate with a fresh schematic each time — the SVG depends on the
  // schematicType in the blueprint config (turret / mines / ...).
  const svg = _buildSchematicSvg(bp.schematicType || 'turret');
  _schematicEl.innerHTML = `
    <div style="
      font-family: 'Courier New', monospace;
      font-size: 11px;
      letter-spacing: 4px;
      color: #b8d4ff;
      margin-bottom: 8px;
    ">▸ SCHEMATIC RECOVERED ◂</div>
    <div style="
      font-family: 'Impact', 'Arial Black', sans-serif;
      font-size: clamp(28px, 5vw, 56px);
      letter-spacing: 6px;
      color: #ffffff;
      text-shadow: 0 0 16px rgba(74, 168, 255, 0.6);
      margin-bottom: 18px;
    ">${bp.label || 'BLUEPRINT'}</div>
    <div style="
      width: clamp(280px, 45vw, 520px);
      aspect-ratio: 4 / 3;
      background:
        linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px) 0 0 / 24px 24px,
        linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px) 0 0 / 24px 24px,
        linear-gradient(135deg, #0a2050, #103070);
      border: 2px solid #4aa8ff;
      box-shadow: 0 0 32px rgba(74, 168, 255, 0.3),
                  inset 0 0 24px rgba(255,255,255,0.05);
      padding: 20px;
      box-sizing: border-box;
      position: relative;
    ">
      ${svg}
    </div>
    <div style="
      font-family: 'Courier New', monospace;
      font-size: 12px;
      letter-spacing: 3px;
      color: #b8d4ff;
      margin-top: 18px;
      animation: ch7BlueprintBlink 1.4s ease-in-out infinite;
    ">▸ PRESS ANY KEY ◂</div>
  `;
  _schematicEl.style.display = 'flex';
}

function _hideSchematicOverlay() {
  if (_schematicEl) _schematicEl.style.display = 'none';
}

/**
 * Returns inline SVG markup for a blueprint diagram. Switch on the
 * stratagem schematic type. Lines are white on the blueprint-blue
 * grid background (handled by the parent div). All shapes are stroked
 * (no fills) so it reads as technical drawing, not painted art.
 */
function _buildSchematicSvg(type) {
  const STROKE = '#ffffff';
  const ACCENT = '#cfe6ff';
  const W = 'stroke="' + STROKE + '" fill="none" stroke-width="1.5"';
  const Wt = 'stroke="' + STROKE + '" fill="none" stroke-width="1"';
  const Wd = 'stroke="' + ACCENT + '" fill="none" stroke-width="0.8" stroke-dasharray="4 3"';
  const TXT = 'fill="' + ACCENT + '" font-family="Courier New, monospace" font-size="9"';

  if (type === 'turret') {
    // A simple sentry-turret blueprint: round base, vertical column,
    // horizontal barrel + counterweight, three mounting bolts, and
    // a couple of measurement annotations.
    return `<svg viewBox="0 0 400 300" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
      <!-- Top-down view (left side) -->
      <g transform="translate(110, 150)">
        <!-- Base outer circle -->
        <circle cx="0" cy="0" r="60" ${W}/>
        <circle cx="0" cy="0" r="48" ${Wt}/>
        <circle cx="0" cy="0" r="32" ${Wt}/>
        <!-- Mounting bolts (3 on outer ring) -->
        <circle cx="0" cy="-54" r="3" ${W}/>
        <circle cx="-47" cy="27" r="3" ${W}/>
        <circle cx="47" cy="27" r="3" ${W}/>
        <!-- Cross-section guides -->
        <line x1="-65" y1="0" x2="65" y2="0" ${Wd}/>
        <line x1="0" y1="-65" x2="0" y2="65" ${Wd}/>
        <!-- Center hub -->
        <circle cx="0" cy="0" r="8" ${W}/>
        <!-- Diameter dimension -->
        <line x1="-60" y1="80" x2="60" y2="80" ${Wt}/>
        <line x1="-60" y1="76" x2="-60" y2="84" ${Wt}/>
        <line x1="60" y1="76" x2="60" y2="84" ${Wt}/>
        <text x="0" y="94" ${TXT} text-anchor="middle">Ø 1.20m</text>
        <!-- Label below -->
        <text x="0" y="-78" ${TXT} text-anchor="middle">PLAN VIEW</text>
      </g>

      <!-- Side view (right side) -->
      <g transform="translate(280, 150)">
        <!-- Base plate -->
        <rect x="-50" y="40" width="100" height="14" ${W}/>
        <!-- Riser column -->
        <rect x="-12" y="-10" width="24" height="50" ${W}/>
        <!-- Turret head (rotating mount) -->
        <rect x="-22" y="-30" width="44" height="22" ${W}/>
        <!-- Barrel -->
        <line x1="22" y1="-19" x2="60" y2="-19" ${W}/>
        <rect x="22" y="-23" width="38" height="8" ${W}/>
        <circle cx="60" cy="-19" r="3" ${W}/>
        <!-- Counterweight -->
        <rect x="-36" y="-23" width="14" height="8" ${W}/>
        <!-- Antenna -->
        <line x1="0" y1="-30" x2="0" y2="-46" ${W}/>
        <circle cx="0" cy="-48" r="2" ${W}/>
        <!-- Ground line -->
        <line x1="-65" y1="54" x2="65" y2="54" ${Wt}/>
        <line x1="-65" y1="58" x2="-58" y2="50" ${Wt}/>
        <line x1="-55" y1="58" x2="-48" y2="50" ${Wt}/>
        <line x1="-45" y1="58" x2="-38" y2="50" ${Wt}/>
        <line x1="-35" y1="58" x2="-28" y2="50" ${Wt}/>
        <line x1="-25" y1="58" x2="-18" y2="50" ${Wt}/>
        <line x1="-15" y1="58" x2="-8" y2="50" ${Wt}/>
        <line x1="-5" y1="58" x2="2" y2="50" ${Wt}/>
        <line x1="5" y1="58" x2="12" y2="50" ${Wt}/>
        <line x1="15" y1="58" x2="22" y2="50" ${Wt}/>
        <line x1="25" y1="58" x2="32" y2="50" ${Wt}/>
        <line x1="35" y1="58" x2="42" y2="50" ${Wt}/>
        <line x1="45" y1="58" x2="52" y2="50" ${Wt}/>
        <line x1="55" y1="58" x2="62" y2="50" ${Wt}/>
        <!-- Height dimension -->
        <line x1="-70" y1="-48" x2="-70" y2="54" ${Wt}/>
        <line x1="-74" y1="-48" x2="-66" y2="-48" ${Wt}/>
        <line x1="-74" y1="54" x2="-66" y2="54" ${Wt}/>
        <text x="-78" y="3" ${TXT} text-anchor="end">1.6m</text>
        <!-- Label -->
        <text x="0" y="-58" ${TXT} text-anchor="middle">SIDE VIEW</text>
      </g>

      <!-- Title block (bottom-right) -->
      <g transform="translate(390, 290)">
        <rect x="-110" y="-22" width="110" height="22" ${Wt}/>
        <text x="-105" y="-9" ${TXT}>SENTRY MK-VII</text>
        <text x="-105" y="-1" ${TXT}>SHEET 01 / 01</text>
      </g>
    </svg>`;
  }

  if (type === 'mines') {
    // Minefield blueprint: rows of mines in a grid pattern, with one
    // exploded view detail showing the mine's internals.
    return `<svg viewBox="0 0 400 300" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
      <!-- Grid of mines (top-down) -->
      <g transform="translate(120, 150)">
        ${[0,1,2,3].map(r => [0,1,2,3].map(c => {
          const x = -75 + c * 50; const y = -75 + r * 50;
          return `<g transform="translate(${x},${y})">
            <circle r="12" ${W}/>
            <circle r="6" ${Wt}/>
            <line x1="-12" y1="0" x2="-18" y2="0" ${Wt}/>
            <line x1="12" y1="0" x2="18" y2="0" ${Wt}/>
            <line x1="0" y1="-12" x2="0" y2="-18" ${Wt}/>
            <line x1="0" y1="12" x2="0" y2="18" ${Wt}/>
          </g>`;
        }).join('')).join('')}
        <text x="0" y="-110" ${TXT} text-anchor="middle">PATTERN: 4×4</text>
      </g>

      <!-- Detail (right side) -->
      <g transform="translate(290, 150)">
        <circle cx="0" cy="0" r="50" ${W}/>
        <circle cx="0" cy="0" r="36" ${Wt}/>
        <circle cx="0" cy="0" r="20" ${W}/>
        <circle cx="0" cy="0" r="6" ${W}/>
        <line x1="-50" y1="0" x2="-60" y2="0" ${Wt}/>
        <line x1="50" y1="0" x2="60" y2="0" ${Wt}/>
        <line x1="0" y1="-50" x2="0" y2="-60" ${Wt}/>
        <line x1="0" y1="50" x2="0" y2="60" ${Wt}/>
        <text x="65" y="3" ${TXT}>DETAIL A</text>
      </g>

      <!-- Title block -->
      <g transform="translate(390, 290)">
        <rect x="-110" y="-22" width="110" height="22" ${Wt}/>
        <text x="-105" y="-9" ${TXT}>MINEFIELD-A</text>
        <text x="-105" y="-1" ${TXT}>SHEET 01 / 01</text>
      </g>
    </svg>`;
  }

  // Generic fallback — single boxy diagram.
  return `<svg viewBox="0 0 400 300" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(200, 150)">
      <rect x="-60" y="-40" width="120" height="80" ${W}/>
      <line x1="-60" y1="0" x2="60" y2="0" ${Wt}/>
      <line x1="0" y1="-40" x2="0" y2="40" ${Wt}/>
      <text x="0" y="65" ${TXT} text-anchor="middle">UNKNOWN ASSET</text>
    </g>
  </svg>`;
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
    _balloonMesh,
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
  _balloonMesh = null;
  // Clear the reveal-dome global if it's still set (e.g. wave ended
  // mid-ascend via dev-cheat).
  window.__ch7GlyphReveal = null;
}
