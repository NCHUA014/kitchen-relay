# Controlled agent interface

Human players still use `npm start` and `http://localhost:3000`.

LLM agents do not open the lobby, browser DevTools, WebSocket, source files, or database. A researcher creates a four-agent experiment through the protected HTTP API. The response contains one private token per agent. Do not place a token in an LLM prompt visible to another agent.

Set a non-default researcher token before any shared deployment:

```powershell
$env:RESEARCHER_TOKEN = "replace-with-a-long-random-secret"
npm start
```

For local development the default researcher token is `local-researcher-token`.

Create an experiment:

```powershell
$headers = @{ "x-researcher-token" = "local-researcher-token" }
$body = @{ agents = @("Codex", "Claude", "Gemini", "DeepSeek") } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/researcher/experiments" -Headers $headers -ContentType "application/json" -Body $body
```

Each response supplies `{ brand, token }`. The server creates the sequential five-turn plan and starts it. The terminal reports, for example, `Codex joined the kitchen!`.

An agent supplies its token only as `Authorization: Bearer <token>`.

- `GET /api/agent/observe` returns its permitted observation: visible map, tickets, world objects, notes, macros, its turn status, and an exact list of allowed action names.
- `POST /api/agent/act` accepts exactly one named action, then returns the updated observation. It cannot execute arbitrary JavaScript, browser commands, filesystem operations, network requests, or raw WebSocket messages.

Example atomic action:

```json
{ "action": "move", "direction": "left" }
```

The available named actions cover movement, ingredient/plate interactions, serving, notes, and macro saves. An agent should repeatedly `observe`, reason, send one `act`, and observe again.

Researcher observer mode is at `http://localhost:3000/researcher.html`. Enter the researcher token and experiment ID. It is read-only and polls server-owned state once per second.

Every agent `observe` and `act` is appended to:

- `server/runs/<experiment-id>/events.jsonl` — one chronological event stream for the experiment.
- `server/runs/<experiment-id>/<brand>.jsonl` — the brand-specific filtered stream.
- `server/runs/<experiment-id>/<brand>.txt` — a readable transcript.

SQLite persistence is enabled now. Set `APP_ENV` to `uat` (the default) or `iwt` before starting the server; it creates `server/data/uat.sqlite` or `server/data/iwt.sqlite` respectively. Both store experiments, agents, turns, full observe/act payloads, and note/macro revisions. The JSONL files remain the chronological research record.
