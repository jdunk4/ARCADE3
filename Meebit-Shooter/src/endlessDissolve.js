// endlessDissolve.js — Wave-end "walls dissolve into autoglyph" animation
//
// Per playtester (Ship 3B): when a wave ends, the procedural
// floorplan walls explode into a cloud of small particles which then
// fly to positions matching a generated autoglyph pattern, lie flat
// on the white floor as a readable glyph for ~2 seconds, then sink
// into the floor and disappear. The autoglyph is generated fresh per
// wave (seeded by wave number for repeatability).
//
// Design:
//   1. PARTICLE POOL — single InstancedMesh, one geometry + material,
//      up to MAX_PARTICLES instances. Each particle is a tiny black
//      cube. Per-particle CPU-side state (origin, target, phase, t).
//   2. PHASES PER PARTICLE:
//      'explode'  (0.0-0.3s)  — random outward velocity, drag decay
//      'fly'      (0.3-1.5s)  — smooth-step from current to target
//      'display'  (1.5-3.5s)  — hold on floor, gentle glow pulse
//      'sink'     (3.5-4.5s)  — y-position drops, opacity fades
//      'done'     (4.5s+)     — instance hidden via tiny scale
//   3. ANIMATION DRIVEN BY: external tick from endlessGlyphs.js,
//      which calls tickDissolve(dt) per frame while the WAVE_DISSOLVE
//      phase is active.
//
// API:
//   startDissolve(walls, waveSeed)
//     → spawns particles from wall AABBs, generates autoglyph using
//       waveSeed, assigns each particle a target floor position.
//       Walls are EXPECTED to be cleared by the caller after this
//       returns — particles are independent of wall meshes.
//
//   tickDissolve(dt)
//     → advance animation. Returns true while still active, false
//       when finished (caller should advance to next wave on false).
//
//   cancelDissolve()
//     → immediately dispose particles, abort any in-flight animation.
//
//   isDissolveActive() — true between startDissolve and the moment
//     tickDissolve returns false.
//
// Performance: single InstancedMesh = 1 draw call regardless of
// particle count. Per-frame cost is N matrix updates where N is the
// active particle count (target is < 800).

import * as THREE from 'three';
import { scene } from './scene.js';
import { generateAutoglyph, forEachCell, countFilled } from './autoglyph.js';

// =====================================================================
// CONSTANTS
// =====================================================================

const MAX_PARTICLES = 1024;          // hard cap on instance count

// Phase timings (cumulative from t=0).
const PHASE_EXPLODE_END = 0.3;
const PHASE_FLY_END     = 1.5;
const PHASE_DISPLAY_END = 3.5;
const PHASE_SINK_END    = 4.5;       // total animation length

// Glyph display patch — the autoglyph is mapped onto a square area
// of this size (world units), centered at arena origin (0, 0).
// 30u = roughly the central third of the 100×100 arena. Big enough
// to read at glance, small enough to leave the player some breathing
// room around it.
const GLYPH_PATCH_SIZE = 30.0;
const GLYPH_PATCH_HALF = GLYPH_PATCH_SIZE * 0.5;
const GLYPH_GRID_DIM = 64;           // matches autoglyph.js GRID_DIM
const GLYPH_FLOOR_Y = 0.05;          // particle rest height on floor

// Particle dimensions.
const PARTICLE_SIZE = 0.18;          // cube edge in world units

// Cap glyph cells we'll actually render. A dense OVERLAPPED scheme
// can hit 1900 filled cells — way more than we want to render.
// We sample down to this cap with a stable hash.
const MAX_GLYPH_CELLS = 800;

// =====================================================================
// STATE
// =====================================================================

let _instancedMesh = null;           // THREE.InstancedMesh
let _instanceMaterial = null;
let _particles = [];                 // CPU-side per-particle state
let _phaseT = 0;                     // seconds since startDissolve
let _active = false;
let _scratchMatrix = new THREE.Matrix4();
let _scratchQuat = new THREE.Quaternion();
let _scratchPos = new THREE.Vector3();
let _scratchScale = new THREE.Vector3();

// =====================================================================
// PUBLIC API
// =====================================================================

/**
 * Begin the dissolve animation.
 *
 * @param {Array<{x,z,w,h}>} walls   wall AABBs from mazeRenderer.getMazeWallEntries()
 * @param {number} waveSeed          seed for autoglyph generation
 *                                   (typically waveNum * some prime)
 */
export function startDissolve(walls, waveSeed) {
  cancelDissolve();   // idempotent — clear any prior animation

  // No walls? Skip the dissolve entirely; caller will advance
  // immediately. (Could happen on a malformed wave config.)
  if (!walls || walls.length === 0) {
    _active = false;
    return;
  }

  // Generate the autoglyph. Use waveSeed * prime for variation across
  // waves. The autoglyph module is deterministic — same seed always
  // produces the same glyph.
  const glyph = generateAutoglyph(waveSeed * 2654435761 + 1);
  const cellCount = countFilled(glyph);

  // Sample glyph cells down to MAX_GLYPH_CELLS if it's a dense scheme.
  // We collect all filled cells, then if there are too many, keep
  // every Nth one (stride = ceil(cellCount / MAX_GLYPH_CELLS)).
  const allCells = [];
  forEachCell(glyph, (gx, gy, sym) => {
    allCells.push({ gx, gy, sym });
  });
  const stride = Math.max(1, Math.ceil(cellCount / MAX_GLYPH_CELLS));
  const usedCells = [];
  for (let i = 0; i < allCells.length; i += stride) {
    usedCells.push(allCells[i]);
  }

  // Spawn one particle per used cell. Each particle:
  //   - origin: a random point inside a randomly-chosen wall AABB
  //   - target: cell position mapped to the floor patch
  //   - delay:  staggered 0-0.3s flight start so particles don't
  //             move in lockstep
  _particles.length = 0;
  for (let i = 0; i < usedCells.length; i++) {
    const cell = usedCells[i];
    // Random origin inside a randomly-picked wall.
    const wall = walls[Math.floor(Math.random() * walls.length)];
    const ox = wall.x + (Math.random() - 0.5) * wall.w;
    const oy = 0.4 + Math.random() * 1.0;       // anywhere in wall height
    const oz = wall.z + (Math.random() - 0.5) * wall.h;
    // Target — autoglyph cell mapped to floor patch. Center the
    // patch at arena origin. Y is GLYPH_FLOOR_Y (just above the floor
    // so particles z-fight is avoided).
    const tx = ((cell.gx + 0.5) / GLYPH_GRID_DIM) * GLYPH_PATCH_SIZE - GLYPH_PATCH_HALF;
    const tz = ((cell.gy + 0.5) / GLYPH_GRID_DIM) * GLYPH_PATCH_SIZE - GLYPH_PATCH_HALF;
    // Random outward velocity for the explode phase. Direction is
    // away from the wall center (pushed outward by the explosion);
    // magnitude tuned so particles travel ~1-2u during the 0.3s
    // explode window before the fly phase takes over.
    const dirX = ox - wall.x;
    const dirZ = oz - wall.z;
    const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
    const speed = 4 + Math.random() * 6;
    _particles.push({
      ox, oy, oz,                                // origin (start position)
      tx, ty: GLYPH_FLOOR_Y, tz,                 // target (glyph cell on floor)
      // Current position — initially equals origin, updated each tick.
      px: ox, py: oy, pz: oz,
      // Explode velocity — pushed outward from wall center, plus
      // random vertical kick so particles puff up a bit.
      vx: (dirX / dirLen) * speed + (Math.random() - 0.5) * 2,
      vy: 2 + Math.random() * 4,
      vz: (dirZ / dirLen) * speed + (Math.random() - 0.5) * 2,
      delay: Math.random() * 0.3,                // flight start delay
      // For the display-phase glow pulse — random phase offset so
      // not all particles pulse in unison.
      pulsePhase: Math.random() * Math.PI * 2,
    });
  }

  // Build the InstancedMesh. Black material with a faint emissive
  // so each particle reads as a solid black mark on the white floor
  // (matches the autoglyph aesthetic from your reference images).
  _buildInstancedMesh(_particles.length);

  _phaseT = 0;
  _active = true;
}

export function tickDissolve(dt) {
  if (!_active) return false;
  _phaseT += dt;

  // Animation phases drive each particle's transform per frame.
  for (let i = 0; i < _particles.length; i++) {
    _stepParticle(_particles[i], _phaseT, dt);
  }

  // Push transforms to the InstancedMesh.
  _writeInstanceMatrices();

  // Display-phase pulse — adjust whole-mesh emissive intensity so
  // the glyph "breathes" on the floor.
  if (_instanceMaterial) {
    if (_phaseT > PHASE_FLY_END && _phaseT < PHASE_DISPLAY_END) {
      const t = (_phaseT - PHASE_FLY_END) / (PHASE_DISPLAY_END - PHASE_FLY_END);
      // Stronger emissive in the middle of display, softer at edges.
      const pulse = Math.sin(t * Math.PI);
      _instanceMaterial.emissiveIntensity = 0.25 + pulse * 0.45;
    } else if (_phaseT >= PHASE_DISPLAY_END) {
      // During sink, fade emissive out.
      const t = Math.min(1, (_phaseT - PHASE_DISPLAY_END) /
                        (PHASE_SINK_END - PHASE_DISPLAY_END));
      _instanceMaterial.emissiveIntensity = 0.25 * (1 - t);
      _instanceMaterial.opacity = 1 - t;
    } else {
      _instanceMaterial.emissiveIntensity = 0.18;
      _instanceMaterial.opacity = 1;
    }
  }

  if (_phaseT >= PHASE_SINK_END) {
    cancelDissolve();
    return false;
  }
  return true;
}

export function cancelDissolve() {
  if (_instancedMesh) {
    if (_instancedMesh.parent) _instancedMesh.parent.remove(_instancedMesh);
    if (_instancedMesh.geometry) _instancedMesh.geometry.dispose();
  }
  if (_instanceMaterial) {
    _instanceMaterial.dispose();
  }
  _instancedMesh = null;
  _instanceMaterial = null;
  _particles.length = 0;
  _phaseT = 0;
  _active = false;
}

export function isDissolveActive() {
  return _active;
}

// =====================================================================
// INTERNAL — PARTICLE STEP
// =====================================================================

/**
 * Update one particle's position based on the current phase.
 * Reads `phaseT` (seconds since dissolve start) to pick which sub-
 * animation governs the particle.
 */
function _stepParticle(p, phaseT, dt) {
  // Effective time for this particle (after its delay).
  const effT = phaseT - p.delay;

  if (effT < 0) {
    // Still waiting — particle stays at origin.
    p.px = p.ox; p.py = p.oy; p.pz = p.oz;
    return;
  }

  if (effT < PHASE_EXPLODE_END) {
    // Ballistic explode — apply velocity with gravity + drag.
    p.vy -= 9.8 * dt;                       // gravity
    const drag = Math.pow(0.92, dt * 60);   // ~92% velocity retained per frame at 60fps
    p.vx *= drag; p.vy *= drag; p.vz *= drag;
    p.px += p.vx * dt;
    p.py += p.vy * dt;
    p.pz += p.vz * dt;
    if (p.py < GLYPH_FLOOR_Y) p.py = GLYPH_FLOOR_Y;  // don't sink below floor
  } else if (effT < PHASE_FLY_END) {
    // Smooth-step from current position toward target. Use a fresh
    // origin captured at fly-start so explode endpoints transition
    // smoothly without a position snap.
    if (!p._flyOrigCaptured) {
      p._fox = p.px; p._foy = p.py; p._foz = p.pz;
      p._flyOrigCaptured = true;
    }
    const t01 = (effT - PHASE_EXPLODE_END) /
                (PHASE_FLY_END - PHASE_EXPLODE_END);
    // Smoothstep: 3t² - 2t³, eases in and out.
    const e = t01 * t01 * (3 - 2 * t01);
    p.px = p._fox + (p.tx - p._fox) * e;
    // Y: arc up slightly mid-flight then down to target. Adds a sense
    // of grace to the convergence — particles arc up over the floor
    // before settling, like leaves drifting down.
    const arcY = p._foy + (p.ty - p._foy) * e + Math.sin(t01 * Math.PI) * 1.5;
    p.py = arcY;
    p.pz = p._foz + (p.tz - p._foz) * e;
  } else if (effT < PHASE_DISPLAY_END) {
    // Settled on the floor — hold target position. Add a tiny
    // vertical jitter from the pulse phase so the glyph isn't
    // perfectly flat-static.
    p.px = p.tx;
    p.pz = p.tz;
    const wobble = Math.sin(phaseT * 3 + p.pulsePhase) * 0.012;
    p.py = GLYPH_FLOOR_Y + wobble;
  } else {
    // Sink phase — y drops linearly, x/z hold.
    const t01 = Math.min(1, (effT - PHASE_DISPLAY_END) /
                         (PHASE_SINK_END - PHASE_DISPLAY_END));
    p.px = p.tx;
    p.pz = p.tz;
    p.py = GLYPH_FLOOR_Y - t01 * 1.0;       // sink 1u into floor
  }
}

// =====================================================================
// INTERNAL — INSTANCED MESH
// =====================================================================

function _buildInstancedMesh(count) {
  // Single shared cube geometry — cheap.
  const geom = new THREE.BoxGeometry(PARTICLE_SIZE, PARTICLE_SIZE, PARTICLE_SIZE);
  // Black material with very faint emissive — reads as solid black
  // marks on the white floor, with just enough glow to register as
  // "energetic" during display.
  _instanceMaterial = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0x222244,           // tiny cool-blue glow tint
    emissiveIntensity: 0.18,
    roughness: 0.85,
    metalness: 0.10,
    transparent: true,
    opacity: 1.0,
  });
  _instancedMesh = new THREE.InstancedMesh(geom, _instanceMaterial, count);
  _instancedMesh.castShadow = false;
  _instancedMesh.receiveShadow = false;
  _instancedMesh.frustumCulled = false;     // particles span the arena
  scene.add(_instancedMesh);
}

function _writeInstanceMatrices() {
  if (!_instancedMesh) return;
  for (let i = 0; i < _particles.length; i++) {
    const p = _particles[i];
    _scratchPos.set(p.px, p.py, p.pz);
    _scratchQuat.set(0, 0, 0, 1);
    _scratchScale.set(1, 1, 1);
    _scratchMatrix.compose(_scratchPos, _scratchQuat, _scratchScale);
    _instancedMesh.setMatrixAt(i, _scratchMatrix);
  }
  _instancedMesh.instanceMatrix.needsUpdate = true;
}
