// pyramidSpawner.js — Cursed pyramid spawner alternative to the wasp-nest
// hive. Same contract as spawnPortal in spawners.js (returns an object
// the existing damageSpawner / updateSpawners / shield system can drive
// without modification) but the visible structure is a stepped stone
// pyramid topped by a glyph obelisk.
//
// Used in chapters 1 and 4 (user-visible "Chapter 2 CURSED" and
// "Chapter 5 CURSED"). Dispatched from spawners.spawnPortal based on
// chapter index.
//
// Visual:
//   - Stepped stone base: 6 levels of square stones, each step smaller
//     than the one below. Cracked dark stone material with a faint
//     warm emissive at the seams (the curse leaking through).
//   - Glyph plates: square inset panels on the faces of each step.
//     Chapter-tinted runes embossed on them. These are the "eggs" —
//     popping them shatters the rune glyph off the face.
//   - Obelisk capstone: tall narrow pyramid sitting on the top step,
//     emissive chapter-tint cap (the cursed eye/sigil). This is the
//     "crown" that pulses faster as HP drops.
//   - Base disc: a circular ground tile under the pyramid suggesting
//     the structure's foundation.
//
// Contract returned (must match wasp-nest spawnPortal):
//   obj, pos, ring, core, orb, base, beam, coreMat, ringMat, baseMat,
//   nestBody, eggs[], eggsAlive, capMat, nestMat, nestOriginalColor,
//   hp, hpMax, hitFlash, spawnCooldown, enemiesAlive, destroyed, tint

import * as THREE from 'three';
import { scene } from './scene.js';
import { SPAWNER_CONFIG, HIVE_CONFIG, CHAPTERS } from './config.js';

// ---- Stone material constants ----
// Dark stone with a faint warm undertone — reads as ancient weathered
// rock. The emissive seam color is the chapter tint (set per spawner)
// so the curse leaks through cracks in the chapter's own palette.
const _STONE_COLOR = 0x4a3e34;
const _STONE_EMISSIVE = 0x180c04;        // dim warm baseline before tint adds
const _STONE_DARK_COLOR = 0x1a1410;       // damage-darkening target

// ---- Shared geometry singletons ----
// Step blocks — square plinths. We allocate ONE BoxGeometry per step
// level since each level has a distinct size; reused across hives.
const _STEP_GEOMS = (() => {
  const out = [];
  // 6 steps; widest at the bottom (3.4u), narrowest near top (1.0u).
  // Heights are 0.5u each for a stout silhouette.
  const widths = [3.4, 2.9, 2.4, 1.9, 1.4, 1.0];
  for (let i = 0; i < widths.length; i++) {
    out.push(new THREE.BoxGeometry(widths[i], 0.5, widths[i]));
  }
  return out;
})();
// Obelisk geometry — narrow tall pyramid (4-sided cone) sitting on
// the top step. Reads as the "spire" of the structure.
const _OBELISK_GEO = new THREE.ConeGeometry(0.5, 1.6, 4);
// Glyph plate — small flat square inset on the step faces.
const _GLYPH_GEO = new THREE.PlaneGeometry(0.40, 0.40);
// Glyph "cap" — slightly raised bump on top of the plate that
// shatters off when the glyph takes damage. Same plate shape, just
// offset outward so it visually peels.
const _GLYPH_CAP_GEO = new THREE.PlaneGeometry(0.44, 0.44);

// Base disc — wider than the bottom step, sits at ground level.
const _BASE_GEO = new THREE.CylinderGeometry(2.2, 2.4, 0.22, 16);

/**
 * Build a pyramid spawner. Same call signature as spawnPortal; same
 * return shape so spawners.js / dormantProps.js / waves.js drive it
 * without knowing the difference.
 */
export function spawnPyramidPortal(x, z, chapterIdx) {
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.lamp;
  const tintColor = new THREE.Color(tint);
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Base disc — same role as wasp-nest base. Dark dried-out stone
  // foundation tinted by the chapter tint just enough to read.
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x2c2218, emissive: 0x100804, emissiveIntensity: 0.5,
    roughness: 0.95, metalness: 0.05,
  });
  const base = new THREE.Mesh(_BASE_GEO, baseMat);
  base.position.y = 0.11;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // Pyramid body — stepped stone stack. We put it inside its own
  // group ("pyramidBody") so the per-frame sway code in spawners.js
  // updateSpawners can rotate this group on its own axis without
  // dragging the base disc with it. This mirrors the wasp-nest
  // nestBody convention exactly.
  const pyramidBody = new THREE.Group();
  pyramidBody.position.y = 0.22;
  group.add(pyramidBody);

  // Stone material — chapter-tinted emissive seams. We share ONE
  // material across all six steps so per-hit damage darkening lerps
  // them uniformly (matching the wasp-nest behavior where one shared
  // nestMat darkens the whole body on damage).
  const stoneMat = new THREE.MeshStandardMaterial({
    color: _STONE_COLOR,
    emissive: tint,
    emissiveIntensity: 0.20,           // subtle — too high reads as neon
    roughness: 0.95,
    metalness: 0.05,
  });

  // Glyph plate material — bright chapter-tinted runes. Shared across
  // all glyphs on this hive so a single material color update covers
  // them all if needed.
  const glyphMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tint,
    emissiveIntensity: 2.4,
    transparent: true,
    opacity: 0.92,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });

  // Glyph cap material — slightly cooler tone so when the cap is
  // present (intact rune) and then shatters, the underlying glyph
  // plate (also visible after shatter) feels slightly brighter and
  // more raw. Mirrors wasp-nest cap-then-egg progression.
  const capMat = new THREE.MeshStandardMaterial({
    color: 0x6a5a44,                   // pale weathered cap stone
    emissive: tint,
    emissiveIntensity: 0.6,
    roughness: 0.85,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  // Build 6 steps stacked. Each step's Y center is half its height
  // above the top of the previous step.
  const STEP_HEIGHT = 0.5;
  const eggs = [];   // glyph-plate "eggs" — see contract docs
  for (let i = 0; i < _STEP_GEOMS.length; i++) {
    const step = new THREE.Mesh(_STEP_GEOMS[i], stoneMat);
    const y = STEP_HEIGHT * i + STEP_HEIGHT * 0.5;
    step.position.y = y;
    step.castShadow = true;
    step.receiveShadow = true;
    pyramidBody.add(step);

    // Add a glyph plate on each of the 4 faces of this step. Top step
    // (i=5) skips glyph plates — its faces are too narrow and the
    // obelisk takes that real estate.
    if (i >= _STEP_GEOMS.length - 1) continue;
    // Step width — read off the geometry parameters. Width.x === width.z.
    const width = _STEP_GEOMS[i].parameters.width;
    const half = width / 2;
    // 4 cardinal faces. outX/outZ point outward from center.
    const FACES = [
      { outX:  0, outZ:  1, rotY: 0 },          // +Z face
      { outX:  0, outZ: -1, rotY: Math.PI },    // -Z face
      { outX:  1, outZ:  0, rotY: Math.PI / 2 },// +X face
      { outX: -1, outZ:  0, rotY: -Math.PI / 2 },// -X face
    ];
    for (const f of FACES) {
      // Plate sits flush against the face, slightly offset outward so
      // it doesn't z-fight with the stone surface.
      const plate = new THREE.Mesh(_GLYPH_GEO, glyphMat);
      plate.position.set(
        f.outX * (half + 0.01),
        y,
        f.outZ * (half + 0.01),
      );
      plate.rotation.y = f.rotY;
      plate.userData.pulsePhase = Math.random() * Math.PI * 2;
      plate.userData.outward = new THREE.Vector3(f.outX, 0, f.outZ);
      pyramidBody.add(plate);
      eggs.push(plate);

      // Add a cap (intact-rune cover) on top of the plate. Same
      // mechanic as wasp-nest egg caps — first hit shatters the cap
      // revealing the brighter glyph beneath, second hit pops the
      // glyph itself. Slight outward offset so the cap is the
      // outermost visible layer.
      const cap = new THREE.Mesh(_GLYPH_CAP_GEO, capMat);
      cap.position.set(
        f.outX * (half + 0.025),
        y,
        f.outZ * (half + 0.025),
      );
      cap.rotation.y = f.rotY;
      cap.userData.isCap = true;
      cap.userData.eggRef = plate;
      pyramidBody.add(cap);
      plate.userData.cap = cap;
      // Capped plates are hidden from the "which to pop" pool until
      // the cap shatters. Same semantics as wasp-nest covered eggs.
      plate.userData.covered = true;
    }
  }

  // Obelisk capstone — sits centered on top of the highest step. The
  // emissive material is keyed by the chapter tint so this is the
  // brightest visual element on the structure. Doubles as the
  // "crown" the per-frame update code pulses on hit and as HP drops.
  const obeliskMat = new THREE.MeshStandardMaterial({
    color: _STONE_COLOR,
    emissive: tint,
    emissiveIntensity: 2.0,
    roughness: 0.55,
    metalness: 0.10,
  });
  const obelisk = new THREE.Mesh(_OBELISK_GEO, obeliskMat);
  // Top of step 5 is at y = 5 * 0.5 + 0.5 = 3.0. Cone height is 1.6
  // so center at 3.0 + 0.8 = 3.8. Add a small inset so the cone base
  // sinks slightly into the top step (reads as planted, not glued).
  obelisk.position.y = 3.0 + 1.6 * 0.5 - 0.05;
  pyramidBody.add(obelisk);

  // Entry ring — flush at the base, tinted glow. Same lore as the
  // wasp-nest entry ring: the spawn point for emerging enemies. A
  // simple glowing torus sitting in front of the bottom step.
  const entryRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.12, 6, 14),
    new THREE.MeshStandardMaterial({
      color: 0x1a0f05,
      emissive: tint,
      emissiveIntensity: 1.8,
      roughness: 0.6,
    })
  );
  entryRing.position.y = 0.26;
  entryRing.rotation.x = Math.PI / 2;
  group.add(entryRing);

  scene.add(group);

  return {
    obj: group,
    pos: group.position,
    // Compatibility aliases — existing update code expects these
    // names. Point them at pyramid equivalents so the per-frame pulse
    // / hit-flash code drives the obelisk emissive without any
    // change to spawners.js updateSpawners().
    ring: obelisk,
    core: obelisk,
    orb: obelisk,
    base,
    beam: entryRing,
    coreMat: obelisk.material,
    ringMat: obelisk.material,
    baseMat: base.material,
    // The key alias — spawners.js tests `s.nestBody` to apply sway,
    // and reads `s.eggs[]` to drive pop animations. We reuse the
    // exact same field names so the existing animation loop drives
    // pyramids identically to wasp nests.
    nestBody: pyramidBody,
    eggs,
    eggsAlive: eggs.length,
    capMat,
    // The shared stone material + its baseline color, used by
    // _updateHiveDamageColor in spawners.js to lerp toward black as
    // HP drops. Must be the actual material + actual original color.
    nestMat: stoneMat,
    nestOriginalColor: new THREE.Color(_STONE_COLOR),
    hp: SPAWNER_CONFIG.spawnerHp || 180,
    hpMax: SPAWNER_CONFIG.spawnerHp || 180,
    hitFlash: 0,
    spawnCooldown: 0.5 + Math.random() * HIVE_CONFIG.spawnIntervalSec,
    enemiesAlive: 0,
    destroyed: false,
    tint,
    // Tag so debug tooling / future per-style logic can branch on
    // structure type. spawners.js doesn't read this; it's purely
    // informational.
    structureType: 'pyramid',
  };
}
