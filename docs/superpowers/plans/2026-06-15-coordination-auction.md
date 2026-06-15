# Coordination — team-optimal allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn two independently-playing BDI agents into a cooperating team via a leader-less SSI auction over soft replicated claims, a global rebalance, and a dispersion tie-break (DESIGN §9).

**Architecture:** Both agents run the *identical* deterministic auction on the shared belief replica, so no bids are exchanged — only the resulting claim is broadcast on a `type:'claims'` a2a channel; lower-id resolves the rare same-epoch double-commit. Claims are stored sticky state; each agent's route is *derived* from its own claims via `routeFromClaims`. Pure modules (`auction`, `rebalance`, `dispersion`) take shared state + params in and a decision out; `ClaimStore` holds and replicates the claims.

**Tech Stack:** Bun + TypeScript (strict, ESM, `.js` import suffixes), `bun test`, Pino logger interface, existing `src/bdi/route.ts` (`buildRoute`/`uRoute`/`vValue` with the `ParcelWeight` factor already shipped).

**Spec:** `docs/superpowers/specs/2026-06-15-coordination-auction-design.md`

**Reused types (already in the codebase — do not redefine):**
- `AgentId = 'liaison' | 'courier'`, `A2AMessage { from, to, type: string, payload: unknown }` — `src/types/a2a.ts`
- `ParcelBelief { id, pos, rewardSeen, carriedBy: string|null, lastSeen }`, `AgentBelief { id, pos, rel, lastSeen, carrying? }` — `src/blackboard/beliefs.ts`
- `Pos { x, y }` — `src/types/perception.ts`
- `DecayConsts`, `EnemyThreat`, `pAvail`, `ParcelWeight`, `W1` — `src/bdi/utility.ts`
- `Route`, `buildRoute`, `uRoute` — `src/bdi/route.ts`
- `Params`, `DEFAULT_PARAMS` — `src/bdi/params.ts`

**Determinism discipline (applies to every pure module):** iterate parcels/agents in a **sorted** order (`parcelId`, then `agentId`) so both replicas produce byte-identical results. Never iterate a `Map` for a decision without sorting its keys first.

---

## Task 1: Coordination hyperparameters

**Files:**
- Modify: `src/bdi/params.ts`
- Modify: `config/params.yaml`
- Test: `tests/bdi-params.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/bdi-params.test.ts`:

```ts
test('coordination defaults are present and sane', () => {
  expect(DEFAULT_PARAMS.claim_ttl).toBe(10)
  expect(DEFAULT_PARAMS.bid_wait).toBe(1)
  expect(DEFAULT_PARAMS.rebalance_period).toBe(15)
  expect(DEFAULT_PARAMS.auction_budget_ms).toBe(8)
  expect(DEFAULT_PARAMS.theta_disp).toBeGreaterThan(0)
})

test('out-of-range coordination key throws', () => {
  // a 0-tick CLAIM_TTL would expire every claim instantly — reject it
  expect(() => loadParams('tests/fixtures/params-bad-ttl.yaml')).toThrow()
})
```

- [ ] **Step 2: Create the bad-fixture file**

Create `tests/fixtures/params-bad-ttl.yaml`:

```yaml
claim_ttl: 0
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test ./tests/bdi-params.test.ts`
Expected: FAIL — `DEFAULT_PARAMS.claim_ttl` is `undefined`.

- [ ] **Step 4: Extend `Params`, defaults, and ranges**

In `src/bdi/params.ts`, add to the `Params` interface (after `push_plan_budget_ms`):

```ts
  claim_ttl: number          // soft-claim expiry if no progress (ticks)
  bid_wait: number           // max wait for partner's same-epoch commit (ticks)
  rebalance_period: number   // global rebalance cadence (ticks)
  auction_budget_ms: number  // anytime cap on the SSI auction (ms)
  theta_disp: number         // dispersion weight (tie-break-only)
```

Add to `DEFAULT_PARAMS`:

```ts
  claim_ttl: 10,
  bid_wait: 1,
  rebalance_period: 15,
  auction_budget_ms: 8,
  theta_disp: 0.05,
```

Add to `RANGES`:

```ts
  claim_ttl: [1, 1000],
  bid_wait: [0, 100],
  rebalance_period: [1, 10000],
  auction_budget_ms: [0, 1000],
  theta_disp: [0, 4],
```

- [ ] **Step 5: Document the keys in `config/params.yaml`**

Append to `config/params.yaml`:

```yaml
# Coordination (DESIGN §9 / §12). Omit a key to take its default.
claim_ttl: 10           # soft-claim expiry if no progress  [ticks]
bid_wait: 1             # max wait for partner's same-epoch commit  [ticks]
rebalance_period: 15    # global rebalance cadence  [ticks]
auction_budget_ms: 8    # anytime cap on the SSI auction  [ms]
theta_disp: 0.05        # dispersion weight (tie-break-only)
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test ./tests/bdi-params.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/bdi/params.ts config/params.yaml tests/bdi-params.test.ts tests/fixtures/params-bad-ttl.yaml
git commit -m "feat(params): coordination tunables (CLAIM_TTL, REBALANCE_PERIOD, theta_disp …)"
```

---

## Task 2: `routeFromClaims` — service a committed parcel set

A claim is committed, so the route must include **every** own claim (unlike `buildRoute`, which greedily *selects* from a pool). This primitive orders a fixed set by cheapest insertion and includes all of it.

**Files:**
- Modify: `src/bdi/route.ts`
- Test: `tests/bdi-route.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/bdi-route.test.ts`:

```ts
import { routeFromClaims } from '../src/bdi/route.js'

test('routeFromClaims includes every claimed parcel (never drops a low-value one)', () => {
  // a worthless far parcel that buildRoute's emergent horizon would drop is still serviced
  const claimed = [parcel('near', 2, 0, 10), parcel('far', 40, 0, 1)]
  const r = routeFromClaims([], claimed, { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, manhattan)!
  expect(r.pickups.map((p) => p.id).sort()).toEqual(['far', 'near'])
})

test('routeFromClaims of an empty commitment is null', () => {
  expect(routeFromClaims([], [], { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, manhattan)).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/bdi-route.test.ts`
Expected: FAIL — `routeFromClaims` is not exported.

- [ ] **Step 3: Implement `routeFromClaims`**

In `src/bdi/route.ts`, add after `buildRoute` (it reuses the existing private `score`/`bestInsert` and the `W1`/`ParcelWeight` already imported):

```ts
/**
 * §9.7 route derived from a committed claim set: order ALL of `claimed` by greedy
 * cheapest insertion and include every one (committed parcels are never dropped —
 * the auction already decided to take them). Null only when carrying nothing AND
 * no claim is reachable. Pass `claimed` pre-sorted by id for replica-determinism.
 */
export function routeFromClaims(carried: ParcelBelief[], claimed: ParcelBelief[], self: Pos, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight = W1): Route | null {
  if (carried.length === 0 && claimed.length === 0) return null
  let cur = score(self, carried, [], zones, tnow, dc, params, dist, weight)
  if (cur === null) return null // no reachable zone
  for (const p of claimed) {
    const ins = bestInsert(self, carried, cur.route.pickups, p, zones, tnow, dc, params, dist, weight)
    if (ins !== null) cur = ins // unreachable insertion: skip; parcel stays claimed but unrouted this tick
  }
  return cur.route
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/bdi-route.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/route.ts tests/bdi-route.test.ts
git commit -m "feat(route): routeFromClaims — service a committed parcel set in full (§9.7)"
```

---

## Task 3: `Claim` type + `ClaimStore` core (store, query, expiry)

**Files:**
- Create: `src/coordination/claims.ts`
- Test: `tests/coordination-claims.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/coordination-claims.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { ClaimStore, type Claim } from '../src/coordination/claims.js'

const claim = (parcelId: string, agentId: 'liaison' | 'courier', over: Partial<Claim> = {}): Claim => ({
  parcelId, agentId, origin: 'AUCTION', epoch: 1, commitTick: 0, originD: 5, lastD: 5, lastProgressTick: 0, ...over,
})

test('add / claimedBy / ownClaims / partnerClaimed', () => {
  const s = new ClaimStore()
  s.add(claim('p1', 'courier'))
  s.add(claim('p2', 'liaison'))
  expect(s.claimedBy('p1')).toBe('courier')
  expect(s.claimedBy('p3')).toBeNull()
  expect(s.ownClaims('courier').map((c) => c.parcelId)).toEqual(['p1'])
  expect([...s.partnerClaimed('courier')]).toEqual(['p2'])
})

test('expire drops claims with no progress for CLAIM_TTL ticks', () => {
  const s = new ClaimStore()
  s.add(claim('stuck', 'courier', { lastD: 5, lastProgressTick: 0 }))
  // tnow=10, still 5 away (no progress since tick 0), CLAIM_TTL=10 → expires
  const dropped = s.expire(10, () => 5, 10)
  expect(dropped.map((c) => c.parcelId)).toEqual(['stuck'])
  expect(s.claimedBy('stuck')).toBeNull()
})

test('expire keeps a claim that is still making progress', () => {
  const s = new ClaimStore()
  s.add(claim('moving', 'courier', { lastD: 5, lastProgressTick: 0 }))
  s.expire(3, () => 4, 10) // got closer (5→4) at tick 3 → progress, resets timer
  const dropped = s.expire(12, () => 4, 10) // 9 ticks since last progress < 10 → kept
  expect(dropped).toEqual([])
  expect(s.claimedBy('moving')).toBe('courier')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/coordination-claims.test.ts`
Expected: FAIL — module `claims.js` does not exist.

- [ ] **Step 3: Implement `Claim` + `ClaimStore` core**

Create `src/coordination/claims.ts`:

```ts
// src/coordination/claims.ts
// Stored, replicated coordination state (DESIGN §9.2/§9.7/§9.10). One local replica
// per agent, kept convergent by broadcasting commits (Task 4). Claims are stored;
// routes are derived from them (§2.3.2) and never published.
import type { AgentId } from '../types/a2a.js'

export type ClaimOrigin = 'AUCTION' | 'MISSION' // only AUCTION is created this slice

export interface Claim {
  parcelId: string
  agentId: AgentId
  origin: ClaimOrigin
  epoch: number // material-change round id; monotone, tick-derived
  commitTick: number
  originD: number // d(committer pos at commit, parcel) — sunk-travel basis (§9.6)
  lastD: number // most recent d(owner now, parcel)
  lastProgressTick: number // last tick lastD strictly decreased (§9.7 CLAIM_TTL liveness)
}

export class ClaimStore {
  private readonly byParcel = new Map<string, Claim>()

  claimedBy(parcelId: string): AgentId | null {
    return this.byParcel.get(parcelId)?.agentId ?? null
  }

  /** Own claims, sorted by parcelId for replica-deterministic route ordering. */
  ownClaims(self: AgentId): Claim[] {
    return [...this.byParcel.values()].filter((c) => c.agentId === self).sort((a, b) => a.parcelId.localeCompare(b.parcelId))
  }

  /** Parcel ids claimed by anyone other than `self` (§9.4 P_avail=0 set). */
  partnerClaimed(self: AgentId): Set<string> {
    const out = new Set<string>()
    for (const c of this.byParcel.values()) if (c.agentId !== self) out.add(c.parcelId)
    return out
  }

  add(c: Claim): void {
    this.byParcel.set(c.parcelId, c)
  }

  remove(parcelId: string): void {
    this.byParcel.delete(parcelId)
  }

  /**
   * §9.7 liveness. `distOf(c)` = d(owner now, parcel). Updates lastD/lastProgressTick;
   * returns (and removes) AUCTION claims with no strict progress for CLAIM_TTL ticks.
   * MISSION claims never expire here (§9.10). Iterates sorted ids for determinism.
   */
  expire(tnow: number, distOf: (c: Claim) => number, claimTtl: number): Claim[] {
    const dropped: Claim[] = []
    for (const id of [...this.byParcel.keys()].sort()) {
      const c = this.byParcel.get(id)!
      const d = distOf(c)
      if (d < c.lastD) {
        c.lastD = d
        c.lastProgressTick = tnow
      }
      if (c.origin === 'AUCTION' && tnow - c.lastProgressTick >= claimTtl) {
        this.byParcel.delete(id)
        dropped.push(c)
      }
    }
    return dropped
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/coordination-claims.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/coordination/claims.ts tests/coordination-claims.test.ts
git commit -m "feat(coordination): ClaimStore core — store, query, CLAIM_TTL expiry (§9.7)"
```

---

## Task 4: `ClaimStore` replication — `ClaimMsg` + conflict resolution

**Files:**
- Modify: `src/coordination/claims.ts`
- Test: `tests/coordination-claims.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/coordination-claims.test.ts`:

```ts
import { isClaimMsg, type ClaimMsg } from '../src/coordination/claims.js'

test('applyMsg: claim then release converges', () => {
  const s = new ClaimStore()
  s.applyMsg({ kind: 'claim', claim: claim('p1', 'liaison') }, 'courier')
  expect(s.claimedBy('p1')).toBe('liaison')
  s.applyMsg({ kind: 'release', parcelId: 'p1', epoch: 1 }, 'courier')
  expect(s.claimedBy('p1')).toBeNull()
})

test('applyMsg: same-epoch conflict resolves to lower agent id', () => {
  const s = new ClaimStore()
  s.add(claim('p1', 'liaison')) // local owner: liaison
  // partner 'courier' also claims p1 at the same epoch; 'courier' < 'liaison' → courier wins
  s.applyMsg({ kind: 'claim', claim: claim('p1', 'courier') }, 'liaison')
  expect(s.claimedBy('p1')).toBe('courier')
})

test('applyMsg: higher-id incoming claim does not override the lower-id local owner', () => {
  const s = new ClaimStore()
  s.add(claim('p1', 'courier')) // local owner: courier (lower id)
  s.applyMsg({ kind: 'claim', claim: claim('p1', 'liaison') }, 'courier')
  expect(s.claimedBy('p1')).toBe('courier')
})

test('isClaimMsg guards malformed payloads', () => {
  expect(isClaimMsg({ kind: 'claim', claim: claim('p1', 'courier') })).toBe(true)
  expect(isClaimMsg({ kind: 'nope' })).toBe(false)
  expect(isClaimMsg(null)).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/coordination-claims.test.ts`
Expected: FAIL — `applyMsg` / `isClaimMsg` / `ClaimMsg` not exported.

- [ ] **Step 3: Implement the replication sub-protocol**

In `src/coordination/claims.ts`, add the message type above the class:

```ts
/** The claims sub-protocol carried in A2AMessage.payload on the `type:'claims'` channel. */
export type ClaimMsg =
  | { kind: 'claim'; claim: Claim }
  | { kind: 'release'; parcelId: string; epoch: number }
  | { kind: 'swap'; parcelId: string; toAgent: AgentId; epoch: number }

/** Narrowing guard for an inbound claims payload (unknown → ClaimMsg). */
export function isClaimMsg(p: unknown): p is ClaimMsg {
  if (typeof p !== 'object' || p === null) return false
  const m = p as Record<string, unknown>
  switch (m.kind) {
    case 'claim':
      return typeof m.claim === 'object' && m.claim !== null && typeof (m.claim as Claim).parcelId === 'string'
    case 'release':
      return typeof m.parcelId === 'string' && typeof m.epoch === 'number'
    case 'swap':
      return typeof m.parcelId === 'string' && typeof m.toAgent === 'string' && typeof m.epoch === 'number'
    default:
      return false
  }
}
```

Add the `applyMsg` method to `ClaimStore`:

```ts
  /**
   * Apply an inbound replication message. Conflict rule (§9.3): if an incoming
   * same-epoch claim contends with a local claim on the same parcel, the lower
   * agentId keeps it (deterministic, so a double-chase lasts ≤ 1 tick).
   */
  applyMsg(msg: ClaimMsg, _self: AgentId): void {
    switch (msg.kind) {
      case 'claim': {
        const incoming = msg.claim
        const cur = this.byParcel.get(incoming.parcelId)
        if (cur && cur.epoch === incoming.epoch && cur.agentId !== incoming.agentId) {
          // same-epoch conflict → lower id wins
          if (incoming.agentId < cur.agentId) this.byParcel.set(incoming.parcelId, incoming)
          return
        }
        this.byParcel.set(incoming.parcelId, incoming)
        return
      }
      case 'release':
        this.byParcel.delete(msg.parcelId)
        return
      case 'swap': {
        const cur = this.byParcel.get(msg.parcelId)
        if (cur) cur.agentId = msg.toAgent
        return
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/coordination-claims.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/coordination/claims.ts tests/coordination-claims.test.ts
git commit -m "feat(coordination): claim replication + lower-id conflict resolution (§9.3)"
```

---

## Task 5: `dispersion.ts` — awayFromPartner tie-break

**Files:**
- Create: `src/coordination/dispersion.ts`
- Test: `tests/coordination-dispersion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/coordination-dispersion.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { awayFromPartner } from '../src/coordination/dispersion.js'
import type { Pos } from '../src/types/perception.js'

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

test('0 at the partner target, rising toward 1 with distance, capped at 1', () => {
  const target: Pos = { x: 0, y: 0 }
  const Dref = 10
  expect(awayFromPartner({ x: 0, y: 0 }, target, Dref, manhattan)).toBe(0)
  expect(awayFromPartner({ x: 5, y: 0 }, target, Dref, manhattan)).toBeCloseTo(0.5, 10)
  expect(awayFromPartner({ x: 50, y: 0 }, target, Dref, manhattan)).toBe(1) // capped
})

test('no partner target → neutral 0 (degraded mode handles region ownership elsewhere)', () => {
  expect(awayFromPartner({ x: 5, y: 0 }, null, 10, manhattan)).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/coordination-dispersion.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/coordination/dispersion.ts`:

```ts
// src/coordination/dispersion.ts
// §9.5 soft dispersion: a bounded, tie-break-only repulsion from where the partner
// is heading. Added (weighted by θ_disp) to U_explore regions and zone choice.
import type { Pos } from '../types/perception.js'

/**
 * §9.5. min(1, d(x, partnerTarget)/D_ref) ∈ [0,1]. `partnerTarget` is the head of
 * the partner's derived route (its intention), or null when unknown — null yields 0
 * so the term vanishes (degraded mode falls back to static region ownership elsewhere).
 */
export function awayFromPartner(x: Pos, partnerTarget: Pos | null, dRef: number, dist: (a: Pos, b: Pos) => number): number {
  if (partnerTarget === null || dRef <= 0) return 0
  return Math.min(1, dist(x, partnerTarget) / dRef)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/coordination-dispersion.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/coordination/dispersion.ts tests/coordination-dispersion.test.ts
git commit -m "feat(coordination): awayFromPartner dispersion tie-break (§9.5)"
```

---

## Task 6: `auction.ts` — deterministic marginal-route SSI auction

**Files:**
- Create: `src/coordination/auction.ts`
- Test: `tests/coordination-auction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/coordination-auction.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { runAuction, type AgentSnap } from '../src/coordination/auction.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { GameConsts, Pos } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const parcel = (id: string, x: number, reward = 10): ParcelBelief => ({ id, pos: { x, y: 0 }, rewardSeen: reward, carriedBy: null, lastSeen: 0 })
const zones: Pos[] = [{ x: 0, y: 0 }]

const snap = (id: 'liaison' | 'courier', x: number): AgentSnap => ({ id, pos: { x, y: 0 }, carried: [], claimed: [] })

test('synergy: a parcel goes to the closer agent (cheaper marginal insert), not by count', () => {
  // p1 near courier(1,0), far from liaison(9,0)
  const alloc = runAuction({
    pool: [parcel('p1', 2)], agents: [snap('courier', 1), snap('liaison', 9)],
    enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 0, budgetMs: 50,
  })
  expect(alloc.get('p1')).toBe('courier')
})

test('two parcels on one path are both assigned (rounds re-bid)', () => {
  const alloc = runAuction({
    pool: [parcel('p1', 2), parcel('p2', 3)], agents: [snap('courier', 1), snap('liaison', 40)],
    enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 0, budgetMs: 50,
  })
  expect(alloc.get('p1')).toBe('courier')
  expect(alloc.get('p2')).toBe('courier')
})

test('zero budget assigns nothing (anytime fallback)', () => {
  const alloc = runAuction({
    pool: [parcel('p1', 2)], agents: [snap('courier', 1), snap('liaison', 9)],
    enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 0, budgetMs: 0,
  })
  expect(alloc.size).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/coordination-auction.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the auction**

Create `src/coordination/auction.ts`:

```ts
// src/coordination/auction.ts
// §9.3 sequential single-item (SSI) marginal-route auction. Deterministic and
// leader-less: both replicas run this identical function over shared beliefs and
// reach the identical full allocation. Each round commits the global-best (p*, X*)
// only if it strictly improves X*'s route (emergent horizon, team level); the pool
// is then re-bid because every Δ shifts with X*'s new route.
import type { ParcelBelief, AgentBelief } from '../blackboard/beliefs.js'
import type { Pos } from '../types/perception.js'
import type { Params } from '../bdi/params.js'
import type { AgentId } from '../types/a2a.js'
import { routeFromClaims, uRoute } from '../bdi/route.js'
import { pAvail, type DecayConsts, type EnemyThreat, type ParcelWeight } from '../bdi/utility.js'

export interface AgentSnap {
  id: AgentId
  pos: Pos
  carried: ParcelBelief[]
  claimed: ParcelBelief[] // own already-committed claims (the base route)
}

export interface AuctionInput {
  pool: ParcelBelief[]
  agents: [AgentSnap, AgentSnap]
  enemies: AgentBelief[]
  zones: Pos[]
  dist: (a: Pos, b: Pos) => number
  dc: DecayConsts
  params: Params
  tnow: number
  epoch: number
  budgetMs: number
}

/** Per-agent P_avail weight for a parcel, from that agent's vantage (§5.5). */
function weightFor(agent: AgentSnap, enemies: AgentBelief[], dist: AuctionInput['dist'], dc: DecayConsts, params: Params, tnow: number): ParcelWeight {
  return (p: ParcelBelief): number => {
    if (p.carriedBy !== null) return 0
    const threats: EnemyThreat[] = enemies.map((e) => ({ age: tnow - e.lastSeen, dToP: dist(e.pos, p.pos) }))
    return pAvail(p, dist(agent.pos, p.pos), threats, params.beta_comp, tnow, dc)
  }
}

export function runAuction(inp: AuctionInput): Map<string, AgentId> {
  const t0 = performance.now()
  const alloc = new Map<string, AgentId>()
  const weights = new Map<AgentId, ParcelWeight>(inp.agents.map((a) => [a.id, weightFor(a, inp.enemies, inp.dist, inp.dc, inp.params, inp.tnow)]))
  // mutable per-agent claimed sets (start from existing claims)
  const claimed = new Map<AgentId, ParcelBelief[]>(inp.agents.map((a) => [a.id, [...a.claimed]]))
  const baseU = new Map<AgentId, number>()
  const routeU = (a: AgentSnap, set: ParcelBelief[]): number => {
    const sorted = [...set].sort((x, y) => x.parcelId.localeCompare(y.parcelId))
    const r = routeFromClaims(a.carried, sorted, a.pos, inp.zones, inp.tnow, inp.dc, inp.params, inp.dist, weights.get(a.id)!)
    return r === null ? 0 : uRoute(r, inp.tnow, inp.dc, inp.params, weights.get(a.id)!)
  }
  for (const a of inp.agents) baseU.set(a.id, routeU(a, claimed.get(a.id)!))

  // sorted pool for determinism; remaining shrinks each round
  const remaining = [...inp.pool].sort((a, b) => a.id.localeCompare(b.id))
  while (remaining.length > 0) {
    if (performance.now() - t0 >= inp.budgetMs) break // anytime cap
    let best: { p: ParcelBelief; idx: number; agent: AgentSnap; gain: number } | null = null
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i]!
      for (const a of inp.agents) {
        const gain = routeU(a, [...claimed.get(a.id)!, p]) - baseU.get(a.id)!
        // tie-break: larger gain, then lower agentId, then lower parcelId (sorted scan ⇒ id order stable)
        if (gain > 0 && (best === null || gain > best.gain || (gain === best.gain && a.id < best.agent.id))) {
          best = { p, idx: i, agent: a, gain }
        }
      }
    }
    if (best === null) break // emergent horizon: nothing improves any route
    claimed.get(best.agent.id)!.push(best.p)
    baseU.set(best.agent.id, routeU(best.agent, claimed.get(best.agent.id)!))
    alloc.set(best.p.id, best.agent.id)
    remaining.splice(best.idx, 1)
  }
  return alloc
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/coordination-auction.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/coordination/auction.ts tests/coordination-auction.test.ts
git commit -m "feat(coordination): deterministic marginal-route SSI auction (§9.3)"
```

---

## Task 7: `rebalance.ts` — switchCost-gated transfers

Concrete instantiation of §9.6's physics hysteresis: a transfer of claim `c` from `X` to `Y` is accepted iff the team rate gain beats `switchCost`, where `switchCost = ρ · (sunk_X + reApproach_Y) / (L_Yafter + 1)` — a points/tick penalty for forfeiting `sunk` already-spent ticks and re-incurring `Y`'s approach. Exact magnitude is offline-calibrated (§16); tests use clear-cut cases robust to the precise form.

**Files:**
- Create: `src/coordination/rebalance.ts`
- Test: `tests/coordination-rebalance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/coordination-rebalance.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { runRebalance, type RebalanceAgent } from '../src/coordination/rebalance.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { GameConsts, Pos } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'
import type { Claim } from '../src/coordination/claims.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const parcel = (id: string, x: number): ParcelBelief => ({ id, pos: { x, y: 0 }, rewardSeen: 10, carriedBy: null, lastSeen: 0 })
const claim = (parcelId: string, agentId: 'liaison' | 'courier', originD: number): Claim => ({ parcelId, agentId, origin: 'AUCTION', epoch: 0, commitTick: 0, originD, lastD: originD, lastProgressTick: 0 })
const zones: Pos[] = [{ x: 0, y: 0 }]

test('transfer accepted: a far parcel barely started moves to the much closer agent', () => {
  // liaison owns q at x=8 but is at x=9 (originD just 1 spent → low sunk); courier sits next to q
  const q = parcel('q', 8)
  const liaison: RebalanceAgent = { id: 'liaison', pos: { x: 9, y: 0 }, carried: [], claimed: [q] }
  const courier: RebalanceAgent = { id: 'courier', pos: { x: 8, y: 0 }, carried: [], claimed: [] }
  const reassign = runRebalance({ agents: [courier, liaison], claims: [claim('q', 'liaison', 1)], enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 1 })
  expect(reassign.find((r) => r.parcelId === 'q')?.toAgent).toBe('courier')
})

test('transfer refused: high sunk travel sticks the parcel to its owner', () => {
  // liaison owns q at x=8, started 8 away, now 1 away (sunk 7) → switchCost huge; courier slightly closer is not enough
  const q = parcel('q', 8)
  const liaison: RebalanceAgent = { id: 'liaison', pos: { x: 7, y: 0 }, carried: [], claimed: [q] }
  const courier: RebalanceAgent = { id: 'courier', pos: { x: 8, y: 0 }, carried: [], claimed: [] }
  const reassign = runRebalance({ agents: [courier, liaison], claims: [claim('q', 'liaison', 8)], enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 1 })
  expect(reassign).toEqual([])
})

test('picked-up parcels never rebalance', () => {
  const carried = { id: 'held', pos: { x: 5, y: 0 }, rewardSeen: 10, carriedBy: 'liaison', lastSeen: 0 } as ParcelBelief
  const liaison: RebalanceAgent = { id: 'liaison', pos: { x: 5, y: 0 }, carried: [carried], claimed: [] }
  const courier: RebalanceAgent = { id: 'courier', pos: { x: 5, y: 0 }, carried: [], claimed: [] }
  const reassign = runRebalance({ agents: [courier, liaison], claims: [claim('held', 'liaison', 0)], enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 1 })
  expect(reassign).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/coordination-rebalance.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement rebalance**

Create `src/coordination/rebalance.ts`:

```ts
// src/coordination/rebalance.ts
// §9.6 periodic global rebalance: 2-opt-style single-claim transfers between the two
// agents, accepted only when the team rate gain beats the physics-derived switchCost
// (sunk travel forfeited + the other agent's re-approach). Deterministic: both replicas
// compute the identical verdict from shared state, so no negotiation is needed.
import type { ParcelBelief, AgentBelief } from '../blackboard/beliefs.js'
import type { Pos } from '../types/perception.js'
import type { Params } from '../bdi/params.js'
import type { AgentId } from '../types/a2a.js'
import type { Claim } from './claims.js'
import { routeFromClaims, uRoute } from '../bdi/route.js'
import { pAvail, type DecayConsts, type EnemyThreat, type ParcelWeight } from '../bdi/utility.js'

export interface RebalanceAgent {
  id: AgentId
  pos: Pos
  carried: ParcelBelief[]
  claimed: ParcelBelief[] // own AUCTION-claimed, not-yet-picked parcels (the route)
}

export interface RebalanceInput {
  agents: [RebalanceAgent, RebalanceAgent]
  claims: Claim[] // current AUCTION claims (for originD / sunk travel)
  enemies: AgentBelief[]
  zones: Pos[]
  dist: (a: Pos, b: Pos) => number
  dc: DecayConsts
  params: Params
  tnow: number
  epoch: number
}

export interface Reassign {
  parcelId: string
  toAgent: AgentId
}

function weightFor(agent: RebalanceAgent, inp: RebalanceInput): ParcelWeight {
  return (p: ParcelBelief): number => {
    if (p.carriedBy !== null) return 0
    const threats: EnemyThreat[] = inp.enemies.map((e) => ({ age: inp.tnow - e.lastSeen, dToP: inp.dist(e.pos, p.pos) }))
    return pAvail(p, inp.dist(agent.pos, p.pos), threats, inp.params.beta_comp, inp.tnow, inp.dc)
  }
}

function routeU(a: RebalanceAgent, set: ParcelBelief[], inp: RebalanceInput): number {
  const sorted = [...set].sort((x, y) => x.parcelId.localeCompare(y.parcelId))
  const r = routeFromClaims(a.carried, sorted, a.pos, inp.zones, inp.tnow, inp.dc, inp.params, inp.dist, weightFor(a, inp))
  return r === null ? 0 : uRoute(r, inp.tnow, inp.dc, inp.params, weightFor(a, inp))
}

export function runRebalance(inp: RebalanceInput): Reassign[] {
  const originD = new Map<string, number>(inp.claims.map((c) => [c.parcelId, c.originD]))
  const [a0, a1] = inp.agents
  let best: { parcelId: string; toAgent: AgentId; margin: number } | null = null

  // consider transferring each not-picked claim from its owner X to the other agent Y
  for (const [X, Y] of [[a0, a1], [a1, a0]] as const) {
    for (const p of [...X.claimed].sort((m, n) => m.parcelId.localeCompare(n.parcelId))) {
      if (p.carriedBy !== null) continue // never reassign picked-up goods
      const without = X.claimed.filter((q) => q.parcelId !== p.parcelId)
      const gainY = routeU(Y, [...Y.claimed, p], inp) - routeU(Y, Y.claimed, inp)
      const lossX = routeU(X, X.claimed, inp) - routeU(X, without, inp)
      const dUteam = gainY - lossX
      const sunk = Math.max(0, (originD.get(p.parcelId) ?? inp.dist(X.pos, p.pos)) - inp.dist(X.pos, p.pos))
      const reApproach = inp.dist(Y.pos, p.pos)
      const lYafter = inp.dist(Y.pos, p.pos) + inp.dist(p.pos, inp.zones[0] ?? Y.pos)
      const switchCost = (inp.dc.rho * (sunk + reApproach)) / (lYafter + 1)
      const margin = dUteam - switchCost
      if (margin > 0 && (best === null || margin > best.margin || (margin === best.margin && Y.id < best.toAgent))) {
        best = { parcelId: p.parcelId, toAgent: Y.id, margin }
      }
    }
  }
  return best === null ? [] : [{ parcelId: best.parcelId, toAgent: best.toAgent }]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/coordination-rebalance.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/coordination/rebalance.ts tests/coordination-rebalance.test.ts
git commit -m "feat(coordination): switchCost-gated global rebalance (§9.6)"
```

---

## Task 8: `loop.ts` — §9.4 partner-claimed exclusion + route from own claims

This task makes the loop *consume* claims: exclude partner-claimed parcels from candidacy and derive the execution route from own claims. The loop gains a `ClaimStore` field (constructed empty; populated by Task 9's wiring). `dist` and grid plumbing already exist.

**Files:**
- Modify: `src/bdi/loop.ts`
- Test: `tests/bdi-loop-claims.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/bdi-loop-claims.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { ClaimStore } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult, ParcelObs } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 7; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}
function fakeClient(map: Tile[]): { moves: string[]; pickups: number; client: DeliverooClient } {
  const rec = { moves: [] as string[], pickups: 0, client: null as unknown as DeliverooClient }
  rec.client = {
    role: 'courier', consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir: string) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => { rec.pickups++; return [] },
    putdown: async (ids?: string[]): Promise<PickResult[]> => (ids ?? []).map((id) => ({ id })),
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}
const pcl = (id: string, x: number): ParcelObs => ({ id, pos: { x, y: 0 }, reward: 10, carriedBy: null })
const snap = (over: Partial<PerceptionSnapshot>): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 }, parcels: [], agents: [], crates: [], ...over,
})

test('a parcel claimed by the partner is not pursued (P_avail=0, §9.4)', async () => {
  const rec = fakeClient(rowMap())
  const claims = new ClaimStore()
  claims.add({ parcelId: 'p1', agentId: 'liaison', origin: 'AUCTION', epoch: 0, commitTick: 0, originD: 0, lastD: 0, lastProgressTick: 0 })
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, { info: () => {}, debug: () => {}, warn: () => {} }, claims)
  // only parcel present is partner-claimed → agent must not walk toward it
  await loop.tick(snap({ self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 }, parcels: [pcl('p1', 5)] }))
  expect(rec.moves).toEqual([]) // idles / explores, does not chase a partner's parcel
  expect(rec.pickups).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/bdi-loop-claims.test.ts`
Expected: FAIL — `BdiLoop` constructor takes 3 args, not 4 (no `ClaimStore` param yet).

- [ ] **Step 3: Add the `ClaimStore` field and use it**

In `src/bdi/loop.ts`:

1. Import at top: `import { ClaimStore } from '../coordination/claims.js'` and `import { routeFromClaims } from './route.js'` (alongside the existing `buildRoute, uRoute` import — keep `uRoute`, drop `buildRoute` from the route candidate; `buildRoute` stays imported only if still referenced elsewhere, otherwise remove it from the import).

2. Add a constructor parameter (default keeps existing callers working until Task 9 wires the real store):

```ts
  constructor(
    private readonly client: DeliverooClient,
    private readonly params: Params,
    private readonly log: LogFn,
    private readonly claims: ClaimStore = new ClaimStore(),
  ) {
```

3. In `tick(...)`, replace the route-candidate construction. The current block is:

```ts
    const { pool, weight } = this.buildPool(beliefs, self, tnow, dist)
    const weightOf = (p: ParcelBelief): number => weight.get(p.id) ?? 1
    const route = buildRoute(carried, pool, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf)
    const cands: Candidate[] = []
    if (route !== null) cands.push({ intention: { kind: 'route', route }, u: uRoute(route, tnow, this.dc, this.params, weightOf) })
```

Replace with (route now comes from this agent's *own claims*; pool/weights still computed for §9.4 + the auction in Task 9):

```ts
    const { weight } = this.buildPool(beliefs, self, tnow, dist)
    const weightOf = (p: ParcelBelief): number => weight.get(p.id) ?? 1
    const ownClaimed = this.claims.ownClaims(this.client.role)
      .map((c) => beliefs.parcels.get(c.parcelId))
      .filter((p): p is ParcelBelief => p !== undefined && p.carriedBy === null)
    const route = routeFromClaims(carried, ownClaimed, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf)
    const cands: Candidate[] = []
    if (route !== null) cands.push({ intention: { kind: 'route', route }, u: uRoute(route, tnow, this.dc, this.params, weightOf) })
```

4. In `buildPool`, exclude partner-claimed parcels (§9.4). Change the loop body guard:

```ts
    const partnerClaimed = this.claims.partnerClaimed(this.client.role)
    for (const p of beliefs.parcels.values()) {
      if (p.carriedBy !== null) continue
      if (partnerClaimed.has(p.id)) continue // §9.4: partner-claimed ⇒ P_avail = 0 for me
      ...
```

(Keep `buildPool` returning `{ pool, weight }` — `pool` is consumed by Task 9's auction; `weight` by the route.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/bdi-loop-claims.test.ts && bun test ./tests/ && bunx tsc --noEmit`
Expected: the new test PASSES; the full suite stays green (the walkover/route loop tests construct `BdiLoop` with 3 args → the default empty `ClaimStore` means no parcel is partner-claimed, so prior behavior is unchanged); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/loop.ts tests/bdi-loop-claims.test.ts
git commit -m "feat(loop): derive route from own claims + §9.4 partner-claimed exclusion"
```

---

## Task 9: `loop.ts` — run the auction, rebalance, expiry, and claim broadcast

The loop now *produces* claims. It needs the partner's snapshot (pos/carried) from shared beliefs, a way to send `ClaimMsg`, and the partner id. Add a `coordinate` step before the route is built.

**Files:**
- Modify: `src/bdi/loop.ts`
- Test: `tests/bdi-loop-claims.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/bdi-loop-claims.test.ts`:

```ts
test('a free parcel is auctioned to self and broadcast as a claim', async () => {
  const rec = fakeClient(rowMap())
  const claims = new ClaimStore()
  const sent: unknown[] = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, { info: () => {}, debug: () => {}, warn: () => {} }, claims, {
    partner: 'liaison', send: (m) => sent.push(m),
  })
  await loop.tick(snap({ self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 }, parcels: [pcl('p1', 4)] }))
  // self is the only agent the auction sees as present → wins p1
  expect(claims.claimedBy('p1')).toBe('courier')
  expect(sent.some((m) => (m as { type: string }).type === 'claims')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/bdi-loop-claims.test.ts`
Expected: FAIL — the 5th constructor arg (coordination options) does not exist.

- [ ] **Step 3: Add coordination wiring to the loop**

In `src/bdi/loop.ts`:

1. Imports: `import { runAuction, type AgentSnap } from '../coordination/auction.js'`, `import { runRebalance, type RebalanceAgent } from '../coordination/rebalance.js'`, `import type { ClaimMsg, Claim } from '../coordination/claims.js'`, `import type { A2AMessage, AgentId } from '../types/a2a.js'`.

2. Add an optional coordination-options constructor param and store it:

```ts
  constructor(
    private readonly client: DeliverooClient,
    private readonly params: Params,
    private readonly log: LogFn,
    private readonly claims: ClaimStore = new ClaimStore(),
    private readonly coord?: { partner: AgentId; send: (msg: A2AMessage) => void },
  ) { /* existing body */ }
```

3. Add a field for the rebalance timer: `private lastRebalanceTick = -Infinity`.

4. In `tick(...)`, after `blackboard.onTick`/belief fold and before building candidates, insert the coordination step:

```ts
    // ── coordination (§9.3/§9.6/§9.7) ──
    const self = beliefs.self.pos
    // 1. liveness: expire own stuck claims (distOf reads live d from this agent)
    const dropped = this.claims.expire(tnow, (c) => {
      const p = beliefs.parcels.get(c.parcelId)
      return p ? dist(self, p.pos) : Infinity
    }, this.params.claim_ttl)
    for (const c of dropped) this.broadcast({ kind: 'release', parcelId: c.parcelId, epoch: tnow })

    if (this.coord) {
      const me = this.client.role
      const partner = beliefs.agents.get(this.coord.partner) ?? null
      // build both agent snapshots from shared beliefs
      const meSnap: AgentSnap = { id: me, pos: self, carried, claimed: this.claimedParcels(beliefs, me) }
      const partnerSnap: AgentSnap = partner
        ? { id: this.coord.partner, pos: partner.pos, carried: this.carriedOf(beliefs, this.coord.partner), claimed: this.claimedParcels(beliefs, this.coord.partner) }
        : { id: this.coord.partner, pos: self, carried: [], claimed: [] } // degraded: no partner bids
      const enemies = [...beliefs.agents.values()].filter((a) => a.rel === 'enemy')
      const { pool } = this.buildPool(beliefs, self, tnow, dist)
      // 2. auction the unclaimed pool (deterministic; commit only own wins)
      const agents: [AgentSnap, AgentSnap] = me < this.coord.partner ? [meSnap, partnerSnap] : [partnerSnap, meSnap]
      const alloc = runAuction({ pool, agents, enemies, zones: this.grid.deliveryZones, dist, dc: this.dc, params: this.params, tnow, epoch: tnow, budgetMs: this.params.auction_budget_ms })
      for (const [parcelId, winner] of alloc) {
        if (winner !== me) continue
        const p = beliefs.parcels.get(parcelId)!
        const claim: Claim = { parcelId, agentId: me, origin: 'AUCTION', epoch: tnow, commitTick: tnow, originD: dist(self, p.pos), lastD: dist(self, p.pos), lastProgressTick: tnow }
        this.claims.add(claim)
        this.broadcast({ kind: 'claim', claim })
      }
      // 3. periodic rebalance (or on own route finish)
      const routeFinished = this.claims.ownClaims(me).length === 0
      if (tnow - this.lastRebalanceTick >= this.params.rebalance_period || routeFinished) {
        this.lastRebalanceTick = tnow
        const ra: [RebalanceAgent, RebalanceAgent] = [
          { id: agents[0].id, pos: agents[0].pos, carried: agents[0].carried, claimed: agents[0].claimed },
          { id: agents[1].id, pos: agents[1].pos, carried: agents[1].carried, claimed: agents[1].claimed },
        ]
        const swaps = runRebalance({ agents: ra, claims: [...this.claims.ownClaims(me), ...this.claims.ownClaims(this.coord.partner)], enemies, zones: this.grid.deliveryZones, dist, dc: this.dc, params: this.params, tnow, epoch: tnow })
        for (const s of swaps) {
          this.claims.applyMsg({ kind: 'swap', parcelId: s.parcelId, toAgent: s.toAgent, epoch: tnow }, me)
          this.broadcast({ kind: 'swap', parcelId: s.parcelId, toAgent: s.toAgent, epoch: tnow })
        }
      }
    }
```

5. Add the helper methods to the class:

```ts
  private broadcast(msg: ClaimMsg): void {
    if (!this.coord) return
    this.coord.send({ from: this.client.role, to: this.coord.partner, type: 'claims', payload: msg })
  }

  /** Parcels claimed by `who` that are present and not yet picked, as ParcelBeliefs. */
  private claimedParcels(beliefs: BeliefBase, who: AgentId): ParcelBelief[] {
    return this.claims.ownClaims(who)
      .map((c) => beliefs.parcels.get(c.parcelId))
      .filter((p): p is ParcelBelief => p !== undefined && p.carriedBy === null)
  }

  private carriedOf(beliefs: BeliefBase, who: AgentId): ParcelBelief[] {
    const ag = beliefs.agents.get(who)
    const ids = ag?.carrying ?? []
    return ids.map((id) => beliefs.parcels.get(id)).filter((p): p is ParcelBelief => p !== undefined)
  }
```

6. On own `pickup`/`putdown` of a claimed parcel, remove its claim and broadcast a `release` (so it leaves the pool/union cleanly). In the `act(...)` pickup branch, after a successful pickup of the route head, add:

```ts
      this.claims.remove(headId)               // headId = the picked parcel id
      this.broadcast({ kind: 'release', parcelId: headId, epoch: tnow })
```

(Locate the existing pickup emission in `act`; `headId` is the route's head pickup id already computed there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/bdi-loop-claims.test.ts && bun test ./tests/ && bunx tsc --noEmit`
Expected: new test PASSES; full suite green; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/loop.ts tests/bdi-loop-claims.test.ts
git commit -m "feat(loop): run SSI auction + rebalance + claim expiry, broadcast claims (§9.3/§9.6)"
```

---

## Task 10: `intentions.ts` — dispersion nudge on exploration

**Files:**
- Modify: `src/bdi/intentions.ts`
- Test: `tests/bdi-intentions.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/bdi-intentions.test.ts` (match the file's existing import/fixture style; this shows the shape):

```ts
import { chooseExplore } from '../src/bdi/intentions.js'
// ... reuse the file's existing CONSTS / params / manhattan helpers ...

test('dispersion nudges explore away from the partner target (tie-break only)', () => {
  // two equally-stale, equal-value spawner tiles; partner heads to the near one →
  // the agent should prefer the far one once θ_disp is applied.
  // (Construct two ExploreTarget candidates equidistant from self, one near partnerTarget.)
  // Assert the chosen explore target is the one FARTHER from partnerTarget.
})
```

Fill the test body using the file's existing `chooseExplore` fixture pattern: build a `seenAt`/spawner setup with two reachable tiles symmetric from `self`, pass a `partnerTarget` near one, and assert the returned target is the far one. (If `chooseExplore` has no `partnerTarget` parameter yet, the test will not compile — that is the RED.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./tests/bdi-intentions.test.ts`
Expected: FAIL — `chooseExplore` does not accept a `partnerTarget`/`dispersion` argument.

- [ ] **Step 3: Thread dispersion into `chooseExplore`**

In `src/bdi/intentions.ts`:
1. Import: `import { awayFromPartner } from '../coordination/dispersion.js'`.
2. Add two parameters to `chooseExplore` (append, so existing callers can pass `null`/default): `partnerTarget: Pos | null = null`, `dRef = 1`.
3. Where each candidate region/tile `r` is scored, add the dispersion term to its score:

```ts
   const score = baseScore + params.theta_disp * awayFromPartner(r, partnerTarget, dRef)
```

(`baseScore` is the existing `θ_explore · [spawnValue + κ·staleness] / (d+1)` value. Keep the argmax over `score`.)

4. In `loop.ts`, pass `partnerTarget` (head of the partner's derived route, or `null` when the partner is lost) and `dRef = this.grid.diameter` to `chooseExplore`. Compute `partnerTarget` as the first pickup tile of `this.claimedParcels(beliefs, partnerId)` ordered by `routeFromClaims`, else the partner's `z_route`, else `null`. Add a `diameter` to `Grid` at build time (`max manhattan over walkable tiles`) if not present; otherwise compute once in the loop constructor.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./tests/bdi-intentions.test.ts && bun test ./tests/ && bunx tsc --noEmit`
Expected: PASS; full suite green; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/intentions.ts src/bdi/loop.ts tests/bdi-intentions.test.ts
git commit -m "feat(intentions): θ_disp dispersion nudge on exploration (§9.5)"
```

---

## Task 11: Agent wiring — construct `ClaimStore`, route the `claims` channel

**Files:**
- Modify: `src/agents/courier.ts`
- Modify: `src/agents/liaison.ts`
- Test: `tests/coordination-claims.test.ts` (integration of the inbound route — optional unit; the main proof is the §9 loop tests above)

- [ ] **Step 1: Wire courier**

In `src/agents/courier.ts`, where the `BdiLoop` is constructed on first perception:
1. Construct a `const claims = new ClaimStore()` alongside the `Blackboard`.
2. Pass it plus coordination options to the loop:

```ts
   loop = new BdiLoop(client, params, logger, claims, {
     partner: 'liaison',
     send: (msg) => postA2A(msg), // the same a2a sender already used for blackboard deltas
   })
```
3. In the inbound a2a handler (currently `blackboard.receive(msg)`), also route claims:

```ts
   if (msg.type === 'claims' && isClaimMsg(msg.payload)) claims.applyMsg(msg.payload, 'courier')
   else blackboard.receive(msg)
```

Import `ClaimStore, isClaimMsg` from `../coordination/claims.js`.

- [ ] **Step 2: Wire liaison**

Repeat Step 1 in `src/agents/liaison.ts`, with `partner: 'courier'` and `claims.applyMsg(msg.payload, 'liaison')`.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `bun test ./tests/ && bunx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add src/agents/courier.ts src/agents/liaison.ts
git commit -m "feat(agents): wire ClaimStore + claims a2a channel into both workers"
```

---

## Task 12: Two-agent integration test — divide the field, no double-chase

**Files:**
- Test: `tests/coordination-integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/coordination-integration.test.ts`. Drive two `BdiLoop` instances over a shared row map with a relay that forwards each loop's `send` into the other's inbound handler (claims) and a shared belief setup. Two parcels, one near each agent. Assert after a few ticks each parcel is claimed by exactly one agent and the two agents do **not** both move toward the same parcel.

```ts
// Shape: build courierLoop + liaisonLoop, wire send(courier)→applyMsg(liaison store) and
// vice-versa, plus identical belief snapshots fed to both. Tick both a few times.
// Assert: claimsCourier.claimedBy('pNearCourier') === 'courier'
//         claimsCourier.claimedBy('pNearLiaison') === 'liaison'
//         no tick has both recorders moving toward the same parcel's x.
```

Fill the body using the `fakeClient` helper from `tests/bdi-loop-claims.test.ts` (extract it to a shared `tests/helpers/fake-client.ts` if convenient) and two `ClaimStore`s cross-wired. Feed both loops the same `PerceptionSnapshot` each tick (shared beliefs).

- [ ] **Step 2: Run + verify**

Run: `bun test ./tests/coordination-integration.test.ts && bun test ./tests/ && bunx tsc --noEmit`
Expected: PASS; full suite green; tsc clean.

- [ ] **Step 3: Commit**

```bash
git add tests/coordination-integration.test.ts tests/helpers/fake-client.ts
git commit -m "test(coordination): two agents divide a parcel field with no double-chase"
```

---

## Self-review notes (resolved while writing)

- **Spec coverage:** §9.2 bid metric → reused (`uRoute`/`routeFromClaims`, Tasks 2/6); §9.3 auction → Task 6 + loop Task 9; §9.4 partner P_avail=0 → Task 8; §9.5 dispersion → Tasks 5/10; §9.6 rebalance → Task 7 + loop Task 9; §9.7 claims-stored/CLAIM_TTL → Tasks 3/4 + loop Task 9; §11 degradation → Task 9 (partner-absent snapshot) + Task 10 (null partnerTarget). §12 tunables → Task 1.
- **`buildRoute` retained:** still exported and unit-tested; the loop now uses `routeFromClaims` for execution. `buildRoute`'s greedy *selection* role is subsumed by the auction's accept-only-if-`Δ>0` rule (team-level emergent horizon). Left in place (tested, harmless); not removed to keep scope tight.
- **switchCost is a concrete instantiation** of §9.6's semi-formal "points/tick physics hysteresis"; tests use clear-cut accept/reject cases robust to the exact formula. Exact magnitude is an offline-calibration concern (§16), out of scope.
- **Determinism guard:** every pure module sorts ids before any decision; the auction takes `agents` in `id`-sorted order from the loop. This is the load-bearing invariant for replica convergence — note it in review of Tasks 6/7/9.
