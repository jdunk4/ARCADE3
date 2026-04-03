# ARCADE3 — WHEP Streaming Cabinet

WebRTC/WHEP replaces the JPEG-over-WebSocket frame streaming from ARCADE2.

## What changed

| | ARCADE2 | ARCADE3-WHEP |
|---|---|---|
| Video path | `page.screenshot()` JPEG → base64 → WS → `<m-image>` swap | ffmpeg rawvideo → wrtc RTCVideoSource → WebRTC → `<m-video>` |
| Audio path | ffmpeg Opus chunks → base64 → WS → MediaSource JS buffer | ffmpeg PCM → RTCAudioSource → WebRTC (same peer connection) |
| Transport | TCP WebSocket | UDP WebRTC |
| Latency | ~200–500ms | ~30–80ms |
| Screen flicker | Yes (image element swap per frame) | No (native video texture) |
| Input path | WS → server → Puppeteer (unchanged) | Same |

## How it works

```
Player presses E
  → cabinet opens WebSocket to /input?rom=...&session=SESSION_ID
  → server spawns Puppeteer + ffmpeg video + ffmpeg audio
  → server replies { type: "session_ready", whepUrl: "whep://server/stream/SESSION_ID" }
  → cabinet sets <m-video src="whep://...">
  → MML client POSTs SDP offer to https://server/stream/SESSION_ID
  → server feeds offer into RTCPeerConnection, returns SDP answer (201)
  → WebRTC handshake completes over UDP
  → video+audio stream appears on cabinet screen in ~1-2s
  → gamepad inputs flow: Gamepad API → WS → Puppeteer keyboard (unchanged)
```

## Files

| File | Purpose |
|---|---|
| `server-whep.js` | Main server — Puppeteer + ffmpeg + wrtc + WHEP endpoint + MML doc server |
| `arcade-wario-whep.html` | MML cabinet — `<m-video>` instead of `<m-image>` swap |
| `Dockerfile` | Chromium + ffmpeg + PulseAudio + wrtc deps |
| `start.sh` | Boots Xvfb + PulseAudio + Node |
| `default.pa` | PulseAudio virtual sink config |
| `package.json` | Adds `@roamhq/wrtc` to deps |

## Deploy to Railway

1. Push these files to your Arcade3 repo
2. Railway detects `Dockerfile` → builds automatically
3. After deploy, copy your Railway domain (e.g. `arcade3-production.up.railway.app`)
4. In `arcade-wario-whep.html` update:
   ```js
   var SNES_SERVER_WS = "wss://arcade3-production.up.railway.app";
   ```
5. Commit and push — Railway redeploys

## WHEP URL format

MML uses `whep://` protocol which it converts to `https://` for the SDP POST:

```
<m-video src="whep://arcade3-production.up.railway.app/stream/SESSION_ID">
```

becomes:

```
POST https://arcade3-production.up.railway.app/stream/SESSION_ID
Content-Type: application/sdp
Body: [SDP offer]
```

Response: `201 Created` + SDP answer → WebRTC connected.

## wrtc on Railway

`@roamhq/wrtc` ships prebuilt binaries for Linux x64 — Railway's default environment.
No compilation needed. It just works with `npm install`.

## One session per player

Each player who presses E gets their own:
- Puppeteer browser instance
- ffmpeg video + audio capture process  
- RTCPeerConnection

This is the same model as ARCADE2. Railway's free tier handles ~2-3 concurrent sessions.
Upgrade to a paid Railway plan for more concurrent players.
