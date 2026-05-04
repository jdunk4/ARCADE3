// ============================================================================
// src/powerups.js — end-of-chapter reward cards + persistent effects.
//
// FLOW
//   1. Boss dies. waves.js fires the "CHAPTER N COMPLETE" toast.
//   2. We intercept the normal 3-2-1 countdown and show a 3-card modal.
//   3. Player picks ONE card. The pick is applied permanently + the
//      countdown resumes.
//   4. End of next chapter → same modal. Picks STACK.
//
// CARDS
//   A) FOLLOWER MEEBIT — adds a Galaga-style escort that trails the
//      player's movement with per-slot lag. Each follower auto-fires
//      at the nearest enemy with a pistol-equivalent shot. Up to 6
//      followers (one per chapter reward). Each follower is the
//      chapter's themed meebit (pigs for Inferno, elephants for
//      Crimson, skeletons for Solar, robots for Toxic, visitors for
//      Arctic, dissected for Paradise).
//
//   B) CHAIN LIGHTNING — any player-weapon kill arcs lightning to the
//      nearest living enemy within range for reduced damage. Stacks
//      increase jump count and per-jump damage.
//
//   C) POISON TRAIL — player drops poison patches while moving.
//      Enemies touching a patch take DoT damage and move slower while
//      standing in poison. Stacks thicken the trail and increase DPS.
//
// INTEGRATION
//   - main.js imports { initPowerups, maybeShowChapterReward,
//     updatePowerups, chainLightningOnKill, clearAllPowerups,
//     powerupsActive }. See the bottom of this file for the full API.
//   - waves.js (via main.js wave-change detector) calls
//     maybeShowChapterReward(S.chapter) at the moment CHAPTER N
//     COMPLETE fires. The modal pauses the game until pick.
//   - main.js calls chainLightningOnKill(enemy) at every player-kill
//     site so the chain can arc. The function is a no-op if the
//     player hasn't picked the card.
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { S } from './state.js';
import { ARENA, CHAPTERS, WAVES_PER_CHAPTER, PLAYER, PARADISE_FALLEN_CHAPTER_IDX } from './config.js';
import { Audio } from './audio.js';
import { hitBurst } from './effects.js';
import { enemies } from './enemies.js';
import { getHerdMeshByFilename, getHerdFilenamesSync } from './herdVrmLoader.js';
import { attachMixer, animationsReady, applyGunHoldPose, GUN_HOLD_EXCLUDE_BONES, IDLE_HIP_EXCLUDE_BONES } from './animation.js';

// Re-usable scratch
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// ============================================================================
// PERSISTENT STATE
// ============================================================================
// Stack counts per upgrade. Starts at 0. Each chapter reward bumps one
// of these by 1. We check them from update loops to apply effects.
// Kept as a plain object (not on S) so save-load doesn't have to learn
// about them yet — they live for the duration of the run only.
// ============================================================================

const stacks = {
  follower: 0,       // number of Galaga-style trailing pets
  chainLightning: 0, // 0 = off, 1 = +1 jump, 2 = +2 jumps, ...
  poisonTrail: 0,    // 0 = off, 1+ = trail density & damage
};

// One kept per chapter so we only offer the modal ONCE per chapter boundary
// even if the main loop's wave-change detector fires twice.
const rewardedChapters = new Set();

// The countdown-resume callback held while the modal is up. When the player
// clicks a card we invoke this to continue the normal wave flow.
let pendingResume = null;

// ============================================================================
// FOLLOWERS (Galaga escort)
// ============================================================================
// Each follower samples the player's position into a shared ring buffer.
// Its own mesh reads from (current index - lag) so it trails naturally:
//   slot 0 → 8 samples behind
//   slot 1 → 16 samples behind
//   ...
// With a 60Hz sample rate, 8 samples ≈ 133ms — close enough to feel
// "right behind the player" without overlapping.
// ============================================================================

const FOLLOWER_MAX = 6;
const FOLLOWER_LAG_PER_SLOT = 8;     // ring-buffer frames
const FOLLOWER_RING_SIZE = 256;      // holds ~4s of trail at 60Hz
const FOLLOWER_FIRE_INTERVAL = 0.55; // sec between shots
const FOLLOWER_RANGE = 24;
const FOLLOWER_DAMAGE = 22;
const FOLLOWER_BULLET_SPEED = 42;
const FOLLOWER_BULLET_LIFE = 1.2;
const FOLLOWER_BULLET_COLOR = 0x4ff7ff;

// Map chapter index → which herd folder to pull the follower mesh from.
// Uses the same themed herds as the bonus wave so followers look right.
function getFollowerHerdForChapter(chapterIdx) {
  const chap = CHAPTERS[chapterIdx % CHAPTERS.length];
  return chap && chap.bonusHerd ? chap.bonusHerd.id : 'pigs';
}

const followers = [];   // { obj, slot, chapterIdx, herdId, ready, fireCd }
const followerBullets = [];

const playerTrail = {
  ring: new Array(FOLLOWER_RING_SIZE),
  head: 0,
  initialized: false,
};

function _initTrail(pos) {
  for (let i = 0; i < FOLLOWER_RING_SIZE; i++) {
    playerTrail.ring[i] = { x: pos.x, z: pos.z, facing: 0 };
  }
  playerTrail.head = 0;
  playerTrail.initialized = true;
}

function _pushTrail(pos, facing) {
  if (!playerTrail.initialized) _initTrail(pos);
  playerTrail.head = (playerTrail.head + 1) % FOLLOWER_RING_SIZE;
  const s = playerTrail.ring[playerTrail.head];
  s.x = pos.x;
  s.z = pos.z;
  s.facing = facing;
}

function _readTrail(lagSamples) {
  const idx = (playerTrail.head - lagSamples + FOLLOWER_RING_SIZE * 2) % FOLLOWER_RING_SIZE;
  return playerTrail.ring[idx];
}

async function _spawnFollower(chapterIdx) {
  const slot = followers.length;
  if (slot >= FOLLOWER_MAX) return;

  const herdId = getFollowerHerdForChapter(chapterIdx);
  const chap = CHAPTERS[chapterIdx % CHAPTERS.length];
  const tint = chap && chap.full ? chap.full.grid1 : 0xaabbcc;

  // Placeholder so the follower "exists" in the update loop immediately
  // even while the VRM is still downloading.
  const placeholder = new THREE.Group();
  placeholder.position.copy(_v.set(0, 0, 0));
  scene.add(placeholder);

  const fol = {
    obj: placeholder,
    pos: placeholder.position,
    slot,
    chapterIdx,
    herdId,
    ready: false,
    fireCd: FOLLOWER_FIRE_INTERVAL * (0.4 + Math.random() * 0.4),
    walkPhase: Math.random() * Math.PI * 2,
    facing: 0,
  };
  followers.push(fol);

  try {
    // Grab a random file from the herd folder; fall back to a voxel
    // meebit if the herd isn't yet preloaded or the fetch 404s.
    const files = getHerdFilenamesSync(herdId) || [];
    const filename = files.length
      ? files[Math.floor(Math.random() * files.length)]
      : null;

    let mesh;
    if (filename) {
      mesh = await getHerdMeshByFilename(herdId, filename, tint);
    } else {
      mesh = null;
    }

    if (mesh) {
      // Follower size is already set by herdVrmLoader (normalized to 2.6u
      // tall to match the player's on-screen height). No extra rescale
      // here — doing one would double-normalize and shrink every follower.
      mesh.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(mesh);
      if (isFinite(box2.min.y)) mesh.position.y -= box2.min.y;
      mesh.traverse(o => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.frustumCulled = false;
          o.castShadow = true;
        }
      });
      if (fol.obj && fol.obj.parent) scene.remove(fol.obj);
      scene.add(mesh);
      fol.obj = mesh;
      fol.pos = mesh.position;

      // Attach the shared walk mixer. Arm bones are excluded so our per-
      // frame gun-hold pose (applied in _updateFollowers after the mixer
      // update) drives them into a shooter stance. Idle clips additionally
      // exclude hip/spine — the Mixamo Standing Idles have a 60°+ hip
      // cock baked in that tips Meebit VRMs sideways. Only works on VRM-
      // rigged meshes (HipsBone / LeftUpperLegBone / etc.) — the herd
      // VRMs satisfy that. Silently skipped if animations haven't finished
      // preloading yet.
      if (animationsReady()) {
        try {
          fol.mixer = attachMixer(mesh, {
            excludeBones: {
              default: GUN_HOLD_EXCLUDE_BONES,
              idle2:   IDLE_HIP_EXCLUDE_BONES,
              idle3:   IDLE_HIP_EXCLUDE_BONES,
              idle4:   IDLE_HIP_EXCLUDE_BONES,
            },
          });
          fol.mixer.playIdle(2);   // start still; update loop flips to walk when moving
        } catch (e) {
          console.warn('[Follower] attachMixer failed', e);
        }
      }
    } else {
      // Fallback: colored cube so the slot still renders.
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: tint, emissiveIntensity: 0.6,
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5, 0.6), mat);
      body.position.y = 0.75;
      placeholder.add(body);
    }

    // Aura ring below so it reads as an ally at a glance.
    const auraGeo = new THREE.RingGeometry(0.8, 1.2, 20);
    const auraMat = new THREE.MeshBasicMaterial({
      color: tint, side: THREE.DoubleSide, transparent: true, opacity: 0.45,
    });
    const aura = new THREE.Mesh(auraGeo, auraMat);
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.05;
    fol.obj.add(aura);

    fol.ready = true;
  } catch (err) {
    console.warn('[Follower] failed to load', herdId, err);
    fol.ready = true;   // keep the slot; the placeholder remains visible
  }
}

function _updateFollowers(dt, playerPos, playerFacing) {
  _pushTrail(playerPos, playerFacing);
  for (const f of followers) {
    if (!f.ready || !f.obj) continue;

    const lag = FOLLOWER_LAG_PER_SLOT * (f.slot + 1);
    const sample = _readTrail(lag);
    // Smooth follow — lerp toward the lagged sample so motion feels fluid
    // even if the ring gets stale near game start.
    const prevX = f.pos.x;
    const prevZ = f.pos.z;
    f.pos.x += (sample.x - f.pos.x) * Math.min(1, dt * 12);
    f.pos.z += (sample.z - f.pos.z) * Math.min(1, dt * 12);

    // STANDOFF + V-FORMATION BEHIND PLAYER.
    // Followers stay behind the player in a Galaga-style V shape rather
    // than a single-file line. Slot 0 is the wingman closest to center-
    // left, slot 1 is center-right, slot 2 is outer-left, etc. Alternating
    // sides and widening the V per row reads as squad formation instead
    // of a conga line.
    //
    // Layout math:
    //   row  = floor(slot / 2)                 0, 0, 1, 1, 2, 2
    //   side = (slot % 2) === 0 ? -1 : 1       L, R, L, R, L, R
    //   behind = STANDOFF_BASE + row * STANDOFF_PER_ROW
    //   lateral = (1 + row) * LATERAL_STEP * side
    //
    // So slots 0/1 sit at one step behind on each shoulder, slots 2/3
    // behind and wider, etc. Fills in as followers are earned.
    const STANDOFF_BASE = 4.0;
    const STANDOFF_PER_ROW = 2.2;
    const LATERAL_STEP = 2.2;
    const row = Math.floor(f.slot / 2);
    const side = (f.slot % 2) === 0 ? -1 : 1;
    const desiredBehind = STANDOFF_BASE + row * STANDOFF_PER_ROW;
    const desiredLateral = (1 + row) * LATERAL_STEP * side;
    const dxFromPlayer = f.pos.x - playerPos.x;
    const dzFromPlayer = f.pos.z - playerPos.z;
    const distFromPlayer = Math.sqrt(dxFromPlayer * dxFromPlayer + dzFromPlayer * dzFromPlayer);
    // Direction vectors relative to the player's facing.
    //   playerFacing is a yaw angle. forward = (sin(facing), cos(facing)).
    //   behind  = (-sin(facing), -cos(facing)).
    //   right   = (cos(facing), -sin(facing))   (perpendicular, clockwise)
    const behindX = -Math.sin(playerFacing);
    const behindZ = -Math.cos(playerFacing);
    const rightX  =  Math.cos(playerFacing);
    const rightZ  = -Math.sin(playerFacing);
    // Target = player pos + behind * desiredBehind + right * desiredLateral
    const targetX = playerPos.x + behindX * desiredBehind + rightX * desiredLateral;
    const targetZ = playerPos.z + behindZ * desiredBehind + rightZ * desiredLateral;
    // Blend the trail follow with the standoff target. Blend ramps up as
    // the follower gets closer to the player so close range always sits
    // in formation; far away, trail dominates.
    const STANDOFF_KICKIN = desiredBehind + Math.abs(desiredLateral) + 1.0;
    if (distFromPlayer < STANDOFF_KICKIN) {
      const blend = 1 - Math.min(1, Math.max(0, (distFromPlayer - desiredBehind * 0.5) / STANDOFF_KICKIN));
      f.pos.x += (targetX - f.pos.x) * blend * Math.min(1, dt * 10);
      f.pos.z += (targetZ - f.pos.z) * blend * Math.min(1, dt * 10);
    }

    // Face the direction of actual movement if moving; otherwise face the
    // player's facing so they look like they're watching the player's back.
    const movedX = f.pos.x - prevX;
    const movedZ = f.pos.z - prevZ;
    if (movedX * movedX + movedZ * movedZ > 0.0004) {
      f.obj.rotation.y = Math.atan2(movedX, movedZ);
    } else {
      f.obj.rotation.y = playerFacing;
    }

    // Drive the shared walk mixer if attached, else keep the old procedural
    // bob as a fallback so non-VRM / unloaded followers still show motion.
    // Speed scales with actual ground speed this frame so the feet step at
    // roughly the right tempo.
    if (f.mixer) {
      const groundSpeed = Math.hypot(f.pos.x - prevX, f.pos.z - prevZ) / Math.max(dt, 1e-4);
      if (groundSpeed > 0.5) {
        f.mixer.playWalk();
        // 3.0 is a magic number: tuned so the walk clip's stride reads as
        // "jogging" at the follower's normal trail speed. Walk's nominal
        // tempo fits a 3 u/s ground speed — anything faster needs to scale
        // the playback speed up, anything slower scales down.
        f.mixer.setSpeed(Math.min(1.6, Math.max(0.6, groundSpeed / 3.0)));
      } else {
        f.mixer.playIdle(2);
        f.mixer.setSpeed(1.0);
      }
      f.mixer.update(dt);
      // Gun-hold arm pose (mixer excluded these bones).
      applyGunHoldPose(f.obj);
    } else {
      // Fallback walk bob (no mixer attached — asset wasn't VRM, or anims
      // still loading at spawn time)
      f.walkPhase += dt * 9;
      f.obj.position.y = Math.abs(Math.sin(f.walkPhase)) * 0.05;
    }

    // Auto-fire at nearest enemy in range
    f.fireCd -= dt;
    if (f.fireCd <= 0) {
      const tgt = _findNearestEnemy(f.pos, FOLLOWER_RANGE);
      if (tgt) {
        _fireFollowerShot(f, tgt);
        f.fireCd = FOLLOWER_FIRE_INTERVAL;
      } else {
        // Short retry window so we snap onto a target quickly when one appears
        f.fireCd = 0.15;
      }
    }
  }

  // Follower bullets
  for (let i = followerBullets.length - 1; i >= 0; i--) {
    const b = followerBullets[i];
    const ud = b.userData;
    b.position.addScaledVector(ud.vel, dt);
    ud.life -= dt;
    if (ud.life <= 0 ||
        Math.abs(b.position.x) > ARENA ||
        Math.abs(b.position.z) > ARENA) {
      scene.remove(b);
      followerBullets.splice(i, 1);
      continue;
    }
    // Only hits enemies — no blocks, no civilians, no hives.
    let hit = -1;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      const r = e.isBoss ? 2.5 : 0.9;
      const dx = e.pos.x - b.position.x;
      const dz = e.pos.z - b.position.z;
      if (dx * dx + dz * dz < r * r) { hit = j; break; }
    }
    if (hit >= 0) {
      const e = enemies[hit];
      // Bosses take reduced follower damage too (same rationale as Pixl Pals).
      const dmg = e.isBoss ? ud.damage * 0.25 : ud.damage;
      e.hp -= dmg;
      e.hitFlash = 0.15;
      hitBurst(b.position, ud.color, 5);
      if (e.hp <= 0 && _killHandler) _killHandler(hit);
      scene.remove(b);
      followerBullets.splice(i, 1);
    }
  }
}

function _fireFollowerShot(f, target) {
  const origin = new THREE.Vector3(f.pos.x, 1.3, f.pos.z);
  _v.copy(target.pos).sub(origin);
  _v.y = 0;
  const d = _v.length();
  if (d < 0.001) return;
  _v.normalize();

  const geo = new THREE.BoxGeometry(0.22, 0.22, 0.55);
  const mat = new THREE.MeshBasicMaterial({
    color: FOLLOWER_BULLET_COLOR, transparent: true, opacity: 0.95,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(origin);
  m.lookAt(origin.x + _v.x, origin.y, origin.z + _v.z);
  m.userData = {
    vel: _v.clone().multiplyScalar(FOLLOWER_BULLET_SPEED),
    life: FOLLOWER_BULLET_LIFE,
    damage: FOLLOWER_DAMAGE,
    color: FOLLOWER_BULLET_COLOR,
  };
  scene.add(m);
  followerBullets.push(m);
}

// ============================================================================
// CHAIN LIGHTNING
// ============================================================================
// Triggered externally by chainLightningOnKill(enemy). We arc to the
// nearest living enemy within CHAIN_RANGE, deal damage, and keep going
// until jumps run out or no enemy is in range.
// ============================================================================

const CHAIN_RANGE = 8;
const CHAIN_BASE_DAMAGE = 60;
const CHAIN_FALLOFF = 0.8;     // each jump = 80% of the previous damage
const CHAIN_BASE_JUMPS = 2;    // stack 1 = 2 jumps, stack 2 = 3, ...

const chainBolts = [];         // visual line segments with lifetime

function _chainJumps() {
  return CHAIN_BASE_JUMPS + Math.max(0, stacks.chainLightning - 1);
}

export function chainLightningOnKill(deadEnemyOrPos) {
  if (stacks.chainLightning <= 0) return;
  // Accept either an enemy object or a Vector3 origin
  const origin = _v.set(
    deadEnemyOrPos.pos ? deadEnemyOrPos.pos.x : deadEnemyOrPos.x,
    1.5,
    deadEnemyOrPos.pos ? deadEnemyOrPos.pos.z : deadEnemyOrPos.z
  ).clone();

  let from = origin.clone();
  let dmg = CHAIN_BASE_DAMAGE;
  const hitSet = new Set();           // avoid arcing back to the same enemy
  if (deadEnemyOrPos.pos) hitSet.add(deadEnemyOrPos);
  let jumps = _chainJumps();

  while (jumps > 0) {
    let best = null, bestDsq = CHAIN_RANGE * CHAIN_RANGE;
    for (const e of enemies) {
      if (hitSet.has(e)) continue;
      const dx = e.pos.x - from.x;
      const dz = e.pos.z - from.z;
      const dsq = dx * dx + dz * dz;
      if (dsq < bestDsq) { bestDsq = dsq; best = e; }
    }
    if (!best) break;
    // Bosses take reduced chain damage, same 0.25 multiplier we use elsewhere.
    const finalDmg = best.isBoss ? dmg * 0.25 : dmg;
    best.hp -= finalDmg;
    best.hitFlash = 0.2;
    hitSet.add(best);

    _spawnChainBolt(from, new THREE.Vector3(best.pos.x, 1.5, best.pos.z));
    if (best.hp <= 0 && _killHandler) {
      const idx = enemies.indexOf(best);
      if (idx >= 0) _killHandler(idx);
    }
    from = new THREE.Vector3(best.pos.x, 1.5, best.pos.z);
    dmg *= CHAIN_FALLOFF;
    jumps--;
  }
  if (hitSet.size > (deadEnemyOrPos.pos ? 1 : 0)) {
    Audio.hit && Audio.hit();
  }
}

// Shared material for chain bolts — avoids allocating a new material per bolt.
const _chainMat = new THREE.LineBasicMaterial({
  color: 0x88eeff, transparent: true, opacity: 1.0,
});

// Cap simultaneous bolts to avoid geometry spam in dense crowds.
const MAX_CHAIN_BOLTS = 8;

function _spawnChainBolt(a, b) {
  // If too many bolts are already live, skip the visual — damage still
  // applied by the caller. Prevents the GPU/GC spike that was freezing
  // the screen when chain lightning chained through a dense crowd.
  if (chainBolts.length >= MAX_CHAIN_BOLTS) return;

  // Jagged lightning with fewer midpoints (4 steps instead of 6).
  const pts = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t + (Math.random() - 0.5) * 0.5 * Math.sin(t * Math.PI);
    const y = a.y + (b.y - a.y) * t + (Math.random() - 0.5) * 0.3 * Math.sin(t * Math.PI);
    const z = a.z + (b.z - a.z) * t + (Math.random() - 0.5) * 0.5 * Math.sin(t * Math.PI);
    pts.push(new THREE.Vector3(x, y, z));
  }
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  // Clone the shared material so each bolt can fade independently.
  const mat = _chainMat.clone();
  const line = new THREE.Line(geom, mat);
  line.userData.life = 0.18;
  scene.add(line);
  chainBolts.push(line);
  // Minimal sparkle — only at the target endpoint, small count.
  hitBurst(b, 0x88eeff, 2);
}

function _updateChainBolts(dt) {
  for (let i = chainBolts.length - 1; i >= 0; i--) {
    const b = chainBolts[i];
    b.userData.life -= dt;
    b.material.opacity = Math.max(0, b.userData.life / 0.18);
    if (b.userData.life <= 0) {
      scene.remove(b);
      b.geometry.dispose();
      b.material.dispose();
      chainBolts.splice(i, 1);
    }
  }
}

// ============================================================================
// POISON TRAIL
// ============================================================================
// Every POISON_DROP_INTERVAL sec while the player is moving we drop a
// poison patch at their feet. Each patch is a disc + persistent collision
// zone with DoT + slow. Patches fade over POISON_LIFE seconds.
// ============================================================================

const POISON_DROP_INTERVAL = 0.22;
const POISON_LIFE = 3.5;
const POISON_RADIUS = 1.3;
const POISON_DPS = 18;            // base. Scales with stack count.
const POISON_SLOW = 0.55;         // multiplier on enemy speed
const POISON_COLOR = 0x66ff33;
const POISON_MAX_PATCHES = 60;

const poisonPatches = [];
let poisonDropTimer = 0;
let lastPlayerX = 0, lastPlayerZ = 0;

function _poisonDps() {
  return POISON_DPS + (stacks.poisonTrail - 1) * 10;  // tier 1 → 18, tier 2 → 28, ...
}

function _dropPoisonPatch(x, z) {
  if (poisonPatches.length >= POISON_MAX_PATCHES) {
    // Recycle oldest
    const old = poisonPatches.shift();
    scene.remove(old.mesh);
  }
  const geo = new THREE.CircleGeometry(POISON_RADIUS, 20);
  const mat = new THREE.MeshBasicMaterial({
    color: POISON_COLOR, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.06, z);
  scene.add(m);
  poisonPatches.push({
    x, z, life: POISON_LIFE, mesh: m, mat,
  });
}

function _updatePoisonTrail(dt, playerPos) {
  if (stacks.poisonTrail > 0) {
    // Drop a patch if the player moved enough since last drop
    const dx = playerPos.x - lastPlayerX;
    const dz = playerPos.z - lastPlayerZ;
    const movedSq = dx * dx + dz * dz;
    poisonDropTimer -= dt;
    if (poisonDropTimer <= 0 && movedSq > 0.01) {
      _dropPoisonPatch(playerPos.x, playerPos.z);
      lastPlayerX = playerPos.x;
      lastPlayerZ = playerPos.z;
      // Higher stack counts drop patches more frequently (denser trail)
      poisonDropTimer = Math.max(0.05, POISON_DROP_INTERVAL / stacks.poisonTrail);
    }
  }

  // Age + visually fade patches; apply damage + slow to overlapping enemies
  const dps = _poisonDps();
  for (let i = poisonPatches.length - 1; i >= 0; i--) {
    const p = poisonPatches[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
      poisonPatches.splice(i, 1);
      continue;
    }
    p.mat.opacity = 0.55 * (p.life / POISON_LIFE);

    // Damage + slow enemies inside
    const r2 = POISON_RADIUS * POISON_RADIUS;
    for (const e of enemies) {
      if (e.hp <= 0) continue;
      const ex = e.pos.x - p.x;
      const ez = e.pos.z - p.z;
      if (ex * ex + ez * ez < r2) {
        // Damage — no kill-handler call here. Poison is a soft,
        // sustained tick; letting the main bullet pipeline kill
        // the enemy means the player still gets score/XP/loot
        // drops via the normal path.
        const effDps = e.isBoss ? dps * 0.25 : dps;
        e.hp -= effDps * dt;
        e.hitFlash = Math.max(e.hitFlash || 0, 0.08);
        // Flag the slow for this frame. enemies.js reads this before
        // applying movement if _poisoned is true; we expose a simple
        // slowing side-channel.
        e._poisonedUntil = (typeof e._poisonedUntil === 'number')
          ? Math.max(e._poisonedUntil, 0.2)
          : 0.2;
      }
    }
  }

  // Decay poison slow timer on every enemy (in case they've stepped out)
  for (const e of enemies) {
    if (typeof e._poisonedUntil === 'number' && e._poisonedUntil > 0) {
      e._poisonedUntil -= dt;
    }
  }
}

// Exposed helper — enemies.js can multiply speed by this value to apply slow.
export function getEnemySpeedMult(enemy) {
  if (!enemy) return 1;
  let mult = 1;
  if (typeof enemy._poisonedUntil === 'number' && enemy._poisonedUntil > 0) {
    mult *= POISON_SLOW;
  }
  // Chapter 7 only — roaches move at 0.65× speed. Per playtester:
  // "Can we make the roaches move a bit slower?" Stacks with poison.
  if (S.chapter === PARADISE_FALLEN_CHAPTER_IDX && enemy.type === 'roach') {
    mult *= 0.65;
  }
  return mult;
}

// ============================================================================
// CARD MODAL
// ============================================================================

// Chapter-indexed follower card image paths (uploaded to repo at
// assets/cards/). These are the hero images for the "ESCORT" pick.
const FOLLOWER_CARD_IMAGES = {
  0: 'assets/cards/pig_card.png',        // CH.1 Inferno
  1: 'assets/cards/elephant_card.png',   // CH.2 Crimson
  2: 'assets/cards/skeleton_card.png',   // CH.3 Solar
  3: 'assets/cards/robot_card.png',      // CH.4 Toxic
  4: 'assets/cards/visitor_card.png',    // CH.5 Arctic
  5: 'assets/cards/dissected_card.png',  // CH.6 Paradise
};

// Card definitions. Image-backed cards render the PNG as the card face;
// placeholder cards render a styled solid block with the title overlay.
const CARDS = [
  {
    key: 'follower',
    accent: '#ffd93d',
    titleFn: (chapterIdx) => {
      const chap = CHAPTERS[chapterIdx % CHAPTERS.length];
      const herd = chap && chap.bonusHerd ? chap.bonusHerd : { label: 'MEEBIT', icon: '🤖' };
      return {
        title: herd.icon + ' ' + herd.label + ' ESCORT',
        sub: 'Permanent follower. Auto-fires. Stacks to 6.',
      };
    },
    imageFn: (chapterIdx) => FOLLOWER_CARD_IMAGES[chapterIdx % 6] || FOLLOWER_CARD_IMAGES[0],
  },
  {
    key: 'chainLightning',
    accent: '#88eeff',
    titleFn: () => ({
      title: '⚡ CHAIN LIGHTNING',
      sub: 'Kills arc lightning between enemies. Stacks add jumps.',
    }),
    imageFn: () => null, // placeholder — art TBD
  },
  {
    key: 'poisonTrail',
    accent: '#66ff33',
    titleFn: () => ({
      title: '☠ POISON TRAIL',
      sub: 'Toxic patches slow and damage enemies.',
    }),
    imageFn: () => null, // placeholder — art TBD
  },
];

let _modalEl = null;
let _styleEl = null;

// Inject the modal stylesheet once. Defines the card layout, pulsing gold
// glow around each card, and the animated matrix rain overlay that tints
// each card face in green.
function _injectStyles() {
  if (_styleEl) return;
  _styleEl = document.createElement('style');
  _styleEl.id = 'powerup-modal-styles';
  _styleEl.textContent = `
    #powerup-modal {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(5px);
      font-family: Impact, 'Arial Black', sans-serif;
    }
    #powerup-modal .pu-header {
      font-size: 14px;
      letter-spacing: 6px;
      color: #fff;
      opacity: 0.7;
      margin-bottom: 6px;
      text-align: center;
    }
    #powerup-modal .pu-title {
      font-size: 42px;
      letter-spacing: 4px;
      color: #ffd93d;
      text-shadow: 0 0 24px #ffd93d, 3px 3px 0 #000;
      margin-bottom: 28px;
      text-align: center;
    }
    #powerup-modal .pu-cards {
      display: flex;
      gap: 22px;
      justify-content: center;
      flex-wrap: wrap;
    }
    #powerup-modal .pu-card {
      position: relative;
      width: 260px;
      height: 360px;
      border-radius: 12px;
      cursor: pointer;
      overflow: hidden;
      user-select: none;
      transition: transform 0.18s ease, filter 0.18s ease;
      background: #000;
      box-shadow: 0 0 0 3px var(--accent), 0 0 28px var(--accent-glow);
      animation: puCardGlow 2.4s ease-in-out infinite;
    }
    #powerup-modal .pu-card:hover {
      transform: translateY(-6px) scale(1.03);
      filter: brightness(1.12);
      animation-play-state: paused;
      box-shadow: 0 0 0 3px var(--accent), 0 0 48px var(--accent), 0 0 80px var(--accent-glow);
    }
    @keyframes puCardGlow {
      0%, 100% { box-shadow: 0 0 0 3px var(--accent), 0 0 22px var(--accent-glow); }
      50%      { box-shadow: 0 0 0 3px var(--accent), 0 0 42px var(--accent); }
    }
    #powerup-modal .pu-card-face {
      position: absolute;
      inset: 0;
      background-size: cover;
      background-position: center;
      background-color: #0a0a14;
    }
    /* Matrix rain — a CSS-only animated cover. Thin green vertical streaks
       scroll downward over the image, set to "screen" blend so the image
       stays readable but picks up a green glitch-tint. */
    #powerup-modal .pu-matrix {
      position: absolute;
      inset: 0;
      pointer-events: none;
      mix-blend-mode: screen;
      opacity: 0.55;
      background:
        repeating-linear-gradient(
          to bottom,
          rgba(0, 255, 80, 0.0) 0px,
          rgba(0, 255, 80, 0.0) 4px,
          rgba(0, 255, 80, 0.55) 6px,
          rgba(0, 255, 80, 0.0) 12px
        ),
        repeating-linear-gradient(
          to right,
          rgba(0, 0, 0, 0.0) 0px,
          rgba(0, 0, 0, 0.0) 10px,
          rgba(0, 40, 10, 0.6) 11px,
          rgba(0, 0, 0, 0.0) 14px
        );
      background-size: 100% 200px, 100% 100%;
      animation: puMatrixRain 2.6s linear infinite;
    }
    @keyframes puMatrixRain {
      0%   { background-position: 0 0, 0 0; }
      100% { background-position: 0 200px, 0 0; }
    }
    /* Global green tint that gets multiplied over the image so it reads as
       "matrix-coded" while still legible. */
    #powerup-modal .pu-tint {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        to bottom,
        rgba(0, 255, 80, 0.15),
        rgba(0, 60, 20, 0.05) 40%,
        rgba(0, 0, 0, 0.35)
      );
      mix-blend-mode: multiply;
    }
    /* Scan-line flicker for extra matrix-y feel */
    #powerup-modal .pu-scan {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: repeating-linear-gradient(
        to bottom,
        rgba(0, 0, 0, 0) 0px,
        rgba(0, 0, 0, 0) 2px,
        rgba(0, 0, 0, 0.18) 3px
      );
      opacity: 0.5;
    }
    #powerup-modal .pu-panel {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      padding: 10px 12px 12px;
      background: linear-gradient(to top, rgba(0,0,0,0.92), rgba(0,0,0,0.6) 70%, rgba(0,0,0,0));
      text-align: center;
    }
    #powerup-modal .pu-num {
      position: absolute;
      top: 8px; left: 10px;
      color: var(--accent);
      font-size: 14px;
      letter-spacing: 3px;
      opacity: 0.9;
      text-shadow: 0 0 6px var(--accent-glow), 1px 1px 0 #000;
    }
    #powerup-modal .pu-owned {
      position: absolute;
      top: 8px; right: 10px;
      color: var(--accent);
      font-size: 11px;
      letter-spacing: 2px;
      background: rgba(0,0,0,0.7);
      border: 1px solid var(--accent);
      padding: 2px 6px;
      border-radius: 3px;
    }
    #powerup-modal .pu-card-title {
      color: var(--accent);
      font-size: 20px;
      letter-spacing: 2px;
      text-shadow: 0 0 12px var(--accent-glow), 2px 2px 0 #000;
      margin-bottom: 6px;
    }
    #powerup-modal .pu-card-sub {
      color: #ccc;
      font-size: 12px;
      letter-spacing: 1px;
      line-height: 1.4;
      font-family: Arial, sans-serif;
    }
    /* Placeholder cards — simple themed block with big centered emoji */
    #powerup-modal .pu-placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 120px;
      color: var(--accent);
      text-shadow: 0 0 32px var(--accent-glow);
      background:
        radial-gradient(circle at 50% 45%, rgba(255,255,255,0.08), rgba(0,0,0,0) 65%),
        linear-gradient(180deg, #0a0a1a, #000);
    }
    #powerup-modal .pu-hint {
      margin-top: 22px;
      font-size: 11px;
      letter-spacing: 3px;
      color: #888;
      text-align: center;
    }

    /* ============================================================
       MOBILE — keep all 3 cards SIDE BY SIDE per playtester request:
       "On the choose power up at the end of each chapter we need
       the 3 cards to be side by side. So maybe make them all smaller."
       Default desktop layout has flex-wrap so 3 × 260px cards wrap
       to 2+1 on narrow screens. We override to nowrap with shrunk
       cards so they fit on one line on a phone.
       ============================================================ */
    @media (max-width: 900px), (pointer: coarse) {
      #powerup-modal .pu-header {
        font-size: 10px;
        letter-spacing: 4px;
        margin-bottom: 4px;
      }
      #powerup-modal .pu-title {
        font-size: 24px;
        letter-spacing: 2px;
        margin-bottom: 14px;
      }
      #powerup-modal .pu-cards {
        flex-wrap: nowrap;
        gap: 8px;
        padding: 0 6px;
        max-width: 100vw;
      }
      #powerup-modal .pu-card {
        width: 110px;
        height: 155px;
        flex: 0 0 110px;
        border-radius: 8px;
      }
      #powerup-modal .pu-num {
        font-size: 9px;
        letter-spacing: 1px;
        top: 4px; left: 5px;
      }
      #powerup-modal .pu-owned {
        font-size: 8px;
        letter-spacing: 1px;
        padding: 1px 4px;
        top: 4px; right: 5px;
      }
      #powerup-modal .pu-panel {
        padding: 6px 6px 7px;
      }
      #powerup-modal .pu-card-title {
        font-size: 11px;
        letter-spacing: 1px;
        margin-bottom: 2px;
      }
      #powerup-modal .pu-card-sub {
        font-size: 9px;
        letter-spacing: 0.3px;
        line-height: 1.25;
      }
      #powerup-modal .pu-placeholder {
        font-size: 56px;
      }
      #powerup-modal .pu-hint {
        margin-top: 12px;
        font-size: 9px;
        letter-spacing: 2px;
      }
    }
  `;
  document.head.appendChild(_styleEl);
}

function _buildModalOnce() {
  if (_modalEl) return _modalEl;
  _injectStyles();
  const el = document.createElement('div');
  el.id = 'powerup-modal';
  el.innerHTML = `
    <div style="max-width: 960px; padding: 20px;">
      <div class="pu-header" id="pu-sub">CHAPTER COMPLETE</div>
      <div class="pu-title">CHOOSE A POWER-UP</div>
      <div class="pu-cards" id="pu-cards"></div>
      <div class="pu-hint">CLICK A CARD · OR PRESS 1 / 2 / 3</div>
    </div>
  `;
  document.body.appendChild(el);
  _modalEl = el;
  return el;
}

function _renderModal(chapterIdx) {
  const el = _buildModalOnce();
  el._chapterIdx = chapterIdx;
  const sub = el.querySelector('#pu-sub');
  sub.textContent = 'CHAPTER ' + (chapterIdx + 1) + ' COMPLETE';

  const cardsEl = el.querySelector('#pu-cards');
  cardsEl.innerHTML = '';

  // Placeholder emoji per card key (used when no image available).
  const PLACEHOLDER_EMOJI = {
    chainLightning: '⚡',
    poisonTrail: '☠',
  };

  CARDS.forEach((card, idx) => {
    const info = card.titleFn(chapterIdx);
    const imgPath = card.imageFn ? card.imageFn(chapterIdx) : null;

    const cardEl = document.createElement('div');
    cardEl.className = 'pu-card';
    // Glow tint is a 40% alpha version of accent. For a hex like #88eeff
    // we just use the full color for the glow and let box-shadow do the work.
    cardEl.style.setProperty('--accent', card.accent);
    cardEl.style.setProperty('--accent-glow', card.accent + '99'); // 60% alpha

    // Face: either a background-image or a placeholder block with emoji
    let faceHtml;
    if (imgPath) {
      faceHtml = `
        <div class="pu-card-face" style="background-image:url('${imgPath}');"></div>
        <div class="pu-matrix"></div>
        <div class="pu-tint"></div>
        <div class="pu-scan"></div>
      `;
    } else {
      const emoji = PLACEHOLDER_EMOJI[card.key] || '?';
      faceHtml = `
        <div class="pu-placeholder">${emoji}</div>
        <div class="pu-matrix"></div>
        <div class="pu-scan"></div>
      `;
    }

    const ownedHtml = stacks[card.key] > 0
      ? `<div class="pu-owned">OWNED: ${stacks[card.key]}</div>`
      : '';

    cardEl.innerHTML = `
      ${faceHtml}
      <div class="pu-num">${idx + 1}</div>
      ${ownedHtml}
      <div class="pu-panel">
        <div class="pu-card-title">${info.title}</div>
        <div class="pu-card-sub">${info.sub}</div>
      </div>
    `;
    cardEl.addEventListener('click', () => _pickCard(card.key, chapterIdx));
    cardsEl.appendChild(cardEl);
  });

  el.style.display = 'flex';
}

function _hideModal() {
  if (_modalEl) _modalEl.style.display = 'none';
}

function _pickCard(key, chapterIdx) {
  if (stacks[key] == null) return;
  stacks[key] += 1;

  if (key === 'follower') {
    _spawnFollower(chapterIdx);   // fire-and-forget async load
  }
  // Chain lightning + poison are read lazily every frame — nothing else to do here.

  Audio.levelup && Audio.levelup();

  _hideModal();
  S.paused = false;
  const cb = pendingResume;
  pendingResume = null;
  if (cb) cb();
}

// Keyboard shortcut: 1 / 2 / 3 while the modal is up
function _onKey(e) {
  if (!_modalEl || _modalEl.style.display !== 'flex') return;
  const map = { '1': 0, '2': 1, '3': 2 };
  if (map[e.key] != null) {
    const card = CARDS[map[e.key]];
    // Need chapterIdx — we stashed it on the modal for this lookup
    _pickCard(card.key, _modalEl._chapterIdx);
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * One-time module setup. Safe to call multiple times.
 */
export function initPowerups() {
  _buildModalOnce();
  window.removeEventListener('keydown', _onKey);
  window.addEventListener('keydown', _onKey);
}

/**
 * Register the kill pipeline — same pattern as turrets.js / pixlPals.js.
 * Receives the index of the enemy in the enemies[] array to remove.
 */
let _killHandler = null;
export function registerPowerupKillHandler(fn) {
  _killHandler = fn;
}

/**
 * Called at chapter completion (right when the COMPLETE toast fires).
 * Pauses the game, shows the card modal, and invokes `resumeCallback`
 * after the player picks.
 *
 * If the chapter already offered a reward, no-op + immediately resumes.
 */
export function maybeShowChapterReward(chapterIdx, resumeCallback) {
  // CH7 (PARADISE FALLEN) has no powerup rewards. The chapter is
  // designed as a fresh-slate empty arena — the player gets a starter
  // stratagem loadout on entry (granted by main.js's chapter-7 entry
  // block) and that's the entirety of the toolkit. Skip the modal
  // and continue the run.
  if (chapterIdx === PARADISE_FALLEN_CHAPTER_IDX) {
    if (resumeCallback) resumeCallback();
    return false;
  }
  if (rewardedChapters.has(chapterIdx)) {
    if (resumeCallback) resumeCallback();
    return false;
  }
  rewardedChapters.add(chapterIdx);
  pendingResume = resumeCallback || null;
  S.paused = true;
  _buildModalOnce()._chapterIdx = chapterIdx;
  _renderModal(chapterIdx);
  return true;
}

/**
 * Per-frame tick. Called from main.js animate() AFTER updatePlayer so we
 * always sample the current player position.
 */
export function updatePowerups(dt, playerPos, playerFacing) {
  if (!S.running || S.paused) return;
  _updateFollowers(dt, playerPos, playerFacing);
  _updateChainBolts(dt);
  _updatePoisonTrail(dt, playerPos);
}

/**
 * Reset all powerup state on game reset.
 */
export function clearAllPowerups() {
  // Followers
  for (const f of followers) {
    if (f.mixer) { try { f.mixer.stop && f.mixer.stop(); } catch (e) {} f.mixer = null; }
    if (f.obj && f.obj.parent) scene.remove(f.obj);
  }
  followers.length = 0;
  for (const b of followerBullets) {
    if (b && b.parent) scene.remove(b);
  }
  followerBullets.length = 0;

  // Chain bolts
  for (const b of chainBolts) {
    if (b && b.parent) scene.remove(b);
    if (b.geometry) b.geometry.dispose();
    if (b.material) b.material.dispose();
  }
  chainBolts.length = 0;

  // Poison
  for (const p of poisonPatches) {
    if (p.mesh && p.mesh.parent) scene.remove(p.mesh);
    if (p.mesh && p.mesh.geometry) p.mesh.geometry.dispose();
    if (p.mat) p.mat.dispose();
  }
  poisonPatches.length = 0;

  // Stacks + flags
  stacks.follower = 0;
  stacks.chainLightning = 0;
  stacks.poisonTrail = 0;
  rewardedChapters.clear();
  pendingResume = null;
  playerTrail.initialized = false;
  _hideModal();
}

/**
 * True if any powerup has been picked (used for HUD / debug).
 */
export function powerupsActive() {
  return stacks.follower > 0 || stacks.chainLightning > 0 || stacks.poisonTrail > 0;
}

export function getPowerupStacks() {
  return { ...stacks };
}

// ============================================================================
// HELPERS
// ============================================================================

function _findNearestEnemy(fromPos, maxRange) {
  let best = null, bestDsq = maxRange * maxRange;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const dx = e.pos.x - fromPos.x;
    const dz = e.pos.z - fromPos.z;
    const dsq = dx * dx + dz * dz;
    if (dsq < bestDsq) { bestDsq = dsq; best = e; }
  }
  return best;
}
