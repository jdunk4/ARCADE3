import * as THREE from 'three';
import { scene } from './scene.js';
import { MEEBIT_CONFIG } from './config.js';
import { S } from './state.js';

// ---- PORTRAIT TEXTURE CACHE ----
const portraitCache = new Map();
const loader = new THREE.TextureLoader();
loader.crossOrigin = 'anonymous';

function loadPortrait(meebitId) {
  if (portraitCache.has(meebitId)) return portraitCache.get(meebitId);
  // Create a placeholder first so the mesh has something valid.
  const placeholder = makePlaceholderTexture(meebitId);
  portraitCache.set(meebitId, placeholder);
  // Kick off real load async. On success replace in-place.
  const url = MEEBIT_CONFIG.portraitUrl(meebitId);
  loader.load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.LinearFilter;
      // Replace — anything referencing it will use the real image next frame.
      portraitCache.set(meebitId, tex);
      // Update any billboards showing this id.
      activeBillboards.forEach((b) => {
        if (b._meebitId === meebitId) {
          b.material.map = tex;
          b.material.needsUpdate = true;
        }
      });
    },
    undefined,
    (err) => {
      console.warn('[meebit] portrait failed', meebitId, err?.message || err);
    }
  );
  return placeholder;
}

function makePlaceholderTexture(meebitId) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  // Gradient background
  const hue = (meebitId * 47) % 360;
  ctx.fillStyle = `hsl(${hue}, 60%, 25%)`;
  ctx.fillRect(0, 0, size, size);
  // Simple voxel silhouette
  ctx.fillStyle = `hsl(${hue}, 40%, 55%)`;
  ctx.fillRect(size*0.3, size*0.15, size*0.4, size*0.35); // head
  ctx.fillRect(size*0.25, size*0.5, size*0.5, size*0.35); // body
  // Glasses
  ctx.fillStyle = '#fff';
  ctx.fillRect(size*0.32, size*0.26, size*0.36, size*0.08);
  ctx.fillStyle = '#ff3cac';
  ctx.fillRect(size*0.35, size*0.28, size*0.10, size*0.04);
  ctx.fillRect(size*0.55, size*0.28, size*0.10, size*0.04);
  // ID label
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('#' + meebitId, size/2, size - 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

const activeBillboards = [];

// ---- RESCUE NPC ----
// Creates a caged Meebit billboard at (x, z). Returns object with update/destroy hooks.
export function spawnRescueMeebit(x, z, meebitId) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // CAGE (made of thin emissive bars)
  const cageGroup = new THREE.Group();
  const barGeo = new THREE.BoxGeometry(0.08, 2.4, 0.08);
  const barMat = new THREE.MeshStandardMaterial({
    color: 0x666666, emissive: 0xffd93d, emissiveIntensity: 0.6, metalness: 0.8, roughness: 0.3
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
  // Top & bottom rings
  const ringGeo = new THREE.TorusGeometry(cageRadius, 0.05, 6, 20);
  const topRing = new THREE.Mesh(ringGeo, barMat);
  topRing.rotation.x = Math.PI / 2;
  topRing.position.y = 2.4;
  const botRing = new THREE.Mesh(ringGeo, barMat);
  botRing.rotation.x = Math.PI / 2;
  botRing.position.y = 0.1;
  cageGroup.add(topRing);
  cageGroup.add(botRing);
  group.add(cageGroup);

  // GLOWING FLOOR DISC
  const floorDisc = new THREE.Mesh(
    new THREE.CircleGeometry(cageRadius * 1.1, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd93d, transparent: true, opacity: 0.3 })
  );
  floorDisc.rotation.x = -Math.PI / 2;
  floorDisc.position.y = 0.03;
  group.add(floorDisc);

  // LIGHT BEAM
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 1.0, 25, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffd93d, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false,
    })
  );
  beam.position.y = 12.5;
  group.add(beam);

  // GLOWING "SOS" ARROW
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.6, 1.4, 4),
    new THREE.MeshStandardMaterial({ color: 0xffd93d, emissive: 0xffd93d, emissiveIntensity: 2.5 })
  );
  arrow.rotation.x = Math.PI;
  arrow.position.y = 5;
  group.add(arrow);

  // PORTRAIT BILLBOARD inside cage
  const texture = loadPortrait(meebitId);
  const billboardMat = new THREE.MeshBasicMaterial({
    map: texture, transparent: false, side: THREE.DoubleSide,
  });
  const billboard = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), billboardMat);
  billboard.position.y = 1.4;
  billboard._meebitId = meebitId;
  activeBillboards.push(billboard);
  group.add(billboard);

  // POINT LIGHT
  const light = new THREE.PointLight(0xffd93d, 2.5, 14, 1.5);
  light.position.y = 2;
  group.add(light);

  scene.add(group);

  return {
    obj: group,
    pos: group.position,
    bars, cageGroup, floorDisc, beam, arrow, billboard, light,
    meebitId,
    rescueProgress: 0,
    rescueTarget: MEEBIT_CONFIG.rescueHoldTime,
    freed: false,
    following: false,
    followTimer: 0,
    removed: false,
  };
}

export function updateRescueMeebit(meebit, dt, playerPos, onFreed, onEscaped) {
  if (!meebit || meebit.removed) return;
  const dx = playerPos.x - meebit.pos.x;
  const dz = playerPos.z - meebit.pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  // Always rotate billboard toward camera (simple: keep y at 0 rotation, let it look "forward")
  meebit.billboard.rotation.y = Math.atan2(playerPos.x - meebit.pos.x, playerPos.z - meebit.pos.z);

  if (!meebit.freed) {
    // Pulsing ring / arrow animation
    meebit.arrow.position.y = 5 + Math.sin(performance.now() * 0.004) * 0.4;
    meebit.cageGroup.rotation.y += dt * 0.4;
    meebit.beam.material.opacity = 0.2 + Math.sin(performance.now() * 0.003) * 0.1;

    if (dist < 2.0) {
      meebit.rescueProgress += dt;
      // Flash cage bars
      for (const bar of meebit.bars) {
        bar.material.emissiveIntensity = 0.6 + Math.sin(performance.now() * 0.02) * 0.6;
      }
      if (meebit.rescueProgress >= meebit.rescueTarget) {
        // Free!
        meebit.freed = true;
        meebit.following = true;
        // Make cage fall away
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
    } else {
      meebit.rescueProgress = Math.max(0, meebit.rescueProgress - dt * 0.6);
      for (const bar of meebit.bars) {
        bar.material.emissiveIntensity = 0.6;
      }
    }
  } else {
    // Cage bars physics
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
        // Move toward player
        meebit.pos.x += (dx / dist) * 5 * dt;
        meebit.pos.z += (dz / dist) * 5 * dt;
      }
      // Bob the billboard
      meebit.billboard.position.y = 1.4 + Math.sin(performance.now() * 0.005) * 0.1;
      // After 3 seconds, run to edge
      if (meebit.followTimer > 3) {
        meebit.following = false;
      }
    } else {
      // Run to nearest edge
      const toEdgeX = meebit.pos.x > 0 ? 48 : -48;
      const ex = toEdgeX - meebit.pos.x;
      const edx = Math.sign(ex);
      meebit.pos.x += edx * 9 * dt;
      // Spin the billboard as they flee
      meebit.billboard.rotation.y += dt * 3;
      if (Math.abs(meebit.pos.x) > 47) {
        // Escaped!
        meebit.removed = true;
        onEscaped && onEscaped(meebit);
        removeRescueMeebit(meebit);
      }
    }
  }
}

export function removeRescueMeebit(meebit) {
  if (!meebit || !meebit.obj) return;
  // Remove billboard from active list
  const idx = activeBillboards.indexOf(meebit.billboard);
  if (idx >= 0) activeBillboards.splice(idx, 1);
  scene.remove(meebit.obj);
}

export function getRescueProgress(meebit) {
  if (!meebit || meebit.freed) return 0;
  return meebit.rescueProgress / meebit.rescueTarget;
}

// Pick a random meebit ID that the player hasn't rescued yet this run.
export function pickNewMeebitId(alreadyRescued) {
  const rescued = new Set(alreadyRescued);
  for (let i = 0; i < 30; i++) {
    const id = Math.floor(Math.random() * MEEBIT_CONFIG.totalSupply);
    if (!rescued.has(id)) return id;
  }
  return Math.floor(Math.random() * MEEBIT_CONFIG.totalSupply);
}
