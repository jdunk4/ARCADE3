// ============================================================================
// src/waveProps.js — central wave-2 compound layout + dormant prop geometry.
//
// Scope (Stage 3a):
//   - Defines LAYOUT, the single source of truth for WHERE the silo, 3
//     turrets, powerplant, and radio tower sit in the arena.
//   - Exports buildCentralCompound() which spawns the dormant silo,
//     powerplant, and radio tower geometry at chapter start. (Turrets are
//     still built by turrets.js — they just consume LAYOUT.turrets to
//     pick their positions.)
//   - Exports clearCentralCompound() to tear it all down on chapter end.
//
// Not implemented here yet (Stage 3b):
//   - Powerplant "mini city" light-up on POWER completion
//   - Wires from powerplant → turrets + silo
//   - Silo opening / missile raising animation
//   - Generator on the rocket that you shoot
//
// Not implemented here yet (Stage 3c):
//   - Missile launch arc, DOM flash overlay, 20s countdown
//   - Screen darken + shockwave at detonation
// ============================================================================

import * as THREE from 'three';
import { scene } from './scene.js';
import { CHAPTERS } from './config.js';
import { getCentroidFor, getCenterAngleFor } from './triangles.js';

// ---------------------------------------------------------------------------
// LAYOUT — the canonical compound composition.
//
// Stage 3-fix: the silo is no longer fixed at (0,0). It sits at the
// CENTROID of whichever triangle the triangulation system assigned to
// wave 2 for the current chapter. The 3 turrets still form a triangle
// around the silo; the powerplant and radio tower flank it. The whole
// composition rotates so the silo "faces outward" toward the arena wall.
//
// LAYOUT is populated by _recomputeLayout() during buildCentralCompound.
// Consumers (turrets.js, powerupZones.js) read it as a live reference, so
// mutating it in place keeps them in sync without re-exports.
// ---------------------------------------------------------------------------
export const LAYOUT = {
  silo: { x: 0, z: 0 },
  turrets: [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ],
  powerplant: { x: 0, z: 0 },
  radioTower: { x: 0, z: 0 },
};

/**
 * Recompute LAYOUT based on the power-up triangle assignment for the
 * current chapter. Mutates LAYOUT in place so every consumer that
 * imported it as a reference picks up the new coordinates.
 *
 * Coordinate system: the silo sits at the triangle centroid. The three
 * turrets form a triangle of radius 6 around it (tightened from 8 since
 * the wedge is narrower than the full arena). The powerplant and radio
 * tower are offset perpendicular to the wedge's center axis — think of
 * the center axis as a "spine" running from the arena center outward,
 * with the powerplant and radio tower to either side of that spine,
 * slightly closer to the arena wall than the silo.
 */
function _recomputeLayout() {
  const centroid = getCentroidFor('powerup');
  const outward = getCenterAngleFor('powerup');  // away from origin
  const perp = outward + Math.PI / 2;            // perpendicular

  LAYOUT.silo.x = centroid.x;
  LAYOUT.silo.z = centroid.z;

  // 3 turrets 120° apart at r=6 from silo. One points "inward" (back
  // toward arena center) so its firing arc covers the spawn side.
  const turretR = 6;
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3 + outward;
    LAYOUT.turrets[i].x = centroid.x + Math.cos(a) * turretR;
    LAYOUT.turrets[i].z = centroid.z + Math.sin(a) * turretR;
  }

  // Powerplant: offset 10 units along the perpendicular, 4 further out.
  LAYOUT.powerplant.x = centroid.x + Math.cos(perp) * 10 + Math.cos(outward) * 4;
  LAYOUT.powerplant.z = centroid.z + Math.sin(perp) * 10 + Math.sin(outward) * 4;

  // Radio tower: same deal, mirrored perpendicular.
  LAYOUT.radioTower.x = centroid.x - Math.cos(perp) * 10 + Math.cos(outward) * 4;
  LAYOUT.radioTower.z = centroid.z - Math.sin(perp) * 10 + Math.sin(outward) * 4;
}

// ---------------------------------------------------------------------------
// DORMANT GEOMETRY — silo, powerplant, radio tower.
//
// Everything here is intentionally low-cost: cached materials per chapter
// tint, shared geometries across all three props where possible. Every
// mesh is dormant-dim at chapter start; Stage 3b will add "activate"
// helpers that brighten emissives + add moving parts.
// ---------------------------------------------------------------------------

// Shared geometries.
const SILO_BASE_GEO   = new THREE.CylinderGeometry(2.4, 2.6, 0.5, 10);
const SILO_TUBE_GEO   = new THREE.CylinderGeometry(1.8, 1.8, 4.5, 10, 1, true);
const SILO_CAP_GEO    = new THREE.CylinderGeometry(1.85, 1.85, 0.3, 10);
const SILO_RIM_GEO    = new THREE.TorusGeometry(1.85, 0.16, 6, 16);

// v7 silo amp — grain-silo detailing. Inspired by reference photos of
// industrial corrugated grain bins: vertical ribs wrap the full height,
// horizontal banding rings encircle the silo at regular intervals, and
// a conical dome sits on top instead of a flat cap. This reads as a
// real silo silhouette at any angle.
//
// Vertical corrugation ribs — 20 thin vertical strips spaced around the
// tube circumference. Using boxes (not extruded cylinders) keeps draw
// calls cheap. Each rib is tall enough to span the tube and poke out
// slightly so they silhouette against the dome.
const SILO_RIB_GEO    = new THREE.BoxGeometry(0.08, 4.5, 0.18);
// Horizontal banding rings — 3 torus rings wrapping the tube at ~25%,
// 50%, 75% height. Reads as the "bolted section joints" you see on
// real silos.
const SILO_BAND_GEO   = new THREE.TorusGeometry(1.88, 0.08, 6, 20);
// Conical dome cap — a cone seated on top of the tube. Opens (slides
// aside) when the silo launches, same as the old flat cap.
const SILO_DOME_GEO   = new THREE.ConeGeometry(1.92, 1.4, 20);
// Small sphere finial at the tip of the dome — sells the grain-silo
// silhouette at a glance.
const SILO_FINIAL_GEO = new THREE.SphereGeometry(0.22, 8, 6);
// Dome banding — a single ring at the base of the dome where it meets
// the tube, so the dome-to-tube junction reads as a real seam.
const SILO_DOME_BAND_GEO = new THREE.TorusGeometry(1.92, 0.08, 6, 20);

// v6 silo detail — structural amp pass.
// Support struts that angle from the base plate up to the tube (4 sides).
const SILO_STRUT_GEO  = new THREE.BoxGeometry(0.25, 2.2, 0.35);
// Riveted armor panels on the tube exterior — 4 vertical strips.
const SILO_PANEL_GEO  = new THREE.BoxGeometry(0.18, 3.8, 0.5);
// Caution stripe ring near the top of the tube (tinted emissive).
const SILO_STRIPE_GEO = new THREE.TorusGeometry(1.87, 0.08, 6, 18);
// Warning light bulbs on top of the struts.
const SILO_LIGHT_GEO  = new THREE.SphereGeometry(0.16, 8, 6);
// Small access hatch near the base (flat box against the tube).
const SILO_HATCH_GEO  = new THREE.BoxGeometry(0.9, 0.7, 0.15);

// Missile geometry — nose cone + body + fins. Sits inside the silo tube
// at rest position (y = -1.8, i.e. fully inside the shaft). During Stage
// 3b it raises to y = +3.8 when the missile is armed. Stage 3c takes
// over and fires it from there.
const MISSILE_BODY_GEO  = new THREE.CylinderGeometry(0.55, 0.55, 3.2, 10);
const MISSILE_NOSE_GEO  = new THREE.ConeGeometry(0.55, 1.1, 10);
const MISSILE_FIN_GEO   = new THREE.BoxGeometry(0.08, 0.8, 0.65);
const MISSILE_LIGHT_GEO = new THREE.SphereGeometry(0.18, 8, 6);

const PP_BASE_GEO     = new THREE.BoxGeometry(4.0, 0.4, 3.0);
const PP_STACK_GEO    = new THREE.CylinderGeometry(0.5, 0.6, 3.2, 8);
const PP_BLOCK_GEO    = new THREE.BoxGeometry(1.2, 1.2, 1.2);
const PP_WINDOW_GEO   = new THREE.PlaneGeometry(0.4, 0.4);
// Chimney-tip flame: a small cone that glows when the powerplant is lit.
const PP_FLAME_GEO    = new THREE.ConeGeometry(0.35, 0.7, 6);

const RT_BASE_GEO     = new THREE.BoxGeometry(2.2, 0.4, 2.2);
const RT_MAST_GEO     = new THREE.CylinderGeometry(0.12, 0.18, 5.5, 6);
const RT_STRUT_GEO    = new THREE.BoxGeometry(1.6, 0.08, 0.08);
const RT_BULB_GEO     = new THREE.SphereGeometry(0.22, 8, 6);

// Cached materials keyed by chapter tint.
const _bodyMatCache    = new Map();  // dark metal — same for every chapter
const _accentDimCache  = new Map();  // dim chapter-tint emissive (dormant)
const _rimCache        = new Map();  // small bright accent edges
const _windowDimCache  = new Map();  // powerplant windows when dormant
// NEW for stage 3b:
const _windowLitCache  = new Map();  // bright "mini city" windows (POWER online)
const _flameCache      = new Map();  // chimney flame emissive
const _missileBodyMat  = new Map();  // missile body (metal + tint rim)
const _missileLightCache = new Map();// missile blinker lights (bright tint)

function _getBodyMat() {
  if (_bodyMatCache.has('_')) return _bodyMatCache.get('_');
  const m = new THREE.MeshStandardMaterial({
    color: 0x2a2a3a,
    roughness: 0.55,
    metalness: 0.6,
  });
  _bodyMatCache.set('_', m);
  return m;
}

// Brushed-silver metal used on the silo tube, cap, and armor panels.
// The default body mat is a very dark blue-grey that reads as near-black
// from the game's low-angle camera, giving the silo a flat black
// silhouette. Silver metal breaks that up and makes the silo look like
// an actual piece of military hardware next to the darker powerplant.
// Emissive tuned bright enough that the silo reads silver even in dim
// chapters (red/purple chapters had the earlier dim emissive washing
// into the environment color).
function _getSiloSilverMat(tint) {
  const key = 'silver:' + tint;
  if (_bodyMatCache.has(key)) return _bodyMatCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    color: 0xcfd4dc,          // brighter brushed silver
    emissive: 0xb8bec8,       // self-lit silver — locked to metal color,
                              // not chapter tint, so the silo reads as a
                              // silver object regardless of arena palette.
    emissiveIntensity: 0.22,  // up from 0.08 — makes the silo visibly pop
    roughness: 0.3,           // glossier than before so highlights bounce
    metalness: 0.9,           // reads as real polished metal
  });
  _bodyMatCache.set(key, m);
  return m;
}

// DoubleSide variant of the silver material — used ONLY for the launch-shaft
// tube. The tube geometry is `openEnded: true` (no caps on top/bottom) so
// the dome can slide off and reveal the shaft. With the default FrontSide
// material, back-face culling hid the tube's inside walls — once the dome
// opened, the camera looking down into the silo saw straight through to
// the far outside wall, making one side of the silo look un-textured.
// DoubleSide makes the interior render too.
function _getSiloSilverTubeMat(tint) {
  const key = 'silver-tube:' + tint;
  if (_bodyMatCache.has(key)) return _bodyMatCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    color: 0xcfd4dc,
    emissive: 0xb8bec8,
    emissiveIntensity: 0.22,
    roughness: 0.3,
    metalness: 0.9,
    side: THREE.DoubleSide,
  });
  _bodyMatCache.set(key, m);
  return m;
}

function _getAccentDim(tint) {
  let m = _accentDimCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x1a1a2a,
      emissive: tint,
      emissiveIntensity: 0.20,
      metalness: 0.4, roughness: 0.55,
    });
    _accentDimCache.set(tint, m);
  }
  return m;
}

function _getRimMat(tint) {
  let m = _rimCache.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x2a2a40,
      emissive: tint,
      emissiveIntensity: 0.6,
      metalness: 0.7, roughness: 0.35,
    });
    _rimCache.set(tint, m);
  }
  return m;
}

function _getWindowDim(tint) {
  let m = _windowDimCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    });
    _windowDimCache.set(tint, m);
  }
  return m;
}

// Stage 3b: once POWER completes, every powerplant window swaps to this
// material — bright, fully opaque, "mini city" feel.
function _getWindowLit(tint) {
  let m = _windowLitCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: false,
      opacity: 1.0,
      side: THREE.DoubleSide,
    });
    _windowLitCache.set(tint, m);
  }
  return m;
}

function _getFlameMat(tint) {
  let m = _flameCache.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.0,        // invisible while dormant; the updater bumps
                            // this up when the powerplant is lit
    });
    _flameCache.set(tint, m);
  }
  return m;
}

function _getMissileBodyMat(tint) {
  let m = _missileBodyMat.get(tint);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      emissive: tint,
      emissiveIntensity: 0.35,
      metalness: 0.75,
      roughness: 0.30,
    });
    _missileBodyMat.set(tint, m);
  }
  return m;
}

function _getMissileLightMat(tint) {
  let m = _missileLightCache.get(tint);
  if (!m) {
    // MeshBasic so it stays bright regardless of scene lighting; we pulse
    // the opacity each frame once the missile is up.
    m = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.9,
    });
    _missileLightCache.set(tint, m);
  }
  return m;
}

/** Prewarm every chapter's materials so the wave-2 prop spawn is free. */
export function prewarmWavePropsMats(tint) {
  _getBodyMat();
  _getAccentDim(tint);
  _getRimMat(tint);
  _getWindowDim(tint);
  _getWindowLit(tint);
  _getFlameMat(tint);
  _getMissileBodyMat(tint);
  _getMissileLightMat(tint);
}

// ---------------------------------------------------------------------------
// BUILDERS — return a group positioned at the layout coord. All returned
// groups are parented to the scene inside buildCentralCompound().
// ---------------------------------------------------------------------------

function _buildSilo(tint) {
  const g = new THREE.Group();
  g.position.set(LAYOUT.silo.x, 0, LAYOUT.silo.z);

  // --- BASE PLATE ---
  const base = new THREE.Mesh(SILO_BASE_GEO, _getAccentDim(tint));
  base.position.y = 0.25;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // --- OPEN TUBE (launch shaft) ---
  // Uses the DoubleSide silver variant so the interior walls render when
  // the dome is open and the camera can see down into the shaft.
  const tube = new THREE.Mesh(SILO_TUBE_GEO, _getSiloSilverTubeMat(tint));
  tube.position.y = 2.75;
  g.add(tube);

  // --- v6 DETAIL: 4 SUPPORT STRUTS ---
  // Angled vertical braces running from the base plate up the side of
  // the tube. One on each cardinal direction. These read as structural
  // reinforcement and break up the plain tube silhouette.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;   // 45° offset
    const strut = new THREE.Mesh(SILO_STRUT_GEO, _getAccentDim(tint));
    strut.position.set(Math.cos(a) * 2.1, 1.4, Math.sin(a) * 2.1);
    strut.rotation.y = -a;
    strut.castShadow = true;
    g.add(strut);

    // Warning light on top of each strut, chapter-tinted.
    const light = new THREE.Mesh(SILO_LIGHT_GEO, _getRimMat(tint));
    light.position.set(Math.cos(a) * 2.1, 2.55, Math.sin(a) * 2.1);
    g.add(light);
  }

  // --- v7 DETAIL: VERTICAL CORRUGATION RIBS ---
  // 20 thin silver ribs wrapping the full circumference at r ≈ 1.85. Each
  // rib is silver material so it picks up highlights separately from the
  // tube, giving the real corrugated-grain-silo texture you see on every
  // industrial bin. Replaces the old 4 armor panels (which were widely
  // spaced and read as "sci-fi bunker", not "grain silo").
  const RIB_COUNT = 20;
  const ribMat = _getSiloSilverMat(tint);
  for (let i = 0; i < RIB_COUNT; i++) {
    const a = (i / RIB_COUNT) * Math.PI * 2;
    const rib = new THREE.Mesh(SILO_RIB_GEO, ribMat);
    rib.position.set(Math.cos(a) * 1.85, 2.75, Math.sin(a) * 1.85);
    rib.rotation.y = -a;
    g.add(rib);
  }

  // --- v7 DETAIL: HORIZONTAL BANDING RINGS ---
  // Three wrapping bands at ~25%, 50%, 75% of the tube height. These
  // read as the bolted section seams on a real silo.
  const bandMat = _getSiloSilverMat(tint);
  for (let i = 0; i < 3; i++) {
    const band = new THREE.Mesh(SILO_BAND_GEO, bandMat);
    // Tube spans y = 0.5..5.0; place bands within that range.
    band.position.y = 1.6 + i * 1.2;
    band.rotation.x = Math.PI / 2;
    g.add(band);
  }

  // --- v6 DETAIL: CAUTION STRIPE near the top ---
  // Emissive chapter-tinted ring hugging the tube's upper portion.
  const stripe = new THREE.Mesh(SILO_STRIPE_GEO, _getRimMat(tint));
  stripe.position.y = 4.3;
  stripe.rotation.x = Math.PI / 2;
  g.add(stripe);

  // --- v6 DETAIL: ACCESS HATCH at the base ---
  const hatch = new THREE.Mesh(SILO_HATCH_GEO, _getAccentDim(tint));
  hatch.position.set(0, 1.1, 1.85);
  g.add(hatch);
  // Small emissive door indicator on the hatch.
  const hatchIndicator = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.08, 0.03),
    _getRimMat(tint),
  );
  hatchIndicator.position.set(0, 1.35, 1.93);
  g.add(hatchIndicator);

  // --- v7 DETAIL: CONICAL DOME + FINIAL ---
  // Replaces the old flat cap. The dome is a cone whose base sits flush
  // with the top of the tube; a small spherical finial crowns it. Named
  // `cap` so the existing launch-open animation (position.y + rotation
  // slide at stage 3b) still grabs this as its target.
  //
  // The cap is a Group holding the dome + finial together so they slide
  // off as one piece when the silo opens. The launch-open code mutates
  // position.x / position.y / rotation.z on `silo.cap` — those all
  // transform the whole Group, which is exactly what we want.
  const cap = new THREE.Group();
  cap.position.y = 5.1;
  const dome = new THREE.Mesh(SILO_DOME_GEO, _getSiloSilverMat(tint));
  dome.position.y = 0.7;   // cone origin is at its base; raise so tip is highest
  dome.castShadow = true;
  cap.add(dome);
  // Banding ring where the dome meets the tube — structural seam.
  const domeBand = new THREE.Mesh(SILO_DOME_BAND_GEO, _getSiloSilverMat(tint));
  domeBand.position.y = 0.05;
  domeBand.rotation.x = Math.PI / 2;
  cap.add(domeBand);
  // Finial sphere at the tip of the dome.
  const finial = new THREE.Mesh(SILO_FINIAL_GEO, _getSiloSilverMat(tint));
  finial.position.y = 1.45;
  cap.add(finial);
  g.add(cap);

  // Chapter-tinted rim around the opening — easy readable accent
  const rim = new THREE.Mesh(SILO_RIM_GEO, _getRimMat(tint));
  rim.position.y = 5.25;
  rim.rotation.x = Math.PI / 2;
  g.add(rim);

  // --- MISSILE (stage 3b: hidden inside the tube at rest; raises up
  //     above the silo when RADIO completes) ---
  const missile = new THREE.Group();
  // Rest Y = 1.8, below the silo top so it's invisible inside the shaft.
  // Stage 3b updater lerps this up to 6.5 over ~1.5s after RADIO.
  missile.position.y = 1.8;

  const missileBodyMat = _getMissileBodyMat(tint);
  const bodyMesh = new THREE.Mesh(MISSILE_BODY_GEO, missileBodyMat);
  bodyMesh.position.y = 0;
  bodyMesh.castShadow = true;
  missile.add(bodyMesh);

  const noseMesh = new THREE.Mesh(MISSILE_NOSE_GEO, missileBodyMat);
  noseMesh.position.y = 2.15;
  noseMesh.castShadow = true;
  missile.add(noseMesh);

  // Four fins in a cross pattern at the base of the missile body.
  for (let f = 0; f < 4; f++) {
    const fin = new THREE.Mesh(MISSILE_FIN_GEO, missileBodyMat);
    const a = f * (Math.PI / 2);
    fin.position.set(Math.sin(a) * 0.6, -1.3, Math.cos(a) * 0.6);
    fin.rotation.y = a;
    missile.add(fin);
  }

  // Blinker lights on all 4 sides of the missile body — 3 vertical
  // positions × 4 cardinal directions = 12 total. Stage 3b pulses their
  // opacity once the missile is raised. Having them on every side means
  // the player can see the blink no matter which way they're looking.
  // Each blinker clones the cached material so its opacity can be tweened
  // individually — otherwise all 12 would pulse in unison.
  const blinkerLights = [];
  const blinkMatShared = _getMissileLightMat(tint);
  for (let side = 0; side < 4; side++) {
    const a = side * (Math.PI / 2);
    const bx = Math.sin(a) * 0.58;
    const bz = Math.cos(a) * 0.58;
    for (let i = 0; i < 3; i++) {
      const perLightMat = blinkMatShared.clone();
      const light = new THREE.Mesh(MISSILE_LIGHT_GEO, perLightMat);
      light.position.set(bx, -0.8 + i * 0.9, bz);
      // Tag with side/index so the update loop can drive a rolling pattern.
      light.userData.side = side;
      light.userData.ring = i;     // 0 = bottom, 2 = top
      missile.add(light);
      blinkerLights.push(light);
    }
  }

  g.add(missile);
  // Hide the missile visually until stage 3b's activation fires.
  missile.visible = false;

  scene.add(g);
  return {
    obj: g, cap, tube, rim,
    missile,                // group reference for raise animation
    blinkerLights,          // for the blinker pulse
    // Animation state (driven by updateCompound)
    capOpenT: 0,            // 0 = closed, 1 = fully open
    capOpenTarget: 0,       // where capOpenT is heading
    missileRaiseT: 0,       // 0 = at rest (inside); 1 = fully up
    missileRaiseTarget: 0,  // where missileRaiseT is heading
  };
}

function _buildPowerplant(tint) {
  const g = new THREE.Group();
  g.position.set(LAYOUT.powerplant.x, 0, LAYOUT.powerplant.z);

  const base = new THREE.Mesh(PP_BASE_GEO, _getBodyMat());
  base.position.y = 0.2;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // Two stacks (power station chimneys) + a flame at each tip.
  const flames = [];
  const flameMat = _getFlameMat(tint);
  for (const sx of [-1.2, 1.2]) {
    const stack = new THREE.Mesh(PP_STACK_GEO, _getBodyMat());
    stack.position.set(sx, 2.0, -0.8);
    stack.castShadow = true;
    g.add(stack);

    const flame = new THREE.Mesh(PP_FLAME_GEO, flameMat);
    flame.position.set(sx, 3.95, -0.8);  // right above chimney top
    g.add(flame);
    flames.push(flame);
  }

  // Central reactor block (becomes a bright accent when POWER completes).
  const reactor = new THREE.Mesh(PP_BLOCK_GEO, _getAccentDim(tint));
  reactor.position.set(0, 1.0, 0.3);
  reactor.castShadow = true;
  g.add(reactor);

  // Window grid (dim at rest; swaps to lit material when POWER completes).
  const windows = [];
  const windowMat = _getWindowDim(tint);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const w = new THREE.Mesh(PP_WINDOW_GEO, windowMat);
      w.position.set(-0.5 + col * 0.5, 0.4 + row * 0.5, 0.91);
      g.add(w);
      windows.push(w);
    }
  }

  scene.add(g);
  return { obj: g, reactor, windows, flames, tint, lit: false };
}

function _buildRadioTower(tint) {
  const g = new THREE.Group();
  g.position.set(LAYOUT.radioTower.x, 0, LAYOUT.radioTower.z);

  const base = new THREE.Mesh(RT_BASE_GEO, _getAccentDim(tint));
  base.position.y = 0.2;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // Central mast
  const mast = new THREE.Mesh(RT_MAST_GEO, _getBodyMat());
  mast.position.y = 3.15;
  mast.castShadow = true;
  g.add(mast);

  // Three cross-struts along the mast
  for (let i = 0; i < 3; i++) {
    const y = 1.8 + i * 1.3;
    const strut = new THREE.Mesh(RT_STRUT_GEO, _getBodyMat());
    strut.position.y = y;
    g.add(strut);
    const strutPerp = strut.clone();
    strutPerp.rotation.y = Math.PI / 2;
    g.add(strutPerp);
  }

  // Beacon bulb at the top (chapter tint, dim by default)
  const bulb = new THREE.Mesh(RT_BULB_GEO, _getRimMat(tint));
  bulb.position.y = 6.0;
  g.add(bulb);

  scene.add(g);
  return { obj: g, bulb };
}

// ---------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------

let _current = null;

/**
 * Build the silo, powerplant, and radio tower for the given chapter.
 * Idempotent — a second call tears down the previous compound first.
 * Returns handles to every mesh so stage 3b/3c can animate them.
 */
export function buildCentralCompound(chapterIdx) {
  clearCentralCompound();
  // Recompute LAYOUT based on which triangle got assigned to wave 2
  // this chapter. Must happen BEFORE the builders run since they read
  // LAYOUT to place their props.
  _recomputeLayout();
  const tint = CHAPTERS[chapterIdx % CHAPTERS.length].full.grid1;
  _current = {
    silo: _buildSilo(tint),
    powerplant: _buildPowerplant(tint),
    radioTower: _buildRadioTower(tint),
  };
  return _current;
}

export function clearCentralCompound() {
  if (!_current) return;
  // Dispose per-blinker cloned materials before removing the silo group.
  // Each blinker owns its own material clone (so the rolling-pattern
  // updater can tweak opacity individually); shared cached materials
  // stay warm for the next chapter.
  if (_current.silo && _current.silo.blinkerLights) {
    for (const light of _current.silo.blinkerLights) {
      if (light.material && light.material.dispose) light.material.dispose();
    }
  }
  for (const part of [_current.silo, _current.powerplant, _current.radioTower]) {
    if (part && part.obj && part.obj.parent) scene.remove(part.obj);
  }
  _current = null;
}

/** Handle lookup for future stages (3b will light up the powerplant, etc). */
export function getCompound() { return _current; }

// ---------------------------------------------------------------------------
// STAGE 3B ACTIVATION API
// ---------------------------------------------------------------------------
//
// These helpers are called from waves.js as power-up zones complete. They
// flip the compound's animation-target flags; the actual tweens run
// per-frame inside updateCompound().
//
// Each helper is idempotent + safe to call with no compound built (no-op).

/**
 * POWER completed. Powerplant windows go bright, reactor block emissive
 * jumps, chimney flames start burning. Visual only — no mechanical side
 * effects live here.
 */
export function setPowerplantLit(isLit) {
  if (!_current || !_current.powerplant) return;
  const pp = _current.powerplant;
  if (pp.lit === !!isLit) return;
  pp.lit = !!isLit;

  // Swap the window material for every window mesh in one go. Because we
  // share the material, this is a cheap reference swap — no per-mesh
  // material mutation, and we don't leak dormant materials.
  const nextMat = isLit ? _getWindowLit(pp.tint) : _getWindowDim(pp.tint);
  for (const w of pp.windows) w.material = nextMat;

  // Reactor block emissive: clone-and-swap the shared accent material so
  // we don't bump other dormant users' brightness.
  if (isLit) {
    const reactorMat = pp.reactor.material.clone();
    reactorMat.emissiveIntensity = 2.5;
    pp.reactor.material = reactorMat;
  } else {
    pp.reactor.material = _getAccentDim(pp.tint);
  }
  // Flames: updater ramps opacity toward target based on pp.lit.
}

/**
 * RADIO completed. Cap slides open (rotates about its Y axis + tilts up)
 * and the missile raises from inside the silo over ~1.5s.
 */
export function openSiloAndRaiseMissile() {
  if (!_current || !_current.silo) return;
  const silo = _current.silo;
  silo.capOpenTarget = 1;
  silo.missileRaiseTarget = 1;
  if (silo.missile) silo.missile.visible = true;
}

/**
 * Wave-2 ended (EMP fired). Reset every animation target so the next
 * wave 2 in a new chapter starts from a clean dormant state. The
 * compound itself is torn down by clearCentralCompound on chapter end,
 * but this call is what flips the visuals back mid-chapter if the EMP
 * has already detonated.
 */
export function resetCompoundAnimations() {
  if (!_current) return;
  if (_current.silo) {
    _current.silo.capOpenTarget = 0;
    _current.silo.missileRaiseTarget = 0;
  }
  if (_current.powerplant) {
    setPowerplantLit(false);
  }
}

// ---------------------------------------------------------------------------
// PER-FRAME TICK
// ---------------------------------------------------------------------------
/**
 * Advance compound animations by dt.  Called unconditionally from the
 * main render loop; no-ops when no compound is built.
 *
 * Covers:
 *   - Silo cap sliding open/closed (rotation + Y offset)
 *   - Missile raising out of silo (Y position lerp)
 *   - Missile blinker lights pulsing once raised
 *   - Powerplant chimney flames ramping on/off + flicker
 */
export function updateCompound(dt, time) {
  if (!_current) return;

  // --- Silo cap + missile raise ---
  if (_current.silo) {
    const silo = _current.silo;

    // Cap: animate capOpenT toward capOpenTarget at ~1/s.
    {
      const target = silo.capOpenTarget;
      const cur = silo.capOpenT;
      const next = cur + (target - cur) * Math.min(1, dt * 2.5);
      silo.capOpenT = next;
      // Rendered cap transform: slides up + over + tilts.
      if (silo.cap) {
        silo.cap.position.y = 5.1 + next * 0.8;
        silo.cap.position.x = next * 2.4;
        silo.cap.rotation.z = next * 0.6;
      }
    }

    // Missile raise: 0 → 1 over ~1.5s.
    if (silo.missile && silo.missile.visible) {
      const target = silo.missileRaiseTarget;
      const cur = silo.missileRaiseT;
      const next = cur + (target - cur) * Math.min(1, dt * 1.2);
      silo.missileRaiseT = next;
      // Y lerp from 1.8 (inside tube) to 6.5 (fully above silo top).
      silo.missile.position.y = 1.8 + next * 4.7;

      // Blink the lights once the missile is mostly up. Each light's
      // opacity is driven by its side/ring so the pattern reads as a
      // rolling beacon spiraling up the missile — much cooler than all
      // 12 pulsing in unison.
      if (next > 0.6 && silo.blinkerLights && silo.blinkerLights.length) {
        const phase = time * 4.5;
        for (let i = 0; i < silo.blinkerLights.length; i++) {
          const light = silo.blinkerLights[i];
          const side = light.userData.side || 0;   // 0..3
          const ring = light.userData.ring || 0;   // 0..2
          // Rolling: each side is offset in phase, and higher rings lag
          // behind lower ones so the pattern climbs.
          const local = Math.sin(phase - side * (Math.PI / 2) - ring * 0.6);
          light.material.opacity = local > 0.2 ? 1.0 : 0.12;
        }
      }

      // When fully raised + past target, hold (target stays at 1).
      // Stage 3c will flip missileRaiseTarget to fire the launch.
    }
  }

  // --- Powerplant flames ---
  if (_current.powerplant) {
    const pp = _current.powerplant;
    // Flame opacity ramps to 0.85 when lit, flickers with a small sin.
    if (pp.flames && pp.flames.length) {
      const baseMat = pp.flames[0].material;
      const targetOpacity = pp.lit ? 0.85 : 0.0;
      const cur = baseMat.opacity;
      const eased = cur + (targetOpacity - cur) * Math.min(1, dt * 3);
      // Flicker — keep same shared material so all flames share it.
      baseMat.opacity = eased * (0.85 + 0.15 * Math.sin(time * 14));
      // Scale Y slightly to simulate flicker height.
      if (pp.lit) {
        for (const f of pp.flames) {
          const s = 0.9 + 0.15 * Math.sin(time * 11 + f.position.x * 2);
          f.scale.set(1, s, 1);
        }
      }
    }
  }

  // --- Retraction ---
  if (_retractActive) {
    _retractT = Math.min(RETRACT_DURATION, _retractT + dt);
    const f = _retractT / RETRACT_DURATION;
    const eased = f * f;  // ease-in — starts slow, speeds up as it descends
    const sinkY = -eased * 6;  // 0 → -6
    if (_current.silo && _current.silo.obj) _current.silo.obj.position.y = sinkY;
    if (_current.powerplant && _current.powerplant.obj) _current.powerplant.obj.position.y = sinkY;
    if (_current.radioTower && _current.radioTower.obj) _current.radioTower.obj.position.y = sinkY;
    // Turrets too — read their group objs through the getter.
    if (_turretsGetter) {
      const turrets = _turretsGetter();
      if (turrets) {
        for (const t of turrets) {
          if (t && t.obj) t.obj.position.y = sinkY;
        }
      }
    }
    if (f >= 1) {
      _retractActive = false;
      // Force-snap the silo cap and missile to fully closed rest positions.
      // resetCompoundAnimations() flipped the targets to 0 but the per-frame
      // lerp may not have fully converged by retraction end — meaning the
      // cap could be parked slightly off-center / tilted, with its open
      // x-offset (+2.4u) carrying into wave 3. At y=-6 that x-offset would
      // leave the cap peeking up out of the ground to the side of the buried
      // silo. Snap it so no matter what state the lerp was in, the cap is
      // exactly where a closed silo would want it.
      if (_current.silo) {
        const silo = _current.silo;
        silo.capOpenT = 0;
        silo.capOpenTarget = 0;
        if (silo.cap) {
          silo.cap.position.set(0, 5.1, 0);
          silo.cap.rotation.z = 0;
        }
        silo.missileRaiseT = 0;
        silo.missileRaiseTarget = 0;
        if (silo.missile) {
          silo.missile.position.y = 1.8;
          silo.missile.visible = false;
        }
      }

      // BULLETPROOF CLEANUP — once the sink animation is done, toggle every
      // retracted group invisible. Sinking to y=-6 only buries them ~0.9m
      // below ground (silo is 4.5m tall, cap sits 5.1m up in local space),
      // which can leave the very top peeking through if the camera angle
      // is shallow. Flipping `.visible = false` guarantees nothing from
      // the wave-2 compound can bleed into wave 3.
      if (_current.silo && _current.silo.obj) _current.silo.obj.visible = false;
      if (_current.powerplant && _current.powerplant.obj) _current.powerplant.obj.visible = false;
      if (_current.radioTower && _current.radioTower.obj) _current.radioTower.obj.visible = false;
      if (_turretsGetter) {
        const turrets = _turretsGetter();
        if (turrets) {
          for (const t of turrets) {
            if (t && t.obj) t.obj.visible = false;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LAUNCH TRIGGER + CINEMATIC HANDLES
// ---------------------------------------------------------------------------
//
// The launch trigger is now driven by the LAUNCH power-up zone (see
// powerupZones.js stage 3) — the player stands at the base of the raised
// missile and holds the zone for a few seconds, which calls the
// registered launch handler. waves.js registers startLaunch() here at
// module load.
//
// hideSiloMissile + getSiloLaunchOrigin are called by empLaunch.js when
// the cinematic takes over.

let _launchHandler = null;

/** Register the callback fired when the LAUNCH zone completes. */
export function registerLaunchHandler(fn) {
  _launchHandler = fn;
}

/** Fire the registered launch handler, if any. Called from waves.js on
 *  the LAUNCH zone completion event. Idempotent — callers protect
 *  against re-entry via S.powerupEmpFired. */
export function triggerLaunch() {
  if (_launchHandler) {
    try { _launchHandler(); }
    catch (err) { console.warn('[waveProps] launch handler threw:', err); }
  }
}

/** Hide the missile's in-silo copy once the launch cinematic has taken
 *  over. empLaunch.js swaps in its own moving missile mesh so the
 *  static one can go away. */
export function hideSiloMissile() {
  if (!_current || !_current.silo) return;
  const silo = _current.silo;
  if (silo.missile) silo.missile.visible = false;
}

/** World position of the silo top — used by empLaunch to spawn the
 *  flight-missile copy at the right place. */
export function getSiloLaunchOrigin() {
  if (!_current || !_current.silo) return null;
  const base = _current.silo.obj.position;
  // Silo cap y was 5.1; missile peak sits around 6.5 when raised.
  return new THREE.Vector3(base.x, 6.5, base.z);
}

// ---------------------------------------------------------------------------
// COMPOUND RETRACTION (Stage 3+ polish)
// ---------------------------------------------------------------------------
//
// After the EMP detonation, the whole compound (silo, powerplant, radio
// tower, turrets — the turrets live in turrets.js but we animate them
// via the same timer here) retracts into the ground over ~2s. Lore:
// "safety mechanisms retract when systems fail." Visually: every group's
// Y position lerps from 0 → -6 and then everything clears.
//
// Usage:
//   startCompoundRetraction()  — called from waves.js _fireEmp epilogue
//                                 after resetCompoundAnimations/wire reset
//   Per-frame tick happens inside updateCompound() which is already
//   called every frame from main.js.
//
// When retraction completes, the meshes remain at y=-6 (invisible under
// the floor). The next chapter's prepareChapter() tears everything down
// and rebuilds at y=0, so there's no leaked state between chapters.

let _retractT = 0;
let _retractActive = false;
const RETRACT_DURATION = 2.0;

/** Begin retracting the whole compound into the ground. Idempotent. */
export function startCompoundRetraction() {
  if (_retractActive) return;
  if (!_current) return;
  _retractActive = true;
  _retractT = 0;
}

/** Is a retraction currently in progress? (waves.js polls this to know
 *  when it can trigger chapter-end cleanup.) */
export function isRetracting() {
  return _retractActive;
}

/** Cached import — we need the turret array from turrets.js to animate
 *  them alongside the silo/powerplant/radio. We can't import at the top
 *  of this file without risking a circular import (turrets.js imports
 *  LAYOUT from us), so we read the group positions lazily from the
 *  object returned by getTurrets(). */
let _turretsGetter = null;
export function _setTurretsGetter(fn) { _turretsGetter = fn; }

// ---------------------------------------------------------------------------
// COLLISION — silo + turrets as solid obstacles.
//
// The silo is a cylinder ~2.4u radius at its base. Each turret is a cylinder
// of ~1.0u radius at its base. Neither should be walkable through by the
// player or enemies once they're standing in the arena. We expose a single
// push-out helper that resolves both in one pass so callers don't have to
// duplicate loops.
//
// NOTE: we only collide during waves where these props are present. The
// compound is built by prepareChapter (via buildCentralCompound) at chapter
// start and cleared by teardownChapter at chapter end — but until retraction
// finishes the meshes remain visible and must remain solid. A caller can
// always safely call this every frame; if the compound isn't present we
// early-out.
// ---------------------------------------------------------------------------
const _SILO_COLLIDE_R = 2.6;    // slightly > the SILO_BASE_GEO radius
const _TURRET_COLLIDE_R = 1.2;  // slightly > the TURRET base disk

/**
 * Push `pos` out of the silo + turret obstacles. `entityRadius` is the
 * caller's own radius (player ~0.8u, enemy ~0.5u). Mutates `pos` in place.
 * Safe to call unconditionally — no-ops when the compound isn't built or
 * when props have retracted.
 */
export function resolveCompoundCollision(pos, entityRadius) {
  if (!_current) return;

  // Silo — only solid while its group is at normal y (retraction sinks it).
  if (_current.silo && _current.silo.obj && _current.silo.obj.parent) {
    // During retraction, props slide underground. Once their y drops below
    // -0.5 there's nothing left above ground to collide with. This lets
    // EMP cleanup / chapter-end retraction "open" the space cleanly.
    if (_current.silo.obj.position.y > -0.5) {
      _pushOutCircle(pos, entityRadius, LAYOUT.silo.x, LAYOUT.silo.z, _SILO_COLLIDE_R);
    }
  }

  // Turrets. Use live turret objects (from turrets.js) so we respect any
  // retraction their groups perform — but fall back to LAYOUT positions
  // when the getter isn't wired yet (init race).
  const liveTurrets = _turretsGetter ? _turretsGetter() : null;
  if (liveTurrets && liveTurrets.length) {
    for (const t of liveTurrets) {
      if (!t || !t.obj || !t.obj.parent) continue;
      if (t.obj.position.y < -0.5) continue;   // already sunk
      _pushOutCircle(pos, entityRadius, t.pos.x, t.pos.z, _TURRET_COLLIDE_R);
    }
  } else {
    // Fallback — compound exists but turret module hasn't exposed them yet.
    for (const tp of LAYOUT.turrets) {
      _pushOutCircle(pos, entityRadius, tp.x, tp.z, _TURRET_COLLIDE_R);
    }
  }
}

function _pushOutCircle(pos, entityR, cx, cz, obstacleR) {
  const dx = pos.x - cx;
  const dz = pos.z - cz;
  const minD = entityR + obstacleR;
  const d2 = dx * dx + dz * dz;
  if (d2 >= minD * minD) return;
  const d = Math.sqrt(d2) || 0.0001;
  const overlap = minD - d;
  pos.x += (dx / d) * overlap;
  pos.z += (dz / d) * overlap;
}
