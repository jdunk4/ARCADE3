// Minesweeper hazard style — chapter 3 visuals.
//
// Telescoping silver pointers descend from the sky, target a random cell
// in the current ring, "tap" the cell, and reveal it. Each tile has a
// pre-determined hidden state at chapter start:
//   - 10% of cells are bombs    → reveal turns the cell into a flagged
//                                  LETHAL tile (instant kill on player
//                                  contact; planted with a 3D red flag)
//   - 90% of cells are safe     → reveal turns the cell into a regular
//                                  damage tile (standard 10dmg/s tick)
//
// All revealed cells become hazard tiles. Numbers + bomb icons (extra
// warning hints) are reserved for stage 2.
//
// Style interface contract (see hazards.js):
//   - getCellSize()             — 2.5u, matches arena floor grid
//   - cleanup()                 — wipe all in-flight pointers
//   - tickDeliveries(dt)        — advance pointer state machines, return
//                                 completed reveals (each becomes a tile)
//   - tickSpawning(dt, ctx)     — maintain pointer pool, choose new
//                                 targets in the current ring band
//   - managesOwnSpawns = true   — hazards.js skips its drop loop, we
//                                 own pacing internally
//
// Pointer state machine:
//   DESCENDING (~1.0s) — telescoping pole extends down, hand approaches floor
//   TAPPING    (0.3s)  — hand at floor, cell revealed
//   ASCENDING  (~0.8s) — pole retracts; pointer despawns
//
// Hidden mine grid:
//   - Generated lazily on first call to _isBomb (per chapter)
//   - Cleared when chapter changes (via cleanup())
//   - Quantized to grid cells: keys are "x,z" strings of cell-snapped coords
//   - 10% bomb density (BOMB_PROBABILITY)

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA } from './config.js';
import { hitBurst } from './effects.js';
import { Audio } from './audio.js';

const CELL_SIZE = 2.5;

// Tuning knobs.
const POINTER_TARGET_COUNT = 4;        // simultaneous pointers in flight
const RESPAWN_DELAY = 0.4;             // seconds between completion and next spawn attempt
const DESCEND_DURATION = 1.0;
const TAP_DURATION = 0.3;
const ASCEND_DURATION = 0.8;
const SPAWN_ALTITUDE = 14.0;            // y at which pointer enters scene
const TAP_ALTITUDE = 0.3;               // y at which pointer hand touches floor
const SATURATION_FAIL_LIMIT = 8;
const BOMB_PROBABILITY = 0.10;

// ---- Pointer geometry -------------------------------------------------
// Pointer = telescoping pole + small white pointing hand at the tip.
// The pole is built as a single tall cylinder whose Y-scale is animated
// to extend/retract; positioning the cylinder so its top stays at the
// "spawn altitude" while the bottom slides down to TAP_ALTITUDE gives
// the telescoping illusion without nesting multiple cylinders.

const POLE_FULL_LENGTH = SPAWN_ALTITUDE - TAP_ALTITUDE;  // 13.7 units
const POLE_RADIUS_TOP = 0.10;
const POLE_RADIUS_BOTTOM = 0.06;
const POLE_GEO = new THREE.CylinderGeometry(
  POLE_RADIUS_TOP, POLE_RADIUS_BOTTOM, POLE_FULL_LENGTH, 8,
);
const POLE_MAT = new THREE.MeshStandardMaterial({
  color: 0xcccccc,
  emissive: 0x222222,
  emissiveIntensity: 0.4,
  metalness: 0.85,
  roughness: 0.25,
});

// "Hand" = small white box sphere near the tip of the pole, oriented
// pointing downward. Tiny "finger" cylinder protrudes a hair from the
// hand toward the cell. Together they read as a pointing finger.
const HAND_GEO = new THREE.SphereGeometry(0.16, 8, 8);
const HAND_MAT = new THREE.MeshStandardMaterial({
  color: 0xfafafa,
  emissive: 0x202020,
  emissiveIntensity: 0.15,
  metalness: 0.05,
  roughness: 0.5,
});
const FINGER_GEO = new THREE.CylinderGeometry(0.045, 0.045, 0.30, 6);
const FINGER_MAT = new THREE.MeshStandardMaterial({
  color: 0xfafafa,
  emissive: 0x202020,
  emissiveIntensity: 0.15,
  metalness: 0.05,
  roughness: 0.5,
});

// ---- State ------------------------------------------------------------
const _pointers = [];
let _respawnTimer = 0;
let _spawnFailCount = 0;
const _bombMap = new Map();          // "x,z" → bool (true = bomb)
const _revealedCells = new Set();    // "x,z" → already converted to tile

export const managesOwnSpawns = true;

export function getCellSize() {
  return CELL_SIZE;
}

// ---- Helpers ----------------------------------------------------------

function _cellKey(x, z) {
  // Round to grid-half precision (matches the grid snap used at spawn time).
  // CELL_SIZE * 0.5 = 1.25 → keys like "1.25,3.75"
  const sx = Math.round(x / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
  const sz = Math.round(z / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
  return sx + ',' + sz;
}

function _isBomb(x, z) {
  const key = _cellKey(x, z);
  if (!_bombMap.has(key)) {
    _bombMap.set(key, Math.random() < BOMB_PROBABILITY);
  }
  return _bombMap.get(key);
}

function _isAlreadyRevealed(x, z) {
  return _revealedCells.has(_cellKey(x, z));
}

function _markRevealed(x, z) {
  _revealedCells.add(_cellKey(x, z));
}

function _countAdjacentBombs(x, z) {
  // Check all 8 neighbors at one full cell distance. Each neighbor is
  // rolled lazily by _isBomb (random + cached), so the bomb pattern
  // is deterministic per chapter even though we don't pre-generate
  // the entire grid up front.
  const STEP = CELL_SIZE;
  let count = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      if (_isBomb(x + dx * STEP, z + dz * STEP)) count++;
    }
  }
  return count;
}

function _chooseTargetCell(ctx) {
  const ringInner = ctx.ringInner;
  const ringOuter = ctx.ringOuter;
  // Bias toward the player's quadrant so pointer descent + tile placement
  // happens onscreen. Same 70% bias as galaga bugs.
  const px = ctx.playerPos ? ctx.playerPos.x : 0;
  const pz = ctx.playerPos ? ctx.playerPos.z : 0;
  const biasNearPlayer = Math.random() < 0.70;
  const cheb = ringInner + Math.random() * (ringOuter - ringInner);
  let edge;
  if (biasNearPlayer && (Math.abs(px) > 1 || Math.abs(pz) > 1)) {
    if (Math.abs(pz) >= Math.abs(px)) {
      edge = pz > 0 ? 0 : 1;
    } else {
      edge = px > 0 ? 2 : 3;
    }
  } else {
    edge = Math.floor(Math.random() * 4);
  }
  let along;
  if (biasNearPlayer && ctx.playerPos) {
    const playerAlong = (edge === 0 || edge === 1) ? px : pz;
    along = Math.max(-cheb, Math.min(cheb, playerAlong + (Math.random() - 0.5) * 20));
  } else {
    along = (Math.random() * 2 - 1) * cheb;
  }
  let rawX, rawZ;
  if (edge === 0) { rawX = along;  rawZ = cheb; }
  else if (edge === 1) { rawX = along;  rawZ = -cheb; }
  else if (edge === 2) { rawX = cheb;   rawZ = along; }
  else { rawX = -cheb;  rawZ = along; }
  const x = Math.round(rawX / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
  const z = Math.round(rawZ / (CELL_SIZE * 0.5)) * (CELL_SIZE * 0.5);
  if (_isAlreadyRevealed(x, z)) return null;
  const cells = [{ x, z }];
  if (!ctx.validate(cells, x, z)) return null;
  return { cells, originX: x, originZ: z };
}

function _buildPointerMesh() {
  const group = new THREE.Group();
  // Pole — geometry centered on origin, height = POLE_FULL_LENGTH.
  // We translate it up by half-length so its bottom is at y = 0
  // when the group is at world y = 0; later the group position
  // controls overall altitude.
  const pole = new THREE.Mesh(POLE_GEO, POLE_MAT);
  pole.position.y = POLE_FULL_LENGTH * 0.5;
  group.add(pole);
  // Hand — small sphere at the BOTTOM of the pole.
  const hand = new THREE.Mesh(HAND_GEO, HAND_MAT);
  hand.position.y = 0.0;
  hand.scale.set(1.0, 1.2, 1.0);   // taller than wide, reads as "fist"
  group.add(hand);
  // Finger — points DOWN from the hand toward the floor.
  const finger = new THREE.Mesh(FINGER_GEO, FINGER_MAT);
  finger.position.y = -0.20;
  group.add(finger);
  return { group, pole, hand };
}

function _spawnPointer(target) {
  const { group, pole, hand } = _buildPointerMesh();
  // Initial position: group at the target XZ but at SPAWN_ALTITUDE,
  // with pole scaled to ZERO Y (telescoped up) so only the hand is visible
  // at the very top of the spawn point. Animation extends pole back to 1.0.
  group.position.set(target.originX, SPAWN_ALTITUDE, target.originZ);
  pole.scale.y = 0.05;
  pole.position.y = POLE_FULL_LENGTH * 0.025;  // anchor to top of compressed pole
  hand.position.y = -POLE_FULL_LENGTH * 0.05;
  scene.add(group);
  _pointers.push({
    group,
    pole,
    hand,
    target,
    phase: 'DESCENDING',
    t: 0,
  });
  try { Audio.pointerDescend && Audio.pointerDescend(); } catch (e) {}
}

// ---- Public API: tickDeliveries / tickSpawning / cleanup --------------

export function tickSpawning(dt, ctx) {
  if (_pointers.length < POINTER_TARGET_COUNT) {
    _respawnTimer -= dt;
    if (_respawnTimer <= 0) {
      const target = _chooseTargetCell(ctx);
      if (target) {
        _markRevealed(target.originX, target.originZ);
        _spawnPointer(target);
        _respawnTimer = RESPAWN_DELAY;
        _spawnFailCount = 0;
      } else {
        _spawnFailCount++;
        if (_spawnFailCount >= SATURATION_FAIL_LIMIT) {
          ctx.onRingSaturated && ctx.onRingSaturated();
          _spawnFailCount = 0;
        }
        _respawnTimer = 0.15;
      }
    }
  }
}

export function tickDeliveries(dt) {
  const completed = [];
  for (let i = _pointers.length - 1; i >= 0; i--) {
    const p = _pointers[i];
    p.t += dt;
    if (p.phase === 'DESCENDING') {
      // Pole extends from 0% length to 100% length over DESCEND_DURATION,
      // and the hand slides down to where the bottom of the pole is.
      const progress = Math.min(1, p.t / DESCEND_DURATION);
      // Ease-in for a "telescoping reach" feel: pole snaps out fast,
      // then settles. Quadratic ease-out is a reasonable shape.
      const eased = 1 - Math.pow(1 - progress, 2);
      const length = POLE_FULL_LENGTH * eased;
      // Pole is anchored at the TOP — its top stays at world y = SPAWN_ALTITUDE.
      // To keep the top fixed we move pole.position.y by half the length DOWN
      // from where the top is, where the geometry's pivot is at its center.
      // Pole geometry is height POLE_FULL_LENGTH centered on local origin,
      // so we set scale.y = (length / POLE_FULL_LENGTH) and translate
      // pole.position.y = -POLE_FULL_LENGTH/2 + length/2 (to keep top fixed).
      p.pole.scale.y = Math.max(0.05, length / POLE_FULL_LENGTH);
      p.pole.position.y = (POLE_FULL_LENGTH * 0.5) - (POLE_FULL_LENGTH - length) * 0.5;
      // Hand slides DOWN to follow the pole tip.
      p.hand.position.y = -length;
      if (progress >= 1) {
        p.phase = 'TAPPING';
        p.t = 0;
      }
    } else if (p.phase === 'TAPPING') {
      // Brief hover at the cell — small bobbing finger so it reads as
      // "tapping the spot." When tap completes, place the tile.
      p.hand.position.y = -POLE_FULL_LENGTH + Math.sin(p.t * 30) * 0.05;
      if (p.t >= TAP_DURATION) {
        // Reveal the cell. Determine if bomb → lethal flag, else regular tile.
        const lethal = _isBomb(p.target.originX, p.target.originZ);
        // For safe tiles, count adjacent bombs (1-8) so hazards.js can
        // stamp the corresponding number on the tile. Lethal tiles
        // skip the count — they get a flag + bomb icon instead.
        const number = lethal ? null : _countAdjacentBombs(p.target.originX, p.target.originZ);
        completed.push({
          cells: p.target.cells,
          tintHex: lethal ? 0x8a0a0a : 0xffd93d,
          lethal,
          number,
        });
        try { hitBurst(
          { x: p.target.originX, y: 0.3, z: p.target.originZ },
          lethal ? 0xff2020 : 0xffd93d,
          lethal ? 14 : 6,
        ); } catch (e) {}
        // Audio: thunk + low boom hint for bombs, lighter click for safe.
        try {
          if (lethal) Audio.bombFlagPlanted && Audio.bombFlagPlanted();
          else Audio.cellRevealed && Audio.cellRevealed();
        } catch (e) {}
        p.phase = 'ASCENDING';
        p.t = 0;
      }
    } else if (p.phase === 'ASCENDING') {
      const progress = Math.min(1, p.t / ASCEND_DURATION);
      // Reverse of descend — pole retracts from full length back to ~zero,
      // hand slides back up to the spawn point.
      const eased = 1 - Math.pow(progress, 2);
      const length = POLE_FULL_LENGTH * eased;
      p.pole.scale.y = Math.max(0.05, length / POLE_FULL_LENGTH);
      p.pole.position.y = (POLE_FULL_LENGTH * 0.5) - (POLE_FULL_LENGTH - length) * 0.5;
      p.hand.position.y = -length;
      if (progress >= 1) {
        if (p.group.parent) scene.remove(p.group);
        _pointers.splice(i, 1);
      }
    }
  }
  return completed;
}

export function cleanup() {
  for (const p of _pointers) {
    if (p.group.parent) scene.remove(p.group);
  }
  _pointers.length = 0;
  _respawnTimer = 0;
  _spawnFailCount = 0;
  _bombMap.clear();
  _revealedCells.clear();
}

// Stubs for style interface compatibility.
export function chooseSpawnLocation(ringInner, ringOuter, validate) {
  return null;
}
export function spawnDelivery(spot, tintHex) {}
export function getInFlightCount() {
  return _pointers.length;
}
