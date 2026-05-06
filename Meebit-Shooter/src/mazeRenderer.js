// ============================================================
// MAZE RENDERER — slide-fill maze visuals + collision.
//
// Cell-based walls. Each cell is either 'floor' (cream tile, fills
// orange when visited) or 'wall' (occupies the whole tile as a
// cluster of small alternating black/white cubes — the "row of
// dice" look from the reference, applied to a square instead of
// a strip).
//
// Public API:
//   buildMaze(mazeData, scene, fillTint)
//   clearMaze(scene)
//   updateMazeFx(dt)
//   markCellVisited(col, row)
//   isCellVisited(col, row)
//   getCoverage()                       — visited / total-walkable
//   collectGlyphAt(col, row)            — pickup; returns true on collect
//   getGlyphsRemaining()
//   getGlyphsTotal()
//   isKillZoneCell(col, row)
//   isCellBlocked(col, row)             — un-broken mining block
//   isBlockedByWall(x, z, dx, dz)
//   segmentBlockedByMazeWall(x0,z0,x1,z1)
//   resolveMazeCollision(pos, radius)
//   damageMiningBlockAt(x, z, dmg)      (alias damageMiningWallAt)
//   getMazeWallEntries()
//   getMazeBounds()
//   getMazeData()
//   isMazeActive()
// ============================================================

import * as THREE from 'three';
import { CELL_SIZE, cellToWorld } from './mazeGenerator.js';

let _mazeGroup = null;
let _mazeData = null;

let _wallEntries = [];          // assemble/dissolve animation snapshot
let _miningBlockEntries = [];
let _miningCellSet = null;
let _killZoneEntries = [];
let _killZoneCells = null;
let _glyphEntries = [];         // [{ col, row, mesh, collected, baseY, phase }]
let _glyphsCollected = 0;
let _decorEnemyEntries = [];    // [{ col, row, mesh, destroyed, phase }]

let _fillMeshes = null;
let _coverageFilled = 0;
let _coverageTotal = 0;
let _fillTint = 0xff6a1a;

const WALL_HEIGHT = 1.6;
const WALL_CUBE_SIZE = 0.78;
// 5x5 grid of small cubes per wall tile. CELL_SIZE / 5 = 1u stride
// gives a clean checker; the cube is slightly under-sized so the
// individual cubes read as discrete blocks.
const CUBES_PER_TILE_SIDE = 5;

const GLYPH_CHARS = 'アイウエオカキクケコサシスセソ';

// ---- CACHED MATERIALS ----
let _floorMat = null;
function _getFloorMat() {
  if (_floorMat) return _floorMat;
  _floorMat = new THREE.MeshStandardMaterial({
    color: 0xf2ede0, roughness: 0.85, metalness: 0.0,
  });
  return _floorMat;
}

const _fillMatCache = new Map();
function _getFillMat(tint) {
  let m = _fillMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint, emissive: tint, emissiveIntensity: 0.45,
      roughness: 0.65, metalness: 0.0,
      transparent: true, opacity: 0.0,
    });
    _fillMatCache.set(tint, m);
  }
  return m;
}

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

function _makeMiningMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x080808, emissive: 0x000000,
    roughness: 0.55, metalness: 0.15,
  });
}

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

// ---- GLYPH TEXTURE CACHE ----
const _glyphTexCache = new Map();
function _makeGlyphTexture(char, color) {
  const key = char + color;
  if (_glyphTexCache.has(key)) return _glyphTexCache.get(key);
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${size - 8}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fillStyle = color;
  ctx.fillText(char, size / 2, size / 2);
  ctx.fillText(char, size / 2, size / 2);
  ctx.shadowBlur = 4;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(char, size / 2, size / 2);
  const tex = new THREE.CanvasTexture(canvas);
  _glyphTexCache.set(key, tex);
  return tex;
}

// ============================================================
// BUILD
// ============================================================
export function buildMaze(mazeData, scene, fillTint) {
  clearMaze(scene);
  _mazeData = mazeData;
  _fillTint = fillTint;
  _coverageFilled = 0;
  _glyphsCollected = 0;

  const { cols, rows, cells, miningBlocks, killZones, glyphs, decorEnemies } = mazeData;
  const group = new THREE.Group();
  group.name = 'maze';

  group.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 0.4);
  dir.position.set(20, 50, 30);
  group.add(dir);

  const floorMat = _getFloorMat();
  const fillMat = _getFillMat(fillTint);
  const tintHex = '#' + new THREE.Color(fillTint).getHexString();
  const floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.98, CELL_SIZE * 0.98);
  floorGeo.rotateX(-Math.PI / 2);
  const fillGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.95, CELL_SIZE * 0.95);
  fillGeo.rotateX(-Math.PI / 2);

  _fillMeshes = new Array(cols * rows).fill(null);
  _coverageTotal = 0;

  // ---- FLOOR + WALL CUBES ----
  // Walls are emitted into two InstancedMesh pools (black + white).
  // Each wall cell contributes CUBES_PER_TILE_SIDE × CUBES_PER_TILE_SIDE
  // cubes alternating in a checker pattern.
  const blackCubes = [];
  const whiteCubes = [];
  const cubeStride = CELL_SIZE / CUBES_PER_TILE_SIDE;
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3(WALL_CUBE_SIZE, WALL_HEIGHT, WALL_CUBE_SIZE);
  _wallEntries = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      const { x, z } = cellToWorld(c, r, cols, rows);

      if (cell.kind === 'wall') {
        const halfSide = (CUBES_PER_TILE_SIDE - 1) / 2;
        for (let iy = 0; iy < CUBES_PER_TILE_SIDE; iy++) {
          for (let ix = 0; ix < CUBES_PER_TILE_SIDE; ix++) {
            const px = x + (ix - halfSide) * cubeStride;
            const pz = z + (iy - halfSide) * cubeStride;
            const m = new THREE.Matrix4();
            m.compose(
              new THREE.Vector3(px, WALL_HEIGHT / 2, pz),
              tmpQuat,
              tmpScale,
            );
            // Checker pattern is per-cube but offset by the cell
            // coordinates so adjacent wall cells don't visibly tile
            // identically.
            const checker = (ix + iy + c + r) & 1;
            if (checker === 0) blackCubes.push(m);
            else whiteCubes.push(m);
          }
        }
        _wallEntries.push({
          x, z,
          w: CELL_SIZE, h: CELL_SIZE,
        });
      } else {
        // Floor tile + invisible fill decal.
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.position.set(x, 0.01, z);
        floor.receiveShadow = true;
        group.add(floor);

        const fill = new THREE.Mesh(fillGeo, fillMat.clone());
        fill.position.set(x, 0.04, z);
        fill.visible = false;
        group.add(fill);
        _fillMeshes[r * cols + c] = fill;
        _coverageTotal++;
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
    for (const e of _wallEntries) e.mesh = blackMesh;     // for assemble fade
  }
  if (whiteCubes.length > 0) {
    const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
    const whiteMesh = new THREE.InstancedMesh(cubeGeo, _getWallMatWhite(), whiteCubes.length);
    for (let i = 0; i < whiteCubes.length; i++) whiteMesh.setMatrixAt(i, whiteCubes[i]);
    whiteMesh.instanceMatrix.needsUpdate = true;
    whiteMesh.castShadow = true;
    group.add(whiteMesh);
  }

  // ---- GLYPHS ----
  _glyphEntries = [];
  for (let i = 0; i < (glyphs || []).length; i++) {
    const g = glyphs[i];
    const { x, z } = cellToWorld(g.col, g.row, cols, rows);
    const char = GLYPH_CHARS[i % GLYPH_CHARS.length];
    const tex = _makeGlyphTexture(char, tintHex);
    const spriteMat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(4.8, 4.8, 1);
    sprite.position.set(x, 2.0, z);
    group.add(sprite);
    _glyphEntries.push({
      col: g.col, row: g.row,
      mesh: sprite,
      collected: false,
      baseY: 2.0,
      phase: i * 1.3,
      char,
      tint: tintHex,
    });
  }

  // ---- MINING BLOCKS ----
  _miningBlockEntries = [];
  _miningCellSet = new Set();
  const blockGeo = new THREE.BoxGeometry(CELL_SIZE * 0.78, CELL_SIZE * 0.55, CELL_SIZE * 0.78);
  for (const mb of (miningBlocks || [])) {
    const { x, z } = cellToWorld(mb.col, mb.row, cols, rows);
    const mat = _makeMiningMat();
    const mesh = new THREE.Mesh(blockGeo, mat);
    mesh.position.set(x, CELL_SIZE * 0.55 / 2 + 0.02, z);
    mesh.castShadow = true;
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

  // ---- DECOR ENEMIES ----
  // Chapter-tinted boxy meshes — visual fluff. Slide over to destroy.
  // Built from simple primitives; we don't reuse the makeEnemy path
  // because we don't want enemy AI / damage behavior to engage.
  _decorEnemyEntries = [];
  if (decorEnemies && decorEnemies.length) {
    const enemyChapterIdx = Math.floor((mazeData.config.waveNum - 1) / 10) % 6;
    const enemyTint = _enemyTintForChapter(enemyChapterIdx);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: enemyTint,
      emissive: enemyTint,
      emissiveIntensity: 0.35,
      roughness: 0.55,
      metalness: 0.1,
    });
    const bodyGeo = new THREE.BoxGeometry(1.6, 1.8, 1.6);
    const headGeo = new THREE.BoxGeometry(1.0, 0.9, 1.0);
    for (const e of decorEnemies) {
      const { x, z } = cellToWorld(e.col, e.row, cols, rows);
      const ent = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.9;
      ent.add(body);
      const head = new THREE.Mesh(headGeo, bodyMat);
      head.position.y = 2.2;
      ent.add(head);
      ent.position.set(x, 0, z);
      group.add(ent);
      _decorEnemyEntries.push({
        col: e.col, row: e.row, mesh: ent,
        destroyed: false, phase: Math.random() * Math.PI * 2,
      });
    }
  }

  scene.add(group);
  _mazeGroup = group;
  return group;
}

function _enemyTintForChapter(idx) {
  // Mirrors CHAPTERS[idx].full.enemyTint without importing config.js.
  const tints = [0xff6a1a, 0xff2e4d, 0xffbb00, 0x00ff44, 0x4ff7ff, 0xbb00ff];
  return tints[idx % tints.length];
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
  _glyphEntries = [];
  _glyphsCollected = 0;
  _decorEnemyEntries = [];
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
  // Glyph bob + sprite rotation.
  for (const g of _glyphEntries) {
    if (g.collected || !g.mesh) continue;
    g.mesh.position.y = g.baseY + Math.sin(time * 2 + g.phase) * 0.3;
    g.mesh.material.rotation = time * 0.5 + g.phase;
  }
  // Decor enemy idle wiggle.
  for (const e of _decorEnemyEntries) {
    if (e.destroyed || !e.mesh) continue;
    e.mesh.rotation.y = Math.sin(time * 1.5 + e.phase) * 0.2;
    e.mesh.position.y = Math.abs(Math.sin(time * 3 + e.phase)) * 0.15;
  }
  // Fill fade-in + post-fade pulse. Once a cell is fully revealed
  // (opacity 1), modulate emissive intensity around the base value
  // using a sin keyed off a per-cell phase. The phase varies with
  // (col, row) so the whole filled area reads as a wave rippling
  // across the maze — visual reinforcement that the player's
  // coverage is alive, not just painted on.
  if (_fillMeshes) {
    const PULSE_BASE = 0.45;
    const PULSE_AMP  = 0.55;
    const PULSE_HZ   = 1.4;
    for (let i = 0; i < _fillMeshes.length; i++) {
      const m = _fillMeshes[i];
      if (!m || !m.visible) continue;
      const mat = m.material;
      if (mat.opacity < 1) {
        mat.opacity = Math.min(1, mat.opacity + dt * 6);
      } else {
        const phase = (m.userData && m.userData.pulsePhase) || 0;
        const s = Math.sin(time * PULSE_HZ + phase);
        // Map sin (-1..1) → (0..1) then scale into [base..base+amp]
        // so the cell never dims below its baseline glow.
        mat.emissiveIntensity = PULSE_BASE + ((s + 1) * 0.5) * PULSE_AMP;
      }
    }
  }
}

// ============================================================
// COVERAGE (visual feedback only — not the win condition)
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
  // Phase tied to grid position so the pulse reads as a coherent wave
  // sweeping across the filled area, not random per-cell flicker. The
  // 0.55/0.40 frequencies are mutually irrational enough to avoid a
  // visible repeating banding pattern.
  m.userData.pulsePhase = col * 0.55 + row * 0.40;
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
  return { filled: _coverageFilled, total: Math.max(1, _coverageTotal) };
}

// ============================================================
// GLYPHS (the win condition)
// ============================================================
export function collectGlyphAt(col, row) {
  for (let i = 0; i < _glyphEntries.length; i++) {
    const g = _glyphEntries[i];
    if (g.collected) continue;
    if (g.col === col && g.row === row) {
      g.collected = true;
      if (g.mesh) g.mesh.visible = false;
      _glyphsCollected++;
      return { index: i, char: g.char, tint: g.tint };
    }
  }
  return null;
}
export function getGlyphsRemaining() {
  return _glyphEntries.length - _glyphsCollected;
}
export function getGlyphsTotal() {
  return _glyphEntries.length;
}
export function getGlyphsCollected() {
  return _glyphsCollected;
}

// Slide-over destruction for decor enemies. Returns the world center
// of the destroyed enemy (or null) so the caller can spawn a hit
// burst.
export function clearDecorEnemyAt(col, row) {
  for (const e of _decorEnemyEntries) {
    if (e.destroyed) continue;
    if (e.col === col && e.row === row) {
      e.destroyed = true;
      if (e.mesh) {
        if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
        e.mesh.traverse((node) => {
          if (node.isMesh && node.geometry) node.geometry.dispose();
        });
      }
      const { cols, rows } = _mazeData;
      const w = cellToWorld(col, row, cols, rows);
      return { x: w.x, z: w.z };
    }
  }
  return null;
}

// ============================================================
// CELL QUERIES
// ============================================================
export function isKillZoneCell(col, row) {
  if (!_mazeData || !_killZoneCells) return false;
  return _killZoneCells.has(row * _mazeData.cols + col);
}

export function isCellBlocked(col, row) {
  // True if the cell is currently impassable: either a wall cell or
  // an un-broken mining block.
  if (!_mazeData) return false;
  const { cols, rows, cells } = _mazeData;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return true;
  const cell = cells[row * cols + col];
  if (cell && cell.kind === 'wall') return true;
  if (_miningCellSet && _miningCellSet.has(row * cols + col)) {
    for (const e of _miningBlockEntries) {
      if (e.col === col && e.row === row) return !(e.ref && e.ref.broken);
    }
  }
  return false;
}

// ============================================================
// COLLISION
// ============================================================
export function isBlockedByWall(x, z, dx, dz) {
  if (!_mazeData) return false;
  const { cols, rows } = _mazeData;
  const mazeW = cols * CELL_SIZE;
  const mazeH = rows * CELL_SIZE;
  const ox = -mazeW / 2;
  const oz = -mazeH / 2;
  const newX = x + dx;
  const newZ = z + dz;
  const newCol = Math.floor((newX - ox) / CELL_SIZE);
  const newRow = Math.floor((newZ - oz) / CELL_SIZE);
  if (newCol < 0 || newCol >= cols || newRow < 0 || newRow >= rows) return true;
  return isCellBlocked(newCol, newRow);
}

export function segmentBlockedByMazeWall(x0, z0, x1, z1) {
  if (!_mazeData) return false;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return false;
  const stride = CELL_SIZE * 0.33;
  const steps = Math.max(1, Math.ceil(len / stride));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + dx * t;
    const cz = z0 + dz * t;
    if (isBlockedByWall(cx - 1e-3, cz - 1e-3, 0, 0)) return true;
  }
  return false;
}

export function resolveMazeCollision(pos, radius) {
  if (!_mazeData) return;
  const { cols, rows } = _mazeData;
  const mazeW = cols * CELL_SIZE;
  const mazeH = rows * CELL_SIZE;
  const ox = -mazeW / 2;
  const oz = -mazeH / 2;
  const col = Math.max(0, Math.min(cols - 1, Math.floor((pos.x - ox) / CELL_SIZE)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor((pos.z - oz) / CELL_SIZE)));
  // Push out of any adjacent wall cell.
  const half = CELL_SIZE / 2;
  const pushFromCell = (cc, cr) => {
    if (!isCellBlocked(cc, cr)) return;
    const cx = ox + (cc + 0.5) * CELL_SIZE;
    const cz = oz + (cr + 0.5) * CELL_SIZE;
    const closestX = Math.max(cx - half, Math.min(pos.x, cx + half));
    const closestZ = Math.max(cz - half, Math.min(pos.z, cz + half));
    const ddx = pos.x - closestX;
    const ddz = pos.z - closestZ;
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 < radius * radius && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      const overlap = radius - d;
      pos.x += (ddx / d) * overlap;
      pos.z += (ddz / d) * overlap;
    }
  };
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dc === 0 && dr === 0) continue;
      pushFromCell(col + dc, row + dr);
    }
  }
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
    return { hit: true, destroyed: true, color: _fillTint };
  }
  return { hit: true, destroyed: false, color: _fillTint };
}

// Backward-compat alias for callers that still import the old name.
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
