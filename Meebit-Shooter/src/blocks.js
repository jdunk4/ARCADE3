import * as THREE from 'three';
import { scene } from './scene.js';
import { BLOCK_CONFIG, MINING_CONFIG, ARENA, CHAPTERS, PARADISE_FALLEN_CHAPTER_IDX } from './config.js';
import { hitBurst, makePickup } from './effects.js';
import { shake, S } from './state.js';
import { spawnOre, depot } from './ores.js';
import { makeEnemy } from './enemies.js';
import { getTriangleFor, INNER_RADIUS, OUTER_RADIUS } from './triangles.js';

// Probability that a block in chapter 7 wave 1 reveals a MEGA BRUTE
// instead of an ore. Bumped DOWN from 0.75 to 0.25 — at 75%, players
// were getting overrun by mega_brutes faster than they could grind
// through them. 25% means 1 in 4 blocks hides a brute, the rest are
// normal ore drops, which keeps the mining wave completable while
// the brute swarm-on-death still creates dramatic moments.
const CH7_MEGA_BRUTE_REVEAL_CHANCE = 0.25;

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
  // Block drop is constrained to the mining triangle so wave-1 debris
  // doesn't rain across the whole arena (including on top of the
  // power-up compound or the hives). Uniform-area sampling inside the
  // wedge using the helper. Keeps the mining area visually coherent.
  const t = getTriangleFor('mining');
  const halfWidth = (t.maxAngle - t.minAngle) / 2;
  // Depot exclusion — never let a block land directly on the depot
  // (it'd cover the deposit beacon and players would have to mine
  // through the block to reach the depot). Depot occupies a ~2.4u
  // orbit radius; with block half-size 0.9 + a 0.4 buffer we get
  // an exclusion radius of ~3.7u around the depot center. We retry
  // up to 8 times to find a clear spot. If all retries fail (very
  // unlikely given the wide mining wedge), we proceed with the last
  // attempt — the wave continues rather than failing to spawn.
  const DEPOT_EXCLUSION = 3.7;
  const DEPOT_EXCL_SQ = DEPOT_EXCLUSION * DEPOT_EXCLUSION;
  let x = 0, z = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = t.centerAngle + (Math.random() - 0.5) * 2 * halfWidth;
    const radius = 10 + Math.random() * 20;
    x = Math.cos(angle) * radius;
    z = Math.sin(angle) * radius;
    if (depot && depot.pos) {
      const ddx = x - depot.pos.x;
      const ddz = z - depot.pos.z;
      if (ddx * ddx + ddz * ddz < DEPOT_EXCL_SQ) continue;     // too close — reroll
    }
    break;     // accepted — exit retry loop
  }

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
    // EGG PATH — chapter 1 reflow. Eggs piggyback on this array but
    // shatter to a charge ore drop with a small green burst, no
    // mega-brute reveal, no AoE explosion. Return early before all
    // the standard block-explosion behavior.
    if (block.kind === 'egg') {
      // Inline the egg destroy logic to avoid a circular import.
      // Green burst + gold sparkle + small shake + drop charge ore.
      const burstPos = new THREE.Vector3(block.pos.x, block.pos.y + 0.3, block.pos.z);
      hitBurst(burstPos, 0x66ff66, 28);
      hitBurst(burstPos, 0xffd633, 10);
      spawnOre(block.pos.x, block.pos.z, 0x66ff66, block.chapterIdx || 0);
      // Small chance of bonus xp/health on egg shatter (same as blocks)
      if (Math.random() < 0.35) makePickup('xp', block.pos.x, block.pos.z);
      if (Math.random() < 0.20) makePickup('health', block.pos.x + 0.4, block.pos.z);
      if (block.mesh && block.mesh.parent) scene.remove(block.mesh);
      const idx = blocks.indexOf(block);
      if (idx >= 0) blocks.splice(idx, 1);
      shake(0.30, 0.18);
      return true;
    }
    // CHAPTER 7 WAVE 1 — blocks reveal MEGA BRUTES instead of ore at
    // a 75% rate. The remaining 25% drop ore as normal so the wave
    // can still be completed (player needs 5 ores to clear the wave).
    // Detect "chapter 7" via S.chapter (0-indexed PARADISE_FALLEN_CHAPTER_IDX)
    // and "wave 1" via the block.chapterIdx... actually we use the
    // CURRENT live chapter+wave from S so blocks falling at chapter
    // boundary don't hand out wrong rewards.
    const localWave = S && S.wave ? ((S.wave - 1) % 5) + 1 : 0;
    const inCh7Wave1 = (S && S.chapter === PARADISE_FALLEN_CHAPTER_IDX && localWave === 1);
    let revealedMegaBrute = false;
    if (inCh7Wave1 && Math.random() < CH7_MEGA_BRUTE_REVEAL_CHANCE) {
      try {
        // Spawn a mega_brute at the block's XZ. Tint with chapter
        // accent color so it reads as native to chapter 7's palette.
        const ch7Color = (CHAPTERS[PARADISE_FALLEN_CHAPTER_IDX]
          && CHAPTERS[PARADISE_FALLEN_CHAPTER_IDX].full
          && CHAPTERS[PARADISE_FALLEN_CHAPTER_IDX].full.grid1)
          || 0x9966ff;
        makeEnemy('mega_brute', ch7Color, new THREE.Vector3(block.pos.x, 0, block.pos.z));
        // Visual flash + particle burst — block crumbles, brute emerges
        hitBurst(
          new THREE.Vector3(block.pos.x, block.pos.y + 0.5, block.pos.z),
          ch7Color, 30
        );
        revealedMegaBrute = true;
      } catch (err) {
        console.warn('[ch7 mega_brute reveal] failed:', err);
      }
    }
    if (!revealedMegaBrute) {
      // EXPLODE — drop an ore, then hurt anything in the blast radius.
      // Standard mining behavior outside chapter 7 wave 1, OR the 25%
      // chance within chapter 7 wave 1 when the brute roll fails.
      spawnOre(block.pos.x, block.pos.z, block.color, block.chapterIdx);
    }

    // Small chance of bonus pickups (regardless of brute/ore reveal)
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
    // EGG PATH — eggs are Group meshes (body sphere + gold band) with
    // their material cached on userData. They don't fall, don't have
    // shadows, but DO use targetScale for hit-grow + emissive flash.
    if (b.kind === 'egg') {
      // Smooth scale-up toward targetScale (set in damageBlock)
      if (b.targetScale !== undefined) {
        const cur = b.mesh.scale.x;
        const next = cur + (b.targetScale - cur) * Math.min(1, dt * 12);
        b.mesh.scale.setScalar(next);
      }
      const ratio = Math.max(0, b.hp) / b.hpMax;
      let emissiveI = 0.5;        // base egg emissive (higher than blocks)
      if (b.hitFlash > 0) {
        b.hitFlash -= dt;
        emissiveI = 0.5 + b.hitFlash * 5;
      }
      if (ratio < BLOCK_CONFIG.blinkStartRatio && b.hp > 0) {
        // Crack-telegraph blink — faster + more dramatic than blocks so
        // the player sees the egg about to shatter.
        b._blinkPhase = (b._blinkPhase || 0) + dt * (8 + (1 - ratio / BLOCK_CONFIG.blinkStartRatio) * 16);
        const on = Math.sin(b._blinkPhase) > 0;
        emissiveI = on ? 3.5 : 0.15;
      }
      const bodyMat = b.mesh.userData && b.mesh.userData.bodyMat;
      if (bodyMat) bodyMat.emissiveIntensity = emissiveI;
      continue;          // skip the standard block path below
    }

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
