# Meebit Shooter — Full Patch Bundle

Drop these files into your `Meebit-Shooter/` directory:

- `index.html` → project root (replaces existing)
- Everything in `src/` → `Meebit-Shooter/src/` (replaces existing)

15 files: 14 JS modules + `index.html`. No asset changes.
No new dependencies. No build step.

---

## Performance fixes

### Shared materials and geometries
Every bullet, rocket, pickup, particle, enemy projectile, goo splat,
capture zone, depot, mining block, ore, boss cube, hazard tile, and
rain drop is allocated from a module-level pool keyed by color. Each
unique material compiles its shader exactly once per session.

### Shader prewarm (`prewarm.js`)
Called once from `startGame`. Spawns an invisible instance of every
enemy, boss, weapon bullet, rocket, projectile type/color, pickup type,
mining block, ore, boss cube, goo splat, capture zone, depot, hazard
tile, and simulates a hit-flash on every enemy body material. Then
calls `renderer.compile(scene, camera)` to compile every shader
permutation the game can produce. Decoys are torn down before the
first frame of gameplay. One-time ~100ms pause during the title →
game transition.

Kills: red-chapter-first-hit stall, wave-4 civilian-load stall,
green-chapter first-goo stall, wave-3 capture-zone stall, boss-cube
first-drop stall.

### Pooled rain
1800 drops allocated once. Wave transitions toggle `.visible` and
mutate one shared material's color/opacity — no meshes created or
destroyed during gameplay.

### Staggered civilian spawns
Civilian VRM fetches spread 100ms apart so 8 materials don't all
compile in the same frame.

---

## Gameplay changes

### Wave structure
- **Wave 1** → mining (was civilian_rescue)
- **Wave 2** → hive
- **Wave 3** → capture
- **Wave 4** → civilian_rescue (was mining)
- **Wave 5** → boss

### Civilians
- Only spawn on wave 4.
- Four rescue zones at random positions per wave.
- Rescue target: 4 civilians.
- Permanent corner rings/poles/flags removed.

### Mining blocks
- HP: 25 (25 shots or 2 pickaxe swings)
- **Grow** with damage (1.0 → 1.55 scale)
- **Blink** emissive when HP below 20%
- **Explode** on destruction with 4.5-unit AoE
  - Enemies: 80 damage with falloff
  - Civilians: one-shot
  - Player: 18 damage with falloff, shield check, invuln

### Floor hazards (`hazards.js`)
Tetris shapes (`I O T L S`) on the floor, **solid themed color** per
chapter (orange/red/yellow/green/cyan/purple). No pulse, no overlay.
- Count: `localWave × 2` (2 → 10)
- Resets on chapter change
- 10 dps continuous player damage
- Non-boss enemies path around

### Health drops
4% → 14% on enemy kill.

### T-pose player
All animation branches skipped. GLB mode resets bones to rest every
frame. Invuln flicker preserved.

---

## Title screen

### Text
- `SURVIVAL PROTOCOL` → **`EXTINGUISH THE VIRUS`**
- `ENTER THE GRID` button → **`ATTACK THE AI`**

### Color
Title heading is **matrix green**. Game-over "SIGNAL LOST" keeps
neon pink.

### Audio flow
1. Matrix dive ends → C-drone keeps playing (ambient under title),
   no music.
2. Click **ATTACK THE AI** → C-drone stops, Arena I begins.

---

## Spectator crowd (`crowd.js`)

Floating lanterns in a **square formation** around the arena, 3 rows
deep per side. Each lantern is a boxy Meebit silhouette with an
**emissive material** retinted per chapter via instanceColor.

- Square perimeter, 3 rows around all 4 sides
- Floating at 2.2 units above ground
- Bob animation (1.4 Hz, ±0.35 units, per-instance seed)
- 4 chapter-tinted side point lights bleed glow onto the arena floor
- Per-lantern brightness jitter so it's not a solid neon wall
- 2 draw calls total regardless of count

Chapter change instantly retints every lantern + side lights — no
shader recompile, just an instanceColor flip.

---

## Files

| File | Status |
|------|--------|
| `index.html` | MOD — title text + button |
| `src/blocks.js` | MOD — 25hp, grow, blink, explode |
| `src/civilians.js` | MOD — random zones, staggered spawns |
| `src/config.js` | MOD — wave swap, block tuning |
| `src/crowd.js` | **NEW** — floating lantern crowd |
| `src/effects.js` | MOD — shared materials, pooled rain |
| `src/enemies.js` | MOD — cached projectile resources |
| `src/hazards.js` | **NEW** — themed lava tiles |
| `src/main.js` | MOD — prewarm, hooks, audio flow |
| `src/ores.js` | MOD — cached depot materials |
| `src/player.js` | MOD — T-pose |
| `src/prewarm.js` | **NEW** — shader compile pass |
| `src/scene.js` | MOD — removed fixed corners |
| `src/styles.css` | MOD — `#title h1` matrix green |
| `src/waves.js` | MOD — hazard + crowd wiring |

---

## Verification

1. Matrix dive ends → title shows matrix-green **EXTINGUISH THE
   VIRUS** with C-drone humming and no music.
2. Click **ATTACK THE AI** → brief prewarm pause, Arena I begins.
3. Look outside the arena → square of floating chapter-colored
   lanterns bobbing.
4. Progress to chapter 2 → lanterns retint red instantly.
5. Red chapter wave 1 — no stall on bullet hits.
6. Wave 4 — civilians fade in over ~800ms, no freeze.
7. Mining — 25 shots, block grows/blinks/explodes.
8. Floor tiles are solid colored tetris shapes matching chapter.
9. Player stands in T-pose.
10. Health drops feel common.
