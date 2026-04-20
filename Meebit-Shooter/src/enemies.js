import * as THREE from 'three';
import { scene } from './scene.js';
import { ENEMY_TYPES, BOSSES } from './config.js';

export const enemies = [];
export const enemyProjectiles = [];

function makeVoxelBody(tintHex, scale, extraEmissive = 0) {
  const group = new THREE.Group();

  // Darken the tint for body/pants variants
  const tint = new THREE.Color(tintHex);
  const bodyColor = tint.clone().multiplyScalar(0.55);
  const headColor = tint.clone().multiplyScalar(0.75);
  const legColor = tint.clone().multiplyScalar(0.4);

  // Head
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.9, 0.9),
    new THREE.MeshStandardMaterial({
      color: headColor,
      emissive: tint,
      emissiveIntensity: 0.25 + extraEmissive,
      roughness: 0.85,
    })
  );
  head.position.y = 2.6;
  head.castShadow = true;
  group.add(head);

  // Visor — glowing strip
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.12, 0.06),
    new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 1.8 + extraEmissive * 2,
    })
  );
  visor.position.set(0, 2.6, 0.46);
  group.add(visor);

  // Body
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    emissive: tint,
    emissiveIntensity: extraEmissive,
    roughness: 0.9,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.3, 0.7), bodyMat);
  body.position.y = 1.55;
  body.castShadow = true;
  group.add(body);

  // Arms (pivoted at shoulder — parent is a group, mesh offset below)
  const armGeo = new THREE.BoxGeometry(0.3, 1.0, 0.3);
  const armMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.9 });
  const armL = new THREE.Group();
  const armLMesh = new THREE.Mesh(armGeo, armMat);
  armLMesh.position.y = -0.5;
  armLMesh.castShadow = true;
  armL.add(armLMesh);
  armL.position.set(-0.7, 2.1, 0);
  group.add(armL);

  const armR = new THREE.Group();
  const armRMesh = new THREE.Mesh(armGeo, armMat);
  armRMesh.position.y = -0.5;
  armRMesh.castShadow = true;
  armR.add(armRMesh);
  armR.position.set(0.7, 2.1, 0);
  group.add(armR);

  // Legs
  const legGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
  const legMat = new THREE.MeshStandardMaterial({ color: legColor, roughness: 0.95 });
  const legL = new THREE.Group();
  const legLMesh = new THREE.Mesh(legGeo, legMat);
  legLMesh.position.y = -0.5;
  legLMesh.castShadow = true;
  legL.add(legLMesh);
  legL.position.set(-0.28, 1.0, 0);
  group.add(legL);

  const legR = new THREE.Group();
  const legRMesh = new THREE.Mesh(legGeo, legMat);
  legRMesh.position.y = -0.5;
  legRMesh.castShadow = true;
  legR.add(legRMesh);
  legR.position.set(0.28, 1.0, 0);
  group.add(legR);

  group.scale.setScalar(scale);

  return { group, body, bodyMat, armL, armR, legL, legR, head, visor };
}

export function makeEnemy(typeKey, tintHex, pos) {
  const spec = ENEMY_TYPES[typeKey] || ENEMY_TYPES.zomeeb;
  const scale = 0.55 * spec.scale;
  const { group, body, bodyMat, armL, armR, legL, legR } = makeVoxelBody(tintHex, scale);

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
    isBoss: false,
  };
  enemies.push(enemy);
  return enemy;
}

export function makeBoss(bossKey, tintHex, pos) {
  const spec = BOSSES[bossKey] || BOSSES.MEGA_ZOMEEB;
  const scale = 0.55 * spec.scale;
  const { group, body, bodyMat, armL, armR, legL, legR } = makeVoxelBody(tintHex, scale, 0.4);

  group.position.copy(pos);

  // Add a menacing point light to the boss
  const bossLight = new THREE.PointLight(tintHex, 3, 18, 1.5);
  bossLight.position.y = 3;
  group.add(bossLight);

  // Crown-like topper
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
    hp: spec.hp,
    hpMax: spec.hp,
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
