const test = require('node:test');
const assert = require('node:assert/strict');
const { GameEngine } = require('./game-engine');

test('the same room seed produces the same ticket sequence', () => {
  const engine = new GameEngine();
  const first = engine.createRoom('KITCHEN-SEED');
  const second = engine.createRoom('KITCHEN-SEED');
  assert.equal(engine.nextRecipe(first).name, engine.nextRecipe(second).name);
  assert.equal(engine.nextRecipe(first).name, engine.nextRecipe(second).name);
});

test('stage reset keeps shared knowledge but clears the physical world', () => {
  const engine = new GameEngine();
  const room = engine.createRoom('KITCHEN-RESET');
  room.notepad = { text: 'Use the bridge.', author: 'Codex', updatedAt: 1, revision: 1 }; room.macros.push({ name: 'cross' });
  room.buns.push({ id: 1 }); room.ingredients.push({ id: 1 }); room.plates.push({ id: 1 }); room.tickets.push({ id: 'ticket' });
  engine.resetStage(room, 3, 1000);
  assert.equal(room.stage, 3);
  assert.equal(room.notepad.text, 'Use the bridge.'); assert.equal(room.macros.length, 1);
  assert.equal(room.buns.length, 0); assert.equal(room.ingredients.length, 0); assert.equal(room.plates.length, 0); assert.equal(room.tickets.length, 0);
});

test('abyss is blocked while the bridge remains walkable', () => {
  const engine = new GameEngine();
  const room = engine.createRoom('KITCHEN-BRIDGE');
  engine.resetStage(room, 4, 0);
  assert.equal(engine.isWalkable(room, 8, 3, 0), true);
  assert.equal(engine.isWalkable(room, 8, 4, 0), false);
});
