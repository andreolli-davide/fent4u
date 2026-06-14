# Blackboard Belief-Replication Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/blackboard/blackboard.ts` — the agent-local a2a replication hub that wraps `BeliefBase`, broadcasts belief deltas on material change, services the (re)connect snapshot handshake, heartbeats when silent, and exposes a partner-liveness signal.

**Architecture:** One class `Blackboard` wrapping a `BeliefBase` instance (passed in). It is the **sole** caller of the base's `computeDelta`/`applyDelta`/`computeSnapshot`/`applySnapshot` (single-drainer rule). Transport is an injected `send: (A2AMessage) => void` callback; inbound messages arrive via `receive(A2AMessage)`. All cadence is a pure function of the `onTick(tick)` stream — no real timers. Blackboard traffic rides one a2a channel (`type: 'blackboard'`) carrying a `kind`-discriminated `BlackboardMsg` payload.

**Tech Stack:** Bun + TypeScript (strict, ESM, `.js` import extensions), `bun:test`, Pino (`LoggerLike` slice). Depends on `src/blackboard/beliefs.ts` (`Delta`, `BeliefBase`) and `src/types/a2a.ts` (`AgentId`, `A2AMessage`).

**Spec:** `docs/superpowers/specs/2026-06-14-blackboard-design.md`

---

## File Structure

- **Create `src/blackboard/blackboard.ts`** — everything for v1: the `BlackboardMsg` union, the `isBlackboardMsg` / `isEmptyDelta` helpers, the `LoggerLike` slice, the `HEARTBEAT_INTERVAL_TICKS` / `PARTNER_TTL_TICKS` constants, and the `Blackboard` class.
- **Create `tests/blackboard.test.ts`** — all cases, growing task-by-task. Shared fixtures (a `CONSTS`/`MAP`/`SelfObs` set, a `fakeLogger`, a parcel-perception `snap` helper) defined once in Task 1.

No existing files are modified. `claims` / `mission` / `contract` / `gate` are out of scope (spec §1, deferred to their owning subsystems).

---

## Conventions for every task

- Run a single test file with `bun test tests/blackboard.test.ts`.
- Typecheck with `bunx tsc --noEmit` (strict; no `any`, no `console.log`).
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- The class accumulates across tasks — each task adds the methods its tests need; earlier methods stay. Do not re-stub already-implemented methods.

---

### Task 1: Module scaffolding — types, guards, constants, class skeleton

**Files:**
- Create: `src/blackboard/blackboard.ts`
- Test: `tests/blackboard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/blackboard.test.ts` with the shared fixtures and the Task-1 unit tests:

```ts
// tests/blackboard.test.ts
import { test, expect } from 'bun:test'
import {
  Blackboard,
  isBlackboardMsg,
  isEmptyDelta,
  HEARTBEAT_INTERVAL_TICKS,
  PARTNER_TTL_TICKS,
  type BlackboardMsg,
  type LoggerLike,
} from '../src/blackboard/blackboard.js'
import { BeliefBase, type Delta } from '../src/blackboard/beliefs.js'
import type { GameConsts, Tile, SelfObs } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = {
  CLOCK: 50,
  MOVEMENT_DURATION: 50,
  OBS_DISTANCE: 5,
  PARCEL_DECAY_TICKS: 20,
  PARCEL_DECAY_RAW: '1s',
  PENALTY: 1,
}
const MAP: Tile[] = [{ pos: { x: 5, y: 5 }, type: 'walkable' }]
const SELF_A: SelfObs = { id: 'A', name: 'A', teamId: 'T', pos: { x: 5, y: 5 }, score: 0 }
const SELF_B: SelfObs = { id: 'B', name: 'B', teamId: 'T', pos: { x: 1, y: 1 }, score: 0 }

function fakeLogger(): { log: LoggerLike; debugs: Record<string, unknown>[]; infos: Record<string, unknown>[] } {
  const debugs: Record<string, unknown>[] = []
  const infos: Record<string, unknown>[] = []
  const log: LoggerLike = {
    debug: (o) => debugs.push(typeof o === 'string' ? { msg: o } : o),
    info: (o) => infos.push(typeof o === 'string' ? { msg: o } : o),
  }
  return { log, debugs, infos }
}

const emptyDelta = (): Delta => ({
  tick: 0,
  parcels: { upsert: [], remove: [] },
  agents: { upsert: [] },
  crates: { upsert: [] },
  self: null,
})

test('constants have the spec defaults', () => {
  expect(HEARTBEAT_INTERVAL_TICKS).toBe(1)
  expect(PARTNER_TTL_TICKS).toBe(5)
})

test('isEmptyDelta is true for a blank delta, false when any field is populated', () => {
  expect(isEmptyDelta(emptyDelta())).toBe(true)
  const d = emptyDelta()
  d.parcels.remove.push('p1')
  expect(isEmptyDelta(d)).toBe(false)
  const d2 = emptyDelta()
  d2.self = { id: 'A', name: 'A', teamId: 'T', pos: { x: 0, y: 0 }, score: 0, carrying: [] }
  expect(isEmptyDelta(d2)).toBe(false)
})

test('isBlackboardMsg accepts each kind and rejects malformed payloads', () => {
  expect(isBlackboardMsg({ kind: 'hello', tick: 3 })).toBe(true)
  expect(isBlackboardMsg({ kind: 'heartbeat', tick: 3 })).toBe(true)
  expect(isBlackboardMsg({ kind: 'delta', tick: 3, delta: emptyDelta() })).toBe(true)
  expect(isBlackboardMsg({ kind: 'snapshot', tick: 3, base: emptyDelta() })).toBe(true)
  expect(isBlackboardMsg({ kind: 'delta', tick: 3 })).toBe(false) // missing delta
  expect(isBlackboardMsg({ kind: 'bogus', tick: 3 })).toBe(false)
  expect(isBlackboardMsg({ tick: 3 })).toBe(false)
  expect(isBlackboardMsg(null)).toBe(false)
  expect(isBlackboardMsg('x')).toBe(false)
})

test('partnerAlive is false before any contact', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
  })
  expect(bb.partnerLastSeenTick).toBe(-Infinity)
  expect(bb.partnerAlive(100)).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/blackboard.test.ts`
Expected: FAIL — cannot resolve `../src/blackboard/blackboard.js` / exports missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/blackboard/blackboard.ts`:

```ts
// src/blackboard/blackboard.ts
// Belief-replication hub (DESIGN §2.2 belief half, §2.3.5). Wraps a BeliefBase and
// moves deltas/snapshots between the two agent replicas over the a2a channel. Sole
// caller of the base's computeDelta/applyDelta/computeSnapshot/applySnapshot.
import { BeliefBase, type Delta } from './beliefs.js'
import type { AgentId, A2AMessage } from '../types/a2a.js'

/** Default cadence: ping every silent tick so freshness stays inside GATE_STALE_TTL (~2). */
export const HEARTBEAT_INTERVAL_TICKS = 1
/** Default coarse partner-loss horizon (§11). Looser than the gate's tight threshold. */
export const PARTNER_TTL_TICKS = 5

/** The blackboard sub-protocol carried in A2AMessage.payload on the `type:'blackboard'` channel. */
export type BlackboardMsg =
  | { kind: 'hello'; tick: number }
  | { kind: 'snapshot'; tick: number; base: Delta }
  | { kind: 'delta'; tick: number; delta: Delta }
  | { kind: 'heartbeat'; tick: number }

/** The slice of a pino Logger this module needs. */
export interface LoggerLike {
  debug: (obj: Record<string, unknown> | string, msg?: string) => void
  info: (obj: Record<string, unknown> | string, msg?: string) => void
}

export interface BlackboardOpts {
  self: AgentId
  partner: AgentId
  send: (msg: A2AMessage) => void
  logger: LoggerLike
  heartbeatInterval?: number
  partnerTtl?: number
}

/** True iff a delta carries no observed change (used to decide heartbeat vs broadcast). */
export function isEmptyDelta(d: Delta): boolean {
  return (
    d.parcels.upsert.length === 0 &&
    d.parcels.remove.length === 0 &&
    d.agents.upsert.length === 0 &&
    d.crates.upsert.length === 0 &&
    d.self === null
  )
}

/** Minimal structural guard for a Delta. Trust boundary is in-process structured-clone, so light. */
function isDelta(d: unknown): boolean {
  if (typeof d !== 'object' || d === null) return false
  const x = d as Record<string, unknown>
  return typeof x.tick === 'number' && typeof x.parcels === 'object' && x.parcels !== null
}

/** Narrowing guard for an inbound blackboard payload (unknown → BlackboardMsg). */
export function isBlackboardMsg(p: unknown): p is BlackboardMsg {
  if (typeof p !== 'object' || p === null) return false
  const m = p as Record<string, unknown>
  if (typeof m.tick !== 'number') return false
  switch (m.kind) {
    case 'hello':
    case 'heartbeat':
      return true
    case 'snapshot':
      return isDelta(m.base)
    case 'delta':
      return isDelta(m.delta)
    default:
      return false
  }
}

export class Blackboard {
  readonly beliefs: BeliefBase
  partnerLastSeenTick = -Infinity

  private readonly self: AgentId
  private readonly partner: AgentId
  private readonly send: (msg: A2AMessage) => void
  private readonly logger: LoggerLike
  private readonly heartbeatInterval: number
  private readonly partnerTtl: number
  private lastSentTick = -Infinity
  private lastPartnerAlive = false

  constructor(beliefs: BeliefBase, opts: BlackboardOpts) {
    this.beliefs = beliefs
    this.self = opts.self
    this.partner = opts.partner
    this.send = opts.send
    this.logger = opts.logger
    this.heartbeatInterval = opts.heartbeatInterval ?? HEARTBEAT_INTERVAL_TICKS
    this.partnerTtl = opts.partnerTtl ?? PARTNER_TTL_TICKS
  }

  /** Coarse degradation signal (§11). False before first contact (partnerLastSeenTick = -Infinity). */
  partnerAlive(tick: number): boolean {
    return tick - this.partnerLastSeenTick <= this.partnerTtl
  }

  private emit(msg: BlackboardMsg): void {
    this.send({ from: this.self, to: this.partner, type: 'blackboard', payload: msg })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/blackboard.test.ts`
Expected: PASS (4 tests). Then `bunx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/blackboard/blackboard.ts tests/blackboard.test.ts
git commit -m "feat(blackboard): scaffold replication hub — msg union, guards, class skeleton

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `onTick` — broadcast trigger + heartbeat

**Files:**
- Modify: `src/blackboard/blackboard.ts` (add `onTick`, the `deltaCount` helper)
- Test: `tests/blackboard.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/blackboard.test.ts`. Add this fixture helper near the top fixtures (after `emptyDelta`):

```ts
import type { PerceptionSnapshot, ParcelObs } from '../src/types/perception.js'

function snap(self: SelfObs, tick: number, parcels: ParcelObs[] = []): PerceptionSnapshot {
  return {
    tick,
    self: { id: self.id, name: self.name, teamId: self.teamId, pos: self.pos, score: self.score },
    parcels,
    agents: [],
    crates: [],
  }
}

function payloads(sent: A2AMessage[]): BlackboardMsg[] {
  return sent.map((m) => m.payload as BlackboardMsg)
}
```

Then the tests:

```ts
test('onTick ships a delta on material change and addresses it to the partner', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
  })
  bb.beliefs.foldPerception(snap(SELF_A, 10, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  bb.onTick(10)
  expect(sent).toHaveLength(1)
  expect(sent[0].from).toBe('liaison')
  expect(sent[0].to).toBe('courier')
  expect(sent[0].type).toBe('blackboard')
  const msg = sent[0].payload as BlackboardMsg
  expect(msg.kind).toBe('delta')
  if (msg.kind === 'delta') {
    expect(msg.tick).toBe(10)
    expect(msg.delta.parcels.upsert.map((p) => p.id)).toEqual(['p1'])
  }
})

test('onTick drains the base: a second onTick with no new observation does not re-ship the delta', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
    heartbeatInterval: 100,
  })
  bb.beliefs.foldPerception(snap(SELF_A, 10, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  bb.onTick(10)
  bb.onTick(10) // same tick, nothing new, heartbeat interval not reached
  expect(payloads(sent).filter((m) => m.kind === 'delta')).toHaveLength(1)
  expect(sent).toHaveLength(1)
})

test('onTick emits a heartbeat only once the interval since the last send has elapsed', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
    heartbeatInterval: 3,
  })
  bb.beliefs.foldPerception(snap(SELF_A, 10, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  bb.onTick(10) // delta, lastSentTick = 10
  bb.onTick(11) // 11-10=1 < 3 -> silent
  bb.onTick(12) // 12-10=2 < 3 -> silent
  expect(sent).toHaveLength(1)
  bb.onTick(13) // 13-10=3 >= 3 -> heartbeat
  expect(sent).toHaveLength(2)
  const last = sent[1].payload as BlackboardMsg
  expect(last.kind).toBe('heartbeat')
  if (last.kind === 'heartbeat') expect(last.tick).toBe(13)
})

test('a delta send counts as a heartbeat (resets the silence clock)', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
    heartbeatInterval: 2,
  })
  bb.beliefs.foldPerception(snap(SELF_A, 10, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  bb.onTick(10) // delta at 10
  bb.onTick(11) // 11-10=1 < 2 -> silent, no redundant ping right after a delta
  expect(sent).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/blackboard.test.ts`
Expected: FAIL — `bb.onTick is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/blackboard/blackboard.ts`, add a module-level helper after `isEmptyDelta`:

```ts
/** Count of entities a delta carries — for the `n` field in debug logs. */
function deltaCount(d: Delta): number {
  return (
    d.parcels.upsert.length +
    d.parcels.remove.length +
    d.agents.upsert.length +
    d.crates.upsert.length +
    (d.self === null ? 0 : 1)
  )
}
```

Add the `onTick` method to the class (after `partnerAlive`):

```ts
/**
 * Pump after BeliefBase.foldPerception + own-action calls each tick. Sole drainer of
 * computeDelta. Ships a delta on material change, else heartbeats when silence exceeds
 * the interval. A delta doubles as a liveness ping (it resets lastSentTick).
 */
onTick(tick: number): void {
  const d = this.beliefs.computeDelta()
  if (!isEmptyDelta(d)) {
    this.emit({ kind: 'delta', tick, delta: d })
    this.lastSentTick = tick
    this.logger.debug({ kind: 'delta', n: deltaCount(d), agentId: this.self }, 'bb send')
  } else if (tick - this.lastSentTick >= this.heartbeatInterval) {
    this.emit({ kind: 'heartbeat', tick })
    this.lastSentTick = tick
    this.logger.debug({ kind: 'heartbeat', agentId: this.self }, 'bb send')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/blackboard.test.ts`
Expected: PASS (8 tests). `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/blackboard/blackboard.ts tests/blackboard.test.ts
git commit -m "feat(blackboard): onTick broadcast trigger + silent-tick heartbeat

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `receive` — apply delta/snapshot, refresh liveness, ignore foreign channels

**Files:**
- Modify: `src/blackboard/blackboard.ts` (add `receive`)
- Test: `tests/blackboard.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```ts
function mkBB(self: SelfObs, id: AgentIdT, partner: AgentIdT, sent: A2AMessage[], log: LoggerLike): Blackboard {
  return new Blackboard(new BeliefBase(self, CONSTS, MAP), { self: id, partner, send: (m) => sent.push(m), logger: log })
}

test('receive(delta) applies the partner delta into the local base and refreshes liveness', () => {
  const { log } = fakeLogger()
  const sentA: A2AMessage[] = []
  const sentB: A2AMessage[] = []
  const a = mkBB(SELF_A, 'liaison', 'courier', sentA, log)
  const b = mkBB(SELF_B, 'courier', 'liaison', sentB, log)
  a.beliefs.foldPerception(snap(SELF_A, 100, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  a.onTick(100)
  b.receive(sentA[0])
  expect(b.beliefs.parcels.get('p1')?.rewardSeen).toBe(9)
  expect(b.partnerLastSeenTick).toBe(100)
  expect(b.partnerAlive(101)).toBe(true)
})

test('receive(heartbeat) refreshes liveness only — no base mutation', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const b = mkBB(SELF_B, 'courier', 'liaison', sent, log)
  const beat: A2AMessage = { from: 'liaison', to: 'courier', type: 'blackboard', payload: { kind: 'heartbeat', tick: 42 } }
  b.receive(beat)
  expect(b.partnerLastSeenTick).toBe(42)
  expect(b.beliefs.parcels.size).toBe(0)
})

test('receive(snapshot) applies the full base additively', () => {
  const { log } = fakeLogger()
  const sentA: A2AMessage[] = []
  const sentB: A2AMessage[] = []
  const a = mkBB(SELF_A, 'liaison', 'courier', sentA, log)
  const b = mkBB(SELF_B, 'courier', 'liaison', sentB, log)
  a.beliefs.foldPerception(snap(SELF_A, 100, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  const base = a.beliefs.computeSnapshot()
  const msg: A2AMessage = { from: 'liaison', to: 'courier', type: 'blackboard', payload: { kind: 'snapshot', tick: base.tick, base } }
  b.receive(msg)
  expect(b.beliefs.parcels.get('p1')?.rewardSeen).toBe(9)
})

test('receive ignores a foreign-channel message: no mutation, no liveness refresh', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const b = mkBB(SELF_B, 'courier', 'liaison', sent, log)
  const foreign: A2AMessage = { from: 'liaison', to: 'courier', type: 'auction-bid', payload: { parcelId: 'p9' } }
  b.receive(foreign)
  expect(b.partnerLastSeenTick).toBe(-Infinity)
  expect(b.beliefs.parcels.size).toBe(0)
})

test('receive ignores a blackboard message with a malformed payload', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const b = mkBB(SELF_B, 'courier', 'liaison', sent, log)
  const bad: A2AMessage = { from: 'liaison', to: 'courier', type: 'blackboard', payload: { kind: 'delta', tick: 5 } }
  b.receive(bad)
  expect(b.partnerLastSeenTick).toBe(-Infinity)
})
```

Add this type alias next to the fixtures at the top of the file (used by `mkBB`):

```ts
import type { AgentId as AgentIdT } from '../src/types/a2a.js'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/blackboard.test.ts`
Expected: FAIL — `b.receive is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the `receive` method to the class (after `onTick`):

```ts
/** Feed inbound a2a from the main relay. Ignores non-blackboard / malformed messages. */
receive(msg: A2AMessage): void {
  if (msg.type !== 'blackboard' || !isBlackboardMsg(msg.payload)) return
  const bb = msg.payload
  this.partnerLastSeenTick = Math.max(this.partnerLastSeenTick, bb.tick)
  switch (bb.kind) {
    case 'hello': {
      const base = this.beliefs.computeSnapshot()
      this.emit({ kind: 'snapshot', tick: base.tick, base })
      this.logger.debug({ kind: 'snapshot', n: deltaCount(base), agentId: this.self }, 'bb send')
      break
    }
    case 'snapshot':
      this.beliefs.applySnapshot(bb.base)
      this.logger.debug({ kind: 'snapshot', n: deltaCount(bb.base), agentId: this.self }, 'bb recv')
      break
    case 'delta':
      this.beliefs.applyDelta(bb.delta)
      this.logger.debug({ kind: 'delta', n: deltaCount(bb.delta), agentId: this.self }, 'bb recv')
      break
    case 'heartbeat':
      this.logger.debug({ kind: 'heartbeat', agentId: this.self }, 'bb recv')
      break
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/blackboard.test.ts`
Expected: PASS (13 tests). `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/blackboard/blackboard.ts tests/blackboard.test.ts
git commit -m "feat(blackboard): receive — apply delta/snapshot, refresh liveness, drop foreign msgs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `hello` handshake — reconnect snapshot

**Files:**
- Modify: `src/blackboard/blackboard.ts` (add `hello`)
- Test: `tests/blackboard.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```ts
test('hello() emits a hello message addressed to the partner', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const a = mkBB(SELF_A, 'liaison', 'courier', sent, log)
  a.hello(7)
  expect(sent).toHaveLength(1)
  expect(sent[0].to).toBe('courier')
  const msg = sent[0].payload as BlackboardMsg
  expect(msg.kind).toBe('hello')
  if (msg.kind === 'hello') expect(msg.tick).toBe(7)
})

test('receiving a hello triggers a snapshot reply carrying the survivor full base', () => {
  const { log } = fakeLogger()
  const sentSurvivor: A2AMessage[] = []
  const survivor = mkBB(SELF_A, 'liaison', 'courier', sentSurvivor, log)
  survivor.beliefs.foldPerception(snap(SELF_A, 100, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  survivor.onTick(100) // ship + drain its own first delta
  sentSurvivor.length = 0 // ignore that; focus on the hello reply
  const hello: A2AMessage = { from: 'courier', to: 'liaison', type: 'blackboard', payload: { kind: 'hello', tick: 120 } }
  survivor.receive(hello)
  expect(sentSurvivor).toHaveLength(1)
  const msg = sentSurvivor[0].payload as BlackboardMsg
  expect(msg.kind).toBe('snapshot')
  if (msg.kind === 'snapshot') expect(msg.base.parcels.upsert.map((p) => p.id)).toEqual(['p1'])
})

test('answering a hello does not drain the survivor pending delta', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const survivor = mkBB(SELF_A, 'liaison', 'courier', sent, log)
  survivor.beliefs.foldPerception(snap(SELF_A, 100, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  const hello: A2AMessage = { from: 'courier', to: 'liaison', type: 'blackboard', payload: { kind: 'hello', tick: 120 } }
  survivor.receive(hello) // snapshot reply, must NOT drain dirty
  sent.length = 0
  survivor.onTick(100) // the pending parcel delta must still ship
  expect(sent).toHaveLength(1)
  const msg = sent[0].payload as BlackboardMsg
  expect(msg.kind).toBe('delta')
  if (msg.kind === 'delta') expect(msg.delta.parcels.upsert.map((p) => p.id)).toEqual(['p1'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/blackboard.test.ts`
Expected: FAIL — `survivor.hello is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the `hello` method to the class (after `receive`):

```ts
/** Call once on worker boot to announce (re)connection; the partner replies with a snapshot. */
hello(tick: number): void {
  this.emit({ kind: 'hello', tick })
  this.logger.debug({ kind: 'hello', agentId: this.self }, 'bb send')
}
```

(The hello-reply path itself already lives in `receive`'s `'hello'` case from Task 3 — these tests now exercise it end to end.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/blackboard.test.ts`
Expected: PASS (16 tests). `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/blackboard/blackboard.ts tests/blackboard.test.ts
git commit -m "feat(blackboard): hello handshake — reconnect triggers snapshot reply

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Liveness edge logging — partner-loss / partner-recovered

**Files:**
- Modify: `src/blackboard/blackboard.ts` (add `checkLivenessEdge`, call it from `onTick`)
- Test: `tests/blackboard.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```ts
test('onTick logs partner-recovered on first contact and partner-loss after the TTL lapses', () => {
  const { log, infos } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
    partnerTtl: 5,
    heartbeatInterval: 100,
  })
  // no contact yet -> still considered lost, no edge logged
  bb.onTick(1)
  expect(infos).toHaveLength(0)
  // partner speaks at tick 10
  bb.receive({ from: 'courier', to: 'liaison', type: 'blackboard', payload: { kind: 'heartbeat', tick: 10 } })
  bb.onTick(11) // 11-10=1 <= 5 -> alive -> edge: recovered
  expect(infos.map((o) => o.event)).toEqual(['partner-recovered'])
  // silence: 17-10=7 > 5 -> lost
  bb.onTick(17)
  expect(infos.map((o) => o.event)).toEqual(['partner-recovered', 'partner-loss'])
  // no duplicate edge while still lost
  bb.onTick(18)
  expect(infos).toHaveLength(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/blackboard.test.ts`
Expected: FAIL — `infos` empty / no `partner-recovered` entry (edge logging not wired).

- [ ] **Step 3: Write minimal implementation**

Add a private method to the class (after `onTick`):

```ts
/** Log the boolean edge of partnerAlive at `info` (a degradation event, §11). */
private checkLivenessEdge(tick: number): void {
  const alive = this.partnerAlive(tick)
  if (alive !== this.lastPartnerAlive) {
    this.logger.info(
      { event: alive ? 'partner-recovered' : 'partner-loss', partnerLastSeenTick: this.partnerLastSeenTick, tick },
      'bb liveness',
    )
    this.lastPartnerAlive = alive
  }
}
```

Then call it at the **end** of `onTick`, after the send/heartbeat block:

```ts
onTick(tick: number): void {
  const d = this.beliefs.computeDelta()
  if (!isEmptyDelta(d)) {
    this.emit({ kind: 'delta', tick, delta: d })
    this.lastSentTick = tick
    this.logger.debug({ kind: 'delta', n: deltaCount(d), agentId: this.self }, 'bb send')
  } else if (tick - this.lastSentTick >= this.heartbeatInterval) {
    this.emit({ kind: 'heartbeat', tick })
    this.lastSentTick = tick
    this.logger.debug({ kind: 'heartbeat', agentId: this.self }, 'bb send')
  }
  this.checkLivenessEdge(tick)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/blackboard.test.ts`
Expected: PASS (17 tests). `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/blackboard/blackboard.ts tests/blackboard.test.ts
git commit -m "feat(blackboard): log partner-loss/recovered liveness edges at info

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Two-instance integration — convergence + reconnect re-sync

**Files:**
- Test: `tests/blackboard.test.ts` (append — no production change)

- [ ] **Step 1: Write the failing test**

Append. This wires two blackboards into a zero-latency in-process relay (each `send` calls the other's `receive`), mirroring the main-thread relay (CLAUDE.md):

```ts
test('two wired blackboards converge: a parcel A observes appears in B base', () => {
  const { log } = fakeLogger()
  let b: Blackboard
  const a = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => b.receive(m),
    logger: log,
  })
  b = new Blackboard(new BeliefBase(SELF_B, CONSTS, MAP), {
    self: 'courier',
    partner: 'liaison',
    send: (m) => a.receive(m),
    logger: log,
  })
  a.beliefs.foldPerception(snap(SELF_A, 100, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  a.onTick(100)
  expect(b.beliefs.parcels.get('p1')?.rewardSeen).toBe(9)
  expect(b.partnerAlive(101)).toBe(true)
})

test('reconnect: a freshly-booted agent hello triggers a snapshot that hydrates its empty base', () => {
  const { log } = fakeLogger()
  // survivor already holds rich state
  let fresh: Blackboard | undefined
  const survivor = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    // fresh is not booted yet: its live delta is dropped (the cold-start premise),
    // and the guard avoids touching `fresh` before it is assigned.
    send: (m) => {
      if (fresh !== undefined) fresh.receive(m)
    },
    logger: log,
  })
  survivor.beliefs.foldPerception(snap(SELF_A, 200, [{ id: 'p7', pos: { x: 6, y: 5 }, reward: 4, carriedBy: null }]))
  survivor.onTick(200) // delta is dropped — fresh not up yet
  // fresh agent boots empty, announces itself
  fresh = new Blackboard(new BeliefBase(SELF_B, CONSTS, MAP), {
    self: 'courier',
    partner: 'liaison',
    send: (m) => survivor.receive(m),
    logger: log,
  })
  expect(fresh.beliefs.parcels.size).toBe(0)
  fresh.hello(205) // survivor replies with a snapshot
  expect(fresh.beliefs.parcels.get('p7')?.rewardSeen).toBe(4)
})
```

- [ ] **Step 2: Run test to verify it fails (then pass)**

Run: `bun test tests/blackboard.test.ts`
Expected: These two tests PASS immediately — they exercise already-built behaviour end to end (no new production code). If either fails, the wiring or an earlier task has a bug; fix the implicated method, not the test.

- [ ] **Step 3: Full-suite regression**

Run: `bun test ./tests`
Expected: all blackboard tests (19) plus the pre-existing beliefs/deliveroo/relay/config/logger suites PASS. `bunx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add tests/blackboard.test.ts
git commit -m "test(blackboard): two-instance relay — convergence + reconnect snapshot re-sync

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `bun test ./tests` — full suite green.
- [ ] `bunx tsc --noEmit` — no type errors (strict, no `any`).
- [ ] `grep -rn "console.log" src/blackboard/blackboard.ts` — no matches (Pino only).
- [ ] Spec coverage: §2 protocol (Task 1), §3 interface (Tasks 1–5), §4 onTick (Tasks 2,5), §5 receive (Tasks 3,4), §6 liveness (Tasks 1,5), §7 observability (debug in 2–4, info in 5), §9 testing (all tasks).
