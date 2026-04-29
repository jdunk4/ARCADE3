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
import { getHexTilingTexture } from './dormantProps.js';

// ---- Tunables ----
// Queen is much bigger than a normal hive — visible from any angle,
// reads as "the boss of this chapter". 4× scale per user request.
const QUEEN_SCALE = 4.0;

// Shield domes are CONCENTRIC SPHERES centered on the queen, not
// orbiting hemispheres. Each layer's radius is set so the outermost
// is just outside the queen's silhouette and each subsequent inner
// layer is ~1.6u smaller. The outermost layer is the one cannon
// shots hit first; when popped, the next layer becomes the new outer.
const DOME_RADII = [13.0, 11.4, 9.8, 8.2];   // outer → inner (4 layers)
const DOMES_COUNT = DOME_RADII.length;

// ---- Geometry / materials ----
// Pre-build one geometry per radius (cached). Full sphere — covers
// the queen completely from all angles.
const _DOME_GEOS = DOME_RADII.map(r =>
  new THREE.SphereGeometry(r, 24, 18)
);
function _domeMat(tint, layerIdx) {
  // Outer layer most opaque (most "armored-looking"), inner layers
  // progressively dimmer so the player can see SOMETHING through
  // them and read "there are more shields beneath."
  const baseOpacity = 0.45 - layerIdx * 0.06;     // 0.45, 0.39, 0.33, 0.27
  // Apply the same hex tiling texture used by the spawner shields
  // so the queen's domes match the visual language of the rest of
  // the game's shields. Each layer gets its own clone of the texture
  // with a slightly different repeat count so the hex patterns
  // don't perfectly stack into a single visual line — outer layer
  // has the most hexes (densest), inner the fewest. Reads as nested
  // force-field layers rather than a single shield.
  const hexTex = getHexTilingTexture().clone();
  hexTex.needsUpdate = true;
  hexTex.wrapS = hexTex.wrapT = THREE.RepeatWrapping;
  // Scale repeat by layer so each dome's pattern is distinguishable.
  // Outer (large radius) = more repeats so hexes stay visually small.
  // Inner (smaller radius) = fewer repeats so hexes stay readable.
  const repeatBase = 6 - layerIdx;     // 6, 5, 4, 3 horizontal
  hexTex.repeat.set(repeatBase, Math.max(2, repeatBase - 2));
  return new THREE.MeshStandardMaterial({
    map: hexTex,
    color: tint,
    transparent: true,
    opacity: baseOpacity,
    emissive: tint,
    emissiveIntensity: 0.55 - layerIdx * 0.08,
    roughness: 0.4,
    metalness: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

// ---- Module state ----
let _queen = null;        // back-compat reference (first hive in cluster)
let _queens = [];         // all 4 hives in the cluster
let _clusterX = 0;        // cluster center X (for shield collision + beam aim)
let _clusterZ = 0;        // cluster center Z
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

  // Cluster center — at the hive triangle centroid
  const tri = getTriangleFor('hive');
  const ax = tri.minAngle, bx = tri.maxAngle;
  const cAng = (ax + bx) / 2;
  const cR = 22;
  const cx = Math.cos(cAng) * cR;
  const cz = Math.sin(cAng) * cR;
  // Stash cluster center for beam aim + shield collision
  _clusterX = cx;
  _clusterZ = cz;

  // Spawn 4 hives in a tight ring at radius ~3u. Each hive is a
  // regular portal — all enemy-spawn + damage + destroy logic reuses
  // the standard pipeline. They all share a queen-shield pool: the
  // 4 concentric domes covering the whole cluster pop one per cannon
  // shot, and clearing all 4 sets shielded=false on every hive.
  const HIVE_RING_RADIUS = 3.0;
  const HIVE_COUNT = 4;
  for (let i = 0; i < HIVE_COUNT; i++) {
    const a = (i / HIVE_COUNT) * Math.PI * 2;
    const hx = cx + Math.cos(a) * HIVE_RING_RADIUS;
    const hz = cz + Math.sin(a) * HIVE_RING_RADIUS;
    const h = spawnPortal(hx, hz, chapterIdx);
    h.kind = 'queen-cluster';
    h.shielded = true;
    // Scale the cluster hives somewhat (smaller than the previous big
    // single queen, but larger than default hives so they read as
    // boss-tier). 1.6× balances "tight cluster" with "intimidating".
    if (h.obj) {
      h.obj.scale.setScalar(1.6);
      h.obj.position.y = (h.obj.position.y || 0) + 0.2;
    }
    // Per-hive hp boost — wave 3 needs to feel substantial
    if (typeof h.hp === 'number') {
      h.hpMax = (h.hpMax || h.hp) * 2;
      h.hp = h.hpMax;
    }
    spawners.push(h);
    _queens.push(h);
  }
  // Track shields-left on the FIRST hive object (the API surface
  // queenShieldsRemaining/popQueenShield uses _domes count anyway,
  // so this is bookkeeping only). _queen stays as a back-compat
  // reference to the first hive in the cluster.
  _queen = _queens[0];
  _queen.queenShieldsLeft = DOMES_COUNT;

  // Place 4 CONCENTRIC SHIELD SPHERES centered on the cluster. The
  // outermost shell is the one cannon shots hit first; when it pops,
  // the next shell becomes the new outer.
  for (let i = 0; i < DOMES_COUNT; i++) {
    const mat = _domeMat(_tint, i);
    const geo = _DOME_GEOS[i];
    const dome = new THREE.Mesh(geo, mat);
    dome.position.set(cx, 4.0, cz);
    scene.add(dome);
    _domes.push({
      mesh: dome,
      mat,
      intact: true,
      popping: false,
      popT: 0,
      layerIdx: i,                     // 0 = outermost
      pulseSeed: Math.random() * Math.PI * 2,
    });
  }

  return _queen;
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
      // shards flying outward. The dome center IS the queen center
      // (lifted to mid-shield height) so the burst reads as the
      // shield collapsing inward toward the queen.
      const p = d.mesh.position;
      const burstPos = new THREE.Vector3(p.x, p.y, p.z);
      hitBurst(burstPos, 0xffffff, 18);
      hitBurst(burstPos, _tint, 36);
      shake(0.4, 0.25);
      // Update shield counter on the back-compat queen reference;
      // clear `shielded` flag on ALL hives in the cluster at 0 so
      // every hive becomes vulnerable simultaneously.
      if (_queen) {
        _queen.queenShieldsLeft = Math.max(0, (_queen.queenShieldsLeft || 0) - 1);
        if (_queen.queenShieldsLeft <= 0) {
          for (const h of _queens) {
            if (h) h.shielded = false;
          }
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
      // All concentric shields share the queen's center. Beam endpoint
      // is the queen position lifted to mid-shield height so the laser
      // visually strikes the dome surface from above, not the floor.
      const p = d.mesh.position.clone();
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
      // Idle pulse — gentle scale + opacity bob to read as "active".
      // Use the layer-specific base opacity so outer shells stay more
      // opaque and inner shells dimmer, with a small modulation
      // around that baseline.
      d.pulseSeed += dt * 1.5;
      const pulse = 1.0 + Math.sin(d.pulseSeed) * 0.04;
      d.mesh.scale.setScalar(pulse);
      const baseOpacity = 0.45 - (d.layerIdx || 0) * 0.06;
      let opacity = baseOpacity + Math.sin(d.pulseSeed * 1.3) * 0.10;
      // Hit-flash override — when a bullet pings the shield, ramp
      // opacity + emissive briefly so the shield "blinks" on hit.
      if (d._hitFlashT && d._hitFlashT > 0) {
        d._hitFlashT -= dt;
        const flash = Math.max(0, d._hitFlashT) / 0.15;
        opacity = Math.min(1.0, opacity + flash * 0.55);
      }
      d.mat.opacity = opacity;
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

/**
 * Test if a bullet position has hit the outermost intact shield.
 * Returns true if the bullet was inside the shield (and consumed by it),
 * triggering a chapter-tinted ping spark + a brief dome flash so the
 * shield reads as alive.
 *
 * Caller is responsible for removing the bullet on a true return.
 */
export function tryHitQueenShield(bulletPos) {
  if (!bulletPos) return false;
  // Find outermost intact dome (lowest layerIdx in the array order).
  let outerIntact = null;
  for (const d of _domes) {
    if (d.intact && !d.popping) {
      outerIntact = d;
      break;
    }
  }
  if (!outerIntact) return false;
  const radius = DOME_RADII[outerIntact.layerIdx] || DOME_RADII[0];
  const dx = bulletPos.x - _clusterX;
  const dz = bulletPos.z - _clusterZ;
  const dy = bulletPos.y - 4.0;            // dome center Y
  const dist2 = dx * dx + dy * dy + dz * dz;
  if (dist2 > radius * radius) return false;
  // Inside the shield — register hit. Ping spark at the surface
  // closest to the bullet (looks like the shot impacted the shell).
  const dist = Math.sqrt(dist2);
  const surfaceX = _clusterX + (dx / dist) * radius;
  const surfaceY = 4.0 + (dy / dist) * radius;
  const surfaceZ = _clusterZ + (dz / dist) * radius;
  const impactPos = new THREE.Vector3(surfaceX, surfaceY, surfaceZ);
  hitBurst(impactPos, 0xffffff, 4);
  hitBurst(impactPos, _tint, 8);
  // Flash the dome's emissive — visible "blink" on hit.
  outerIntact._hitFlashT = 0.15;
  return true;
}

/**
 * Read-only inspection of the outermost intact dome. Used by callers
 * that need dome geometry for beam/projectile clamping but should NOT
 * register a hit (e.g. the raygun beam clamping its visible length to
 * the dome surface every frame). Returns null when no intact domes
 * remain — meaning shields are fully down.
 *
 * Returned object: { x, y, z, radius } in world coordinates.
 */
export function getOutermostDomeInfo() {
  let outerIntact = null;
  for (const d of _domes) {
    if (d.intact && !d.popping) {
      outerIntact = d;
      break;
    }
  }
  if (!outerIntact) return null;
  const radius = DOME_RADII[outerIntact.layerIdx] || DOME_RADII[0];
  return { x: _clusterX, y: 4.0, z: _clusterZ, radius };
}

/**
 * Flash the outermost dome and emit hit sparks at the given world
 * point. Used by callers that detected their own shield collision
 * (e.g. raygun beam intersection math) and want the same visual
 * feedback as tryHitQueenShield but at a chosen impact point.
 * Returns true if a flash was applied.
 */
export function pingQueenShieldAt(impactPos) {
  if (!impactPos) return false;
  let outerIntact = null;
  for (const d of _domes) {
    if (d.intact && !d.popping) { outerIntact = d; break; }
  }
  if (!outerIntact) return false;
  hitBurst(impactPos, 0xffffff, 4);
  hitBurst(impactPos, _tint, 8);
  outerIntact._hitFlashT = 0.15;
  return true;
}

/**
 * Push the player out of the outermost intact dome. Called once per
 * frame from main with the current player position. Mutates playerPos
 * directly so the player is shoved back along the dome surface normal
 * if they try to walk in. No-op once all 4 domes are popped.
 */
export function tickQueenShieldCollision(playerPos) {
  if (!playerPos) return false;
  // Find the outermost intact dome — its layerIdx + radius give us
  // the active barrier the player can't cross.
  let outerIntact = null;
  for (const d of _domes) {
    if (d.intact && !d.popping) {
      // First match is outermost (spawn order outer→inner, popQueenShield
      // pops outer-first so _domes[0] is always the outermost living one).
      outerIntact = d;
      break;
    }
  }
  if (!outerIntact) return false;
  const radius = DOME_RADII[outerIntact.layerIdx] || DOME_RADII[0];
  const dx = playerPos.x - _clusterX;
  const dz = playerPos.z - _clusterZ;
  const dist2 = dx * dx + dz * dz;
  if (dist2 > radius * radius) return false;
  // Player is inside the dome — push them out to the surface.
  const dist = Math.sqrt(dist2);
  if (dist < 0.001) {
    // At the exact center — push along an arbitrary direction
    playerPos.x = _clusterX + radius;
    return true;
  }
  const inv = radius / dist;
  playerPos.x = _clusterX + dx * inv;
  playerPos.z = _clusterZ + dz * inv;
  return true;
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
  // The queens are in the spawners array — clearAllPortals() in
  // spawners.js handles their mesh removal. We just drop our refs.
  _queen = null;
  _queens.length = 0;
  _clusterX = 0;
  _clusterZ = 0;
}
