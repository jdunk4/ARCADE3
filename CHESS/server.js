/**
 * server.js
 *
 * Runs the chess session.
 *
 *   - Holds the authoritative board state (chess.js)
 *   - Exposes wss://host/mml  -> the MML document rendered from board state
 *                                (this URL is what you paste into Otherside
 *                                 / MML editor / MML Viewer)
 *   - Exposes wss://host/play -> the browser UI <-> server channel for moves
 *   - Serves http://host/play -> the 2D chessboard web page
 *
 * Move flow:
 *   1. Browser user drags a piece -> sends { type: "move", from, to }
 *   2. Server validates with chess.js
 *   3. On success, server updates its internal piece list and the MML DOM.
 *      All connected MML clients (Otherside + MML editor preview) see the
 *      attribute changes applied to the <m-group> for that piece, and the
 *      new <m-attr-anim> child animates it sliding across the board.
 *   4. Server broadcasts the new FEN to all browser clients so they re-render.
 *
 * Author-note: We don't use @mml-io/networked-dom-server directly because we
 * want tight control over the DOM diff (for Unreal compatibility we rebuild
 * the scene from a template each move). Instead we implement a minimal
 * MML WebSocket protocol by hand:
 *   - On client connect: send the full document as a "snapshot" message.
 *   - On each move: send a fresh "snapshot" message with the updated DOM.
 * This is simple and works with the Unreal plugin's MML loader.
 */

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const path = require('path');

const {
  DEFAULT_PIECE_MODELS,
  buildInitialPieces,
  buildMML,
} = require('./chess-document');

// -----------------------------------------------------------------------------
// PIECE MODELS (optional GLB override)
// -----------------------------------------------------------------------------
// By default, pieces are built from MML primitives (m-cylinder, m-sphere,
// m-cube) and need no external files. They render correctly in Otherside today
// with zero dependencies.
//
// To swap in real 3D chess pieces: drop GLB files into the `assets/` folder
// (at the project root) and flip USE_GLB_PIECES to true. The filenames below
// are what this project expects — see assets/README.md for download links.
//
// The MML plugin in Unreal needs ABSOLUTE URLs for <m-model src>, so we build
// them at runtime from PUBLIC_HOST. On Render, that's your-service.onrender.com.
//
// Set this via environment variable before the server starts, e.g.
//   PUBLIC_HOST=chess-mml.onrender.com npm start
// Or set it in the Render dashboard under Environment Variables.
// -----------------------------------------------------------------------------
const USE_GLB_PIECES = process.env.USE_GLB_PIECES === 'true';
const PUBLIC_HOST = process.env.PUBLIC_HOST || `localhost:${process.env.PORT || 8080}`;
const ASSET_PROTO = process.env.PUBLIC_HOST ? 'https' : 'http';
const ASSET_BASE = `${ASSET_PROTO}://${PUBLIC_HOST}/assets`;

const PIECE_MODELS = USE_GLB_PIECES ? {
  // White pieces (same GLB, colored/tinted via Unreal materials if needed)
  wK: `${ASSET_BASE}/king.glb`,
  wQ: `${ASSET_BASE}/queen.glb`,
  wR: `${ASSET_BASE}/rook.glb`,
  wB: `${ASSET_BASE}/bishop.glb`,
  wN: `${ASSET_BASE}/knight.glb`,
  wP: `${ASSET_BASE}/pawn.glb`,
  // Black pieces - same models. If you want distinct black GLBs, rename the
  // files below to king-black.glb etc. and place them in assets/.
  bK: `${ASSET_BASE}/king.glb`,
  bQ: `${ASSET_BASE}/queen.glb`,
  bR: `${ASSET_BASE}/rook.glb`,
  bB: `${ASSET_BASE}/bishop.glb`,
  bN: `${ASSET_BASE}/knight.glb`,
  bP: `${ASSET_BASE}/pawn.glb`,
} : {
  ...DEFAULT_PIECE_MODELS,
  // Leave empty or add per-piece GLB URLs here to override individual pieces
  // while keeping primitives for the rest.
};

// -----------------------------------------------------------------------------
// GAME STATE
// -----------------------------------------------------------------------------
const chess = new Chess();
let pieces = buildInitialPieces(chess);
let lastMove = null; // { fromSquare, toSquare, pieceId }
let statusText = 'White to move';
const docStartMs = Date.now();

// Find the piece that currently occupies `square` (if any).
function pieceAt(square) {
  return pieces.find((p) => !p.captured && p.square === square);
}

// Apply a chess.js move result to our piece list, preserving ids so that
// the MML m-group for a given piece keeps its identity and animates smoothly.
function applyMoveToPieces(move) {
  // move: { from, to, piece, color, captured, promotion, flags, san }
  const mover = pieceAt(move.from);
  if (!mover) {
    console.warn('No piece found at', move.from, '- state desync?');
    return null;
  }

  // Handle capture (including en passant).
  if (move.captured) {
    // Normal capture: victim is on move.to.
    // En passant: victim is on the same file as move.to but one rank back
    //             from the mover's POV.
    let victimSquare = move.to;
    if (move.flags.includes('e')) {
      const epRank = move.color === 'w'
        ? parseInt(move.to[1], 10) - 1
        : parseInt(move.to[1], 10) + 1;
      victimSquare = `${move.to[0]}${epRank}`;
    }
    const victim = pieceAt(victimSquare);
    if (victim) victim.captured = true;
  }

  // Move the mover.
  mover.square = move.to;

  // Handle promotion: change the piece key so next render uses the new model.
  if (move.promotion) {
    mover.type = move.promotion; // chess.js gives "q" "r" "b" "n"
    mover.key = mover.color + move.promotion.toUpperCase();
  }

  // Handle castling: also move the rook.
  // move.flags contains "k" (kingside) or "q" (queenside) on castles.
  if (move.flags.includes('k') || move.flags.includes('q')) {
    const rank = move.color === 'w' ? '1' : '8';
    const rookFromFile = move.flags.includes('k') ? 'h' : 'a';
    const rookToFile = move.flags.includes('k') ? 'f' : 'd';
    const rook = pieceAt(`${rookFromFile}${rank}`);
    if (rook) rook.square = `${rookToFile}${rank}`;
  }

  return { fromSquare: move.from, toSquare: move.to, pieceId: mover.id };
}

function updateStatusText() {
  if (chess.isCheckmate()) {
    statusText = `Checkmate - ${chess.turn() === 'w' ? 'Black' : 'White'} wins`;
  } else if (chess.isStalemate()) {
    statusText = 'Stalemate - draw';
  } else if (chess.isDraw()) {
    statusText = 'Draw';
  } else if (chess.inCheck()) {
    statusText = `${chess.turn() === 'w' ? 'White' : 'Black'} to move (check)`;
  } else {
    statusText = `${chess.turn() === 'w' ? 'White' : 'Black'} to move`;
  }
}

function resetGame() {
  chess.reset();
  pieces = buildInitialPieces(chess);
  lastMove = null;
  updateStatusText();
  broadcastMML();
  broadcastPlayState();
}

function tryMove({ from, to, promotion }) {
  // chess.js accepts promotion as optional
  const move = chess.move({ from, to, promotion: promotion || 'q' });
  if (!move) return { ok: false, error: 'illegal move' };
  const lm = applyMoveToPieces(move);
  lastMove = lm;
  updateStatusText();
  return { ok: true, move };
}

// -----------------------------------------------------------------------------
// MML WEBSOCKET CHANNEL (at wss://host/mml)
// -----------------------------------------------------------------------------
// Speaks the "networked-dom" protocol at its simplest: we send the full
// document snapshot on connect and on every change. This works with every
// MML client (web viewer, MML editor, Unreal plugin) because they all accept
// a "snapshot" message type.
// -----------------------------------------------------------------------------
const mmlClients = new Set();

function currentMMLString() {
  return buildMML({
    pieces,
    lastMove,
    statusText,
    pieceModels: PIECE_MODELS,
    docStartMs,
  });
}

function snapshotMessage() {
  return JSON.stringify({
    type: 'snapshot',
    snapshot: currentMMLString(),
    documentTime: Date.now() - docStartMs,
  });
}

function broadcastMML() {
  const msg = snapshotMessage();
  for (const ws of mmlClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// -----------------------------------------------------------------------------
// PLAY (browser) WEBSOCKET CHANNEL (at wss://host/play)
// -----------------------------------------------------------------------------
const playClients = new Set();

function broadcastPlayState() {
  const msg = JSON.stringify({
    type: 'state',
    fen: chess.fen(),
    turn: chess.turn(),
    status: statusText,
    isGameOver: chess.isGameOver(),
  });
  for (const ws of playClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// -----------------------------------------------------------------------------
// HTTP + WS SETUP
// -----------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Serve chess-piece GLB files (and any other assets you drop here) at /assets/*.
// The folder lives at the project root so it's easy to find and commit to git.
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

app.get('/', (req, res) => {
  res.redirect('/play');
});

app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

app.get('/mml.html', (req, res) => {
  // Convenience: serve the current MML as plain HTML so you can eyeball it.
  res.type('text/html').send(currentMMLString());
});

const server = http.createServer(app);

const mmlWss = new WebSocketServer({ noServer: true });
mmlWss.on('connection', (ws) => {
  mmlClients.add(ws);
  ws.send(snapshotMessage());
  ws.on('close', () => mmlClients.delete(ws));
  ws.on('error', () => mmlClients.delete(ws));
});

const playWss = new WebSocketServer({ noServer: true });
playWss.on('connection', (ws) => {
  playClients.add(ws);
  // Immediately sync state.
  ws.send(JSON.stringify({
    type: 'state',
    fen: chess.fen(),
    turn: chess.turn(),
    status: statusText,
    isGameOver: chess.isGameOver(),
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'move') {
      const result = tryMove({ from: msg.from, to: msg.to, promotion: msg.promotion });
      if (result.ok) {
        broadcastMML();
        broadcastPlayState();
      } else {
        ws.send(JSON.stringify({ type: 'moveRejected', from: msg.from, to: msg.to, reason: result.error }));
        // Send the current state so the browser snaps the piece back.
        ws.send(JSON.stringify({
          type: 'state',
          fen: chess.fen(),
          turn: chess.turn(),
          status: statusText,
          isGameOver: chess.isGameOver(),
        }));
      }
    } else if (msg.type === 'reset') {
      resetGame();
    }
  });

  ws.on('close', () => playClients.delete(ws));
  ws.on('error', () => playClients.delete(ws));
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';
  if (url.startsWith('/mml')) {
    mmlWss.handleUpgrade(req, socket, head, (ws) => mmlWss.emit('connection', ws, req));
  } else if (url.startsWith('/play')) {
    playWss.handleUpgrade(req, socket, head, (ws) => playWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  updateStatusText();
  console.log('');
  console.log('  Chess-MML server running');
  console.log('  ------------------------');
  console.log(`  Browser (play UI):   http://localhost:${PORT}/play`);
  console.log(`  MML WebSocket:       ws://localhost:${PORT}/mml`);
  console.log('');
  console.log('  Paste the MML URL into:');
  console.log('    - mmleditor.com  (View URL field)');
  console.log('    - viewer.mml.io/?url=<MML URL>');
  console.log('    - Otherside Vibe Maker MML Object');
  console.log('');
});
