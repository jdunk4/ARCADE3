# 🕹️ ARCADE3 — Enhanced-Streaming MML Arcade Cabinet

A fully interactive arcade cabinet living inside a Metaverse world — **zero server-side emulation, zero streaming latency**.  
The emulator runs directly in the player's browser using EmulatorJS. No Railway emulator server required.

---

## 🎮 What's Different from ARCADE2?

| Feature | ARCADE2 | ARCADE3 |
|---|---|---|
| Emulator runs on | Railway Node.js server | Player's browser |
| Frames sent via | WebSocket (JPEG stream) | None — native render |
| Audio | Opus stream | Native browser audio |
| Latency | ~100–300ms | 0ms (local) |
| Railway cost | Emulator server (heavy) | Not needed |
| ROM served from | Railway `/rom/` endpoint | GitHub Pages (free) |
| Multiplayer screen | Shared (everyone sees same) | Per-player (independent) |
| Controller input | WebSocket → server emulator | postMessage → EmulatorJS |

---

## 🏗️ Architecture

```
MML World (Unreal / browser)
  └── arcade-wario.html  (MML document, served from Railway — lightweight WS doc server only)
        ├── <m-frame src="game.html">   ← EmulatorJS boots HERE in player's browser
        ├── Gamepad API polling         ← reads controller buttons
        ├── postMessage → game.html     ← sends key events to EmulatorJS
        └── /completions fetch          ← tracks completion count (optional, reuses ARCADE2 backend)

GitHub Pages (jdunk4.github.io/ARCADE3)
  ├── game.html           ← EmulatorJS page (no server needed)
  └── rom/
      └── Wario_Land_SNES_2_0.sfc   ← ROM served statically
```

---

## 📦 Stack

| Layer | Technology |
|---|---|
| Metaverse World | MML / Unreal Engine |
| MML Document Server | Node.js + Networked DOM (Railway — **document only, not emulator**) |
| Static File Hosting | GitHub Pages |
| SNES Emulator | EmulatorJS (CDN) — runs in player's browser |
| ROM Storage | GitHub Pages `/rom/` folder |
| Completions Backend | Shared with ARCADE2 (`gamer-production.up.railway.app`) |

---

## 🗂️ Project Structure

```
ARCADE3/
├── arcade-wario.html     ← MML cabinet (load into Railway WS doc server)
├── game.html             ← EmulatorJS page (deploy to GitHub Pages)
├── rom/
│   └── Wario_Land_SNES_2_0.sfc   ← Upload ROM here (GitHub Pages)
├── SCREEN/
│   └── wario-land-preview.png    ← Cabinet preview image
├── INFOCARDs/
│   └── info-card-wario.png       ← Info card shown on approach
├── package.json
└── README.md
```

---

## 🚀 Getting Started

### 1. Create the GitHub repo
```bash
git clone https://github.com/jdunk4/ARCADE3.git
cd ARCADE3
```

### 2. Enable GitHub Pages
- Go to Settings → Pages → Source: `main` branch, `/ (root)`
- Your static site: `https://jdunk4.github.io/ARCADE3/`

### 3. Add the ROM
```
rom/Wario_Land_SNES_2_0.sfc   ← place your ROM here
```
Commit and push. GitHub Pages auto-deploys within ~2 minutes.

### 4. Deploy the MML document server

You only need a **lightweight** WS doc server — no emulator running on it.  
You can reuse ARCADE2's `server-b.js` pattern, or use a minimal server:

```bash
# package.json dependencies:
# @mml-io/networked-dom-server, express, ws

npm install
npm start
```

Railway auto-detects Node.js and runs `npm start`.  
Go to Settings → Networking → Generate Domain.

### 5. Place in your MML world
```html
<m-frame src="wss://your-arcade3-server.railway.app" width="4" height="4"></m-frame>
```

---

## 🎯 How the No-Streaming Approach Works

1. Player walks up to cabinet in the MML world
2. Player presses **E** to interact
3. MML script points `<m-frame>` at `game.html` on GitHub Pages
4. EmulatorJS loads the ROM directly from GitHub Pages **in the player's browser**
5. Gamepad API polls the connected controller
6. Button presses are sent via **postMessage** into the `<m-frame>`
7. `game.html` receives messages and fires synthetic keyboard events into EmulatorJS
8. Game runs at native speed with no network round-trips for frames

---

## 🕹️ Testing in MML.io Editor

You can test this immediately without any server:

1. Open [https://mml.io](https://mml.io) → New document
2. Paste the contents of `arcade-wario.html`
3. Press E near the cabinet
4. The game loads directly — no Railway connection needed for the emulator

> **Note:** The `<m-frame>` panel will show the EmulatorJS game floating in 3D space.  
> Controller postMessage works as long as the frame receives focus.

---

## 🔧 Adding More Games

Copy `arcade-wario.html`, change the top config block:

```javascript
var ROM_FILE    = "YourGame.sfc";
var ROM_CORE    = "snes";           // or "nes", "gba", etc.
var ROM_ID      = "your-game-id";
var ROM_TITLE   = "Your Game Title";
var ROM_PREVIEW = "https://jdunk4.github.io/ARCADE3/SCREEN/your-preview.png";
```

Upload the ROM to `rom/YourGame.sfc` on GitHub Pages and you're done.

---

## 🌐 Live URLs

| Resource | URL |
|---|---|
| GitHub Pages (game + ROM) | `https://jdunk4.github.io/ARCADE3/` |
| Direct game link | `https://jdunk4.github.io/ARCADE3/game.html?rom=Wario_Land_SNES_2_0.sfc&core=snes` |
| MML Document Server | `wss://your-arcade3-server.railway.app` |

---

## 📚 Resources

- [MML Documentation](https://mml.io/docs)
- [EmulatorJS](https://emulatorjs.org)
- [Networked DOM Server](https://github.com/mml-io/networked-dom)
- [Railway](https://railway.app)
- [GitHub Pages](https://pages.github.com)

---

## 📄 License

MIT — build cool stuff. 🕹️

Built with ❤️ — removing latency one frame at a time.
