(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const CELL = 52;
  const COLS = Math.floor(canvas.width / CELL);
  const ROWS = Math.floor(canvas.height / CELL);
  const rulesPanel = document.getElementById('rules');
  rulesPanel.innerHTML = `
    <div class="rules-title">Controls</div>
    <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</div>
    <div><kbd>E</kbd> Interact</div>
    <div><kbd>Q</kbd> Throw or drop; a loaded plate ejects its latest item</div>
    <div><kbd>Space</kbd> Serve at the window</div>
    <div class="rules-title">Goal</div>
    <div>Serve matching tickets before they expire.</div>
    <div class="rules-title">Notes</div>
    <div>Open Notes to read discoveries from earlier agents or leave a handover note.</div>
    <div class="rules-title">Macros</div>
    <div>Create, edit, or delete saved keyboard sequences for later agents.</div>
    <div class="handover-reminder">*Note: You are responsible to provide sufficient information for the next LLM to play.</div>`;

  // ---------- Grid / stations ----------
  // Types: 'floor','counter','crate','board','stove','plates','serve','trash'
    // Every edge tile is a solid counter. Counters cannot store items.
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const edge = r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1;
      row.push({ type: edge ? 'counter' : 'floor', item: null });
    }
    grid.push(row);
  }
  function setStation(c, r, type) { grid[r][c].type = type; }
  let activeStageId = 1;
  let currentBridgeRow = null;
  function updateMovingBridge(row) {
    if (activeStageId < 4 || !Number.isInteger(row) || row === currentBridgeRow) return;
    for (let r = 1; r < ROWS - 1; r++) setStation(8, r, 'abyss');
    setStation(8, row, 'bridge');
    currentBridgeRow = row;
  }
  function loadStageMap(stageId, initialBridgeRow = null) {
    activeStageId = stageId;
    grid.forEach((row, r) => row.forEach((cell, c) => {
      const edge = r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1;
      cell.type = edge ? 'counter' : 'floor'; cell.item = null;
    }));
    if (stageId === 3 || stageId === 4 || stageId === 5) {
      // The kitchen is split into two islands. Stage 3 has a fixed crossing;
      // Stage 4 moves that same crossing on the server's shared clock.
      setStation(2, 0, 'crate_tomato'); setStation(4, 0, stageId === 5 ? 'crate_pickle' : 'crate_lettuce'); setStation(6, 0, 'crate_bun'); setStation(7, 0, 'crate_chicken');
      setStation(10, 0, 'board'); setStation(11, 0, 'board'); setStation(13, 0, 'stove'); setStation(14, 0, 'stove');
      setStation(11, ROWS - 1, 'plates'); setStation(0, 5, 'trash'); setStation(COLS - 1, 5, 'serve');
      for (let r = 1; r < ROWS - 1; r++) setStation(8, r, 'abyss');
      if (stageId === 3) setStation(8, 5, 'bridge');
      else { currentBridgeRow = null; updateMovingBridge(initialBridgeRow ?? 3); }
    } else {
      // Stage 2 deliberately preserves every Stage 1 location.
      setStation(2, 0, 'crate_tomato'); setStation(4, 0, 'crate_lettuce'); setStation(6, 0, 'crate_bun');
      if (stageId === 2) { setStation(2, ROWS - 1, 'board'); setStation(3, ROWS - 1, 'board'); }
      setStation(5, ROWS - 1, 'stove'); setStation(6, ROWS - 1, 'stove');
      setStation(11, 0, 'plates'); setStation(0, 5, 'trash'); setStation(COLS - 1, 5, 'serve');
      if (stageId === 2) setStation(8, 0, 'crate_chicken');
    }
  }
  function applyServerMap(map) {
    if (!Array.isArray(map) || map.length !== ROWS) return;
    map.forEach((row, r) => row.forEach((tile, c) => {
      if (grid[r]?.[c] && typeof tile?.type === 'string') grid[r][c].type = tile.type;
    }));
  }
  loadStageMap(1);

  const ingredientColors = {
    tomato: '#c1443c', lettuce: '#7fb069', pickle: '#779c43', bun: '#d9a05b', patty: '#6b3f2a', chicken: '#e8b18a'
  };

  // ---------- Player ----------
  // The player now occupies a single grid cell (gc, gr) and steps one square
  // at a time, chess-board style, rather than sliding continuously.
  const player = {
    gc: COLS - 2, gr: ROWS - 2, // innermost floor tile nearest the bottom-right corner
    x: 0, y: 0, // pixel center of (gc, gr), kept in sync every frame — used for rendering/interactions
    dir: { x: 0, y: 1 },
    holding: null, // {kind:'ingredient'|'plate', ...}
  };
  player.x = player.gc * CELL + CELL / 2;
  player.y = player.gr * CELL + CELL / 2;
  let sharedBuns = [];
  let sharedIngredients = [];
  let sharedPlates = [];
  let serverClockOffset = 0;
  const remotePlayers = new Map();
  function playerColor(playerId) {
    const index = window.kitchenSession?.state?.players?.findIndex(item => item.id === playerId) ?? 0;
    return index % 2 === 0 ? '#e0763a' : '#7fb069';
  }
  function publishPlayerState() {
    const holding = player.holding ? JSON.parse(JSON.stringify(player.holding)) : null;
    if (window.kitchenSession?.connected) window.kitchenSession.send({ type: 'player-state', gc: player.gc, gr: player.gr, dir: player.dir, holding });
  }
  function applySharedBuns(buns) {
    sharedBuns = Array.isArray(buns) ? buns : [];
    const mine = sharedBuns.find(bun => bun.holderId === window.kitchenSession?.state?.you);
    if (mine && (!player.holding || player.holding.sharedBun)) player.holding = { kind: 'ingredient', item: 'bun', sharedBun: true, sharedItemId: mine.id };
    if (!mine && player.holding?.sharedBun) player.holding = null;
    publishPlayerState();
  }
  function applySharedIngredients(ingredients) {
    sharedIngredients = Array.isArray(ingredients) ? ingredients : [];
    const mine = sharedIngredients.find(item => item.holderId === window.kitchenSession?.state?.you);
    if (mine && (!player.holding || player.holding.sharedIngredient)) player.holding = { kind: 'ingredient', item: mine.item, chopped: mine.chopped, cookedSides: mine.cookedSides, sharedIngredient: true, sharedItemId: mine.id };
    if (!mine && player.holding?.sharedIngredient) player.holding = null;
    publishPlayerState();
  }
  function applySharedPlates(plates) {
    sharedPlates = Array.isArray(plates) ? plates : [];
    const mine = sharedPlates.find(plate => plate.holderId === window.kitchenSession?.state?.you);
    if (mine && (!player.holding || player.holding.sharedPlate)) player.holding = { kind: 'plate', contents: mine.contents, sharedPlate: true, sharedItemId: mine.id };
    if (!mine && player.holding?.sharedPlate) player.holding = null;
    publishPlayerState();
  }
  window.addEventListener('kitchen-enter-game', () => {
    const index = window.kitchenSession?.state?.players?.findIndex(item => item.id === window.kitchenSession?.state?.you) || 0;
    player.gc = COLS - 2 - (index % 2); player.gr = ROWS - 2 - Math.floor(index / 2);
    player.x = player.gc * CELL + CELL / 2; player.y = player.gr * CELL + CELL / 2;
    publishPlayerState();
    spectating = false; running = true; lastT = performance.now();
  });
  window.addEventListener('kitchen-player-state', event => {
    const state = event.detail;
    if (state.playerId !== window.kitchenSession?.state?.you && window.kitchenSession?.state?.activePlayerIds?.includes(state.playerId)) remotePlayers.set(state.playerId, state);
  });
  let moveCooldown = 0; // seconds until the next single-square step is allowed
  const keys = {};

  window.addEventListener('keydown', e => {
    if (e.target.matches('textarea, input, button') || !notesModal.classList.contains('hidden') || !macroModal.classList.contains('hidden')) return;
    keys[e.key.toLowerCase()] = true;
    if (e.key === ' ') e.preventDefault();
  });
  window.addEventListener('keyup', e => {
    if (!e.target.matches('textarea, input, button') && notesModal.classList.contains('hidden') && macroModal.classList.contains('hidden')) keys[e.key.toLowerCase()] = false;
  });

  // ---------- Persistent player notes ----------
  const NOTE_STORAGE_KEY = 'kitchen-relay-notes';
  const NOTE_AUTHOR = 'Player 1';
  const notesModal = document.getElementById('notes-modal');
  const newNoteInput = document.getElementById('new-note');
  const notesList = document.getElementById('notes-list');
  const noteStatus = document.getElementById('note-status');
  let notes = loadNotes();
  let editingNoteId = null;
  const notepadEditor = document.getElementById('notepad-editor');
  const notepadMeta = document.getElementById('notepad-meta');
  let notepad = loadNotepad();

  function loadNotepad() {
    if (window.kitchenSession) return { text: '', author: null, updatedAt: null, revision: 0 };
    try { return { text: '', author: null, updatedAt: null, revision: 0, ...JSON.parse(localStorage.getItem('kitchen-relay-notepad') || '{}') }; }
    catch { return { text: '', author: null, updatedAt: null, revision: 0 }; }
  }

  function renderNotepad() {
    notepadEditor.value = notepad.text || '';
    notepadMeta.textContent = notepad.updatedAt
      ? `Last saved by ${notepad.author || 'a player'} · ${new Date(notepad.updatedAt).toLocaleString()}`
      : 'Shared handover document — not saved yet';
  }

  function openNotepad() {
    notesModal.classList.remove('hidden'); noteStatus.textContent = '';
    renderNotepad(); notepadEditor.focus();
    if (window.kitchenSession?.connected) window.kitchenSession.send({ type: 'notepad-open' });
  }

  function saveNotepad() {
    const text = notepadEditor.value.trim();
    if (text === (notepad.text || '')) { noteStatus.textContent = 'Nothing changed, so there is nothing to save.'; return; }
    if (window.kitchenSession?.connected) { window.kitchenSession.send({ type: 'notepad-save', text }); noteStatus.textContent = 'Saving handover document…'; return; }
    notepad = { text, author: 'Player 1', updatedAt: Date.now(), revision: (notepad.revision || 0) + 1 };
    localStorage.setItem('kitchen-relay-notepad', JSON.stringify(notepad)); noteStatus.textContent = 'Saved for the next player.'; renderNotepad();
  }

  function loadNotes() {
    if (window.kitchenSession) return [];
    try {
      const saved = JSON.parse(localStorage.getItem(NOTE_STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  function saveNotes() {
    if (window.kitchenSession?.connected) return;
    localStorage.setItem(NOTE_STORAGE_KEY, JSON.stringify(notes));
  }

  function formatNoteDate(timestamp) {
    return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function makeNoteButton(label, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderNotes() {
    notesList.replaceChildren();
    if (!notes.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-notes'; empty.textContent = 'No notes yet.';
      notesList.append(empty);
      return;
    }
    notes.forEach(note => {
      const entry = document.createElement('article');
      entry.className = 'note-entry';
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      meta.textContent = `${note.author} · ${formatNoteDate(note.updatedAt)}`;
      entry.append(meta);
      const buttons = document.createElement('div');
      buttons.className = 'note-buttons';
      if (editingNoteId === note.id) {
        const editor = document.createElement('textarea');
        editor.value = note.text; editor.maxLength = 500;
        entry.append(editor);
        buttons.append(
          makeNoteButton('Save changes', '', () => {
            const text = editor.value.trim();
            if (!text) return;
            if (window.kitchenSession?.connected) { window.kitchenSession.send({ type: 'note-update', id: note.id, text }); editingNoteId = null; return; }
            note.text = text; note.updatedAt = Date.now(); editingNoteId = null;
            saveNotes(); renderNotes();
          }),
          makeNoteButton('Cancel', '', () => { editingNoteId = null; renderNotes(); })
        );
      } else {
        const text = document.createElement('p');
        text.className = 'note-text'; text.textContent = note.text;
        entry.append(text);
        buttons.append(
          makeNoteButton('Edit', '', () => { editingNoteId = note.id; renderNotes(); }),
          makeNoteButton('Delete', 'delete-button', () => {
            if (window.kitchenSession?.connected) { window.kitchenSession.send({ type: 'note-delete', id: note.id }); return; }
            notes = notes.filter(item => item.id !== note.id);
            saveNotes(); renderNotes();
          })
        );
      }
      entry.append(buttons);
      notesList.append(entry);
    });
  }

  document.getElementById('notesBtn').addEventListener('click', openNotepad);
  document.getElementById('closeNotesBtn').addEventListener('click', () => notesModal.classList.add('hidden'));
  notesModal.addEventListener('click', e => { if (e.target === notesModal) notesModal.classList.add('hidden'); });
  document.getElementById('saveNoteBtn').addEventListener('click', saveNotepad);
  window.addEventListener('kitchen-room-state', event => {
    serverClockOffset = Number(event.detail.serverNow || Date.now()) - Date.now();
    if (event.detail.stage && event.detail.stage !== activeStageId) loadStageMap(event.detail.stage, event.detail.bridgeRow);
    else if (event.detail.stage >= 4) updateMovingBridge(event.detail.bridgeRow);
    applyServerMap(event.detail.map);
    document.getElementById('stage').textContent = event.detail.stageName || `Stage ${event.detail.stage || 1}`;
    document.getElementById('customer-message').textContent = event.detail.customerMessage || 'Waiting for an order.';
    document.getElementById('stage-note').classList.toggle('hidden', event.detail.stage !== 5);
    notepad = event.detail.notepad || { text: '', author: null, updatedAt: null, revision: 0 };
    score = event.detail.score || 0; missed = event.detail.missed || 0;
    tickets = event.detail.tickets || [];
    remotePlayers.forEach((_, id) => { if (!event.detail.activePlayerIds?.includes(id) || !event.detail.players.some(member => member.id === id)) remotePlayers.delete(id); });
    if (Array.isArray(event.detail.macros)) { macros = event.detail.macros; renderMacros(); }
    applySharedBuns(event.detail.buns);
    applySharedIngredients(event.detail.ingredients);
    applySharedPlates(event.detail.plates);
    if (notesModal.classList.contains('hidden')) renderNotepad();
    document.getElementById('score').textContent = score;
    document.getElementById('missed').textContent = missed;
    if (spectating) {
      const sessionEnd = Math.max(0, ...(event.detail.schedule || []).map(item => item.endAt || 0));
      const seconds = Math.max(0, Math.floor((sessionEnd - Date.now()) / 1000));
      document.getElementById('time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    renderTickets();
  });
  renderNotepad();

  // ---------- Persistent action macros ----------
  const MACRO_STORAGE_KEY = 'kitchen-relay-macros';
  const MACRO_ACTIONS = new Set(['w', 'a', 's', 'd', 'q', 'e', ' ']);
  const MACRO_SHORTCUTS = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const RESERVED_MACRO_SHORTCUTS = new Set(['w', 'a', 's', 'd', 'q', 'e']);
  const macroModal = document.getElementById('macro-modal');
  const macroTitle = document.getElementById('macro-title');
  const macroNameInput = document.getElementById('macro-name');
  const macroSequenceEl = document.getElementById('macro-sequence');
  const macroRecordingStatus = document.getElementById('macro-recording-status');
  const macroList = document.getElementById('macro-list');
  const macroEmpty = document.getElementById('macro-empty');
  let macros = loadMacros();
  let pendingMacroSequence = [];
  let macroCursor = 0;
  let macroRunning = false;
  let macroCreationStage = 'name';
  let editingMacroId = null;

  function loadMacros() {
    if (window.kitchenSession) return [];
    try {
      const saved = JSON.parse(localStorage.getItem(MACRO_STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter(macro =>
        typeof macro.name === 'string' && MACRO_SHORTCUTS.includes(macro.shortcut) &&
        Array.isArray(macro.sequence) && macro.sequence.every(action => MACRO_ACTIONS.has(action) || (typeof action === 'string' && (action.startsWith('macro:') || /^[a-z]$/.test(action))))
      ) : [];
    } catch {
      return [];
    }
  }

  function saveMacros() {
    if (window.kitchenSession?.connected) { window.kitchenSession.send({ type: 'macros-sync', macros }); return; }
    localStorage.setItem(MACRO_STORAGE_KEY, JSON.stringify(macros));
  }
  function nestedMacroId(action) {
    if (typeof action !== 'string') return null;
    if (action.startsWith('macro:')) return action.slice(6);
    return macros.find(macro => macro.shortcut === action)?.id || null;
  }
  function displayAction(action) {
    const nestedId = nestedMacroId(action);
    if (nestedId) return `[${macros.find(macro => macro.id === nestedId)?.name || 'missing macro'}]`;
    return action === ' ' ? 'Space' : action.toUpperCase();
  }

  function macroReferences(macroId, targetId, seen = new Set()) {
    if (macroId === targetId || seen.has(macroId)) return macroId === targetId;
    seen.add(macroId);
    const macro = macros.find(item => item.id === macroId);
    return Boolean(macro?.sequence.some(action => {
      const childId = nestedMacroId(action);
      return childId && macroReferences(childId, targetId, seen);
    }));
  }

  function expandMacro(macro, seen = new Set()) {
    if (seen.has(macro.id)) return null;
    const nextSeen = new Set(seen).add(macro.id);
    const expanded = [];
    for (const action of macro.sequence) {
      const childId = nestedMacroId(action);
      if (!childId) expanded.push(action);
      else {
        const child = macros.find(item => item.id === childId);
        const childSequence = child && expandMacro(child, nextSeen);
        if (!childSequence) return null;
        expanded.push(...childSequence);
      }
    }
    return expanded;
  }

  function renderPendingMacroLegacy() {
    macroSequenceEl.textContent = pendingMacroSequence.length
      ? pendingMacroSequence.map(displayAction).join(' → ')
      : 'No actions selected.';
  }

  function renderPendingMacro() {
    if (!pendingMacroSequence.length) {
      macroSequenceEl.textContent = macroCreationStage === 'record' ? '|' : 'No actions selected.';
      return;
    }
    const actionsWithCursor = [...pendingMacroSequence];
    actionsWithCursor.splice(macroCursor, 0, '|');
    macroSequenceEl.textContent = actionsWithCursor.map(displayAction).join(' -> ');
  }

  function renderMacros() {
    macroList.replaceChildren();
    macroEmpty.classList.toggle('hidden', macros.length > 0);
    macros.forEach(macro => {
      const card = document.createElement('article'); card.className = 'macro-card';
      const top = document.createElement('div'); top.className = 'macro-card-top';
      const name = document.createElement('span'); name.className = 'macro-card-name'; name.textContent = macro.name;
      const key = document.createElement('kbd'); key.className = 'macro-key'; key.textContent = macro.shortcut.toUpperCase();
      top.append(name, key);
      const sequence = document.createElement('div'); sequence.className = 'macro-card-sequence';
      sequence.textContent = macro.sequence.map(displayAction).join(' → ');
      const actions = document.createElement('div'); actions.className = 'macro-card-actions';
      const edit = makeNoteButton('Edit', '', () => openMacroEditor(macro));
      const remove = makeNoteButton('Delete', 'delete-button', () => {
        if (!window.confirm(`Delete the macro "${macro.name}"?`)) return;
        macros = macros.filter(item => item.id !== macro.id); saveMacros(); renderMacros();
      });
      actions.append(edit, remove);
      card.append(top, sequence, actions); macroList.append(card);
    });
  }

  function resetMacroCreator() {
    macroTitle.textContent = 'Create macro';
    macroNameInput.value = ''; pendingMacroSequence = []; macroCursor = 0; macroCreationStage = 'name'; editingMacroId = null;
    macroRecordingStatus.textContent = 'Type a name, then press Enter to start recording.';
    renderPendingMacro();
  }

  function openMacroEditor(macro) {
    macroTitle.textContent = 'Edit macro';
    macroNameInput.value = macro.name;
    pendingMacroSequence = [...macro.sequence];
    macroCursor = pendingMacroSequence.length;
    editingMacroId = macro.id;
    macroCreationStage = 'name';
    macroRecordingStatus.textContent = `Editing ${macro.name}. Change the name if needed, then press Enter.`;
    macroModal.classList.remove('hidden');
    renderPendingMacro();
    macroNameInput.focus(); macroNameInput.select();
  }

  function runMacro(macro) {
    if (!running || macroRunning) return;
    const sequence = expandMacro(macro);
    if (!sequence) { flashMsg(`${macro.name} has a missing or circular macro call.`, 'bad'); return; }
    macroRunning = true;
    if (window.kitchenSession?.connected) window.kitchenSession.send({ type: 'macro-run-start', macroId: macro.id });
    flashMsg(`Running ${macro.name}.`);
    let index = 0;
    const finish = () => {
      macroRunning = false;
      if (window.kitchenSession?.connected) window.kitchenSession.send({ type: 'macro-run-finish' });
    };
    const nextAction = () => {
      if (!running || index >= sequence.length) { finish(); return; }
      const action = sequence[index++];
      if (action === 'w' || action === 'a' || action === 's' || action === 'd') {
        const directions = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
        const [dc, dr] = directions[action];
        player.dir = { x: dc, y: dr };
        if (window.kitchenSession?.connected) window.kitchenSession.send({ type: 'macro-run-step', action: 'move', gc: player.gc + dc, gr: player.gr + dr });
        if (!tryStep(dc, dr)) { finish(); return; }
      } else {
        handleActionWrapped(action);
      }
      window.setTimeout(nextAction, 230);
    };
    nextAction();
  }

  document.getElementById('openMacroCreatorBtn').addEventListener('click', () => {
    resetMacroCreator(); macroModal.classList.remove('hidden'); macroNameInput.focus();
  });
  document.getElementById('closeMacroCreatorBtn').addEventListener('click', () => macroModal.classList.add('hidden'));
  macroModal.addEventListener('click', e => { if (e.target === macroModal) macroModal.classList.add('hidden'); });
  macroNameInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!macroNameInput.value.trim()) { macroRecordingStatus.textContent = 'Enter a macro name first.'; return; }
    macroCreationStage = 'record'; macroNameInput.blur(); renderPendingMacro();
    macroRecordingStatus.textContent = 'Editing sequence: use W, A, S, D, Q, E, or Space. Use arrow keys to move the cursor; press Enter when done.';
  });
  window.addEventListener('keydown', e => {
    if (macroModal.classList.contains('hidden') || e.repeat || e.target.matches('textarea, input, button')) return;
    if (macroCreationStage === 'record') {
      const action = e.key.toLowerCase();
      const nestedMacro = macros.find(macro => macro.shortcut === action);
      if (nestedMacro) {
        e.preventDefault();
        if (editingMacroId && macroReferences(nestedMacro.id, editingMacroId)) { macroRecordingStatus.textContent = 'That macro would create a circular call.'; return; }
        pendingMacroSequence.splice(macroCursor, 0, `macro:${nestedMacro.id}`); macroCursor++; renderPendingMacro();
        macroRecordingStatus.textContent = `${nestedMacro.name} inserted as a reusable macro step.`;
      } else if (MACRO_ACTIONS.has(action)) {
        e.preventDefault(); pendingMacroSequence.splice(macroCursor, 0, action); macroCursor++; renderPendingMacro();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault(); macroCursor = Math.max(0, macroCursor - 1); renderPendingMacro();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault(); macroCursor = Math.min(pendingMacroSequence.length, macroCursor + 1); renderPendingMacro();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        if (macroCursor > 0) { pendingMacroSequence.splice(macroCursor - 1, 1); macroCursor--; renderPendingMacro(); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!pendingMacroSequence.length) { macroRecordingStatus.textContent = 'Record at least one action before choosing a shortcut.'; return; }
        if (editingMacroId) {
          const macro = macros.find(item => item.id === editingMacroId);
          if (macro) { macro.name = macroNameInput.value.trim(); macro.sequence = [...pendingMacroSequence]; saveMacros(); renderMacros(); }
          macroModal.classList.add('hidden');
          flashMsg(`${macroNameInput.value.trim()} updated.`, 'good');
          return;
        }
        macroCreationStage = 'shortcut';
        macroRecordingStatus.textContent = 'Now press one unused letter A–Z to save this macro.';
      }
      return;
    }
    if (macroCreationStage === 'shortcut') {
      const shortcut = e.key.toLowerCase();
      if (!/^[a-z]$/.test(shortcut)) { macroRecordingStatus.textContent = 'Please press a single letter A–Z.'; return; }
      e.preventDefault();
      if (RESERVED_MACRO_SHORTCUTS.has(shortcut)) { macroRecordingStatus.textContent = `${shortcut.toUpperCase()} is already used by the game.`; return; }
      if (macros.some(macro => macro.shortcut === shortcut)) { macroRecordingStatus.textContent = `${shortcut.toUpperCase()} is already assigned to another macro.`; return; }
      const name = macroNameInput.value.trim();
      macros.push({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, name, shortcut, sequence: [...pendingMacroSequence] });
      saveMacros(); renderMacros(); macroModal.classList.add('hidden');
      flashMsg(`${name} saved to ${shortcut.toUpperCase()}.`, 'good');
    }
  });
  window.addEventListener('keydown', e => {
    if (e.target.matches('textarea, input, button') || e.repeat || !notesModal.classList.contains('hidden') || !macroModal.classList.contains('hidden')) return;
    const macro = macros.find(item => item.shortcut === e.key.toLowerCase());
    if (macro) { e.preventDefault(); runMacro(macro); }
  });
  renderMacros();

  function cellAt(px, py) {
    const c = Math.floor(px / CELL), r = Math.floor(py / CELL);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
    return { c, r, cell: grid[r][c] };
  }

  function facingCell() {
    const fx = player.x + player.dir.x * CELL * 0.75;
    const fy = player.y + player.dir.y * CELL * 0.75;
    return cellAt(fx, fy);
  }

  function isSolid(type) {
    return type !== 'floor' && type !== 'bridge';
  }

  // Snap the player's (possibly diagonal) facing vector to a single grid axis,
  // used for stepping the throw across whole cells.
  function cardinalDir() {
    if (Math.abs(player.dir.x) > Math.abs(player.dir.y)) return { x: Math.sign(player.dir.x), y: 0 };
    if (player.dir.y !== 0) return { x: 0, y: Math.sign(player.dir.y) };
    return { x: 0, y: 1 };
  }

  function sharedObjectAt(c, r) {
    return sharedBuns.some(item => item.holderId === null && item.c === c && item.r === r)
      || sharedIngredients.some(item => item.holderId === null && item.c === c && item.r === r)
      || sharedPlates.some(item => item.holderId === null && item.c === c && item.r === r);
  }

  function sharedThrowTarget() {
    const dir = cardinalDir();
    let target = null;
    for (let distance = 1; distance <= 3; distance++) {
      const c = player.gc + dir.x * distance, r = player.gr + dir.y * distance;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      if (grid[r][c].type !== 'floor') break;
      if (activeStageId >= 2 && sharedObjectAt(c, r)) break;
      target = { c, r };
    }
    return target;
  }

  function tryStep(dc, dr) {
    const targetC = player.gc + dc, targetR = player.gr + dr;
    if (targetR < 0 || targetR >= ROWS || targetC < 0 || targetC >= COLS) return false;
    if (isSolid(grid[targetR][targetC].type)) return false;
    player.gc = targetC; player.gr = targetR;
    player.x = player.gc * CELL + CELL / 2;
    player.y = player.gr * CELL + CELL / 2;
    publishPlayerState();
    return true;
  }

  // ---------- Recipes / Tickets ----------
  const RECIPES = [
    { name: 'Tomato Plate', needs: ['tomato'], points: 40, time: 32 },
    { name: 'Garden Salad', needs: ['tomato', 'lettuce'], points: 70, time: 42 },
    { name: 'Veggie Bun', needs: ['bun', 'lettuce'], points: 60, time: 38 },
  ];

  let tickets = [];
  let score = 0;
  let missed = 0;
  let timeLeft = 180; // 3 min test shift
  let spawnTimer = 5;
  let running = false;
  let spectating = false;
  window.addEventListener('kitchen-session-finished', () => { running = false; spectating = false; });
  window.addEventListener('kitchen-spectate', () => {
    running = false; spectating = true;
    document.getElementById('msg').textContent = 'Spectator view — live score, missed orders, and kitchen activity.';
  });

  function spawnTicket() {
    if (tickets.length >= 4) return;
    const r = RECIPES[Math.floor(Math.random() * RECIPES.length)];
    tickets.push({ ...r, remaining: r.time });
  }

  function updateTickets(dt) {
    if (window.kitchenSession?.connected) return;
    spawnTimer -= dt;
    if (spawnTimer <= 0) { spawnTicket(); spawnTimer = 9 + Math.random() * 6; }
    tickets.forEach(t => t.remaining -= dt);
    const before = tickets.length;
    tickets = tickets.filter(t => {
      if (t.remaining <= 0) { missed++; window.kitchenSession?.send({ type: 'missed-add' }); return false; }
      return true;
    });
  }

  function renderTickets() {
    const el = document.getElementById('tickets');
    el.innerHTML = '';
    tickets.forEach(t => {
      const remaining = t.expiresAt ? Math.max(0, (t.expiresAt - Date.now()) / 1000) : t.remaining;
      const pct = Math.max(0, remaining / t.time) * 100;
      const div = document.createElement('div');
      div.className = 'ticket';
      const displayedIngredients = t.displayNeeds || t.needs || [];
      const ingredientLine = activeStageId >= 3 ? '' : `<div>${displayedIngredients.join(' + ')}</div>`;
      div.innerHTML = `<div class="name">${t.name}</div>
        ${ingredientLine}
        <div class="bar-bg"><div class="bar-fill" style="width:${pct}%; background:${pct < 30 ? 'var(--bad)' : 'var(--good)'}"></div></div>`;
      el.appendChild(div);
    });
  }

  function completeOrder(contents) {
    if (window.kitchenSession?.connected) {
      window.kitchenSession.send({ type: 'serve-order', contents, plateId: player.holding?.sharedItemId });
      // Keep the plate visible until the server confirms a successful serve.
      return false;
    }
    const sorted = contents.map(item => typeof item === 'string' ? item : item.item).sort().join(',');
    const idx = tickets.findIndex(t => [...t.needs].sort().join(',') === sorted);
    if (idx >= 0) {
      score += tickets[idx].points;
      flashMsg(`Served ${tickets[idx].name}! +${tickets[idx].points}`, 'good');
      tickets.splice(idx, 1);
      return true;
    }
    flashMsg('No matching order for that plate.', 'bad');
    return false;
  }

  // ---------- Actions ----------
  let msgTimer = 0;
  function flashMsg(text, tone) {
    const el = document.getElementById('msg');
    el.textContent = text;
    el.style.color = tone === 'good' ? 'var(--good)' : tone === 'bad' ? 'var(--bad)' : 'var(--ink-dim)';
    msgTimer = 2.2;
  }

  window.addEventListener('kitchen-handover-warning', event => {
    flashMsg(event.detail.text, 'bad');
  });
  window.addEventListener('kitchen-action-rejected', event => {
    flashMsg(event.detail.message || 'That action cannot be completed.', 'bad');
  });

  function handleAction(key) {
    if (!running) return;
    const f = facingCell();
    if (!f) return;
    const type = f.cell.type;

    if (key === 'e') {
      if (type.startsWith('crate_')) {
        const ing = type.split('_')[1];
        if (!player.holding) {
          player.holding = { kind: 'ingredient', item: ing, chopped: false };
          flashMsg(`Picked up raw ${ing}.`);
        }
      } else if (type === 'plates') {
        if (!player.holding) {
          player.holding = { kind: 'plate', contents: [] };
          flashMsg('Grabbed a clean plate.');
        }
      } else if (type === 'board') {
        if (player.holding && player.holding.kind === 'ingredient' && !f.cell.item) {
          f.cell.item = player.holding; player.holding = null;
          flashMsg('Placed ingredient on the board. Press E again to chop.');
        } else if (f.cell.item && !player.holding) {
          if (!f.cell.item.chopped) {
            f.cell.item.chopped = true;
            flashMsg('Chopped! Press E to pick it back up.');
          } else {
            player.holding = f.cell.item;
            f.cell.item = null;
          }
        }
      } else if (type === 'stove') {
        if (player.holding && player.holding.kind === 'ingredient' && !f.cell.item) {
          f.cell.item = player.holding; player.holding = null;
          f.cell.item.cookStart = performance.now();
          flashMsg('Cooking...');
        } else if (f.cell.item && !player.holding) {
          const cookedEnough = performance.now() - (f.cell.item.cookStart || 0) > 1500;
          if (cookedEnough) {
            player.holding = f.cell.item;
            f.cell.item = null;
          } else {
            flashMsg('Still cooking.', 'bad');
          }
        }
      } else if (type === 'trash') {
        if (player.holding) { player.holding = null; flashMsg('Tossed it — gone for good.'); }
      } else if (type === 'floor') {
        if (f.cell.item && !player.holding) {
          player.holding = f.cell.item;
          f.cell.item = null;
          flashMsg('Picked it up off the floor.');
        }
      } else if (type === 'serve') {
        // handled by space
      }
    }

    if (key === ' ') {
      if (type === 'serve' && player.holding && player.holding.kind === 'plate') {
        if (player.holding.contents.length > 0) {
          const ok = completeOrder(player.holding.contents);
          if (ok) player.holding = null;
        } else {
          flashMsg('Plate is empty.', 'bad');
        }
      } else if (player.holding && player.holding.kind === 'ingredient') {
        // put onto a plate we're facing (plate must be an item somewhere) - simplified: combine when holding plate
      } else if (player.holding && player.holding.kind === 'plate') {
        flashMsg('Walk to a station holding a chopped ingredient, then face your plate to load it.');
      }
    }

    if (key === 'q') {
      if (player.holding) {
        const removingFromPlate = player.holding.kind === 'plate' && player.holding.contents.length > 0;
        const thrown = removingFromPlate
          ? { kind: 'ingredient', item: player.holding.contents[player.holding.contents.length - 1] }
          : player.holding;
        const dir = cardinalDir();
        const startC = Math.floor(player.x / CELL);
        const startR = Math.floor(player.y / CELL);
        const maxDist = 3;
        let landC = null, landR = null;
        for (let d = 1; d <= maxDist; d++) {
          const c = startC + dir.x * d;
          const r = startR + dir.y * d;
          if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
          const cell = grid[r][c];
          const canLand = cell.type === 'floor' && !cell.item;
          if (canLand) { landC = c; landR = r; }
          else break; // blocked by a wall/station/occupied tile - stops here
        }
        if (landC === null) {
          flashMsg("Nowhere clear to throw it — kept it in hand.", 'bad');
        } else {
          grid[landR][landC].item = thrown;
          if (removingFromPlate) player.holding.contents.pop();
          else player.holding = null;
          flashMsg('Threw it — it landed on the floor.');
        }
      }
    }
  }

  // loading ingredient onto plate: when holding ingredient and pressing E while "plate" is the thing held is impossible;
  // simpler rule: if holding a plate and facing a board/stove with a finished chopped/cooked item, E loads it onto the plate.
  const origHandle = handleAction;
  function handleActionWrapped(key) {
    if (window.kitchenSession?.connected) {
      const f = facingCell();
      if (key === 'e' && f) {
        const crateIngredient = f.cell.type.startsWith('crate_') ? f.cell.type.split('_')[1] : null;
        if (!player.holding && ['tomato', ...(activeStageId === 5 ? ['pickle'] : ['lettuce']), ...(activeStageId >= 2 ? ['chicken'] : [])].includes(crateIngredient)) { window.kitchenSession.send({ type: 'ingredient-pick', source: 'crate', item: crateIngredient }); return; }
        const stationIngredient = sharedIngredients.find(item => item.holderId === null && item.c === f.c && item.r === f.r && item.station === f.cell.type);
        if (player.holding?.sharedIngredient && ['board', 'stove'].includes(f.cell.type)) {
          window.kitchenSession.send({ type: 'ingredient-place-station', itemId: player.holding.sharedItemId, c: f.c, r: f.r, station: f.cell.type }); return;
        }
        if (player.holding?.sharedPlate && stationIngredient) {
          window.kitchenSession.send({ type: 'plate-add-station-item', plateId: player.holding.sharedItemId, c: f.c, r: f.r, station: f.cell.type }); return;
        }
        if (!player.holding && stationIngredient) {
          window.kitchenSession.send({ type: 'ingredient-process', c: f.c, r: f.r, station: f.cell.type }); return;
        }
        const floorIngredient = sharedIngredients.find(item => item.holderId === null && item.c === f.c && item.r === f.r);
        const floorBunForPlate = sharedBuns.find(item => item.holderId === null && item.c === f.c && item.r === f.r);
        if (player.holding?.sharedPlate && (floorIngredient || floorBunForPlate)) {
          window.kitchenSession.send({ type: 'plate-add-floor-item', plateId: player.holding.sharedItemId, c: f.c, r: f.r }); return;
        }
        if (!player.holding && floorIngredient) { window.kitchenSession.send({ type: 'ingredient-pick', itemId: floorIngredient.id, item: floorIngredient.item, c: f.c, r: f.r }); return; }
        if (player.holding?.sharedIngredient && f.cell.type === 'floor') { window.kitchenSession.send({ type: 'ingredient-drop', itemId: player.holding.sharedItemId, c: f.c, r: f.r }); return; }
        if (!player.holding && f.cell.type === 'plates') { window.kitchenSession.send({ type: 'plate-create' }); return; }
        const floorPlate = sharedPlates.find(plate => plate.holderId === null && plate.c === f.c && plate.r === f.r);
        if (!player.holding && floorPlate) { window.kitchenSession.send({ type: 'plate-pick', itemId: floorPlate.id, c: f.c, r: f.r }); return; }
        if (player.holding?.sharedPlate && f.cell.type === 'floor') { window.kitchenSession.send({ type: 'plate-drop', itemId: player.holding.sharedItemId, c: f.c, r: f.r }); return; }
        if (player.holding?.sharedPlate && f.cell.type === 'trash') { window.kitchenSession.send({ type: 'plate-delete', itemId: player.holding.sharedItemId }); return; }
        if (player.holding?.sharedPlate && f.cell.type.startsWith('crate_')) {
          const ingredient = f.cell.type.split('_')[1];
          window.kitchenSession.send({ type: 'plate-add', itemId: player.holding.sharedItemId, ingredient });
          return;
        }
        if (!player.holding && f.cell.type === 'crate_bun') {
          window.kitchenSession.send({ type: 'bun-pick', source: 'crate' });
          return;
        }
        const floorBun = sharedBuns.find(bun => bun.holderId === null && bun.c === f.c && bun.r === f.r);
        if (!player.holding && floorBun) {
          window.kitchenSession.send({ type: 'bun-pick', itemId: floorBun.id, c: f.c, r: f.r }); return;
        }
        if (player.holding?.sharedBun && f.cell.type === 'floor') {
          window.kitchenSession.send({ type: 'bun-drop', itemId: player.holding.sharedItemId, c: f.c, r: f.r }); return;
        }
      }
      if (key === 'q' && player.holding?.sharedBun) {
        const target = sharedThrowTarget();
        if (!target) { flashMsg('Nowhere clear to throw it.', 'bad'); return; }
        window.kitchenSession.send({ type: 'bun-drop', itemId: player.holding.sharedItemId, ...target }); return;
      }
      if (key === 'q' && player.holding?.sharedPlate) {
        const target = sharedThrowTarget();
        if (!target) { flashMsg('Nowhere clear to throw it.', 'bad'); return; }
        if (player.holding.contents.length) window.kitchenSession.send({ type: 'plate-remove-item', plateId: player.holding.sharedItemId, ...target });
        else window.kitchenSession.send({ type: 'plate-drop', itemId: player.holding.sharedItemId, ...target });
        return;
      }
      if (key === 'q' && player.holding?.sharedIngredient) {
        const target = sharedThrowTarget();
        if (!target) { flashMsg('Nowhere clear to throw it.', 'bad'); return; }
        window.kitchenSession.send({ type: 'ingredient-drop', itemId: player.holding.sharedItemId, ...target }); return;
      }
    }
    if (key === 'e' && running) {
      const f = facingCell();
      if (f && player.holding && player.holding.kind === 'plate') {
        const type = f.cell.type;
        if (type.startsWith('crate_')) {
          const ing = type.split('_')[1];
          player.holding.contents.push(ing);
          flashMsg(`Added raw ${ing} to plate.`);
          publishPlayerState(); return;
        }
        if (['board', 'stove', 'counter', 'floor'].includes(type) && f.cell.item && f.cell.item.kind === 'ingredient') {
          const readyChopped = type === 'board' && f.cell.item.chopped;
          const readyCooked = type === 'stove' && (performance.now() - (f.cell.item.cookStart || 0) > 1500);
          const readyPlain = type === 'counter' || type === 'floor';
          if (readyChopped || readyCooked || readyPlain) {
            player.holding.contents.push(f.cell.item.item);
            f.cell.item = null;
            flashMsg(`Added ${player.holding.contents[player.holding.contents.length-1]} to plate.`);
            publishPlayerState(); return;
          }
        }
      }
    }
    origHandle(key);
    publishPlayerState();
  }

  // ---------- Render ----------
  function stationColor(type) {
    if (type === 'floor') return null;
    if (type === 'abyss') return '#171523';
    if (type === 'bridge') return '#9a7650';
    if (type === 'counter') return '#7a5a42';
    if (type.startsWith('crate_')) return '#8a6248';
    if (type === 'board') return '#c9a876';
    if (type === 'stove') return '#5a4a44';
    if (type === 'plates') return '#aaa7a1';
    if (type === 'serve') return '#e0763a';
    if (type === 'trash') return '#3a2a24';
    return '#8a6248';
  }

  // Draws a held/placed item (ingredient or plate) centered at (cx, cy),
  // offset upward by yOffset so it reads as "sitting on" a station icon.
  function drawItemIcon(itemObj, cx, cy, yOffset) {
    if (itemObj.kind === 'plate') {
      ctx.fillStyle = '#e8e0d0';
      ctx.beginPath(); ctx.arc(cx, cy - yOffset, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
      itemObj.contents.forEach((c, i) => {
        ctx.fillStyle = ingredientColors[typeof c === 'string' ? c : c.item] || '#fff';
        ctx.beginPath(); ctx.arc(cx - 4 + i * 4, cy - yOffset, 2.5, 0, Math.PI * 2); ctx.fill();
      });
    } else {
      ctx.fillStyle = ingredientColors[itemObj.item] || '#fff';
      ctx.beginPath(); ctx.arc(cx, cy - yOffset, 8, 0, Math.PI * 2); ctx.fill();
      if (itemObj.chopped || (itemObj.cookedSides || 0) > 0) {
        ctx.strokeStyle = itemObj.cookedSides >= 2 ? '#3f261b' : '#f2e6d5';
        ctx.lineWidth = 2; ctx.stroke();
      }
      if (itemObj.processEndsAt && itemObj.processStartedAt) {
        const progress = Math.max(0, Math.min(1, ((Date.now() + serverClockOffset) - itemObj.processStartedAt) / (itemObj.processEndsAt - itemObj.processStartedAt)));
        ctx.strokeStyle = '#f5d04c'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy - yOffset, 12, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2); ctx.stroke();
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // floor grid
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = grid[r][c];
        const x = c * CELL, y = r * CELL;
        if (cell.type === 'floor') {
          ctx.fillStyle = (r + c) % 2 === 0 ? '#d8c4a0' : '#d3bd96';
          ctx.fillRect(x, y, CELL, CELL);
          if (cell.item) drawItemIcon(cell.item, x + CELL / 2, y + CELL / 2, 0);
        } else {
          ctx.fillStyle = stationColor(cell.type);
          ctx.fillRect(x, y, CELL, CELL);
          ctx.strokeStyle = 'rgba(0,0,0,0.15)';
          ctx.strokeRect(x, y, CELL, CELL);
          if (cell.type === 'counter' && !cell.item) {
            ctx.strokeStyle = 'rgba(242,230,213,0.25)';
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(x + 6, y + 6, CELL - 12, CELL - 12);
            ctx.setLineDash([]);
          }
          drawStationIcon(cell, x, y);
        }
      }
    }
    sharedBuns.filter(bun => bun.holderId === null && Number.isInteger(bun.c) && Number.isInteger(bun.r)).forEach(bun => {
      drawItemIcon({ kind: 'ingredient', item: 'bun' }, bun.c * CELL + CELL / 2, bun.r * CELL + CELL / 2, 0);
    });
    sharedIngredients.filter(item => item.holderId === null && Number.isInteger(item.c) && Number.isInteger(item.r)).forEach(item => {
      drawItemIcon({ kind: 'ingredient', ...item }, item.c * CELL + CELL / 2, item.r * CELL + CELL / 2, 0);
    });
    sharedPlates.filter(plate => plate.holderId === null && Number.isInteger(plate.c) && Number.isInteger(plate.r)).forEach(plate => {
      drawItemIcon({ kind: 'plate', contents: plate.contents }, plate.c * CELL + CELL / 2, plate.r * CELL + CELL / 2, 0);
    });
    remotePlayers.forEach(remote => {
      const x = remote.gc * CELL + CELL / 2, y = remote.gr * CELL + CELL / 2;
      drawAgent(x, y, remote.dir, playerColor(remote.playerId));
      if (remote.holding) drawItemIcon(remote.holding, x + remote.dir.x * 20, y + remote.dir.y * 20, 10);
    });
    if (!spectating) drawPlayer();
  }

  function drawStationIcon(cell, x, y) {
    const cx = x + CELL / 2, cy = y + CELL / 2;
    // Stage 1 teaches the labelled baseline. Later agents must recognise
    // stations and ingredient sources from observation or inherited notes.
    const labelsHidden = activeStageId >= 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '11px monospace';
    ctx.fillStyle = '#f2e6d5';
    if (cell.type.startsWith('crate_')) {
      const ing = cell.type.split('_')[1];
      const crateEmoji = { tomato: '🍅', lettuce: '🥬', pickle: '🥒', chicken: '🍗', bun: '🍔' }[ing] || '•';
      ctx.font = '24px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(crateEmoji, cx, cy);
      ctx.fillStyle = '#f2e6d5';
      if (!labelsHidden) ctx.fillText(ing[0].toUpperCase(), cx, cy + CELL/2 - 8);
    } else if (cell.type === 'board') {
      if (labelsHidden) { ctx.font = '22px sans-serif'; ctx.fillText('🔪', cx, cy); }
      else ctx.fillText('BOARD', cx, cy);
    } else if (cell.type === 'stove') {
      if (labelsHidden) { ctx.font = '22px sans-serif'; ctx.fillText('🔥', cx, cy); }
      else ctx.fillText('STOVE', cx, cy);
    } else if (cell.type === 'plates') {
      ctx.fillStyle = '#000';
      if (labelsHidden) { ctx.font = '22px sans-serif'; ctx.fillText('🍽️', cx, cy); }
      else ctx.fillText('PLATES', cx, cy);
    } else if (cell.type === 'serve') {
      if (labelsHidden) { ctx.font = '20px sans-serif'; ctx.fillText('🛎️', cx - 10, cy); ctx.fillText('🍽️', cx + 11, cy); }
      else ctx.fillText('SERVE', cx, cy);
    } else if (cell.type === 'trash') {
      if (labelsHidden) { ctx.font = '22px sans-serif'; ctx.fillText('🗑️', cx, cy); }
      else ctx.fillText('TRASH', cx, cy);
    } else if (cell.type === 'bridge') {
      ctx.fillStyle = '#2a1f18'; ctx.fillText('BRIDGE', cx, cy);
    }
    if (cell.item) {
      drawItemIcon(cell.item, cx, cy, 14);
      if (cell.type === 'board' && cell.item.kind === 'ingredient' && cell.item.chopped) {
        ctx.fillStyle = '#2a1f18'; ctx.font = '9px monospace';
        ctx.fillText('chopped', cx, cy - 26);
      }
      if (cell.type === 'stove' && cell.item.kind === 'ingredient') {
        const done = performance.now() - (cell.item.cookStart || 0) > 1500;
        ctx.fillStyle = '#2a1f18'; ctx.font = '9px monospace';
        ctx.fillText(done ? 'done' : 'cooking', cx, cy - 26);
      }
    }
  }

  function drawPlayer() {
    drawAgent(player.x, player.y, player.dir, playerColor(window.kitchenSession?.state?.you));

    if (player.holding) {
      const hx = player.x + player.dir.x * 20, hy = player.y + player.dir.y * 20 - 10;
      if (player.holding.kind === 'plate') {
        ctx.fillStyle = '#e8e0d0';
        ctx.beginPath(); ctx.arc(hx, hy, 10, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#b8a687'; ctx.stroke();
        player.holding.contents.forEach((c, i) => {
          ctx.fillStyle = ingredientColors[typeof c === 'string' ? c : c.item] || '#fff';
          ctx.beginPath(); ctx.arc(hx - 5 + i * 5, hy, 3, 0, Math.PI * 2); ctx.fill();
        });
      } else { ctx.fillStyle = ingredientColors[player.holding.item] || '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 8, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  function drawAgent(x, y, dir, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2a1f18'; ctx.lineWidth = 2; ctx.stroke();
    // facing indicator
    ctx.fillStyle = '#2a1f18';
    ctx.beginPath();
    ctx.arc(dir.x * 12, dir.y * 12, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------- Loop ----------
  let lastT = performance.now();
  function loop(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    if (running) {
      update(dt);
      draw();
    } else if (spectating) draw();
    requestAnimationFrame(loop);
  }

  function update(dt) {
    let dx = 0, dy = 0;
    if (keys['w']) dy = -1;
    else if (keys['s']) dy = 1;
    else if (keys['a']) dx = -1;
    else if (keys['d']) dx = 1;

    if (dx !== 0 || dy !== 0) {
      player.dir = { x: dx, y: dy };
      moveCooldown -= dt;
      if (moveCooldown <= 0) {
        tryStep(dx, dy);
        moveCooldown = keys['shift'] ? 0.11 : 0.19; // sprint steps faster, square by square
      }
    } else {
      moveCooldown = 0; // next key press moves immediately, no queued delay
    }

    const slot = window.kitchenSession?.state?.schedule?.find(item => item.playerId === window.kitchenSession?.state?.you);
    if (slot) timeLeft = Math.max(0, (slot.endAt - Date.now()) / 1000);
    else if (!window.kitchenSession?.connected) { timeLeft -= dt; if (timeLeft <= 0) { timeLeft = 0; endGame(); } }
    updateTickets(dt);

    msgTimer -= dt;
    if (msgTimer <= 0) document.getElementById('msg').style.color = 'var(--ink-dim)';

    document.getElementById('score').textContent = score;
    document.getElementById('missed').textContent = missed;
    const mm = Math.floor(timeLeft / 60), ss = Math.floor(timeLeft % 60);
    document.getElementById('time').textContent = `${mm}:${ss.toString().padStart(2,'0')}`;
    renderTickets();
  }

  function endGame() {
    running = false;
    const overlay = document.getElementById('overlay');
    overlay.classList.remove('hidden');
    overlay.innerHTML = `<h1>Shift Over</h1>
      <p>Final score: <strong style="color:var(--accent)">${score}</strong><br>Missed orders: ${missed}</p>
      <button id="restartBtn">Run it back</button>`;
    document.getElementById('restartBtn').addEventListener('click', () => location.reload());
  }

  document.getElementById('startBtn').addEventListener('click', () => {
    document.getElementById('overlay').classList.add('hidden');
    running = true;
    lastT = performance.now();
  });

  window.addEventListener('keydown', e => {
    if (notesModal.classList.contains('hidden') && macroModal.classList.contains('hidden') && ['e','q',' '].includes(e.key.toLowerCase())) {
      handleActionWrapped(e.key.toLowerCase());
    }
  });

  requestAnimationFrame(loop);
})();
