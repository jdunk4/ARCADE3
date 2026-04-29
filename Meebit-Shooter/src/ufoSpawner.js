// ufoSpawner.js — Alien UFO spawner alternative to the wasp-nest hive.
// Same contract as spawnPortal in spawners.js — returns a spawner-shape
// object the existing damageSpawner / updateSpawners / shield system
// drives without modification.
//
// Used in chapters 2 and 5 (user-visible "Chapter 3 ALIEN" and
// "Chapter 6 ALIEN"). Dispatched from spawners.spawnPortal based on
// chapter index.
//
// HIGH-FIDELITY CONSTRUCTION
// --------------------------
// Stacked-disc silhouette built from many thin layers rather than
// two slabs, so the saucer reads as a fabricated multi-layer craft
// when the camera circles it. Working bottom-up:
//
//   • Underside lens     — flattened sphere segment giving the
//                          saucer a rounded belly instead of a flat
//                          base.
//   • Engine vent        — emissive recessed disc in the belly,
//                          driving a "downwash glow" that meshes
//                          with the tractor beam visually.
//   • Lower hull         — wide bevel ring + main saucer disc.
//   • Equator accent     — bright chapter-tinted band at the widest
//                          point. The single most colored element
//                          on the hull — like the cyan stripe in
//                          the reference image.
//   • Upper bevel        — beveled shoulder leading into the upper
//                          hull stack.
//   • Upper hull stack   — three stepped tiers of decreasing radius,
//                          each with its own thin trim ring on top,
//                          producing the reference's chunky
//                          terraced silhouette.
//   • Cockpit collar     — narrow ring around the dome base.
//   • Dome cockpit       — glass hemisphere + inner emissive core
//                          (the "pilot light") visible through it.
//   • Tech crown         — antenna mast + radar dish + a tip beacon
//                          on top of the dome.
//   • Side pods (eggs)   — N tinted orbs spaced around the upper
//                          hull's broadest tier. These are the
//                          gameplay "eggs" the player pops; placing
//                          them up here (vs underside as before)
//                          matches the reference image's prominent
//                          side bumps and reads from the player's
//                          eye-level camera angle.
//   • Underlight ring    — additional purely-decorative emissive
//                          dots under the rim, giving the underside
//                          its classic scrolling-light look without
//                          consuming gameplay eggs.
//   • Tractor beam       — translucent cone projecting from the
//                          underside down to the floor.
//   • Hover bob          — per-frame Y oscillation handled by the
//                          existing nestBody sway code in
//                          spawners.js updateSpawners().
//
// All chapter color goes into emissive accents (rim band, dome,
// pods, beacon, beam, vent, underlights). The hull itself stays
// gunmetal so the silhouette reads neutral and the colored
// elements pop — same approach as the reference photo.
//
// Contract returned (must match wasp-nest spawnPortal):
//   obj, pos, ring, core, orb, base, beam, coreMat, ringMat, baseMat,
//   nestBody, eggs[], eggsAlive, capMat, nestMat, nestOriginalColor,
//   hp, hpMax, hitFlash, spawnCooldown, enemiesAlive, destroyed, tint

import * as THREE from 'three';
import { scene } from './scene.js';
import { SPAWNER_CONFIG, HIVE_CONFIG, CHAPTERS } from './config.js';
import { getCrackTexture } from './spawnerFx.js';
import { hitBurst } from './effects.js';
import { spawnMushroomCloud } from './mushroomCloud.js';

// ---- Hull material constants ----
// Cool gunmetal — reads as fabricated craft, not organic. The chapter
// tint goes into emissive only so the silhouette stays neutral while
// the rim band / dome / pods / beam do the colored heavy lifting.
const _HULL_COLOR      = 0x6a7280;
const _HULL_DARK_COLOR = 0x1a1c20;       // damage-darkening target
const _TRIM_COLOR      = 0x3a3f48;       // darker trim for layer separation

// ---- Shared geometry ----
// Built once at module load, reused across every UFO instance.
//
// Bottom-up layer stack. Y values quoted are RELATIVE TO saucerBody
// origin (which itself sits at _HOVER_Y above the ground in the
// finished build).

// Underside lens — flattened bottom half-sphere giving the saucer a
// rounded belly. Radius slightly less than the lower-hull base so it
// nests up inside without protruding.
const _BELLY_GEO     = new THREE.SphereGeometry(1.95, 28, 12, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45);

// Engine vent in the belly — recessed emissive disc + two outer rings.
const _VENT_GEO       = new THREE.CircleGeometry(0.95, 24);
const _VENT_RING1_GEO = new THREE.RingGeometry(1.05, 1.18, 32);
const _VENT_RING2_GEO = new THREE.RingGeometry(1.30, 1.42, 36);

// Lower-hull bevel — thin tapered disc that connects the belly up
// to the main saucer disc.
const _LOWER_BEVEL_GEO = new THREE.CylinderGeometry(2.45, 2.05, 0.18, 32);
// Lower-hull main disc — the widest part of the saucer.
const _LOWER_HULL_GEO  = new THREE.CylinderGeometry(2.75, 2.55, 0.35, 36);

// Equator band — extruded ring at the saucer's widest point. Open
// cylinder (no caps) so it reads as a wraparound strip rather than
// a solid disc.
const _EQUATOR_BAND_GEO = new THREE.CylinderGeometry(2.82, 2.82, 0.16, 36, 1, true);

// Upper bevel — sloped shoulder leading from equator up to the upper
// hull stack.
const _UPPER_BEVEL_GEO = new THREE.CylinderGeometry(2.30, 2.65, 0.30, 32);

// Upper hull tiered stack — three thinning discs.
const _TIER1_GEO      = new THREE.CylinderGeometry(2.05, 2.25, 0.22, 32);
const _TIER1_TRIM_GEO = new THREE.CylinderGeometry(2.10, 2.10, 0.06, 32);
const _TIER2_GEO      = new THREE.CylinderGeometry(1.70, 1.95, 0.22, 32);
const _TIER2_TRIM_GEO = new THREE.CylinderGeometry(1.75, 1.75, 0.06, 30);
const _TIER3_GEO      = new THREE.CylinderGeometry(1.35, 1.65, 0.22, 28);
const _TIER3_TRIM_GEO = new THREE.CylinderGeometry(1.40, 1.40, 0.06, 28);

// Cockpit collar — thin emissive ring at dome base.
const _COLLAR_GEO    = new THREE.CylinderGeometry(1.02, 1.10, 0.10, 24);

// Dome cockpit — glass hemisphere on top.
const _DOME_GEO      = new THREE.SphereGeometry(0.95, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2);
// Inner pilot-light core — small bright sphere visible inside the
// translucent dome.
const _PILOT_GEO     = new THREE.SphereGeometry(0.32, 14, 10);

// Tech crown — radar dish, mast, sensor stubs, beacon at the apex.
const _MAST_GEO      = new THREE.CylinderGeometry(0.04, 0.06, 0.85, 8);
const _DISH_GEO      = new THREE.ConeGeometry(0.42, 0.12, 18, 1, true);
const _BEACON_GEO    = new THREE.SphereGeometry(0.10, 10, 8);
const _STUB_GEO      = new THREE.CylinderGeometry(0.025, 0.025, 0.32, 6);

// Side pods (eggs) — chapter-tinted spheres set into the upper hull
// tier 1 face. Hemispheres rather than full spheres because they
// look "set in" rather than glued on — the flat side faces inward.
const _POD_GEO       = new THREE.SphereGeometry(0.30, 14, 10);
// Pod cap — bevel ring sitting around each pod base, like a porthole
// frame. Doubles as the cap-shutter element the existing cap-shatter
// animation drives.
const _POD_CAP_GEO   = new THREE.RingGeometry(0.32, 0.42, 16);

// Decorative underlights — small dots set into the underside of
// the lower hull rim.
const _UNDERLIGHT_GEO = new THREE.SphereGeometry(0.08, 8, 6);

// Tractor beam — narrow cone projecting downward.
const _BEAM_GEO      = new THREE.ConeGeometry(0.95, 2.1, 18, 1, true);

// Base disc — visual ground footprint of the tractor beam.
const _BASE_GEO      = new THREE.CylinderGeometry(1.00, 1.10, 0.05, 18);

// Counts.
const _POD_COUNT        = 8;
const _UNDERLIGHT_COUNT = 12;

// Hover altitude — saucer center sits this high above the floor.
// Slightly higher than the previous build (was 2.3) to give the
// taller silhouette + tractor beam more room to breathe.
const _HOVER_Y = 2.6;

/**
 * Build a UFO spawner. Same call signature as spawnPortal; same
 * return shape so spawners.js / dormantProps.js / waves.js drive it
 * without knowing the difference.
 */
export function spawnUfoPortal(x, z, chapterIdx) {
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.lamp;
  const tintColor = new THREE.Color(tint);
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Base disc — flat circular tile under the hover beam, marking the
  // ground footprint. Tinted dim so it doesn't dominate.
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x1a1c22, emissive: tint, emissiveIntensity: 0.4,
    roughness: 0.9, metalness: 0.1, transparent: true, opacity: 0.55,
    depthWrite: false,
  });
  const base = new THREE.Mesh(_BASE_GEO, baseMat);
  base.position.y = 0.04;
  base.receiveShadow = true;
  group.add(base);

  // Saucer body — hosts the entire flying craft. Per-frame sway from
  // spawners.js updateSpawners() applies rotation to this group.
  const saucerBody = new THREE.Group();
  saucerBody.position.y = _HOVER_Y;
  group.add(saucerBody);

  // Shared hull material — chapter-tinted emissive seam glow on
  // gunmetal. Damage-darkening shrinks the color toward black as
  // HP drops via _updateHiveDamageColor in spawners.js.
  const hullMat = new THREE.MeshStandardMaterial({
    color: _HULL_COLOR,
    emissive: tint,
    emissiveIntensity: 0.25,
    roughness: 0.40,
    metalness: 0.85,
  });
  // Darker trim material — used for the bevel/shoulder discs and
  // mast/cross-arm bits to break up the silhouette and read as
  // separate plating layers.
  const trimMat = new THREE.MeshStandardMaterial({
    color: _TRIM_COLOR,
    emissive: tint,
    emissiveIntensity: 0.15,
    roughness: 0.55,
    metalness: 0.70,
  });

  // ---- BOTTOM-UP HULL CONSTRUCTION ----

  // Sheddable panel pieces — collected as we build. In the late
  // damage stage these break off one-by-one and tumble away. Order
  // chosen so the LEAST silhouette-defining pieces drop first
  // (trim caps, bevels) and the MAIN tiers stay attached longest.
  const sheddable = [];

  // Crack overlay material — one shared material whose opacity is
  // ramped per-frame by tickUfoDamage in spawners.js. Starts at
  // opacity 0 (invisible) and ramps to ~0.85 as HP drops. The same
  // crack texture is mapped to overlay meshes parented to each
  // major hull surface, sized 1.01× their host so they hover just
  // above the hull face without z-fighting.
  const crackTex = getCrackTexture();
  const crackMat = new THREE.MeshBasicMaterial({
    map: crackTex,
    alphaMap: crackTex,
    color: 0x000000,        // black cracks read clearly on metallic gunmetal
    transparent: true,
    opacity: 0,             // ramped by tickUfoDamage
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  // Helper: attach a crack overlay as a child of a hull mesh,
  // scaled slightly larger so it sits just outside the surface.
  // Uses the same geometry as the host (cheap, exact silhouette
  // match) and the shared crackMat (one opacity update covers all).
  function _addCrack(host, scale = 1.012) {
    const overlay = new THREE.Mesh(host.geometry, crackMat);
    overlay.scale.setScalar(scale);
    host.add(overlay);
    return overlay;
  }

  // Belly lens — rounded underside.
  const belly = new THREE.Mesh(_BELLY_GEO, hullMat);
  belly.position.y = -0.18;
  belly.castShadow = true;
  saucerBody.add(belly);
  _addCrack(belly);

  // Engine vent + inner glow rings on the underside center. Additive
  // blending against the dim underside for a self-illuminated appearance
  // even when ambient lighting is dark.
  const ventMat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const vent = new THREE.Mesh(_VENT_GEO, ventMat);
  vent.position.y = -1.15;
  vent.rotation.x = Math.PI / 2;     // face downward
  saucerBody.add(vent);

  const ventRingMat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const ventRing1 = new THREE.Mesh(_VENT_RING1_GEO, ventRingMat);
  ventRing1.position.y = -1.13;
  ventRing1.rotation.x = -Math.PI / 2;
  saucerBody.add(ventRing1);

  const ventRing2 = new THREE.Mesh(_VENT_RING2_GEO, ventRingMat);
  ventRing2.position.y = -1.10;
  ventRing2.rotation.x = -Math.PI / 2;
  saucerBody.add(ventRing2);

  // Lower hull bevel — sits between belly and main disc.
  const lowerBevel = new THREE.Mesh(_LOWER_BEVEL_GEO, trimMat);
  lowerBevel.position.y = -0.40;
  saucerBody.add(lowerBevel);

  // Lower hull main disc — the widest part of the saucer.
  const lowerHull = new THREE.Mesh(_LOWER_HULL_GEO, hullMat);
  lowerHull.position.y = -0.18;
  lowerHull.castShadow = true;
  saucerBody.add(lowerHull);
  _addCrack(lowerHull);

  // Equator accent band — chapter-tinted bright ring at saucer's
  // widest point. The main color element on the silhouette.
  const equatorMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tint,
    emissiveIntensity: 1.8,
    roughness: 0.30,
    metalness: 0.30,
  });
  const equator = new THREE.Mesh(_EQUATOR_BAND_GEO, equatorMat);
  equator.position.y = 0.0;
  saucerBody.add(equator);

  // Upper bevel — shoulder above the equator.
  const upperBevel = new THREE.Mesh(_UPPER_BEVEL_GEO, trimMat);
  upperBevel.position.y = 0.20;
  saucerBody.add(upperBevel);

  // Upper hull stack — three stepped tiers + trim caps.
  const tier1 = new THREE.Mesh(_TIER1_GEO, hullMat);
  tier1.position.y = 0.45;
  tier1.castShadow = true;
  saucerBody.add(tier1);
  _addCrack(tier1);
  const tier1Trim = new THREE.Mesh(_TIER1_TRIM_GEO, trimMat);
  tier1Trim.position.y = 0.59;
  saucerBody.add(tier1Trim);
  sheddable.push(tier1Trim);

  const tier2 = new THREE.Mesh(_TIER2_GEO, hullMat);
  tier2.position.y = 0.73;
  saucerBody.add(tier2);
  _addCrack(tier2);
  const tier2Trim = new THREE.Mesh(_TIER2_TRIM_GEO, trimMat);
  tier2Trim.position.y = 0.87;
  saucerBody.add(tier2Trim);
  sheddable.push(tier2Trim);

  const tier3 = new THREE.Mesh(_TIER3_GEO, hullMat);
  tier3.position.y = 1.00;
  saucerBody.add(tier3);
  _addCrack(tier3);
  const tier3Trim = new THREE.Mesh(_TIER3_TRIM_GEO, trimMat);
  tier3Trim.position.y = 1.14;
  saucerBody.add(tier3Trim);
  sheddable.push(tier3Trim);

  // Cockpit collar — narrow ring at dome base.
  const collarMat = new THREE.MeshStandardMaterial({
    color: 0x1a1c22,
    emissive: tint,
    emissiveIntensity: 1.0,
    roughness: 0.45,
    metalness: 0.55,
  });
  const collar = new THREE.Mesh(_COLLAR_GEO, collarMat);
  collar.position.y = 1.22;
  saucerBody.add(collar);

  // Dome cockpit — translucent glass hemisphere. Dome is the "crown"
  // element the per-frame pulse drives via .core/.ring/.orb aliases.
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tint,
    emissiveIntensity: 2.2,
    roughness: 0.20,
    metalness: 0.10,
    transparent: true,
    opacity: 0.55,           // more transparent so the pilot core shows through
  });
  const dome = new THREE.Mesh(_DOME_GEO, domeMat);
  dome.position.y = 1.30;
  saucerBody.add(dome);

  // Pilot-light core — bright emissive sphere visible inside the
  // dome. Reads as a glass canopy with someone home.
  const pilotMat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const pilot = new THREE.Mesh(_PILOT_GEO, pilotMat);
  pilot.position.y = 1.55;     // floats inside the dome
  saucerBody.add(pilot);

  // ---- TECH CROWN ----

  // Radar dish — open cone facing up around the mast base.
  const dish = new THREE.Mesh(_DISH_GEO, trimMat);
  dish.position.y = 2.13;
  dish.rotation.x = Math.PI;     // flip so cone wide end points down
  saucerBody.add(dish);
  sheddable.push(dish);

  // Mast.
  const mast = new THREE.Mesh(_MAST_GEO, trimMat);
  mast.position.y = 2.55;
  saucerBody.add(mast);
  sheddable.push(mast);

  // Two perpendicular cross-arms ~2/3 up the mast — sensor stubs.
  const stub1 = new THREE.Mesh(_STUB_GEO, trimMat);
  stub1.position.y = 2.45;
  stub1.rotation.z = Math.PI / 2;     // horizontal
  saucerBody.add(stub1);
  sheddable.push(stub1);
  const stub2 = new THREE.Mesh(_STUB_GEO, trimMat);
  stub2.position.y = 2.55;
  stub2.rotation.x = Math.PI / 2;     // perpendicular to stub1
  saucerBody.add(stub2);
  sheddable.push(stub2);

  // Tip beacon.
  const beaconMat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const beacon = new THREE.Mesh(_BEACON_GEO, beaconMat);
  beacon.position.y = 3.00;
  saucerBody.add(beacon);

  // ---- SIDE PODS (gameplay eggs) ----
  // Set into tier 1's face. Each pod is a tinted sphere capped by
  // a porthole-frame ring. spawners.js's existing per-frame egg
  // tick drives pulse animation, pop shrink/fade, and cap shatter
  // exactly as it does for wasp-nest eggs.

  const podMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tint,
    emissiveIntensity: 2.4,
    transparent: true,
    opacity: 0.92,
    roughness: 0.30,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: 0x2a2c34,
    emissive: tint,
    emissiveIntensity: 0.6,
    roughness: 0.55,
    metalness: 0.85,
    side: THREE.DoubleSide,
  });

  const eggs = [];   // gameplay eggs — see contract docs in spawners.js
  // Place pods at tier 1 outer radius, just above equator.
  const POD_R = 2.18;
  const POD_Y = 0.45;
  for (let i = 0; i < _POD_COUNT; i++) {
    const a = (i / _POD_COUNT) * Math.PI * 2;
    const lx = Math.cos(a) * POD_R;
    const lz = Math.sin(a) * POD_R;
    const pod = new THREE.Mesh(_POD_GEO, podMat);
    pod.position.set(lx, POD_Y, lz);
    pod.userData.pulsePhase = Math.random() * Math.PI * 2;
    // outward direction used by spawners.js cap-shatter physics.
    pod.userData.outward = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    saucerBody.add(pod);
    eggs.push(pod);

    // Porthole frame — flat ring tangent to the hull face. Sits a
    // hair outside the pod so the ring perimeter shows around it.
    const cap = new THREE.Mesh(_POD_CAP_GEO, capMat);
    cap.position.set(
      Math.cos(a) * (POD_R + 0.04),
      POD_Y,
      Math.sin(a) * (POD_R + 0.04),
    );
    cap.lookAt(
      saucerBody.position.x + Math.cos(a) * 100,
      saucerBody.position.y + POD_Y,
      saucerBody.position.z + Math.sin(a) * 100,
    );
    cap.userData.isCap = true;
    cap.userData.eggRef = pod;
    saucerBody.add(cap);
    pod.userData.cap = cap;
    pod.userData.covered = true;
  }

  // ---- DECORATIVE UNDERLIGHTS ----
  // Small chapter-tinted dots circling the underside of the lower
  // hull rim. Not gameplay eggs — they don't get popped, just
  // visual underside detail. Static emissive (no animation) — the
  // equator band, dome, beam, and pod pulses are already animated;
  // a fourth animated layer would be noisy.
  const underlightMat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const UNDER_R = 2.50;
  const UNDER_Y = -0.36;
  for (let i = 0; i < _UNDERLIGHT_COUNT; i++) {
    const a = (i / _UNDERLIGHT_COUNT) * Math.PI * 2;
    const dot = new THREE.Mesh(_UNDERLIGHT_GEO, underlightMat);
    dot.position.set(Math.cos(a) * UNDER_R, UNDER_Y, Math.sin(a) * UNDER_R);
    saucerBody.add(dot);
  }

  // ---- TRACTOR BEAM ----
  // Translucent cone from the saucer's underside down to the floor.
  const beamMat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    opacity: 0.32,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const beam = new THREE.Mesh(_BEAM_GEO, beamMat);
  // Default cone points +Y; rotate so it points -Y (downward).
  beam.rotation.x = Math.PI;
  // After rotation, cone tip is at +Y in geometry's local frame —
  // we want the WIDE base flush with the belly underside (y ≈ -1.20)
  // and the tip touching the ground (y ≈ -_HOVER_Y = -2.6).
  // Cone height is 2.1 so center sits at the midpoint of those.
  beam.position.y = -(_HOVER_Y + 1.20) / 2 + 0.55;
  saucerBody.add(beam);

  scene.add(group);

  return {
    obj: group,
    pos: group.position,
    // Compatibility aliases — existing update code references these
    // by name. Point them at UFO equivalents so the per-frame pulse
    // and hit-flash code drives the dome emissive uniformly across
    // all spawner types without spawners.js needing to branch.
    ring: dome,
    core: dome,
    orb: dome,
    base,
    beam,
    coreMat: dome.material,
    ringMat: dome.material,
    baseMat: base.material,
    // Reuse the wasp-nest field names so spawners.js updateSpawners
    // drives sway / egg pop / damage-darkening identically.
    nestBody: saucerBody,
    eggs,
    eggsAlive: eggs.length,
    capMat,
    nestMat: hullMat,
    // UFOs use crack overlays + panel-shedding instead of color
    // darkening — _updateHiveDamageColor early-returns when
    // nestOriginalColor is null. tickUfoDamage in spawners.js
    // drives the crack and shed FX from the same per-hit path.
    nestOriginalColor: null,
    // UFO-specific FX state — read by tickUfoDamage in spawners.js.
    crackMat,                       // shared overlay; opacity ramps with damage
    sheddable,                      // ordered list of detachable trim pieces
    shedNext: 0,                    // index into sheddable; advances on milestone
    shedFlying: [],                 // pieces currently airborne after detach
    spinAccum: 0,                   // accumulated rotation.y, for damage-driven spin
    hp: SPAWNER_CONFIG.spawnerHp || 180,
    hpMax: SPAWNER_CONFIG.spawnerHp || 180,
    hitFlash: 0,
    spawnCooldown: 0.5 + Math.random() * HIVE_CONFIG.spawnIntervalSec,
    enemiesAlive: 0,
    destroyed: false,
    tint,
    structureType: 'ufo',
  };
}

// =====================================================================
// UFO-SPECIFIC DAMAGE FX
// =====================================================================
// Called every frame from spawners.js updateSpawners() for any spawner
// with structureType === 'ufo'. Drives:
//   - Damage-driven spin: rotation rate ramps from 0 at full HP to
//     ~3 rad/sec at 0 HP. The saucer wobbles as it spins via the
//     existing sway tick (which is also dt-scaled), so the two read
//     as a coherent destabilization.
//   - Crack opacity: ramps from 0 (full HP) to 0.85 (0 HP) so the
//     hull progressively shows damage instead of darkening.
//   - Panel shedding: at HP < 60% / 40% / 20%, one trim piece detaches
//     and tumbles away. Pieces fall on a parabolic arc and disappear
//     after ~1.4s.
//
// Caller passes the current HP ratio (0..1) so we don't recompute it.
// dt is per-frame seconds.
export function tickUfoDamage(s, dt, ratio) {
  if (!s || s.destroyed) return;

  // Spin rate ramps quadratically — gentle at first, dramatic near death.
  const dmg = 1 - ratio;
  const spinRate = dmg * dmg * 3.0;     // 0..3 rad/sec
  if (s.nestBody) {
    s.spinAccum = (s.spinAccum || 0) + spinRate * dt;
    s.nestBody.rotation.y = s.spinAccum;
  }

  // Crack opacity ramp. Hold at 0 for the first 20% of damage so an
  // intact-looking UFO doesn't show fake cracks; ramp linearly after.
  if (s.crackMat) {
    const crackStart = 0.20;            // start cracking after 20% damage
    const crackProg = Math.max(0, (dmg - crackStart) / (1 - crackStart));
    s.crackMat.opacity = crackProg * 0.85;
  }

  // Milestone shedding — drop a trim piece each time HP crosses
  // 60% / 40% / 20%. Sheddable list ordered LEAST→MOST silhouette-
  // important, so dish + stubs go first, trim caps follow.
  const milestones = [0.6, 0.4, 0.2];
  while (
    s.sheddable && s.shedNext < s.sheddable.length &&
    s.shedNext < milestones.length &&
    ratio <= milestones[s.shedNext]
  ) {
    _shedNextPanel(s);
    s.shedNext++;
  }

  // Tick airborne pieces — parabolic fall + tumble + opacity fade.
  if (s.shedFlying && s.shedFlying.length) {
    for (let i = s.shedFlying.length - 1; i >= 0; i--) {
      const p = s.shedFlying[i];
      p.t += dt;
      // Position update — initial velocity + gravity.
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy -= 12 * dt;                  // gravity
      p.mesh.rotation.x += p.spinX * dt;
      p.mesh.rotation.z += p.spinZ * dt;
      if (p.t > 1.4) {
        if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
        s.shedFlying.splice(i, 1);
      }
    }
  }
}

// Detach the next sheddable piece, fling it outward + upward, and add
// it to the airborne list for the per-frame tick to manage. Reparents
// the piece from saucerBody to the parent group so it falls in world
// space without inheriting the saucer's spin.
function _shedNextPanel(s) {
  const piece = s.sheddable[s.shedNext];
  if (!piece) return;
  // Compute current world position before reparenting so we can
  // preserve continuity.
  const wpos = new THREE.Vector3();
  piece.getWorldPosition(wpos);
  const wquat = new THREE.Quaternion();
  piece.getWorldQuaternion(wquat);
  // Detach from saucerBody, attach to the spawner's outer group so
  // gravity acts in world space.
  if (piece.parent) piece.parent.remove(piece);
  piece.position.copy(wpos);
  piece.quaternion.copy(wquat);
  s.obj.add(piece);
  // Velocity: outward radial component + upward kick + small random
  // tangential.
  const dx = wpos.x - s.pos.x;
  const dz = wpos.z - s.pos.z;
  const r = Math.sqrt(dx * dx + dz * dz) || 1;
  const ox = dx / r, oz = dz / r;
  const tangX = -oz, tangZ = ox;
  const rec = {
    mesh: piece,
    t: 0,
    vx: ox * 4 + tangX * (Math.random() - 0.5) * 3,
    vy: 4 + Math.random() * 2,
    vz: oz * 4 + tangZ * (Math.random() - 0.5) * 3,
    spinX: (Math.random() - 0.5) * 12,
    spinZ: (Math.random() - 0.5) * 12,
  };
  s.shedFlying.push(rec);
  // Visual feedback at the detach point — a small spark burst in the
  // chapter tint.
  hitBurst(wpos, s.tint, 6);
  hitBurst(wpos, 0xffffff, 3);
}

// =====================================================================
// UFO DESTRUCTION — bigger explosion than the wasp-nest variant +
// animated mushroom cloud rising from the ground. The standard
// collapse animation in spawners.js takes the saucer body away over
// ~0.17s, which times perfectly with the cloud's flash phase so the
// cloud reads as consuming/replacing the saucer. The cloud itself
// then runs for ~3.8s on its own lifecycle.
// Called from destroySpawner in spawners.js when structureType==='ufo'.
// =====================================================================
export function explodeUfo(s) {
  if (!s) return;
  // Center of the saucer body in world space — slightly higher than
  // the standard hive explosion (UFOs hover at _HOVER_Y).
  const pos = new THREE.Vector3(s.pos.x, _HOVER_Y, s.pos.z);
  // Multi-stage explosion — bigger than the default destroySpawner
  // burst because we asked for it. Three burst layers fired in
  // quick succession read as a coherent fireball.
  hitBurst(pos, 0xffffff, 60);
  hitBurst(pos, s.tint, 50);
  setTimeout(() => hitBurst(pos, 0xffaa00, 40), 60);
  setTimeout(() => hitBurst(pos, 0xff5520, 32), 130);
  setTimeout(() => hitBurst(pos, 0xff3cac, 24), 220);

  // Mushroom cloud — spawned at GROUND level (not hover level) so
  // the stem rises naturally from the floor. The cloud is its own
  // free-standing scene object with an independent ~3.8s lifecycle
  // (ticked by updateMushroomClouds() in spawners.js); it survives
  // long after the saucer's collapse animation removes the body
  // from the scene.
  const groundPos = new THREE.Vector3(s.pos.x, 0, s.pos.z);
  try { spawnMushroomCloud(groundPos, s.tint); } catch (e) { console.warn('[ufo cloud]', e); }

  // Shed every remaining trim piece on death so the explosion has
  // visible debris.
  if (s.sheddable && s.shedNext < s.sheddable.length) {
    while (s.shedNext < s.sheddable.length) {
      _shedNextPanel(s);
      s.shedNext++;
    }
  }
}
