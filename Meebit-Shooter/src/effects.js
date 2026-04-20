import * as THREE from 'three';
import { scene } from './scene.js';

// ============================================================
//  BULLETS
// ============================================================
export const bullets = [];

const BULLET_GEO = new THREE.BoxGeometry(0.12, 0.12, 0.6);

export function spawnBullet(origin, facing, weapon) {
  const count = Math.max(1, weapon.bullets);
  for (let i = 0; i < count; i++) {
    const spread = weapon.spread;
    const angleOffset = count === 1
      ? (Math.random() - 0.5) * spread
      : (i / (count - 1) - 0.5) * spread * 2 + (Math.random() - 0.5) * spread * 0.3;
    const angle = facing + angleOffset;

    const mat = new THREE.MeshStandardMaterial({
      color: weapon.color,
      emissive: weapon.color,
      emissiveIntensity: 2.5,
    });
    const bullet = new THREE.Mesh(BULLET_GEO, mat);
    bullet.position.copy(origin);
    bullet.userData = {
      vel: new THREE.Vector3(Math.sin(angle) * weapon.speed, 0, Math.cos(angle) * weapon.speed),
      life: 1.5,
      damage: weapon.damage,
    };
    bullet.lookAt(
      origin.x + Math.sin(angle),
      origin.y,
      origin.z + Math.cos(angle)
    );
    scene.add(bullet);
    bullets.push(bullet);
  }
}

export function clearBullets() {
  for (const b of bullets) scene.remove(b);
  bullets.length = 0;
}

// ============================================================
//  PICKUPS (xp / health / speed / shield)
// ============================================================
export const pickups = [];

const PICKUP_GEO = new THREE.OctahedronGeometry(0.28, 0);

const PICKUP_COLORS = {
  xp: 0xffd93d,
  health: 0x00ff66,
  speed: 0x4ff7ff,
  shield: 0xe63aff,
};

export function makePickup(type, x, z) {
  const color = PICKUP_COLORS[type] || 0xffffff;
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 1.8, roughness: 0.3,
  });
  const mesh = new THREE.Mesh(PICKUP_GEO, mat);
  mesh.castShadow = true;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.55, 12),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;

  const obj = new THREE.Group();
  obj.position.set(x, 0, z);
  obj.add(mesh);
  obj.add(ring);
  mesh.position.y = 0.6;

  scene.add(obj);

  const p = {
    obj, mesh, ring, type,
    value: type === 'xp' ? 1 : 0,
    life: 12,
  };
  pickups.push(p);
  return p;
}

export function clearPickups() {
  for (const p of pickups) scene.remove(p.obj);
  pickups.length = 0;
}

// ============================================================
//  PARTICLES (hit bursts)
// ============================================================
const particles = [];

export function hitBurst(pos, color, count = 8) {
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), mat);
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
//  CAPTURE ZONE (capture-wave objective)
// ============================================================
export function makeCaptureZone(x, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Inner disc
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(2.8, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffd93d, transparent: true, opacity: 0.15, side: THREE.DoubleSide,
    })
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.04;
  group.add(inner);

  // Rotating outer ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.6, 3.0, 24, 1, 0, Math.PI * 1.5),
    new THREE.MeshBasicMaterial({
      color: 0xffd93d, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  group.add(ring);

  // Vertical beam
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 2.8, 20, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffd93d, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false,
    })
  );
  beam.position.y = 10;
  group.add(beam);

  // Point light
  const light = new THREE.PointLight(0xffd93d, 3, 16, 1.3);
  light.position.y = 3;
  group.add(light);

  scene.add(group);

  return { obj: group, pos: group.position, inner, ring, beam, light };
}

export function removeCaptureZone(zone) {
  if (zone && zone.obj) scene.remove(zone.obj);
}
