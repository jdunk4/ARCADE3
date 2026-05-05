// ============================================================
// MAZE RENDERER v2 — 3D visualization + collision for the maze.
//
// Changes from v1:
//   - No point lights on glyphs (emissive only — saves perf)
//   - Only 1 ambient + 1 spawn light for the whole maze
//   - Wall collision via simple grid lookup (no raycaster needed)
//   - Thicker walls (0.4u) for visual punch
//   - Mining blocks placed in some corridors
// ============================================================

import * as THREE from 'three';
import { CELL_SIZE, WALL_N, WALL_E, WALL_S, WALL_W, cellToWorld } from './mazeGenerator.js';

let _mazeGroup = null;
let _glyphMeshes = [];
let _exitMesh = null;
let _exitPos = null;
let _mazeData = null;

const WALL_HEIGHT = 3.5;
const WALL_THICKNESS = 0.4;

const GLYPH_CHARS = 'アイウエオカキクケコサシスセソ';

// Shared materials (created once)
let _wallMat = null;
let _floorMat = null;

function _getWallMat(tint) {
  _wallMat = new THREE.MeshStandardMaterial({
    color: tint,
    emissive: tint,
    emissiveIntensity: 0.2,
    roughness: 0.6,
    metalness: 0.3,
  });
  return _wallMat;
}

function _getFloorMat() {
  if (_floorMat) return _floorMat;
  _floorMat = new THREE.MeshStandardMaterial({
    color: 0x111118,
    roughness: 0.9,
    metalness: 0.1,
  });
  return _floorMat;
}

// ---- GLYPH TEXTURE ----
const _glyphTexCache = new Map();
function _makeGlyphTexture(char, color) {
  const key = char + color;
  if (_glyphTexCache.has(key)) return _glyphTexCache.get(key);
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.font = `bold ${size - 8}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
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

// ---- BUILD MAZE ----
export function buildMaze(mazeData, scene, chapterTint) {
  clearMaze(scene);
  _mazeData = mazeData;

  const { cols, rows, cells, spawn, exit, glyphs } = mazeData;
  const group = new THREE.Group();
  group.name = 'maze';

  const wallMat = _getWallMat(chapterTint);
  const floorMat = _getFloorMat();
  const tintHex = '#' + new THREE.Color(chapterTint).getHexString();

  // Single ambient light for the maze
  const mazeLight = new THREE.AmbientLight(0xffffff, 0.4);
  group.add(mazeLight);

  // Shared geometries
  const wallGeoN = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, WALL_THICKNESS);
  const wallGeoW = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, CELL_SIZE);
  const floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.96, CELL_SIZE * 0.96);
  floorGeo.rotateX(-Math.PI / 2);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      const { x, z } = cellToWorld(c, r, cols, rows);

      // Floor tile
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.position.set(x, 0.01, z);
      floor.receiveShadow = true;
      group.add(floor);

      // North wall
      if (cell.walls & WALL_N) {
        const wall = new THREE.Mesh(wallGeoN, wallMat);
        wall.position.set(x, WALL_HEIGHT / 2, z - CELL_SIZE / 2);
        wall.castShadow = true;
        group.add(wall);
      }

      // West wall
      if (cell.walls & WALL_W) {
        const wall = new THREE.Mesh(wallGeoW, wallMat);
        wall.position.set(x - CELL_SIZE / 2, WALL_HEIGHT / 2, z);
        wall.castShadow = true;
        group.add(wall);
      }

      // South wall (bottom row border)
      if (r === rows - 1 && (cell.walls & WALL_S)) {
        const wall = new THREE.Mesh(wallGeoN, wallMat);
        wall.position.set(x, WALL_HEIGHT / 2, z + CELL_SIZE / 2);
        wall.castShadow = true;
        group.add(wall);
      }

      // East wall (right column border)
      if (c === cols - 1 && (cell.walls & WALL_E)) {
        const wall = new THREE.Mesh(wallGeoW, wallMat);
        wall.position.set(x + CELL_SIZE / 2, WALL_HEIGHT / 2, z);
        wall.castShadow = true;
        group.add(wall);
      }
    }
  }

  // ---- GLYPH PICKUPS (no point lights — emissive only) ----
  _glyphMeshes = [];
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const { x, z } = cellToWorld(g.col, g.row, cols, rows);
    const char = GLYPH_CHARS[i % GLYPH_CHARS.length];
    const tex = _makeGlyphTexture(char, tintHex);
    const spriteMat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(2.2, 2.2, 1);
    sprite.position.set(x, 1.8, z);
    group.add(sprite);

    _glyphMeshes.push({
      mesh: sprite,
      collected: false,
      worldX: x,
      worldZ: z,
      baseY: 1.8,
      phase: i * 1.3,
    });
  }

  // ---- EXIT GATE ----
  const exitWorld = cellToWorld(exit.col, exit.row, cols, rows);
  _exitPos = exitWorld;

  const exitGeo = new THREE.TorusGeometry(1.2, 0.18, 8, 24);
  const exitMat = new THREE.MeshStandardMaterial({
    color: 0x00ff66, emissive: 0x00ff66,
    emissiveIntensity: 0.4, transparent: true, opacity: 0.35,
  });
  _exitMesh = new THREE.Mesh(exitGeo, exitMat);
  _exitMesh.position.set(exitWorld.x, 1.5, exitWorld.z);
  _exitMesh.rotation.x = Math.PI / 2;
  group.add(_exitMesh);

  // Spawn marker
  const spawnWorld = cellToWorld(spawn.col, spawn.row, cols, rows);
  const spawnGeo = new THREE.RingGeometry(0.8, 1.0, 24);
  spawnGeo.rotateX(-Math.PI / 2);
  const spawnMat = new THREE.MeshBasicMaterial({
    color: 0x00ff66, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
  });
  const spawnMarker = new THREE.Mesh(spawnGeo, spawnMat);
  spawnMarker.position.set(spawnWorld.x, 0.05, spawnWorld.z);
  group.add(spawnMarker);

  scene.add(group);
  _mazeGroup = group;
  return group;
}

// ---- CLEAR MAZE ----
export function clearMaze(scene) {
  if (_mazeGroup) {
    scene.remove(_mazeGroup);
    _mazeGroup.traverse((child) => {
      if (child.isMesh && child.geometry) child.geometry.dispose();
    });
    _mazeGroup = null;
  }
  _glyphMeshes = [];
  _exitMesh = null;
  _exitPos = null;
  _mazeData = null;
}

// ---- UPDATE GLYPHS (bobbing) ----
export function updateMazeGlyphs(dt) {
  const time = performance.now() * 0.001;
  for (const g of _glyphMeshes) {
    if (g.collected) continue;
    g.mesh.position.y = g.baseY + Math.sin(time * 2 + g.phase) * 0.3;
    g.mesh.material.rotation = time * 0.5 + g.phase;
  }
  if (_exitMesh) _exitMesh.rotation.z = time * 0.8;
}

// ---- COLLECT GLYPH ----
export function collectGlyph(index) {
  if (index < 0 || index >= _glyphMeshes.length) return false;
  const g = _glyphMeshes[index];
  if (g.collected) return false;
  g.collected = true;
  g.mesh.visible = false;

  // Check if all collected — activate exit
  const allCollected = _glyphMeshes.every(gl => gl.collected);
  if (allCollected && _exitMesh) {
    _exitMesh.material.opacity = 1.0;
    _exitMesh.material.emissiveIntensity = 2.5;
  }
  return allCollected;
}

// ---- GLYPH POSITIONS ----
export function getGlyphWorldPositions() {
  return _glyphMeshes.map(g => ({
    x: g.worldX, z: g.worldZ, collected: g.collected,
  }));
}

// ---- EXIT CHECK ----
export function isNearExit(playerPos) {
  if (!_exitPos) return false;
  if (!_glyphMeshes.every(g => g.collected)) return false;
  const dx = playerPos.x - _exitPos.x;
  const dz = playerPos.z - _exitPos.z;
  return (dx * dx + dz * dz) < 3.0 * 3.0;
}

// ---- WALL COLLISION ----
// Returns true if moving from (x,z) by (dx,dz) would cross a wall.
// Uses the maze grid to check — no raycaster needed.
export function isBlockedByWall(x, z, dx, dz) {
  if (!_mazeData) return false;
  const { cols, rows, cells } = _mazeData;
  const mazeW = cols * CELL_SIZE;
  const mazeH = rows * CELL_SIZE;
  const ox = -mazeW / 2;
  const oz = -mazeH / 2;

  const newX = x + dx;
  const newZ = z + dz;

  // Current cell
  const col = Math.floor((x - ox) / CELL_SIZE);
  const row = Math.floor((z - oz) / CELL_SIZE);
  // New cell
  const newCol = Math.floor((newX - ox) / CELL_SIZE);
  const newRow = Math.floor((newZ - oz) / CELL_SIZE);

  // Out of bounds = blocked
  if (newCol < 0 || newCol >= cols || newRow < 0 || newRow >= rows) return true;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return false;

  const cell = cells[row * cols + col];

  // Moving east
  if (newCol > col && (cell.walls & WALL_E)) return true;
  // Moving west
  if (newCol < col && (cell.walls & WALL_W)) return true;
  // Moving south
  if (newRow > row && (cell.walls & WALL_S)) return true;
  // Moving north
  if (newRow < row && (cell.walls & WALL_N)) return true;

  return false;
}

// ---- GETTERS ----
export function getMazeGroup() { return _mazeGroup; }
export function getGlyphCount() { return _glyphMeshes.length; }
export function getCollectedCount() { return _glyphMeshes.filter(g => g.collected).length; }
export function areAllGlyphsCollected() { return _glyphMeshes.length > 0 && _glyphMeshes.every(g => g.collected); }
export function getMazeData() { return _mazeData; }
