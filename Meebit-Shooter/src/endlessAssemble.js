// endlessAssemble.js — Wave-start "particles assemble into walls" animation
//
// Per playtester (Ship 3C of 3, "Full" assembly polish): walls don't
// appear instantly when a wave starts. Particles emerge from random
// floor positions across the arena, fly to wall surfaces, and the
// walls materialize (fade in) as the particles converge. Once
// walls are fully visible, the particles dissolve away and the
// player can engage the wave.
//
// Conceptually the inverse of endlessDissolve.js:
//   dissolve = walls → particles → autoglyph on floor → sink
//   assemble = particles emerge from floor → fly to walls → walls
//              materialize → particles fade
//
// Architecture mirrors endlessDissolve.js — same InstancedMesh
// approach, similar particle pool, different animation curves +
// origin/target swap.
//
// Phases:
//   t=0.0       walls created (opacity 0), particles spawn at floor level
//   t=0.0-0.3   particles rise from below floor, spread out
//   t=0.3-1.5   particles fly to wall-surface target positions
//   t=1.0-2.0   walls fade in (opacity 0 → 1, eased)
//   t=1.5-2.0   particles fade out (opacity 1 → 0)
//   t=2.0       done — particles disposed, walls fully visible
//
// API:
//   startAssemble(walls)
//     → spawns particles at scattered floor positions, assigns each
//       to a target on one of the wall surfaces. Walls passed in
//       must already be created in scene with their wall meshes
//       set to opacity 0 (invisible). The assembly tick fades them
//       in.
//
//   tickAssemble(dt) → boolean
//     → advance animation. Returns true while still active, false
//       when the animation has completed.
//
//   cancelAssemble() — abort + dispose particles. Walls are NOT
//                       removed (caller owns them).
//
//   isAssembleActive() — true between startAssemble and the moment
//                        tickAssemble returns false.

import * as THREE from 'three';
import { scene } from './scene.js';

// =====================================================================
// CONSTANTS
// =====================================================================

const MAX_PARTICLES = 1024;

// Phase timings (cumulative seconds from t=0).
const PHASE_RISE_END    = 0.3;
const PHASE_FLY_END     = 1.5;
const PHASE_FADE_END    = 2.0;       // particles fade out + animation done

// Wall fade-in window — walls go from invisible to fully visible over
// this range. Starts halfway through the fly phase so the wall
// "materializes around" the converging particles instead of popping
// in at the end.
const WALL_FADE_START   = 1.0;
const WALL_FADE_END     = 2.0;

const PARTICLES_PER_WALL_UNIT = 1.5; // wall area-proportional particle count
const MIN_PARTICLES_PER_WALL  = 12;
const MAX_PARTICLES_PER_WALL  = 60;

const PARTICLE_SIZE = 0.18;
const SPAWN_FLOOR_Y = -0.4;          // start below floor → rise up

// Spread radius around the arena origin where particles emerge.
// 30u radius covers most of the playable area without going past
// the arena edges.
const SPAWN_SPREAD = 30.0;

// =====================================================================
// STATE
// =====================================================================

let _instancedMesh = null;
let _instanceMaterial = null;
let _particles = [];
let _walls = [];                     // refs to wall mesh groups for fade-in
let _wallMaterials = [];             // flat list of all wall materials
let _phaseT = 0;
let _active = false;
let _scratchMatrix = new THREE.Matrix4();
let _scratchQuat = new THREE.Quaternion();
let _scratchPos = new THREE.Vector3();
let _scratchScale = new THREE.Vector3();

// =====================================================================
// PUBLIC API
// =====================================================================

/**
 * Begin the assembly animation. Walls passed in are expected to be
 * already in the scene as Group objects with a `mesh` field; the
 * tick will lerp their materials' opacity from 0 to 1 over the
 * fade window.
 *
 * @param {Array<{mesh: THREE.Group, x, z, w, h}>} walls
 */
export function startAssemble(walls) {
  cancelAssemble();
  if (!walls || walls.length === 0) {
    _active = false;
    return;
  }

  // Take refs to the wall meshes so we can fade them. Walk each wall
  // group's children to collect every Material — the body uses
  // MeshStandardMaterial, the trim uses MeshBasicMaterial; both
  // need their opacity ramped together.
  _walls = walls.slice();
  _wallMaterials.length = 0;
  for (const wall of _walls) {
    if (!wall.mesh) continue;
    wall.mesh.traverse((node) => {
      if (!node.material) return;
      const arr = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of arr) {
        // Walls are normally opaque — flip transparent on so the
        // fade-in renders correctly. We restore this in the wall
        // mesh builder when the animation finishes (by setting the
        // wall body's transparent back to false), or rely on the
        // builder being aware of the assemble pattern. For now,
        // leave transparent on for the lifetime of the wave —
        // negligible perf impact for ~20 walls.
        m.transparent = true;
        m.opacity = 0;          // start invisible
        m.needsUpdate = true;
        _wallMaterials.push(m);
      }
    });
  }

  // Build per-wall particle counts. Larger walls get more particles
  // (proportional to perimeter area, capped). Total particle count
  // sums across all walls; we cap at MAX_PARTICLES with a stride.
  const wallParticleCounts = _walls.map((wall) => {
    const area = wall.w * wall.h + 4 * (wall.w + wall.h);  // surface-ish
    const n = Math.round(area * PARTICLES_PER_WALL_UNIT);
    return Math.max(MIN_PARTICLES_PER_WALL,
                    Math.min(MAX_PARTICLES_PER_WALL, n));
  });
  let totalCount = 0;
  for (const c of wallParticleCounts) totalCount += c;
  // Apply stride if we'd exceed the cap.
  let stride = 1;
  if (totalCount > MAX_PARTICLES) {
    stride = Math.ceil(totalCount / MAX_PARTICLES);
  }

  // Spawn particles. For each wall, generate its share of particles.
  // Each particle:
  //   - origin: random scattered point in the arena, BELOW the floor
  //   - target: random point on the wall's surface (3D, includes
  //             top/bottom faces so particles arrive across the
  //             whole wall, not just the perimeter)
  //   - delay: 0-0.3s stagger so emergence isn't a wall of bodies
  _particles.length = 0;
  let particleIdx = 0;
  for (let wIdx = 0; wIdx < _walls.length; wIdx++) {
    const wall = _walls[wIdx];
    const want = wallParticleCounts[wIdx];
    for (let i = 0; i < want; i++) {
      particleIdx++;
      if (particleIdx % stride !== 0) continue;     // stride sample-down

      // Origin — a random scatter point on the floor across the arena.
      // Pulls toward the wall location (60% scatter spread + 40%
      // toward wall) so emergence has a directional read but isn't
      // tightly clustered.
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * SPAWN_SPREAD;
      const scatterX = Math.cos(angle) * r;
      const scatterZ = Math.sin(angle) * r;
      const ox = scatterX * 0.6 + wall.x * 0.4;
      const oz = scatterZ * 0.6 + wall.z * 0.4;
      const oy = SPAWN_FLOOR_Y - Math.random() * 0.3;

      // Target — random point ON the wall's surface. We pick a
      // random face (top/bottom/4 sides) then a random point on it.
      // For Ship 3C simplicity: just use a random point WITHIN the
      // wall AABB at any height. The visual reads correctly because
      // particles fade out before the player can scrutinize them.
      const tx = wall.x + (Math.random() - 0.5) * wall.w;
      const ty = 0.2 + Math.random() * 1.3;      // anywhere in wall height
      const tz = wall.z + (Math.random() - 0.5) * wall.h;

      _particles.push({
        ox, oy, oz,
        tx, ty, tz,
        px: ox, py: oy, pz: oz,
        delay: Math.random() * 0.3,
        // For the rise-phase, particles emerge upward; their initial
        // velocity is gentle — the smooth-step in fly phase does the
        // heavy lifting.
        riseTargetY: 0.3 + Math.random() * 0.4,
      });
    }
  }

  _buildInstancedMesh(_particles.length);
  _phaseT = 0;
  _active = true;
}

export function tickAssemble(dt) {
  if (!_active) return false;
  _phaseT += dt;

  for (let i = 0; i < _particles.length; i++) {
    _stepParticle(_particles[i], _phaseT);
  }
  _writeInstanceMatrices();

  // Fade walls in over the wall-fade window. Eased with smoothstep.
  if (_wallMaterials.length > 0) {
    let wallOpacity = 0;
    if (_phaseT >= WALL_FADE_END) {
      wallOpacity = 1;
    } else if (_phaseT > WALL_FADE_START) {
      const t01 = (_phaseT - WALL_FADE_START) / (WALL_FADE_END - WALL_FADE_START);
      wallOpacity = t01 * t01 * (3 - 2 * t01);
    }
    for (const m of _wallMaterials) {
      m.opacity = wallOpacity;
    }
  }

  // Fade particles out in the final 0.5s so they don't pop off
  // suddenly when the animation ends.
  if (_instanceMaterial) {
    if (_phaseT > PHASE_FLY_END) {
      const t01 = Math.min(1, (_phaseT - PHASE_FLY_END) /
                           (PHASE_FADE_END - PHASE_FLY_END));
      _instanceMaterial.opacity = 1 - t01;
    } else {
      _instanceMaterial.opacity = 1;
    }
  }

  if (_phaseT >= PHASE_FADE_END) {
    // Animation done. Walls are fully visible — restore them to
    // opaque rendering by flipping transparent off + opacity 1.
    for (const m of _wallMaterials) {
      m.transparent = false;
      m.opacity = 1;
      m.needsUpdate = true;
    }
    cancelAssemble();
    return false;
  }
  return true;
}

export function cancelAssemble() {
  if (_instancedMesh) {
    if (_instancedMesh.parent) _instancedMesh.parent.remove(_instancedMesh);
    if (_instancedMesh.geometry) _instancedMesh.geometry.dispose();
  }
  if (_instanceMaterial) _instanceMaterial.dispose();
  _instancedMesh = null;
  _instanceMaterial = null;
  _particles.length = 0;
  _walls.length = 0;
  _wallMaterials.length = 0;
  _phaseT = 0;
  _active = false;
}

export function isAssembleActive() {
  return _active;
}

// =====================================================================
// INTERNAL — PARTICLE STEP
// =====================================================================

function _stepParticle(p, phaseT) {
  const effT = phaseT - p.delay;

  if (effT < 0) {
    // Pre-delay — hold below the floor at origin.
    p.px = p.ox; p.py = p.oy; p.pz = p.oz;
    return;
  }

  if (effT < PHASE_RISE_END) {
    // Rise phase — emerge from below the floor up to riseTargetY.
    // Eased with smoothstep so it doesn't feel like a flat lift.
    const t01 = effT / PHASE_RISE_END;
    const e = t01 * t01 * (3 - 2 * t01);
    p.px = p.ox;
    p.py = p.oy + (p.riseTargetY - p.oy) * e;
    p.pz = p.oz;
  } else if (effT < PHASE_FLY_END) {
    // Fly phase — converge on target. Capture rise endpoint as the
    // fly origin so there's no position snap.
    if (!p._flyOrigCaptured) {
      p._fox = p.px; p._foy = p.py; p._foz = p.pz;
      p._flyOrigCaptured = true;
    }
    const t01 = (effT - PHASE_RISE_END) /
                (PHASE_FLY_END - PHASE_RISE_END);
    const e = t01 * t01 * (3 - 2 * t01);
    p.px = p._fox + (p.tx - p._fox) * e;
    // Y arc — particles arc up over the floor before settling onto
    // the wall surface. Mirrors the dissolve animation's arc for
    // visual consistency.
    const arcY = p._foy + (p.ty - p._foy) * e + Math.sin(t01 * Math.PI) * 1.0;
    p.py = arcY;
    p.pz = p._foz + (p.tz - p._foz) * e;
  } else {
    // Settle on target while fading out (handled in tick via
    // material opacity).
    p.px = p.tx;
    p.py = p.ty;
    p.pz = p.tz;
  }
}

// =====================================================================
// INTERNAL — INSTANCED MESH
// =====================================================================

function _buildInstancedMesh(count) {
  const geom = new THREE.BoxGeometry(PARTICLE_SIZE, PARTICLE_SIZE, PARTICLE_SIZE);
  // Slightly different tint from dissolve particles — assembly uses
  // a cooler emissive (more saturated cyan) to read as "construction
  // energy" vs the dissolve's colder near-black.
  _instanceMaterial = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0x4488dd,
    emissiveIntensity: 0.45,
    roughness: 0.85,
    metalness: 0.10,
    transparent: true,
    opacity: 1.0,
  });
  _instancedMesh = new THREE.InstancedMesh(geom, _instanceMaterial, count);
  _instancedMesh.castShadow = false;
  _instancedMesh.receiveShadow = false;
  _instancedMesh.frustumCulled = false;
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
