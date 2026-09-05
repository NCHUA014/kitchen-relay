const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const SHIFT_SECONDS = Number(process.env.SHIFT_SECONDS || 180);
const OVERLAP_SECONDS = Number(process.env.OVERLAP_SECONDS || 120);
const WARNING_SECONDS = 60;
const RECIPES = [
  { name: 'Tomato Plate', needs: ['tomato'], points: 40, time: 32 },
  { name: 'Garden Salad', needs: ['tomato', 'lettuce'], points: 70, time: 42 },
  { name: 'Veggie Bun', needs: ['bun', 'lettuce'], points: 60, time: 38 },
];
const rooms = new Map();
let nextPlayerId = 1;

app.use(express.static(path.join(__dirname, '..', 'client')));

function makeRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = `KITCHEN-${Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`;
  } while (rooms.has(id));
  return id;
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function roomState(room, player) {
  return {
    type: 'room-state', roomId: room.id, status: room.status, hostId: room.hostId, activePlayerIds: room.activePlayerIds,
    you: player.id, maxPlayers: MAX_PLAYERS,
    players: room.players.map(({ id, name }) => ({ id, name })), notes: room.notes, macros: room.macros,
    score: room.score, missed: room.missed, buns: room.buns, ingredients: room.ingredients, plates: room.plates, tickets: room.tickets, schedule: room.schedule || [], serverNow: Date.now(),
  };
}

function broadcastRoom(room) {
  room.players.forEach(player => send(player.ws, roomState(room, player)));
}

function leaveRoom(player) {
  const room = player?.room;
  if (!room) return;
  room.players = room.players.filter(item => item !== player);
  room.activePlayerIds = room.activePlayerIds.filter(id => id !== player.id);
  if (room.status !== 'waiting') room.disconnectedPlayers.set(player.name.toLowerCase(), player);
  if (room.hostId === player.id && room.players.length) room.hostId = room.players[0].id;
  player.room = null;
  console.log(`[${room.id}] ${player.name} left (${room.players.length}/${MAX_PLAYERS})`);
  if (!room.players.length) {
    clearInterval(room.timer);
    rooms.delete(room.id);
    console.log(`[${room.id}] room removed; live notes and macros are cleared.`);
  } else broadcastRoom(room);
}

function joinRoom(ws, message) {
  if (ws.player) return;
  const name = String(message.name || '').trim().slice(0, 24);
  if (!name) return send(ws, { type: 'error', message: 'Enter a display name.' });
  let room;
  if (message.action === 'create') {
    room = { id: makeRoomId(), players: [], notes: [], macros: [], score: 0, missed: 0, buns: [], nextBunId: 1, ingredients: [], nextIngredientId: 1, plates: [], nextPlateId: 1, tickets: [], nextTicketAt: null, status: 'waiting', hostId: null, activePlayerIds: [], schedule: [], timer: null };
    rooms.set(room.id, room);
    console.log(`[${room.id}] room created.`);
  } else {
    room = rooms.get(String(message.roomId || '').trim().toUpperCase());
    if (!room) return send(ws, { type: 'error', message: 'Meeting ID not found.' });
    if (room.status !== 'waiting' && !room.disconnectedPlayers?.has(name.toLowerCase())) return send(ws, { type: 'error', message: 'This session has already started. Rejoin using your original display name.' });
  }
  room.disconnectedPlayers ||= new Map();
  if (room.players.some(member => member.name.toLowerCase() === name.toLowerCase())) return send(ws, { type: 'error', message: 'That display name is already connected.' });
  if (room.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'This waiting room is full.' });
  const returning = room.disconnectedPlayers.get(name.toLowerCase());
  const player = returning || { id: nextPlayerId++, name };
  player.ws = ws; player.room = room;
  room.disconnectedPlayers.delete(name.toLowerCase());
  ws.player = player;
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  console.log(`[${room.id}] ${name} joined (${room.players.length}/${MAX_PLAYERS})`);
  broadcastRoom(room);
  if (returning && room.status === 'active') {
    advanceRoom(room);
    const slot = room.schedule.find(item => item.playerId === player.id);
    if (slot?.ended) send(ws, { type: 'shift-ended' });
    else if (slot?.entered) {
      if (!room.activePlayerIds.includes(player.id)) room.activePlayerIds.push(player.id);
      broadcastRoom(room);
      send(ws, { type: 'enter-game', roomId: room.id });
    }
  }
}

wss.on('connection', ws => {
  send(ws, { type: 'connected' });
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw); } catch { return send(ws, { type: 'error', message: 'Invalid message.' }); }
    if (message.type === 'join-room') return joinRoom(ws, message);
    const player = ws.player;
    if (!player?.room) return send(ws, { type: 'error', message: 'Join a room first.' });
    const room = player.room;
    if (room.status === 'finished') return;
    if (message.type === 'note-create') {
      const text = String(message.text || '').trim().slice(0, 500);
      if (!text) return;
      room.notes.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, author: player.name, text, updatedAt: Date.now() });
      console.log(`[${room.id}] ${player.name} created a note.`); return broadcastRoom(room);
    }
    if (message.type === 'note-update') {
      const note = room.notes.find(item => item.id === message.id);
      const text = String(message.text || '').trim().slice(0, 500);
      if (!note || !text) return;
      note.text = text; note.updatedAt = Date.now();
      console.log(`[${room.id}] ${player.name} updated a note.`); return broadcastRoom(room);
    }
    if (message.type === 'note-delete') {
      const before = room.notes.length;
      room.notes = room.notes.filter(item => item.id !== message.id);
      if (room.notes.length !== before) console.log(`[${room.id}] ${player.name} deleted a note.`);
      return broadcastRoom(room);
    }
    if (message.type === 'player-state') {
      if (!room.activePlayerIds.includes(player.id)) return;
      const gc = Number(message.gc), gr = Number(message.gr);
      if (!Number.isInteger(gc) || !Number.isInteger(gr) || gc < 0 || gr < 0 || gc > 16 || gr > 9) return;
      room.players.forEach(member => {
        if (member !== player) send(member.ws, { type: 'player-state', playerId: player.id, gc, gr, dir: message.dir, holding: message.holding || null });
      });
      return;
    }
    if (message.type === 'bun-pick') {
      if (!room.activePlayerIds.includes(player.id)) return;
      let bun;
      if (message.source === 'crate') {
        bun = { id: room.nextBunId++, holderId: player.id, c: null, r: null };
        room.buns.push(bun);
      } else {
        bun = room.buns.find(item => item.id === Number(message.itemId) && item.holderId === null && item.c === Number(message.c) && item.r === Number(message.r));
        if (!bun) return;
        bun.holderId = player.id; bun.c = null; bun.r = null;
      }
      console.log(`[${room.id}] ${player.name} picked up the shared bun.`); return broadcastRoom(room);
    }
    if (message.type === 'bun-drop') {
      const c = Number(message.c), r = Number(message.r);
      const bun = room.buns.find(item => item.id === Number(message.itemId));
      if (bun?.holderId !== player.id || !Number.isInteger(c) || !Number.isInteger(r) || c < 0 || r < 0 || c > 16 || r > 9) return;
      bun.holderId = null; bun.c = c; bun.r = r;
      console.log(`[${room.id}] ${player.name} released the shared bun at ${c},${r}.`); return broadcastRoom(room);
    }
    if (message.type === 'ingredient-pick') {
      const item = String(message.item || '');
      if (!room.activePlayerIds.includes(player.id) || !['tomato', 'lettuce'].includes(item)) return;
      let ingredient;
      if (message.source === 'crate') { ingredient = { id: room.nextIngredientId++, item, holderId: player.id, c: null, r: null }; room.ingredients.push(ingredient); }
      else { ingredient = room.ingredients.find(entry => entry.id === Number(message.itemId) && entry.item === item && entry.holderId === null && entry.c === Number(message.c) && entry.r === Number(message.r)); if (!ingredient) return; ingredient.holderId = player.id; ingredient.c = null; ingredient.r = null; }
      return broadcastRoom(room);
    }
    if (message.type === 'ingredient-drop') {
      const ingredient = room.ingredients.find(entry => entry.id === Number(message.itemId));
      const c = Number(message.c), r = Number(message.r);
      if (ingredient?.holderId !== player.id || !Number.isInteger(c) || !Number.isInteger(r) || c < 0 || r < 0 || c > 16 || r > 9) return;
      ingredient.holderId = null; ingredient.c = c; ingredient.r = r; return broadcastRoom(room);
    }
    if (message.type === 'plate-create') {
      if (!room.activePlayerIds.includes(player.id)) return;
      room.plates.push({ id: room.nextPlateId++, holderId: player.id, c: null, r: null, contents: [] });
      return broadcastRoom(room);
    }
    if (message.type === 'plate-pick') {
      const plate = room.plates.find(item => item.id === Number(message.itemId) && item.holderId === null && item.c === Number(message.c) && item.r === Number(message.r));
      if (!plate || !room.activePlayerIds.includes(player.id)) return;
      plate.holderId = player.id; plate.c = null; plate.r = null; return broadcastRoom(room);
    }
    if (message.type === 'plate-drop') {
      const plate = room.plates.find(item => item.id === Number(message.itemId));
      const c = Number(message.c), r = Number(message.r);
      if (plate?.holderId !== player.id || !Number.isInteger(c) || !Number.isInteger(r) || c < 0 || r < 0 || c > 16 || r > 9) return;
      plate.holderId = null; plate.c = c; plate.r = r; return broadcastRoom(room);
    }
    if (message.type === 'plate-delete') {
      const index = room.plates.findIndex(item => item.id === Number(message.itemId) && item.holderId === player.id);
      if (index < 0) return;
      room.plates.splice(index, 1);
      console.log(`[${room.id}] ${player.name} discarded a shared plate.`); return broadcastRoom(room);
    }
    if (message.type === 'plate-add') {
      const plate = room.plates.find(item => item.id === Number(message.itemId));
      const ingredient = String(message.ingredient || '');
      if (plate?.holderId !== player.id || !['tomato', 'lettuce', 'bun'].includes(ingredient)) return;
      plate.contents.push(ingredient); return broadcastRoom(room);
    }
    if (message.type === 'plate-add-floor-item') {
      const plate = room.plates.find(item => item.id === Number(message.plateId) && item.holderId === player.id);
      if (!plate) return;
      const c = Number(message.c), r = Number(message.r);
      const bunIndex = room.buns.findIndex(item => item.holderId === null && item.c === c && item.r === r);
      const ingredientIndex = room.ingredients.findIndex(item => item.holderId === null && item.c === c && item.r === r);
      if (bunIndex >= 0) { room.buns.splice(bunIndex, 1); plate.contents.push('bun'); }
      else if (ingredientIndex >= 0) { plate.contents.push(room.ingredients[ingredientIndex].item); room.ingredients.splice(ingredientIndex, 1); }
      else return;
      console.log(`[${room.id}] ${player.name} loaded a shared floor item onto a plate.`); return broadcastRoom(room);
    }
    if (message.type === 'score-add') {
      const points = Number(message.points);
      if (!Number.isFinite(points) || points < 0 || points > 200) return;
      room.score += points; console.log(`[${room.id}] score +${points} (${room.score}).`); return broadcastRoom(room);
    }
    if (message.type === 'serve-order') {
      const contents = Array.isArray(message.contents) ? message.contents.slice().sort().join(',') : '';
      const index = room.tickets.findIndex(ticket => ticket.needs.slice().sort().join(',') === contents);
      const plateIndex = room.plates.findIndex(plate => plate.id === Number(message.plateId) && plate.holderId === player.id);
      if (index < 0 || plateIndex < 0) return;
      const ticket = room.tickets.splice(index, 1)[0]; room.score += ticket.points;
      room.plates.splice(plateIndex, 1);
      console.log(`[${room.id}] ${player.name} served ${ticket.name} (+${ticket.points}).`); return broadcastRoom(room);
    }
    if (message.type === 'missed-add') {
      room.missed += 1; console.log(`[${room.id}] missed order (${room.missed}).`); return broadcastRoom(room);
    }
    if (message.type === 'macros-sync') {
      if (!Array.isArray(message.macros) || message.macros.length > 20) return;
      room.macros = message.macros.map(macro => ({ id: String(macro.id || ''), name: String(macro.name || '').slice(0, 40), shortcut: String(macro.shortcut || '').slice(0, 1), sequence: Array.isArray(macro.sequence) ? macro.sequence.slice(0, 40) : [] }));
      console.log(`[${room.id}] ${player.name} updated shared macros.`); return broadcastRoom(room);
    }
    if (message.type === 'start-session') {
      if (room.hostId !== player.id) return send(ws, { type: 'error', message: 'Only the host can start the session.' });
      startSession(room, player);
      return broadcastRoom(room);
    }
  });
  ws.on('close', () => leaveRoom(ws.player));
  ws.on('error', err => console.error('WebSocket error:', err.message));
});

function broadcastEvent(room, message) { room.players.forEach(player => send(player.ws, message)); }
function updateTickets(room, now) {
  if (!room.nextTicketAt) room.nextTicketAt = now + 5000;
  if (now >= room.nextTicketAt && room.tickets.length < 4) {
    const recipe = RECIPES[Math.floor(Math.random() * RECIPES.length)];
    room.tickets.push({ ...recipe, id: `${now}-${Math.random()}`, expiresAt: now + recipe.time * 1000 });
    room.nextTicketAt = now + (9 + Math.random() * 6) * 1000;
  }
  const remaining = room.tickets.filter(ticket => ticket.expiresAt <= now);
  if (remaining.length) { room.missed += remaining.length; room.tickets = room.tickets.filter(ticket => ticket.expiresAt > now); }
}
function advanceRoom(room) {
  const now = Date.now();
  updateTickets(room, now);
  room.schedule.forEach(slot => {
    const player = room.players.find(member => member.id === slot.playerId);
    if (player && !slot.warned && now >= slot.startAt - WARNING_SECONDS * 1000 && slot.startAt > room.startedAt) {
      slot.warned = true;
      console.log(`[${room.id}] warning: ${player.name} enters in one minute.`);
      broadcastEvent(room, { type: 'handover-warning', playerId: player.id, playerName: player.name, startsAt: slot.startAt });
    }
    if (player && !slot.entered && now >= slot.startAt && now < slot.endAt) {
      slot.entered = true; room.activePlayerIds.push(player.id);
      console.log(`[${room.id}] ${player.name} entered the kitchen.`);
      send(player.ws, { type: 'enter-game', roomId: room.id }); broadcastRoom(room);
    }
    if (!slot.ended && now >= slot.endAt) {
      slot.ended = true; room.activePlayerIds = room.activePlayerIds.filter(id => id !== slot.playerId);
      if (player) send(player.ws, { type: 'shift-ended' });
      broadcastRoom(room);
    }
  });
  broadcastRoom(room);
  if (room.schedule.length && room.schedule.every(slot => slot.ended)) {
    clearInterval(room.timer); room.status = 'finished'; broadcastEvent(room, { type: 'session-finished' }); broadcastRoom(room);
  }
}
function startSession(room, host) {
  if (room.status !== 'waiting') return;
  room.status = 'active'; room.startedAt = Date.now(); room.activePlayerIds = [];
  room.schedule = room.players.map((player, index) => {
    const startAt = room.startedAt + index * (SHIFT_SECONDS - OVERLAP_SECONDS) * 1000;
    return { playerId: player.id, startAt, endAt: startAt + SHIFT_SECONDS * 1000, warned: index === 0, entered: false, ended: false };
  });
  room.tickets = []; room.nextTicketAt = room.startedAt + 5000;
  console.log(`[${room.id}] session started by ${host.name}; ${room.players[0].name} is first.`);
  advanceRoom(room);
  room.timer = setInterval(() => advanceRoom(room), 1000);
}

function shutdown() {
  console.log('Server stopping; clearing live rooms.');
  rooms.forEach(room => room.players.forEach(player => send(player.ws, { type: 'session-ended' })));
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.listen(PORT, () => console.log(`Kitchen Relay server running on http://localhost:${PORT}`));
