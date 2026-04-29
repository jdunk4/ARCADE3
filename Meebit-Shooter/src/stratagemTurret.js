// stratagemTurret.js — Player-deployable sentry turrets dropped by
// the SENTRY TURRET stratagem. Distinct from src/turrets.js which is
// the *enemy*-side compound turret tied to chapter waveProps.
//
// Four variants, picked via in-menu digit keys 1-4 before throwing
// the beacon:
//
//   'mg'        — Rapid hitscan tracers. Good crowd control, modest
//                 per-hit damage. Tint defaults to chapter color.
//   'tesla'     — Chains lightning between nearby enemies. Lower
//                 fire rate but each shot can hit several enemies.
//   'flame'     — Short-range cone DoT. Shreds packed groups but
//                 doesn't reach far.
//   'antitank'  — Slow heavy single-shot rockets with AoE. Built for
//                 elites; pokey vs swarms.
//
// Each turret:
//   • drops from height with a landing impact burst (matches mech)
//   • acquires the closest enemy within range every 0.25s
//   • aims its head smoothly toward the target
//   • fires per-variant on its own cadence
//   • has HP and is destroyed if damaged enough; explodes + leaves
//     a small impact burst. Currently turrets take damage only via
//     the optional `damageTurret(t, dmg)` API — wire to enemy melee
//     when desired. Default lifetime is finite (TURRET_LIFETIME_SEC)
//     so a turret will eventually self-decommission.
//
// Public API:
//   spawnTurret(pos, tint, variant)   — drop one turret
//   updateTurrets(dt)                 — per-frame tick (already called
//                                       by the existing turrets.js
//                                       updateTurrets path? NO — that's
//                                       a different module. main.js
//                                       wires this directly.)
//   clearStratagemTurrets()           — wipe all
//   damageTurret(t, dmg)              — apply damage (optional hook
//                                       for future enemy-attacks-turret
//                                       wiring)

import * as THREE from 'three';
import { scene } from './scene.js';
import { hitBurst } from './effects.js';
import { enemies } from './enemies.js';
import { Audio } from './audio.js';
import { S } from './state.js';
import { player } from './player.js';
import { isPiloting } from './mech.js';

// =====================================================================
// TUNING
// =====================================================================
const TURRET_HP_MAX           = 240;
const TURRET_LIFETIME_SEC     = 35.0;     // self-decommission timer
const TURRET_RISE_DEPTH       = 3.0;       // turrets start buried this deep
const TURRET_RISE_DURATION    = 0.85;
// Legacy aliases — code below references DROP_HEIGHT / DROP_DURATION.
const TURRET_DROP_HEIGHT      = TURRET_RISE_DEPTH;
const TURRET_DROP_DURATION    = TURRET_RISE_DURATION;
const TURRET_AIM_LERP         = 8.0;      // higher = snappier
const TURRET_ACQ_INTERVAL     = 0.25;     // re-acquire target this often

// Per-variant config drives geometry + fire behavior.
const _VARIANT_CONFIG = {
  mg: {
    label: 'MG',
    range: 22,
    fireInterval: 0.10,                   // rapid
    barrelGeo: new THREE.CylinderGeometry(0.10, 0.10, 1.40, 10),
    barrelOffset: 0.70,
    bodyHex: 0x4a4d54,
    headHex: 0x2a2c34,
    accentHex: null,                       // null = chapter tint
    fire: (t, target) => _fireMg(t, target),
  },
  tesla: {
    label: 'TESLA',
    range: 14,
    fireInterval: 0.55,
    barrelGeo: new THREE.CylinderGeometry(0.18, 0.30, 1.10, 10),
    barrelOffset: 0.55,
    bodyHex: 0x2c2c44,
    headHex: 0x1c1c30,
    accentHex: 0x66ccff,                  // electric blue regardless of chapter
    fire: (t, target) => _fireTesla(t, target),
  },
  flame: {
    label: 'FLAME',
    range: 8,
    fireInterval: 0.04,                   // continuous stream
    barrelGeo: new THREE.ConeGeometry(0.32, 0.55, 12),
    barrelOffset: 0.45,
    bodyHex: 0x3a1f12,
    headHex: 0x2a1a10,
    accentHex: 0xff7a30,
    fire: (t, target) => _fireFlame(t, target),
  },
  antitank: {
    label: 'AT',
    range: 28,
    fireInterval: 1.30,                   // slow heavy
    barrelGeo: new THREE.CylinderGeometry(0.18, 0.22, 1.70, 10),
    barrelOffset: 0.85,
    bodyHex: 0x4a4d54,
    headHex: 0x1a1a1a,
    accentHex: 0xff5520,
    fire: (t, target) => _fireAntitank(t, target),
  },
};

// =====================================================================
// SHARED GEOMETRY
// =====================================================================
const _BASE_GEO     = new THREE.CylinderGeometry(0.65, 0.85, 0.55, 16);
const _PILLAR_GEO   = new THREE.CylinderGeometry(0.22, 0.22, 0.45, 12);
const _HEAD_GEO     = new THREE.BoxGeometry(0.95, 0.55, 0.85);

const _activeTurrets = [];
const _activeTracers = [];                 // mg + tesla visuals
const _activeRockets = [];                 // antitank
const _activeFlames  = [];                 // flame turret particles

// =====================================================================
// SPAWN
// =====================================================================
export function spawnTurret(pos, tint, variantId) {
  const cfg = _VARIANT_CONFIG[variantId] || _VARIANT_CONFIG.mg;
  const accentHex = cfg.accentHex != null ? cfg.accentHex : tint;
  const accentColor = new THREE.Color(accentHex);
  const tintColor = new THREE.Color(tint);

  const root = new THREE.Group();
  // Drop animation — start above target.
  // Spawn buried; ticked up to ground level over TURRET_RISE_DURATION.
  // Reads as the turret deploying out of the floor.
  root.position.set(pos.x, -TURRET_RISE_DEPTH, pos.z);

  // ---- BASE ----
  const baseMat = new THREE.MeshStandardMaterial({
    color: cfg.bodyHex,
    emissive: accentColor,
    emissiveIntensity: 0.20,
    roughness: 0.55,
    metalness: 0.75,
  });
  const base = new THREE.Mesh(_BASE_GEO, baseMat);
  base.position.y = 0.27;
  root.add(base);

  // Pillar (short pole that the swiveling head sits on).
  const pillar = new THREE.Mesh(_PILLAR_GEO, baseMat);
  pillar.position.y = 0.78;
  root.add(pillar);

  // ---- HEAD (swivel group) ----
  const head = new THREE.Group();
  head.position.y = 1.10;
  root.add(head);

  const headMat = new THREE.MeshStandardMaterial({
    color: cfg.headHex,
    emissive: accentColor,
    emissiveIntensity: 0.30,
    roughness: 0.45,
    metalness: 0.80,
  });
  const headMesh = new THREE.Mesh(_HEAD_GEO, headMat);
  head.add(headMesh);

  // Eye / sensor — additive sphere on the head front.
  const eyeMat = new THREE.MeshBasicMaterial({
    color: accentColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.10, 10, 8), eyeMat);
  eye.position.set(0, 0.12, 0.42);
  head.add(eye);

  // Barrel — variant-specific geometry. Always points along +Z in
  // local space; head rotation aims the whole assembly.
  const barrelMat = new THREE.MeshStandardMaterial({
    color: cfg.headHex,
    emissive: accentColor,
    emissiveIntensity: 0.30,
    roughness: 0.50,
    metalness: 0.85,
  });
  const barrel = new THREE.Mesh(cfg.barrelGeo, barrelMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, -0.05, cfg.barrelOffset);
  head.add(barrel);

  // Muzzle marker — Group at barrel tip used as fire origin.
  const muzzle = new THREE.Group();
  muzzle.position.set(0, -0.05, cfg.barrelOffset + 0.85);
  head.add(muzzle);

  // Tesla coil ornament — extra geometry on the tesla variant for
  // visual identity (a small additive sphere on top of the head).
  if (variantId === 'tesla') {
    const coilMat = new THREE.MeshBasicMaterial({
      color: accentColor,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const coil = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), coilMat);
    coil.position.set(0, 0.40, 0);
    head.add(coil);
  }

  scene.add(root);

  const t = {
    root, base, baseMat, pillar,
    head, headMat, eye, eyeMat,
    barrel, barrelMat,
    muzzle,
    variant: variantId,
    cfg,
    tint,
    accentHex,
    accentColor,
    tintColor,
    pos: new THREE.Vector3(pos.x, 0, pos.z),
    aimYaw: 0,
    target: null,
    targetT: 0,
    fireT: 0,
    hp: TURRET_HP_MAX,
    hpMax: TURRET_HP_MAX,
    life: 0,
    lifetime: TURRET_LIFETIME_SEC,
    dropping: true,
    dropT: 0,
    destroyed: false,
    deathT: 0,
    flameLastFireT: 0,
  };
  _activeTurrets.push(t);
  return t;
}

// =====================================================================
// PER-FRAME TICK
// =====================================================================
export function updateTurrets(dt) {
  // --- TURRETS ---
  for (let i = _activeTurrets.length - 1; i >= 0; i--) {
    const t = _activeTurrets[i];

    // Rise animation — emerges from the floor, with deploy click +
    // dirt burst on landing.
    if (t.dropping) {
      if (!t._riseAudioFired) {
        t._riseAudioFired = true;
        try { Audio.turretDeploy(); } catch (_) {}
        // Initial dirt burst at ground level.
        const gp = new THREE.Vector3(t.pos.x, 0, t.pos.z);
        hitBurst(gp, 0x8a6a44, 16);
      }
      t.dropT += dt;
      const f = Math.min(1, t.dropT / TURRET_RISE_DURATION);
      const eased = 1 - Math.pow(1 - f, 2.4);
      t.root.position.y = -TURRET_RISE_DEPTH * (1 - eased);
      if (f >= 1) {
        t.dropping = false;
        t.root.position.y = 0;
        hitBurst(t.pos.clone(), t.accentHex, 22);
        hitBurst(t.pos.clone(), 0xffffff, 14);
      }
      continue;
    }

    // Death sequence.
    if (t.destroyed) {
      t.deathT += dt;
      t.root.rotation.y += dt * 4;
      t.root.position.y -= dt * 1.5;
      if (t.deathT > 0.9) {
        _disposeTurret(t);
        _activeTurrets.splice(i, 1);
      }
      continue;
    }

    // Self-decommission.
    t.life += dt;
    if (t.life >= t.lifetime) {
      _destroyTurret(t);
      continue;
    }

    // Re-acquire target periodically.
    t.targetT -= dt;
    if (t.targetT <= 0) {
      t.targetT = TURRET_ACQ_INTERVAL;
      t.target = _findClosestEnemy(t.pos, t.cfg.range);
    }
    // Stale target check — clear if target died, despawned, or
    // wandered past range. The fire path also bails on dead targets.
    if (t.target) {
      if (!t.target.pos || t.target.dying) {
        t.target = null;
      } else {
        const dx = t.target.pos.x - t.pos.x;
        const dz = t.target.pos.z - t.pos.z;
        if (dx * dx + dz * dz > t.cfg.range * t.cfg.range) {
          t.target = null;
        }
      }
    }

    // Aim head toward target (smooth lerp).
    if (t.target && t.target.pos) {
      const dx = t.target.pos.x - t.pos.x;
      const dz = t.target.pos.z - t.pos.z;
      const desired = Math.atan2(dx, dz);
      let dy = desired - t.aimYaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      t.aimYaw += dy * Math.min(1, dt * TURRET_AIM_LERP);
      t.head.rotation.y = t.aimYaw;
    }

    // Fire.
    t.fireT -= dt;
    if (t.target && t.fireT <= 0) {
      t.fireT = t.cfg.fireInterval;
      try { t.cfg.fire(t, t.target); }
      catch (e) { console.warn('[turret fire]', e); }
    }

    // Tesla coil flicker — keep the eye pulsing even when not firing.
    if (t.variant === 'tesla') {
      t.eyeMat.opacity = 0.6 + 0.35 * Math.sin(t.life * 8);
    }
  }

  // --- TRACERS (mg + tesla visuals) ---
  _tickTracers(dt);
  // --- ROCKETS (antitank) ---
  _tickRockets(dt);
  // --- FLAME PARTICLES (flame turret) ---
  _tickFlames(dt);
}

// =====================================================================
// TARGETING
// =====================================================================
function _findClosestEnemy(pos, range) {
  let best = null;
  let bestD2 = range * range;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const dx = e.pos.x - pos.x;
    const dz = e.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// =====================================================================
// VARIANT FIRE FUNCTIONS
// =====================================================================
const _MG_TRACER_GEO = new THREE.CylinderGeometry(0.04, 0.04, 1.0, 6);
function _fireMg(t, target) {
  // Hitscan: damage target instantly + spawn a tracer for visual.
  const dmg = 16;
  target.hp -= dmg;
  target.hitFlash = 0.10;
  const muzzleWorld = new THREE.Vector3();
  t.muzzle.getWorldPosition(muzzleWorld);
  _spawnTracer(muzzleWorld, target.pos.clone(), t.accentColor, 0.06);
  // Small muzzle puff.
  hitBurst(muzzleWorld, t.accentHex, 2);
  try { Audio.turretMg(); } catch (_) {}
}

function _fireTesla(t, target) {
  // Chain lightning — hits the primary target, then jumps to the
  // closest enemy within JUMP_RADIUS, up to MAX_CHAIN times.
  const PRIMARY_DAMAGE = 60;
  const FALLOFF = 0.65;            // each successive jump deals this fraction
  const JUMP_RADIUS = 5.0;
  const MAX_CHAIN = 4;
  const visited = new Set();
  visited.add(target);
  // Start point is the muzzle.
  const muzzleWorld = new THREE.Vector3();
  t.muzzle.getWorldPosition(muzzleWorld);
  let from = muzzleWorld;
  let cur = target;
  let dmg = PRIMARY_DAMAGE;
  for (let i = 0; i < MAX_CHAIN; i++) {
    if (!cur || !cur.pos) break;
    cur.hp -= dmg;
    cur.hitFlash = 0.16;
    const to = cur.pos.clone();
    to.y = 1.0;
    _spawnTracer(from, to, t.accentColor, 0.18);
    hitBurst(to, t.accentHex, 4);
    // Find next chain target.
    let next = null;
    let bestD2 = JUMP_RADIUS * JUMP_RADIUS;
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying || visited.has(e)) continue;
      const dx = e.pos.x - cur.pos.x;
      const dz = e.pos.z - cur.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; next = e; }
    }
    if (!next) break;
    visited.add(next);
    from = cur.pos.clone(); from.y = 1.0;
    cur = next;
    dmg *= FALLOFF;
  }
  try { Audio.turretTesla(); } catch (_) {}
}

function _fireFlame(t, target) {
  // Small forward cone — apply DPS and spawn a particle each call.
  const RANGE = t.cfg.range;
  const CONE_HALF = 0.40;
  const DPS_BURST = 40;            // damage per call (called every cfg.fireInterval)
  const ang = t.aimYaw;
  const dirX = Math.sin(ang), dirZ = Math.cos(ang);
  // Apply damage once per call to anything in cone.
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const ex = e.pos.x - t.pos.x;
    const ez = e.pos.z - t.pos.z;
    const along = ex * dirX + ez * dirZ;
    if (along < 0 || along > RANGE) continue;
    const perp = Math.sqrt(Math.max(0, (ex * ex + ez * ez) - along * along));
    if (perp / Math.max(0.5, along) > CONE_HALF) continue;
    e.hp -= DPS_BURST;
    e.hitFlash = 0.06;
  }
  // Particle.
  const muzzleWorld = new THREE.Vector3();
  t.muzzle.getWorldPosition(muzzleWorld);
  _spawnFlameParticle(muzzleWorld, ang, t.accentColor);
  // Throttle audio — flame fires every 0.04s, but we only want a
  // hiss every ~6 calls so the whoosh layers softly.
  t._flameAudioCount = (t._flameAudioCount || 0) + 1;
  if (t._flameAudioCount >= 6) {
    t._flameAudioCount = 0;
    try { Audio.turretFlame(); } catch (_) {}
  }
}

const _AT_ROCKET_GEO = new THREE.CylinderGeometry(0.10, 0.14, 0.85, 8);
function _fireAntitank(t, target) {
  const muzzleWorld = new THREE.Vector3();
  t.muzzle.getWorldPosition(muzzleWorld);
  // Aim a leading shot at the target's current position. Simple: no
  // velocity prediction; antitank turret is meant for slow elites
  // anyway.
  const tx = target.pos.x;
  const tz = target.pos.z;
  const dx = tx - muzzleWorld.x;
  const dz = tz - muzzleWorld.z;
  const dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
  const SPEED = 32;
  const vx = (dx / dist) * SPEED;
  const vz = (dz / dist) * SPEED;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: t.accentColor,
    emissiveIntensity: 2.5,
    roughness: 0.30,
  });
  const mesh = new THREE.Mesh(_AT_ROCKET_GEO, mat);
  mesh.position.copy(muzzleWorld);
  // Orient along velocity.
  const ang = Math.atan2(vx, vz);
  mesh.rotation.y = ang;
  mesh.rotation.x = Math.PI / 2;
  scene.add(mesh);

  _activeRockets.push({
    mesh, mat,
    pos: muzzleWorld.clone(),
    vel: new THREE.Vector3(vx, 0, vz),
    life: 0,
    maxLife: 2.0,
    accentHex: t.accentHex,
  });

  // Backblast.
  hitBurst(muzzleWorld, t.accentHex, 8);
  hitBurst(muzzleWorld, 0xffffff, 4);
  try { Audio.turretAntitank(); } catch (_) {}
}

// =====================================================================
// TRACER FX (mg + tesla)
// =====================================================================
function _spawnTracer(from, to, color, ttl) {
  const len = from.distanceTo(to);
  if (len < 0.1) return;
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const tracer = new THREE.Mesh(_MG_TRACER_GEO, mat);
  tracer.scale.set(1, len, 1);
  const mid = from.clone().lerp(to, 0.5);
  tracer.position.copy(mid);
  const dir = to.clone().sub(from).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
  tracer.quaternion.copy(quat);
  scene.add(tracer);
  _activeTracers.push({ mesh: tracer, mat, life: 0, ttl });
}

function _tickTracers(dt) {
  for (let i = _activeTracers.length - 1; i >= 0; i--) {
    const t = _activeTracers[i];
    t.life += dt;
    const f = t.life / t.ttl;
    if (f >= 1) {
      if (t.mesh.parent) t.mesh.parent.remove(t.mesh);
      if (t.mat) t.mat.dispose();
      _activeTracers.splice(i, 1);
      continue;
    }
    t.mat.opacity = 0.85 * (1 - f);
  }
}

// =====================================================================
// ROCKETS (antitank)
// =====================================================================
const _AT_BLAST_RADIUS = 4.0;
const _AT_BLAST_DAMAGE = 320;
const _AT_PLAYER_DAMAGE = 45;     // max player splash; falloff w/ distance

// Local player-splash helper. Mirrors mech's _splashDamagePlayer:
// gated on isPiloting + invuln, falloff with distance from epicenter.
function _splashDamagePlayerAT(epicenter, radius, maxDmg) {
  if (!player || !player.pos) return;
  if (isPiloting()) return;
  if (S.invulnTimer && S.invulnTimer > 0) return;
  const dx = player.pos.x - epicenter.x;
  const dz = player.pos.z - epicenter.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= radius) return;
  const falloff = 1 - d / radius;
  S.hp = Math.max(0, (S.hp || 0) - maxDmg * falloff);
  S.invulnTimer = Math.max(S.invulnTimer || 0, 0.20);
  if (typeof window !== 'undefined' && window.__takePlayerDamageVfx) {
    try { window.__takePlayerDamageVfx(0.30, 0.20); } catch (_) {}
  }
}

function _tickRockets(dt) {
  for (let i = _activeRockets.length - 1; i >= 0; i--) {
    const r = _activeRockets[i];
    r.pos.x += r.vel.x * dt;
    r.pos.z += r.vel.z * dt;
    r.mesh.position.copy(r.pos);
    r.life += dt;

    // Hit-test.
    let hit = null;
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying) continue;
      const dx = e.pos.x - r.pos.x;
      const dz = e.pos.z - r.pos.z;
      if (dx * dx + dz * dz < 1.4 * 1.4) {
        hit = e;
        break;
      }
    }
    if (hit || r.life >= r.maxLife) {
      // AoE detonation.
      const r2 = _AT_BLAST_RADIUS * _AT_BLAST_RADIUS;
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (!e || !e.pos || e.dying) continue;
        const dx = e.pos.x - r.pos.x;
        const dz = e.pos.z - r.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < r2) {
          const falloff = 1 - Math.sqrt(d2) / _AT_BLAST_RADIUS;
          e.hp -= _AT_BLAST_DAMAGE * falloff;
          e.hitFlash = 0.20;
        }
      }
      // Friendly fire — player too if standing in the blast.
      _splashDamagePlayerAT(r.pos.clone(), _AT_BLAST_RADIUS, _AT_PLAYER_DAMAGE);
      hitBurst(r.pos.clone(), 0xffffff, 24);
      hitBurst(r.pos.clone(), r.accentHex, 18);
      setTimeout(() => hitBurst(r.pos.clone(), 0xffaa00, 14), 60);
      // Audio — reuse the mech rocket impact (same heavy thump
      // profile fits the AT shell).
      try { Audio.mechRocketImpact(); } catch (_) {}
      if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
      if (r.mat) r.mat.dispose();
      _activeRockets.splice(i, 1);
    }
  }
}

// =====================================================================
// FLAME PARTICLES (flame turret)
// =====================================================================
const _FLAME_PUFF_GEO = new THREE.SphereGeometry(0.18, 8, 6);
const _FLAME_TTL = 0.30;
function _spawnFlameParticle(muzzleWorld, aimYaw, accentColor) {
  const dirX = Math.sin(aimYaw), dirZ = Math.cos(aimYaw);
  const speed = 14 + Math.random() * 5;
  const spread = (Math.random() - 0.5) * 0.55;
  const sx = dirX * Math.cos(spread) - dirZ * Math.sin(spread);
  const sz = dirX * Math.sin(spread) + dirZ * Math.cos(spread);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff3a0,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(_FLAME_PUFF_GEO, mat);
  mesh.position.copy(muzzleWorld);
  scene.add(mesh);
  _activeFlames.push({
    mesh, mat,
    pos: muzzleWorld.clone(),
    vel: new THREE.Vector3(sx * speed, (Math.random() - 0.5) * 1.2, sz * speed),
    life: 0,
    accent: accentColor,
  });
}

function _tickFlames(dt) {
  for (let i = _activeFlames.length - 1; i >= 0; i--) {
    const p = _activeFlames[i];
    p.life += dt;
    const f = p.life / _FLAME_TTL;
    if (f >= 1) {
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
      if (p.mat) p.mat.dispose();
      _activeFlames.splice(i, 1);
      continue;
    }
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.pos.z += p.vel.z * dt;
    p.mesh.position.copy(p.pos);
    p.mesh.scale.setScalar(0.5 + f * 1.4);
    if (f < 0.3) p.mat.color.setHex(0xfff3a0);
    else if (f < 0.6) p.mat.color.setHex(0xffaa30);
    else p.mat.color.setHex(0xff5520);
    p.mat.opacity = 0.95 * (1 - f);
  }
}

// =====================================================================
// DAMAGE / DESTRUCTION
// =====================================================================
export function damageTurret(t, dmg) {
  if (!t || t.destroyed) return;
  t.hp -= dmg;
  if (t.hp <= 0) _destroyTurret(t);
}

function _destroyTurret(t) {
  t.destroyed = true;
  t.deathT = 0;
  // Big burst.
  const pos = t.pos.clone();
  pos.y = 0.8;
  hitBurst(pos, 0xffffff, 28);
  hitBurst(pos, t.accentHex, 22);
  setTimeout(() => hitBurst(pos, 0xffaa00, 18), 60);
  try { Audio.turretDestroyed(); } catch (_) {}
}

function _disposeTurret(t) {
  if (t.root.parent) scene.remove(t.root);
  if (t.baseMat) t.baseMat.dispose();
  if (t.headMat) t.headMat.dispose();
  if (t.eyeMat) t.eyeMat.dispose();
  if (t.barrelMat) t.barrelMat.dispose();
}

// =====================================================================
// TEARDOWN
// =====================================================================
export function clearStratagemTurrets() {
  for (const t of _activeTurrets) _disposeTurret(t);
  _activeTurrets.length = 0;
  for (const tr of _activeTracers) {
    if (tr.mesh.parent) tr.mesh.parent.remove(tr.mesh);
    if (tr.mat) tr.mat.dispose();
  }
  _activeTracers.length = 0;
  for (const r of _activeRockets) {
    if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
    if (r.mat) r.mat.dispose();
  }
  _activeRockets.length = 0;
  for (const p of _activeFlames) {
    if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    if (p.mat) p.mat.dispose();
  }
  _activeFlames.length = 0;
}
