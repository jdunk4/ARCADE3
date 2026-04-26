// hazardsDonkeyKong.js — Chapter 6 (PARADISE, chapterIdx 5) hazard style.
//
// CONCEPT (Donkey Kong arcade homage)
//   Four blue 3D ladders stand at the corners of the arena. Periodically
//   each ladder drops a red barrel — the barrel descends as a 3D
//   cylinder, then transitions to a 2D rolling sprite at ground level.
//   While rolling, the barrel lays purple hazard tiles. Tiles fill
//   concentric rings from outside-in, like the pong style.
//
//   In addition to barrels, two FIRE characters live on the arena.
//   They alternate 2D (sprite on the floor) and 3D (small flame mesh
//   hovering up) states like the pacman ghosts. Fires walk across
//   hazard tiles (preferring tile cells). When in 3D state, they
//   periodically drop "trail fire" markers on tiles. Player touching
//   any fire — main fires OR trail fires, in any state — is INSTANT
//   KILL.
//
// API (matches the chapter-style contract used by hazards.js):
//   getCellSize()         — quantization unit (2.5u, matches floor grid)
//   chooseSpawnLocation() — no-op (style manages its own placement)
//   spawnDelivery()       — no-op
//   tickDeliveries(dt)    — advances barrels + fires + lays tiles
//   cleanup()             — removes meshes
//   managesOwnSpawns      — true: hazards.js skips its drop-loop

import * as THREE from 'three';
import { scene, camera } from './scene.js';
import { ARENA, WAVES_PER_CHAPTER } from './config.js';
import { hitBurst } from './effects.js';
import { isCellInBlockedZone } from './hazards.js';
import { S } from './state.js';

// Player + UI for instant-kill on fire contact. Imports done inline
// to avoid a circular-import risk during module bootstrap.
import { player } from './player.js';
import { UI } from './ui.js';

// ---- TUNING ----
const CELL_SIZE = 2.5;                    // floor grid unit
const RING_WIDTH = 8.0;
const FILL_THRESHOLD = 0.85;
const SAFE_INNER = 8.0;
const TILE_TINT = 0x9933ff;               // vivid purple

// Ladder placement — 4 corners of the outer ring, slight inset from
// arena edge so they're clearly INSIDE the arena.
const LADDER_INSET = 4.0;
const LADDER_HEIGHT = 6.5;                // top of ladder above floor
const LADDER_WIDTH = 0.9;                 // cross-section width
const LADDER_RUNG_COUNT = 12;

// Barrel mechanics
const BARREL_SPAWN_INTERVAL = 6.0;        // seconds between spawns per ladder
const BARREL_DESCENT_TIME = 1.4;          // seconds to fall from top to floor
const BARREL_ROLL_SPEED = 7.5;            // units per second along ground
const BARREL_ROLL_LIFETIME = 4.0;         // seconds of rolling before despawn
const BARREL_RADIUS = 0.55;

// Fire characters
const FIRE_COUNT = 2;
const FIRE_SPEED = 5.5;
const FIRE_3D_DURATION = 3.5;             // seconds in 3D (hovering)
const FIRE_2D_DURATION = 5.0;             // seconds in 2D (sprite on floor)
const FIRE_TRAIL_INTERVAL = 0.45;         // seconds between trail-fire drops while 3D
const FIRE_KILL_RADIUS = 0.95;            // distance at which player dies on contact
const TRAIL_FIRE_LIFETIME = 5.0;          // seconds before trail fire fades
const TRAIL_FIRE_KILL_RADIUS = 0.65;      // smaller radius for trail fires

// ---- STATE ----
let _initialized = false;
let _ladders = [];                        // [{ mesh, cooldown, x, z }]
let _barrels = [];                        // [{ mesh, phase, age, x, z, dirX, dirZ, ladderIdx }]
let _fires = [];                          // [{ mesh3D, sprite2D, state, stateTimer, trailTimer, x, z, dirX, dirZ }]
let _trailFires = [];                     // [{ mesh, age, x, z }]
let _coveredCells = new Set();            // hazard tile cells laid by barrels
let _currentRing = 0;
let _ringTotalCache = new Map();

// ---- HELPERS ----
function _ringOuterHalf(n) { return ARENA - n * RING_WIDTH; }
function _ringInnerHalf(n) { return _ringOuterHalf(n + 1); }
function _ringCount() {
  return Math.max(1, Math.min(6, Math.floor((ARENA - SAFE_INNER) / RING_WIDTH)));
}
function _snap(v) { return Math.round(v / CELL_SIZE) * CELL_SIZE; }
function _cellKey(x, z) { return `${_snap(x)},${_snap(z)}`; }

function _isInWave2() {
  if (!S || !S.wave) return false;
  return ((S.wave - 1) % WAVES_PER_CHAPTER) + 1 === 2;
}

function _ringTotalCells(ringIdx) {
  if (_ringTotalCache.has(ringIdx)) return _ringTotalCache.get(ringIdx);
  const outer = _ringOuterHalf(ringIdx);
  const inner = _ringInnerHalf(ringIdx);
  let count = 0;
  for (let cx = -outer + CELL_SIZE / 2; cx < outer; cx += CELL_SIZE) {
    for (let cz = -outer + CELL_SIZE / 2; cz < outer; cz += CELL_SIZE) {
      const ax = Math.abs(cx);
      const az = Math.abs(cz);
      if ((ax < outer && az < outer) && !(ax < inner && az < inner)) count++;
    }
  }
  _ringTotalCache.set(ringIdx, count);
  return count;
}

function _ringCoveredCells(ringIdx) {
  const outer = _ringOuterHalf(ringIdx);
  const inner = _ringInnerHalf(ringIdx);
  let count = 0;
  for (const key of _coveredCells) {
    const parts = key.split(',');
    const cx = parseFloat(parts[0]);
    const cz = parseFloat(parts[1]);
    const ax = Math.abs(cx);
    const az = Math.abs(cz);
    if ((ax < outer && az < outer) && !(ax < inner && az < inner)) count++;
  }
  return count;
}

// ---- LADDER GEOMETRY ----
// Cross-shaped ladder: two perpendicular rail-pairs forming a "+" in
// horizontal cross-section so it reads as a real ladder from any angle.
// Two vertical rails along X axis, two along Z axis. Rungs pierce through
// the cross at evenly-spaced heights.
function _makeLadderMesh() {
  const g = new THREE.Group();
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x3344ff,
    emissive: 0x2244cc,
    emissiveIntensity: 0.7,
    roughness: 0.4,
    metalness: 0.3,
  });
  const rungMat = new THREE.MeshStandardMaterial({
    color: 0x4488ff,
    emissive: 0x3366ff,
    emissiveIntensity: 0.9,
    roughness: 0.4,
    metalness: 0.3,
  });
  const railHalf = LADDER_WIDTH / 2;
  // Vertical rails — 4 corner posts. Geom is a tall thin cylinder.
  const railGeo = new THREE.CylinderGeometry(0.07, 0.07, LADDER_HEIGHT, 6);
  const cornerOffsets = [
    [-railHalf, -railHalf], [railHalf, -railHalf],
    [railHalf,  railHalf], [-railHalf,  railHalf],
  ];
  for (const [ox, oz] of cornerOffsets) {
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.set(ox, LADDER_HEIGHT / 2, oz);
    g.add(rail);
  }
  // Rungs — horizontal cross bars. For the "visible from all 4 sides"
  // effect we add rungs in BOTH X and Z orientations at each height.
  const rungGeoX = new THREE.BoxGeometry(LADDER_WIDTH + 0.1, 0.05, 0.10);
  const rungGeoZ = new THREE.BoxGeometry(0.10, 0.05, LADDER_WIDTH + 0.1);
  const ystep = LADDER_HEIGHT / (LADDER_RUNG_COUNT + 1);
  for (let i = 1; i <= LADDER_RUNG_COUNT; i++) {
    const y = i * ystep;
    const rx = new THREE.Mesh(rungGeoX, rungMat);
    rx.position.set(0, y, 0);
    g.add(rx);
    const rz = new THREE.Mesh(rungGeoZ, rungMat);
    rz.position.set(0, y, 0);
    g.add(rz);
  }
  return g;
}

// ---- BARREL GEOMETRY ----
// 3D barrel: short cylinder with red emissive
const BARREL_GEO_3D = new THREE.CylinderGeometry(BARREL_RADIUS, BARREL_RADIUS, 0.95, 12);
function _makeBarrel3DMesh() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff4400,
    emissive: 0xff2200,
    emissiveIntensity: 0.8,
    roughness: 0.5,
    metalness: 0.2,
  });
  const m = new THREE.Mesh(BARREL_GEO_3D, mat);
  m.rotation.z = Math.PI / 2;     // rolling orientation (axis along travel direction)
  return m;
}

// 2D barrel: flat circle with painted-on barrel detail
const BARREL_SPRITE_GEO = new THREE.PlaneGeometry(BARREL_RADIUS * 2.4, BARREL_RADIUS * 2.4);
let _barrelSpriteTex = null;
function _getBarrelSpriteTexture() {
  if (_barrelSpriteTex) return _barrelSpriteTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  // Draw a 2D barrel: red circle with darker bands
  ctx.fillStyle = '#ff3300';
  ctx.beginPath(); ctx.arc(32, 32, 28, 0, Math.PI * 2); ctx.fill();
  // Outer rim
  ctx.strokeStyle = '#aa1100'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(32, 32, 28, 0, Math.PI * 2); ctx.stroke();
  // Bands
  ctx.strokeStyle = '#660000'; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(8, 22); ctx.lineTo(56, 22);
  ctx.moveTo(8, 42); ctx.lineTo(56, 42);
  ctx.stroke();
  // Highlight
  ctx.fillStyle = '#ffaa66';
  ctx.beginPath(); ctx.arc(24, 24, 4, 0, Math.PI * 2); ctx.fill();
  _barrelSpriteTex = new THREE.CanvasTexture(c);
  _barrelSpriteTex.magFilter = THREE.NearestFilter;
  _barrelSpriteTex.minFilter = THREE.NearestFilter;
  return _barrelSpriteTex;
}
function _makeBarrel2DMesh() {
  const mat = new THREE.MeshBasicMaterial({
    map: _getBarrelSpriteTexture(),
    transparent: true,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(BARREL_SPRITE_GEO, mat);
  m.rotation.x = -Math.PI / 2;     // lay flat on floor
  return m;
}

// ---- FIRE CHARACTERS ----
// 2D sprite: small flame on canvas
let _fireSpriteTex = null;
function _getFireSpriteTexture() {
  if (_fireSpriteTex) return _fireSpriteTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  // Draw a stylized flame: red base, orange middle, yellow inner
  ctx.fillStyle = '#cc0000';
  ctx.beginPath();
  ctx.moveTo(32, 60);
  ctx.bezierCurveTo(8, 50, 12, 24, 32, 6);
  ctx.bezierCurveTo(52, 24, 56, 50, 32, 60);
  ctx.fill();
  ctx.fillStyle = '#ff5500';
  ctx.beginPath();
  ctx.moveTo(32, 56);
  ctx.bezierCurveTo(16, 48, 18, 28, 32, 14);
  ctx.bezierCurveTo(46, 28, 48, 48, 32, 56);
  ctx.fill();
  ctx.fillStyle = '#ffcc00';
  ctx.beginPath();
  ctx.moveTo(32, 50);
  ctx.bezierCurveTo(24, 44, 26, 32, 32, 24);
  ctx.bezierCurveTo(38, 32, 40, 44, 32, 50);
  ctx.fill();
  // Cute eyes
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(28, 38, 3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(36, 38, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#000000';
  ctx.beginPath(); ctx.arc(28, 39, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(36, 39, 1.5, 0, Math.PI * 2); ctx.fill();
  _fireSpriteTex = new THREE.CanvasTexture(c);
  _fireSpriteTex.magFilter = THREE.NearestFilter;
  _fireSpriteTex.minFilter = THREE.NearestFilter;
  return _fireSpriteTex;
}

const FIRE_SPRITE_GEO = new THREE.PlaneGeometry(1.4, 1.4);
function _makeFireSprite() {
  const mat = new THREE.MeshBasicMaterial({
    map: _getFireSpriteTexture(),
    transparent: true,
    side: THREE.DoubleSide,
    alphaTest: 0.05,
    depthWrite: false,
  });
  const m = new THREE.Mesh(FIRE_SPRITE_GEO, mat);
  return m;
}

// 3D fire: emissive cone
const FIRE_3D_GEO = new THREE.ConeGeometry(0.55, 1.4, 6);
function _makeFire3D() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff5500,
    emissive: 0xff8800,
    emissiveIntensity: 1.5,
    roughness: 0.5,
    transparent: true,
    opacity: 0.95,
  });
  return new THREE.Mesh(FIRE_3D_GEO, mat);
}

// Trail fire: small additive sphere
const TRAIL_FIRE_GEO = new THREE.SphereGeometry(0.4, 8, 6);
function _makeTrailFire() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffaa22,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(TRAIL_FIRE_GEO, mat);
}

// ---- INIT ----
function _ensureInit() {
  if (_initialized) return;
  // 4 ladders at corners
  const half = ARENA - LADDER_INSET;
  const corners = [
    [-half, -half], [half, -half],
    [half, half], [-half, half],
  ];
  for (let i = 0; i < corners.length; i++) {
    const [x, z] = corners[i];
    const ladderMesh = _makeLadderMesh();
    ladderMesh.position.set(x, 0, z);
    scene.add(ladderMesh);
    _ladders.push({
      mesh: ladderMesh,
      cooldown: BARREL_SPAWN_INTERVAL * (i / 4) + 1.5,   // stagger initial spawns
      x, z,
    });
  }
  // 2 fires, catty-corner. Start at NE and SW, mid-radius.
  const r = ARENA * 0.55;
  const fireSpawns = [
    { x: r * 0.7, z: -r * 0.7 },
    { x: -r * 0.7, z: r * 0.7 },
  ];
  for (let i = 0; i < FIRE_COUNT; i++) {
    const sp = fireSpawns[i];
    const sprite2D = _makeFireSprite();
    const mesh3D = _makeFire3D();
    sprite2D.rotation.x = -Math.PI / 2;     // lay flat (will billboard later if needed)
    sprite2D.position.set(sp.x, 0.05, sp.z);
    mesh3D.position.set(sp.x, 0.7, sp.z);
    mesh3D.visible = false;
    scene.add(sprite2D);
    scene.add(mesh3D);
    // Random initial direction
    const ang = Math.random() * Math.PI * 2;
    _fires.push({
      sprite2D, mesh3D,
      state: '2D',
      stateTimer: FIRE_2D_DURATION + Math.random() * 1.5,
      trailTimer: 0,
      x: sp.x, z: sp.z,
      dirX: Math.cos(ang),
      dirZ: Math.sin(ang),
    });
  }
  _initialized = true;
}

// ---- BARREL SPAWN ----
function _spawnBarrel(ladderIdx) {
  const lad = _ladders[ladderIdx];
  const mesh = _makeBarrel3DMesh();
  mesh.position.set(lad.x, LADDER_HEIGHT - 0.5, lad.z);
  scene.add(mesh);
  // Roll direction — clockwise along the arena perimeter from this
  // ladder's corner to the next corner. Corners are ordered:
  //   0 SW(-,-)  →  east   (+X)  →  SE
  //   1 SE(+,-)  →  north  (+Z)  →  NE
  //   2 NE(+,+)  →  west   (-X)  →  NW
  //   3 NW(-,+)  →  south  (-Z)  →  SW
  // This keeps barrels hugging the outer boundary instead of cutting
  // diagonally across the arena.
  const PERIMETER_DIRS = [
    { dirX:  1, dirZ:  0 },   // SW → east
    { dirX:  0, dirZ:  1 },   // SE → north
    { dirX: -1, dirZ:  0 },   // NE → west
    { dirX:  0, dirZ: -1 },   // NW → south
  ];
  const dir = PERIMETER_DIRS[ladderIdx % 4];
  _barrels.push({
    mesh,
    phase: 'descend',     // 'descend' | 'roll'
    age: 0,
    x: lad.x, z: lad.z,
    dirX: dir.dirX, dirZ: dir.dirZ,
    is3D: true,
    ladderIdx,
  });
}

function _convertBarrelToRolling(b) {
  scene.remove(b.mesh);
  if (b.mesh.material) b.mesh.material.dispose();
  const sprite = _makeBarrel2DMesh();
  sprite.position.set(b.x, 0.05, b.z);
  scene.add(sprite);
  b.mesh = sprite;
  b.phase = 'roll';
  b.age = 0;       // reset age for roll lifetime
  b.is3D = false;
}

// ---- BARREL UPDATE ----
function _updateBarrels(dt) {
  for (let i = _barrels.length - 1; i >= 0; i--) {
    const b = _barrels[i];
    b.age += dt;
    if (b.phase === 'descend') {
      const t = Math.min(1, b.age / BARREL_DESCENT_TIME);
      const eased = t * t;        // ease-in (gravity-like)
      const y = (LADDER_HEIGHT - 0.5) - eased * (LADDER_HEIGHT - 0.5);
      b.mesh.position.y = y;
      // Spin the barrel as it falls
      b.mesh.rotation.x = b.age * 6;
      if (t >= 1) {
        _convertBarrelToRolling(b);
        // Lay tile at landing point
        _layTileAtBarrel(b);
      }
    } else {
      // Rolling phase
      b.x += b.dirX * BARREL_ROLL_SPEED * dt;
      b.z += b.dirZ * BARREL_ROLL_SPEED * dt;
      b.mesh.position.x = b.x;
      b.mesh.position.z = b.z;
      // Spin the sprite for a rolling effect
      b.mesh.rotation.z += dt * 5;
      _layTileAtBarrel(b);
      // Despawn after lifetime or when out of bounds
      if (b.age > BARREL_ROLL_LIFETIME
          || Math.abs(b.x) > ARENA || Math.abs(b.z) > ARENA) {
        scene.remove(b.mesh);
        if (b.mesh.material) b.mesh.material.dispose();
        _barrels.splice(i, 1);
      }
    }
  }
}

function _layTileAtBarrel(b) {
  const cellX = _snap(b.x);
  const cellZ = _snap(b.z);
  const key = _cellKey(cellX, cellZ);
  if (_coveredCells.has(key)) return;
  const ringIdx = _currentRing;
  // Ring membership check — only count cells in the active ring
  const ax = Math.abs(cellX);
  const az = Math.abs(cellZ);
  const inOuter = (ax < _ringOuterHalf(ringIdx) && az < _ringOuterHalf(ringIdx));
  const inInner = (ax < _ringInnerHalf(ringIdx) && az < _ringInnerHalf(ringIdx));
  if (!inOuter || inInner) return;
  // Wave-2 zone suppression
  if (_isInWave2() && isCellInBlockedZone(cellX, cellZ)) return;
  _coveredCells.add(key);
  _pendingDeliveries.push({
    cells: [{ x: cellX, z: cellZ }],
    tintHex: TILE_TINT,
    lethal: false,
  });
  try { hitBurst({ x: cellX, y: 0.3, z: cellZ }, TILE_TINT, 4); } catch (e) {}
}

// Pending tile-delivery queue — populated by barrels, drained by tickDeliveries.
let _pendingDeliveries = [];

// ---- FIRE UPDATE ----
function _updateFires(dt) {
  for (const f of _fires) {
    f.stateTimer -= dt;
    // Fire stays 2D ONLY — no 3D state, no trail fires. Per design,
    // the only hazard that should kill the player is fire-on-tile, not
    // a 3D variant or a separate trail.
    f.sprite2D.visible = true;
    f.mesh3D.visible = false;

    // Movement: try to stay on hazard tile cells. Each frame:
    //   1. Compute the candidate next position
    //   2. If it's still on a hazard cell (or there are no hazard
    //      cells laid yet), accept it
    //   3. Otherwise, rotate the heading 90° clockwise and try again
    //      up to 3 times. If still off-tile, accept the move (so the
    //      fire isn't trapped) but flag a turn so it heads back.
    const nx = f.x + f.dirX * FIRE_SPEED * dt;
    const nz = f.z + f.dirZ * FIRE_SPEED * dt;
    const nKey = _cellKey(nx, nz);
    const onTile = _coveredCells.has(nKey);
    if (onTile || _coveredCells.size === 0) {
      f.x = nx; f.z = nz;
    } else {
      // Try rotating heading by 90° to find a still-on-tile path.
      let turned = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const ang = Math.atan2(f.dirZ, f.dirX) + Math.PI / 2;
        f.dirX = Math.cos(ang);
        f.dirZ = Math.sin(ang);
        const tx = f.x + f.dirX * FIRE_SPEED * dt;
        const tz = f.z + f.dirZ * FIRE_SPEED * dt;
        if (_coveredCells.has(_cellKey(tx, tz))) {
          f.x = tx; f.z = tz;
          turned = true;
          break;
        }
      }
      if (!turned) {
        // No on-tile direction found — stay in place this tick.
        // Next frame the rotated heading might find one.
      }
    }

    // Bounce off arena edges (last-resort safety)
    const margin = 4.0;
    if (f.x > ARENA - margin) { f.x = ARENA - margin; f.dirX = -Math.abs(f.dirX); }
    if (f.x < -(ARENA - margin)) { f.x = -(ARENA - margin); f.dirX = Math.abs(f.dirX); }
    if (f.z > ARENA - margin) { f.z = ARENA - margin; f.dirZ = -Math.abs(f.dirZ); }
    if (f.z < -(ARENA - margin)) { f.z = -(ARENA - margin); f.dirZ = Math.abs(f.dirZ); }
    // Periodic small heading change so the fire wanders rather than
    // running on rails along one row of tiles.
    if (Math.random() < 0.005) {
      const ang = Math.atan2(f.dirZ, f.dirX) + (Math.random() - 0.5) * 0.8;
      f.dirX = Math.cos(ang);
      f.dirZ = Math.sin(ang);
    }

    // Update sprite position + animate
    f.sprite2D.position.x = f.x;
    f.sprite2D.position.z = f.z;
    f.sprite2D.position.y = 0.05 + Math.sin(S.timeElapsed * 5) * 0.02;
    _billboard(f.sprite2D);

    // Player damage check — instant kill on contact.
    const dx = player.pos.x - f.x;
    const dz = player.pos.z - f.z;
    if (dx * dx + dz * dz < FIRE_KILL_RADIUS * FIRE_KILL_RADIUS) {
      _killPlayer();
    }
  }
}

function _billboard(mesh) {
  // Cheap billboard: rotate Y so the mesh faces the camera. For the
  // floor sprites which are flat-on-ground, this orientation isn't
  // critical (player views from above), so this is mostly idempotent.
  if (!camera) return;
  const dx = camera.position.x - mesh.position.x;
  const dz = camera.position.z - mesh.position.z;
  mesh.rotation.y = Math.atan2(dx, dz);
}

function _spawnTrailFire(x, z) {
  const m = _makeTrailFire();
  m.position.set(x, 0.4, z);
  scene.add(m);
  _trailFires.push({ mesh: m, age: 0, x, z });
}

function _updateTrailFires(dt) {
  for (let i = _trailFires.length - 1; i >= 0; i--) {
    const t = _trailFires[i];
    t.age += dt;
    if (t.age > TRAIL_FIRE_LIFETIME) {
      scene.remove(t.mesh);
      if (t.mesh.material) t.mesh.material.dispose();
      _trailFires.splice(i, 1);
      continue;
    }
    // Pulse + flicker
    const phase = (t.age / TRAIL_FIRE_LIFETIME);
    t.mesh.material.opacity = (1 - phase) * (0.7 + Math.sin(t.age * 12) * 0.3);
    const s = 1.0 + Math.sin(t.age * 8) * 0.2;
    t.mesh.scale.set(s, s, s);
    // Player damage check
    const dx = player.pos.x - t.x;
    const dz = player.pos.z - t.z;
    if (dx * dx + dz * dz < TRAIL_FIRE_KILL_RADIUS * TRAIL_FIRE_KILL_RADIUS) {
      _killPlayer();
    }
  }
}

function _killPlayer() {
  // Instant kill — gameOver path. Guard against repeated calls in same
  // frame (multiple fires/trails could overlap the player position).
  if (S.hp <= 0) return;
  if (S.invulnTimer > 0) return;        // i-frames or overdrive bypass
  if (S.overdriveActive) return;        // overdrive grants invulnerability
  S.hp = 0;
  try { UI.damageFlash(); } catch (e) {}
  try { UI.toast('BURNED ALIVE', '#ff4400', 2200); } catch (e) {}
  // gameOver lives in main.js; setting hp=0 will be picked up by the
  // existing damage path on next frame. Belt and suspenders: also try
  // to invoke gameOver via a global if it's been hung off window.
  if (typeof window !== 'undefined' && typeof window.__forceGameOver === 'function') {
    window.__forceGameOver();
  }
}

// ---- LADDER COOLDOWN ----
function _updateLadders(dt) {
  for (const lad of _ladders) {
    lad.cooldown -= dt;
    if (lad.cooldown <= 0) {
      lad.cooldown = BARREL_SPAWN_INTERVAL;
      _spawnBarrel(_ladders.indexOf(lad));
    }
  }
}

// ---- TICK ----
export function tickDeliveries(dt) {
  // After despawnActive() is called (end of wave 3), the active
  // hazards are gone but the laid tiles persist. We exit early so
  // nothing re-spawns.
  if (_retired) return [];
  _ensureInit();
  _pendingDeliveries.length = 0;

  const ringIdx = _currentRing;
  const totalRings = _ringCount();
  if (ringIdx < totalRings) {
    _updateLadders(dt);
  }
  _updateBarrels(dt);
  _updateFires(dt);
  _updateTrailFires(dt);

  // Ring advance
  if (ringIdx < totalRings) {
    const total = _ringTotalCells(ringIdx);
    const covered = _ringCoveredCells(ringIdx);
    if (total > 0 && covered / total >= FILL_THRESHOLD) {
      if (ringIdx + 1 < totalRings) {
        _currentRing = ringIdx + 1;
      } else {
        _currentRing = ringIdx + 1;     // sentinel — beyond all rings
      }
    }
  }

  // Drain queue
  const out = _pendingDeliveries.slice();
  _pendingDeliveries.length = 0;
  return out;
}

// ---- API STUBS ----
export function getCellSize() { return CELL_SIZE; }
export function chooseSpawnLocation() { return null; }
export function spawnDelivery() { return null; }
export const managesOwnSpawns = true;

/**
 * Despawn the active hazard meshes (ladders, barrels, fires) without
 * clearing the laid hazard tiles. Used at end of wave 3 to retire the
 * active mechanic — player still has to navigate the purple tile
 * pattern but no new hazards spawn from this point forward.
 */
export function despawnActive() {
  for (const lad of _ladders) {
    if (lad.mesh && lad.mesh.parent) scene.remove(lad.mesh);
  }
  _ladders.length = 0;
  for (const b of _barrels) {
    if (b.mesh && b.mesh.parent) scene.remove(b.mesh);
    if (b.mesh && b.mesh.material) b.mesh.material.dispose();
  }
  _barrels.length = 0;
  for (const f of _fires) {
    if (f.sprite2D && f.sprite2D.parent) scene.remove(f.sprite2D);
    if (f.mesh3D && f.mesh3D.parent) scene.remove(f.mesh3D);
  }
  _fires.length = 0;
  for (const t of _trailFires) {
    if (t.mesh && t.mesh.parent) scene.remove(t.mesh);
    if (t.mesh && t.mesh.material) t.mesh.material.dispose();
  }
  _trailFires.length = 0;
  // Set flag so tickDeliveries doesn't tick the dead systems and
  // doesn't re-init on the next call.
  _retired = true;
}

let _retired = false;

export function cleanup() {
  if (!_initialized && !_retired) return;
  for (const lad of _ladders) {
    if (lad.mesh && lad.mesh.parent) scene.remove(lad.mesh);
  }
  _ladders.length = 0;
  for (const b of _barrels) {
    if (b.mesh && b.mesh.parent) scene.remove(b.mesh);
    if (b.mesh && b.mesh.material) b.mesh.material.dispose();
  }
  _barrels.length = 0;
  for (const f of _fires) {
    if (f.sprite2D && f.sprite2D.parent) scene.remove(f.sprite2D);
    if (f.mesh3D && f.mesh3D.parent) scene.remove(f.mesh3D);
  }
  _fires.length = 0;
  for (const t of _trailFires) {
    if (t.mesh && t.mesh.parent) scene.remove(t.mesh);
    if (t.mesh && t.mesh.material) t.mesh.material.dispose();
  }
  _trailFires.length = 0;
  _coveredCells.clear();
  _ringTotalCache.clear();
  _currentRing = 0;
  _initialized = false;
}
