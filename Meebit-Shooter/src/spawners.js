import * as THREE from 'three';
import { scene } from './scene.js';
import { SPAWNER_CONFIG, HIVE_CONFIG, CHAPTERS, ARENA } from './config.js';
import { hitBurst } from './effects.js';
import { getTriangleFor } from './triangles.js';
import { enemies } from './enemies.js';
import { spawnPyramidPortal, tickPyramidDamage, launchPyramid, tickPyramidLaunch } from './pyramidSpawner.js';
import { spawnUfoPortal, tickUfoDamage, explodeUfo } from './ufoSpawner.js';

export const spawners = [];

// --- Wave-3-to-wave-4 retraction ---
//
// After wave 3 ends and before wave 4 starts, waves.js calls
// startHiveRetraction(). Every hive group (live and destroyed-collapsing)
// sinks into the ground over HIVE_RETRACT_SEC, then gets removed from
// the scene. Lore: the enemy infrastructure recalls its portals once the
// assault phase fails.
const HIVE_RETRACT_SEC = 2.0;
let _retractActive = false;
let _retractT = 0;

export function startHiveRetraction() {
  if (_retractActive) return;
  _retractActive = true;
  _retractT = 0;
}

/**
 * Failsafe — force any in-flight retraction (and all lingering hives) to
 * finish immediately. Used as a belt-and-suspenders cleanup at wave 4 start
 * so a hive that never finished its sink animation (due to wave-type flip,
 * low frame rate, backgrounded tab, etc) can't leak into the next wave.
 *
 * Idempotent and safe to call whether a retraction is active or not.
 */
export function forceCompleteRetraction() {
  // Remove every hive group from the scene regardless of retraction state.
  for (const s of spawners) {
    if (s.obj && s.obj.parent) scene.remove(s.obj);
    s.destroyed = true;
  }
  spawners.length = 0;
  _retractActive = false;
  _retractT = 0;
}

export function isHiveRetracting() {
  return _retractActive;
}

// Position of the most-recently-destroyed hive — wave-3-end shockwave
// originates here. Updated inside destroySpawner() each time a hive
// falls. Null before any hive destruction.
let _lastHiveDeathPos = null;
export function getLastHiveDeathPos() { return _lastHiveDeathPos; }

// ============================================================================
//  WASP-NEST HIVE
// ============================================================================
// The hive now reads as a papery wasp/hornet nest: a teardrop dome of
// stacked honeycomb rings, each ring made of real hexagonal cells. Some
// cells are "capped" (opaque wax lids) — those hide eggs. Some cells are
// "open" — you can see the translucent egg sac glowing chapter-tint inside.
// A smaller fraction of cells are empty voids (negative space, black).
//
// When the player shoots the hive, one random intact egg gets popped:
// its cap shatters outward, its glow burns out, and a cloud of
// chapter-color particles sprays from the cell. The nest itself is still
// the source of enemies — popping eggs just reduces visible egg count
// and telegraphs damage.
//
// Geometry is shared where possible (one hex prism, one egg sphere, one
// cap cylinder) so 4 hives per wave ≈ 4 * ~80 hex instances = ~320
// meshes per wave. Acceptable given they only exist during the hive wave.

// Shared geo for the hex cells. Lightweight -- one hexagonal prism with
// a small depth so each cell reads as a recess, not a flat face.
const _hexShape = (() => {
  const s = new THREE.Shape();
  const r = 0.28;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
})();
const _hexCellGeo = new THREE.ExtrudeGeometry(_hexShape, {
  depth: 0.12, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1,
});
const _hexCapGeo = new THREE.ExtrudeGeometry(_hexShape, {
  depth: 0.08, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.03, bevelSegments: 1,
});
const _eggGeo = new THREE.SphereGeometry(0.19, 8, 6);

// Papery cream — the outer comb material. Slight warm emissive so the
// nest reads in dark arenas without needing its own light.
const _NEST_PAPER_COLOR = 0xd9c79a;
const _NEST_PAPER_EMISSIVE = 0x3a2a10;
// Darker cavity — the cell interior you see behind egg sacks.
const _NEST_CAVITY_COLOR = 0x2a1e10;

// Dispatcher — per user spec, chapters cycle through three structure
// types on a mod-3 schedule. Each chapter pair gets a distinct theme:
//   chapter 0 (CH1 INFERNO)  + chapter 3 (CH4 TOXIC)     → HIVE (wasp nest)
//   chapter 1 (CH2 CRIMSON)  + chapter 4 (CH5 ARCTIC)    → PYRAMID (cursed)
//   chapter 2 (CH3 SOLAR)    + chapter 5 (CH6 PARADISE)  → UFO (alien)
// Modulo 3 of the chapter index picks the type so the rotation is
// implicit in the index and doesn't require a per-chapter table.
//
// All three structure modules return objects with the same field
// shape (obj, pos, nestBody, eggs[], nestMat, nestOriginalColor,
// crown/coreMat aliases, hp, hpMax, etc), so the existing
// damageSpawner / updateSpawners / shield / destruction code drives
// any of them without needing to know which is which.
export function spawnPortal(x, z, chapterIdx) {
  const slot = ((chapterIdx % 3) + 3) % 3;     // safe modulo for negatives
  if (slot === 1) return spawnPyramidPortal(x, z, chapterIdx);
  if (slot === 2) return spawnUfoPortal(x, z, chapterIdx);
  return _spawnHivePortal(x, z, chapterIdx);
}

// Create a wasp-nest-style hive at (x, z) tinted to the current chapter color.
function _spawnHivePortal(x, z, chapterIdx) {
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.lamp;
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Base — a thin disc of dried paper the nest grows on. Smaller than the
  // old portal base, tinted browner, reads as "dried pulp" rather than
  // "sci-fi platform". Emissive bumped 0.6 → 0.9 so the foundation
  // glows clearly against the dark chapter floors. Refresh per
  // playtester request — "modify the look of hives".
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9, 2.1, 0.22, 14),
    new THREE.MeshStandardMaterial({
      color: 0x3a2a18, emissive: 0x1a0f05, emissiveIntensity: 0.9,
      roughness: 0.95, metalness: 0.0,
    })
  );
  base.position.y = 0.11;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // Papery nest body — an egg-shaped dome made of stacked hex rings.
  // The dome sits on the base (y=0.22) and crowns at y~3.4. Each ring
  // tapers as it goes up. I draw 8 rings vertically; ring 0 is widest,
  // top ring is narrow/crown. Body warm-tone emissive bumped
  // 0.35 → 0.55 so the papery structure reads as glowing from within
  // even in dim chapters.
  const nestMat = new THREE.MeshStandardMaterial({
    color: _NEST_PAPER_COLOR,
    emissive: _NEST_PAPER_EMISSIVE,
    emissiveIntensity: 0.55,
    roughness: 0.92,
    metalness: 0.0,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: _NEST_PAPER_COLOR,
    emissive: tint,                 // faintly tinted — "something alive inside"
    emissiveIntensity: 0.50,
    roughness: 0.85,
    metalness: 0.0,
  });
  const cavityMat = new THREE.MeshStandardMaterial({
    color: _NEST_CAVITY_COLOR,
    emissive: 0x120808,
    emissiveIntensity: 0.4,
    roughness: 1.0,
  });
  const eggMat = new THREE.MeshStandardMaterial({
    color: 0xfff3d0,
    emissive: tint,
    emissiveIntensity: 2.4,
    transparent: true,
    opacity: 0.85,
    roughness: 0.35,
  });

  const nestBody = new THREE.Group();
  nestBody.position.y = 0.2;
  group.add(nestBody);

  // Eggs we can damage. Populated below as we build the rings.
  const eggs = [];

  const RINGS = 8;
  for (let ring = 0; ring < RINGS; ring++) {
    // Teardrop profile: widest at ring ~2, tapers toward top.
    // f goes 0..1 top-to-bottom as ring increases; we invert later.
    const f = ring / (RINGS - 1);            // 0 at bottom, 1 at top
    // Profile: fat middle, narrow top. sin gives a nice dome curve.
    const profile = Math.sin((1 - f) * Math.PI * 0.55 + 0.25);
    const ringR = 0.6 + profile * 1.3;       // 0.6..1.9
    const ringY = 0.25 + f * 3.1;            // 0.25..3.35
    // Hex cells per ring scale with circumference
    const cellCount = Math.max(7, Math.floor(ringR * 8.5));
    const angleOffset = (ring % 2) * (Math.PI / cellCount);  // alternate rows
    for (let i = 0; i < cellCount; i++) {
      const a = angleOffset + (i / cellCount) * Math.PI * 2;
      const cx = Math.cos(a) * ringR;
      const cz = Math.sin(a) * ringR;
      // Outward-facing normal (cell tilts to sit flush on the dome surface)
      const outX = Math.cos(a);
      const outZ = Math.sin(a);

      // Decide cell role: CAPPED (opaque lid hiding an egg), OPEN (visible
      // egg glowing from inside), or VOID (empty dark cell).
      //   40% capped, 45% open-with-egg, 15% void
      const roll = Math.random();
      const role = roll < 0.40 ? 'capped' : (roll < 0.85 ? 'open' : 'void');

      // The hex cell itself — a shallow prism sitting tangent to the dome
      // surface. We orient so the prism's +Z (extrude dir) points outward
      // from the nest center, i.e. the "mouth" of the cell faces inward.
      const cell = new THREE.Mesh(_hexCellGeo, role === 'void' ? cavityMat : nestMat);
      cell.position.set(cx, ringY, cz);
      cell.lookAt(cx * 100, ringY, cz * 100);  // face outward
      // Pull slightly back so cells aren't floating
      cell.position.x -= outX * 0.05;
      cell.position.z -= outZ * 0.05;
      cell.castShadow = true;
      nestBody.add(cell);

      if (role === 'void') continue;

      // Egg inside every non-void cell. Sits just inside the cell mouth.
      const eggPos = new THREE.Vector3(
        cx + outX * 0.10,
        ringY,
        cz + outZ * 0.10,
      );
      const egg = new THREE.Mesh(_eggGeo, eggMat.clone());
      egg.position.copy(eggPos);
      egg.scale.setScalar(0.8 + Math.random() * 0.5);
      egg.userData = {
        popped: false,
        pulsePhase: Math.random() * Math.PI * 2,
        basePos: eggPos.clone(),
        outward: new THREE.Vector3(outX, 0, outZ),
      };
      nestBody.add(egg);
      eggs.push(egg);

      if (role === 'capped') {
        // Opaque wax lid hiding the egg. Sits at the cell mouth.
        const cap = new THREE.Mesh(_hexCapGeo, capMat);
        cap.position.set(
          cx + outX * 0.18,
          ringY,
          cz + outZ * 0.18,
        );
        cap.lookAt(cx * 100, ringY, cz * 100);
        cap.userData.isCap = true;
        cap.userData.eggRef = egg;
        nestBody.add(cap);
        egg.userData.cap = cap;
        // Capped eggs are hidden from the "which egg to pop" roll until
        // their cap is broken. We flag them capped so the pop logic
        // shatters the cap first, then the egg on a subsequent hit.
        egg.userData.covered = true;
      }
    }
  }

  // Crown tuft — a small bulge at the top of the nest where the queen's
  // chamber would sit. Emits the chapter tint so the hive reads from afar.
  const crown = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 10, 8),
    new THREE.MeshStandardMaterial({
      color: _NEST_PAPER_COLOR,
      emissive: tint,
      emissiveIntensity: 2.0,
      roughness: 0.6,
    })
  );
  crown.position.y = 3.55;
  nestBody.add(crown);

  // Entry hole at the bottom — a dark ring under the nest where wasps
  // would crawl out. Also doubles as our "enemy spawn point" visual.
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
    // Compatibility with the old portal shape so existing update code
    // that references .ring/.core/.orb/.beam/.ringMat still works —
    // we point them at nest-equivalents so the existing pulse/hitFlash
    // code drives the crown glow.
    ring: crown,
    core: crown,
    orb: crown,
    base,
    beam: entryRing,
    coreMat: crown.material,
    ringMat: crown.material,
    baseMat: base.material,
    // Wasp-nest specifics
    nestBody,
    eggs,
    eggsAlive: eggs.length,
    capMat,
    // Expose the paper body material + a snapshot of its original color
    // so damageSpawner can progressively darken it toward black as the
    // hive takes damage (see _updateHiveDamageColor). Cached _NEST_PAPER_COLOR
    // as a THREE.Color makes the per-hit lerp a one-liner with no allocs.
    nestMat,
    nestOriginalColor: new THREE.Color(_NEST_PAPER_COLOR),
    hp: SPAWNER_CONFIG.spawnerHp || 180,
    hpMax: SPAWNER_CONFIG.spawnerHp || 180,
    hitFlash: 0,
    spawnCooldown: 0.5 + Math.random() * HIVE_CONFIG.spawnIntervalSec,
    enemiesAlive: 0,
    destroyed: false,
    tint,
  };
}

/**
 * Pick N random hive positions INSIDE the hive triangle, avoiding:
 *   - the map center (player spawn)
 *   - each other (minimum pairwise distance)
 *   - the arena edge (so hives are reachable)
 *
 * The triangulation system assigns wave 3 (hive wave) to one of three
 * arena wedges each chapter. All hives cluster in that wedge, keeping
 * wave-1 mining and wave-2 power-up space clear.
 */
function pickRandomHivePositions(count) {
  const cfg = HIVE_CONFIG;
  const minC = cfg.minDistFromCenter;
  const minPair = cfg.minPairwiseDist;
  const maxR = ARENA - 6;

  // Constrain angle to the hive triangle. Every random angle draw falls
  // inside the wedge — no rejection sampling needed.
  const tri = getTriangleFor('hive');
  const aMin = tri.minAngle;
  const aSpan = tri.maxAngle - tri.minAngle;

  const picked = [];
  let attempts = 0;
  while (picked.length < count && attempts < 400) {
    attempts++;
    const angle = aMin + Math.random() * aSpan;
    const r = minC + Math.random() * (maxR - minC);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    let ok = true;
    for (const p of picked) {
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz < minPair * minPair) { ok = false; break; }
    }
    if (ok) picked.push({ x, z });
  }
  // Fallback: relax the pairwise constraint but stay inside the triangle.
  // Hives getting slightly crowded is better than one leaking into the
  // mining or power-up wedge.
  while (picked.length < count) {
    const angle = aMin + Math.random() * aSpan;
    const r = minC + Math.random() * (maxR - minC);
    picked.push({ x: Math.cos(angle) * r, z: Math.sin(angle) * r });
  }
  return picked;
}

export function spawnAllPortals(chapterIdx) {
  clearAllPortals();
  const positions = pickRandomHivePositions(HIVE_CONFIG.hiveCount);
  for (const p of positions) {
    spawners.push(spawnPortal(p.x, p.z, chapterIdx));
  }
}

// New canonical names for the hive phase. Kept alongside old names for
// back-compat so existing imports don't break.
export const spawnAllHives = spawnAllPortals;

export function damageSpawner(spawner, dmg) {
  if (spawner.destroyed) return false;
  // Shielded hives (waves 1-2 before EMP) are invulnerable. Fire a white
  // spark on the shield surface so the player sees their shots landing
  // but bouncing — no damage is applied.
  if (spawner.shielded) {
    hitBurst(
      new THREE.Vector3(spawner.pos.x, 2.2, spawner.pos.z),
      0xffffff, 2
    );
    return false;
  }
  spawner.hp -= dmg;
  spawner.hitFlash = 0.2;
  // Darken the nest body color as HP falls. At full HP, color is the
  // original papery tone. At 0 HP it lerps all the way to near-black.
  // Lerps the SHARED-per-hive material once per hit — no per-frame cost.
  _updateHiveDamageColor(spawner);
  // Extra-visible hit burst — sparks at the impact point plus a shower
  // of chapter-color chunks. Bigger than the default so the hive feels
  // meaty to shoot.
  hitBurst(
    new THREE.Vector3(spawner.pos.x, 2.2, spawner.pos.z),
    0xffffff, 4
  );
  hitBurst(
    new THREE.Vector3(spawner.pos.x, 2, spawner.pos.z),
    spawner.tint, 8
  );
  // Pop an egg! Pick a random intact target — cap first if available
  // (shatters the wax lid revealing the egg below), otherwise an exposed
  // uncovered egg. This makes repeated hits visibly degrade the nest.
  _popRandomEgg(spawner);
  if (spawner.hp <= 0) {
    destroySpawner(spawner);
    return true;
  }
  return false;
}

// --- Egg/cap damage helpers -------------------------------------------------
// Hits pop individual cells on the wasp nest so the player sees ongoing
// progress between the hive taking its first damage and the hive dying.
// Picks a random intact target on each hit: capped cells get their cap
// knocked off (revealing the egg inside), exposed eggs get popped (their
// mesh shrinks to zero, their material stops emitting).

const _POP_PARTICLES = 10;

function _popRandomEgg(spawner) {
  if (!spawner.eggs || !spawner.eggs.length) return;
  // Prefer cells whose cap is still on (shatter cap first). Fall back to
  // any exposed intact egg. Once nothing's intact the nest is visibly
  // stripped and we just do a hit spark — HP still ticks down until the
  // hive's overall destroy threshold.
  const cappedIntact = [];
  const exposedIntact = [];
  for (const e of spawner.eggs) {
    if (e.userData.popped) continue;
    if (e.userData.covered && e.userData.cap && !e.userData.cap.userData._shattered) {
      cappedIntact.push(e);
    } else {
      exposedIntact.push(e);
    }
  }
  const pool = cappedIntact.length ? cappedIntact : exposedIntact;
  if (!pool.length) return;
  const target = pool[Math.floor(Math.random() * pool.length)];
  // Where in world space to spawn the pop FX
  const worldPos = new THREE.Vector3();
  target.getWorldPosition(worldPos);

  if (target.userData.covered && target.userData.cap && !target.userData.cap.userData._shattered) {
    // Shatter the cap — set flag so animation tick can fling it away.
    const cap = target.userData.cap;
    cap.userData._shattered = true;
    cap.userData._shatterT = 0;
    cap.userData._shatterDir = target.userData.outward.clone();
    target.userData.covered = false;
    // Small white spark at the cap
    hitBurst(worldPos, 0xffffff, 4);
    hitBurst(worldPos, spawner.tint, 6);
  } else {
    // Pop the egg itself. Flag it so the animation tick shrinks + fades.
    target.userData.popped = true;
    target.userData._popT = 0;
    spawner.eggsAlive = Math.max(0, spawner.eggsAlive - 1);
    // Bigger pop burst — chapter tint + yellow yolk mix
    hitBurst(worldPos, spawner.tint, _POP_PARTICLES);
    hitBurst(worldPos, 0xfff3d0, 6);
  }
}

/**
 * Update the hive's body material color based on its current HP ratio.
 * At full HP the body is the original papery tone. As HP drops, the
 * color lerps toward near-black so a wounded hive visibly looks charred.
 * Called on every damage hit; no per-frame cost.
 */
function _updateHiveDamageColor(spawner) {
  if (!spawner || !spawner.nestMat || !spawner.nestOriginalColor) return;
  const ratio = Math.max(0, Math.min(1, spawner.hp / spawner.hpMax));
  // Lerp to near-black (not pure 000 — keeping a hint of brown so it
  // reads as "charred paper" rather than "missing texture").
  const dark = _HIVE_DAMAGE_DARK;
  const target = spawner.nestMat.color;
  target.copy(spawner.nestOriginalColor).lerp(dark, 1 - ratio);
  // Also dim the emissive so the hive doesn't keep glowing with the
  // same intensity when it looks half-dead.
  spawner.nestMat.emissiveIntensity = 0.35 * (0.3 + 0.7 * ratio);
}
// Single shared THREE.Color instance used as the lerp target — avoids
// allocating a new Color object on every damage tick.
const _HIVE_DAMAGE_DARK = new THREE.Color(0x0a0603);

// Radius of the AoE blast when a hive explodes. Tuned so an enemy standing
// right at the hive's base or a few meters out gets vaporized, but enemies
// across the arena are untouched (this is a SMALL explosion, not a nuke).
const HIVE_EXPLOSION_RADIUS = 7.5;
// Damage at the epicenter. Falls off linearly to 0 at the edge of the radius.
// Most wave-3 enemies have 30-70 HP, so 150 at center is a guaranteed kill
// inside ~4m and still lethal to wounded enemies near the edge.
const HIVE_EXPLOSION_DAMAGE = 150;

function destroySpawner(spawner) {
  spawner.destroyed = true;
  spawner.hp = 0;
  // Record death position for the wave-3-end shockwave. Overwrites each
  // time a hive falls — the final overwrite is the "last hive standing".
  _lastHiveDeathPos = { x: spawner.pos.x, y: 0.2, z: spawner.pos.z };

  // Structure-specific destruction FX. UFOs explode bigger; pyramids
  // launch into the sky on thrusters. Both branch run BEFORE the
  // generic hitBurst chain so their visual lead is clean — but we
  // still want the AoE damage and the chain-decoration bursts for
  // wasp-nests + UFOs. Pyramids skip the bursts (their lightning +
  // launch sequence is the visual event).
  const isPyramid = spawner.structureType === 'pyramid';
  const isUfo     = spawner.structureType === 'ufo';

  if (isPyramid) {
    // Pyramid takes off — no explosion, no AoE damage. The launch
    // sequence is its death cinematic; updateSpawners drives it.
    try { launchPyramid(spawner); } catch (e) { console.warn('[pyramid launch]', e); }
    // Tag so updateSpawners runs the launch tick instead of the
    // standard collapse animation.
    spawner.obj.userData._launching = true;
    return;
  }

  if (isUfo) {
    // Bigger UFO explosion — extra burst layers via explodeUfo.
    try { explodeUfo(spawner); } catch (e) { console.warn('[ufo explode]', e); }
  } else {
    // Default (wasp-nest) explosion — chapter tint + white core +
    // orange flash. Bigger than the per-hit bursts in damageSpawner()
    // so the death reads as an explosion rather than another hit.
    const pos = new THREE.Vector3(spawner.pos.x, 2, spawner.pos.z);
    hitBurst(pos, 0xffffff, 40);
    hitBurst(pos, spawner.tint, 32);
    setTimeout(() => hitBurst(pos, 0xff8800, 22), 60);
    setTimeout(() => hitBurst(pos, 0xff3cac, 18), 140);
  }

  // AoE enemy damage — the structure's death throws shrapnel that
  // guts whatever was clustered around it. Uses the same falloff
  // pattern as explodeRocket in main.js: full damage at the epicenter,
  // linearly falling to zero at HIVE_EXPLOSION_RADIUS.
  const r2 = HIVE_EXPLOSION_RADIUS * HIVE_EXPLOSION_RADIUS;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || !e.pos) continue;
    const dx = e.pos.x - spawner.pos.x;
    const dz = e.pos.z - spawner.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r2) {
      const falloff = 1 - Math.sqrt(d2) / HIVE_EXPLOSION_RADIUS;
      e.hp -= HIVE_EXPLOSION_DAMAGE * falloff;
      e.hitFlash = 0.15;
      // Don't remove here — enemies.js / main.js owns kill bookkeeping
      // (score, spawn counts, etc). We just flag hp<=0 and the normal
      // per-frame enemy tick will kill it.
    }
  }

  // Collapse animation: was 2× speed (full shrink in 0.5s) — bump to
  // 6× speed so the structure crumbles inside ~0.17s and the
  // explosion reads as the cause of death rather than a slow wilt.
  spawner.obj.userData._collapsing = true;
  spawner.obj.userData._collapseT = 0;
  spawner.obj.userData._collapseFast = true;
}

export function updateSpawners(dt) {
  // Global retraction tick — invoked from waves.js startHiveRetraction()
  // before wave 4 starts. Every hive (destroyed-and-collapsed OR still
  // standing) sinks into the ground over 2s.
  if (_retractActive) {
    _retractT = Math.min(HIVE_RETRACT_SEC, _retractT + dt);
    const f = _retractT / HIVE_RETRACT_SEC;
    const eased = f * f;
    const sinkY = -eased * 6;
    for (const s of spawners) {
      if (s.obj && s.obj.parent) {
        s.obj.position.y = sinkY;
      }
    }
    if (f >= 1) {
      _retractActive = false;
      // Remove every hive group from scene now that they're underground,
      // AND clear the spawners array so objective arrows, livePortalCount(),
      // and the hive objective-label stop referencing the now-invisible
      // hive data. Without this, a destroyed-but-array-resident hive (or
      // any stragglers referenced by an arrow target) can leave a "HIVE"
      // label stuck on-screen into wave 4.
      for (const s of spawners) {
        if (s.obj && s.obj.parent) scene.remove(s.obj);
        s.destroyed = true;   // flag so any late reference treats it as dead
      }
      spawners.length = 0;
    }
  }

  const now = performance.now();
  for (const s of spawners) {
    if (s.destroyed) {
      // Pyramid takeoff path — replaces the standard collapse with a
      // launch sequence (charge → ignition → ascent). When tickPyramidLaunch
      // returns true, the pyramid has cleared the arena and we can
      // remove its group from the scene.
      if (s.obj.userData._launching) {
        const done = tickPyramidLaunch(s, dt);
        if (done) {
          if (s.obj.parent) scene.remove(s.obj);
          s.obj.userData._launching = false;
        }
        continue;
      }
      // Standard collapse animation (wasp-nest, UFO).
      if (s.obj.userData._collapsing) {
        s.obj.userData._collapseT += dt;
        const t = s.obj.userData._collapseT;
        // Fast collapse (0.17s) when the hive exploded in destroySpawner —
        // the explosion is the main visual event, the collapse is just
        // the hive crumbling afterward. Legacy 0.5s rate kept as fallback.
        const rate = s.obj.userData._collapseFast ? 6 : 2;
        const scale = Math.max(0, 1 - t * rate);
        s.obj.scale.setScalar(scale);
        s.obj.rotation.y += dt * 8;
        if (scale <= 0) {
          scene.remove(s.obj);
          s.obj.userData._collapsing = false;
        }
      }
      continue;
    }

    // HP ratio: 1.0 at full, 0.0 just before destruction
    const ratio = Math.max(0, s.hp / s.hpMax);

    // Nest body gently sways on its base so it reads as organic/alive.
    // Faster sway as HP drops — a wounded nest visibly trembles.
    if (s.nestBody) {
      const swayHz = 0.8 + (1 - ratio) * 2.5;
      s.nestBody.rotation.z = Math.sin(now * 0.001 * swayHz) * 0.03 * (1 + (1 - ratio) * 2);
      s.nestBody.rotation.x = Math.cos(now * 0.0013 * swayHz) * 0.02 * (1 + (1 - ratio) * 1.5);
    }

    // Tick eggs — intact eggs pulse, popped eggs shrink/fade, shattered
    // caps fly outward. Keep the work per-egg minimal since there can be
    // ~60 eggs across a hive.
    if (s.eggs) {
      for (const e of s.eggs) {
        const ud = e.userData;
        if (ud.popped) {
          // Shrink + fade out over 0.35s, then remove from the scene
          ud._popT = (ud._popT || 0) + dt;
          const t = Math.min(1, ud._popT / 0.35);
          const scale = 1 - t;
          if (scale <= 0) {
            if (e.parent) e.parent.remove(e);
          } else {
            e.scale.setScalar(scale * (0.8 + Math.random() * 0.15));
            if (e.material && e.material.emissiveIntensity !== undefined) {
              e.material.emissiveIntensity = 2.4 * (1 - t);
              e.material.opacity = 0.85 * (1 - t);
            }
          }
        } else if (!ud.covered) {
          // Exposed intact egg — gentle breathing pulse tinted brighter
          // as HP drops so the "overheating" telegraph still reads on
          // the new nest look.
          const p = 0.5 + 0.5 * Math.sin(now * 0.003 + ud.pulsePhase);
          const base = 2.0 + (1 - ratio) * 3.0;
          if (e.material && e.material.emissiveIntensity !== undefined) {
            e.material.emissiveIntensity = base + p * 1.8;
          }
        }
        // Capped eggs get driven by their cap's anim (below) — no tick here.

        // Tick cap shatter: once shattered, the cap flies outward and
        // tumbles for ~0.4s, then detaches.
        if (ud.cap && ud.cap.userData._shattered) {
          const cap = ud.cap;
          cap.userData._shatterT = (cap.userData._shatterT || 0) + dt;
          const ct = cap.userData._shatterT;
          const dir = cap.userData._shatterDir;
          cap.position.x += dir.x * dt * 4;
          cap.position.z += dir.z * dt * 4;
          cap.position.y += dt * 2 - ct * dt * 6;  // small hop then fall
          cap.rotation.x += dt * 12;
          cap.rotation.z += dt * 9;
          if (ct > 0.45) {
            if (cap.parent) cap.parent.remove(cap);
            ud.cap = null;
          }
        }
      }
    }

    // Smooth shrink on death approach — the whole nest shrinks slightly
    // as HP drops so you read "this thing is dying" even before the
    // kill moment.
    const targetScale = 0.85 + ratio * 0.15;
    const curScale = s.obj.scale.x;
    s.obj.scale.setScalar(curScale + (targetScale - curScale) * Math.min(1, dt * 6));

    // Crown glow pulses faster and brighter as HP drops — telegraphs
    // "nest is about to pop" without the old sci-fi ring rotation.
    const pulseHz = 1.6 + (1 - ratio) * 6;
    const pulse = (Math.sin(now * 0.001 * pulseHz * Math.PI * 2) + 1) * 0.5;
    const baseEmissive = 1.6 + (1 - ratio) * 2.5 + pulse * (1 - ratio) * 2.0;
    if (s.hitFlash > 0) {
      s.hitFlash -= dt;
      if (s.ringMat) s.ringMat.emissiveIntensity = baseEmissive + s.hitFlash * 8;
    } else {
      if (s.ringMat) s.ringMat.emissiveIntensity = baseEmissive;
    }

    // Structure-specific damage FX — each spawner type drives its own
    // damage visuals on top of the shared sway/egg/hit-flash machinery
    // above. UFOs spin faster + crack + shed panels; pyramids brighten
    // + spawn lightning. Both early-return harmlessly when nothing to do.
    if (s.structureType === 'ufo') {
      try { tickUfoDamage(s, dt, ratio); } catch (e) {}
    } else if (s.structureType === 'pyramid') {
      try { tickPyramidDamage(s, dt, ratio); } catch (e) {}
    }
  }
}

// Returns count of still-alive portals
export function livePortalCount() {
  let n = 0;
  for (const s of spawners) if (!s.destroyed) n++;
  return n;
}

export function clearAllPortals() {
  for (const s of spawners) {
    if (s.obj.parent) scene.remove(s.obj);
  }
  spawners.length = 0;
}

// Pick a random NON-destroyed portal to spawn an enemy from.
// Returns null if all are destroyed.
export function pickActivePortal() {
  const live = spawners.filter(s => !s.destroyed);
  if (live.length === 0) return null;
  return live[Math.floor(Math.random() * live.length)];
}

// Hive-phase aliases for readability in new code
export const liveHiveCount = livePortalCount;
export const clearAllHives = clearAllPortals;
export const pickActiveHive = pickActivePortal;
export const hives = spawners;
