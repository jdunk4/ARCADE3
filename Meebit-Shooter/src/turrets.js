// ============================================================================
// src/turrets.js — automated defense turrets.
//
// Three turrets spawn at chapter start (via dormantProps.prepareChapter).
// They sit dormant (dim, barrel drooping) through wave 1 and the first two
// stages of wave 2, then come online progressively during the power-up
// wave. While active they auto-target the nearest enemy inside range and
// fire a pistol-like bullet on their own cadence. When the EMP fires at
// the end of wave 2, they power down and stay dormant for the rest of
// the chapter (waves 3, 4, 5).
//
// Design notes
//
//  - Turret bullets live in their OWN array, separate from player bullets.
//    This avoids the turret accidentally chewing mining blocks in wave 1,
//    and keeps collision pipelines cheap / independent.
//  - Turret bullets only collide with enemies. They reduce enemy HP, fire
//    a hit-burst, and call killEnemyIfDead() if they drop the enemy.
//  - Position: fixed triangle around the arena at radius ~24 units. The
//    three placements are deterministic so players learn the firing arcs.
//  - Activation flow:
//       Wave 2 step 1 ('POWER')      → no turrets yet, just power
//       Wave 2 step 2 ('TURRETS_A')  → turret 0 online
//       Wave 2 step 3 ('TURRETS_B')  → turrets 1 + 2 online
//       Wave 2 step 5 ('EMP')        → all turrets offline
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS, ARENA } from './config.js';
import { hitBurst } from './effects.js';
import { enemies } from './enemies.js';
import { Audio } from './audio.js';
import { LAYOUT, _setTurretsGetter } from './waveProps.js';
import { S } from './state.js';

// Exposed array so main.js / others can iterate if they need to. We also
// export a turretBullets array; main.js's update loop calls updateTurrets
// every frame and the bullet pipeline is fully self-contained here.
export const turrets = [];
export const turretBullets = [];

// Register with waveProps so its retraction tick can animate turret
// groups alongside the silo/powerplant/radio.
_setTurretsGetter(() => turrets);

// Kill handler — mirrors the block-explosion handler pattern. Registered
// from main.js at startup. Turret bullets call it when a shot drops an
// enemy so the existing killEnemy() path handles score, XP, drops, and
// onEnemyKilled() bookkeeping. Without a registered handler the turret
// still deals damage, but kills won't tick score / loot.
let _killHandler = null;
export function registerTurretKillHandler(fn) {
  _killHandler = fn;
}

// Turret positions come from waveProps.LAYOUT.turrets. Three turrets
// cluster in an equilateral triangle of radius 6 around the EMP silo
// wherever the triangulation system placed the compound this chapter.
// Read at spawn time (not import time) because LAYOUT mutates when
// buildCentralCompound recomputes positions per chapter.

// Turret tuning.
const TURRET_CFG = {
  range: 22,            // units — enemies outside this radius are ignored
  fireIntervalSec: 1.35,// seconds between shots (per turret)
  bulletSpeed: 44,      // units/sec
  bulletDamage: 28,     // per hit
  bulletLife: 1.6,      // seconds before despawn
  hitRadius: 1.0,       // collision radius vs enemy
  scanIntervalSec: 0.2, // target re-scan cadence
  aimTurnRate: 6.0,     // rad/s barrel rotation
  bulletColor: 0xfff08a,// soft yellow, reads as "ally fire"
};

// ---------------------------------------------------------------------------
// CHAPTER WEAPON PROGRESSION
//
// Turrets become more powerful as chapters advance, mirroring the player's
// own weapon ladder:
//   Chapter 1  → PISTOL     (single shot, moderate dps)
//   Chapter 2  → SHOTGUN    (5 pellets per shot, spread, slower cadence)
//   Chapter 3  → SMG        (fast cadence, small bullets)
//   Chapter 4  → ROCKET     (slow, heavy homing AoE)
//   Chapter 5  → RAYGUN     (continuous beam ticks)
// Chapter 6+  cycles back to the start so later chapters still fire.
//
// Each profile overrides fireInterval, damage, bulletSpeed, bulletColor,
// hitRadius, and the shot type. `type` tells _fireTurretBullet() which path
// to take: 'bullet' (default), 'shotgun', 'smg', 'rocket', 'beam'.
// ---------------------------------------------------------------------------
const TURRET_PROFILES = [
  {
    // Chapter 1 — Pistol.
    type: 'bullet',
    fireInterval: 1.35,
    damage: 28,
    bulletSpeed: 44,
    bulletColor: 0xfff08a,   // soft yellow
    hitRadius: 1.0,
  },
  {
    // Chapter 2 — Shotgun. Slower cadence but fires a spread of 5 pellets.
    type: 'shotgun',
    fireInterval: 1.85,
    damage: 16,              // per pellet
    pellets: 5,
    spread: 0.22,            // radians half-angle
    bulletSpeed: 40,
    bulletColor: 0xff8800,
    hitRadius: 0.9,
  },
  {
    // Chapter 3 — SMG. Fast cadence, small bullets.
    type: 'smg',
    fireInterval: 0.32,
    damage: 14,
    bulletSpeed: 48,
    bulletColor: 0xff3cac,
    hitRadius: 0.8,
  },
  {
    // Chapter 4 — Rocket. Slow cadence, heavy damage + AoE on impact.
    type: 'rocket',
    fireInterval: 2.4,
    damage: 70,              // direct hit
    explosionRadius: 3.5,
    explosionDamage: 55,
    bulletSpeed: 26,
    bulletColor: 0xffaa00,
    hitRadius: 1.1,
  },
  {
    // Chapter 5 — Raygun. Continuous beam that ticks damage rapidly while
    // a target is in range. Represented as a visible ray each tick rather
    // than a persistent mesh (cheaper, still reads as a beam weapon).
    type: 'beam',
    fireInterval: 0.12,      // tick cadence while target acquired
    damage: 10,              // per tick
    bulletSpeed: 0,
    bulletColor: 0x00ff66,
    hitRadius: 0.9,
  },
];

function getTurretProfile() {
  const chapterIdx = (typeof S !== 'undefined' && typeof S.chapter === 'number')
    ? S.chapter
    : 0;
  return TURRET_PROFILES[chapterIdx % TURRET_PROFILES.length];
}

// ---------------------------------------------------------------------------
// SHARED GEOMETRIES + CACHED MATERIALS
// ---------------------------------------------------------------------------

const BASE_GEO = new THREE.CylinderGeometry(0.9, 1.1, 0.5, 8);
const PEDESTAL_GEO = new THREE.CylinderGeometry(0.55, 0.7, 1.1, 8);
const SWIVEL_GEO = new THREE.BoxGeometry(0.9, 0.55, 0.9);
const BARREL_GEO = new THREE.CylinderGeometry(0.13, 0.13, 1.6, 8);
const MUZZLE_GEO = new THREE.SphereGeometry(0.18, 8, 6);

const BULLET_GEO = new THREE.BoxGeometry(0.25, 0.25, 0.65);

// Material caches keyed by chapter tint — one shader compile per chapter.
const _bodyMatCache = new Map();
const _dormantEmissiveMatCache = new Map();
const _activeEmissiveMatCache = new Map();
const _barrelMatCache = new Map();
const _bulletMatCache = new Map();

function _getBodyMat(tint) {
  let m = _bodyMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x2a2a3a,
      emissive: tint,
      emissiveIntensity: 0.15,
      roughness: 0.45,
      metalness: 0.7,
    });
    _bodyMatCache.set(tint, m);
  }
  return m;
}

function _getDormantEmissive(tint) {
  let m = _dormantEmissiveMatCache.get(tint);
  if (!m) {
    // A dim ring under the swivel; shows "we exist but we're off".
    m = new THREE.MeshStandardMaterial({
      color: 0x1a1a2a,
      emissive: tint,
      emissiveIntensity: 0.12,
      metalness: 0.3, roughness: 0.8,
    });
    _dormantEmissiveMatCache.set(tint, m);
  }
  return m;
}

function _getActiveEmissive(tint) {
  let m = _activeEmissiveMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x1a1a2a,
      emissive: tint,
      emissiveIntensity: 2.0,
      metalness: 0.3, roughness: 0.4,
    });
    _activeEmissiveMatCache.set(tint, m);
  }
  return m;
}

function _getBarrelMat(tint) {
  let m = _barrelMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x404050,
      emissive: tint,
      emissiveIntensity: 0.25,
      metalness: 0.8, roughness: 0.3,
    });
    _barrelMatCache.set(tint, m);
  }
  return m;
}

function _getBulletMat(tint) {
  let m = _bulletMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.95,
    });
    _bulletMatCache.set(tint, m);
  }
  return m;
}

/**
 * Pre-build every material a chapter will need so Wave 2's turret-online
 * beat is freeze-free. Called from prewarm.js on game start.
 */
export function prewarmTurretMats(tint) {
  _getBodyMat(tint);
  _getDormantEmissive(tint);
  _getActiveEmissive(tint);
  _getBarrelMat(tint);
  _getBulletMat(TURRET_CFG.bulletColor);
}

// ---------------------------------------------------------------------------
// TURRET LIFECYCLE
// ---------------------------------------------------------------------------

/**
 * Spawn all three turrets for the given chapter in DORMANT state. Called
 * once from prepareChapter at chapter start.
 */
export function spawnAllTurrets(chapterIdx) {
  clearAllTurrets();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  // Read LAYOUT.turrets now rather than at module load — buildCentralCompound
  // (called just before this by prepareChapter) mutates it with the current
  // chapter's triangulated positions.
  for (let i = 0; i < LAYOUT.turrets.length; i++) {
    const p = LAYOUT.turrets[i];
    turrets.push(_buildTurret(i, p.x, p.z, tint));
  }
}

export function clearAllTurrets() {
  for (const t of turrets) {
    if (t.obj && t.obj.parent) scene.remove(t.obj);
  }
  turrets.length = 0;
  clearTurretBullets();
}

export function clearTurretBullets() {
  for (const b of turretBullets) {
    if (b.parent) scene.remove(b);
  }
  turretBullets.length = 0;
}

/**
 * Flip a turret by index to "online". Idempotent. The visual accents
 * brighten, the barrel lifts from its drooped rest position to level,
 * and auto-firing begins in the next update tick.
 */
export function activateTurret(idx) {
  const t = turrets[idx];
  if (!t || t.active) return;
  t.active = true;
  t.targetBarrelPitch = 0;
  // Swap emissive materials for the visible brightening.
  t.accent.material = _getActiveEmissive(t.tint);
  // Small celebration sparkle so the player sees exactly which turret
  // just woke up.
  hitBurst(new THREE.Vector3(t.pos.x, 2.0, t.pos.z), t.tint, 18);
  hitBurst(new THREE.Vector3(t.pos.x, 2.0, t.pos.z), 0xffffff, 8);
}

/**
 * Activate turrets 1..count starting from turret 0. Called by the
 * power-up zones: TURRETS_A → activateTurretsUpTo(1); TURRETS_B →
 * activateTurretsUpTo(3).
 */
export function activateTurretsUpTo(count) {
  const n = Math.min(count, turrets.length);
  for (let i = 0; i < n; i++) activateTurret(i);
}

/**
 * Deactivate every turret with a quick fade-down — visual accent dims
 * back to dormant state, barrel droops, auto-fire stops.
 *
 * Called when the EMP fires at the end of wave 2. Turrets stay dormant
 * for the rest of the chapter (we don't clear them — they remain as
 * dormant props just like the hives).
 */
export function deactivateAllTurrets() {
  for (const t of turrets) {
    if (!t.active) continue;
    t.active = false;
    t.targetBarrelPitch = -0.35; // droop
    t.accent.material = _getDormantEmissive(t.tint);
    // EMP pulse visual at each turret.
    hitBurst(new THREE.Vector3(t.pos.x, 2.0, t.pos.z), 0x66ccff, 14);
  }
}

export function anyTurretActive() {
  for (const t of turrets) if (t.active) return true;
  return false;
}

// ---------------------------------------------------------------------------
// BUILDER
// ---------------------------------------------------------------------------

function _buildTurret(idx, x, z, tint) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Base plate (lowest, widest)
  const base = new THREE.Mesh(BASE_GEO, _getBodyMat(tint));
  base.position.y = 0.25;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // Emissive ring under the swivel — this is the visible on/off tell.
  const accent = new THREE.Mesh(
    new THREE.TorusGeometry(1.1, 0.12, 8, 16),
    _getDormantEmissive(tint),
  );
  accent.position.y = 0.55;
  accent.rotation.x = Math.PI / 2;
  group.add(accent);

  // Pedestal column
  const pedestal = new THREE.Mesh(PEDESTAL_GEO, _getBodyMat(tint));
  pedestal.position.y = 1.1;
  pedestal.castShadow = true;
  group.add(pedestal);

  // Swivel block (rotates around Y to aim)
  const swivel = new THREE.Group();
  swivel.position.y = 1.8;
  group.add(swivel);

  const swivelBox = new THREE.Mesh(SWIVEL_GEO, _getBodyMat(tint));
  swivelBox.castShadow = true;
  swivel.add(swivelBox);

  // Barrel pivot inside the swivel — rotates around X for pitch
  const barrelPivot = new THREE.Group();
  barrelPivot.position.set(0, 0.1, 0);
  barrelPivot.rotation.x = -0.35;   // drooped while dormant
  swivel.add(barrelPivot);

  const barrel = new THREE.Mesh(BARREL_GEO, _getBarrelMat(tint));
  barrel.rotation.x = Math.PI / 2;  // stand the cylinder along +Z
  barrel.position.z = 0.8;
  barrelPivot.add(barrel);

  const muzzle = new THREE.Mesh(MUZZLE_GEO, _getBarrelMat(tint));
  muzzle.position.z = 1.6;
  barrelPivot.add(muzzle);

  scene.add(group);

  return {
    idx,
    obj: group,
    pos: group.position,
    swivel,
    barrelPivot,
    muzzle,
    accent,
    tint,
    active: false,
    target: null,            // current enemy being tracked
    scanTimer: 0,            // seconds until next target scan
    fireTimer: getTurretProfile().fireInterval * (0.3 + Math.random() * 0.7),
    targetBarrelPitch: -0.35,// current pitch target (lerped toward)
    muzzleFlashTimer: 0,
    // Power-up charging spin. When the player stands on this turret's
    // zone in wave 2, setTurretCharging(idx, true) is called and the
    // swivel spins fast around Y. Once the zone completes and the turret
    // activates, the flag is cleared.
    charging: false,
  };
}

/**
 * Toggle the "being charged" visual state for a turret. While true the
 * swivel spins rapidly (3x the usual idle sweep) so the player sees the
 * turret "spooling up" as their zone progress fills.
 *
 * No-op when the turret is already active — once a turret is online, its
 * swivel is driven by target tracking, not by the charging animation.
 */
export function setTurretCharging(idx, isCharging) {
  const t = turrets[idx];
  if (!t || t.active) return;
  t.charging = !!isCharging;
}

// ---------------------------------------------------------------------------
// PER-FRAME UPDATE
// ---------------------------------------------------------------------------

/**
 * Per-frame tick for every turret and turret bullet.
 *
 * Called from main.js's render loop, unconditionally — the function
 * early-outs when there are no turrets to tick. Safe to call during any
 * wave.
 */
export function updateTurrets(dt) {
  if (turrets.length === 0 && turretBullets.length === 0) return;

  // --- Tick turrets themselves ---
  for (const t of turrets) {
    // Smooth barrel pitch lerp — even dormant turrets droop back into
    // position after the EMP, so this runs regardless of active state.
    const curPitch = t.barrelPivot.rotation.x;
    const target = t.targetBarrelPitch;
    t.barrelPivot.rotation.x = curPitch + (target - curPitch) * Math.min(1, dt * 4.5);

    if (!t.active) {
      // While the player is on this turret's power-up zone, spin the
      // swivel fast around Y so it reads as "spooling up" — visual
      // feedback that their charge is going into this specific turret.
      if (t.charging) {
        t.swivel.rotation.y += dt * 6.0;
      }
      continue;
    }

    // Muzzle-flash afterglow
    if (t.muzzleFlashTimer > 0) {
      t.muzzleFlashTimer = Math.max(0, t.muzzleFlashTimer - dt);
    }

    // Target acquisition: re-scan every scanIntervalSec seconds, or
    // immediately if the current target died / escaped range.
    t.scanTimer -= dt;
    let currentValid = false;
    if (t.target && !t.target.isBoss) {
      const dx = t.target.pos.x - t.pos.x;
      const dz = t.target.pos.z - t.pos.z;
      const d2 = dx * dx + dz * dz;
      const inList = enemies.indexOf(t.target) >= 0;
      currentValid = inList && d2 < TURRET_CFG.range * TURRET_CFG.range && t.target.hp > 0;
    }
    if (!currentValid || t.scanTimer <= 0) {
      t.target = _pickNearestEnemy(t.pos, TURRET_CFG.range);
      t.scanTimer = TURRET_CFG.scanIntervalSec;
    }

    // Rotate swivel toward target.
    if (t.target) {
      const dx = t.target.pos.x - t.pos.x;
      const dz = t.target.pos.z - t.pos.z;
      const desired = Math.atan2(dx, dz); // Y-rotation to face (dx,dz)
      const cur = t.swivel.rotation.y;
      // Shortest-arc rotation step.
      let diff = desired - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxStep = TURRET_CFG.aimTurnRate * dt;
      const step = Math.max(-maxStep, Math.min(maxStep, diff));
      t.swivel.rotation.y = cur + step;

      // Fire when aim is close enough and cooldown has elapsed.
      t.fireTimer -= dt;
      if (t.fireTimer <= 0 && Math.abs(diff) < 0.25) {
        const profile = getTurretProfile();
        _fireTurretShot(t, t.target, profile);
        // Beam profile ticks on a tight cadence; others use the normal jitter.
        if (profile.type === 'beam') {
          t.fireTimer = profile.fireInterval;
        } else {
          t.fireTimer = profile.fireInterval * (0.85 + Math.random() * 0.30);
        }
      }
    } else {
      // No target — slowly sweep the swivel idle.
      t.swivel.rotation.y += dt * 0.4;
      t.fireTimer = Math.max(getTurretProfile().fireInterval * 0.5, t.fireTimer);
    }
  }

  // --- Tick turret bullets ---
  _updateTurretBullets(dt);
}

function _pickNearestEnemy(pos, maxRange) {
  let best = null;
  let bestD2 = maxRange * maxRange;
  for (const e of enemies) {
    if (!e || e.hp <= 0) continue;
    // Turrets don't prioritize the boss — they support the player against
    // the horde. Big target, small turret. Leave the boss to the player.
    if (e.isBoss) continue;
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// PER-PROFILE FIRING
// ---------------------------------------------------------------------------

/**
 * Dispatch to the right firing routine based on the chapter's profile type.
 * Each branch creates bullet(s) in `turretBullets` (or applies damage
 * directly for the beam profile).
 */
function _fireTurretShot(turret, target, profile) {
  switch (profile.type) {
    case 'shotgun': return _fireShotgunPellets(turret, target, profile);
    case 'rocket':  return _fireRocketShot(turret, target, profile);
    case 'beam':    return _fireBeamTick(turret, target, profile);
    case 'smg':
    case 'bullet':
    default:        return _fireBulletShot(turret, target, profile);
  }
}

/** Compute muzzle origin + base aim direction for `target`. Shared by all
 *  firing routines so they agree on the same leading math. */
function _muzzleAim(turret, target) {
  const origin = new THREE.Vector3();
  turret.muzzle.getWorldPosition(origin);
  origin.y = Math.max(origin.y, 1.6);
  const vel = target.vel || null;
  const aimPoint = new THREE.Vector3(target.pos.x, 1.4, target.pos.z);
  if (vel) {
    aimPoint.x += (vel.x || 0) * 0.12;
    aimPoint.z += (vel.z || 0) * 0.12;
  }
  const dir = aimPoint.sub(origin).normalize();
  return { origin, dir };
}

/** Common bullet spawn — used by pistol and smg paths. */
function _spawnTurretBullet(turret, origin, dir, profile, extra = {}) {
  const mat = _getBulletMat(profile.bulletColor);
  const bullet = new THREE.Mesh(BULLET_GEO, mat);
  bullet.position.copy(origin);
  bullet.lookAt(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z);
  bullet.userData = {
    vel: dir.clone().multiplyScalar(profile.bulletSpeed),
    life: 1.6,
    damage: profile.damage,
    sourceTurret: turret,
    hitRadius: profile.hitRadius,
    bulletColor: profile.bulletColor,
    // Optional per-type tags
    isRocket: !!extra.isRocket,
    explosionRadius: extra.explosionRadius || 0,
    explosionDamage: extra.explosionDamage || 0,
  };
  scene.add(bullet);
  turretBullets.push(bullet);
  return bullet;
}

function _fireBulletShot(turret, target, profile) {
  const { origin, dir } = _muzzleAim(turret, target);
  _spawnTurretBullet(turret, origin, dir, profile);
  turret.muzzleFlashTimer = 0.08;
  hitBurst(origin, 0xffffff, 3);
  hitBurst(origin, profile.bulletColor, 4);
  if (Audio && Audio.shoot) { try { Audio.shoot(); } catch (e) {} }
}

function _fireShotgunPellets(turret, target, profile) {
  const { origin, dir } = _muzzleAim(turret, target);
  // Fire `pellets` rounds in a tight spread centered on `dir`.
  const pellets = profile.pellets || 5;
  const half = profile.spread || 0.22;
  // Reference frame: build a "right" vector perpendicular to the horizontal aim.
  const rightX = dir.z;
  const rightZ = -dir.x;
  for (let i = 0; i < pellets; i++) {
    const t = pellets > 1 ? ((i / (pellets - 1)) - 0.5) * 2 : 0; // -1..+1
    const angle = t * half + (Math.random() - 0.5) * (half * 0.3);
    // Rotate the base dir by `angle` in the xz plane.
    const c = Math.cos(angle), s = Math.sin(angle);
    const pd = new THREE.Vector3(
      dir.x * c + rightX * s,
      dir.y,
      dir.z * c + rightZ * s,
    ).normalize();
    _spawnTurretBullet(turret, origin, pd, profile);
  }
  turret.muzzleFlashTimer = 0.12;
  hitBurst(origin, 0xffffff, 5);
  hitBurst(origin, profile.bulletColor, 8);
  if (Audio && Audio.shoot) { try { Audio.shoot(); } catch (e) {} }
}

function _fireRocketShot(turret, target, profile) {
  const { origin, dir } = _muzzleAim(turret, target);
  _spawnTurretBullet(turret, origin, dir, profile, {
    isRocket: true,
    explosionRadius: profile.explosionRadius,
    explosionDamage: profile.explosionDamage,
  });
  turret.muzzleFlashTimer = 0.16;
  hitBurst(origin, 0xffffff, 6);
  hitBurst(origin, profile.bulletColor, 10);
  if (Audio && Audio.shoot) { try { Audio.shoot(); } catch (e) {} }
}

// Beam tick — no bullet mesh. Briefly draw a beam segment from muzzle to
// target and apply damage immediately. The beam segment is created as a
// short-lived bullet-like mesh so _updateTurretBullets cleans it up without
// needing its own list.
function _fireBeamTick(turret, target, profile) {
  const { origin } = _muzzleAim(turret, target);
  const endX = target.pos.x;
  const endY = 1.4;
  const endZ = target.pos.z;
  // Line mesh — thin emissive box stretched from origin to target.
  const dx = endX - origin.x;
  const dy = endY - origin.y;
  const dz = endZ - origin.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
  const geo = new THREE.BoxGeometry(0.18, 0.18, len);
  const mat = new THREE.MeshBasicMaterial({
    color: profile.bulletColor,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const seg = new THREE.Mesh(geo, mat);
  seg.position.set(origin.x + dx * 0.5, origin.y + dy * 0.5, origin.z + dz * 0.5);
  seg.lookAt(endX, endY, endZ);
  // Tag so updater disposes it on next tick without trying to collide.
  seg.userData = {
    vel: new THREE.Vector3(0, 0, 0),
    life: 0.06,
    damage: 0,         // damage already applied below
    sourceTurret: turret,
    isBeamSegment: true,
    ownGeo: geo,
    ownMat: mat,
  };
  scene.add(seg);
  turretBullets.push(seg);
  // Apply damage directly to the target.
  target.hp -= profile.damage;
  target.hitFlash = 0.12;
  hitBurst(new THREE.Vector3(endX, endY, endZ), profile.bulletColor, 2);
  if (target.hp <= 0 && _killHandler) {
    const idx = enemies.indexOf(target);
    if (idx >= 0) {
      try { _killHandler(idx); }
      catch (err) { console.warn('[turrets] beam kill handler threw:', err); }
    }
  }
  turret.muzzleFlashTimer = 0.06;
  // Softer audio cadence for beam ticks — don't spam the shoot SFX.
  if (Math.random() < 0.25 && Audio && Audio.shoot) { try { Audio.shoot(); } catch (e) {} }
}

// Back-compat alias — some older paths may still call _fireTurretBullet.
function _fireTurretBullet(turret, target) {
  _fireTurretShot(turret, target, getTurretProfile());
}

function _updateTurretBullets(dt) {
  for (let i = turretBullets.length - 1; i >= 0; i--) {
    const b = turretBullets[i];
    b.position.addScaledVector(b.userData.vel, dt);
    b.userData.life -= dt;

    // Beam segments are purely visual — dispose them when their short life
    // runs out, no collision processing needed.
    if (b.userData.isBeamSegment) {
      if (b.userData.life <= 0) {
        scene.remove(b);
        if (b.userData.ownGeo) b.userData.ownGeo.dispose();
        if (b.userData.ownMat) b.userData.ownMat.dispose();
        turretBullets.splice(i, 1);
      }
      continue;
    }

    // Despawn out-of-bounds / expired.
    if (
      b.userData.life <= 0 ||
      Math.abs(b.position.x) > ARENA ||
      Math.abs(b.position.z) > ARENA
    ) {
      scene.remove(b);
      turretBullets.splice(i, 1);
      continue;
    }

    // Collision vs enemies only — no blocks, no civilians, no hives, no
    // player. Keeps ally fire from ever causing a grief moment.
    let hit = false;
    const hitR = b.userData.hitRadius || 1.0;
    const hitR2 = hitR * hitR;
    const bulletCol = b.userData.bulletColor || 0xfff08a;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (!e || e.hp <= 0) continue;
      if (e.isBoss) continue;  // boss is off-limits for turret DPS
      const dx = e.pos.x - b.position.x;
      const dz = e.pos.z - b.position.z;
      if (dx * dx + dz * dz < hitR2) {
        if (b.userData.isRocket) {
          // ROCKET — apply direct-hit damage to impact target, then an AoE
          // blast to every other enemy within explosionRadius.
          e.hp -= b.userData.damage;
          e.hitFlash = 0.2;
          const expR = b.userData.explosionRadius;
          const expR2 = expR * expR;
          const expDmg = b.userData.explosionDamage;
          // Big visual pop
          hitBurst(b.position, 0xffffff, 14);
          hitBurst(b.position, 0xffaa00, 16);
          hitBurst(b.position, 0xff5522, 10);
          for (let k = enemies.length - 1; k >= 0; k--) {
            if (k === j) continue;
            const e2 = enemies[k];
            if (!e2 || e2.hp <= 0 || e2.isBoss) continue;
            const ddx = e2.pos.x - b.position.x;
            const ddz = e2.pos.z - b.position.z;
            if (ddx * ddx + ddz * ddz < expR2) {
              e2.hp -= expDmg;
              e2.hitFlash = 0.18;
              if (e2.hp <= 0 && _killHandler) {
                try { _killHandler(k); }
                catch (err) { console.warn('[turrets] rocket AoE kill handler threw:', err); }
              }
            }
          }
          scene.remove(b);
          turretBullets.splice(i, 1);
          if (e.hp <= 0 && _killHandler) {
            try { _killHandler(j); }
            catch (err) { console.warn('[turrets] rocket kill handler threw:', err); }
          }
        } else {
          // Regular bullet / shotgun pellet / smg round.
          e.hp -= b.userData.damage;
          e.hitFlash = 0.15;
          hitBurst(b.position, 0xffffff, 4);
          hitBurst(b.position, bulletCol, 3);
          scene.remove(b);
          turretBullets.splice(i, 1);
          if (e.hp <= 0 && _killHandler) {
            try { _killHandler(j); }
            catch (err) { console.warn('[turrets] kill handler threw:', err); }
          }
        }
        hit = true;
        break;
      }
    }
    if (hit) continue;
  }
}
