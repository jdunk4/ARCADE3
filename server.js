/**
 * ARCADE3 — Lightweight MML Document Server
 *
 * This server does ONE thing only: serve arcade-wario.html (and any
 * other arcade-*.html files) as live MML WebSocket documents.
 *
 * There is NO emulator running here. No frame streaming. No audio piping.
 * The emulator (EmulatorJS) runs entirely in the player's browser via
 * the <m-frame> that points to GitHub Pages.
 *
 * Compared to ARCADE2's server-b.js this is ~85% smaller and uses
 * almost no CPU at runtime.
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");
const { NetworkedDomServer } = require("@mml-io/networked-dom-server");

const PORT = process.env.PORT || 3000;

// ─── HTTP server (health check for Railway) ───────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ARCADE3 MML doc server running\n");
    return;
  }
  res.writeHead(404);
  res.end("Not found\n");
});

// ─── Load MML documents from disk ─────────────────────────────────────────
function loadDoc(filename) {
  const filepath = path.join(__dirname, filename);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, "utf8");
}

// ─── Map URL paths to document files ─────────────────────────────────────
//   wss://your-server.railway.app/          → arcade-wario.html  (default)
//   wss://your-server.railway.app/wario     → arcade-wario.html
//   wss://your-server.railway.app/b         → arcade-b.html (if present)
const ROUTE_MAP = {
  "/":       "arcade-wario.html",
  "/wario":  "arcade-wario.html",
};

// ─── Start Networked DOM server ────────────────────────────────────────────
const networkedDomServer = new NetworkedDomServer({
  httpServer,
  getDocumentForPath: (urlPath) => {
    const filename = ROUTE_MAP[urlPath] || ROUTE_MAP["/"];
    const content  = loadDoc(filename);
    if (!content) {
      console.warn(`[ARCADE3] No document found for path: ${urlPath}`);
      return "<m-label content=\"Document not found\" color=\"#ff4444\"></m-label>";
    }
    console.log(`[ARCADE3] Serving ${filename} for path: ${urlPath}`);
    return content;
  },
});

httpServer.listen(PORT, () => {
  console.log(`[ARCADE3] MML doc server running on port ${PORT}`);
  console.log(`[ARCADE3] WebSocket: ws://localhost:${PORT}/`);
  console.log(`[ARCADE3] Health:    http://localhost:${PORT}/health`);
  console.log(`[ARCADE3] No emulator — EmulatorJS runs in player's browser`);
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("[ARCADE3] Shutting down…");
  httpServer.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("[ARCADE3] Shutting down…");
  httpServer.close(() => process.exit(0));
});
