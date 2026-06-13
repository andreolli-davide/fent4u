# fent4u — Claude Code Project Guide

## Project Brief

Two-person university project (ASA course). Two cooperating BDI agents play Deliveroo.js together to maximise combined score. One agent (Liaison) handles natural-language special missions via an async LLM compiler; the other (Courier) plays pure BDI. Both share a replicated blackboard over an agent-to-agent channel.

External game server: `external/deliveroo.js` (git submodule).

## Architecture

**DESIGN.md is the single source of truth.** Read it before touching any agent logic. If code and DESIGN.md conflict, the code is wrong — fix the code, never diverge silently.

Key sections to read first:
- §2 — architecture overview and blackboard schema
- §5 — unified utility model (points/tick)
- §8 — coordination contracts
- §9 — execution selector

`GAME_RULES.md` is the authoritative reference for game mechanics (tile types, actions, decay, scoring).

## Planned Source Layout

```
src/
  agents/
    liaison.ts       # Liaison agent entry point
    courier.ts       # Courier agent entry point
  bdi/
    loop.ts          # shared BDI tick loop
    intentions.ts    # intention types and selector (§9.9)
    utility.ts       # U_route, U_mission, U_explore, U_idle (§5.5)
  blackboard/
    blackboard.ts    # shared replicated state (§2.2)
    beliefs.ts       # belief schema and update logic (§2.3)
  mission/
    compiler.ts      # async LLM mission compiler (§3)
    kinds.ts         # Mission type definitions (§4)
  coordination/
    contract.ts      # Contract primitive and lifecycle (§8)
  planning/
    astar.ts         # push-aware A* (§5.1, §15)
  external/
    deliveroo.ts     # deliveroo.js client wrapper
```

## TypeScript Conventions

- `strict: true` in tsconfig — no exceptions
- No `any`. Use `unknown` + type guards at boundaries.
- ESM modules: `import`/`export`, use `.js` extensions in relative imports
- No implicit `any` from untyped third-party libs — write minimal type stubs instead
- One concept per file; keep files focused (see layout above)

## Git Workflow

Conventional Commits format required:

```
feat(blackboard): add delta-sync broadcast
fix(utility): correct Rnow decay formula
docs(design): update §5.5 for deadline urgency
refactor(astar): extract push admissibility check
```

**PR required for:** new features, refactors, anything touching the BDI loop, blackboard, utility model, or mission compiler.

**Direct push to main OK for:** docs edits, config changes, typo fixes, dependency bumps.

## Runtime & Toolchain

- **Bun** is the TypeScript runtime — no Node.js, no `ts-node`
- SDK: `@unitn-asa/deliveroo-js-sdk` (npm) — official Deliveroo.js client
- LLM: `litellm` (npm JS SDK) — unified interface for mission compiler (§3 DESIGN.md)

## Process Model — Two Bun Workers (MANDATORY)

**Liaison and Courier run as two `Bun.Worker` instances inside one Bun process.**

```
main.ts (main thread)
  ├─ spawns Worker("src/agents/liaison.ts")
  ├─ spawns Worker("src/agents/courier.ts")
  ├─ routes: liaison → postMessage → courier  (blackboard deltas, contract proposals)
  ├─ routes: courier → postMessage → liaison  (bids, delta acks)
  └─ drains NDJSON logs from both workers → ./logs/session-<timestamp>.ndjson
```

**Rules:**
- Bun workers cannot `postMessage` each other directly — ALL a2a traffic routes through main
- Main thread is a dumb relay: inspect `msg.to`, forward, no business logic
- Every inter-worker message must carry `{ from: AgentId, to: AgentId, type: string, payload: unknown }`
- This satisfies DESIGN.md §2.3.5 "local reliable channel" assumption — in-process relay = zero loss, negligible latency, no CRDT needed
- FALLBACK PDDL flag is `false` (constant) — `FALLBACK` missions resolve to `NOT_APPLICABLE` and are discarded

## Observability — Pino + DuckDB (MANDATORY)

**ALL logging and telemetry MUST use Pino + DuckDB. No exceptions.**

### Pino (structured logging)
- Every log line is NDJSON with mandatory fields: `{ level, time, tick, agentId, msg, ...context }`
- Use child loggers per module: `logger.child({ agentId: 'liaison', module: 'bdi' })`
- Dev: pipe through `pino-pretty` for colored output
- Prod/analysis: write raw NDJSON to file (one per agent)
- **Never use `console.log` anywhere** — always use the Pino logger

### DuckDB (post-session analysis)
- After a game session, query NDJSON logs with DuckDB SQL
- Example: `SELECT tick, agentId, intent, u FROM read_json_auto('*.log') WHERE level='info' ORDER BY tick`
- Use for: intent distribution, utility values over time, tick timing, mission events
- DuckDB runs offline (analysis step), never in the hot BDI loop

### Why this stack
- Pino fires ~2µs/call — safe inside the 50ms BDI loop with zero drift risk
- Zero infrastructure: no collector, no sidecar, no ports
- DuckDB queries NDJSON directly — no ingestion step needed
- OpenTelemetry was considered and rejected: Bun+OTEL has rough edges, per-span overhead risks jitter in the 50ms loop, and collector infra is overkill for a 2-agent local project

### Tracing discipline
- Log **every intent switch** at `info` level with `{ from, to, uFrom, uTo, tick }`
- Log **every auction round** at `debug` level with `{ parcelId, winner, deltaA, deltaB }`
- Log **every blackboard delta** at `debug` level with `{ type, entityId, agentId }`
- Log **mission lifecycle events** at `info` level with `{ missionId, kind, status, tick }`
- Log **BDI tick duration** at `debug` level with `{ durationMs }` — alert if >40ms

## Claude Code Workflow

- Run `/brainstorming` before implementing any new feature or subsystem
- Run `/writing-plans` before starting implementation after brainstorming
- Always read DESIGN.md before editing agent logic — Claude will do this automatically
- Caveman mode is active project-wide (startup hook); use `/caveman lite` or `stop caveman` to adjust
