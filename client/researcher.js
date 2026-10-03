(() => {
  const token = document.getElementById('researcher-token');
  const experimentId = document.getElementById('experiment-id');
  const status = document.getElementById('observer-status');
  const data = document.getElementById('observer-data');
  const summary = document.getElementById('observer-summary');
  const tickets = document.getElementById('observer-tickets');
  const map = document.getElementById('observer-map');
  const lastAction = document.getElementById('observer-last-action');
  const events = document.getElementById('observer-events');
  const researchPanel = document.getElementById('research-panel');
  const agentPanelMirror = document.getElementById('agent-panel-mirror');
  const panelButtons = [...document.querySelectorAll('[data-panel]')];
  let poll = null;
  let pollingInFlight = false;
  // The local runner submits planned keys roughly every 100ms. Match that pace
  // so the spectator map can show individual steps and pivots rather than
  // appearing to jump across a route once a second.
  const OBSERVER_POLL_MS = 100;
  let selectedPanel = null;
  let latestPayload = null;

  function card(label, value) {
    const element = document.createElement('article'); element.className = 'observer-card';
    const heading = document.createElement('strong'); heading.textContent = label;
    const content = document.createElement('div');
    if (value instanceof Node) content.append(value);
    else content.textContent = value;
    element.append(heading, content); return element;
  }
  function ticketStatusCard(payload) {
    const element = document.createElement('article'); element.className = 'observer-card ticket-status-card';
    const heading = document.createElement('strong'); heading.textContent = 'Tickets';
    const items = document.createElement('div'); items.className = 'ticket-status-items';
    const pending = (payload.tickets || []).filter(ticket => ticket.kind !== 'handover').length;
    [['Completed', payload.completedTickets || 0], ['Missed', payload.missed || 0], ['Pending', pending]].forEach(([label, value]) => {
      const item = document.createElement('div');
      const caption = document.createElement('span'); caption.textContent = label;
      const count = document.createElement('b'); count.textContent = value;
      item.append(caption, count); items.append(item);
    });
    element.append(heading, items); return element;
  }
  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function glyphForItem(item) {
    return ({ tomato: '🍅', lettuce: '🥬', pickle: '🥒', chicken: '🍗', bun: '🍔' })[item] || '•';
  }
  function itemVisual(item) {
    const details = typeof item === 'string' ? { item } : item || {};
    if (details.item === 'chicken' && details.burnt) {
      const image = document.createElement('img');
      image.className = 'observer-held-state'; image.src = 'assets/burnt-chicken.png'; image.alt = 'Burnt chicken';
      return image;
    }
    if (details.item === 'chicken' && !details.cooked) {
      const image = document.createElement('img');
      image.className = 'observer-held-state observer-raw-held-chicken'; image.src = 'assets/raw-chicken.png'; image.alt = 'Raw chicken';
      return image;
    }
    if (details.chopped && ['tomato', 'lettuce'].includes(details.item)) {
      const image = document.createElement('img');
      image.className = 'observer-held-state'; image.src = `assets/sliced-${details.item}.png`; image.alt = `Chopped ${details.item}`;
      return image;
    }
    const glyph = document.createElement('span'); glyph.textContent = glyphForItem(details.item); return glyph;
  }
  function holdingVisual(holding) {
    const display = document.createElement('span'); display.className = 'observer-holding-display';
    if (!holding) { display.textContent = 'Nothing'; return display; }
    if (holding.kind === 'plate') {
      const plate = document.createElement('span'); plate.textContent = '🍽️'; display.append(plate);
      holding.contents.forEach(item => display.append(itemVisual(item)));
      return display;
    }
    display.append(itemVisual(holding.item)); return display;
  }
  function describeEvent(event) {
    const who = event.playerName || 'Agent';
    if (event.type === 'move') return `${who} moved to (${event.gc}, ${event.gr}).`;
    if (event.type === 'pivot') return `${who} turned to face (${event.dir?.x}, ${event.dir?.y}).`;
    if (event.type === 'bridge-carried') return `The moving bridge carried ${who} from row ${event.fromRow} to row ${event.toRow}.`;
    if (event.type === 'command') return `${who} sent a ${String(event.command || 'game').replaceAll('-', ' ')} command.`;
    if (event.type === 'stage-reset') return `The server reset the physical kitchen for Stage ${event.stageId}.`;
    return String(event.type || 'server event').replaceAll('-', ' ');
  }
  function drawMap(payload) {
    const glyph = { crate_tomato: '🍅', crate_lettuce: '🥬', crate_pickle: '🥒', crate_bun: '🍔', crate_chicken: '🍗', board: '🔪', stove: '🔥', plates: '🍽️', trash: '🗑️', serve: '🛎️', bridge: '🟨' };
    const occupants = new Map();
    payload.players.forEach(player => occupants.set(`${player.position.c},${player.position.r}`, '●'));
    payload.world.buns.forEach(item => { if (item.holderId === null) occupants.set(`${item.c},${item.r}`, '🍔'); });
    payload.world.ingredients.forEach(item => { if (item.holderId === null) occupants.set(`${item.c},${item.r}`, glyph[`crate_${item.item}`] || '●'); });
    payload.world.plates.forEach(item => { if (item.holderId === null) occupants.set(`${item.c},${item.r}`, item.contents?.length ? '🍽️🥗' : '🍽️'); });
    const choppedFloorIngredients = new Map(payload.world.ingredients
      .filter(item => item.holderId === null && item.chopped && ['tomato', 'lettuce'].includes(item.item))
      .map(item => [`${item.c},${item.r}`, item]));
    const burntChickenIngredients = new Map(payload.world.ingredients
      .filter(item => item.holderId === null && item.item === 'chicken' && item.burnt)
      .map(item => [`${item.c},${item.r}`, item]));
    map.replaceChildren();
    payload.map.forEach((row, r) => row.forEach((tile, c) => {
      const cell = document.createElement('div'); cell.className = `observer-cell ${tile.type}`;
      const occupied = occupants.has(`${c},${r}`);
      cell.textContent = occupants.get(`${c},${r}`) || glyph[tile.type] || '';
      const choppedIngredient = choppedFloorIngredients.get(`${c},${r}`);
      const burntChicken = burntChickenIngredients.get(`${c},${r}`);
      if (burntChicken) {
        cell.textContent = '';
        const image = document.createElement('img');
        image.className = 'observer-burnt-chicken'; image.src = 'assets/burnt-chicken.png'; image.alt = 'Burnt chicken';
        cell.append(image);
      } else if (choppedIngredient) {
        cell.textContent = '';
        const image = document.createElement('img');
        image.className = 'observer-chopped-ingredient';
        image.src = `assets/sliced-${choppedIngredient.item}.png`;
        image.alt = `Chopped ${choppedIngredient.item}`;
        cell.append(image);
      }
      if (!occupied && tile.type === 'crate_chicken' && payload.stage >= 2) {
        cell.textContent = '';
        const rawChicken = document.createElement('img');
        rawChicken.className = 'observer-raw-chicken';
        rawChicken.src = 'assets/raw-chicken.png';
        rawChicken.alt = 'Raw chicken station';
        cell.append(rawChicken);
      }
      const activePlayer = payload.players.find(player => player.position.c === c && player.position.r === r);
      if (activePlayer) {
        const facing = ({ '0,-1': 'north', '0,1': 'south', '-1,0': 'west', '1,0': 'east' })[`${activePlayer.direction?.x || 0},${activePlayer.direction?.y || 0}`] || 'south';
        cell.textContent = '';
        cell.classList.add('observer-player');
        const agent = document.createElement('span');
        agent.className = `observer-agent facing-${facing}`;
        const head = document.createElement('span'); head.className = 'observer-agent-head';
        agent.append(head); cell.append(agent);
        const panelKind = payload.researcherPanel?.agentId === activePlayer.id ? payload.researcherPanel.kind : null;
        if (panelKind === 'notes' || panelKind === 'macros') {
          const marker = document.createElement('span');
          marker.className = `observer-knowledge-marker ${panelKind}`;
          marker.textContent = panelKind === 'notes' ? 'N' : 'M';
          marker.title = `${activePlayer.name} has ${panelKind === 'notes' ? 'Notes' : 'Macros'} open`;
          cell.append(marker);
        }
        if (payload.activeHolding) {
          const held = document.createElement('span'); held.className = 'observer-held';
          if (payload.activeHolding.kind === 'plate') {
            const plate = document.createElement('span'); plate.textContent = '🍽️'; held.append(plate);
            payload.activeHolding.contents.forEach(item => held.append(itemVisual(item)));
          } else held.append(itemVisual(payload.activeHolding.item));
          cell.append(held);
        }
      }
      cell.title = `${c},${r}: ${tile.type}`; map.append(cell);
    }));
  }
  function describeAction(actionRecord) {
    const action = actionRecord?.action;
    if (!action) return 'Waiting for an agent action.';
    const keys = { up: 'W', left: 'A', down: 'S', right: 'D' };
    let description;
    if (action.action === 'move') description = `${keys[action.direction] || '?'} — ${action.direction || 'unknown'}`;
    else if (action.action === 'pivot') description = `Shift+${({ north: 'W', west: 'A', south: 'S', east: 'D' })[action.direction] || '?'} — pivot ${action.direction || 'unknown'}`;
    else if (action.action === 'interact') description = 'E — interact';
    else if (action.action === 'throw') description = 'Q — throw / drop';
    else if (action.action === 'serve') description = 'Space — serve';
    else if (action.action === 'runMacro') description = `${String(action.shortcut || '?').toUpperCase()} — run macro`;
    else description = action.action;
    if (actionRecord.step?.outcome && actionRecord.step.outcome !== 'succeeded') description += ` (${actionRecord.step.outcome})`;
    return `${actionRecord.brand || 'Agent'}: ${description}`;
  }
  function drawTickets(payload) {
    tickets.replaceChildren();
    if (!payload.tickets.length) { tickets.textContent = 'No current tickets.'; return; }
    payload.tickets.forEach(ticket => {
      const element = document.createElement('article'); element.className = 'observer-ticket';
      const title = document.createElement('strong'); title.textContent = ticket.name;
      const needs = document.createElement('small');
      needs.textContent = ticket.kind === 'handover'
        ? (ticket.displayNeeds || []).join(' ') || 'Observe environment carefully and give sufficient notes and macros for smooth handover to next agent.'
        : (ticket.displayNeeds || ticket.needs || []).join(' · ') || 'Recipe: hidden';
      const timer = document.createElement('small'); timer.textContent = ticket.kind === 'handover' ? `Handover window: ${formatTime(new Date(ticket.expiresAt).getTime() - Date.now())}` : `Order: ${formatTime(new Date(ticket.expiresAt).getTime() - Date.now())}`;
      element.append(title, needs, document.createElement('br'), timer); tickets.append(element);
    });
  }
  function appendEntry(parent, metadata, content) {
    const entry = document.createElement('article'); entry.className = 'research-entry';
    const label = document.createElement('small'); label.textContent = metadata;
    const body = document.createElement('div'); body.textContent = content;
    entry.append(label, body); parent.append(entry);
  }
  function drawResearchPanel(payload, panel) {
    panelButtons.forEach(button => button.classList.toggle('active', button.dataset.panel === panel));
    const priorScrollTop = researchPanel.scrollTop;
    researchPanel.replaceChildren();
    researchPanel.classList.toggle('react-panel', panel === 'react');
    if (!panel) { researchPanel.classList.add('hidden'); return; }
    researchPanel.classList.remove('hidden');
    const heading = document.createElement('div'); heading.className = 'research-panel-header';
    const title = document.createElement('h2'); title.textContent = panel === 'react' ? 'ReAct trail' : panel === 'notes' ? 'Shared notepad' : 'Shared macros';
    const state = document.createElement('span'); state.textContent = payload.researcherPanel?.kind === panel ? `${payload.researcherPanel.brand} has this panel open` : 'Researcher review';
    heading.append(title, state); researchPanel.append(heading);
    if (panel === 'notes') {
      appendEntry(researchPanel, `Current revision ${payload.notepad.revision} · ${payload.notepad.author || 'No author yet'}`, payload.notepad.text || 'No saved notes yet.');
      payload.research.notes.forEach(item => appendEntry(researchPanel, `${item.brand} saved · ${new Date(item.at).toLocaleTimeString()}`, item.text));
    } else if (panel === 'macros') {
      if (!payload.macros.length) appendEntry(researchPanel, 'Current macros', 'No saved macros yet.');
      payload.macros.forEach(macro => appendEntry(researchPanel, `${macro.name} · key ${macro.shortcut}`, (macro.sequence || []).join(' → ') || 'No sequence'));
      payload.research.macros.forEach(item => appendEntry(researchPanel, `${item.brand} saved macro collection · ${new Date(item.at).toLocaleTimeString()}`, `${item.macros.length} macro(s)`));
    } else {
      if (!payload.research.react.length) appendEntry(researchPanel, 'No ReAct entries yet', 'The agent has not sent a reasoning summary.');
      payload.research.react.forEach(item => appendEntry(researchPanel, `${item.brand} · ${new Date(item.at).toLocaleTimeString()}`, item.summary));
    }
    if (panel === 'react') researchPanel.scrollTop = priorScrollTop;
  }
  function drawAgentPanelMirror(payload) {
    agentPanelMirror.replaceChildren();
    const panel = payload.researcherPanel;
    if (!panel) { agentPanelMirror.classList.add('hidden'); return; }
    agentPanelMirror.classList.remove('hidden');
    const heading = document.createElement('div'); heading.className = 'research-panel-header';
    const title = document.createElement('h2'); title.textContent = `${panel.brand} is currently viewing ${panel.kind === 'notes' ? 'Notes' : 'Macros'}`;
    const state = document.createElement('span'); state.textContent = 'Live agent mirror';
    heading.append(title, state); agentPanelMirror.append(heading);
    if (panel.kind === 'notes') appendEntry(agentPanelMirror, `Notepad revision ${payload.notepad.revision}`, payload.notepad.text || 'No saved notes yet.');
    else if (!payload.macros.length) appendEntry(agentPanelMirror, 'Current macros', 'No saved macros yet.');
    else payload.macros.forEach(macro => appendEntry(agentPanelMirror, `${macro.name} · key ${macro.shortcut}`, (macro.sequence || []).join(' → ') || 'No sequence'));
  }
  function render(payload) {
    payload.research ||= { notes: [], macros: [], react: [] };
    payload.research.notes ||= []; payload.research.macros ||= []; payload.research.react ||= [];
    payload.researcherPanel ||= null;
    latestPayload = payload;
    status.textContent = `Observing ${payload.experimentId} (live updates every 100ms).`;
    const turnLabel = payload.turn ? `Agent ${payload.turn.number}: ${payload.turn.agent}` : 'No active agent';
    const held = holdingVisual(payload.activeHolding);
    const keys = payload.keystrokes || { manual: 0, macros: 0, total: 0 };
    summary.replaceChildren(card('Kitchen', payload.roomId), card('Status', payload.status), card('Stage', `Stage ${payload.stage}`), card('Agent', turnLabel), card('Holding', held), card('Keystrokes · 65%', `${keys.total} total · ${keys.manual} manual · ${keys.macros} macro`), card('Customer feedback', payload.customerMessage || 'Waiting for an order.'), card('Turn remaining', payload.turn ? formatTime(payload.turn.remainingMs) : '—'), card('Score · 35%', payload.score), ticketStatusCard(payload));
    drawTickets(payload); drawMap(payload);
    lastAction.replaceChildren(); const actionLabel = document.createElement('strong'); actionLabel.textContent = 'Last key'; lastAction.append(actionLabel, document.createTextNode(describeAction(payload.lastAgentAction)));
    events.textContent = payload.events.map(event => `${new Date(event.at).toLocaleTimeString()}  ${describeEvent(event)}`).join('\n') || 'No game events yet.';
    drawResearchPanel(payload, selectedPanel); data.classList.remove('hidden');
    drawAgentPanelMirror(payload);
  }
  async function load() {
    if (pollingInFlight) return;
    const id = experimentId.value.trim();
    if (!id || !token.value) { status.textContent = 'Both fields are required.'; return; }
    pollingInFlight = true;
    try {
      const response = await fetch(`/api/researcher/experiments/${encodeURIComponent(id)}`, { headers: { 'x-researcher-token': token.value } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to observe experiment.');
      if (payload.status === 'waiting') {
        const start = await fetch(`/api/researcher/experiments/${encodeURIComponent(id)}/start`, { method: 'POST', headers: { 'x-researcher-token': token.value } });
        const started = await start.json();
        if (!start.ok) throw new Error(started.error || 'Unable to start experiment.');
        status.textContent = `Started ${id}; observing live updates.`;
        return load();
      }
      render(payload);
    } catch (error) { status.textContent = error.message; data.classList.add('hidden'); }
    finally { pollingInFlight = false; }
  }
  panelButtons.forEach(button => button.addEventListener('click', () => {
    selectedPanel = button.dataset.panel === selectedPanel ? null : button.dataset.panel;
    if (latestPayload) drawResearchPanel(latestPayload, selectedPanel);
    load();
  }));
  document.getElementById('load-experiment').addEventListener('click', () => { clearInterval(poll); load(); poll = setInterval(load, OBSERVER_POLL_MS); });
})();
