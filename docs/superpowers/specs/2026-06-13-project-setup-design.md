# fent4u — Project Setup Design

**Date:** 2026-06-13
**Status:** Approved

---

## 1. Scope

Initial project scaffolding for fent4u: runtime, toolchain, process model, configuration, observability, and LLM integration. Implementation must follow DESIGN.md; this spec covers only the infrastructure that hosts the agents, not the BDI logic itself.

---

## 2. Runtime & SDK

- **Runtime:** Bun (TypeScript-native, no Node.js, no `ts-node`)
- **Game SDK:** `@unitn-asa/deliveroo-js-sdk` (npm) — official Deliveroo.js client wrapper
- **LLM SDK:** `litellm` (npm JS SDK) — unified interface for the mission compiler (DESIGN.md §3)

---

## 3. Process Model

One Bun process. Two `Bun.Worker` instances (Liaison, Courier). Main thread is a dumb relay.

```
main.ts (main thread)
  ├─ spawns Worker("src/agents/liaison.ts")
  ├─ spawns Worker("src/agents/courier.ts")
  ├─ routes: liaison → postMessage → courier  (blackboard deltas, contract proposals)
  ├─ routes: courier → postMessage → liaison  (bids, delta acks)
  └─ drains NDJSON logs from both workers → ./logs/session-<timestamp>.ndjson
```

### Rules

- Bun workers cannot `postMessage` each other directly — all a2a traffic routes through main
- Main thread contains zero business logic: inspect `msg.to`, forward, done
- Every inter-worker message carries `{ from: AgentId, to: AgentId, type: string, payload: unknown }`
- Satisfies DESIGN.md §2.3.5 "local reliable channel" assumption — in-process relay has zero loss and negligible latency; no CRDT, tombstones, or conflict resolution needed
- FALLBACK PDDL flag is `false` (compile-time constant) — `FALLBACK` missions resolve to `NOT_APPLICABLE` and are discarded (DESIGN.md §4.4)

---

## 4. Source Layout

```
src/
  main.ts              # process entry: spawn workers, route a2a, drain logs to file
  logger.ts            # Pino singleton + child logger factory
  agents/
    liaison.ts         # Liaison worker entry point
    courier.ts         # Courier worker entry point
  bdi/
    loop.ts            # shared BDI tick loop
    intentions.ts      # intention types and selector (§9.9)
    utility.ts         # U_route, U_mission, U_explore, U_idle (§5.5)
  blackboard/
    blackboard.ts      # shared replicated state (§2.2)
    beliefs.ts         # belief schema and update logic (§2.3)
  mission/
    compiler.ts        # async LLM mission compiler (§3)
    kinds.ts           # Mission type definitions (§4)
  coordination/
    contract.ts        # Contract primitive and lifecycle (§8)
  planning/
    astar.ts           # push-aware A* (§5.1, §15)
  external/
    deliveroo.ts       # deliveroo.js client wrapper
scripts/
  analyse.ts           # DuckDB post-session analysis queries
```

---

## 5. Configuration

Bun reads `.env` natively. `.env.example` is committed; `.env` is gitignored.

```ini
# Game server
DELIVEROO_HOST=localhost
DELIVEROO_PORT=8080

# Agent tokens
TOKEN_LIAISON=token-a
TOKEN_COURIER=token-b

# LiteLLM
LITELLM_MODEL=gpt-4o
LITELLM_API_KEY=sk-...
LITELLM_BASE_URL=          # optional: custom proxy endpoint

# Logging
LOG_LEVEL=info             # debug|info|warn|error
LOG_DIR=./logs
```

### Config flow

Config is loaded and validated in `main.ts` with a type guard. A bad `.env` kills the process before any worker starts (fail fast). Workers receive config via the initial `postMessage` — they never read `Bun.env` directly. One validation point, one source of truth.

---

## 6. Toolchain

### `package.json`

```json
{
  "scripts": {
    "start": "bun run src/main.ts",
    "dev": "bun run src/main.ts 2>&1 | pino-pretty",
    "analyse": "bun run scripts/analyse.ts"
  },
  "dependencies": {
    "@unitn-asa/deliveroo-js-sdk": "latest",
    "litellm": "latest",
    "pino": "^9"
  },
  "devDependencies": {
    "pino-pretty": "^13",
    "@types/bun": "latest",
    "@duckdb/node-api": "latest"
  }
}
```

DuckDB is not a runtime dependency. Analysis runs via `scripts/analyse.ts` using `@duckdb/node-api` (dev dependency) or the DuckDB CLI.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "types": ["bun-types"]
  },
  "include": ["src", "scripts"]
}
```

`moduleResolution: "bundler"` is Bun's native mode. Relative imports use `.js` extensions per CLAUDE.md convention.

---

## 7. Observability — Pino + DuckDB

### Pino (runtime)

`src/logger.ts` exports one factory:

```ts
export function makeLogger(agentId: 'liaison' | 'courier', module: string): pino.Logger
```

Every source file calls this once at module init. `console.log` is banned project-wide.

Mandatory fields on every log line: `{ level, time, tick, agentId, module, msg }`.

Log discipline (from CLAUDE.md):
- `info` — intent switches `{ from, to, uFrom, uTo, tick }`, mission lifecycle `{ missionId, kind, status }`
- `debug` — auction rounds `{ parcelId, winner, deltaA, deltaB }`, blackboard deltas `{ type, entityId }`, BDI tick duration `{ durationMs }`

Main thread collects NDJSON lines from both workers and writes to `./logs/session-<timestamp>.ndjson`.

### DuckDB (post-session)

`scripts/analyse.ts` loads the session log and runs SQL queries:

```sql
SELECT tick, agentId, intent, u
FROM read_json_auto('./logs/*.ndjson')
WHERE msg = 'intent-switch'
ORDER BY tick;
```

DuckDB runs offline after a session ends, never in the hot BDI loop.

### Why not OpenTelemetry

Considered and rejected: Bun + OTEL Node SDK has rough edges; per-span overhead risks jitter in the 50ms BDI loop; collector infrastructure is overkill for a 2-agent local project. Pino fires ~2µs/call with zero infra.

---

## 8. LiteLLM Integration

`src/mission/compiler.ts` is the only file that touches LiteLLM. It runs async, off the 50ms loop (DESIGN.md §10).

```ts
import { completion } from 'litellm'

async function compileMission(raw: string, config: Config): Promise<Mission | null> {
  const response = await completion({
    model: config.LITELLM_MODEL,
    messages: [{ role: 'user', content: buildPrompt(raw) }],
    response_format: { type: 'json_object' },
  })
  return validateMission(JSON.parse(response.choices[0].message.content))
}
```

`validateMission` is a type guard returning `null` on malformed output. `FALLBACK` kind always returns `null` (flag OFF). Errors are caught, logged at `warn`, prior mission state preserved.

---

## 9. Decision Summary

| Concern | Decision |
|---|---|
| Runtime | Bun |
| Game SDK | `@unitn-asa/deliveroo-js-sdk` |
| Process model | One process, two `Bun.Worker`s, main as relay |
| a2a channel | `postMessage` via main thread |
| LLM | LiteLLM JS SDK, `response_format: json_object` |
| FALLBACK flag | `false` — `NOT_APPLICABLE` |
| Logging | Pino child loggers, NDJSON to `./logs/` |
| Analysis | DuckDB via `scripts/analyse.ts` |
| Config | `.env` → validated in main → passed to workers |
