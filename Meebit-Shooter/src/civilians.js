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
import { attachMixer, animationsReady } from './animation.js';

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
const CORNER_HOLD = 0.7;   // was 1.2; felt like a chore, dropped for snappier feel

// The four rescue zones — randomized per civilian_rescue wave.
// Default is the four map corners so anything that reads this before a
// wave starts still gets a sensible value. buildCornerMarkers() below
// picks new random positions every time it's called.
export const CIVILIAN_CORNERS = [
  { x: -ARENA * 0.9, z: -ARENA * 0.9 },
  { x:  ARENA * 0.9, z: -ARENA * 0.9 },
  { x: -ARENA * 0.9, z:  ARENA * 0.9 },
  { x:  ARENA * 0.9, z:  ARENA * 0.9 },
];

// Random-zone parameters
const ZONE_COUNT = 4;
const ZONE_MIN_FROM_CENTER = 12;
const ZONE_MAX_FROM_CENTER = ARENA * 0.85;
const ZONE_MIN_PAIRWISE_DIST = 14;   // zones can't be right on top of each other
const ZONE_RANDOM_TRIES = 40;

function _pickRandomZones() {
  const zones = [];
  for (let i = 0; i < ZONE_COUNT; i++) {
    let pick = null;
    for (let tries = 0; tries < ZONE_RANDOM_TRIES; tries++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = ZONE_MIN_FROM_CENTER +
        Math.random() * (ZONE_MAX_FROM_CENTER - ZONE_MIN_FROM_CENTER);
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      // Keep them apart so you can't rescue all four by standing in one spot
      let ok = true;
      for (const other of zones) {
        const dx = other.x - x, dz = other.z - z;
        if (dx * dx + dz * dz < ZONE_MIN_PAIRWISE_DIST * ZONE_MIN_PAIRWISE_DIST) {
          ok = false; break;
        }
      }
      if (ok) { pick = { x, z }; break; }
    }
    // Fallback to a corner if we couldn't find a good spot (rare)
    if (!pick) {
      const fall = [
        { x: -ARENA * 0.7, z: -ARENA * 0.7 },
        { x:  ARENA * 0.7, z: -ARENA * 0.7 },
        { x: -ARENA * 0.7, z:  ARENA * 0.7 },
        { x:  ARENA * 0.7, z:  ARENA * 0.7 },
      ][i];
      pick = fall;
    }
    zones.push(pick);
  }
  return zones;
}

const activeIds = new Set();
let spawnQueue = 0;
let cornerHoldTimer = 0;
let cornerHoldIndex = -1;

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
    if (c.mixer) { c.mixer.stop(); c.mixer = null; }
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
  // Staggered spawn — firing all 8 awaits simultaneously caused a
  // multi-hundred-ms freeze on wave 4 (all 8 VRM meshes resolving at
  // once, with 8 new materials compiling in one frame). Spread the
  // spawns across ~800ms so the VRM loads and material compiles are
  // naturally spread across frames.
  const stagger = 100;  // ms between spawns
  for (let i = 0; i < count; i++) {
    setTimeout(() => spawnOneCivilian(chapterTintHex), i * stagger);
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
    if (mesh.userData.isFallback && mesh.userData.animRefs) {
      civilian.animRefs = mesh.userData.animRefs;
    } else {
      applyCivilianHighlight(mesh, chapterTintHex);
      // Real VRM: attach a Mixamo-retargeted walk animation if clips are ready.
      if (animationsReady()) {
        civilian.mixer = attachMixer(mesh);
        civilian.mixer.playWalk();
      }
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
 * Visual treatment for real VRM civilians so they stand out against the
 * dark arena. Warm-white lamp above each civilian -- actually LIGHTS the
 * surrounding ground tiles, so it reads as "glow around the meebit"
 * rather than just a color stain.
 *
 * The tint arg is kept for the emissive lift so civilians still ping in
 * the chapter color from far away (useful for spotting them at distance),
 * but the main fill light is white.
 */
function applyCivilianHighlight(mesh, tintHex) {
  // Warm white, punchy. Intensity 4 + radius 8 actually illuminates the
  // 4x4 tile area around each civilian -- you'll see the tile grid light up.
  const fill = new THREE.PointLight(0xfff4d6, 4.0, 8.0, 2);
  fill.position.set(0, 3.4, 0);
  mesh.add(fill);

  // Chapter-tint accent kept as a small secondary light so civilians are
  // findable at long range (you can spot the color puck even if detail washes out).
  const accent = new THREE.PointLight(tintHex, 1.2, 5.0, 2);
  accent.position.set(0, 1.4, 0);
  mesh.add(accent);

  // Subtle emissive lift so skin tones don't go pure-black when the fill
  // light's inverse-square falloff dims them. White-ish, not chapter-tint.
  mesh.traverse(obj => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) continue;
      if (m.emissive && m.emissive.getHex() === 0) {
        m.emissive = new THREE.Color(0x332922);
        m.emissiveIntensity = 0.55;
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

    // Walk animation: real skeletal mixer if attached, procedural bob otherwise.
    if (c.obj && c.mixer) {
      const movingSpeed =
        c.state === 'following' ? FOLLOW_SPEED :
        c.state === 'panic'     ? PANIC_SPEED  :
                                  WANDER_SPEED;
      // Normalize animation tempo to ground speed. 2.0 is a magic number:
      // tuned so the feet appear to step at roughly the right rate.
      c.mixer.setSpeed(Math.max(0.4, movingSpeed / 2.0));
      c.mixer.update(dt);
    } else if (c.obj && !c.animRefs) {
      // Fallback bob for VRMs that failed to get a mixer (anim not yet loaded)
      const movingSpeed =
        c.state === 'following' ? FOLLOW_SPEED :
        c.state === 'panic'     ? PANIC_SPEED  :
                                  WANDER_SPEED;
      c.walkPhase += dt * movingSpeed * 2.0;
      const bob = Math.sin(c.walkPhase * 2) * 0.12;
      const lean = Math.sin(c.walkPhase) * 0.08;
      c.obj.position.y = bob;
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
  // Stop the walk mixer so the corpse doesn't keep cycling its feet.
  if (c.mixer) { c.mixer.stop(); }
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
  // Release the mixer reference so GC can collect the cached actions.
  // Three.js AnimationMixer has no explicit dispose; dropping the ref is enough.
  c.mixer = null;
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

// ============================================================================
// CORNER MARKERS -- visual indicators at each of the 4 rescue corners.
// Each marker is a pair of discs on the ground:
//   - a dim static ring showing "you can rescue here"
//   - a bright filling arc that grows while the player holds
// ============================================================================

const _cornerMarkers = [];   // array of { group, fillMesh, baseRing, tintColor }

/**
 * Build (or rebuild) corner markers tinted to the chapter color.
 * Call this when a civilian_rescue wave starts. Randomizes the four
 * rescue zones to fresh positions on the map each call.
 */
export function buildCornerMarkers(scene, chapterTintHex) {
  clearCornerMarkers(scene);
  const color = new THREE.Color(chapterTintHex);

  // Randomize the rescue zone positions — mutate in place so the exported
  // CIVILIAN_CORNERS reference stays valid for anything that imported it.
  const fresh = _pickRandomZones();
  for (let i = 0; i < CIVILIAN_CORNERS.length; i++) {
    CIVILIAN_CORNERS[i].x = fresh[i].x;
    CIVILIAN_CORNERS[i].z = fresh[i].z;
  }

  for (let i = 0; i < CIVILIAN_CORNERS.length; i++) {
    const cc = CIVILIAN_CORNERS[i];
    const group = new THREE.Group();
    group.position.set(cc.x, 0.03, cc.z);

    // Dim static ring outlining the rescue area
    const baseRing = new THREE.Mesh(
      new THREE.RingGeometry(CORNER_RADIUS - 0.15, CORNER_RADIUS + 0.05, 48),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
      })
    );
    baseRing.rotation.x = -Math.PI / 2;
    group.add(baseRing);

    // Soft filled disc so the corner reads from a distance
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(CORNER_RADIUS - 0.2, 48),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.08, side: THREE.DoubleSide,
      })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.005;
    group.add(disc);

    // The filling progress arc (thetaLength animated at runtime).
    // Start with 0 theta -- invisible until hold begins.
    const fillGeo = new THREE.RingGeometry(
      CORNER_RADIUS - 0.05, CORNER_RADIUS + 0.35, 48, 1, -Math.PI / 2, 0.001
    );
    const fillMesh = new THREE.Mesh(
      fillGeo,
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
      })
    );
    fillMesh.rotation.x = -Math.PI / 2;
    fillMesh.position.y = 0.02;
    group.add(fillMesh);

    // Thin emissive post so the corner is visible across the arena
    const postMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3, 8), postMat);
    post.position.y = 1.5;
    group.add(post);

    scene.add(group);
    _cornerMarkers.push({ group, fillMesh, baseRing, tintColor: color.clone(), phase: i });
  }
}

export function clearCornerMarkers(scene) {
  for (const m of _cornerMarkers) {
    if (m.group.parent) scene.remove(m.group);
    // Dispose geometries so repeated wave builds don't leak
    m.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  _cornerMarkers.length = 0;
}

/**
 * Update every frame. `time` = performance.now() / 1000, used for a subtle pulse.
 * The arc on the corner the player is currently holding fills up; all other
 * corners just pulse gently.
 */
export function updateCornerMarkers(time) {
  for (let i = 0; i < _cornerMarkers.length; i++) {
    const m = _cornerMarkers[i];

    // Gentle pulse on the base ring so corners look "alive"
    const pulse = 0.25 + Math.sin(time * 2 + m.phase) * 0.1;
    m.baseRing.material.opacity = pulse;

    // Fill arc matches current rescue progress on the held corner
    let theta = 0.001;
    if (cornerHoldIndex === i && cornerHoldTimer > 0) {
      theta = Math.min(1, cornerHoldTimer / CORNER_HOLD) * Math.PI * 2;
    }
    // Dispose and replace the geometry. RingGeometry can't be mutated in
    // place for thetaLength, so we rebuild it. This is cheap (a few dozen
    // vertices at 60fps) and happens only for 4 corners.
    m.fillMesh.geometry.dispose();
    m.fillMesh.geometry = new THREE.RingGeometry(
      CORNER_RADIUS - 0.05, CORNER_RADIUS + 0.35, 48, 1, -Math.PI / 2, theta
    );
  }
}
