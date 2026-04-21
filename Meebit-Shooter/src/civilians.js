// Civilian Meebits — follow-the-player conga line with corner rescue.
//
// Behavior states:
//   wander:    no player contact yet — random drift
//   following: player came within RECRUIT_RADIUS → joins the conga line
//   panic:     2+ enemies within PANIC_RADIUS while unrecruited → dodge run
//   dead:      bullet/enemy hit → ragdoll drop, no update
//
// CORNER RESCUE:
//   Four corners at (±ARENA*0.9, ±ARENA*0.9). When the player stands in a
//   corner for CORNER_HOLD seconds with at least one follower, ALL followers
//   are rescued simultaneously.
//
// Visual: real VRM from meebits.app/meebit/{id}. Voxel fallback on fetch fail.

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA } from './config.js';
import { getMeebitMesh, pickRandomMeebitId } from './meebitsPublicApi.js';
import { hitBurst } from './effects.js';

export const civilians = [];

// --- Tuning ---
const RECRUIT_RADIUS = 2.4;
const RECRUIT_RADIUS_SQ = RECRUIT_RADIUS * RECRUIT_RADIUS;
const FOLLOW_SPACING = 1.8;
const FOLLOW_SPEED = 6.5;
const FOLLOW_CATCHUP_SPEED = 10;
const MAX_FOLLOW_GAP = 4.5;
const PANIC_RADIUS = 8;
const PANIC_SPEED = 4.6;
const WANDER_SPEED = 2.4;
const WANDER_CHANGE_SEC = 2.5;
const CORNER_RADIUS = 3.5;
const CORNER_HOLD = 1.2;

// The four rescue corners — exported for UI markers / minimap
export const CIVILIAN_CORNERS = [
  { x: -ARENA * 0.9, z: -ARENA * 0.9 },
  { x:  ARENA * 0.9, z: -ARENA * 0.9 },
  { x: -ARENA * 0.9, z:  ARENA * 0.9 },
  { x:  ARENA * 0.9, z:  ARENA * 0.9 },
];

const activeIds = new Set();
let spawnQueue = 0;
let cornerHoldTimer = 0;
let cornerHoldIndex = -1;
let _spawnDiagCount = 0;

function recruitedCount() {
  let n = 0;
  for (const c of civilians) if (c.state === 'following' && !c.dead) n++;
  return n;
}

function getFollowAnchor(c, player) {
  if (c.chainIndex === 0) return player.pos;
  for (const other of civilians) {
    if (other === c) continue;
    if (other.state === 'following' && !other.dead && other.chainIndex === c.chainIndex - 1) {
      return other.pos;
    }
  }
  return player.pos;
}

export function clearAllCivilians() {
  for (const c of civilians) {
    if (c.obj && c.obj.parent) scene.remove(c.obj);
  }
  civilians.length = 0;
  activeIds.clear();
  spawnQueue = 0;
  cornerHoldTimer = 0;
  cornerHoldIndex = -1;
}

export function spawnCivilians(count, chapterTintHex) {
  spawnQueue += count;
  for (let i = 0; i < count; i++) {
    spawnOneCivilian(chapterTintHex);
  }
}

async function spawnOneCivilian(chapterTintHex) {
  const id = pickRandomMeebitId(activeIds);
  activeIds.add(id);

  const angle = Math.random() * Math.PI * 2;
  const dist = 14 + Math.random() * 22;
  const x = Math.cos(angle) * dist;
  const z = Math.sin(angle) * dist;

  const placeholder = new THREE.Group();
  placeholder.position.set(x, 0, z);
  scene.add(placeholder);

  const civilian = {
    obj: placeholder,
    pos: placeholder.position,
    meebitId: id,
    state: 'wander',
    chainIndex: -1,
    vel: new THREE.Vector3(),
    wanderTarget: new THREE.Vector3(x, 0, z),
    wanderTimer: Math.random() * WANDER_CHANGE_SEC,
    panicPhase: Math.random() * Math.PI * 2,
    screamCooldown: 0,
    hp: 1,
    dead: false,
    ready: false,
    animRefs: null,
    walkPhase: Math.random() * Math.PI * 2,
    joinedAt: 0,
  };
  civilians.push(civilian);

  try {
    const mesh = await getMeebitMesh(id, chapterTintHex);
    if (civilian.obj.parent) scene.remove(civilian.obj);
    mesh.position.copy(placeholder.position);
    // DIAG: show what the position actually is right after the copy
    if (_spawnDiagCount < 3) {
      _spawnDiagCount++;
      console.log('[Civilian SPAWN-DIAG]', {
        id,
        placeholder: { x: placeholder.position.x, y: placeholder.position.y, z: placeholder.position.z },
        meshAfterCopy: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
        isFallback: !!mesh.userData.isFallback,
      });
    }
    if (mesh.userData.isFallback && mesh.userData.animRefs) {
      civilian.animRefs = mesh.userData.animRefs;
    } else {
      applyCivilianHighlight(mesh);
    }
    scene.add(mesh);
    civilian.obj = mesh;
    civilian.pos = mesh.position;
    civilian.ready = true;
  } catch (err) {
    console.warn('[Civilian] failed to load', id, err);
    civilian.ready = true;
  } finally {
    spawnQueue = Math.max(0, spawnQueue - 1);
  }
}

/**
 * Visual treatment for real VRM civilians so they stand out against enemies
 * and dark tiles: a small friendly-green point light above their head, plus
 * a subtle emissive tint on every material. Cheap (one light per civilian,
 * ~8 max on screen) and reads clearly.
 */
function applyCivilianHighlight(mesh) {
  const light = new THREE.PointLight(0x66ff99, 0.9, 4.5, 2);
  light.position.set(0, 3.4, 0);
  mesh.add(light);

  mesh.traverse(obj => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m || !m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) continue;
      // Subtle green lift. Don't overwrite existing emissive -- some meebits
      // already have accent colours baked in.
      if (m.emissive && m.emissive.getHex() === 0) {
        m.emissive = new THREE.Color(0x004422);
        m.emissiveIntensity = 0.35;
      }
    }
  });
}

export function updateCivilians(dt, enemies, player, onCivilianKilled, onCivilianRescued) {
  // Corner-rescue check
  let inCornerIdx = -1;
  for (let i = 0; i < CIVILIAN_CORNERS.length; i++) {
    const cc = CIVILIAN_CORNERS[i];
    const dx = player.pos.x - cc.x;
    const dz = player.pos.z - cc.z;
    if (dx * dx + dz * dz < CORNER_RADIUS * CORNER_RADIUS) {
      inCornerIdx = i;
      break;
    }
  }

  if (inCornerIdx >= 0 && recruitedCount() > 0) {
    if (cornerHoldIndex !== inCornerIdx) {
      cornerHoldIndex = inCornerIdx;
      cornerHoldTimer = 0;
    }
    cornerHoldTimer += dt;
    if (cornerHoldTimer >= CORNER_HOLD) {
      for (let i = civilians.length - 1; i >= 0; i--) {
        const c = civilians[i];
        if (c.state === 'following' && !c.dead) {
          hitBurst(new THREE.Vector3(c.pos.x, 2, c.pos.z), 0x00ff66, 12);
          if (onCivilianRescued) onCivilianRescued(c);
          removeCivilian(c, i);
        }
      }
      cornerHoldTimer = 0;
      cornerHoldIndex = -1;
    }
  } else {
    cornerHoldTimer = 0;
    cornerHoldIndex = -1;
  }

  // Per-civilian update
  for (let i = civilians.length - 1; i >= 0; i--) {
    const c = civilians[i];
    if (c.dead) continue;

    let nearestEnemy = null;
    let nearestDist = Infinity;
    let enemiesNear = 0;
    for (const e of enemies) {
      if (e.isBoss) continue;
      const dx = e.pos.x - c.pos.x;
      const dz = e.pos.z - c.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestDist) { nearestDist = d2; nearestEnemy = e; }
      if (d2 < PANIC_RADIUS * PANIC_RADIUS) enemiesNear++;
    }

    // Recruitment
    if (c.state !== 'following') {
      const pdx = player.pos.x - c.pos.x;
      const pdz = player.pos.z - c.pos.z;
      if (pdx * pdx + pdz * pdz < RECRUIT_RADIUS_SQ) {
        c.state = 'following';
        c.chainIndex = recruitedCount();
        c.joinedAt = performance.now() / 1000;
        hitBurst(new THREE.Vector3(c.pos.x, 2.2, c.pos.z), 0xffd93d, 6);
      }
    }

    if (c.state === 'following') {
      const anchor = getFollowAnchor(c, player);
      const dx = anchor.x - c.pos.x;
      const dz = anchor.z - c.pos.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;

      if (d > MAX_FOLLOW_GAP * 3) {
        c.pos.x = anchor.x - (dx / d) * FOLLOW_SPACING;
        c.pos.z = anchor.z - (dz / d) * FOLLOW_SPACING;
      } else if (d > FOLLOW_SPACING) {
        const gap = d - FOLLOW_SPACING;
        const speed = gap > MAX_FOLLOW_GAP ? FOLLOW_CATCHUP_SPEED : FOLLOW_SPEED;
        const step = Math.min(gap, speed * dt);
        c.pos.x += (dx / d) * step;
        c.pos.z += (dz / d) * step;
      }
      if (d > 0.01) c.obj.rotation.y = Math.atan2(dx, dz);

      if (c.animRefs) {
        c.walkPhase += dt * 9;
        const sw = Math.sin(c.walkPhase) * 0.5;
        if (c.animRefs.legL) c.animRefs.legL.rotation.x = sw;
        if (c.animRefs.legR) c.animRefs.legR.rotation.x = -sw;
        if (c.animRefs.armL) c.animRefs.armL.rotation.x = -sw * 0.6;
        if (c.animRefs.armR) c.animRefs.armR.rotation.x = sw * 0.6;
      }
    } else if (enemiesNear >= 2 && nearestEnemy) {
      c.state = 'panic';
      c.panicPhase += dt * 8;
      const ax = c.pos.x - nearestEnemy.pos.x;
      const az = c.pos.z - nearestEnemy.pos.z;
      const d = Math.sqrt(ax * ax + az * az) || 1;
      const nx = ax / d, nz = az / d;
      const perpX = -nz, perpZ = nx;
      const jitter = Math.sin(c.panicPhase) * 0.6;
      const vx = nx + perpX * jitter;
      const vz = nz + perpZ * jitter;
      const vlen = Math.sqrt(vx * vx + vz * vz) || 1;
      c.pos.x += (vx / vlen) * PANIC_SPEED * dt;
      c.pos.z += (vz / vlen) * PANIC_SPEED * dt;
      c.obj.rotation.y = Math.atan2(vx, vz);
      c.screamCooldown -= dt;
      if (c.screamCooldown <= 0) {
        c.screamCooldown = 0.6 + Math.random() * 0.4;
        hitBurst(new THREE.Vector3(c.pos.x, 2.8, c.pos.z), 0xffffff, 3);
      }
    } else {
      c.state = 'wander';
      c.wanderTimer -= dt;
      if (c.wanderTimer <= 0) {
        c.wanderTimer = WANDER_CHANGE_SEC + Math.random() * 2;
        const a = Math.random() * Math.PI * 2;
        const r = 4 + Math.random() * 8;
        const limit = ARENA - 2;
        c.wanderTarget.set(
          Math.max(-limit, Math.min(limit, c.pos.x + Math.cos(a) * r)),
          0,
          Math.max(-limit, Math.min(limit, c.pos.z + Math.sin(a) * r))
        );
      }
      const dx = c.wanderTarget.x - c.pos.x;
      const dz = c.wanderTarget.z - c.pos.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      if (d > 0.5) {
        c.pos.x += (dx / d) * WANDER_SPEED * dt;
        c.pos.z += (dz / d) * WANDER_SPEED * dt;
        c.obj.rotation.y = Math.atan2(dx, dz);
      }
    }

    const limit = ARENA - 1.5;
    c.pos.x = Math.max(-limit, Math.min(limit, c.pos.x));
    c.pos.z = Math.max(-limit, Math.min(limit, c.pos.z));

    // Walk-cycle bob for real VRM meshes (they have no rigged limb refs).
    // Advance walkPhase proportional to how fast the civilian is moving so
    // idle civilians don't bob; recruiting/panic civilians bob quickly.
    if (c.obj && !c.animRefs) {
      const movingSpeed =
        c.state === 'following' ? FOLLOW_SPEED :
        c.state === 'panic'     ? PANIC_SPEED  :
                                  WANDER_SPEED;
      c.walkPhase += dt * movingSpeed * 2.0;
      // Gentle vertical bob + slight forward lean, keyed to phase.
      const bob = Math.sin(c.walkPhase * 2) * 0.12;
      const lean = Math.sin(c.walkPhase) * 0.08;
      c.obj.position.y = bob;                    // feet stay near y=0 thanks to the wrapper's normalization
      c.obj.rotation.x = lean;
    }

    // Enemy-touch kill — followers get slight protective aura (smaller radius)
    const touchRadius = c.state === 'following' ? 0.6 : 1.0;
    const touchR2 = touchRadius * touchRadius;
    for (const e of enemies) {
      if (e.isBoss) continue;
      const dx = e.pos.x - c.pos.x;
      const dz = e.pos.z - c.pos.z;
      if (dx * dx + dz * dz < touchR2) {
        killCivilian(c, i, 'enemy', onCivilianKilled);
        break;
      }
    }
  }

  // Re-compact chain indices
  let idx = 0;
  for (const c of civilians) {
    if (c.state === 'following' && !c.dead) c.chainIndex = idx++;
  }
}

export function damageCivilianAt(x, z, hitRadius, cause, onCivilianKilled) {
  for (let i = civilians.length - 1; i >= 0; i--) {
    const c = civilians[i];
    if (c.dead) continue;
    const dx = c.pos.x - x;
    const dz = c.pos.z - z;
    if (dx * dx + dz * dz < hitRadius * hitRadius) {
      killCivilian(c, i, cause, onCivilianKilled);
      return true;
    }
  }
  return false;
}

function killCivilian(c, idx, cause, onCivilianKilled) {
  c.dead = true;
  c.state = 'dead';
  if (c.obj) {
    c.obj.rotation.x = Math.PI / 2;
    c.obj.position.y = 0.3;
  }
  hitBurst(new THREE.Vector3(c.pos.x, 1.5, c.pos.z), 0xff2e4d, 12);
  setTimeout(() => hitBurst(new THREE.Vector3(c.pos.x, 0.5, c.pos.z), 0x880000, 6), 80);
  if (onCivilianKilled) onCivilianKilled(c, cause);
  setTimeout(() => {
    const realIdx = civilians.indexOf(c);
    if (realIdx >= 0) removeCivilian(c, realIdx);
  }, 3000);
}

function removeCivilian(c, idx) {
  if (c.obj && c.obj.parent) scene.remove(c.obj);
  activeIds.delete(c.meebitId);
  civilians.splice(idx, 1);
}

export function civiliansFollowing() {
  let n = 0;
  for (const c of civilians) if (c.state === 'following' && !c.dead) n++;
  return n;
}

/** Count civilians still alive (any state except 'dead'). Useful for
 *  wave-failure detection when the player needs to rescue N of them. */
export function civiliansAlive() {
  let n = 0;
  for (const c of civilians) if (!c.dead) n++;
  return n;
}

export function cornerRescueProgress() {
  return {
    active: cornerHoldIndex >= 0 && cornerHoldTimer > 0,
    progress: Math.min(1, cornerHoldTimer / CORNER_HOLD),
    cornerIndex: cornerHoldIndex,
  };
}
