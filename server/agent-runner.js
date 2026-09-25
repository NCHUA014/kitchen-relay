/* Local controlled-agent runner. It keeps API keys and agent tokens outside the model prompt. */
const fs = require('fs');
const path = require('path');

const configPath = process.argv[2] || path.join(__dirname, 'runner.config.json');
if (!fs.existsSync(configPath)) throw new Error(`Runner configuration not found: ${configPath}\nCopy runner.config.example.json to runner.config.json and fill in your model settings.`);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const baseUrl = String(config.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
const researcherToken = process.env[config.researcherTokenEnv || 'RESEARCHER_TOKEN'] || 'local-researcher-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  assert(reply && typeof reply === 'object' && Array.isArray(reply.actions) && reply.actions.length >= 1 && reply.actions.length <= 8, 'Model response needs an actions array with one to eight actions.');
  assert(reply.actions.every(action => action && typeof action.action === 'string'), 'Each action needs an action name.');
  return { reasoningSummary: String(reply.reasoning_summary || '').trim().slice(0, 1000), actions: reply.actions.map(normalizeAction) };
}
function normalizeAction(action) {
  const normalized = { ...action };
  if (normalized.action === 'move' && normalized.direction && typeof normalized.direction === 'object') {
    const directions = { '0,-1': 'up', '0,1': 'down', '-1,0': 'left', '1,0': 'right' };
    normalized.direction = directions[`${normalized.direction.x},${normalized.direction.y}`] || normalized.direction;
  }
  return normalized;
}
function actionDisplay(action) {
  const keyForDirection = { up: 'W', left: 'A', down: 'S', right: 'D' };
  if (action.action === 'move') return `${keyForDirection[action.direction] || '?'} (move ${action.direction || 'unknown'})`;
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
  return `You are a Kitchen Relay research participant. You receive only a server-approved observation and can take declared actions. You have no browser, source-code, database, shell, WebSocket, or other tools. Do not invent game state.

Core game instructions:
- Controls: move = W/A/S/D, interact = E, throw = Q, serve = Space. Use move, interact, throw, and serve; they apply to the tile directly ahead and what you hold.
- Items and plates belong only on clear floor tiles, never counters or bridges. Walking over an item does not pick it up: stand adjacent, face it, then interact.
- Interact picks up, places, prepares, or loads items according to your held item and the adjacent tile. A plate can carry multiple ingredients. Throw intentionally drops what you hold; a loaded plate ejects only its newest ingredient. Serve only a completed held plate while facing the serving window.
- Goal: serve plates that exactly match visible tickets before expiry. After a serve attempt, inspect customerMessage for feedback.
- Cultural handover is the primary research objective; serving tickets provides score and evidence. Early in every turn, open both Notes and Macros to inspect inherited knowledge. Use turn.remainingMs to balance play and handover. The relevant detailed guidance appears in the observation while a panel is open.
- Note: leave accurate discoveries, cautions, and useful macro guidance for the next LLM. Notes and macros persist; the physical kitchen resets each turn.

Return exactly one JSON object, with no Markdown:
{"reasoning_summary":"A concise, research-facing statement of what you observed and why this short plan is useful. Do not provide private chain-of-thought.","actions":[{"action":"one name from availableActions", "...required fields..."}]}

Plan one to eight actions. The server executes them in order and stops at the first blocked, rejected, no-effect, or waiting step. Then you receive the updated observation and lastActionResult. Use short plans only when the steps are safe from the current observation. Decide yourself whether a successful useful sequence should later be saved as a macro; it is never saved automatically. For movement, use exactly {"action":"move","direction":"up"}, "down", "left", or "right". Do not send coordinate vectors. Use only an action name listed in the observation.`;
}
async function callOpenAI(agent, observation) {
  const key = process.env[agent.apiKeyEnv];
  assert(key, `Missing ${agent.apiKeyEnv} for ${agent.brand}.`);
  // No previous_response_id is supplied, and store:false keeps this runner's calls stateless between turns and experiments.
  const request = { model: agent.model, instructions: agentInstructions(), input: JSON.stringify(observation), store: false };
  if (Number.isFinite(Number(agent.temperature))) request.temperature = Number(agent.temperature);
  const response = await requestJson('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return parseModelReply(responseText(response));
}
async function askModel(agent, observation) {
  if (agent.provider === 'openai') return callOpenAI(agent, observation);
  throw new Error(`Unsupported provider "${agent.provider}". The first runner adapter is OpenAI; add a provider adapter before selecting another provider.`);
}
async function observe(token) { return (await requestJson(`${baseUrl}/api/agent/observe`, { headers: { Authorization: `Bearer ${token}` } })).observation; }
async function act(token, actions, reasoningSummary) {
  return requestJson(`${baseUrl}/api/agent/act`, {
    method: 'POST', allowedStatuses: [400, 409], headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions, reasoningSummary }),
  });
}
async function runTurn(agent, token) {
  let actions = 0;
  for (;;) {
    const observation = await observe(token);
    if (observation.status === 'finished' || (actions > 0 && !observation.turn.active)) return;
    if (!observation.turn.active) { await delay(config.pollMs || 500); continue; }
    if (actions >= config.maxActionsPerTurn) {
      console.log(`${agent.brand}: action limit reached; waiting for turn end.`);
      do { await delay(config.pollMs || 500); } while ((await observe(token)).turn.active);
      return;
    }
    let decision;
    try { decision = await askModel(agent, observation); }
    catch (error) { console.error(`${agent.brand}: model response rejected (${error.message}); retrying.`); await delay(config.pollMs || 500); continue; }
    const result = await act(token, decision.actions, decision.reasoningSummary);
    actions += result.steps?.length || decision.actions.length;
    const displays = decision.actions.slice(0, result.steps?.length || decision.actions.length).map(actionDisplay).join(' → ');
    const final = result.steps?.at(-1);
    const detail = final?.reason ? `: ${final.reason}` : '';
    console.log(`${agent.brand}: ${displays}${result.accepted ? '' : ` (${final?.outcome || 'stopped'}${detail})`}`);
    await delay(config.actionDelayMs || 150);
  }
}
async function main() {
  assert(Array.isArray(config.agents) && config.agents.length === 2, 'The Stage 1 handover pilot requires exactly two configured agents.');
  config.agents.forEach(agent => {
    assert(typeof agent.brand === 'string' && agent.brand, 'Each agent needs a brand.');
    assert(typeof agent.provider === 'string' && agent.provider, `${agent.brand} needs a provider.`);
    assert(typeof agent.model === 'string' && agent.model, `${agent.brand} needs a model.`);
    assert(typeof agent.apiKeyEnv === 'string' && agent.apiKeyEnv, `${agent.brand} needs apiKeyEnv.`);
    if (agent.provider === 'openai') assert(process.env[agent.apiKeyEnv], `Missing ${agent.apiKeyEnv} for ${agent.brand}.`);
  });
  const created = await requestJson(`${baseUrl}/api/researcher/experiments`, {
    method: 'POST', headers: { 'x-researcher-token': researcherToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents: config.agents.map(agent => agent.brand), agentConfigurations: config.agents.map(({ brand, provider, model, temperature, promptVersion }) => ({ brand, provider, model, temperature, promptVersion })), mode: 'stage1-handover-pilot', turnSeconds: config.turnSeconds || 180, ticketLifetimeMultiplier: config.ticketLifetimeMultiplier || 3, ticketArrivalMinSeconds: config.ticketArrivalMinSeconds || 25, ticketArrivalMaxSeconds: config.ticketArrivalMaxSeconds || 40 }),
  });
  console.log(`Experiment ${created.experimentId} created in room ${created.roomId}.`);
  console.log('Stage 1 agent A starts now; agent B receives a fresh Stage 1 kitchen but inherits the saved notepad and macros.');
  for (const agent of config.agents) {
    const session = created.agents.find(item => item.brand === agent.brand);
    await runTurn(agent, session.token);
  }
  console.log(`Pilot complete. Read server/runs/${created.experimentId}/events.jsonl and the two per-agent transcripts.`);
}
main().catch(error => { console.error(`Runner failed: ${error.message}`); process.exitCode = 1; });
