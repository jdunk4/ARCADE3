// ============================================================
// MAZE RENDERER — slide-fill maze visuals + collision.
//
// Look (matches the reference image):
//   • Cream floor; per-cell decals fade in with the chapter fill
//     color when visited.
//   • Walls are rendered as rows of small alternating black/white
//     cubes (single InstancedMesh — one draw call per maze).
//   • Mining BLOCKS are big black cubes that fill a cell. Slide
//     stops at them; player must shoot to break.
//   • Kill zones are static themed hazards (rune / mine / ghost).
//
// Public API:
//   buildMaze(mazeData, scene, fillTint)
//   clearMaze(scene)
//   updateMazeFx(dt)
//   markCellVisited(col, row)
//   isCellVisited(col, row)
//   getCoverage()
//   isKillZoneCell(col, row)
//   isCellBlocked(col, row)         — true when the cell holds an
//                                     un-broken mining block
//   isBlockedByWall(x, z, dx, dz)
//   segmentBlockedByMazeWall(x0,z0,x1,z1)
//   resolveMazeCollision(pos, radius)
//   damageMiningBlockAt(x, z, dmg)  — alias kept as
//                                     damageMiningWallAt for
//                                     backward compatibility
//   findFirstMiningBlockInDir(col, row, dx, dz)
//   getMazeWallEntries()
//   getMazeBounds()
//   getMazeData()
//   isMazeActive()
// ============================================================

import * as THREE from 'three';
import {
  CELL_SIZE,
  WALL_N, WALL_E, WALL_S, WALL_W,
  cellToWorld,
} from './mazeGenerator.js';

let _mazeGroup = null;
let _mazeData = null;
let _wallEntries = [];          // for assemble/dissolve animation snapshot
let _miningBlockEntries = [];   // [{ col, row, ref, mesh }]
let _miningCellSet = null;      // Set<idx> for fast cell lookup
let _killZoneEntries = [];
let _killZoneCells = null;
let _fillMeshes = null;
let _coverageFilled = 0;
let _coverageTotal = 0;
let _fillTint = 0xff6a1a;

const WALL_HEIGHT = 1.6;        // shorter — top-down view doesn't need tall walls
const WALL_THICKNESS = 0.55;
const WALL_CUBE_SIZE = 0.65;    // each segment cube edge
const CUBES_PER_WALL = 7;       // along a 5u edge

// ---- CACHED MATS / GEO ----
let _floorMat = null;
function _getFloorMat() {
  if (_floorMat) return _floorMat;
  _floorMat = new THREE.MeshStandardMaterial({
    color: 0xf2ede0,            // cream
    roughness: 0.85,
    metalness: 0.0,
  });
  return _floorMat;
}

const _fillMatCache = new Map();
function _getFillMat(tint) {
  let m = _fillMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.45,
      roughness: 0.65,
      metalness: 0.0,
      transparent: true,
      opacity: 0.0,
    });
    _fillMatCache.set(tint, m);
  }
  return m;
}

// Wall cube materials (shared by every maze's walls — one cache).
let _wallMatBlack = null, _wallMatWhite = null;
function _getWallMatBlack() {
  if (_wallMatBlack) return _wallMatBlack;
  _wallMatBlack = new THREE.MeshStandardMaterial({
    color: 0x101010, roughness: 0.7, metalness: 0.0,
  });
  return _wallMatBlack;
}
function _getWallMatWhite() {
  if (_wallMatWhite) return _wallMatWhite;
  _wallMatWhite = new THREE.MeshStandardMaterial({
    color: 0xfafafa, roughness: 0.6, metalness: 0.0,
  });
  return _wallMatWhite;
}

// Mining block (cell-fill black cube). Each instance gets its own
// material clone for hit-flash.
function _makeMiningMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x080808,
    emissive: 0x000000,
    roughness: 0.55,
    metalness: 0.15,
  });
}

// Kill-zone meshes
const _kzGeo = {
  rune: new THREE.OctahedronGeometry(1.2, 0),
  mine: new THREE.SphereGeometry(1.0, 12, 8),
  ghost: new THREE.SphereGeometry(1.1, 12, 8),
};
const _kzMatCache = {};
function _getKzMat(kind) {
  if (_kzMatCache[kind]) return _kzMatCache[kind];
  const color = kind === 'rune' ? 0xff2e4d : kind === 'mine' ? 0xffaa00 : 0x88ccff;
  _kzMatCache[kind] = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.9,
    roughness: 0.4, metalness: 0.1,
  });
  return _kzMatCache[kind];
}

// ============================================================
// BUILD
// ============================================================
export function buildMaze(mazeData, scene, fillTint) {
  clearMaze(scene);
  _mazeData = mazeData;
  _fillTint = fillTint;
  _coverageFilled = 0;

  const { cols, rows, cells, miningBlocks, killZones } = mazeData;
  const group = new THREE.Group();
  group.name = 'maze';

  // Bright ambient + mild directional so the cream floor reads.
  group.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 0.4);
  dir.position.set(20, 50, 30);
  group.add(dir);

  // ---- FLOOR + FILL DECALS ----
  const floorMat = _getFloorMat();
  const fillMat = _getFillMat(fillTint);
  const floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.98, CELL_SIZE * 0.98);
  floorGeo.rotateX(-Math.PI / 2);
  const fillGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.95, CELL_SIZE * 0.95);
  fillGeo.rotateX(-Math.PI / 2);

  _fillMeshes = new Array(cols * rows).fill(null);
  _coverageTotal = cols * rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const { x, z } = cellToWorld(c, r, cols, rows);
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.position.set(x, 0.01, z);
      floor.receiveShadow = true;
      group.add(floor);

      const fill = new THREE.Mesh(fillGeo, fillMat.clone());
      fill.position.set(x, 0.04, z);
      fill.visible = false;
      group.add(fill);
      _fillMeshes[r * cols + c] = fill;
    }
  }

  // ---- WALLS ----
  // Collect all wall edges first, then emit one InstancedMesh of
  // black cubes + one of white cubes to keep draw calls minimal.
  // _wallEntries also stores per-edge AABBs so the assemble/dissolve
  // animations can target them.
  _wallEntries = [];
  const blackCubes = [];     // [Matrix4]
  const whiteCubes = [];

  const tmpScale = new THREE.Vector3(WALL_CUBE_SIZE, WALL_HEIGHT, WALL_CUBE_SIZE);
  const tmpQuat = new THREE.Quaternion();
  const _pushCubes = (xMid, zMid, axis /* 'NS' or 'EW' */, wallSeed) => {
    // axis 'NS' = wall extends along X (north/south wall, on the
    // top or bottom of a cell). axis 'EW' = wall extends along Z
    // (east/west wall).
    const half = (CUBES_PER_WALL - 1) * 0.5;
    for (let i = 0; i < CUBES_PER_WALL; i++) {
      const t = (i - half) * (CELL_SIZE / CUBES_PER_WALL);
      const px = axis === 'NS' ? xMid + t : xMid;
      const pz = axis === 'NS' ? zMid : zMid + t;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(px, WALL_HEIGHT / 2, pz),
        tmpQuat,
        tmpScale,
      );
      // Alternate B/W along the wall, with the wall's seed offsetting
      // the start so adjacent walls don't visibly line up.
      if (((i + wallSeed) & 1) === 0) blackCubes.push(m);
      else whiteCubes.push(m);
    }
  };

  let wallSeed = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      const { x, z } = cellToWorld(c, r, cols, rows);
      if (cell.walls & WALL_N) {
        _pushCubes(x, z - CELL_SIZE / 2, 'NS', wallSeed++);
        _wallEntries.push({ x, z: z - CELL_SIZE / 2, w: CELL_SIZE, h: WALL_THICKNESS });
      }
      if (cell.walls & WALL_W) {
        _pushCubes(x - CELL_SIZE / 2, z, 'EW', wallSeed++);
        _wallEntries.push({ x: x - CELL_SIZE / 2, z, w: WALL_THICKNESS, h: CELL_SIZE });
      }
      if (r === rows - 1 && (cell.walls & WALL_S)) {
        _pushCubes(x, z + CELL_SIZE / 2, 'NS', wallSeed++);
        _wallEntries.push({ x, z: z + CELL_SIZE / 2, w: CELL_SIZE, h: WALL_THICKNESS });
      }
      if (c === cols - 1 && (cell.walls & WALL_E)) {
        _pushCubes(x + CELL_SIZE / 2, z, 'EW', wallSeed++);
        _wallEntries.push({ x: x + CELL_SIZE / 2, z, w: WALL_THICKNESS, h: CELL_SIZE });
      }
    }
  }

  if (blackCubes.length > 0) {
    const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
    const blackMesh = new THREE.InstancedMesh(cubeGeo, _getWallMatBlack(), blackCubes.length);
    for (let i = 0; i < blackCubes.length; i++) blackMesh.setMatrixAt(i, blackCubes[i]);
    blackMesh.instanceMatrix.needsUpdate = true;
    blackMesh.castShadow = true;
    group.add(blackMesh);
    // Save the InstancedMesh as the synthetic "mesh" for every
    // wall entry so endlessAssemble's traverse can fade them.
    for (const e of _wallEntries) e.mesh = blackMesh;
  }
  if (whiteCubes.length > 0) {
    const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
    const whiteMesh = new THREE.InstancedMesh(cubeGeo, _getWallMatWhite(), whiteCubes.length);
    for (let i = 0; i < whiteCubes.length; i++) whiteMesh.setMatrixAt(i, whiteCubes[i]);
    whiteMesh.instanceMatrix.needsUpdate = true;
    whiteMesh.castShadow = true;
    group.add(whiteMesh);
  }

  // ---- MINING BLOCKS (cell-based) ----
  _miningBlockEntries = [];
  _miningCellSet = new Set();
  const blockGeo = new THREE.BoxGeometry(CELL_SIZE * 0.78, CELL_SIZE * 0.55, CELL_SIZE * 0.78);
  for (const mb of (miningBlocks || [])) {
    const { x, z } = cellToWorld(mb.col, mb.row, cols, rows);
    const mat = _makeMiningMat();
    const mesh = new THREE.Mesh(blockGeo, mat);
    mesh.position.set(x, CELL_SIZE * 0.55 / 2 + 0.02, z);
    mesh.castShadow = true;
    // Bright outline so the black-on-cream block reads at glance.
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(blockGeo),
      new THREE.LineBasicMaterial({ color: fillTint, transparent: true, opacity: 0.85 }),
    );
    mesh.add(edges);
    group.add(mesh);
    const entry = { col: mb.col, row: mb.row, ref: mb, mesh, hitFlash: 0 };
    mb._entry = entry;
    _miningBlockEntries.push(entry);
    _miningCellSet.add(mb.row * cols + mb.col);
  }

  // ---- KILL ZONES ----
  _killZoneEntries = [];
  _killZoneCells = new Set();
  for (const kz of (killZones || [])) {
    const { x, z } = cellToWorld(kz.col, kz.row, cols, rows);
    const geo = _kzGeo[kz.kind] || _kzGeo.rune;
    const mat = _getKzMat(kz.kind);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 1.4, z);
    mesh.userData.bobPhase = Math.random() * Math.PI * 2;
    group.add(mesh);
    _killZoneEntries.push({ col: kz.col, row: kz.row, kind: kz.kind, mesh });
    _killZoneCells.add(kz.row * cols + kz.col);
  }

  scene.add(group);
  _mazeGroup = group;
  return group;
}

// ============================================================
// CLEAR
// ============================================================
export function clearMaze(scene) {
  if (_mazeGroup) {
    scene.remove(_mazeGroup);
    _mazeGroup.traverse((child) => {
      if (child.isMesh && child.geometry) child.geometry.dispose();
    });
    _mazeGroup = null;
  }
  _wallEntries = [];
  _miningBlockEntries = [];
  _miningCellSet = null;
  _killZoneEntries = [];
  _killZoneCells = null;
  _fillMeshes = null;
  _mazeData = null;
  _coverageFilled = 0;
  _coverageTotal = 0;
}

// ============================================================
// PER-FRAME FX
// ============================================================
export function updateMazeFx(dt) {
  const time = performance.now() * 0.001;
  // Mining-block hit-flash decay.
  for (const e of _miningBlockEntries) {
    if (e.hitFlash <= 0) continue;
    e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
    if (e.mesh && e.mesh.material) {
      e.mesh.material.emissive.setRGB(e.hitFlash * 0.4, e.hitFlash * 0.4, e.hitFlash * 0.4);
    }
  }
  // Kill-zone bob + spin.
  for (const kz of _killZoneEntries) {
    if (!kz.mesh) continue;
    const phase = kz.mesh.userData.bobPhase || 0;
    kz.mesh.position.y = 1.4 + Math.sin(time * 2 + phase) * 0.25;
    kz.mesh.rotation.y = time * 1.5 + phase;
  }
  if (_fillMeshes) {
    for (let i = 0; i < _fillMeshes.length; i++) {
      const m = _fillMeshes[i];
      if (!m || !m.visible) continue;
      const mat = m.material;
      if (mat.opacity < 1) mat.opacity = Math.min(1, mat.opacity + dt * 6);
    }
  }
}

// ============================================================
// COVERAGE
// ============================================================
export function markCellVisited(col, row) {
  if (!_mazeData || !_fillMeshes) return false;
  const { cols, rows } = _mazeData;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
  const i = row * cols + col;
  const m = _fillMeshes[i];
  if (!m || m.visible) return false;
  m.visible = true;
  m.material.opacity = 0;
  _coverageFilled++;
  return true;
}

export function isCellVisited(col, row) {
  if (!_mazeData || !_fillMeshes) return false;
  const { cols, rows } = _mazeData;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
  const m = _fillMeshes[row * cols + col];
  return !!(m && m.visible);
}

export function getCoverage() {
  // Mining-block cells don't count toward coverage (the player can't
  // visit them while the block stands). They're factored into the
  // total only AFTER they break — visited then.
  let blockedTotal = 0;
  for (const e of _miningBlockEntries) {
    if (!e.ref || !e.ref.broken) blockedTotal++;
  }
  return { filled: _coverageFilled, total: Math.max(1, _coverageTotal - blockedTotal) };
}

// ============================================================
// CELL QUERIES
// ============================================================
export function isKillZoneCell(col, row) {
  if (!_mazeData || !_killZoneCells) return false;
  return _killZoneCells.has(row * _mazeData.cols + col);
}

export function isCellBlocked(col, row) {
  if (!_mazeData || !_miningCellSet) return false;
  if (!_miningCellSet.has(row * _mazeData.cols + col)) return false;
  // Look up the actual entry to check broken state.
  for (const e of _miningBlockEntries) {
    if (e.col === col && e.row === row) return !(e.ref && e.ref.broken);
  }
  return false;
}

/**
 * Walk from (col,row) in (dx,dz) until either a wall is hit or a
 * mining block cell is reached. Returns the block entry if a block
 * is the first impassable thing in that direction (so directional
 * fire can damage it), or null otherwise.
 */
export function findFirstMiningBlockInDir(col, row, dx, dz) {
  if (!_mazeData) return null;
  const { cols, rows, cells } = _mazeData;
  let c = col, r = row;
  for (let step = 0; step < Math.max(cols, rows); step++) {
    const cell = cells[r * cols + c];
    const flag =
      dx > 0 ? WALL_E :
      dx < 0 ? WALL_W :
      dz > 0 ? WALL_S : WALL_N;
    if (cell.walls & flag) return null;
    const nc = c + dx, nr = r + dz;
    if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return null;
    if (_miningCellSet && _miningCellSet.has(nr * cols + nc)) {
      for (const e of _miningBlockEntries) {
        if (e.col === nc && e.row === nr && !(e.ref && e.ref.broken)) return e;
      }
      return null;
    }
    c = nc; r = nr;
  }
  return null;
}

// ============================================================
// COLLISION
// ============================================================

export function isBlockedByWall(x, z, dx, dz) {
  if (!_mazeData) return false;
  const { cols, rows, cells } = _mazeData;
  const mazeW = cols * CELL_SIZE;
  const mazeH = rows * CELL_SIZE;
  const ox = -mazeW / 2;
  const oz = -mazeH / 2;
  const newX = x + dx;
  const newZ = z + dz;
  const col = Math.floor((x - ox) / CELL_SIZE);
  const row = Math.floor((z - oz) / CELL_SIZE);
  const newCol = Math.floor((newX - ox) / CELL_SIZE);
  const newRow = Math.floor((newZ - oz) / CELL_SIZE);
  if (newCol < 0 || newCol >= cols || newRow < 0 || newRow >= rows) return true;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
  const cell = cells[row * cols + col];
  if (newCol > col && (cell.walls & WALL_E)) return true;
  if (newCol < col && (cell.walls & WALL_W)) return true;
  if (newRow > row && (cell.walls & WALL_S)) return true;
  if (newRow < row && (cell.walls & WALL_N)) return true;
  // Mining blocks block movement at the cell boundary too.
  if ((newCol !== col || newRow !== row) && isCellBlocked(newCol, newRow)) return true;
  return false;
}

export function segmentBlockedByMazeWall(x0, z0, x1, z1) {
  if (!_mazeData) return false;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return false;
  const stride = CELL_SIZE * 0.33;
  const steps = Math.max(1, Math.ceil(len / stride));
  let prevX = x0, prevZ = z0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + dx * t;
    const cz = z0 + dz * t;
    if (isBlockedByWall(prevX, prevZ, cx - prevX, cz - prevZ)) return true;
    prevX = cx; prevZ = cz;
  }
  return false;
}

export function resolveMazeCollision(pos, radius) {
  if (!_mazeData) return;
  const { cols, rows, cells } = _mazeData;
  const mazeW = cols * CELL_SIZE;
  const mazeH = rows * CELL_SIZE;
  const ox = -mazeW / 2;
  const oz = -mazeH / 2;
  const col = Math.max(0, Math.min(cols - 1, Math.floor((pos.x - ox) / CELL_SIZE)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor((pos.z - oz) / CELL_SIZE)));
  const cell = cells[row * cols + col];
  const cx = ox + (col + 0.5) * CELL_SIZE;
  const cz = oz + (row + 0.5) * CELL_SIZE;
  const halfCell = CELL_SIZE / 2;
  const halfThick = WALL_THICKNESS / 2;

  const pushOut = (ax, az, hx, hz) => {
    const closestX = Math.max(ax - hx, Math.min(pos.x, ax + hx));
    const closestZ = Math.max(az - hz, Math.min(pos.z, az + hz));
    const ddx = pos.x - closestX;
    const ddz = pos.z - closestZ;
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 < radius * radius && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      const overlap = radius - d;
      pos.x += (ddx / d) * overlap;
      pos.z += (ddz / d) * overlap;
    } else if (d2 <= 1e-8) {
      if (Math.abs(pos.x - ax) > Math.abs(pos.z - az)) {
        pos.x += (pos.x >= ax ? 1 : -1) * (hx + radius);
      } else {
        pos.z += (pos.z >= az ? 1 : -1) * (hz + radius);
      }
    }
  };

  if (cell.walls & WALL_N) pushOut(cx, cz - halfCell, halfCell, halfThick);
  if (cell.walls & WALL_S) pushOut(cx, cz + halfCell, halfCell, halfThick);
  if (cell.walls & WALL_W) pushOut(cx - halfCell, cz, halfThick, halfCell);
  if (cell.walls & WALL_E) pushOut(cx + halfCell, cz, halfThick, halfCell);
}

// ============================================================
// MINING BLOCK DAMAGE
// ============================================================

export function damageMiningBlockAt(x, z, dmg) {
  if (!_mazeData) return { hit: false };
  const { cols, rows } = _mazeData;
  const mazeW = cols * CELL_SIZE;
  const mazeH = rows * CELL_SIZE;
  const ox = -mazeW / 2;
  const oz = -mazeH / 2;
  const col = Math.floor((x - ox) / CELL_SIZE);
  const row = Math.floor((z - oz) / CELL_SIZE);
  if (col < 0 || col >= cols || row < 0 || row >= rows) return { hit: false };
  if (!_miningCellSet || !_miningCellSet.has(row * cols + col)) return { hit: false };
  for (const e of _miningBlockEntries) {
    if (e.col === col && e.row === row && e.ref && !e.ref.broken) {
      return _applyMiningBlockDamage(e, dmg);
    }
  }
  return { hit: false };
}

/** Same as damageMiningBlockAt but scoped to a known block entry —
 * used by directional-fire so we don't miss when the bullet path
 * lands a hair off the cell center. */
export function damageMiningBlockEntry(entry, dmg) {
  if (!entry || !entry.ref || entry.ref.broken) return { hit: false };
  return _applyMiningBlockDamage(entry, dmg);
}

function _applyMiningBlockDamage(entry, dmg) {
  const ref = entry.ref;
  ref.hp = Math.max(0, ref.hp - dmg);
  entry.hitFlash = 1;
  if (ref.hp <= 0 && !ref.broken) {
    ref.broken = true;
    if (entry.mesh) {
      if (entry.mesh.parent) entry.mesh.parent.remove(entry.mesh);
      if (entry.mesh.geometry) entry.mesh.geometry.dispose();
      if (entry.mesh.material && entry.mesh.material.dispose) entry.mesh.material.dispose();
    }
    if (_miningCellSet) _miningCellSet.delete(entry.row * _mazeData.cols + entry.col);
    const idx = _miningBlockEntries.indexOf(entry);
    if (idx >= 0) _miningBlockEntries.splice(idx, 1);
    return { hit: true, destroyed: true, color: _fillTint, x: entry.col, z: entry.row };
  }
  return { hit: true, destroyed: false, color: _fillTint };
}

// Backward-compat shim — main.js + stratagemTurret still reference
// the old name. Maps to the new cell-based API.
export const damageMiningWallAt = damageMiningBlockAt;

// ============================================================
// HELPERS
// ============================================================
export function getMazeWallEntries() { return _wallEntries.slice(); }
export function getMazeBounds() {
  if (!_mazeData) return null;
  const { cols, rows } = _mazeData;
  const halfW = (cols * CELL_SIZE) / 2;
  const halfH = (rows * CELL_SIZE) / 2;
  return { x0: -halfW, x1: halfW, z0: -halfH, z1: halfH };
}
export function getMazeData() { return _mazeData; }
export function isMazeActive() { return !!_mazeData; }
