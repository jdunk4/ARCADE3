import * as THREE from 'three';
import { scene } from './scene.js';
import { PLAYER, WEAPONS } from './config.js';
import { S } from './state.js';

// Voxel player avatar built from boxes. No external model load — we fake the
// load progress so the loading screen still shows its progress bar.

export const player = {
  obj: null,          // THREE.Group
  pos: new THREE.Vector3(0, 0, 0),
  vel: new THREE.Vector3(0, 0, 0),
  facing: 0,
  ready: false,
  // Parts
  body: null,
  head: null,
  legL: null, legR: null,
  armL: null, armR: null,
  gun: null,          // recolored per-weapon
  gunMat: null,
  muzzle: null,       // PointLight
};

const MEEBIT_PALETTE = {
  skin:   0xd9b08c,  // warm tan
  hat:    0x1a1a1a,  // black hat
  shirt:  0x2c2c2c,  // dark gray shirt
  pants:  0x1a1a24,  // dark pants
  boots:  0x0a0a0a,
  glasses:0xff3cac,  // neon pink visor
  skull:  0xffffff,  // chest emblem
  gun:    0x4ff7ff,  // neon cyan pistol
};

export function loadPlayer(onProgress, onDone, onError) {
  try {
    const root = new THREE.Group();
    root.position.copy(player.pos);

    // ---- HEAD (hat + face) ----
    const head = new THREE.Group();
    head.position.y = 2.7;
    // hat top
    const hat = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.55, 0.95),
      new THREE.MeshStandardMaterial({ color: MEEBIT_PALETTE.hat, roughness: 0.8 })
    );
    hat.position.y = 0.55;
    hat.castShadow = true;
    head.add(hat);
    // hat brim
    const brim = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 0.1, 1.15),
      new THREE.MeshStandardMaterial({ color: MEEBIT_PALETTE.hat, roughness: 0.7 })
    );
    brim.position.y = 0.28;
    head.add(brim);
    // face block (skin)
    const face = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.6, 0.85),
      new THREE.MeshStandardMaterial({ color: MEEBIT_PALETTE.skin, roughness: 0.9 })
    );
    face.position.y = -0.05;
    face.castShadow = true;
    head.add(face);
    // glasses/visor (neon pink bar)
    const glasses = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.12, 0.05),
      new THREE.MeshStandardMaterial({
        color: MEEBIT_PALETTE.glasses,
        emissive: MEEBIT_PALETTE.glasses,
        emissiveIntensity: 1.8,
      })
    );
    glasses.position.set(0, -0.02, 0.44);
    head.add(glasses);
    root.add(head);

    // ---- TORSO ----
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.05, 1.2, 0.7),
      new THREE.MeshStandardMaterial({ color: MEEBIT_PALETTE.shirt, roughness: 0.8 })
    );
    body.position.y = 1.75;
    body.castShadow = true;
    root.add(body);

    // skull emblem on chest
    const skull = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.05),
      new THREE.MeshStandardMaterial({
        color: MEEBIT_PALETTE.skull,
        emissive: 0x888888,
        emissiveIntensity: 0.4,
      })
    );
    skull.position.set(0, 1.75, 0.36);
    root.add(skull);

    // ---- ARMS ----
    const armGeo = new THREE.BoxGeometry(0.32, 1.0, 0.32);
    const armMat = new THREE.MeshStandardMaterial({ color: MEEBIT_PALETTE.shirt, roughness: 0.8 });
    const armL = new THREE.Group();
    const armLMesh = new THREE.Mesh(armGeo, armMat);
    armLMesh.position.y = -0.5;
    armLMesh.castShadow = true;
    armL.add(armLMesh);
    armL.position.set(-0.68, 2.3, 0);
    root.add(armL);

    const armR = new THREE.Group();
    const armRMesh = new THREE.Mesh(armGeo, armMat);
    armRMesh.position.y = -0.5;
    armRMesh.castShadow = true;
    armR.add(armRMesh);
    armR.position.set(0.68, 2.3, 0);
    root.add(armR);

    // ---- GUN (attached to right arm) ----
    const gunMat = new THREE.MeshStandardMaterial({
      color: MEEBIT_PALETTE.gun,
      emissive: MEEBIT_PALETTE.gun,
      emissiveIntensity: 0.9,
      metalness: 0.6,
      roughness: 0.3,
    });
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.6), gunMat);
    gun.position.set(0, -0.9, 0.2);
    gun.castShadow = true;
    armR.add(gun);
    // barrel tip (a small box sticking out)
    const barrelTip = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.2), gunMat);
    barrelTip.position.set(0, 0, 0.4);
    gun.add(barrelTip);

    // muzzle flash light
    const muzzle = new THREE.PointLight(0xffd93d, 0, 5, 2);
    muzzle.position.set(0, 0, 0.6);
    gun.add(muzzle);

    // ---- LEGS ----
    const legGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
    const legMat = new THREE.MeshStandardMaterial({ color: MEEBIT_PALETTE.pants, roughness: 0.85 });
    const legL = new THREE.Group();
    const legLMesh = new THREE.Mesh(legGeo, legMat);
    legLMesh.position.y = -0.5;
    legLMesh.castShadow = true;
    legL.add(legLMesh);
    // boot
    const bootL = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.25, 0.55),
      new THREE.MeshStandardMaterial({ color: MEEBIT_PALETTE.boots, roughness: 0.6 })
    );
    bootL.position.set(0, -1.05, 0.05);
    legL.add(bootL);
    legL.position.set(-0.28, 1.1, 0);
    root.add(legL);

    const legR = new THREE.Group();
    const legRMesh = new THREE.Mesh(legGeo, legMat);
    legRMesh.position.y = -0.5;
    legRMesh.castShadow = true;
    legR.add(legRMesh);
    const bootR = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.25, 0.55),
      new THREE.MeshStandardMaterial({ color: MEEBIT_PALETTE.boots, roughness: 0.6 })
    );
    bootR.position.set(0, -1.05, 0.05);
    legR.add(bootR);
    legR.position.set(0.28, 1.1, 0);
    root.add(legR);

    // Scale the whole avatar to match PLAYER.scale (baseline is ~3.4 world units tall -> normalize)
    // We want the player about 2 units tall on screen, so ~0.6 scale.
    root.scale.setScalar(0.55 * (PLAYER.scale / 1.8));

    scene.add(root);

    player.obj = root;
    player.head = head;
    player.body = body;
    player.legL = legL;
    player.legR = legR;
    player.armL = armL;
    player.armR = armR;
    player.gun = gun;
    player.gunMat = gunMat;
    player.muzzle = muzzle;
    player.ready = true;

    // Fake load progress for UI
    let pct = 0;
    const tick = setInterval(() => {
      pct += 15 + Math.random() * 15;
      if (pct >= 100) {
        pct = 100;
        clearInterval(tick);
        onProgress && onProgress({ loaded: 100, total: 100 });
        onDone && onDone();
      } else {
        onProgress && onProgress({ loaded: pct, total: 100 });
      }
    }, 80);
  } catch (err) {
    onError && onError(err);
  }
}

export function animatePlayer(dt, moving, timeElapsed) {
  if (!player.ready) return;
  if (moving) {
    player._walkPhase = (player._walkPhase || 0) + dt * 10;
    const sw = Math.sin(player._walkPhase) * 0.5;
    player.legL.rotation.x = sw;
    player.legR.rotation.x = -sw;
    player.armL.rotation.x = -sw * 0.5;
    // Right arm (gun) — keep mostly forward, small sway
    player.armR.rotation.x = sw * 0.2;
    // Body bob
    player.obj.position.y = player.pos.y + Math.abs(Math.sin(player._walkPhase)) * 0.08;
  } else {
    // idle breathing
    const t = timeElapsed * 2;
    player.legL.rotation.x *= 0.85;
    player.legR.rotation.x *= 0.85;
    player.armL.rotation.x *= 0.85;
    player.armR.rotation.x = Math.sin(t) * 0.03;
    player.obj.position.y = player.pos.y + Math.sin(t) * 0.03;
  }
  // Right arm always points forward-ish to aim the gun where the player faces
  player.armR.rotation.z = 0;

  // Invuln flicker
  if (S.invulnTimer > 0) {
    player.obj.visible = Math.floor(S.invulnTimer * 20) % 2 === 0;
  } else {
    player.obj.visible = true;
  }
}

export function recolorGun(hexColor) {
  if (!player.gunMat) return;
  player.gunMat.color.setHex(hexColor);
  player.gunMat.emissive.setHex(hexColor);
}

export function resetPlayer() {
  player.pos.set(0, 0, 0);
  player.vel.set(0, 0, 0);
  player.facing = 0;
  if (player.obj) player.obj.position.copy(player.pos);
  if (player.gunMat) {
    const c = WEAPONS[S.currentWeapon]?.color ?? 0x4ff7ff;
    player.gunMat.color.setHex(c);
    player.gunMat.emissive.setHex(c);
  }
}
