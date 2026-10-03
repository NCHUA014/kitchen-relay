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
const HANDOVER_SECONDS = 120;
const PREPARATION_MS = 1500;
const STAGE_FIVE_COOKED_MS = 15000;
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
const STAGES_ONE_AND_TWO_PLAN = Object.freeze([
  { playerIndex: 0, stageId: 1 },
  { playerIndex: 0, stageId: 2 },
]);
const STAGES_ONE_TO_THREE_PLAN = Object.freeze([
  { playerIndex: 0, stageId: 1 },
  { playerIndex: 0, stageId: 2 },
  { playerIndex: 1, stageId: 3 },
]);
const MACRO_BASIC_KEYS = new Set(['w', 'a', 's', 'd', "w'", "a'", "s'", "d'", 'q', 'e', ' ']);
const RESERVED_MACRO_SHORTCUTS = new Set(['w', 'a', 's', 'd', 'q', 'e']);
let nextPlayerId = 1;

function preparationFeedback(items) {
  const messages = items.map(item => item === 'chicken_burnt'
    ? 'Chicken is burnt. Please replace chicken. Be careful, the chicken may overcook!'
    : item === 'chicken' ? 'Chicken is uncooked.' : `${item[0].toUpperCase()}${item.slice(1)} is not chopped.`);
  const hasUnpreparedIngredient = items.some(item => item !== 'chicken_burnt');
  return `${messages.join(' ')}${hasUnpreparedIngredient ? ' To prepare ingredients, take them individually to corresponding preparation stations.' : ''}`;
}

function missingIngredientFeedback(room, contents) {
  if (room.stage !== 3) return 'That is not what I ordered.';
  const present = new Set(contents);
  const candidates = room.tickets
    .filter(ticket => ticket.kind !== 'handover')
    .map(ticket => {
      const missing = ticket.needs.filter(item => !present.has(item));
      const overlap = ticket.needs.filter(item => present.has(item)).length;
      return { ticket, missing, overlap };
    })
    .filter(candidate => candidate.overlap > 0 && candidate.missing.length > 0)
    .sort((left, right) => right.overlap - left.overlap || left.missing.length - right.missing.length);
  if (!candidates.length) return 'That is not what I ordered.';
  const missing = candidates[0].missing;
  return `This is not what I ordered! Missing ${missing.join(' and ')}.`;
}

function landmarkAppearance(type) {
  return {
    crate_tomato: 'tomato icon',
    crate_lettuce: 'lettuce icon',
    crate_pickle: 'pickle icon',
    crate_bun: 'bun icon',
    crate_chicken: 'raw chicken illustration',
    board: 'knife icon',
    stove: 'fire icon',
    plates: 'plate icon',
    serve: 'serving cloche and plate icons',
    trash: 'trash-bin icon',
  }[type] || null;
}

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

function turnSecondsForStage(room, stageId) {
  const configured = Number(room.turnSecondsByStage?.[stageId]);
  return Number.isInteger(configured) && configured >= 15 ? configured : room.shiftSeconds;
}

function handoverSecondsForStage(room, stageId) {
  const configured = Number(room.handoverSecondsByStage?.[stageId]);
  return Number.isInteger(configured) && configured >= 15 ? configured : HANDOVER_SECONDS;
}

function visibleTickets(room) {
  return room.tickets.map(({ needs, displayNeeds, ...ticket }) => {
    if (ticket.kind === 'handover') {
      return { ...ticket, displayNeeds: displayNeeds?.length ? displayNeeds : ['Observe environment carefully and give sufficient notes and macros for smooth handover to next agent.'] };
    }
    // `needs` is always server-only. Stage 1 exposes only its intended
    // player-facing recipe wording; later stages deliberately hide it.
    if (room.stage === 1) return { ...ticket, displayNeeds };
    // Chicken Burger is Stage 2's new ticket. Its modular wording teaches the
    // new requirement without exposing the authoritative ingredient list.
    if (room.stage === 2 && ticket.name === 'Chicken Burger') {
      return { ...ticket, displayNeeds, recipeVisibility: 'visible' };
    }
    // From Stage 2 onward, recipes are stable but deliberately undisclosed.
    // `needs` remains private server state for authoritative serve validation.
    if (room.stage >= 2) {
      return { ...ticket, displayNeeds: ['Recipe: hidden'], recipeVisibility: 'hidden' };
    }
    return ticket;
  });
}

function roomState(room, player) {
  return {
    type: 'room-state', roomId: room.id, status: room.status, hostId: room.hostId, activePlayerIds: room.activePlayerIds,
    you: player.id, maxPlayers: MAX_PLAYERS,
    players: room.players.map(({ id, name, gc, gr, dir }) => ({ id, name, gc, gr, dir })), notes: room.notepad.text ? [room.notepad] : [], notepad: room.notepad, macros: room.macros,
    stage: room.stage, stageName: STAGES[room.stage]?.name || 'Stage', bridgeRow: bridgeRow(room), customerMessage: room.customerMessage || '',
    map: engine.map(room),
    score: room.score, missed: room.missed, buns: room.buns, ingredients: room.ingredients, plates: room.plates,
    tickets: visibleTickets(room),
    schedule: room.schedule || [], serverNow: Date.now(),
  };
}

function broadcastRoom(room) {
  room.players.forEach(player => send(player.ws, roomState(room, player)));
}

function rawIngredient(item, holderId = null, c = null, r = null) {
  return { id: null, item, holderId, c, r, chopped: false, cooked: false, burnt: false, cookedAt: null, station: null, processing: null, processStartedAt: null, processEndsAt: null };
}

function plateIngredient(item) {
  return typeof item === 'string'
    ? { item, chopped: false, cooked: false, burnt: false, prepState: item === 'chicken' ? 'raw' : 'unprepared' }
    : {
      item: item.item,
      chopped: Boolean(item.chopped),
      cooked: Boolean(item.cooked),
      burnt: Boolean(item.burnt),
      prepState: item.item === 'chicken' ? (item.burnt ? 'burnt' : item.cooked ? 'cooked' : 'raw') : (item.chopped ? 'chopped' : 'unprepared'),
    };
}

function restoreIngredientPreparation(ingredient, contents) {
  ingredient.chopped = Boolean(contents.chopped);
  ingredient.cooked = Boolean(contents.cooked);
  ingredient.burnt = Boolean(contents.burnt);
}

function directionName(direction) {
  return ({ '0,-1': 'north', '0,1': 'south', '-1,0': 'west', '1,0': 'east' })[`${direction?.x || 0},${direction?.y || 0}`] || 'south';
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
  const pivotDirections = { "w'": [0, -1], "a'": [-1, 0], "s'": [0, 1], "d'": [1, 0] };
  if (pivotDirections[key]) {
    const [dc, dr] = pivotDirections[key];
    player.dir = { x: dc, y: dr };
    engine.record(room, 'pivot', { playerId: player.id, dir: player.dir });
    return null;
  }
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
        else { const ingredient = rawIngredient(contents.item, null, target.c, target.r); ingredient.id = room.nextIngredientId++; restoreIngredientPreparation(ingredient, contents); room.ingredients.push(ingredient); }
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
  if (held?.kind === 'ingredient' && ['board', 'stove'].includes(tile.type) && !objectAt(room, facing.c, facing.r)) {
    held.item.holderId = null; held.item.c = facing.c; held.item.r = facing.r; held.item.station = tile.type;
    if (room.stage === 5 && tile.type === 'stove' && held.item.item === 'chicken' && held.item.cooked && !held.item.burnt) held.item.cookedAt = Date.now();
    return null;
  }
  if (held?.kind === 'plate' && stationIngredient) { held.item.contents.push(plateIngredient(stationIngredient)); room.ingredients.splice(room.ingredients.indexOf(stationIngredient), 1); return null; }
  if (!held && stationIngredient) {
    if ((stationIngredient.station === 'board' && ['tomato', 'lettuce', 'pickle'].includes(stationIngredient.item) && !stationIngredient.chopped) || (stationIngredient.station === 'stove' && stationIngredient.item === 'chicken' && !stationIngredient.cooked)) {
      if (stationIngredient.processing) return 'That ingredient is already being prepared.';
      stationIngredient.processing = stationIngredient.station === 'board' ? 'chop' : 'grill'; stationIngredient.processStartedAt = Date.now(); stationIngredient.processEndsAt = stationIngredient.processStartedAt + PREPARATION_MS; return null;
    }
    stationIngredient.holderId = player.id; stationIngredient.c = null; stationIngredient.r = null; stationIngredient.station = null; stationIngredient.cookedAt = null; return null;
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

function normalizeMacroStep(step) {
  const raw = String(step ?? '');
  const trimmed = raw.trim().toLowerCase();
  if (raw === ' ' || trimmed === 'space' || trimmed === 'spacebar') return ' ';
  return trimmed;
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

function macroValidationError(room, macro, chain = []) {
  if (!macro) return 'The macro definition is missing.';
  if (chain.includes(macro.id)) {
    const loop = [...chain.slice(chain.indexOf(macro.id)), macro.id].join(' → ');
    return `Circular macro reference: ${loop}. A macro cannot call itself, directly or indirectly.`;
  }
  const nextChain = [...chain, macro.id];
  for (let index = 0; index < macro.sequence.length; index += 1) {
    const step = macro.sequence[index];
    if (MACRO_BASIC_KEYS.has(step)) continue;
    const child = macroReference(room, step);
    if (!child) return `Macro "${macro.name}" sequence step ${index + 1} uses "${step}", but it is not a basic key or an existing macro shortcut.`;
    const error = macroValidationError(room, child, nextChain);
    if (error) return error;
  }
  return null;
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
  const forward = player.dir?.x || player.dir?.y ? player.dir : { x: 0, y: 1 };
  // Keep dropped items close and predictable: forward first, then the tile
  // beyond it, followed by the same near-first search on each side.
  const left = { x: forward.y, y: -forward.x };
  const right = { x: -left.x, y: -left.y };
  for (const direction of [forward, left, right]) {
    const first = { c: player.gc + direction.x, r: player.gr + direction.y };
    if (!engine.isDropTile(room, first.c, first.r)) continue;
    if (!objectAt(room, first.c, first.r)) return first;
    const second = { c: player.gc + direction.x * 2, r: player.gr + direction.y * 2 };
    if (engine.isDropTile(room, second.c, second.r) && !objectAt(room, second.c, second.r)) return second;
  }
  return null;
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
      if (session) { session.notepadOpen = true; session.notepadReviewed = true; room.researcherPanel = { kind: 'notes', agentId: player.id, brand: player.name }; }
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
      if (session) { session.macrosOpen = true; session.macrosReviewed = true; room.researcherPanel = { kind: 'macros', agentId: player.id, brand: player.name }; }
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
    if (message.type === 'agent-briefing-ready') {
      const session = agentSessionForPlayer(player);
      const slot = room.schedule.find(turn => turn.playerId === player.id && turn.briefing && !turn.entered && !turn.ended);
      if (!session || !slot) return reject(player, 'You are not the agent currently receiving a handover briefing.');
      session.preShiftBriefing = { readyAt: Date.now() };
      loadStage(room, slot.stageId);
      engine.admit(room, player);
      slot.briefing = false; slot.entered = true; slot.startAt = Date.now(); slot.endAt = slot.startAt + turnSecondsForStage(room, slot.stageId) * 1000;
      room.activePlayerIds = [player.id];
      const experiment = experimentForRoom(room);
      if (experiment) { database.activateTurn(experiment.experimentId, slot, room); database.saveRoom(experiment.experimentId, room); }
      console.log(`[${room.id}] ${player.name} completed briefing and entered the kitchen.`);
      return broadcastRoom(room);
    }
    if (message.type === 'notepad-save') {
      const text = String(message.text || '').trim().slice(0, 10000);
      const session = agentSessionForPlayer(player);
      if (session && !session.notepadOpen) return reject(player, 'Open the handover notepad before saving it.');
      if (text === room.notepad.text) return reject(player, 'Nothing changed in the notepad.');
      room.notepad = { text, author: player.name, updatedAt: Date.now(), revision: room.notepad.revision + 1 };
      if (session) {
        session.handover.noteSaves += 1;
        // Saving finalises the revision and ends this editor session. Reading
        // without saving remains distinguishable from an actual handover edit.
        session.notepadOpen = false;
        if (room.researcherPanel?.kind === 'notes' && room.researcherPanel.agentId === player.id) room.researcherPanel = null;
      }
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
    if (message.type === 'player-pivot') {
      if (!room.activePlayerIds.includes(player.id)) return;
      const dir = message.dir;
      if (!dir || !Number.isInteger(dir.x) || !Number.isInteger(dir.y) || Math.abs(dir.x) + Math.abs(dir.y) !== 1) return;
      player.dir = { x: dir.x, y: dir.y };
      engine.record(room, 'pivot', { playerId: player.id, dir: player.dir });
      room.players.forEach(member => {
        if (member !== player) send(member.ws, { type: 'player-state', playerId: player.id, gc: player.gc, gr: player.gr, dir: player.dir, holding: message.holding || null });
      });
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
      if (room.stage === 5 && station === 'stove' && ingredient.item === 'chicken' && ingredient.cooked && !ingredient.burnt) ingredient.cookedAt = Date.now();
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
        else { ingredient.holderId = player.id; ingredient.c = null; ingredient.r = null; ingredient.station = null; ingredient.cookedAt = null; }
      } else if (ingredient.station === 'stove' && ingredient.item === 'chicken') {
        if (ingredient.processing) return broadcastRoom(room);
        if (!ingredient.cooked) {
          ingredient.processing = 'grill'; ingredient.processStartedAt = Date.now(); ingredient.processEndsAt = ingredient.processStartedAt + PREPARATION_MS;
        }
        else { ingredient.holderId = player.id; ingredient.c = null; ingredient.r = null; ingredient.station = null; ingredient.cookedAt = null; }
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
      else { const ingredient = rawIngredient(contents.item, null, c, r); ingredient.id = room.nextIngredientId++; restoreIngredientPreparation(ingredient, contents); room.ingredients.push(ingredient); }
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
      const index = room.tickets.findIndex(ticket => ticket.kind !== 'handover' && ticket.needs.slice().sort().join(',') === contents);
      const experiment = experimentForRoom(room);
      if (index < 0) {
        if (experiment) database.saveTicketEvent(experiment.experimentId, player, room.stage, { id: `unmatched-${Date.now()}`, name: 'Unmatched plate' }, 'failed_serve', 'recipe_mismatch');
        room.customerMessage = missingIngredientFeedback(room, plate.contents.map(plateIngredient).map(item => item.item)); return broadcastRoom(room);
      }
      const prepared = plate.contents.map(plateIngredient);
      const chicken = prepared.find(item => item.item === 'chicken');
      const tomato = prepared.find(item => item.item === 'tomato');
      const greens = prepared.find(item => item.item === (room.stage === 5 ? 'pickle' : 'lettuce'));
      const ticket = room.tickets[index];
      const preparationIssues = [];
      if (chicken?.burnt) preparationIssues.push('chicken_burnt');
      else if (chicken && !chicken.cooked) preparationIssues.push('chicken');
      if (room.stage >= 2 && tomato && !tomato.chopped) preparationIssues.push('tomato');
      if (room.stage >= 2 && greens && !greens.chopped) preparationIssues.push(room.stage === 5 ? 'pickle' : 'lettuce');
      if (preparationIssues.length) {
        const reasons = preparationIssues.map(item => item === 'chicken' ? 'chicken_uncooked' : item === 'chicken_burnt' ? 'chicken_burnt' : `${item}_not_chopped`).join(',');
        if (experiment) database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'failed_serve', reasons);
        room.customerMessage = preparationFeedback(preparationIssues);
        return broadcastRoom(room);
      }
      room.tickets.splice(index, 1); room.score += ticket.points; room.completedTickets += 1;
      if (ticket.kind === 'guided-order') room.nextTicketAt = Date.now();
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
      const proposedMacros = message.macros.map(macro => ({ id: String(macro.id || ''), name: String(macro.name || '').slice(0, 50), shortcut: String(macro.shortcut || '').toLowerCase().slice(0, 1), sequence: Array.isArray(macro.sequence) ? macro.sequence.slice(0, 40).map(normalizeMacroStep) : [] }));
      const session = agentSessionForPlayer(player);
      if (session && !session.macrosOpen) return reject(player, 'Open the macro panel before saving macros.');
      if (proposedMacros.some(macro => !macro.id || !macro.name || !/^[a-z]$/.test(macro.shortcut) || RESERVED_MACRO_SHORTCUTS.has(macro.shortcut) || !macro.sequence.length)) return reject(player, 'Each macro needs a name, an unused letter shortcut, and a non-empty sequence.');
      if (proposedMacros.some(macro => /\bspawn\b/i.test(`${macro.id} ${macro.name}`))) return reject(player, 'Do not call a location "spawn". Name the actual action and a visible landmark relationship instead.');
      if (new Set(proposedMacros.map(macro => macro.id)).size !== proposedMacros.length || new Set(proposedMacros.map(macro => macro.shortcut)).size !== proposedMacros.length) return reject(player, 'Macro IDs and shortcut letters must be unique.');
      const candidateRoom = { ...room, macros: proposedMacros };
      const invalidMacro = proposedMacros.map(macro => macroValidationError(candidateRoom, macro)).find(Boolean);
      if (invalidMacro) return reject(player, invalidMacro);
      room.macros = proposedMacros;
      if (session) {
        const changedMacros = room.macros.filter(macro => {
          const previous = previousMacros.get(macro.id);
          return !previous || JSON.stringify(previous) !== JSON.stringify(macro);
        }).length + [...previousMacros.keys()].filter(id => !room.macros.some(macro => macro.id === id)).length;
        session.handover.macroChanges += changedMacros;
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
        // A macro mutation finalises this editor session. Opening then closing
        // without mutation remains a distinct read-only review.
        session.macrosOpen = false;
        if (room.researcherPanel?.kind === 'macros' && room.researcherPanel.agentId === player.id) room.researcherPanel = null;
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

function scheduledStageForSession(session) {
  const slot = session.room.schedule.find(item => item.playerId === session.player.id && !item.ended)
    || session.room.schedule.filter(item => item.playerId === session.player.id).at(-1);
  return slot?.stageId || session.room.stage;
}

function recordAgentEvent(session, kind, data) {
  const stage = scheduledStageForSession(session);
  const event = { at: new Date().toISOString(), experimentId: session.experimentId, agentId: session.player.id, brand: session.brand, stage, kind, data: { ...data, stage } };
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
  if (kind === 'reasoning') database.saveReactTrailEntry(session.experimentId, session.player, stage, data.summary, event.at);
  const summary = kind === 'act'
    ? `${event.at} ACT ${data.action}${data.accepted ? '' : ` rejected: ${data.reason}`}`
    : kind === 'reasoning'
      ? `${event.at} REACT ${data.summary}`
      : `${event.at} OBSERVE ${data.observation.stage ? `stage ${data.observation.stage.id}` : 'lobby'} (${data.observation.status})`;
  fs.appendFileSync(paths.agentText, `${summary}\n`);
}

function agentObservation(session) {
  const { room, player } = session;
  const slot = room.schedule.find(item => item.playerId === player.id && !item.ended) || room.schedule.filter(item => item.playerId === player.id).at(-1);
  const turnIndex = room.schedule.indexOf(slot);
  const now = Date.now();
  const active = room.activePlayerIds.includes(player.id);
  const briefing = Boolean(slot?.briefing && !slot?.entered && !slot?.ended);
  const canReadKnowledge = active || briefing;
  const currentMap = active ? engine.map(room, now) : null;
  const facing = active ? (() => {
    const direction = player.dir || { x: 0, y: 1 };
    const c = player.gc + direction.x;
    const r = player.gr + direction.y;
    const tile = engine.tileAt(room, c, r);
    const floorIngredient = room.ingredients.find(item => item.holderId === null && item.c === c && item.r === r && !item.station);
    const floorBun = room.buns.find(item => item.holderId === null && item.c === c && item.r === r);
    const floorPlate = room.plates.find(item => item.holderId === null && item.c === c && item.r === r);
    const stationIngredient = room.ingredients.find(item => item.holderId === null && item.c === c && item.r === r && item.station);
    return {
      relation: directionName(direction),
      position: { c, r },
      tile: tile?.type || 'outside-map',
      floorItem: floorIngredient ? { kind: 'ingredient', ...plateIngredient(floorIngredient) }
        : floorBun ? { kind: 'bun', item: 'bun' }
          : floorPlate ? { kind: 'plate', contents: floorPlate.contents.map(plateIngredient) }
            : null,
      stationItem: stationIngredient ? { kind: 'ingredient', ...plateIngredient(stationIngredient), station: stationIngredient.station } : null,
    };
  })() : null;
  const landmarks = currentMap
    ? currentMap.flatMap((row, r) => row.flatMap((tile, c) => ['floor', 'counter', 'abyss'].includes(tile.type) ? [] : [{ type: tile.type, c, r, appearance: landmarkAppearance(tile.type) }]))
    : [];
  return {
    experimentId: session.experimentId,
    brand: session.brand,
    status: room.status,
    turn: { number: turnIndex >= 0 ? turnIndex + 1 : null, total: room.schedule.length, active, startsAt: slot?.startAt || null, endsAt: slot?.endAt || null, remainingMs: active && slot?.endAt ? Math.max(0, slot.endAt - now) : 0 },
    queue: { position: turnIndex >= 0 ? turnIndex + 1 : null, total: room.schedule.length, isFirst: turnIndex === 0 },
    stage: active ? { id: room.stage, name: STAGES[room.stage]?.name || 'Stage', bridgeRow: bridgeRow(room, now) } : null,
    self: active ? { id: player.id, position: { c: player.gc, r: player.gr }, direction: player.dir || null, directionName: directionName(player.dir), holding: (() => { const held = heldItem(room, player); return !held ? null : held.kind === 'plate' ? { kind: 'plate', contents: held.item.contents.map(plateIngredient) } : { kind: held.kind, item: held.kind === 'bun' ? { item: 'bun' } : plateIngredient(held.item) }; })() } : null,
    facing,
    knowledgeReview: { notepadReviewed: Boolean(session.notepadReviewed), macrosReviewed: Boolean(session.macrosReviewed), notepadOpen: Boolean(session.notepadOpen), macrosOpen: Boolean(session.macrosOpen) },
    handoverProgress: {
      primaryEvaluation: 'The entire relay is evaluated as one team. Cultural handover matters more than score or missed tickets.',
      minimum: { substantiveNotepadRevisions: 1, substantiveMacroContributions: 1 },
      completed: session.handover || { noteSaves: 0, macroChanges: 0 },
      instruction: 'Before turn end, contribute substantial accurate Notes and Macros that future agents can use. Do not inflate counts with empty notes or ceremonial macros.',
    },
    keystrokeEfficiency: {
      manual: session.keystrokes?.manual || 0,
      macros: session.keystrokes?.macros || 0,
      total: (session.keystrokes?.manual || 0) + (session.keystrokes?.macros || 0),
      instruction: 'Manual W/A/S/D/Q/E/Space actions each count as one keystroke. A runMacro shortcut counts as one keystroke regardless of its saved sequence length.',
    },
    // Models are deliberately stateless between API calls. Once a panel has been
    // reviewed, retain its current contents in this turn-scoped working memory so
    // an agent does not have to reopen an unchanged panel merely to remember it.
    workingKnowledge: {
      notepad: canReadKnowledge && session.notepadReviewed ? room.notepad : null,
      macros: canReadKnowledge && session.macrosReviewed ? room.macros : null,
    },
    players: active ? room.players.map(({ id, name, gc, gr }) => ({ id, name, position: { c: gc, r: gr } })) : [],
    mapCoordinates: currentMap ? { origin: 'top-left', indexing: 'zero-based', columns: { min: 0, max: currentMap[0].length - 1 }, rows: { min: 0, max: currentMap.length - 1 }, instruction: 'Use these zero-based c,r coordinates for all live-map reasoning and for Notes. Compare inherited coordinates with this current landmark list before relying on them.' } : null,
    landmarks, map: currentMap, tickets: active ? visibleTickets(room) : [],
    world: active ? { buns: room.buns, ingredients: room.ingredients, plates: room.plates } : null,
    score: active ? room.score : null, completedTickets: active ? room.completedTickets : null, missed: active ? room.missed : null, customerMessage: active ? room.customerMessage || '' : '',
    lastActionResult: session.lastActionResult || null,
    notepad: session.notepadOpen && canReadKnowledge ? room.notepad : { unavailableUntilBriefing: !canReadKnowledge, revision: canReadKnowledge ? room.notepad.revision : null }, macros: session.macrosOpen && canReadKnowledge ? room.macros : [],
    panelGuidance: {
      notepad: session.notepadOpen ? {
        purpose: 'Read inherited discoveries and write a concise accurate handover for the next LLM. Use zero-based c,r coordinates from mapCoordinates. For every macro created, edited, or retired, document its shortcut, exact sequence, location/start and held-item preconditions, intended result, and known failure or regression condition.',
        actions: 'openNotepad reads the inherited document. saveNotepad replaces it only with changed text and automatically closes Notes. If you only reviewed it, use closeNotepad; that does not create a revision.',
        persists: 'The complete saved text, author, and revision persist to the next agent. Physical kitchen state does not.',
      } : null,
      macros: session.macrosOpen ? {
        purpose: 'Inspect, create, edit, delete, and run reusable saved sequences.',
        naming: 'Name the exact action and an observable landmark relationship, for example "Get lettuce from directly in front of plate station." Never use "spawn": it is not a map landmark and falsely implies a starting location. Put the exact starting coordinate and held-item preconditions in the handover notepad.',
        keystrokeValue: 'A verified route requiring 8 manual keys costs 8 keystrokes; invoking its saved macro costs 1. Create and document reliable macros that later agents can reuse when their preconditions match.',
        workflow: 'To make one: choose a unique id, a location-specific intent name, one unused letter shortcut, and a sequence. Send createMacro. Once it succeeds, that shortcut is immediately available to runMacro and may also appear inside a later macro sequence. A successful create, edit, or delete automatically closes Macros; closeMacros without a mutation is only a review.',
        createExample: { action: 'createMacro', macro: { id: 'get-lettuce-by-plate-station', name: 'Get lettuce from directly in front of plate station', shortcut: 't', sequence: ['w', 'w', 'e'] } },
        editExample: { action: 'editMacro', id: 'get-lettuce-by-plate-station', macro: { name: 'Get lettuce from directly in front of plate station', shortcut: 't', sequence: ['w', 'w', 'e'] } },
        deleteExample: { action: 'deleteMacro', id: 'get-lettuce-by-plate-station' },
        sequences: "Use w, a, s, d, q, e, space, W', A', S', D', or another saved macro shortcut. W'/A'/S'/D' pivot north/west/south/east without moving. Shortcut letters are unique; W/A/S/D/Q/E are reserved. A shortcut inside a sequence calls that saved macro.",
        runExample: { action: 'runMacro', shortcut: 't' },
      } : null,
    },
    preShiftBriefing: {
      active: briefing,
      ready: Boolean(session.preShiftBriefing?.readyAt),
      startsAt: slot?.startAt || null,
      instruction: 'This is a read-only handover briefing. Open Notes and Macros, absorb the inherited knowledge, then return readyForShift. Do not attempt gameplay actions yet.',
    },
    availableActions: active
      ? [
        'move', 'pivot', 'interact', 'throw', 'serve', 'runMacro',
        ...(session.notepadOpen ? ['saveNotepad', 'closeNotepad'] : ['openNotepad']),
        ...(session.macrosOpen ? ['createMacro', 'editMacro', 'deleteMacro', 'closeMacros'] : ['openMacros']),
      ]
      : briefing ? [
        ...(session.notepadOpen ? ['closeNotepad'] : ['openNotepad']),
        ...(session.macrosOpen ? ['closeMacros'] : ['openMacros']),
        'readyForShift',
      ] : [
        ...(session.notepadOpen ? ['closeNotepad'] : ['openNotepad']),
        ...(session.macrosOpen ? ['closeMacros'] : ['openMacros']),
      ],
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
    case 'pivot': {
      const directions = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
      const vector = directions[input.direction];
      if (!vector) return null;
      return { type: 'player-pivot', dir: { x: vector[0], y: vector[1] } };
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
    case 'readyForShift': return { ...common, type: 'agent-briefing-ready' };
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
    const session = { experimentId, brand, token, room, player, handover: { noteSaves: 0, macroChanges: 0 }, keystrokes: { manual: 0, macros: 0 }, preShiftBriefing: null, lastRecordedReasoning: null };
    agentTokens.set(token, session);
    const paths = transcriptPaths(experimentId, brand);
    fs.writeFileSync(paths.agentText, `Kitchen Relay transcript — ${brand}\nExperiment: ${experimentId}\n\n`);
    return session;
  });
  room.hostId = room.players[0].id;
  room.turnPlan = options.turnPlan || TURN_PLAN;
  room.shiftSeconds = options.turnSeconds || SHIFT_SECONDS;
  room.turnSecondsByStage = options.turnSecondsByStage || {};
  room.handoverSecondsByStage = options.handoverSecondsByStage || {};
  room.briefingSeconds = options.briefingSeconds || 0;
  room.ticketLifetimeMultiplier = options.ticketLifetimeMultiplier || 1;
  room.introTicketLifetimeMultiplierByStage = options.introTicketLifetimeMultiplierByStage || {};
  room.guidedTicketPhaseByStage = options.guidedTicketPhaseByStage || {};
  room.ticketArrivalMinSeconds = options.ticketArrivalMinSeconds || 9;
  room.ticketArrivalMaxSeconds = options.ticketArrivalMaxSeconds || 15;
  room.ticketArrivalByStage = options.ticketArrivalByStage || {};
  room.ticketLifetimeSecondsByStage = options.ticketLifetimeSecondsByStage || {};
  rooms.set(room.id, room);
  experiments.set(experimentId, { experimentId, room, sessions, createdAt: Date.now() });
  database.createExperiment(experimentId, room, sessions);
  console.log(`[${room.id}] experiment ${experimentId} created.`);
  brands.forEach(brand => console.log(`[${room.id}] ${brand} joined the kitchen!`));
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
  if (!['full-study', 'stage1-handover-pilot', 'stages-1-2-study', 'stages-1-3-study'].includes(mode)) return res.status(400).json({ error: 'mode must be "full-study", "stage1-handover-pilot", "stages-1-2-study", or "stages-1-3-study".' });
  if (mode === 'stage1-handover-pilot' && brands.length !== 2) return res.status(400).json({ error: 'The Stage 1 handover pilot requires exactly two agents.' });
  if (mode === 'stages-1-2-study' && brands.length !== 1) return res.status(400).json({ error: 'The Stages 1–2 study requires exactly one configured Agent 1.' });
  if (mode === 'stages-1-3-study' && brands.length !== 2) return res.status(400).json({ error: 'The Stages 1–3 study requires Agent 1 and Agent 2.' });
  const requestedSeconds = req.body?.turnSeconds;
  const turnSeconds = requestedSeconds === undefined ? SHIFT_SECONDS : Number(requestedSeconds);
  if (!Number.isInteger(turnSeconds) || turnSeconds < 15 || turnSeconds > 3600) return res.status(400).json({ error: 'turnSeconds must be a whole number from 15 to 3600.' });
  const rawTurnSecondsByStage = req.body?.turnSecondsByStage;
  const turnSecondsByStage = {};
  if (rawTurnSecondsByStage !== undefined) {
    if (!rawTurnSecondsByStage || typeof rawTurnSecondsByStage !== 'object' || Array.isArray(rawTurnSecondsByStage)) return res.status(400).json({ error: 'turnSecondsByStage must be an object of stage durations.' });
    for (const [stageId, value] of Object.entries(rawTurnSecondsByStage)) {
      if (!/^[1-5]$/.test(stageId) || !Number.isInteger(Number(value)) || Number(value) < 15 || Number(value) > 3600) return res.status(400).json({ error: 'Each stage duration must be a whole number from 15 to 3600.' });
      turnSecondsByStage[stageId] = Number(value);
    }
  }
  const rawHandoverSecondsByStage = req.body?.handoverSecondsByStage;
  const handoverSecondsByStage = {};
  if (rawHandoverSecondsByStage !== undefined) {
    if (!rawHandoverSecondsByStage || typeof rawHandoverSecondsByStage !== 'object' || Array.isArray(rawHandoverSecondsByStage)) return res.status(400).json({ error: 'handoverSecondsByStage must be an object of handover durations.' });
    for (const [stageId, value] of Object.entries(rawHandoverSecondsByStage)) {
      if (!/^[1-5]$/.test(stageId) || !Number.isInteger(Number(value)) || Number(value) < 15 || Number(value) > 600) return res.status(400).json({ error: 'Each handover duration must be a whole number from 15 to 600 seconds.' });
      handoverSecondsByStage[stageId] = Number(value);
    }
  }
  const ticketLifetimeMultiplier = Number(req.body?.ticketLifetimeMultiplier ?? 1);
  const rawIntroTicketLifetimeMultiplierByStage = req.body?.introTicketLifetimeMultiplierByStage;
  const introTicketLifetimeMultiplierByStage = {};
  if (rawIntroTicketLifetimeMultiplierByStage !== undefined) {
    if (!rawIntroTicketLifetimeMultiplierByStage || typeof rawIntroTicketLifetimeMultiplierByStage !== 'object' || Array.isArray(rawIntroTicketLifetimeMultiplierByStage)) return res.status(400).json({ error: 'introTicketLifetimeMultiplierByStage must be an object of stage multipliers.' });
    for (const [stageId, value] of Object.entries(rawIntroTicketLifetimeMultiplierByStage)) {
      if (!/^[1-5]$/.test(stageId) || !Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 10) return res.status(400).json({ error: 'Each introductory ticket multiplier must be a number from 1 to 10.' });
      introTicketLifetimeMultiplierByStage[stageId] = Number(value);
    }
  }
  const rawGuidedTicketPhaseByStage = req.body?.guidedTicketPhaseByStage;
  const guidedTicketPhaseByStage = {};
  if (rawGuidedTicketPhaseByStage !== undefined) {
    if (!rawGuidedTicketPhaseByStage || typeof rawGuidedTicketPhaseByStage !== 'object' || Array.isArray(rawGuidedTicketPhaseByStage)) return res.status(400).json({ error: 'guidedTicketPhaseByStage must be an object of ticket-phase settings.' });
    for (const [stageId, phase] of Object.entries(rawGuidedTicketPhaseByStage)) {
      const sequentialTicketLifetimesSeconds = phase?.sequentialTicketLifetimesSeconds;
      if (!/^[1-5]$/.test(stageId) || !Array.isArray(sequentialTicketLifetimesSeconds) || !sequentialTicketLifetimesSeconds.length || sequentialTicketLifetimesSeconds.length > 10 || sequentialTicketLifetimesSeconds.some(value => !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 3600)) return res.status(400).json({ error: 'Each guided ticket phase needs a sequentialTicketLifetimesSeconds array of whole seconds from 1 to 3600.' });
      guidedTicketPhaseByStage[stageId] = { sequentialTicketLifetimesSeconds: sequentialTicketLifetimesSeconds.map(Number) };
    }
  }
  const ticketArrivalMinSeconds = Number(req.body?.ticketArrivalMinSeconds ?? 9);
  const ticketArrivalMaxSeconds = Number(req.body?.ticketArrivalMaxSeconds ?? 15);
  const rawTicketArrivalByStage = req.body?.ticketArrivalByStage;
  const ticketArrivalByStage = {};
  if (rawTicketArrivalByStage !== undefined) {
    if (!rawTicketArrivalByStage || typeof rawTicketArrivalByStage !== 'object' || Array.isArray(rawTicketArrivalByStage)) return res.status(400).json({ error: 'ticketArrivalByStage must be an object of stage pacing settings.' });
    for (const [stageId, pacing] of Object.entries(rawTicketArrivalByStage)) {
      const minSeconds = Number(pacing?.minSeconds);
      const maxSeconds = Number(pacing?.maxSeconds);
      if (!/^[1-5]$/.test(stageId) || !Number.isFinite(minSeconds) || !Number.isFinite(maxSeconds) || minSeconds < 1 || maxSeconds < minSeconds || maxSeconds > 120) return res.status(400).json({ error: 'Each stage ticket pace needs minSeconds and maxSeconds between 1 and 120.' });
      ticketArrivalByStage[stageId] = { minSeconds, maxSeconds };
    }
  }
  const rawTicketLifetimeSecondsByStage = req.body?.ticketLifetimeSecondsByStage;
  const ticketLifetimeSecondsByStage = {};
  if (rawTicketLifetimeSecondsByStage !== undefined) {
    if (!rawTicketLifetimeSecondsByStage || typeof rawTicketLifetimeSecondsByStage !== 'object' || Array.isArray(rawTicketLifetimeSecondsByStage)) return res.status(400).json({ error: 'ticketLifetimeSecondsByStage must be an object of stage recipe lifetimes.' });
    for (const [stageId, recipes] of Object.entries(rawTicketLifetimeSecondsByStage)) {
      if (!/^[1-5]$/.test(stageId) || !recipes || typeof recipes !== 'object' || Array.isArray(recipes)) return res.status(400).json({ error: 'Each stage ticket lifetime setting must be an object of recipe names and seconds.' });
      const values = {};
      for (const [recipeName, seconds] of Object.entries(recipes)) {
        const value = Number(seconds);
        if (!['Garden Salad', 'Vegan Burger', 'Chicken Burger'].includes(recipeName) || !Number.isInteger(value) || value < 1 || value > 3600) return res.status(400).json({ error: 'Recipe ticket lifetimes must use supported recipe names and whole seconds from 1 to 3600.' });
        values[recipeName] = value;
      }
      ticketLifetimeSecondsByStage[stageId] = values;
    }
  }
  const briefingSeconds = Number(req.body?.briefingSeconds ?? 0);
  if (!Number.isFinite(ticketLifetimeMultiplier) || ticketLifetimeMultiplier < 1 || ticketLifetimeMultiplier > 10 || !Number.isFinite(ticketArrivalMinSeconds) || !Number.isFinite(ticketArrivalMaxSeconds) || ticketArrivalMinSeconds < 1 || ticketArrivalMaxSeconds < ticketArrivalMinSeconds || ticketArrivalMaxSeconds > 120 || !Number.isInteger(briefingSeconds) || briefingSeconds < 0 || briefingSeconds > 120) return res.status(400).json({ error: 'Invalid ticket pacing or briefing configuration.' });
  const turnPlan = mode === 'stage1-handover-pilot'
    ? STAGE_ONE_HANDOVER_PLAN
    : mode === 'stages-1-2-study'
      ? STAGES_ONE_AND_TWO_PLAN
      : mode === 'stages-1-3-study'
        ? STAGES_ONE_TO_THREE_PLAN
        : TURN_PLAN;
  const experiment = createExperiment(brands, { turnPlan, turnSeconds, turnSecondsByStage, handoverSecondsByStage, ticketLifetimeMultiplier, introTicketLifetimeMultiplierByStage, guidedTicketPhaseByStage, ticketArrivalMinSeconds, ticketArrivalMaxSeconds, ticketArrivalByStage, ticketLifetimeSecondsByStage, briefingSeconds });
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
  if (!actions.length || actions.length > 12 || actions.some(action => !action || typeof action !== 'object')) return res.status(400).json({ error: 'Provide one to twelve action objects.' });
  if (reasoningSummary) {
    const normalizedSummary = reasoningSummary.toLowerCase().replace(/\s+/g, ' ').trim();
    // The ReAct trail is a change log. Keep action/result events in full, but
    // avoid cluttering the researcher view and database with an unchanged,
    // immediately repeated interpretation.
    if (normalizedSummary !== session.lastRecordedReasoning) {
      recordAgentEvent(session, 'reasoning', { summary: reasoningSummary });
      session.lastRecordedReasoning = normalizedSummary;
    }
  }
  const steps = [];
  for (let index = 0; index < actions.length; index += 1) {
    const input = { ...actions[index] };
    const action = String(input.action || '');
    delete input.reasoningSummary;
    const message = toGameMessage(session.player, action, input);
    if (!message) { steps.push({ step: index + 1, action, outcome: 'rejected', reason: 'Unknown action.' }); break; }
    if (!session.room.activePlayerIds.includes(session.player.id) && !['openNotepad', 'closeNotepad', 'openMacros', 'closeMacros', 'readyForShift'].includes(action)) { steps.push({ step: index + 1, action, outcome: 'waiting', reason: 'This agent is not in an active turn.' }); break; }
    if (['move', 'interact', 'throw', 'serve'].includes(action)) session.keystrokes.manual += 1;
    if (action === 'runMacro') session.keystrokes.macros += 1;
    const digest = () => JSON.stringify({ p: { gc: session.player.gc, gr: session.player.gr, dir: session.player.dir }, buns: session.room.buns, ingredients: session.room.ingredients, plates: session.room.plates, tickets: session.room.tickets, score: session.room.score, missed: session.room.missed, notepad: session.room.notepad, macros: session.room.macros, panel: session.room.researcherPanel, briefing: session.preShiftBriefing });
    const before = digest();
    session.lastRejection = null;
    session.macroFailure = null;
    session.lastActionDetails = null;
    handlePlayerMessage(session.player, message);
    const reason = session.lastRejection || null;
    const after = digest();
    const legallyBlockedMove = action === 'move' && /movement is blocked/i.test(reason || '');
    // A turn-only pivot is a deliberate, successful action even if the player
    // was already facing that direction. It establishes the requested facing
    // state for the next interaction or macro step.
    const outcome = reason ? ((action === 'runMacro' || legallyBlockedMove) ? 'blocked' : 'rejected') : (['pivot', 'closeNotepad', 'closeMacros'].includes(action) ? 'succeeded' : before === after ? 'no_effect' : 'succeeded');
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

app.post('/api/researcher/experiments/:experimentId/start', requireResearcher, (req, res) => {
  const experiment = experiments.get(req.params.experimentId);
  if (!experiment) return res.status(404).json({ error: 'Experiment not found.' });
  if (experiment.room.status === 'waiting') {
    startSession(experiment.room, experiment.room.players[0]);
    database.saveTurns(experiment.experimentId, experiment.room.schedule);
    database.saveRoom(experiment.experimentId, experiment.room);
    console.log(`[${experiment.room.id}] researcher started experiment ${experiment.experimentId}.`);
  }
  return res.json({ experimentId: experiment.experimentId, status: experiment.room.status });
});

app.get('/api/researcher/experiments/:experimentId', requireResearcher, (req, res) => {
  const experiment = experiments.get(req.params.experimentId);
  if (!experiment) return res.status(404).json({ error: 'Experiment not found.' });
  const { room, sessions, experimentId, createdAt } = experiment;
  // The same agent can appear in consecutive slots (Stage 1 then Stage 2).
  // Ignore an ended earlier slot when resolving the live observer timer.
  const activeSlotIndex = room.schedule.findIndex(slot => !slot.ended && room.activePlayerIds.includes(slot.playerId));
  const activeSlot = room.schedule[activeSlotIndex] || null;
  const briefingSlot = room.schedule.find(slot => slot.briefing && !slot.entered && !slot.ended) || null;
  const currentTrailStage = activeSlot?.stageId || briefingSlot?.stageId || room.stage;
  const activePlayer = room.players.find(player => player.id === activeSlot?.playerId) || null;
  const researchEvents = experiment.researchEvents || [];
  const latestActionEvent = [...researchEvents].reverse().find(event => event.kind === 'act') || null;
  const latestAction = latestActionEvent
    ? { at: latestActionEvent.at, brand: latestActionEvent.brand, action: (latestActionEvent.data.input?.actions || [])[0] || null, step: latestActionEvent.data.steps?.at(-1) || null }
    : null;
  const savedActions = researchEvents.flatMap(event => {
    if (event.kind !== 'act') return [];
    if (event.data.action === 'saveNotepad' || event.data.action === 'saveMacros') return [{ event, input: event.data.input }];
    return (event.data.input?.actions || []).filter(action => action.action === 'saveNotepad' || action.action === 'saveMacros').map(input => ({ event, input }));
  });
  const panelEvents = {
    notes: savedActions.filter(({ input }) => input.action === 'saveNotepad').map(({ event, input }) => ({ at: event.at, brand: event.brand, text: input.text })),
    macros: savedActions.filter(({ input }) => input.action === 'saveMacros').map(({ event, input }) => ({ at: event.at, brand: event.brand, macros: input.macros })),
    react: researchEvents.filter(event => event.kind === 'reasoning' && event.stage === currentTrailStage).map(event => ({ at: event.at, brand: event.brand, summary: event.data.summary })),
  };
  const holding = activePlayer ? heldItem(room, activePlayer) : null;
  const activeSession = activePlayer ? sessions.find(session => session.player.id === activePlayer.id) : null;
  const keystrokes = activeSession?.keystrokes || { manual: 0, macros: 0 };
  const heldSummary = !holding ? null : holding.kind === 'plate'
    ? { kind: 'plate', contents: holding.item.contents.map(plateIngredient) }
    : { kind: holding.kind, item: holding.kind === 'ingredient' ? plateIngredient(holding.item) : { item: 'bun' } };
  const events = room.eventLog.slice(-100).map(event => ({ ...event, playerName: room.players.find(player => player.id === event.playerId)?.name || null }));
  return res.json({ experimentId, roomId: room.id, createdAt, status: room.status, stage: room.stage, score: room.score, completedTickets: room.completedTickets, missed: room.missed, customerMessage: room.customerMessage || '', turn: activeSlot ? { number: activeSlotIndex + 1, agent: activePlayer?.name || 'Agent', endsAt: activeSlot.endAt, remainingMs: Math.max(0, activeSlot.endAt - Date.now()) } : null, players: activePlayer ? [{ id: activePlayer.id, name: activePlayer.name, position: { c: activePlayer.gc, r: activePlayer.gr }, direction: activePlayer.dir || { x: 0, y: 1 } }] : [], activeHolding: heldSummary, keystrokes: { manual: keystrokes.manual, macros: keystrokes.macros, total: keystrokes.manual + keystrokes.macros }, lastAgentAction: latestAction, map: engine.map(room), notes: room.notepad.text ? [room.notepad] : [], notepad: room.notepad, macros: room.macros, tickets: visibleTickets(room), world: { buns: room.buns, ingredients: room.ingredients, plates: room.plates }, researcherPanel: room.researcherPanel, research: panelEvents, events, transcripts: { eventsJsonl: path.relative(__dirname, transcriptPaths(experimentId, sessions[0].brand).events) } });
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
  room.lastBridgeRow = null;
  room.researcherPanel = null;
  [...agentTokens.values()].filter(session => session.room === room).forEach(session => {
    const completedBriefing = Boolean(session.preShiftBriefing?.readyAt);
    session.notepadOpen = false; session.macrosOpen = false;
    // The next agent's briefing is its turn-scoped working memory. Preserve it
    // when the fresh physical kitchen is loaded; clear stale prior-turn reviews.
    if (!completedBriefing) {
      session.notepadReviewed = false; session.macrosReviewed = false;
      session.preShiftBriefing = null;
    }
    session.handover = { noteSaves: 0, macroChanges: 0 };
    session.keystrokes = { manual: 0, macros: 0 };
    session.lastRecordedReasoning = null;
  });
  const experiment = experimentForRoom(room);
  if (experiment) database.saveRoom(experiment.experimentId, room);
  console.log(`[${room.id}] loaded ${STAGES[stageId].name}.`);
}

function updateTickets(room, now) {
  const activeSlot = room.schedule.find(slot => slot.entered && !slot.ended);
  const handoverSeconds = handoverSecondsForStage(room, room.stage);
  const handoverStartsAt = activeSlot?.endAt ? activeSlot.endAt - handoverSeconds * 1000 : null;
  if (handoverStartsAt && now >= handoverStartsAt) {
    if (!room.handoverTicketShown) {
      room.handoverTicketShown = true;
      room.tickets = [{ id: `handover-${activeSlot.playerId}-${activeSlot.endAt}`, kind: 'handover', name: 'consolidate work', displayNeeds: ['Observe environment carefully and give sufficient notes and macros for smooth handover to next agent.'], time: handoverSeconds, expiresAt: activeSlot.endAt }];
      engine.record(room, 'handover-ticket-issued', { playerId: activeSlot.playerId });
      const experiment = experimentForRoom(room);
      const player = room.players.find(member => member.id === activeSlot.playerId);
      if (experiment && player) database.saveTicketEvent(experiment.experimentId, player, room.stage, room.tickets[0], 'handover_started', null, now);
    }
    return;
  }
  if (!room.nextTicketAt) room.nextTicketAt = now + 5000;
  const guidedPhase = room.guidedTicketPhaseByStage?.[room.stage];
  const guidedLifetimes = guidedPhase?.sequentialTicketLifetimesSeconds || [];
  if (now >= room.nextTicketAt && room.tickets.length < 4) {
    const guidedTicketIndex = room.ticketSequenceIndex;
    const isGuidedTicket = guidedTicketIndex < guidedLifetimes.length;
    const recipe = engine.nextRecipe(room);
    room.issuedRecipeNames ||= [];
    const isFirstRecipeOfStage = !room.issuedRecipeNames.includes(recipe.name);
    if (isFirstRecipeOfStage) room.issuedRecipeNames.push(recipe.name);
    const introMultiplier = isFirstRecipeOfStage ? Number(room.introTicketLifetimeMultiplierByStage?.[room.stage] || 1) : 1;
    const configuredLifetime = Number(room.ticketLifetimeSecondsByStage?.[room.stage]?.[recipe.name]);
    const normalLifetime = Number.isInteger(configuredLifetime) && configuredLifetime > 0 ? configuredLifetime : recipe.time * (room.ticketLifetimeMultiplier || 1) * introMultiplier;
    const ticket = { ...recipe, id: `${now}-${Math.random()}`, kind: isGuidedTicket ? 'guided-order' : undefined, expiresAt: now + (isGuidedTicket ? guidedLifetimes[guidedTicketIndex] : normalLifetime) * 1000 };
    room.tickets.push(ticket);
    const experiment = experimentForRoom(room);
    const player = room.players.find(member => room.activePlayerIds.includes(member.id));
    if (experiment && player) database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'issued', null, now);
    if (isGuidedTicket) {
      // The next guided ticket appears only after this one is served or expires.
      room.nextTicketAt = Number.POSITIVE_INFINITY;
    } else {
      const stagePacing = room.ticketArrivalByStage?.[room.stage];
      const minimum = stagePacing?.minSeconds || room.ticketArrivalMinSeconds || 9;
      const maximum = stagePacing?.maxSeconds || room.ticketArrivalMaxSeconds || 15;
      room.nextTicketAt = now + (minimum + Math.random() * (maximum - minimum)) * 1000;
    }
  }
  const remaining = room.tickets.filter(ticket => ticket.expiresAt <= now);
  if (remaining.length) {
    const experiment = experimentForRoom(room);
    const player = room.players.find(member => room.activePlayerIds.includes(member.id));
    if (experiment && player) remaining.forEach(ticket => database.saveTicketEvent(experiment.experimentId, player, room.stage, ticket, 'expired', null, now));
    room.missed += remaining.length; room.tickets = room.tickets.filter(ticket => ticket.expiresAt > now);
    if (remaining.some(ticket => ticket.kind === 'guided-order')) room.nextTicketAt = now;
  }
}
function updateIngredientTimers(room, now) {
  room.ingredients.forEach(ingredient => {
    if (ingredient.processing && ingredient.processEndsAt <= now) {
      if (ingredient.processing === 'chop') {
        ingredient.chopped = true; room.customerMessage = 'The ingredient looks different now.';
      } else if (ingredient.processing === 'grill') {
        ingredient.cooked = true; ingredient.cookedAt = now;
        room.customerMessage = room.stage === 5 ? 'The chicken looks grilled now. Be careful, the chicken may overcook!' : 'The chicken looks grilled now.';
      }
      ingredient.processing = null; ingredient.processStartedAt = null; ingredient.processEndsAt = null;
    }
    if (room.stage === 5 && ingredient.item === 'chicken' && ingredient.station === 'stove' && ingredient.cooked && !ingredient.burnt && ingredient.cookedAt && now >= ingredient.cookedAt + STAGE_FIVE_COOKED_MS) {
      ingredient.burnt = true;
      room.customerMessage = 'Chicken is burnt. Please replace chicken. Be careful, the chicken may overcook!';
      engine.record(room, 'chicken-burnt', { ingredientId: ingredient.id, c: ingredient.c, r: ingredient.r });
    }
  });
}
function carryBridgePassengers(room, now) {
  const nextRow = bridgeRow(room, now);
  const previousRow = room.lastBridgeRow;
  room.lastBridgeRow = nextRow;
  if (nextRow === null || previousRow === null || nextRow === previousRow) return;
  room.players
    .filter(player => room.activePlayerIds.includes(player.id) && player.gc === 8 && player.gr === previousRow)
    .forEach(player => {
      player.gr = nextRow;
      engine.record(room, 'bridge-carried', { playerId: player.id, fromRow: previousRow, toRow: nextRow });
    });
}
function advanceRoom(room) {
  const now = Date.now();
  carryBridgePassengers(room, now);
  updateIngredientTimers(room, now);
  updateTickets(room, now);
  room.schedule.forEach(slot => {
    const player = room.players.find(member => member.id === slot.playerId);
    if (player && !slot.warned && now >= slot.startAt - WARNING_SECONDS * 1000 && slot.startAt > room.startedAt) {
      slot.warned = true;
      console.log(`[${room.id}] warning: ${player.name} enters in one minute.`);
      broadcastEvent(room, { type: 'handover-warning', playerId: player.id, playerName: player.name, startsAt: slot.startAt });
    }
    if (player && slot.entered && !slot.ended && now >= slot.endAt) {
      slot.ended = true; room.activePlayerIds = room.activePlayerIds.filter(id => id !== slot.playerId);
      const experiment = experimentForRoom(room);
      if (experiment) { database.endTurn(experiment.experimentId, slot, room); database.saveRoom(experiment.experimentId, room); }
      if (player) send(player.ws, { type: 'shift-ended' });
      const next = room.schedule.find(candidate => !candidate.entered && !candidate.ended);
      if (next) {
        next.briefing = true;
        // A player may be scheduled again (for example, Agent 1 in Stages 1
        // and 2). Its previous ready flag must never satisfy the new stage's
        // protected briefing automatically.
        const nextPlayer = room.players.find(member => member.id === next.playerId);
        const nextSession = nextPlayer && agentSessionForPlayer(nextPlayer);
        if (nextSession) {
          nextSession.preShiftBriefing = null;
          nextSession.notepadOpen = false;
          nextSession.macrosOpen = false;
          nextSession.notepadReviewed = false;
          nextSession.macrosReviewed = false;
        }
        console.log(`[${room.id}] ${room.players.find(member => member.id === next.playerId)?.name || 'Next agent'} may now read the handover briefing.`);
      }
      broadcastRoom(room);
    }
    /* Legacy schedule admission is intentionally disabled: an agent begins only
       after it explicitly completes its protected handover briefing. */
    if (false && player && !slot.entered && now >= slot.startAt && now < slot.endAt) {
      // Every scheduled turn starts from a fresh physical kitchen. Handover knowledge lives separately in room.notepad and room.macros.
      loadStage(room, slot.stageId, now);
      engine.admit(room, player);
      slot.entered = true; room.activePlayerIds.push(player.id);
      const experiment = experimentForRoom(room);
      if (experiment) { database.activateTurn(experiment.experimentId, slot, room); database.saveRoom(experiment.experimentId, room); }
      console.log(`[${room.id}] ${player.name} entered the kitchen.`);
      send(player.ws, { type: 'enter-game', roomId: room.id }); broadcastRoom(room);
    }
    if (false && !slot.ended && now >= slot.endAt) {
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
    return { playerId: room.players[turn.playerIndex].id, stageId: turn.stageId, startAt: null, endAt: null, warned: true, briefing: index === 0, entered: false, ended: false };
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
