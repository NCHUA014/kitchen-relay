(() => {
  const token = document.getElementById('researcher-token');
  const experimentId = document.getElementById('experiment-id');
  const status = document.getElementById('observer-status');
  const data = document.getElementById('observer-data');
  const summary = document.getElementById('observer-summary');
  const tickets = document.getElementById('observer-tickets');
  const map = document.getElementById('observer-map');
  const events = document.getElementById('observer-events');
  const researchPanel = document.getElementById('research-panel');
  const agentPanelMirror = document.getElementById('agent-panel-mirror');
  const panelButtons = [...document.querySelectorAll('[data-panel]')];
  let poll = null;
  let selectedPanel = null;
  let latestPayload = null;

  function card(label, value) {
    const element = document.createElement('article'); element.className = 'observer-card';
    const heading = document.createElement('strong'); heading.textContent = label;
    const content = document.createElement('div'); content.textContent = value;
    element.append(heading, content); return element;
  }
  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function glyphForItem(item) {
    return ({ tomato: '🍅', lettuce: '🥬', pickle: '🥒', chicken: '🍗', bun: '🍔' })[item] || '•';
  }
  function describeEvent(event) {
    const who = event.playerName || 'Agent';
    if (event.type === 'move') return `${who} moved to (${event.gc}, ${event.gr}).`;
    if (event.type === 'pivot') return `${who} turned to face (${event.dir?.x}, ${event.dir?.y}).`;
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
    map.replaceChildren();
    payload.map.forEach((row, r) => row.forEach((tile, c) => {
      const cell = document.createElement('div'); cell.className = `observer-cell ${tile.type}`;
      cell.textContent = occupants.get(`${c},${r}`) || glyph[tile.type] || '';
      cell.title = `${c},${r}: ${tile.type}`; map.append(cell);
    }));
  }
  function drawTickets(payload) {
    tickets.replaceChildren();
    if (!payload.tickets.length) { tickets.textContent = 'No current tickets.'; return; }
    payload.tickets.forEach(ticket => {
      const element = document.createElement('article'); element.className = 'observer-ticket';
      const title = document.createElement('strong'); title.textContent = ticket.name;
      const needs = document.createElement('small'); needs.textContent = (ticket.displayNeeds || ticket.needs || []).join(' · ') || 'Recipe hidden';
      const timer = document.createElement('small'); timer.textContent = `Order: ${formatTime(new Date(ticket.expiresAt).getTime() - Date.now())}`;
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
    researchPanel.replaceChildren();
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
    status.textContent = `Observing ${payload.experimentId} (updates every second).`;
    const turnLabel = payload.turn ? `Agent ${payload.turn.number}: ${payload.turn.agent}` : 'No active agent';
    const held = payload.activeHolding?.kind === 'plate'
      ? `🍽️ ${payload.activeHolding.contents.map(item => glyphForItem(item.item)).join(' ') || 'empty'}`
      : payload.activeHolding ? glyphForItem(payload.activeHolding.item?.item) : 'Nothing';
    summary.replaceChildren(card('Kitchen', payload.roomId), card('Status', payload.status), card('Stage', `Stage ${payload.stage}`), card('Agent', turnLabel), card('Holding', held), card('Customer feedback', payload.customerMessage || 'Waiting for an order.'), card('Turn remaining', payload.turn ? formatTime(payload.turn.remainingMs) : '—'), card('Score', payload.score), card('Missed', payload.missed));
    drawTickets(payload); drawMap(payload);
    events.textContent = payload.events.map(event => `${new Date(event.at).toLocaleTimeString()}  ${describeEvent(event)}`).join('\n') || 'No game events yet.';
    drawResearchPanel(payload, selectedPanel); data.classList.remove('hidden');
    drawAgentPanelMirror(payload);
  }
  async function load() {
    const id = experimentId.value.trim();
    if (!id || !token.value) { status.textContent = 'Both fields are required.'; return; }
    try {
      const response = await fetch(`/api/researcher/experiments/${encodeURIComponent(id)}`, { headers: { 'x-researcher-token': token.value } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to observe experiment.');
      render(payload);
    } catch (error) { status.textContent = error.message; data.classList.add('hidden'); }
  }
  panelButtons.forEach(button => button.addEventListener('click', () => {
    selectedPanel = button.dataset.panel === selectedPanel ? null : button.dataset.panel;
    if (latestPayload) drawResearchPanel(latestPayload, selectedPanel);
    load();
  }));
  document.getElementById('load-experiment').addEventListener('click', () => { clearInterval(poll); load(); poll = setInterval(load, 1000); });
})();
