# Handoff Contract (§8.3) + MISSION-claim Producer (§9.10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the HANDOFF coordination contract ("+200 if a *different* agent delivers") and, with it, the first producer of `origin:'MISSION'` parcel claims (§9.10).

**Architecture:** Extend the existing pure contract primitive (`contract.ts`) with an `ACTION` step kind (atomic, self-navigating `pickUp`/`putDown` with explicit ids), a `handoffContract()` builder for the §8.3 step list, and a pure `bindHandoff()` map-scanning tile binder. The BDI loop gains a level-triggered MISSION-lock reconcile (the picker installs the contract's `lockParcels` as `origin:'MISSION'` claims while ACTIVE, releases on teardown) and executes the new pickup/putdown contract actions. The lock *consumers* (auction pool, rebalance, claim expiry) already skip `origin==='MISSION'` — this slice only adds the producer.

**Tech Stack:** Bun + TypeScript (strict, ESM, `.js` import extensions), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-17-handoff-contract-design.md`

---

## File Structure

- **Modify** `src/coordination/contract.ts` — add `ACTION` to `Step`; add `pickup`/`putdown` to `ContractAction`; add `lockOwner`/`lockParcels` to `Contract`; extend `advance()` (ACTION execution + terminal-condition fix); add `HandoffTiles`, `handoffContract()`, `bindHandoff()`.
- **Modify** `src/bdi/loop.ts` — add `contractLocks` field; add `reconcileContractLocks()`; call it before the contract short-circuit; add the pickup/putdown branch to `actContract()`.
- **Modify** `tests/contract-runtime.test.ts` — unit tests for `advance()` handoff walk-through, `handoffContract()` builder, `bindHandoff()`.
- **Create** `tests/contract-handoff-e2e.test.ts` — two-loop e2e mirroring `contract-rendezvous-e2e.test.ts`, routing both the `'contract'` and `'claims'` channels, asserting the full sequence + MISSION-lock lifecycle.

---

### Task 1: `ACTION` step kind + `advance()` extension

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract-runtime.test.ts` (`Contract` is already imported at the top of the file
from the existing rendezvous tests; this only adds `advance`):

```ts
import { advance } from '../src/coordination/contract.js'

// A hand-built ACTIVE handoff-shaped contract for the advance() walk-through (no map / builder
// needed — Task 1 must go green before handoffContract exists). The shape matches what Task 2's
// handoffContract() will produce, exercised there.
function handoffSteps(): Contract {
  return {
    id: 'h1', type: 'HANDOFF', payoff: 200, deadline: 9999, status: 'ACTIVE', posted: {},
    lockOwner: 'liaison', lockParcels: ['p1'],
    steps: [
      { kind: 'ACTION', agent: 'liaison', primitive: 'pickUp', ids: ['p1'], at: { x: 2, y: 1 }, post: 'picked' },
      { kind: 'ACTION', agent: 'liaison', primitive: 'putDown', ids: ['p1'], at: { x: 1, y: 0 }, post: 'dropped', onDelivery: false },
      { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'AT_TILE', tile: { x: 1, y: 1 } }, post: 'H_clear' },
      { kind: 'LOCAL', agent: 'courier', goal: { kind: 'AT_TILE', tile: { x: 2, y: 0 } }, post: 'b_ready' },
      { kind: 'BARRIER', needs: ['H_clear', 'b_ready'] },
      { kind: 'ACTION', agent: 'courier', primitive: 'pickUp', ids: ['p1'], at: { x: 1, y: 0 }, post: 'b_picked' },
      { kind: 'ACTION', agent: 'courier', primitive: 'putDown', ids: ['p1'], at: { x: 0, y: 0 }, post: 'delivered', onDelivery: true },
    ],
  }
}

test('advance: picker picks up at the parcel tile, then drops at the drop tile', () => {
  const c = handoffSteps()
  // picker (liaison) standing on the parcel tile → pickUp with explicit ids
  expect(advance(c, 'liaison', { x: 2, y: 1 })).toEqual({ kind: 'pickup', ids: ['p1'], post: 'picked' })
  c.posted.picked = true
  // not yet at the drop tile → navigate to it
  expect(advance(c, 'liaison', { x: 2, y: 1 })).toEqual({ kind: 'navigate', to: { x: 1, y: 0 } })
  // on the drop tile → putDown (non-scoring ground drop)
  expect(advance(c, 'liaison', { x: 1, y: 0 })).toEqual({ kind: 'putdown', ids: ['p1'], post: 'dropped', onDelivery: false })
})

test('advance: picker blocks at the barrier after vacating until the deliverer is ready', () => {
  const c = handoffSteps()
  c.posted.picked = true
  c.posted.dropped = true
  // picker on the vacate tile → posts H_clear
  expect(advance(c, 'liaison', { x: 1, y: 1 })).toEqual({ kind: 'post', milestone: 'H_clear' })
  c.posted.H_clear = true
  // H_clear posted but b_ready not → picker hits the barrier and blocks
  expect(advance(c, 'liaison', { x: 1, y: 1 })).toEqual({ kind: 'block' })
})

test('advance: contract is done only after the deliverer posts delivered (not when the picker runs out of steps)', () => {
  const c = handoffSteps()
  c.posted.picked = true
  c.posted.dropped = true
  c.posted.H_clear = true
  c.posted.b_ready = true   // barrier released
  // picker has no steps after the barrier, but the deliverer has not delivered → block, NOT done
  expect(advance(c, 'liaison', { x: 1, y: 1 })).toEqual({ kind: 'block' })
  // deliverer finishes
  c.posted.b_picked = true
  c.posted.delivered = true
  // now every non-barrier milestone is posted → done for both
  expect(advance(c, 'liaison', { x: 1, y: 1 })).toEqual({ kind: 'done' })
  expect(advance(c, 'courier', { x: 0, y: 0 })).toEqual({ kind: 'done' })
})

test('advance: deliverer scoring putDown carries onDelivery:true', () => {
  const c = handoffSteps()
  c.posted.picked = true; c.posted.dropped = true; c.posted.H_clear = true
  c.posted.b_ready = true; c.posted.b_picked = true
  // deliverer on the delivery tile → scoring putDown
  expect(advance(c, 'courier', { x: 0, y: 0 })).toEqual({ kind: 'putdown', ids: ['p1'], post: 'delivered', onDelivery: true })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/contract-runtime.test.ts`
Expected: FAIL — `handoffContract` / `bindHandoff` not exported, and `advance` lacks ACTION handling.

- [ ] **Step 3: Extend the schema and `advance()`**

In `src/coordination/contract.ts`, replace the `Step` type (currently the LOCAL+BARRIER union near line 35):

```ts
// A single step in the contract's plan. Both agents hold the SAME list; each executes only its
// own LOCAL/ACTION steps and blocks on every BARRIER (§8.1). An ACTION is an atomic game primitive
// fired at tile `at` with EXPLICIT ids (§8.3 rule 1 — never dump base-play parcels on the corridor);
// `onDelivery` marks the deliverer's scoring putDown (selects the belief update in the loop).
export type Step =
  | { kind: 'LOCAL'; agent: AgentId; goal: LocalGoal; post: string }
  | { kind: 'BARRIER'; needs: string[] }
  | { kind: 'ACTION'; agent: AgentId; primitive: 'pickUp' | 'putDown'; ids: string[]; at: Pos; post: string; onDelivery?: boolean }
```

Add the two optional lock fields to `Contract` (after `status: ContractStatus`):

```ts
  lockOwner?: AgentId      // §9.10 — the single party that installs MISSION locks (handoff picker)
  lockParcels?: string[]   // §9.10 — parcels the contract MISSION-locks for its life
```

Extend `ContractAction` (after the `done` variant):

```ts
  | { kind: 'pickup'; ids: string[]; post: string }
  | { kind: 'putdown'; ids: string[]; post: string; onDelivery: boolean }
```

Replace the body of `advance()` with:

```ts
export function advance(c: Contract, me: AgentId, self: Pos): ContractAction {
  for (const s of c.steps) {
    if (s.kind === 'BARRIER') {
      if (s.needs.every((m) => c.posted[m])) continue // released → fall through to later steps
      return { kind: 'block' }
    }
    if (s.agent !== me) continue   // not my step → skip (the partner runs it)
    if (c.posted[s.post]) continue // my milestone already reached → advance
    if (s.kind === 'LOCAL') {
      if (goalSatisfied(s.goal, self)) return { kind: 'post', milestone: s.post }
      return { kind: 'navigate', to: navTarget(s.goal) }
    }
    // s.kind === 'ACTION' — self-navigate to the action tile, then fire the primitive.
    if (self.x !== s.at.x || self.y !== s.at.y) return { kind: 'navigate', to: s.at }
    return s.primitive === 'pickUp'
      ? { kind: 'pickup', ids: s.ids, post: s.post }
      : { kind: 'putdown', ids: s.ids, post: s.post, onDelivery: s.onDelivery ?? false }
  }
  // Fell through: every barrier released and every step of MINE posted. The contract is SATISFIED
  // only when EVERY non-barrier milestone is posted (mine AND the partner's) — otherwise hold while
  // the partner finishes (the handoff picker waits after vacating until the deliverer scores). In
  // rendezvous both LOCALs posted ⇒ all-posted ⇒ done for both, so this is backward-compatible.
  const allPosted = c.steps.every((s) => s.kind === 'BARRIER' || c.posted[s.post])
  return allPosted ? { kind: 'done' } : { kind: 'block' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/contract-runtime.test.ts`
Expected: PASS (the new `advance` tests pass; the existing rendezvous-runtime tests stay green).

- [ ] **Step 5: Commit**

```bash
git add src/coordination/contract.ts tests/contract-runtime.test.ts
git commit -m "feat(contract): §8.3 ACTION step kind + advance() terminal-condition fix

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `handoffContract()` builder

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/contract-runtime.test.ts`:

```ts
import { handoffContract, type HandoffTiles } from '../src/coordination/contract.js'

test('handoffContract builds the §8.3 step list with lock fields', () => {
  const tiles: HandoffTiles = {
    parcel: { x: 2, y: 1 }, drop: { x: 1, y: 0 }, vacate: { x: 1, y: 1 },
    approach: { x: 2, y: 0 }, delivery: { x: 0, y: 0 },
  }
  const c = handoffContract('h1', 'p1', 'liaison', 'courier', tiles, 200, 9999)
  expect(c.type).toBe('HANDOFF')
  expect(c.status).toBe('PROPOSED')
  expect(c.lockOwner).toBe('liaison')
  expect(c.lockParcels).toEqual(['p1'])
  expect(c.steps).toEqual([
    { kind: 'ACTION', agent: 'liaison', primitive: 'pickUp', ids: ['p1'], at: { x: 2, y: 1 }, post: 'picked' },
    { kind: 'ACTION', agent: 'liaison', primitive: 'putDown', ids: ['p1'], at: { x: 1, y: 0 }, post: 'dropped', onDelivery: false },
    { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'AT_TILE', tile: { x: 1, y: 1 } }, post: 'H_clear' },
    { kind: 'LOCAL', agent: 'courier', goal: { kind: 'AT_TILE', tile: { x: 2, y: 0 } }, post: 'b_ready' },
    { kind: 'BARRIER', needs: ['H_clear', 'b_ready'] },
    { kind: 'ACTION', agent: 'courier', primitive: 'pickUp', ids: ['p1'], at: { x: 1, y: 0 }, post: 'b_picked' },
    { kind: 'ACTION', agent: 'courier', primitive: 'putDown', ids: ['p1'], at: { x: 0, y: 0 }, post: 'delivered', onDelivery: true },
  ])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/contract-runtime.test.ts`
Expected: FAIL — `handoffContract` not yet defined / shape mismatch.

- [ ] **Step 3: Add `HandoffTiles` and `handoffContract()`**

In `src/coordination/contract.ts`, after `rendezvousContract` (end of file), add:

```ts
// §8.3 HANDOFF — the picker (A) picks the parcel, carries it to a NON-delivery drop tile next to a
// delivery zone, drops it (ground, not scoring) and vacates; the deliverer (B) waits at an approach
// tile until the barrier (picker dropped AND vacated, B staged) releases, then steps onto the now-
// free drop tile, picks the parcel and delivers it — a CROSS-agent delivery scoring `payoff`.
// Roles are bound by the caller from shared beliefs (picker = closer to the parcel, §9.10), then
// frozen here. Tiles come from bindHandoff() (RUNTIME_BOUND, §8.2).
export interface HandoffTiles { parcel: Pos; drop: Pos; vacate: Pos; approach: Pos; delivery: Pos }

export function handoffContract(
  id: string,
  parcelId: string,
  picker: AgentId,
  deliverer: AgentId,
  tiles: HandoffTiles,
  payoff: number,
  deadline: number,
): Contract {
  const at = (p: Pos): LocalGoal => ({ kind: 'AT_TILE', tile: p })
  return {
    id,
    type: 'HANDOFF',
    steps: [
      { kind: 'ACTION', agent: picker, primitive: 'pickUp', ids: [parcelId], at: tiles.parcel, post: 'picked' },
      { kind: 'ACTION', agent: picker, primitive: 'putDown', ids: [parcelId], at: tiles.drop, post: 'dropped', onDelivery: false },
      { kind: 'LOCAL', agent: picker, goal: at(tiles.vacate), post: 'H_clear' },
      { kind: 'LOCAL', agent: deliverer, goal: at(tiles.approach), post: 'b_ready' },
      { kind: 'BARRIER', needs: ['H_clear', 'b_ready'] },
      { kind: 'ACTION', agent: deliverer, primitive: 'pickUp', ids: [parcelId], at: tiles.drop, post: 'b_picked' },
      { kind: 'ACTION', agent: deliverer, primitive: 'putDown', ids: [parcelId], at: tiles.delivery, post: 'delivered', onDelivery: true },
    ],
    posted: {},
    payoff,
    deadline,
    status: 'PROPOSED',
    lockOwner: picker,
    lockParcels: [parcelId],
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/contract-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coordination/contract.ts tests/contract-runtime.test.ts
git commit -m "feat(contract): §8.3 handoffContract builder + HandoffTiles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `bindHandoff()` runtime tile binder

**Files:**
- Modify: `src/coordination/contract.ts`
- Test: `tests/contract-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract-runtime.test.ts`:

```ts
import { bindHandoff } from '../src/coordination/contract.js'
import { buildGrid } from '../src/planning/astar.js'
import type { Tile } from '../src/types/perception.js'

// 3x2 walkable grid (x:0..2, y:0..1) with (0,0) a delivery tile.
function grid3x2() {
  const tiles: Tile[] = []
  for (let x = 0; x <= 2; x++) for (let y = 0; y <= 1; y++) {
    tiles.push({ pos: { x, y }, type: x === 0 && y === 0 ? 'delivery' : 'walkable' })
  }
  return buildGrid(tiles)
}

test('bindHandoff finds a non-delivery drop tile adjacent to delivery with vacate + approach', () => {
  const t = bindHandoff(grid3x2(), { x: 2, y: 1 })
  expect(t).toEqual({
    parcel: { x: 2, y: 1 },
    drop: { x: 1, y: 0 },
    vacate: { x: 1, y: 1 },
    approach: { x: 2, y: 0 },
    delivery: { x: 0, y: 0 },
  })
})

test('bindHandoff declines (null) when no walkable non-delivery tile is adjacent to a delivery', () => {
  // A lone delivery tile with all neighbours walls → no valid drop tile.
  const tiles: Tile[] = [
    { pos: { x: 0, y: 0 }, type: 'delivery' },
    { pos: { x: 1, y: 0 }, type: 'wall' },
    { pos: { x: 0, y: 1 }, type: 'wall' },
  ]
  expect(bindHandoff(buildGrid(tiles), { x: 0, y: 1 })).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/contract-runtime.test.ts`
Expected: FAIL — `bindHandoff` not yet defined.

- [ ] **Step 3: Add the `Grid` type import and `bindHandoff()`**

At the top of `src/coordination/contract.ts`, add to the imports (after the existing `Pos` import):

```ts
import type { Grid } from '../planning/astar.js'
```

After `handoffContract()`, add:

```ts
// §8.3 runtime tile binding (the 3 binding rules). Pure over the grid + parcel position. Returns a
// HandoffTiles or null ⇒ DECLINE the bid (do not propose). A `drop` tile must be walkable, NON-
// delivery (a delivery-tile drop would score for the picker solo, voiding the cross-agent condition)
// and adjacent to a delivery tile; it must have ≥2 distinct walkable non-delivery neighbours for the
// picker's `vacate` step-off and the deliverer's `approach` staging (agents never share a tile).
// Deterministic: delivery zones in array order, neighbours in a fixed order, free neighbours sorted.
// Walkability here is grid-only (non-wall); full push-aware reachability is left to stepToward,
// which blocks gracefully if a bound tile turns out unreachable at run time.
export function bindHandoff(grid: Grid, parcel: Pos): HandoffTiles | null {
  const walkableNonDelivery = (p: Pos): boolean => {
    const t = grid.tiles.get(`${p.x},${p.y}`)
    return t !== undefined && t.type !== 'wall' && t.type !== 'delivery'
  }
  const neigh = (p: Pos): Pos[] => [
    { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 },
    { x: p.x - 1, y: p.y }, { x: p.x + 1, y: p.y },
  ]
  const eq = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y
  for (const delivery of grid.deliveryZones) {
    for (const drop of neigh(delivery)) {
      if (!walkableNonDelivery(drop)) continue
      const free = neigh(drop)
        .filter((n) => walkableNonDelivery(n) && !eq(n, delivery))
        .sort((a, b) => a.x - b.x || a.y - b.y)
      if (free.length >= 2) {
        return { parcel, drop, vacate: free[0], approach: free[1], delivery }
      }
    }
  }
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/contract-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coordination/contract.ts tests/contract-runtime.test.ts
git commit -m "feat(contract): §8.3 bindHandoff runtime tile binder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Loop wiring — `actContract` pickup/putdown + MISSION-lock reconcile (driven by e2e)

**Files:**
- Create: `tests/contract-handoff-e2e.test.ts`
- Modify: `src/bdi/loop.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/contract-handoff-e2e.test.ts`:

```ts
// tests/contract-handoff-e2e.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime, handoffContract, bindHandoff, isContractMsg } from '../src/coordination/contract.js'
import { buildGrid } from '../src/planning/astar.js'
import { ClaimStore, isClaimMsg } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage, AgentId } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// 3x2 walkable grid (x:0..2, y:0..1) with (0,0) the delivery tile.
function hMap(): Tile[] {
  const tiles: Tile[] = []
  for (let x = 0; x <= 2; x++) for (let y = 0; y <= 1; y++) {
    tiles.push({ pos: { x, y }, type: x === 0 && y === 0 ? 'delivery' : 'walkable' })
  }
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

test('two loops complete a handoff and the MISSION lock is installed then released', async () => {
  const grid = buildGrid(hMap())
  const tiles = bindHandoff(grid, { x: 2, y: 1 })!
  expect(tiles).not.toBeNull()

  // Picker = liaison (starts on the parcel); deliverer = courier (starts away from the corridor).
  const L = movingClient(hMap(), 'liaison', { x: 2, y: 1 })
  const C = movingClient(hMap(), 'courier', { x: 0, y: 1 })
  const lc = new ContractRuntime()
  const cc = new ContractRuntime()
  const lClaims = new ClaimStore()
  const cClaims = new ClaimStore()

  // In-memory a2a buses: each agent's outbound msgs are routed to the OTHER's runtime/store.
  const inbox: Record<AgentId, A2AMessage[]> = { liaison: [], courier: [] }
  const send = (m: A2AMessage): void => { inbox[m.to].push(structuredClone(m)) }
  const rts: Record<AgentId, ContractRuntime> = { liaison: lc, courier: cc }
  const stores: Record<AgentId, ClaimStore> = { liaison: lClaims, courier: cClaims }
  function drain(self: AgentId): void {
    for (const m of inbox[self].splice(0)) {
      if (m.type === 'contract' && isContractMsg(m.payload)) {
        const reply = rts[self].applyMsg(m.payload, self)
        if (reply !== null) send({ from: self, to: m.from, type: 'contract', payload: reply })
      } else if (m.type === 'claims' && isClaimMsg(m.payload)) {
        stores[self].applyMsg(m.payload, self)
      }
    }
  }

  const loopL = new BdiLoop(L.client, DEFAULT_PARAMS, log, lClaims,
    { partner: 'courier', send }, { view: new TeamMissionView(), pursue: true, contracts: lc })
  const loopC = new BdiLoop(C.client, DEFAULT_PARAMS, log, cClaims,
    { partner: 'liaison', send }, { view: new TeamMissionView(), pursue: false, contracts: cc })

  // Liaison proposes the handoff; wrap in an A2AMessage envelope (mirrors sendContract()).
  const proposeMsg = lc.propose(handoffContract('h1', 'p1', 'liaison', 'courier', tiles, 200, 9999))
  send({ from: 'liaison', to: 'courier', type: 'contract', payload: proposeMsg })

  // Drive until both runtimes have torn the contract down AND the MISSION lock is released.
  let guard = 0
  let lockSeen = false
  while ((lc.current() !== null || cc.current() !== null ||
          lClaims.claimedBy('p1') !== null || cClaims.claimedBy('p1') !== null) && guard++ < 60) {
    drain('liaison'); drain('courier')
    await loopL.tick(snapAt(L.pos))
    await loopC.tick(snapAt(C.pos))
    drain('liaison'); drain('courier')
    if (lClaims.claimedBy('p1') === 'liaison') lockSeen = true
  }

  expect(guard).toBeLessThan(60)          // converged, did not spin out
  expect(lc.current()).toBeNull()         // both tore down on SATISFIED
  expect(cc.current()).toBeNull()
  expect(lockSeen).toBe(true)             // picker MISSION-locked p1 during the contract (§9.10)
  expect(lClaims.claimedBy('p1')).toBeNull()  // released on teardown
  expect(cClaims.claimedBy('p1')).toBeNull()  // release replicated to the partner
  expect(L.pos).toEqual({ x: 1, y: 1 })   // picker ended on the vacate tile
  expect(C.pos).toEqual({ x: 0, y: 0 })   // deliverer ended on the delivery tile
})
```

- [ ] **Step 2: Run the e2e to verify it fails**

Run: `bun test tests/contract-handoff-e2e.test.ts`
Expected: FAIL — `actContract` does not handle `pickup`/`putdown` (the contract never advances past the first ACTION), and no MISSION lock is ever installed (`lockSeen` stays false).

- [ ] **Step 3: Add the `contractLocks` field**

In `src/bdi/loop.ts`, add a field to `BdiLoop` (next to the other private fields, ~line 38):

```ts
  private readonly contractLocks = new Set<string>() // §9.10 — MISSION-lock ids this loop installed
```

- [ ] **Step 4: Add `reconcileContractLocks()` and call it before the contract short-circuit**

In `src/bdi/loop.ts`, immediately before the `const activeContract = ...` line (~line 108), insert the call:

```ts
    // §9.10 — MISSION-lock reconcile (level-triggered, idempotent). The picker (lockOwner) installs
    // the active contract's lockParcels as origin:'MISSION' claims; teardown (no active contract I
    // own) releases them. Runs BEFORE the contract short-circuit so a release tick still falls
    // through to base play.
    this.reconcileContractLocks(tnow)
```

Add the method next to `actContract` (after `sendContract`, ~line 332):

```ts
  // §9.10 producer. MISSION claims never expire (ClaimStore.expire) and never rebalance
  // (rebalance.ts), so originD/lastD are inert here (set 0). Single writer: only the lockOwner
  // (handoff picker) installs, so there is no claim race; the partner's replica receives the lock
  // over the 'claims' channel and its auction/rebalance already exclude origin==='MISSION'.
  private reconcileContractLocks(tnow: number): void {
    const c = this.mission?.contracts?.active() ?? null
    const me = this.client.role
    if (c !== null && c.lockOwner === me) {
      for (const id of c.lockParcels ?? []) {
        if (this.contractLocks.has(id)) continue
        const claim: Claim = { parcelId: id, agentId: me, origin: 'MISSION', epoch: tnow, commitTick: tnow, originD: 0, lastD: 0, lastProgressTick: tnow }
        this.claims.add(claim)
        this.broadcast({ kind: 'claim', claim })
        this.contractLocks.add(id)
        this.log.info({ tick: tnow, contract: c.id, parcelId: id }, 'MISSION lock installed')
      }
      return
    }
    // No active contract I own → release every lock I installed (teardown, §4.3).
    if (this.contractLocks.size > 0) {
      for (const id of [...this.contractLocks].sort()) {
        this.claims.remove(id)
        this.broadcast({ kind: 'release', parcelId: id, epoch: tnow })
        this.log.info({ tick: tnow, parcelId: id }, 'MISSION lock released')
      }
      this.contractLocks.clear()
    }
  }
```

- [ ] **Step 5: Add the pickup/putdown branch to `actContract()`**

In `src/bdi/loop.ts`, in `actContract` (~line 303), insert this branch after the `navigate` block and before the `post` block:

```ts
    if (action.kind === 'pickup' || action.kind === 'putdown') {
      this.acting = true
      try {
        if (action.kind === 'pickup') {
          await this.client.pickup()
          beliefs.applyPickup(action.ids)
        } else {
          await this.client.putdown(action.ids)
          // A scoring delivery removes the parcel; a non-delivery drop leaves it on the ground at
          // `self` (= the ACTION tile, since advance emits putdown only when self === at). §8.3.
          if (action.onDelivery) beliefs.applyDelivery(action.ids)
          else beliefs.applyDrop(action.ids, self)
        }
      } finally {
        this.acting = false
      }
      const msg = this.mission!.contracts!.post(action.post)
      if (msg !== null) this.sendContract(msg)
      this.log.info({ tick: tnow, contract: c.id, action: action.kind, ids: action.ids, post: action.post }, 'contract action')
      return
    }
```

- [ ] **Step 6: Run the e2e to verify it passes**

Run: `bun test tests/contract-handoff-e2e.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add src/bdi/loop.ts tests/contract-handoff-e2e.test.ts
git commit -m "feat(bdi): execute handoff ACTION steps + §9.10 MISSION-lock producer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full suite + base-play regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test tests/`
Expected: `All tests passed.` — in particular the rendezvous e2e (`contract-rendezvous-e2e.test.ts`) and all base-play tests stay green, proving the `advance()` terminal-condition change and the pre-short-circuit `reconcileContractLocks` call are backward-compatible (no contract active ⇒ reconcile is a no-op ⇒ base play unchanged).

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors (strict mode; `ACTION` step exhaustiveness in `advance` covered by the union).

- [ ] **Step 3: Final commit (only if Steps 1-2 surfaced fixes)**

```bash
git add -A
git commit -m "test(contract): handoff slice green across the suite

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done When

A `handoffContract` (tiles from `bindHandoff`) proposed on one `ContractRuntime` and accepted by the
other drives two `BdiLoop`s — each reading only its own perception — through pickup → carry →
ground-drop → vacate → barrier → cross-agent pickup → scoring delivery, both reaching `SATISFIED`
with the slot cleared on both replicas, and the `origin:'MISSION'` lock installed by the picker for
the contract's life and released on teardown (replicated to the partner). Proven by
`tests/contract-handoff-e2e.test.ts`. Base play is byte-for-byte unchanged when no contract is
active (`bun test tests/` stays green).

## Out of scope (follow-on)

- LLM-compiler → `COORDINATION_CONTRACT` mission → contract bridge, incl. the proposer-side
  role-binding helper (picker = closer from shared beliefs) — the builder takes explicit roles for now.
- Lifecycle hardening: barrier deadlines → `FAILED`, commit timeout → `ABORTED`, adoption gating.
- Opportunistic base-play pickups while blocked at a barrier.
- Full push-aware reachability inside `bindHandoff` (currently grid-walkability only).

## Review-surfaced follow-on TODOs (from the final whole-branch review)

Captured here so the bridge / lifecycle-hardening author addresses them when the relevant code path first exists. None is a live defect in this slice (the handoff contract's `lockParcels === ids` is a fixed singleton and no abort/back-to-back path exists yet).

- **AUCTION-claim release on contract pickup (bridge):** `actContract`'s contract pickup does not release an AUCTION self-claim on the picked id the way base-play `doPickup` does. Safe today (the only contract id is the MISSION-locked parcel), but a future caller that puts a parcel already AUCTION-claimed into `ACTION.ids` would leak that claim (released only via TTL). Add a release/guard when the bridge can emit such ids.
- **Same-tick re-lock race (bridge):** teardown `release` uses `epoch: tnow`; `applyMsg` only ignores `epoch < cur.epoch`. Back-to-back handoffs re-locking the *same* parcel on the *same* tick could let a same-epoch release delete the new lock at the partner. No back-to-back path exists yet; guard when chaining contracts on a shared parcel becomes possible.
- **`rewardSeen=0` synthetic belief on abort (lifecycle hardening):** `BeliefBase.ensureParcel` inserts the deliverer's never-perceived handoff parcel with `rewardSeen=0`. While the contract is ACTIVE the §9 selector is short-circuited so 0 cannot bias a route; but if a future abort path tears the contract down *after* the deliverer picked up and *before* delivery, it is left carrying a 0-reward synthetic parcel and `U_route` would value delivering it at 0. The abort handler must `applyDrop`/`applyDelivery` (or refresh `rewardSeen`) for any still-carried contract parcel.
- **`bindHandoff` vacate/approach mutual blocking (push-aware reachability):** the two free neighbours of the drop tile are only guaranteed distinct + walkable; `approach` may sit on the picker's vacate route, causing transient mutual blocking that only `stepToward` re-planning resolves. Acceptable liveness soft spot today; subsumed by the full push-aware reachability follow-on above.
