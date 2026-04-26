// queenHive.js — Chapter-1 reflow boss-hive replacement. Replaces
// the standard 4-hive cluster spawn with ONE oversized "queen hive"
// surrounded by 4 visual shield DOMES that pop one-by-one as the
// cannon fires.
//
// Design choices:
//   - Queen hive uses spawnPortal (same as regular hives) so all the
//     existing enemy-spawn + damage + destroy logic works unchanged.
//     We just scale up the visuals with `kind:'queen'` and place ONE.
//   - The queen has `shielded: true` until ALL 4 domes are popped,
//     then `shielded: false` so the player can damage it with their
//     gun in wave 3.
//   - Domes are 4 individual hemisphere meshes positioned at cardinal
//     points around the queen (N, E, S, W) at radius ~6u — far enough
//     out to read as "encircling" the queen without overlapping it.
//   - Dome pop animation: bright flash + outward expand + alpha fade
//     out + chapter-tinted shard burst.
//
// Public API:
//   spawnQueenHive(chapterIdx)  — place queen + 4 domes at hive triangle centroid
//   clearQueenHive()            — full cleanup
//   popQueenShield()            — pop the next intact dome (called by cannon)
//   queenShieldsRemaining()     — int 0..4
//   getQueen()                  — the queen spawner object (or null)
//   updateQueenHive(dt)         — animate dome pulse + pop animation

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { shake, S } from './state.js';
import { getTriangleFor } from './triangles.js';
import { spawners, spawnPortal, clearAllPortals } from './spawners.js';

// ---- Tunables ----
const DOME_RADIUS = 2.4;             // each dome's radius
const DOME_ORBIT_RADIUS = 6.0;       // domes spaced this far from queen center
const QUEEN_SCALE = 1.7;             // queen is ~1.7× a normal hive
const DOMES_COUNT = 4;

// ---- Geometry / materials (singletons) ----
const _DOME_GEO = new THREE.SphereGeometry(DOME_RADIUS, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2);
function _domeMat(tint) {
  return new THREE.MeshStandardMaterial({
    color: tint, transparent: true, opacity: 0.55,
    emissive: tint, emissiveIntensity: 0.45,
    roughness: 0.4, metalness: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

// ---- Module state ----
let _queen = null;        // the spawner object returned by spawnPortal
let _domes = [];          // [{ mesh, mat, intact, popping, t, ang }]
let _tint = 0xff2e4d;

/** Build the queen hive + 4 surrounding shield domes at the hive
 *  triangle centroid. Returns the queen spawner object. */
export function spawnQueenHive(chapterIdx) {
  // Defensive: clear any prior queen state
  clearQueenHive();
  // Also clear any standard-hive spawns since the queen replaces the
  // 4-hive cluster for chapter 1.
  clearAllPortals();

  _tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;

  // Queen position = hive triangle centroid
  const tri = getTriangleFor('hive');
  const ax = tri.minAngle, bx = tri.maxAngle;
  const cAng = (ax + bx) / 2;
  const cR = 22;       // similar to hive distance from origin
  const qx = Math.cos(cAng) * cR;
  const qz = Math.sin(cAng) * cR;

  // Spawn the queen as a regular portal — all hive logic reused.
  const queen = spawnPortal(qx, qz, chapterIdx);
  // Tag and shield
  queen.kind = 'queen';
  queen.shielded = true;            // gun shots bounce until domes pop
  queen.queenShieldsLeft = DOMES_COUNT;
  // Scale up the visual mesh — spawner uses `.obj` for the group
  if (queen.obj) {
    queen.obj.scale.setScalar(QUEEN_SCALE);
    // Lift slightly so the bigger mesh doesn't bury under the floor
    queen.obj.position.y = (queen.obj.position.y || 0) + 0.4;
  }
  // Queen has more HP than a normal hive (it's the boss-of-wave-3)
  if (typeof queen.hp === 'number') {
    queen.hpMax = (queen.hpMax || queen.hp) * 3;
    queen.hp = queen.hpMax;
  }
  spawners.push(queen);
  _queen = queen;

  // Place 4 domes around the queen at cardinal points
  for (let i = 0; i < DOMES_COUNT; i++) {
    const a = (i / DOMES_COUNT) * Math.PI * 2 - Math.PI / 2;     // start at +Z (north)
    const dx = qx + Math.cos(a) * DOME_ORBIT_RADIUS;
    const dz = qz + Math.sin(a) * DOME_ORBIT_RADIUS;
    const mat = _domeMat(_tint);
    const dome = new THREE.Mesh(_DOME_GEO, mat);
    dome.position.set(dx, 0.05, dz);
    scene.add(dome);
    _domes.push({
      mesh: dome,
      mat,
      intact: true,
      popping: false,
      popT: 0,
      ang: a,
      pulseSeed: Math.random() * Math.PI * 2,
    });
  }

  return queen;
}

/** Pop the next intact dome. Called once per cannon shot. Returns
 *  true if a dome was popped, false if no domes remain. After all
 *  domes are popped, the queen.shielded flag is cleared so player
 *  bullets can damage her. */
export function popQueenShield() {
  for (const d of _domes) {
    if (d.intact && !d.popping) {
      d.intact = false;
      d.popping = true;
      d.popT = 0;
      // Pop VFX — chapter-tinted burst at the dome center, plus
      // shards flying outward.
      const p = d.mesh.position;
      const burstPos = new THREE.Vector3(p.x, p.y + DOME_RADIUS * 0.5, p.z);
      hitBurst(burstPos, 0xffffff, 18);
      hitBurst(burstPos, _tint, 36);
      shake(0.4, 0.25);
      // Update queen's shield counter; clear shielded flag at 0
      if (_queen) {
        _queen.queenShieldsLeft = Math.max(0, (_queen.queenShieldsLeft || 0) - 1);
        if (_queen.queenShieldsLeft <= 0) {
          _queen.shielded = false;
        }
      }
      return true;
    }
  }
  return false;
}

/** Number of intact domes remaining (0..4). */
export function queenShieldsRemaining() {
  let n = 0;
  for (const d of _domes) if (d.intact) n++;
  return n;
}

/** The queen spawner object (so callers can read .pos / .hp / etc). */
export function getQueen() {
  return _queen;
}

/** True if the queen has been destroyed (HP <=0 or removed). */
export function isQueenDead() {
  if (!_queen) return false;
  return _queen.destroyed || (typeof _queen.hp === 'number' && _queen.hp <= 0);
}

// ---- Cannon beam VFX ----
// Transient laser beams from cannon muzzle to a popping dome. Each
// beam is a thick chapter-tinted cylinder that fades out over 0.4s.
const _beams = [];          // [{ mesh, mat, age }]
const BEAM_LIFE = 0.4;
const BEAM_RADIUS = 0.35;

/** Spawn a chapter-tinted laser beam from `fromPos` to `toPos`. The
 *  cylinder is oriented along the line between the two points and
 *  fades out over BEAM_LIFE seconds. */
export function spawnCannonBeam(fromPos, toPos) {
  if (!fromPos || !toPos) return;
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const dz = toPos.z - fromPos.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 0.1) return;
  // Cylinder along +Y by default, length=1. Scale Y to len, position
  // mid-way between endpoints, and rotate to face along (dx,dy,dz).
  const geo = new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, len, 10, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color: _tint, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(
    (fromPos.x + toPos.x) * 0.5,
    (fromPos.y + toPos.y) * 0.5,
    (fromPos.z + toPos.z) * 0.5,
  );
  // Default cylinder axis is +Y. We want it along the (dx,dy,dz) vector.
  // Compute the rotation that rotates +Y onto the target direction.
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
  mesh.quaternion.copy(quat);
  scene.add(mesh);
  _beams.push({ mesh, mat, geo, age: 0 });
}

/** Convenience: shoot a beam at the next-to-pop dome's world position. */
export function spawnCannonBeamToNextDome() {
  // Find the first intact (or just-popped this tick) dome
  let target = null;
  for (const d of _domes) {
    if (d.intact || d.popping) {
      target = d.mesh.position.clone();
      target.y += DOME_RADIUS * 0.5;
      break;
    }
  }
  if (!target) return;
  // Look up the cannon muzzle position. We do a dynamic import so
  // queenHive doesn't have to hard-import cannon at module load
  // (avoids circular import risk).
  // Simpler: callers pass the muzzle pos themselves. But since we
  // already know the cannon is at LAYOUT.silo, we can read it from
  // there + add muzzle offset. For perfect alignment use the actual
  // cannon API — see spawnCannonBeam which takes both endpoints.
  // Here we estimate: silo position + Y=4 (around muzzle height).
  // The waves.js caller has access to getCannonOrigin() and will
  // pass exact coords via a separate spawnCannonBeam call.
  // This convenience helper is for cases where the caller doesn't
  // have the muzzle pos handy.
  const muzzle = new THREE.Vector3(0, 4, 0);
  spawnCannonBeam(muzzle, target);
}

/** Get the next-popping dome's world position (for caller-driven
 *  beam VFX where waves.js wants to use getCannonOrigin() as the
 *  source). Returns null if all domes are gone. */
export function getNextDomePos() {
  for (const d of _domes) {
    if (d.intact || d.popping) {
      const p = d.mesh.position.clone();
      p.y += DOME_RADIUS * 0.5;
      return p;
    }
  }
  return null;
}

/** Per-frame update: animate dome pulse + pop animation + beam fade. */
export function updateQueenHive(dt) {
  for (let i = _domes.length - 1; i >= 0; i--) {
    const d = _domes[i];
    if (!d.popping && d.intact) {
      // Idle pulse — gentle scale + opacity bob to read as "active"
      d.pulseSeed += dt * 1.5;
      const pulse = 1.0 + Math.sin(d.pulseSeed) * 0.04;
      d.mesh.scale.setScalar(pulse);
      d.mat.opacity = 0.45 + Math.sin(d.pulseSeed * 1.3) * 0.15;
    } else if (d.popping) {
      // Pop animation — expand + fade over 0.45s
      d.popT += dt;
      const f = Math.min(1, d.popT / 0.45);
      const scale = 1.0 + f * 1.1;
      d.mesh.scale.setScalar(scale);
      d.mat.opacity = 0.7 * (1 - f);
      if (f >= 1) {
        if (d.mesh.parent) scene.remove(d.mesh);
        if (d.mat && d.mat.dispose) d.mat.dispose();
        _domes.splice(i, 1);
      }
    }
  }
  // Beam fade animation
  for (let i = _beams.length - 1; i >= 0; i--) {
    const b = _beams[i];
    b.age += dt;
    const f = Math.min(1, b.age / BEAM_LIFE);
    b.mat.opacity = 0.85 * (1 - f);
    // Slight beam expansion as it fades — looks more energetic
    const scl = 1.0 + f * 0.6;
    b.mesh.scale.x = scl;
    b.mesh.scale.z = scl;
    if (f >= 1) {
      if (b.mesh.parent) scene.remove(b.mesh);
      if (b.mat && b.mat.dispose) b.mat.dispose();
      if (b.geo && b.geo.dispose) b.geo.dispose();
      _beams.splice(i, 1);
    }
  }
}

/** Full cleanup — remove queen + all domes from the scene. Called on
 *  chapter exit / reset. */
export function clearQueenHive() {
  for (const d of _domes) {
    if (d.mesh && d.mesh.parent) scene.remove(d.mesh);
    if (d.mat && d.mat.dispose) d.mat.dispose();
  }
  _domes.length = 0;
  for (const b of _beams) {
    if (b.mesh && b.mesh.parent) scene.remove(b.mesh);
    if (b.mat && b.mat.dispose) b.mat.dispose();
    if (b.geo && b.geo.dispose) b.geo.dispose();
  }
  _beams.length = 0;
  // The queen is in the spawners array — clearAllPortals() in
  // spawners.js handles its mesh removal. We just drop our reference.
  _queen = null;
}
