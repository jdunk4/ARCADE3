import * as THREE from 'three';
import { scene } from './scene.js';
import { ENEMY_TYPES, BOSSES } from './config.js';
import { buildInfectorMesh, buildRoachMesh } from './infector.js';

export const enemies = [];
export const enemyProjectiles = [];

// ============================================================================
// HUMANOID BODY (zomeeb, sprinter, brute, spitter, phantom)
// ============================================================================
function makeHumanoid(tintHex, scale, extraEmissive = 0) {
  const group = new THREE.Group();
  const tint = new THREE.Color(tintHex);
  const bodyColor = tint.clone().multiplyScalar(0.55);
  const headColor = tint.clone().multiplyScalar(0.75);
  const legColor = tint.clone().multiplyScalar(0.4);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.9, 0.9),
    new THREE.MeshStandardMaterial({
      color: headColor, emissive: tint, emissiveIntensity: 0.25 + extraEmissive, roughness: 0.85,
    })
  );
  head.position.y = 2.6; head.castShadow = true; group.add(head);

  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.12, 0.06),
    new THREE.MeshStandardMaterial({
      color: tint, emissive: tint, emissiveIntensity: 1.8 + extraEmissive * 2,
    })
  );
  visor.position.set(0, 2.6, 0.46); group.add(visor);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor, emissive: tint, emissiveIntensity: extraEmissive, roughness: 0.9,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.3, 0.7), bodyMat);
  body.position.y = 1.55; body.castShadow = true; group.add(body);

  const armGeo = new THREE.BoxGeometry(0.3, 1.0, 0.3);
  const armMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.9 });
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(armGeo, armMat);
  armLMesh.position.y = -0.5; armLMesh.castShadow = true; armL.add(armLMesh);
  armL.position.set(-0.7, 2.1, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(armGeo, armMat);
  armRMesh.position.y = -0.5; armRMesh.castShadow = true; armR.add(armRMesh);
  armR.position.set(0.7, 2.1, 0); group.add(armR);

  const legGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
  const legMat = new THREE.MeshStandardMaterial({ color: legColor, roughness: 0.95 });
  const legL = new THREE.Group();
  const legLMesh = new THREE.Mesh(legGeo, legMat);
  legLMesh.position.y = -0.5; legLMesh.castShadow = true; legL.add(legLMesh);
  legL.position.set(-0.28, 1.0, 0); group.add(legL);
  const legR = new THREE.Group();
  const legRMesh = new THREE.Mesh(legGeo, legMat);
  legRMesh.position.y = -0.5; legRMesh.castShadow = true; legR.add(legRMesh);
  legR.position.set(0.28, 1.0, 0); group.add(legR);

  group.scale.setScalar(scale);
  return { group, body, bodyMat, armL, armR, legL, legR, head, visor };
}

// ============================================================================
// SPIDER
// ============================================================================
function makeSpider(tintHex, scale) {
  const group = new THREE.Group();
  const tint = new THREE.Color(tintHex);
  const bodyColor = tint.clone().multiplyScalar(0.4);
  const legColor = tint.clone().multiplyScalar(0.3);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor, emissive: tint, emissiveIntensity: 0.3, roughness: 0.85,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.5), bodyMat);
  body.position.y = 0.8; body.castShadow = true; group.add(body);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.5, 0.5),
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 })
  );
  head.position.set(0, 0.9, 0.95); head.castShadow = true; group.add(head);

  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xff2e4d, emissive: 0xff2e4d, emissiveIntensity: 3,
  });
  for (let i = 0; i < 4; i++) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.04), eyeMat);
    eye.position.set(-0.18 + (i % 2) * 0.36, 0.9 + Math.floor(i / 2) * 0.12, 1.22);
    group.add(eye);
  }

  const legGeo = new THREE.BoxGeometry(0.12, 0.12, 0.9);
  const legMat = new THREE.MeshStandardMaterial({ color: legColor, roughness: 0.8 });
  const legs = [];
  const positions = [
    [-0.55, 0.4, Math.PI * 0.25], [0.55, 0.4, -Math.PI * 0.25],
    [-0.6, -0.1, Math.PI * 0.1], [0.6, -0.1, -Math.PI * 0.1],
    [-0.55, -0.5, Math.PI * -0.1], [0.55, -0.5, -Math.PI * -0.1],
    [-0.45, -0.8, Math.PI * -0.25], [0.45, -0.8, -Math.PI * -0.25],
  ];
  for (const [x, z, ry] of positions) {
    const legGrp = new THREE.Group();
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(0, -0.3, 0.45);
    leg.rotation.x = Math.PI / 3;
    leg.castShadow = true;
    legGrp.add(leg);
    legGrp.position.set(x, 0.7, z);
    legGrp.rotation.y = ry;
    group.add(legGrp);
    legs.push(legGrp);
  }

  group.scale.setScalar(scale);
  return { group, body, bodyMat, armL: legs[0], armR: legs[1], legL: legs[2], legR: legs[3], head, spiderLegs: legs };
}

// ============================================================================
// PUMPKIN HEAD
// ============================================================================
function makePumpkin(tintHex, scale) {
  const group = new THREE.Group();
  const tint = new THREE.Color(tintHex);
  const pumpkinColor = new THREE.Color(0xff6a1a).lerp(tint, 0.4);
  const stemColor = 0x1a3a0a;
  const bodyColor = new THREE.Color(0x1a0a04).lerp(tint, 0.3);

  const pumpMat = new THREE.MeshStandardMaterial({
    color: pumpkinColor, emissive: pumpkinColor, emissiveIntensity: 0.35, roughness: 0.75,
  });
  const pumpCenter = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.9, 1.15), pumpMat);
  pumpCenter.position.y = 2.6; pumpCenter.castShadow = true; group.add(pumpCenter);
  const pumpSide1 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.85, 1.05), pumpMat);
  pumpSide1.position.set(-0.65, 2.6, 0); pumpSide1.castShadow = true; group.add(pumpSide1);
  const pumpSide2 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.85, 1.05), pumpMat);
  pumpSide2.position.set(0.65, 2.6, 0); pumpSide2.castShadow = true; group.add(pumpSide2);

  const stem = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.3, 0.2),
    new THREE.MeshStandardMaterial({ color: stemColor, roughness: 0.9 })
  );
  stem.position.y = 3.2; group.add(stem);

  const faceMat = new THREE.MeshStandardMaterial({
    color: 0xffee00, emissive: 0xffaa00, emissiveIntensity: 4,
  });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.05), faceMat);
  eyeL.position.set(-0.25, 2.7, 0.6); group.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.05), faceMat);
  eyeR.position.set(0.25, 2.7, 0.6); group.add(eyeR);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.05), faceMat);
  mouth.position.set(0, 2.4, 0.6); group.add(mouth);

  // Small body
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor, emissive: tint, emissiveIntensity: 0.2, roughness: 0.9,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.6), bodyMat);
  body.position.y = 1.4; body.castShadow = true; group.add(body);

  // Stumpy legs
  const legGeo = new THREE.BoxGeometry(0.35, 0.7, 0.35);
  const legMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.9 });
  const legL = new THREE.Group();
  const legLMesh = new THREE.Mesh(legGeo, legMat);
  legLMesh.position.y = -0.35; legLMesh.castShadow = true; legL.add(legLMesh);
  legL.position.set(-0.22, 0.8, 0); group.add(legL);
  const legR = new THREE.Group();
  const legRMesh = new THREE.Mesh(legGeo, legMat);
  legRMesh.position.y = -0.35; legRMesh.castShadow = true; legR.add(legRMesh);
  legR.position.set(0.22, 0.8, 0); group.add(legR);

  // Arms (stubby)
  const armGeo = new THREE.BoxGeometry(0.25, 0.7, 0.25);
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(armGeo, legMat);
  armLMesh.position.y = -0.35; armL.add(armLMesh);
  armL.position.set(-0.5, 1.9, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(armGeo, legMat);
  armRMesh.position.y = -0.35; armR.add(armRMesh);
  armR.position.set(0.5, 1.9, 0); group.add(armR);

  // Orange glow — emissive-only (no PointLight to avoid shader recompile churn)
  // const light = new THREE.PointLight(0xff8800, 1.8, 6, 1.5);
  // light.position.y = 2.6; group.add(light);

  group.scale.setScalar(scale);
  return { group, body, bodyMat, armL, armR, legL, legR };
}

// ============================================================================
// GHOST
// ============================================================================
function makeGhost(tintHex, scale) {
  const group = new THREE.Group();
  const tint = new THREE.Color(tintHex);
  const ghostColor = tint.clone().lerp(new THREE.Color(0xffffff), 0.55);

  const ghostMat = new THREE.MeshStandardMaterial({
    color: ghostColor, emissive: ghostColor, emissiveIntensity: 0.9,
    transparent: true, opacity: 0.72, roughness: 0.3,
  });

  const head = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 1.0), ghostMat);
  head.position.y = 2.4; group.add(head);

  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: tint, emissiveIntensity: 1.5,
  });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.1), eyeMat);
  eyeL.position.set(-0.26, 2.45, 0.52); group.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.1), eyeMat);
  eyeR.position.set(0.26, 2.45, 0.52); group.add(eyeR);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.2, 0.1), eyeMat);
  mouth.position.set(0, 2.1, 0.52); group.add(mouth);

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 0.9), ghostMat);
  body.position.y = 1.4; group.add(body);

  const tailSegs = [];
  for (let i = 0; i < 4; i++) {
    const w = 0.9 - i * 0.15;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, 0.7), ghostMat);
    seg.position.y = 0.8 - i * 0.25;
    group.add(seg);
    tailSegs.push(seg);
  }

  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.6, 0.25), ghostMat);
  armLMesh.position.y = -0.3; armL.add(armLMesh);
  armL.position.set(-0.6, 1.9, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.6, 0.25), ghostMat);
  armRMesh.position.y = -0.3; armR.add(armRMesh);
  armR.position.set(0.6, 1.9, 0); group.add(armR);

  const invisibleDummy = new THREE.Group();
  const legL = invisibleDummy.clone();
  const legR = invisibleDummy.clone();
  group.add(legL); group.add(legR);

  // Aura light removed — was adding a PointLight per ghost, which
  // caused wave-start shader recompile stalls.
  // const aura = new THREE.PointLight(tint.getHex(), 2, 8, 1.5);
  // aura.position.y = 2; group.add(aura);

  group.scale.setScalar(scale);
  return { group, body, bodyMat: ghostMat, armL, armR, legL, legR, head, ghostTail: tailSegs };
}

// ============================================================================
// VAMPIRE — pale, caped, red eyes, teleports
// ============================================================================
function makeVampire(tintHex, scale) {
  const group = new THREE.Group();
  const tint = new THREE.Color(tintHex);
  const paleColor = new THREE.Color(0xe8e0e0);
  const capeColor = new THREE.Color(0x1a0208);
  const bloodRed = 0xff2e4d;

  // Pale head
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.9, 0.9),
    new THREE.MeshStandardMaterial({
      color: paleColor, emissive: 0x331122, emissiveIntensity: 0.1, roughness: 0.6,
    })
  );
  head.position.y = 2.7; head.castShadow = true; group.add(head);

  // Slicked-back hair (black box on top)
  const hair = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, 0.25, 0.92),
    new THREE.MeshStandardMaterial({ color: 0x0a0408, roughness: 0.5 })
  );
  hair.position.y = 3.12; group.add(hair);

  // Glowing red eyes
  const eyeMat = new THREE.MeshStandardMaterial({
    color: bloodRed, emissive: bloodRed, emissiveIntensity: 3.5,
  });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.05), eyeMat);
  eyeL.position.set(-0.2, 2.72, 0.46); group.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.05), eyeMat);
  eyeR.position.set(0.2, 2.72, 0.46); group.add(eyeR);

  // Fangs
  const fangMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5 });
  const fangL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.05), fangMat);
  fangL.position.set(-0.12, 2.45, 0.46); group.add(fangL);
  const fangR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.05), fangMat);
  fangR.position.set(0.12, 2.45, 0.46); group.add(fangR);

  // Body (dark)
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x220010, emissive: tint, emissiveIntensity: 0.18, roughness: 0.85,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.3, 0.6), bodyMat);
  body.position.y = 1.6; body.castShadow = true; group.add(body);

  // Cape — wider box behind the body
  const capeMat = new THREE.MeshStandardMaterial({
    color: capeColor, emissive: bloodRed, emissiveIntensity: 0.4, roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const cape = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 0.15), capeMat);
  cape.position.set(0, 1.6, -0.4); cape.castShadow = true; group.add(cape);

  // High collar (cape top, points up)
  const collarL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.12), capeMat);
  collarL.position.set(-0.5, 2.55, -0.2);
  collarL.rotation.z = -0.25; group.add(collarL);
  const collarR = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.12), capeMat);
  collarR.position.set(0.5, 2.55, -0.2);
  collarR.rotation.z = 0.25; group.add(collarR);

  const armGeo = new THREE.BoxGeometry(0.28, 1.0, 0.28);
  const armMat = new THREE.MeshStandardMaterial({ color: 0x180008, roughness: 0.9 });
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(armGeo, armMat);
  armLMesh.position.y = -0.5; armLMesh.castShadow = true; armL.add(armLMesh);
  armL.position.set(-0.65, 2.15, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(armGeo, armMat);
  armRMesh.position.y = -0.5; armRMesh.castShadow = true; armR.add(armRMesh);
  armR.position.set(0.65, 2.15, 0); group.add(armR);

  const legGeo = new THREE.BoxGeometry(0.35, 1.0, 0.35);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x0a0004, roughness: 0.95 });
  const legL = new THREE.Group();
  const legLMesh = new THREE.Mesh(legGeo, legMat);
  legLMesh.position.y = -0.5; legLMesh.castShadow = true; legL.add(legLMesh);
  legL.position.set(-0.26, 1.0, 0); group.add(legL);
  const legR = new THREE.Group();
  const legRMesh = new THREE.Mesh(legGeo, legMat);
  legRMesh.position.y = -0.5; legRMesh.castShadow = true; legR.add(legRMesh);
  legR.position.set(0.26, 1.0, 0); group.add(legR);

  // Blood-red aura — removed PointLight
  // const aura = new THREE.PointLight(bloodRed, 1.5, 6, 1.5);
  // aura.position.y = 2.5; group.add(aura);

  group.scale.setScalar(scale);
  return { group, body, bodyMat, armL, armR, legL, legR, cape };
}

// ============================================================================
// RED DEVIL — horned, dark-red, shoots fireballs
// ============================================================================
function makeRedDevil(tintHex, scale) {
  const group = new THREE.Group();
  const devilRed = new THREE.Color(0xa61020);
  const darkRed = new THREE.Color(0x4a0510);
  const fireOrange = 0xff4400;

  // Head
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 0.9, 0.95),
    new THREE.MeshStandardMaterial({
      color: devilRed, emissive: devilRed, emissiveIntensity: 0.4, roughness: 0.7,
    })
  );
  head.position.y = 2.6; head.castShadow = true; group.add(head);

  // Horns (cones, pointed up and slightly back)
  const hornMat = new THREE.MeshStandardMaterial({
    color: 0x1a0208, emissive: 0x331010, emissiveIntensity: 0.3, roughness: 0.8,
  });
  const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.6, 4), hornMat);
  hornL.position.set(-0.3, 3.2, -0.1);
  hornL.rotation.z = 0.3; group.add(hornL);
  const hornR = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.6, 4), hornMat);
  hornR.position.set(0.3, 3.2, -0.1);
  hornR.rotation.z = -0.3; group.add(hornR);

  // Glowing yellow eyes
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xffff00, emissive: 0xffaa00, emissiveIntensity: 4,
  });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.05), eyeMat);
  eyeL.position.set(-0.22, 2.6, 0.5); group.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.05), eyeMat);
  eyeR.position.set(0.22, 2.6, 0.5); group.add(eyeR);

  // Body
  const bodyMat = new THREE.MeshStandardMaterial({
    color: darkRed, emissive: devilRed, emissiveIntensity: 0.3, roughness: 0.8,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.3, 0.7), bodyMat);
  body.position.y = 1.55; body.castShadow = true; group.add(body);

  // Arms
  const armGeo = new THREE.BoxGeometry(0.32, 1.0, 0.32);
  const armMat = new THREE.MeshStandardMaterial({ color: darkRed, emissive: devilRed, emissiveIntensity: 0.25 });
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(armGeo, armMat);
  armLMesh.position.y = -0.5; armLMesh.castShadow = true; armL.add(armLMesh);
  armL.position.set(-0.72, 2.1, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(armGeo, armMat);
  armRMesh.position.y = -0.5; armRMesh.castShadow = true; armR.add(armRMesh);
  armR.position.set(0.72, 2.1, 0); group.add(armR);

  // Flame above right hand (fireball charging)
  const flameMat = new THREE.MeshStandardMaterial({
    color: fireOrange, emissive: fireOrange, emissiveIntensity: 4, transparent: true, opacity: 0.85,
  });
  const flame = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), flameMat);
  flame.position.set(0, -1.0, 0.1); armR.add(flame);

  const legGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x300508, roughness: 0.95 });
  const legL = new THREE.Group();
  const legLMesh = new THREE.Mesh(legGeo, legMat);
  legLMesh.position.y = -0.5; legLMesh.castShadow = true; legL.add(legLMesh);
  legL.position.set(-0.28, 1.0, 0); group.add(legL);
  const legR = new THREE.Group();
  const legRMesh = new THREE.Mesh(legGeo, legMat);
  legRMesh.position.y = -0.5; legRMesh.castShadow = true; legR.add(legRMesh);
  legR.position.set(0.28, 1.0, 0); group.add(legR);

  // Red glow — removed PointLight
  // const aura = new THREE.PointLight(0xff2e4d, 2.2, 8, 1.5);
  // aura.position.y = 2.5; group.add(aura);

  group.scale.setScalar(scale);
  return { group, body, bodyMat, armL, armR, legL, legR };
}

// ============================================================================
// WIZARD — pointed hat, robe, golden staff, throws triangles
// ============================================================================
function makeWizard(tintHex, scale) {
  const group = new THREE.Group();
  const robeColor = new THREE.Color(0x402010).lerp(new THREE.Color(tintHex), 0.35);
  const hatColor = 0x2a1a04;
  const gold = 0xffd93d;

  // Pointed hat (cone) — tall
  const hatMat = new THREE.MeshStandardMaterial({
    color: hatColor, emissive: gold, emissiveIntensity: 0.25, roughness: 0.9,
  });
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.3, 4), hatMat);
  hat.position.y = 3.45;
  hat.rotation.y = Math.PI / 4;
  hat.castShadow = true; group.add(hat);

  // Hat brim
  const brim = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.15, 1.2),
    new THREE.MeshStandardMaterial({ color: hatColor, roughness: 0.9 })
  );
  brim.position.y = 2.82; group.add(brim);

  // Head (partially hidden by hat/beard)
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.7, 0.8),
    new THREE.MeshStandardMaterial({
      color: 0xd8b090, emissive: 0x332210, emissiveIntensity: 0.15, roughness: 0.7,
    })
  );
  head.position.y = 2.55; head.castShadow = true; group.add(head);

  // Glowing yellow eyes
  const eyeMat = new THREE.MeshStandardMaterial({
    color: gold, emissive: gold, emissiveIntensity: 3.5,
  });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.04), eyeMat);
  eyeL.position.set(-0.16, 2.58, 0.41); group.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.04), eyeMat);
  eyeR.position.set(0.16, 2.58, 0.41); group.add(eyeR);

  // White beard
  const beard = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.6, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.9 })
  );
  beard.position.set(0, 2.15, 0.35); group.add(beard);

  // Robe body — wider at bottom
  const bodyMat = new THREE.MeshStandardMaterial({
    color: robeColor, emissive: tintHex, emissiveIntensity: 0.35, roughness: 0.85,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.3, 0.7), bodyMat);
  body.position.y = 1.5; body.castShadow = true; group.add(body);
  const robeBot = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.8, 0.9), bodyMat);
  robeBot.position.y = 0.6; robeBot.castShadow = true; group.add(robeBot);

  // Arms
  const armGeo = new THREE.BoxGeometry(0.28, 1.0, 0.28);
  const armMat = new THREE.MeshStandardMaterial({ color: robeColor, emissive: tintHex, emissiveIntensity: 0.3 });
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(armGeo, armMat);
  armLMesh.position.y = -0.5; armLMesh.castShadow = true; armL.add(armLMesh);
  armL.position.set(-0.7, 2.05, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(armGeo, armMat);
  armRMesh.position.y = -0.5; armRMesh.castShadow = true; armR.add(armRMesh);
  armR.position.set(0.7, 2.05, 0); group.add(armR);

  // Golden staff in right hand
  const staffMat = new THREE.MeshStandardMaterial({
    color: 0x886622, emissive: gold, emissiveIntensity: 0.4, roughness: 0.6,
  });
  const staff = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 0.12), staffMat);
  staff.position.set(0.2, -0.9, 0); armR.add(staff);
  // Staff orb (glowing yellow crystal)
  const orbMat = new THREE.MeshStandardMaterial({
    color: gold, emissive: gold, emissiveIntensity: 4, transparent: true, opacity: 0.9,
  });
  const orb = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), orbMat);
  orb.position.set(0.2, 0.15, 0); armR.add(orb);

  // Legs (hidden by robe but kept for anim)
  const legGeo = new THREE.BoxGeometry(0.3, 0.6, 0.3);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x200a00, roughness: 0.9 });
  const legL = new THREE.Group();
  const legLMesh = new THREE.Mesh(legGeo, legMat);
  legLMesh.position.y = -0.3; legL.add(legLMesh);
  legL.position.set(-0.2, 0.3, 0); group.add(legL);
  const legR = new THREE.Group();
  const legRMesh = new THREE.Mesh(legGeo, legMat);
  legRMesh.position.y = -0.3; legR.add(legRMesh);
  legR.position.set(0.2, 0.3, 0); group.add(legR);

  // Wizard aura — removed PointLight
  // const aura = new THREE.PointLight(gold, 2.0, 8, 1.5);
  // aura.position.y = 3.5; group.add(aura);

  group.scale.setScalar(scale);
  return { group, body, bodyMat, armL, armR, legL, legR };
}

// ============================================================================
// GOO SPITTER — tall, lanky, green, spits ranged goo
// ============================================================================
function makeGooSpitter(tintHex, scale) {
  const group = new THREE.Group();
  const gooGreen = new THREE.Color(0x00ff44);
  const darkGreen = new THREE.Color(0x104020);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: darkGreen, emissive: gooGreen, emissiveIntensity: 0.5, roughness: 0.6,
  });

  // Elongated head — narrow, taller than wide
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 1.2, 0.7),
    bodyMat.clone()
  );
  head.material.emissiveIntensity = 0.7;
  head.position.y = 3.3; head.castShadow = true; group.add(head);

  // Big glowing mouth
  const mouthMat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: gooGreen, emissiveIntensity: 3.5,
  });
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.3, 0.08), mouthMat);
  mouth.position.set(0, 3.0, 0.37); group.add(mouth);

  // Bulging eyes
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xffff00, emissive: 0xffff00, emissiveIntensity: 3,
  });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.1), eyeMat);
  eyeL.position.set(-0.2, 3.55, 0.35); group.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.1), eyeMat);
  eyeR.position.set(0.2, 3.55, 0.35); group.add(eyeR);

  // Long skinny neck
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 0.3), bodyMat);
  neck.position.y = 2.4; group.add(neck);

  // Narrow body — tall and thin
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.4, 0.5), bodyMat);
  body.position.y = 1.45; body.castShadow = true; group.add(body);

  // Very long lanky arms
  const armGeo = new THREE.BoxGeometry(0.22, 1.6, 0.22);
  const armMat = new THREE.MeshStandardMaterial({
    color: darkGreen, emissive: gooGreen, emissiveIntensity: 0.4, roughness: 0.6,
  });
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(armGeo, armMat);
  armLMesh.position.y = -0.8; armLMesh.castShadow = true; armL.add(armLMesh);
  armL.position.set(-0.55, 2.05, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(armGeo, armMat);
  armRMesh.position.y = -0.8; armRMesh.castShadow = true; armR.add(armRMesh);
  armR.position.set(0.55, 2.05, 0); group.add(armR);

  // Very long lanky legs
  const legGeo = new THREE.BoxGeometry(0.26, 1.5, 0.26);
  const legMat = armMat.clone();
  const legL = new THREE.Group();
  const legLMesh = new THREE.Mesh(legGeo, legMat);
  legLMesh.position.y = -0.75; legLMesh.castShadow = true; legL.add(legLMesh);
  legL.position.set(-0.22, 0.85, 0); group.add(legL);
  const legR = new THREE.Group();
  const legRMesh = new THREE.Mesh(legGeo, legMat);
  legRMesh.position.y = -0.75; legRMesh.castShadow = true; legR.add(legRMesh);
  legR.position.set(0.22, 0.85, 0); group.add(legR);

  // Dripping goo on shoulders
  const dropMat = new THREE.MeshStandardMaterial({
    color: gooGreen, emissive: gooGreen, emissiveIntensity: 2, transparent: true, opacity: 0.75,
  });
  const drop1 = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.2, 0.15), dropMat);
  drop1.position.set(-0.4, 2.1, 0.15); group.add(drop1);
  const drop2 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.15, 0.12), dropMat);
  drop2.position.set(0.45, 1.95, 0.1); group.add(drop2);

  // Green glow — removed PointLight
  // const aura = new THREE.PointLight(gooGreen, 2.2, 10, 1.5);
  // aura.position.y = 2.5; group.add(aura);

  group.scale.setScalar(scale);
  return { group, body, bodyMat, armL, armR, legL, legR };
}

// ============================================================================
// MAKE ENEMY — dispatches to the right factory
// ============================================================================
export function makeEnemy(typeKey, tintHex, pos) {
  const spec = ENEMY_TYPES[typeKey] || ENEMY_TYPES.zomeeb;
  const scale = 0.55 * spec.scale;

  let built;
  if (typeKey === 'infector') {
    const m = buildInfectorMesh(tintHex, scale);
    built = { group: m.group, body: m.body, bodyMat: m.bodyMat };
    built._tendrils = m.tendrils;
  }
  else if (typeKey === 'roach') {
    const m = buildRoachMesh(tintHex, scale);
    built = { group: m.group, body: m.body, bodyMat: m.bodyMat };
    built._legs = m.legs;
  }
  else if (typeKey === 'spider')        built = makeSpider(tintHex, scale);
  else if (typeKey === 'pumpkin')  built = makePumpkin(tintHex, scale);
  else if (typeKey === 'ghost')    built = makeGhost(tintHex, scale);
  else if (typeKey === 'vampire')  built = makeVampire(tintHex, scale);
  else if (typeKey === 'red_devil') built = makeRedDevil(tintHex, scale);
  else if (typeKey === 'wizard')   built = makeWizard(tintHex, scale);
  else if (typeKey === 'goospitter') built = makeGooSpitter(tintHex, scale);
  else                             built = makeHumanoid(tintHex, scale);

  const { group, body, bodyMat, armL, armR, legL, legR } = built;
  group.position.copy(pos);
  scene.add(group);

  const enemy = {
    type: typeKey,
    obj: group,
    pos: group.position,
    body, bodyMat, armL, armR, legL, legR,
    speed: spec.speed,
    hp: spec.hp,
    hpMax: spec.hp,
    damage: spec.damage,
    scoreVal: spec.score,
    xpVal: spec.xp,
    walkPhase: Math.random() * Math.PI * 2,
    hitFlash: 0,
    touchCooldown: 0,
    ranged: !!spec.ranged,
    range: spec.range || 0,
    rangedCooldown: 1 + Math.random() * 1.5,
    phases: !!spec.phases,
    phaseTimer: spec.phases ? 2 + Math.random() * 2 : 0,
    isFloater: typeKey === 'ghost',
    isExplosive: typeKey === 'pumpkin',
    isSpider: typeKey === 'spider',
    spiderLegs: built.spiderLegs || null,
    ghostTail: built.ghostTail || null,
    floatPhase: Math.random() * Math.PI * 2,
    isBoss: false,
    // New behavior flags
    blinks: !!spec.blinks,
    blinkInterval: spec.blinkInterval || 0,
    blinkRange: spec.blinkRange || 0,
    blinkTimer: spec.blinks ? (spec.blinkInterval * (0.5 + Math.random() * 0.5)) : 0,
    projType: spec.projType || 'box',
    fireballColor: spec.fireballColor || 0x00ff66,
    leavesGoo: !!spec.leavesGoo,
    // Infector lineage
    isInfectorType: !!spec.isInfector,
    _tendrils: built._tendrils || null,
    _legs: built._legs || null,
    isPossessed: false,
    flingLock: false,
  };
  enemies.push(enemy);
  return enemy;
}

// ============================================================================
// MAKE BOSS — with pattern flag for new behavior
// ============================================================================
export function makeBoss(bossKey, tintHex, pos) {
  const spec = BOSSES[bossKey] || BOSSES.MEGA_ZOMEEB;
  const scale = 0.55 * spec.scale;
  const { group, body, bodyMat, armL, armR, legL, legR } = makeHumanoid(tintHex, scale, 0.4);

  group.position.copy(pos);
  // Boss aura PointLight removed — adding it mid-wave caused shader
  // recompile churn. Emissive boost is bumped in the makeHumanoid
  // call above (extraEmissive=0.4) so the boss still reads bright.

  const crown = new THREE.Mesh(
    new THREE.ConeGeometry(0.7, 0.9, 4),
    new THREE.MeshStandardMaterial({ color: 0xffd93d, emissive: 0xffd93d, emissiveIntensity: 1.2 })
  );
  crown.position.y = 3.5;
  crown.rotation.y = Math.PI / 4;
  group.add(crown);

  scene.add(group);

  const boss = {
    type: bossKey,
    obj: group,
    pos: group.position,
    body, bodyMat, armL, armR, legL, legR,
    speed: spec.speed,
    hp: spec.hp, hpMax: spec.hp,
    damage: spec.damage,
    scoreVal: spec.score,
    xpVal: spec.xp,
    walkPhase: 0,
    hitFlash: 0,
    touchCooldown: 0,
    ranged: true,
    range: 20,
    rangedCooldown: 1.5,
    phases: false,
    phaseTimer: 0,
    isBoss: true,
    name: spec.name,
    // New pattern-specific properties
    pattern: spec.pattern || 'summoner',
    summonCooldown: 6,
    cubeStormCooldown: 5,
    halfHpTriggered: false,
  };
  enemies.push(boss);
  return boss;
}

export function clearAllEnemies() {
  for (const e of enemies) scene.remove(e.obj);
  enemies.length = 0;
  for (const p of enemyProjectiles) scene.remove(p);
  enemyProjectiles.length = 0;
}

// Shared geometries for enemy projectiles — allocated once at module load
// so first-fire of each projectile type doesn't trigger a shader-compile stall.
const _PROJ_BOX_GEO = new THREE.BoxGeometry(0.3, 0.3, 0.3);
const _PROJ_TRIANGLE_GEO = new THREE.ConeGeometry(0.35, 0.7, 3);
const _PROJ_FIREBALL_GEO = new THREE.OctahedronGeometry(0.28, 0);
const _projMatCache = new Map();
function _getProjMat(projType, color) {
  const key = projType + ':' + color;
  let m = _projMatCache.get(key);
  if (!m) {
    const intensity = projType === 'box' ? 2.5 : 3.5;
    m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity });
    _projMatCache.set(key, m);
  }
  return m;
}

// Generic box projectile (zomeeb spit, vampire bolt, devil fireball)
export function spawnEnemyProjectile(fromPos, toPos, speed, damage, color, projType = 'box') {
  let geo;
  if (projType === 'triangle') geo = _PROJ_TRIANGLE_GEO;
  else if (projType === 'fireball') geo = _PROJ_FIREBALL_GEO;
  else geo = _PROJ_BOX_GEO;
  const mat = _getProjMat(projType, color);
  const proj = new THREE.Mesh(geo, mat);
  proj.position.set(fromPos.x, 1.4, fromPos.z);
  const dx = toPos.x - fromPos.x;
  const dz = toPos.z - fromPos.z;
  const d = Math.sqrt(dx * dx + dz * dz) || 1;
  proj.userData = {
    vel: new THREE.Vector3((dx / d) * speed, 0, (dz / d) * speed),
    life: 3,
    damage,
    projType,
    color,
  };
  if (projType === 'triangle') {
    // Orient triangle toward travel direction
    proj.rotation.x = Math.PI / 2;
  }
  scene.add(proj);
  enemyProjectiles.push(proj);
  return proj;
}
