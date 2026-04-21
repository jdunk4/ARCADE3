import * as THREE from 'three';
import { ARENA, CHAPTERS, CHAPTER_BASE, WAVES_PER_CHAPTER, intensityForWave } from './config.js';

export const scene = new THREE.Scene();
const startTheme = mixTheme(CHAPTERS[0].full, 0.2);
scene.background = new THREE.Color(startTheme.sky);
scene.fog = new THREE.Fog(startTheme.fog, 30, 85);

export const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
export const CAMERA_OFFSET = new THREE.Vector3(0, 17, 11);
camera.position.copy(CAMERA_OFFSET);
camera.lookAt(0, 0, 0);

export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- LIGHTS ----
const ambient = new THREE.AmbientLight(0x3a2850, 0.55);
scene.add(ambient);

const hemi = new THREE.HemisphereLight(startTheme.hemi1, startTheme.hemi2, 0.45);
scene.add(hemi);

const moon = new THREE.DirectionalLight(0xb4a8ff, 1.0);
moon.position.set(-18, 30, 18);
moon.castShadow = true;
moon.shadow.mapSize.width = 1024;
moon.shadow.mapSize.height = 1024;
moon.shadow.camera.near = 1;
moon.shadow.camera.far = 90;
moon.shadow.camera.left = -35;
moon.shadow.camera.right = 35;
moon.shadow.camera.top = 35;
moon.shadow.camera.bottom = -35;
moon.shadow.bias = -0.0008;
scene.add(moon);

const rimLight = new THREE.PointLight(startTheme.lamp, 1.6, 20, 1.5);
scene.add(rimLight);

// ---- CHECKERED FLOOR ----
function makeCheckerTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a0c2e';
  ctx.fillRect(0, 0, size, size);
  const step = size / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if ((x + y) % 2 === 0) {
        ctx.fillStyle = '#2a1848';
        ctx.fillRect(x * step, y * step, step, step);
      }
    }
  }
  ctx.strokeStyle = 'rgba(255,60,172,0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

const floorTex = makeCheckerTexture();
const groundMat = new THREE.MeshStandardMaterial({
  map: floorTex,
  color: 0xffffff,
  roughness: 0.85,
  metalness: 0.05
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2, ARENA * 2, 1, 1), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---- GRID OVERLAY ----
let gridHelper = new THREE.GridHelper(ARENA * 2, 40, startTheme.grid1, startTheme.grid2);
gridHelper.material.opacity = 0.15;
gridHelper.material.transparent = true;
gridHelper.position.y = 0.015;
scene.add(gridHelper);

// ---- BORDER PILLARS (instanced) ----
const pillarPositions = [];
for (let i = -ARENA; i <= ARENA; i += 4) {
  pillarPositions.push([i, -ARENA], [i, ARENA], [-ARENA, i], [ARENA, i]);
}
const pillarGeo = new THREE.BoxGeometry(1.2, 2.2, 1.2);
const pillarMat = new THREE.MeshStandardMaterial({ color: 0x5a2a80, roughness: 0.7, emissive: 0x2a1044, emissiveIntensity: 0.3 });
const pillarMesh = new THREE.InstancedMesh(pillarGeo, pillarMat, pillarPositions.length);
pillarMesh.castShadow = true;
pillarMesh.receiveShadow = true;
{
  const dummy = new THREE.Object3D();
  pillarPositions.forEach(([x, z], i) => {
    dummy.position.set(x, 1.1, z);
    dummy.updateMatrix();
    pillarMesh.setMatrixAt(i, dummy.matrix);
  });
  pillarMesh.instanceMatrix.needsUpdate = true;
}
scene.add(pillarMesh);

const capGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
const capMat = new THREE.MeshStandardMaterial({ color: startTheme.lamp, emissive: startTheme.lamp, emissiveIntensity: 1.8 });
const capMesh = new THREE.InstancedMesh(capGeo, capMat, pillarPositions.length);
{
  const dummy = new THREE.Object3D();
  pillarPositions.forEach(([x, z], i) => {
    dummy.position.set(x, 2.4, z);
    dummy.updateMatrix();
    capMesh.setMatrixAt(i, dummy.matrix);
  });
  capMesh.instanceMatrix.needsUpdate = true;
}
scene.add(capMesh);

// ---- TOMBSTONES ----
const tombGeo = new THREE.BoxGeometry(1.0, 1.6, 0.3);
const tombMat = new THREE.MeshStandardMaterial({ color: 0x7a5aa0, roughness: 0.9 });
const tombPositions = [];
for (let i = 0; i < 50; i++) {
  const x = (Math.random() - 0.5) * ARENA * 1.7;
  const z = (Math.random() - 0.5) * ARENA * 1.7;
  if (Math.abs(x) < 6 && Math.abs(z) < 6) continue;
  tombPositions.push([x, z, Math.random() * Math.PI]);
}
const tombMesh = new THREE.InstancedMesh(tombGeo, tombMat, tombPositions.length);
tombMesh.castShadow = true;
tombMesh.receiveShadow = true;
{
  const dummy = new THREE.Object3D();
  tombPositions.forEach(([x, z, r], i) => {
    dummy.position.set(x, 0.8, z);
    dummy.rotation.y = r;
    dummy.updateMatrix();
    tombMesh.setMatrixAt(i, dummy.matrix);
  });
  tombMesh.instanceMatrix.needsUpdate = true;
}
scene.add(tombMesh);

// ---- LAMPS ----
const lampBulbs = [];
const lampPointLights = [];
{
  const poleGeo = new THREE.BoxGeometry(0.2, 3, 0.2);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a1040, roughness: 0.7 });
  const bulbGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  for (let i = 0; i < 6; i++) {
    const x = (Math.random() - 0.5) * ARENA * 1.4;
    const z = (Math.random() - 0.5) * ARENA * 1.4;
    if (Math.abs(x) < 10 && Math.abs(z) < 10) continue;
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, 1.5, z);
    pole.castShadow = true;
    scene.add(pole);
    const bulbMat = new THREE.MeshStandardMaterial({ color: startTheme.lamp, emissive: startTheme.lamp, emissiveIntensity: 3 });
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.set(x, 3.2, z);
    scene.add(bulb);
    lampBulbs.push(bulb);
    const pl = new THREE.PointLight(startTheme.lamp, 2.0, 14, 1.4);
    pl.position.set(x, 3.2, z);
    scene.add(pl);
    lampPointLights.push(pl);
  }
}

// ---- CIVILIAN RESCUE CORNERS ----
// Previously this added four permanent green rings + poles at the map
// corners. They're gone now: rescue zones are randomized per wave and
// their visuals live in civilians.js (buildCornerMarkers). Leaving the
// permanent decor up would clash with the randomized zones.


export const Scene = {
  scene, camera, renderer, rimLight, ground, groundMat, gridHelper,
  capMesh, capMat, lampBulbs, lampPointLights, hemi, floorTex,
};

// ---- THEME INTERPOLATION ----
// Mixes CHAPTER_BASE toward a chapter's full palette by strength [0..1].
// Each wave inside a chapter increases strength: wave1=0.22, wave2=0.4, wave3=0.58, wave4=0.76, wave5=1.0
export function mixTheme(fullTheme, strength) {
  const mix = {};
  const keys = ['fog', 'ground', 'grid1', 'grid2', 'hemi1', 'hemi2', 'lamp', 'sky', 'enemyTint'];
  for (const k of keys) {
    const base = new THREE.Color(CHAPTER_BASE[k]);
    const full = new THREE.Color(fullTheme[k]);
    base.lerp(full, strength);
    mix[k] = base.getHex();
  }
  mix.name = fullTheme.name;
  return mix;
}

export function strengthForWave(localWave) {
  return intensityForWave(localWave);
}

// Backward-compatible API: accepts (absoluteWaveIndex).
// Internally figures out chapter and strength, interpolates, and applies.
export function applyTheme(waveIndexOrChapter, maybeLocalWave) {
  let chapterIdx, localWave;
  if (maybeLocalWave !== undefined) {
    chapterIdx = waveIndexOrChapter;
    localWave = maybeLocalWave;
  } else {
    // Legacy: single-arg was absolute wave index (0-based)
    const wave = waveIndexOrChapter + 1;
    chapterIdx = Math.floor((wave - 1) / WAVES_PER_CHAPTER);
    localWave = ((wave - 1) % WAVES_PER_CHAPTER) + 1;
  }
  const chapter = CHAPTERS[chapterIdx % CHAPTERS.length];
  const strength = strengthForWave(localWave);
  const t = mixTheme(chapter.full, strength);

  scene.background.set(t.sky);
  scene.fog.color.set(t.fog);
  scene.remove(gridHelper);
  gridHelper = new THREE.GridHelper(ARENA * 2, 40, t.grid1, t.grid2);
  gridHelper.material.opacity = 0.15;
  gridHelper.material.transparent = true;
  gridHelper.position.y = 0.015;
  scene.add(gridHelper);
  Scene.gridHelper = gridHelper;
  hemi.color.set(t.hemi1);
  hemi.groundColor.set(t.hemi2);
  rimLight.color.set(t.lamp);
  capMat.color.set(t.lamp);
  capMat.emissive.set(t.lamp);
  groundMat.color.set(new THREE.Color(0xffffff).lerp(new THREE.Color(t.lamp), 0.08));
  for (const bulb of lampBulbs) {
    bulb.material.color.set(t.lamp);
    bulb.material.emissive.set(t.lamp);
  }
  for (const pl of lampPointLights) pl.color.set(t.lamp);
  return t;
}
