// server.js
// A minimal waiting-room + relay server for Kitchen Relay.
// - Serves the game client (static files) from ../client
// - Accepts WebSocket connections, capped at 2 players at a time
// - Tracks who's "waiting" vs "in a session" and broadcasts state to both players
//
// Run locally with:  node server.js
// Then open:          http://localhost:3000

const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Serve the game client as static files (client/index.html, etc.)
app.use(express.static(path.join(__dirname, '..', 'client')));

// ---------- Room state ----------
// This simple version supports a single shared room with at most 2 players.
// If you need multiple simultaneous games later, this is the place to grow
// into a Map of rooms keyed by a room code.
const MAX_PLAYERS = 2;
let players = []; // { ws, id, name }
let nextPlayerId = 1;

function broadcast(msg, exceptWs = null) {
  const data = JSON.stringify(msg);
  players.forEach(p => {
    if (p.ws !== exceptWs && p.ws.readyState === p.ws.OPEN) {
      p.ws.send(data);
    }
  });
}

function roomStatus() {
  return {
    type: 'room-status',
    count: players.length,
    max: MAX_PLAYERS,
    players: players.map(p => ({ id: p.id, name: p.name })),
  };
}

wss.on('connection', (ws) => {
  // Reject if the room is already full
  if (players.length >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'room-full' }));
    ws.close();
    return;
  }

  const player = { ws, id: nextPlayerId++, name: `Player ${players.length + 1}` };
  players.push(player);

  console.log(`${player.name} connected. (${players.length}/${MAX_PLAYERS})`);

  // Tell the new player who they are
  ws.send(JSON.stringify({ type: 'welcome', id: player.id, name: player.name }));

  // Let everyone know the current room status (this is what drives the waiting-room UI)
  broadcast(roomStatus());

  // Once both players are present, signal that the session can begin
  if (players.length === MAX_PLAYERS) {
    broadcast({ type: 'session-ready' });
  }

  ws.on('message', (raw) => {
    try {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; } // ignore malformed messages, don't crash

      // For now, relay any game action/state message to the other player(s).
      // This is intentionally generic — the client decides what these messages mean
      // (e.g. { type: 'action', action: 'move', dir: 'up' } or a full state sync).
      broadcast({ ...msg, from: player.id }, ws);
    } catch (err) {
      // Something unexpected happened while handling this one message —
      // log it and keep the server (and the other player's connection) alive.
      console.error('Error handling message:', err);
    }
  });

  ws.on('error', (err) => {
    console.error(`${player.name} socket error:`, err);
  });

  ws.on('close', () => {
    players = players.filter(p => p.ws !== ws);
    console.log(`${player.name} disconnected. (${players.length}/${MAX_PLAYERS})`);
    broadcast(roomStatus());
    broadcast({ type: 'player-left', id: player.id });
  });
});

server.listen(PORT, () => {
  console.log(`Kitchen Relay server running on http://localhost:${PORT}`);
});

// Safety nets: log unexpected errors instead of letting them silently kill
// the process mid-experiment. This isn't a substitute for fixing real bugs,
// but it buys resilience during a live playtest session.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server kept running):', err);
});
