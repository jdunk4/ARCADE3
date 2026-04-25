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
import { Audio } from './audio.js';
import { tryConsumePelletAt, getNearestActivePellet } from './pacmanPellets.js';
import {
  setGhostsVulnerable,
  tryEatGhostAt,
  getVulnerableGhosts,
  getGhostPos,
} from './hazardsPacman.js';
import { S } from './state.js';

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
// During the FALL phase Pac-Man is a 3D yellow ball (sphere) descending
// from the sky. On LANDING he transitions to a flat 2D sprite oriented
// face-up on the floor, sharing the same plane as the ghosts and pellets
// for visual consistency.

const _ballGeo = new THREE.SphereGeometry(PACMAN_RADIUS, 24, 12);
const _ballMat = new THREE.MeshStandardMaterial({
  color: 0xffeb3b,
  emissive: 0xfdd835,
  emissiveIntensity: 0.6,
  metalness: 0.1,
  roughness: 0.5,
});

// 2D sprite — flat plane lying on the floor with a canvas texture.
// The canvas is redrawn each frame to animate the chomping mouth.
// One canvas per Pac-Man instance (we only ever have one, but cleaner
// to keep it instance-scoped so nothing leaks between plays).
const PACMAN_SPRITE_SIZE = 2.4;       // world units — about a cell
const _spriteGeo = new THREE.PlaneGeometry(PACMAN_SPRITE_SIZE, PACMAN_SPRITE_SIZE);

function _buildSpriteCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  return canvas;
}

// Redraw Pac-Man sprite onto the given canvas with the current chomp
// state. mouthAngle = 0 → mouth fully closed (just a yellow circle).
// mouthAngle = ~0.6 rad → mouth fully open (wedge cut out toward +X).
// The sprite always faces +X in canvas space; the 3D plane rotates
// to face the actual movement direction.
function _drawPacmanSprite(canvas, mouthAngle) {
  const ctx = canvas.getContext('2d');
  const SIZE = canvas.width;
  const cx = SIZE * 0.5;
  const cy = SIZE * 0.5;
  const r = SIZE * 0.42;
  ctx.clearRect(0, 0, SIZE, SIZE);
  // Body — yellow circle with mouth wedge cut. Mouth opens to the right
  // (+X in canvas space); the 3D plane rotates to face direction.
  ctx.fillStyle = '#ffeb3b';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.beginPath();
  // Arc covers everything EXCEPT the mouth wedge. Mouth wedge spans
  // -mouthAngle to +mouthAngle around the +X direction.
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, mouthAngle, Math.PI * 2 - mouthAngle, false);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Eye — small black dot on the upper side (canvas y is flipped, so
  // upper = lower y).
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(cx - r * 0.15, cy - r * 0.5, SIZE * 0.04, 0, Math.PI * 2);
  ctx.fill();
}

// ---- State ----------------------------------------------------------

let _pacman = null;
// Each Pac-Man entry holds:
//   ballMesh:   3D sphere shown during FALLING phase
//   spriteMesh: 2D plane lying on floor shown during WANDERING phase
//   spriteTex:  CanvasTexture wrapping the sprite canvas — redrawn each
//               frame for chomp animation
//   spriteCanvas: backing canvas for the texture
//   facing:     direction index into DIRECTIONS
//   phase:      'FALLING' | 'WANDERING'
//   t:          seconds elapsed in current phase
//   targetCell: { x, z } — next grid cell Pac-Man is moving toward
//   chompPhase: accumulator for mouth chomp animation
//   cellX/cellZ: current grid-snapped position
//   moveT:      0..1 progress between cellX/Z and targetCell

function _buildPacmanVisuals() {
  // Build 3D ball for fall phase + 2D sprite for floor phase.
  const ballMesh = new THREE.Mesh(_ballGeo, _ballMat);
  // Sprite — canvas-textured plane oriented flat on floor.
  const spriteCanvas = _buildSpriteCanvas();
  _drawPacmanSprite(spriteCanvas, 0);  // initial: mouth closed
  const spriteTex = new THREE.CanvasTexture(spriteCanvas);
  spriteTex.needsUpdate = true;
  const spriteMat = new THREE.MeshBasicMaterial({
    map: spriteTex,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const spriteMesh = new THREE.Mesh(_spriteGeo, spriteMat);
  spriteMesh.rotation.x = -Math.PI / 2;     // lay flat on floor
  spriteMesh.visible = false;               // hidden until landing
  return { ballMesh, spriteMesh, spriteCanvas, spriteTex };
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

function _pickTarget(p) {
  // Priority 1: nearest vulnerable ghost. Pac-Man hunts!
  const vulns = getVulnerableGhosts();
  if (vulns.length > 0) {
    let best = null;
    let bestDist = Infinity;
    for (const g of vulns) {
      const gp = getGhostPos(g);
      if (!gp) continue;
      const dx = gp.x - p.cellX;
      const dz = gp.z - p.cellZ;
      const d = dx * dx + dz * dz;
      if (d < bestDist) { bestDist = d; best = gp; }
    }
    if (best) return { x: best.x, z: best.z };
  }
  // Priority 2: nearest active pellet, but only sometimes (so Pac-Man
  // doesn't beeline to pellets every chapter — feels more natural to
  // wander too). 60% chance to seek pellet at each decision point.
  if (Math.random() < 0.6) {
    const pellet = getNearestActivePellet({ x: p.cellX, z: p.cellZ });
    if (pellet) return pellet;
  }
  // Otherwise: no target, wander.
  return null;
}

function _pickNewDirection(currentIdx, posX, posZ, targetPos) {
  // If we have a target (pellet or vulnerable ghost), strongly bias
  // moves that reduce distance to it. Otherwise, fall back to wander.
  // Build candidate list: continuing same direction, plus left/right.
  // Reversing (180°) is generally not allowed unless we're stuck.
  const continueDir = DIRECTIONS[currentIdx];
  const leftDir = DIRECTIONS[(currentIdx + 3) % 4];
  const rightDir = DIRECTIONS[(currentIdx + 1) % 4];
  const reverseDir = DIRECTIONS[(currentIdx + 2) % 4];

  // For each candidate, score it. Without a target: weight comes from
  // wander preferences. With a target: weight comes from distance
  // reduction (lower is better → invert so higher weight = closer target).
  const cands = [
    { idx: currentIdx,           dir: continueDir },
    { idx: (currentIdx + 3) % 4, dir: leftDir     },
    { idx: (currentIdx + 1) % 4, dir: rightDir    },
  ];
  if (targetPos) {
    // Hunt/pellet-seek mode — also allow reverse if it gets us closer.
    cands.push({ idx: (currentIdx + 2) % 4, dir: reverseDir });
  }

  const valid = [];
  for (const c of cands) {
    const nx = posX + c.dir.x * CELL_SIZE;
    const nz = posZ + c.dir.z * CELL_SIZE;
    if (!_isCellValid(nx, nz)) continue;
    let w;
    if (targetPos) {
      // Score by distance reduction — closer to target gets higher weight.
      const tx = targetPos.x, tz = targetPos.z;
      const curDistSq = (tx - posX) * (tx - posX) + (tz - posZ) * (tz - posZ);
      const newDistSq = (tx - nx) * (tx - nx) + (tz - nz) * (tz - nz);
      // Strong preference for moving closer; weak penalty for moving away.
      // Map "closer by 1 cell" to ~3x weight, "farther by 1 cell" to 0.3x.
      const delta = curDistSq - newDistSq;
      w = Math.max(0.05, 1.0 + delta * 0.005);
      if (c.idx === currentIdx) w *= 1.3;     // mild straight-line preference
    } else {
      // Wander mode — original weighting.
      if (c.idx === currentIdx) w = 1.0 - TURN_PROB;
      else w = TURN_PROB * 0.5;
      if (_isInsideSafeZone(nx, nz)) w *= 0.1;
    }
    valid.push({ idx: c.idx, dir: c.dir, weight: w });
  }
  if (valid.length === 0) {
    const nx = posX + reverseDir.x * CELL_SIZE;
    const nz = posZ + reverseDir.z * CELL_SIZE;
    if (_isCellValid(nx, nz)) {
      return { idx: (currentIdx + 2) % 4, dir: reverseDir };
    }
    return { idx: currentIdx, dir: continueDir };
  }
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
  const built = _buildPacmanVisuals();
  // Initial spawn position: a random cell in the upper half of the arena
  // so the drop is visible to the camera. Snap to grid.
  const startX = _snapToGrid((Math.random() * 2 - 1) * (ARENA - 12));
  const startZ = _snapToGrid(-(Math.random() * (ARENA - 12)));
  built.ballMesh.position.set(startX, SPAWN_ALTITUDE, startZ);
  built.spriteMesh.position.set(startX, 0.08, startZ);
  scene.add(built.ballMesh);
  scene.add(built.spriteMesh);
  _pacman = {
    ballMesh: built.ballMesh,
    spriteMesh: built.spriteMesh,
    spriteCanvas: built.spriteCanvas,
    spriteTex: built.spriteTex,
    phase: 'FALLING',
    t: 0,
    fallStartY: SPAWN_ALTITUDE,
    fallEndY: PACMAN_RADIUS,         // ball rests at this Y when landing
    chompPhase: 0,
    facing: 0,                 // points east initially
    cellX: startX,
    cellZ: startZ,
    targetCell: { x: startX, z: startZ },
    moveT: 0,
  };
}

export function despawnPacman() {
  if (!_pacman) return;
  if (_pacman.ballMesh.parent) scene.remove(_pacman.ballMesh);
  if (_pacman.spriteMesh.parent) scene.remove(_pacman.spriteMesh);
  if (_pacman.spriteTex) _pacman.spriteTex.dispose();
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
    // 3D ball falls from sky. Quadratic ease-in (gravity-like).
    const f = Math.min(1, p.t / FALL_DURATION);
    const eased = f * f;
    const y = p.fallStartY * (1 - eased) + p.fallEndY * eased;
    p.ballMesh.position.y = y;
    if (f >= 1) {
      // Landed. Hide 3D ball, reveal 2D sprite at floor level. From
      // here on Pac-Man is a flat sprite on the floor like the ghosts.
      p.ballMesh.visible = false;
      p.spriteMesh.visible = true;
      // Pick first wandering direction.
      const target = _pickTarget(p);
      const choice = _pickNewDirection(p.facing, p.cellX, p.cellZ, target);
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
      const target = _pickTarget(p);
      const choice = _pickNewDirection(p.facing, p.cellX, p.cellZ, target);
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
    p.spriteMesh.position.set(fx, 0.08, fz);

    // Pellet-eat check
    if (tryConsumePelletAt(p.spriteMesh.position, 1.0)) {
      try {
        setGhostsVulnerable();
        if (Audio.pelletEaten) Audio.pelletEaten();
        if (S) S.score = (S.score || 0) + 50;
      } catch (e) {}
    }

    // Ghost-eat check
    const eaten = tryEatGhostAt(p.spriteMesh.position, 1.1);
    if (eaten) {
      try {
        if (Audio.ghostEaten) Audio.ghostEaten();
        if (S) S.score = (S.score || 0) + 200;
      } catch (e) {}
    }

    // Rotate sprite to face direction. The sprite faces +X by default
    // (mouth wedge cut on the +X side). The plane is laying flat with
    // rotation.x = -PI/2 already; rotation.z spins it around the Y
    // axis (which is the up axis of the lay-flat plane).
    //
    // Direction → Z-rotation map (camera looks down -Y):
    //   east  (+X)  → 0
    //   north (-Z)  → +PI/2
    //   west  (-X)  → +PI
    //   south (+Z)  → -PI/2 (or +3PI/2)
    const dir = DIRECTIONS[p.facing];
    const targetZRot = Math.atan2(-dir.z, dir.x);
    let delta = targetZRot - p.spriteMesh.rotation.z;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    p.spriteMesh.rotation.z += delta * (1 - Math.exp(-12 * dt));
  }

  // Animate mouth chomp by redrawing the sprite canvas. Open/close
  // wedge angle oscillates 0 → ~0.55 rad.
  if (p.phase === 'WANDERING') {
    const chomp = Math.abs(Math.sin(p.chompPhase));
    const mouthAngle = chomp * 0.55;
    _drawPacmanSprite(p.spriteCanvas, mouthAngle);
    p.spriteTex.needsUpdate = true;
  }
}

// Exposed for stage 3 (ghost-targeting, pellet eating).
export function getPacmanPos() {
  return _pacman ? _pacman.group.position : null;
}
