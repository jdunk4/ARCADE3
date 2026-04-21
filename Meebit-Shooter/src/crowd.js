// Spectator lanterns — floating, chapter-glowing figures arranged in a
// square formation around the arena (matching the arena's own square
// shape). Each figure is a boxy silhouette with an EMISSIVE material
// retinted per chapter, so the whole ring glows like a crowd of
// lanterns in the chapter's signature color.
//
// Implemented as two InstancedMeshes (body + head) so rendering the
// whole crowd costs 2 draw calls no matter how large the count.

import * as THREE from 'three';
import { scene } from './scene.js';
import { ARENA } from './config.js';

// ---------------------------------------------------------------
// Layout: square perimeter, a few rows deep.
// ---------------------------------------------------------------
const ROWS = 3;
const SPACING_ALONG_SIDE = 3.0;   // gap between lanterns along each side
const ROW_STEP = 2.6;             // distance between consecutive rows (outward)
const OUTER_PADDING = 5.0;        // how far the inner row sits beyond arena wall
const FLOAT_HEIGHT = 2.2;         // base y-height — floating above ground
const BOB_AMPLITUDE = 0.35;       // vertical bob range

let CROWD_COUNT = 0;

// Geometry — small box body + small box head (Meebit silhouette)
const BODY_GEO = new THREE.BoxGeometry(0.9, 1.4, 0.9);
BODY_GEO.translate(0, 0.7, 0);
const HEAD_GEO = new THREE.BoxGeometry(0.75, 0.75, 0.75);
HEAD_GEO.translate(0, 1.75, 0);

let bodyMesh = null;
let headMesh = null;

let bobSeeds = null;
let basePositions = null;

const _tmpMatrix = new THREE.Matrix4();
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3(1, 1, 1);
const _tmpColor = new THREE.Color();

// Four chapter-tinted side lights so the crowd's glow bleeds onto the
// arena floor near each edge.
let sideLights = null;

function _generateLayout() {
  const positions = [];
  for (let row = 0; row < ROWS; row++) {
    const outer = ARENA + OUTER_PADDING + row * ROW_STEP;
    const perSide = Math.max(1, Math.floor((outer * 2) / SPACING_ALONG_SIDE));
    const spacing = (outer * 2) / perSide;
    for (let i = 0; i < perSide; i++) {
      const t = -outer + (i + 0.5) * spacing;
      positions.push([t, -outer]);   // south
      positions.push([t,  outer]);   // north
      positions.push([-outer, t]);   // west
      positions.push([ outer, t]);   // east
    }
  }
  return positions;
}

export function buildCrowd() {
  if (bodyMesh) return;

  const layout = _generateLayout();
  CROWD_COUNT = layout.length;
  bobSeeds = new Float32Array(CROWD_COUNT);
  basePositions = new Float32Array(CROWD_COUNT * 3);

  // Emissive materials. instanceColor drives BOTH the diffuse AND the
  // emissive contribution on MeshStandardMaterial, so retinting the
  // instance color retints the glow without any shader recompile.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.4,
    roughness: 0.7, metalness: 0.0,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.8,
    roughness: 0.6, metalness: 0.0,
  });

  bodyMesh = new THREE.InstancedMesh(BODY_GEO, bodyMat, CROWD_COUNT);
  headMesh = new THREE.InstancedMesh(HEAD_GEO, headMat, CROWD_COUNT);
  bodyMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(CROWD_COUNT * 3), 3
  );
  headMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(CROWD_COUNT * 3), 3
  );

  for (let i = 0; i < CROWD_COUNT; i++) {
    const [x, z] = layout[i];
    basePositions[i * 3]     = x;
    basePositions[i * 3 + 1] = FLOAT_HEIGHT;
    basePositions[i * 3 + 2] = z;
    bobSeeds[i] = Math.random() * Math.PI * 2;

    const faceAngle = Math.atan2(-x, -z);
    _tmpPos.set(x, FLOAT_HEIGHT, z);
    _tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), faceAngle);
    _tmpMatrix.compose(_tmpPos, _tmpQuat, _tmpScale);
    bodyMesh.setMatrixAt(i, _tmpMatrix);
    headMesh.setMatrixAt(i, _tmpMatrix);
  }

  bodyMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;

  recolorCrowd(0x4ff7ff);

  scene.add(bodyMesh);
  scene.add(headMesh);

  // Four chapter-tinted point lights so the crowd's glow reaches the
  // arena floor near each side.
  sideLights = [];
  const sidePositions = [
    [0, FLOAT_HEIGHT, -ARENA - OUTER_PADDING - 2],
    [0, FLOAT_HEIGHT,  ARENA + OUTER_PADDING + 2],
    [-ARENA - OUTER_PADDING - 2, FLOAT_HEIGHT, 0],
    [ ARENA + OUTER_PADDING + 2, FLOAT_HEIGHT, 0],
  ];
  for (const [sx, sy, sz] of sidePositions) {
    const light = new THREE.PointLight(0x4ff7ff, 1.6, 28, 1.4);
    light.position.set(sx, sy, sz);
    scene.add(light);
    sideLights.push(light);
  }
}

/**
 * Retint every lantern + the four side lights to the chapter color.
 */
export function recolorCrowd(tintHex) {
  if (!bodyMesh) return;
  const tint = new THREE.Color(tintHex);

  for (let i = 0; i < CROWD_COUNT; i++) {
    const jitter = 0.75 + (bobSeeds[i] % 1) * 0.5;
    _tmpColor.copy(tint).multiplyScalar(jitter * 0.85);
    bodyMesh.setColorAt(i, _tmpColor);
    _tmpColor.copy(tint).multiplyScalar(jitter);
    headMesh.setColorAt(i, _tmpColor);
  }
  if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
  if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

  if (sideLights) {
    for (const light of sideLights) light.color.setHex(tintHex);
  }
}

/**
 * Per-frame bob animation — each lantern floats on a seeded sine wave.
 */
export function updateCrowd(timeElapsed) {
  if (!bodyMesh) return;

  for (let i = 0; i < CROWD_COUNT; i++) {
    const x = basePositions[i * 3];
    const baseY = basePositions[i * 3 + 1];
    const z = basePositions[i * 3 + 2];
    const seed = bobSeeds[i];

    const bob = Math.sin(timeElapsed * 1.4 + seed) * BOB_AMPLITUDE;
    const sway = Math.sin(timeElapsed * 0.9 + seed * 1.7) * 0.06;

    const faceAngle = Math.atan2(-x, -z) + sway * 0.15;
    _tmpPos.set(x, baseY + bob, z);
    _tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), faceAngle);
    _tmpMatrix.compose(_tmpPos, _tmpQuat, _tmpScale);
    bodyMesh.setMatrixAt(i, _tmpMatrix);
    headMesh.setMatrixAt(i, _tmpMatrix);
  }
  bodyMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;
}
