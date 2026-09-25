const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const environment = String(process.env.APP_ENV || 'uat').toLowerCase();
if (!['iwt', 'uat'].includes(environment)) throw new Error('APP_ENV must be either "iwt" or "uat".');

const dataDirectory = path.join(__dirname, 'data');
fs.mkdirSync(dataDirectory, { recursive: true });
const filePath = path.join(dataDirectory, `${environment}.sqlite`);
const db = new DatabaseSync(filePath);
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS experiments (
    experiment_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, environment TEXT NOT NULL,
    created_at TEXT NOT NULL, status TEXT NOT NULL, stage INTEGER NOT NULL, score INTEGER NOT NULL DEFAULT 0,
    missed INTEGER NOT NULL DEFAULT 0, finalised_at TEXT
  );
  CREATE TABLE IF NOT EXISTS agents (
    experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id), agent_id INTEGER NOT NULL,
    brand TEXT NOT NULL, PRIMARY KEY (experiment_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
    agent_id INTEGER NOT NULL, stage INTEGER NOT NULL, sequence INTEGER NOT NULL,
    starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
    agent_id INTEGER NOT NULL, brand TEXT NOT NULL, occurred_at TEXT NOT NULL, kind TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
    agent_id INTEGER, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_events_experiment_time ON agent_events(experiment_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_knowledge_experiment_time ON knowledge_revisions(experiment_id, occurred_at);
`);
db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());

const migrationTwo = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get();
if (!migrationTwo) {
  db.exec(`
    ALTER TABLE turns ADD COLUMN score_at_start INTEGER;
    ALTER TABLE turns ADD COLUMN missed_at_start INTEGER;
    ALTER TABLE turns ADD COLUMN score_at_end INTEGER;
    ALTER TABLE turns ADD COLUMN missed_at_end INTEGER;
    ALTER TABLE turns ADD COLUMN first_successful_serve_at TEXT;
    CREATE TABLE ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
      turn_id INTEGER REFERENCES turns(id), agent_id INTEGER, stage INTEGER NOT NULL,
      ticket_id TEXT NOT NULL, ticket_name TEXT NOT NULL, event_kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL, reason TEXT
    );
    CREATE TABLE notepad_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
      turn_id INTEGER REFERENCES turns(id), agent_id INTEGER NOT NULL, stage INTEGER NOT NULL,
      revision INTEGER NOT NULL, text TEXT NOT NULL, saved_at TEXT NOT NULL
    );
    CREATE TABLE macro_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
      turn_id INTEGER REFERENCES turns(id), agent_id INTEGER NOT NULL, stage INTEGER NOT NULL,
      macro_id TEXT NOT NULL, macro_name TEXT NOT NULL, shortcut TEXT NOT NULL,
      sequence_json TEXT NOT NULL, event_kind TEXT NOT NULL, finalised_at TEXT NOT NULL
    );
    CREATE TABLE macro_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
      turn_id INTEGER REFERENCES turns(id), agent_id INTEGER NOT NULL, stage INTEGER NOT NULL,
      macro_id TEXT NOT NULL, macro_name TEXT NOT NULL, shortcut TEXT NOT NULL,
      used_at TEXT NOT NULL, ended_at TEXT, blocked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_ticket_events_turn_time ON ticket_events(turn_id, occurred_at);
    CREATE INDEX idx_notepad_revisions_turn_time ON notepad_revisions(turn_id, saved_at);
    CREATE INDEX idx_macro_revisions_turn_time ON macro_revisions(turn_id, finalised_at);
    CREATE INDEX idx_macro_runs_turn_time ON macro_runs(turn_id, used_at);
  `);
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString());
}

const migrationThree = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 3').get();
if (!migrationThree) {
  db.exec(`
    CREATE TABLE agent_configurations (
      experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
      agent_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      temperature REAL,
      prompt_version TEXT NOT NULL,
      configured_at TEXT NOT NULL,
      PRIMARY KEY (experiment_id, agent_id)
    );
  `);
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString());
}

const statements = {
  insertExperiment: db.prepare('INSERT INTO experiments (experiment_id, room_id, environment, created_at, status, stage, score, missed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  insertAgent: db.prepare('INSERT INTO agents (experiment_id, agent_id, brand) VALUES (?, ?, ?)'),
  insertTurn: db.prepare('INSERT INTO turns (experiment_id, agent_id, stage, sequence, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateExperiment: db.prepare('UPDATE experiments SET status = ?, stage = ?, score = ?, missed = ?, finalised_at = ? WHERE experiment_id = ?'),
  updateTurn: db.prepare('UPDATE turns SET status = ? WHERE experiment_id = ? AND agent_id = ? AND stage = ?'),
  activateTurn: db.prepare('UPDATE turns SET status = ?, score_at_start = ?, missed_at_start = ? WHERE experiment_id = ? AND agent_id = ? AND stage = ?'),
  endTurn: db.prepare('UPDATE turns SET status = ?, score_at_end = ?, missed_at_end = ? WHERE experiment_id = ? AND agent_id = ? AND stage = ?'),
  setFirstServe: db.prepare('UPDATE turns SET first_successful_serve_at = COALESCE(first_successful_serve_at, ?) WHERE experiment_id = ? AND agent_id = ? AND stage = ?'),
  findTurn: db.prepare('SELECT id FROM turns WHERE experiment_id = ? AND agent_id = ? AND stage = ?'),
  insertEvent: db.prepare('INSERT INTO agent_events (experiment_id, agent_id, brand, occurred_at, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?)'),
  insertKnowledge: db.prepare('INSERT INTO knowledge_revisions (experiment_id, agent_id, kind, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)'),
  insertTicketEvent: db.prepare('INSERT INTO ticket_events (experiment_id, turn_id, agent_id, stage, ticket_id, ticket_name, event_kind, occurred_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  insertNotepadRevision: db.prepare('INSERT INTO notepad_revisions (experiment_id, turn_id, agent_id, stage, revision, text, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  insertMacroRevision: db.prepare('INSERT INTO macro_revisions (experiment_id, turn_id, agent_id, stage, macro_id, macro_name, shortcut, sequence_json, event_kind, finalised_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  insertMacroRun: db.prepare('INSERT INTO macro_runs (experiment_id, turn_id, agent_id, stage, macro_id, macro_name, shortcut, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  finishMacroRun: db.prepare('UPDATE macro_runs SET ended_at = ?, blocked = ? WHERE id = ?'),
  upsertAgentConfiguration: db.prepare('INSERT OR REPLACE INTO agent_configurations (experiment_id, agent_id, provider, model, temperature, prompt_version, configured_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
};

function iso(ms = Date.now()) { return new Date(ms).toISOString(); }

function createExperiment(experiment, room, sessions) {
  statements.insertExperiment.run(experiment, room.id, environment, iso(), room.status, room.stage, room.score, room.missed);
  sessions.forEach(session => statements.insertAgent.run(experiment, session.player.id, session.brand));
}

function saveTurns(experiment, schedule) {
  schedule.forEach((turn, sequence) => statements.insertTurn.run(experiment, turn.playerId, turn.stageId, sequence, iso(turn.startAt), iso(turn.endAt), 'scheduled'));
}

function saveRoom(experiment, room) {
  statements.updateExperiment.run(room.status, room.stage, room.score, room.missed, room.status === 'finished' ? iso() : null, experiment);
}

function saveTurnStatus(experiment, turn, status) { statements.updateTurn.run(status, experiment, turn.playerId, turn.stageId); }
function turnId(experiment, agentId, stage) { return statements.findTurn.get(experiment, agentId, stage)?.id || null; }
function activateTurn(experiment, turn, room) { statements.activateTurn.run('active', room.score, room.missed, experiment, turn.playerId, turn.stageId); }
function endTurn(experiment, turn, room) { statements.endTurn.run('ended', room.score, room.missed, experiment, turn.playerId, turn.stageId); }
function saveFirstSuccessfulServe(experiment, player, stage, at = Date.now()) { statements.setFirstServe.run(iso(at), experiment, player.id, stage); }

function saveAgentEvent(event) {
  statements.insertEvent.run(event.experimentId, event.agentId, event.brand, event.at, event.kind, JSON.stringify(event.data));
}

function saveKnowledge(experiment, agentId, kind, payload) {
  statements.insertKnowledge.run(experiment, agentId || null, kind, iso(), JSON.stringify(payload));
}

function saveTicketEvent(experiment, player, stage, ticket, eventKind, reason = null, at = Date.now()) {
  statements.insertTicketEvent.run(experiment, turnId(experiment, player?.id, stage), player?.id || null, stage, ticket.id, ticket.name, eventKind, iso(at), reason);
}

function saveNotepadRevision(experiment, player, stage, notepad) {
  statements.insertNotepadRevision.run(experiment, turnId(experiment, player.id, stage), player.id, stage, notepad.revision, notepad.text, iso(notepad.updatedAt));
}

function saveMacroRevision(experiment, player, stage, macro, eventKind, at = Date.now()) {
  statements.insertMacroRevision.run(experiment, turnId(experiment, player.id, stage), player.id, stage, macro.id, macro.name, macro.shortcut, JSON.stringify(macro.sequence), eventKind, iso(at));
}

function startMacroRun(experiment, player, stage, macro, at = Date.now()) {
  return statements.insertMacroRun.run(experiment, turnId(experiment, player.id, stage), player.id, stage, macro.id, macro.name, macro.shortcut, iso(at)).lastInsertRowid;
}

function finishMacroRun(id, blocked, at = Date.now()) { statements.finishMacroRun.run(iso(at), blocked ? 1 : 0, id); }
function saveAgentConfiguration(experiment, player, configuration) {
  statements.upsertAgentConfiguration.run(experiment, player.id, configuration.provider, configuration.model, configuration.temperature, configuration.promptVersion, iso());
}

module.exports = { environment, filePath, createExperiment, saveTurns, saveRoom, saveTurnStatus, activateTurn, endTurn, saveFirstSuccessfulServe, saveAgentEvent, saveKnowledge, saveTicketEvent, saveNotepadRevision, saveMacroRevision, startMacroRun, finishMacroRun, saveAgentConfiguration };
