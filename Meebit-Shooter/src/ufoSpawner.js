// ufoSpawner.js — Alien UFO spawner alternative to the wasp-nest hive.
// Same contract as spawnPortal in spawners.js — returns a spawner-shape
// object the existing damageSpawner / updateSpawners / shield system
// drives without modification. Visible structure is a hovering flying
// saucer with a domed cockpit, a ring of underlights, and a tractor
// beam pulsing toward the ground.
//
// Used in chapters 2 and 5 (user-visible "Chapter 3 ALIEN" and
// "Chapter 6 ALIEN"). Dispatched from spawners.spawnPortal based on
// chapter index.
//
// Visual:
//   - Lower hull: shallow disc (wide flat saucer) — main bulk of the
//     UFO. Metallic, slightly emissive in the chapter tint.
//   - Upper hull: smaller disc on top of the lower one, gives the
//     classic stacked-saucer silhouette.
//   - Dome cockpit: glass hemisphere on top with a glowing core
//     visible inside (the "pilot light"). Emissive chapter tint —
//     this is the "crown" element that pulses on hit / under HP.
//   - Underlight ring: 8 chapter-tinted bulb lights spaced evenly
//     around the lower hull rim. These are the "eggs" — popping them
//     dims and removes lights one by one as the player damages the UFO.
//   - Tractor beam: translucent cone projecting from the underside
//     down to the ground. Pulses + slightly scrolls. Hit-effect
//     intensifies the beam briefly.
//   - Hover bob: per-frame Y oscillation handled by the existing
//     nestBody sway code in spawners.js updateSpawners() — the saucer
//     sits inside saucerBody (the "nestBody") and we add a Y offset.
//
// Contract returned (must match wasp-nest spawnPortal):
//   obj, pos, ring, core, orb, base, beam, coreMat, ringMat, baseMat,
//   nestBody, eggs[], eggsAlive, capMat, nestMat, nestOriginalColor,
//   hp, hpMax, hitFlash, spawnCooldown, enemiesAlive, destroyed, tint

import * as THREE from 'three';
import { scene } from './scene.js';
import { SPAWNER_CONFIG, HIVE_CONFIG, CHAPTERS } from './config.js';

// ---- Hull material constants ----
// Cool gunmetal — reads as fabricated craft, not organic. The chapter
// tint goes into emissive only so the silhouette stays neutral while
// underlights / dome / beam do the colored heavy lifting.
const _HULL_COLOR = 0x6a7280;
const _HULL_DARK_COLOR = 0x1a1c20;       // damage-darkening target

// ---- Shared geometry ----
// Lower hull — wide, shallow. CylinderGeometry with different top/bottom
// radii reads as a rounded saucer when viewed from any angle.
const _LOWER_HULL_GEO = new THREE.CylinderGeometry(2.6, 2.0, 0.55, 24);
// Upper hull — smaller disc that sits on top of the lower hull.
const _UPPER_HULL_GEO = new THREE.CylinderGeometry(1.6, 2.4, 0.45, 24);
// Dome — hemisphere on top of the upper hull. Half a sphere via
// the standard SphereGeometry phi/theta range trick.
const _DOME_GEO = new THREE.SphereGeometry(0.95, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2);
// Underlight bulb — small sphere positioned on the rim of the lower
// hull. Reused across all 8 lights.
const _LIGHT_GEO = new THREE.SphereGeometry(0.16, 10, 8);
// Light "cap" — small disc covering the bulb on intact lights. First
// hit shatters the cap, second hit pops the light. Mirrors the
// wasp-nest cap-then-egg progression so the same per-frame update
// loop drives both styles.
const _LIGHT_CAP_GEO = new THREE.CircleGeometry(0.20, 12);
// Tractor beam — narrow cone projecting downward from the saucer's
// underside to the floor. We construct it pointing in -Y so its tip
// is at the ground and base is at the saucer.
const _BEAM_GEO = new THREE.ConeGeometry(0.85, 2.1, 16, 1, true);

// Base disc — visual ground footprint of the tractor beam. Helps the
// player target where the saucer is hovering.
const _BASE_GEO = new THREE.CylinderGeometry(0.95, 1.05, 0.05, 16);

// Number of underlights around the rim.
const _LIGHT_COUNT = 8;

// Hover altitude — saucer center sits this high above the floor.
const _HOVER_Y = 2.3;

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
  // ground footprint. Tinted dim so it doesn't dominate; mostly
  // there to give the existing per-frame baseMat-emissive code
  // something to drive (matches wasp-nest base contract).
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x1a1c22, emissive: tint, emissiveIntensity: 0.4,
    roughness: 0.9, metalness: 0.1, transparent: true, opacity: 0.55,
    depthWrite: false,
  });
  const base = new THREE.Mesh(_BASE_GEO, baseMat);
  base.position.y = 0.04;
  base.receiveShadow = true;
  group.add(base);

  // Saucer body — hosts the entire flying craft. Position raises it
  // off the ground; per-frame sway from spawners.js updateSpawners
  // applies rotation to this group, which gives a natural-feeling
  // hover wobble.
  const saucerBody = new THREE.Group();
  saucerBody.position.y = _HOVER_Y;
  group.add(saucerBody);

  // Shared hull material — chapter-tinted emissive seam glow on
  // gunmetal. Damaged-darkening shrinks the color toward black as
  // HP drops via _updateHiveDamageColor in spawners.js.
  const hullMat = new THREE.MeshStandardMaterial({
    color: _HULL_COLOR,
    emissive: tint,
    emissiveIntensity: 0.30,
    roughness: 0.40,
    metalness: 0.85,
  });

  // Lower hull — main saucer disc.
  const lowerHull = new THREE.Mesh(_LOWER_HULL_GEO, hullMat);
  lowerHull.position.y = 0;
  lowerHull.castShadow = true;
  saucerBody.add(lowerHull);

  // Upper hull — smaller stacked disc.
  const upperHull = new THREE.Mesh(_UPPER_HULL_GEO, hullMat);
  upperHull.position.y = 0.5;
  saucerBody.add(upperHull);

  // Dome cockpit — emissive hemisphere on top. The chapter tint
  // makes it the brightest element on the UFO, so it doubles as
  // the "crown" the per-frame pulse drives.
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tint,
    emissiveIntensity: 2.2,
    roughness: 0.25,
    metalness: 0.15,
    transparent: true,
    opacity: 0.78,
  });
  const dome = new THREE.Mesh(_DOME_GEO, domeMat);
  dome.position.y = 0.72;
  saucerBody.add(dome);

  // Underlights — N bulbs evenly spaced around the lower hull rim.
  // These are the "eggs": popping a light dims and shrinks it,
  // visually peppering the UFO with knocked-out emitters as it
  // takes damage. Caps mirror the wasp-nest cap progression.
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tint,
    emissiveIntensity: 2.4,
    transparent: true,
    opacity: 0.92,
    roughness: 0.35,
  });
  const capMat = new THREE.MeshStandardMaterial({
    // Caps read as a metallic shutter over each light.
    color: 0x2a2c34,
    emissive: tint,
    emissiveIntensity: 0.5,
    roughness: 0.55,
    metalness: 0.85,
    side: THREE.DoubleSide,
  });

  const eggs = [];   // light "eggs" — see contract docs
  // Lower hull bottom radius is 2.0u; sit lights just inside that so
  // they hug the rim. Light center y = -0.18 puts them on the
  // underside lip of the lower disc.
  const RIM_R = 1.85;
  const RIM_Y = -0.18;
  for (let i = 0; i < _LIGHT_COUNT; i++) {
    const a = (i / _LIGHT_COUNT) * Math.PI * 2;
    const lx = Math.cos(a) * RIM_R;
    const lz = Math.sin(a) * RIM_R;
    const bulb = new THREE.Mesh(_LIGHT_GEO, lightMat);
    bulb.position.set(lx, RIM_Y, lz);
    bulb.userData.pulsePhase = Math.random() * Math.PI * 2;
    bulb.userData.outward = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    saucerBody.add(bulb);
    eggs.push(bulb);

    // Cap shutter — a small disc covering the bulb. First hit
    // shatters the cap, second hit pops the bulb. Cap is offset
    // slightly outward + downward so it lies tangent to the rim.
    const cap = new THREE.Mesh(_LIGHT_CAP_GEO, capMat);
    cap.position.set(
      Math.cos(a) * (RIM_R + 0.05),
      RIM_Y - 0.03,
      Math.sin(a) * (RIM_R + 0.05),
    );
    // Face the cap outward — it's a flat disc, so we orient its
    // local +Z to point along the outward radial direction.
    cap.lookAt(
      saucerBody.position.x + Math.cos(a) * 100,
      saucerBody.position.y + RIM_Y,
      saucerBody.position.z + Math.sin(a) * 100,
    );
    cap.userData.isCap = true;
    cap.userData.eggRef = bulb;
    saucerBody.add(cap);
    bulb.userData.cap = cap;
    bulb.userData.covered = true;
  }

  // Tractor beam — translucent cone from the saucer's underside
  // down to the floor. Cone built point-down already (we orient by
  // rotating the geometry), then positioned so the wide base sits
  // just under the lower hull and the tip touches the ground.
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
  // After rotation, cone tip is at +Y inside the geometry's local
  // frame — we want the WIDE base flush with the saucer underside
  // (y ≈ -0.28) and the tip touching the ground (y ≈ -_HOVER_Y).
  // Cone height is 2.1 so center sits at the midpoint of those.
  // Tip y = -_HOVER_Y, base y = -0.28; center y = -(_HOVER_Y + 0.28) / 2.
  beam.position.y = -(_HOVER_Y + 0.28) / 2;
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
    nestOriginalColor: new THREE.Color(_HULL_COLOR),
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
