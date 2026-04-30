// mineField.js — Anti-personnel mines deployed by the MINE FIELD
// stratagem. Three damage kinds, selectable per stratagem code:
//
//   'explosion' — high-burst AoE damage on detonation. Standard
//                 frag mine; reads as the chapter-tinted classic.
//   'fire'      — smaller burst + leaves a fire patch that ticks
//                 DPS for ~3.5s. Color-shifted toward warm orange.
//   'poison'    — green-tinted mine that puffs a toxic cloud on
//                 trigger. Lower burst damage but applies a 4-second
//                 poison DoT to any enemy in cloud radius.
//
// Mines lay flat on the floor, sit dormant until an enemy steps
// within trigger radius, then beep for ~0.45s before firing.
//
// Public API:
//   deployMineField(centerPos, tint, kind)  — scatter mines around
//                                             centerPos. kind defaults
//                                             to 'explosion'.
//   updateMines(dt)                         — per-frame tick (proximity,
//                                             arming, detonation, fire-patch
//                                             ticking, poison-cloud DPS).
//   clearAllMines()                         — wipe all (game reset).

import * as THREE from 'three';
import { scene } from './scene.js';
import { hitBurst } from './effects.js';
import { enemies } from './enemies.js';
import { Audio } from './audio.js';
import { S } from './state.js';
import { player } from './player.js';
import { isPiloting } from './mech.js';

const MINE_COUNT          = 12;
const MINE_SPREAD_RADIUS  = 5.5;
const MINE_TRIGGER_RADIUS = 1.6;
const MINE_BEEP_DUR       = 0.45;          // arming/warning before detonation

// =====================================================================
// PER-KIND TUNING
// =====================================================================
// Each kind is a knob set tuned for a distinct combat role.
const _KIND_CONFIG = {
  explosion: {
    aoeRadius: 3.4,
    aoeDamage: 200,
    bodyColor: 0x2a2c34,                      // dark gunmetal
    lightHex:  null,                          // null = use chapter tint
    burstColor: 0xffaa00,
    secondaryBurstColor: 0xff5520,
    spawnPatch: false,
    spawnPoisonCloud: false,
  },
  fire: {
    aoeRadius: 2.6,
    aoeDamage: 130,
    bodyColor: 0x3a1f12,                      // scorched brown
    lightHex:  0xff7a30,                      // orange override
    burstColor: 0xff5520,
    secondaryBurstColor: 0xffaa00,
    spawnPatch: true,
    patchRadius: 2.6,
    patchDur: 3.5,
    patchDps: 70,
    patchColor: 0xff5520,
    spawnPoisonCloud: false,
  },
  poison: {
    aoeRadius: 3.0,
    aoeDamage: 80,                            // smaller burst
    bodyColor: 0x1f2a14,                      // dark moss
    lightHex:  0x7af797,                      // bright green override
    burstColor: 0x7af797,
    secondaryBurstColor: 0xb3ffd0,
    spawnPatch: false,
    spawnPoisonCloud: true,
    cloudRadius: 3.4,
    cloudDur: 4.0,
    cloudDps: 55,
    cloudColor: 0x7af797,
  },
};

// =====================================================================
// SHARED GEOMETRY
// =====================================================================
const _MINE_BASE_GEO   = new THREE.CylinderGeometry(0.32, 0.36, 0.18, 14);
const _MINE_LIGHT_GEO  = new THREE.SphereGeometry(0.10, 10, 8);
const _PATCH_GEO       = new THREE.CircleGeometry(1.0, 28);
const _CLOUD_PUFF_GEO  = new THREE.SphereGeometry(0.55, 10, 8);

const _activeMines = [];
const _activePatches = [];      // fire patches from 'fire' mines
const _activeClouds = [];       // poison clouds from 'poison' mines

// Active dispenser drones (one per active deployment, despawns once
// it has ejected all its mines and faded out).
const _activeDispensers = [];

// Mines in flight from the dispenser to the ground. These are
// pre-armed (visible mine body) but lack proximity logic until they
// land — at which point they're promoted into _activeMines.
const _airborneMines = [];

// =====================================================================
// MINE DEPLOYER GEOMETRY
// =====================================================================
// The deployer is a stationary ground installation, not a drone. It
// emerges from the floor, then ejects mines outward from the cells
// on its hex tower over ~2 seconds.
//
// Form factor (matches the reference photo):
//   • Hexagonal central hub (the "deck") with 3 long flat arms
//     extending at 120° intervals, like landing struts.
//   • Tall hexagonal column (the magazine) on top of the hub. Sides
//     are panels covered in glowing circle-with-triangle "cell" ports
//     painted in chapter-tint emissive over a black body.
//   • Top cap on the column with a control plate.
//   • Yellow LED strip across the front of the deck (an "arm/active"
//     status indicator).

const _DEPLOY_HUB_GEO     = new THREE.CylinderGeometry(1.40, 1.55, 0.55, 8);
const _DEPLOY_HUB_LIP_GEO = new THREE.CylinderGeometry(1.55, 1.55, 0.10, 8);
const _DEPLOY_ARM_GEO     = new THREE.BoxGeometry(0.85, 0.18, 2.40);
const _DEPLOY_ARM_PAD_GEO = new THREE.BoxGeometry(1.10, 0.10, 0.85);
const _DEPLOY_COL_GEO     = new THREE.CylinderGeometry(1.10, 1.10, 2.95, 6);
// Top cap: slightly wider than the column, also hex.
const _DEPLOY_CAP_GEO     = new THREE.CylinderGeometry(1.22, 1.18, 0.28, 6);
const _DEPLOY_CAP_PLATE_GEO = new THREE.CylinderGeometry(0.55, 0.55, 0.06, 6);
// Status strip on front of deck — small bar of glowing yellow.
const _DEPLOY_STRIP_GEO   = new THREE.BoxGeometry(1.10, 0.10, 0.06);

const DEPLOYER_RISE_DEPTH    = 4.0;
const DEPLOYER_RISE_DURATION = 0.95;
const DEPLOYER_EJECT_DELAY   = 0.16;       // seconds between mine ejects
const DEPLOYER_LINGER        = 6.0;        // sits idle this long after ejecting all mines

// =====================================================================
// DEPLOY
// =====================================================================
// Builds the stationary deployer at centerPos buried below the floor;
// rise animation lifts it into place over DEPLOYER_RISE_DURATION.
// Once landed it ejects mines through the column cells one at a time
// while the column slowly rotates. Each mine arcs outward and lands
// on the ground, where it joins the proximity-armed pool.
export function deployMineField(centerPos, tint, kind) {
  const k = (kind && _KIND_CONFIG[kind]) ? kind : 'explosion';
  const cfg = _KIND_CONFIG[k];
  const lightHex = cfg.lightHex != null ? cfg.lightHex : tint;
  const lightColor = new THREE.Color(lightHex);

  // Yellow accent — kept fixed regardless of mine kind, so the
  // deployer reads as the same "machine" type in every chapter.
  const accentColor = new THREE.Color(0xfff060);

  // ---- ROOT (buried below floor; rise animation lifts to y=0) ----
  const root = new THREE.Group();
  root.position.set(centerPos.x, -DEPLOYER_RISE_DEPTH, centerPos.z);

  // Materials.
  const deckMat = new THREE.MeshStandardMaterial({
    color: 0x1c1d22,
    roughness: 0.55,
    metalness: 0.55,
  });
  const lipMat = new THREE.MeshStandardMaterial({
    color: 0x111216,
    roughness: 0.45,
    metalness: 0.70,
  });
  const armMat = new THREE.MeshStandardMaterial({
    color: 0x1c1d22,
    roughness: 0.65,
    metalness: 0.45,
  });
  const armPadMat = new THREE.MeshStandardMaterial({
    color: 0x121317,
    roughness: 0.50,
    metalness: 0.65,
  });
  const colMat = new THREE.MeshStandardMaterial({
    color: 0x0f1014,
    roughness: 0.60,
    metalness: 0.40,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: 0x1c1d22,
    roughness: 0.55,
    metalness: 0.55,
  });
  const plateMat = new THREE.MeshStandardMaterial({
    color: 0x0a0b0f,
    emissive: lightColor,
    emissiveIntensity: 0.35,
    roughness: 0.45,
    metalness: 0.75,
  });
  const stripMat = new THREE.MeshBasicMaterial({
    color: accentColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  // ---- DECK ----
  const hub = new THREE.Mesh(_DEPLOY_HUB_GEO, deckMat);
  hub.position.y = 0.40;
  root.add(hub);
  const lip = new THREE.Mesh(_DEPLOY_HUB_LIP_GEO, lipMat);
  lip.position.y = 0.65;
  root.add(lip);

  // ---- 3 LANDING ARMS (120° apart) ----
  // Each arm is a long flat box jutting outward from the hub, capped
  // at the far end with a wider pad. Pad sits flush with the ground.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;   // 30° offset so an arm faces forward
    // Arm body — local +Z is "outward" before rotation.
    const arm = new THREE.Mesh(_DEPLOY_ARM_GEO, armMat);
    arm.position.set(Math.cos(a) * 1.55, 0.18, Math.sin(a) * 1.55);
    arm.rotation.y = -a + Math.PI / 2;       // rotate so length points outward
    root.add(arm);
    // End pad — at the far end of the arm.
    const pad = new THREE.Mesh(_DEPLOY_ARM_PAD_GEO, armPadMat);
    const padDist = 2.65;
    pad.position.set(Math.cos(a) * padDist, 0.10, Math.sin(a) * padDist);
    pad.rotation.y = -a + Math.PI / 2;
    root.add(pad);
  }

  // ---- FRONT STATUS STRIP ----
  // Yellow LED bar on the deck's front face. We pick "front" as the
  // arm at angle = Math.PI/6 (the +x-ish arm); place the strip on the
  // outer face of the hub between the front arm and the column.
  {
    const a = Math.PI / 6;
    const strip = new THREE.Mesh(_DEPLOY_STRIP_GEO, stripMat);
    strip.position.set(
      Math.cos(a) * 1.43,
      0.55,
      Math.sin(a) * 1.43,
    );
    strip.rotation.y = -a + Math.PI / 2;
    root.add(strip);
  }

  // ---- COLUMN (rotating) ----
  // Hex column with 6 sides. Each side is a panel of glowing
  // circle-with-triangle cells (the mine ports). The column rotates
  // slowly so different facets eject sequentially. We rotate the
  // entire columnGroup (not just material UVs) so the cell sprite
  // texture's normal lines up with the player's view — looks more
  // mechanical.
  const columnGroup = new THREE.Group();
  columnGroup.position.y = 0.80 + 1.475;
  root.add(columnGroup);

  // Body — hex prism (CylinderGeometry with 6 segments is a hexagon).
  const col = new THREE.Mesh(_DEPLOY_COL_GEO, colMat);
  columnGroup.add(col);

  // Cell-grid panels on each of the 6 hex faces. Drawn on a shared
  // canvas texture and applied as side decals — much cheaper than
  // building each cell as separate geometry.
  const cellTex = _buildMineCellTexture(accentColor);
  // Apply the texture as 6 plane decals around the prism, one per
  // face. Each plane sits flush against its hex side.
  const HEX_R = 1.10;            // matches column radius
  const HEX_APOTHEM = HEX_R * Math.cos(Math.PI / 6);   // distance from center to face
  const FACE_W = HEX_R * 2 * Math.sin(Math.PI / 6);    // face width
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;     // face normals at 30° offsets
    const planeMat = new THREE.MeshBasicMaterial({
      map: cellTex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(FACE_W * 1.02, 2.85),
      planeMat,
    );
    plane.position.set(Math.cos(a) * (HEX_APOTHEM + 0.005), 0, Math.sin(a) * (HEX_APOTHEM + 0.005));
    // Plane normal needs to face outward (-a relative to +z forward).
    plane.rotation.y = -a + Math.PI / 2;
    columnGroup.add(plane);
  }

  // ---- TOP CAP ----
  const cap = new THREE.Mesh(_DEPLOY_CAP_GEO, capMat);
  cap.position.y = 1.475 + 0.14;
  columnGroup.add(cap);
  const plate = new THREE.Mesh(_DEPLOY_CAP_PLATE_GEO, plateMat);
  plate.position.y = 1.475 + 0.30;
  columnGroup.add(plate);
  // Tiny ring of cross-shaped emissive lines on the plate top — read
  // as a control surface. Cheap: 4 thin boxes at 90°.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.02, 0.32),
      new THREE.MeshBasicMaterial({
        color: accentColor,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    line.position.set(Math.cos(a) * 0.18, 1.475 + 0.34, Math.sin(a) * 0.18);
    line.rotation.y = a;
    columnGroup.add(line);
  }

  scene.add(root);

  const dispenser = {
    root,
    columnGroup,
    cellTex,
    materials: [
      deckMat, lipMat, armMat, armPadMat, colMat, capMat, plateMat, stripMat,
    ],
    centerPos: new THREE.Vector3(centerPos.x, 0, centerPos.z),
    tint,
    lightColor,
    accentColor,
    cfg,
    kind: k,
    phase: 'rising',     // rising → ejecting → idle → done
    phaseT: 0,
    ejectIdx: 0,
    ejectTimer: 0,
    spinAngle: 0,
    minesToEject: MINE_COUNT,
    riseAudioFired: false,
  };
  _activeDispensers.push(dispenser);
}

// Build a CanvasTexture for the mine-cell pattern: a grid of glowing
// circles each with a small triangle inset. The reference image shows
// 5 rows × ~3-visible-columns of these on each hex face. We bake one
// canvas and reuse it for all 6 faces.
function _buildMineCellTexture(accentColor) {
  const w = 256, h = 640;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  // Background — black with very faint vertical seam lines for a
  // "panel" feel.
  ctx.fillStyle = '#0a0b0f';
  ctx.fillRect(0, 0, w, h);
  // Faint seam stripes.
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 24) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  // Mine cell pattern — circle + smaller arc indicators + triangle
  // center, painted in chapter-yellow accent.
  const accentHex = '#' + accentColor.getHexString();
  const cols = 3;
  const rows = 6;
  const cellW = w / cols;
  const cellH = h / rows;
  const radius = Math.min(cellW, cellH) * 0.35;
  ctx.lineWidth = 4;
  ctx.strokeStyle = accentHex;
  ctx.fillStyle = accentHex;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = c * cellW + cellW / 2;
      const cy = r * cellH + cellH / 2;
      // Outer broken circle (4 arcs, gaps at cardinal points).
      for (let q = 0; q < 4; q++) {
        const a0 = q * Math.PI / 2 + 0.18;
        const a1 = (q + 1) * Math.PI / 2 - 0.18;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, a0, a1);
        ctx.stroke();
      }
      // Inner triangle.
      ctx.beginPath();
      const tr = radius * 0.42;
      ctx.moveTo(cx, cy - tr);
      ctx.lineTo(cx + tr * 0.866, cy + tr * 0.5);
      ctx.lineTo(cx - tr * 0.866, cy + tr * 0.5);
      ctx.closePath();
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// =====================================================================
// DISPENSER TICK
// =====================================================================
function _tickDispensers(dt) {
  for (let i = _activeDispensers.length - 1; i >= 0; i--) {
    const d = _activeDispensers[i];
    d.phaseT += dt;
    // Column rotates continuously so different facets face the player
    // as it ejects. Faster while actively ejecting, slow idle spin
    // afterward for visual life.
    const spinRate = d.phase === 'ejecting' ? 1.2 : 0.4;
    d.spinAngle += dt * spinRate;
    d.columnGroup.rotation.y = d.spinAngle;

    if (d.phase === 'rising') {
      if (!d.riseAudioFired) {
        d.riseAudioFired = true;
        try { Audio.mechRise(); } catch (_) {}
        // Initial dirt burst at the deployer's position.
        const gp = new THREE.Vector3(d.centerPos.x, 0, d.centerPos.z);
        hitBurst(gp, 0x8a6a44, 22);
        hitBurst(gp, 0x4a3422, 14);
      }
      const f = Math.min(1, d.phaseT / DEPLOYER_RISE_DURATION);
      // Ease-out so it slows as it reaches its final height.
      const eased = 1 - Math.pow(1 - f, 2.4);
      d.root.position.y = -DEPLOYER_RISE_DEPTH * (1 - eased);
      // Periodic dust as it surfaces.
      d._dustT = (d._dustT || 0) + dt;
      if (d._dustT > 0.10 && f < 0.85) {
        d._dustT = 0;
        const gp = new THREE.Vector3(d.centerPos.x, 0.05, d.centerPos.z);
        hitBurst(gp, 0x8a6a44, 5);
      }
      if (f >= 1) {
        d.phase = 'ejecting';
        d.phaseT = 0;
        d.root.position.y = 0;
        try { Audio.mechLand(); } catch (_) {}
      }
    } else if (d.phase === 'ejecting') {
      d.ejectTimer -= dt;
      if (d.ejectTimer <= 0 && d.ejectIdx < d.minesToEject) {
        d.ejectTimer = DEPLOYER_EJECT_DELAY;
        _ejectMineFromDispenser(d);
        d.ejectIdx++;
        try { Audio.mineDispenserWhir(); } catch (_) {}
      }
      if (d.ejectIdx >= d.minesToEject) {
        d.phase = 'idle';
        d.phaseT = 0;
      }
    } else if (d.phase === 'idle') {
      // Sit on the field. The deployer remains visible as a deployed
      // installation; despawn after DEPLOYER_LINGER so it doesn't
      // clutter the arena forever (the mines themselves stay).
      if (d.phaseT >= DEPLOYER_LINGER) {
        d.phase = 'done';
      }
    } else if (d.phase === 'done') {
      _disposeDispenser(d);
      _activeDispensers.splice(i, 1);
    }
  }
}

function _disposeDispenser(d) {
  if (d.root.parent) scene.remove(d.root);
  for (const m of d.materials || []) {
    try { if (m && m.dispose) m.dispose(); } catch (_) {}
  }
  if (d.cellTex) d.cellTex.dispose();
  // Plane materials we built per-face also need disposal. They live
  // on children of d.columnGroup; walk the children.
  if (d.columnGroup) {
    d.columnGroup.traverse((node) => {
      if (node.material && node.material !== d.materials) {
        try { node.material.dispose && node.material.dispose(); } catch (_) {}
      }
      if (node.geometry && node.geometry !== _DEPLOY_COL_GEO &&
          node.geometry !== _DEPLOY_CAP_GEO &&
          node.geometry !== _DEPLOY_CAP_PLATE_GEO) {
        try { node.geometry.dispose && node.geometry.dispose(); } catch (_) {}
      }
    });
  }
}

// =====================================================================
// MINE EJECT (from dispenser)
// =====================================================================
// Build the mine body, attach it as an airborne projectile that arcs
// outward + down with gravity. On ground impact it converts into a
// proper proximity-armed mine.
function _ejectMineFromDispenser(d) {
  const cfg = d.cfg;
  const lightHex = cfg.lightHex != null ? cfg.lightHex : d.tint;
  const lightColor = new THREE.Color(lightHex);

  const baseMat = new THREE.MeshStandardMaterial({
    color: cfg.bodyColor,
    emissive: lightColor,
    emissiveIntensity: 0.4,
    roughness: 0.55,
    metalness: 0.70,
  });
  const lightMat = new THREE.MeshBasicMaterial({
    color: lightColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  const root = new THREE.Group();
  // Eject from the rotating column at the column's mid-height. We
  // use the column's current rotation so mines fire from whichever
  // facet faces "out" right now.
  const a = d.spinAngle + (d.ejectIdx * 0.41);
  const HUB_Y = 0.80 + 1.475;       // matches columnGroup.position.y in build
  const colR = 1.20;
  root.position.set(
    d.centerPos.x + Math.cos(a) * colR,
    HUB_Y + (Math.random() - 0.5) * 1.0,
    d.centerPos.z + Math.sin(a) * colR,
  );
  const base = new THREE.Mesh(_MINE_BASE_GEO, baseMat);
  root.add(base);
  const light = new THREE.Mesh(_MINE_LIGHT_GEO, lightMat);
  light.position.y = 0.12;
  root.add(light);
  scene.add(root);

  // Eject vector — outward in +a direction, into the field.
  const r = MINE_SPREAD_RADIUS * (0.65 + Math.random() * 0.45);
  const targetX = d.centerPos.x + Math.cos(a) * r;
  const targetZ = d.centerPos.z + Math.sin(a) * r;

  const dx = targetX - root.position.x;
  const dz = targetZ - root.position.z;
  const T = 0.55;
  const G = 18;
  const vx = dx / T;
  const vz = dz / T;
  const y0 = root.position.y;
  const vy = (0.5 * G * T * T - y0) / T;

  _airborneMines.push({
    root, base, baseMat,
    light, lightMat,
    pos: new THREE.Vector3(root.position.x, root.position.y, root.position.z),
    vel: new THREE.Vector3(vx, vy, vz),
    spin: new THREE.Vector3(
      (Math.random() - 0.5) * 12,
      Math.random() * 8,
      (Math.random() - 0.5) * 12,
    ),
    tint: d.tint,
    cfg, kind: d.kind,
  });
}

function _tickAirborneMines(dt) {
  const G = 18;
  for (let i = _airborneMines.length - 1; i >= 0; i--) {
    const a = _airborneMines[i];
    a.vel.y -= G * dt;
    a.pos.x += a.vel.x * dt;
    a.pos.y += a.vel.y * dt;
    a.pos.z += a.vel.z * dt;
    a.root.position.copy(a.pos);
    // Tumble.
    a.root.rotation.x += a.spin.x * dt;
    a.root.rotation.y += a.spin.y * dt;
    a.root.rotation.z += a.spin.z * dt;
    if (a.pos.y <= 0.09) {
      // Land — settle flat, promote to active mine.
      a.pos.y = 0.09;
      a.root.position.y = 0.09;
      a.root.rotation.set(0, 0, 0);
      try { Audio.mineArm(); } catch (_) {}
      // Tiny dirt puff.
      hitBurst(new THREE.Vector3(a.pos.x, 0.06, a.pos.z), 0x8a6a44, 4);
      _activeMines.push({
        root: a.root,
        base: a.base, baseMat: a.baseMat,
        light: a.light, lightMat: a.lightMat,
        kind: a.kind,
        cfg: a.cfg,
        tint: a.tint,
        pos: new THREE.Vector3(a.pos.x, 0, a.pos.z),
        armed: true,
        beeping: false,
        beepT: 0,
        detonated: false,
        detonateT: 0,
        pulsePhase: Math.random() * Math.PI * 2,
      });
      _airborneMines.splice(i, 1);
    }
  }
}

// =====================================================================
// PER-FRAME TICK
// =====================================================================
export function updateMines(dt) {
  // --- Dispenser drones (must tick FIRST since they spawn airborne
  // mines this frame which the airborne tick then advances). ---
  _tickDispensers(dt);
  _tickAirborneMines(dt);

  // --- Mines ---
  for (let i = _activeMines.length - 1; i >= 0; i--) {
    const m = _activeMines[i];
    if (!m.beeping && !m.detonated) {
      // Idle pulse on the light.
      m.pulsePhase += dt * 1.5;
      m.lightMat.opacity = 0.6 + 0.35 * Math.sin(m.pulsePhase);
      // Proximity check.
      const r2 = MINE_TRIGGER_RADIUS * MINE_TRIGGER_RADIUS;
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (!e || !e.pos || e.dying) continue;
        const dx = e.pos.x - m.pos.x;
        const dz = e.pos.z - m.pos.z;
        if (dx * dx + dz * dz < r2) {
          m.beeping = true;
          m.beepT = 0;
          try { Audio.mineBeep(); } catch (_) {}
          break;
        }
      }
    } else if (m.beeping && !m.detonated) {
      const wasT = m.beepT;
      m.beepT += dt;
      // Mid-beep secondary chirp at the halfway mark for an audible
      // "winding up" — adds urgency to the warning window.
      if (wasT < MINE_BEEP_DUR * 0.55 && m.beepT >= MINE_BEEP_DUR * 0.55) {
        try { Audio.mineBeep(); } catch (_) {}
      }
      // Fast pulse during the beep window.
      const pulse = 0.5 + 0.5 * Math.sin(m.beepT * 28);
      m.lightMat.opacity = 0.4 + pulse * 0.6;
      m.baseMat.emissiveIntensity = 0.4 + pulse * 1.0;
      if (m.beepT >= MINE_BEEP_DUR) {
        _detonateMine(m);
      }
    } else if (m.detonated) {
      // Brief lingering smoke — disposed at end.
      m.detonateT += dt;
      if (m.detonateT > 0.6) {
        _disposeMine(m);
        _activeMines.splice(i, 1);
      }
    }
  }

  // --- Fire patches (from 'fire' mines) ---
  for (let i = _activePatches.length - 1; i >= 0; i--) {
    const p = _activePatches[i];
    p.life += dt;
    const f = p.life / p.ttl;
    if (f >= 1) {
      if (p.disc.parent) p.disc.parent.remove(p.disc);
      if (p.mat) p.mat.dispose();
      _activePatches.splice(i, 1);
      continue;
    }
    // Pulse + fade.
    const pulse = 0.5 + 0.5 * Math.sin(p.life * 7);
    p.mat.opacity = (0.55 + pulse * 0.20) * (1 - f * 0.6);
    // Damage enemies inside the patch. Iterate BACKWARDS so the
    // splice inside __killEnemyAtIdx doesn't skip enemies behind us.
    const r2 = p.radius * p.radius;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying) continue;
      const dx = e.pos.x - p.pos.x;
      const dz = e.pos.z - p.pos.z;
      if (dx * dx + dz * dz < r2) {
        e.hp -= p.dps * dt;
        if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
          try { window.__killEnemyAtIdx(e); } catch (_) {}
        }
      }
    }
    // Damage player if they walk through it too. Lower DPS than the
    // enemy figure, no invuln blanket — the player's expected to step
    // out, not stand in it.
    if (player && player.pos && !isPiloting()) {
      const dx = player.pos.x - p.pos.x;
      const dz = player.pos.z - p.pos.z;
      if (dx * dx + dz * dz < r2) {
        const PLAYER_PATCH_DPS = p.dps * 0.40;
        S.hp = Math.max(0, S.hp - PLAYER_PATCH_DPS * dt);
      }
    }
  }

  // --- Poison clouds (from 'poison' mines) ---
  for (let i = _activeClouds.length - 1; i >= 0; i--) {
    const c = _activeClouds[i];
    c.life += dt;
    const f = c.life / c.ttl;
    if (f >= 1) {
      for (const puff of c.puffs) {
        if (puff.mesh.parent) puff.mesh.parent.remove(puff.mesh);
        if (puff.mat) puff.mat.dispose();
      }
      _activeClouds.splice(i, 1);
      continue;
    }
    // Drift + dissipate puffs.
    for (const puff of c.puffs) {
      puff.pos.x += puff.vel.x * dt;
      puff.pos.y += puff.vel.y * dt;
      puff.pos.z += puff.vel.z * dt;
      puff.mesh.position.copy(puff.pos);
      // Slow the drift over time so puffs settle.
      puff.vel.multiplyScalar(0.985);
      // Grow + fade.
      const localF = (c.life - puff.delay) / Math.max(0.001, puff.ttl);
      const lf = Math.max(0, Math.min(1, localF));
      const s = 1.0 + lf * 1.6;
      puff.mesh.scale.setScalar(s);
      puff.mat.opacity = (0.45 + 0.15 * Math.sin(c.life * 4 + puff.phase)) * (1 - f);
    }
    // Damage enemies inside the cloud. Backwards iteration matches the
    // mine + patch loops above.
    const r2 = c.radius * c.radius;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (!e || !e.pos || e.dying) continue;
      const dx = e.pos.x - c.pos.x;
      const dz = e.pos.z - c.pos.z;
      if (dx * dx + dz * dz < r2) {
        e.hp -= c.dps * dt;
        if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
          try { window.__killEnemyAtIdx(e); } catch (_) {}
        }
      }
    }
    // Player DoT if standing in the cloud.
    if (player && player.pos && !isPiloting()) {
      const dx = player.pos.x - c.pos.x;
      const dz = player.pos.z - c.pos.z;
      if (dx * dx + dz * dz < r2) {
        S.hp = Math.max(0, S.hp - c.dps * 0.40 * dt);
      }
    }
  }
}

// =====================================================================
// DETONATION
// =====================================================================
function _detonateMine(m) {
  m.detonated = true;
  m.detonateT = 0;
  // Hide the mine body but leave the group for the linger window so
  // the FX has somewhere reasonable to anchor (though hitBurst is
  // pos-based and doesn't actually need it).
  if (m.base.parent) m.base.visible = false;
  if (m.light.parent) m.light.visible = false;

  const cfg = m.cfg;
  // Burst-style AoE damage in the configured radius. Iterate BACKWARDS
  // because the kill hook splices the live enemies array — going
  // forward would skip enemies as the array shrinks behind us.
  const r2 = cfg.aoeRadius * cfg.aoeRadius;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || !e.pos || e.dying) continue;
    const dx = e.pos.x - m.pos.x;
    const dz = e.pos.z - m.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r2) {
      const falloff = 1 - Math.sqrt(d2) / cfg.aoeRadius;
      e.hp -= cfg.aoeDamage * falloff;
      e.hitFlash = 0.18;
      // Finish the kill via the global bridge (set up in main.js as
      // window.__killEnemyAtIdx). Without this, mines damaged enemies
      // but never actually killed them — they'd walk around at -150 hp
      // because the standard score/loot/splice pipeline never fired.
      if (e.hp <= 0 && typeof window !== 'undefined' && window.__killEnemyAtIdx) {
        try { window.__killEnemyAtIdx(e); } catch (_) {}
      }
    }
  }

  // FX — burst plume colored to the mine kind.
  const pos = m.pos.clone();
  pos.y = 0.5;
  hitBurst(pos, 0xffffff, 14);
  hitBurst(pos, cfg.burstColor, 18);
  setTimeout(() => hitBurst(pos, cfg.secondaryBurstColor, 12), 50);

  // Audio per-kind.
  try { Audio.mineDetonate(m.kind); } catch (_) {}

  // Splash damage to the player. Falloff with distance, smaller max
  // damage than the kind's anti-enemy figure (mines are tactical, not
  // a player nuke). Kept consistent across kinds; the per-kind patch
  // / cloud aftermath is what makes you regret standing on the field
  // afterward, and those are damage-tick based (handled in the patch
  // / cloud ticks below).
  _splashDamagePlayerLocal(m.pos, cfg.aoeRadius, 30);

  // Per-kind aftermath.
  if (cfg.spawnPatch) {
    _spawnFirePatch(m.pos, cfg);
  }
  if (cfg.spawnPoisonCloud) {
    _spawnPoisonCloud(m.pos, cfg);
  }

  // Notify any tutorial observer that a mine fired. We pass the kind
  // so the lesson can branch if it ever wants to (the current bonus
  // lesson watches for any detonation, kind-agnostic).
  if (typeof window !== 'undefined' && window.__bonusObserve && window.__bonusObserve.onMineDetonate) {
    try { window.__bonusObserve.onMineDetonate(m.kind); } catch (e) {}
  }
}

// Player-splash helper for mineField.js. Mirrors mech.js's
// _splashDamagePlayer but lives here too so we don't bridge through
// window. Bails when piloting (mech absorbs) or invuln.
function _splashDamagePlayerLocal(epicenter, radius, maxDmg) {
  if (!player || !player.pos) return;
  if (isPiloting()) return;           // mech absorbs the hit
  if (S.invulnTimer && S.invulnTimer > 0) return;
  const dx = player.pos.x - epicenter.x;
  const dz = player.pos.z - epicenter.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= radius) return;
  const falloff = 1 - d / radius;
  S.hp = Math.max(0, (S.hp || 0) - maxDmg * falloff);
  S.invulnTimer = Math.max(S.invulnTimer || 0, 0.20);
  if (typeof window !== 'undefined' && window.__takePlayerDamageVfx) {
    try { window.__takePlayerDamageVfx(0.30, 0.20); } catch (_) {}
  }
}

// =====================================================================
// FIRE PATCH (fire mine aftermath)
// =====================================================================
function _spawnFirePatch(pos, cfg) {
  const mat = new THREE.MeshBasicMaterial({
    color: cfg.patchColor,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const disc = new THREE.Mesh(_PATCH_GEO, mat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(pos.x, 0.06, pos.z);
  disc.scale.set(cfg.patchRadius, cfg.patchRadius, 1);
  scene.add(disc);
  _activePatches.push({
    disc, mat,
    pos: pos.clone(),
    radius: cfg.patchRadius,
    dps: cfg.patchDps,
    life: 0,
    ttl: cfg.patchDur,
  });
}

// =====================================================================
// POISON CLOUD (poison mine aftermath)
// =====================================================================
// A cloud is several drifting additive puffs covering an area — they
// share a damage region (radius around cloud.pos) but each renders
// independently for visual variety.
function _spawnPoisonCloud(pos, cfg) {
  const cloudColor = new THREE.Color(cfg.cloudColor);
  const puffs = [];
  const PUFF_COUNT = 7;
  for (let i = 0; i < PUFF_COUNT; i++) {
    const a = (i / PUFF_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const r = cfg.cloudRadius * (0.2 + Math.random() * 0.7);
    const px = pos.x + Math.cos(a) * r;
    const pz = pos.z + Math.sin(a) * r;
    const py = 0.35 + Math.random() * 0.4;
    const mat = new THREE.MeshBasicMaterial({
      color: cloudColor,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(_CLOUD_PUFF_GEO, mat);
    mesh.position.set(px, py, pz);
    scene.add(mesh);
    puffs.push({
      mesh, mat,
      pos: new THREE.Vector3(px, py, pz),
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 0.6,
        0.15 + Math.random() * 0.25,
        (Math.random() - 0.5) * 0.6,
      ),
      delay: i * 0.05,
      ttl: cfg.cloudDur,
      phase: Math.random() * Math.PI * 2,
    });
  }
  _activeClouds.push({
    puffs,
    pos: pos.clone(),
    radius: cfg.cloudRadius,
    dps: cfg.cloudDps,
    life: 0,
    ttl: cfg.cloudDur,
  });
}

// =====================================================================
// DISPOSAL
// =====================================================================
function _disposeMine(m) {
  if (m.root.parent) scene.remove(m.root);
  if (m.baseMat) m.baseMat.dispose();
  if (m.lightMat) m.lightMat.dispose();
}

export function clearAllMines() {
  for (const m of _activeMines) _disposeMine(m);
  _activeMines.length = 0;
  for (const p of _activePatches) {
    if (p.disc.parent) p.disc.parent.remove(p.disc);
    if (p.mat) p.mat.dispose();
  }
  _activePatches.length = 0;
  for (const c of _activeClouds) {
    for (const puff of c.puffs) {
      if (puff.mesh.parent) puff.mesh.parent.remove(puff.mesh);
      if (puff.mat) puff.mat.dispose();
    }
  }
  _activeClouds.length = 0;
  // Airborne mines (mid-flight from a dispenser) — dispose just like
  // a regular mine since the inner THREE objects are the same.
  for (const a of _airborneMines) {
    if (a.root.parent) scene.remove(a.root);
    if (a.baseMat) a.baseMat.dispose();
    if (a.lightMat) a.lightMat.dispose();
  }
  _airborneMines.length = 0;
  // Dispensers.
  for (const d of _activeDispensers) _disposeDispenser(d);
  _activeDispensers.length = 0;
}
