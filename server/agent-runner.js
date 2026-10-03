/* Local controlled-agent runner. It keeps API keys and agent tokens outside the model prompt. */
const fs = require('fs');
const path = require('path');

const configPath = process.argv[2] || path.join(__dirname, 'runner.config.json');
if (!fs.existsSync(configPath)) throw new Error(`Runner configuration not found: ${configPath}\nCopy runner.config.example.json to runner.config.json and fill in your model settings.`);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const baseUrl = String(config.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
const researcherToken = process.env[config.researcherTokenEnv || 'RESEARCHER_TOKEN'] || 'local-researcher-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_BURST_ACTIONS = 20;
const PRIVATE_MEMORY_MAX_ENTRIES = 16;
const PRIVATE_MEMORY_MAX_CHARACTERS = 6000;

function assert(condition, message) { if (!condition) throw new Error(message); }
async function requestJson(url, options = {}) {
  const { allowedStatuses = [], ...fetchOptions } = options;
  const response = await fetch(url, fetchOptions);
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !allowedStatuses.includes(response.status)) throw new Error(`${fetchOptions.method || 'GET'} ${url} failed (${response.status}): ${body.error || JSON.stringify(body)}`);
  return body;
}
function parseModelReply(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model response did not contain a JSON object.');
  const reply = JSON.parse(source.slice(start, end + 1));
  assert(reply && typeof reply === 'object' && Array.isArray(reply.actions) && reply.actions.length >= 1 && reply.actions.length <= MAX_BURST_ACTIONS, `Model response needs an actions array with one to ${MAX_BURST_ACTIONS} actions.`);
  assert(reply.actions.every(action => action && typeof action.action === 'string'), 'Each action needs an action name.');
  return { reasoningSummary: String(reply.reasoning_summary || '').trim().slice(0, 1000), actions: reply.actions.map(normalizeAction) };
}
function normalizeAction(action) {
  const normalized = { ...action };
  if (['move', 'pivot'].includes(normalized.action) && normalized.direction && typeof normalized.direction === 'object') {
    const directions = { '0,-1': 'up', '0,1': 'down', '-1,0': 'left', '1,0': 'right' };
    normalized.direction = directions[`${normalized.direction.x},${normalized.direction.y}`] || normalized.direction;
  }
  if (normalized.action === 'pivot') normalized.direction = ({ up: 'north', down: 'south', left: 'west', right: 'east' })[normalized.direction] || normalized.direction;
  return normalized;
}
function actionDisplay(action) {
  const keyForDirection = { up: 'W', left: 'A', down: 'S', right: 'D' };
  if (action.action === 'move') return `${keyForDirection[action.direction] || '?'} (${action.direction || 'unknown'})`;
  if (action.action === 'pivot') return `Shift+${({ north: 'W', west: 'A', south: 'S', east: 'D' })[action.direction] || '?'} (pivot ${action.direction || 'unknown'})`;
  if (action.action === 'serve') return 'Space (serve)';
  if (action.action === 'runMacro') return `${String(action.shortcut || '?').toUpperCase()} (run macro)`;
  const interactActions = new Set(['interact', 'pickupBun', 'pickupIngredient', 'placeIngredient', 'processIngredient', 'takePlate', 'pickupPlate', 'discardPlate', 'addToPlate', 'addFloorItemToPlate', 'addStationItemToPlate']);
  if (interactActions.has(action.action)) return `E (interact: ${action.action})`;
  const throwActions = new Set(['throw', 'dropBun', 'dropIngredient', 'dropPlate', 'removePlateItem']);
  if (throwActions.has(action.action)) return `Q (throw/drop: ${action.action})`;
  return action.action;
}
function responseText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  return (response.output || [])
    .flatMap(item => item.content || [])
    .filter(content => content.type === 'output_text' && typeof content.text === 'string')
    .map(content => content.text)
    .join('');
}
function agentInstructions() {
  return `You are a Kitchen Relay research participant.

You are one member of a team of agents. The whole relay—not one agent alone—is evaluated. Your most important responsibility is to leave useful, accurate cultural handover for future agents through Notes and Macros. Score and missed tickets are useful evidence of learning, but are less important than the team’s accumulated knowledge.

You receive only the approved game observation and may use only the declared actions. You do not have access to a browser, page source, DevTools, database, shell, WebSocket, or any other tools. Do not invent state that is not visible in your observation.

Controls and interaction:
- Move: W, A, S, D. Interact: E. Throw/drop: Q. Serve: Space.
- W attempts to move north and faces north; A west; S south; D east. This sets the matching facing direction regardless of the earlier direction. Shift+W/A/S/D pivots north/west/south/east without moving. Use the controlled action {"action":"pivot","direction":"north"}, "west", "south", or "east" for a turn-only pivot.
- These actions affect the tile directly in front of you. The facing field identifies that live tile and any item on it. To collect a floor item or use a station, stand beside it, face it, then interact. Walking over an item does not collect it.
- Coordinate examples: if you stand at (4,2) facing north, facing.position is (4,1). If that facing tile is floor with floorItem lettuce and your hands are empty, use {"action":"interact"} to pick up the lettuce. If you stand at (4,1) facing north and facing.tile is crate_lettuce, the same action takes lettuce from the crate. With a plate held, interacting with either source adds that ingredient to the plate instead. These are interface examples only: use the current live coordinates and facing field, not these example coordinates.
- Floor pickup example: for a loose tomato at (4,4), stand on any clear adjacent tile and face the tomato: (4,5) facing north, (4,3) facing south, (3,4) facing east, or (5,4) facing west. Then use {"action":"interact"}. Do not stand on the item tile; walking over it does not collect it. These coordinates are only an interface example; use the current live map.
- Preparation-station interaction: facing.stationItem means an ingredient is sitting on the board or stove directly ahead; it is not a floor item. With one ingredient held, interact while facing a board or stove to place it there. With empty hands, interact with a compatible raw station item to operate that station; after it is prepared, interact with empty hands to hold it. With a plate held, interact with a station item to transfer that item onto the plate. These are mechanics, not a statement of which items need preparation.
- Once your turn starts, mapCoordinates and landmarks give the exact current map. Coordinates are zero-based with (0,0) at the top-left. Treat those live values as authoritative when a new stage may differ from an inherited Note.
- Loose ingredients do not stack in your hands: a plate is the only container that can stack non-plate ingredients. Before assembling a multi-item order, obtain and hold an empty plate, then face each source, floor item, or station item and interact to add it one at a time. With empty hands, E picks up a floor ingredient directly ahead. While holding a plate, E adds that floor ingredient directly ahead to the plate instead. To put down everything you are holding, face a clear empty floor tile and press E: a loose item is placed there, while a plate is placed there intact with all of its contents. This differs from Q: with a loaded plate, Q releases only its newest ingredient; with a loose item, Q drops that one item. If you are holding one loose ingredient but need a plate, either E or Q can place it onto clear floor; after obtaining a plate, face the dropped ingredient and interact to add it. Serve only while holding a completed plate and facing the serving window. Read customerMessage after a serve attempt.
- Items and plates belong only on clear floor tiles, never counters or bridges.

Your team responsibility:
- Early in every turn, inspect Notes and Macros once. If you are first in the relay, empty Notes and Macros are expected: discover useful facts, then leave them for the next agent.
- Opening Notes lets you review the inherited handover. Use saveNotepad only after changing its text: saving creates a shared revision and automatically closes Notes. If you only read Notes, use closeNotepad; it records no revision and does not alter the shared document.
- Opening Macros lets you review inherited sequences. A successful createMacro, editMacro, or deleteMacro saves that mutation and automatically closes Macros. If you only reviewed the collection, use closeMacros; it creates no macro revision.
- workingKnowledge remembers panels already reviewed during this turn. Do not reopen an unchanged panel hoping for new information.
- Treat inherited Notes as useful evidence, not an unquestionable live-state feed. Verify a note's position, route, ticket, available action, and failure claim against your current observation before acting. In particular, a note that an action was unavailable may have been written during briefing, after a turn ended, or under an earlier environment; check availableActions now.
- handoverProgress shows your current contribution. Before turn end, make substantive contributions to both Notes and Macros when useful. Do not write empty notes or create ceremonial macros just to increase a count.
- Use Notes for discoveries, cautions, station locations, and macro preconditions. Every created, edited, or retired macro must have a matching comprehensive Note for the next agent: its shortcut, exact sequence, location/start and held-item preconditions, intended result, and any known failure or regression condition. Use Macros for genuinely reusable local action sequences. Macro names must identify the real action and a visible landmark relationship; never call an ordinary location "spawn." Detailed macro instructions appear only when you open Macros.
- Gameplay performance is evaluated as **65% keystroke efficiency** and **35% completed-ticket score**. Each manual W/A/S/D/Q/E/Space action costs one declared keystroke. Running a saved macro costs one declared keystroke even if it performs many saved steps. Prefer verified reusable macros over repeatedly issuing the same manual sequence, while still completing tickets accurately. Investigate and document a macro when an environmental change breaks it.
- Notes and Macros persist to the next agent; the physical kitchen resets each turn. queue.position is your one-based position in the relay.
- Other agents will take later stages after you. Their kitchens may change, but the Notes and Macros you leave are their foundational shared knowledge. Make each handover accurate enough to support their first decisions and help them recognize regressions.
- privateAgentMemory, when present, is a compact record of your own earlier work in this experiment. It follows only you into your next assigned stage; no other agent can read it, and it is discarded for a new experiment. It complements rather than replaces the shared Notes and Macros: future agents can learn only from those shared handovers.
- If preShiftBriefing.active is true, this is protected reading time before your gameplay timer begins. Read the inherited Notes and Macros, then return only readyForShift with a concise briefing summary. Do not attempt gameplay actions.

Return exactly one JSON object, with no Markdown:
{"reasoning_summary":"A concise, research-facing statement of what you observed and why this short plan is useful. Do not provide private chain-of-thought.","actions":[{"action":"one name from availableActions", "...required fields..."}]}

Use burst ReAct: give one concise research-facing reasoning_summary for the whole burst, not a thought for every key. If no new evidence or interpretation has appeared since your immediately prior summary, use an empty reasoning_summary rather than repeating it. Plan one to twenty actions. A local controller executes the planned keys quickly, one at a time. It asks you for a fresh decision after a serve, macro activity, knowledge-panel action, rejected/no-effect action, ticket change, bridge movement, or turn end. Successful collection, placement, preparation, and drop actions may continue within the same short plan. Use longer bursts only when the expected route and interaction sequence are safe. Decide yourself whether a useful sequence should become a macro; it is never saved automatically. For movement, use exactly {"action":"move","direction":"up"}, "down", "left", or "right". Do not send coordinate vectors. Use only an action name listed in the observation.`;
}
function privateObservation(observation, runtime) {
  if (!runtime.memory.length) return observation;
  return {
    ...observation,
    privateAgentMemory: {
      scope: 'Private continuity for this agent only in this experiment. It is unavailable to other agents and resets for a new experiment.',
      entries: runtime.memory,
    },
  };
}
function actionResultSummary(step) {
  if (!step) return 'no server result returned';
  const outcome = step.outcome || 'unknown outcome';
  return step.reason ? `${outcome}: ${step.reason}` : outcome;
}
function remember(runtime, observation, decision, result) {
  const stage = observation.stage?.id ?? observation.turn?.number ?? 'lobby';
  const actions = result?.displayed?.join(' → ') || 'no action';
  const outcome = actionResultSummary(result?.steps?.at(-1));
  const interruption = result?.interruption ? ` Stop: ${result.interruption}.` : '';
  const summary = decision?.reasoningSummary || 'No research-facing summary was supplied.';
  runtime.memory.push(`Stage ${stage}. ${summary} Actions: ${actions}. Result: ${outcome}.${interruption}`);
  while (runtime.memory.length > PRIVATE_MEMORY_MAX_ENTRIES || runtime.memory.join('\n').length > PRIVATE_MEMORY_MAX_CHARACTERS) runtime.memory.shift();
}
async function callOpenAI(agent, observation, runtime) {
  const key = process.env[agent.apiKeyEnv];
  assert(key, `Missing ${agent.apiKeyEnv} for ${agent.brand}.`);
  // The runner, rather than the provider, owns the bounded private continuity memo.
  // Calls remain store:false and do not use previous_response_id.
  const request = { model: agent.model, instructions: agentInstructions(), input: JSON.stringify(privateObservation(observation, runtime)), store: false };
  if (Number.isFinite(Number(agent.temperature))) request.temperature = Number(agent.temperature);
  const response = await requestJson('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return parseModelReply(responseText(response));
}
async function askModel(agent, observation, runtime) {
  if (agent.provider === 'openai') return callOpenAI(agent, observation, runtime);
  throw new Error(`Unsupported provider "${agent.provider}". The first runner adapter is OpenAI; add a provider adapter before selecting another provider.`);
}
async function observe(token) { return (await requestJson(`${baseUrl}/api/agent/observe`, { headers: { Authorization: `Bearer ${token}` } })).observation; }
async function act(token, actions, reasoningSummary) {
  return requestJson(`${baseUrl}/api/agent/act`, {
    method: 'POST', allowedStatuses: [400, 409], headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions, reasoningSummary }),
  });
}
function ticketSignature(observation) {
  return (observation.tickets || []).map(ticket => `${ticket.id}:${ticket.expiresAt || ''}`).join('|');
}
function actionNeedsFreshDecision(action) {
  // Successful collection, placement, preparation, and drop actions can follow
  // the short plan the model already supplied. Stop for actions whose result
  // should be deliberately reviewed before committing to a further plan.
  return ['serve', 'runMacro', 'openNotepad', 'saveNotepad', 'closeNotepad', 'openMacros', 'createMacro', 'editMacro', 'deleteMacro', 'closeMacros'].includes(action.action);
}
async function executeBurst(token, decision, startingObservation) {
  const steps = [];
  const displayed = [];
  const initialBridgeRow = startingObservation.stage?.bridgeRow ?? null;
  const initialTickets = ticketSignature(startingObservation);
  let observation = startingObservation;
  let interruption = null;
  const stepDelayMs = Number(config.controllerStepMs || 100);

  for (let index = 0; index < decision.actions.length; index += 1) {
    const action = decision.actions[index];
    // Submit one key at a time. The server remains authoritative and can reject
    // a key after its own game tick changes the bridge or other world state.
    const result = await act(token, [action], index === 0 ? decision.reasoningSummary : '');
    const step = result.steps?.at(-1) || { action: action.action, outcome: result.accepted ? 'succeeded' : 'stopped' };
    steps.push(step);
    displayed.push(actionDisplay(action));
    observation = result.observation || observation;

    if (step.outcome !== 'succeeded') { interruption = step.outcome; break; }
    if (!observation.turn?.active) { interruption = 'turn ended'; break; }
    if ((observation.stage?.bridgeRow ?? null) !== initialBridgeRow) { interruption = 'bridge moved'; break; }
    if (ticketSignature(observation) !== initialTickets) { interruption = 'tickets changed'; break; }
    if (actionNeedsFreshDecision(action)) { interruption = 'meaningful action completed'; break; }
    if (index < decision.actions.length - 1) await delay(stepDelayMs);
  }
  return { steps, displayed, interruption };
}
async function runTurn(agent, token, runtime) {
  let actions = 0;
  for (;;) {
    const observation = await observe(token);
    if (observation.status === 'finished') return;
    if (actions > 0 && !observation.turn.active) actions = 0;
    if (!observation.turn.active) {
      if (observation.preShiftBriefing?.active && !observation.preShiftBriefing.ready) {
        await act(token, [{ action: 'openNotepad' }]);
        await act(token, [{ action: 'openMacros' }]);
        const briefingObservation = await observe(token);
        try {
          const briefing = await askModel(agent, briefingObservation, runtime);
          await act(token, [{ action: 'readyForShift' }], briefing.reasoningSummary);
          remember(runtime, briefingObservation, briefing, { displayed: ['readyForShift'], steps: [{ outcome: 'succeeded' }], interruption: 'briefing completed' });
          console.log(`${agent.brand}: handover briefing complete; waiting for shift start.`);
        } catch (error) { console.error(`${agent.brand}: handover briefing failed (${error.message}); retrying.`); }
      }
      await delay(config.pollMs || 500); continue;
    }
    if (actions >= config.maxActionsPerTurn) {
      console.log(`${agent.brand}: action limit reached; waiting for turn end.`);
      do { await delay(config.pollMs || 500); } while ((await observe(token)).turn.active);
      actions = 0;
      continue;
    }
    let decision;
    try { decision = await askModel(agent, observation, runtime); }
    catch (error) { console.error(`${agent.brand}: model response rejected (${error.message}); retrying.`); await delay(config.pollMs || 500); continue; }
    const result = await executeBurst(token, decision, observation);
    remember(runtime, observation, decision, result);
    actions += result.steps.length;
    const displays = result.displayed.join(' → ');
    const final = result.steps.at(-1);
    const detail = final?.reason ? `: ${final.reason}` : '';
    const stopped = result.interruption && result.interruption !== 'meaningful action completed' ? ` (${result.interruption}${detail})` : '';
    console.log(`${agent.brand}: ${displays}${stopped}`);
  }
}
async function main() {
  const mode = config.mode || 'stages-1-2-study';
  const requiredAgents = ['stage1-handover-pilot', 'stages-1-3-study'].includes(mode) ? 2 : 1;
  assert(Array.isArray(config.agents) && config.agents.length === requiredAgents, `${mode} requires exactly ${requiredAgents} configured agent(s).`);
  config.agents.forEach(agent => {
    assert(typeof agent.brand === 'string' && agent.brand, 'Each agent needs a brand.');
    assert(typeof agent.provider === 'string' && agent.provider, `${agent.brand} needs a provider.`);
    assert(typeof agent.model === 'string' && agent.model, `${agent.brand} needs a model.`);
    assert(typeof agent.apiKeyEnv === 'string' && agent.apiKeyEnv, `${agent.brand} needs apiKeyEnv.`);
    if (agent.provider === 'openai') assert(process.env[agent.apiKeyEnv], `Missing ${agent.apiKeyEnv} for ${agent.brand}.`);
  });
  const created = await requestJson(`${baseUrl}/api/researcher/experiments`, {
    method: 'POST', headers: { 'x-researcher-token': researcherToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents: config.agents.map(agent => agent.brand), agentConfigurations: config.agents.map(({ brand, provider, model, temperature, promptVersion }) => ({ brand, provider, model, temperature, promptVersion })), mode, turnSeconds: config.turnSeconds || 180, turnSecondsByStage: config.turnSecondsByStage, handoverSecondsByStage: config.handoverSecondsByStage, briefingSeconds: config.briefingSeconds ?? 20, ticketLifetimeMultiplier: config.ticketLifetimeMultiplier || 3, introTicketLifetimeMultiplierByStage: config.introTicketLifetimeMultiplierByStage, guidedTicketPhaseByStage: config.guidedTicketPhaseByStage, ticketArrivalMinSeconds: config.ticketArrivalMinSeconds || 25, ticketArrivalMaxSeconds: config.ticketArrivalMaxSeconds || 40, ticketArrivalByStage: config.ticketArrivalByStage, ticketLifetimeSecondsByStage: config.ticketLifetimeSecondsByStage }),
  });
  console.log(`Experiment ${created.experimentId} created in room ${created.roomId}.`);
  console.log('Waiting for the researcher to click Observe in researcher.html before the relay begins.');
  await Promise.all(config.agents.map(agent => {
    const session = created.agents.find(item => item.brand === agent.brand);
    return runTurn(agent, session.token, { memory: [] });
  }));
  console.log(`Study complete. Read server/runs/${created.experimentId}/events.jsonl and the per-agent transcripts.`);
}
main().catch(error => { console.error(`Runner failed: ${error.message}`); process.exitCode = 1; });
