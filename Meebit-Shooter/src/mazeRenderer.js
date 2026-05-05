// ============================================================
// MAZE RENDERER — 3D visuals + collision for the Endless Glyphs maze.
//
// Responsibilities:
//   • Build all wall + floor meshes for a generated maze.
//   • Render mining gates as breakable themed blocks.
//   • Expose collision: cell-based isBlockedByWall + circle push-out
//     (resolveMazeCollision) + segment check for projectiles
//     (segmentBlockedByMazeWall).
//   • Track the wall mesh list so endlessAssemble / endlessDissolve
//     can animate them as particles.
//   • Track glyph pickup state, exit gate state.
//   • Mining-gate damage: damageMiningWallAt(x,z,dmg) returns hit info
//     and removes the wall from the maze when its HP drops to zero.
// ============================================================

import * as THREE from 'three';
import {
  CELL_SIZE,
  WALL_N, WALL_E, WALL_S, WALL_W,
  cellToWorld, worldToCell,
} from './mazeGenerator.js';

let _mazeGroup = null;
let _glyphMeshes = [];
let _exitMesh = null;
let _exitPos = null;
let _mazeData = null;

// _wallEntries: every visible wall as { mesh, x, z, w, h, isMining,
// gateRef, cellCol, cellRow, dir }. Used by the assemble/dissolve
// particle animations and by mining-wall damage routing.
let _wallEntries = [];

const WALL_HEIGHT = 3.5;
const WALL_THICKNESS = 0.45;

const GLYPH_CHARS = 'アイウエオカキクケコサシスセソ';

// Shared materials — cached by tint so back-to-back waves with the
// same chapter color don't recompile shaders.
let _floorMat = null;
const _wallMatCache = new Map();
const _miningMatCache = new Map();
const _miningEdgeMatCache = new Map();

function _getWallMat(tint) {
  let m = _wallMatCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.2,
      roughness: 0.6,
      metalness: 0.3,
    });
    _wallMatCache.set(tint, m);
  }
  return m;
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

function _getMiningMat(tint) {
  let m = _miningMatCache.get(tint);
  if (!m) {
    const base = new THREE.Color(tint).lerp(new THREE.Color(0x222233), 0.35);
    m = new THREE.MeshStandardMaterial({
      color: base,
      emissive: tint,
      emissiveIntensity: 0.45,
      roughness: 0.55,
      metalness: 0.25,
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

  const { cols, rows, cells, spawn, exit, glyphs, miningWalls } = mazeData;
  const group = new THREE.Group();
  group.name = 'maze';

  const wallMat = _getWallMat(chapterTint);
  const floorMat = _getFloorMat();
  const miningMat = _getMiningMat(chapterTint);
  const miningEdgeMat = _getMiningEdgeMat(chapterTint);
  const tintHex = '#' + new THREE.Color(chapterTint).getHexString();

  group.add(new THREE.AmbientLight(0xffffff, 0.4));

  // Look up which (col,row,dir) edges are mining gates so we can
  // route their wall meshes to the breakable material + track them.
  const miningByEdge = new Map();
  for (const m of (miningWalls || [])) {
    miningByEdge.set(`${m.col},${m.row},${m.dir}`, m);
  }

  // Shared geometries (exact size = wall edge = CELL_SIZE).
  const wallGeoNS = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, WALL_THICKNESS);
  const wallGeoEW = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, CELL_SIZE);
  const floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.96, CELL_SIZE * 0.96);
  floorGeo.rotateX(-Math.PI / 2);

  _wallEntries = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      const { x, z } = cellToWorld(c, r, cols, rows);

      // Floor tile
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.position.set(x, 0.01, z);
      floor.receiveShadow = true;
      group.add(floor);

      // Canonical edges: each cell owns its N + W walls. The S edge of
      // the bottom row and E edge of the right column become outer
      // borders here so we don't lose the arena boundary.
      if (cell.walls & WALL_N) {
        const gateKey = `${c},${r},N`;
        const gate = miningByEdge.get(gateKey);
        _addWall(group, wallGeoNS, x, WALL_HEIGHT / 2, z - CELL_SIZE / 2,
                 CELL_SIZE, WALL_THICKNESS,
                 c, r, 'N', gate, wallMat, miningMat, miningEdgeMat);
      }
      if (cell.walls & WALL_W) {
        const gateKey = `${c},${r},W`;
        const gate = miningByEdge.get(gateKey);
        _addWall(group, wallGeoEW, x - CELL_SIZE / 2, WALL_HEIGHT / 2, z,
                 WALL_THICKNESS, CELL_SIZE,
                 c, r, 'W', gate, wallMat, miningMat, miningEdgeMat);
      }
      if (r === rows - 1 && (cell.walls & WALL_S)) {
        // Outer boundary — never a mining gate.
        _addWall(group, wallGeoNS, x, WALL_HEIGHT / 2, z + CELL_SIZE / 2,
                 CELL_SIZE, WALL_THICKNESS,
                 c, r, 'S', null, wallMat, miningMat, miningEdgeMat);
      }
      if (c === cols - 1 && (cell.walls & WALL_E)) {
        _addWall(group, wallGeoEW, x + CELL_SIZE / 2, WALL_HEIGHT / 2, z,
                 WALL_THICKNESS, CELL_SIZE,
                 c, r, 'E', null, wallMat, miningMat, miningEdgeMat);
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
      map: tex, transparent: true, depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(2.2, 2.2, 1);
    sprite.position.set(x, 1.8, z);
    group.add(sprite);

    _glyphMeshes.push({
      mesh: sprite, collected: false,
      worldX: x, worldZ: z, baseY: 1.8, phase: i * 1.3,
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

function _addWall(group, geo, x, y, z, w, h, col, row, dir, gateRef,
                  wallMat, miningMat, miningEdgeMat) {
  const isMining = !!gateRef;
  const mat = isMining ? miningMat : wallMat;
  // Each wall gets its own material clone if it's a mining gate so a
  // hit flash on one gate doesn't tint the whole maze.
  const useMat = isMining ? mat.clone() : mat;
  const mesh = new THREE.Mesh(geo, useMat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;

  if (isMining) {
    // Bright outline so mining gates read as "shoot me" against
    // ordinary walls. Cheap — single LineSegments with a shared
    // EdgesGeometry per orientation.
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
  _wallEntries = [];
}

// ---- UPDATE GLYPHS ----
export function updateMazeGlyphs(dt) {
  const time = performance.now() * 0.001;
  for (const g of _glyphMeshes) {
    if (g.collected) continue;
    g.mesh.position.y = g.baseY + Math.sin(time * 2 + g.phase) * 0.3;
    g.mesh.material.rotation = time * 0.5 + g.phase;
  }
  if (_exitMesh) _exitMesh.rotation.z = time * 0.8;

  // Mining wall hit-flash decay.
  for (const e of _wallEntries) {
    if (!e.isMining || e.hitFlash <= 0) continue;
    e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
    if (e.mesh && e.mesh.material) {
      e.mesh.material.emissiveIntensity = 0.45 + e.hitFlash * 1.5;
    }
  }
}

// ---- COLLECT GLYPH ----
export function collectGlyph(index) {
  if (index < 0 || index >= _glyphMeshes.length) return false;
  const g = _glyphMeshes[index];
  if (g.collected) return false;
  g.collected = true;
  g.mesh.visible = false;
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

export function isNearExit(playerPos) {
  if (!_exitPos) return false;
  if (!_glyphMeshes.every(g => g.collected)) return false;
  const dx = playerPos.x - _exitPos.x;
  const dz = playerPos.z - _exitPos.z;
  return (dx * dx + dz * dz) < 3.0 * 3.0;
}

// ---- COLLISION ----

/**
 * Cell-flag step check. True if moving from (x,z) by (dx,dz) crosses a
 * solid wall (regular OR un-broken mining gate). Single-step, so for
 * fast-moving entities the caller should split the step or use
 * segmentBlockedByMazeWall instead.
 */
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

/**
 * Segment crossing test for projectiles. Walks the segment in steps of
 * a third of CELL_SIZE so a fast bullet can't tunnel through a wall.
 * Returns true if the segment crosses any solid wall edge.
 */
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

/**
 * Push an entity (player or enemy) out of any maze wall it overlaps.
 * Looks at the four wall AABBs adjacent to the entity's current cell.
 * Mutates pos.x / pos.z. Safe to call when no maze is active.
 */
export function resolveMazeCollision(pos, radius) {
  if (!_mazeData) return;
  const { cols, rows, cells } = _mazeData;
  const mazeW = cols * CELL_SIZE;
  const mazeH = rows * CELL_SIZE;
  const ox = -mazeW / 2;
  const oz = -mazeH / 2;
  // Cell containing the entity (clamped to grid).
  const col = Math.max(0, Math.min(cols - 1, Math.floor((pos.x - ox) / CELL_SIZE)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor((pos.z - oz) / CELL_SIZE)));
  const cell = cells[row * cols + col];
  // World center of the cell.
  const cx = ox + (col + 0.5) * CELL_SIZE;
  const cz = oz + (row + 0.5) * CELL_SIZE;
  const halfCell = CELL_SIZE / 2;
  const halfThick = WALL_THICKNESS / 2;

  // Helper — push pos out of an AABB centered at (ax,az) with half-extents
  // (hx,hz), using a circle with given radius.
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
      // Entity is exactly on the wall — push along the larger axis.
      if (Math.abs(pos.x - ax) > Math.abs(pos.z - az)) {
        pos.x += (pos.x >= ax ? 1 : -1) * (hx + radius);
      } else {
        pos.z += (pos.z >= az ? 1 : -1) * (hz + radius);
      }
    }
  };

  // North wall (z-edge above)
  if (cell.walls & WALL_N) pushOut(cx, cz - halfCell, halfCell, halfThick);
  // South wall (z-edge below)
  if (cell.walls & WALL_S) pushOut(cx, cz + halfCell, halfCell, halfThick);
  // West wall (x-edge left)
  if (cell.walls & WALL_W) pushOut(cx - halfCell, cz, halfThick, halfCell);
  // East wall (x-edge right)
  if (cell.walls & WALL_E) pushOut(cx + halfCell, cz, halfThick, halfCell);
}

// ---- MINING WALLS ----

/**
 * Damage a mining wall at world position (x,z). Returns:
 *   { hit: true, destroyed, color, x, z }   if a mining wall absorbed
 *                                            the shot
 *   { hit: false }                           otherwise
 *
 * On destruction the wall mesh is removed, both adjacent cells get
 * their wall bit cleared, and the gateRef is flagged broken so the
 * region map can be refreshed by the caller if desired.
 */
export function damageMiningWallAt(x, z, dmg) {
  if (!_mazeData) return { hit: false };
  // Find the closest mining wall whose AABB contains the hit point.
  let target = null;
  let bestDist = Infinity;
  for (const e of _wallEntries) {
    if (!e.isMining || !e.gateRef || e.gateRef.broken) continue;
    const hx = e.w / 2;
    const hz = e.h / 2;
    const minX = e.x - hx, maxX = e.x + hx;
    const minZ = e.z - hz, maxZ = e.z + hz;
    if (x < minX - 0.4 || x > maxX + 0.4) continue;
    if (z < minZ - 0.4 || z > maxZ + 0.4) continue;
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
    // Clear wall flags on both cells of the broken edge so collision
    // and projectile checks let entities through immediately.
    const { cells, cols } = _mazeData;
    const c = gate.col, r = gate.row;
    if (gate.dir === 'W') {
      cells[r * cols + c].walls &= ~WALL_W;
      if (c - 1 >= 0) cells[r * cols + (c - 1)].walls &= ~WALL_E;
    } else {
      cells[r * cols + c].walls &= ~WALL_N;
      if (r - 1 >= 0) cells[(r - 1) * cols + c].walls &= ~WALL_S;
    }
    // Remove + dispose the wall mesh.
    if (target.mesh) {
      if (target.mesh.parent) target.mesh.parent.remove(target.mesh);
      if (target.mesh.geometry) target.mesh.geometry.dispose();
      if (target.mesh.material && target.mesh.material.dispose) target.mesh.material.dispose();
    }
    // Remove from wall entries so collision iteration doesn't see it.
    const idx = _wallEntries.indexOf(target);
    if (idx >= 0) _wallEntries.splice(idx, 1);

    return {
      hit: true, destroyed: true,
      color: target.mesh ? target.mesh.material.color.getHex() : 0xffffff,
      x: target.x, z: target.z,
    };
  }

  return {
    hit: true, destroyed: false,
    color: target.mesh ? target.mesh.material.color.getHex() : 0xffffff,
    x: target.x, z: target.z,
  };
}

// Returns the mining-wall entry that the given world point would hit
// (useful for HUD/aim hints). Returns null if no mining wall here.
export function findMiningWallAt(x, z) {
  if (!_mazeData) return null;
  for (const e of _wallEntries) {
    if (!e.isMining || !e.gateRef || e.gateRef.broken) continue;
    const hx = e.w / 2, hz = e.h / 2;
    if (x >= e.x - hx && x <= e.x + hx && z >= e.z - hz && z <= e.z + hz) {
      return e;
    }
  }
  return null;
}

// ---- WALL ENTRY EXPORT (for assemble/dissolve animations) ----
export function getMazeWallEntries() {
  // Return a shallow copy so callers can splice safely.
  return _wallEntries.slice();
}

// ---- CELL PATHING (BFS over open neighbors) ----
/**
 * Breadth-first search over the maze cell graph, treating solid walls
 * AND un-broken mining gates as blockers. Returns an array of
 * {col, row} cells from start to goal (inclusive), or null if no path
 * exists. Used for enemy patrol waypoints.
 */
export function getCellPath(startCol, startRow, goalCol, goalRow) {
  if (!_mazeData) return null;
  const { cols, rows, cells } = _mazeData;
  if (startCol < 0 || startCol >= cols || startRow < 0 || startRow >= rows) return null;
  if (goalCol < 0 || goalCol >= cols || goalRow < 0 || goalRow >= rows) return null;
  const startIdx = startRow * cols + startCol;
  const goalIdx = goalRow * cols + goalCol;
  if (startIdx === goalIdx) return [{ col: startCol, row: startRow }];

  const prev = new Int32Array(cols * rows).fill(-1);
  const queue = [startIdx];
  prev[startIdx] = startIdx;

  while (queue.length > 0) {
    const ci = queue.shift();
    if (ci === goalIdx) break;
    const cr = Math.floor(ci / cols);
    const cc = ci - cr * cols;
    const cell = cells[ci];
    if (!(cell.walls & WALL_N) && cr > 0) {
      const ni = (cr - 1) * cols + cc;
      if (prev[ni] === -1) { prev[ni] = ci; queue.push(ni); }
    }
    if (!(cell.walls & WALL_S) && cr < rows - 1) {
      const ni = (cr + 1) * cols + cc;
      if (prev[ni] === -1) { prev[ni] = ci; queue.push(ni); }
    }
    if (!(cell.walls & WALL_W) && cc > 0) {
      const ni = cr * cols + (cc - 1);
      if (prev[ni] === -1) { prev[ni] = ci; queue.push(ni); }
    }
    if (!(cell.walls & WALL_E) && cc < cols - 1) {
      const ni = cr * cols + (cc + 1);
      if (prev[ni] === -1) { prev[ni] = ci; queue.push(ni); }
    }
  }

  if (prev[goalIdx] === -1) return null;
  const path = [];
  let cur = goalIdx;
  while (cur !== startIdx) {
    path.push({ col: cur % cols, row: Math.floor(cur / cols) });
    cur = prev[cur];
    if (cur === -1) return null;
  }
  path.push({ col: startCol, row: startRow });
  path.reverse();
  return path;
}

// ---- GETTERS ----
export function getMazeGroup() { return _mazeGroup; }
export function getGlyphCount() { return _glyphMeshes.length; }
export function getCollectedCount() { return _glyphMeshes.filter(g => g.collected).length; }
export function areAllGlyphsCollected() { return _glyphMeshes.length > 0 && _glyphMeshes.every(g => g.collected); }
export function getMazeData() { return _mazeData; }
export function isMazeActive() { return !!_mazeData; }
