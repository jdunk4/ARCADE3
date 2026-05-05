// ============================================================
// MAZE RENDERER — slide-fill maze visuals + collision.
//
// Visual style: black-and-white checker walls, dark floor that
// recolors to the chapter fill tint as the player slides over each
// cell. Mining gates are themed breakable blocks. Kill zones are
// static hazard meshes (rune / mine / ghost depending on chapter).
//
// Public API:
//   buildMaze(mazeData, scene, fillTint)
//   clearMaze(scene)
//   updateMazeFx(dt)
//   markCellVisited(col, row)        — flips a cell to filled
//   isCellVisited(col, row)
//   getCoverage()                    → { filled, total }
//   isKillZoneCell(col, row)
//   isBlockedByWall(x, z, dx, dz)    — single-step
//   segmentBlockedByMazeWall(x0,z0,x1,z1)
//   resolveMazeCollision(pos, radius)
//   damageMiningWallAt(x, z, dmg)
//   findMiningWallAt(x, z)
//   getMazeWallEntries()
//   getMazeBounds()                  → { x0, x1, z0, z1 }
//   isMazeActive()
// ============================================================

import * as THREE from 'three';
import {
  CELL_SIZE,
  WALL_N, WALL_E, WALL_S, WALL_W,
  cellToWorld, worldToCell,
} from './mazeGenerator.js';

let _mazeGroup = null;
let _mazeData = null;
let _wallEntries = [];
let _killZoneEntries = [];   // { col, row, kind, mesh }
let _fillTint = 0xff6a1a;
let _fillMatCache = new Map();
let _fillMeshes = null;       // 2D array (cols*rows) of decal meshes; null until built
let _coverageFilled = 0;
let _coverageTotal = 0;
let _killZoneCells = null;    // Set<idx> for fast lookup

const WALL_HEIGHT = 3.5;
const WALL_THICKNESS = 0.45;

// ---- WALL MATERIAL CACHE (black + white pattern) ----
let _wallMatBlack = null;
let _wallMatWhite = null;
let _floorMat = null;

function _getWallMatBlack() {
  if (_wallMatBlack) return _wallMatBlack;
  _wallMatBlack = new THREE.MeshStandardMaterial({
    color: 0x080808, emissive: 0x000000, roughness: 0.85, metalness: 0.0,
  });
  return _wallMatBlack;
}
function _getWallMatWhite() {
  if (_wallMatWhite) return _wallMatWhite;
  _wallMatWhite = new THREE.MeshStandardMaterial({
    color: 0xf2f2f2, emissive: 0x111111, roughness: 0.7, metalness: 0.0,
  });
  return _wallMatWhite;
}
function _getFloorMat() {
  if (_floorMat) return _floorMat;
  _floorMat = new THREE.MeshStandardMaterial({
    color: 0x111118, roughness: 0.92, metalness: 0.0,
  });
  return _floorMat;
}

// Mining gate uses fill-tint emissive so it pops against the B&W walls.
const _miningMatCache = new Map();
const _miningEdgeMatCache = new Map();
function _getMiningMat(tint) {
  let m = _miningMatCache.get(tint);
  if (!m) {
    const base = new THREE.Color(tint).lerp(new THREE.Color(0x222233), 0.35);
    m = new THREE.MeshStandardMaterial({
      color: base, emissive: tint, emissiveIntensity: 0.55,
      roughness: 0.55, metalness: 0.25,
    });
    _miningMatCache.set(tint, m);
  }
  return m;
}
function _getMiningEdgeMat(tint) {
  let m = _miningEdgeMatCache.get(tint);
  if (!m) {
    m = new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: 0.95 });
    _miningEdgeMatCache.set(tint, m);
  }
  return m;
}

// Fill-decal material (one per chapter tint).
function _getFillMat(tint) {
  let m = _fillMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint, emissive: tint, emissiveIntensity: 0.35,
      roughness: 0.7, metalness: 0.0,
      transparent: true, opacity: 0.0,    // fade in via opacity
    });
    _fillMatCache.set(tint, m);
  }
  return m;
}

// ---- KILL ZONE MESHES ----
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

  const { cols, rows, cells, miningWalls, killZones } = mazeData;
  const group = new THREE.Group();
  group.name = 'maze';

  group.add(new THREE.AmbientLight(0xffffff, 0.6));

  // Wall entries — alternate black/white per cell index for a checker
  // read on the maze. Mining gates override into themed mining mat.
  const miningByEdge = new Map();
  for (const m of (miningWalls || [])) {
    miningByEdge.set(`${m.col},${m.row},${m.dir}`, m);
  }
  const miningMat = _getMiningMat(fillTint);
  const miningEdgeMat = _getMiningEdgeMat(fillTint);
  const blackMat = _getWallMatBlack();
  const whiteMat = _getWallMatWhite();
  const floorMat = _getFloorMat();
  const fillMat = _getFillMat(fillTint);

  const wallGeoNS = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, WALL_THICKNESS);
  const wallGeoEW = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, CELL_SIZE);
  const floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.96, CELL_SIZE * 0.96);
  floorGeo.rotateX(-Math.PI / 2);
  const fillGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.94, CELL_SIZE * 0.94);
  fillGeo.rotateX(-Math.PI / 2);

  _wallEntries = [];
  _fillMeshes = new Array(cols * rows).fill(null);
  _coverageTotal = cols * rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      const { x, z } = cellToWorld(c, r, cols, rows);

      // Floor tile (dark base).
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.position.set(x, 0.01, z);
      floor.receiveShadow = true;
      group.add(floor);

      // Fill decal — built invisible, opacity bumps to 1 when visited.
      const fill = new THREE.Mesh(fillGeo, fillMat.clone());
      fill.position.set(x, 0.04, z);
      fill.visible = false;
      group.add(fill);
      _fillMeshes[r * cols + c] = fill;

      // Walls — alternating black/white pattern.
      const checker = ((c + r) & 1) === 0 ? blackMat : whiteMat;

      if (cell.walls & WALL_N) {
        const gate = miningByEdge.get(`${c},${r},N`);
        _addWall(group, wallGeoNS, x, WALL_HEIGHT / 2, z - CELL_SIZE / 2,
                 CELL_SIZE, WALL_THICKNESS, c, r, 'N', gate, checker, miningMat, miningEdgeMat);
      }
      if (cell.walls & WALL_W) {
        const gate = miningByEdge.get(`${c},${r},W`);
        _addWall(group, wallGeoEW, x - CELL_SIZE / 2, WALL_HEIGHT / 2, z,
                 WALL_THICKNESS, CELL_SIZE, c, r, 'W', gate, checker, miningMat, miningEdgeMat);
      }
      if (r === rows - 1 && (cell.walls & WALL_S)) {
        _addWall(group, wallGeoNS, x, WALL_HEIGHT / 2, z + CELL_SIZE / 2,
                 CELL_SIZE, WALL_THICKNESS, c, r, 'S', null, checker, miningMat, miningEdgeMat);
      }
      if (c === cols - 1 && (cell.walls & WALL_E)) {
        _addWall(group, wallGeoEW, x + CELL_SIZE / 2, WALL_HEIGHT / 2, z,
                 WALL_THICKNESS, CELL_SIZE, c, r, 'E', null, checker, miningMat, miningEdgeMat);
      }
    }
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

function _addWall(group, geo, x, y, z, w, h, col, row, dir, gateRef,
                  baseMat, miningMat, miningEdgeMat) {
  const isMining = !!gateRef;
  const useMat = isMining ? miningMat.clone() : baseMat;
  const mesh = new THREE.Mesh(geo, useMat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;

  if (isMining) {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), miningEdgeMat);
    mesh.add(edges);
  }
  group.add(mesh);

  const entry = {
    mesh, x, z, w, h,
    isMining, gateRef,
    cellCol: col, cellRow: row, dir,
    hitFlash: 0,
  };
  if (isMining && gateRef) gateRef._entry = entry;
  _wallEntries.push(entry);
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
  // Mining-wall hit-flash decay.
  for (const e of _wallEntries) {
    if (!e.isMining || e.hitFlash <= 0) continue;
    e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
    if (e.mesh && e.mesh.material) {
      e.mesh.material.emissiveIntensity = 0.55 + e.hitFlash * 1.5;
    }
  }
  // Kill-zone bob + spin.
  for (const kz of _killZoneEntries) {
    if (!kz.mesh) continue;
    const phase = kz.mesh.userData.bobPhase || 0;
    kz.mesh.position.y = 1.4 + Math.sin(time * 2 + phase) * 0.25;
    kz.mesh.rotation.y = time * 1.5 + phase;
  }
  // Fade in newly-marked fills.
  if (_fillMeshes) {
    for (let i = 0; i < _fillMeshes.length; i++) {
      const m = _fillMeshes[i];
      if (!m || !m.visible) continue;
      const mat = m.material;
      if (mat.opacity < 1) {
        mat.opacity = Math.min(1, mat.opacity + dt * 6);
      }
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
  m.material.opacity = 0;            // tickFx fades it in
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
  return { filled: _coverageFilled, total: _coverageTotal };
}

// ============================================================
// KILL ZONES
// ============================================================
export function isKillZoneCell(col, row) {
  if (!_mazeData || !_killZoneCells) return false;
  return _killZoneCells.has(row * _mazeData.cols + col);
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
// MINING WALLS
// ============================================================
export function damageMiningWallAt(x, z, dmg) {
  if (!_mazeData) return { hit: false };
  let target = null;
  let bestDist = Infinity;
  for (const e of _wallEntries) {
    if (!e.isMining || !e.gateRef || e.gateRef.broken) continue;
    const hx = e.w / 2, hz = e.h / 2;
    if (x < e.x - hx - 0.4 || x > e.x + hx + 0.4) continue;
    if (z < e.z - hz - 0.4 || z > e.z + hz + 0.4) continue;
    const ddx = x - e.x, ddz = z - e.z;
    const d = ddx * ddx + ddz * ddz;
    if (d < bestDist) { bestDist = d; target = e; }
  }
  if (!target) return { hit: false };

  const gate = target.gateRef;
  gate.hp = Math.max(0, gate.hp - dmg);
  target.hitFlash = 1;

  if (gate.hp <= 0 && !gate.broken) {
    gate.broken = true;
    const { cells, cols } = _mazeData;
    const c = gate.col, r = gate.row;
    if (gate.dir === 'W') {
      cells[r * cols + c].walls &= ~WALL_W;
      if (c - 1 >= 0) cells[r * cols + (c - 1)].walls &= ~WALL_E;
    } else {
      cells[r * cols + c].walls &= ~WALL_N;
      if (r - 1 >= 0) cells[(r - 1) * cols + c].walls &= ~WALL_S;
    }
    if (target.mesh) {
      if (target.mesh.parent) target.mesh.parent.remove(target.mesh);
      if (target.mesh.geometry) target.mesh.geometry.dispose();
      if (target.mesh.material && target.mesh.material.dispose) target.mesh.material.dispose();
    }
    const idx = _wallEntries.indexOf(target);
    if (idx >= 0) _wallEntries.splice(idx, 1);
    return {
      hit: true, destroyed: true,
      color: _fillTint,
      x: target.x, z: target.z,
    };
  }

  return {
    hit: true, destroyed: false,
    color: _fillTint,
    x: target.x, z: target.z,
  };
}

export function findMiningWallAt(x, z) {
  if (!_mazeData) return null;
  for (const e of _wallEntries) {
    if (!e.isMining || !e.gateRef || e.gateRef.broken) continue;
    const hx = e.w / 2, hz = e.h / 2;
    if (x >= e.x - hx && x <= e.x + hx && z >= e.z - hz && z <= e.z + hz) return e;
  }
  return null;
}

export function getMazeWallEntries() { return _wallEntries.slice(); }

// ============================================================
// HELPERS
// ============================================================
export function getMazeBounds() {
  if (!_mazeData) return null;
  const { cols, rows } = _mazeData;
  const halfW = (cols * CELL_SIZE) / 2;
  const halfH = (rows * CELL_SIZE) / 2;
  return { x0: -halfW, x1: halfW, z0: -halfH, z1: halfH };
}

export function getMazeData() { return _mazeData; }
export function isMazeActive() { return !!_mazeData; }
