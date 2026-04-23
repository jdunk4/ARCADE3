// ============================================================================
// src/infector.js — Flood-style parasite enemies.
//
// DESIGN
//  Infectors behave like the Flood from Halo: they prioritize attacking OTHER
//  enemies over the player. On contact with an enemy they "possess" it (take
//  over the body) — merging their speed and lethality with the host's HP.
//  The possessed host then sprints at the player and EXPLODES on contact,
//  spawning 3-4 Roaches. Roaches are small, fast, and chase the player
//  (or any enemy in range) and deal contact damage.
//
//  In chapter 7 (PARADISE FALLEN) infectors are dominant — hives emit them
//  constantly, they eat the other enemies, and the only way to cleanse is a
//  Super Nuke. Visual palette shifts to black/white for the finale.
//
// PUBLIC API
//   updateInfectors(dt, player)      — per-frame AI tick; called from main.js
//   clearInfectors()                 — call on game-reset
//   spawnInfector(x, z, tintHex)     — spawn a new infector at ground pos
//   spawnRoach(x, z, tintHex)        — spawn a roach (used after explosions)
//   isInfector(enemy)                — check if an enemy is an infector
//   possessEnemy(infector, host)     — convert a normal enemy into a possessed one
//   triggerSuperNuke(centerPos)      — cleanse all infectors + roaches in-arena
//
// INTEGRATION
//   - makeEnemy('infector' | 'roach' | 'possessed') is wired in enemies.js.
//   - Chapter 7 waves in config.js set the dominant enemy mix.
//   - main.js calls updateInfectors each frame.
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { enemies } from './enemies.js';
import { hitBurst } from './effects.js';
import { Audio } from './audio.js';
import { S, shake } from './state.js';
import { UI } from './ui.js';

// -----------------------------------------------------------------------------
// TUNING
// -----------------------------------------------------------------------------

// Range within which an infector will target another enemy instead of player.
const INFECTOR_ENEMY_SEEK_RANGE = 28;

// Range within which the infector prefers an enemy over the player.
// Past this it just goes for the player.
const INFECTOR_ENEMY_PREFER_RANGE = 12;

// Contact radius for "latches onto an enemy" possession.
const POSSESSION_RADIUS = 1.2;

// When a possessed host reaches the player, it explodes at this distance.
const POSSESSED_EXPLODE_RADIUS = 1.6;

// How many roaches a possessed host drops when it explodes.
const ROACHES_PER_EXPLOSION_MIN = 3;
const ROACHES_PER_EXPLOSION_MAX = 4;

// Possessed host — raw stats overrides (merge over whatever enemy type it was).
const POSSESSED_STATS = {
  speed: 4.2,
  damage: 22,   // explosion contact damage
  // hp is inherited from the host — this is what makes possessions strong.
};

// Explosion radius for a possessed host when it blows up.
const POSSESSED_EXPLODE_AOE = 3.2;
const POSSESSED_EXPLODE_DMG = 40;

// Roach stats
const ROACH_SPEED = 5.5;
const ROACH_CONTACT_DMG = 6;

// Super Nuke area — cleanses everything in this radius around the detonation
// point. If detonated from the player/center, this is effectively arena-wide.
const SUPER_NUKE_RADIUS = 120;

// Aesthetic: in chapter 7 (PARADISE FALLEN) infectors go monochrome.
const CH7_MONO_TINT = 0xeeeeee;
const CH7_DARK_TINT = 0x222222;

// -----------------------------------------------------------------------------
// INFECTOR BUILDERS
// -----------------------------------------------------------------------------

/**
 * Build an infector mesh. It's a spindly, multi-tentacled parasite —
 * squat body + several wavy tendrils. On possession we ATTACH the infector
 * to the host instead of destroying it, so the host gets a visible rider.
 */
export function buildInfectorMesh(tintHex, scale = 0.55) {
  const group = new THREE.Group();

  const tint = new THREE.Color(tintHex);
  const dark = tint.clone().multiplyScalar(0.45);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: dark.getHex(),
    emissive: tint.getHex(),
    emissiveIntensity: 0.85,
    roughness: 0.75,
  });

  // Bulbous body — stretched ellipsoid approximation with boxes
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.7, 1.05), bodyMat);
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);

  // Glowing cluster on top
  const cluster = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.55),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: tint.getHex(),
      emissiveIntensity: 3.0,
      roughness: 0.3,
    })
  );
  cluster.position.y = 1.4;
  group.add(cluster);

  // Tendrils — 5 of them sprouting around the base. Stored so AI can
  // animate wobble each frame.
  const tendrils = [];
  const tendrilMat = new THREE.MeshStandardMaterial({
    color: dark.getHex(),
    emissive: tint.getHex(),
    emissiveIntensity: 1.4,
    roughness: 0.6,
  });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.9, 0.14), tendrilMat);
    t.position.set(Math.cos(a) * 0.45, 0.5, Math.sin(a) * 0.45);
    t.rotation.x = (Math.random() - 0.5) * 0.4;
    t.rotation.z = (Math.random() - 0.5) * 0.4;
    group.add(t);
    tendrils.push({ mesh: t, phase: Math.random() * Math.PI * 2 });
  }

  group.scale.setScalar(scale * 1.6);
  return { group, body, bodyMat, tendrils };
}

/**
 * Build a roach mesh — tiny, fast, many legs. Just a small lozenge with
 * stubby leg segments. Very different silhouette from every other enemy.
 */
export function buildRoachMesh(tintHex, scale = 0.35) {
  const group = new THREE.Group();

  const tint = new THREE.Color(tintHex);
  const dark = tint.clone().multiplyScalar(0.35);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: dark.getHex(),
    emissive: tint.getHex(),
    emissiveIntensity: 0.9,
    roughness: 0.7,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.95), bodyMat);
  body.position.y = 0.3;
  body.castShadow = true;
  group.add(body);

  // Glowing pip on back
  const pip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.2),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: tint.getHex(),
      emissiveIntensity: 2.5,
      roughness: 0.3,
    })
  );
  pip.position.set(0, 0.45, -0.1);
  group.add(pip);

  // Legs — 6 stubby boxes, 3 per side.
  const legMat = new THREE.MeshStandardMaterial({
    color: dark.getHex(),
    roughness: 0.8,
  });
  const legs = [];
  for (let side = -1; side <= 1; side += 2) {
    for (let k = 0; k < 3; k++) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), legMat);
      leg.position.set(side * 0.32, 0.15, -0.3 + k * 0.3);
      group.add(leg);
      legs.push({ mesh: leg, side, index: k });
    }
  }

  group.scale.setScalar(scale * 1.5);
  return { group, body, bodyMat, legs };
}

// -----------------------------------------------------------------------------
// TYPE GUARDS / HELPERS
// -----------------------------------------------------------------------------

export function isInfector(e) {
  return !!e && (e.type === 'infector' || e.type === 'roach' || e.isPossessed);
}

function _findNearestNonInfectorEnemy(fromPos, maxRange) {
  let best = null;
  let bestD = maxRange * maxRange;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (isInfector(e)) continue;
    if (e.isBoss) continue;
    const dx = e.pos.x - fromPos.x;
    const dz = e.pos.z - fromPos.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function _findAnyNearestEnemy(fromPos, maxRange, exclude) {
  let best = null;
  let bestD = maxRange * maxRange;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e === exclude) continue;
    if (e.isBoss) continue;
    const dx = e.pos.x - fromPos.x;
    const dz = e.pos.z - fromPos.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// -----------------------------------------------------------------------------
// POSSESSION
// -----------------------------------------------------------------------------

/**
 * Convert a normal enemy `host` into a possessed variant.
 * The infector itself is consumed (removed from enemies[]).
 * The host gets recolored, sped up, and flagged to explode on contact.
 */
export function possessEnemy(infector, host) {
  if (!host || host.isBoss || host.isPossessed) return;

  // Kill the infector (remove from scene + enemies[]).
  const iIdx = enemies.indexOf(infector);
  if (iIdx >= 0) {
    if (infector.obj && infector.obj.parent) scene.remove(infector.obj);
    enemies.splice(iIdx, 1);
  }

  // Flag host as possessed. Merge stats.
  host.isPossessed = true;
  host.speed = POSSESSED_STATS.speed;
  host.damage = POSSESSED_STATS.damage;
  // HP stays — that's the point. A possessed brute is a tank.

  // Visual overlay — dark emissive layer + a parasite-rider growth on top
  // of the existing body. Re-tint the bodyMat and drop a "rider" box on the
  // host's head height.
  try {
    if (host.bodyMat) {
      host.bodyMat.emissive = new THREE.Color(0xeeeeee);
      host.bodyMat.emissiveIntensity = 1.6;
      host.bodyMat.needsUpdate = true;
    }
    const riderGeo = new THREE.BoxGeometry(0.9, 0.6, 0.9);
    const riderMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      emissive: 0xffffff,
      emissiveIntensity: 1.8,
      roughness: 0.4,
    });
    const rider = new THREE.Mesh(riderGeo, riderMat);
    rider.position.y = 3.4; // perched on the head
    host.obj.add(rider);
    host._possRider = rider;
  } catch (e) {
    // non-fatal
  }

  // Effect + audio
  hitBurst(new THREE.Vector3(host.pos.x, 1.4, host.pos.z), 0xffffff, 20);
  hitBurst(new THREE.Vector3(host.pos.x, 1.4, host.pos.z), 0x111111, 14);
  Audio.damage && Audio.damage();
  shake(0.18, 0.15);
}

/**
 * Possessed host reached player (or its HP hit zero). Blow up.
 * Spawn 3-4 roaches, splash damage nearby.
 */
export function detonatePossessed(host, player) {
  const pos = host.pos.clone();
  hitBurst(new THREE.Vector3(pos.x, 1.3, pos.z), 0xffffff, 28);
  hitBurst(new THREE.Vector3(pos.x, 1.3, pos.z), 0x222222, 22);
  shake(0.3, 0.25);
  Audio.bigBoom && Audio.bigBoom();

  // AoE damage to the player + other enemies (not just visual)
  if (player && S.invulnTimer <= 0) {
    const dx = player.pos.x - pos.x;
    const dz = player.pos.z - pos.z;
    if (dx * dx + dz * dz < POSSESSED_EXPLODE_AOE * POSSESSED_EXPLODE_AOE) {
      if (S.shields > 0) { S.shields -= 1; UI.toast && UI.toast('SHIELD ABSORBED', '#e63aff'); }
      else { S.hp -= host.damage; UI.damageFlash && UI.damageFlash(); Audio.damage && Audio.damage(); }
      S.invulnTimer = 0.5;
    }
  }

  for (let j = enemies.length - 1; j >= 0; j--) {
    const o = enemies[j];
    if (o === host) continue;
    const dx = o.pos.x - pos.x;
    const dz = o.pos.z - pos.z;
    if (dx * dx + dz * dz < POSSESSED_EXPLODE_AOE * POSSESSED_EXPLODE_AOE) {
      o.hp -= POSSESSED_EXPLODE_DMG;
      o.hitFlash = 0.2;
    }
  }

  // Host dies
  if (host.obj && host.obj.parent) scene.remove(host.obj);
  const hIdx = enemies.indexOf(host);
  if (hIdx >= 0) enemies.splice(hIdx, 1);

  // Spawn roaches
  const n = ROACHES_PER_EXPLOSION_MIN +
            Math.floor(Math.random() * (ROACHES_PER_EXPLOSION_MAX - ROACHES_PER_EXPLOSION_MIN + 1));
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
    const rx = pos.x + Math.cos(a) * 0.8;
    const rz = pos.z + Math.sin(a) * 0.8;
    spawnRoach(rx, rz, CH7_MONO_TINT);
  }
}

// -----------------------------------------------------------------------------
// SPAWN HELPERS
// -----------------------------------------------------------------------------

/**
 * Spawn an infector at (x, z). Uses the makeEnemy pipeline from enemies.js
 * via the 'infector' type key (registered in config.js ENEMY_TYPES).
 */
export function spawnInfector(x, z, tintHex) {
  // Defer to makeEnemy — the 'infector' type is registered and will route
  // through buildInfectorMesh above when constructed.
  import('./enemies.js').then(m => {
    const enemy = m.makeEnemy('infector', tintHex || CH7_MONO_TINT, new THREE.Vector3(x, 0, z));
    if (enemy) {
      hitBurst(new THREE.Vector3(x, 0.8, z), 0xffffff, 10);
    }
  });
}

export function spawnRoach(x, z, tintHex) {
  import('./enemies.js').then(m => {
    const enemy = m.makeEnemy('roach', tintHex || CH7_MONO_TINT, new THREE.Vector3(x, 0, z));
    if (enemy) {
      hitBurst(new THREE.Vector3(x, 0.5, z), 0xffffff, 4);
    }
  });
}

// -----------------------------------------------------------------------------
// PER-FRAME UPDATE
// -----------------------------------------------------------------------------

/**
 * Called from main.js animate(). Walks through enemies[] and runs the
 * infector/possessed/roach-specific AI on anything that matches.
 * Normal enemy AI still runs in main.js; this just adds the extra behaviors.
 */
export function updateInfectors(dt, player) {
  if (!player) return;

  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e) continue;

    // --- INFECTOR: prefer nearby enemy, possess on contact ---
    if (e.type === 'infector' && !e.isPossessed) {
      // Animate tendrils
      if (e._tendrils) {
        for (const t of e._tendrils) {
          t.phase += dt * 4;
          t.mesh.rotation.x = Math.sin(t.phase) * 0.35;
          t.mesh.rotation.z = Math.cos(t.phase * 1.3) * 0.35;
        }
      }

      // Target decision
      const preferred = _findNearestNonInfectorEnemy(e.pos, INFECTOR_ENEMY_SEEK_RANGE);
      let target;
      if (preferred) {
        const dx = preferred.pos.x - e.pos.x;
        const dz = preferred.pos.z - e.pos.z;
        const dsq = dx * dx + dz * dz;
        // Only prefer an enemy over the player if it's genuinely closer
        // than INFECTOR_ENEMY_PREFER_RANGE, OR if the player is farther away.
        const px = player.pos.x - e.pos.x;
        const pz = player.pos.z - e.pos.z;
        const pdsq = px * px + pz * pz;
        if (dsq < INFECTOR_ENEMY_PREFER_RANGE * INFECTOR_ENEMY_PREFER_RANGE || dsq < pdsq) {
          target = preferred;
          e._isHuntingEnemy = true;
        } else {
          target = player;
          e._isHuntingEnemy = false;
        }
      } else {
        target = player;
        e._isHuntingEnemy = false;
      }

      // Move toward target — override the humanoid walker in main.js by
      // snapping position directly each frame. We don't disable main.js's
      // movement; we add to it. For infectors (which use the infector
      // mesh, not a humanoid), main.js's default move logic already
      // handles it via spec.speed. But we want to retarget, so we nudge.
      if (target && target !== player) {
        // When chasing a specific enemy: steer toward it instead of player.
        const dx = target.pos.x - e.pos.x;
        const dz = target.pos.z - e.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        const sp = e.speed * dt;
        e.pos.x += (dx / d) * sp;
        e.pos.z += (dz / d) * sp;
        if (e.obj) e.obj.position.copy(e.pos);

        // Possession check
        if (dx * dx + dz * dz < POSSESSION_RADIUS * POSSESSION_RADIUS) {
          possessEnemy(e, target);
          continue; // e was removed from enemies[] inside possessEnemy
        }
      }
      // If target === player, main.js's default chase-player loop already
      // handles movement. We don't duplicate it here.
    }

    // --- POSSESSED HOST: sprint at player, explode on contact ---
    if (e.isPossessed) {
      const dx = player.pos.x - e.pos.x;
      const dz = player.pos.z - e.pos.z;
      const dsq = dx * dx + dz * dz;
      if (dsq < POSSESSED_EXPLODE_RADIUS * POSSESSED_EXPLODE_RADIUS) {
        detonatePossessed(e, player);
        continue;
      }
      // Also: if the host's HP hits zero from damage, detonate.
      if (e.hp <= 0 && !e._detonated) {
        e._detonated = true;
        detonatePossessed(e, player);
        continue;
      }
      // Wobble the rider — visual life
      if (e._possRider) {
        e._possRider.rotation.y += dt * 3;
      }
    }

    // --- ROACH: chase player OR any non-roach enemy in short range ---
    if (e.type === 'roach') {
      // Legs scurry
      if (e._legs) {
        e._legPhase = (e._legPhase || 0) + dt * 22;
        const k = Math.sin(e._legPhase) * 0.25;
        for (const l of e._legs) {
          l.mesh.rotation.x = (l.index % 2 === 0 ? 1 : -1) * k * (l.side > 0 ? 1 : -1);
        }
      }

      // Roaches briefly chase nearest non-roach enemy if one is closer than player
      const other = _findAnyNearestEnemy(e.pos, 8, e);
      let target = player;
      if (other) {
        const dx = other.pos.x - e.pos.x;
        const dz = other.pos.z - e.pos.z;
        const dsq = dx * dx + dz * dz;
        const px = player.pos.x - e.pos.x;
        const pz = player.pos.z - e.pos.z;
        const pdsq = px * px + pz * pz;
        if (dsq < pdsq && dsq < 36) target = other;
      }
      if (target !== player) {
        const dx = target.pos.x - e.pos.x;
        const dz = target.pos.z - e.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        const sp = e.speed * dt;
        e.pos.x += (dx / d) * sp;
        e.pos.z += (dz / d) * sp;
        if (e.obj) e.obj.position.copy(e.pos);

        // Damage enemy on contact — roaches bite
        if (dx * dx + dz * dz < 1.1 * 1.1) {
          target.hp -= ROACH_CONTACT_DMG;
          target.hitFlash = 0.15;
        }
      }
    }
  }
}

/**
 * Called when the game resets.
 */
export function clearInfectors() {
  // No module-level state to clear — infectors live in `enemies[]` and are
  // cleared by clearAllEnemies(). Placeholder hook in case we add lists later.
}

// -----------------------------------------------------------------------------
// SUPER NUKE
// -----------------------------------------------------------------------------

/**
 * Cleanse all infectors + possessed + roaches inside `radius` of `centerPos`.
 * Defaults to arena-wide. Leaves non-infector enemies alone so the wave
 * structure stays legible.
 */
export function triggerSuperNuke(centerPos, radius = SUPER_NUKE_RADIUS) {
  const rsq = radius * radius;
  let cleansed = 0;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!isInfector(e)) continue;
    const dx = e.pos.x - centerPos.x;
    const dz = e.pos.z - centerPos.z;
    if (dx * dx + dz * dz > rsq) continue;
    hitBurst(new THREE.Vector3(e.pos.x, 1.0, e.pos.z), 0xffffff, 12);
    if (e.obj && e.obj.parent) scene.remove(e.obj);
    enemies.splice(i, 1);
    cleansed++;
  }
  if (cleansed > 0) {
    hitBurst(centerPos, 0xffffff, 60);
    hitBurst(centerPos, 0xaaaaaa, 40);
    shake(0.6, 0.8);
    Audio.bigBoom && Audio.bigBoom();
    UI.toast && UI.toast('SUPER NUKE · CLEANSED ' + cleansed, '#ffffff', 2500);
  } else {
    UI.toast && UI.toast('NO INFECTION DETECTED', '#888888', 1500);
  }
}
