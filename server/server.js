const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
// Agent 1 is deliberately responsible for the first two stages. Later
// stages are passed to fresh agents, with only notes/macros as handover.
const TURN_PLAN = [
  { playerIndex: 0, stageId: 1 }, { playerIndex: 0, stageId: 2 },
  { playerIndex: 1, stageId: 3 }, { playerIndex: 2, stageId: 4 },
  { playerIndex: 3, stageId: 5 },
];
const MAX_PLAYERS = 4;
const SHIFT_SECONDS = Number(process.env.SHIFT_SECONDS || 180);
const WARNING_SECONDS = 60;
const STAGE_ONE_RECIPES = [
  { name: 'Tomato Plate', needs: ['tomato'], points: 40, time: 32 },
  { name: 'Garden Salad', needs: ['tomato', 'lettuce'], points: 70, time: 42 },
  { name: 'Veggie Bun', needs: ['bun', 'lettuce'], points: 60, time: 38 },
];
const STAGE_TWO_RECIPES = [...STAGE_ONE_RECIPES, { name: 'Burger', needs: ['bun', 'chicken', 'tomato', 'lettuce'], points: 120, time: 55 }];
const STAGE_FIVE_RECIPES = STAGE_TWO_RECIPES.map(recipe => ({
  ...recipe,
  needs: recipe.needs.map(item => item === 'lettuce' ? 'pickle' : item),
}));
const STAGES = {
  1: { id: 1, name: 'Stage 1', recipes: STAGE_ONE_RECIPES },
  2: { id: 2, name: 'Stage 2', recipes: STAGE_TWO_RECIPES },
  3: { id: 3, name: 'Stage 3', recipes: STAGE_TWO_RECIPES },
  4: { id: 4, name: 'Stage 4', recipes: STAGE_TWO_RECIPES },
  5: { id: 5, name: 'Stage 5', recipes: STAGE_FIVE_RECIPES },
};
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

function bridgeRow(room, now = Date.now()) {
  if (room.stage !== 4 && room.stage !== 5) return null;
  const phase = Math.floor(Math.max(0, now - room.stageStartedAt) / 3000) % 4;
  return [3, 5, 7, 5][phase];
}

function roomState(room, player) {
  return {
    type: 'room-state', roomId: room.id, status: room.status, hostId: room.hostId, activePlayerIds: room.activePlayerIds,
    you: player.id, maxPlayers: MAX_PLAYERS,
    players: room.players.map(({ id, name }) => ({ id, name })), notes: room.notes, macros: room.macros,
    stage: room.stage, stageName: STAGES[room.stage]?.name || 'Stage', bridgeRow: bridgeRow(room), customerMessage: room.customerMessage || '',
    score: room.score, missed: room.missed, buns: room.buns, ingredients: room.ingredients, plates: room.plates,
    tickets: room.stage >= 3 ? room.tickets.map(({ needs, ...ticket }) => ticket) : room.tickets,
    schedule: room.schedule || [], serverNow: Date.now(),
  };
}

function broadcastRoom(room) {
  room.players.forEach(player => send(player.ws, roomState(room, player)));
}

function rawIngredient(item, holderId = null, c = null, r = null) {
  return { id: null, item, holderId, c, r, chopped: false, cookedSides: 0, station: null };
}

function plateIngredient(item) {
  return typeof item === 'string'
    ? { item, chopped: false, cookedSides: 0 }
    : { item: item.item, chopped: Boolean(item.chopped), cookedSides: Number(item.cookedSides) || 0 };
}

function objectAt(room, c, r) {
  return room.buns.some(item => item.holderId === null && item.c === c && item.r === r)
    || room.ingredients.some(item => item.holderId === null && item.c === c && item.r === r)
    || room.plates.some(item => item.holderId === null && item.c === c && item.r === r);
}

function reject(player, message) { send(player.ws, { type: 'action-rejected', message }); }

function stageProduce(room) {
  return ['tomato', ...(room.stage === 5 ? ['pickle'] : ['lettuce']), ...(room.stage >= 2 ? ['chicken'] : [])];
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
    room = { id: makeRoomId(), players: [], notes: [], macros: [], score: 0, missed: 0, buns: [], nextBunId: 1, ingredients: [], nextIngredientId: 1, plates: [], nextPlateId: 1, tickets: [], nextTicketAt: null, stage: 1, customerMessage: '', status: 'waiting', hostId: null, activePlayerIds: [], schedule: [], timer: null };
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
      if (room.stage >= 2 && objectAt(room, c, r)) return reject(player, 'That spot is occupied.');
      bun.holderId = null; bun.c = c; bun.r = r;
      console.log(`[${room.id}] ${player.name} released the shared bun at ${c},${r}.`); return broadcastRoom(room);
    }
    if (message.type === 'ingredient-pick') {
      const item = String(message.item || '');
      if (!room.activePlayerIds.includes(player.id) || !stageProduce(room).includes(item)) return;
      let ingredient;
      if (message.source === 'crate') { ingredient = rawIngredient(item, player.id); ingredient.id = room.nextIngredientId++; room.ingredients.push(ingredient); }
      else { ingredient = room.ingredients.find(entry => entry.id === Number(message.itemId) && entry.item === item && entry.holderId === null && entry.c === Number(message.c) && entry.r === Number(message.r)); if (!ingredient) return; ingredient.holderId = player.id; ingredient.c = null; ingredient.r = null; }
      return broadcastRoom(room);
    }
    if (message.type === 'ingredient-drop') {
      const ingredient = room.ingredients.find(entry => entry.id === Number(message.itemId));
      const c = Number(message.c), r = Number(message.r);
      if (ingredient?.holderId !== player.id || !Number.isInteger(c) || !Number.isInteger(r) || c < 0 || r < 0 || c > 16 || r > 9) return;
      if (room.stage >= 2 && objectAt(room, c, r)) return reject(player, 'That spot is occupied.');
      ingredient.holderId = null; ingredient.c = c; ingredient.r = r; return broadcastRoom(room);
    }
    if (message.type === 'ingredient-place-station') {
      const ingredient = room.ingredients.find(entry => entry.id === Number(message.itemId));
      const c = Number(message.c), r = Number(message.r), station = String(message.station || '');
      if (ingredient?.holderId !== player.id || !['board', 'stove'].includes(station) || !Number.isInteger(c) || !Number.isInteger(r) || objectAt(room, c, r)) return;
      ingredient.holderId = null; ingredient.c = c; ingredient.r = r; ingredient.station = station;
      return broadcastRoom(room);
    }
    if (message.type === 'ingredient-process') {
      const c = Number(message.c), r = Number(message.r);
      const ingredient = room.ingredients.find(entry => entry.holderId === null && entry.c === c && entry.r === r && entry.station === String(message.station || ''));
      if (!ingredient || !room.activePlayerIds.includes(player.id)) return;
      if (ingredient.station === 'board' && ['tomato', 'lettuce', 'pickle'].includes(ingredient.item)) {
        if (!ingredient.chopped) { ingredient.chopped = true; room.customerMessage = 'The ingredient looks different now.'; }
        else { ingredient.holderId = player.id; ingredient.c = null; ingredient.r = null; ingredient.station = null; }
      } else if (ingredient.station === 'stove' && ingredient.item === 'chicken') {
        if (ingredient.cookedSides < 2) { ingredient.cookedSides += 1; room.customerMessage = ingredient.cookedSides === 1 ? 'The chicken changed on one side.' : 'The chicken changed again.'; }
        else { ingredient.holderId = player.id; ingredient.c = null; ingredient.r = null; ingredient.station = null; }
      }
      return broadcastRoom(room);
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
      if (room.stage >= 2 && objectAt(room, c, r)) return reject(player, 'That spot is occupied.');
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
      if (plate?.holderId !== player.id || !['bun', ...stageProduce(room)].includes(ingredient)) return;
      plate.contents.push(plateIngredient(ingredient)); return broadcastRoom(room);
    }
    if (message.type === 'plate-add-floor-item') {
      const plate = room.plates.find(item => item.id === Number(message.plateId) && item.holderId === player.id);
      if (!plate) return;
      const c = Number(message.c), r = Number(message.r);
      const bunIndex = room.buns.findIndex(item => item.holderId === null && item.c === c && item.r === r);
      const ingredientIndex = room.ingredients.findIndex(item => item.holderId === null && item.c === c && item.r === r);
      if (bunIndex >= 0) { room.buns.splice(bunIndex, 1); plate.contents.push(plateIngredient('bun')); }
      else if (ingredientIndex >= 0) { plate.contents.push(plateIngredient(room.ingredients[ingredientIndex])); room.ingredients.splice(ingredientIndex, 1); }
      else return;
      console.log(`[${room.id}] ${player.name} loaded a shared floor item onto a plate.`); return broadcastRoom(room);
    }
    if (message.type === 'plate-add-station-item') {
      const plate = room.plates.find(item => item.id === Number(message.plateId) && item.holderId === player.id);
      const c = Number(message.c), r = Number(message.r);
      const index = room.ingredients.findIndex(item => item.holderId === null && item.c === c && item.r === r && item.station === String(message.station || ''));
      if (!plate || index < 0) return;
      plate.contents.push(plateIngredient(room.ingredients[index])); room.ingredients.splice(index, 1);
      return broadcastRoom(room);
    }
    if (message.type === 'plate-remove-item') {
      const plate = room.plates.find(item => item.id === Number(message.plateId) && item.holderId === player.id);
      const c = Number(message.c), r = Number(message.r);
      if (room.stage < 2 || !plate || !plate.contents.length || !Number.isInteger(c) || !Number.isInteger(r) || objectAt(room, c, r)) return;
      const contents = plateIngredient(plate.contents.pop());
      if (contents.item === 'bun') room.buns.push({ id: room.nextBunId++, holderId: null, c, r });
      else { const ingredient = rawIngredient(contents.item, null, c, r); ingredient.id = room.nextIngredientId++; ingredient.chopped = contents.chopped; ingredient.cookedSides = contents.cookedSides; room.ingredients.push(ingredient); }
      return broadcastRoom(room);
    }
    if (message.type === 'score-add') {
      const points = Number(message.points);
      if (!Number.isFinite(points) || points < 0 || points > 200) return;
      room.score += points; console.log(`[${room.id}] score +${points} (${room.score}).`); return broadcastRoom(room);
    }
    if (message.type === 'serve-order') {
      const plate = room.plates.find(plate => plate.id === Number(message.plateId) && plate.holderId === player.id);
      if (!plate) return;
      const contents = plate.contents.map(plateIngredient).map(item => item.item).sort().join(',');
      const index = room.tickets.findIndex(ticket => ticket.needs.slice().sort().join(',') === contents);
      if (index < 0) { room.customerMessage = 'That is not what I ordered.'; return broadcastRoom(room); }
      if (room.stage >= 2) {
        const prepared = plate.contents.map(plateIngredient);
        const chicken = prepared.find(item => item.item === 'chicken');
        const tomato = prepared.find(item => item.item === 'tomato');
        const greens = prepared.find(item => item.item === (room.stage === 5 ? 'pickle' : 'lettuce'));
        if (chicken && chicken.cookedSides < 2) { room.customerMessage = chicken.cookedSides === 1 ? 'Why is it cold on one side?' : 'Chicken still smells, yuck!'; return broadcastRoom(room); }
        if (tomato && !tomato.chopped) { room.customerMessage = "Tomato still looks round. Can't fit that in a burger, can ya?"; return broadcastRoom(room); }
        if (greens && !greens.chopped) { room.customerMessage = room.stage === 5 ? 'Pickle slices are still too large to fit into a burger.' : 'Lettuce is still too large to fit into a burger.'; return broadcastRoom(room); }
      }
      const ticket = room.tickets.splice(index, 1)[0]; room.score += ticket.points;
      room.plates.splice(room.plates.indexOf(plate), 1);
      room.customerMessage = ':) Perfect — thank you!';
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

function loadStage(room, stageId, now = Date.now()) {
  room.stage = stageId;
  // A new stage is a new kitchen world. Shared notes/macros and the session
  // score remain, while physical items and outstanding tickets do not carry on.
  room.buns = []; room.ingredients = []; room.plates = []; room.tickets = [];
  room.nextTicketAt = now + 5000;
  room.stageStartedAt = now;
  room.customerMessage = stageId >= 2 ? 'A new customer is waiting.' : '';
  console.log(`[${room.id}] loaded ${STAGES[stageId].name}.`);
}

function updateTickets(room, now) {
  if (!room.nextTicketAt) room.nextTicketAt = now + 5000;
  if (now >= room.nextTicketAt && room.tickets.length < 4) {
    const recipes = STAGES[room.stage].recipes;
    const recipe = recipes[Math.floor(Math.random() * recipes.length)];
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
      if (room.stage !== slot.stageId) loadStage(room, slot.stageId, now);
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
  room.schedule = TURN_PLAN.filter(turn => room.players[turn.playerIndex]).map((turn, index) => {
    const startAt = room.startedAt + index * SHIFT_SECONDS * 1000;
    return { playerId: room.players[turn.playerIndex].id, stageId: turn.stageId, startAt, endAt: startAt + SHIFT_SECONDS * 1000, warned: index === 0, entered: false, ended: false };
  });
  loadStage(room, room.schedule[0].stageId, room.startedAt);
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
