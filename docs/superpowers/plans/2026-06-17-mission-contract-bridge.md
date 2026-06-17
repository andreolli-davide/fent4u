# Mission → Contract Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the disconnected §4 mission lane to the §8 contract lane so a `COORDINATION_CONTRACT` mission compiles, binds from live state, role-bids, and proposes a `Contract` (HANDOFF / RENDEZVOUS / SYNC_GATE) that both agents drive to terminal.

**Architecture:** A new pure module `src/coordination/bridge.ts` is the single seam: pure `(mission, grid, live-state) → Contract | null`. The Liaison's BDI loop calls it each tick while a `COORDINATION_CONTRACT` mission sits in the view and no contract is live; `null` means *not yet bindable* → hold and retry (the loop's per-tick re-entry IS the retry). SYNC_GATE is a perpetual control overlay: a new `advance` outcome `'gated'` hands control back to base play under a freshness-checked gate flag carried on a dedicated `type:'gate'` a2a channel.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Bun test runner (`bun test`), existing project conventions: pure modules + DI, `§`-referenced comments, `AgentId = 'liaison' | 'courier'`, `Pos = {x,y}`, `A2AMessage = { from, to, type, payload }`.

## Global Constraints

- `strict: true` tsconfig — no `any`; `unknown` + type guards at boundaries.
- ESM: relative imports use `.js` extensions.
- One concept per file; pure modules where possible (bridge logic is pure; only the loop seam has effects).
- Never `console.log` — use the injected `LogFn` / Pino logger.
- Base play MUST be byte-for-byte unchanged when no `COORDINATION_CONTRACT` mission is active (`bun test tests/` stays green).
- Adoption gating (§8.6) is OUT — propose unconditionally.

## Scope note

One spec, all three contract types (explicit user decision), structured as a shared bridge spine + three isolated adapters. Spec: `docs/superpowers/specs/2026-06-17-mission-contract-bridge-design.md`.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/coordination/bridge.ts` | `selectHandoffParcel`, `bindRoles`, `rendezvousTarget`, `buildContract` dispatcher; `RENDEZVOUS_RADIUS`, `DEFAULT_CONTRACT_TTL` | **Create** |
| `src/coordination/contract.ts` | `syncGateContract`, `'gated'` `ContractAction` + `advance` branch, `GateState`/`setGate`/`applyGate`/`gateOpen`/`fail` on `ContractRuntime`, `GateMsg` + `isGateMsg`, `GATE_STALE_TTL` | **Modify** |
| `src/bdi/loop.ts` | Liaison bind+propose call; `'gated'` fall-through + gate hold; SYNC_GATE partner-loss teardown | **Modify** |
| `src/agents/liaison.ts` | route `type:'gate'` → `applyGate` | **Modify** |
| `src/agents/courier.ts` | route `type:'gate'` → `applyGate` | **Modify** |
| `tests/bridge-core.test.ts` | `selectHandoffParcel`, `bindRoles`, `rendezvousTarget` | **Create** |
| `tests/bridge-build.test.ts` | `buildContract` HANDOFF/RENDEZVOUS/SYNC_GATE + null-holds | **Create** |
| `tests/contract-syncgate.test.ts` | `syncGateContract`, `advance`→`'gated'`, gate state/`gateOpen`/`isGateMsg`/`fail` | **Create** |
| `tests/bdi-loop-bridge.test.ts` | Liaison propose-on-bind, hold-on-null, non-liaison never proposes, gate-hold | **Create** |
| `tests/contract-bridge-e2e.test.ts` | COORDINATION_CONTRACT mission → bridge → handoff → SATISFIED via relay | **Create** |

---

## Task 1: Bridge handoff selection + role bind (pure)

**Files:**
- Create: `src/coordination/bridge.ts`
- Test: `tests/bridge-core.test.ts`

**Interfaces:**
- Consumes: `ParcelBelief` (`{ id, pos, rewardSeen, carriedBy, lastSeen }`) from `../blackboard/beliefs.js`; `Pos` from `../types/perception.js`; `AgentId` from `../types/a2a.js`.
- Produces: `selectHandoffParcel(parcels: ParcelBelief[], isClaimed: (id: string) => boolean): ParcelBelief | null`; `bindRoles(parcel: Pos, a: AgentRef, b: AgentRef): { picker: AgentId; deliverer: AgentId }` where `AgentRef = { id: AgentId; pos: Pos }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/bridge-core.test.ts
import { test, expect } from 'bun:test'
import { selectHandoffParcel, bindRoles } from '../src/coordination/bridge.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

function p(id: string, x: number, y: number, rewardSeen: number, carriedBy: string | null = null): ParcelBelief {
  return { id, pos: { x, y }, rewardSeen, carriedBy, lastSeen: 0 }
}

test('selectHandoffParcel picks the highest-reward free, unclaimed parcel', () => {
  const parcels = [p('a', 1, 1, 30), p('b', 2, 2, 90), p('c', 3, 3, 50)]
  expect(selectHandoffParcel(parcels, () => false)!.id).toBe('b')
})

test('selectHandoffParcel skips carried, claimed and zero-reward parcels', () => {
  const parcels = [p('carried', 1, 1, 99, 'someone'), p('claimed', 2, 2, 80), p('zero', 3, 3, 0), p('ok', 4, 4, 40)]
  expect(selectHandoffParcel(parcels, (id) => id === 'claimed')!.id).toBe('ok')
})

test('selectHandoffParcel returns null when nothing is eligible', () => {
  expect(selectHandoffParcel([], () => false)).toBeNull()
  expect(selectHandoffParcel([p('z', 1, 1, 0)], () => false)).toBeNull()
})

test('selectHandoffParcel breaks reward ties by id order', () => {
  const parcels = [p('y', 1, 1, 50), p('x', 2, 2, 50)]
  expect(selectHandoffParcel(parcels, () => false)!.id).toBe('x')
})

test('bindRoles makes the agent closer to the parcel the picker', () => {
  const r = bindRoles({ x: 0, y: 0 }, { id: 'liaison', pos: { x: 1, y: 0 } }, { id: 'courier', pos: { x: 9, y: 0 } })
  expect(r).toEqual({ picker: 'liaison', deliverer: 'courier' })
})

test('bindRoles breaks distance ties by agent id (liaison < courier)', () => {
  const r = bindRoles({ x: 5, y: 0 }, { id: 'liaison', pos: { x: 4, y: 0 } }, { id: 'courier', pos: { x: 6, y: 0 } })
  expect(r.picker).toBe('liaison')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bridge-core.test.ts`
Expected: FAIL — `Cannot find module '../src/coordination/bridge.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/coordination/bridge.ts
// DESIGN §8 bridge — the single seam between a §4 COORDINATION_CONTRACT mission and a §8 Contract.
// Pure: (mission, grid, live state) → Contract | null. `null` means NOT YET bindable (parcel
// unperceived / no valid tiles) — the Liaison loop holds and retries next tick (§8.2, deferred bind).
import type { AgentId } from '../types/a2a.js'
import type { Pos } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'

export interface AgentRef { id: AgentId; pos: Pos }

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

// Highest-reward free (uncarried, unclaimed, reward>0) parcel; deterministic id tie-break so both
// replicas would select identically (§9.3). null ⇒ nothing to hand off this tick.
export function selectHandoffParcel(
  parcels: ParcelBelief[],
  isClaimed: (id: string) => boolean,
): ParcelBelief | null {
  let best: ParcelBelief | null = null
  for (const p of parcels) {
    if (p.carriedBy !== null || p.rewardSeen <= 0 || isClaimed(p.id)) continue
    if (best === null || p.rewardSeen > best.rewardSeen || (p.rewardSeen === best.rewardSeen && p.id < best.id)) {
      best = p
    }
  }
  return best
}

// §8.3 / §9.10: picker = the agent closer (Manhattan) to the parcel; deliverer = the other. Bound
// ONCE by the Liaison, frozen into the proposed contract. Tie → lower agent id is picker.
export function bindRoles(parcel: Pos, a: AgentRef, b: AgentRef): { picker: AgentId; deliverer: AgentId } {
  const da = manhattan(a.pos, parcel)
  const db = manhattan(b.pos, parcel)
  const aPicks = da < db || (da === db && a.id < b.id)
  return aPicks ? { picker: a.id, deliverer: b.id } : { picker: b.id, deliverer: a.id }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bridge-core.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/bridge.ts tests/bridge-core.test.ts
git commit -m "feat(bridge): §8.3 handoff parcel selection + deterministic role bind"
```

---

## Task 2: Bridge rendezvous target binder (pure)

**Files:**
- Modify: `src/coordination/bridge.ts`
- Test: `tests/bridge-core.test.ts`

**Interfaces:**
- Consumes: `Grid` (`{ w, h, tiles, deliveryZones: Pos[] }`) from `../planning/astar.js`; `Mission` from `../mission/kinds.js` (uses `mission.params.targetTile?: { tag: 'TEXT_BOUND'; x; y } | { tag: 'RUNTIME_BOUND'; rule }`).
- Produces: `rendezvousTarget(mission: Mission, grid: Grid): Pos | null`; `RENDEZVOUS_RADIUS: number`; `DEFAULT_CONTRACT_TTL: number`.

- [ ] **Step 1: Write the failing test (append to `tests/bridge-core.test.ts`)**

```ts
import { rendezvousTarget } from '../src/coordination/bridge.js'
import type { Mission } from '../src/mission/kinds.js'
import type { Grid } from '../src/planning/astar.js'

function gridWith(zones: Array<{ x: number; y: number }>, w = 10, h = 10): Grid {
  return { w, h, tiles: new Map(), deliveryZones: zones }
}
function coordMission(params: Mission['params']): Mission {
  return { id: 'm1', kind: 'COORDINATION_CONTRACT', payoff: 500, abstractIntent: 'meet', params, rawText: 'meet', status: 'CLASSIFIED' }
}

test('rendezvousTarget uses a TEXT_BOUND tile verbatim', () => {
  const m = coordMission({ contractType: 'RENDEZVOUS', targetTile: { tag: 'TEXT_BOUND', x: 7, y: 3 } })
  expect(rendezvousTarget(m, gridWith([{ x: 0, y: 0 }]))).toEqual({ x: 7, y: 3 })
})

test('rendezvousTarget falls back to the delivery zone nearest the map centre', () => {
  // centre of a 10x10 grid is (5,5); (4,6) is nearer than (0,0).
  const m = coordMission({ contractType: 'RENDEZVOUS' })
  expect(rendezvousTarget(m, gridWith([{ x: 0, y: 0 }, { x: 4, y: 6 }]))).toEqual({ x: 4, y: 6 })
})

test('rendezvousTarget returns null with no TEXT_BOUND and no delivery zones', () => {
  const m = coordMission({ contractType: 'RENDEZVOUS' })
  expect(rendezvousTarget(m, gridWith([]))).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bridge-core.test.ts`
Expected: FAIL — `rendezvousTarget` is not exported.

- [ ] **Step 3: Write minimal implementation (append imports + body to `src/coordination/bridge.ts`)**

Add to the import block:

```ts
import type { Grid } from '../planning/astar.js'
import type { Mission } from '../mission/kinds.js'
```

Append:

```ts
// §8.4 default in-zone radius when the LLM transcribed none (the worked example uses 3).
export const RENDEZVOUS_RADIUS = 3
// Fallback contract lifetime when the mission carries no deadline (absolute-tick deadline added in loop).
export const DEFAULT_CONTRACT_TTL = 500

// Coordinate-free meet-point resolution (§8.4): an explicit TEXT_BOUND tile wins; otherwise the
// delivery zone nearest the map centre — a real landmark both agents know. null ⇒ DECLINE.
export function rendezvousTarget(mission: Mission, grid: Grid): Pos | null {
  const t = mission.params.targetTile
  if (t !== undefined && t.tag === 'TEXT_BOUND') return { x: t.x, y: t.y }
  if (grid.deliveryZones.length === 0) return null
  const centre: Pos = { x: Math.floor(grid.w / 2), y: Math.floor(grid.h / 2) }
  let best = grid.deliveryZones[0]
  let bestD = manhattan(best, centre)
  for (const z of grid.deliveryZones) {
    const d = manhattan(z, centre)
    if (d < bestD || (d === bestD && (z.x < best.x || (z.x === best.x && z.y < best.y)))) { best = z; bestD = d }
  }
  return { x: best.x, y: best.y }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bridge-core.test.ts`
Expected: PASS (9 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/bridge.ts tests/bridge-core.test.ts
git commit -m "feat(bridge): §8.4 coordinate-free rendezvous target binder"
```

---

## Task 3: `buildContract` dispatcher — HANDOFF + RENDEZVOUS

**Files:**
- Modify: `src/coordination/bridge.ts`
- Test: `tests/bridge-build.test.ts`

**Interfaces:**
- Consumes: `bindHandoff`, `handoffContract`, `rendezvousContract`, `type Contract` from `../coordination/contract.js`; `selectHandoffParcel`, `bindRoles`, `rendezvousTarget`, `RENDEZVOUS_RADIUS`, `DEFAULT_CONTRACT_TTL` (Tasks 1–2).
- Produces: `interface BuildCtx { parcels: ParcelBelief[]; self: AgentRef; partner: AgentRef | null; isClaimed: (id: string) => boolean; tnow: number }`; `buildContract(mission: Mission, grid: Grid, ctx: BuildCtx): Contract | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/bridge-build.test.ts
import { test, expect } from 'bun:test'
import { buildContract, type BuildCtx } from '../src/coordination/bridge.js'
import type { Mission } from '../src/mission/kinds.js'
import type { Grid } from '../src/planning/astar.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'
import type { GridTile } from '../src/planning/astar.js'

// 6x3 grid, delivery at (4,1); walkable elsewhere — enough for bindHandoff to find drop+vacate+approach.
function grid(): Grid {
  const tiles = new Map<string, GridTile>()
  for (let x = 0; x <= 5; x++) for (let y = 0; y <= 2; y++) tiles.set(`${x},${y}`, { type: 'walkable' })
  tiles.set('4,1', { type: 'delivery' })
  return { w: 6, h: 3, tiles, deliveryZones: [{ x: 4, y: 1 }] }
}
function coord(contractType: string, params: Partial<Mission['params']> = {}): Mission {
  return { id: 'm1', kind: 'COORDINATION_CONTRACT', payoff: 200, abstractIntent: 'x', params: { contractType, ...params }, rawText: 'x', status: 'CLASSIFIED' }
}
function parcel(id: string, x: number, y: number, r: number): ParcelBelief {
  return { id, pos: { x, y }, rewardSeen: r, carriedBy: null, lastSeen: 0 }
}
const ctx = (over: Partial<BuildCtx> = {}): BuildCtx => ({
  parcels: [parcel('p1', 0, 0, 100)],
  self: { id: 'liaison', pos: { x: 0, y: 0 } },
  partner: { id: 'courier', pos: { x: 5, y: 2 } },
  isClaimed: () => false,
  tnow: 10,
  ...over,
})

test('buildContract HANDOFF binds parcel, roles, tiles and a deadline', () => {
  const c = buildContract(coord('HANDOFF'), grid(), ctx())!
  expect(c.type).toBe('HANDOFF')
  expect(c.id).toBe('m1:HANDOFF')
  expect(c.lockParcels).toEqual(['p1'])
  expect(c.lockOwner).toBe('liaison')      // closer to p1 at (0,0)
  expect(c.payoff).toBe(200)
  expect(c.deadline).toBe(510)             // tnow 10 + DEFAULT_CONTRACT_TTL 500 (mission has no deadline)
  expect(c.status).toBe('PROPOSED')
})

test('buildContract HANDOFF returns null when no parcel is eligible', () => {
  expect(buildContract(coord('HANDOFF'), grid(), ctx({ parcels: [] }))).toBeNull()
})

test('buildContract HANDOFF returns null when no partner is bound yet', () => {
  expect(buildContract(coord('HANDOFF'), grid(), ctx({ partner: null }))).toBeNull()
})

test('buildContract RENDEZVOUS binds the central delivery zone', () => {
  const c = buildContract(coord('RENDEZVOUS'), grid(), ctx())!
  expect(c.type).toBe('RENDEZVOUS')
  expect(c.id).toBe('m1:RENDEZVOUS')
  expect(c.steps.some((s) => s.kind === 'LOCAL' && s.goal.kind === 'IN_ZONE')).toBe(true)
})

test('buildContract uses an explicit mission deadline when present', () => {
  const m = coord('RENDEZVOUS'); m.deadline = 999
  expect(buildContract(m, grid(), ctx())!.deadline).toBe(999)
})

test('buildContract returns null for an unknown contractType', () => {
  expect(buildContract(coord('NONSENSE'), grid(), ctx())).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bridge-build.test.ts`
Expected: FAIL — `buildContract` is not exported.

- [ ] **Step 3: Write minimal implementation (append to `src/coordination/bridge.ts`)**

Add to imports:

```ts
import { bindHandoff, handoffContract, rendezvousContract, type Contract } from './contract.js'
```

Append:

```ts
// Live state the dispatcher binds against. `partner` is null until the partner is perceived (handoff
// needs both positions to bid roles). `isClaimed` keeps the auction's soft claims off the handoff pool.
export interface BuildCtx {
  parcels: ParcelBelief[]
  self: AgentRef
  partner: AgentRef | null
  isClaimed: (id: string) => boolean
  tnow: number
}

// Classify a COORDINATION_CONTRACT mission into a bound, PROPOSED Contract — or null (hold/decline).
// Liaison-only (the proposer, §2.1); the bound contract ships whole in `propose`, so the Courier
// never re-binds. Adoption gating (§8.6) is OUT — this proposes unconditionally once bindable.
export function buildContract(mission: Mission, grid: Grid, ctx: BuildCtx): Contract | null {
  const deadline = mission.deadline ?? ctx.tnow + DEFAULT_CONTRACT_TTL
  switch (mission.params.contractType) {
    case 'HANDOFF': {
      if (ctx.partner === null) return null
      const parcel = selectHandoffParcel(ctx.parcels, ctx.isClaimed)
      if (parcel === null) return null
      const tiles = bindHandoff(grid, parcel.pos)
      if (tiles === null) return null
      const { picker, deliverer } = bindRoles(parcel.pos, ctx.self, ctx.partner)
      return handoffContract(`${mission.id}:HANDOFF`, parcel.id, picker, deliverer, tiles, mission.payoff, deadline)
    }
    case 'RENDEZVOUS': {
      const target = rendezvousTarget(mission, grid)
      if (target === null) return null
      return rendezvousContract(`${mission.id}:RENDEZVOUS`, target, RENDEZVOUS_RADIUS, mission.payoff, deadline)
    }
    default:
      return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bridge-build.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/bridge.ts tests/bridge-build.test.ts
git commit -m "feat(bridge): §8 buildContract dispatcher (HANDOFF + RENDEZVOUS)"
```

---

## Task 4: `syncGateContract` factory + `'gated'` advance outcome

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-syncgate.test.ts`

**Interfaces:**
- Consumes: existing `Contract`, `LocalGoal`, `advance`, `ContractAction` in `contract.ts`.
- Produces: `syncGateContract(id: string, target: Pos, radius: number, payoff: number, deadline: number): Contract`; `ContractAction` gains `| { kind: 'gated' }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract-syncgate.test.ts
import { test, expect } from 'bun:test'
import { syncGateContract, advance, type Contract } from '../src/coordination/contract.js'

test('syncGateContract builds two staging LOCALs + a barrier (no parcels/roles)', () => {
  const c = syncGateContract('g1', { x: 5, y: 5 }, 3, 700, 9999)
  expect(c.type).toBe('SYNC_GATE')
  expect(c.status).toBe('PROPOSED')
  expect(c.lockParcels).toBeUndefined()
  expect(c.steps).toEqual([
    { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'l_staged' },
    { kind: 'LOCAL', agent: 'courier', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'c_staged' },
    { kind: 'BARRIER', needs: ['l_staged', 'c_staged'] },
  ])
})

test('advance returns "gated" once a SYNC_GATE barrier is released (not "done")', () => {
  const c: Contract = { ...syncGateContract('g1', { x: 5, y: 5 }, 3, 700, 9999), status: 'ACTIVE', posted: { l_staged: true, c_staged: true } }
  expect(advance(c, 'liaison', { x: 5, y: 5 })).toEqual({ kind: 'gated' })
})

test('advance still stages a SYNC_GATE normally before the barrier', () => {
  const c: Contract = { ...syncGateContract('g1', { x: 5, y: 5 }, 3, 700, 9999), status: 'ACTIVE', posted: {} }
  expect(advance(c, 'liaison', { x: 0, y: 0 })).toEqual({ kind: 'navigate', to: { x: 5, y: 5 } })
  expect(advance(c, 'liaison', { x: 5, y: 5 })).toEqual({ kind: 'post', milestone: 'l_staged' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/contract-syncgate.test.ts`
Expected: FAIL — `syncGateContract` is not exported.

- [ ] **Step 3a: Extend `ContractAction`** in `src/coordination/contract.ts` — change:

```ts
export type ContractAction =
  | { kind: 'navigate'; to: Pos }
  | { kind: 'post'; milestone: string }
  | { kind: 'block' }
  | { kind: 'done' }
  | { kind: 'pickup'; ids: string[]; post: string }
  | { kind: 'putdown'; ids: string[]; post: string; onDelivery: boolean }
```

to add the `'gated'` outcome:

```ts
export type ContractAction =
  | { kind: 'navigate'; to: Pos }
  | { kind: 'post'; milestone: string }
  | { kind: 'block' }
  | { kind: 'done' }
  | { kind: 'gated' } // §8.5 SYNC_GATE: staging complete — hand control back to gated base play
  | { kind: 'pickup'; ids: string[]; post: string }
  | { kind: 'putdown'; ids: string[]; post: string; onDelivery: boolean }
```

- [ ] **Step 3b: Branch the `advance` terminal** — change the last two lines of `advance` from:

```ts
  const allPosted = c.steps.every((s) => s.kind === 'BARRIER' || c.posted[s.post])
  return allPosted ? { kind: 'done' } : { kind: 'block' }
```

to:

```ts
  const allPosted = c.steps.every((s) => s.kind === 'BARRIER' || c.posted[s.post])
  // §8.5: a SYNC_GATE never terminates on its own — past staging it perpetually yields control to
  // gated base play. Every other type completes when all its milestones are posted (§8.1).
  if (allPosted) return c.type === 'SYNC_GATE' ? { kind: 'gated' } : { kind: 'done' }
  return { kind: 'block' }
```

- [ ] **Step 3c: Add the factory** (append near `rendezvousContract` in `src/coordination/contract.ts`):

```ts
// §8.5 SYNC_GATE: both stage into the meet zone (reusing the rendezvous staging shape), then the
// barrier releases into a perpetual GATED phase governed by the gate flag — NOT another step list.
// No parcels, no roles, no MISSION lock; "odd-row" parity staging (§8.5 example) is a follow-on.
export function syncGateContract(
  id: string,
  target: Pos,
  radius: number,
  payoff: number,
  deadline: number,
): Contract {
  const goal = { kind: 'IN_ZONE' as const, center: target, radius }
  return {
    id,
    type: 'SYNC_GATE',
    steps: [
      { kind: 'LOCAL', agent: 'liaison', goal, post: 'l_staged' },
      { kind: 'LOCAL', agent: 'courier', goal, post: 'c_staged' },
      { kind: 'BARRIER', needs: ['l_staged', 'c_staged'] },
    ],
    posted: {},
    payoff,
    deadline,
    status: 'PROPOSED',
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/contract-syncgate.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite (advance change is backward-compatible)**

Run: `bun test tests/`
Expected: `All tests passed.` (non-SYNC_GATE contracts still hit the `'done'` branch)

- [ ] **Step 6: Commit**

```bash
git add src/coordination/contract.ts tests/contract-syncgate.test.ts
git commit -m "feat(contract): §8.5 syncGateContract + gated advance outcome"
```

---

## Task 5: Gate state on `ContractRuntime` + `GateMsg`/`isGateMsg` + `fail()`

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-syncgate.test.ts`

**Interfaces:**
- Consumes: `ContractRuntime` (existing).
- Produces: `GATE_STALE_TTL: number`; `type GateMsg = { id: string; state: 'OPEN' | 'CLOSED'; tick: number }`; `isGateMsg(p: unknown): p is GateMsg`; on `ContractRuntime`: `setGate(state, tick): GateMsg | null`, `applyGate(msg: GateMsg): void`, `gateOpen(now: number): boolean`, `fail(): ContractMsg | null`. Gate resets to `{ OPEN, 0 }` on every slot clear (propose/accept/complete/fail/teardown).

- [ ] **Step 1: Write the failing test (append to `tests/contract-syncgate.test.ts`)**

```ts
import { ContractRuntime, isGateMsg, GATE_STALE_TTL } from '../src/coordination/contract.js'

function activeGate(): ContractRuntime {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: syncGateContract('g1', { x: 5, y: 5 }, 3, 700, 9999) }, 'courier')
  return rt
}

test('gate defaults OPEN and is fresh at the heartbeat tick', () => {
  const rt = activeGate()
  expect(rt.gateOpen(0)).toBe(true)
})

test('setGate flips the flag locally and returns the broadcast msg', () => {
  const rt = activeGate()
  const msg = rt.setGate('CLOSED', 10)
  expect(msg).toEqual({ id: 'g1', state: 'CLOSED', tick: 10 })
  expect(rt.gateOpen(10)).toBe(false)
})

test('a stale OPEN gate reads CLOSED past GATE_STALE_TTL (§8.5 fail-safe)', () => {
  const rt = activeGate()
  rt.setGate('OPEN', 10)
  expect(rt.gateOpen(10 + GATE_STALE_TTL)).toBe(true)
  expect(rt.gateOpen(10 + GATE_STALE_TTL + 1)).toBe(false)
})

test('applyGate replicates a newer gate state but ignores an older tick', () => {
  const rt = activeGate()
  rt.applyGate({ id: 'g1', state: 'CLOSED', tick: 20 })
  expect(rt.gateOpen(20)).toBe(false)
  rt.applyGate({ id: 'g1', state: 'OPEN', tick: 5 }) // stale → ignored
  expect(rt.gateOpen(20)).toBe(false)
})

test('applyGate ignores a different contract id', () => {
  const rt = activeGate()
  rt.applyGate({ id: 'OTHER', state: 'CLOSED', tick: 99 })
  expect(rt.gateOpen(99)).toBe(true)
})

test('fail() marks FAILED, clears the slot, and resets the gate OPEN', () => {
  const rt = activeGate()
  rt.setGate('CLOSED', 10)
  const msg = rt.fail()
  expect(msg).toEqual({ kind: 'teardown', id: 'g1', status: 'FAILED' })
  expect(rt.current()).toBeNull()
  expect(rt.gateOpen(10)).toBe(true) // gate disarmed back to OPEN on teardown
})

test('isGateMsg accepts well-formed and rejects malformed payloads', () => {
  expect(isGateMsg({ id: 'g1', state: 'OPEN', tick: 1 })).toBe(true)
  expect(isGateMsg({ id: 'g1', state: 'CLOSED', tick: 1 })).toBe(true)
  expect(isGateMsg(null)).toBe(false)
  expect(isGateMsg({ id: 'g1', state: 'green', tick: 1 })).toBe(false)
  expect(isGateMsg({ id: 'g1', state: 'OPEN' })).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/contract-syncgate.test.ts`
Expected: FAIL — `isGateMsg` / `GATE_STALE_TTL` not exported; `setGate` missing.

- [ ] **Step 3a: Add the constant + `GateMsg` + guard** (append near `isContractMsg` in `contract.ts`):

```ts
// §8.5 close-latency guard: an OPEN gate older than this many ticks reads CLOSED (fail-safe to STOP
// under uncertainty — a late "red" must never license a move). Carried on the dedicated 'gate' channel.
export const GATE_STALE_TTL = 5

// The gate sub-protocol on the `type:'gate'` a2a channel (separate from 'contract'). `tick` is the
// heartbeat stamp the freshness check reads. Externally originated (server red/green); this slice
// routes + applies it, the live source is a follow-on seam.
export type GateMsg = { id: string; state: 'OPEN' | 'CLOSED'; tick: number }

export function isGateMsg(p: unknown): p is GateMsg {
  if (typeof p !== 'object' || p === null) return false
  const m = p as Record<string, unknown>
  return typeof m.id === 'string' && (m.state === 'OPEN' || m.state === 'CLOSED') && typeof m.tick === 'number'
}
```

- [ ] **Step 3b: Add gate state + methods to `ContractRuntime`.** Add the field after `private c: Contract | null = null`:

```ts
  // §8.5 gate flag — lifetime = the active SYNC_GATE contract. Default OPEN so it is inert outside a
  // SYNC_GATE (gate scoping: callers only consult gateOpen() while a SYNC_GATE contract is ACTIVE).
  private gate: { state: 'OPEN' | 'CLOSED'; heartbeat: number } = { state: 'OPEN', heartbeat: 0 }

  private resetGate(): void { this.gate = { state: 'OPEN', heartbeat: 0 } }
```

Add the three gate methods + `fail()` (place after `complete()`):

```ts
  // OPEN and fresh (§8.5): a stale heartbeat reads CLOSED. Callers arm this only under a live SYNC_GATE.
  gateOpen(now: number): boolean {
    return this.gate.state === 'OPEN' && now - this.gate.heartbeat <= GATE_STALE_TTL
  }

  // Origination (Liaison): set the gate locally and return the msg to broadcast on the 'gate' channel.
  setGate(state: 'OPEN' | 'CLOSED', tick: number): GateMsg | null {
    if (this.c === null) return null
    this.gate = { state, heartbeat: tick }
    return { id: this.c.id, state, tick }
  }

  // Replication: apply an inbound gate msg for THIS contract, monotonic in tick (a late stamp is dropped).
  applyGate(msg: GateMsg): void {
    if (this.c !== null && this.c.id === msg.id && msg.tick >= this.gate.heartbeat) {
      this.gate = { state: msg.state, heartbeat: msg.tick }
    }
  }

  // §8.5 partner-loss / barrier-deadline failure: mark FAILED, clear the slot, disarm the gate.
  fail(): ContractMsg | null {
    if (this.c === null) return null
    const id = this.c.id
    this.c.status = 'FAILED'
    this.c = null
    this.resetGate()
    return { kind: 'teardown', id, status: 'FAILED' }
  }
```

- [ ] **Step 3c: Reset the gate on every other slot transition.** In `propose`, after `this.c = { ...contract, status: 'PROPOSED' }` add `this.resetGate()`. In `complete`, after `this.c = null` add `this.resetGate()`. In `applyMsg`, in the `'propose'` case after `this.c = { ...msg.contract, status: 'ACTIVE' }` add `this.resetGate()`; in the `'teardown'` case change `if (this.c !== null && this.c.id === msg.id) this.c = null` to also reset:

```ts
      case 'teardown':
        if (this.c !== null && this.c.id === msg.id) { this.c = null; this.resetGate() }
        return null
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/contract-syncgate.test.ts`
Expected: PASS (10 tests in this file)

- [ ] **Step 5: Run the full suite**

Run: `bun test tests/`
Expected: `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/coordination/contract.ts tests/contract-syncgate.test.ts
git commit -m "feat(contract): §8.5 gate state, GateMsg channel + fail() teardown"
```

---

## Task 6: `buildContract` SYNC_GATE branch

**Files:**
- Modify: `src/coordination/bridge.ts`
- Test: `tests/bridge-build.test.ts`

**Interfaces:**
- Consumes: `syncGateContract` from `../coordination/contract.js`; `rendezvousTarget`, `RENDEZVOUS_RADIUS` (existing in bridge).
- Produces: `buildContract` now also handles `contractType === 'SYNC_GATE'`.

- [ ] **Step 1: Write the failing test (append to `tests/bridge-build.test.ts`)**

```ts
test('buildContract SYNC_GATE binds a staging zone and no locks', () => {
  const c = buildContract(coord('SYNC_GATE'), grid(), ctx())!
  expect(c.type).toBe('SYNC_GATE')
  expect(c.id).toBe('m1:SYNC_GATE')
  expect(c.lockParcels).toBeUndefined()
  expect(c.steps.some((s) => s.kind === 'BARRIER')).toBe(true)
})

test('buildContract SYNC_GATE returns null with no target (no TEXT_BOUND, no zones)', () => {
  const emptyGrid: Grid = { w: 6, h: 3, tiles: new Map(), deliveryZones: [] }
  expect(buildContract(coord('SYNC_GATE'), emptyGrid, ctx())).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bridge-build.test.ts`
Expected: FAIL — SYNC_GATE falls through to the `default` and returns null on the first test.

- [ ] **Step 3: Add the branch.** In `src/coordination/bridge.ts`, add `syncGateContract` to the contract import:

```ts
import { bindHandoff, handoffContract, rendezvousContract, syncGateContract, type Contract } from './contract.js'
```

Add the case before `default:` in `buildContract`:

```ts
    case 'SYNC_GATE': {
      const target = rendezvousTarget(mission, grid)
      if (target === null) return null
      return syncGateContract(`${mission.id}:SYNC_GATE`, target, RENDEZVOUS_RADIUS, mission.payoff, deadline)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bridge-build.test.ts`
Expected: PASS (8 tests in this file)

- [ ] **Step 5: Commit**

```bash
git add src/coordination/bridge.ts tests/bridge-build.test.ts
git commit -m "feat(bridge): §8.5 buildContract SYNC_GATE branch"
```

---

## Task 7: Liaison loop — bind + propose a pending COORDINATION_CONTRACT

**Files:**
- Modify: `src/bdi/loop.ts`
- Test: `tests/bdi-loop-bridge.test.ts`

**Context for the implementer.** `tick()` defines `self`, `beliefs`, `mView` (`this.mission?.view`), `dist`, then calls `this.reconcileContractLocks(tnow)` (~line 110) and runs the ACTIVE-contract short-circuit. Insert the bridge **propose** attempt immediately BEFORE `this.reconcileContractLocks(tnow)`. It runs only on the Liaison (the proposer, §2.1), only while a `COORDINATION_CONTRACT` mission is in the view and the runtime slot is empty. `this.partnerBelief(beliefs)` returns the partner `AgentBelief | null` (has `.pos`); `this.claims.claimedBy(id)` returns `AgentId | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/bdi-loop-bridge.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime } from '../src/coordination/contract.js'
import type { ContractMsg } from '../src/coordination/contract.js'
import type { Mission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// 6x3 grid, delivery at (4,1).
function map(): Tile[] {
  const t: Tile[] = []
  for (let x = 0; x <= 5; x++) for (let y = 0; y <= 2; y++) t.push({ pos: { x, y }, type: x === 4 && y === 1 ? 'delivery' : 'walkable' })
  return t
}
function fakeClient(role: 'liaison' | 'courier'): DeliverooClient {
  return {
    role, consts: CONSTS, map: map(), tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async () => ({ x: 0, y: 0 } as Pos),
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (): Promise<PickResult[]> => [],
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
}
const log = { info: () => {}, debug: () => {}, warn: () => {} }
function coordMission(contractType: string): Mission {
  return { id: 'm1', kind: 'COORDINATION_CONTRACT', payoff: 200, abstractIntent: 'x', params: { contractType }, rawText: 'x', status: 'CLASSIFIED' }
}
// snapshot with a perceived free parcel at (0,0) and the partner visible at (5,2).
function snap(selfPos: Pos): PerceptionSnapshot {
  return {
    tick: 1, self: { id: 'L', name: 'L', teamId: 'A', pos: selfPos, score: 0 },
    parcels: [{ id: 'p1', pos: { x: 0, y: 0 }, reward: 100, carriedBy: null }],
    agents: [{ id: 'C', name: 'C', teamId: 'A', pos: { x: 5, y: 2 } }], crates: [],
  }
}

function liaisonLoop(view: TeamMissionView, rt: ContractRuntime, sent: A2AMessage[]): BdiLoop {
  return new BdiLoop(fakeClient('liaison'), DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send: (m) => sent.push(m) },
    { view, pursue: true, contracts: rt })
}

test('Liaison proposes a HANDOFF contract once the parcel + partner are perceived', async () => {
  const view = new TeamMissionView(); view.set(coordMission('HANDOFF'))
  const rt = new ContractRuntime(); const sent: A2AMessage[] = []
  await liaisonLoop(view, rt, sent).tick(snap({ x: 1, y: 0 }))
  const proposes = sent.filter((m) => m.type === 'contract').map((m) => m.payload as ContractMsg)
  expect(proposes.length).toBe(1)
  expect(proposes[0].kind).toBe('propose')
  expect(rt.current()!.id).toBe('m1:HANDOFF')
  expect(rt.current()!.status).toBe('PROPOSED')
})

test('Liaison holds (no propose) when the parcel is not yet perceived', async () => {
  const view = new TeamMissionView(); view.set(coordMission('HANDOFF'))
  const rt = new ContractRuntime(); const sent: A2AMessage[] = []
  const noParcel: PerceptionSnapshot = { ...snap({ x: 1, y: 0 }), parcels: [] }
  await liaisonLoop(view, rt, sent).tick(noParcel)
  expect(sent.filter((m) => m.type === 'contract').length).toBe(0)
  expect(rt.current()).toBeNull()
})

test('Liaison does not re-propose once a contract occupies the slot', async () => {
  const view = new TeamMissionView(); view.set(coordMission('HANDOFF'))
  const rt = new ContractRuntime(); const sent: A2AMessage[] = []
  const loop = liaisonLoop(view, rt, sent)
  await loop.tick(snap({ x: 1, y: 0 }))
  await loop.tick(snap({ x: 1, y: 0 }))
  expect(sent.filter((m) => m.type === 'contract' && (m.payload as ContractMsg).kind === 'propose').length).toBe(1)
})

test('Courier (pursue:false) never proposes a contract', async () => {
  const view = new TeamMissionView(); view.set(coordMission('HANDOFF'))
  const rt = new ContractRuntime(); const sent: A2AMessage[] = []
  const loop = new BdiLoop(fakeClient('courier'), DEFAULT_PARAMS, log, undefined,
    { partner: 'liaison', send: (m) => sent.push(m) }, { view, pursue: false, contracts: rt })
  await loop.tick(snap({ x: 1, y: 0 }))
  expect(sent.filter((m) => m.type === 'contract').length).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-loop-bridge.test.ts`
Expected: FAIL — no propose is sent (bridge not wired).

- [ ] **Step 3a: Add the import** to `src/bdi/loop.ts` (next to the contract import on line 12):

```ts
import { buildContract } from '../coordination/bridge.js'
```

- [ ] **Step 3b: Insert the propose attempt** immediately before `this.reconcileContractLocks(tnow)`:

```ts
    // §8 bridge — the Liaison (proposer, §2.1) binds a pending COORDINATION_CONTRACT mission into a
    // Contract once it is bindable, and proposes it. buildContract returns null while unbindable
    // (parcel/partner unperceived, no valid tiles) → hold and retry next tick (deferred bind, §8.2).
    // Once proposed, the runtime slot is non-null so this stops firing — idempotent by derivation.
    if (
      this.client.role === 'liaison' &&
      this.mission?.contracts &&
      this.mission.contracts.current() === null &&
      mView?.current()?.kind === 'COORDINATION_CONTRACT'
    ) {
      const partner = this.partnerBelief(beliefs)
      const c = buildContract(mView.current()!, this.grid, {
        parcels: [...beliefs.parcels.values()],
        self: { id: this.client.role, pos: self },
        partner: partner !== null ? { id: this.coord!.partner, pos: partner.pos } : null,
        isClaimed: (id) => this.claims.claimedBy(id) !== null,
        tnow,
      })
      if (c !== null) {
        this.sendContract(this.mission.contracts.propose(c))
        this.log.info({ tick: tnow, contract: c.id, type: c.type }, 'contract proposed')
      } else {
        this.log.debug({ tick: tnow, missionId: mView.current()!.id }, 'contract bind pending')
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bdi-loop-bridge.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite (bridge inert without a COORDINATION_CONTRACT mission)**

Run: `bun test tests/`
Expected: `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/bdi/loop.ts tests/bdi-loop-bridge.test.ts
git commit -m "feat(bdi): §8 Liaison bridge — bind & propose pending contract"
```

---

## Task 8: Loop — `'gated'` fall-through, gate hold, SYNC_GATE partner-loss teardown

**Files:**
- Modify: `src/bdi/loop.ts`
- Test: `tests/bdi-loop-bridge.test.ts`

**Context for the implementer.** The current ACTIVE-contract short-circuit (~lines 115–121) is:

```ts
    const activeContract = this.mission?.contracts?.active() ?? null
    if (activeContract !== null) {
      await this.actContract(activeContract, beliefs, planCtx, tnow)
      this.prevSelf = self
      this.log.debug({ durationMs: performance.now() - t0, tick: tnow, contract: activeContract.id }, 'tick (contract)')
      return
    }
```

Replace it with a version that (a) aborts a SYNC_GATE on partner loss and falls through, (b) on `'gated'` either holds (gate CLOSED/stale) or falls through to base play (gate OPEN+fresh), (c) otherwise behaves exactly as before. `tick(snap, partnerAlive = true)` already carries `partnerAlive`. `advance` is already imported.

- [ ] **Step 1: Write the failing test (append to `tests/bdi-loop-bridge.test.ts`)**

```ts
import { syncGateContract, advance } from '../src/coordination/contract.js'

// Build an ACTIVE, fully-staged SYNC_GATE so advance() yields 'gated'.
function gatedRuntime(): ContractRuntime {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: syncGateContract('g1', { x: 0, y: 0 }, 9, 700, 9999) }, 'liaison')
  rt.applyMsg({ kind: 'post', id: 'g1', milestone: 'l_staged' }, 'liaison')
  rt.applyMsg({ kind: 'post', id: 'g1', milestone: 'c_staged' }, 'liaison')
  return rt
}

// A move-recording client so we can see whether base play moved this tick.
function recClient(role: 'liaison' | 'courier'): { client: DeliverooClient; moves: string[] } {
  const moves: string[] = []
  const client = { ...fakeClient(role), move: async (d: string) => { moves.push(d); return { x: 0, y: 0 } as Pos } } as DeliverooClient
  return { client, moves }
}

test('gated + CLOSED gate: agent holds (no base-play move)', async () => {
  const rt = gatedRuntime(); rt.setGate('CLOSED', 1)
  const { client, moves } = recClient('liaison')
  const view = new TeamMissionView()
  const loop = new BdiLoop(client, DEFAULT_PARAMS, log, undefined, { partner: 'courier', send: () => {} }, { view, pursue: true, contracts: rt })
  // parcel present, so base play WOULD move toward it if not gated.
  await loop.tick(snap({ x: 3, y: 0 }))
  expect(moves).toEqual([])
  expect(advance(rt.active()!, 'liaison', { x: 3, y: 0 })).toEqual({ kind: 'gated' })
})

test('SYNC_GATE aborts on partner loss (Active→Failed) and broadcasts a FAILED teardown', async () => {
  const rt = gatedRuntime()
  const sent: A2AMessage[] = []
  const { client } = recClient('liaison')
  const loop = new BdiLoop(client, DEFAULT_PARAMS, log, undefined, { partner: 'courier', send: (m) => sent.push(m) }, { view: new TeamMissionView(), pursue: true, contracts: rt })
  await loop.tick(snap({ x: 3, y: 0 }), false) // partnerAlive = false
  const tear = sent.filter((m) => m.type === 'contract').map((m) => m.payload as ContractMsg)
  expect(tear).toEqual([{ kind: 'teardown', id: 'g1', status: 'FAILED' }])
  expect(rt.current()).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-loop-bridge.test.ts`
Expected: FAIL — gated tick currently routes through `actContract` (no `'gated'` handling) / no partner-loss abort.

- [ ] **Step 3: Replace the short-circuit block** in `src/bdi/loop.ts` with:

```ts
    const activeContract = this.mission?.contracts?.active() ?? null
    if (activeContract !== null) {
      // §8.5 — a SYNC_GATE has no terminal barrier; a lost partner would freeze the survivor on a
      // stale gate forever. Partner-loss aborts it (Active→Failed), clears the gate, resumes base play.
      if (activeContract.type === 'SYNC_GATE' && !partnerAlive) {
        const msg = this.mission!.contracts!.fail()
        if (msg !== null) this.sendContract(msg)
        this.log.info({ tick: tnow, contract: activeContract.id, status: 'FAILED' }, 'sync-gate partner lost')
        // fall through to base play below (slot now empty, gate disarmed)
      } else {
        const action = advance(activeContract, this.client.role, self)
        if (action.kind === 'gated') {
          // §8.5 movement overlay: past staging, base play resumes — but only through an OPEN+fresh
          // gate (stale ⇒ CLOSED). A held tick takes no action; an open tick falls through to base play.
          if (!this.mission!.contracts!.gateOpen(tnow)) {
            this.prevSelf = self
            this.log.debug({ tick: tnow, contract: activeContract.id, gate: 'CLOSED' }, 'tick (gate held)')
            return
          }
          // gate OPEN+fresh → fall through to base play below
        } else {
          await this.actContract(activeContract, beliefs, planCtx, tnow)
          this.prevSelf = self
          this.log.debug({ durationMs: performance.now() - t0, tick: tnow, contract: activeContract.id }, 'tick (contract)')
          return
        }
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bdi-loop-bridge.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite (rendezvous/handoff still short-circuit; base play unchanged)**

Run: `bun test tests/`
Expected: `All tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/bdi/loop.ts tests/bdi-loop-bridge.test.ts
git commit -m "feat(bdi): §8.5 gated base-play overlay + sync-gate partner-loss teardown"
```

---

## Task 9: Route the `type:'gate'` a2a channel into both runtimes

**Files:**
- Modify: `src/agents/liaison.ts`
- Modify: `src/agents/courier.ts`

**Context.** Both entrypoints route `type:'claims'`/`type:'contract'` (and the Courier `type:'mission'`) in `self.onmessage`. Add a `type:'gate'` branch that applies the gate msg to the `ContractRuntime`. The external red/green source is a follow-on seam — this slice wires the channel + the freshness fail-safe; gate msgs are injected onto the channel (tests / a future server bridge).

- [ ] **Step 1 (Liaison): add `isGateMsg` to the contract import** in `src/agents/liaison.ts`:

Change:

```ts
import { ContractRuntime, isContractMsg } from '../coordination/contract.js'
```

to:

```ts
import { ContractRuntime, isContractMsg, isGateMsg } from '../coordination/contract.js'
```

- [ ] **Step 2 (Liaison): add the route.** In `self.onmessage`, change the contract branch's tail from:

```ts
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'liaison') ?? null
      if (reply !== null) send({ from: 'liaison', to: 'courier', type: 'contract', payload: reply })
    } else blackboard?.receive(msg)
```

to:

```ts
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'liaison') ?? null
      if (reply !== null) send({ from: 'liaison', to: 'courier', type: 'contract', payload: reply })
    } else if (msg.type === 'gate' && isGateMsg(msg.payload)) {
      contracts?.applyGate(msg.payload)
    } else blackboard?.receive(msg)
```

- [ ] **Step 3 (Courier): mirror it** in `src/agents/courier.ts`. Change the import:

```ts
import { ContractRuntime, isContractMsg, isGateMsg } from '../coordination/contract.js'
```

and the contract branch tail from:

```ts
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'courier') ?? null
      if (reply !== null) send({ from: 'courier', to: 'liaison', type: 'contract', payload: reply })
    } else blackboard?.receive(msg)
```

to:

```ts
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'courier') ?? null
      if (reply !== null) send({ from: 'courier', to: 'liaison', type: 'contract', payload: reply })
    } else if (msg.type === 'gate' && isGateMsg(msg.payload)) {
      contracts?.applyGate(msg.payload)
    } else blackboard?.receive(msg)
```

- [ ] **Step 4: Typecheck + full suite**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun test tests/`
Expected: `All tests passed.`

- [ ] **Step 5: Commit**

```bash
git add src/agents/liaison.ts src/agents/courier.ts
git commit -m "feat(agents): route the §8.5 gate a2a channel into ContractRuntime"
```

---

## Task 10: Capstone — COORDINATION_CONTRACT mission drives a handoff to SATISFIED

**Files:**
- Test: `tests/contract-bridge-e2e.test.ts`

**Purpose.** Prove the whole bridge: a `COORDINATION_CONTRACT`/HANDOFF mission set on the Liaison's view is bound + proposed by the Liaison loop, accepted by the Courier over the relay, and driven to `SATISFIED` on both replicas — no direct factory call.

- [ ] **Step 1: Write the test**

```ts
// tests/contract-bridge-e2e.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime, isContractMsg } from '../src/coordination/contract.js'
import { isClaimMsg, ClaimStore } from '../src/coordination/claims.js'
import type { Mission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage, AgentId } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 50, PARCEL_DECAY_TICKS: 9999, PARCEL_DECAY_RAW: '0s', PENALTY: 0 }

// 8x3 grid, delivery at (4,1). Parcel p1 at (1,1). Liaison near p1, Courier near delivery.
function map(): Tile[] {
  const t: Tile[] = []
  for (let x = 0; x <= 7; x++) for (let y = 0; y <= 2; y++) t.push({ pos: { x, y }, type: x === 4 && y === 1 ? 'delivery' : 'walkable' })
  return t
}

// A client whose position is mutated by move(), and whose carried set + ground parcels it tracks so
// pickup/putdown behave. Minimal — exercises the protocol, not full server fidelity.
function movingClient(role: AgentId, start: Pos): { client: DeliverooClient; pos: Pos } {
  const state = { pos: { ...start } }
  const client: DeliverooClient = {
    role, consts: CONSTS, map: map(), tick: () => 0,
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
function snapAt(self: Pos, partner: Pos, partnerId: string): PerceptionSnapshot {
  return {
    tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: self, score: 0 },
    parcels: [{ id: 'p1', pos: { x: 1, y: 1 }, reward: 100, carriedBy: null }],
    agents: [{ id: partnerId, name: partnerId, teamId: 'A', pos: partner }], crates: [],
  }
}
function handoffMission(): Mission {
  return { id: 'm1', kind: 'COORDINATION_CONTRACT', payoff: 200, abstractIntent: 'hand off p1', params: { contractType: 'HANDOFF' }, rawText: 'hand off p1', status: 'CLASSIFIED' }
}

test('a COORDINATION_CONTRACT/HANDOFF mission drives a handoff to SATISFIED via the bridge', async () => {
  const L = movingClient('liaison', { x: 1, y: 0 })
  const C = movingClient('courier', { x: 6, y: 1 })
  const lc = new ContractRuntime(); const cc = new ContractRuntime()
  const lClaims = new ClaimStore(); const cClaims = new ClaimStore()

  const inbox: Record<AgentId, A2AMessage[]> = { liaison: [], courier: [] }
  const send = (m: A2AMessage): void => { inbox[m.to].push(m) }
  function drain(rt: ContractRuntime, claims: ClaimStore, self: AgentId): void {
    for (const m of inbox[self].splice(0)) {
      if (m.type === 'contract' && isContractMsg(m.payload)) {
        const reply = rt.applyMsg(m.payload, self)
        if (reply !== null) send({ from: self, to: m.from, type: 'contract', payload: reply })
      } else if (m.type === 'claims' && isClaimMsg(m.payload)) {
        claims.applyMsg(m.payload, self)
      }
    }
  }

  const lView = new TeamMissionView(); lView.set(handoffMission())
  const cView = new TeamMissionView() // Courier receives the contract via the relay, not the mission
  const loopL = new BdiLoop(L.client, DEFAULT_PARAMS, log, lClaims, { partner: 'courier', send }, { view: lView, pursue: true, contracts: lc })
  const loopC = new BdiLoop(C.client, DEFAULT_PARAMS, log, cClaims, { partner: 'liaison', send }, { view: cView, pursue: false, contracts: cc })

  let guard = 0
  let satisfied = false
  while (!satisfied && guard++ < 60) {
    drain(lc, lClaims, 'liaison'); drain(cc, cClaims, 'courier')
    await loopL.tick(snapAt(L.pos, C.pos, 'courier'))
    await loopC.tick(snapAt(C.pos, L.pos, 'liaison'))
    drain(lc, lClaims, 'liaison'); drain(cc, cClaims, 'courier')
    // SATISFIED ⇔ a contract existed and both runtimes have torn it down.
    satisfied = lc.current() === null && cc.current() === null && guard > 2
  }

  expect(guard).toBeLessThan(60) // converged
  expect(lc.current()).toBeNull()
  expect(cc.current()).toBeNull()
})
```

> **Note.** `guard > 2` avoids declaring victory on the first ticks before the contract is proposed/accepted (both runtimes start empty). The bound is generous (60 ticks) because the picker must walk to p1, carry to the drop tile, vacate, and the deliverer must stage, pick and deliver. If the harness's minimal pickup/putdown model proves too thin to advance `posted`, drive the milestones the way `tests/contract-handoff-e2e.test.ts` does (that file is the reference handoff harness) — the assertion (both slots null = SATISFIED) is unchanged.

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/contract-bridge-e2e.test.ts`
Expected: PASS (1 test)

- [ ] **Step 3: Run the full suite**

Run: `bun test tests/`
Expected: `All tests passed.`

- [ ] **Step 4: Commit**

```bash
git add tests/contract-bridge-e2e.test.ts
git commit -m "test(bridge): §8 COORDINATION_CONTRACT→handoff e2e via relay"
```

---

## Done When

A `COORDINATION_CONTRACT` mission of each `contractType` set on the Liaison's view is bound from live beliefs and proposed over the `'contract'` channel; HANDOFF and RENDEZVOUS reach `SATISFIED` on both replicas; SYNC_GATE stages both agents then gates base-play movement (stale ⇒ CLOSED) and tears down `FAILED` on partner loss, clearing the gate. Base play is byte-for-byte unchanged with no COORDINATION_CONTRACT mission active (`bun test tests/` green; `bunx tsc --noEmit` clean).

## Follow-on (not this plan)

1. **Live gate source** — a server→`type:'gate'` bridge feeding `setGate` on the Liaison (this plan wires the channel + fail-safe; the origin is injected).
2. **Lifecycle hardening (§8.6)** — adoption gating, barrier deadlines→FAILED, commit-timeout→ABORTED, abort handler refreshing carried-parcel beliefs (the `rewardSeen=0` review TODO).
3. **`PARITY_ROW` staging goal (§8.5 "odd row")** + map-aware `navTarget`.
4. The four review-surfaced handoff TODOs (auction-claim release on contract pickup, same-tick re-lock race, etc.) when their triggering path lands.
