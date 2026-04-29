// fogRing.js — Player-centered fog-ring visibility effect.
//
// Replaces the distance-based fog's role for player fairness. The
// existing scene.fog still tints distant geometry, but visibility is
// now governed by a CIRCULAR ring around the player. Inside the ring:
// clear floor + visible enemies. Outside: dark, fading to opaque past
// the boundary. Anything past the boundary CAN'T BE SEEN — and we
// tighten the existing distance-fog far parameter to match so projectiles
// from beyond the ring are visually obscured at the edge.
//
// Implementation:
//   - Big floor-level RingGeometry mesh, ~22u inner radius, ~50u outer
//   - Parented directly to the scene; we move it to track the player
//     each frame in updateFogRing
//   - Material: MeshBasicMaterial with alpha ramp via vertex colors
//     (vertex at inner radius = transparent, vertex at outer radius =
//     opaque). We approximate the gradient with a 2-vertex ring +
//     vertexColors instead of a custom shader.
//   - For real darkening at the outer edge, we use a SECOND outer ring
//     at full opacity (50u → 100u) so anything outside is just black.
//
// Public API:
//   initFogRing()                       — build meshes + tighten distance fog
//   updateFogRing(playerPos, chapterIdx)  — reposition + recolor per frame
//   setFogVisible(v)
//   clearFogRing()

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';

// ---- Tunables ----
const VISIBLE_RADIUS = 17.0;     // clear inside this (user spec'd 17)
const FALLOFF_RADIUS = 23.0;     // ramps to opaque between visible and falloff
const OUTER_BLACK_RADIUS = 100;  // beyond this — pure cover
// Camera at offset (0, 17, 11) means bottom of screen maps to +Z
// (camera-side). Bias the ring CENTER away from the camera (toward
// -Z, i.e. forward of the player) so the +Z side of the ring is
// closer to the player and the lower screen corners get covered by
// fog. Effective fog reach: ring extends BIAS_Z+VISIBLE forward
// (~22u) and VISIBLE-BIAS_Z back (~12u). Player still feels centered
// in their bubble visually due to the camera angle.
const FOG_BIAS_Z = -5.0;

// Tighten the existing distance fog so distant geometry actually
// hides. Default is near=30, far=85. Drop to match the ring boundary.
const FOG_NEAR = 8;
const FOG_FAR  = 30;

let _ring = null;
let _outerCover = null;
let _origFogNear = null;
let _origFogFar = null;
let _origFogColor = null;
let _origBgColor = null;

/** Build the fog ring + tighten distance fog. Idempotent. */
export function initFogRing() {
  if (_ring) return;

  // --- Inner gradient ring: VISIBLE_RADIUS → FALLOFF_RADIUS ---
  // Use RingGeometry with vertex colors to fake a gradient:
  // inner verts alpha=0 (transparent), outer verts alpha=1 (opaque).
  const ringGeo = new THREE.RingGeometry(VISIBLE_RADIUS, FALLOFF_RADIUS, 64, 1);
  // Tweak vertex colors per-vertex. The geometry has 2 rings of vertices:
  // first 64+1 = 65 inner ring, then 65 outer ring (or similar — depends
  // on segments). We attach color attribute and let the shader interpolate.
  const positions = ringGeo.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);   // RingGeometry lays in XY plane
    const r = Math.sqrt(x * x + y * y);
    // Linear ramp from 0 at VISIBLE_RADIUS to 1 at FALLOFF_RADIUS
    const t = Math.max(0, Math.min(1, (r - VISIBLE_RADIUS) / (FALLOFF_RADIUS - VISIBLE_RADIUS)));
    // We use the color as our alpha proxy — store t in r/g/b and use
    // the material's color * vertexColor to drive opacity via the
    // material's transparent flag. With a black material color we get
    // black at outer (t=1) and transparent at inner (t=0).
    // Instead — store INVERSE: color = 0 at outer, 1 at inner. With
    // a black BasicMaterial multiplied by vertex color we'd get
    // black-where-color-is-0. So vertex color of (0,0,0) = black,
    // (1,1,1) = original. Doesn't give us alpha.
    // Better: use color WITH alpha via Float32 RGBA isn't standard.
    // Workaround: set color RGB to (0,0,0), keep transparent=true,
    // and bake alpha into a custom attribute used by onBeforeCompile.
    // SIMPLEST APPROACH: store t as RGB; use a material with vertexColors
    // and a custom shader hook that sets gl_FragColor.a based on it.
    colors[i * 3 + 0] = t;
    colors[i * 3 + 1] = t;
    colors[i * 3 + 2] = t;
  }
  ringGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const ringMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute float vRingTAttr;
      varying float vRingT;
      void main() {
        vRingT = vRingTAttr;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vRingT;
      void main() {
        gl_FragColor = vec4(0.0, 0.0, 0.0, vRingT);
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  // Build a per-vertex float attribute (vRingTAttr) carrying t.
  // 0 at inner radius, 1 at outer radius. We've already computed t per
  // vertex above into the colors[i*3] array; copy out into a 1D attr.
  const vRingTArr = new Float32Array(positions.count);
  for (let i = 0; i < positions.count; i++) {
    vRingTArr[i] = colors[i * 3];
  }
  ringGeo.setAttribute('vRingTAttr', new THREE.BufferAttribute(vRingTArr, 1));

  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.5;          // slightly above the floor so it draws on top of grid
  scene.add(ring);
  _ring = ring;

  // --- Outer cover ring: FALLOFF_RADIUS → OUTER_BLACK_RADIUS ---
  // Pure black, fully opaque. This blocks any distant geometry from
  // poking through the gradient.
  const outerGeo = new THREE.RingGeometry(FALLOFF_RADIUS, OUTER_BLACK_RADIUS, 48, 1);
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: false,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const outer = new THREE.Mesh(outerGeo, outerMat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = 0.5;
  scene.add(outer);
  _outerCover = outer;

  // Tighten the existing scene fog so distant skybox / props also
  // disappear at the visibility boundary. Stash originals so we can
  // restore on clearFogRing. Also override the fog COLOR to pure black
  // — without this, distant areas fade to the chapter-tinted fog color
  // (purplish for chapter 1, etc) instead of true black, leaving a
  // visible "edge of map" tint past the ring's falloff.
  if (scene.fog) {
    _origFogNear = scene.fog.near;
    _origFogFar = scene.fog.far;
    _origFogColor = scene.fog.color.getHex();
    scene.fog.near = FOG_NEAR;
    scene.fog.far = FOG_FAR;
    scene.fog.color.setHex(0x000000);
  }
  // Same for scene.background — set to pure black so the sky doesn't
  // bleed chapter-tint past the fog boundary.
  if (scene.background) {
    _origBgColor = scene.background.getHex ? scene.background.getHex() : null;
    if (_origBgColor !== null) scene.background.setHex(0x000000);
  }
}

/** Per-frame: reposition the rings so they're centered on the player.
 *  Cheap — just two .position.set calls. Also re-asserts fog + bg
 *  colors as black each frame; the scene's theme system tries to set
 *  them to chapter tint on transitions, but the fog ring takes
 *  precedence. */
export function updateFogRing(playerPos) {
  if (!_ring || !playerPos) return;
  // Bias ring center forward (toward -Z, away from camera) so lower
  // screen corners (which map to +Z) get covered by the fog gradient.
  _ring.position.x = playerPos.x;
  _ring.position.z = playerPos.z + FOG_BIAS_Z;
  if (_outerCover) {
    _outerCover.position.x = playerPos.x;
    _outerCover.position.z = playerPos.z + FOG_BIAS_Z;
  }
  // Re-assert fog params each frame — overrides theme transitions
  if (scene.fog) {
    scene.fog.near = FOG_NEAR;
    scene.fog.far = FOG_FAR;
    scene.fog.color.setHex(0x000000);
  }
  if (scene.background && scene.background.setHex) {
    scene.background.setHex(0x000000);
  }
}

export function setFogVisible(v) {
  if (_ring) _ring.visible = !!v;
  if (_outerCover) _outerCover.visible = !!v;
}

/** Remove the fog ring + restore original distance-fog params. */
export function clearFogRing() {
  if (_ring && _ring.parent) scene.remove(_ring);
  if (_outerCover && _outerCover.parent) scene.remove(_outerCover);
  _ring = null;
  _outerCover = null;
  if (scene.fog && _origFogNear !== null) {
    scene.fog.near = _origFogNear;
    scene.fog.far = _origFogFar;
    if (_origFogColor !== null) scene.fog.color.setHex(_origFogColor);
    _origFogNear = null;
    _origFogFar = null;
    _origFogColor = null;
  }
  if (scene.background && _origBgColor !== null) {
    scene.background.setHex(_origBgColor);
    _origBgColor = null;
  }
}
