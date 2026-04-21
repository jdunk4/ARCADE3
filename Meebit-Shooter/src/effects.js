import * as THREE from 'three';
import { scene } from './scene.js';
import { CAPTURE_RADIUS, RAIN_CONFIG, GOO_CONFIG, rainIntensity } from './config.js';

// ============================================================
//  SHARED MATERIAL CACHE (performance)
//  Per-spawn material allocation was causing GC hitches and
//  first-use shader compilation stalls. We cache materials by
//  color so each unique emissive color compiles its shader
//  exactly once for the whole game.
// ============================================================
const _bulletMatCache = new Map();
const _projectileMatCache = new Map(); // key: projType + ':' + color
const _particleMatCache = new Map();
const _pickupMatCache = new Map();
const _ringMatCache = new Map();

function getBulletMat(color) {
  let m = _bulletMatCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.5 });
    _bulletMatCache.set(color, m);
  }
  return m;
}
function getProjectileMat(projType, color) {
  const key = projType + ':' + color;
  let m = _projectileMatCache.get(key);
  if (!m) {
    const intensity = projType === 'box' ? 2.5 : 3.5;
    m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity });
    _projectileMatCache.set(key, m);
  }
  return m;
}
function getParticleMat(color) {
  let m = _particleMatCache.get(color);
  if (!m) {
    // Must be unique-per-particle for opacity fade, so we clone on request.
    // Cache a template so the base compiles once, then clone cheaply.
    const tpl = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    _particleMatCache.set(color, tpl);
    m = tpl;
  }
  return m.clone();
}

// Shared geometries — one per shape for the whole game.
const BULLET_GEO = new THREE.BoxGeometry(0.12, 0.12, 0.6);
const PARTICLE_GEO = new THREE.BoxGeometry(0.1, 0.1, 0.1);
const PROJ_BOX_GEO = new THREE.BoxGeometry(0.3, 0.3, 0.3);
const PROJ_TRIANGLE_GEO = new THREE.ConeGeometry(0.35, 0.7, 3);
const PROJ_FIREBALL_GEO = new THREE.OctahedronGeometry(0.28, 0);

// Rocket shared resources
const ROCKET_BODY_GEO = new THREE.BoxGeometry(0.22, 0.22, 0.7);
const ROCKET_FIN_SIDE_GEO = new THREE.BoxGeometry(0.05, 0.28, 0.15);
const ROCKET_FIN_TOP_GEO = new THREE.BoxGeometry(0.28, 0.05, 0.15);
const ROCKET_EXHAUST_GEO = new THREE.BoxGeometry(0.16, 0.16, 0.25);
const ROCKET_FIN_MAT = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6 });
const ROCKET_EXHAUST_MAT = new THREE.MeshStandardMaterial({
  color: 0xffee00, emissive: 0xffaa00, emissiveIntensity: 4, transparent: true, opacity: 0.9,
});

// ============================================================
//  BULLETS
// ============================================================
export const bullets = [];

export function spawnBullet(origin, facing, weapon) {
  const count = Math.max(1, weapon.bullets);
  for (let i = 0; i < count; i++) {
    const spread = weapon.spread;
    const angleOffset = count === 1
      ? (Math.random() - 0.5) * spread
      : (i / (count - 1) - 0.5) * spread * 2 + (Math.random() - 0.5) * spread * 0.3;
    const angle = facing + angleOffset;

    const mat = getBulletMat(weapon.color);
    const bullet = new THREE.Mesh(BULLET_GEO, mat);
    bullet.position.copy(origin);
    bullet.userData = {
      vel: new THREE.Vector3(Math.sin(angle) * weapon.speed, 0, Math.cos(angle) * weapon.speed),
      life: 1.5,
      damage: weapon.damage,
    };
    bullet.lookAt(origin.x + Math.sin(angle), origin.y, origin.z + Math.cos(angle));
    scene.add(bullet);
    bullets.push(bullet);
  }
}

export function clearBullets() {
  for (const b of bullets) scene.remove(b);
  bullets.length = 0;
}

// ============================================================
//  ROCKETS — homing missiles
// ============================================================
export const rockets = [];

// Rocket body materials: reuse per weapon color via cache (rocket uses intensity 2.2,
// but close enough to bullet intensity 2.5 that visual difference is imperceptible.
// Using the same cache avoids a separate shader compile.)
function getRocketBodyMat(color) {
  return getBulletMat(color);
}

export function spawnRocket(origin, facing, weapon, targetRef) {
  const mat = getRocketBodyMat(weapon.color);
  const group = new THREE.Group();
  const body = new THREE.Mesh(ROCKET_BODY_GEO, mat);
  group.add(body);
  // Fins (shared geometry + material)
  const finL = new THREE.Mesh(ROCKET_FIN_SIDE_GEO, ROCKET_FIN_MAT);
  finL.position.set(-0.15, 0, -0.25); group.add(finL);
  const finR = new THREE.Mesh(ROCKET_FIN_SIDE_GEO, ROCKET_FIN_MAT);
  finR.position.set(0.15, 0, -0.25); group.add(finR);
  const finT = new THREE.Mesh(ROCKET_FIN_TOP_GEO, ROCKET_FIN_MAT);
  finT.position.set(0, 0.15, -0.25); group.add(finT);
  // Exhaust glow (shared)
  const exhaust = new THREE.Mesh(ROCKET_EXHAUST_GEO, ROCKET_EXHAUST_MAT);
  exhaust.position.set(0, 0, -0.45); group.add(exhaust);

  group.position.copy(origin);
  group.position.y = 1.2;
  const vx = Math.sin(facing) * weapon.speed;
  const vz = Math.cos(facing) * weapon.speed;
  group.userData = {
    vel: new THREE.Vector3(vx, 0, vz),
    speed: weapon.speed,
    life: 4.0,
    damage: weapon.damage,
    explosionRadius: weapon.explosionRadius,
    explosionDamage: weapon.explosionDamage,
    homingStrength: weapon.homingStrength,
    target: targetRef,         // may be null; auto-acquires
    color: weapon.color,
    exhaust,
    trailTimer: 0,
  };
  scene.add(group);
  rockets.push(group);
  return group;
}

export function clearRockets() {
  for (const r of rockets) scene.remove(r);
  rockets.length = 0;
}

// ============================================================
//  PICKUPS
// ============================================================
export const pickups = [];
const PICKUP_GEO = new THREE.OctahedronGeometry(0.28, 0);
const PICKUP_RING_GEO = new THREE.RingGeometry(0.45, 0.55, 12);

const PICKUP_COLORS = {
  xp: 0xffd93d, health: 0x00ff66, speed: 0x4ff7ff, shield: 0xe63aff,
};

export function makePickup(type, x, z) {
  const color = PICKUP_COLORS[type] || 0xffffff;
  let mat = _pickupMatCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 1.8, roughness: 0.3,
    });
    _pickupMatCache.set(color, mat);
  }
  const mesh = new THREE.Mesh(PICKUP_GEO, mat);
  mesh.castShadow = true;
  let ringMat = _ringMatCache.get(color);
  if (!ringMat) {
    ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
    });
    _ringMatCache.set(color, ringMat);
  }
  const ring = new THREE.Mesh(PICKUP_RING_GEO, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;

  const obj = new THREE.Group();
  obj.position.set(x, 0, z);
  obj.add(mesh); obj.add(ring);
  mesh.position.y = 0.6;
  scene.add(obj);

  const p = { obj, mesh, ring, type, value: type === 'xp' ? 1 : 0, life: 12 };
  pickups.push(p);
  return p;
}

export function clearPickups() {
  for (const p of pickups) scene.remove(p.obj);
  pickups.length = 0;
}

// ============================================================
//  PARTICLES
// ============================================================
const particles = [];

export function hitBurst(pos, color, count = 8) {
  for (let i = 0; i < count; i++) {
    const mat = getParticleMat(color);
    const p = new THREE.Mesh(PARTICLE_GEO, mat);
    p.position.copy(pos);
    const a = Math.random() * Math.PI * 2;
    const s = 4 + Math.random() * 6;
    p.userData = {
      vel: new THREE.Vector3(Math.cos(a) * s, Math.random() * 4 + 1, Math.sin(a) * s),
      life: 0.5 + Math.random() * 0.3,
      ageMax: 0.8,
    };
    scene.add(p);
    particles.push(p);
  }
}

export function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.position.addScaledVector(p.userData.vel, dt);
    p.userData.vel.y -= 12 * dt;
    p.userData.life -= dt;
    p.material.opacity = Math.max(0, p.userData.life / p.userData.ageMax);
    if (p.userData.life <= 0) {
      scene.remove(p);
      particles.splice(i, 1);
    }
  }
}

export function clearParticles() {
  for (const p of particles) scene.remove(p);
  particles.length = 0;
}

// ============================================================
//  RAIN — per-wave intensity with chapter-themed color
//  Chapter sets the HUE (orange / red / yellow / green / blue / purple)
//  Wave sets the INTENSITY (drizzle → steady → downpour → torrential → typhoon)
// ============================================================
let rainGroup = null;
const rainDrops = [];
let rainTintHex = 0xaaccff;
let currentRainCfg = rainIntensity(1);
let windPhase = 0;
let nextLightningIn = 0;
let lightningFlashT = 0;
let lightningLight = null;       // THREE.DirectionalLight — chapter-tinted
let cssFlashEl = null;           // DOM overlay for the camera flash
let lightningTintHex = 0xc5d8ff; // current lightning color (chapter-tinted)

const RAIN_DROP_GEO = new THREE.BoxGeometry(0.04, 0.7, 0.04);

function ensureLightningLight() {
  if (lightningLight) return;
  lightningLight = new THREE.DirectionalLight(lightningTintHex, 0);
  lightningLight.position.set(0, 40, 0);
  scene.add(lightningLight);
}

function ensureCssFlash() {
  if (cssFlashEl || typeof document === 'undefined') return;
  cssFlashEl = document.createElement('div');
  cssFlashEl.id = 'lightning-flash';
  Object.assign(cssFlashEl.style, {
    position: 'fixed', inset: '0',
    background: '#cfd8ff',
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '3',
    mixBlendMode: 'screen',
    transition: 'opacity 60ms linear',
  });
  document.body.appendChild(cssFlashEl);
}

// Lighten a hex color toward white — used to keep chapter-tinted lightning
// from looking like a colored filter. Gives a pale version of the chapter hue.
function _lightenHex(hex, amount) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(0xffffff), amount);
  return c.getHex();
}

function _hexToCss(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

// Single shared material for all rain drops — color/opacity are mutated
// in place when chapter/wave changes, so no teardown is ever needed.
const RAIN_MAT = new THREE.MeshBasicMaterial({
  color: 0xaaccff, transparent: true, opacity: 0.25,
});

// Maximum drop count across all intensities (wave 5 typhoon = 1800).
// We allocate this pool ONCE up front and toggle per-drop .visible per wave,
// which eliminates the multi-hundred-mesh rebuild that was causing the
// wave-6 (chapter transition) freeze.
const RAIN_POOL_MAX = 1800;
let rainPoolBuilt = false;

function buildRainPool(tintHex, cfg) {
  if (rainPoolBuilt) return;
  rainPoolBuilt = true;
  rainTintHex = tintHex;
  RAIN_MAT.color.setHex(tintHex);
  RAIN_MAT.opacity = cfg.opacity;
  rainGroup = new THREE.Group();
  scene.add(rainGroup);
  for (let i = 0; i < RAIN_POOL_MAX; i++) {
    const drop = new THREE.Mesh(RAIN_DROP_GEO, RAIN_MAT);
    resetRainDrop(drop, true);
    drop.rotation.z = 0.35 + cfg.wind * 0.4;
    drop.visible = i < cfg.dropCount;
    rainGroup.add(drop);
    rainDrops.push(drop);
  }
}

function applyRainPool(tintHex, cfg) {
  rainTintHex = tintHex;
  RAIN_MAT.color.setHex(tintHex);
  RAIN_MAT.opacity = cfg.opacity;
  const tilt = 0.35 + cfg.wind * 0.4;
  const target = Math.min(RAIN_POOL_MAX, cfg.dropCount);
  for (let i = 0; i < rainDrops.length; i++) {
    const drop = rainDrops[i];
    const shouldShow = i < target;
    // If a drop is newly showing, re-seed it to a random height so it
    // doesn't all appear at y=height in a line.
    if (shouldShow && !drop.visible) resetRainDrop(drop, true);
    drop.visible = shouldShow;
    drop.rotation.z = tilt;
  }
}

export function initRain(tintHex, localWave = 1) {
  currentRainCfg = rainIntensity(localWave);
  buildRainPool(tintHex, currentRainCfg);
  // Lightning tint tracks chapter color, lightened toward white for flash feel
  lightningTintHex = _lightenHex(tintHex, 0.55);
  if (currentRainCfg.lightning) {
    ensureLightningLight();
    if (lightningLight) lightningLight.color.setHex(lightningTintHex);
    ensureCssFlash();
    if (cssFlashEl) cssFlashEl.style.background = _hexToCss(_lightenHex(tintHex, 0.7));
    nextLightningIn = 3 + Math.random() * 5;
  }
}

/**
 * Called at each wave start. Chapter tint sets color, localWave sets intensity.
 * Uses a pooled pre-allocated drop array: per-wave transitions only toggle
 * visibility, so wave 5 → wave 6 no longer tears down 1800 meshes.
 */
export function applyRainTo(chapterTintHex, localWave) {
  const next = rainIntensity(localWave);

  // Lightning color always follows chapter (lightened)
  lightningTintHex = _lightenHex(chapterTintHex, 0.55);
  if (lightningLight) lightningLight.color.setHex(lightningTintHex);
  if (cssFlashEl) cssFlashEl.style.background = _hexToCss(_lightenHex(chapterTintHex, 0.7));

  if (!rainPoolBuilt) {
    buildRainPool(chapterTintHex, next);
  } else {
    applyRainPool(chapterTintHex, next);
  }
  currentRainCfg = next;

  if (next.lightning) {
    ensureLightningLight();
    if (lightningLight) lightningLight.color.setHex(lightningTintHex);
    ensureCssFlash();
    nextLightningIn = 2 + Math.random() * 4;
  } else {
    lightningFlashT = 0;
    if (lightningLight) lightningLight.intensity = 0;
    if (cssFlashEl) cssFlashEl.style.opacity = '0';
  }
}

function resetRainDrop(drop, initialSpawn = false) {
  const r = RAIN_CONFIG.area;
  drop.position.x = (Math.random() - 0.5) * r * 2;
  drop.position.z = (Math.random() - 0.5) * r * 2;
  drop.position.y = initialSpawn
    ? Math.random() * RAIN_CONFIG.height
    : RAIN_CONFIG.height;
}

export function updateRain(dt, playerPos) {
  if (!rainGroup) return;
  const cfg = currentRainCfg;

  // Follow the player so rain appears everywhere
  rainGroup.position.x = playerPos.x;
  rainGroup.position.z = playerPos.z;

  // Wind gusting — stronger at higher waves. Typhoon adds violent swings.
  windPhase += dt * (cfg.typhoon ? 2.2 : 1.2);
  const gust = cfg.typhoon
    ? Math.sin(windPhase) * 18 + Math.sin(windPhase * 2.7) * 10
    : Math.sin(windPhase) * (cfg.wind * 8);

  const vX = cfg.speedX + gust;
  const vY = cfg.speedY * (cfg.typhoon ? 1.15 : 1.0);

  for (const drop of rainDrops) {
    if (!drop.visible) continue;
    drop.position.x += vX * dt;
    drop.position.y += vY * dt;
    if (drop.position.y < 0) resetRainDrop(drop);
    const r = RAIN_CONFIG.area;
    if (drop.position.x > r) drop.position.x -= r * 2;
    if (drop.position.x < -r) drop.position.x += r * 2;
  }

  // Lightning (waves 4 and 5)
  if (cfg.lightning) {
    nextLightningIn -= dt;
    if (nextLightningIn <= 0) {
      lightningFlashT = 1.0;
      nextLightningIn = cfg.typhoon
        ? 1.5 + Math.random() * 2.5
        : 4 + Math.random() * 6;
      // Typhoon double-strike
      if (cfg.typhoon && Math.random() < 0.4) {
        setTimeout(() => { lightningFlashT = Math.max(lightningFlashT, 0.9); }, 90);
      }
      // Thunder SFX hook — audio module can subscribe via window.__onLightning
      if (typeof window !== 'undefined' && window.__onLightning) {
        try { window.__onLightning(cfg.typhoon); } catch (e) {}
      }
    }
    if (lightningFlashT > 0) {
      lightningFlashT = Math.max(0, lightningFlashT - dt * 4.5);
      if (lightningLight) lightningLight.intensity = lightningFlashT * 2.0;
      if (cssFlashEl) cssFlashEl.style.opacity = String(lightningFlashT * 0.55);
    }
  }
}

export function setRainTint(tintHex) {
  if (!rainPoolBuilt) return;
  rainTintHex = tintHex;
  // All drops share RAIN_MAT, so one update covers the whole pool.
  RAIN_MAT.color.setHex(tintHex);
  // Keep lightning in sync with chapter tint
  lightningTintHex = _lightenHex(tintHex, 0.55);
  if (lightningLight) lightningLight.color.setHex(lightningTintHex);
  if (cssFlashEl) cssFlashEl.style.background = _hexToCss(_lightenHex(tintHex, 0.7));
}

function disposeRainGroupOnly() {
  // Pool-aware: we don't actually tear down the pool anymore (the whole
  // point of pooling is that rebuilds never happen during gameplay).
  // On a hard dispose we hide every drop instead of deleting geometry.
  if (!rainGroup) return;
  for (const d of rainDrops) d.visible = false;
}

export function disposeRain() {
  disposeRainGroupOnly();
  lightningFlashT = 0;
  if (lightningLight) lightningLight.intensity = 0;
  if (cssFlashEl) cssFlashEl.style.opacity = '0';
}

// ============================================================
//  GOO SPLATS — themed, decay over 60s
// ============================================================
export const gooSplats = [];
const GOO_GEO = new THREE.CircleGeometry(GOO_CONFIG.size, 12);

export function spawnGooSplat(x, z, tintHex) {
  const mat = new THREE.MeshBasicMaterial({
    color: tintHex, transparent: true, opacity: 0.75, side: THREE.DoubleSide,
  });
  const splat = new THREE.Mesh(GOO_GEO, mat);
  splat.rotation.x = -Math.PI / 2;
  splat.position.set(x, 0.03 + Math.random() * 0.02, z);
  // Slight scale variation
  const s = 0.7 + Math.random() * 0.8;
  splat.scale.setScalar(s);
  // Random rotation
  splat.rotation.z = Math.random() * Math.PI * 2;
  scene.add(splat);
  const g = {
    mesh: splat,
    mat,
    life: GOO_CONFIG.lifetimeSec,
    lifeMax: GOO_CONFIG.lifetimeSec,
  };
  gooSplats.push(g);
  return g;
}

export function updateGooSplats(dt) {
  for (let i = gooSplats.length - 1; i >= 0; i--) {
    const g = gooSplats[i];
    g.life -= dt;
    const t = Math.max(0, g.life / g.lifeMax);
    // Fade out over the last 20% of life
    if (t < 0.2) g.mat.opacity = 0.75 * (t / 0.2);
    if (g.life <= 0) {
      scene.remove(g.mesh);
      gooSplats.splice(i, 1);
    }
  }
}

export function clearGooSplats() {
  for (const g of gooSplats) scene.remove(g.mesh);
  gooSplats.length = 0;
}

// ============================================================
//  BOSS CUBES — rain from above, hatch or explode
// ============================================================
export const bossCubes = [];
const BOSS_CUBE_GEO = new THREE.BoxGeometry(1.4, 1.4, 1.4);

export function spawnBossCube(x, z, tintHex, mode /* 'hatch' | 'explode' */) {
  const col = tintHex;
  const mat = new THREE.MeshStandardMaterial({
    color: col, emissive: col, emissiveIntensity: 1.2, roughness: 0.4,
  });
  const cube = new THREE.Mesh(BOSS_CUBE_GEO, mat);
  cube.position.set(x, 25, z);
  cube.castShadow = true;
  scene.add(cube);
  // Ground shadow warning indicator
  const ringMat = new THREE.MeshBasicMaterial({
    color: mode === 'explode' ? 0xff2e4d : 0xffd93d,
    transparent: true, opacity: 0.7, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.6, 24), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.05, z);
  scene.add(ring);

  const c = {
    mesh: cube,
    ring,
    ringMat,
    pos: cube.position,
    fallSpeed: 15,
    landed: false,
    fuseTimer: 0.8,     // after landing
    mode,               // 'hatch' or 'explode'
    tintHex,
  };
  bossCubes.push(c);
  return c;
}

export function clearBossCubes() {
  for (const c of bossCubes) {
    scene.remove(c.mesh);
    scene.remove(c.ring);
  }
  bossCubes.length = 0;
}

// ============================================================
//  CAPTURE ZONE
// ============================================================
export function makeCaptureZone(x, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(CAPTURE_RADIUS - 0.2, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffd93d, transparent: true, opacity: 0.15, side: THREE.DoubleSide,
    })
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.04;
  group.add(inner);

  const boundary = new THREE.Mesh(
    new THREE.RingGeometry(CAPTURE_RADIUS - 0.1, CAPTURE_RADIUS + 0.2, 64),
    new THREE.MeshBasicMaterial({
      color: 0xffd93d, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
    })
  );
  boundary.rotation.x = -Math.PI / 2;
  boundary.position.y = 0.05;
  group.add(boundary);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(CAPTURE_RADIUS + 0.3, CAPTURE_RADIUS + 0.6, 48, 1, 0, 0.1),
    new THREE.MeshBasicMaterial({
      color: 0xffd93d, transparent: true, opacity: 1.0, side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);

  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffd93d, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 16, 16, 1, true), beamMat);
  beam.position.y = 8;
  group.add(beam);

  const missile = new THREE.Mesh(
    new THREE.ConeGeometry(0.8, 2.5, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd93d, emissive: 0xffd93d, emissiveIntensity: 0.8 })
  );
  missile.position.y = 1.3;
  group.add(missile);

  scene.add(group);
  return {
    obj: group,
    pos: group.position,
    inner,
    ring,
    boundary,
    beam,
    missile,
  };
}

export function removeCaptureZone(zone) {
  if (zone && zone.obj) scene.remove(zone.obj);
}
