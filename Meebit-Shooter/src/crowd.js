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
const SPACING_ALONG_SIDE = 4.5;   // was 3.0 — spread lanterns farther apart
const ROW_STEP = 4.0;             // was 2.6 — rows are deeper apart
const OUTER_PADDING = 8.0;        // was 5.0 — push the inner row back
const FLOAT_HEIGHT = 2.2;
const BOB_AMPLITUDE = 0.35;

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

  // MeshBasicMaterial — UNLIT. Scene ambient + hemi + side lights were
  // washing the standard-material lanterns toward white no matter how
  // saturated the instance color was. Basic material ignores lights
  // entirely, so the diffuse = exactly the instanceColor × material
  // color. For lanterns this actually reads correctly: they're lights,
  // not lit objects, so they should project their color regardless of
  // what's nearby.
  const bodyMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,   // white base — instanceColor multiplies this to the chapter hue
    toneMapped: false, // preserve color saturation through ACES tone mapping
  });
  const headMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
  });

  bodyMesh = new THREE.InstancedMesh(BODY_GEO, bodyMat, CROWD_COUNT);
  headMesh = new THREE.InstancedMesh(HEAD_GEO, headMat, CROWD_COUNT);
  // Note: we do NOT manually assign bodyMesh.instanceColor here.
  // setColorAt() lazily creates the InstancedBufferAttribute on first
  // call, which guarantees Three.js flags USE_INSTANCING_COLOR correctly
  // in the program cache. Manually assigning `.instanceColor` used to
  // produce white lanterns because the shader define wasn't set.

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

  // Eight chapter-tinted point lights positioned around the perimeter.
  // Four on the side-midpoints, four on the corners. This gives an
  // even chapter-colored wash across the arena floor edges without
  // hot spots. Intensity 11 / range 65 — bumped from 7/55 for a
  // more dramatic chapter wash. The lights also breathe in
  // updateCrowd: a slow sine pulse on intensity makes the perimeter
  // glow visibly alive instead of feeling like a static neon sign.
  sideLights = [];
  const outerDist = ARENA + OUTER_PADDING + 4;
  const sidePositions = [
    // Side midpoints
    [0, FLOAT_HEIGHT + 1, -outerDist],
    [0, FLOAT_HEIGHT + 1,  outerDist],
    [-outerDist, FLOAT_HEIGHT + 1, 0],
    [ outerDist, FLOAT_HEIGHT + 1, 0],
    // Corners
    [-outerDist * 0.75, FLOAT_HEIGHT + 1, -outerDist * 0.75],
    [ outerDist * 0.75, FLOAT_HEIGHT + 1, -outerDist * 0.75],
    [-outerDist * 0.75, FLOAT_HEIGHT + 1,  outerDist * 0.75],
    [ outerDist * 0.75, FLOAT_HEIGHT + 1,  outerDist * 0.75],
  ];
  for (let i = 0; i < sidePositions.length; i++) {
    const [sx, sy, sz] = sidePositions[i];
    const light = new THREE.PointLight(0x4ff7ff, 11.0, 65, 1.3);
    light.position.set(sx, sy, sz);
    // Stash a per-light pulse phase so neighboring lights don't
    // breathe in lockstep — slight phase shifts between adjacent
    // perimeter lights look like the chapter mood is sweeping
    // around the arena rather than blinking on/off as a unit.
    light.userData.pulsePhase = (i / sidePositions.length) * Math.PI * 2;
    light.userData.baseIntensity = 11.0;
    scene.add(light);
    sideLights.push(light);
  }
}

/**
 * Retint every lantern + the four side lights to the chapter color.
 */
export function setCrowdVisible(visible) {
  if (bodyMesh) bodyMesh.visible = !!visible;
  if (headMesh) headMesh.visible = !!visible;
  if (sideLights) {
    for (const l of sideLights) if (l) l.visible = !!visible;
  }
}

export function recolorCrowd(tintHex) {
  if (!bodyMesh) return;
  const tint = new THREE.Color(tintHex);

  for (let i = 0; i < CROWD_COUNT; i++) {
    // Very tight jitter range so every lantern still reads as a
    // SATURATED chapter color. Some variation keeps it from being a
    // perfectly uniform wall, but we don't want washed-out lanterns.
    const jitter = 0.9 + (bobSeeds[i] % 1) * 0.2;   // 0.9 .. 1.1
    _tmpColor.copy(tint).multiplyScalar(jitter);
    bodyMesh.setColorAt(i, _tmpColor);
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

  // Perimeter side-light pulse. Each light has its own phase shift
  // (set in _generateLayout), so the chapter glow visibly sweeps
  // around the arena instead of breathing as one big unit. Intensity
  // oscillates between 0.85× and 1.15× of base — subtle enough not
  // to feel disco-y, dramatic enough that the user perceives the
  // arena edges as "alive".
  if (sideLights) {
    for (const light of sideLights) {
      const base = light.userData.baseIntensity || 11.0;
      const phase = light.userData.pulsePhase || 0;
      light.intensity = base * (0.85 + 0.30 * Math.sin(timeElapsed * 1.2 + phase));
    }
  }
}
