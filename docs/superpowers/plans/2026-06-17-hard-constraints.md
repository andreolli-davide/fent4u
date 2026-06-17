# §7 Hard Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement DESIGN.md §7 hard constraints — priced A\* tolls (§7.1) and absolute value filters (§7.2, §7.3) — by folding both into existing machinery, replicated to both agents.

**Architecture:** Bottom-up. First make the leaf pure functions accept the new concepts via *optional/identity-defaulted* params (A\* `tollSum`, `vValue` `filter`) so the tree keeps compiling. Then flip the `Dist` type to pair-returning `{L, toll}` in one cohesive refactor, add the `HARD_CONSTRAINT` param builders + `TeamMissionView` accessors, and wire `c_tick`/tolls/filter into the BDI loop for both agents. Identity (empty toll map, `F1` filter) recovers base play byte-for-byte.

**Tech Stack:** Bun + TypeScript (strict, ESM `.js` imports), `bun test`. Spec: `docs/superpowers/specs/2026-06-17-hard-constraints-design.md`.

---

## File Structure

- `src/planning/astar.ts` — `PathResult.tollSum`, `PlanCtx.tolls`/`cTick`, toll-aware cost (Task 1).
- `src/bdi/utility.ts` — `BundleFilter`, `F1`, `vValue` filter param, `bestZone` filter + toll (Tasks 2, 3, 6).
- `src/mission/shapers.ts` — `bestSubset` filter param, `buildTolls`, `buildBundleFilter` (Tasks 3, 4).
- `src/mission/kinds.ts` — `MissionParams.priced`/`absolute`, `emit_mission` schema (Tasks 4, 8).
- `src/mission/view.ts` — `tolls()`, `bundleFilter()` accessors (Task 5).
- `src/bdi/route.ts` — pair-returning `Dist`, toll-subtracting numerator (Task 6).
- `src/coordination/auction.ts`, `src/coordination/rebalance.ts` — read `.L` from pair `Dist` (Task 6).
- `src/bdi/loop.ts` — `c_tick`, `ctx.tolls` from view, pair `distMemo`, filter into route/doDeliver (Task 7).
- Tests: `tests/astar-toll.test.ts`, `tests/bdi-utility-kernel.test.ts` (extend), `tests/mission-shapers.test.ts` (extend), `tests/mission-view.test.ts` (extend), `tests/bdi-route.test.ts` (extend), `tests/bdi-loop-mission.test.ts` (extend), `tests/mission-replication.test.ts` (extend).

---

## Task 1: A\* toll-aware search

**Files:**
- Modify: `src/planning/astar.ts`
- Test: `tests/astar-toll.test.ts` (create)

Goal: `planPath` returns `tollSum`; when `ctx.tolls` is empty/undefined the search is byte-identical to today (existing `astar-plain.test.ts` must stay green). When non-empty, it minimises `cTick·steps + Σtoll`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/astar-toll.test.ts
import { test, expect } from 'bun:test'
import { buildGrid, planPath, key, type PlanCtx } from '../src/planning/astar.js'
import type { Tile } from '../src/types/perception.js'

function row(n: number): Tile[] {
  const tiles: Tile[] = []
  for (let x = 0; x < n; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}
const base = (extra: Partial<PlanCtx> = {}): PlanCtx => ({
  obstacles: { crateAt: new Map(), agentAt: new Set() }, protectedTiles: [], budgetMs: 8, ...extra,
})

test('no tolls: tollSum is 0 and path is the pure-tick shortest', () => {
  const grid = buildGrid(row(5))
  const r = planPath(grid, base(), { x: 0, y: 0 }, { x: 4, y: 0 })
  expect(r.L).toBe(4)
  expect(r.tollSum).toBe(0)
})

test('toll mode accumulates tollSum along the chosen straight path', () => {
  const grid = buildGrid(row(5))
  // (2,0) costs 7 points to enter; cTick high so dodging is not worth extra steps.
  const ctx = base({ tolls: new Map([[key({ x: 2, y: 0 }), 7]]), cTick: 100 })
  const r = planPath(grid, ctx, { x: 0, y: 0 }, { x: 4, y: 0 })
  expect(r.L).toBe(4)      // L stays a pure tick count (§7.1 rule b)
  expect(r.tollSum).toBe(7)
})

test('toll mode dodges a priced tile when the detour is cheaper in cost units', () => {
  // 2-row grid; the only tolled tile is on the straight bottom row. cTick low ⇒ a detour
  // through the top row (more steps, no toll) wins on cTick·steps + Σtoll.
  const grid = buildGrid([
    { pos: { x: 0, y: 0 }, type: 'walkable' }, { pos: { x: 1, y: 0 }, type: 'walkable' }, { pos: { x: 2, y: 0 }, type: 'walkable' },
    { pos: { x: 0, y: 1 }, type: 'walkable' }, { pos: { x: 1, y: 1 }, type: 'walkable' }, { pos: { x: 2, y: 1 }, type: 'walkable' },
  ])
  const ctx = base({ tolls: new Map([[key({ x: 1, y: 0 }), 50]]), cTick: 1 })
  const r = planPath(grid, ctx, { x: 0, y: 0 }, { x: 2, y: 0 })
  expect(r.tollSum).toBe(0)  // dodged the toll
  expect(r.L).toBe(4)        // 0,0 -> 0,1 -> 1,1 -> 2,1 -> 2,0  (4 ticks vs 2 straight)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/astar-toll.test.ts`
Expected: FAIL — `tollSum` undefined / `tolls` not in `PlanCtx`.

- [ ] **Step 3: Implement toll-aware search**

In `src/planning/astar.ts`:

Add to `PathResult` (after `timedOut`):
```ts
  tollSum: number // Σ toll(tile) over the chosen path's entered tiles; 0 in pure-tick mode
```

Add to `PlanCtx`:
```ts
  tolls?: Map<string, number> // tileKey -> toll points; absent/empty ⇒ pure-tick mode
  cTick?: number // §7.1 exchange rate (points per travel tick); required iff tolls non-empty
```

Extend `Node` with a separate ordering cost and toll accumulator (pure-tick mode leaves them unused):
```ts
interface Node {
  pos: Pos
  g: number // tick count (steps) — what L is reported from
  cost: number // ordering cost: cTick*g + tollAccum (== g in pure-tick mode)
  tollAccum: number
  f: number
  firstStep: Step | null
  seq: number
}
```

Replace the heap comparator `before` to order by `f` over `cost`, keep deterministic tie-breaks:
```ts
function before(a: Node, b: Node): boolean {
  if (a.f !== b.f) return a.f < b.f
  if (a.g !== b.g) return a.g > b.g // prefer deeper (fewer expansions)
  return a.seq < b.seq
}
```

In `planPath`, compute mode locals at the top (after the same-tile early return):
```ts
  const tolls = ctx.tolls
  const tollMode = tolls !== undefined && tolls.size > 0
  const cTick = tollMode ? (ctx.cTick ?? 1) : 1
  const tollOf = (k: string): number => (tollMode ? (tolls!.get(k) ?? 0) : 0)
```

Seed and per-tile costs use `cost`/`tollAccum`; `f = cost + cTick * manhattan(...)`. Replace the `bestG` relaxation key from raw `g` to `cost` (a tile is worth re-expanding when reached at lower *cost*, not lower step count, since a tolled detour can have more steps but lower cost):
- Rename `bestG` → `bestCost` (Map<string, number>), seed `bestCost.set(key(from), 0)`.
- Seed node: `{ pos: from, g: 0, cost: 0, tollAccum: 0, f: cTick * manhattan(from, to), firstStep: null, seq: seq++ }`.
- On expand, for each neighbour `np` with key `nk` that passed the floor/enter/agent/crate checks:
```ts
      const stepToll = tollOf(nk)
      const cost = cur.cost + cTick + stepToll
      const prev = bestCost.get(nk)
      if (prev !== undefined && prev <= cost) continue
      bestCost.set(nk, cost)
      open.push({ pos: np, g: cur.g + 1, cost, tollAccum: cur.tollAccum + stepToll, f: cost + cTick * manhattan(np, to), firstStep, seq: seq++ })
```
- The `closed`-set stale-pop guard stays keyed on position.
- At the goal return: `return { reachable: true, L: cur.g, firstStep: cur.firstStep, pushes, timedOut: false, tollSum: cur.tollAccum }`.
- The three early/failure returns (`L: 0` same-tile, timeout, exhausted) all gain `tollSum: 0`.

Note: `closed.add` plus `bestCost <= cost` skip preserves the existing lazy decrease-key. In pure-tick mode `cTick=1`, `stepToll=0`, so `cost === g` and behaviour is identical to today.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/astar-toll.test.ts tests/astar-plain.test.ts tests/astar-push.test.ts`
Expected: PASS (new toll tests + unchanged plain/push regression).

- [ ] **Step 5: Commit**

```bash
git add src/planning/astar.ts tests/astar-toll.test.ts
git commit -m "feat(astar): toll-aware search returns tollSum; pure-tick unchanged (§7.1)"
```

---

## Task 2: `vValue` bundle filter

**Files:**
- Modify: `src/bdi/utility.ts`
- Test: `tests/bdi-utility-kernel.test.ts` (extend)

Goal: a `BundleFilter (S, z) => boolean` (true = valid) applied at the single value chokepoint. Default `F1` passes everything (base play unchanged).

- [ ] **Step 1: Write the failing test**

Append to `tests/bdi-utility-kernel.test.ts`:
```ts
import { vValue, F1, type BundleFilter } from '../src/bdi/utility.js'
// (reuse the file's existing ParcelBelief/DecayConsts fixtures; mk(reward) below mirrors them)

test('F1 filter leaves value unchanged (base play)', () => {
  const dc = { rho: 0, lambda: 0, lambdaAgent: 0, decayIntervalTicks: Infinity }
  const p = { id: 'p', pos: { x: 0, y: 0 }, rewardSeen: 20, carriedBy: null, lastSeen: 0 }
  expect(vValue([p], { x: 1, y: 1 }, 0, 0, dc)).toBe(20)
  expect(vValue([p], { x: 1, y: 1 }, 0, 0, dc, undefined, undefined, undefined, F1)).toBe(20)
})

test('a filter that rejects the bundle zeroes value', () => {
  const dc = { rho: 0, lambda: 0, lambdaAgent: 0, decayIntervalTicks: Infinity }
  const p = { id: 'p', pos: { x: 0, y: 0 }, rewardSeen: 20, carriedBy: null, lastSeen: 0 }
  const reject: BundleFilter = () => false
  expect(vValue([p], { x: 1, y: 1 }, 0, 0, dc, undefined, undefined, undefined, reject)).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-utility-kernel.test.ts`
Expected: FAIL — `F1`/`BundleFilter` not exported; `vValue` has no 9th param.

- [ ] **Step 3: Implement the filter**

In `src/bdi/utility.ts`, after the `ParcelWeight`/`W1` block:
```ts
/** §7.2 absolute constraint predicate over (bundle, delivery zone). true = valid. */
export type BundleFilter = (S: ParcelBelief[], z: Pos) => boolean
export const F1: BundleFilter = () => true
```

Add `filter` as the trailing param of `vValue` and short-circuit to 0 on violation:
```ts
export function vValue(parcels: ParcelBelief[], z: Pos, L: number, tnow: number, dc: DecayConsts, m: CountShaper = M1, g: ZoneShaper = G1, weight: ParcelWeight = W1, filter: BundleFilter = F1): number {
  if (!filter(parcels, z)) return 0
  let sum = 0
  for (const p of parcels) sum += weight(p) * Math.max(0, rnow(p, tnow, dc) - dc.rho * L)
  return g(z) * m(parcels.length) * sum
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bdi-utility-kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/utility.ts tests/bdi-utility-kernel.test.ts
git commit -m "feat(utility): BundleFilter at the vValue chokepoint; F1 identity (§7.2)"
```

---

## Task 3: `bestZone` and `bestSubset` honour the filter

**Files:**
- Modify: `src/bdi/utility.ts` (`bestZone`), `src/mission/shapers.ts` (`bestSubset`)
- Test: `tests/mission-shapers.test.ts` (extend)

Goal: thread `filter` into the two subset/zone selectors so a forbidden zone drops out and `bestSubset` never assembles a forfeiting bundle.

- [ ] **Step 1: Write the failing test**

Append to `tests/mission-shapers.test.ts`:
```ts
import { bestSubset } from '../src/mission/shapers.js'
import { M1, G1, type BundleFilter } from '../src/bdi/utility.js'

const dcInf = { rho: 0, lambda: 0, lambdaAgent: 0, decayIntervalTicks: Infinity }
const mkc = (id: string, reward: number) => ({ id, pos: { x: 0, y: 0 }, rewardSeen: reward, carriedBy: 'me', lastSeen: 0 })

test('bestSubset excludes a parcel that trips a REWARD_THRESHOLD filter', () => {
  const carried = [mkc('a', 5), mkc('b', 50)] // b > 10
  const overTen: BundleFilter = (S) => S.every((p) => p.rewardSeen <= 10)
  const r = bestSubset(carried, { x: 1, y: 1 }, 0, dcInf, M1, G1, 0, overTen)
  expect(r.set.map((p) => p.id)).toEqual(['a']) // best non-forfeiting subset
  expect(r.value).toBe(5)
})

test('bestSubset with F1 default is unchanged', () => {
  const carried = [mkc('a', 5), mkc('b', 50)]
  const r = bestSubset(carried, { x: 1, y: 1 }, 0, dcInf, M1, G1, 0)
  expect(r.value).toBe(55)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-shapers.test.ts`
Expected: FAIL — `bestSubset` has no 8th `filter` param.

- [ ] **Step 3: Thread `filter` through both selectors**

In `src/mission/shapers.ts`, import `F1, type BundleFilter` from utility and add the param to `bestSubset`, passing it into the inner `vValue`:
```ts
export function bestSubset(
  carried: ParcelBelief[], tile: Pos, tnow: number, dc: DecayConsts,
  m: CountShaper, g: ZoneShaper, floorTicks: number, filter: BundleFilter = F1,
): { set: ParcelBelief[]; value: number } {
  // ...unchanged positive/forced/optional setup...
  for (let j = 0; j <= optional.length; j++) {
    const set = [...forced, ...optional.slice(0, j)]
    if (set.length === 0) continue
    const value = vValue(set, tile, 0, tnow, dc, m, g, undefined, filter)
    if (best === null || value > best.value) best = { set, value }
  }
  return best!
}
```
Note the worst-case intersection (§7.3 / §6.2): if a `forced` (expiring) parcel itself trips the filter, every candidate scores 0 and `best!` is the first non-empty set at value 0 — a 0-value delivery, as designed.

In `src/bdi/utility.ts`, add `filter: BundleFilter = F1` to `bestZone` and pass it to its inner `vValue`:
```ts
export function bestZone(parcels: ParcelBelief[], from: Pos, zones: Pos[], tnow: number, dc: DecayConsts, dist: (a: Pos, b: Pos) => number, alpha: number, m: CountShaper = M1, g: ZoneShaper = G1, filter: BundleFilter = F1): ZonePick | null {
  let best: ZonePick | null = null
  for (const z of zones) {
    const L = dist(from, z)
    if (!Number.isFinite(L)) continue
    const r = rate(vValue(parcels, z, L, tnow, dc, m, g, undefined, filter), L, alpha)
    if (best === null || r > best.rate) best = { zone: z, L, rate: r }
  }
  return best
}
```
(`dist` stays number-typed here — it becomes a pair in Task 6.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/mission-shapers.test.ts tests/bdi-utility-kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mission/shapers.ts src/bdi/utility.ts tests/mission-shapers.test.ts
git commit -m "feat(utility,shapers): bestZone/bestSubset honour BundleFilter (§7.2/§7.3)"
```

---

## Task 4: `HARD_CONSTRAINT` params + builders

**Files:**
- Modify: `src/mission/kinds.ts` (`MissionParams`), `src/mission/shapers.ts` (`buildTolls`, `buildBundleFilter`)
- Test: `tests/mission-shapers.test.ts` (extend)

Goal: structured constraint params + pure closure builders (TEXT_BOUND only, identity when absent), mirroring `buildCountShaper`/`buildZoneShaper`.

- [ ] **Step 1: Write the failing test**

Append to `tests/mission-shapers.test.ts`:
```ts
import { buildTolls, buildBundleFilter } from '../src/mission/shapers.js'
import { key } from '../src/planning/astar.js'

test('buildTolls maps TEXT_BOUND priced tiles to tollKeyed points; empty when absent', () => {
  expect(buildTolls(undefined).size).toBe(0)
  const m = buildTolls([{ tile: { tag: 'TEXT_BOUND', x: 5, y: 2 }, toll: 50 }])
  expect(m.get(key({ x: 5, y: 2 }))).toBe(50)
})

test('buildTolls skips RUNTIME_BOUND tiles and non-finite tolls', () => {
  const m = buildTolls([
    { tile: { tag: 'RUNTIME_BOUND', rule: 'spawner' }, toll: 50 },
    { tile: { tag: 'TEXT_BOUND', x: 1, y: 1 }, toll: Number.NaN },
  ])
  expect(m.size).toBe(0)
})

test('buildBundleFilter REWARD_THRESHOLD rejects a bundle with any parcel over max', () => {
  const f = buildBundleFilter({ kind: 'REWARD_THRESHOLD', max: 10 })
  const lo = { id: 'a', pos: { x: 0, y: 0 }, rewardSeen: 8, carriedBy: null, lastSeen: 0 }
  const hi = { id: 'b', pos: { x: 0, y: 0 }, rewardSeen: 20, carriedBy: null, lastSeen: 0 }
  expect(f([lo], { x: 1, y: 1 })).toBe(true)
  expect(f([lo, hi], { x: 1, y: 1 })).toBe(false)
})

test('buildBundleFilter ZONE rejects only the forbidden delivery tile', () => {
  const f = buildBundleFilter({ kind: 'ZONE', tile: { tag: 'TEXT_BOUND', x: 3, y: 4 } })
  expect(f([], { x: 3, y: 4 })).toBe(false)
  expect(f([], { x: 0, y: 0 })).toBe(true)
})

test('buildBundleFilter identity (F1) when absent', () => {
  expect(buildBundleFilter(undefined)([], { x: 0, y: 0 })).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-shapers.test.ts`
Expected: FAIL — builders + `priced`/`absolute` types undefined.

- [ ] **Step 3: Add types and builders**

In `src/mission/kinds.ts`, add to `MissionParams` (keep the legacy `tile?`/`filter?`/`rule?` fields for back-compat; they are no longer the constraint carriers):
```ts
  priced?: Array<{ tile: TileSlot; toll: number }> // §7.1 PRICED
  absolute?:
    | { kind: 'REWARD_THRESHOLD'; max: number } // §7.2 — any parcel reward > max voids the bundle
    | { kind: 'ZONE'; tile: TileSlot }          // §7.2 — delivering at this tile voids the bundle
```

In `src/mission/shapers.ts`, add (import `key` from `../planning/astar.js`, `F1, type BundleFilter` already imported in Task 3):
```ts
/** §7.1 priced tiles -> tileKey->toll points. TEXT_BOUND + finite only; empty when absent. */
export function buildTolls(priced: MissionParams['priced']): Map<string, number> {
  const out = new Map<string, number>()
  if (priced === undefined) return out
  for (const e of priced) {
    if (e.tile.tag !== 'TEXT_BOUND') continue
    if (!Number.isFinite(e.toll)) continue
    out.set(key({ x: e.tile.x, y: e.tile.y }), e.toll)
  }
  return out
}

/** §7.2 absolute constraint -> BundleFilter. Identity (F1) when absent. */
export function buildBundleFilter(absolute: MissionParams['absolute']): BundleFilter {
  if (absolute === undefined) return F1
  if (absolute.kind === 'REWARD_THRESHOLD') {
    const max = absolute.max
    return (S) => S.every((p) => p.rewardSeen <= max) // §7.3 worst-case: any over-max voids all
  }
  if (absolute.tile.tag !== 'TEXT_BOUND') return F1 // RUNTIME_BOUND deferred this slice
  const forbidden = key({ x: absolute.tile.x, y: absolute.tile.y })
  return (_S, z) => key(z) !== forbidden
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/mission-shapers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mission/kinds.ts src/mission/shapers.ts tests/mission-shapers.test.ts
git commit -m "feat(mission): structured HARD_CONSTRAINT params + buildTolls/buildBundleFilter (§7)"
```

---

## Task 5: `TeamMissionView` constraint accessors

**Files:**
- Modify: `src/mission/view.ts`
- Test: `tests/mission-view.test.ts` (extend)

Goal: the Phase-3 accessors the file already promises — `tolls()` and `bundleFilter()` — so both agents read constraints from the one shared view.

- [ ] **Step 1: Write the failing test**

Append to `tests/mission-view.test.ts`:
```ts
import { key } from '../src/planning/astar.js'

const constraintMission = () => assembleMission(
  { kind: 'HARD_CONSTRAINT', payoff: -50, abstractIntent: 'avoid (5,2); no big parcels', sub: 'PRICED',
    params: { priced: [{ tile: { tag: 'TEXT_BOUND', x: 5, y: 2 }, toll: 50 }], absolute: { kind: 'REWARD_THRESHOLD', max: 10 } } },
  'raw', 'm-hc',
)

test('identity constraints when empty or non-HARD_CONSTRAINT', () => {
  const v = new TeamMissionView()
  expect(v.tolls().size).toBe(0)
  expect(v.bundleFilter()([], { x: 0, y: 0 })).toBe(true)
  v.set(mk('m-1')) // CANDIDATE_INTENTION
  expect(v.tolls().size).toBe(0)
  expect(v.bundleFilter()([], { x: 0, y: 0 })).toBe(true)
})

test('HARD_CONSTRAINT mission yields tolls + bundle filter', () => {
  const v = new TeamMissionView()
  v.set(constraintMission())
  expect(v.tolls().get(key({ x: 5, y: 2 }))).toBe(50)
  const big = { id: 'b', pos: { x: 0, y: 0 }, rewardSeen: 20, carriedBy: null, lastSeen: 0 }
  expect(v.bundleFilter()([big], { x: 0, y: 0 })).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-view.test.ts`
Expected: FAIL — `tolls`/`bundleFilter` not methods of `TeamMissionView`.

- [ ] **Step 3: Add the accessors**

In `src/mission/view.ts`, import the builders + types and add two methods (mirroring `countShaper`/`zoneShaper`):
```ts
import { buildCountShaper, buildZoneShaper, buildTolls, buildBundleFilter } from './shapers.js'
import { M1, G1, F1, type CountShaper, type ZoneShaper, type BundleFilter } from '../bdi/utility.js'

  // ...existing countShaper/zoneShaper...

  tolls(): Map<string, number> {
    return this.mission?.kind === 'HARD_CONSTRAINT' ? buildTolls(this.mission.params.priced) : new Map()
  }

  bundleFilter(): BundleFilter {
    return this.mission?.kind === 'HARD_CONSTRAINT' ? buildBundleFilter(this.mission.params.absolute) : F1
  }
```
Update the file's header comment line "Toll/filter accessors arrive in Phase 3." → "Toll/filter accessors (Phase 3): tolls()/bundleFilter()."

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/mission-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mission/view.ts tests/mission-view.test.ts
git commit -m "feat(mission): TeamMissionView tolls()/bundleFilter() accessors (§7)"
```

---

## Task 6: `Dist` becomes `{L, toll}`; route value subtracts tolls

**Files:**
- Modify: `src/bdi/route.ts`, `src/bdi/utility.ts` (`bestZone`), `src/coordination/auction.ts`, `src/coordination/rebalance.ts`
- Test: `tests/bdi-route.test.ts` (extend)

Goal: flip the `Dist` type to pair-returning so `L` and `tollSum` come from one search, and subtract the route's toll from the value numerator (§7.1: `U = (V − Σtoll)/(L+1)^α`). Most call sites only read `.L`; only route/zone value reads `.toll`.

- [ ] **Step 1: Write the failing test**

Append to `tests/bdi-route.test.ts`. It reuses the file's existing top-of-file fixtures (`dc`, `manhattan`, `parcel`, `DEFAULT_PARAMS`). The assertion is relative (toll lowers `uRoute`) so it is robust to the non-zero decay in `DEFAULT_PARAMS`/`dc`:
```ts
test('Dist tolls flow into Route.toll and reduce uRoute (§7.1)', () => {
  const held = parcel('held', 0, 0, 30) // already at the delivery zone (0,0)
  const noToll = (a: Pos, b: Pos): { L: number; toll: number } => ({ L: manhattan(a, b), toll: 0 })
  // entering the delivery tile (0,0) costs 40 points; every other leg is toll-free.
  const withToll = (a: Pos, b: Pos): { L: number; toll: number } => ({ L: manhattan(a, b), toll: b.x === 0 && b.y === 0 ? 40 : 0 })
  const r0 = buildRoute([held], [], { x: 3, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, noToll)!
  const r1 = buildRoute([held], [], { x: 3, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, withToll)!
  expect(r0.toll).toBe(0)
  expect(r1.toll).toBe(40)
  expect(uRoute(r1, 0, dc, DEFAULT_PARAMS)).toBeLessThan(uRoute(r0, 0, dc, DEFAULT_PARAMS))
})
```
(`buildRoute`'s `dist` is the 8th positional arg; `uRoute`/`buildRoute` already imported at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-route.test.ts`
Expected: FAIL — `Dist` is `(a,b)=>number`; `buildRoute` rejects the pair-returning `dist`, and value does not subtract toll.

- [ ] **Step 3: Flip the type and subtract tolls**

In `src/bdi/route.ts`:
- Change the type and add a toll field to `Route`:
```ts
type Dist = (a: Pos, b: Pos) => { L: number; toll: number }

export interface Route {
  pickups: ParcelBelief[]
  zone: Pos
  delivered: ParcelBelief[]
  L: number
  toll: number // Σ toll over self -> pickups -> zone (§7.1); 0 when no priced constraint
}
```
- `routeLength` returns both accumulators:
```ts
function routeLeg(self: Pos, pickups: ParcelBelief[], zone: Pos, dist: Dist): { L: number; toll: number } {
  let L = 0, toll = 0, at = self
  for (const p of pickups) { const d = dist(at, p.pos); L += d.L; toll += d.toll; at = p.pos }
  const d = dist(at, zone); L += d.L; toll += d.toll
  return { L, toll }
}
```
- `score` must thread `bestZone`'s toll too. Change `bestZone` (in `utility.ts`) to a pair-`dist` signature and to return the zone leg's toll:
```ts
export interface ZonePick { zone: Pos; L: number; toll: number; rate: number }
export function bestZone(parcels: ParcelBelief[], from: Pos, zones: Pos[], tnow: number, dc: DecayConsts, dist: (a: Pos, b: Pos) => { L: number; toll: number }, alpha: number, m: CountShaper = M1, g: ZoneShaper = G1, filter: BundleFilter = F1): ZonePick | null {
  let best: ZonePick | null = null
  for (const z of zones) {
    const { L, toll } = dist(from, z)
    if (!Number.isFinite(L)) continue
    const r = rate(vValue(parcels, z, L, tnow, dc, m, g, undefined, filter) - toll, L, alpha)
    if (best === null || r > best.rate) best = { zone: z, L, toll, rate: r }
  }
  return best
}
```
- In `score`, compute the prefix leg with `routeLeg(self, pickups, tail, dist)` and add `zp.toll`:
```ts
function score(self, carried, pickups, zones, tnow, dc, params, dist, weight, m, g, filter = F1): { route: Route; u: number } | null {
  const delivered = [...carried, ...pickups]
  const tail = pickups.length > 0 ? pickups[pickups.length - 1]!.pos : self
  const pre = routeLeg(self, pickups, tail, dist)
  if (!Number.isFinite(pre.L)) return null
  const zp = bestZone(delivered, tail, zones, tnow, dc, dist, params.alpha, m, g, filter)
  if (zp === null) return null
  const L = pre.L + zp.L
  const toll = pre.toll + zp.toll
  const u = rate(vValue(delivered, zp.zone, L, tnow, dc, m, g, weight, filter) - toll, L, params.alpha)
  return { route: { pickups, zone: zp.zone, delivered, L, toll }, u }
}
```
- Add a trailing `filter: BundleFilter = F1` param to `score`, `bestInsert`, `buildRoute`, `routeFromClaims`, and `uRoute`, threading it through every internal call. `uRoute` subtracts the stored route toll:
```ts
export function uRoute(r: Route, tnow: number, dc: DecayConsts, params: Params, weight: ParcelWeight = W1, m: CountShaper = M1, g: ZoneShaper = G1, filter: BundleFilter = F1): number {
  return rate(vValue(r.delivered, r.zone, r.L, tnow, dc, m, g, weight, filter) - r.toll, r.L, params.alpha)
}
```
- Import `F1, type BundleFilter` into `route.ts`.

In `src/coordination/auction.ts` and `src/coordination/rebalance.ts`: their `dist` params are now pair-returning. Update the `Dist`/inline type to `(a: Pos, b: Pos) => { L: number; toll: number }` and every `dist(a, b)` use that expects a number to read `.L` (these modules rank by tick distance; tolls do not enter the bid metric this slice — only realised route value via `uRoute`/`bestZone` carries tolls). Grep each file for `dist(` and append `.L` at the numeric use sites.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bdi-route.test.ts tests/coordination-auction.test.ts tests/coordination-rebalance.test.ts tests/bdi-utility-kernel.test.ts`
Expected: PASS. (Existing route/auction/rebalance tests that pass a number-returning `dist` must be updated to return `{ L, toll: 0 }` — update those fixtures in this task.)

- [ ] **Step 5: Commit**

```bash
git add src/bdi/route.ts src/bdi/utility.ts src/coordination/auction.ts src/coordination/rebalance.ts tests/bdi-route.test.ts tests/coordination-auction.test.ts tests/coordination-rebalance.test.ts
git commit -m "refactor(route): Dist returns {L,toll}; U_route nets path tolls (§7.1)"
```

---

## Task 7: BDI loop integration — c_tick, tolls, filter, both agents

**Files:**
- Modify: `src/bdi/loop.ts`
- Test: `tests/bdi-loop-mission.test.ts` (extend)

Goal: compute `c_tick` once per tick, feed `ctx.tolls`/`ctx.cTick` from the view, make `distMemo` store `{L, toll}`, and pass `bundleFilter()` into route building + `doDeliver`'s `bestSubset`. Applies to both agents — the Courier (`pursue:false`) reads from the same replicated view.

- [ ] **Step 1: Write the failing test**

Append to `tests/bdi-loop-mission.test.ts`, reusing its existing `fakeClient`, `BdiLoop` constructor shape, and `log`. Add three local fixtures (a 2-row map so a dodge exists, a carried-parcel snapshot, a priced mission), then assert the move for both roles plus a base-play control. `ParcelObs` is `{ id, pos, reward, carriedBy }`; a carried parcel uses `carriedBy: 'me'` (self id in the snapshot is `'me'`):
```ts
// 2 rows: delivery at (0,0); a detour exists via row y=1.
function dodgeMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x <= 2; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  for (let x = 0; x <= 2; x++) tiles.push({ pos: { x, y: 1 }, type: 'walkable' })
  return tiles
}
// self at (2,0) carrying one parcel; must deliver to (0,0).
const carrySnap = (): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 2, y: 0 }, score: 0 },
  parcels: [{ id: 'c', pos: { x: 2, y: 0 }, reward: 50, carriedBy: 'me' }], agents: [], crates: [],
})
const tollMission = () => assembleMission(
  { kind: 'HARD_CONSTRAINT', payoff: -100, abstractIntent: 'avoid (1,0)', sub: 'PRICED',
    params: { priced: [{ tile: { tag: 'TEXT_BOUND', x: 1, y: 0 }, toll: 100 }] } },
  'avoid', 'm-toll')

test('both agents dodge a priced tile when delivering (§7.1, pursue:true/false)', async () => {
  for (const role of ['liaison', 'courier'] as const) {
    const rec = fakeClient(dodgeMap(), role)
    const view = new TeamMissionView(); view.set(tollMission())
    const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: role === 'liaison' })
    await loop.tick(carrySnap())
    expect(rec.moves[0]).toBe('up') // steps to row y=1 to skirt the 100-point tile (1,0)
  }
})

test('without the constraint the carried delivery goes straight (base play unchanged)', async () => {
  const rec = fakeClient(dodgeMap(), 'liaison')
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log) // no mission
  await loop.tick(carrySnap())
  expect(rec.moves[0]).toBe('left') // straight (2,0)->(1,0)->(0,0)
})
```
Rationale: `cTick = ρ·1 + uForgone(bootstrap)` is small, so the straight cost `cTick·2 + 100` loses to the detour `cTick·4 + 0` — the toll-aware A\* (driving both the route `dist` and the execution-selector `planPath`) returns the dodge first step `up`. The control proves base play is byte-identical with no constraint.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-loop-mission.test.ts`
Expected: FAIL — loop ignores tolls/filter (ctx has no `tolls`, dist memo is number-typed).

- [ ] **Step 3: Wire the loop**

In `src/bdi/loop.ts`:
- After computing `ctx` (line ~73) and `tnow`, derive `c_tick` and the toll map from the view, and add them to `ctx`:
```ts
    const mView = this.mission?.view
    const tolls = mView ? mView.tolls() : new Map<string, number>()
    const carriedNow = this.carriedOf(beliefs) // parcels in hand this tick
    const cTick = this.dc.rho * carriedNow.filter((p) => rnow(p, tnow, this.dc) > 0).length + this.rateTracker.uForgone()
    const planCtx: PlanCtx = { ...ctx, tolls, cTick }
```
  (Import `rnow` from `./utility.js` if not already.) Use `planCtx` wherever `ctx` was passed to `planPath`/dist below.
- Change `distMemo` to store the pair and `dist` to return it; `planPath` now takes `planCtx`:
```ts
    const distMemo = new Map<string, { L: number; toll: number }>()
    const dist = (a: Pos, b: Pos): { L: number; toll: number } => {
      const k = `${a.x},${a.y}|${b.x},${b.y}`
      const hit = distMemo.get(k)
      if (hit !== undefined) return hit
      const r = planPath(this.grid, planCtx, a, b)
      const v = { L: r.L, toll: r.tollSum }
      distMemo.set(k, v)
      return v
    }
```
- Every existing in-loop use of `dist(...)` that expected a number now reads `.L`. Audit the call sites surfaced by grep (`dist(self, p.pos)` in claim expiry at line ~97, `dist(winnerPos, p.pos)` at ~147, `buildPool` at ~255/257, `chooseExplore` arg at ~205, `dRef`). Each numeric use appends `.L`; route/uRoute calls pass the pair `dist` directly. The `distOf`/claim-liveness and explore paths rank by ticks → use `.L`.
- Compute the filter once and pass it into route building and delivery:
```ts
    const cf = this.mission ? this.mission.view.bundleFilter() : F1
```
  Pass `cf` as the trailing `filter` arg to `routeFromClaims` / `buildRoute` (lines ~189–200) and `uMission` route legs as applicable.
- In `doDeliver` (line ~345), pass the filter to `bestSubset`:
```ts
    const cf = this.mission ? this.mission.view.bundleFilter() : F1
    const bundle = bestSubset(carried, tile, tnow, this.dc, m, g, this.params.expiry_floor_ticks, cf)
```
- Import `F1` (and `rnow`) from `./utility.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bdi-loop-mission.test.ts tests/bdi-loop.test.ts tests/bdi-loop-claims.test.ts tests/bdi-loop-walkover.test.ts`
Expected: PASS (new constraint test + unchanged loop regressions — base play identical when no `HARD_CONSTRAINT`).

- [ ] **Step 5: Commit**

```bash
git add src/bdi/loop.ts tests/bdi-loop-mission.test.ts
git commit -m "feat(bdi): loop threads c_tick/tolls/filter into routing for both agents (§7)"
```

---

## Task 8: `emit_mission` schema + end-to-end replication

**Files:**
- Modify: `src/mission/kinds.ts` (`EMIT_MISSION_FN` schema)
- Test: `tests/mission-kinds.test.ts` (extend), `tests/mission-replication.test.ts` (extend)

Goal: let the LLM emit structured `priced`/`absolute` params, and prove a `HARD_CONSTRAINT` mission round-trips over a2a so both replicas build identical tolls/filter.

- [ ] **Step 1: Write the failing test**

Append to `tests/mission-replication.test.ts` (mirror the existing shaper-replication assertion):
```ts
test('HARD_CONSTRAINT mission replicates: both views build identical tolls + filter', () => {
  const m = assembleMission(
    { kind: 'HARD_CONSTRAINT', payoff: -50, abstractIntent: 'avoid (5,2)', sub: 'PRICED',
      params: { priced: [{ tile: { tag: 'TEXT_BOUND', x: 5, y: 2 }, toll: 50 }], absolute: { kind: 'REWARD_THRESHOLD', max: 10 } } },
    'avoid', 'm-hc')
  // serialize over the a2a envelope path used by the existing shaper test, then rehydrate into a second view:
  const wire = JSON.parse(JSON.stringify(m))
  expect(isMission(wire)).toBe(true)
  const vA = new TeamMissionView(); vA.set(m)
  const vB = new TeamMissionView(); vB.set(wire)
  expect([...vA.tolls()]).toEqual([...vB.tolls()])
  const big = [{ id: 'b', pos: { x: 0, y: 0 }, rewardSeen: 20, carriedBy: null, lastSeen: 0 }]
  expect(vA.bundleFilter()(big, { x: 0, y: 0 })).toBe(vB.bundleFilter()(big, { x: 0, y: 0 }))
})
```

- [ ] **Step 2: Run test to verify it fails / passes**

Run: `bun test tests/mission-replication.test.ts`
Expected: PASS for replication (params are plain data; `isMission` guard already accepts them) — if it FAILS, the `isMission` guard rejects the new fields; widen it. Either way, lock the behaviour with this test.

- [ ] **Step 3: Update the `emit_mission` schema**

In `src/mission/kinds.ts`, expand `EMIT_MISSION_FN.parameters.properties.params` description and add structured shape so the model emits `priced`/`absolute` (params stays permissive-typed, validated by the guard + builders):
```ts
      params: {
        type: 'object',
        description:
          'Kind-specific transcribed params. HARD_CONSTRAINT PRICED: priced=[{tile:{tag:"TEXT_BOUND",x,y},toll}]. ' +
          'HARD_CONSTRAINT ABSOLUTE: absolute={kind:"REWARD_THRESHOLD",max} OR {kind:"ZONE",tile:{tag:"TEXT_BOUND",x,y}}. ' +
          'Transcribe ONLY stated literals; never invent coordinates. REWARD_SHAPER: m (count->factor), g (tile->factor).',
      },
```
Add a guard test in `tests/mission-kinds.test.ts` asserting `isMissionDraft` accepts a `HARD_CONSTRAINT` draft carrying `priced`/`absolute`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/mission-replication.test.ts tests/mission-kinds.test.ts tests/mission-compiler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mission/kinds.ts tests/mission-replication.test.ts tests/mission-kinds.test.ts
git commit -m "feat(mission): emit_mission structured priced/absolute; HARD_CONSTRAINT replication (§7)"
```

---

## Final verification

- [ ] **Full suite green:** `bun test` — all tests pass, including untouched base-play regressions (proves identity = base play unchanged).
- [ ] **Spec coverage check:** §7.1 toll (Tasks 1, 6, 7) · c_tick exchange rate (Task 7) · §7.2 zone + reward-threshold filter (Tasks 2, 3, 4) · §7.3 worst-case whole-bundle void (Tasks 3, 4) · structured emission (Tasks 4, 8) · replication to both agents (Tasks 5, 7, 8).
- [ ] **DESIGN.md §7 status note:** update the line in `src/mission/view.ts` (done Task 5) and, if DESIGN.md tracks phase status, mark §7 implemented.
```
