// shieldShader.js — TSL-based animated shield, ported from the
// Three.js Journey "shield" lesson asset. Uses three/tsl nodes
// for an animated hex pattern, Fresnel rim, and 5 simultaneous
// impact ripples that propagate as 3D distance fields from the
// impact point.
//
// Public API:
//   loadShieldTexture()        → Promise (kicks off lazy load)
//   isShieldTextureLoaded()    → boolean
//   buildShield(tintHex, opts) → { mesh, impacts: { add, ... } } | null
//                                 returns null if texture not loaded
//   updateShieldsTick(dt)      → called once per frame from main.js
//
// Each impact:
//   shield.impacts.add(worldPos, radius=1)
// schedules a GSAP-replacement animation that ramps the impact
// radius up to `radius` in 0.10s, then back to 0 over 1s.

import * as THREE from 'three';
import {
  dot, float, Fn, positionLocal, texture, uniform, uv, vec2,
  time, TWO_PI, mul, normalView, uniformArray, Loop, max,
  positionWorld, add, color, mix, positionViewDirection,
} from 'three/tsl';
import { scene } from './scene.js';

// positionViewDirection is exported from three/tsl in three.js 0.184+.
// If you upgrade to a different version where the export name has
// changed, replace this with: dot(normalView, vec3(0,0,1)).abs().oneMinus()
// as a Fresnel approximation that doesn't depend on the missing export.
const _positionViewDirection = positionViewDirection;

const HEX_TEXTURE_URL = 'assets/shield/hexagons.png';

// ---- Texture loader (lazy, cached) ----
let _hexTexture = null;
let _hexLoadPromise = null;
let _hexLoadFailed = false;

export function loadShieldTexture() {
  if (_hexLoadPromise) return _hexLoadPromise;
  const loader = new THREE.TextureLoader();
  _hexLoadPromise = new Promise((resolve) => {
    loader.load(
      HEX_TEXTURE_URL,
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        _hexTexture = tex;
        console.log('[shieldShader] hex texture loaded');
        resolve();
      },
      undefined,
      (err) => {
        console.warn('[shieldShader] hex texture failed to load', err);
        _hexLoadFailed = true;
        resolve();
      }
    );
  });
  return _hexLoadPromise;
}

export function isShieldTextureLoaded() {
  return !!_hexTexture && !_hexLoadFailed;
}

// ---- Active shields tracking (for impact animations) ----
// Each entry: { impacts: [{ x, y, z, w, target, phase, t0 }, ...] }
// where phase is 'rampup' | 'rampdown' | 'idle'.
const _activeShields = [];

export function updateShieldsTick(dt) {
  // Walk active shields; advance any ramping impacts.
  for (const sh of _activeShields) {
    for (const imp of sh.impacts) {
      if (imp.phase === 'rampup') {
        imp.t0 += dt;
        const u = Math.min(1, imp.t0 / 0.10);
        // Ease-out (power2.out equivalent): 1 - (1-u)^2
        const e = 1 - (1 - u) * (1 - u);
        imp.w = imp.target * e;
        if (u >= 1) {
          imp.phase = 'rampdown';
          imp.t0 = 0;
        }
      } else if (imp.phase === 'rampdown') {
        imp.t0 += dt;
        const u = Math.min(1, imp.t0 / 1.0);
        // Ease-in (power2.in equivalent): u^2
        const e = u * u;
        imp.w = imp.target * (1 - e);
        if (u >= 1) {
          imp.phase = 'idle';
          imp.w = 0;
        }
      }
      // Push the latest values into the uniform array entry.
      // The Vector4 in the uniform array is shared by reference, so
      // mutating its properties propagates to the shader on next render.
      imp.uniformVec.x = imp.x;
      imp.uniformVec.y = imp.y;
      imp.uniformVec.z = imp.z;
      imp.uniformVec.w = imp.w;
    }
  }
}

// ---- Shield builder ----
//
// tintHex: chapter-tint hex int (e.g. 0xff2e4d for chapter 2 crimson)
// opts.radius: world-space radius of the shield sphere (default 3.8 — matches our existing shield geo)
// opts.strength: emissive strength multiplier (default 7 — matches the asset's default)
//
// Returns null if the hex texture hasn't loaded yet — caller falls
// back to the existing buildShieldMaterials path.
export function buildShield(tintHex, opts = {}) {
  if (!_hexTexture) return null;

  const radius = opts.radius ?? 3.8;
  const strength = opts.strength ?? 7;

  // Derive the two-color palette from the single chapter tint.
  // colorA = the tint itself (used at low emissive strength = mid surface)
  // colorB = the tint pushed bright toward white (used at high emissive
  //          strength = the rim halo + impact peaks)
  // The mix() in the shader interpolates A→B based on emissiveStrength.
  const tintColorA = new THREE.Color(tintHex);
  const tintColorB = new THREE.Color(tintHex).lerp(new THREE.Color(0xffffff), 0.45);

  // ---- Uniforms ----
  const uRadius = uniform(radius);
  const uColorA = uniform(color(tintColorA.getHex()));
  const uColorB = uniform(color(tintColorB.getHex()));
  const uStrength = uniform(strength);

  // ---- Impact uniform array (5 slots) ----
  const IMPACT_COUNT = 5;
  const impactData = [];
  for (let i = 0; i < IMPACT_COUNT; i++) {
    impactData.push(new THREE.Vector4(0, 0, 0, 0));
  }
  const impactsUniform = uniformArray(impactData, 'vec4');

  // ---- Material (TSL node-based) ----
  // Black base color; the visible color comes entirely from the
  // emissive node (so additive blending makes the shield glow).
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    color: 0x000000,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });
  // positionNode scales the unit sphere geometry up to `radius`. Lets
  // us reuse one shared SphereGeometry(1,...,...) across all shields.
  mat.positionNode = positionLocal.mul(uRadius);

  // Emissive node — the heart of the asset. Computes per-pixel:
  //   1. Impact field — max distance-falloff from any of the 5 impacts
  //   2. Fresnel — bright at silhouette edges
  //   3. Hexagons — animated pulsing pattern from the texture's R/G/B channels
  //   4. Lines — vertical scrolling stripes for that "energy field" feel
  // Then mixes colorA→colorB based on combined emissive strength.
  const hexTex = _hexTexture;
  mat.emissiveNode = Fn(() => {
    // ----- Impact field -----
    // Loop over all 5 impact slots; for each, compute distance
    // from the fragment position to the impact center, subtract
    // from the impact's current radius (.w), max with 0 for the
    // "is this fragment inside the ripple" mask. Take the max
    // across all impacts so multiple simultaneous hits accumulate
    // at their peaks rather than averaging out.
    const finalImpact = float(0).toVar();
    Loop(IMPACT_COUNT, ({ i }) => {
      const data = impactsUniform.element(i);
      const d = data.xyz.distance(positionLocal);
      const inside = data.w.sub(d).max(0);
      finalImpact.assign(max(finalImpact, inside));
    });
    // Remap the impact value: ramp from 0..0.4 of the in-bound
    // value up to a 0..1 brightness, so impacts read as a sharp
    // pulse rather than a soft wash.
    finalImpact.assign(finalImpact.remap(0.4, 0, 1, 0));

    // ----- Fresnel (rim) -----
    // |dot(viewDir, normal)| at silhouette = 0 → fresnel = 1.
    // We use positionViewDirection if available; otherwise
    // approximate via 1 - dot(normalView, vec3(0,0,1)).
    let fresnel;
    if (_positionViewDirection) {
      fresnel = dot(_positionViewDirection, normalView).abs().oneMinus();
    } else {
      // Approximation: assumes camera looks down -Z in view space,
      // so the view direction at the fragment is roughly +Z. Less
      // accurate at extreme angles but doesn't crash if positionViewDirection
      // isn't exported in this three version.
      fresnel = normalView.z.abs().oneMinus();
    }

    // ----- Hexagons -----
    // Sample the data-encoded hex texture. Channels carry:
    //   R = base hex glow brightness (0 in centers, 1 at edges)
    //   G = per-hex phase offset (used as time bias for pulse)
    //   B = per-hex "this hex is filled" mask
    // UV is multiplied by (6,4) so 6 hexes appear horizontally, 4 vertically.
    const hexColor = texture(hexTex, uv().mul(vec2(6, 4)));
    // Animated pulse: each hex pulses at a different time based on
    // its G-channel offset. sin(time + G*2π) gives per-hex sine wave.
    // Remap from [-1,1] to [0,1] for blending.
    const hexStep = max(
      time.add(hexColor.g.mul(TWO_PI)).sin().remap(-1, 1, 0, 1),
      finalImpact
    );
    // Mask: only show this hex if its R brightness exceeds the pulse
    // threshold. step(threshold, value) returns 1 if value > threshold.
    const hexMask = hexStep.step(hexColor.r);
    // Polar fade: hexes near the top/bottom poles of the sphere
    // distort hard due to UV pinching, so we fade them out above v=0.85
    // and below v=0.15. remapClamp from 0.35..0.2 gives a soft edge.
    const polarFade = uv().y.sub(0.5).abs().remapClamp(0.35, 0.2);
    // Fresnel modulator — hexes brighter at silhouette + during impact.
    const fresnelFade = max(fresnel.pow(2), finalImpact);
    // Final hex contribution: layered multiplication of all the modulators.
    const hexFill = max(hexColor.r, finalImpact);
    const hexagons = mul(
      hexMask,
      hexColor.b,
      polarFade,
      fresnelFade,
      hexFill
    );

    // ----- Vertical scrolling lines -----
    // Adds a subtle "energy" feel — bright stripes scroll up the
    // shield. positionWorld.y * 20 + time gives the stripe pattern,
    // .fract().pow(3) makes them sharp + fast-moving.
    const linesStrength = positionWorld.y
      .mul(3).sub(time).sin().remap(-1, 1).mul(0.05);
    const lines = positionWorld.y
      .mul(20).add(time).fract().pow(3).mul(linesStrength);

    // ----- Combine -----
    const emissiveStrength = add(
      hexagons,
      fresnel.pow(5),
      lines
    ).mul(uStrength);
    // Color: at low strength the surface is colorA (tint), at high
    // strength (rim + impacts) it shifts toward colorB (brighter / whiter).
    // Then multiply BY emissiveStrength so unlit areas are dark.
    return mix(uColorA, uColorB, emissiveStrength).mul(emissiveStrength);
  })();

  // ---- Mesh ----
  // Shared SphereGeometry — radius=1, scaled up by the positionNode.
  // 32×32 segments matches the asset; gives smooth silhouette + enough
  // UV resolution for the hex texture to look crisp.
  const geo = new THREE.SphereGeometry(1, 32, 32);
  const mesh = new THREE.Mesh(geo, mat);

  // ---- Impact API ----
  let impactIndex = 0;
  const impactSlots = impactData.map((vec, i) => ({
    x: 0, y: 0, z: 0, w: 0,
    target: 1,
    phase: 'idle',
    t0: 0,
    uniformVec: vec,        // shared reference into the uniform array
  }));

  // Track this shield in the global active list so updateShieldsTick
  // can advance impact animations.
  const tracker = { impacts: impactSlots };
  _activeShields.push(tracker);

  function addImpact(worldPos, impactRadius = 1) {
    // Convert world position to mesh-local. The asset uses
    // `mesh.worldToLocal(position)` — same here. Mesh must already
    // be in the scene with up-to-date matrices when this is called;
    // for safety we update matrices first.
    mesh.updateMatrixWorld(true);
    const local = mesh.worldToLocal(worldPos.clone ? worldPos.clone() : worldPos);
    const slot = impactSlots[impactIndex];
    slot.x = local.x;
    slot.y = local.y;
    slot.z = local.z;
    slot.target = impactRadius;
    slot.phase = 'rampup';
    slot.t0 = 0;
    impactIndex = (impactIndex + 1) % IMPACT_COUNT;
  }

  return {
    mesh,
    material: mat,
    radius: uRadius,
    strength: uStrength,
    colorA: uColorA,
    colorB: uColorB,
    impacts: { add: addImpact, slots: impactSlots },
    // Internal: the tracker reference, used by dispose() to remove
    // the shield from the active list when it's torn down.
    _tracker: tracker,
  };
}

// Tear down a shield built via buildShield(). Call when the shield
// is destroyed so we don't keep ticking dead impact animations.
export function disposeShield(shieldHandle) {
  if (!shieldHandle) return;
  const idx = _activeShields.indexOf(shieldHandle._tracker);
  if (idx >= 0) _activeShields.splice(idx, 1);
  if (shieldHandle.mesh) {
    if (shieldHandle.mesh.parent) shieldHandle.mesh.parent.remove(shieldHandle.mesh);
    if (shieldHandle.mesh.geometry) shieldHandle.mesh.geometry.dispose();
  }
  if (shieldHandle.material) shieldHandle.material.dispose();
}
