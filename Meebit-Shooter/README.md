# SIMVOID (Meebit Shooter)

A browser-based 3D wave-survival arena shooter starring Meebits voxel
avatars. Six themed chapters, layered objectives, and a tutorial,
endless, and armory layer on top of the main campaign. Built with
Three.js and vanilla ES modules — no framework, no build step beyond
Vite.

> The project folder is still named `Meebit-Shooter/` for repo history.
> The in-game title is **SIMVOID**.

---

## Quick start

```bash
cd Meebit-Shooter
npm install
npm run dev      # Vite dev server, opens at http://localhost:5173
```

Other scripts:

| Script             | What it does                          |
|--------------------|---------------------------------------|
| `npm run build`    | Production build into `dist/`         |
| `npm run preview`  | Serve the built bundle locally        |

`index.html` is the production entry. `index-dev.html` is a stripped
variant used while iterating on individual systems.

---

## Stack

- **Three.js 0.184.0** — rendering, scene graph, GLB/VRM loading
- **Vite 6** — dev server + bundler
- ES modules, no transpiler, no framework
- ~120 single-purpose files under `src/`

---

## Modes

Pick one from the title screen:

- **TUTORIAL** — guided walkthrough of movement, weapons, and wave types.
- **ATTACK THE AI** — main campaign: 6 chapters of escalating waves
  ending in a chapter boss.
- **ENDLESS GLYPHS** — procedural arena that keeps spawning until you
  die; tracks high score.
- **ARMORY** — weapon and loadout viewer.
- **CONNECT WALLET** — pulls owned Meebits via the Meebits API and
  unlocks them as playable avatars.

---

## Campaign structure

Six chapters, each with its own palette, enemy mix, music, and
signature boss:

| # | Chapter   | Theme color | Signature enemy | Bonus herd     |
|---|-----------|-------------|-----------------|----------------|
| 1 | INFERNO   | Orange      | Pumpkin         | Pigs           |
| 2 | CRIMSON   | Red         | Vampire / Devil | Elephants      |
| 3 | SOLAR     | Yellow      | Wizard          | Skeletons      |
| 4 | TOXIC     | Green       | Goospitter      | Robots         |
| 5 | ARCTIC    | Cyan        | Ghost           | Visitors (UFO) |
| 6 | PARADISE  | Purple      | (final)         | —              |

Each chapter runs five wave types in order:

1. **Mining** — destroy themed blocks for resources.
2. **Hive** — clear a swarm with hive lasers.
3. **Capture** — hold zones against enemy pressure.
4. **Civilian rescue** — escort civilians from random zones to safety.
5. **Boss** — chapter signature boss fight.

Wave 6 is a chapter-themed bonus herd round (e.g. PIGS in INFERNO).

---

## Project layout

```
Meebit-Shooter/
├── index.html            production entry
├── index-dev.html        dev-only entry
├── package.json          three + vite, npm scripts
├── vite.config.js
├── src/
│   ├── main.js           bootstrap, game loop, title flow
│   ├── config.js         arena size, chapter definitions
│   ├── state.js          shared mutable state
│   ├── scene.js          Three.js scene, lights, ground
│   ├── prewarm.js        one-time shader compile pass
│   ├── waves.js          wave director
│   ├── player.js / armory.js / pickups.js / powerups.js
│   ├── enemies.js + per-boss files (cockroachBoss.js, ...)
│   ├── hazards*.js       arena hazards (Tetris, Pong, Pacman, ...)
│   ├── crowd.js          spectator lantern crowd
│   ├── meebits*.js       Meebits API + wallet integration
│   ├── matrixRain*.js    title-screen rain effect
│   └── ...               ~120 modules total
├── assets/
│   ├── *.mp3             chapter music + ambience
│   ├── enemies/          enemy GLBs
│   ├── civilians/        civilian VRMs (per chapter herd)
│   ├── animations/       shared animation clips
│   ├── VO/               voice-over lines
│   └── 16801*            hero Meebit GLB/VRM/PNG
└── tools/
    └── make-herd-manifests.sh
```

---

## Performance notes

The game targets a steady 60fps in a single canvas with hundreds of
animated entities. Two techniques carry most of the weight:

- **Pooled materials and geometries.** Bullets, rockets, pickups,
  particles, projectiles, hazards, mining blocks, ores, capture zones,
  and rain drops all share module-level pools keyed by color. Each
  unique material compiles its shader exactly once per session.
- **Shader prewarm pass.** `prewarm.js` runs once during the title-to-
  game transition, instantiates one of every visual permutation
  (enemies, bosses, projectiles, pickups, hazards, hit-flashes), and
  calls `renderer.compile(scene, camera)` to force shader compilation
  before gameplay starts. Decoys are torn down before the first frame.
  This eliminates the first-hit / first-spawn stalls.

---

## Meebits integration

The shooter is built around [Meebits](https://meebits.app) voxel
avatars. `src/meebitsApi.js` and `src/meebitsPublicApi.js` fetch
images, sprite sheets, and VRM 3D models for player avatars and
civilian herds. `wallet.js` connects a wallet so a player can use
their owned Meebits in-game.

---

## Audio

Six chapter tracks plus ambience:

- `Arena I` through `Arena IV`, `AwakenArena`, `Beyond`, `XIAN`,
  `YOMI`, `ZION`, `TheOtherSide`, `Underworld`, `TeachingWar`
- `C-drone.mp3` — title-screen ambience
- `phone_ring.mp3` / `PHONE RINGS.mp3` — incoming-call intro

Title flow: matrix dive ends, C-drone hums under the title screen with
no music. Selecting a mode stops the drone and starts the chapter
track.

---

## Adding content

- **A new civilian herd**: drop VRMs into `assets/civilians/<id>/`
  and run `tools/make-herd-manifests.sh` to regenerate the manifest,
  then add an entry to the relevant chapter's `bonusHerd` in
  `src/config.js`.
- **A new chapter palette**: extend the `CHAPTERS` array in
  `src/config.js` (fog, ground, grid, hemi, lamp, sky, enemyTint,
  orb), pick a `signatureEnemy`, and define a `bonusHerd`.
- **A new hazard set**: add a `src/hazardsXxx.js` module exposing
  `init()`, `update(dt)`, and `clear()`, then wire it into
  `src/waves.js`.

---

## License

Private. Game assets including Meebits artwork and audio belong to
their respective rights holders.
