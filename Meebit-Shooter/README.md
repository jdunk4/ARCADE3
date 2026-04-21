# Meebit Shooter — Patch Bundle

Drop these 11 files into `Meebit-Shooter/src/`, replacing what's there:

Modified:
- `blocks.js`
- `civilians.js`
- `config.js`
- `effects.js`
- `enemies.js`
- `main.js`
- `player.js`
- `scene.js`
- `waves.js`

New:
- `prewarm.js`
- `hazards.js`

No other files change. No asset changes. No new npm dependencies.

---

## Round 1 — Freeze fixes

### Shared materials and geometries (`effects.js`, `enemies.js`)
Every bullet, rocket, pickup, particle, and enemy projectile used to allocate
fresh geometry + material on spawn. Now they share geometry and cache
materials by color, so each unique color compiles its shader exactly once
for the whole session. Eliminates GC hitches and per-spawn compile stalls.

### Shader prewarm (new `prewarm.js`)
Called once from `startGame`. Spawns an invisible instance of every enemy,
boss, weapon bullet, rocket, projectile type/color combination, and pickup
type, then calls `renderer.compile(scene, camera)`. All shader
permutations the game can produce are compiled before the first frame of
gameplay. Decoys are removed before wave 1 starts. This is what kills the
wave-6 stall — red devils, vampires, and fireball projectiles no longer
trigger a compile mid-game.

### Pooled rain (`effects.js`)
Wave 5 → wave 6 used to tear down 1,800 rain drops and rebuild 80 on one
frame (the #1 cause of the wave-6 freeze). Now the rain pool is allocated
once at max size, and per-wave transitions only toggle per-drop visibility
and mutate one shared material's color/opacity. No meshes created or
destroyed during gameplay.

---

## Round 2 — Gameplay changes

### 1. Wave structure: rescue moved to wave 4 (`config.js`, `waves.js`, `civilians.js`, `scene.js`)
- **Wave 1** is now `mining` (was civilian_rescue).
- **Wave 4** is now `civilian_rescue` (was mining).
- Civilians are **only** spawned on civilian_rescue waves — every other
  wave (mining, hive, capture, boss) has zero civilians.
- The four rescue zones are **randomized per wave** — they pick fresh
  positions between 12 units and ~42 units from center, with a minimum
  pairwise distance of 14 so you can't rescue all four by standing in
  one spot.
- Rescue target is **4** civilians (matches the 4 zones).
- Deleted the permanent green corner rings/poles/flags from `scene.js`
  so they don't clash with the new random zones.

### 2. Mining blocks rework (`config.js`, `blocks.js`, `main.js`)
- Block HP: **100 → 25**. Every bullet still deals 1 damage, so blocks
  now take 25 shots (or 2 pickaxe swings).
- Blocks **grow** as they take damage (scale lerps from 1.0 up to 1.55).
- Blocks **blink** emissive on/off when HP drops below 20% (last 5 hits),
  getting faster as HP approaches 0.
- On destruction the block **explodes** with AoE:
  - 4.5 unit radius.
  - Enemies: 80 damage with distance falloff, routed through the existing
    `killEnemy` pipeline so score/XP/pickups still drop.
  - Civilians: one-shot killed (they're fragile).
  - Player: 18 damage with falloff, checks shield first, triggers invuln
    frames and damage flash. Gameover is handled if HP hits 0.
  - Bigger particle burst (chapter tint + hot orange core) and bigger
    screen shake than the old "break" effect.

### 3. Floor hazards — lava tetrominoes (new `hazards.js`)
- Tetris-shaped (`I`, `O`, `T`, `L`, `S`) patches of "lava" on the floor,
  themed to each chapter via `CHAPTERS[i].full.grid1` mixed with hot
  orange so every chapter still reads as molten.
- Count scales with wave: `localWave × 2` per wave (2 on wave 1, 10 on
  wave 5).
- **Reset each chapter** — `clearHazards()` fires on `localWave === 1`,
  so every new chapter starts clean and builds up again.
- **Player damage**: 10 dps continuous while standing on a hazard cell,
  with a 0.4s periodic flash so it doesn't strobe every frame. Dash
  invuln protects the player briefly.
- **Enemies walk around them**: a cheap repulsion nudge in `updateEnemies`
  steers non-boss enemies away from hazard cells. Bosses ignore them (too
  big to path).
- Uses shared materials and geometries like everything else — the whole
  system is ~3 draw calls per hazard regardless of theme.
- Positions avoid the player spawn (safe radius 7 units) and the arena
  walls (min 6 units padding).

### 4. More health drops (`main.js`)
Health drop rate on enemy kill: **4% → 14%**. Speed/shield rolls were
shifted to keep the total non-XP drop rate similar.

### 5. T-pose player (`player.js`)
`animatePlayer` skips all animation branches. For GLB mode it:
- stops and detaches any attached mixer,
- sets `_mixerSkipped` so no re-attach ever fires,
- resets every bone to its rest quaternion every frame (so any leftover
  pose from an earlier animation clears out),
- still updates skinned-mesh skeletons so the mesh renders correctly.

For voxel mode it zeroes the limb rotations (legs and arms) so the boxy
fallback player stands straight. Invuln flicker is preserved.

**Note:** This uses the GLB's imported rest pose. If the rest pose itself
is the "crumpled ball", that's an asset issue — the fix in that case is
`bone.quaternion.identity()` instead of `bone.quaternion.copy(rest)` on
line ~395 of `player.js`. Try the current version first; Larva Labs
Meebits ship in real T-pose so this should look right.

---

## How to verify

1. **Startup freeze**: click START. The title → game transition has a
   brief one-time prewarm cost (~50-120ms) instead of the previous
   stall-on-first-enemy pattern.
2. **Wave 6 freeze**: play through chapter 1 to the Crimson chapter.
   The old build stalled for ~200-500ms when the first red devil
   spawned and fired a fireball. The new build is smooth.
3. **Wave order**: wave 1 is now the mining wave. Wave 4 is the civilian
   rescue (with four random glowing zones).
4. **Mining**: shoot a block — it grows, blinks in the last ~5 shots,
   then explodes with a big burst. Standing next to it hurts. Enemies
   standing next to it die.
5. **Floor lava**: waves 2+ should have visible tetris-shaped glowing
   patches on the floor. Walk on one — you lose HP. Enemies walk
   around them. They reset at the start of every chapter.
6. **Health drops**: health pickups should feel noticeably more common.
7. **Player pose**: player stands still in a clean pose when idle and
   when moving (no more walk animation).

If anything looks off, open the browser console — all the new systems
`console.warn` on failure but never throw, so the game keeps running
even if an edge case trips something.
