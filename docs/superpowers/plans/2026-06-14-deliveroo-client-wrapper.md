# Deliveroo Client Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/external/deliveroo.ts` — the single typed, role-aware boundary between the untyped `@unitn-asa/deliveroo-js-sdk` and the Liaison/Courier BDI workers.

**Architecture:** Functional core / imperative shell. Pure exported functions do all risky work (tile/sensing normalization, decay-string parsing, tick interpolation) and are unit-tested without a socket. A thin `connect()` factory wires the SDK socket to those pure functions and returns a `DeliverooClient`. The untyped SDK is described by a hand-written ambient `.d.ts` stub covering only the surface we use.

**Tech Stack:** Bun (runtime + `bun test`), TypeScript `strict`, `@unitn-asa/deliveroo-js-sdk`, `pino` (injected child logger), ESM with `.js` import extensions.

---

## Reference: ground-truth facts (verified against SDK source + server submodule)

These are the facts the code depends on. Verified in `node_modules/@unitn-asa/deliveroo-js-sdk/src` and `external/deliveroo.js/backend/src`.

- `DjsConnect(host, token, name, autoconnect) → DjsClientSocket` (extends socket.io `Socket`).
- One-shot promise getters on the socket (resolve once):
  - `socket.me: Promise<IOAgent>` (resolves from the first `you` event)
  - `socket.config: Promise<IOConfig>`
  - `socket.map: Promise<{ width: number; height: number; tiles: IOTile[] }>` — **resolves to an object; take `.tiles`**
  - `socket.token: Promise<string>` (unused here)
- Repeating listeners: `onConnect(cb)`, `onDisconnect(cb)`, `onConfig(cb)`, `onMap(cb)`, `onYou(cb)`, `onSensing(cb)`, `onMsg(cb)` where `onMsg` cb is `(id, name, msg, replyAck) => void`.
- Raw socket.io events also available via `socket.on(event, cb)`. The `ping` event fires every 1000 ms with payload `(pingData, ackCallback)`; `pingData` carries `{ frame, roundTrip }` (server `ioServer.js`, `PING_INTERVAL = 1000`). The server `Clock` increments `frame` every `CLOCK` ms (default 50). `sensing` carries **no** frame.
- Async actions (all return Promises):
  - `emitMove(dir) → Promise<{x,y} | false>`
  - `emitPickup() → Promise<{ id: string }[]>`
  - `emitPutdown(selected = []) → Promise<{ id: string }[]>`
  - `emitSay(toId, msg) → Promise<'successful' | 'failed'>`
  - `emitAsk(toId, msg) → Promise<unknown>`
  - `emitShout(msg) → Promise<unknown>`
  - `emitAndResolveOnAck` has a 1 s ack timeout → action Promises reject on timeout.
- IO wire shapes (JSDoc typedefs):
  - `IOSensing { positions: {x,y}[]; agents: IOAgent[]; parcels: IOParcel[]; crates: IOCrate[] }`
  - `IOParcel { id: string; x: number; y: number; carriedBy?: string; reward: number }`
  - `IOAgent { id: string; name: string; teamId: string; teamName: string; x?: number; y?: number; score: number; penalty: number }`
  - `IOTile { x: number; y: number; type: IOTileType }`, `IOTileType = '0'|'1'|'2'|'3'|'4'|'5'|'5!'|'←'|'↑'|'→'|'↓'`
  - `IOConfig { CLOCK: number; PENALTY: number; AGENT_TIMEOUT: number; BROADCAST_LOGS: boolean; GAME: IOGameOptions }`
  - `IOGameOptions.parcels.decaying_event: string`, `IOGameOptions.player.movement_duration: number`, `IOGameOptions.player.observation_distance: number`
  - `IOCrate { id: string; x: number; y: number }`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/types/perception.ts` | Project-owned domain types: `Pos`, `TileType`, `Tile`, `ParcelObs`, `AgentObs`, `CrateObs`, `SelfObs`, `PickResult`, `GameConsts`, `PerceptionSnapshot`, `Role`. Zero imports. |
| `src/external/deliveroo-sdk.d.ts` | Ambient `declare module '@unitn-asa/deliveroo-js-sdk'` describing only the surface we use (`DjsConnect`, `DjsClientSocket`, `IO*` shapes). |
| `src/external/deliveroo.ts` | Imperative shell `connect()` factory + the `DeliverooClient` object, plus the pure exported functions `normalizeTile`, `normalizeSensing`, `parseDecayEvent`, `tickFrom`, `buildConsts`. |
| `tests/perception.test.ts` | Tests for any pure helpers that live in perception.ts (none initially — types only; file created when first needed). *(Not created in this plan — perception.ts is types-only.)* |
| `tests/deliveroo-normalize.test.ts` | Unit tests for `normalizeTile`, `normalizeSensing`. |
| `tests/deliveroo-consts.test.ts` | Unit tests for `parseDecayEvent`, `buildConsts`. |
| `tests/deliveroo-tick.test.ts` | Unit tests for `tickFrom`. |
| `tests/deliveroo-connect.test.ts` | Fake-socket end-to-end test of `connect()` + role gating. |

**Why this split:** the pure functions in `deliveroo.ts` are exported so tests import them directly without constructing a socket. The `.d.ts` is a separate file because it is ambient declaration (no runtime), keeping `deliveroo.ts` free of `any`. `perception.ts` has zero imports so every other module can depend on it without cycles.

**Convention note:** tests use `bun test` with `import { test, expect } from 'bun:test'` (see existing `tests/relay.test.ts`, `tests/config.test.ts`). Relative imports use `.js` extensions. No `console.log` anywhere — the wrapper uses the injected pino logger.

---

### Task 1: Domain types (`src/types/perception.ts`)

Pure type declarations, no runtime code, no tests (types are checked by `tsc`/`bun`). This task unblocks every later task.

**Files:**
- Create: `src/types/perception.ts`

- [ ] **Step 1: Write the types file**

```ts
// src/types/perception.ts
// Project-owned perception domain types. The SDK's IO* wire shapes never escape
// src/external/deliveroo.ts — these are what the rest of the project consumes.

export type Role = 'liaison' | 'courier'

export type Pos = { x: number; y: number }

export type TileType =
  | 'wall' // '0'
  | 'spawner' // '1' parcel spawner
  | 'delivery' // '2'
  | 'base' // '4'
  | 'walkable' // '3'
  | 'slide' // '5' crate sliding tile
  | 'crateSpawner' // '5!'
  | 'oneway' // '←' '↑' '→' '↓' (direction in `dir`)

export interface Tile {
  pos: Pos
  type: TileType
  dir?: 'up' | 'down' | 'left' | 'right'
}

export interface ParcelObs {
  id: string
  pos: Pos
  reward: number
  carriedBy: string | null
}

export interface AgentObs {
  id: string
  name: string
  teamId: string
  pos: Pos
  score: number
}

export interface CrateObs {
  id: string
  pos: Pos
}

export interface SelfObs {
  id: string
  name: string
  teamId: string
  pos: Pos
  score: number
}

// Action result. The SDK's emitPickup/emitPutdown resolve to { id }[] only — no
// pos/reward/carriedBy. The stateless wrapper passes these through verbatim; the
// BDI belief base holds the full ParcelObs and looks up by id.
export interface PickResult {
  id: string
}

export interface GameConsts {
  CLOCK: number // ms per frame (IOConfig.CLOCK), default 50
  MOVEMENT_DURATION: number // GAME.player.movement_duration, default 50
  OBS_DISTANCE: number // GAME.player.observation_distance, default 5
  PARCEL_DECAY_TICKS: number // decaying_event parsed to ticks; Infinity if 'infinite'
  PARCEL_DECAY_RAW: string // raw decaying_event ('1s' | '2s' | ... | 'infinite')
  PENALTY: number // IOConfig.PENALTY
}

export interface PerceptionSnapshot {
  tick: number
  self: SelfObs
  parcels: ParcelObs[]
  agents: AgentObs[]
  crates: CrateObs[]
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `bun x tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors). If `tsc` is unavailable, run `bun build src/types/perception.ts --target=bun > /dev/null` instead; expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/types/perception.ts
git commit -m "feat(types): add perception domain types for client wrapper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Ambient SDK type stub (`src/external/deliveroo-sdk.d.ts`)

Hand-written declaration so `deliveroo.ts` imports the SDK with full types and zero `any`. Covers only the surface we use.

**Files:**
- Create: `src/external/deliveroo-sdk.d.ts`

- [ ] **Step 1: Write the ambient module declaration**

```ts
// src/external/deliveroo-sdk.d.ts
// Minimal ambient types for @unitn-asa/deliveroo-js-sdk (JSDoc-only, no .d.ts shipped).
// Declares ONLY the surface src/external/deliveroo.ts uses. Verified against
// node_modules/@unitn-asa/deliveroo-js-sdk/src.

declare module '@unitn-asa/deliveroo-js-sdk' {
  export type IOTileType =
    | '0'
    | '1'
    | '2'
    | '3'
    | '4'
    | '5'
    | '5!'
    | '←'
    | '↑'
    | '→'
    | '↓'

  export interface IOTile {
    x: number
    y: number
    type: IOTileType
  }

  export interface IOParcel {
    id: string
    x: number
    y: number
    carriedBy?: string
    reward: number
  }

  export interface IOAgent {
    id: string
    name: string
    teamId: string
    teamName: string
    x?: number
    y?: number
    score: number
    penalty: number
  }

  export interface IOCrate {
    id: string
    x: number
    y: number
  }

  export interface IOSensing {
    positions: { x: number; y: number }[]
    agents: IOAgent[]
    parcels: IOParcel[]
    crates: IOCrate[]
  }

  export interface IOPlayerOptions {
    movement_duration: number
    observation_distance: number
  }

  export interface IOParcelsOptions {
    decaying_event: string
    generation_event: string
  }

  export interface IOGameOptions {
    player: IOPlayerOptions
    parcels: IOParcelsOptions
  }

  export interface IOConfig {
    CLOCK: number
    PENALTY: number
    AGENT_TIMEOUT: number
    BROADCAST_LOGS: boolean
    GAME: IOGameOptions
  }

  export interface IOPing {
    frame: number
    roundTrip: number
  }

  export interface DjsClientSocket {
    // one-shot promise getters
    readonly me: Promise<IOAgent>
    readonly config: Promise<IOConfig>
    readonly map: Promise<{ width: number; height: number; tiles: IOTile[] }>
    readonly token: Promise<string>

    // repeating listeners
    onConnect(cb: () => void): void
    onDisconnect(cb: (reason: string) => void): void
    onYou(cb: (me: IOAgent) => void): void
    onSensing(cb: (sensing: IOSensing) => void): void
    onMsg(
      cb: (id: string, name: string, msg: unknown, reply: (ack: unknown) => void) => void,
    ): void

    // raw socket.io passthrough (used for the `ping` event)
    on(event: 'ping', cb: (data: IOPing, ack: () => void) => void): void
    on(event: string, cb: (...args: unknown[]) => void): void

    // async actions
    emitMove(dir: 'up' | 'right' | 'left' | 'down'): Promise<{ x: number; y: number } | false>
    emitPickup(): Promise<{ id: string }[]>
    emitPutdown(selected?: string[]): Promise<{ id: string }[]>
    emitSay(toId: string, msg: unknown): Promise<'successful' | 'failed'>
    emitAsk(toId: string, msg: unknown): Promise<unknown>
    emitShout(msg: unknown): Promise<unknown>

    // lifecycle
    disconnect(): DjsClientSocket
  }

  export function DjsConnect(
    host?: string,
    token?: string,
    name?: string,
    autoconnect?: boolean,
  ): DjsClientSocket
}
```

- [ ] **Step 2: Verify the stub type-checks and resolves the import**

Create a one-line scratch check, run it, then delete it:

```bash
printf "import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk'\nconst _f: typeof DjsConnect = DjsConnect\nexport {}\n" > /tmp/sdk-check.ts
bun x tsc --noEmit /tmp/sdk-check.ts 2>&1 | grep -v 'sdk-check' || echo "STUB OK"
rm -f /tmp/sdk-check.ts
```

Expected: prints `STUB OK` (the import resolves to the ambient module with no `any`).

> Note: the scratch file lives in `/tmp` so it is outside `tsconfig.json`'s `include`. If `tsc` cannot see the ambient `.d.ts` from `/tmp`, instead verify in Task 5 when `deliveroo.ts` imports the SDK for real. Either path is fine; do not block on this step.

- [ ] **Step 3: Commit**

```bash
git add src/external/deliveroo-sdk.d.ts
git commit -m "feat(external): add ambient type stub for deliveroo-js-sdk

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `parseDecayEvent` + `buildConsts` (pure, TDD)

Mechanical clock-event-string → ticks parse, and assembly of `GameConsts` from `IOConfig`. No socket.

**Files:**
- Create: `src/external/deliveroo.ts` (start the file with these two pure functions + imports)
- Test: `tests/deliveroo-consts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/deliveroo-consts.test.ts
import { test, expect } from 'bun:test'
import { parseDecayEvent, buildConsts } from '../src/external/deliveroo.js'
import type { IOConfig } from '@unitn-asa/deliveroo-js-sdk'

test('parseDecayEvent maps clock-event strings to ticks at CLOCK=50', () => {
  expect(parseDecayEvent('1s', 50)).toBe(20)
  expect(parseDecayEvent('2s', 50)).toBe(40)
  expect(parseDecayEvent('5s', 50)).toBe(100)
  expect(parseDecayEvent('10s', 50)).toBe(200)
  expect(parseDecayEvent('1m', 50)).toBe(1200)
  expect(parseDecayEvent('1h', 50)).toBe(72000)
})

test('parseDecayEvent: infinite -> Infinity', () => {
  expect(parseDecayEvent('infinite', 50)).toBe(Infinity)
})

test('parseDecayEvent: unknown string falls back to 1s equivalent', () => {
  expect(parseDecayEvent('frame', 50)).toBe(20) // '1s' fallback at CLOCK=50
  expect(parseDecayEvent('banana', 50)).toBe(20)
})

test('buildConsts assembles GameConsts from IOConfig', () => {
  const io: IOConfig = {
    CLOCK: 50,
    PENALTY: 1,
    AGENT_TIMEOUT: 10000,
    BROADCAST_LOGS: false,
    GAME: {
      player: { movement_duration: 50, observation_distance: 5 },
      parcels: { decaying_event: '1s', generation_event: '2s' },
    },
  }
  const consts = buildConsts(io)
  expect(consts).toEqual({
    CLOCK: 50,
    MOVEMENT_DURATION: 50,
    OBS_DISTANCE: 5,
    PARCEL_DECAY_TICKS: 20,
    PARCEL_DECAY_RAW: '1s',
    PENALTY: 1,
  })
})

test('buildConsts: infinite decay yields Infinity ticks, raw preserved', () => {
  const io: IOConfig = {
    CLOCK: 50,
    PENALTY: 1,
    AGENT_TIMEOUT: 10000,
    BROADCAST_LOGS: false,
    GAME: {
      player: { movement_duration: 50, observation_distance: 5 },
      parcels: { decaying_event: 'infinite', generation_event: '2s' },
    },
  }
  const consts = buildConsts(io)
  expect(consts.PARCEL_DECAY_TICKS).toBe(Infinity)
  expect(consts.PARCEL_DECAY_RAW).toBe('infinite')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/deliveroo-consts.test.ts`
Expected: FAIL — `parseDecayEvent`/`buildConsts` not exported (module has no such export / cannot find module).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/external/deliveroo.ts
import type { IOConfig } from '@unitn-asa/deliveroo-js-sdk'
import type { GameConsts } from '../types/perception.js'

const EVENT_MS: Record<string, number> = {
  '1s': 1000,
  '2s': 2000,
  '5s': 5000,
  '10s': 10000,
  '1m': 60000,
  '1h': 3600000,
}

/**
 * Convert a clock-event decay string to ticks-per-1-point-decay.
 * 'infinite' -> Infinity (no decay). Unknown string -> '1s' equivalent
 * (matches the SDK's parseClockEvent fallback). Mechanical only; utility.ts
 * owns the rate formulas (ρ/λ).
 */
export function parseDecayEvent(ev: string, clockMs: number): number {
  if (ev === 'infinite') return Infinity
  const ms = EVENT_MS[ev]
  if (ms === undefined) return EVENT_MS['1s'] / clockMs
  return ms / clockMs
}

/** Assemble immutable GameConsts from the SDK IOConfig. */
export function buildConsts(io: IOConfig): GameConsts {
  const raw = io.GAME.parcels.decaying_event
  return {
    CLOCK: io.CLOCK,
    MOVEMENT_DURATION: io.GAME.player.movement_duration,
    OBS_DISTANCE: io.GAME.player.observation_distance,
    PARCEL_DECAY_TICKS: parseDecayEvent(raw, io.CLOCK),
    PARCEL_DECAY_RAW: raw,
    PENALTY: io.PENALTY,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/deliveroo-consts.test.ts`
Expected: PASS (6 tests across the 4 `test()` blocks pass).

- [ ] **Step 5: Commit**

```bash
git add src/external/deliveroo.ts tests/deliveroo-consts.test.ts
git commit -m "feat(external): add decay-event parse and GameConsts builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `tickFrom` (pure tick interpolation, TDD)

Server-authoritative tick via anchor + wall-time interpolation.

**Files:**
- Modify: `src/external/deliveroo.ts` (append `tickFrom`)
- Test: `tests/deliveroo-tick.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/deliveroo-tick.test.ts
import { test, expect } from 'bun:test'
import { tickFrom } from '../src/external/deliveroo.js'

test('tickFrom returns the anchor frame when no time has elapsed', () => {
  expect(tickFrom(100, 1000, 1000, 50)).toBe(100)
})

test('tickFrom adds floor(elapsed / clock) frames', () => {
  // 500 ms elapsed at 50 ms/frame = 10 frames
  expect(tickFrom(100, 1000, 1500, 50)).toBe(110)
})

test('tickFrom floors a partial frame', () => {
  // 70 ms elapsed = 1.4 frames -> floor 1
  expect(tickFrom(100, 1000, 1070, 50)).toBe(101)
})

test('tickFrom handles the exact frame boundary', () => {
  // 50 ms elapsed = exactly 1 frame
  expect(tickFrom(0, 0, 50, 50)).toBe(1)
})

test('tickFrom pre-first-ping case: anchorFrame 0 grows from connect time', () => {
  // before first ping, anchorFrame=0, anchorWallMs=connect time
  expect(tickFrom(0, 2000, 2200, 50)).toBe(4) // 200ms / 50 = 4
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/deliveroo-tick.test.ts`
Expected: FAIL — `tickFrom` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/external/deliveroo.ts`:

```ts
/**
 * Server-authoritative tick. Anchored to the most recent server frame (delivered
 * via the 1 Hz `ping` event) and interpolated with wall-clock time so it has
 * per-tick resolution between pings. Both agents re-anchor to the same server
 * frame, keeping their ticks cross-comparable (DESIGN §2.3, §6).
 */
export function tickFrom(
  anchorFrame: number,
  anchorWallMs: number,
  nowMs: number,
  clockMs: number,
): number {
  return anchorFrame + Math.floor((nowMs - anchorWallMs) / clockMs)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/deliveroo-tick.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/external/deliveroo.ts tests/deliveroo-tick.test.ts
git commit -m "feat(external): add anchor+interpolate tick clock

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `normalizeTile` (pure, TDD)

Map each `IOTileType` char to a domain `Tile`. Unknown char → `wall` + warn.

**Files:**
- Modify: `src/external/deliveroo.ts` (append `normalizeTile` + a `LoggerLike` minimal type)
- Test: `tests/deliveroo-normalize.test.ts` (created here; extended in Task 6)

- [ ] **Step 1: Write the failing test**

```ts
// tests/deliveroo-normalize.test.ts
import { test, expect } from 'bun:test'
import { normalizeTile } from '../src/external/deliveroo.js'
import type { IOTile } from '@unitn-asa/deliveroo-js-sdk'

// minimal logger spy capturing warn calls
function spyLogger() {
  const warns: unknown[][] = []
  return {
    logger: {
      warn: (...args: unknown[]) => {
        warns.push(args)
      },
      info: () => {},
      debug: () => {},
    },
    warns,
  }
}

test('normalizeTile maps basic tile types', () => {
  const { logger } = spyLogger()
  expect(normalizeTile({ x: 1, y: 2, type: '0' }, logger)).toEqual({
    pos: { x: 1, y: 2 },
    type: 'wall',
  })
  expect(normalizeTile({ x: 0, y: 0, type: '1' }, logger).type).toBe('spawner')
  expect(normalizeTile({ x: 0, y: 0, type: '2' }, logger).type).toBe('delivery')
  expect(normalizeTile({ x: 0, y: 0, type: '3' }, logger).type).toBe('walkable')
  expect(normalizeTile({ x: 0, y: 0, type: '4' }, logger).type).toBe('base')
  expect(normalizeTile({ x: 0, y: 0, type: '5' }, logger).type).toBe('slide')
  expect(normalizeTile({ x: 0, y: 0, type: '5!' }, logger).type).toBe('crateSpawner')
})

test('normalizeTile maps directional arrows to oneway with dir', () => {
  const { logger } = spyLogger()
  expect(normalizeTile({ x: 0, y: 0, type: '↑' }, logger)).toEqual({
    pos: { x: 0, y: 0 },
    type: 'oneway',
    dir: 'up',
  })
  expect(normalizeTile({ x: 0, y: 0, type: '↓' }, logger).dir).toBe('down')
  expect(normalizeTile({ x: 0, y: 0, type: '←' }, logger).dir).toBe('left')
  expect(normalizeTile({ x: 0, y: 0, type: '→' }, logger).dir).toBe('right')
})

test('normalizeTile: unknown char -> wall + warn', () => {
  const { logger, warns } = spyLogger()
  // force an invalid type past the type system
  const bad = { x: 3, y: 4, type: '9' } as unknown as IOTile
  const tile = normalizeTile(bad, logger)
  expect(tile).toEqual({ pos: { x: 3, y: 4 }, type: 'wall' })
  expect(warns.length).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/deliveroo-normalize.test.ts`
Expected: FAIL — `normalizeTile` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/external/deliveroo.ts`. Add the `IOTile`, `IOTileType` imports to the existing top-of-file `import type` from the SDK, and a minimal logger interface so the pure functions don't depend on pino directly.

```ts
// add to the SDK import at the top of the file:
//   import type { IOConfig, IOTile, IOTileType } from '@unitn-asa/deliveroo-js-sdk'
// add to the perception import at the top of the file:
//   import type { GameConsts, Tile } from '../types/perception.js'

/** The slice of a pino Logger the pure functions need. */
export interface LoggerLike {
  warn: (obj: Record<string, unknown> | string, msg?: string) => void
  info: (obj: Record<string, unknown> | string, msg?: string) => void
  debug: (obj: Record<string, unknown> | string, msg?: string) => void
}

const ARROW_DIR: Record<string, Tile['dir']> = {
  '↑': 'up',
  '↓': 'down',
  '←': 'left',
  '→': 'right',
}

/**
 * Map an SDK tile to a domain Tile. Unknown type chars become `wall` (safe by
 * default: a wall blocks pathing and can never trigger an unsafe crate push;
 * DESIGN §15 re-checks admissibility against live state anyway).
 */
export function normalizeTile(io: IOTile, logger: LoggerLike): Tile {
  const pos = { x: io.x, y: io.y }
  switch (io.type) {
    case '0':
      return { pos, type: 'wall' }
    case '1':
      return { pos, type: 'spawner' }
    case '2':
      return { pos, type: 'delivery' }
    case '3':
      return { pos, type: 'walkable' }
    case '4':
      return { pos, type: 'base' }
    case '5':
      return { pos, type: 'slide' }
    case '5!':
      return { pos, type: 'crateSpawner' }
    case '↑':
    case '↓':
    case '←':
    case '→':
      return { pos, type: 'oneway', dir: ARROW_DIR[io.type] }
    default: {
      logger.warn({ type: io.type, pos }, 'unknown tile type, defaulting to wall')
      return { pos, type: 'wall' }
    }
  }
}
```

> Implementation note: the `switch` is exhaustive over `IOTileType`, so the `default` branch is only reachable when malformed data slips past the types at runtime — exactly the trust-boundary case. Do not delete the `default` for "unreachable code"; it is the safety net.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/deliveroo-normalize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/external/deliveroo.ts tests/deliveroo-normalize.test.ts
git commit -m "feat(external): add tile normalizer with safe-default-to-wall

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `normalizeSensing` (pure, TDD)

Map `IOSensing` + latest `you` + current tick → `PerceptionSnapshot`. Drop agents with no position; `carriedBy` `undefined`→`null`; drop malformed records.

**Files:**
- Modify: `src/external/deliveroo.ts` (append `normalizeSensing`)
- Test: `tests/deliveroo-normalize.test.ts` (extend)

- [ ] **Step 1: Write the failing test (append to the existing normalize test file)**

```ts
// append to tests/deliveroo-normalize.test.ts
import { normalizeSensing } from '../src/external/deliveroo.js'
import type { IOSensing, IOAgent } from '@unitn-asa/deliveroo-js-sdk'

const selfMe: IOAgent = {
  id: 'self1',
  name: 'Courier',
  teamId: 'team1',
  teamName: 'Team One',
  x: 5,
  y: 5,
  score: 42,
  penalty: 0,
}

test('normalizeSensing builds a snapshot with self, parcels, agents, crates', () => {
  const { logger } = spyLogger()
  const io: IOSensing = {
    positions: [],
    agents: [
      {
        id: 'a2',
        name: 'Other',
        teamId: 'team2',
        teamName: 'Team Two',
        x: 1,
        y: 1,
        score: 3,
        penalty: 0,
      },
    ],
    parcels: [
      { id: 'p1', x: 2, y: 3, reward: 10 }, // carriedBy undefined
      { id: 'p2', x: 4, y: 4, reward: 5, carriedBy: 'self1' },
    ],
    crates: [{ id: 'c1', x: 7, y: 8 }],
  }
  const snap = normalizeSensing(io, selfMe, 123, logger)
  expect(snap.tick).toBe(123)
  expect(snap.self).toEqual({
    id: 'self1',
    name: 'Courier',
    teamId: 'team1',
    pos: { x: 5, y: 5 },
    score: 42,
  })
  expect(snap.parcels).toEqual([
    { id: 'p1', pos: { x: 2, y: 3 }, reward: 10, carriedBy: null },
    { id: 'p2', pos: { x: 4, y: 4 }, reward: 5, carriedBy: 'self1' },
  ])
  expect(snap.agents).toEqual([
    { id: 'a2', name: 'Other', teamId: 'team2', pos: { x: 1, y: 1 }, score: 3 },
  ])
  expect(snap.crates).toEqual([{ id: 'c1', pos: { x: 7, y: 8 } }])
})

test('normalizeSensing drops agents with no position (out of view)', () => {
  const { logger } = spyLogger()
  const io: IOSensing = {
    positions: [],
    agents: [
      { id: 'ghost', name: 'NoPos', teamId: 't', teamName: 'T', score: 0, penalty: 0 },
    ],
    parcels: [],
    crates: [],
  }
  const snap = normalizeSensing(io, selfMe, 1, logger)
  expect(snap.agents).toEqual([])
})

test('normalizeSensing drops a malformed parcel record but keeps the rest', () => {
  const { logger, warns } = spyLogger()
  const io = {
    positions: [],
    agents: [],
    parcels: [
      { id: 'good', x: 1, y: 1, reward: 5 },
      { x: 2, y: 2, reward: 5 }, // missing id
    ],
    crates: [],
  } as unknown as IOSensing
  const snap = normalizeSensing(io, selfMe, 1, logger)
  expect(snap.parcels).toEqual([
    { id: 'good', pos: { x: 1, y: 1 }, reward: 5, carriedBy: null },
  ])
  expect(warns.length).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/deliveroo-normalize.test.ts`
Expected: FAIL — `normalizeSensing` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/external/deliveroo.ts` (extend the perception import to include the rest of the domain types):

```ts
// extend the perception import at the top of the file to:
//   import type {
//     GameConsts, Tile, ParcelObs, AgentObs, CrateObs, SelfObs, PerceptionSnapshot,
//   } from '../types/perception.js'
// extend the SDK import to include the sensing shapes:
//   import type {
//     IOConfig, IOTile, IOTileType, IOSensing, IOAgent, IOParcel, IOCrate,
//   } from '@unitn-asa/deliveroo-js-sdk'

function hasPos(e: { x?: number; y?: number }): e is { x: number; y: number } {
  return typeof e.x === 'number' && typeof e.y === 'number'
}

/**
 * Map an SDK sensing event to a domain PerceptionSnapshot. `me` is the latest
 * `you` payload (own position; sensing does not report self). Trust boundary:
 * entities missing id/coords are dropped (with a warn) rather than emitted
 * malformed; agents out of view (no x/y) are dropped silently — that is the
 * normal "not visible" case, not an error.
 */
export function normalizeSensing(
  io: IOSensing,
  me: IOAgent,
  tick: number,
  logger: LoggerLike,
): PerceptionSnapshot {
  const self: SelfObs = {
    id: me.id,
    name: me.name,
    teamId: me.teamId,
    pos: { x: me.x ?? 0, y: me.y ?? 0 },
    score: me.score,
  }

  const parcels: ParcelObs[] = []
  for (const p of io.parcels) {
    if (!p.id || !hasPos(p)) {
      logger.warn({ record: 'parcel' }, 'dropping malformed parcel record')
      continue
    }
    parcels.push({
      id: p.id,
      pos: { x: p.x, y: p.y },
      reward: p.reward,
      carriedBy: p.carriedBy ?? null,
    })
  }

  const agents: AgentObs[] = []
  for (const a of io.agents) {
    if (!a.id) {
      logger.warn({ record: 'agent' }, 'dropping malformed agent record')
      continue
    }
    if (!hasPos(a)) continue // out of view — normal, drop silently
    agents.push({
      id: a.id,
      name: a.name,
      teamId: a.teamId,
      pos: { x: a.x, y: a.y },
      score: a.score,
    })
  }

  const crates: CrateObs[] = []
  for (const c of io.crates) {
    if (!c.id || !hasPos(c)) {
      logger.warn({ record: 'crate' }, 'dropping malformed crate record')
      continue
    }
    crates.push({ id: c.id, pos: { x: c.x, y: c.y } })
  }

  return { tick, self, parcels, agents, crates }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/deliveroo-normalize.test.ts`
Expected: PASS (6 tests total in this file now).

- [ ] **Step 5: Commit**

```bash
git add src/external/deliveroo.ts tests/deliveroo-normalize.test.ts
git commit -m "feat(external): add sensing normalizer with trust-boundary drops

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `connect()` factory + `DeliverooClient` (imperative shell)

Wire the SDK socket to the pure functions and return the client. Role-gate the mission channel. This is the imperative shell — it has no branching logic worth unit-testing beyond what Task 8's fake-socket test covers.

**Files:**
- Modify: `src/external/deliveroo.ts` (add imports for `DjsConnect`, `Role`, `PickResult`, `Pos`; add `connect`)

- [ ] **Step 1: Add the `connect` factory**

Append to `src/external/deliveroo.ts`. Extend the top imports:

```ts
// top of file — value import (not type) for the factory function:
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk'
import type { DjsClientSocket } from '@unitn-asa/deliveroo-js-sdk'
// extend perception type import to add: Pos, PickResult, Role
// (full perception import becomes: GameConsts, Tile, ParcelObs, AgentObs,
//  CrateObs, SelfObs, PerceptionSnapshot, Pos, PickResult, Role)
import type { Config } from '../types/config.js'
```

```ts
export interface DeliverooClient {
  readonly role: Role
  readonly consts: GameConsts
  readonly map: Tile[]
  tick(): number

  onPerception(cb: (s: PerceptionSnapshot) => void): void
  onConnect(cb: () => void): void
  onDisconnect(cb: (reason: string) => void): void

  move(dir: 'up' | 'down' | 'left' | 'right'): Promise<Pos | false>
  pickup(): Promise<PickResult[]>
  putdown(ids?: string[]): Promise<PickResult[]>

  onMissionMsg(cb: (from: string, name: string, msg: unknown) => void): void
  say(toId: string, msg: unknown): Promise<'successful' | 'failed'>
  ask(toId: string, msg: unknown): Promise<unknown>
  shout(msg: unknown): Promise<unknown>

  close(): void
}

function missionOnly(): never {
  throw new Error('mission channel: liaison only')
}

/**
 * Connect to the Deliveroo server and return a typed, role-aware client.
 * Awaits the SDK one-shot promises (me/config/map) so the returned client is
 * fully initialized: self id, GameConsts, and tile map are all present.
 */
export async function connect(
  config: Config,
  role: Role,
  logger: LoggerLike,
): Promise<DeliverooClient> {
  const token = role === 'liaison' ? config.TOKEN_LIAISON : config.TOKEN_COURIER
  const host = `${config.DELIVEROO_HOST}:${config.DELIVEROO_PORT}`
  const socket: DjsClientSocket = DjsConnect(host, token, '', true)

  // await startup one-shots
  const [me0, ioConfig, mapResult] = await Promise.all([socket.me, socket.config, socket.map])
  const consts = buildConsts(ioConfig)
  const map = mapResult.tiles.map((t) => normalizeTile(t, logger))

  // transient transport bookkeeping (not a belief cache): latest self position
  let me = me0
  socket.onYou((m) => {
    me = m
  })

  // tick anchor
  let anchorFrame = 0
  let anchorWallMs = Date.now()
  socket.on('ping', (data) => {
    anchorFrame = data.frame
    anchorWallMs = Date.now()
  })
  const tick = (): number => tickFrom(anchorFrame, anchorWallMs, Date.now(), consts.CLOCK)

  // perception
  let perceptionCb: ((s: PerceptionSnapshot) => void) | null = null
  socket.onSensing((io) => {
    if (!perceptionCb) return
    perceptionCb(normalizeSensing(io, me, tick(), logger))
  })

  // lifecycle
  socket.onConnect(() => logger.info({ role }, 'connected'))
  socket.onDisconnect((reason) => logger.info({ role, reason }, 'disconnected'))

  // mission channel is wired inline in the returned object below, and ONLY for
  // liaison — courier never calls socket.onMsg (see the role ternaries).

  return {
    role,
    consts,
    map,
    tick,

    onPerception: (cb) => {
      perceptionCb = cb
    },
    onConnect: (cb) => socket.onConnect(cb),
    onDisconnect: (cb) => socket.onDisconnect(cb),

    move: (dir) => socket.emitMove(dir),
    pickup: () => socket.emitPickup(),
    putdown: (ids) => socket.emitPutdown(ids),

    onMissionMsg:
      role === 'liaison'
        ? (cb) => socket.onMsg((id, name, msg) => cb(id, name, msg))
        : missionOnly,
    say: role === 'liaison' ? (toId, msg) => socket.emitSay(toId, msg) : missionOnly,
    ask: role === 'liaison' ? (toId, msg) => socket.emitAsk(toId, msg) : missionOnly,
    shout: role === 'liaison' ? (msg) => socket.emitShout(msg) : missionOnly,

    close: () => {
      socket.disconnect()
      logger.info({ role }, 'client closed')
    },
  }
}
```

- [ ] **Step 2: Verify the whole file type-checks**

Run: `bun build src/external/deliveroo.ts --target=bun > /dev/null && echo TYPECHECK_OK`
Expected: prints `TYPECHECK_OK` with no type errors. Fix any `any`/missing-import errors before continuing.

- [ ] **Step 3: Run the full pure-function suite (regression)**

Run: `bun test tests/deliveroo-consts.test.ts tests/deliveroo-tick.test.ts tests/deliveroo-normalize.test.ts`
Expected: PASS — all pure-function tests still green.

- [ ] **Step 4: Commit**

```bash
git add src/external/deliveroo.ts
git commit -m "feat(external): add connect factory with role-gated mission channel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Fake-socket end-to-end test of `connect()`

Drive `connect()` with a hand-built fake socket: resolve the one-shots, fire a `sensing`, assert `onPerception` gets a correctly-shaped, correctly-ticked snapshot. Assert courier role-gating throws. No live server.

**Files:**
- Test: `tests/deliveroo-connect.test.ts`
- Modify (only if needed): `src/external/deliveroo.ts` — extract the socket-building line so a fake can be injected (see Step 1 note).

- [ ] **Step 1: Decide injection seam**

`connect()` calls `DjsConnect(...)` directly. To test it without a live server, add an optional last parameter that defaults to the real `DjsConnect`:

Modify the `connect` signature in `src/external/deliveroo.ts`:

```ts
export async function connect(
  config: Config,
  role: Role,
  logger: LoggerLike,
  connectFn: typeof DjsConnect = DjsConnect,
): Promise<DeliverooClient> {
  // ...
  const socket: DjsClientSocket = connectFn(host, token, '', true)
  // ... rest unchanged
}
```

This keeps production callers unchanged (they pass three args) while tests inject a fake. Re-run `bun build src/external/deliveroo.ts --target=bun > /dev/null && echo OK` — expected `OK`.

- [ ] **Step 2: Write the fake-socket test**

```ts
// tests/deliveroo-connect.test.ts
import { test, expect } from 'bun:test'
import { connect } from '../src/external/deliveroo.js'
import type {
  DjsClientSocket,
  IOAgent,
  IOConfig,
  IOTile,
  IOSensing,
  IOPing,
} from '@unitn-asa/deliveroo-js-sdk'
import type { Config } from '../src/types/config.js'
import type { PerceptionSnapshot } from '../src/types/perception.js'

const noopLogger = {
  warn: () => {},
  info: () => {},
  debug: () => {},
}

const fakeConfig: Config = {
  DELIVEROO_HOST: 'http://localhost',
  DELIVEROO_PORT: 8080,
  TOKEN_LIAISON: 'L',
  TOKEN_COURIER: 'C',
  LITELLM_MODEL: 'm',
  LITELLM_API_KEY: 'k',
  LITELLM_BASE_URL: '',
  LOG_LEVEL: 'info',
  LOG_DIR: './logs',
}

const me: IOAgent = {
  id: 'self', name: 'Me', teamId: 't1', teamName: 'T1', x: 0, y: 0, score: 0, penalty: 0,
}
const ioConfig: IOConfig = {
  CLOCK: 50, PENALTY: 1, AGENT_TIMEOUT: 10000, BROADCAST_LOGS: false,
  GAME: {
    player: { movement_duration: 50, observation_distance: 5 },
    parcels: { decaying_event: '1s', generation_event: '2s' },
  },
}
const tiles: IOTile[] = [
  { x: 0, y: 0, type: '3' },
  { x: 1, y: 0, type: '2' },
  { x: 2, y: 0, type: '↑' },
]

/** Build a fake DjsClientSocket with manual event triggers. */
function makeFakeSocket() {
  let sensingCb: ((io: IOSensing) => void) | null = null
  let youCb: ((m: IOAgent) => void) | null = null
  let pingCb: ((d: IOPing, ack: () => void) => void) | null = null
  const socket = {
    me: Promise.resolve(me),
    config: Promise.resolve(ioConfig),
    map: Promise.resolve({ width: 3, height: 1, tiles }),
    token: Promise.resolve('tok'),
    onConnect: () => {},
    onDisconnect: () => {},
    onYou: (cb: (m: IOAgent) => void) => {
      youCb = cb
    },
    onSensing: (cb: (io: IOSensing) => void) => {
      sensingCb = cb
    },
    onMsg: () => {},
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'ping') pingCb = cb as (d: IOPing, ack: () => void) => void
    },
    emitMove: async () => ({ x: 1, y: 0 }),
    emitPickup: async () => [{ id: 'p1' }],
    emitPutdown: async () => [{ id: 'p1' }],
    emitSay: async () => 'successful' as const,
    emitAsk: async () => ({}),
    emitShout: async () => ({}),
    disconnect: () => socket,
  }
  return {
    socket: socket as unknown as DjsClientSocket,
    fire: {
      sensing: (io: IOSensing) => sensingCb?.(io),
      you: (m: IOAgent) => youCb?.(m),
      ping: (d: IOPing) => pingCb?.(d, () => {}),
    },
  }
}

test('connect resolves a fully-initialized client (consts + map)', async () => {
  const { socket } = makeFakeSocket()
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)
  expect(client.role).toBe('courier')
  expect(client.consts.PARCEL_DECAY_TICKS).toBe(20)
  expect(client.map).toHaveLength(3)
  expect(client.map[1].type).toBe('delivery')
  expect(client.map[2]).toEqual({ pos: { x: 2, y: 0 }, type: 'oneway', dir: 'up' })
})

test('connect emits a correctly-ticked snapshot on sensing', async () => {
  const { socket, fire } = makeFakeSocket()
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)

  let got: PerceptionSnapshot | null = null
  client.onPerception((s) => {
    got = s
  })

  fire.ping({ frame: 100, roundTrip: 10 })
  fire.sensing({
    positions: [],
    agents: [],
    parcels: [{ id: 'p1', x: 1, y: 1, reward: 9 }],
    crates: [],
  })

  expect(got).not.toBeNull()
  expect(got!.self.id).toBe('self')
  expect(got!.parcels).toEqual([
    { id: 'p1', pos: { x: 1, y: 1 }, reward: 9, carriedBy: null },
  ])
  // tick anchored at frame 100, ~0ms elapsed -> 100 (allow +1 for slow CI)
  expect(got!.tick).toBeGreaterThanOrEqual(100)
  expect(got!.tick).toBeLessThanOrEqual(101)
})

test('snapshot self position tracks the latest you event', async () => {
  const { socket, fire } = makeFakeSocket()
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)
  let got: PerceptionSnapshot | null = null
  client.onPerception((s) => {
    got = s
  })

  fire.you({ ...me, x: 4, y: 7 })
  fire.sensing({ positions: [], agents: [], parcels: [], crates: [] })

  expect(got!.self.pos).toEqual({ x: 4, y: 7 })
})

test('courier role-gates the mission channel', async () => {
  const { socket } = makeFakeSocket()
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)
  expect(() => client.onMissionMsg(() => {})).toThrow('mission channel: liaison only')
  await expect(client.say('x', 'hi')).rejects.toThrow('mission channel: liaison only')
  await expect(client.ask('x', 'hi')).rejects.toThrow('mission channel: liaison only')
  await expect(client.shout('hi')).rejects.toThrow('mission channel: liaison only')
})

test('liaison can use the mission channel', async () => {
  const { socket } = makeFakeSocket()
  const client = await connect(fakeConfig, 'liaison', noopLogger, () => socket)
  expect(await client.say('x', 'hi')).toBe('successful')
})
```

> Note on the `say`/`ask`/`shout` rejection assertions: `missionOnly()` throws synchronously, but because these client methods are declared to return Promises, calling the throwing function inside an `async`-typed position still surfaces as a rejected promise to `await expect(...).rejects`. If the implementer wired `say` as a direct reference to `missionOnly` (a sync throw), wrap the assertion with `expect(() => client.say(...)).toThrow(...)` instead. Either is acceptable — pick the one matching the implementation and keep it consistent.

- [ ] **Step 3: Run the test to verify it passes**

Run: `bun test tests/deliveroo-connect.test.ts`
Expected: PASS (5 tests). If the role-gating async assertion fails because `missionOnly` throws synchronously, switch those three assertions to the sync `toThrow` form per the note above, then re-run.

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS — all wrapper tests plus the pre-existing `config`/`logger`/`relay` tests.

- [ ] **Step 5: Commit**

```bash
git add tests/deliveroo-connect.test.ts src/external/deliveroo.ts
git commit -m "test(external): add fake-socket end-to-end test for connect

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Final verification + open PR

The wrapper touches no BDI/blackboard/utility/mission code, but it IS a new feature module → PR required (CLAUDE.md git workflow).

**Files:** none (verification + PR only)

- [ ] **Step 1: Full type-check + test sweep**

Run: `bun build src/external/deliveroo.ts --target=bun > /dev/null && bun test`
Expected: build emits nothing (exit 0); all tests PASS. Capture the test summary line for the PR body.

- [ ] **Step 2: Confirm no `console.log` and no `any` slipped in**

Run: `grep -rn "console.log\|: any\b\| as any" src/external/deliveroo.ts src/types/perception.ts src/external/deliveroo-sdk.d.ts || echo CLEAN`
Expected: prints `CLEAN`.

- [ ] **Step 3: Create the feature branch (if not already on one) and push**

```bash
git rev-parse --abbrev-ref HEAD   # if this prints "main", branch first:
git checkout -b feat/deliveroo-client-wrapper
git push -u origin feat/deliveroo-client-wrapper
```

> If the implementation tasks were done directly on `main`, move them onto a branch before opening the PR — features must not land via direct push (CLAUDE.md).

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat(external): typed role-aware Deliveroo client wrapper" --body "$(cat <<'EOF'
Implements `src/external/deliveroo.ts` per spec
`docs/superpowers/specs/2026-06-13-deliveroo-client-wrapper-design.md`.

## What
- Project-owned perception domain types (`src/types/perception.ts`)
- Ambient SDK type stub (`src/external/deliveroo-sdk.d.ts`) — only the surface we use, no `any`
- Pure normalizers (`normalizeTile`, `normalizeSensing`), decay parse (`parseDecayEvent`/`buildConsts`), and anchor+interpolate tick (`tickFrom`)
- `connect(config, role, logger)` factory returning a role-aware `DeliverooClient`; mission channel role-gated to liaison

## Testing
- Unit tests for every pure function (consts, tick, tile, sensing)
- Fake-socket end-to-end test of `connect()` incl. role gating
- `bun test`: all green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review (completed against the spec)

**1. Spec coverage:**

| Spec section | Plan task |
|---|---|
| §3 domain types (incl. `PickResult`) | Task 1 |
| §2 file layout / ambient `.d.ts` | Task 2 |
| §5 `GameConsts` + `decaying_event` parse | Task 3 |
| §6 tick anchor+interpolate | Task 4 |
| §3 tile mapping incl. unknown→wall | Task 5 |
| §3 sensing normalize, drop rules, `carriedBy`→null | Task 6 |
| §4 `connect` behaviour + role gating | Task 7 |
| §7 lifecycle (you→self, ping→anchor, sensing→emit) | Task 7 |
| §9 unit + fake-socket tests | Tasks 3–8 |
| §8 error handling (warn on drop, move=false passthrough) | Tasks 5,6,7 |

No spec requirement is left without a task.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X". Every code step shows full, final code; every test step shows full assertions. No dead scaffold — the mission channel is wired only via the inline role ternaries in the returned client object.

**3. Type consistency:** Names match across tasks: `parseDecayEvent`, `buildConsts`, `tickFrom`, `normalizeTile`, `normalizeSensing`, `connect`, `DeliverooClient`, `LoggerLike`, `PickResult`, `PerceptionSnapshot`. The `LoggerLike` interface (Task 5) is the logger type used by every pure function and by `connect` (Task 7); the fake-socket test's `noopLogger` satisfies it. `connect`'s injected `connectFn` default (`DjsConnect`) is added in Task 8 and is the only signature change after Task 7 — production callers (3 args) are unaffected.

**Known follow-ups (out of scope for this plan, by spec §1 non-goals):** belief caching, utility ρ/λ, action sequencing, live-server integration. Downstream BDI tasks consume `DeliverooClient` + `PerceptionSnapshot`.
