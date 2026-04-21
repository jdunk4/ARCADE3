// Floor hazards — tetromino-shaped "lava" patches embedded in the arena
// floor. The player takes damage for standing in one; enemies path around
// them (cheap repulsion in updateEnemies). Count scales with wave number
// within the current chapter and resets each chapter.
//
// Visual: SOLID color matching the chapter theme (orange for Inferno,
// red for Crimson, yellow for Solar, green for Toxic, cyan for Arctic,
// purple for Paradise). No pulse, no overlay, no transparency — just a
// clean flat tile that reads clearly against the dark floor.

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA, CHAPTERS } from './config.js';

// Tetromino footprints — each number is a unit cell offset on the XZ grid.
const TETROMINOES = [
  [[-1.5, 0], [-0.5, 0], [0.5, 0], [1.5, 0]],      // I
  [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]], // O
  [[-1, 0], [0, 0], [1, 0], [0, -1]],              // T
  [[-0.5, -1], [-0.5, 0], [-0.5, 1], [0.5, 1]],    // L
  [[-1, 0.5], [0, 0.5], [0, -0.5], [1, -0.5]],     // S
];

const CELL_SIZE = 1.6;
const SAFE_RADIUS_FROM_CENTER = 7;
const MIN_EDGE_PADDING = 6;
const ENEMY_REPEL_RADIUS = 1.8;
const ENEMY_REPEL_STRENGTH = 2.2;

const hazards = [];

// Shared geometry — one allocation.
const TILE_GEO = new THREE.PlaneGeometry(CELL_SIZE * 0.98, CELL_SIZE * 0.98);

// Material pool — keyed by chapter tint. Solid color, fully opaque.
const _hazardMatCache = new Map();
function getHazardMat(tintHex) {
  let m = _hazardMatCache.get(tintHex);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tintHex,
      side: THREE.DoubleSide,
    });
    _hazardMatCache.set(tintHex, m);
  }
  return m;
}

/**
 * Exposed so prewarm can pre-compile a material per chapter tint, so
 * moving into a new chapter never introduces a first-use compile stall.
 */
export function prewarmHazardMat(tintHex) {
  return getHazardMat(tintHex);
}

function _placeHazard(shape, originX, originZ, rotation, tintHex) {
  const group = new THREE.Group();
  const cells = [];
  const mat = getHazardMat(tintHex);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  for (const [cx, cz] of shape) {
    const rx = cx * cos - cz * sin;
    const rz = cx * sin + cz * cos;
    const wx = originX + rx * CELL_SIZE;
    const wz = originZ + rz * CELL_SIZE;
    const tile = new THREE.Mesh(TILE_GEO, mat);
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(wx, 0.03, wz);
    group.add(tile);
    cells.push({ x: wx, z: wz });
  }

  scene.add(group);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  const pad = CELL_SIZE * 0.5;
  hazards.push({
    group,
    cells,
    bbox: { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad },
  });
}

export function spawnHazardsForWave(chapterIdx, localWave) {
  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  const tint = chapter.full.grid1;
  const target = Math.min(10, localWave * 2);
  let attempts = 0;
  while (hazards.length < target && attempts < target * 10) {
    attempts++;
    const shape = TETROMINOES[Math.floor(Math.random() * TETROMINOES.length)];
    const limit = ARENA - MIN_EDGE_PADDING;
    const x = (Math.random() - 0.5) * 2 * limit;
    const z = (Math.random() - 0.5) * 2 * limit;
    if (x * x + z * z < SAFE_RADIUS_FROM_CENTER * SAFE_RADIUS_FROM_CENTER) continue;
    const rot = [0, Math.PI / 2, Math.PI, -Math.PI / 2][Math.floor(Math.random() * 4)];
    _placeHazard(shape, x, z, rot, tint);
  }
}

export function clearHazards() {
  for (const h of hazards) {
    if (h.group.parent) scene.remove(h.group);
  }
  hazards.length = 0;
}

export function isHazardAt(x, z) {
  const half = CELL_SIZE * 0.49;
  for (const h of hazards) {
    const b = h.bbox;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    for (const c of h.cells) {
      if (Math.abs(x - c.x) < half && Math.abs(z - c.z) < half) return true;
    }
  }
  return false;
}

export function hurtPlayerIfOnHazard(dt, playerPos, S, UI, Audio, shake) {
  if (S.invulnTimer > 0) return false;
  if (!isHazardAt(playerPos.x, playerPos.z)) return false;
  S._hazardTickTimer = (S._hazardTickTimer || 0) - dt;
  S.hp -= 10 * dt;
  if (S._hazardTickTimer <= 0) {
    S._hazardTickTimer = 0.4;
    if (UI && UI.damageFlash) UI.damageFlash();
    if (Audio && Audio.damage) Audio.damage();
    if (shake) shake(0.12, 0.1);
  }
  if (S.hp <= 0) S.hp = 0;
  return true;
}

export function repelEnemyFromHazards(e, dt) {
  for (const h of hazards) {
    const b = h.bbox;
    if (e.pos.x < b.minX - ENEMY_REPEL_RADIUS || e.pos.x > b.maxX + ENEMY_REPEL_RADIUS) continue;
    if (e.pos.z < b.minZ - ENEMY_REPEL_RADIUS || e.pos.z > b.maxZ + ENEMY_REPEL_RADIUS) continue;
    let best = null, bestD = Infinity;
    for (const c of h.cells) {
      const dx = e.pos.x - c.x;
      const dz = e.pos.z - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = c; }
    }
    if (best && bestD < ENEMY_REPEL_RADIUS * ENEMY_REPEL_RADIUS) {
      const d = Math.sqrt(bestD) || 0.001;
      const nx = (e.pos.x - best.x) / d;
      const nz = (e.pos.z - best.z) / d;
      e.pos.x += nx * ENEMY_REPEL_STRENGTH * dt;
      e.pos.z += nz * ENEMY_REPEL_STRENGTH * dt;
    }
  }
}

// No-op — hazards are solid color, no animation. Kept for API compat.
export function updateHazards(dt, timeElapsed) {}
