(() => {
  const byId = id => document.getElementById(id);
  const welcome = byId('welcome-screen');
  const lobby = byId('lobby-screen');
  const status = byId('connection-status');
  const lobbyMessage = byId('lobby-message');
  let socket;
  let inGame = false;
  let spectating = false;
  let finished = false;
  let latestState = null;
  window.kitchenSession = { connected: false, send: () => false };

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message)); return true;
  }
  function formatDate(time) { return new Date(time).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); }
  function render(state) {
    latestState = state;
    byId('lobby-room-id').textContent = state.roomId;
    const active = state.players.filter(player => state.activePlayerIds?.includes(player.id));
    byId('lobby-status').textContent = state.status === 'active'
      ? (state.activePlayerIds?.includes(state.you) ? 'Your shift is active' : `${active.map(player => player.name).join(' and ') || 'A player'} is in the kitchen`)
      : 'Waiting room';
    byId('lobby-count').textContent = `${state.players.length}/${state.maxPlayers}`;
    const players = byId('lobby-players'); players.replaceChildren();
    state.players.forEach(player => { const item = document.createElement('li'); item.textContent = `${player.name}${player.id === state.hostId ? ' (host)' : ''}${player.id === state.you ? ' (you)' : ''}`; players.append(item); });
    const notes = byId('lobby-notes'); notes.replaceChildren();
    if (!state.notes.length) notes.textContent = 'No team notes yet.';
    state.notes.forEach(note => { const item = document.createElement('article'); item.className = 'lobby-note'; item.textContent = `${note.author} · ${formatDate(note.updatedAt)}\n${note.text}`; notes.append(item); });
    byId('start-session-btn').classList.toggle('hidden', state.you !== state.hostId || state.status !== 'waiting');
    window.kitchenSession = { connected: true, state, send };
    window.dispatchEvent(new CustomEvent('kitchen-room-state', { detail: state }));
  }
  function updateElapsed() {
    const firstStart = latestState?.schedule?.[0]?.startAt;
    const el = byId('lobby-elapsed');
    if (!firstStart || latestState.status !== 'active') { el.textContent = ''; return; }
    const seconds = Math.max(0, Math.floor((Date.now() - firstStart) / 1000));
    el.textContent = `Session elapsed: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  setInterval(updateElapsed, 1000);
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}`);
    socket.addEventListener('open', () => status.textContent = 'Connected. Create or join a session.');
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'room-state') {
        welcome.classList.add('hidden');
        if (!inGame && !spectating && !finished) lobby.classList.remove('hidden');
        render(message);
        if (message.status === 'finished') showFinalSummary(message);
      }
      if (message.type === 'error') { status.textContent = message.message; lobbyMessage.textContent = message.message; }
      if (message.type === 'enter-game') { inGame = true; lobby.classList.add('hidden'); byId('app').classList.remove('hidden'); byId('macro-panel').classList.remove('hidden'); byId('overlay').classList.add('hidden'); window.dispatchEvent(new Event('kitchen-enter-game')); }
      if (message.type === 'handover-warning') {
        const text = message.playerId === window.kitchenSession.state?.you
          ? 'Your kitchen shift begins in one minute — get ready.'
          : `${message.playerName} joins the kitchen in one minute.`;
        lobbyMessage.textContent = text;
        window.dispatchEvent(new CustomEvent('kitchen-handover-warning', { detail: { text } }));
      }
      if (message.type === 'player-state') window.dispatchEvent(new CustomEvent('kitchen-player-state', { detail: message }));
      if (message.type === 'shift-ended') { inGame = false; spectating = true; lobby.classList.add('hidden'); byId('app').classList.remove('hidden'); byId('overlay').classList.add('hidden'); byId('macro-panel').classList.add('hidden'); window.dispatchEvent(new Event('kitchen-spectate')); }
      if (message.type === 'session-finished') { finished = true; }
      if (message.type === 'session-ended') { inGame = false; window.kitchenSession = { connected: false, send: () => false }; lobbyMessage.textContent = 'Server ended this session. Live notes were cleared.'; lobby.classList.remove('hidden'); byId('app').classList.add('hidden'); }
    });
    socket.addEventListener('close', () => { status.textContent = 'Disconnected from server.'; window.kitchenSession.connected = false; });
  }
  function showFinalSummary(state) {
    finished = true; spectating = false; inGame = false;
    lobby.classList.add('hidden'); byId('app').classList.add('hidden'); byId('macro-panel').classList.add('hidden');
    window.dispatchEvent(new Event('kitchen-session-finished'));
    byId('notes-modal').classList.add('hidden'); byId('macro-modal').classList.add('hidden');
    const overlay = byId('overlay'); overlay.classList.remove('hidden');
    overlay.innerHTML = `<h1>Session Complete</h1><p><strong>Final score: ${state.score}</strong><br><strong>Missed orders: ${state.missed}</strong><br>Notes remaining: ${state.notes?.length || 0}<br>Macros remaining: ${state.macros?.length || 0}</p>`;
  }
  function join(action) { send({ type: 'join-room', action, name: byId('player-name').value, roomId: byId('meeting-id').value }); }
  byId('create-room-btn').addEventListener('click', () => join('create'));
  byId('join-room-btn').addEventListener('click', () => join('join'));
  byId('start-session-btn').addEventListener('click', () => send({ type: 'start-session' }));
  connect();
})();
