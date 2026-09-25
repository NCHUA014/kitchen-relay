const TURN_PLAN = [
  { playerIndex: 0, stageId: 1 }, { playerIndex: 0, stageId: 2 },
  { playerIndex: 1, stageId: 3 }, { playerIndex: 2, stageId: 4 },
  { playerIndex: 3, stageId: 5 },
];

const STAGE_ONE_RECIPES = [
  { name: 'Garden Salad', needs: ['tomato', 'lettuce'], displayNeeds: ['tomato', 'lettuce'], points: 70, time: 42 },
  { name: 'Vegan Burger', needs: ['bun', 'tomato', 'lettuce'], displayNeeds: ['garden salad', 'bun'], points: 90, time: 48 },
];
const STAGE_TWO_RECIPES = [
  { name: 'Garden Salad', needs: ['tomato', 'lettuce'], displayNeeds: [], points: 70, time: 42 },
  { name: 'Vegan Burger', needs: ['bun', 'tomato', 'lettuce'], displayNeeds: [], points: 90, time: 48 },
  { name: 'Chicken Burger', needs: ['bun', 'chicken', 'tomato', 'lettuce'], displayNeeds: ['vegan burger', 'grilled chicken'], points: 120, time: 55 },
];
const STAGE_FIVE_RECIPES = STAGE_TWO_RECIPES.map(recipe => ({ ...recipe, needs: recipe.needs.map(item => item === 'lettuce' ? 'pickle' : item) }));
const STAGES = {
  1: { id: 1, name: 'Stage 1', recipes: STAGE_ONE_RECIPES },
  2: { id: 2, name: 'Stage 2', recipes: STAGE_TWO_RECIPES },
  3: { id: 3, name: 'Stage 3', recipes: STAGE_TWO_RECIPES },
  4: { id: 4, name: 'Stage 4', recipes: STAGE_TWO_RECIPES },
  5: { id: 5, name: 'Stage 5', recipes: STAGE_FIVE_RECIPES },
};

const COLS = 17;
const ROWS = 10;

function bridgeRow(room, now = Date.now()) {
  if (room.stage !== 4 && room.stage !== 5) return null;
  return [3, 4, 5, 6, 7, 6, 5, 4][Math.floor(Math.max(0, now - room.stageStartedAt) / 2000) % 8];
}

function stageMap(stageId, room, now = Date.now()) {
  const tiles = Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => ({ type: r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1 ? 'counter' : 'floor' })));
  const set = (c, r, type) => { tiles[r][c].type = type; };
  if (stageId >= 3) {
    set(2, 0, 'crate_tomato'); set(4, 0, stageId === 5 ? 'crate_pickle' : 'crate_lettuce'); set(6, 0, 'crate_bun'); set(7, 0, 'crate_chicken');
    set(10, 0, 'board'); set(11, 0, 'board'); set(13, 0, 'stove'); set(14, 0, 'stove'); set(11, ROWS - 1, 'plates');
    set(0, 5, 'trash'); set(COLS - 1, 5, 'serve');
    for (let r = 1; r < ROWS - 1; r++) set(8, r, 'abyss');
    set(8, stageId === 3 ? 5 : bridgeRow(room, now), 'bridge');
  } else {
    set(2, 0, 'crate_tomato'); set(4, 0, 'crate_lettuce'); set(6, 0, 'crate_bun'); if (stageId === 2) set(8, 0, 'crate_chicken');
    if (stageId === 2) { set(2, ROWS - 1, 'board'); set(3, ROWS - 1, 'board'); }
    set(5, ROWS - 1, 'stove'); set(6, ROWS - 1, 'stove');
    set(11, 0, 'plates'); set(0, 5, 'trash'); set(COLS - 1, 5, 'serve');
  }
  return tiles;
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

class GameEngine {
  createRoom(id) {
    return { id, players: [], notepad: { text: '', author: null, updatedAt: null, revision: 0 }, macros: [], researcherPanel: null, score: 0, missed: 0, buns: [], nextBunId: 1, ingredients: [], nextIngredientId: 1, plates: [], nextPlateId: 1, tickets: [], nextTicketAt: null, ticketSequenceIndex: 0, stage: 1, stageStartedAt: Date.now(), customerMessage: '', status: 'waiting', hostId: null, activePlayerIds: [], schedule: [], timer: null, eventLog: [], rngState: hashSeed(id) };
  }

  map(room, now) { return stageMap(room.stage, room, now); }
  bridgeRow(room, now) { return bridgeRow(room, now); }
  tileAt(room, c, r, now) { return this.map(room, now)[r]?.[c] || null; }
  isWalkable(room, c, r, now) { return ['floor', 'bridge'].includes(this.tileAt(room, c, r, now)?.type); }
  isDropTile(room, c, r, now) { return this.tileAt(room, c, r, now)?.type === 'floor'; }
  spawnFor(room, playerId) {
    const index = Math.max(0, room.players.findIndex(player => player.id === playerId));
    return { gc: COLS - 2 - (index % 2), gr: ROWS - 2 - Math.floor(index / 2), dir: { x: 0, y: 1 } };
  }
  admit(room, player) { Object.assign(player, this.spawnFor(room, player.id)); }
  move(room, player, state) {
    const gc = Number(state.gc), gr = Number(state.gr);
    if (!Number.isInteger(gc) || !Number.isInteger(gr) || !this.isWalkable(room, gc, gr)) return false;
    const distance = Math.abs(gc - player.gc) + Math.abs(gr - player.gr);
    if (distance > 1) return false;
    player.gc = gc; player.gr = gr;
    if (state.dir && Number.isFinite(state.dir.x) && Number.isFinite(state.dir.y)) player.dir = { x: state.dir.x, y: state.dir.y };
    this.record(room, 'move', { playerId: player.id, gc, gr });
    return true;
  }
  resetStage(room, stageId, now = Date.now()) {
    room.stage = stageId; room.stageStartedAt = now; room.buns = []; room.ingredients = []; room.plates = []; room.tickets = []; room.nextTicketAt = now + 5000; room.ticketSequenceIndex = 0;
    room.customerMessage = stageId >= 2 ? 'A new customer is waiting.' : '';
    this.record(room, 'stage-reset', { stageId });
  }
  nextRecipe(room) {
    if (room.stage === 1) {
      const sequence = [STAGE_ONE_RECIPES[0], STAGE_ONE_RECIPES[0], STAGE_ONE_RECIPES[1], STAGE_ONE_RECIPES[1]];
      if (room.ticketSequenceIndex < sequence.length) return sequence[room.ticketSequenceIndex++];
    }
    if (room.stage === 2) {
      const sequence = [STAGE_TWO_RECIPES[0], STAGE_TWO_RECIPES[0], STAGE_TWO_RECIPES[1], STAGE_TWO_RECIPES[1], STAGE_TWO_RECIPES[2]];
      if (room.ticketSequenceIndex < sequence.length) return sequence[room.ticketSequenceIndex++];
    }
    room.rngState = (Math.imul(room.rngState, 1664525) + 1013904223) >>> 0;
    const recipes = STAGES[room.stage].recipes;
    return recipes[room.rngState % recipes.length];
  }
  record(room, type, details = {}) { room.eventLog.push({ at: Date.now(), type, ...details }); }
}

module.exports = { GameEngine, TURN_PLAN, STAGES, COLS, ROWS };
