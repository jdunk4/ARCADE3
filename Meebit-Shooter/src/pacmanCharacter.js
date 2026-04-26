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

// ---- 3D POP-UP CYCLE ------------------------------------------------
// Periodically Pac-Man rises off the floor as a 3D ball, hovers above
// the player like the Galaga ship, then descends back into a fresh
// floor cell as a flat sprite. This is purely cosmetic — Pac-Man
// doesn't eat pellets or ghosts during the 3D phase. Reads as the
// chapter mascot "showing off."
const HOVER_ALTITUDE = 4.0;        // Y offset above floor while hovering
const RISE_DURATION = 1.0;         // seconds to lift from floor to hover
const HOVER_DURATION = 6.0;        // seconds spent hovering above player
const DESCEND_DURATION = 1.0;      // seconds to fall back to floor
const FLAT_BETWEEN_RISES = 30.0;   // seconds in flat mode between 3D pop-ups
const FIRST_RISE_DELAY = 35.0;     // seconds after landing before first rise
const HOVER_LERP_SPEED = 1.8;      // how aggressively ball follows player (Galaga ship-ish)

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

// ---- Glow halo (matching ghost halo style) -------------------------
// Additive yellow radial gradient. Same texture cached and used by
// _buildPacmanVisuals — opacity controlled per-frame in updatePacman
// based on phase. Visible only during 3D pop-up phases.
const PACMAN_HALO_SIZE = PACMAN_RADIUS * 4.5;
const _pacmanHaloGeo = new THREE.PlaneGeometry(PACMAN_HALO_SIZE, PACMAN_HALO_SIZE);
let _pacmanHaloTexCache = null;
function _getPacmanHaloTexture() {
  if (_pacmanHaloTexCache) return _pacmanHaloTexCache;
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(
    SIZE * 0.5, SIZE * 0.5, 0,
    SIZE * 0.5, SIZE * 0.5, SIZE * 0.5,
  );
  grad.addColorStop(0.00, 'rgba(255,255,255,1.0)');
  grad.addColorStop(0.30, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  _pacmanHaloTexCache = tex;
  return tex;
}

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

  // ---- Face features for the 3D ball ----
  // Match the reference image: yellow body, big black mouth wedge cut
  // out of the +X face, black eye on the upper-front. We don't want
  // to do CSG (booleans on a sphere are heavy). Instead we attach two
  // child meshes:
  //   - A black "mouth" disc on the +X face that LOOKS like a cut-out
  //     when viewed from above/front. It's a flat cap pushed slightly
  //     into the body so its edge reads as a hard line.
  //   - A small black sphere for the eye on the upper-front.
  const _faceBlackMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
  });
  // Mouth — wedge-shaped CircleGeometry segment, oriented to face +X.
  // Using a partial circle (theta 0 → ~70°) gives a visible wedge.
  const MOUTH_OPEN = Math.PI * 0.40;                  // half-angle of the open wedge
  const mouthGeo = new THREE.CircleGeometry(
    PACMAN_RADIUS * 0.96,
    24,
    -MOUTH_OPEN,
    MOUTH_OPEN * 2,
  );
  const mouthMesh = new THREE.Mesh(mouthGeo, _faceBlackMat);
  mouthMesh.rotation.y = Math.PI / 2;                 // face the +X direction
  mouthMesh.position.x = PACMAN_RADIUS * 0.04;        // tiny push outward to avoid z-fight
  ballMesh.add(mouthMesh);
  ballMesh.userData.mouth = mouthMesh;
  // Eyes — TWO large black spheres on the upper-front face, left + right.
  // Bigger and paired so they read clearly at distance and through the
  // chapter tint. Positioned above the mouth wedge.
  const eyeGeo = new THREE.SphereGeometry(PACMAN_RADIUS * 0.16, 12, 10);
  const eyeRight = new THREE.Mesh(eyeGeo, _faceBlackMat);
  eyeRight.position.set(PACMAN_RADIUS * 0.42, PACMAN_RADIUS * 0.58,  PACMAN_RADIUS * 0.30);
  ballMesh.add(eyeRight);
  ballMesh.userData.eye = eyeRight;
  const eyeLeft = new THREE.Mesh(eyeGeo, _faceBlackMat);
  eyeLeft.position.set( PACMAN_RADIUS * 0.42, PACMAN_RADIUS * 0.58, -PACMAN_RADIUS * 0.30);
  ballMesh.add(eyeLeft);
  ballMesh.userData.eyeLeft = eyeLeft;

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

  // Halo — additive yellow glow that follows the 3D ball during pop-up.
  // Matches the ghost glow style. Hidden during flat WANDERING mode;
  // fades in during RISING, full pulse during HOVERING, fades out
  // during DESCENDING. Attached as child of ballMesh so it tracks
  // automatically.
  const haloMat = new THREE.MeshBasicMaterial({
    map: _getPacmanHaloTexture(),
    color: 0xffeb3b,                        // bright yellow
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const haloMesh = new THREE.Mesh(_pacmanHaloGeo, haloMat);
  haloMesh.rotation.x = -Math.PI / 2;
  ballMesh.add(haloMesh);
  ballMesh.userData.halo = haloMesh;
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
// Constants for the intro hover sequence. When spawnPacman is called
// with a playerPos, the ball appears at INTRO_ALTITUDE directly above
// the player and spins in place for INTRO_DURATION before diving into
// the standard FALLING phase. Lets the player see what's coming
// rather than having to walk to a corner to discover it.
const INTRO_ALTITUDE = 22.0;
const INTRO_DURATION = 1.5;

export function spawnPacman(playerPos) {
  if (_pacman) return;
  const built = _buildPacmanVisuals();
  // If we have the player's position, do the intro flyover: spawn
  // directly above them, hover, then dive. Otherwise fall back to
  // the original random-cell drop.
  let startX, startZ;
  let phase = 'FALLING';
  if (playerPos && typeof playerPos.x === 'number') {
    startX = _snapToGrid(playerPos.x);
    startZ = _snapToGrid(playerPos.z);
    built.ballMesh.position.set(startX, INTRO_ALTITUDE, startZ);
    phase = 'INTRO_HOVER';
  } else {
    startX = _snapToGrid((Math.random() * 2 - 1) * (ARENA - 12));
    startZ = _snapToGrid(-(Math.random() * (ARENA - 12)));
    built.ballMesh.position.set(startX, SPAWN_ALTITUDE, startZ);
  }
  built.spriteMesh.position.set(startX, 0.08, startZ);
  scene.add(built.ballMesh);
  scene.add(built.spriteMesh);
  _pacman = {
    ballMesh: built.ballMesh,
    spriteMesh: built.spriteMesh,
    spriteCanvas: built.spriteCanvas,
    spriteTex: built.spriteTex,
    phase,
    t: 0,
    fallStartY: phase === 'INTRO_HOVER' ? INTRO_ALTITUDE : SPAWN_ALTITUDE,
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

/**
 * Trigger run-away exit. Called at end of wave 3 (chapter 4) so Pac-Man
 * peaces out before the boss/bonus waves rather than just disappearing.
 *
 * If currently in 3D pop-up phases (RISING/HOVERING/DESCENDING), the
 * ball descends quickly first to flat-sprite mode at the current XZ.
 * Then Pac-Man heads in a straight line toward the nearest arena edge,
 * fading out and despawning when complete.
 *
 * Idempotent — calling twice in a row only triggers once.
 */
export function runAwayPacman() {
  if (!_pacman || _pacman.phase === 'EXITING') return;
  // Force descent to flat sprite if currently 3D — instant snap (no
  // descent animation needed since the run-away animation will do its
  // own fade).
  _pacman.ballMesh.visible = false;
  if (_pacman.ballMesh.userData.halo) {
    _pacman.ballMesh.userData.halo.material.opacity = 0;
  }
  _pacman.spriteMesh.visible = true;
  _pacman.spriteMesh.position.y = 0.08;
  // Pick exit direction — toward the nearest arena edge along the
  // larger axis component of current position.
  const px = _pacman.spriteMesh.position.x;
  const pz = _pacman.spriteMesh.position.z;
  if (Math.abs(px) > Math.abs(pz)) {
    _pacman.exitDirX = Math.sign(px) || 1;
    _pacman.exitDirZ = 0;
  } else {
    _pacman.exitDirX = 0;
    _pacman.exitDirZ = Math.sign(pz) || 1;
  }
  // Make sprite material transparent so opacity fade works.
  if (_pacman.spriteMesh.material) {
    _pacman.spriteMesh.material.transparent = true;
  }
  _pacman.phase = 'EXITING';
  _pacman.exitTimer = 0;
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

  // EXITING — run-away animation overrides all other phases. Pac-Man
  // sprite slides toward the nearest arena edge at boosted speed, fades
  // out, and despawns when EXIT_DURATION is up.
  if (p.phase === 'EXITING') {
    const EXIT_DURATION = 1.6;
    const EXIT_SPEED = 16;          // u/sec — about 4× normal walk speed
    p.exitTimer += dt;
    p.spriteMesh.position.x += p.exitDirX * EXIT_SPEED * dt;
    p.spriteMesh.position.z += p.exitDirZ * EXIT_SPEED * dt;
    // Rotate sprite to face exit direction (mouth chomps "forward").
    const targetZRot = Math.atan2(-p.exitDirZ, p.exitDirX);
    let delta = targetZRot - p.spriteMesh.rotation.z;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    p.spriteMesh.rotation.z += delta * (1 - Math.exp(-12 * dt));
    // Fade opacity over EXIT_DURATION
    p.spriteMesh.material.opacity = Math.max(0, 1 - p.exitTimer / EXIT_DURATION);
    // Mouth keeps chomping — adds urgency to the run-away.
    const chomp = Math.abs(Math.sin(p.chompPhase));
    const mouthAngle = chomp * 0.55;
    _drawPacmanSprite(p.spriteCanvas, mouthAngle);
    p.spriteTex.needsUpdate = true;
    if (p.exitTimer >= EXIT_DURATION) {
      despawnPacman();
    }
    return;
  }

  if (p.phase === 'INTRO_HOVER') {
    // Cinematic intro: pacman hovers directly above player and spins
    // so the threat is visible. After INTRO_DURATION it transitions
    // to FALLING and dives down to the floor.
    p.ballMesh.position.y = INTRO_ALTITUDE + Math.sin(p.t * 4) * 0.6;
    p.ballMesh.rotation.y += dt * 4.0;             // spin in place
    p.ballMesh.rotation.x = Math.sin(p.t * 3) * 0.2;
    // Halo bright + pulsing during intro for visibility
    const halo = p.ballMesh.userData && p.ballMesh.userData.halo;
    if (halo) {
      const hp = 0.55 + Math.sin(p.t * 6) * 0.25;
      halo.material.opacity = hp;
      halo.scale.setScalar(1.4 + Math.sin(p.t * 5) * 0.12);
    }
    if (p.t >= INTRO_DURATION) {
      p.phase = 'FALLING';
      p.t = 0;
      // Reset rotation so the dive looks clean (mouth pointing down).
      p.ballMesh.rotation.x = 0;
      p.ballMesh.rotation.y = 0;
    }
  } else if (p.phase === 'FALLING') {
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
      // Schedule first 3D pop-up after FIRST_RISE_DELAY of flat play.
      p.popTimer = FIRST_RISE_DELAY;
    }
  } else if (p.phase === 'WANDERING') {
    // Tick the 3D pop-up timer. When it expires, lift off into 3D mode.
    if (p.popTimer != null) {
      p.popTimer -= dt;
      if (p.popTimer <= 0) {
        // Transition: hide flat sprite, show 3D ball, position ball at
        // current cell (floor level), start rising.
        p.spriteMesh.visible = false;
        p.ballMesh.visible = true;
        p.ballMesh.position.set(p.cellX, PACMAN_RADIUS, p.cellZ);
        p.phase = 'RISING';
        p.t = 0;
        return;       // skip rest of WANDERING this frame
      }
    }
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
    if (tryConsumePelletAt(p.spriteMesh.position, 1.4)) {
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
  } else if (p.phase === 'RISING') {
    // 3D ball lifts smoothly from floor (y=PACMAN_RADIUS) to hover
    // altitude. Halo fades in as it rises.
    const f = Math.min(1, p.t / RISE_DURATION);
    const eased = 1 - Math.pow(1 - f, 2);    // ease-out
    p.ballMesh.position.y = PACMAN_RADIUS + (HOVER_ALTITUDE - PACMAN_RADIUS) * eased;
    if (p.ballMesh.userData.halo) {
      p.ballMesh.userData.halo.material.opacity = 0.7 * f;
    }
    if (f >= 1) {
      p.phase = 'HOVERING';
      p.t = 0;
    }
  } else if (p.phase === 'HOVERING') {
    // Ball lerps smoothly toward the player's XZ position at hover
    // altitude. Galaga-ship-style follow with damping. Player position
    // pulled from S.playerPos (set every frame by main.js).
    const px = (S && S.playerPos) ? S.playerPos.x : 0;
    const pz = (S && S.playerPos) ? S.playerPos.z : 0;
    const lerpF = 1 - Math.exp(-HOVER_LERP_SPEED * dt);
    p.ballMesh.position.x += (px - p.ballMesh.position.x) * lerpF;
    p.ballMesh.position.z += (pz - p.ballMesh.position.z) * lerpF;
    // Subtle bob — ±0.18u on top of base hover altitude.
    p.ballMesh.position.y = HOVER_ALTITUDE + Math.sin(p.t * 3) * 0.18;
    // Halo full opacity with subtle pulse.
    if (p.ballMesh.userData.halo) {
      const pulse = 0.55 + 0.30 * (0.5 + 0.5 * Math.sin(p.t * 4));
      p.ballMesh.userData.halo.material.opacity = pulse;
      const sc = 1.0 + 0.10 * (0.5 + 0.5 * Math.sin(p.t * 4));
      p.ballMesh.userData.halo.scale.set(sc, sc, sc);
    }
    if (p.t >= HOVER_DURATION) {
      // Pick a fresh floor cell to descend into. Choose a grid-aligned
      // cell within ~10u of the player so when Pac-Man re-enters the
      // floor he's near the action.
      const targetX = _snapToGrid(px + (Math.random() * 2 - 1) * 8);
      const targetZ = _snapToGrid(pz + (Math.random() * 2 - 1) * 8);
      // Stash descent target on the ball mesh so DESCENDING can lerp.
      p.descendStartX = p.ballMesh.position.x;
      p.descendStartZ = p.ballMesh.position.z;
      p.descendStartY = p.ballMesh.position.y;
      p.descendTargetX = targetX;
      p.descendTargetZ = targetZ;
      // Update grid cell so when DESCENDING completes, WANDERING starts
      // from the new cell.
      p.cellX = targetX;
      p.cellZ = targetZ;
      p.targetCell = { x: targetX, z: targetZ };
      p.moveT = 0;
      p.phase = 'DESCENDING';
      p.t = 0;
    }
  } else if (p.phase === 'DESCENDING') {
    // Smoothly arc from current XYZ to target floor cell over
    // DESCEND_DURATION. Ball slides + drops simultaneously.
    const f = Math.min(1, p.t / DESCEND_DURATION);
    const eased = f * f;     // ease-in: gravity-like fall
    p.ballMesh.position.x = p.descendStartX + (p.descendTargetX - p.descendStartX) * f;
    p.ballMesh.position.z = p.descendStartZ + (p.descendTargetZ - p.descendStartZ) * f;
    p.ballMesh.position.y = p.descendStartY + (PACMAN_RADIUS - p.descendStartY) * eased;
    // Halo fades out as he descends.
    if (p.ballMesh.userData.halo) {
      p.ballMesh.userData.halo.material.opacity = 0.7 * (1 - f);
      p.ballMesh.userData.halo.scale.set(1, 1, 1);
    }
    if (f >= 1) {
      // Touchdown — hide ball, reveal flat sprite at the new cell,
      // resume WANDERING with a fresh popTimer for the next pop-up.
      p.ballMesh.visible = false;
      if (p.ballMesh.userData.halo) p.ballMesh.userData.halo.material.opacity = 0;
      p.spriteMesh.visible = true;
      p.spriteMesh.position.set(p.cellX, 0.08, p.cellZ);
      // Pick a fresh wander direction from the new cell.
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
      p.popTimer = FLAT_BETWEEN_RISES;
    }
  }

  // Animate mouth chomp by redrawing the sprite canvas. Open/close
  // wedge angle oscillates 0 → ~0.55 rad. Only matters during WANDERING
  // (the 3D ball doesn't use the canvas texture).
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
