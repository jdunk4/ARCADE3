import * as THREE from 'three';
import { scene } from './scene.js';
import { MEEBIT_CONFIG } from './config.js';
import { S } from './state.js';

// ---------------------------------------------------------------------------
// PORTRAIT TEXTURES
// ---------------------------------------------------------------------------
const portraitCache = new Map();
const loader = new THREE.TextureLoader();
loader.crossOrigin = 'anonymous';

function loadPortrait(meebitId) {
  if (portraitCache.has(meebitId)) return portraitCache.get(meebitId);
  const placeholder = makePlaceholderTexture(meebitId);
  portraitCache.set(meebitId, placeholder);
  const url = MEEBIT_CONFIG.portraitUrl(meebitId);
  loader.load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.LinearFilter;
      portraitCache.set(meebitId, tex);
      activeBillboards.forEach((b) => {
        if (b._meebitId === meebitId) {
          b.material.map = tex;
          b.material.needsUpdate = true;
        }
      });
    },
    undefined,
    (err) => console.warn('[meebit] portrait failed', meebitId, err?.message || err)
  );
  return placeholder;
}

function makePlaceholderTexture(meebitId) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const hue = (meebitId * 47) % 360;
  ctx.fillStyle = `hsl(${hue}, 60%, 25%)`;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = `hsl(${hue}, 40%, 55%)`;
  ctx.fillRect(size * 0.3, size * 0.15, size * 0.4, size * 0.35);
  ctx.fillRect(size * 0.25, size * 0.5, size * 0.5, size * 0.35);
  ctx.fillStyle = '#fff';
  ctx.fillRect(size * 0.32, size * 0.26, size * 0.36, size * 0.08);
  ctx.fillStyle = '#ff3cac';
  ctx.fillRect(size * 0.35, size * 0.28, size * 0.10, size * 0.04);
  ctx.fillRect(size * 0.55, size * 0.28, size * 0.10, size * 0.04);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('#' + meebitId, size / 2, size - 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

const activeBillboards = [];

// ---------------------------------------------------------------------------
// SPAWN
// ---------------------------------------------------------------------------
export function spawnRescueMeebit(x, z, meebitId) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Cage
  const cageGroup = new THREE.Group();
  const barGeo = new THREE.BoxGeometry(0.08, 2.4, 0.08);
  const barMat = new THREE.MeshStandardMaterial({
    color: 0x666666, emissive: 0xffd93d, emissiveIntensity: 0.6,
    metalness: 0.8, roughness: 0.3,
  });
  const cageRadius = 1.2;
  const barCount = 10;
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const a = (i / barCount) * Math.PI * 2;
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.set(Math.cos(a) * cageRadius, 1.2, Math.sin(a) * cageRadius);
    bar.castShadow = true;
    cageGroup.add(bar);
    bars.push(bar);
  }
  const ringGeo = new THREE.TorusGeometry(cageRadius, 0.05, 6, 20);
  const topRing = new THREE.Mesh(ringGeo, barMat);
  topRing.rotation.x = Math.PI / 2; topRing.position.y = 2.4;
  const botRing = new THREE.Mesh(ringGeo, barMat);
  botRing.rotation.x = Math.PI / 2; botRing.position.y = 0.1;
  cageGroup.add(topRing); cageGroup.add(botRing);
  group.add(cageGroup);

  // Floor disc
  const floorDisc = new THREE.Mesh(
    new THREE.CircleGeometry(cageRadius * 1.1, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd93d, transparent: true, opacity: 0.3 })
  );
  floorDisc.rotation.x = -Math.PI / 2;
  floorDisc.position.y = 0.03;
  group.add(floorDisc);

  // Beacon beam
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 1.0, 25, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffd93d, transparent: true, opacity: 0.25,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  beam.position.y = 12.5; group.add(beam);

  // Pulsing arrow
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.6, 1.4, 4),
    new THREE.MeshStandardMaterial({ color: 0xffd93d, emissive: 0xffd93d, emissiveIntensity: 2.5 })
  );
  arrow.rotation.x = Math.PI;
  arrow.position.y = 5;
  group.add(arrow);

  // Portrait billboard
  const texture = loadPortrait(meebitId);
  const billboardMat = new THREE.MeshBasicMaterial({
    map: texture, transparent: false, side: THREE.DoubleSide,
  });
  const billboard = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), billboardMat);
  billboard.position.y = 1.4;
  billboard._meebitId = meebitId;
  activeBillboards.push(billboard);
  group.add(billboard);

  // Cage light
  const light = new THREE.PointLight(0xffd93d, 2.5, 14, 1.5);
  light.position.y = 2;
  group.add(light);

  scene.add(group);

  return {
    obj: group,
    pos: group.position,
    bars, cageGroup, floorDisc, beam, arrow, billboard, light, barMat,
    meebitId,
    rescueProgress: 0,
    rescueTarget: MEEBIT_CONFIG.rescueHoldTime,
    cageHp: MEEBIT_CONFIG.cageHp,
    cageHpMax: MEEBIT_CONFIG.cageHp,
    cageHitFlash: 0,
    freed: false,
    killed: false,       // cage broken before rescue
    following: false,
    followTimer: 0,
    removed: false,
  };
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------
export function updateRescueMeebit(meebit, dt, playerPos, onFreed, onEscaped, onKilled) {
  if (!meebit || meebit.removed) return;

  // Billboard rotation toward camera/player
  meebit.billboard.rotation.y = Math.atan2(playerPos.x - meebit.pos.x, playerPos.z - meebit.pos.z);

  const now = performance.now();
  const dx = playerPos.x - meebit.pos.x;
  const dz = playerPos.z - meebit.pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  // Cage hit flash
  if (meebit.cageHitFlash > 0) {
    meebit.cageHitFlash -= dt;
    for (const bar of meebit.bars) bar.material.emissiveIntensity = 0.6 + meebit.cageHitFlash * 4;
  }

  if (!meebit.freed && !meebit.killed) {
    // Cage pulse
    meebit.arrow.position.y = 5 + Math.sin(now * 0.004) * 0.4;
    meebit.cageGroup.rotation.y += dt * 0.4;
    meebit.beam.material.opacity = 0.2 + Math.sin(now * 0.003) * 0.1;

    // Panic state when cage is low
    if (meebit.cageHp < meebit.cageHpMax * 0.33) {
      meebit.floorDisc.material.color.setHex(0xff2e4d);
      meebit.beam.material.color.setHex(0xff2e4d);
      meebit.light.color.setHex(0xff2e4d);
    }

    if (dist < 2.0) {
      meebit.rescueProgress += dt;
      if (meebit.rescueProgress >= meebit.rescueTarget) {
        freeMeebit(meebit, onFreed);
      }
    } else {
      meebit.rescueProgress = Math.max(0, meebit.rescueProgress - dt * 0.6);
    }
  } else if (meebit.freed) {
    // Cage fall physics
    for (const bar of meebit.bars) {
      if (bar.userData.fallVel) {
        bar.position.addScaledVector(bar.userData.fallVel, dt);
        bar.userData.fallVel.y -= 9 * dt;
        bar.rotation.z += bar.userData.spin * dt;
        if (bar.position.y < -3) bar.visible = false;
      }
    }

    meebit.followTimer += dt;
    if (meebit.following) {
      if (dist > 3) {
        meebit.pos.x += (dx / dist) * 5 * dt;
        meebit.pos.z += (dz / dist) * 5 * dt;
      }
      meebit.billboard.position.y = 1.4 + Math.sin(now * 0.005) * 0.1;
      if (meebit.followTimer > 3) meebit.following = false;
    } else {
      const toEdgeX = meebit.pos.x > 0 ? 48 : -48;
      const edx = Math.sign(toEdgeX - meebit.pos.x);
      meebit.pos.x += edx * 9 * dt;
      meebit.billboard.rotation.y += dt * 3;
      if (Math.abs(meebit.pos.x) > 47) {
        meebit.removed = true;
        onEscaped && onEscaped(meebit);
        removeRescueMeebit(meebit);
      }
    }
  }
  // if meebit.killed, just sit — removeRescueMeebit was already called
}

function freeMeebit(meebit, onFreed) {
  meebit.freed = true;
  meebit.following = true;
  for (const bar of meebit.bars) {
    bar.userData.fallVel = new THREE.Vector3(
      (Math.random() - 0.5) * 4,
      Math.random() * 3 + 2,
      (Math.random() - 0.5) * 4
    );
    bar.userData.spin = (Math.random() - 0.5) * 6;
  }
  meebit.arrow.visible = false;
  meebit.beam.visible = false;
  meebit.floorDisc.material.color.set(0x00ff66);
  onFreed && onFreed(meebit);
}

/**
 * Returns true if the meebit was killed (cage broken to 0).
 * Called by main.js when an enemy is in melee range of the cage.
 */
export function damageCage(meebit, dmg, onKilled) {
  if (!meebit || meebit.freed || meebit.killed || meebit.removed) return false;
  meebit.cageHp -= dmg;
  meebit.cageHitFlash = 0.2;
  if (meebit.cageHp <= 0) {
    meebit.killed = true;
    meebit.cageHp = 0;
    // Dramatic cage burst
    for (const bar of meebit.bars) {
      bar.userData.fallVel = new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        Math.random() * 4 - 1,
        (Math.random() - 0.5) * 8
      );
      bar.userData.spin = (Math.random() - 0.5) * 12;
    }
    // Billboard flickers out
    meebit.billboard.material.color = new THREE.Color(0x330000);
    meebit.beam.visible = false;
    meebit.arrow.visible = false;
    if (onKilled) onKilled(meebit);
    setTimeout(() => {
      removeRescueMeebit(meebit);
      meebit.removed = true;
    }, 1500);
    return true;
  }
  return false;
}

export function removeRescueMeebit(meebit) {
  if (!meebit || !meebit.obj) return;
  const idx = activeBillboards.indexOf(meebit.billboard);
  if (idx >= 0) activeBillboards.splice(idx, 1);
  scene.remove(meebit.obj);
}

export function getRescueProgress(meebit) {
  if (!meebit || meebit.freed || meebit.killed) return 0;
  return meebit.rescueProgress / meebit.rescueTarget;
}

export function pickNewMeebitId(alreadyRescued) {
  const rescued = new Set(alreadyRescued);
  for (let i = 0; i < 30; i++) {
    const id = Math.floor(Math.random() * MEEBIT_CONFIG.totalSupply);
    if (!rescued.has(id)) return id;
  }
  return Math.floor(Math.random() * MEEBIT_CONFIG.totalSupply);
}
