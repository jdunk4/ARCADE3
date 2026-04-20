import * as THREE from 'three';
import { scene } from './scene.js';
import { ENEMY_TYPES, BOSSES } from './config.js';

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
// SPIDER — low-profile, 4 legs, skittering
// ============================================================================
function makeSpider(tintHex, scale) {
  const group = new THREE.Group();
  const tint = new THREE.Color(tintHex);
  const bodyColor = tint.clone().multiplyScalar(0.4);
  const legColor = tint.clone().multiplyScalar(0.3);

  // Big round body
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor, emissive: tint, emissiveIntensity: 0.3, roughness: 0.85,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.5), bodyMat);
  body.position.y = 0.8; body.castShadow = true; group.add(body);

  // Small head up front
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.5, 0.5),
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 })
  );
  head.position.set(0, 0.9, 0.95); head.castShadow = true; group.add(head);

  // 4 glowing eyes
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xff2e4d, emissive: 0xff2e4d, emissiveIntensity: 3,
  });
  for (let i = 0; i < 4; i++) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.04), eyeMat);
    eye.position.set(-0.18 + (i % 2) * 0.36, 0.9 + Math.floor(i / 2) * 0.12, 1.22);
    group.add(eye);
  }

  // 8 legs as 4 groups (two legs per pair)
  const legGeo = new THREE.BoxGeometry(0.12, 0.12, 0.9);
  const legMat = new THREE.MeshStandardMaterial({ color: legColor, roughness: 0.8 });
  const legs = [];
  const positions = [
    // [x, z, angle-offset-y]
    [-0.55, 0.4, Math.PI * 0.25],
    [0.55, 0.4, -Math.PI * 0.25],
    [-0.6, -0.1, Math.PI * 0.1],
    [0.6, -0.1, -Math.PI * 0.1],
    [-0.55, -0.5, Math.PI * -0.1],
    [0.55, -0.5, -Math.PI * -0.1],
    [-0.45, -0.8, Math.PI * -0.25],
    [0.45, -0.8, -Math.PI * -0.25],
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
  // Return with leg array so animation can skitter them
  return { group, body, bodyMat, armL: legs[0], armR: legs[1], legL: legs[2], legR: legs[3], head, spiderLegs: legs };
}

// ============================================================================
// PUMPKIN HEAD — tall pumpkin on stumpy body, glowing jack-o-lantern face
// ============================================================================
function makePumpkin(tintHex, scale) {
  const group = new THREE.Group();
  const tint = new THREE.Color(tintHex);
  const pumpkinColor = new THREE.Color(0xff6a1a).lerp(tint, 0.4);
  const stemColor = 0x1a3a0a;
  const bodyColor = new THREE.Color(0x1a0a04).lerp(tint, 0.3);

  // Pumpkin head — 3 stacked boxes to give segmented shape
  const pumpMat = new THREE.MeshStandardMaterial({
    color: pumpkinColor, emissive: pumpkinColor, emissiveIntensity: 0.35, roughness: 0.75,
  });
  const pumpCenter = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.9, 1.15), pumpMat);
  pumpCenter.position.y = 2.6; pumpCenter.castShadow = true; group.add(pumpCenter);
  const pumpSide1 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.85, 1.05), pumpMat);
  pumpSide1.position.set(-0.65, 2.6, 0); pumpSide1.castShadow = true; group.add(pumpSide1);
  const pumpSide2 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.85, 1.05), pumpMat);
  pumpSide2.position.set(0.65, 2.6, 0); pumpSide2.castShadow = true; group.add(pumpSide2);

  // Stem
  const stem = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.3, 0.2),
    new THREE.MeshStandardMaterial({ color: stemColor, roughness: 0.9 })
  );
  stem.position.y = 3.2; group.add(stem);

  // Jack-o-lantern face — glowing panels
  const faceMat = new THREE.MeshStandardMaterial({
    color: 0xffee00, emissive: 0xffaa00, emissiveIntensity: 4,
  });
  // Triangle eyes (approximated with boxes)
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.05), faceMat);
  eyeL.position.set(-0.22, 2.7, 0.62); group.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.05), faceMat);
  eyeR.position.set(0.22, 2.7, 0.62); group.add(eyeR);
  // Jagged mouth
  const mouthMat = new THREE.MeshStandardMaterial({
    color: 0xffee00, emissive: 0xff6600, emissiveIntensity: 3,
  });
  for (let i = 0; i < 5; i++) {
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.15, 0.05), mouthMat);
    tooth.position.set(-0.28 + i * 0.14, 2.4, 0.62);
    tooth.rotation.z = (i % 2) * 0.25;
    group.add(tooth);
  }

  // Stumpy body
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor, emissive: tint, emissiveIntensity: 0.15, roughness: 0.9,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.4, 0.7), bodyMat);
  body.position.y = 1.4; body.castShadow = true; group.add(body);

  // Stubby arms
  const armGeo = new THREE.BoxGeometry(0.28, 0.9, 0.28);
  const armMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.9 });
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(armGeo, armMat);
  armLMesh.position.y = -0.45; armLMesh.castShadow = true; armL.add(armLMesh);
  armL.position.set(-0.63, 1.95, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(armGeo, armMat);
  armRMesh.position.y = -0.45; armRMesh.castShadow = true; armR.add(armRMesh);
  armR.position.set(0.63, 1.95, 0); group.add(armR);

  // Legs
  const legGeo = new THREE.BoxGeometry(0.38, 0.9, 0.38);
  const legMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.95 });
  const legL = new THREE.Group();
  const legLMesh = new THREE.Mesh(legGeo, legMat);
  legLMesh.position.y = -0.45; legLMesh.castShadow = true; legL.add(legLMesh);
  legL.position.set(-0.25, 0.9, 0); group.add(legL);
  const legR = new THREE.Group();
  const legRMesh = new THREE.Mesh(legGeo, legMat);
  legRMesh.position.y = -0.45; legRMesh.castShadow = true; legR.add(legRMesh);
  legR.position.set(0.25, 0.9, 0); group.add(legR);

  // Inner glow
  const glow = new THREE.PointLight(0xffaa00, 2.5, 5, 1.5);
  glow.position.y = 2.6;
  group.add(glow);

  group.scale.setScalar(scale);
  return { group, body, bodyMat, armL, armR, legL, legR, head: pumpCenter };
}

// ============================================================================
// GHOST — floating, semi-transparent, trailing tail
// ============================================================================
function makeGhost(tintHex, scale) {
  const group = new THREE.Group();
  const tint = new THREE.Color(tintHex);
  const ghostColor = tint.clone().lerp(new THREE.Color(0xffffff), 0.55);

  const ghostMat = new THREE.MeshStandardMaterial({
    color: ghostColor, emissive: ghostColor, emissiveIntensity: 0.9,
    transparent: true, opacity: 0.72, roughness: 0.3,
  });

  // Head
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 1.0), ghostMat);
  head.position.y = 2.4; head.castShadow = false; group.add(head);

  // Hollow eye sockets
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: tint, emissiveIntensity: 1.5,
  });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.1), eyeMat);
  eyeL.position.set(-0.26, 2.45, 0.52); group.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.1), eyeMat);
  eyeR.position.set(0.26, 2.45, 0.52); group.add(eyeR);
  // Gaping mouth
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.2, 0.1), eyeMat);
  mouth.position.set(0, 2.1, 0.52); group.add(mouth);

  // Body — tapered, wavy tail
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 0.9), ghostMat);
  body.position.y = 1.4; body.castShadow = false; group.add(body);

  // Wavy tail segments
  const tailSegs = [];
  for (let i = 0; i < 4; i++) {
    const w = 0.9 - i * 0.15;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, 0.7), ghostMat);
    seg.position.y = 0.8 - i * 0.25;
    group.add(seg);
    tailSegs.push(seg);
  }

  // Fake arms (for shared walkPhase animation — they just wave)
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.6, 0.25), ghostMat);
  armLMesh.position.y = -0.3; armL.add(armLMesh);
  armL.position.set(-0.6, 1.9, 0); group.add(armL);
  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.6, 0.25), ghostMat);
  armRMesh.position.y = -0.3; armR.add(armRMesh);
  armR.position.set(0.6, 1.9, 0); group.add(armR);

  // No legs — we'll use legL/legR refs as tail placeholders so animation code
  // doesn't crash. Hide them by making them tiny.
  const invisibleDummy = new THREE.Group();
  const legL = invisibleDummy.clone();
  const legR = invisibleDummy.clone();
  group.add(legL); group.add(legR);

  // Aura light
  const aura = new THREE.PointLight(tint.getHex(), 2, 8, 1.5);
  aura.position.y = 2; group.add(aura);

  group.scale.setScalar(scale);
  return { group, body, bodyMat: ghostMat, armL, armR, legL, legR, head, ghostTail: tailSegs };
}

// ============================================================================
// MAKE ENEMY
// ============================================================================
export function makeEnemy(typeKey, tintHex, pos) {
  const spec = ENEMY_TYPES[typeKey] || ENEMY_TYPES.zomeeb;
  const scale = 0.55 * spec.scale;

  let built;
  if (typeKey === 'spider') {
    built = makeSpider(tintHex, scale);
  } else if (typeKey === 'pumpkin') {
    built = makePumpkin(tintHex, scale);
  } else if (typeKey === 'ghost') {
    built = makeGhost(tintHex, scale);
  } else {
    built = makeHumanoid(tintHex, scale);
  }

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
    // Ghost/pumpkin floats + bobs, not walks. Spider skitters.
    isFloater: typeKey === 'ghost',
    isExplosive: typeKey === 'pumpkin',
    isSpider: typeKey === 'spider',
    spiderLegs: built.spiderLegs || null,
    ghostTail: built.ghostTail || null,
    floatPhase: Math.random() * Math.PI * 2,
    isBoss: false,
  };
  enemies.push(enemy);
  return enemy;
}

// ============================================================================
// MAKE BOSS (reuses humanoid, larger)
// ============================================================================
export function makeBoss(bossKey, tintHex, pos) {
  const spec = BOSSES[bossKey] || BOSSES.MEGA_ZOMEEB;
  const scale = 0.55 * spec.scale;
  const { group, body, bodyMat, armL, armR, legL, legR } = makeHumanoid(tintHex, scale, 0.4);

  group.position.copy(pos);
  const bossLight = new THREE.PointLight(tintHex, 3, 18, 1.5);
  bossLight.position.y = 3;
  group.add(bossLight);

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

export function spawnEnemyProjectile(fromPos, toPos, speed, damage, color) {
  const geo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 2.5,
  });
  const proj = new THREE.Mesh(geo, mat);
  proj.position.set(fromPos.x, 1.4, fromPos.z);
  const dx = toPos.x - fromPos.x;
  const dz = toPos.z - fromPos.z;
  const d = Math.sqrt(dx * dx + dz * dz) || 1;
  proj.userData = {
    vel: new THREE.Vector3((dx / d) * speed, 0, (dz / d) * speed),
    life: 3,
    damage,
  };
  scene.add(proj);
  enemyProjectiles.push(proj);
  return proj;
}
