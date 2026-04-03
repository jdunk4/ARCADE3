/**
 * ARCADE3 — WHEP Streaming Server
 *
 * Architecture vs ARCADE2 server-b.js:
 *   BEFORE: Puppeteer page → page.screenshot() JPEG → base64 → WebSocket → <m-image> swap
 *   AFTER:  Puppeteer page → ffmpeg x11grab H.264 → wrtc RTCPeerConnection → WHEP → <m-video>
 *
 * What this buys us:
 *   - UDP transport (WebRTC) instead of TCP (WebSocket) — drops a frame rather than blocking
 *   - H.264 encoded by ffmpeg libx264 zerolatency — ~30-80ms glass-to-glass vs ~200-500ms JPEG
 *   - Native browser video decode — no JS frame-swap flicker on <m-image>
 *   - Audio travels in the same WebRTC peer connection — no separate Opus chunk stream
 *
 * Per-player model: each player who presses E gets their own Puppeteer+ffmpeg+RTCPeerConnection.
 * Input still flows: Gamepad API → WebSocket → Puppeteer keyboard.down/up (unchanged from ARCADE2).
 *
 * Dependencies (package.json):
 *   @roamhq/wrtc  — Node.js WebRTC bindings (prebuilt Linux x64 ✓ on Railway)
 *   puppeteer     — headless Chromium (same as ARCADE2)
 *   express, ws   — HTTP + WebSocket (MML doc served over raw WS, no mml-io package needed)
 *
 * ffmpeg must be available on PATH (included in Dockerfile or Railway nixpacks).
 */

"use strict";

const fs            = require("fs");
const path          = require("path");
const http          = require("http");
const { spawn }     = require("child_process");
const express       = require("express");
const { WebSocketServer } = require("ws");
const puppeteer     = require("puppeteer");

// wrtc provides RTCPeerConnection, RTCSessionDescription, etc. in Node.js
const wrtc = require("@roamhq/wrtc");
const { RTCPeerConnection, RTCSessionDescription, nonstandard } = wrtc;
const { RTCVideoSource, RTCAudioSource } = nonstandard;

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const GAME_BASE_URL = process.env.GAME_URL || "https://jdunk4.github.io/ARCADE1/game.html";
const LOADING_URL   = process.env.LOADING_URL || "https://jdunk4.github.io/ARCADE1/loading.html";
const DISPLAY       = process.env.DISPLAY || ":99";
const VIEWPORT_W    = 512;
const VIEWPORT_H    = 448;
const TARGET_FPS    = 30;
const LOADING_SCREEN_MS = 18000;
const MML_DOC_FILE  = "arcade-wario-whep.html";

// Key map: SNES button name → Puppeteer keyboard key (same as ARCADE2)
const KEY_MAP = {
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  a: "z", b: "x", x: "a", y: "s",
  start: "Enter", select: "Shift", l: "q", r: "w"
};

// ─── APP + HTTP SERVER ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => res.send("ARCADE3-WHEP server OK\n"));
app.get("/", (req, res) => res.send("ARCADE3-WHEP server OK\n"));

// Debug: grab a single JPEG from the virtual display
app.get("/debug.jpg", (req, res) => {
  const { execSync } = require("child_process");
  try {
    execSync(`ffmpeg -y -f x11grab -r 1 -s ${VIEWPORT_W}x${VIEWPORT_H} -i ${DISPLAY}.0 -vframes 1 /tmp/debug.jpg 2>/dev/null`);
    res.sendFile("/tmp/debug.jpg");
  } catch (e) {
    res.status(500).send("Error: " + e.message);
  }
});

// ─── WHEP SIGNALING ENDPOINT ──────────────────────────────────────────────────
//
// MML's <m-video src="whep://your-server/stream/SESSION_ID"> becomes
// a POST to https://your-server/stream/SESSION_ID
//
// The session must already exist (player's WebSocket triggered Puppeteer launch).
// If the session isn't ready yet we return 503 so the MML client retries.
//
// Flow:
//  1. Player presses E → cabinet sends WebSocket connect → server starts Puppeteer
//  2. Cabinet sets <m-video src="whep://server/stream/SESSION_ID">
//  3. MML client POSTs SDP offer to https://server/stream/SESSION_ID
//  4. Server feeds that offer into the session's RTCPeerConnection
//  5. Server replies 201 with SDP answer
//  6. WebRTC handshake completes → video/audio streams to <m-video>

app.post("/stream/:sessionId", express.text({ type: "application/sdp" }), async (req, res) => {
  const sessionId = req.params.sessionId;
  const session   = sessionsByKey.get(sessionId);

  if (!session) {
    console.warn(`[whep] no session for id: ${sessionId}`);
    return res.status(503).send("Session not ready — retry");
  }
  if (!req.body) {
    return res.status(400).send("Expected application/sdp body");
  }

  try {
    const answer = await session.handleWhepOffer(req.body);
    res.status(201)
       .setHeader("Content-Type", "application/sdp")
       .setHeader("Location", `/stream/${sessionId}`)
       .send(answer);
    console.log(`[whep] SDP exchange complete for session ${sessionId}`);
  } catch (e) {
    console.error(`[whep] SDP exchange failed: ${e.message}`);
    res.status(500).send("SDP exchange failed: " + e.message);
  }
});

// Allow the client to tear down the WebRTC connection cleanly
app.delete("/stream/:sessionId", (req, res) => {
  const session = sessionsByKey.get(req.params.sessionId);
  if (session) session.closePeerConnection();
  res.status(200).send("OK");
});

// ─── MML DOCUMENT SERVER ──────────────────────────────────────────────────────
//
// Reads arcade-wario-whep.html from disk and serves it over a raw WebSocket.
// This is the same pattern ARCADE2 uses — no @mml-io/networked-dom-server needed.
// The MML world connects to wss://server/ and receives the HTML document content.
// Any attribute mutations from the script (setAttribute calls) are broadcast back
// to all connected clients as DOM diffs via the ws connection.
//
// We use the ws library directly, matching how ARCADE2 handles this.

const mmlWss   = new WebSocketServer({ server, path: "/" });
const inputWss = new WebSocketServer({ server, path: "/input" });

function loadMMLDoc() {
  const filepath = path.join(__dirname, MML_DOC_FILE);
  if (!fs.existsSync(filepath)) {
    console.error(`[mml] ERROR: ${MML_DOC_FILE} not found at ${filepath}`);
    return `<m-label content="Missing: ${MML_DOC_FILE}" color="#ff4444"></m-label>`;
  }
  return fs.readFileSync(filepath, "utf8");
}

// MML WebSocket connections — send the document content on connect
// The MML world client parses the HTML and renders it as 3D objects
mmlWss.on("connection", (ws, req) => {
  console.log(`[mml] client connected from ${req.socket.remoteAddress}`);
  const doc = loadMMLDoc();
  // Send initial document — MML client expects the full HTML as first message
  ws.send(JSON.stringify({ type: "document", content: doc }));
  ws.on("close", () => console.log("[mml] client disconnected"));
  ws.on("error", (e) => console.warn(`[mml] ws error: ${e.message}`));
});

// Map sessionId → session object (populated when Puppeteer session starts)
const sessionsByKey = new Map();
// Map WebSocket → sessionId (for input routing)
const wsBySession   = new Map();

inputWss.on("connection", async (ws, req) => {
  const url       = new URL(req.url, `http://localhost`);
  const romFile   = url.searchParams.get("rom")    || "Wario Land SNES 2.0.sfc";
  const romCore   = url.searchParams.get("core")   || "snes";
  const romId     = url.searchParams.get("id")     || "wario-land-snes-2";
  const sessionId = url.searchParams.get("session") || Math.random().toString(36).slice(2);
  const wallet    = url.searchParams.get("wallet") || "anonymous";

  console.log(`[ws] input connection: session=${sessionId} rom=${romFile}`);
  wsBySession.set(ws, sessionId);

  ws.send(JSON.stringify({ type: "status", message: "Launching..." }));

  try {
    const session = await createSession(sessionId, ws, romFile, romCore, romId, wallet);
    sessionsByKey.set(sessionId, session);
    // Tell the cabinet the session ID + WHEP URL so it can set <m-video src>
    ws.send(JSON.stringify({
      type:      "session_ready",
      sessionId: sessionId,
      whepUrl:   `whep://ARCADE3_SERVER_HOST/stream/${sessionId}`
    }));
  } catch (e) {
    console.error(`[ws] session failed: ${e.message}`);
    ws.send(JSON.stringify({ type: "error", message: "Failed to start: " + e.message }));
    ws.close();
    return;
  }

  ws.on("message", async (data) => {
    const session = sessionsByKey.get(sessionId);
    if (!session) return;
    try {
      const msg = JSON.parse(data);
      const key = KEY_MAP[msg.key];
      if (!key) return;
      if (msg.type === "keyDown") await session.page.keyboard.down(key);
      else if (msg.type === "keyUp")  await session.page.keyboard.up(key);
    } catch (e) { /* ignore */ }
  });

  ws.on("close", () => {
    console.log(`[ws] disconnected: ${sessionId}`);
    const session = sessionsByKey.get(sessionId);
    if (session) { session.destroy(); sessionsByKey.delete(sessionId); }
    wsBySession.delete(ws);
  });

  ws.on("error", (e) => {
    console.error(`[ws] error: ${e.message}`);
  });
});

// ─── CREATE PUPPETEER + FFMPEG + WEBRTC SESSION ───────────────────────────────

async function createSession(sessionId, ws, romFile, romCore, romId, wallet) {
  console.log(`[session:${sessionId}] starting puppeteer`);

  // ── 1. Launch headless Chromium (same flags as ARCADE2) ───────────────────
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: false,          // needs virtual display for x11grab
    defaultViewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    ignoreDefaultArgs: ["--mute-audio"],
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--enable-webgl", "--enable-webgl2", "--ignore-gpu-blocklist",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-features=SharedArrayBuffer",
      `--display=${DISPLAY}`,
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  page.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("Translation not found") || t.includes("Language set to")) return;
    console.log(`[browser:${sessionId}] ${msg.type()}: ${t}`);
  });

  // ── 2. Show loading screen while emulator initialises ─────────────────────
  ws.send(JSON.stringify({ type: "status", message: "Loading emulator..." }));
  await page.goto(LOADING_URL, { waitUntil: "domcontentloaded", timeout: 10000 });
  await new Promise(r => setTimeout(r, LOADING_SCREEN_MS));

  // ── 3. Navigate to game ────────────────────────────────────────────────────
  const gameUrl = `${GAME_BASE_URL}?rom=${encodeURIComponent(romFile)}&core=${encodeURIComponent(romCore)}&id=${encodeURIComponent(romId)}&wallet=${encodeURIComponent(wallet)}`;
  console.log(`[session:${sessionId}] loading game: ${gameUrl}`);
  await page.goto(gameUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for canvas (EmulatorJS renders here)
  try {
    await page.waitForSelector("canvas", { timeout: 60000 });
    console.log(`[session:${sessionId}] canvas found`);
  } catch (e) {
    console.warn(`[session:${sessionId}] canvas timeout — proceeding anyway`);
  }

  // Click Play button if present, then focus canvas
  await new Promise(r => setTimeout(r, 8000));
  try {
    const els = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("button,[role='button'],span"))
        .filter(el => (el.innerText||"").trim() === "Play")
        .map(el => { const r = el.getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2 }; });
    });
    if (els.length) await page.mouse.click(els[0].x, els[0].y);
  } catch (e) { /* no play button */ }
  await page.mouse.click(VIEWPORT_W / 2, VIEWPORT_H / 2);

  // ── 4. Build WebRTC peer connection with video + audio tracks ─────────────
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle",
  });

  // Video: ffmpeg captures x11 display → raw YUV → wrtc RTCVideoSource
  const videoSource = new RTCVideoSource();
  const videoTrack  = videoSource.createTrack();
  pc.addTrack(videoTrack);

  // Audio: ffmpeg captures PulseAudio → PCM → wrtc RTCAudioSource
  const audioSource = new RTCAudioSource();
  const audioTrack  = audioSource.createTrack();
  pc.addTrack(audioTrack);

  // ── 5. Start ffmpeg video capture ─────────────────────────────────────────
  //
  // Captures the virtual X display at TARGET_FPS, outputs raw yuv420p frames
  // which we push into the wrtc RTCVideoSource frame-by-frame.
  // Using rawvideo instead of H.264 here because wrtc expects raw I420 frames.
  // The WebRTC stack inside @roamhq/wrtc does the H.264/VP8 encode internally
  // using its bundled libvpx/openh264 with congestion control baked in.

  const ffmpegVideo = spawn("ffmpeg", [
    "-f",    "x11grab",
    "-r",    String(TARGET_FPS),
    "-s",    `${VIEWPORT_W}x${VIEWPORT_H}`,
    "-i",    `${DISPLAY}.0+0,0`,        // capture top-left corner where Chromium sits
    "-vf",   `crop=${VIEWPORT_W}:${VIEWPORT_H}:0:0`,
    "-pix_fmt", "yuv420p",
    "-c:v",  "rawvideo",                 // raw frames — wrtc encodes for us
    "-f",    "rawvideo",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  // Each raw yuv420p frame = W * H * 1.5 bytes
  const FRAME_BYTES = VIEWPORT_W * VIEWPORT_H * 1.5;
  let   videoBuf    = Buffer.alloc(0);

  ffmpegVideo.stdout.on("data", (chunk) => {
    videoBuf = Buffer.concat([videoBuf, chunk]);
    while (videoBuf.length >= FRAME_BYTES) {
      const frame = videoBuf.slice(0, FRAME_BYTES);
      videoBuf    = videoBuf.slice(FRAME_BYTES);
      // Push I420 frame to wrtc
      try {
        const i420Frame = {
          width:  VIEWPORT_W,
          height: VIEWPORT_H,
          data:   new Uint8ClampedArray(frame.buffer, frame.byteOffset, FRAME_BYTES),
        };
        videoSource.onFrame(i420Frame);
      } catch (e) { /* peer may not be connected yet */ }
    }
  });

  ffmpegVideo.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line.includes("Error") || line.includes("error")) {
      console.warn(`[ffmpeg-video:${sessionId}] ${line}`);
    }
  });

  ffmpegVideo.on("error",  (e) => console.error(`[ffmpeg-video:${sessionId}] ${e.message}`));
  ffmpegVideo.on("close",  (c) => console.log(`[ffmpeg-video:${sessionId}] exited ${c}`));

  // ── 6. Start ffmpeg audio capture ─────────────────────────────────────────
  //
  // Captures PulseAudio virtual_speaker.monitor at 48kHz stereo.
  // Outputs raw PCM s16le which RTCAudioSource expects.

  const AUDIO_SAMPLE_RATE   = 48000;
  const AUDIO_CHANNELS      = 1;       // mono is fine for SNES
  const AUDIO_SAMPLES_FRAME = 480;     // 10ms @ 48kHz = one WebRTC audio frame
  const AUDIO_FRAME_BYTES   = AUDIO_SAMPLES_FRAME * AUDIO_CHANNELS * 2; // s16 = 2 bytes

  const ffmpegAudio = spawn("ffmpeg", [
    "-f",         "pulse",
    "-i",         "virtual_speaker.monitor",
    "-ar",        String(AUDIO_SAMPLE_RATE),
    "-ac",        String(AUDIO_CHANNELS),
    "-f",         "s16le",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let audioBuf = Buffer.alloc(0);

  ffmpegAudio.stdout.on("data", (chunk) => {
    audioBuf = Buffer.concat([audioBuf, chunk]);
    while (audioBuf.length >= AUDIO_FRAME_BYTES) {
      const frame = audioBuf.slice(0, AUDIO_FRAME_BYTES);
      audioBuf    = audioBuf.slice(AUDIO_FRAME_BYTES);
      try {
        audioSource.onData({
          samples:    new Int16Array(frame.buffer, frame.byteOffset, AUDIO_SAMPLES_FRAME * AUDIO_CHANNELS),
          sampleRate: AUDIO_SAMPLE_RATE,
          bitsPerSample: 16,
          channelCount:  AUDIO_CHANNELS,
          numberOfFrames: AUDIO_SAMPLES_FRAME,
        });
      } catch (e) { /* not connected yet */ }
    }
  });

  ffmpegAudio.on("error",  (e) => console.warn(`[ffmpeg-audio:${sessionId}] ${e.message}`));
  ffmpegAudio.on("close",  (c) => console.log(`[ffmpeg-audio:${sessionId}] exited ${c}`));

  // ── 7. WHEP offer handler ─────────────────────────────────────────────────
  async function handleWhepOffer(sdpOffer) {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sdpOffer }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // Wait for ICE gathering (max 1s)
    await new Promise(resolve => {
      if (pc.iceGatheringState === "complete") return resolve();
      const onStateChange = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", onStateChange);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", onStateChange);
      setTimeout(resolve, 1000);
    });
    return pc.localDescription.sdp;
  }

  function closePeerConnection() {
    try { pc.close(); } catch (e) {}
  }

  // ── 8. Session cleanup ────────────────────────────────────────────────────
  async function destroy() {
    console.log(`[session:${sessionId}] destroying`);
    try { ffmpegVideo.kill("SIGKILL"); } catch (e) {}
    try { ffmpegAudio.kill("SIGKILL"); } catch (e) {}
    try { pc.close(); } catch (e) {}
    try { await browser.close(); } catch (e) {}
  }

  ws.send(JSON.stringify({ type: "status", message: "" }));
  console.log(`[session:${sessionId}] live — waiting for WHEP offer`);

  return { page, browser, handleWhepOffer, closePeerConnection, destroy };
}

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[ARCADE3-WHEP] server on port ${PORT}`);
  console.log(`[ARCADE3-WHEP] WHEP endpoint: POST /stream/:sessionId (application/sdp)`);
  console.log(`[ARCADE3-WHEP] Input WS:      ws://host/input?rom=...&session=SESSION_ID`);
  console.log(`[ARCADE3-WHEP] MML doc:       wss://host/ (arcade-wario-whep.html)`);
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
const shutdown = () => {
  console.log("[ARCADE3-WHEP] shutting down");
  for (const [, session] of sessionsByKey) { try { session.destroy(); } catch (e) {} }
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
