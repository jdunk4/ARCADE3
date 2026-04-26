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
const VISIBLE_RADIUS = 22.0;     // clear inside this
const FALLOFF_RADIUS = 30.0;     // ramps to opaque between visible and falloff
const OUTER_BLACK_RADIUS = 100;  // beyond this — pure cover

// Tighten the existing distance fog so distant geometry actually
// hides. Default is near=30, far=85. We drop far to 35 so anything
// past ~35u from the camera is heavily fogged. Matches the ring boundary.
const FOG_NEAR = 12;
const FOG_FAR  = 38;

let _ring = null;
let _outerCover = null;
let _origFogNear = null;
let _origFogFar = null;

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
  // restore on clearFogRing.
  if (scene.fog) {
    _origFogNear = scene.fog.near;
    _origFogFar = scene.fog.far;
    scene.fog.near = FOG_NEAR;
    scene.fog.far = FOG_FAR;
  }
}

/** Per-frame: reposition the rings so they're centered on the player.
 *  Cheap — just two .position.set calls. */
export function updateFogRing(playerPos) {
  if (!_ring || !playerPos) return;
  _ring.position.x = playerPos.x;
  _ring.position.z = playerPos.z;
  if (_outerCover) {
    _outerCover.position.x = playerPos.x;
    _outerCover.position.z = playerPos.z;
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
    _origFogNear = null;
    _origFogFar = null;
  }
}
