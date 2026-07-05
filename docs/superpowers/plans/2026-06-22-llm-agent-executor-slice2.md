# §18 LLM-agent Step-List Executor (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a compiled `AGENT_PLAN` mission step-by-step on the Liaison's `BdiLoop`, with the full §17.7 plan lifecycle and off-loop re-planning on invalidation.

**Architecture:** A new pure module `src/mission/agent/executor.ts` holds the `PlanCursor` execution state and pure lifecycle helpers (re-validation, world signature, progress, blocking-tile). `BdiLoop.actAgentPlan()` consumes them the way `actContract` consumes the contract runtime: one step per tick via the existing `stepToward`/`doPickup`/`doDeliver` primitives. Invalidation / K_block / born-stale call a new `requestReplan` dep that re-submits `Mission.rawText` through the single-flight intake; a masked-tile set is threaded through the snapshot to the cost A\*.

**Tech Stack:** Bun + TypeScript strict (no `any`, ESM with `.js` relative-import suffix). Tests use `bun:test`. Logger is Pino (never `console.log`).

## Global Constraints

- `strict: true`, no `any`; use `unknown` + type guards at boundaries.
- ESM: every relative import ends in `.js`.
- `params.ts` has a three-place invariant: every new field appears in the `Params` interface, `DEFAULT_PARAMS`, AND `RANGES`.
- `kblock_max = 5` is pinned by DESIGN §17.7.4 (`K_block = 5 consecutive blocked retries`). `antiphantom_n = 8` and `suppress_ticks = 20` are placeholders, offline-calibratable (§16).
- The executor never lets the LLM touch the grid or the wire; it drives the LLM's already-emitted steps through the shared push-aware A\* and the existing move primitives (§18.1 invariant 7).
- The born-stale watcher signature MUST exclude what the plan mutates (own position, plan-target parcels), or the plan self-invalidates every tick (DESIGN ~L1488 / §17.8).
- Run the whole suite with `bun test`; type-check with `bunx tsc --noEmit`.

---

### Task 1: New executor params

**Files:**
- Modify: `src/bdi/params.ts` (interface ~L28-30, `DEFAULT_PARAMS` ~L56-58, `RANGES` ~L85-87)
- Test: `tests/bdi-params.test.ts`

**Interfaces:**
- Produces: `Params.kblock_max: number`, `Params.antiphantom_n: number`, `Params.suppress_ticks: number` (defaults 5 / 8 / 20).

- [ ] **Step 1: Write the failing test**

Add to `tests/bdi-params.test.ts`:

```ts
import { DEFAULT_PARAMS } from '../src/bdi/params.js'

test('executor params carry their slice-2 defaults', () => {
  expect(DEFAULT_PARAMS.kblock_max).toBe(5)
  expect(DEFAULT_PARAMS.antiphantom_n).toBe(8)
  expect(DEFAULT_PARAMS.suppress_ticks).toBe(20)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-params.test.ts`
Expected: FAIL — `kblock_max` is `undefined`.

- [ ] **Step 3: Add the three fields in all three places**

In the `Params` interface, after `batch_max: number`:

```ts
  kblock_max: number         // §17.7.4 consecutive blocked ticks before a masked re-plan
  antiphantom_n: number      // §17.7.4 no-progress ticks before suppressing the branch
  suppress_ticks: number     // §17.7.4 branch suppression duration (ticks)
```

In `DEFAULT_PARAMS`, after `batch_max: 6,`:

```ts
  kblock_max: 5,
  antiphantom_n: 8,
  suppress_ticks: 20,
```

In `RANGES`, after `batch_max: [1, 50],`:

```ts
  kblock_max: [1, 1000],
  antiphantom_n: [1, 1000],
  suppress_ticks: [1, 100000],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bdi-params.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/params.ts tests/bdi-params.test.ts
git commit -m "feat(params): add executor lifecycle params (kblock_max, antiphantom_n, suppress_ticks)"
```

---

### Task 2: Suppression field + uMission gate

**Files:**
- Modify: `src/mission/kinds.ts` (the `MissionDraft` interface, ~L80-91)
- Modify: `src/bdi/mission-intention.ts` (the `AGENT_PLAN` branch, ~L23-38)
- Test: `tests/mission-intention.test.ts`

**Interfaces:**
- Consumes: `Params.suppress_ticks` (Task 1).
- Produces: `MissionDraft.suppressedUntil?: number` (inherited by `Mission`); `uMission` returns `null` for an `AGENT_PLAN` while `suppressedUntil > tnow`.

- [ ] **Step 1: Write the failing test**

Add to `tests/mission-intention.test.ts` (the `planMission` factory at ~L61 already spreads `over`, so `suppressedUntil` passes through):

```ts
test('a suppressed AGENT_PLAN is withheld from the argmax', () => {
  // suppressedUntil in the future ⇒ null; in the past ⇒ candidate present again.
  const future = uMission(planMission({ suppressedUntil: 10 }), { x: 0, y: 0 }, planDist, 5, 100, DEFAULT_PARAMS)
  expect(future).toBeNull()
  const past = uMission(planMission({ suppressedUntil: 3 }), { x: 0, y: 0 }, planDist, 5, 100, DEFAULT_PARAMS)
  expect(past).not.toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-intention.test.ts`
Expected: FAIL — the suppressed mission is still a candidate (or a type error on `suppressedUntil`).

- [ ] **Step 3: Add the field**

In `src/mission/kinds.ts`, inside `interface MissionDraft`, after `plan?: AgentPlan`:

```ts
  suppressedUntil?: number // §17.7.4 executor anti-phantom: branch withheld from uMission until this tick
```

- [ ] **Step 4: Add the gate in uMission**

In `src/bdi/mission-intention.ts`, at the very top of the `if (mission.kind === 'AGENT_PLAN') {` block (before reading `plan`):

```ts
    if (mission.suppressedUntil !== undefined && mission.suppressedUntil > tnow) return null // §17.7.4 anti-phantom
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/mission-intention.test.ts`
Expected: PASS (all prior cases still green).

- [ ] **Step 6: Commit**

```bash
git add src/mission/kinds.ts src/bdi/mission-intention.ts tests/mission-intention.test.ts
git commit -m "feat(mission): anti-phantom suppression gate for AGENT_PLAN in uMission"
```

---

### Task 3: Executor pure helpers

**Files:**
- Create: `src/mission/agent/executor.ts`
- Test: `tests/agent-executor.test.ts`

**Interfaces:**
- Consumes: `AgentStep`, `AgentPlan`, `Mission` (`../kinds.js`); `WorldSnapshot`, `SnapParcel` (`./snapshot.js`); `Grid`, `PlanCtx`, `planPath`, `key`, type `Dir` (`../../planning/astar.js`); `Pos` (`../../types/perception.js`).
- Produces:
  - `interface PlanCursor { missionId: string; ptr: number; sigAtLanding: string; ticksNoProgress: number; blockedCount: number; lastDist: number; lastSelfPos: Pos; waitLeft: number | null }`
  - `manhattan(a: Pos, b: Pos): number`
  - `goalOf(step: AgentStep, snap: WorldSnapshot): Pos | null`
  - `worldSignature(snap: WorldSnapshot, plan: AgentPlan): string`
  - `revalidateStep(step: AgentStep, snap: WorldSnapshot, grid: Grid, ctx: PlanCtx): 'ok' | 'invalid'`
  - `progressed(ptrAdvanced: boolean, prevDist: number, curDist: number, isWaitTick: boolean): boolean`
  - `blockingTile(self: Pos, goal: Pos, grid: Grid, ctx: PlanCtx): Pos | null`
  - `freshCursor(mission: Mission, sig: string, snap: WorldSnapshot): PlanCursor`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-executor.test.ts`:

```ts
import { test, expect } from 'bun:test'
import {
  manhattan, goalOf, worldSignature, revalidateStep, progressed, blockingTile, freshCursor,
} from '../src/mission/agent/executor.js'
import { buildGrid } from '../src/planning/astar.js'
import type { PlanCtx } from '../src/planning/astar.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'
import type { AgentStep, Mission } from '../src/mission/kinds.js'
import type { Tile } from '../src/types/perception.js'

// 3x1 walkable row, delivery at (0,0).
const map: Tile[] = [
  { pos: { x: 0, y: 0 }, type: 'delivery' },
  { pos: { x: 1, y: 0 }, type: 'walkable' },
  { pos: { x: 2, y: 0 }, type: 'walkable' },
]
const grid = buildGrid(map)
const ctx: PlanCtx = { obstacles: { crateAt: new Map(), agentAt: new Set() }, protectedTiles: [], budgetMs: 8 }

const snap = (over: Partial<WorldSnapshot> = {}): WorldSnapshot => ({
  t0: 0, selfPos: { x: 2, y: 0 }, carried: [], delivered: [],
  parcels: [{ id: 'p1', pos: { x: 1, y: 0 }, reward: 10, carriedBy: null }],
  zones: [{ x: 0, y: 0 }], partnerPos: null, sig: 'x', ...over,
})

const plan = (steps: AgentStep[]) => ({ steps, L: 4, vPlan: 5 })
const mission = (steps: AgentStep[]): Mission => ({
  kind: 'AGENT_PLAN', payoff: 10, abstractIntent: 'x', params: {},
  id: 'm1', rawText: 'go', status: 'CLASSIFIED', plan: plan(steps),
})

test('manhattan + goalOf resolve each op', () => {
  expect(manhattan({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(2)
  expect(goalOf({ op: 'goto', target: { x: 1, y: 0 } }, snap())).toEqual({ x: 1, y: 0 })
  expect(goalOf({ op: 'pickup', parcelId: 'p1' }, snap())).toEqual({ x: 1, y: 0 })
  expect(goalOf({ op: 'deliver', zone: { x: 0, y: 0 } }, snap())).toEqual({ x: 0, y: 0 })
  expect(goalOf({ op: 'wait', n: 3 }, snap())).toBeNull()
})

test('worldSignature ignores self and plan-target parcels', () => {
  const p = plan([{ op: 'pickup', parcelId: 'p1' }])
  const a = worldSignature(snap({ selfPos: { x: 2, y: 0 } }), p)
  const b = worldSignature(snap({ selfPos: { x: 0, y: 0 } }), p) // self moved
  const c = worldSignature(snap({ parcels: [{ id: 'p1', pos: { x: 1, y: 0 }, reward: 10, carriedBy: 'self' }] }), p) // target picked
  expect(a).toBe(b)
  expect(a).toBe(c)
  // a NON-target parcel appearing DOES change the signature.
  const d = worldSignature(snap({ parcels: [
    { id: 'p1', pos: { x: 1, y: 0 }, reward: 10, carriedBy: null },
    { id: 'p2', pos: { x: 2, y: 0 }, reward: 5, carriedBy: null },
  ] }), p)
  expect(d).not.toBe(a)
})

test('revalidateStep flags each invalid case', () => {
  expect(revalidateStep({ op: 'goto', target: { x: 1, y: 0 } }, snap(), grid, ctx)).toBe('ok')
  // unreachable target (off-map) → invalid
  expect(revalidateStep({ op: 'goto', target: { x: 9, y: 9 } }, snap(), grid, ctx)).toBe('invalid')
  expect(revalidateStep({ op: 'pickup', parcelId: 'p1' }, snap(), grid, ctx)).toBe('ok')
  expect(revalidateStep({ op: 'pickup', parcelId: 'gone' }, snap(), grid, ctx)).toBe('invalid')
  const taken = snap({ parcels: [{ id: 'p1', pos: { x: 1, y: 0 }, reward: 10, carriedBy: 'enemy' }] })
  expect(revalidateStep({ op: 'pickup', parcelId: 'p1' }, taken, grid, ctx)).toBe('invalid')
  expect(revalidateStep({ op: 'deliver', zone: { x: 0, y: 0 } }, snap(), grid, ctx)).toBe('ok')
  expect(revalidateStep({ op: 'deliver', zone: { x: 1, y: 0 } }, snap(), grid, ctx)).toBe('invalid') // not a delivery tile
  expect(revalidateStep({ op: 'wait', n: 2 }, snap(), grid, ctx)).toBe('ok')
})

test('progressed: ptr advance, distance shrink, or wait-tick all count', () => {
  expect(progressed(true, 5, 5, false)).toBe(true)   // ptr advanced
  expect(progressed(false, 5, 4, false)).toBe(true)  // distance shrank
  expect(progressed(false, 5, 5, true)).toBe(true)   // wait tick
  expect(progressed(false, 5, 5, false)).toBe(false) // stalled
  expect(progressed(false, 5, 6, false)).toBe(false) // moved away
})

test('blockingTile returns the first planned tile toward the goal', () => {
  // self (2,0) -> goal (0,0): first step is left to (1,0).
  expect(blockingTile({ x: 2, y: 0 }, { x: 0, y: 0 }, grid, ctx)).toEqual({ x: 1, y: 0 })
  // already at goal → null
  expect(blockingTile({ x: 0, y: 0 }, { x: 0, y: 0 }, grid, ctx)).toBeNull()
})

test('freshCursor seeds ptr 0, zeroed counters, dist to first goal', () => {
  const c = freshCursor(mission([{ op: 'goto', target: { x: 0, y: 0 } }]), 'sig', snap())
  expect(c).toMatchObject({ missionId: 'm1', ptr: 0, sigAtLanding: 'sig', ticksNoProgress: 0, blockedCount: 0, waitLeft: null })
  expect(c.lastDist).toBe(2) // (2,0)->(0,0)
  expect(c.lastSelfPos).toEqual({ x: 2, y: 0 })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/agent-executor.test.ts`
Expected: FAIL — module `executor.js` not found.

- [ ] **Step 3: Implement `src/mission/agent/executor.ts`**

```ts
// §17.7 plan-lifecycle state + pure helpers for the AGENT_PLAN step-list executor (slice 2).
// No I/O: the BdiLoop owns the side-effecting moves; this module owns the decisions.

import { planPath, key, type Grid, type PlanCtx, type Dir } from '../../planning/astar.js'
import type { Pos } from '../../types/perception.js'
import type { AgentStep, AgentPlan, Mission } from '../kinds.js'
import type { WorldSnapshot } from './snapshot.js'

// Per-mission execution cursor. suppressedUntil lives on the Mission (it must outlive a null'd
// cursor so the uMission gate keeps holding the branch out of the argmax).
export interface PlanCursor {
  missionId: string
  ptr: number              // index of the current step
  sigAtLanding: string     // worldSignature when the plan landed (born-stale watcher §17.7.2-B)
  ticksNoProgress: number  // anti-phantom counter (§17.7.4)
  blockedCount: number     // consecutive ticks with no positional progress on a transit step (K_block)
  lastDist: number         // manhattan to the current step's goal last tick (progress = it shrank)
  lastSelfPos: Pos         // self position last tick (transit-stall detection)
  waitLeft: number | null  // remaining ticks of an in-progress wait step (null = not waiting)
}

export function manhattan(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

// The tile the agent is heading for this step. wait has no destination (null).
export function goalOf(step: AgentStep, snap: WorldSnapshot): Pos | null {
  switch (step.op) {
    case 'goto': return step.target
    case 'deliver': return step.zone
    case 'pickup': {
      const p = snap.parcels.find((q) => q.id === step.parcelId)
      return p ? p.pos : null
    }
    case 'wait': return null
  }
}

// Born-stale watcher signature: the world OUTSIDE the plan. Excludes own position and the
// parcels the plan references in pickup steps (those are tracked per-step by revalidateStep),
// so executing a step never self-invalidates the plan (DESIGN ~L1488 / §17.8).
export function worldSignature(snap: WorldSnapshot, plan: AgentPlan): string {
  const ref = new Set(plan.steps.filter((s): s is Extract<AgentStep, { op: 'pickup' }> => s.op === 'pickup').map((s) => s.parcelId))
  return [...snap.parcels]
    .filter((p) => !ref.has(p.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}:${p.pos.x},${p.pos.y}:${p.carriedBy ?? ''}`)
    .join('|')
}

// §17.7.2-D light prefix re-validation of the current step against live (snapshot) state.
export function revalidateStep(step: AgentStep, snap: WorldSnapshot, grid: Grid, ctx: PlanCtx): 'ok' | 'invalid' {
  switch (step.op) {
    case 'goto': {
      const res = planPath(grid, ctx, snap.selfPos, step.target)
      // timedOut is a budget cap, NOT proof of unreachability (§15.3) — do not invalidate on it.
      return res.reachable || res.timedOut ? 'ok' : 'invalid'
    }
    case 'pickup': {
      const p = snap.parcels.find((q) => q.id === step.parcelId)
      if (p === undefined) return 'invalid'
      if (p.carriedBy !== null && p.carriedBy !== 'self') return 'invalid'
      return 'ok'
    }
    case 'deliver':
      return grid.deliveryZones.some((z) => z.x === step.zone.x && z.y === step.zone.y) ? 'ok' : 'invalid'
    case 'wait':
      return 'ok'
  }
}

// Leg-granularity progress (§17.7.4): a ptr advance, a shrinking distance to the next
// waypoint, or a counting-down wait all count as progress.
export function progressed(ptrAdvanced: boolean, prevDist: number, curDist: number, isWaitTick: boolean): boolean {
  return ptrAdvanced || curDist < prevDist || isWaitTick
}

const ahead = (p: Pos, dir: Dir): Pos => {
  if (dir === 'up') return { x: p.x, y: p.y + 1 }
  if (dir === 'down') return { x: p.x, y: p.y - 1 }
  if (dir === 'left') return { x: p.x - 1, y: p.y }
  return { x: p.x + 1, y: p.y }
}

// The first planned tile toward the goal — the tile to mask on a K_block re-plan (§17.7.4).
// null if already at the goal or no path exists.
export function blockingTile(self: Pos, goal: Pos, grid: Grid, ctx: PlanCtx): Pos | null {
  const res = planPath(grid, ctx, self, goal)
  if (res.firstStep === null) return null
  return ahead(self, res.firstStep.dir)
}

export function freshCursor(mission: Mission, sig: string, snap: WorldSnapshot): PlanCursor {
  const step = mission.plan!.steps[0]
  const goal = step ? goalOf(step, snap) : null
  return {
    missionId: mission.id,
    ptr: 0,
    sigAtLanding: sig,
    ticksNoProgress: 0,
    blockedCount: 0,
    lastDist: goal ? manhattan(snap.selfPos, goal) : 0,
    lastSelfPos: snap.selfPos,
    waitLeft: null,
  }
}

// Exported only so callers can reference the obstacle-key form when masking tiles.
export { key as tileKey }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/agent-executor.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Type-check**

Run: `bunx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/mission/agent/executor.ts tests/agent-executor.test.ts
git commit -m "feat(agent): PlanCursor + pure §17.7 lifecycle helpers"
```

---

### Task 4: Masked-tile threading (snapshot + cost)

**Files:**
- Modify: `src/mission/agent/snapshot.ts` (`WorldSnapshot` interface ~L10-19)
- Modify: `src/mission/agent/wire.ts` (`snapshotFromBeliefs` ~L41-53)
- Modify: `src/mission/agent/cost.ts` (`emptyCtx` ~L13-17, `costPlan` ~L25)
- Test: `tests/agent-cost.test.ts`, `tests/agent-wire.test.ts`

**Interfaces:**
- Consumes: `WorldSnapshot`, `SnapParcel`, `beliefSignature` (`./snapshot.js`); `key` (`../../planning/astar.js`).
- Produces:
  - `WorldSnapshot.maskTiles?: Pos[]` (tiles to treat as obstacles in the cost A\*).
  - `snapshotFromBeliefs(bb, zones, tnow, maskTiles?)` — new optional 4th param, stored on the snapshot.
  - `costPlan` reads `snap.maskTiles` into the plan context's `agentAt` obstacle set.

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent-cost.test.ts` (it already builds a fixture grid + snapshot — reuse that grid; `costPlan` signature is `(steps, grid, snap, tnow, dc, budgetMs)`):

```ts
test('a masked tile forces a detour in L (or makes a 1-wide corridor unreachable)', () => {
  // Reuse this file's existing `grid`, `dc`, and snapshot factory. Place the only path tile under
  // a mask so the straight goto leg is no longer free. (Adapt coords to the local fixture grid.)
  const steps = [{ op: 'goto', target: FAR_TILE }] as const
  const free = costPlan([...steps], grid, makeSnap(), 0, dc, 8)
  const masked = costPlan([...steps], grid, makeSnap({ maskTiles: [CHOKE_TILE] }), 0, dc, 8)
  expect(masked.L).toBeGreaterThanOrEqual(free.L) // detour never cheaper; unreachable ⇒ Infinity
})
```

> Implementer note: `FAR_TILE` / `CHOKE_TILE` / `makeSnap` are the existing fixture's tiles and snapshot builder in `tests/agent-cost.test.ts`. If the existing fixture has no choke point, add a 2-row fixture so a detour exists (mirror `dodgeMap` in `tests/bdi-loop-mission.test.ts`): mask the straight-line tile and assert the masked `L` is strictly greater than the free `L`.

Add to `tests/agent-wire.test.ts`:

```ts
test('snapshotFromBeliefs stores maskTiles (empty/absent ⇒ undefined)', () => {
  // Reuse this file's belief-base + zones fixture.
  const withMask = snapshotFromBeliefs(bb, zones, 0, [{ x: 1, y: 1 }])
  expect(withMask.maskTiles).toEqual([{ x: 1, y: 1 }])
  const without = snapshotFromBeliefs(bb, zones, 0)
  expect(without.maskTiles).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/agent-cost.test.ts tests/agent-wire.test.ts`
Expected: FAIL — `maskTiles` is not a known property / not honoured.

- [ ] **Step 3: Add `maskTiles` to `WorldSnapshot`**

In `src/mission/agent/snapshot.ts`, inside `interface WorldSnapshot`, after `sig: string`:

```ts
  maskTiles?: Pos[] // §17.7.4 K_block: tiles the cost A* must treat as blocked on a re-plan
```

- [ ] **Step 4: Thread `maskTiles` through `snapshotFromBeliefs`**

In `src/mission/agent/wire.ts`, change the signature and the returned object:

```ts
export function snapshotFromBeliefs(bb: BeliefBase, zones: Pos[], tnow: number, maskTiles?: Pos[]): WorldSnapshot {
```

and in the returned object literal, after `parcels, zones, partnerPos, sig: beliefSignature(parcels, selfPos),`:

```ts
    maskTiles,
```

- [ ] **Step 5: Honour `snap.maskTiles` in `costPlan`**

In `src/mission/agent/cost.ts`, replace `emptyCtx` and its single call site so the mask becomes obstacles:

```ts
import { planPath, key, type Grid, type PlanCtx } from '../../planning/astar.js'

const planCtxFor = (budgetMs: number, maskTiles?: Pos[]): PlanCtx => ({
  obstacles: { crateAt: new Map(), agentAt: new Set((maskTiles ?? []).map((t) => key(t))) }, // enemies not modelled (§17.7.4); masked tiles blocked (§17.7.4 K_block)
  protectedTiles: [],
  budgetMs,
})
```

Then in `costPlan`, replace `const ctx = emptyCtx(budgetMs)` with:

```ts
  const ctx = planCtxFor(budgetMs, snap.maskTiles)
```

(Delete the old `emptyCtx` definition and add `key` to the `astar.js` import as shown.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/agent-cost.test.ts tests/agent-wire.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check + commit**

Run: `bunx tsc --noEmit` → exit 0.

```bash
git add src/mission/agent/snapshot.ts src/mission/agent/wire.ts src/mission/agent/cost.ts tests/agent-cost.test.ts tests/agent-wire.test.ts
git commit -m "feat(agent): thread maskTiles into snapshot + cost A* for K_block re-plan"
```

---

### Task 5: BdiLoop.actAgentPlan + dispatch + requestReplan dep

**Files:**
- Modify: `src/bdi/loop.ts` (constructor `mission` dep type ~L48; `act()` mission branch ~L468-478; add `planCursor` field ~L36; add `actAgentPlan` method)
- Test: `tests/bdi-loop-agent-plan.test.ts` (new)

**Interfaces:**
- Consumes: everything from `executor.ts` (Task 3); `snapshotFromBeliefs` (`../mission/agent/wire.js`); `Params` executor fields (Task 1); `Mission.suppressedUntil` (Task 2).
- Produces: a new optional mission dep `requestReplan?: (rawText: string, maskTiles?: Pos[]) => void`; `BdiLoop.actAgentPlan` drives the committed `AGENT_PLAN`.

- [ ] **Step 1: Write the failing tests**

Create `tests/bdi-loop-agent-plan.test.ts` (mirror `tests/bdi-loop-mission.test.ts`'s `fakeClient`/`rowMap`/`snap` harness — copy those helpers verbatim into this file):

```ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import type { Mission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}
interface Recorder { moves: string[]; putdowns: string[][]; picks: number; client: DeliverooClient }
function fakeClient(map: Tile[]): Recorder {
  const rec: Recorder = { moves: [], putdowns: [], picks: 0, client: null as never }
  rec.client = {
    role: 'liaison', consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => { rec.picks++; return [{ id: 'p1' }] },
    putdown: async (ids?: string[]): Promise<PickResult[]> => { rec.putdowns.push(ids ?? []); return (ids ?? []).map((id) => ({ id })) },
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}
const log = { info: () => {}, debug: () => {}, warn: () => {} }

// self at (1,0); one parcel p1 at (3,0).
const snap = (selfX = 1): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: selfX, y: 0 }, score: 0 },
  parcels: [{ id: 'p1', pos: { x: 3, y: 0 }, reward: 50, carriedBy: null }],
  agents: [], crates: [],
})

const planMission = (steps: Mission['plan'] extends infer _ ? never : never) => steps // placeholder removed below
const makePlan = (): Mission => ({
  kind: 'AGENT_PLAN', payoff: 100, abstractIntent: 'fetch p1 to zone', params: {},
  id: 'ap-1', rawText: 'fetch the parcel and deliver', status: 'CLASSIFIED',
  plan: {
    steps: [
      { op: 'goto', target: { x: 3, y: 0 } },
      { op: 'pickup', parcelId: 'p1' },
      { op: 'goto', target: { x: 0, y: 0 } },
      { op: 'deliver', zone: { x: 0, y: 0 } },
    ],
    L: 6, vPlan: 20,
  },
})

test('AGENT_PLAN executor moves toward the first goto target', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView(); view.set(makePlan())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true })
  await loop.tick(snap(1)) // self (1,0), target (3,0) → step right
  expect(rec.moves).toEqual(['right'])
})

test('on the pickup step at the parcel tile the executor picks up', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView(); view.set(makePlan())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true })
  // first tick at (3,0): goto-target reached → ptr advances to pickup; same tick is fine to just arrive.
  await loop.tick(snap(3))
  // second tick still at (3,0): now on the pickup step → pickup fires.
  await loop.tick(snap(3))
  expect(rec.picks).toBeGreaterThanOrEqual(1)
})

test('an invalid pickup step (parcel gone) requests a re-plan with rawText', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  // plan whose current step pickups a parcel that is absent from perception
  const m = makePlan(); m.plan!.steps = [{ op: 'pickup', parcelId: 'ghost' }]
  view.set(m)
  const calls: Array<{ raw: string; mask?: Pos[] }> = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, {
    view, pursue: true, requestReplan: (raw, mask) => calls.push({ raw, mask }),
  })
  await loop.tick(snap(1))
  expect(calls).toHaveLength(1)
  expect(calls[0]!.raw).toBe('fetch the parcel and deliver')
})

test('completing the last step fires onSatisfied', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  const m = makePlan(); m.plan!.steps = [{ op: 'deliver', zone: { x: 0, y: 0 } }]
  view.set(m)
  let satisfied = 0
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, {
    view, pursue: true, onSatisfied: () => { satisfied++ },
  })
  // self at (0,0) carrying nothing: deliver on the zone, ptr reaches end → onSatisfied
  await loop.tick({ ...snap(0), self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 0, y: 0 }, score: 0 } })
  expect(satisfied).toBe(1)
})
```

> Implementer note: delete the dead `planMission` placeholder line — it is a leftover; use only `makePlan`. Adjust the exact tick-count in the pickup test if the loop's arrive-then-act cadence differs; the assertion is "a pickup eventually fires while standing on the parcel".

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/bdi-loop-agent-plan.test.ts`
Expected: FAIL — the AGENT_PLAN mission takes no action (current `act()` returns on the missing `targetTile`).

- [ ] **Step 3: Add the `requestReplan` dep + `planCursor` field**

In `src/bdi/loop.ts`, extend the constructor's `mission` parameter type (currently `{ view: TeamMissionView; pursue: boolean; onSatisfied?: () => void; contracts?: ContractRuntime }`) with:

```ts
    private readonly mission?: { view: TeamMissionView; pursue: boolean; onSatisfied?: () => void; contracts?: ContractRuntime; requestReplan?: (rawText: string, maskTiles?: Pos[]) => void },
```

Add the import near the other agent imports at the top of the file:

```ts
import { snapshotFromBeliefs } from '../mission/agent/wire.js'
import { freshCursor, goalOf, manhattan, progressed, revalidateStep, worldSignature, blockingTile, type PlanCursor } from '../mission/agent/executor.js'
```

Add a field beside `private committed`:

```ts
  private planCursor: PlanCursor | null = null
```

- [ ] **Step 4: Dispatch AGENT_PLAN from `act()`**

In `src/bdi/loop.ts`, in `act()`, replace the `else if (chosen.kind === 'mission') {` block body so AGENT_PLAN routes to the executor:

```ts
    } else if (chosen.kind === 'mission') {
      if (chosen.mission.kind === 'AGENT_PLAN') {
        await this.actAgentPlan(chosen.mission, beliefs, ctx, tnow)
        return
      }
      const t = chosen.mission.params.targetTile
      // uMission only emits a CANDIDATE_INTENTION candidate for a TEXT_BOUND target, so this is safe.
      if (t === undefined || t.tag !== 'TEXT_BOUND') return
      const target: Pos = { x: t.x, y: t.y }
      if (self.x === target.x && self.y === target.y) {
        this.mission?.onSatisfied?.()
        return
      }
      await this.stepToward(beliefs, ctx, self, target)
      return
    } else {
```

- [ ] **Step 5: Implement `actAgentPlan`**

Add this method to `BdiLoop` (e.g. right after `actContract`):

```ts
  // §17.7 step-list executor: drive the committed AGENT_PLAN one step per tick. Invalidation,
  // K_block, born-stale → request an off-loop re-plan (the slot is single-flight); anti-phantom
  // → suppress the branch. Liaison-local this slice (not broadcast).
  private async actAgentPlan(mission: Mission, beliefs: BeliefBase, ctx: PlanCtx, tnow: number): Promise<void> {
    const plan = mission.plan
    if (plan === undefined) return
    const snap = snapshotFromBeliefs(beliefs, this.grid.deliveryZones, tnow)
    const sigNow = worldSignature(snap, plan)

    if (this.planCursor === null || this.planCursor.missionId !== mission.id) {
      this.planCursor = freshCursor(mission, sigNow, snap)
    }
    const cur = this.planCursor
    const step = plan.steps[cur.ptr]
    if (step === undefined) { this.mission?.onSatisfied?.(); this.planCursor = null; return }

    // §17.7.2-B/D: born-stale (world outside the plan moved) or current step invalid → re-plan.
    if (sigNow !== cur.sigAtLanding || revalidateStep(step, snap, this.grid, ctx) === 'invalid') {
      this.planCursor = null
      this.mission?.requestReplan?.(mission.rawText)
      this.log.info({ tick: tnow, missionId: mission.id }, 'agent-plan re-plan (stale/invalid)')
      return
    }

    const self = snap.selfPos
    let ptrAdvanced = false
    let isWaitTick = false

    if (step.op === 'goto') {
      if (self.x === step.target.x && self.y === step.target.y) { cur.ptr++; ptrAdvanced = true }
      else await this.stepToward(beliefs, ctx, self, step.target)
    } else if (step.op === 'pickup') {
      const p = snap.parcels.find((q) => q.id === step.parcelId)
      const at = p && self.x === p.pos.x && self.y === p.pos.y
      if (at) { await this.doPickup(beliefs, tnow); cur.ptr++; ptrAdvanced = true }
      else if (p) await this.stepToward(beliefs, ctx, self, p.pos)
    } else if (step.op === 'deliver') {
      if (self.x === step.zone.x && self.y === step.zone.y) { await this.doDeliver(beliefs, step.zone, tnow); cur.ptr++; ptrAdvanced = true }
      else await this.stepToward(beliefs, ctx, self, step.zone)
    } else { // wait
      if (cur.waitLeft === null) cur.waitLeft = step.n
      cur.waitLeft--
      isWaitTick = true
      if (cur.waitLeft <= 0) { cur.ptr++; cur.waitLeft = null; ptrAdvanced = true }
    }

    // Progress bookkeeping (§17.7.4). Distance is to the (possibly new) current step's goal.
    const nextStep = plan.steps[cur.ptr]
    const goal = nextStep ? goalOf(nextStep, snap) : null
    const curDist = goal ? manhattan(self, goal) : 0
    const moved = self.x !== cur.lastSelfPos.x || self.y !== cur.lastSelfPos.y
    if (progressed(ptrAdvanced, cur.lastDist, curDist, isWaitTick)) { cur.ticksNoProgress = 0 }
    else cur.ticksNoProgress++
    // transit stall: a move-bearing step that did not change position
    const transit = (step.op === 'goto' || step.op === 'pickup' || step.op === 'deliver') && !ptrAdvanced
    if (transit && !moved) cur.blockedCount++
    else cur.blockedCount = 0
    cur.lastDist = curDist
    cur.lastSelfPos = self

    // K_block: mask the blocking tile and re-plan (§17.7.4).
    if (cur.blockedCount >= this.params.kblock_max) {
      const g = goalOf(step, snap)
      const mask = g ? blockingTile(self, g, this.grid, ctx) : null
      this.planCursor = null
      this.mission?.requestReplan?.(mission.rawText, mask ? [mask] : undefined)
      this.log.info({ tick: tnow, missionId: mission.id, mask }, 'agent-plan re-plan (K_block)')
      return
    }
    // anti-phantom: suppress the branch for suppress_ticks (§17.7.4).
    if (cur.ticksNoProgress >= this.params.antiphantom_n) {
      mission.suppressedUntil = tnow + this.params.suppress_ticks
      this.planCursor = null
      this.log.info({ tick: tnow, missionId: mission.id, until: mission.suppressedUntil }, 'agent-plan suppressed (anti-phantom)')
      return
    }
    // plan complete
    if (cur.ptr >= plan.steps.length) { this.mission?.onSatisfied?.(); this.planCursor = null }
  }
```

Add the `Mission` type import if not already present (it is used by `uMission` wiring; confirm `import type { Mission } from '../mission/kinds.js'` exists — `loop.ts` already imports `Mission`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/bdi-loop-agent-plan.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Full suite + type-check**

Run: `bun test` → all pass. Run: `bunx tsc --noEmit` → exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/bdi/loop.ts tests/bdi-loop-agent-plan.test.ts
git commit -m "feat(bdi): AGENT_PLAN step-list executor with §17.7 lifecycle"
```

---

### Task 6: Liaison wiring — requestReplan via single-flight intake

**Files:**
- Modify: `src/agents/liaison.ts` (the `missionCompile`/`snapshot` wiring ~L55-95)
- Test: `tests/agent-wire.test.ts` (add a focused re-plan-requester test)

**Interfaces:**
- Consumes: `intake.onMessage` (single-flight); `snapshotFromBeliefs(bb, zones, tnow, maskTiles?)` (Task 4); the loop's `requestReplan` dep (Task 5).
- Produces: a `makeReplanRequester(intake, setMask)` helper in `src/mission/agent/wire.ts` and its use in `liaison.ts`; the Liaison's `snapshot()` closure consumes a one-shot pending mask.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent-wire.test.ts`:

```ts
import { makeReplanRequester } from '../src/mission/agent/wire.js'

test('makeReplanRequester sets the pending mask then submits rawText once', () => {
  const submitted: string[] = []
  let mask: Pos[] | undefined
  const requestReplan = makeReplanRequester(
    (raw: string) => submitted.push(raw),
    (m?: Pos[]) => { mask = m },
  )
  requestReplan('fetch the parcel', [{ x: 2, y: 2 }])
  expect(mask).toEqual([{ x: 2, y: 2 }])
  expect(submitted).toEqual(['fetch the parcel'])
  // no mask → mask cleared
  requestReplan('again')
  expect(mask).toBeUndefined()
  expect(submitted).toEqual(['fetch the parcel', 'again'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-wire.test.ts`
Expected: FAIL — `makeReplanRequester` not exported.

- [ ] **Step 3: Add `makeReplanRequester` to `wire.ts`**

In `src/mission/agent/wire.ts`, add:

```ts
// The re-plan requester the BdiLoop calls on invalidation/K_block (§17.7). It stages the
// (one-shot) mask the snapshot builder will read, then re-submits the original rawText through
// the single-flight intake — which aborts/supersedes any in-flight compile (§17.7.1).
export function makeReplanRequester(
  submit: (raw: string) => void,
  setMask: (maskTiles?: Pos[]) => void,
): (rawText: string, maskTiles?: Pos[]) => void {
  return (rawText, maskTiles) => {
    setMask(maskTiles)
    submit(rawText)
  }
}
```

- [ ] **Step 4: Wire it into `liaison.ts`**

In `src/agents/liaison.ts`, add a one-shot pending-mask cell beside the other locals (near `let tnow = 0`):

```ts
  let pendingMask: Pos[] | undefined
```

Add the `Pos` import to the existing type imports:

```ts
import type { Pos } from '../types/perception.js'
```

Change the `snapshot` closure inside `makeMissionCompile({...})` to consume the one-shot mask:

```ts
    snapshot: () => {
      if (grid === null || beliefs === null) return null
      const snap = snapshotFromBeliefs(beliefs, grid.deliveryZones, tnow, pendingMask)
      pendingMask = undefined // one-shot: the mask applies only to the re-plan it was set for
      return snap
    },
```

Build the requester after `intake` is created (it needs `intake.onMessage`), and pass it into the loop's mission deps. Replace the `BdiLoop` construction's mission-deps object so it includes `requestReplan`:

```ts
  const requestReplan = makeReplanRequester(
    (raw) => intake.onMessage('self', raw),
    (m) => { pendingMask = m },
  )

  const loop = new BdiLoop(client, params, {
    info: (obj, msg) => log!.info(obj as object, msg),
    debug: (obj, msg) => log!.debug(obj as object, msg),
    warn: (obj, msg) => log!.warn(obj as object, msg),
  }, claims, {
    partner: 'courier',
    send,
  }, {
    view: missionView,
    pursue: true,
    onSatisfied: () => missionSlot.supersede(),
    contracts,
    requestReplan,
  })
```

Add `makeReplanRequester` to the existing wire import:

```ts
import { makeMissionCompile, snapshotFromBeliefs, makeReplanRequester } from '../mission/agent/wire.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/agent-wire.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite + type-check**

Run: `bun test` → all pass. Run: `bunx tsc --noEmit` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/mission/agent/wire.ts src/agents/liaison.ts tests/agent-wire.test.ts
git commit -m "feat(liaison): wire requestReplan through the single-flight intake with one-shot mask"
```

---

## Self-Review notes (plan author)

- **Spec coverage:** PlanCursor + helpers (T3) ✓; actAgentPlan driver with goto/pickup/deliver/wait, prefix re-validation, born-stale, anti-phantom, K_block (T5) ✓; suppression gate in uMission (T2) ✓; off-loop re-plan via single-flight intake (T6) ✓; masked-tile threading (T4) ✓; new params (T1) ✓; per-tick snapshot consistency (T5: one `snapshotFromBeliefs` per tick) ✓; `worldSignature` excludes self + plan-target parcels (T3) ✓.
- **Type consistency:** `snapshotFromBeliefs(bb, zones, tnow, maskTiles?)`, `WorldSnapshot.maskTiles?`, `PlanCursor` fields, and `requestReplan?: (rawText, maskTiles?) => void` are used identically across T4/T5/T6.
- **Known small risk handed to implementer:** the exact tick cadence in the T5 pickup test (arrive-then-act) may need a tick added; the assertion is intentionally "a pickup eventually fires", not an exact count.
- **Out of scope (unchanged):** multi-agent assignment/broadcast, Strategy/Coordination tool families, PDDL, and the slice-1 follow-ups (`cost.ts` multi-zone valuation, `snap.carried`, `route_cost`).
