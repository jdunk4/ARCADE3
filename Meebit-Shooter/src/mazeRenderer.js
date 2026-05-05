// ============================================================
// MAZE RENDERER — 3D visualization of the generated maze.
//
// Converts MazeData from mazeGenerator.js into Three.js geometry:
//   - Walls: BoxGeometry blocks, chapter-tinted
//   - Floor: PlaneGeometry tiles per cell, dark with grid lines
//   - Glyphs: Floating emissive sprites with katakana characters
//   - Exit gate: Glowing portal ring
//   - Spawn marker: Faint green circle
//
// All geometry lives in a single THREE.Group (_mazeGroup) that
// can be added/removed from the scene cleanly.
//
// Public API:
//   buildMaze(mazeData, scene, chapterTint)  → group
//   clearMaze(scene)
//   updateMazeGlyphs(dt)       — animate glyph bobbing
//   collectGlyph(index)        → boolean
//   getGlyphWorldPositions()   → [{x,z,collected}]
//   isNearExit(playerPos)      → boolean
//   getMazeGroup()             → THREE.Group
// ============================================================

import * as THREE from 'three';
import { CELL_SIZE, WALL_N, WALL_E, WALL_S, WALL_W, cellToWorld } from './mazeGenerator.js';

let _mazeGroup = null;
let _glyphMeshes = [];   // { mesh, collected, worldX, worldZ }
let _exitMesh = null;
let _exitPos = null;
let _mazeData = null;

const WALL_HEIGHT = 3.0;
const WALL_THICKNESS = 0.2;

// Glyph characters — katakana for the matrix vibe
const GLYPH_CHARS = 'アイウエオカキクケコサシスセソ';

// ---- SHARED GEOMETRY / MATERIALS ----
const _wallGeo = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, WALL_THICKNESS);
const _wallGeoSide = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, CELL_SIZE);
const _floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.95, CELL_SIZE * 0.95);
_floorGeo.rotateX(-Math.PI / 2);

let _wallMat = null;
let _floorMat = null;

function _getWallMat(tint) {
  if (_wallMat) return _wallMat;
  _wallMat = new THREE.MeshStandardMaterial({
    color: tint,
    emissive: tint,
    emissiveIntensity: 0.15,
    roughness: 0.7,
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

// ---- GLYPH SPRITE TEXTURE ----
const _glyphTexCache = new Map();
function _makeGlyphTexture(char, color) {
  const key = char + color;
  if (_glyphTexCache.has(key)) return _glyphTexCache.get(key);
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
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

  // Ambient light boost for the maze (it's dark)
  const mazeLight = new THREE.AmbientLight(0xffffff, 0.3);
  group.add(mazeLight);

  // Point light at spawn
  const spawnLight = new THREE.PointLight(chapterTint, 1.5, 15);
  const spawnWorld = cellToWorld(spawn.col, spawn.row, cols, rows);
  spawnLight.position.set(spawnWorld.x, WALL_HEIGHT, spawnWorld.z);
  group.add(spawnLight);

  // Build walls + floor
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      const { x, z } = cellToWorld(c, r, cols, rows);

      // Floor tile
      const floor = new THREE.Mesh(floorGeo_clone(), floorMat);
      floor.position.set(x, 0.01, z);
      floor.receiveShadow = true;
      group.add(floor);

      // North wall (only if this is the top row or cell has N wall)
      if (cell.walls & WALL_N) {
        const wall = new THREE.Mesh(_wallGeo, wallMat);
        wall.position.set(x, WALL_HEIGHT / 2, z - CELL_SIZE / 2);
        wall.castShadow = true;
        group.add(wall);
      }

      // West wall
      if (cell.walls & WALL_W) {
        const wall = new THREE.Mesh(_wallGeoSide, wallMat);
        wall.position.set(x - CELL_SIZE / 2, WALL_HEIGHT / 2, z);
        wall.castShadow = true;
        group.add(wall);
      }

      // South wall (only on bottom row to close the border)
      if (r === rows - 1 && (cell.walls & WALL_S)) {
        const wall = new THREE.Mesh(_wallGeo, wallMat);
        wall.position.set(x, WALL_HEIGHT / 2, z + CELL_SIZE / 2);
        wall.castShadow = true;
        group.add(wall);
      }

      // East wall (only on right column to close the border)
      if (c === cols - 1 && (cell.walls & WALL_E)) {
        const wall = new THREE.Mesh(_wallGeoSide, wallMat);
        wall.position.set(x + CELL_SIZE / 2, WALL_HEIGHT / 2, z);
        wall.castShadow = true;
        group.add(wall);
      }
    }
  }

  // ---- GLYPH PICKUPS ----
  _glyphMeshes = [];
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const { x, z } = cellToWorld(g.col, g.row, cols, rows);
    const char = GLYPH_CHARS[i % GLYPH_CHARS.length];
    const tex = _makeGlyphTexture(char, tintHex);
    const spriteMat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1.8, 1.8, 1);
    sprite.position.set(x, 1.5, z);
    group.add(sprite);

    // Point light per glyph
    const light = new THREE.PointLight(chapterTint, 0.8, 6);
    light.position.set(x, 2, z);
    group.add(light);

    _glyphMeshes.push({
      mesh: sprite,
      light,
      collected: false,
      worldX: x,
      worldZ: z,
      baseY: 1.5,
      phase: i * 1.3,  // offset bobbing phase
    });
  }

  // ---- EXIT GATE ----
  const exitWorld = cellToWorld(exit.col, exit.row, cols, rows);
  _exitPos = exitWorld;

  // Exit portal — glowing torus
  const exitGeo = new THREE.TorusGeometry(1.0, 0.15, 8, 24);
  const exitMat = new THREE.MeshStandardMaterial({
    color: 0x00ff66,
    emissive: 0x00ff66,
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.4,  // starts dim — brightens when all glyphs collected
  });
  _exitMesh = new THREE.Mesh(exitGeo, exitMat);
  _exitMesh.position.set(exitWorld.x, 1.5, exitWorld.z);
  _exitMesh.rotation.x = Math.PI / 2;
  group.add(_exitMesh);

  // Exit light (dim until activated)
  const exitLight = new THREE.PointLight(0x00ff66, 0.3, 8);
  exitLight.position.set(exitWorld.x, 2.5, exitWorld.z);
  group.add(exitLight);
  _exitMesh.userData.light = exitLight;

  // Spawn marker
  const spawnGeo = new THREE.RingGeometry(0.8, 1.0, 24);
  spawnGeo.rotateX(-Math.PI / 2);
  const spawnMat = new THREE.MeshBasicMaterial({
    color: 0x00ff66,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
  });
  const spawnMarker = new THREE.Mesh(spawnGeo, spawnMat);
  spawnMarker.position.set(spawnWorld.x, 0.05, spawnWorld.z);
  group.add(spawnMarker);

  scene.add(group);
  _mazeGroup = group;
  return group;
}

// Avoid sharing the same geometry instance for all floor tiles
// (Three.js needs separate references for frustum culling to work)
function floorGeo_clone() {
  return _floorGeo.clone();
}

// ---- CLEAR MAZE ----
export function clearMaze(scene) {
  if (_mazeGroup) {
    scene.remove(_mazeGroup);
    // Dispose geometries (materials are cached/shared, don't dispose)
    _mazeGroup.traverse((child) => {
      if (child.isMesh && child.geometry) {
        child.geometry.dispose();
      }
    });
    _mazeGroup = null;
  }
  _glyphMeshes = [];
  _exitMesh = null;
  _exitPos = null;
  _mazeData = null;
}

// ---- UPDATE GLYPHS (bobbing animation) ----
export function updateMazeGlyphs(dt) {
  const time = performance.now() * 0.001;
  for (const g of _glyphMeshes) {
    if (g.collected) continue;
    // Bob up and down
    g.mesh.position.y = g.baseY + Math.sin(time * 2 + g.phase) * 0.3;
    // Slow rotation
    g.mesh.material.rotation = time * 0.5 + g.phase;
  }
  // Exit gate rotation
  if (_exitMesh) {
    _exitMesh.rotation.z = time * 0.8;
  }
}

// ---- COLLECT GLYPH ----
export function collectGlyph(index) {
  if (index < 0 || index >= _glyphMeshes.length) return false;
  const g = _glyphMeshes[index];
  if (g.collected) return false;
  g.collected = true;
  g.mesh.visible = false;
  if (g.light) g.light.visible = false;

  // Check if all glyphs collected — activate exit
  const allCollected = _glyphMeshes.every(gl => gl.collected);
  if (allCollected && _exitMesh) {
    _exitMesh.material.opacity = 1.0;
    _exitMesh.material.emissiveIntensity = 2.0;
    if (_exitMesh.userData.light) {
      _exitMesh.userData.light.intensity = 2.0;
    }
  }
  return allCollected;
}

// ---- GLYPH POSITIONS (for pickup detection) ----
export function getGlyphWorldPositions() {
  return _glyphMeshes.map(g => ({
    x: g.worldX,
    z: g.worldZ,
    collected: g.collected,
  }));
}

// ---- EXIT PROXIMITY CHECK ----
export function isNearExit(playerPos) {
  if (!_exitPos) return false;
  // Only allow exit if all glyphs collected
  const allCollected = _glyphMeshes.every(g => g.collected);
  if (!allCollected) return false;
  const dx = playerPos.x - _exitPos.x;
  const dz = playerPos.z - _exitPos.z;
  return (dx * dx + dz * dz) < 2.5 * 2.5;
}

// ---- GETTERS ----
export function getMazeGroup() { return _mazeGroup; }
export function getGlyphCount() { return _glyphMeshes.length; }
export function getCollectedCount() { return _glyphMeshes.filter(g => g.collected).length; }
export function areAllGlyphsCollected() { return _glyphMeshes.every(g => g.collected); }
