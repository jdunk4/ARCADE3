import * as THREE from 'three';
import { scene } from './scene.js';
import { BLOCK_CONFIG, ARENA, CHAPTERS } from './config.js';
import { hitBurst, makePickup } from './effects.js';
import { shake } from './state.js';

export const blocks = [];     // { mesh, pos, hp, falling, chapter }
export const fallingDebris = [];

const BLOCK_GEO = new THREE.BoxGeometry(BLOCK_CONFIG.size, BLOCK_CONFIG.size, BLOCK_CONFIG.size);

export function spawnBlock(chapterIdx) {
  const angle = Math.random() * Math.PI * 2;
  const radius = 6 + Math.random() * 22;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;

  // Get tint from current chapter
  const full = CHAPTERS[chapterIdx % CHAPTERS.length].full;
  const baseColor = new THREE.Color(full.lamp).lerp(new THREE.Color(0x222233), 0.4);

  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    emissive: full.lamp,
    emissiveIntensity: 0.25,
    roughness: 0.6,
    metalness: 0.2,
  });
  // Small wireframe edges for voxel feel
  const mesh = new THREE.Mesh(BLOCK_GEO, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(x, BLOCK_CONFIG.fallHeight, z);
  scene.add(mesh);

  // Edge lines for readability
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(BLOCK_GEO),
    new THREE.LineBasicMaterial({ color: full.lamp, transparent: true, opacity: 0.9 })
  );
  mesh.add(edges);

  // Warning shadow on ground where it'll land
  const shadow = new THREE.Mesh(
    new THREE.RingGeometry(BLOCK_CONFIG.size * 0.5, BLOCK_CONFIG.size * 0.7, 16),
    new THREE.MeshBasicMaterial({ color: 0xff2e4d, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
  );
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
  hitBurst(
    new THREE.Vector3(block.pos.x, block.pos.y + BLOCK_CONFIG.size / 2, block.pos.z),
    block.color, 6
  );
  if (block.hp <= 0) {
    // Break — drop XP pickups as bonus
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * 0.5;
      makePickup('xp', block.pos.x + Math.cos(a) * d, block.pos.z + Math.sin(a) * d);
    }
    if (Math.random() < 0.3) makePickup('health', block.pos.x, block.pos.z);
    // Debris particles
    hitBurst(
      new THREE.Vector3(block.pos.x, block.pos.y, block.pos.z),
      block.color, 18
    );
    scene.remove(block.mesh);
    scene.remove(block.shadow);
    const idx = blocks.indexOf(block);
    if (idx >= 0) blocks.splice(idx, 1);
    shake(0.2, 0.15);
    return true;
  }
  return false;
}

export function updateBlocks(dt) {
  for (const b of blocks) {
    // Hit flash decay
    if (b.hitFlash > 0) {
      b.hitFlash -= dt;
      b.mesh.material.emissiveIntensity = 0.25 + b.hitFlash * 4;
    } else {
      b.mesh.material.emissiveIntensity = 0.25;
    }
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
