import * as THREE from 'three';
import { scene } from './scene.js';
import { SPAWNER_CONFIG, HIVE_CONFIG, CHAPTERS, ARENA } from './config.js';
import { hitBurst } from './effects.js';
import { getTriangleFor } from './triangles.js';

export const spawners = [];

// --- Wave-3-to-wave-4 retraction ---
//
// After wave 3 ends and before wave 4 starts, waves.js calls
// startHiveRetraction(). Every hive group (live and destroyed-collapsing)
// sinks into the ground over HIVE_RETRACT_SEC, then gets removed from
// the scene. Lore: the enemy infrastructure recalls its portals once the
// assault phase fails.
const HIVE_RETRACT_SEC = 2.0;
let _retractActive = false;
let _retractT = 0;

export function startHiveRetraction() {
  if (_retractActive) return;
  _retractActive = true;
  _retractT = 0;
}

/**
 * Failsafe — force any in-flight retraction (and all lingering hives) to
 * finish immediately. Used as a belt-and-suspenders cleanup at wave 4 start
 * so a hive that never finished its sink animation (due to wave-type flip,
 * low frame rate, backgrounded tab, etc) can't leak into the next wave.
 *
 * Idempotent and safe to call whether a retraction is active or not.
 */
export function forceCompleteRetraction() {
  // Remove every hive group from the scene regardless of retraction state.
  for (const s of spawners) {
    if (s.obj && s.obj.parent) scene.remove(s.obj);
    s.destroyed = true;
  }
  spawners.length = 0;
  _retractActive = false;
  _retractT = 0;
}

export function isHiveRetracting() {
  return _retractActive;
}

// Position of the most-recently-destroyed hive — wave-3-end shockwave
// originates here. Updated inside destroySpawner() each time a hive
// falls. Null before any hive destruction.
let _lastHiveDeathPos = null;
export function getLastHiveDeathPos() { return _lastHiveDeathPos; }

// Create a portal at (x, z) tinted to the current chapter color.
export function spawnPortal(x, z, chapterIdx) {
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.lamp;
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Base platform
  const baseGeo = new THREE.CylinderGeometry(2.0, 2.2, 0.3, 12);
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a2a, emissive: tint, emissiveIntensity: 0.25, roughness: 0.6,
  });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.position.y = 0.15;
  base.castShadow = true;
  group.add(base);

  // Vertical ring (the portal "frame")
  const ringGeo = new THREE.TorusGeometry(1.6, 0.15, 8, 24);
  const ringMat = new THREE.MeshStandardMaterial({
    color: tint, emissive: tint, emissiveIntensity: 2.2, metalness: 0.7, roughness: 0.3,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = 2.0;
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  // Inner portal (swirling core)
  const coreMat = new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  });
  const core = new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), coreMat);
  core.position.y = 2.0;
  core.rotation.x = Math.PI / 2;
  group.add(core);

  // Center orb
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 12, 8),
    new THREE.MeshStandardMaterial({
      color: tint, emissive: tint, emissiveIntensity: 3.5,
    })
  );
  orb.position.y = 2.0;
  group.add(orb);

  // Point light removed — spawning 4 hives added 4 PointLights per
  // wave-2 start, triggering shader recompile stalls. The emissive
  // orb + vertical beam give the hive enough visual presence.
  // const light = new THREE.PointLight(tint, 3.5, 18, 1.3);
  // light.position.y = 2.0;
  // group.add(light);

  // Beam going straight up
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.6, 20, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  beam.position.y = 12;
  group.add(beam);

  scene.add(group);

  return {
    obj: group,
    pos: group.position,
    ring, core, orb, base, beam, coreMat, ringMat, baseMat,
    hp: SPAWNER_CONFIG.spawnerHp || 180,
    hpMax: SPAWNER_CONFIG.spawnerHp || 180,
    hitFlash: 0,
    spawnCooldown: 0.5 + Math.random() * HIVE_CONFIG.spawnIntervalSec,
    enemiesAlive: 0,
    destroyed: false,
    tint,
  };
}

/**
 * Pick N random hive positions INSIDE the hive triangle, avoiding:
 *   - the map center (player spawn)
 *   - each other (minimum pairwise distance)
 *   - the arena edge (so hives are reachable)
 *
 * The triangulation system assigns wave 3 (hive wave) to one of three
 * arena wedges each chapter. All hives cluster in that wedge, keeping
 * wave-1 mining and wave-2 power-up space clear.
 */
function pickRandomHivePositions(count) {
  const cfg = HIVE_CONFIG;
  const minC = cfg.minDistFromCenter;
  const minPair = cfg.minPairwiseDist;
  const maxR = ARENA - 6;

  // Constrain angle to the hive triangle. Every random angle draw falls
  // inside the wedge — no rejection sampling needed.
  const tri = getTriangleFor('hive');
  const aMin = tri.minAngle;
  const aSpan = tri.maxAngle - tri.minAngle;

  const picked = [];
  let attempts = 0;
  while (picked.length < count && attempts < 400) {
    attempts++;
    const angle = aMin + Math.random() * aSpan;
    const r = minC + Math.random() * (maxR - minC);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    let ok = true;
    for (const p of picked) {
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz < minPair * minPair) { ok = false; break; }
    }
    if (ok) picked.push({ x, z });
  }
  // Fallback: relax the pairwise constraint but stay inside the triangle.
  // Hives getting slightly crowded is better than one leaking into the
  // mining or power-up wedge.
  while (picked.length < count) {
    const angle = aMin + Math.random() * aSpan;
    const r = minC + Math.random() * (maxR - minC);
    picked.push({ x: Math.cos(angle) * r, z: Math.sin(angle) * r });
  }
  return picked;
}

export function spawnAllPortals(chapterIdx) {
  clearAllPortals();
  const positions = pickRandomHivePositions(HIVE_CONFIG.hiveCount);
  for (const p of positions) {
    spawners.push(spawnPortal(p.x, p.z, chapterIdx));
  }
}

// New canonical names for the hive phase. Kept alongside old names for
// back-compat so existing imports don't break.
export const spawnAllHives = spawnAllPortals;

export function damageSpawner(spawner, dmg) {
  if (spawner.destroyed) return false;
  // Shielded hives (waves 1-2 before EMP) are invulnerable. Fire a white
  // spark on the shield surface so the player sees their shots landing
  // but bouncing — no damage is applied.
  if (spawner.shielded) {
    hitBurst(
      new THREE.Vector3(spawner.pos.x, 2.2, spawner.pos.z),
      0xffffff, 2
    );
    return false;
  }
  spawner.hp -= dmg;
  spawner.hitFlash = 0.2;
  // Extra-visible hit burst — sparks at the impact point plus a shower
  // of chapter-color chunks. Bigger than the default so the hive feels
  // meaty to shoot.
  hitBurst(
    new THREE.Vector3(spawner.pos.x, 2.2, spawner.pos.z),
    0xffffff, 4
  );
  hitBurst(
    new THREE.Vector3(spawner.pos.x, 2, spawner.pos.z),
    spawner.tint, 8
  );
  if (spawner.hp <= 0) {
    destroySpawner(spawner);
    return true;
  }
  return false;
}

function destroySpawner(spawner) {
  spawner.destroyed = true;
  spawner.hp = 0;
  // Record death position for the wave-3-end shockwave. Overwrites each
  // time a hive falls — the final overwrite is the "last hive standing".
  _lastHiveDeathPos = { x: spawner.pos.x, y: 0.2, z: spawner.pos.z };
  // Big explosion
  const pos = new THREE.Vector3(spawner.pos.x, 2, spawner.pos.z);
  hitBurst(pos, 0xffffff, 30);
  hitBurst(pos, spawner.tint, 25);
  setTimeout(() => hitBurst(pos, 0xff3cac, 20), 80);

  // Collapse animation: shrink the whole group
  spawner.obj.userData._collapsing = true;
  spawner.obj.userData._collapseT = 0;
}

export function updateSpawners(dt) {
  // Global retraction tick — invoked from waves.js startHiveRetraction()
  // before wave 4 starts. Every hive (destroyed-and-collapsed OR still
  // standing) sinks into the ground over 2s.
  if (_retractActive) {
    _retractT = Math.min(HIVE_RETRACT_SEC, _retractT + dt);
    const f = _retractT / HIVE_RETRACT_SEC;
    const eased = f * f;
    const sinkY = -eased * 6;
    for (const s of spawners) {
      if (s.obj && s.obj.parent) {
        s.obj.position.y = sinkY;
      }
    }
    if (f >= 1) {
      _retractActive = false;
      // Remove every hive group from scene now that they're underground,
      // AND clear the spawners array so objective arrows, livePortalCount(),
      // and the hive objective-label stop referencing the now-invisible
      // hive data. Without this, a destroyed-but-array-resident hive (or
      // any stragglers referenced by an arrow target) can leave a "HIVE"
      // label stuck on-screen into wave 4.
      for (const s of spawners) {
        if (s.obj && s.obj.parent) scene.remove(s.obj);
        s.destroyed = true;   // flag so any late reference treats it as dead
      }
      spawners.length = 0;
    }
  }

  const now = performance.now();
  for (const s of spawners) {
    if (s.destroyed) {
      // Collapse animation
      if (s.obj.userData._collapsing) {
        s.obj.userData._collapseT += dt;
        const t = s.obj.userData._collapseT;
        const scale = Math.max(0, 1 - t * 2);
        s.obj.scale.setScalar(scale);
        s.obj.rotation.y += dt * 8;
        if (scale <= 0) {
          scene.remove(s.obj);
          s.obj.userData._collapsing = false;
        }
      }
      continue;
    }

    // HP ratio: 1.0 at full, 0.0 just before destruction
    const ratio = Math.max(0, s.hp / s.hpMax);

    // SHRINK as HP drops — the hive visibly diminishes as you shoot it.
    // Scale from 1.0 (full) to 0.55 (near death).
    const targetScale = 0.55 + ratio * 0.45;
    // Smooth lerp so hits pulse the scale inward
    const curScale = s.obj.scale.x;
    s.obj.scale.setScalar(curScale + (targetScale - curScale) * Math.min(1, dt * 8));

    // PULSE FASTER as HP drops — emissive throb accelerates near death.
    const pulseHz = 2.0 + (1 - ratio) * 8;
    const pulse = (Math.sin(now * 0.001 * pulseHz * Math.PI * 2) + 1) * 0.5; // 0..1

    // Rotate the core + orb (faster as HP drops so it looks desperate)
    const rotSpeed = 1.5 + (1 - ratio) * 4;
    s.core.rotation.z += dt * rotSpeed;
    s.orb.position.y = 2.0 + Math.sin(now * 0.003) * 0.2;
    s.orb.rotation.y += dt * (2 + (1 - ratio) * 5);

    // Beam pulse — intensifies at low HP
    s.beam.material.opacity = 0.25 + Math.sin(now * 0.004) * 0.15 + (1 - ratio) * 0.25;

    // EMISSIVE INTENSITY — base level pulses faster near death, and
    // adds hit-flash on top. Ring gets BRIGHTER as it gets more damaged,
    // telegraphing "this thing is about to pop".
    const baseEmissive = 2.2 + (1 - ratio) * 2.0 + pulse * (1 - ratio) * 2.5;
    if (s.hitFlash > 0) {
      s.hitFlash -= dt;
      s.ringMat.emissiveIntensity = baseEmissive + s.hitFlash * 8;
    } else {
      s.ringMat.emissiveIntensity = baseEmissive;
    }

    // ORB EMISSIVE — also ramps with damage so the hive "overheats"
    if (s.orb.material && s.orb.material.emissiveIntensity !== undefined) {
      s.orb.material.emissiveIntensity = 3.5 + (1 - ratio) * 4 + (s.hitFlash > 0 ? s.hitFlash * 10 : 0);
    }
  }
}

// Returns count of still-alive portals
export function livePortalCount() {
  let n = 0;
  for (const s of spawners) if (!s.destroyed) n++;
  return n;
}

export function clearAllPortals() {
  for (const s of spawners) {
    if (s.obj.parent) scene.remove(s.obj);
  }
  spawners.length = 0;
}

// Pick a random NON-destroyed portal to spawn an enemy from.
// Returns null if all are destroyed.
export function pickActivePortal() {
  const live = spawners.filter(s => !s.destroyed);
  if (live.length === 0) return null;
  return live[Math.floor(Math.random() * live.length)];
}

// Hive-phase aliases for readability in new code
export const liveHiveCount = livePortalCount;
export const clearAllHives = clearAllPortals;
export const pickActiveHive = pickActivePortal;
export const hives = spawners;
