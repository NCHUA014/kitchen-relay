const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { GameEngine, TURN_PLAN, STAGES } = require('./game-engine');
const database = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const SHIFT_SECONDS = Number(process.env.SHIFT_SECONDS || 180);
const WARNING_SECONDS = 60;
const PREPARATION_MS = 1500;
const rooms = new Map();
const engine = new GameEngine();
const experiments = new Map();
const agentTokens = new Map();
const RESEARCHER_TOKEN = process.env.RESEARCHER_TOKEN || 'local-researcher-token';
const RUNS_DIR = path.join(__dirname, 'runs');
const STAGE_ONE_HANDOVER_PLAN = Object.freeze([
  { playerIndex: 0, stageId: 1 },
  { playerIndex: 1, stageId: 1 },
]);
const MACRO_BASIC_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', ' ']);
const RESERVED_MACRO_SHORTCUTS = new Set(['w', 'a', 's', 'd', 'q', 'e']);
let nextPlayerId = 1;

app.use(express.json({ limit: '32kb' }));
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
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function bridgeRow(room, now = Date.now()) {
  return engine.bridgeRow(room, now);
}

function experimentForRoom(room) {
  return [...experiments.values()].find(experiment => experiment.room === room) || null;
}

function agentSessionForPlayer(player) {
  return [...agentTokens.values()].find(session => session.player === player) || null;
}

function roomState(room, player) {
  return {
    type: 'room-state', roomId: room.id, status: room.status, hostId: room.hostId, activePlayerIds: room.activePlayerIds,
    you: player.id, maxPlayers: MAX_PLAYERS,
    players: room.players.map(({ id, name, gc, gr, dir }) => ({ id, name, gc, gr, dir })), notes: room.notepad.text ? [room.notepad] : [], notepad: room.notepad, macros: room.macros,
    stage: room.stage, stageName: STAGES[room.stage]?.name || 'Stage', bridgeRow: bridgeRow(room), customerMessage: room.customerMessage || '',
    map: engine.map(room),
    score: room.score, missed: room.missed, buns: room.buns, ingredients: room.ingredients, plates: room.plates,
    tickets: room.stage >= 3 ? room.tickets.map(({ needs, displayNeeds, ...ticket }) => ticket) : room.tickets,
    schedule: room.schedule || [], serverNow: Date.now(),
  };
}

function broadcastRoom(room) {
  room.players.forEach(player => send(player.ws, roomState(room, player)));
}

function rawIngredient(item, holderId = null, c = null, r = null) {
  return { id: null, item, holderId, c, r, chopped: false, cookedSides: 0, station: null, processing: null, processStartedAt: null, processEndsAt: null };
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

function finishMacroRun(player, blocked = false) {
  const session = agentSessionForPlayer(player);
  if (!session?.macroRunId) return;
  database.finishMacroRun(session.macroRunId, blocked);
  session.macroRunId = null;
}

function reject(player, message) {
  finishMacroRun(player, true);
  const session = agentSessionForPlayer(player);
  if (session) session.lastRejection = message;
  send(player.ws, { type: 'action-rejected', message });
}

function stageProduce(room) {
  return ['tomato', ...(room.stage === 5 ? ['pickle'] : ['lettuce']), ...(room.stage >= 2 ? ['chicken'] : [])];
}

function runMacroKey(room, player, key) {
  const directions = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
  if (directions[key]) {
    const [dc, dr] = directions[key];
    const direction = { x: dc, y: dr };
    if (!engine.move(room, player, { gc: player.gc + dc, gr: player.gr + dr, dir: direction })) {
      if (player.dir?.x === direction.x && player.dir?.y === direction.y) return 'Macro movement is blocked.';
      player.dir = direction;
      engine.record(room, 'pivot', { playerId: player.id, dir: direction });
    }
    return null;
  }
  const direction = player.dir || { x: 0, y: 1 };
  const facing = { c: player.gc + direction.x, r: player.gr + direction.y };
  const tile = engine.tileAt(room, facing.c, facing.r);
  if (!tile) return 'There is nothing to interact with in that direction.';
  const held = heldItem(room, player);

  if (key === ' ') {
    if (tile.type !== 'serve') return 'Serve requires the serving window directly ahead.';
    if (held?.kind !== 'plate') return 'Serve requires a plate in hand.';
    handlePlayerMessage(player, { type: 'serve-order', plateId: held.item.id });
    return agentSessionForPlayer(player)?.lastRejection || null;
  }

  if (key === 'q') {
    if (!held) return 'Throw requires an item or plate in hand.';
    const target = macroThrowTarget(room, player);
    if (!target) return 'Throw has nowhere clear to land.';
    let droppedItem;
    if (held.kind === 'plate') {
      if (held.item.contents.length) {
        const contents = plateIngredient(held.item.contents.pop());
        droppedItem = contents.item;
        if (contents.item === 'bun') room.buns.push({ id: room.nextBunId++, holderId: null, ...target });
        else { const ingredient = rawIngredient(contents.item, null, target.c, target.r); ingredient.id = room.nextIngredientId++; ingredient.chopped = contents.chopped; ingredient.cookedSides = contents.cookedSides; room.ingredients.push(ingredient); }
      } else { droppedItem = 'plate'; held.item.holderId = null; held.item.c = target.c; held.item.r = target.r; }
    } else { droppedItem = held.kind === 'bun' ? 'bun' : held.item.item; held.item.holderId = null; held.item.c = target.c; held.item.r = target.r; }
    const session = agentSessionForPlayer(player);
    if (session) session.lastActionDetails = { droppedItem, droppedAt: target };
    return null;
  }

  if (key !== 'e') return 'Unknown macro key.';
  const crateIngredient = tile.type.startsWith('crate_') ? tile.type.slice('crate_'.length) : null;
  const stationIngredient = room.ingredients.find(item => item.holderId === null && item.c === facing.c && item.r === facing.r && item.station === tile.type);
  const floorIngredient = room.ingredients.find(item => item.holderId === null && item.c === facing.c && item.r === facing.r && !item.station);
  const floorBun = room.buns.find(item => item.holderId === null && item.c === facing.c && item.r === facing.r);
  const floorPlate = room.plates.find(item => item.holderId === null && item.c === facing.c && item.r === facing.r);
  if (!held && crateIngredient && stageProduce(room).includes(crateIngredient)) { const ingredient = rawIngredient(crateIngredient, player.id); ingredient.id = room.nextIngredientId++; room.ingredients.push(ingredient); return null; }
  if (held?.kind === 'plate' && crateIngredient === 'bun') { held.item.contents.push(plateIngredient('bun')); return null; }
  if (held?.kind === 'plate' && crateIngredient && stageProduce(room).includes(crateIngredient)) { held.item.contents.push(plateIngredient(crateIngredient)); return null; }
  if (!held && tile.type === 'crate_bun') { room.buns.push({ id: room.nextBunId++, holderId: player.id, c: null, r: null }); return null; }
  if (held?.kind === 'ingredient' && ['board', 'stove'].includes(tile.type) && !objectAt(room, facing.c, facing.r)) { held.item.holderId = null; held.item.c = facing.c; held.item.r = facing.r; held.item.station = tile.type; return null; }
  if (held?.kind === 'plate' && stationIngredient) { held.item.contents.push(plateIngredient(stationIngredient)); room.ingredients.splice(room.ingredients.indexOf(stationIngredient), 1); return null; }
  if (!held && stationIngredient) {
    if ((stationIngredient.station === 'board' && ['tomato', 'lettuce', 'pickle'].includes(stationIngredient.item) && !stationIngredient.chopped) || (stationIngredient.station === 'stove' && stationIngredient.item === 'chicken' && stationIngredient.cookedSides < 1)) {
      if (stationIngredient.processing) return 'That ingredient is already being prepared.';
      stationIngredient.processing = stationIngredient.station === 'board' ? 'chop' : 'grill'; stationIngredient.processStartedAt = Date.now(); stationIngredient.processEndsAt = stationIngredient.processStartedAt + PREPARATION_MS; return null;
    }
    stationIngredient.holderId = player.id; stationIngredient.c = null; stationIngredient.r = null; stationIngredient.station = null; return null;
  }
  if (held?.kind === 'plate' && (floorIngredient || floorBun)) {
    if (floorIngredient) { held.item.contents.push(plateIngredient(floorIngredient)); room.ingredients.splice(room.ingredients.indexOf(floorIngredient), 1); }
    else { held.item.contents.push(plateIngredient('bun')); room.buns.splice(room.buns.indexOf(floorBun), 1); }
    return null;
  }
  if (!held && floorIngredient) { floorIngredient.holderId = player.id; floorIngredient.c = null; floorIngredient.r = null; return null; }
  if (!held && floorBun) { floorBun.holderId = player.id; floorBun.c = null; floorBun.r = null; return null; }
  if (!held && tile.type === 'plates') { room.plates.push({ id: room.nextPlateId++, holderId: player.id, c: null, r: null, contents: [] }); return null; }
  if (!held && floorPlate) { floorPlate.holderId = player.id; floorPlate.c = null; floorPlate.r = null; return null; }
  if (held?.kind === 'plate' && tile.type === 'trash') { room.plates.splice(room.plates.indexOf(held.item), 1); return null; }
  if (held && tile.type === 'floor' && !objectAt(room, facing.c, facing.r)) { held.item.holderId = null; held.item.c = facing.c; held.item.r = facing.r; return null; }
  return 'Interact had no available effect on the tile ahead.';
}

function isThrowTarget(room, player, c, r) {
  const distance = Math.abs(c - player.gc) + Math.abs(r - player.gr);
  return distance >= 1 && distance <= 3 && (c === player.gc || r === player.gr) && engine.isDropTile(room, c, r);
}

function macroReference(room, step) {
  if (typeof step !== 'string') return null;
  if (step.startsWith('macro:')) return room.macros.find(macro => macro.id === step.slice(6)) || null;
  return room.macros.find(macro => macro.shortcut === step) || null;
}

function expandMacro(room, macro, seen = new Set()) {
  if (!macro || seen.has(macro.id)) return null;
  const nextSeen = new Set(seen).add(macro.id);
  const expanded = [];
  for (const step of macro.sequence) {
    if (MACRO_BASIC_KEYS.has(step)) { expanded.push(step); continue; }
    const child = macroReference(room, step);
    if (!child) return null;
    const childSteps = expandMacro(room, child, nextSeen);
    if (!childSteps) return null;
    expanded.push(...childSteps);
  }
  return expanded;
}

function heldItem(room, player) {
  const plate = room.plates.find(item => item.holderId === player.id);
  if (plate) return { kind: 'plate', item: plate };
  const ingredient = room.ingredients.find(item => item.holderId === player.id);
  if (ingredient) return { kind: 'ingredient', item: ingredient };
  const bun = room.buns.find(item => item.holderId === player.id);
  return bun ? { kind: 'bun', item: bun } : null;
}

function macroThrowTarget(room, player) {
  const direction = player.dir?.x || player.dir?.y ? player.dir : { x: 0, y: 1 };
  let target = null;
  for (let distance = 1; distance <= 3; distance += 1) {
    const c = player.gc + direction.x * distance, r = player.gr + direction.y * distance;
    if (!engine.isDropTile(room, c, r) || (room.stage >= 2 && objectAt(room, c, r))) break;
    target = { c, r };
  }
  return target;
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
    room = engine.createRoom(makeRoomId());
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
  console.log(`[${room.id}] ${name} joined the kitchen! (${room.players.length}/${MAX_PLAYERS})`);
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

function handlePlayerMessage(player, message) {
    const ws = player?.ws;
    if (!player?.room) return send(ws, { type: 'error', message: 'Join a room first.' });
    const room = player.room;
    if (room.status === 'finished') return;
    if (message.type !== 'player-state') engine.record(room, 'command', { playerId: player.id, command: message.type });
    if (message.type === 'notepad-open') {
      const session = agentSessionForPlayer(player);
      if (session) { session.notepadOpen = true; room.researcherPanel = { kind: 'notes', agentId: player.id, brand: player.name }; }
      console.log(`[${room.id}] ${player.name} opened the handover notepad.`);
      return broadcastRoom(room);
    }
    if (message.type === 'notepad-close') {
      const session = agentSessionForPlayer(player);
      if (session) {
        session.notepadOpen = false;
        if (room.researcherPanel?.kind === 'notes' && room.researcherPanel.agentId === player.id) room.researcherPanel = null;
      }
      return broadcastRoom(room);
    }
    if (message.type === 'macros-open') {
      const session = agentSessionForPlayer(player);
      if (session) { session.macrosOpen = true; room.researcherPanel = { kind: 'macros', agentId: player.id, brand: player.name }; }
      return broadcastRoom(room);
    }
    if (message.type === 'macros-close') {
      const session = agentSessionForPlayer(player);
      if (session) {
        session.macrosOpen = false;
        if (room.researcherPanel?.kind === 'macros' && room.researcherPanel.agentId === player.id) room.researcherPanel = null;
      }
      return broadcastRoom(room);
    }
    if (message.type === 'notepad-save') {
      const text = String(message.text || '').trim().slice(0, 10000);
      const session = agentSessionForPlayer(player);
      if (session && !session.notepadOpen) return reject(player, 'Open the handover notepad before saving it.');
      if (text === room.notepad.text) return reject(player, 'Nothing changed in the notepad.');
      room.notepad = { text, author: player.name, updatedAt: Date.now(), revision: room.notepad.revision + 1 };
      if (session) database.saveKnowledge(session.experimentId, player.id, 'notepad-save', room.notepad);
      if (session) database.saveNotepadRevision(session.experimentId, player, room.stage, room.notepad);
      console.log(`[${room.id}] ${player.name} saved handover notepad revision ${room.notepad.revision}.`);
      return broadcastRoom(room);
    }
    if (message.type === 'agent-key') {
      const failure = runMacroKey(room, player, message.key);
      if (failure) return reject(player, failure);
      return broadcastRoom(room);
    }
    if (message.type === 'macro-run') {
      const session = agentSessionForPlayer(player);
      const shortcut = String(message.shortcut || '').toLowerCase();
      const macro = room.macros.find(item => item.shortcut === shortcut);
      if (!session || !macro) return reject(player, 'That macro shortcut is not available.');
      const sequence = expandMacro(room, macro);
      if (!sequence) return reject(player, 'This macro has a missing or circular macro reference.');
      finishMacroRun(player, true);
      session.macroRunId = database.startMacroRun(session.experimentId, player, room.stage, macro);
      for (let index = 0; index < sequence.length; index += 1) {
        const key = sequence[index];
        const failure = runMacroKey(room, player, key);
        if (failure) { session.macroFailure = { blockedStep: index + 1 }; return reject(player, failure); }
      }
      finishMacroRun(player, false);
      console.log(`[${room.id}] ${player.name} ran macro ${macro.name} (${macro.shortcut.toUpperCase()}).`);
      return broadcastRoom(room);
    }
    if (message.type === 'macro-create') {
      const session = agentSessionForPlayer(player);
      if (!session?.macrosOpen) return reject(player, 'Open the macro panel before creating a macro.');
      return handlePlayerMessage(player, { type: 'macros-sync', macros: [...room.macros, message.macro] });
    }
    if (message.type === 'macro-edit') {
      const session = agentSessionForPlayer(player);
      const id = String(message.id || '');
      const existing = room.macros.find(macro => macro.id === id);
      if (!session?.macrosOpen) return reject(player, 'Open the macro panel before editing a macro.');
      if (!existing) return reject(player, 'That macro is not available.');
      const replacement = { ...existing, ...message.macro, id };
      return handlePlayerMessage(player, { type: 'macros-sync', macros: room.macros.map(macro => macro.id === id ? replacement : macro) });
    }
    if (message.type === 'macro-delete') {
      const session = agentSessionForPlayer(player);
      const id = String(message.id || '');
      if (!session?.macrosOpen) return reject(player, 'Open the macro panel before deleting a macro.');
      if (!room.macros.some(macro => macro.id === id)) return reject(player, 'That macro is not available.');
      return handlePlayerMessage(player, { type: 'macros-sync', macros: room.macros.filter(macro => macro.id !== id) });
    }
    if (message.type === 'macro-run-start') {
      const session = agentSessionForPlayer(player);
      const macro = room.macros.find(item => item.id === String(message.macroId || ''));
      if (!session) return;
      if (!macro) return reject(player, 'That macro is not available.');
      finishMacroRun(player, true);
      session.macroRunId = database.startMacroRun(session.experimentId, player, room.stage, macro);
      return;
    }
    if (message.type === 'macro-run-step') {
      if (message.action !== 'move' || !Number.isInteger(message.gc) || !Number.isInteger(message.gr)) return;
      if (!engine.isWalkable(room, message.gc, message.gr)) return reject(player, 'Macro movement is blocked.');
      return;
    }
    if (message.type === 'macro-run-finish') { finishMacroRun(player, false); return; }
    if (message.type === 'player-state') {
      if (!room.activePlayerIds.includes(player.id)) return;
      if (!engine.move(room, player, message)) {
        const nextDirection = message.dir && Number.isFinite(message.dir.x) && Number.isFinite(message.dir.y) ? { x: message.dir.x, y: message.dir.y } : null;
        const pivoted = nextDirection && (player.dir?.x !== nextDirection.x || player.dir?.y !== nextDirection.y);
        if (!pivoted) return reject(player, 'That movement is blocked.');
        player.dir = nextDirection;
        engine.record(room, 'pivot', { playerId: player.id, dir: nextDirection });
      }
      const { gc, gr, dir } = player;
      room.players.forEach(member => {
        if (member !== player) send(member.ws, { type: 'player-state', playerId: player.id, gc, gr, dir, holding: message.holding || null });
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
      if (bun?.holderId !== player.id || !Number.isInteger(c) || !Number.isInteger(r) || !isThrowTarget(room, player, c, r)) return;
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
      if (ingredient?.holderId !== player.id || !Number.isInteger(c) || !Number.isInteger(r) || !isThrowTarget(room, player, c, r)) return;
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
        if (ingredient.processing) return broadcastRoom(room);
        if (!ingredient.chopped) {
          ingredient.processing = 'chop'; ingredient.processStartedAt = Date.now(); ingredient.processEndsAt = ingredient.processStartedAt + PREPARATION_MS;
        }
        else { ingredient.holderId = player.id; ingredient.c = null; ingredient.r = null; ingredient.station = null; }
      } else if (ingredient.station === 'stove' && ingredient.item === 'chicken') {
        if (ingredient.processing) return broadcastRoom(room);
        if (ingredient.cookedSides < 1) {
          ingredient.processing = 'grill'; ingredient.processStartedAt = Date.now(); ingredient.processEndsAt = ingredient.processStartedAt + PREPARATION_MS;
        }
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
      if (plate?.holderId !== player.id || !Number.isInteger(c) || !Number.isInteger(r) || !isThrowTarget(room, player, c, r)) return;
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
      if (!plate || !plate.contents.length || !Number.isInteger(c) || !Number.isInteger(r) || objectAt(room, c, r)) return;
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
      const experiment = experimentForRoom(room);
      if (index < 0) {
        if (experiment) database.saveTicketEvent(experiment.experimentId, player, room.stage, { id: `unmatched-${Date.now()}`, name: 'Unmatched plate' }, 'failed_serve', 'recipe_mismatch');
        room.customerMessage = 'That is not what I ordered.'; return broadcastRoom(room);
      }
      const prepared = plate.contents.map(plateIngredient);
      const chicken = prepared.find(item => item.item === 'chicken');
      const tomato = prepared.find(item => item.item === 'tomato');
      const greens = prepared.find(item => item.item === (room.stage === 5 ? 'pickle' : 'lettuce'));
      const ticket = room.tickets[index];
      if (chicken && chicken.cookedSides < 1) { if (experiment) database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'failed_serve', 'chicken_not_grilled'); room.customerMessage = 'Chicken still smells, yuck!'; return broadcastRoom(room); }
      if (room.stage >= 2 && tomato && !tomato.chopped) { if (experiment) database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'failed_serve', 'tomato_not_chopped'); room.customerMessage = "Tomato still looks round. Can't fit that in a burger, can ya?"; return broadcastRoom(room); }
      if (room.stage >= 2 && greens && !greens.chopped) { if (experiment) database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'failed_serve', room.stage === 5 ? 'pickle_not_chopped' : 'lettuce_not_chopped'); room.customerMessage = room.stage === 5 ? 'Pickle slices are still too large to fit into a burger.' : 'Lettuce is still too large to fit into a burger.'; return broadcastRoom(room); }
      room.tickets.splice(index, 1); room.score += ticket.points;
      room.plates.splice(room.plates.indexOf(plate), 1);
      room.customerMessage = ':) Perfect — thank you!';
      if (experiment) { database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'served'); database.saveFirstSuccessfulServe(experiment.experimentId, player, room.stage); }
      console.log(`[${room.id}] ${player.name} served ${ticket.name} (+${ticket.points}).`); return broadcastRoom(room);
    }
    if (message.type === 'missed-add') {
      room.missed += 1; console.log(`[${room.id}] missed order (${room.missed}).`); return broadcastRoom(room);
    }
    if (message.type === 'macros-sync') {
      if (!Array.isArray(message.macros) || message.macros.length > 20) return;
      const previousMacros = new Map(room.macros.map(macro => [macro.id, macro]));
      const proposedMacros = message.macros.map(macro => ({ id: String(macro.id || ''), name: String(macro.name || '').slice(0, 40), shortcut: String(macro.shortcut || '').toLowerCase().slice(0, 1), sequence: Array.isArray(macro.sequence) ? macro.sequence.slice(0, 40).map(step => String(step)) : [] }));
      const session = agentSessionForPlayer(player);
      if (session && !session.macrosOpen) return reject(player, 'Open the macro panel before saving macros.');
      if (proposedMacros.some(macro => !macro.id || !macro.name || !/^[a-z]$/.test(macro.shortcut) || RESERVED_MACRO_SHORTCUTS.has(macro.shortcut) || !macro.sequence.length)) return reject(player, 'Each macro needs a name, an unused letter shortcut, and a non-empty sequence.');
      if (new Set(proposedMacros.map(macro => macro.id)).size !== proposedMacros.length || new Set(proposedMacros.map(macro => macro.shortcut)).size !== proposedMacros.length) return reject(player, 'Macro IDs and shortcut letters must be unique.');
      const candidateRoom = { ...room, macros: proposedMacros };
      if (proposedMacros.some(macro => !expandMacro(candidateRoom, macro))) return reject(player, 'A macro has an unknown shortcut, missing reference, or circular reference.');
      room.macros = proposedMacros;
      if (session) {
        database.saveKnowledge(session.experimentId, player.id, 'macros-sync', room.macros);
        const currentIds = new Set(room.macros.map(macro => macro.id));
        room.macros.forEach(macro => {
          const previous = previousMacros.get(macro.id);
          const changed = previous && JSON.stringify(previous) !== JSON.stringify(macro);
          if (!previous || changed) database.saveMacroRevision(session.experimentId, player, room.stage, macro, previous ? 'macro-edit' : 'macro-create');
        });
        previousMacros.forEach(macro => {
          if (!currentIds.has(macro.id)) database.saveMacroRevision(session.experimentId, player, room.stage, macro, 'macro-delete');
        });
      }
      console.log(`[${room.id}] ${player.name} updated shared macros.`); return broadcastRoom(room);
    }
    if (message.type === 'start-session') {
      if (room.hostId !== player.id) return send(ws, { type: 'error', message: 'Only the host can start the session.' });
      startSession(room, player);
      return broadcastRoom(room);
    }
}

function handleSocketMessage(ws, raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return send(ws, { type: 'error', message: 'Invalid message.' }); }
  if (message.type === 'join-room') return joinRoom(ws, message);
  return handlePlayerMessage(ws.player, message);
}

function researchToken(req) {
  return String(req.get('x-researcher-token') || req.get('authorization') || '').replace(/^Bearer\s+/i, '');
}

function requireResearcher(req, res, next) {
  if (researchToken(req) !== RESEARCHER_TOKEN) return res.status(401).json({ error: 'Researcher token required.' });
  next();
}

function agentToken(req) {
  return String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
}

function agentForRequest(req, res) {
  const session = agentTokens.get(agentToken(req));
  if (!session) { res.status(401).json({ error: 'Valid agent token required.' }); return null; }
  return session;
}

function safeBrand(value) {
  const brand = String(value || '').trim().slice(0, 24);
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(brand) ? brand : null;
}

function transcriptPaths(experimentId, brand) {
  const directory = path.join(RUNS_DIR, experimentId);
  const slug = brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  return { directory, events: path.join(directory, 'events.jsonl'), agentJsonl: path.join(directory, `${slug}.jsonl`), agentText: path.join(directory, `${slug}.txt`) };
}

function recordAgentEvent(session, kind, data) {
  const event = { at: new Date().toISOString(), experimentId: session.experimentId, agentId: session.player.id, brand: session.brand, kind, data };
  const experiment = experiments.get(session.experimentId);
  if (experiment) {
    experiment.researchEvents ||= [];
    experiment.researchEvents.push(event);
    if (experiment.researchEvents.length > 300) experiment.researchEvents.shift();
  }
  const paths = transcriptPaths(session.experimentId, session.brand);
  fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`);
  fs.appendFileSync(paths.agentJsonl, `${JSON.stringify(event)}\n`);
  database.saveAgentEvent(event);
  const summary = kind === 'act'
    ? `${event.at} ACT ${data.action}${data.accepted ? '' : ` rejected: ${data.reason}`}`
    : kind === 'reasoning'
      ? `${event.at} REACT ${data.summary}`
      : `${event.at} OBSERVE stage ${data.observation.stage.id} (${data.observation.status})`;
  fs.appendFileSync(paths.agentText, `${summary}\n`);
}

function agentObservation(session) {
  const { room, player } = session;
  const slot = room.schedule.find(item => item.playerId === player.id);
  const turnIndex = room.schedule.indexOf(slot);
  const now = Date.now();
  return {
    experimentId: session.experimentId,
    brand: session.brand,
    status: room.status,
    turn: { number: turnIndex >= 0 ? turnIndex + 1 : null, total: room.schedule.length, active: room.activePlayerIds.includes(player.id), startsAt: slot?.startAt || null, endsAt: slot?.endAt || null, remainingMs: slot ? Math.max(0, slot.endAt - now) : 0 },
    stage: { id: room.stage, name: STAGES[room.stage]?.name || 'Stage', bridgeRow: bridgeRow(room, now) },
    self: { id: player.id, position: { c: player.gc, r: player.gr }, direction: player.dir || null, holding: (() => { const held = heldItem(room, player); return !held ? null : held.kind === 'plate' ? { kind: 'plate', contents: held.item.contents.map(plateIngredient) } : { kind: held.kind, item: held.kind === 'bun' ? 'bun' : held.item.item }; })() },
    players: room.players.map(({ id, name, gc, gr }) => ({ id, name, position: { c: gc, r: gr } })),
    map: engine.map(room, now), tickets: room.stage >= 3 ? room.tickets.map(({ needs, displayNeeds, ...ticket }) => ticket) : room.tickets,
    world: { buns: room.buns, ingredients: room.ingredients, plates: room.plates },
    score: room.score, missed: room.missed, customerMessage: room.customerMessage || '',
    lastActionResult: session.lastActionResult || null,
    notepad: session.notepadOpen ? room.notepad : { author: room.notepad.author, updatedAt: room.notepad.updatedAt, revision: room.notepad.revision }, macros: session.macrosOpen ? room.macros : room.macros.map(({ id, name, shortcut }) => ({ id, name, shortcut })),
    panelGuidance: {
      notepad: session.notepadOpen ? {
        purpose: 'Read inherited discoveries and write a concise accurate handover for the next LLM.',
        actions: 'openNotepad reads; saveNotepad replaces the document only with changed text; closeNotepad ends the controlled session but does not erase saved text.',
        persists: 'The complete saved text, author, and revision persist to the next agent. Physical kitchen state does not.',
      } : null,
      macros: session.macrosOpen ? {
        purpose: 'Inspect, create, edit, delete, and run reusable saved sequences.',
        naming: 'Use an intent-based name such as "Get plate from spawn." Put coordinate and held-item preconditions in the handover notepad, not the macro name.',
        createExample: { action: 'createMacro', macro: { id: 'spawn-to-plate', name: 'Get plate from spawn', shortcut: 't', sequence: ['w', 'w', 'e'] } },
        editExample: { action: 'editMacro', id: 'spawn-to-plate', macro: { name: 'Get plate from spawn', shortcut: 't', sequence: ['w', 'w', 'e'] } },
        deleteExample: { action: 'deleteMacro', id: 'spawn-to-plate' },
        sequences: 'Use w, a, s, d, q, e, space, or another saved macro shortcut. Shortcut letters are unique; W/A/S/D/Q/E are reserved. A shortcut inside a sequence calls that saved macro.',
        runExample: { action: 'runMacro', shortcut: 't' },
      } : null,
    },
    availableActions: ['move', 'interact', 'throw', 'serve', 'openNotepad', 'closeNotepad', 'saveNotepad', 'openMacros', 'closeMacros', 'createMacro', 'editMacro', 'deleteMacro', 'runMacro'],
  };
}

function toGameMessage(player, action, input = {}) {
  const common = { ...input };
  delete common.action;
  switch (action) {
    case 'move': {
      const directions = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const vector = directions[input.direction];
      if (!vector) return null;
      return { type: 'player-state', gc: player.gc + vector[0], gr: player.gr + vector[1], dir: { x: vector[0], y: vector[1] } };
    }
    case 'interact': return { type: 'agent-key', key: 'e' };
    case 'throw': return { type: 'agent-key', key: 'q' };
    case 'serve': return { type: 'agent-key', key: ' ' };
    case 'pickupBun': return { ...common, type: 'bun-pick' };
    case 'dropBun': return { ...common, type: 'bun-drop' };
    case 'pickupIngredient': return { ...common, type: 'ingredient-pick' };
    case 'dropIngredient': return { ...common, type: 'ingredient-drop' };
    case 'placeIngredient': return { ...common, type: 'ingredient-place-station' };
    case 'processIngredient': return { ...common, type: 'ingredient-process' };
    case 'takePlate': return { ...common, type: 'plate-create' };
    case 'pickupPlate': return { ...common, type: 'plate-pick' };
    case 'dropPlate': return { ...common, type: 'plate-drop' };
    case 'discardPlate': return { ...common, type: 'plate-delete' };
    case 'addToPlate': return { ...common, type: 'plate-add' };
    case 'addFloorItemToPlate': return { ...common, type: 'plate-add-floor-item' };
    case 'addStationItemToPlate': return { ...common, type: 'plate-add-station-item' };
    case 'removePlateItem': return { ...common, type: 'plate-remove-item' };
    case 'serve': return { type: 'agent-key', key: ' ' };
    case 'openNotepad': return { ...common, type: 'notepad-open' };
    case 'closeNotepad': return { ...common, type: 'notepad-close' };
    case 'saveNotepad': return { ...common, type: 'notepad-save' };
    case 'openMacros': return { ...common, type: 'macros-open' };
    case 'closeMacros': return { ...common, type: 'macros-close' };
    case 'saveMacros': return { ...common, type: 'macros-sync' };
    case 'createMacro': return { ...common, type: 'macro-create' };
    case 'editMacro': return { ...common, type: 'macro-edit' };
    case 'deleteMacro': return { ...common, type: 'macro-delete' };
    case 'runMacro': return { ...common, type: 'macro-run' };
    case 'startMacroRun': return { ...common, type: 'macro-run-start' };
    case 'macroMoveStep': return { ...common, type: 'macro-run-step' };
    case 'finishMacroRun': return { ...common, type: 'macro-run-finish' };
    default: return null;
  }
}

function createExperiment(brands, options = {}) {
  const room = engine.createRoom(makeRoomId());
  const experimentId = `EXP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const directory = path.join(RUNS_DIR, experimentId);
  fs.mkdirSync(directory, { recursive: true });
  const sessions = brands.map(brand => {
    const player = { id: nextPlayerId++, name: brand, room, agent: true, ws: null };
    room.players.push(player);
    const token = crypto.randomBytes(32).toString('hex');
    const session = { experimentId, brand, token, room, player };
    agentTokens.set(token, session);
    const paths = transcriptPaths(experimentId, brand);
    fs.writeFileSync(paths.agentText, `Kitchen Relay transcript — ${brand}\nExperiment: ${experimentId}\n\n`);
    return session;
  });
  room.hostId = room.players[0].id;
  room.turnPlan = options.turnPlan || TURN_PLAN;
  room.shiftSeconds = options.turnSeconds || SHIFT_SECONDS;
  room.ticketLifetimeMultiplier = options.ticketLifetimeMultiplier || 1;
  room.ticketArrivalMinSeconds = options.ticketArrivalMinSeconds || 9;
  room.ticketArrivalMaxSeconds = options.ticketArrivalMaxSeconds || 15;
  rooms.set(room.id, room);
  experiments.set(experimentId, { experimentId, room, sessions, createdAt: Date.now() });
  database.createExperiment(experimentId, room, sessions);
  console.log(`[${room.id}] experiment ${experimentId} created.`);
  brands.forEach(brand => console.log(`[${room.id}] ${brand} joined the kitchen!`));
  startSession(room, room.players[0]);
  database.saveTurns(experimentId, room.schedule);
  database.saveRoom(experimentId, room);
  return { experimentId, room, sessions };
}

app.post('/api/researcher/experiments', requireResearcher, (req, res) => {
  const requested = Array.isArray(req.body?.agents) ? req.body.agents : ['Codex', 'Claude', 'Gemini', 'DeepSeek'];
  const brands = requested.map(safeBrand);
  if (!brands.length || brands.length > MAX_PLAYERS || brands.some(brand => !brand) || new Set(brands.map(brand => brand.toLowerCase())).size !== brands.length) {
    return res.status(400).json({ error: 'Provide 1–4 unique agent brands using letters, numbers, spaces, dots, hyphens, or underscores.' });
  }
  const mode = String(req.body?.mode || 'full-study');
  if (!['full-study', 'stage1-handover-pilot'].includes(mode)) return res.status(400).json({ error: 'mode must be "full-study" or "stage1-handover-pilot".' });
  if (mode === 'stage1-handover-pilot' && brands.length !== 2) return res.status(400).json({ error: 'The Stage 1 handover pilot requires exactly two agents.' });
  const requestedSeconds = req.body?.turnSeconds;
  const turnSeconds = requestedSeconds === undefined ? SHIFT_SECONDS : Number(requestedSeconds);
  if (!Number.isInteger(turnSeconds) || turnSeconds < 15 || turnSeconds > 3600) return res.status(400).json({ error: 'turnSeconds must be a whole number from 15 to 3600.' });
  const ticketLifetimeMultiplier = Number(req.body?.ticketLifetimeMultiplier ?? 1);
  const ticketArrivalMinSeconds = Number(req.body?.ticketArrivalMinSeconds ?? 9);
  const ticketArrivalMaxSeconds = Number(req.body?.ticketArrivalMaxSeconds ?? 15);
  if (!Number.isFinite(ticketLifetimeMultiplier) || ticketLifetimeMultiplier < 1 || ticketLifetimeMultiplier > 10 || !Number.isFinite(ticketArrivalMinSeconds) || !Number.isFinite(ticketArrivalMaxSeconds) || ticketArrivalMinSeconds < 1 || ticketArrivalMaxSeconds < ticketArrivalMinSeconds || ticketArrivalMaxSeconds > 120) return res.status(400).json({ error: 'Invalid ticket pacing configuration.' });
  const experiment = createExperiment(brands, { turnPlan: mode === 'stage1-handover-pilot' ? STAGE_ONE_HANDOVER_PLAN : TURN_PLAN, turnSeconds, ticketLifetimeMultiplier, ticketArrivalMinSeconds, ticketArrivalMaxSeconds });
  const configurations = Array.isArray(req.body?.agentConfigurations) ? req.body.agentConfigurations : [];
  configurations.forEach(configuration => {
    const session = experiment.sessions.find(item => item.brand === safeBrand(configuration?.brand));
    if (!session) return;
    const provider = String(configuration.provider || 'unknown').trim().slice(0, 40) || 'unknown';
    const model = String(configuration.model || 'unknown').trim().slice(0, 100) || 'unknown';
    const temperature = Number.isFinite(Number(configuration.temperature)) ? Number(configuration.temperature) : null;
    const promptVersion = String(configuration.promptVersion || 'runner-v1').trim().slice(0, 100) || 'runner-v1';
    database.saveAgentConfiguration(experiment.experimentId, session.player, { provider, model, temperature, promptVersion });
  });
  return res.status(201).json({ experimentId: experiment.experimentId, roomId: experiment.room.id, agents: experiment.sessions.map(session => ({ brand: session.brand, token: session.token })) });
});

app.get('/api/agent/observe', (req, res) => {
  const session = agentForRequest(req, res);
  if (!session) return;
  const observation = agentObservation(session);
  recordAgentEvent(session, 'observe', { observation });
  return res.json({ observation });
});

app.post('/api/agent/act', (req, res) => {
  const session = agentForRequest(req, res);
  if (!session) return;
  const request = { ...(req.body || {}) };
  const reasoningSummary = String(request.reasoningSummary || '').trim().slice(0, 1000);
  const actions = Array.isArray(request.actions) ? request.actions : [request];
  if (!actions.length || actions.length > 8 || actions.some(action => !action || typeof action !== 'object')) return res.status(400).json({ error: 'Provide one to eight action objects.' });
  if (reasoningSummary) recordAgentEvent(session, 'reasoning', { summary: reasoningSummary });
  const steps = [];
  for (let index = 0; index < actions.length; index += 1) {
    const input = { ...actions[index] };
    const action = String(input.action || '');
    delete input.reasoningSummary;
    const message = toGameMessage(session.player, action, input);
    if (!message) { steps.push({ step: index + 1, action, outcome: 'rejected', reason: 'Unknown action.' }); break; }
    if (!session.room.activePlayerIds.includes(session.player.id) && !['openNotepad', 'closeNotepad', 'openMacros', 'closeMacros'].includes(action)) { steps.push({ step: index + 1, action, outcome: 'waiting', reason: 'This agent is not in an active turn.' }); break; }
    const digest = () => JSON.stringify({ p: { gc: session.player.gc, gr: session.player.gr, dir: session.player.dir }, buns: session.room.buns, ingredients: session.room.ingredients, plates: session.room.plates, tickets: session.room.tickets, score: session.room.score, missed: session.room.missed, notepad: session.room.notepad, macros: session.room.macros, panel: session.room.researcherPanel });
    const before = digest();
    session.lastRejection = null;
    session.macroFailure = null;
    session.lastActionDetails = null;
    handlePlayerMessage(session.player, message);
    const reason = session.lastRejection || null;
    const after = digest();
    const outcome = reason ? (action === 'runMacro' ? 'blocked' : 'rejected') : (before === after ? 'no_effect' : 'succeeded');
    const macroFailure = action === 'runMacro' && outcome === 'blocked' ? { blockedStep: session.macroFailure?.blockedStep || null } : {};
    steps.push({ step: index + 1, action, outcome, ...(reason ? { reason } : {}), ...macroFailure });
    if (outcome !== 'succeeded') break;
  }
  const finalStep = steps.at(-1);
  session.lastActionResult = { action: actions.length === 1 ? finalStep.action : 'plan', outcome: finalStep.outcome, ...(finalStep.reason ? { reason: finalStep.reason } : {}), ...(finalStep.blockedStep ? { blockedStep: finalStep.blockedStep } : {}), ...(session.lastActionDetails || {}), executedSteps: steps.length, plannedSteps: actions.length };
  const observation = agentObservation(session);
  database.saveRoom(session.experimentId, session.room);
  recordAgentEvent(session, 'act', { action: actions.length === 1 ? finalStep.action : 'plan', input: { actions }, accepted: finalStep.outcome === 'succeeded', reason: finalStep.reason || null, steps, observation });
  return res.status(finalStep.outcome === 'succeeded' ? 200 : 409).json({ accepted: finalStep.outcome === 'succeeded', steps, observation });
});

app.get('/api/researcher/experiments', requireResearcher, (req, res) => {
  return res.json({ experiments: [...experiments.values()].map(({ experimentId, room, createdAt }) => ({ experimentId, roomId: room.id, status: room.status, stage: room.stage, score: room.score, missed: room.missed, createdAt })) });
});

app.get('/api/researcher/experiments/:experimentId', requireResearcher, (req, res) => {
  const experiment = experiments.get(req.params.experimentId);
  if (!experiment) return res.status(404).json({ error: 'Experiment not found.' });
  const { room, sessions, experimentId, createdAt } = experiment;
  const activeSlotIndex = room.schedule.findIndex(slot => room.activePlayerIds.includes(slot.playerId));
  const activeSlot = room.schedule[activeSlotIndex] || null;
  const activePlayer = room.players.find(player => player.id === activeSlot?.playerId) || null;
  const researchEvents = experiment.researchEvents || [];
  const savedActions = researchEvents.flatMap(event => {
    if (event.kind !== 'act') return [];
    if (event.data.action === 'saveNotepad' || event.data.action === 'saveMacros') return [{ event, input: event.data.input }];
    return (event.data.input?.actions || []).filter(action => action.action === 'saveNotepad' || action.action === 'saveMacros').map(input => ({ event, input }));
  });
  const panelEvents = {
    notes: savedActions.filter(({ input }) => input.action === 'saveNotepad').map(({ event, input }) => ({ at: event.at, brand: event.brand, text: input.text })),
    macros: savedActions.filter(({ input }) => input.action === 'saveMacros').map(({ event, input }) => ({ at: event.at, brand: event.brand, macros: input.macros })),
    react: researchEvents.filter(event => event.kind === 'reasoning').map(event => ({ at: event.at, brand: event.brand, summary: event.data.summary })),
  };
  const holding = activePlayer ? heldItem(room, activePlayer) : null;
  const heldSummary = !holding ? null : holding.kind === 'plate'
    ? { kind: 'plate', contents: holding.item.contents.map(plateIngredient) }
    : { kind: holding.kind, item: holding.kind === 'ingredient' ? plateIngredient(holding.item) : { item: 'bun' } };
  const events = room.eventLog.slice(-100).map(event => ({ ...event, playerName: room.players.find(player => player.id === event.playerId)?.name || null }));
  return res.json({ experimentId, roomId: room.id, createdAt, status: room.status, stage: room.stage, score: room.score, missed: room.missed, customerMessage: room.customerMessage || '', turn: activeSlot ? { number: activeSlotIndex + 1, agent: activePlayer?.name || 'Agent', endsAt: activeSlot.endAt, remainingMs: Math.max(0, activeSlot.endAt - Date.now()) } : null, players: activePlayer ? [{ id: activePlayer.id, name: activePlayer.name, position: { c: activePlayer.gc, r: activePlayer.gr } }] : [], activeHolding: heldSummary, map: engine.map(room), notes: room.notepad.text ? [room.notepad] : [], notepad: room.notepad, macros: room.macros, tickets: room.stage >= 3 ? room.tickets.map(({ needs, displayNeeds, ...ticket }) => ticket) : room.tickets, world: { buns: room.buns, ingredients: room.ingredients, plates: room.plates }, researcherPanel: room.researcherPanel, research: panelEvents, events, transcripts: { eventsJsonl: path.relative(__dirname, transcriptPaths(experimentId, sessions[0].brand).events) } });
});

wss.on('connection', ws => {
  send(ws, { type: 'connected' });
  ws.on('message', raw => handleSocketMessage(ws, raw));
  ws.on('close', () => leaveRoom(ws.player));
  ws.on('error', err => console.error('WebSocket error:', err.message));
});

function broadcastEvent(room, message) { room.players.forEach(player => send(player.ws, message)); }

function loadStage(room, stageId, now = Date.now()) {
  engine.resetStage(room, stageId, now);
  room.researcherPanel = null;
  [...agentTokens.values()].filter(session => session.room === room).forEach(session => { session.notepadOpen = false; session.macrosOpen = false; });
  const experiment = experimentForRoom(room);
  if (experiment) database.saveRoom(experiment.experimentId, room);
  console.log(`[${room.id}] loaded ${STAGES[stageId].name}.`);
}

function updateTickets(room, now) {
  if (!room.nextTicketAt) room.nextTicketAt = now + 5000;
  if (now >= room.nextTicketAt && room.tickets.length < 4) {
    const recipe = engine.nextRecipe(room);
    const ticket = { ...recipe, id: `${now}-${Math.random()}`, expiresAt: now + recipe.time * (room.ticketLifetimeMultiplier || 1) * 1000 };
    room.tickets.push(ticket);
    const experiment = experimentForRoom(room);
    const player = room.players.find(member => room.activePlayerIds.includes(member.id));
    if (experiment && player) database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'issued', null, now);
    const minimum = room.ticketArrivalMinSeconds || 9;
    const maximum = room.ticketArrivalMaxSeconds || 15;
    room.nextTicketAt = now + (minimum + Math.random() * (maximum - minimum)) * 1000;
  }
  const remaining = room.tickets.filter(ticket => ticket.expiresAt <= now);
  if (remaining.length) {
    const experiment = experimentForRoom(room);
    const player = room.players.find(member => room.activePlayerIds.includes(member.id));
    if (experiment && player) remaining.forEach(ticket => database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'expired', null, now));
    room.missed += remaining.length; room.tickets = room.tickets.filter(ticket => ticket.expiresAt > now);
  }
}
function updateIngredientTimers(room, now) {
  room.ingredients.forEach(ingredient => {
    if (!ingredient.processing || ingredient.processEndsAt > now) return;
    if (ingredient.processing === 'chop') {
      ingredient.chopped = true; room.customerMessage = 'The ingredient looks different now.';
    } else if (ingredient.processing === 'grill') {
      ingredient.cookedSides += 1;
      room.customerMessage = 'The chicken looks grilled now.';
    }
    ingredient.processing = null; ingredient.processStartedAt = null; ingredient.processEndsAt = null;
  });
}
function advanceRoom(room) {
  const now = Date.now();
  updateIngredientTimers(room, now);
  updateTickets(room, now);
  room.schedule.forEach(slot => {
    const player = room.players.find(member => member.id === slot.playerId);
    if (player && !slot.warned && now >= slot.startAt - WARNING_SECONDS * 1000 && slot.startAt > room.startedAt) {
      slot.warned = true;
      console.log(`[${room.id}] warning: ${player.name} enters in one minute.`);
      broadcastEvent(room, { type: 'handover-warning', playerId: player.id, playerName: player.name, startsAt: slot.startAt });
    }
    if (player && !slot.entered && now >= slot.startAt && now < slot.endAt) {
      // Every scheduled turn starts from a fresh physical kitchen. Handover knowledge lives separately in room.notepad and room.macros.
      loadStage(room, slot.stageId, now);
      engine.admit(room, player);
      slot.entered = true; room.activePlayerIds.push(player.id);
      const experiment = experimentForRoom(room);
      if (experiment) { database.activateTurn(experiment.experimentId, slot, room); database.saveRoom(experiment.experimentId, room); }
      console.log(`[${room.id}] ${player.name} entered the kitchen.`);
      send(player.ws, { type: 'enter-game', roomId: room.id }); broadcastRoom(room);
    }
    if (!slot.ended && now >= slot.endAt) {
      slot.ended = true; room.activePlayerIds = room.activePlayerIds.filter(id => id !== slot.playerId);
      const experiment = experimentForRoom(room);
      if (experiment) { database.endTurn(experiment.experimentId, slot, room); database.saveRoom(experiment.experimentId, room); }
      if (player) send(player.ws, { type: 'shift-ended' });
      broadcastRoom(room);
    }
  });
  broadcastRoom(room);
  if (room.schedule.length && room.schedule.every(slot => slot.ended)) {
    clearInterval(room.timer); room.status = 'finished';
    const experiment = experimentForRoom(room);
    if (experiment) database.saveRoom(experiment.experimentId, room);
    broadcastEvent(room, { type: 'session-finished' }); broadcastRoom(room);
  }
}
function startSession(room, host) {
  if (room.status !== 'waiting') return;
  room.status = 'active'; room.startedAt = Date.now(); room.activePlayerIds = [];
  room.schedule = (room.turnPlan || TURN_PLAN).filter(turn => room.players[turn.playerIndex]).map((turn, index) => {
    const startAt = room.startedAt + index * room.shiftSeconds * 1000;
    return { playerId: room.players[turn.playerIndex].id, stageId: turn.stageId, startAt, endAt: startAt + room.shiftSeconds * 1000, warned: index === 0, entered: false, ended: false };
  });
  console.log(`[${room.id}] session started by ${host.name}; ${room.players[0].name} is first.`);
  advanceRoom(room);
  // Short ticks keep preparation completion close to the visible 1.5s arc.
  room.timer = setInterval(() => advanceRoom(room), 250);
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
