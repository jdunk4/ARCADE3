// cockroachBoss.js — Chapter 2 wave 3 boss. A giant cockroach
// rendered as a floor decal (flat planes at low Y, no 3D collision)
// carrying 4 hives on its back arranged as 2 wing-clusters.
//
// Behavior:
//   - Stationary while any hive is alive
//   - When all 4 hives die: roach starts a slow circular crawl
//     around the arena center (radius 12u, speed 1.5u/s)
//   - After 8s of crawling: roach fades out of the tiles
//   - Wave ends when fade completes (signal via isCockroachDeadAndDone)
//
// Visual:
//   - Body oval — long flat plane, dark with chapter-tinted edge
//   - Head — smaller oval at front
//   - 2 antennae — thin shapes extending forward
//   - 6 legs — 3 per side, angular flat shapes splaying outward
//   - All at Y ≈ 0.04 so they read as silhouettes on the grid tiles
//
// Hives:
//   - 4 hives via spawnPortal — local offsets in roach space
//   - Cluster A (left wing): (-4.5, +1.4) and (-4.5, -1.4)
//   - Cluster B (right wing): (+4.5, +1.4) and (+4.5, -1.4)
//   - Per-frame: hive world pos = roach center + offset rotated by yaw
//   - Hives float above the floor decal, NOT child of the roach group
//     (they're managed in the standard spawners array so all bullet/AI
//     code targets them normally)

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { hitBurst } from './effects.js';
import { spawners, spawnPortal } from './spawners.js';

// ---- Tunables ----
const ROACH_RADIUS = 12;            // orbit radius around arena origin during crawl phase
const ROACH_SPEED = 1.5;            // u/s during crawl phase
const FADE_DURATION = 2.5;          // seconds for decal fade-out

// Hive offsets in roach-local space (X = left/right of body axis, Z = front/back)
// Body axis: +Z is forward (head direction).
// Wing-clusters: each pair is symmetric across the body axis.
const HIVE_OFFSETS = [
  { x: -4.5, z:  1.4 },   // Left wing, forward
  { x: -4.5, z: -1.4 },   // Left wing, rear
  { x:  4.5, z:  1.4 },   // Right wing, forward
  { x:  4.5, z: -1.4 },   // Right wing, rear
];

// ---- Geometry ----
const BODY_GEO    = new THREE.PlaneGeometry(5.0, 14.0);   // 5 wide × 14 long
const HEAD_GEO    = new THREE.PlaneGeometry(3.5, 3.0);
const ANTENNA_GEO = new THREE.PlaneGeometry(0.18, 4.0);
const LEG_GEO     = new THREE.PlaneGeometry(0.45, 5.5);
const BODY_RIM_GEO = new THREE.RingGeometry(2.4, 2.55, 24);
const SEGMENT_GEO = new THREE.PlaneGeometry(4.6, 0.18);   // body segment lines

// ---- Materials ----
function _bodyMat() {
  return new THREE.MeshBasicMaterial({
    color: 0x0d0e10, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
  });
}
function _bodyEdgeMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
function _legMat() {
  return new THREE.MeshBasicMaterial({
    color: 0x080a0c, transparent: true, opacity: 0.75,
    side: THREE.DoubleSide, depthWrite: false,
  });
}
function _antennaMat(tint) {
  return new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.6,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ---- Module state ----
let _roach = null;

/** Build the floor-decal cockroach + spawn its 4 hives. Roach is
 *  centered at the arena origin (0, 0). All hives are unshielded
 *  (the laser fried them in wave 2). */
export function spawnCockroachBoss(chapterIdx) {
  if (_roach) clearCockroachBoss();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;

  const group = new THREE.Group();
  group.position.set(0, 0.04, 0);     // floor-level

  // Track all materials separately so we can fade them all together
  const fadeMats = [];

  // --- BODY (long oval — main thorax/abdomen) ---
  const bodyMat = _bodyMat();
  const body = new THREE.Mesh(BODY_GEO, bodyMat);
  body.rotation.x = -Math.PI / 2;     // lie flat on floor
  group.add(body);
  fadeMats.push(bodyMat);

  // Body rim — chapter-tinted glow ring around the abdomen
  const rimMat = _bodyEdgeMat(tint);
  const rim = new THREE.Mesh(BODY_RIM_GEO, rimMat);
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(0, 0.001, -2.5);
  rim.scale.set(1.0, 1.0, 2.4);       // stretch into oval shape
  group.add(rim);
  fadeMats.push(rimMat);

  // Body segment lines (3 dark stripes across the abdomen)
  for (let i = 0; i < 3; i++) {
    const segMat = _bodyMat();
    const seg = new THREE.Mesh(SEGMENT_GEO, segMat);
    seg.rotation.x = -Math.PI / 2;
    seg.position.set(0, 0.005, -3.5 + i * 1.6);
    group.add(seg);
    fadeMats.push(segMat);
  }

  // --- HEAD (smaller oval at front of body, +Z direction) ---
  const headMat = _bodyMat();
  const head = new THREE.Mesh(HEAD_GEO, headMat);
  head.rotation.x = -Math.PI / 2;
  head.position.set(0, 0.003, 7.5);
  group.add(head);
  fadeMats.push(headMat);

  // --- ANTENNAE (2 thin lines extending forward) ---
  const ant1Mat = _antennaMat(tint);
  const ant1 = new THREE.Mesh(ANTENNA_GEO, ant1Mat);
  ant1.rotation.x = -Math.PI / 2;
  ant1.rotation.z = 0.3;
  ant1.position.set(-0.7, 0.005, 10.5);
  group.add(ant1);
  fadeMats.push(ant1Mat);

  const ant2Mat = _antennaMat(tint);
  const ant2 = new THREE.Mesh(ANTENNA_GEO, ant2Mat);
  ant2.rotation.x = -Math.PI / 2;
  ant2.rotation.z = -0.3;
  ant2.position.set(0.7, 0.005, 10.5);
  group.add(ant2);
  fadeMats.push(ant2Mat);

  // --- LEGS (6 legs, 3 per side, splaying outward) ---
  // Local Z positions for the 3 leg-pairs along the body
  const legZs = [3.5, 0.5, -3.0];
  // Splay angles (degrees off perpendicular) so legs fan front/back
  const splayAngles = [Math.PI / 6, 0, -Math.PI / 6];
  for (let i = 0; i < 3; i++) {
    const z = legZs[i];
    const splay = splayAngles[i];

    // Left leg (negative X)
    const legLMat = _legMat();
    const legL = new THREE.Mesh(LEG_GEO, legLMat);
    legL.rotation.x = -Math.PI / 2;
    legL.rotation.z = Math.PI / 2 + splay;
    legL.position.set(-3.2, 0.002, z);
    group.add(legL);
    fadeMats.push(legLMat);

    // Right leg (positive X)
    const legRMat = _legMat();
    const legR = new THREE.Mesh(LEG_GEO, legRMat);
    legR.rotation.x = -Math.PI / 2;
    legR.rotation.z = -Math.PI / 2 - splay;
    legR.position.set(3.2, 0.002, z);
    group.add(legR);
    fadeMats.push(legRMat);
  }

  scene.add(group);

  // --- SPAWN 4 HIVES at body offsets ---
  const hives = [];
  const yaw = group.rotation.y;
  for (const off of HIVE_OFFSETS) {
    // World position = roach center + offset rotated by roach yaw
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const wx = group.position.x + off.x * cosY + off.z * sinY;
    const wz = group.position.z - off.x * sinY + off.z * cosY;
    const h = spawnPortal(wx, wz, chapterIdx);
    h.kind = 'roach-wing';
    h.shielded = false;          // laser pre-fried them in wave 2
    if (h.obj) {
      h.obj.scale.setScalar(1.5);
      h.obj.position.y = (h.obj.position.y || 0) + 0.2;
    }
    if (typeof h.hp === 'number') {
      h.hpMax = (h.hpMax || h.hp) * 1.5;
      h.hp = h.hpMax;
    }
    spawners.push(h);
    hives.push({ portal: h, localOffset: off });
  }

  _roach = {
    group,
    fadeMats,
    hives,
    tint,
    yaw: 0,                          // current heading (world)
    crawlAngle: Math.random() * Math.PI * 2,   // current angle on circular orbit
    crawling: false,                 // false until all hives die
    crawlT: 0,                       // total crawl time (for fade trigger)
    fadeStartT: -1,                  // -1 until fade begins
    fadeT: 0,
    done: false,
    legBobT: 0,
  };
  return _roach;
}

/** Returns the roach's hive portals (for wave-end checks). */
export function getCockroachHives() {
  if (!_roach) return [];
  return _roach.hives.map(h => h.portal);
}

/** Count surviving hives. */
function _liveHiveCount() {
  if (!_roach) return 0;
  let n = 0;
  for (const h of _roach.hives) {
    const p = h.portal;
    if (p && !p.destroyed && (p.hp || 0) > 0) n++;
  }
  return n;
}

/** True after the post-death fade finishes — caller can endWave. */
export function isCockroachDeadAndDone() {
  return !!(_roach && _roach.done);
}

/** Per-frame update — animate leg bob, drive movement when hives dead,
 *  reposition hives to follow body, fade decal post-death. */
export function updateCockroach(dt) {
  if (!_roach) return;

  // Subtle leg-bob always — even stationary the roach "breathes"
  _roach.legBobT += dt * 1.5;

  const hivesAlive = _liveHiveCount();
  const allDead = hivesAlive === 0;

  if (allDead && !_roach.crawling) {
    _roach.crawling = true;
    // Initial body burst — chapter-tinted dust to mark hive-clear moment
    try {
      for (let k = 0; k < 14; k++) {
        hitBurst(
          new THREE.Vector3(
            _roach.group.position.x + (Math.random() - 0.5) * 8.0,
            0.4 + Math.random() * 0.5,
            _roach.group.position.z + (Math.random() - 0.5) * 8.0,
          ),
          _roach.tint, 12,
        );
      }
    } catch (e) {}
  }

  // Movement: circular crawl around arena origin, radius ROACH_RADIUS
  if (_roach.crawling && _roach.fadeStartT < 0) {
    _roach.crawlT += dt;
    // Angular speed = linear speed / radius
    const angularSpeed = ROACH_SPEED / ROACH_RADIUS;
    _roach.crawlAngle += angularSpeed * dt;
    const newX = Math.cos(_roach.crawlAngle) * ROACH_RADIUS;
    const newZ = Math.sin(_roach.crawlAngle) * ROACH_RADIUS;
    // Yaw — face direction of motion (tangent to circle).
    // Tangent direction at angle a is (-sin a, cos a) on circle.
    const tx = -Math.sin(_roach.crawlAngle);
    const tz =  Math.cos(_roach.crawlAngle);
    _roach.yaw = Math.atan2(tx, tz);
    _roach.group.position.x = newX;
    _roach.group.position.z = newZ;
    _roach.group.rotation.y = _roach.yaw;

    // After 8s of crawling, start fade-out
    if (_roach.crawlT > 8.0) {
      _roach.fadeStartT = 0;
    }
  }

  // Decal fade-out after fade trigger
  if (_roach.fadeStartT >= 0) {
    _roach.fadeStartT += dt;
    const f = Math.min(1, _roach.fadeStartT / FADE_DURATION);
    const opacityMul = 1 - f;
    for (const m of _roach.fadeMats) {
      // Each material has a different base opacity; we just multiply
      // it by opacityMul. Track the original via a userData stash.
      if (m._origOpacity === undefined) m._origOpacity = m.opacity;
      m.opacity = m._origOpacity * opacityMul;
    }
    if (f >= 1 && !_roach.done) {
      _roach.done = true;
    }
  }

  // Reposition hives to follow the roach body (so they look like they're
  // "on its back" even as it crawls).
  const yaw = _roach.group.rotation.y;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cx = _roach.group.position.x;
  const cz = _roach.group.position.z;
  for (const h of _roach.hives) {
    const off = h.localOffset;
    const wx = cx + off.x * cosY + off.z * sinY;
    const wz = cz - off.x * sinY + off.z * cosY;
    if (h.portal && !h.portal.destroyed) {
      // Update both the logical pos (used by AI / arrows / damage)
      // and the visual obj.position
      if (h.portal.pos) {
        h.portal.pos.x = wx;
        h.portal.pos.z = wz;
      }
      if (h.portal.obj) {
        h.portal.obj.position.x = wx;
        h.portal.obj.position.z = wz;
      }
    }
  }
}

export function hasCockroach() {
  return !!_roach;
}

export function clearCockroachBoss() {
  if (!_roach) return;
  if (_roach.group && _roach.group.parent) scene.remove(_roach.group);
  for (const m of _roach.fadeMats) {
    if (m && m.dispose) m.dispose();
  }
  // Hives are in the spawners array — clearAllPortals handles them
  // at chapter teardown. Don't dispose individually here.
  _roach = null;
}
