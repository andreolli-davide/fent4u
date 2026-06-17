# Coordination Contracts — Core Primitive + Rendezvous Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the generic §8 coordination-contract primitive (step list of LOCALs + barriers, the replicated lifecycle) and the first worked template — RENDEZVOUS — end-to-end, so two agents independently navigate into a shared zone, post their milestones over a new a2a channel, and both reach `SATISFIED` with no central controller.

**Architecture:** A new pure module `src/coordination/contract.ts` holds the `Contract` type, the monotonic step-advance function (`advance`), and a `ContractRuntime` that owns the single active contract and applies the `'contract'` a2a sub-protocol (propose/accept/post/teardown). The BDI loop gains a **short-circuit branch**: when a contract is `ACTIVE`, it executes the contract action (navigate / post milestone / hold / complete) *before* the normal route/explore/idle argmax — because a committed contract is not re-bid per tick (§8.6). Both agent entrypoints route the `'contract'` channel into their `ContractRuntime`. The relay already forwards arbitrary a2a `type`s by `to`, so no relay change is needed.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Bun test runner (`bun test`), existing project conventions: pure modules + dependency injection, `§`-referenced comments, `AgentId = 'liaison' | 'courier'`, `Pos = {x,y}`, `A2AMessage = { from, to, type, payload }`.

**What this slice deliberately EXCLUDES (follow-on plans):**
- HANDOFF template — needs `ACTION(putDown ids)` steps + drop/vacate tile binding + §9.10 MISSION-claim parcel lock.
- SYNC_GATE template — needs the chat `gate` flag, `GATE_STALE_TTL` close-latency guard, partner-loss teardown.
- §8.6 **adoption gating** (`payoff > combined forgone base utility`), barrier **deadlines / FAILED** transitions, and the **mission→contract bridge** (classifying a `COORDINATION_CONTRACT` mission + role-bidding + `RUNTIME_BOUND` tile binding). In this slice the Liaison proposes a contract via a direct `rendezvousContract(...)` factory; wiring it to the LLM compiler is out of scope.
- Opportunistic base-play pickups while blocked at a barrier (§8.4 note). In this slice a blocked agent holds position.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/coordination/contract.ts` | `Contract`/`Step`/`LocalGoal` types, `goalSatisfied`, `navTarget`, pure `advance`, `ContractMsg` + `isContractMsg` guard, `ContractRuntime`, `rendezvousContract` factory | **Create** |
| `src/bdi/loop.ts` | Add the ACTIVE-contract short-circuit branch + `actContract`; widen the `mission` constructor param to carry an optional `ContractRuntime` | **Modify** |
| `src/agents/liaison.ts` | Construct a `ContractRuntime`, pass it to the loop, route the `'contract'` a2a channel | **Modify** |
| `src/agents/courier.ts` | Same wiring as the Liaison | **Modify** |
| `tests/contract-core.test.ts` | Unit tests for `goalSatisfied`, `navTarget`, `advance`, `isContractMsg` | **Create** |
| `tests/contract-runtime.test.ts` | Unit tests for the `ContractRuntime` handshake/replication/teardown | **Create** |
| `tests/bdi-loop-contract.test.ts` | Loop-level: navigate-to-zone, post-on-arrival, complete-on-barrier | **Create** |
| `tests/contract-rendezvous-e2e.test.ts` | Capstone: two loops + two runtimes routed through `relay()` drive a rendezvous to `SATISFIED` | **Create** |

---

## Task 1: Contract types + pure predicates (`goalSatisfied`, `navTarget`)

**Files:**
- Create: `src/coordination/contract.ts`
- Test: `tests/contract-core.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract-core.test.ts
import { test, expect } from 'bun:test'
import { goalSatisfied, navTarget } from '../src/coordination/contract.js'

test('AT_TILE goal is satisfied only on the exact tile', () => {
  const goal = { kind: 'AT_TILE' as const, tile: { x: 3, y: 2 } }
  expect(goalSatisfied(goal, { x: 3, y: 2 })).toBe(true)
  expect(goalSatisfied(goal, { x: 3, y: 1 })).toBe(false)
})

test('IN_ZONE goal uses Manhattan radius (server metric, §8.4)', () => {
  const goal = { kind: 'IN_ZONE' as const, center: { x: 5, y: 5 }, radius: 3 }
  expect(goalSatisfied(goal, { x: 5, y: 5 })).toBe(true)  // d=0
  expect(goalSatisfied(goal, { x: 7, y: 6 })).toBe(true)  // d=3
  expect(goalSatisfied(goal, { x: 8, y: 6 })).toBe(false) // d=4
})

test('navTarget returns the tile for AT_TILE and the centre for IN_ZONE', () => {
  expect(navTarget({ kind: 'AT_TILE', tile: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2 })
  expect(navTarget({ kind: 'IN_ZONE', center: { x: 4, y: 4 }, radius: 2 })).toEqual({ x: 4, y: 4 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/contract-core.test.ts`
Expected: FAIL — `Cannot find module '../src/coordination/contract.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/coordination/contract.ts
// DESIGN §8 — the generic coordination-contract primitive. One step list of LOCALs and
// barriers, run by BOTH agents, advanced by shared monotonic `posted` bookkeeping (§8.1).
// This slice implements the RENDEZVOUS template only (single barrier, no parcels).
import type { AgentId } from '../types/a2a.js'
import type { Pos } from '../types/perception.js'

export type ContractType = 'RENDEZVOUS' | 'HANDOFF' | 'SYNC_GATE'
export type ContractStatus =
  | 'PROPOSED' | 'COMMITTED' | 'ACTIVE' | 'SATISFIED' | 'FAILED' | 'ABORTED'

// What a LOCAL party must verify alone (§8.1). AT_TILE: an exact tile. IN_ZONE: within
// `radius` of `center` under the SERVER's distance metric — never A* path length (§8.4).
export type LocalGoal =
  | { kind: 'AT_TILE'; tile: Pos }
  | { kind: 'IN_ZONE'; center: Pos; radius: number }

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

// Manhattan is the project-wide metric (cf. markSeen in bdi/loop.ts). If the server credits
// "within distance r" by a different rule, THIS is the single calibration point (§8.4).
export function goalSatisfied(goal: LocalGoal, self: Pos): boolean {
  if (goal.kind === 'AT_TILE') return self.x === goal.tile.x && self.y === goal.tile.y
  return manhattan(self, goal.center) <= goal.radius
}

// The tile to route TOWARD while the goal is unmet. A* routes into the zone; goalSatisfied
// (server metric) decides arrival — they may disagree at the boundary, by design (§8.4).
export function navTarget(goal: LocalGoal): Pos {
  return goal.kind === 'AT_TILE' ? goal.tile : goal.center
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/contract-core.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/contract.ts tests/contract-core.test.ts
git commit -m "feat(contract): §8.1 contract goal predicates (AT_TILE/IN_ZONE)"
```

---

## Task 2: The pure step-advance function

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-core.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/contract-core.test.ts`)**

```ts
import { advance, type Contract } from '../src/coordination/contract.js'

// A rendezvous: both reach within r=3 of (5,5); barrier needs both milestones.
function rdv(posted: Record<string, boolean> = {}): Contract {
  return {
    id: 'c1', type: 'RENDEZVOUS',
    steps: [
      { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'liaison_ready' },
      { kind: 'LOCAL', agent: 'courier', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'courier_ready' },
      { kind: 'BARRIER', needs: ['liaison_ready', 'courier_ready'] },
    ],
    posted, payoff: 500, deadline: 9999, status: 'ACTIVE',
  }
}

test('advance: navigate toward my zone when I am outside it', () => {
  expect(advance(rdv(), 'liaison', { x: 0, y: 0 })).toEqual({ kind: 'navigate', to: { x: 5, y: 5 } })
})

test('advance: post my milestone when I am inside the zone', () => {
  expect(advance(rdv(), 'liaison', { x: 5, y: 6 })).toEqual({ kind: 'post', milestone: 'liaison_ready' })
})

test('advance: block at the barrier when only I have posted', () => {
  const c = rdv({ liaison_ready: true })
  // I (liaison) am in-zone and already posted; the barrier still needs courier_ready.
  expect(advance(c, 'liaison', { x: 5, y: 5 })).toEqual({ kind: 'block' })
})

test('advance: done once the barrier is released (both posted)', () => {
  const c = rdv({ liaison_ready: true, courier_ready: true })
  expect(advance(c, 'liaison', { x: 5, y: 5 })).toEqual({ kind: 'done' })
})

test('advance: I skip the OTHER agent\'s LOCAL step', () => {
  // courier, far from zone, liaison not yet ready: courier works on ITS own local.
  expect(advance(rdv(), 'courier', { x: 0, y: 0 })).toEqual({ kind: 'navigate', to: { x: 5, y: 5 } })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/contract-core.test.ts`
Expected: FAIL — `advance` is not exported.

- [ ] **Step 3: Write minimal implementation (append to `src/coordination/contract.ts`)**

```ts
// A single step in the contract's plan. Both agents hold the SAME list; each executes only
// its own LOCAL steps and blocks on every BARRIER (§8.1). (ACTION steps land in the handoff plan.)
export type Step =
  | { kind: 'LOCAL'; agent: AgentId; goal: LocalGoal; post: string }
  | { kind: 'BARRIER'; needs: string[] }

export interface Contract {
  id: string
  type: ContractType
  steps: Step[]
  posted: Record<string, boolean> // milestone -> reached; monotonic, replicated (§8.1)
  payoff: number
  deadline: number
  status: ContractStatus
}

// What THIS agent should do for the contract this tick. Pure. Rescans from step 0 every call:
// `posted` is monotonic, so this is idempotent and replica-safe — a late a2a post only ever
// advances the contract, never corrupts it (§8.1). No cursor state to keep convergent.
export type ContractAction =
  | { kind: 'navigate'; to: Pos }
  | { kind: 'post'; milestone: string }
  | { kind: 'block' }
  | { kind: 'done' }

export function advance(c: Contract, me: AgentId, self: Pos): ContractAction {
  for (const s of c.steps) {
    if (s.kind === 'BARRIER') {
      if (s.needs.every((m) => c.posted[m])) continue // released → fall through to later steps
      return { kind: 'block' }
    }
    if (s.agent !== me) continue        // not my LOCAL → skip (the partner runs it)
    if (c.posted[s.post]) continue      // my milestone already reached → advance
    if (goalSatisfied(s.goal, self)) return { kind: 'post', milestone: s.post }
    return { kind: 'navigate', to: navTarget(s.goal) }
  }
  return { kind: 'done' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/contract-core.test.ts`
Expected: PASS (8 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/contract.ts tests/contract-core.test.ts
git commit -m "feat(contract): §8.1 monotonic step-advance (LOCAL/BARRIER)"
```

---

## Task 3: The `'contract'` a2a message type + guard

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-core.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/contract-core.test.ts`)**

```ts
import { isContractMsg } from '../src/coordination/contract.js'

test('isContractMsg accepts the four sub-protocol kinds', () => {
  expect(isContractMsg({ kind: 'propose', contract: rdv() })).toBe(true)
  expect(isContractMsg({ kind: 'accept', id: 'c1' })).toBe(true)
  expect(isContractMsg({ kind: 'post', id: 'c1', milestone: 'liaison_ready' })).toBe(true)
  expect(isContractMsg({ kind: 'teardown', id: 'c1', status: 'SATISFIED' })).toBe(true)
})

test('isContractMsg rejects malformed payloads', () => {
  expect(isContractMsg(null)).toBe(false)
  expect(isContractMsg({ kind: 'nope' })).toBe(false)
  expect(isContractMsg({ kind: 'accept' })).toBe(false)              // missing id
  expect(isContractMsg({ kind: 'post', id: 'c1' })).toBe(false)      // missing milestone
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/contract-core.test.ts`
Expected: FAIL — `isContractMsg` is not exported.

- [ ] **Step 3: Write minimal implementation (append to `src/coordination/contract.ts`)**

```ts
// The contract sub-protocol carried in A2AMessage.payload on the `type:'contract'` channel.
// propose/accept = the §8.2 handshake; post = replicate a milestone; teardown = §8.2 terminal.
export type ContractMsg =
  | { kind: 'propose'; contract: Contract }
  | { kind: 'accept'; id: string }
  | { kind: 'post'; id: string; milestone: string }
  | { kind: 'teardown'; id: string; status: ContractStatus }

// Narrowing guard for an inbound contract payload (unknown → ContractMsg). Trust boundary is
// in-process structured-clone (relay), so the structural checks are light (cf. isClaimMsg).
export function isContractMsg(p: unknown): p is ContractMsg {
  if (typeof p !== 'object' || p === null) return false
  const m = p as Record<string, unknown>
  switch (m.kind) {
    case 'propose':
      return typeof m.contract === 'object' && m.contract !== null &&
        typeof (m.contract as Contract).id === 'string'
    case 'accept':
      return typeof m.id === 'string'
    case 'post':
      return typeof m.id === 'string' && typeof m.milestone === 'string'
    case 'teardown':
      return typeof m.id === 'string' && typeof m.status === 'string'
    default:
      return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/contract-core.test.ts`
Expected: PASS (10 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/contract.ts tests/contract-core.test.ts
git commit -m "feat(contract): §8.2 a2a sub-protocol type + isContractMsg guard"
```

---

## Task 4: `ContractRuntime` — handshake, replication, teardown

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract-runtime.test.ts
import { test, expect } from 'bun:test'
import { ContractRuntime, type Contract } from '../src/coordination/contract.js'

function rdv(): Contract {
  return {
    id: 'c1', type: 'RENDEZVOUS',
    steps: [{ kind: 'BARRIER', needs: ['liaison_ready', 'courier_ready'] }],
    posted: {}, payoff: 500, deadline: 9999, status: 'PROPOSED',
  }
}

test('propose stores the contract PROPOSED and is not yet active()', () => {
  const rt = new ContractRuntime()
  const msg = rt.propose(rdv())
  expect(msg).toEqual({ kind: 'propose', contract: rt.current()! })
  expect(rt.current()!.status).toBe('PROPOSED')
  expect(rt.active()).toBeNull()
})

test('Courier applying a propose goes ACTIVE and replies accept', () => {
  const courier = new ContractRuntime()
  const reply = courier.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  expect(reply).toEqual({ kind: 'accept', id: 'c1' })
  expect(courier.active()!.id).toBe('c1')
})

test('Liaison applying the accept flips PROPOSED → ACTIVE', () => {
  const liaison = new ContractRuntime()
  liaison.propose(rdv())
  expect(liaison.active()).toBeNull()
  const reply = liaison.applyMsg({ kind: 'accept', id: 'c1' }, 'liaison')
  expect(reply).toBeNull()
  expect(liaison.active()!.id).toBe('c1')
})

test('post replicates a milestone onto the local contract', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier') // now ACTIVE
  rt.applyMsg({ kind: 'post', id: 'c1', milestone: 'liaison_ready' }, 'courier')
  expect(rt.current()!.posted.liaison_ready).toBe(true)
})

test('own post() flips the flag locally AND returns the broadcast msg', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  const msg = rt.post('courier_ready')
  expect(msg).toEqual({ kind: 'post', id: 'c1', milestone: 'courier_ready' })
  expect(rt.current()!.posted.courier_ready).toBe(true)
})

test('complete() marks SATISFIED, clears the slot, returns a teardown msg', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  const msg = rt.complete()
  expect(msg).toEqual({ kind: 'teardown', id: 'c1', status: 'SATISFIED' })
  expect(rt.current()).toBeNull()
  expect(rt.active()).toBeNull()
})

test('teardown from the partner clears the local slot', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  rt.applyMsg({ kind: 'teardown', id: 'c1', status: 'SATISFIED' }, 'courier')
  expect(rt.current()).toBeNull()
})

test('messages for a different contract id are ignored', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  rt.applyMsg({ kind: 'post', id: 'OTHER', milestone: 'liaison_ready' }, 'courier')
  rt.applyMsg({ kind: 'teardown', id: 'OTHER', status: 'FAILED' }, 'courier')
  expect(rt.current()!.id).toBe('c1')
  expect(rt.current()!.posted.liaison_ready).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/contract-runtime.test.ts`
Expected: FAIL — `ContractRuntime` is not exported.

- [ ] **Step 3: Write minimal implementation (append to `src/coordination/contract.ts`)**

```ts
// Owns the single active contract for ONE agent (mirrors MissionSlot's single-slot rule, §4.3)
// and applies the `'contract'` a2a sub-protocol. Both replicas converge because the full
// contract ships in `propose` and every milestone is replicated via `post` (§8.1). This slice
// has no adoption gate (§8.6) and no deadline/FAILED logic — see the follow-on plans.
export class ContractRuntime {
  private c: Contract | null = null

  current(): Contract | null { return this.c }
  active(): Contract | null { return this.c?.status === 'ACTIVE' ? this.c : null }

  // Liaison side: install PROPOSED and return the msg to broadcast. Goes ACTIVE on the accept.
  propose(contract: Contract): ContractMsg {
    this.c = { ...contract, status: 'PROPOSED' }
    return { kind: 'propose', contract: this.c }
  }

  // Either agent: flip its OWN milestone and return the post msg to broadcast (§8.1).
  post(milestone: string): ContractMsg | null {
    if (this.c === null) return null
    this.c.posted[milestone] = true
    return { kind: 'post', id: this.c.id, milestone }
  }

  // The agent that observed `advance(...) === 'done'` marks SATISFIED, clears, broadcasts.
  complete(): ContractMsg | null {
    if (this.c === null) return null
    const id = this.c.id
    this.c.status = 'SATISFIED'
    this.c = null
    return { kind: 'teardown', id, status: 'SATISFIED' }
  }

  // Apply an inbound a2a msg; returns an optional reply for the caller to broadcast.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  applyMsg(msg: ContractMsg, _self: AgentId): ContractMsg | null {
    switch (msg.kind) {
      case 'propose':
        // Receiver (Courier) accepts immediately → ACTIVE. Adoption gating is the proposer's
        // responsibility (§8.6), deferred this slice, so acceptance is unconditional.
        this.c = { ...msg.contract, status: 'ACTIVE' }
        return { kind: 'accept', id: msg.contract.id }
      case 'accept':
        if (this.c !== null && this.c.id === msg.id) this.c.status = 'ACTIVE'
        return null
      case 'post':
        if (this.c !== null && this.c.id === msg.id) this.c.posted[msg.milestone] = true
        return null
      case 'teardown':
        if (this.c !== null && this.c.id === msg.id) this.c = null
        return null
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/contract-runtime.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/contract.ts tests/contract-runtime.test.ts
git commit -m "feat(contract): §8.2 ContractRuntime handshake/replication/teardown"
```

---

## Task 5: `rendezvousContract` factory

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-runtime.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/contract-runtime.test.ts`)**

```ts
import { rendezvousContract } from '../src/coordination/contract.js'

test('rendezvousContract builds the two-LOCAL + barrier template', () => {
  const c = rendezvousContract('r1', { x: 5, y: 5 }, 3, 500, 1000)
  expect(c.id).toBe('r1')
  expect(c.type).toBe('RENDEZVOUS')
  expect(c.status).toBe('PROPOSED')
  expect(c.payoff).toBe(500)
  expect(c.deadline).toBe(1000)
  expect(c.posted).toEqual({})
  expect(c.steps).toEqual([
    { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'liaison_ready' },
    { kind: 'LOCAL', agent: 'courier', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'courier_ready' },
    { kind: 'BARRIER', needs: ['liaison_ready', 'courier_ready'] },
  ])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/contract-runtime.test.ts`
Expected: FAIL — `rendezvousContract` is not exported.

- [ ] **Step 3: Write minimal implementation (append to `src/coordination/contract.ts`)**

```ts
// §8.4 RENDEZVOUS: both parties reach within `radius` of `target` (different tiles — agents can
// never share a tile), each posts its readiness, the single barrier releases when both have.
// Roles are symmetric here, so no runtime bid is needed (cf. §8.3 handoff, follow-on plan).
export function rendezvousContract(
  id: string,
  target: Pos,
  radius: number,
  payoff: number,
  deadline: number,
): Contract {
  const goal = { kind: 'IN_ZONE' as const, center: target, radius }
  return {
    id,
    type: 'RENDEZVOUS',
    steps: [
      { kind: 'LOCAL', agent: 'liaison', goal, post: 'liaison_ready' },
      { kind: 'LOCAL', agent: 'courier', goal, post: 'courier_ready' },
      { kind: 'BARRIER', needs: ['liaison_ready', 'courier_ready'] },
    ],
    posted: {},
    payoff,
    deadline,
    status: 'PROPOSED',
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/contract-runtime.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/contract.ts tests/contract-runtime.test.ts
git commit -m "feat(contract): §8.4 rendezvousContract factory"
```

---

## Task 6: BDI loop — the ACTIVE-contract short-circuit branch

**Files:**
- Modify: `src/bdi/loop.ts`
- Test: `tests/bdi-loop-contract.test.ts`

**Context for the implementer.** `BdiLoop` is constructed as
`new BdiLoop(client, params, log, claims?, coord?, mission?)`. Today `mission` is typed
`{ view: TeamMissionView; pursue: boolean; onSatisfied?: () => void }`. This task widens it
with an optional `contracts?: ContractRuntime`. When `mission.contracts.active()` returns a
contract, the loop must run the contract action and **return before** building the route/explore/
idle candidate set — a committed contract is not re-bid per tick (§8.6). The branch goes
**after** `dist`/`distL` are defined and **before** the `// ── coordination` block, so a
contracted agent does not also run the auction (it is not doing base play this tick).

- [ ] **Step 1: Write the failing test**

```ts
// tests/bdi-loop-contract.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime, rendezvousContract, type ContractMsg } from '../src/coordination/contract.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// One straight walkable row x=0..5 at y=0.
function rowMap(): Tile[] {
  const tiles: Tile[] = []
  for (let x = 0; x <= 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

interface Recorder { moves: string[]; client: DeliverooClient }
function fakeClient(map: Tile[], role: 'liaison' | 'courier'): Recorder {
  const rec: Recorder = { moves: [], client: null as never }
  rec.client = {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (): Promise<PickResult[]> => [],
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}

const snapAt = (pos: Pos): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos, score: 0 },
  parcels: [], agents: [], crates: [],
})

const log = { info: () => {}, debug: () => {}, warn: () => {} }

// Helper: an ACTIVE rendezvous runtime targeting (5,0) radius 0 (exact tile, for a clean test).
function activeRuntime(): ContractRuntime {
  const rt = new ContractRuntime()
  // applyMsg(propose) sets status ACTIVE directly (acceptance is immediate, §8.2 this slice).
  rt.applyMsg({ kind: 'propose', contract: rendezvousContract('r1', { x: 5, y: 0 }, 0, 500, 9999) }, 'liaison')
  return rt
}

test('ACTIVE contract: the agent navigates toward its zone (preempts base play)', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const contracts = activeRuntime()
  const sent: A2AMessage[] = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send: (m) => sent.push(m) },
    { view: new TeamMissionView(), pursue: true, contracts })
  await loop.tick(snapAt({ x: 1, y: 0 }))
  expect(rec.moves).toEqual(['right']) // toward (5,0)
})

test('ACTIVE contract: in-zone agent posts its milestone over the contract channel (no move)', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const contracts = activeRuntime()
  const sent: A2AMessage[] = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send: (m) => sent.push(m) },
    { view: new TeamMissionView(), pursue: true, contracts })
  await loop.tick(snapAt({ x: 5, y: 0 })) // exactly on the target
  expect(rec.moves).toEqual([])
  const posts = sent.filter((m) => m.type === 'contract').map((m) => m.payload as ContractMsg)
  expect(posts).toEqual([{ kind: 'post', id: 'r1', milestone: 'liaison_ready' }])
  expect(contracts.current()!.posted.liaison_ready).toBe(true)
})

test('ACTIVE contract: barrier released → onSatisfied fires and a teardown is broadcast', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const contracts = activeRuntime()
  // Pre-seed: partner already ready AND I am already ready → advance returns done.
  contracts.applyMsg({ kind: 'post', id: 'r1', milestone: 'courier_ready' }, 'liaison')
  contracts.applyMsg({ kind: 'post', id: 'r1', milestone: 'liaison_ready' }, 'liaison')
  const sent: A2AMessage[] = []
  let satisfied = 0
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send: (m) => sent.push(m) },
    { view: new TeamMissionView(), pursue: true, contracts, onSatisfied: () => { satisfied++ } })
  await loop.tick(snapAt({ x: 5, y: 0 }))
  expect(satisfied).toBe(1)
  const tear = sent.filter((m) => m.type === 'contract').map((m) => m.payload as ContractMsg)
  expect(tear).toEqual([{ kind: 'teardown', id: 'r1', status: 'SATISFIED' }])
  expect(contracts.current()).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-loop-contract.test.ts`
Expected: FAIL — `contracts` is not accepted by the `mission` param / no contract branch runs (moves empty or wrong).

- [ ] **Step 3a: Widen the `mission` constructor param type**

In `src/bdi/loop.ts`, change the constructor parameter (currently around line 45):

```ts
    private readonly mission?: { view: TeamMissionView; pursue: boolean; onSatisfied?: () => void },
```

to:

```ts
    private readonly mission?: { view: TeamMissionView; pursue: boolean; onSatisfied?: () => void; contracts?: ContractRuntime },
```

- [ ] **Step 3b: Add the imports** at the top of `src/bdi/loop.ts` (next to the other `coordination` imports):

```ts
import { advance, type ContractRuntime } from '../coordination/contract.js'
```

- [ ] **Step 3c: Insert the short-circuit branch.** In `tick()`, immediately after the
`const distL = ...`? No — `distL` is defined later. Insert it right after the `dist` memo closure
is defined (after the block that ends with the `distMemo`/`dist` definition, i.e. just before the
`// §9.7: coordination ... const sharedSelf` line):

```ts
    // §8 — a COMMITTED contract preempts base play. Adoption is a one-time decision (§8.6); once
    // ACTIVE the contract is executed directly, NOT re-bid against route/explore each tick. This
    // returns before the auction/argmax so a contracted agent does no base-play allocation.
    const activeContract = this.mission?.contracts?.active() ?? null
    if (activeContract !== null) {
      await this.actContract(activeContract, beliefs, planCtx, tnow)
      this.prevSelf = self
      this.log.debug({ durationMs: performance.now() - t0, tick: tnow, contract: activeContract.id }, 'tick (contract)')
      return
    }
```

- [ ] **Step 3d: Add the `actContract` method** (place it next to `act`, e.g. just before `private async act(...)`):

```ts
  // Execute one contract step for this agent (§8.1): navigate toward the milestone, post on
  // arrival, hold while blocked at a barrier, or complete when the final barrier releases.
  private async actContract(c: import('../coordination/contract.js').Contract, beliefs: BeliefBase, ctx: PlanCtx, tnow: number): Promise<void> {
    const self = beliefs.self.pos
    const me = this.client.role
    const action = advance(c, me, self)
    if (action.kind === 'navigate') {
      const dir = await this.stepToward(beliefs, ctx, self, action.to)
      this.log.debug({ tick: tnow, pos: self, contract: c.id, action: 'navigate', to: action.to, dir }, 'contract')
      return
    }
    if (action.kind === 'post') {
      const msg = this.mission!.contracts!.post(action.milestone)
      if (msg !== null) this.sendContract(msg)
      this.log.info({ tick: tnow, contract: c.id, milestone: action.milestone }, 'contract milestone posted')
      return
    }
    if (action.kind === 'done') {
      const msg = this.mission!.contracts!.complete()
      if (msg !== null) this.sendContract(msg)
      this.mission?.onSatisfied?.()
      this.log.info({ tick: tnow, contract: c.id, status: 'SATISFIED' }, 'contract satisfied')
      return
    }
    // action.kind === 'block' — hold position at the barrier (no move this tick).
    this.log.debug({ tick: tnow, pos: self, contract: c.id, action: 'block' }, 'contract')
  }

  private sendContract(msg: import('../coordination/contract.js').ContractMsg): void {
    if (!this.coord) return
    this.coord.send({ from: this.client.role, to: this.coord.partner, type: 'contract', payload: msg })
  }
```

> Note: the inline `import('...')` type qualifiers avoid adding `Contract`/`ContractMsg` to the
> top-of-file import list if the implementer prefers; alternatively add them to the existing
> `import { advance, type ContractRuntime } from '../coordination/contract.js'` line as
> `import { advance, type Contract, type ContractMsg, type ContractRuntime } from '../coordination/contract.js'`
> and drop the inline qualifiers. Pick one and be consistent.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bdi-loop-contract.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `bun test tests/`
Expected: `All tests passed.` (the contract branch is inert unless `mission.contracts.active()` is non-null, so base play is unchanged)

- [ ] **Step 6: Commit**

```bash
git add src/bdi/loop.ts tests/bdi-loop-contract.test.ts
git commit -m "feat(bdi): §8 ACTIVE-contract short-circuit (navigate/post/block/complete)"
```

---

## Task 7: Wire the `'contract'` a2a channel into both entrypoints

**Files:**
- Modify: `src/agents/liaison.ts`
- Modify: `src/agents/courier.ts`

**Context.** Both entrypoints already construct a `ClaimStore` and route `type:'claims'`/
`type:'mission'`/blackboard a2a in their `self.onmessage` handler. This task adds a
module-level `ContractRuntime`, passes it into the loop's `mission` param, and routes
`type:'contract'` messages into it — broadcasting any reply (`propose`→`accept`).

- [ ] **Step 1 (Liaison): add the import**

In `src/agents/liaison.ts`, after the `MissionSlot`/`TeamMissionView` imports add:

```ts
import { ContractRuntime, isContractMsg } from '../coordination/contract.js'
```

- [ ] **Step 2 (Liaison): add a module-level runtime** next to `let claims`:

```ts
let contracts: ContractRuntime | null = null
```

- [ ] **Step 3 (Liaison): construct it in `boot` and pass it to the loop.** After
`claims = new ClaimStore()` add `contracts = new ContractRuntime()`. Then in the `new BdiLoop(...)`
call, extend the `mission` object argument from:

```ts
  }, {
    view: missionView,
    pursue: true,
    onSatisfied: () => missionSlot.supersede(),
  })
```

to:

```ts
  }, {
    view: missionView,
    pursue: true,
    onSatisfied: () => missionSlot.supersede(),
    contracts,
  })
```

- [ ] **Step 4 (Liaison): route the channel.** In `self.onmessage`, inside the
`if (envelope.kind === 'a2a')` block, add a branch (before the final `else blackboard?.receive(msg)`):

```ts
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'liaison') ?? null
      if (reply !== null) send({ from: 'liaison', to: 'courier', type: 'contract', payload: reply })
```

So the chain reads `if (claims) … else if (mission) …`? (Liaison has no mission-receive branch
today — it owns the slot.) Concretely the Liaison handler becomes:

```ts
    if (msg.type === 'claims' && isClaimMsg(msg.payload)) {
      if (claims !== null) claims.applyMsg(msg.payload, 'liaison')
      else log?.debug({ type: msg.type }, 'claims msg dropped — boot in progress')
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'liaison') ?? null
      if (reply !== null) send({ from: 'liaison', to: 'courier', type: 'contract', payload: reply })
    } else blackboard?.receive(msg)
```

- [ ] **Step 5 (Courier): mirror the wiring.** In `src/agents/courier.ts`:
  - Add `import { ContractRuntime, isContractMsg } from '../coordination/contract.js'`.
  - Add `let contracts: ContractRuntime | null = null` next to `let missionView`.
  - In `boot`, after `claims = new ClaimStore()` add `contracts = new ContractRuntime()`, and add `contracts` to the loop's `mission` arg (which currently is `{ view: missionView, pursue: false }` → `{ view: missionView, pursue: false, contracts }`).
  - In `self.onmessage`, add the branch alongside the existing `claims`/`mission` branches:

```ts
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'courier') ?? null
      if (reply !== null) send({ from: 'courier', to: 'liaison', type: 'contract', payload: reply })
```

- [ ] **Step 6: Typecheck + full suite**

Run: `bun test tests/`
Expected: `All tests passed.`

Run (typecheck — match the project's existing check; if `tsc` is configured):
`bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/agents/liaison.ts src/agents/courier.ts
git commit -m "feat(agents): route the §8 contract a2a channel into ContractRuntime"
```

---

## Task 8: Capstone — two loops drive a rendezvous to SATISFIED via the relay

**Files:**
- Test: `tests/contract-rendezvous-e2e.test.ts`

**Purpose.** Prove the whole slice: a contract proposed on the Liaison and accepted by the
Courier drives BOTH agents into the zone, exchanges milestones over the `'contract'` channel
(routed by the real `relay()`), and reaches `SATISFIED` on both replicas — no central controller.

- [ ] **Step 1: Write the test**

```ts
// tests/contract-rendezvous-e2e.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime, rendezvousContract, isContractMsg } from '../src/coordination/contract.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage, AgentId } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// 6x1 walkable row, x=0..5 at y=0. Liaison starts at x=0, Courier at x=5. Target (3,0), radius 0.
function rowMap(): Tile[] {
  const tiles: Tile[] = []
  for (let x = 0; x <= 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

// A fake client whose position is mutated by move(), so successive ticks advance the agent.
function movingClient(map: Tile[], role: AgentId, start: Pos): { client: DeliverooClient; pos: Pos } {
  const state = { pos: { ...start } }
  const client: DeliverooClient = {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => {
      if (dir === 'right') state.pos.x++
      else if (dir === 'left') state.pos.x--
      else if (dir === 'up') state.pos.y++
      else state.pos.y--
      return { ...state.pos } as Pos
    },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (): Promise<PickResult[]> => [],
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return { client, pos: state.pos }
}

const log = { info: () => {}, debug: () => {}, warn: () => {} }
const snapAt = (pos: Pos): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos, score: 0 }, parcels: [], agents: [], crates: [],
})

test('two loops complete a rendezvous through the a2a contract channel', async () => {
  const L = movingClient(rowMap(), 'liaison', { x: 0, y: 0 })
  const C = movingClient(rowMap(), 'courier', { x: 5, y: 0 })
  const lc = new ContractRuntime()
  const cc = new ContractRuntime()

  // In-memory a2a buses: each agent's outbound contract msgs are applied to the OTHER's runtime.
  const inbox: Record<AgentId, A2AMessage[]> = { liaison: [], courier: [] }
  const send = (m: A2AMessage): void => { inbox[m.to].push(m) }
  // Drain a runtime's inbox, applying contract msgs and re-broadcasting any replies.
  function drain(rt: ContractRuntime, self: AgentId): void {
    for (const m of inbox[self].splice(0)) {
      if (m.type === 'contract' && isContractMsg(m.payload)) {
        const reply = rt.applyMsg(m.payload, self)
        if (reply !== null) send({ from: self, to: m.from, type: 'contract', payload: reply })
      }
    }
  }

  const loopL = new BdiLoop(L.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send }, { view: new TeamMissionView(), pursue: true, contracts: lc })
  const loopC = new BdiLoop(C.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'liaison', send }, { view: new TeamMissionView(), pursue: false, contracts: cc })

  // Liaison proposes; the propose msg is delivered to the Courier.
  send(lc.propose(rendezvousContract('r1', { x: 3, y: 0 }, 0, 500, 9999)))

  // Drive ticks until both runtimes have torn the contract down (SATISFIED), bounded.
  let guard = 0
  while ((lc.current() !== null || cc.current() !== null) && guard++ < 30) {
    drain(lc, 'liaison'); drain(cc, 'courier')
    await loopL.tick(snapAt(L.pos))
    await loopC.tick(snapAt(C.pos))
    drain(lc, 'liaison'); drain(cc, 'courier')
  }

  expect(guard).toBeLessThan(30)            // converged, did not spin out
  expect(lc.current()).toBeNull()           // Liaison tore down on SATISFIED
  expect(cc.current()).toBeNull()           // Courier tore down on the broadcast teardown
  expect(L.pos).toEqual({ x: 3, y: 0 })     // both ended inside the (radius-0) zone
  expect(C.pos).toEqual({ x: 3, y: 0 })
})
```

> **Note on the radius-0 target.** With `radius: 0` and both agents routed to the exact tile
> (3,0), the test asserts both reach it. Agents "can never share a tile" in the live game (§8.1),
> but this fake has no collision model — the test exercises the *protocol*, not tile occupancy.
> The HANDOFF/real-server work (follow-on) covers distinct-tile binding. If you prefer a
> distinct-tile assertion now, use `radius: 1` and target `(3,0)`: the Liaison stops at (2,0) on
> approach (d=1) and the Courier at (4,0) (d=1) — adjust the final `toEqual` checks accordingly.

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/contract-rendezvous-e2e.test.ts`
Expected: PASS (1 test)

- [ ] **Step 3: Run the full suite**

Run: `bun test tests/`
Expected: `All tests passed.`

- [ ] **Step 4: Commit**

```bash
git add tests/contract-rendezvous-e2e.test.ts
git commit -m "test(contract): §8.4 two-loop rendezvous e2e via relay routing"
```

---

## Done When (this slice)

A `rendezvousContract` proposed on one `ContractRuntime` and accepted by the other drives two
`BdiLoop`s — each reading only its own perception — into the shared zone, exchanges milestones
over the `'contract'` a2a channel, and both reach `SATISFIED` with the slot cleared on both
replicas, proven by `tests/contract-rendezvous-e2e.test.ts`. Base play is byte-for-byte
unchanged when no contract is active (`bun test tests/` stays green).

---

## Follow-on plans (the rest of §8)

1. **Handoff (§8.3)** — add `ACTION(putDown ids)` steps to `Step`/`advance`; runtime-bound drop +
   vacate + approach tiles with the three §8.3 binding rules; **§9.10 lock** by creating
   `origin:'MISSION'` claims (already honoured by `ClaimStore.expire`/`dropForeignAuctionClaims`
   and the auction) for the contract's referenced parcels, released on teardown.
2. **Sync-gate (§8.5)** — a `gate` flag on the shared view toggled from the Liaison's chat channel;
   the `GATE_STALE_TTL` close-latency fail-safe (move only if `OPEN` *and* fresh); gate scoping
   (armed only under an ACTIVE `SYNC_GATE`); partner-loss teardown that clears the gate.
3. **Lifecycle hardening (§8.6)** — barrier **deadlines** → `FAILED` teardown; commit timeout →
   `ABORTED`; **adoption gating** (`payoff > combined forgone base utility`) as the Liaison's
   propose-time decision; per-tick urgency keyed on the *next* barrier; opportunistic base-play
   pickups while blocked (§8.4). Reconcile the contract with the single mission slot (§4.3).
4. **Mission→contract bridge** — classify a `COORDINATION_CONTRACT` mission (compiler/§18) into a
   contract with `RUNTIME_BOUND` tiles bound from the map and roles from the §9.3 bid.
