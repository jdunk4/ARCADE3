// 3D Pac-Man character — chapter 4 chapter mascot.
//
// Stage 2: visual presence only. Pac-Man drops from the sky at chapter
// start, then wanders the arena with grid-aligned movement (turns at
// each cell center). Mouth chomps continuously. He doesn't yet interact
// with ghosts, power pellets, or the player — pure aesthetic for now.
//
// Future stages will wire in:
//   - Power-pellet detection + eating
//   - Ghost flee/hunt logic based on power-pellet state
//   - Ghost-eating mechanics
//
// Visual construction:
//   - Two half-sphere meshes (top + bottom) pivoting around the center
//   - Mouth opens by rotating top half up + bottom half down
//   - Yellow color (#ffeb3b) with emissive glow
//   - Mouth always faces the current movement direction
//
// Movement:
//   - Snaps to floor grid (CELL_SIZE = 2.5u)
//   - At each cell center, picks new direction (70% continue, 30% turn)
//   - Constrained to arena bounds and respects SAFE_RADIUS at center
//     (so he doesn't bump into the player spawn area at low frequency)
//   - Speed ~3 cells/sec — faster than ghosts so he can hunt them later

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA } from './config.js';

const CELL_SIZE = 2.5;
const SAFE_RADIUS = 8.0;          // matches hazardsPacman.js — Pac-Man stays out of center
const PACMAN_RADIUS = 1.0;        // sphere radius — about half a cell
const PACMAN_ALTITUDE = 1.0;      // hover height above floor
const SPAWN_ALTITUDE = 15.0;
const FALL_DURATION = 0.9;
const PACMAN_SPEED = 3.0;         // cells/sec (3x ghosts which are 2.0)
const TURN_PROB = 0.35;           // chance to change direction at each cell center
const CHOMP_RATE = 6.0;           // radians/sec (one full open+close cycle ≈ 1s)

// Direction vectors (XZ plane). Order matters: index used for "current"
// and for left/right adjacency in turn-picking.
const DIRECTIONS = [
  { x:  1, z:  0, name: 'east'  },   // 0
  { x:  0, z:  1, name: 'south' },   // 1
  { x: -1, z:  0, name: 'west'  },   // 2
  { x:  0, z: -1, name: 'north' },   // 3
];

// ---- Geometry + materials -------------------------------------------
// Half-sphere geometry: SphereGeometry with thetaLength = π (so it
// covers half the sphere). The default sphere is centered on origin;
// the half-sphere geometry occupies one hemisphere along the Y axis.
// Two of these flipped for top/bottom give us a chomping mouth.

const _topHalfGeo = new THREE.SphereGeometry(
  PACMAN_RADIUS, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2,
);
const _bottomHalfGeo = new THREE.SphereGeometry(
  PACMAN_RADIUS, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2,
);

const _bodyMat = new THREE.MeshStandardMaterial({
  color: 0xffeb3b,
  emissive: 0xfdd835,
  emissiveIntensity: 0.4,
  metalness: 0.1,
  roughness: 0.5,
  side: THREE.DoubleSide,            // mouth interior visible when open
});

// Black eye sphere (Pac-Man has one tiny eye on the side near the top).
const _eyeGeo = new THREE.SphereGeometry(0.13, 8, 8);
const _eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });

// ---- State ----------------------------------------------------------

let _pacman = null;
// Each Pac-Man entry holds:
//   group:        outer scene group (translates to the cell center)
//   topHalf, bottomHalf: child meshes (rotate to chomp)
//   facing:       direction index into DIRECTIONS
//   phase:        'FALLING' | 'WANDERING'
//   t:            seconds elapsed in current phase
//   targetCell:   { x, z } — next grid cell Pac-Man is moving toward
//                 In WANDERING phase, his position interpolates between
//                 (current cell) and targetCell. When he arrives, he
//                 picks a new direction.
//   chompPhase:   accumulator for mouth chomp animation
//   eyePivot:     subgroup that rotates around Y to face movement dir,
//                 with eye attached to it

function _buildPacmanMesh() {
  const group = new THREE.Group();

  // Top half — pivots around its bottom edge (at y=0 in geometry space)
  // so when we rotate up, the cut edge lifts skyward, opening the mouth.
  const topPivot = new THREE.Group();
  group.add(topPivot);
  const topHalf = new THREE.Mesh(_topHalfGeo, _bodyMat);
  topPivot.add(topHalf);

  // Bottom half — same pivot, rotates the other way.
  const bottomPivot = new THREE.Group();
  group.add(bottomPivot);
  const bottomHalf = new THREE.Mesh(_bottomHalfGeo, _bodyMat);
  bottomPivot.add(bottomHalf);

  // Eye — small black sphere on the upper side, slightly forward so it
  // tilts visibly when Pac-Man rotates to face direction. We attach it
  // to the eyePivot which rotates with Pac-Man's heading.
  const eyePivot = new THREE.Group();
  group.add(eyePivot);
  const eye = new THREE.Mesh(_eyeGeo, _eyeMat);
  // Place eye at upper-right relative to facing direction. When eyePivot
  // is rotated to match the heading, the eye stays "on the side."
  eye.position.set(0.0, 0.55, -0.55);
  eyePivot.add(eye);

  return { group, topPivot, bottomPivot, eyePivot };
}

// ---- Direction + grid helpers ---------------------------------------

function _snapToGrid(v) {
  return Math.round(v / CELL_SIZE) * CELL_SIZE;
}

function _isCellValid(x, z) {
  // Out of arena? (matches hazards.js MIN_EDGE_PADDING = 6)
  if (Math.abs(x) > ARENA - 6) return false;
  if (Math.abs(z) > ARENA - 6) return false;
  // In safe zone? Pac-Man can enter the safe zone but it's discouraged
  // since it'd put him on top of the player. We allow it but with low
  // probability (handled by the turn picker below).
  return true;
}

function _isInsideSafeZone(x, z) {
  return (x * x + z * z) < SAFE_RADIUS * SAFE_RADIUS;
}

function _pickNewDirection(currentIdx, posX, posZ) {
  // Build candidate list: continuing same direction has weight TURN_PROB
  // inverted (~65%); each of the two perpendiculars splits the rest.
  // Reversing (180°) is generally not allowed unless we're stuck.
  const continueDir = DIRECTIONS[currentIdx];
  const leftDir = DIRECTIONS[(currentIdx + 3) % 4];
  const rightDir = DIRECTIONS[(currentIdx + 1) % 4];
  const reverseDir = DIRECTIONS[(currentIdx + 2) % 4];

  // Test each direction's next cell for validity. Penalize stepping
  // into the safe zone heavily so Pac-Man tends to stay outside it.
  const cands = [
    { idx: currentIdx,           dir: continueDir, weight: 1.0 - TURN_PROB },
    { idx: (currentIdx + 3) % 4, dir: leftDir,     weight: TURN_PROB * 0.5 },
    { idx: (currentIdx + 1) % 4, dir: rightDir,    weight: TURN_PROB * 0.5 },
  ];
  const valid = [];
  for (const c of cands) {
    const nx = posX + c.dir.x * CELL_SIZE;
    const nz = posZ + c.dir.z * CELL_SIZE;
    if (!_isCellValid(nx, nz)) continue;
    let w = c.weight;
    if (_isInsideSafeZone(nx, nz)) w *= 0.1;
    valid.push({ idx: c.idx, dir: c.dir, weight: w });
  }
  if (valid.length === 0) {
    // Stuck — only option is to reverse.
    const nx = posX + reverseDir.x * CELL_SIZE;
    const nz = posZ + reverseDir.z * CELL_SIZE;
    if (_isCellValid(nx, nz)) {
      return { idx: (currentIdx + 2) % 4, dir: reverseDir };
    }
    // Truly stuck (corner with no exits) — keep current direction.
    return { idx: currentIdx, dir: continueDir };
  }
  // Weighted random selection.
  let total = 0;
  for (const v of valid) total += v.weight;
  let r = Math.random() * total;
  for (const v of valid) {
    r -= v.weight;
    if (r <= 0) return { idx: v.idx, dir: v.dir };
  }
  return { idx: valid[0].idx, dir: valid[0].dir };
}

// ---- Public API -----------------------------------------------------

/**
 * Spawn Pac-Man if not already active. Idempotent — multiple calls
 * during chapter 4 (e.g. from per-wave style apply) are no-ops.
 */
export function spawnPacman() {
  if (_pacman) return;
  const built = _buildPacmanMesh();
  // Initial spawn position: a random cell in the upper half of the arena
  // so the drop is visible to the camera. Snap to grid.
  const startX = _snapToGrid((Math.random() * 2 - 1) * (ARENA - 12));
  const startZ = _snapToGrid(-(Math.random() * (ARENA - 12)));
  built.group.position.set(startX, SPAWN_ALTITUDE, startZ);
  scene.add(built.group);
  _pacman = {
    group: built.group,
    topPivot: built.topPivot,
    bottomPivot: built.bottomPivot,
    eyePivot: built.eyePivot,
    phase: 'FALLING',
    t: 0,
    fallStartY: SPAWN_ALTITUDE,
    fallEndY: PACMAN_ALTITUDE,
    chompPhase: 0,
    facing: 0,                 // points east initially
    cellX: startX,
    cellZ: startZ,
    targetCell: { x: startX, z: startZ },
    moveT: 0,                  // 0..1 progress between cellX/Z and targetCell
  };
}

export function despawnPacman() {
  if (!_pacman) return;
  if (_pacman.group.parent) scene.remove(_pacman.group);
  _pacman = null;
}

export function isPacmanActive() {
  return _pacman != null;
}

/**
 * Per-frame update: drop animation, wander logic, mouth chomp.
 */
export function updatePacman(dt) {
  if (!_pacman) return;
  const p = _pacman;
  p.t += dt;
  p.chompPhase += dt * CHOMP_RATE;

  if (p.phase === 'FALLING') {
    // Quadratic ease-in (gravity-like). Same shape as tetris fall.
    const f = Math.min(1, p.t / FALL_DURATION);
    const eased = f * f;
    const y = p.fallStartY * (1 - eased) + p.fallEndY * eased;
    p.group.position.y = y;
    if (f >= 1) {
      // Landed. Pick first wandering direction.
      const choice = _pickNewDirection(p.facing, p.cellX, p.cellZ);
      p.facing = choice.idx;
      p.targetCell = {
        x: p.cellX + choice.dir.x * CELL_SIZE,
        z: p.cellZ + choice.dir.z * CELL_SIZE,
      };
      p.moveT = 0;
      p.phase = 'WANDERING';
      p.t = 0;
    }
  } else if (p.phase === 'WANDERING') {
    // Move toward targetCell at PACMAN_SPEED cells/sec.
    const distPerSec = PACMAN_SPEED * CELL_SIZE;
    p.moveT += (distPerSec * dt) / CELL_SIZE;
    if (p.moveT >= 1) {
      // Arrived. Snap, pick next direction.
      p.cellX = p.targetCell.x;
      p.cellZ = p.targetCell.z;
      const choice = _pickNewDirection(p.facing, p.cellX, p.cellZ);
      p.facing = choice.idx;
      p.targetCell = {
        x: p.cellX + choice.dir.x * CELL_SIZE,
        z: p.cellZ + choice.dir.z * CELL_SIZE,
      };
      p.moveT = 0;
    }
    // Interpolate position between (cellX, cellZ) and targetCell.
    const fx = p.cellX + (p.targetCell.x - p.cellX) * p.moveT;
    const fz = p.cellZ + (p.targetCell.z - p.cellZ) * p.moveT;
    p.group.position.set(fx, PACMAN_ALTITUDE, fz);
    // Rotate Pac-Man to face direction (around Y axis).
    // DIRECTIONS index → angle: east=0 → 0, south=1 → -π/2, west=2 → π, north=3 → π/2
    const dir = DIRECTIONS[p.facing];
    const targetYaw = Math.atan2(dir.x, dir.z) - Math.PI;   // align mouth to dir
    // Smooth rotate via shortest arc.
    let delta = targetYaw - p.group.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    p.group.rotation.y += delta * (1 - Math.exp(-12 * dt));
    // Match eyePivot to body rotation (stays "on the side").
    p.eyePivot.rotation.y = p.group.rotation.y;
  }

  // Mouth chomp — top half rotates up to ~25°, bottom half rotates down
  // ~25°, oscillating. Closed = 0° (mouth touching). Open = ±0.45 rad.
  // Squared sine gives a smoother open-and-close cycle.
  const chomp = Math.abs(Math.sin(p.chompPhase));
  const angle = chomp * 0.45;
  // Pivots are at the body center; rotate around X-axis to tilt halves.
  p.topPivot.rotation.x = -angle;
  p.bottomPivot.rotation.x = angle;
}

// Exposed for stage 3 (ghost-targeting, pellet eating).
export function getPacmanPos() {
  return _pacman ? _pacman.group.position : null;
}
