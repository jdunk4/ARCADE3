import * as THREE from 'three';
import { scene } from './scene.js';
import { BLOCK_CONFIG, MINING_CONFIG, ARENA, CHAPTERS } from './config.js';
import { hitBurst, makePickup } from './effects.js';
import { shake } from './state.js';
import { spawnOre } from './ores.js';

export const blocks = [];     // { mesh, pos, hp, falling, chapter }
export const fallingDebris = [];

// Explosion handler — registered from main.js. Receives the world
// position of the block and the block's theme color. Lets main.js
// (which has the player + enemies + civilians in scope) deal the
// actual AoE damage without blocks.js depending on those modules.
let _explosionHandler = null;
export function registerBlockExplosionHandler(fn) {
  _explosionHandler = fn;
}

const BLOCK_GEO = new THREE.BoxGeometry(BLOCK_CONFIG.size, BLOCK_CONFIG.size, BLOCK_CONFIG.size);
// Per-chapter cached materials — the first block of each chapter used
// to cause a shader-compile stall; now each chapter tint compiles once.
const _blockMatCache = new Map();
const _blockEdgeMatCache = new Map();
const SHADOW_RING_GEO = new THREE.RingGeometry(BLOCK_CONFIG.size * 0.5, BLOCK_CONFIG.size * 0.7, 16);
const SHADOW_MAT = new THREE.MeshBasicMaterial({ color: 0xff2e4d, transparent: true, opacity: 0.6, side: THREE.DoubleSide });

function _getBlockMat(tintHex) {
  let m = _blockMatCache.get(tintHex);
  if (!m) {
    const baseColor = new THREE.Color(tintHex).lerp(new THREE.Color(0x222233), 0.4);
    m = new THREE.MeshStandardMaterial({
      color: baseColor,
      emissive: tintHex,
      emissiveIntensity: 0.25,
      roughness: 0.6,
      metalness: 0.2,
    });
    _blockMatCache.set(tintHex, m);
  }
  return m;
}
function _getBlockEdgeMat(tintHex) {
  let m = _blockEdgeMatCache.get(tintHex);
  if (!m) {
    m = new THREE.LineBasicMaterial({ color: tintHex, transparent: true, opacity: 0.9 });
    _blockEdgeMatCache.set(tintHex, m);
  }
  return m;
}
// Share one EdgesGeometry across every block (same box dimensions).
const BLOCK_EDGES_GEO = new THREE.EdgesGeometry(BLOCK_GEO);

export function spawnBlock(chapterIdx) {
  const angle = Math.random() * Math.PI * 2;
  const radius = 6 + Math.random() * 22;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;

  const full = CHAPTERS[chapterIdx % CHAPTERS.length].full;
  const mat = _getBlockMat(full.lamp);

  // IMPORTANT: Cloning here means each block's scale can animate independently
  // from its grow-animation without clobbering other blocks. But cloning a
  // material doesn't recompile its shader — Three.js reuses the program via
  // programCacheKey, so this is still free after the first of each color.
  // Actually — blocks animate emissiveIntensity on hitFlash + blink, which
  // DOES need to be independent. So we clone on spawn (cheap).
  const blockMat = mat.clone();
  const mesh = new THREE.Mesh(BLOCK_GEO, blockMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(x, BLOCK_CONFIG.fallHeight, z);
  scene.add(mesh);

  // Edge lines for readability — shared geometry + cached material
  const edges = new THREE.LineSegments(BLOCK_EDGES_GEO, _getBlockEdgeMat(full.lamp));
  mesh.add(edges);

  // Warning shadow on ground where it'll land — shared geometry + material
  const shadow = new THREE.Mesh(SHADOW_RING_GEO, SHADOW_MAT);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(x, 0.04, z);
  scene.add(shadow);

  const block = {
    mesh,
    shadow,
    pos: mesh.position,
    targetY: BLOCK_CONFIG.size / 2,
    hp: BLOCK_CONFIG.hp,
    hpMax: BLOCK_CONFIG.hp,
    falling: true,
    hitFlash: 0,
    chapterIdx,
    color: full.lamp,
  };
  blocks.push(block);
  return block;
}

// Returns true if a segment from A to B is blocked by any grounded block.
// Uses AABB raycast against each grounded block. Cheap enough for bullets.
const _tmpMin = new THREE.Vector3();
const _tmpMax = new THREE.Vector3();
export function segmentBlocked(ax, az, bx, bz) {
  const half = BLOCK_CONFIG.size / 2;
  for (const b of blocks) {
    if (b.falling) continue;
    // 2D AABB ray-box test on XZ plane
    const minX = b.pos.x - half, maxX = b.pos.x + half;
    const minZ = b.pos.z - half, maxZ = b.pos.z + half;
    if (segIntersectsAABB2D(ax, az, bx, bz, minX, minZ, maxX, maxZ)) return true;
  }
  return false;
}

function segIntersectsAABB2D(ax, az, bx, bz, minX, minZ, maxX, maxZ) {
  const dx = bx - ax, dz = bz - az;
  let tmin = 0, tmax = 1;
  // X slab
  if (Math.abs(dx) < 1e-8) {
    if (ax < minX || ax > maxX) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ax) * inv, t2 = (maxX - ax) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  // Z slab
  if (Math.abs(dz) < 1e-8) {
    if (az < minZ || az > maxZ) return false;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - az) * inv, t2 = (maxZ - az) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

// Push an entity out of any block it's overlapping (for enemy/player collision).
export function resolveCollision(pos, radius) {
  const half = BLOCK_CONFIG.size / 2;
  for (const b of blocks) {
    if (b.falling) continue;
    const minX = b.pos.x - half, maxX = b.pos.x + half;
    const minZ = b.pos.z - half, maxZ = b.pos.z + half;
    const closestX = Math.max(minX, Math.min(pos.x, maxX));
    const closestZ = Math.max(minZ, Math.min(pos.z, maxZ));
    const dx = pos.x - closestX;
    const dz = pos.z - closestZ;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius) {
      const d = Math.sqrt(d2) || 0.001;
      const overlap = radius - d;
      pos.x += (dx / d) * overlap;
      pos.z += (dz / d) * overlap;
    }
  }
}

export function findNearestBlock(x, z, maxRange) {
  let best = null, bestD = maxRange * maxRange;
  for (const b of blocks) {
    if (b.falling) continue;
    const dx = b.pos.x - x;
    const dz = b.pos.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; best = b; }
  }
  return best;
}

export function damageBlock(block, dmg) {
  block.hp -= dmg;
  block.hitFlash = 0.15;

  // Grow with damage — at full HP scale is 1.0, at 0 HP scale is growMaxScale.
  const dmgRatio = 1 - Math.max(0, block.hp) / block.hpMax;
  const targetScale = 1 + (BLOCK_CONFIG.growMaxScale - 1) * dmgRatio;
  // Apply scale; updateBlocks() smooths this with a lerp so it looks organic.
  block.targetScale = targetScale;

  // Small particle burst — smaller count since damageBlock fires on every bullet
  hitBurst(
    new THREE.Vector3(block.pos.x, block.pos.y + BLOCK_CONFIG.size / 2, block.pos.z),
    block.color, 2
  );

  if (block.hp <= 0) {
    // EXPLODE — drop an ore, then hurt anything in the blast radius.
    spawnOre(block.pos.x, block.pos.z, block.color, block.chapterIdx);

    // Small chance of bonus pickups
    if (Math.random() < 0.35) {
      makePickup('xp', block.pos.x, block.pos.z);
    }
    if (Math.random() < 0.20) {
      makePickup('health', block.pos.x + 0.4, block.pos.z);
    }

    // Large, themed burst for the explosion itself
    hitBurst(
      new THREE.Vector3(block.pos.x, block.pos.y + 0.5, block.pos.z),
      block.color, 36
    );
    // Orange hot-core flash regardless of chapter so the blast reads as fire
    hitBurst(
      new THREE.Vector3(block.pos.x, block.pos.y + 0.6, block.pos.z),
      0xff8800, 12
    );

    // Hand off to the AoE handler in main.js (enemies / civilians / player).
    if (_explosionHandler) {
      try {
        _explosionHandler(
          new THREE.Vector3(block.pos.x, block.pos.y + 0.5, block.pos.z),
          BLOCK_CONFIG.explosionRadius,
          block.color
        );
      } catch (err) { console.warn('[blocks] explosion handler', err); }
    }

    scene.remove(block.mesh);
    scene.remove(block.shadow);
    const idx = blocks.indexOf(block);
    if (idx >= 0) blocks.splice(idx, 1);
    shake(0.55, 0.35);   // bigger shake — it's an explosion now
    return true;
  }
  return false;
}

/**
 * Bullet hit-test helper. Called from main.js updateBullets().
 * Returns the block that was hit (if any) and whether it was destroyed.
 * Uses an XZ-plane AABB check — same geometry segmentBlocked() uses, so
 * the hit matches the visual block shape.
 *
 * Usage:
 *   const hit = damageBlockAt(bullet.x, bullet.z, MINING_CONFIG.bulletDamageToBlock);
 *   if (hit) { ...remove bullet, play sound, if hit.destroyed call onBlockMined... }
 */
export function damageBlockAt(x, z, dmg) {
  const half = BLOCK_CONFIG.size / 2;
  for (const b of blocks) {
    if (b.falling) continue;
    if (x >= b.pos.x - half && x <= b.pos.x + half &&
        z >= b.pos.z - half && z <= b.pos.z + half) {
      const destroyed = damageBlock(b, dmg);
      return { block: b, destroyed };
    }
  }
  return null;
}

export function updateBlocks(dt) {
  for (const b of blocks) {
    // Smooth scale-up toward targetScale (set in damageBlock)
    if (b.targetScale !== undefined) {
      const cur = b.mesh.scale.x;
      const next = cur + (b.targetScale - cur) * Math.min(1, dt * 12);
      b.mesh.scale.setScalar(next);
    }

    // Blink when near destruction. At low HP we flash emissive on/off
    // rapidly to telegraph the incoming explosion.
    const ratio = Math.max(0, b.hp) / b.hpMax;
    let emissiveI = 0.25;
    if (b.hitFlash > 0) {
      b.hitFlash -= dt;
      emissiveI = 0.25 + b.hitFlash * 4;
    }
    if (ratio < BLOCK_CONFIG.blinkStartRatio && b.hp > 0 && !b.falling) {
      // Faster blink as HP gets lower (8Hz near death, 4Hz at threshold)
      b._blinkPhase = (b._blinkPhase || 0) + dt * (6 + (1 - ratio / BLOCK_CONFIG.blinkStartRatio) * 14);
      const on = Math.sin(b._blinkPhase) > 0;
      emissiveI = on ? 3.0 : 0.1;
    }
    b.mesh.material.emissiveIntensity = emissiveI;

    if (b.falling) {
      b.pos.y -= BLOCK_CONFIG.fallSpeed * dt;
      if (b.pos.y <= b.targetY) {
        b.pos.y = b.targetY;
        b.falling = false;
        if (b.shadow && b.shadow.parent) scene.remove(b.shadow);
        hitBurst(new THREE.Vector3(b.pos.x, 0.2, b.pos.z), b.color, 10);
        shake(BLOCK_CONFIG.impactShake, 0.2);
      } else {
        // Pulse shadow as block falls
        const fraction = 1 - (b.pos.y - b.targetY) / BLOCK_CONFIG.fallHeight;
        if (b.shadow) {
          b.shadow.scale.setScalar(0.5 + fraction * 0.5);
          b.shadow.material.opacity = 0.3 + fraction * 0.5;
        }
      }
    }
  }
}

export function clearAllBlocks() {
  for (const b of blocks) {
    scene.remove(b.mesh);
    if (b.shadow && b.shadow.parent) scene.remove(b.shadow);
  }
  blocks.length = 0;
}

// Player-block bullet blocking check from shooter origin to bullet position
// is done in segmentBlocked. Exported for waves/main.
