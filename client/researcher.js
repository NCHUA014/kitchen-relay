(() => {
  const token = document.getElementById('researcher-token');
  const experimentId = document.getElementById('experiment-id');
  const status = document.getElementById('observer-status');
  const data = document.getElementById('observer-data');
  const summary = document.getElementById('observer-summary');
  const map = document.getElementById('observer-map');
  const events = document.getElementById('observer-events');
  let poll = null;

  function card(label, value) {
    const element = document.createElement('article');
    element.className = 'observer-card';
    const heading = document.createElement('strong'); heading.textContent = label;
    const content = document.createElement('div'); content.textContent = value;
    element.append(heading, content);
    return element;
  }

  function drawMap(payload) {
    const glyph = { crate_tomato: '🍅', crate_lettuce: '🥬', crate_pickle: '🥒', crate_bun: '🍔', crate_chicken: '🍗', board: '🔪', stove: '🔥', plates: '🍽️', trash: '🗑️', serve: '🪟', bridge: '🟫' };
    const occupants = new Map();
    payload.players.forEach(player => occupants.set(`${player.position.c},${player.position.r}`, '●'));
    payload.world.buns.forEach(item => { if (item.holderId === null) occupants.set(`${item.c},${item.r}`, '🍔'); });
    payload.world.ingredients.forEach(item => { if (item.holderId === null) occupants.set(`${item.c},${item.r}`, glyph[`crate_${item.item}`] || '●'); });
    payload.world.plates.forEach(item => { if (item.holderId === null) occupants.set(`${item.c},${item.r}`, '🍽️'); });
    map.replaceChildren();
    payload.worldMap.forEach((row, r) => row.forEach((tile, c) => {
      const cell = document.createElement('div');
      cell.className = `observer-cell ${tile.type}`;
      cell.textContent = occupants.get(`${c},${r}`) || glyph[tile.type] || '';
      cell.title = `${c},${r}: ${tile.type}`;
      map.append(cell);
    }));
  }

  async function load() {
    const id = experimentId.value.trim();
    if (!id || !token.value) { status.textContent = 'Both fields are required.'; return; }
    try {
      const response = await fetch(`/api/researcher/experiments/${encodeURIComponent(id)}`, { headers: { 'x-researcher-token': token.value } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to observe experiment.');
      status.textContent = `Observing ${payload.experimentId} (updates every second).`;
      summary.replaceChildren(
        card('Kitchen', payload.roomId), card('Status', payload.status), card('Stage', payload.stage),
        card('Score', payload.score), card('Missed', payload.missed),
        card('Players', payload.players.map(player => `${player.name} (${player.position.c}, ${player.position.r})`).join(', ')),
        card('Notes', payload.notes.length), card('Macros', payload.macros.map(macro => macro.name).join(', ') || 'None'),
      );
      drawMap({ ...payload, worldMap: payload.map });
      events.textContent = payload.events.map(event => JSON.stringify(event)).join('\n');
      data.classList.remove('hidden');
    } catch (error) { status.textContent = error.message; data.classList.add('hidden'); }
  }

  document.getElementById('load-experiment').addEventListener('click', () => {
    clearInterval(poll); load(); poll = setInterval(load, 1000);
  });
})();
