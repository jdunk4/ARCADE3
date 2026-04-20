# MEEBIT: SURVIVAL PROTOCOL

A voxel-style Three.js shooter featuring the Meebits NFT universe. This version adds four major systems on top of the original base game.

## New Features

### 1. Chapter-based Gradient Themes
Each **chapter** is 5 waves long. The arena's fog, grid, lamps, and enemy tint all start muted on wave 1 of a chapter and interpolate toward the chapter's full palette by wave 5. Seven chapters cycle: `TOXIC → ARCTIC → PARADISE → CEMETERY → INFERNO → SOLAR → MATRIX`, then start over with cumulative difficulty.

Inside every chapter the five waves have fixed flavors:
- **W1** — Rescue (free a caged Meebit)
- **W2** — Combat
- **W3** — Capture (weapon reward zone)
- **W4** — Mining (blocks fall, bullets blocked, pickaxe needed)
- **W5** — Boss

### 2. Rescuable Meebits
On wave 1 of every chapter a random Meebit (from the 20,000 collection) appears in a spinning cage with a light beam beacon. Walk up to the beam and stay close for **2 seconds** to free them. Freed Meebits follow you briefly then run to the edge of the arena. The portrait is pulled live from the Meebits API:
```
https://meebits.app/meebitimages/characterimage?index=<id>&type=portrait&imageType=png
```

Freed Meebits are saved to your permanent collection across runs.

### 3. Mineable Blocks + Pickaxe
On wave 4 of every chapter, cubes rain from the sky and lock in place as terrain. They block bullets (yours *and* enemy projectiles), and enemies path around them. Press **Q** to switch to the pickaxe and mine a block (takes ~3 swings) for bonus XP pickups and a 30% chance of a health pickup. Blocks are tinted to match the current chapter.

### 4. Persistent Save + Wallet Connect
Progress is saved to `localStorage` (`mbs_save_v1`):
- High score
- Furthest chapter/wave reached
- Lifetime collection of rescued Meebits (deduplicated IDs)
- Selected avatar ID

Click **CONNECT WALLET** on the title screen to connect via MetaMask (or any injected provider). If you own one or more Meebits on Ethereum mainnet (contract `0x7Bd29408f11D2bFC23c34f18275bBf23bB716Bc7`), the first one in your wallet becomes your in-game avatar ID. Ethers v6 is loaded from CDN on demand, so there's no wallet code in the critical path.

## Controls

| Input | Action |
|---|---|
| `WASD` / `Arrows` | Move |
| Mouse | Aim |
| Hold `LMB` | Fire / mine |
| `1` / `2` / `3` / `4` | Weapons |
| `Q` | Toggle pickaxe |
| `Space` | Dash |
| `Esc` | Pause |

Mobile has a virtual joystick, fire button, and a separate pickaxe toggle button.

## File Layout

```
meebit-shooter/
├── index.html
├── assets/
│   ├── phone_ring.mp3           (optional — drop your original here if you have it)
│   ├── meebit_fallback.png      (fallback portrait if Meebits API is unreachable)
│   └── 16801.png                (sprite sheet)
└── src/
    ├── main.js                  — main loop, input, camera, game lifecycle
    ├── config.js                — tunable constants: CHAPTERS, WEAPONS, waves
    ├── state.js                 — mutable game state
    ├── scene.js                 — THREE scene, theme interpolation
    ├── player.js                — voxel player avatar
    ├── enemies.js               — zomeebs, sprinters, brutes, bosses
    ├── effects.js               — bullets, pickups, particles, capture zone
    ├── blocks.js                — falling blocks, collision, mining  [NEW]
    ├── meebits.js               — rescue NPCs, portrait billboards  [NEW]
    ├── save.js                  — localStorage persistence           [NEW]
    ├── wallet.js                — ethers.js / Meebits NFT reader     [NEW]
    ├── waves.js                 — wave flow, chapter hooks
    ├── ui.js                    — HUD updates
    ├── audio.js                 — procedural WebAudio
    └── styles.css               — overlay, HUD, mobile
```

## Running

Serve the directory with any static HTTP server — not `file://` (ES modules and the Meebits API CORS both require http/https):

```bash
cd meebit-shooter
python3 -m http.server 8080
# → http://localhost:8080
```

Or `npx serve`, `caddy file-server`, etc. Wallet connect only works on a real page, not a file URL.

## Dependencies

All loaded from CDN via the import map in `index.html`:
- `three@0.160.0` — voxel rendering
- `ethers@6.13.2` — wallet read (dynamically imported the first time you click Connect)

No build step, no bundler, no npm install.

## Tuning Notes

The theme-intensity curve is in `scene.js`:
```js
strengthForWave(localWave) // 0.22 → 0.40 → 0.58 → 0.76 → 1.0
```
If wave 1 of a chapter feels too muted, raise the `0.22` floor. If wave 5 feels too saturated, clip the ceiling below 1.0.

Block spawn pacing and count are in `config.js` under `getWaveDef('mining')`:
```js
blockFallRate: 2.2,  // seconds between drops
blockCount: 18 + chapterIdx * 2,
```

Rescue hold time is `MEEBIT_CONFIG.rescueHoldTime` (default 2s). Set it higher to make wave 1 harder with enemies swarming.

## Save Data

To wipe progress, open DevTools console and run:
```js
localStorage.removeItem('mbs_save_v1')
```
