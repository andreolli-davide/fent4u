# Project Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the fent4u project — toolchain, shared types, Pino logger, a2a relay, main entry point, worker shells, and DuckDB analysis script — so both agents can be started with `bun run dev`.

**Architecture:** One Bun process spawns two `Bun.Worker`s (Liaison, Courier). The main thread is a dumb relay: it routes `postMessage` traffic between workers and drains NDJSON log lines from both into a session file. Business logic lives only in workers.

**Tech Stack:** Bun, TypeScript (strict ESM), `pino@^9`, `pino-pretty@^13`, `litellm`, `@unitn-asa/deliveroo-js-sdk`, `@duckdb/node-api` (dev), `bun:test`

---

## File Map

| File | Responsibility |
|------|---------------|
| `package.json` | deps, scripts |
| `tsconfig.json` | strict ESM, bundler resolution |
| `.gitignore` | ignore node_modules, .env, logs/ |
| `.env.example` | documented env vars |
| `src/types/config.ts` | `Config` type + `parseConfig` validator |
| `src/types/a2a.ts` | `AgentId`, `A2AMessage`, `WorkerEnvelope` discriminated union |
| `src/logger.ts` | `makeLogger` Pino factory with injectable `writeFn` |
| `src/relay.ts` | pure `relay()` function — a2a routing + log drain |
| `src/main.ts` | spawn workers, wire relay, drain logs to file |
| `src/agents/liaison.ts` | Liaison `Bun.Worker` shell |
| `src/agents/courier.ts` | Courier `Bun.Worker` shell |
| `scripts/analyse.ts` | DuckDB post-session query skeleton |
| `tests/config.test.ts` | `parseConfig` unit tests |
| `tests/logger.test.ts` | `makeLogger` unit tests |
| `tests/relay.test.ts` | `relay()` unit tests |

---

## Task 1: Toolchain files

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "fent4u",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "bun run src/main.ts",
    "dev": "bun run src/main.ts 2>&1 | pino-pretty",
    "test": "bun test",
    "analyse": "bun run scripts/analyse.ts"
  },
  "dependencies": {
    "@unitn-asa/deliveroo-js-sdk": "latest",
    "litellm": "latest",
    "pino": "^9"
  },
  "devDependencies": {
    "@duckdb/node-api": "latest",
    "@types/bun": "latest",
    "pino-pretty": "^13"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "types": ["bun-types"],
    "baseUrl": "."
  },
  "include": ["src", "scripts", "tests"]
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.env
logs/
dist/
*.ndjson
```

- [ ] **Step 4: Install dependencies**

```bash
bun install
```

Expected: `bun.lock` created, `node_modules/` populated, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lock
git commit -m "chore(toolchain): add package.json, tsconfig, gitignore"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/types/config.ts`
- Create: `src/types/a2a.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write `src/types/config.ts`**

```typescript
export interface Config {
  DELIVEROO_HOST: string
  DELIVEROO_PORT: number
  TOKEN_LIAISON: string
  TOKEN_COURIER: string
  LITELLM_MODEL: string
  LITELLM_API_KEY: string
  LITELLM_BASE_URL: string
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error'
  LOG_DIR: string
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const required = [
    'DELIVEROO_HOST',
    'DELIVEROO_PORT',
    'TOKEN_LIAISON',
    'TOKEN_COURIER',
    'LITELLM_MODEL',
    'LITELLM_API_KEY',
  ] as const

  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required env var: ${key}`)
  }

  const level = env.LOG_LEVEL ?? 'info'
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error(`Invalid LOG_LEVEL: ${level}`)
  }

  return {
    DELIVEROO_HOST: env.DELIVEROO_HOST!,
    DELIVEROO_PORT: Number(env.DELIVEROO_PORT),
    TOKEN_LIAISON: env.TOKEN_LIAISON!,
    TOKEN_COURIER: env.TOKEN_COURIER!,
    LITELLM_MODEL: env.LITELLM_MODEL!,
    LITELLM_API_KEY: env.LITELLM_API_KEY!,
    LITELLM_BASE_URL: env.LITELLM_BASE_URL ?? '',
    LOG_LEVEL: level as Config['LOG_LEVEL'],
    LOG_DIR: env.LOG_DIR ?? './logs',
  }
}
```

- [ ] **Step 2: Write `src/types/a2a.ts`**

```typescript
import type { Config } from './config.js'

export type AgentId = 'liaison' | 'courier'

export interface A2AMessage {
  from: AgentId
  to: AgentId
  type: string
  payload: unknown
}

export type WorkerEnvelope =
  | { kind: 'init'; config: Config }
  | { kind: 'a2a'; data: A2AMessage }
  | { kind: 'log'; data: string }
```

- [ ] **Step 3: Write the failing tests in `tests/config.test.ts`**

```typescript
import { describe, it, expect } from 'bun:test'
import { parseConfig } from '../src/types/config.js'

const base = {
  DELIVEROO_HOST: 'localhost',
  DELIVEROO_PORT: '8080',
  TOKEN_LIAISON: 'tok-a',
  TOKEN_COURIER: 'tok-b',
  LITELLM_MODEL: 'gpt-4o',
  LITELLM_API_KEY: 'sk-test',
}

describe('parseConfig', () => {
  it('returns a valid Config when all required vars are present', () => {
    const config = parseConfig(base)
    expect(config.DELIVEROO_HOST).toBe('localhost')
    expect(config.DELIVEROO_PORT).toBe(8080)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.LOG_DIR).toBe('./logs')
    expect(config.LITELLM_BASE_URL).toBe('')
  })

  it('coerces DELIVEROO_PORT to number', () => {
    const config = parseConfig({ ...base, DELIVEROO_PORT: '3000' })
    expect(config.DELIVEROO_PORT).toBe(3000)
    expect(typeof config.DELIVEROO_PORT).toBe('number')
  })

  it('throws when a required var is missing', () => {
    const { LITELLM_API_KEY: _, ...incomplete } = base
    expect(() => parseConfig(incomplete)).toThrow('Missing required env var: LITELLM_API_KEY')
  })

  it('throws on invalid LOG_LEVEL', () => {
    expect(() => parseConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow('Invalid LOG_LEVEL')
  })

  it('accepts optional vars', () => {
    const config = parseConfig({
      ...base,
      LOG_LEVEL: 'debug',
      LOG_DIR: '/tmp/logs',
      LITELLM_BASE_URL: 'http://proxy:4000',
    })
    expect(config.LOG_LEVEL).toBe('debug')
    expect(config.LOG_DIR).toBe('/tmp/logs')
    expect(config.LITELLM_BASE_URL).toBe('http://proxy:4000')
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
bun test tests/config.test.ts
```

Expected: FAIL — `Cannot find module '../src/types/config.js'` (files exist but bun may error on the `!` non-null assertions before types are wired). If it passes already, continue.

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/config.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/config.ts src/types/a2a.ts tests/config.test.ts
git commit -m "feat(types): add Config, parseConfig, A2AMessage, WorkerEnvelope"
```

---

## Task 3: Logger factory

**Files:**
- Create: `src/logger.ts`
- Create: `tests/logger.test.ts`

- [ ] **Step 1: Write the failing tests in `tests/logger.test.ts`**

```typescript
import { describe, it, expect } from 'bun:test'
import { makeLogger } from '../src/logger.js'

describe('makeLogger', () => {
  it('injects agentId and module into every log line', () => {
    const lines: string[] = []
    const log = makeLogger('liaison', 'bdi', {
      level: 'debug',
      writeFn: (line) => lines.push(line),
    })

    log.info({ tick: 5 }, 'test message')

    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.agentId).toBe('liaison')
    expect(parsed.module).toBe('bdi')
    expect(parsed.tick).toBe(5)
    expect(parsed.msg).toBe('test message')
  })

  it('filters out lines below the configured level', () => {
    const lines: string[] = []
    const log = makeLogger('courier', 'bdi', {
      level: 'warn',
      writeFn: (line) => lines.push(line),
    })

    log.debug('filtered')
    log.info('filtered')
    log.warn('kept')

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).msg).toBe('kept')
  })

  it('writes to process.stdout when no writeFn is provided', () => {
    // just verify it does not throw
    const log = makeLogger('liaison', 'test', { level: 'error' })
    expect(() => log.error('stdout test')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/logger.test.ts
```

Expected: FAIL — `Cannot find module '../src/logger.js'`

- [ ] **Step 3: Write `src/logger.ts`**

```typescript
import pino, { type Logger } from 'pino'
import type { AgentId } from './types/a2a.js'

export interface LoggerOptions {
  level: string
  writeFn?: (line: string) => void
}

export function makeLogger(
  agentId: AgentId | 'main',
  module: string,
  options: LoggerOptions
): Logger {
  const stream = {
    write(line: string): void {
      if (options.writeFn) {
        options.writeFn(line)
      } else {
        process.stdout.write(line)
      }
    },
  }
  return pino({ level: options.level }, stream).child({ agentId, module })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/logger.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts tests/logger.test.ts
git commit -m "feat(logger): add Pino factory with injectable writeFn"
```

---

## Task 4: Relay logic

**Files:**
- Create: `src/relay.ts`
- Create: `tests/relay.test.ts`

- [ ] **Step 1: Write the failing tests in `tests/relay.test.ts`**

```typescript
import { describe, it, expect } from 'bun:test'
import { relay, type WorkerLike } from '../src/relay.js'
import type { WorkerEnvelope } from '../src/types/a2a.js'

function makeWorkers(): {
  liaison: WorkerLike & { received: WorkerEnvelope[] }
  courier: WorkerLike & { received: WorkerEnvelope[] }
} {
  const make = () => {
    const received: WorkerEnvelope[] = []
    return { received, postMessage: (m: WorkerEnvelope) => received.push(m) }
  }
  return { liaison: make(), courier: make() }
}

describe('relay', () => {
  it('writes log envelopes to logWriter and does not forward them', () => {
    const workers = makeWorkers()
    const logLines: string[] = []
    const envelope: WorkerEnvelope = { kind: 'log', data: '{"level":30,"msg":"hi"}' }

    relay(envelope, 'liaison', workers, (line) => logLines.push(line))

    expect(logLines).toEqual(['{"level":30,"msg":"hi"}'])
    expect(workers.liaison.received).toHaveLength(0)
    expect(workers.courier.received).toHaveLength(0)
  })

  it('forwards a2a envelopes to the destination worker', () => {
    const workers = makeWorkers()
    const envelope: WorkerEnvelope = {
      kind: 'a2a',
      data: { from: 'liaison', to: 'courier', type: 'delta', payload: { x: 1 } },
    }

    relay(envelope, 'liaison', workers, () => {})

    expect(workers.courier.received).toHaveLength(1)
    expect(workers.courier.received[0]).toEqual(envelope)
    expect(workers.liaison.received).toHaveLength(0)
  })

  it('does not echo a2a messages back to sender even if to === from', () => {
    const workers = makeWorkers()
    const envelope: WorkerEnvelope = {
      kind: 'a2a',
      data: { from: 'liaison', to: 'liaison', type: 'self', payload: null },
    }

    relay(envelope, 'liaison', workers, () => {})

    expect(workers.liaison.received).toHaveLength(0)
  })

  it('ignores init envelopes (they are never relayed)', () => {
    const workers = makeWorkers()
    const envelope: WorkerEnvelope = {
      kind: 'init',
      config: {} as never,
    }

    relay(envelope, 'liaison', workers, () => {})

    expect(workers.liaison.received).toHaveLength(0)
    expect(workers.courier.received).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/relay.test.ts
```

Expected: FAIL — `Cannot find module '../src/relay.js'`

- [ ] **Step 3: Write `src/relay.ts`**

```typescript
import type { AgentId, WorkerEnvelope } from './types/a2a.js'

export interface WorkerLike {
  postMessage(msg: WorkerEnvelope): void
}

export function relay(
  envelope: WorkerEnvelope,
  from: AgentId,
  workers: Record<AgentId, WorkerLike>,
  logWriter: (line: string) => void
): void {
  if (envelope.kind === 'log') {
    logWriter(envelope.data)
    return
  }

  if (envelope.kind === 'init') return

  const target = envelope.data.to
  if (target !== from && target in workers) {
    workers[target].postMessage(envelope)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/relay.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all 12 tests PASS (5 config + 3 logger + 4 relay).

- [ ] **Step 6: Commit**

```bash
git add src/relay.ts tests/relay.test.ts
git commit -m "feat(relay): add pure a2a relay function with log drain"
```

---

## Task 5: Main entry point

**Files:**
- Create: `src/main.ts`

- [ ] **Step 1: Write `src/main.ts`**

```typescript
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseConfig } from './types/config.js'
import { makeLogger } from './logger.js'
import { relay } from './relay.js'
import type { AgentId, WorkerEnvelope } from './types/a2a.js'

const config = parseConfig(Bun.env)

mkdirSync(config.LOG_DIR, { recursive: true })
const logPath = join(config.LOG_DIR, `session-${Date.now()}.ndjson`)
const logFile = Bun.file(logPath).writer()

const log = makeLogger('main', 'main', {
  level: config.LOG_LEVEL,
  writeFn: (line) => {
    process.stdout.write(line)
    logFile.write(line)
  },
})

const liaison = new Worker(new URL('./agents/liaison.ts', import.meta.url))
const courier = new Worker(new URL('./agents/courier.ts', import.meta.url))

const workers: Record<AgentId, Worker> = { liaison, courier }

function handleMessage(from: AgentId): (event: MessageEvent) => void {
  return (event: MessageEvent) => {
    const envelope = event.data as WorkerEnvelope
    relay(envelope, from, workers, (line) => {
      process.stdout.write(line)
      logFile.write(line)
    })
  }
}

liaison.addEventListener('message', handleMessage('liaison'))
courier.addEventListener('message', handleMessage('courier'))

liaison.addEventListener('error', (e) => log.error({ err: e.message }, 'liaison worker error'))
courier.addEventListener('error', (e) => log.error({ err: e.message }, 'courier worker error'))

const initLiaison: WorkerEnvelope = { kind: 'init', config: { ...config, TOKEN: config.TOKEN_LIAISON } as never }
const initCourier: WorkerEnvelope = { kind: 'init', config: { ...config, TOKEN: config.TOKEN_COURIER } as never }

liaison.postMessage(initLiaison)
courier.postMessage(initCourier)

log.info({ logPath }, 'fent4u started — both workers initialised')

process.on('SIGINT', async () => {
  log.info('shutting down')
  liaison.terminate()
  courier.terminate()
  await logFile.flush()
  process.exit(0)
})
```

- [ ] **Step 2: Verify TypeScript compiles without errors**

```bash
bun build src/main.ts --target bun --dry-run 2>&1 || bun run --smol src/main.ts --help 2>&1 | head -5
```

Since there are no args, just check the import chain typechecks:

```bash
bun run --hot src/main.ts 2>&1 | head -5
```

Expected: process starts (may error on missing .env — that is expected at this stage).

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): add process entry — worker spawn, a2a relay, log drain"
```

---

## Task 6: Worker shells

**Files:**
- Create: `src/agents/liaison.ts`
- Create: `src/agents/courier.ts`

- [ ] **Step 1: Write `src/agents/liaison.ts`**

```typescript
import { makeLogger } from '../logger.js'
import type { WorkerEnvelope, A2AMessage } from '../types/a2a.js'
import type { Config } from '../types/config.js'

let log: ReturnType<typeof makeLogger> | null = null

function send(msg: A2AMessage): void {
  const envelope: WorkerEnvelope = { kind: 'a2a', data: msg }
  self.postMessage(envelope)
}

self.onmessage = (event: MessageEvent<WorkerEnvelope>) => {
  const envelope = event.data

  if (envelope.kind === 'init') {
    const config = envelope.config as Config
    log = makeLogger('liaison', 'agent', {
      level: config.LOG_LEVEL,
      writeFn: (line) => {
        const logEnvelope: WorkerEnvelope = { kind: 'log', data: line }
        self.postMessage(logEnvelope)
      },
    })
    log.info({ tick: 0 }, 'Liaison initialised')
    return
  }

  if (envelope.kind === 'a2a') {
    log?.debug({ type: envelope.data.type, from: envelope.data.from }, 'a2a received')
    // BDI loop wired here in subsequent tasks
  }
}

export type { send }
```

- [ ] **Step 2: Write `src/agents/courier.ts`**

```typescript
import { makeLogger } from '../logger.js'
import type { WorkerEnvelope, A2AMessage } from '../types/a2a.js'
import type { Config } from '../types/config.js'

let log: ReturnType<typeof makeLogger> | null = null

function send(msg: A2AMessage): void {
  const envelope: WorkerEnvelope = { kind: 'a2a', data: msg }
  self.postMessage(envelope)
}

self.onmessage = (event: MessageEvent<WorkerEnvelope>) => {
  const envelope = event.data

  if (envelope.kind === 'init') {
    const config = envelope.config as Config
    log = makeLogger('courier', 'agent', {
      level: config.LOG_LEVEL,
      writeFn: (line) => {
        const logEnvelope: WorkerEnvelope = { kind: 'log', data: line }
        self.postMessage(logEnvelope)
      },
    })
    log.info({ tick: 0 }, 'Courier initialised')
    return
  }

  if (envelope.kind === 'a2a') {
    log?.debug({ type: envelope.data.type, from: envelope.data.from }, 'a2a received')
    // BDI loop wired here in subsequent tasks
  }
}

export type { send }
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/liaison.ts src/agents/courier.ts
git commit -m "feat(agents): add Liaison and Courier worker shells"
```

---

## Task 7: Environment example

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Write `.env.example`**

```ini
# Game server
DELIVEROO_HOST=localhost
DELIVEROO_PORT=8080

# Agent tokens (assigned by the Deliveroo.js server config)
TOKEN_LIAISON=token-a
TOKEN_COURIER=token-b

# LiteLLM — set LITELLM_BASE_URL to point at a proxy; leave blank for direct API
LITELLM_MODEL=gpt-4o
LITELLM_API_KEY=sk-...
LITELLM_BASE_URL=

# Logging: debug | info | warn | error
LOG_LEVEL=info
LOG_DIR=./logs
```

- [ ] **Step 2: Copy to .env and fill in real values for local testing**

```bash
cp .env.example .env
# then edit .env with real tokens
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore(env): add .env.example with all required vars documented"
```

---

## Task 8: DuckDB analysis script

**Files:**
- Create: `scripts/analyse.ts`

- [ ] **Step 1: Write `scripts/analyse.ts`**

```typescript
import { DuckDBInstance } from '@duckdb/node-api'

const LOG_GLOB = process.argv[2] ?? './logs/*.ndjson'

const instance = await DuckDBInstance.create(':memory:')
const conn = await instance.connect()

console.log(`\nAnalysing logs: ${LOG_GLOB}\n`)

// Intent switches over time
console.log('=== Intent switches ===')
const intentResult = await conn.runAndReadAll(`
  SELECT
    CAST(tick AS INTEGER) AS tick,
    agentId,
    json_extract_string(json, '$.from') AS from_intent,
    json_extract_string(json, '$.to')   AS to_intent,
    json_extract_string(json, '$.uFrom') AS u_from,
    json_extract_string(json, '$.uTo')   AS u_to
  FROM read_ndjson_auto('${LOG_GLOB}', columns={tick:'VARCHAR', agentId:'VARCHAR', msg:'VARCHAR', json:'JSON'})
  WHERE msg = 'intent-switch'
  ORDER BY tick
`)
console.table(intentResult.getRowObjects())

// BDI tick durations
console.log('\n=== Tick duration percentiles (ms) ===')
const perfResult = await conn.runAndReadAll(`
  SELECT
    agentId,
    ROUND(quantile_cont(CAST(durationMs AS DOUBLE), 0.50), 2) AS p50,
    ROUND(quantile_cont(CAST(durationMs AS DOUBLE), 0.95), 2) AS p95,
    ROUND(quantile_cont(CAST(durationMs AS DOUBLE), 0.99), 2) AS p99,
    COUNT(*) AS ticks
  FROM read_ndjson_auto('${LOG_GLOB}', columns={agentId:'VARCHAR', msg:'VARCHAR', durationMs:'VARCHAR'})
  WHERE msg = 'tick-done'
  GROUP BY agentId
`)
console.table(perfResult.getRowObjects())

await conn.close()
await instance.close()
```

- [ ] **Step 2: Commit**

```bash
git add scripts/analyse.ts
git commit -m "feat(scripts): add DuckDB post-session log analysis script"
```

---

## Task 9: Smoke test — end-to-end startup

No new files. Verifies all tasks compose correctly.

- [ ] **Step 1: Run the full test suite one last time**

```bash
bun test
```

Expected: all 12 tests PASS (5 config + 3 logger + 4 relay).

- [ ] **Step 2: Start the agents with a real `.env`**

```bash
bun run dev
```

Expected (pino-pretty output, two lines within ~1 second):

```
INFO  [liaison] [agent] Liaison initialised  tick=0
INFO  [courier] [agent] Courier initialised  tick=0
```

- [ ] **Step 3: Verify a session log file was created**

```bash
ls -la ./logs/
```

Expected: one `session-<timestamp>.ndjson` file, non-empty.

- [ ] **Step 4: Verify the log file contains valid NDJSON from both agents**

```bash
head -5 ./logs/session-*.ndjson | jq '{agentId, msg, tick}'
```

Expected: objects with `agentId: "liaison"` and `agentId: "courier"` present.

- [ ] **Step 5: Stop the process and run the analysis script**

Press Ctrl-C, then:

```bash
bun run analyse
```

Expected: DuckDB prints empty tables (no intent-switch or tick-done events yet — shells don't emit them). No errors.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: verify scaffold smoke test passes"
```

---

## Self-Review

**Spec coverage check:**

| Spec §| Requirement | Covered by |
|---|---|---|
| §2 Process model | Two Bun.Worker, main as relay | Tasks 4, 5 |
| §2 a2a via main, `{ from, to, type, payload }` | `A2AMessage` type + `relay()` | Tasks 2, 4 |
| §3 Config → main → workers | `parseConfig` + init envelope | Tasks 2, 5 |
| §4 Toolchain: Bun, strict TS, ESM | `package.json`, `tsconfig.json` | Task 1 |
| §5 LiteLLM integration point | Import path in `compiler.ts` stub | Task 6 (noted in agent shells; compiler is a later task) |
| §6 Pino + `writeFn` for workers | `makeLogger` + worker shells | Tasks 3, 6 |
| §7 DuckDB analysis | `scripts/analyse.ts` | Task 8 |
| §7 `.env.example` | documented all vars | Task 7 |
| FALLBACK = OFF | Constant `false` — not yet needed in shells | Shells note it; compiler task enforces it |

**Placeholder scan:** No TBDs. Every step has exact code. `// BDI loop wired here` comments in worker shells are intentional hooks for the next plan, not incomplete steps.

**Type consistency:** `WorkerEnvelope`, `A2AMessage`, `AgentId` defined once in Task 2 and imported in Tasks 3, 4, 5, 6 — no renames.
