# Mission Shapers + Team-Wide Replication (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a compiled `REWARD_SHAPER` mission actually reshape *which subset* and *which zone* both agents deliver to (DESIGN §6), and replicate the active mission Liaison→Courier so the Courier honours it too (spec decision A1).

**Architecture:** The Liaison owns the `MissionSlot`; on every slot change it both mirrors into its own `TeamMissionView` *and* broadcasts `{type:'mission'}` over the existing dumb relay. The Courier ingests that message into its own `TeamMissionView`. Both `BdiLoop`s read count/zone shapers from their local view and thread them — defaulting to identity (`m≡1`, `g≡1`) — into the existing `vValue` kernel, `bestZone`, route building, and the delivery-tile subset choice. No new selector; base play with no mission stays byte-for-byte unchanged.

**Tech Stack:** Bun + TypeScript (strict, ESM, `.js` import extensions), `bun:test`, Pino logging. Source of truth: `docs/superpowers/specs/2026-06-16-mission-intention-design.md` §6/§8 + `DESIGN.md` §6.

---

## Context for the implementer

Phase 1 already shipped the `U_mission` coordinate intention (Liaison-only), the `DeliveryRateTracker`, the `mission` intention variant, and the `TeamMissionView` with only `set`/`current`. This phase adds the **shaper math** and the **replication transport**. Read these before starting:

- `DESIGN.md` §6 (shapers, zone selection, subset argmax, the two §6.2 guards) — **authoritative**.
- `docs/superpowers/specs/2026-06-16-mission-intention-design.md` §6, §8 (Phase 2), §9 (testing).
- Phase 1 plan: `docs/superpowers/plans/2026-06-16-mission-intention-phase1.md`.

### Key codebase facts (already verified — do not re-derive)

- `ParcelBelief` shape: `{ id: string; pos: Pos; rewardSeen: number; carriedBy: string | null; lastSeen: number }` (`src/blackboard/beliefs.ts`). There is **no `reward` field** — current value is `rnow(p, tnow, dc)`.
- `rnow`, `vValue`, `bestZone`, `M1`, `G1`, `W1`, `CountShaper = (k:number)=>number`, `ZoneShaper = (z:Pos)=>number`, `DecayConsts`, `ParcelWeight` are all **exported from `src/bdi/utility.ts`**.
- `posKey = (p:Pos)=>`${p.x},${p.y}`` is exported from `src/types/perception.ts` (`tileKey` in utility.ts is an alias).
- `dc.rho` is points-of-decay per tick (default game: `0.05`).
- `deliverBundle` (the Phase-1 subset stub) is consumed in exactly **two** places: `src/bdi/loop.ts:342` and `tests/bdi-utility-kernel.test.ts:18`. This phase **removes** it in favour of `bestSubset` (Task 5).
- The **relay is type-agnostic** (`src/relay.ts` forwards by `msg.to`, never inspects `type`), so `{type:'mission'}` already passes through. No relay edit. The spec's "relay passthrough" line is a no-op — the payload guard lives at the Courier ingest.
- The structural guard `tests/mission-no-hotloop.test.ts` already scans **all** of `src/mission/*.ts` for `bdi/loop` imports, so the new `shapers.ts` is covered automatically — **no test edit needed**. `shapers.ts` may import from `bdi/utility` (that is not the hot loop and does not create a cycle).
- `MissionParams` (`src/mission/kinds.ts`): `m?: Record<string, number>` (count→factor), `g?: Array<{ tile: TileSlot; factor: number }>` (tile→factor). `TileSlot` is `{tag:'TEXT_BOUND';x;y} | {tag:'RUNTIME_BOUND';rule}`; only `TEXT_BOUND` is bound this slice.

### Two deliberate deviations from the spec (both behaviour-preserving)

1. **`bestSubset` lives in `src/mission/shapers.ts`, and the loop calls it directly in `doDeliver` — `deliverBundle` is deleted, not "delegated to".** The spec §4.2 says `utility.ts`'s `deliverBundle` delegates to `bestSubset`, but `bestSubset` needs `vValue`/`rnow` from `utility.ts`; a back-import would make `bdi/utility ↔ mission/shapers` circular. Putting `bestSubset` in `shapers.ts` (one-way `mission → bdi/utility`) and dropping the now-redundant `deliverBundle` is cleaner and avoids two subset implementations. Behaviour is identical: with `m≡1` `bestSubset` returns all positive-`Rnow` parcels, exactly as `deliverBundle` did.
2. **`bestSubset` scans *every* prefix length, not only the spec's "relevant counts" set.** For a fixed bundle size `k`, the top-`k`-by-`Rnow` parcels maximise `Σrᵢ`, so `value(k) = g·m(k)·Σ(top k)`; the global argmax is `max over k`. Evaluating all `k ∈ [|forced|, |positive|]` is obviously correct (and trivially handles a *penalty* like `m(5)=0.3` by also considering `k=4`, which the spec's literal "`k=|carried|` plus `m(k)≠1`" set omits). The carried count is tiny, so the `O(n²)` scan is free in the hot loop. The sort is the only `O(n log n)` part.

### File structure (created / modified)

| File | Responsibility | Task |
|------|----------------|------|
| `src/mission/kinds.ts` (mod) | add `isMission` payload guard (replication boundary) | 1 |
| `src/mission/shapers.ts` (new) | `buildCountShaper`, `buildZoneShaper`, `bestSubset` (§6.1 argmax + §6.2 expiry floor) | 2,3 |
| `src/bdi/params.ts` (mod) | `expiry_floor_ticks` hyperparameter | 3 |
| `src/mission/view.ts` (mod) | `countShaper()` / `zoneShaper()` derived accessors | 4 |
| `src/bdi/utility.ts` (mod) | delete `deliverBundle` (superseded by `bestSubset`) | 5 |
| `src/bdi/loop.ts` (mod) | call `bestSubset` in `doDeliver`; thread shapers into route building | 5,7 |
| `src/bdi/route.ts` (mod) | thread `m`/`g` through `score`/`bestInsert`/`buildRoute`/`routeFromClaims`/`uRoute` | 6 |
| `src/agents/liaison.ts` (mod) | broadcast `{type:'mission'}` on slot change | 8 |
| `src/agents/courier.ts` (mod) | construct view, pass `pursue:false`, ingest `{type:'mission'}` | 9 |
| `tests/mission-shapers.test.ts` (new) | builders, `bestSubset` argmax + expiry floor | 2,3 |
| `tests/mission-view.test.ts` (mod) | accessor coverage | 4 |
| `tests/bdi-utility-kernel.test.ts` (mod) | drop the `deliverBundle` block | 5 |
| `tests/mission-replication.test.ts` (new) | slot→broadcast→guard→view round-trip; teardown clears; garbage rejected | 8,9 |
| `tests/mission-kinds.test.ts` (mod) | `isMission` guard coverage | 1 |

---

## Task 1: `isMission` payload guard

The Courier receives a mission over an `unknown` a2a payload. It needs a type guard. `isMissionDraft` already validates the draft fields; `isMission` adds the assembled fields (`id`/`rawText`/`status`).

**Files:**
- Modify: `src/mission/kinds.ts`
- Test: `tests/mission-kinds.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/mission-kinds.test.ts`:

```ts
import { isMission, isMissionDraft, assembleMission, type MissionDraft } from '../src/mission/kinds.js'

test('isMission accepts an assembled mission and rejects a bare draft / garbage', () => {
  const m = assembleMission(goodDraft, 'hello', 'm-1')
  expect(isMission(m)).toBe(true)
  expect(isMission(goodDraft)).toBe(false) // no id/rawText/status
  expect(isMission(null)).toBe(false)
  expect(isMission({ ...m, status: 'NOPE' })).toBe(false)
  expect(isMission({ ...m, id: 42 })).toBe(false)
})
```

(Adjust the top-of-file import line to add `isMission` — do not duplicate the import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-kinds.test.ts`
Expected: FAIL — `isMission is not a function` / `not exported`.

- [ ] **Step 3: Implement the guard**

In `src/mission/kinds.ts`, after `isMissionDraft`:

```ts
export function isMission(u: unknown): u is Mission {
  if (!isMissionDraft(u)) return false
  const d = u as Record<string, unknown>
  return (
    typeof d.id === 'string' &&
    typeof d.rawText === 'string' &&
    (d.status === 'CLASSIFIED' || d.status === 'SUPERSEDED')
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-kinds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mission/kinds.ts tests/mission-kinds.test.ts
git commit -m "feat(mission): isMission payload guard for a2a replication"
```

---

## Task 2: Shaper builders (`buildCountShaper`, `buildZoneShaper`)

Pure functions turning transcribed `MissionParams` into the `CountShaper` / `ZoneShaper` closures the kernel already accepts. Identity when absent/empty so base play is recovered.

**Files:**
- Create: `src/mission/shapers.ts`
- Test: `tests/mission-shapers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mission-shapers.test.ts`:

```ts
// tests/mission-shapers.test.ts
import { test, expect } from 'bun:test'
import { buildCountShaper, buildZoneShaper } from '../src/mission/shapers.js'
import { M1, G1 } from '../src/bdi/utility.js'

test('buildCountShaper maps stated counts, identity elsewhere; identity when absent', () => {
  const m = buildCountShaper({ '3': 2, '5': 0.3 })
  expect(m(3)).toBe(2)
  expect(m(5)).toBe(0.3)
  expect(m(1)).toBe(1)
  expect(m(4)).toBe(1)
  expect(buildCountShaper(undefined)).toBe(M1)
  expect(buildCountShaper({})).toBe(M1)
})

test('buildCountShaper ignores non-positive / non-integer / non-finite keys & factors', () => {
  const m = buildCountShaper({ '0': 5, '-1': 5, '2.5': 5, '2': Infinity, '3': 4 })
  expect(m(3)).toBe(4)
  expect(m(0)).toBe(1)
  expect(m(2)).toBe(1)
})

test('buildZoneShaper maps TEXT_BOUND tiles, identity elsewhere; skips RUNTIME_BOUND', () => {
  const g = buildZoneShaper([
    { tile: { tag: 'TEXT_BOUND', x: 1, y: 2 }, factor: 5 },
    { tile: { tag: 'RUNTIME_BOUND', rule: 'nearest' }, factor: 9 },
  ])
  expect(g({ x: 1, y: 2 })).toBe(5)
  expect(g({ x: 0, y: 0 })).toBe(1)
  expect(buildZoneShaper(undefined)).toBe(G1)
  expect(buildZoneShaper([])).toBe(G1)
  expect(buildZoneShaper([{ tile: { tag: 'RUNTIME_BOUND', rule: 'x' }, factor: 5 }])).toBe(G1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-shapers.test.ts`
Expected: FAIL — `Cannot find module '../src/mission/shapers.js'`.

- [ ] **Step 3: Implement the builders**

Create `src/mission/shapers.ts`:

```ts
// src/mission/shapers.ts
// Pure builders: transcribed REWARD_SHAPER params -> the CountShaper/ZoneShaper closures the
// §5.4 kernel already accepts (DESIGN §6). Identity when absent/empty, so base play is recovered
// exactly. bestSubset (§6.1 argmax + §6.2 expiry floor) lives here too — see below.
//
// Imports bdi/utility (NOT bdi/loop): one-way mission -> utility, so no cycle and the
// mission-no-hotloop guard stays green.

import type { Pos } from '../types/perception.js'
import { posKey } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'
import type { MissionParams } from './kinds.js'
import { M1, G1, rnow, vValue, type CountShaper, type ZoneShaper, type DecayConsts } from '../bdi/utility.js'

/** count→factor over |putDown| (§6). Identity (M1) when absent or after filtering empties. */
export function buildCountShaper(m: MissionParams['m']): CountShaper {
  if (m === undefined) return M1
  const table = new Map<number, number>()
  for (const [k, f] of Object.entries(m)) {
    const ki = Number(k)
    if (Number.isInteger(ki) && ki > 0 && Number.isFinite(f)) table.set(ki, f)
  }
  if (table.size === 0) return M1
  return (k: number) => table.get(k) ?? 1
}

/** location→factor over the delivery tile (§6). RUNTIME_BOUND tiles are unbound this slice. */
export function buildZoneShaper(g: MissionParams['g']): ZoneShaper {
  if (g === undefined || g.length === 0) return G1
  const table = new Map<string, number>()
  for (const e of g) {
    if (e.tile.tag !== 'TEXT_BOUND') continue
    if (!Number.isFinite(e.factor)) continue
    table.set(posKey({ x: e.tile.x, y: e.tile.y }), e.factor)
  }
  if (table.size === 0) return G1
  return (z: Pos) => table.get(posKey(z)) ?? 1
}
```

(`bestSubset` is added to this same file in Task 3 — keep the imports; `rnow`/`vValue`/`DecayConsts`/`ParcelBelief` are used there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-shapers.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean (the unused `rnow`/`vValue`/`ParcelBelief`/`DecayConsts` imports are consumed in Task 3 — if tsc flags them as unused *now*, add Task 3's `bestSubset` in the same commit instead of splitting).

- [ ] **Step 5: Commit**

```bash
git add src/mission/shapers.ts tests/mission-shapers.test.ts
git commit -m "feat(mission): count/zone shaper builders (§6)"
```

---

## Task 3: `bestSubset` (§6.1 argmax + §6.2 expiry floor) + `expiry_floor_ticks` param

The real delivery-tile subset chooser. Sort carried by `Rnow` desc; force-include any parcel projected to decay to ≤0 within `expiry_floor_ticks` (§6.2 guard 2); pick the prefix size that maximises `g·m(k)·Σ`.

**Files:**
- Modify: `src/mission/shapers.ts`
- Modify: `src/bdi/params.ts`
- Test: `tests/mission-shapers.test.ts`

- [ ] **Step 1: Add the param**

In `src/bdi/params.ts`:

In the `Params` interface, after `rate_bootstrap`:

```ts
  expiry_floor_ticks: number // §6.2: force-deliver a carried parcel decaying to 0 within this many ticks
```

In `DEFAULT_PARAMS`, after `rate_bootstrap: 0.5,`:

```ts
  expiry_floor_ticks: 3,
```

In `RANGES`, after `rate_bootstrap: [0, 100],`:

```ts
  expiry_floor_ticks: [0, 100],
```

- [ ] **Step 2: Write the failing test**

Append to `tests/mission-shapers.test.ts`:

```ts
import { bestSubset } from '../src/mission/shapers.js'
import { decayConsts } from '../src/bdi/utility.js'
import type { GameConsts } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const p = (id: string, reward: number): ParcelBelief => ({ id, pos: { x: 0, y: 0 }, rewardSeen: reward, carriedBy: null, lastSeen: 0 })
const tile = { x: 0, y: 0 }

test('m=1: keeps all positive-Rnow parcels (base play unchanged)', () => {
  const b = bestSubset([p('a', 10), p('b', 6)], tile, 0, dc, M1, G1, 3)
  expect(b.set.map((x) => x.id).sort()).toEqual(['a', 'b'])
  expect(b.value).toBe(16)
})

test('count shaper ×2 at k=3: drop-3-hold-1 from 4 carried', () => {
  // top 3 = 10+9+8 = 27 -> ×2 = 54; all 4 = 27+1 = 28 -> ×1 = 28. Pick the 3-subset.
  const carried = [p('a', 10), p('b', 9), p('c', 8), p('d', 1)]
  const b = bestSubset(carried, tile, 0, dc, buildCountShaper({ '3': 2 }), G1, 3)
  expect(b.set.map((x) => x.id).sort()).toEqual(['a', 'b', 'c'])
  expect(b.value).toBe(54)
})

test('count penalty m(5)=0.3: never delivers the penalised count (splits to 4)', () => {
  // all 5 = 50 -> ×0.3 = 15; top 4 = 40 -> ×1 = 40. Pick 4.
  const carried = [p('a', 10), p('b', 10), p('c', 10), p('d', 10), p('e', 10)]
  const b = bestSubset(carried, tile, 0, dc, buildCountShaper({ '5': 0.3 }), G1, 3)
  expect(b.set.length).toBe(4)
  expect(b.value).toBe(40)
})

test('zone shaper multiplies the bundle value', () => {
  const b = bestSubset([p('a', 10)], { x: 1, y: 2 }, 0, dc, M1, buildZoneShaper([{ tile: { tag: 'TEXT_BOUND', x: 1, y: 2 }, factor: 5 }]), 3)
  expect(b.value).toBe(50)
})

test('expiry floor forces an about-to-decay parcel into the bundle despite a hold bonus', () => {
  // d is at Rnow=0.1 (<= rho*floor = 0.05*3 = 0.15) -> forced. m(3)=2 would otherwise drop it.
  const carried = [p('a', 10), p('b', 9), p('c', 8), p('d', 0.1)]
  const b = bestSubset(carried, tile, 0, dc, buildCountShaper({ '3': 2 }), G1, 3)
  expect(b.set.map((x) => x.id)).toContain('d')
})

test('drops zero/negative Rnow parcels; empty carried -> empty bundle', () => {
  expect(bestSubset([], tile, 0, dc, M1, G1, 3).set).toEqual([])
  const b = bestSubset([p('a', 10), p('z', 0)], tile, 0, dc, M1, G1, 3)
  expect(b.set.map((x) => x.id)).toEqual(['a'])
})
```

(`buildCountShaper`/`buildZoneShaper`/`M1`/`G1` are already imported at the top of this file from Task 2 — do not re-import them.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/mission-shapers.test.ts`
Expected: FAIL — `bestSubset is not a function`.

- [ ] **Step 4: Implement `bestSubset`**

Append to `src/mission/shapers.ts`:

```ts
/**
 * §6.1 reactive subset choice on a delivery tile, with the §6.2 expiry-floor guard.
 *
 * value(S) = g(tile)·m(|S|)·Σ Rnow(i). For a fixed size k the best S is the top-k carried by
 * Rnow, so the argmax is max over prefix sizes — we scan every feasible k (carried count is tiny;
 * the sort dominates at O(n log n)). Any carried parcel projected to decay to ≤0 within
 * `floorTicks` is FORCED into every candidate (never held to expiry, §6.2 guard 2).
 *
 * NOTE: scanning all prefixes (not only the spec's "relevant counts" set) is an intentional,
 * behaviour-equivalent simplification — see the plan's "deliberate deviations".
 */
export function bestSubset(
  carried: ParcelBelief[],
  tile: Pos,
  tnow: number,
  dc: DecayConsts,
  m: CountShaper,
  g: ZoneShaper,
  floorTicks: number,
): { set: ParcelBelief[]; value: number } {
  const positive = carried
    .map((p) => ({ p, r: rnow(p, tnow, dc) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r)
  if (positive.length === 0) return { set: [], value: 0 }

  const forced = positive.filter((x) => x.r - dc.rho * floorTicks <= 0).map((x) => x.p)
  const optional = positive.filter((x) => x.r - dc.rho * floorTicks > 0).map((x) => x.p)

  let best: { set: ParcelBelief[]; value: number } | null = null
  for (let j = 0; j <= optional.length; j++) {
    const set = [...forced, ...optional.slice(0, j)]
    if (set.length === 0) continue
    const value = vValue(set, tile, 0, tnow, dc, m, g)
    if (best === null || value > best.value) best = { set, value }
  }
  // best is non-null: positive.length>0 ⇒ at least one (forced or optional) parcel exists.
  return best!
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/mission-shapers.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Run the params test (regression)**

Run: `bun test tests/bdi-params.test.ts`
Expected: PASS (new param has a default + range; loader still round-trips).

- [ ] **Step 7: Commit**

```bash
git add src/mission/shapers.ts src/bdi/params.ts tests/mission-shapers.test.ts
git commit -m "feat(mission): bestSubset argmax + expiry floor; expiry_floor_ticks param (§6.1/§6.2)"
```

---

## Task 4: View shaper accessors

The loop must read shapers without knowing mission *kinds*. Add `countShaper()` / `zoneShaper()` to `TeamMissionView`, returning identity unless the current mission is a `REWARD_SHAPER`.

**Files:**
- Modify: `src/mission/view.ts`
- Test: `tests/mission-view.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/mission-view.test.ts`:

```ts
import { M1, G1 } from '../src/bdi/utility.js'

const shaperMission = () => assembleMission(
  { kind: 'REWARD_SHAPER', payoff: 0, abstractIntent: 'stacks of 3 double',
    params: { m: { '3': 2 }, g: [{ tile: { tag: 'TEXT_BOUND', x: 1, y: 2 }, factor: 5 }] } },
  'raw', 'm-shaper',
)

test('identity shapers when empty or when current mission is not a REWARD_SHAPER', () => {
  const v = new TeamMissionView()
  expect(v.countShaper()).toBe(M1)
  expect(v.zoneShaper()).toBe(G1)
  v.set(mk('m-1')) // a CANDIDATE_INTENTION (from the existing helper)
  expect(v.countShaper()).toBe(M1)
  expect(v.zoneShaper()).toBe(G1)
})

test('REWARD_SHAPER mission yields the count/zone shapers', () => {
  const v = new TeamMissionView()
  v.set(shaperMission())
  expect(v.countShaper()(3)).toBe(2)
  expect(v.countShaper()(1)).toBe(1)
  expect(v.zoneShaper()({ x: 1, y: 2 })).toBe(5)
  expect(v.zoneShaper()({ x: 0, y: 0 })).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-view.test.ts`
Expected: FAIL — `v.countShaper is not a function`.

- [ ] **Step 3: Implement the accessors**

Replace the body of `src/mission/view.ts` with:

```ts
// src/mission/view.ts
// Local read model of the active mission, as seen by ONE agent's BDI loop. The Liaison feeds it
// from its MissionSlot.onChange; the Courier feeds it from the replicated a2a 'mission' message.
// The loop reads shapers from HERE (never the slot, never mission kinds) so both agents share one
// code path. Returns identity shapers (M1/G1) when there is no mission, or the mission carries no
// shaper — base play is then byte-for-byte unchanged. Toll/filter accessors arrive in Phase 3.

import type { Mission } from './kinds.js'
import { M1, G1, type CountShaper, type ZoneShaper } from '../bdi/utility.js'
import { buildCountShaper, buildZoneShaper } from './shapers.js'

export class TeamMissionView {
  private mission: Mission | null = null

  set(m: Mission | null): void { this.mission = m }
  current(): Mission | null { return this.mission }

  countShaper(): CountShaper {
    return this.mission?.kind === 'REWARD_SHAPER' ? buildCountShaper(this.mission.params.m) : M1
  }

  zoneShaper(): ZoneShaper {
    return this.mission?.kind === 'REWARD_SHAPER' ? buildZoneShaper(this.mission.params.g) : G1
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-view.test.ts && bun test tests/mission-no-hotloop.test.ts`
Expected: both PASS (view imports `mission/shapers` + `bdi/utility`, neither is `bdi/loop`).

- [ ] **Step 5: Commit**

```bash
git add src/mission/view.ts tests/mission-view.test.ts
git commit -m "feat(mission): TeamMissionView count/zone shaper accessors (§6)"
```

---

## Task 5: Loop uses `bestSubset` in `doDeliver`; delete `deliverBundle`

Swap the Phase-1 subset stub for the real chooser. Read shapers from the view (identity when no mission), apply the expiry floor. Then remove the now-dead `deliverBundle`.

**Files:**
- Modify: `src/bdi/loop.ts`
- Modify: `src/bdi/utility.ts`
- Modify: `tests/bdi-utility-kernel.test.ts`
- Test: `tests/bdi-loop-mission.test.ts` (regression — must stay green)

- [ ] **Step 1: Update the loop's import line**

In `src/bdi/loop.ts`, replace line 6:

```ts
import { decayConsts, pAvail, deliverBundle, tileKey, type DecayConsts, type EnemyThreat } from './utility.js'
```

with:

```ts
import { decayConsts, pAvail, tileKey, M1, G1, type DecayConsts, type EnemyThreat } from './utility.js'
import { bestSubset } from '../mission/shapers.js'
```

- [ ] **Step 2: Rewrite `doDeliver`**

In `src/bdi/loop.ts`, replace the body of `doDeliver` (currently around lines 340–353):

```ts
  private async doDeliver(beliefs: BeliefBase, tile: Pos, tnow: number): Promise<void> {
    const carried = beliefs.self.carrying.map((id) => beliefs.parcels.get(id)).filter((p): p is ParcelBelief => p !== undefined)
    const m = this.mission ? this.mission.view.countShaper() : M1
    const g = this.mission ? this.mission.view.zoneShaper() : G1
    const bundle = bestSubset(carried, tile, tnow, this.dc, m, g, this.params.expiry_floor_ticks)
    const ids = bundle.set.map((p) => p.id)
    if (ids.length === 0) return
    this.acting = true
    try {
      await this.client.putdown(ids)
      beliefs.applyDelivery(ids)
      this.rateTracker.record(bundle.value, tnow)
    } finally {
      this.acting = false
    }
  }
```

- [ ] **Step 3: Delete `deliverBundle` from `utility.ts`**

In `src/bdi/utility.ts`, delete the entire `deliverBundle` function (the `export function deliverBundle(...)` block and its doc comment, around lines 92–103). Leave `vValue`, `bestZone`, `CountShaper`, `ZoneShaper`, `M1`, `G1` intact.

- [ ] **Step 4: Remove the dead `deliverBundle` test**

In `tests/bdi-utility-kernel.test.ts`: remove `deliverBundle` from the import on line 3, and delete the whole `test('deliverBundle keeps all positive-reward parcels (default m=1)', ...)` block (lines 18–22). The `vValue`/`bestZone`/`rate` tests stay.

- [ ] **Step 5: Run the affected tests**

Run: `bun test tests/bdi-utility-kernel.test.ts tests/bdi-loop-mission.test.ts && bunx tsc --noEmit`
Expected: PASS. `bdi-loop-mission` still passes — its fakes carry no parcels, so `doDeliver` is never hit; the mission-divert / onSatisfied / pursue:false behaviours are unchanged.

- [ ] **Step 6: Full suite (no regressions)**

Run: `bun test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/bdi/loop.ts src/bdi/utility.ts tests/bdi-utility-kernel.test.ts
git commit -m "feat(bdi): doDeliver uses bestSubset (shaper+expiry); drop deliverBundle stub (§6.1)"
```

---

## Task 6: Thread `m`/`g` through `route.ts`

Zone choice (`bestZone`) and route value (`vValue`) must see the shapers so the team routes to the high-multiplier zone and values stacked bundles correctly (§6.0). Add optional `m`/`g` params (default identity) appended *after* the existing `weight` param, so every current call site stays valid.

**Files:**
- Modify: `src/bdi/route.ts`
- Test: `tests/bdi-route.test.ts` (regression — defaults must preserve behaviour) + a new zone-shaper case

- [ ] **Step 1: Write the failing test**

Append to `tests/bdi-route.test.ts` (mirror that file's existing fixture style; this assumes its `p`/`dc`/`CONSTS` helpers — if names differ, reuse the local ones already defined at the top of that file):

```ts
import { buildZoneShaper } from '../src/mission/shapers.js'

test('buildRoute routes to a g=5 zone over a nearer identity zone (§6.0)', () => {
  // self at 0; zone A (x=2, g=1), zone B (x=6, g=5). carry one parcel @10, rho=0.05.
  // A rate ≈ (10 - 0.1)/(3) ; B rate ≈ 5*(10 - 0.3)/(7). B should win once g is threaded.
  const carried = [p('a', 10)]
  const zones = [{ x: 2, y: 0 }, { x: 6, y: 0 }]
  const dist = (a: { x: number }, b: { x: number }) => Math.abs(b.x - a.x)
  const g = buildZoneShaper([{ tile: { tag: 'TEXT_BOUND', x: 6, y: 0 }, factor: 5 }])
  const r = buildRoute(carried, [], { x: 0, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, dist, undefined, M1, g)
  expect(r?.zone).toEqual({ x: 6, y: 0 })
})
```

Add whatever imports that file is missing (`buildRoute`, `M1`, `DEFAULT_PARAMS`) — check its existing header first and only add what's absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-route.test.ts`
Expected: FAIL — `buildRoute` ignores the extra args / routes to the nearer zone `{x:2}`.

- [ ] **Step 3: Thread the shapers**

In `src/bdi/route.ts`:

Update the import on line 4 to bring `CountShaper`/`ZoneShaper`:

```ts
import { rate, vValue, bestZone, M1, G1, W1, type DecayConsts, type ParcelWeight, type CountShaper, type ZoneShaper } from './utility.js'
```

`uRoute` (line 27) — append `m`/`g` and pass them into `vValue`:

```ts
export function uRoute(r: Route, tnow: number, dc: DecayConsts, params: Params, weight: ParcelWeight = W1, m: CountShaper = M1, g: ZoneShaper = G1): number {
  return rate(vValue(r.delivered, r.zone, r.L, tnow, dc, m, g, weight), r.L, params.alpha)
}
```

`score` (line 33) — append `m`/`g`; pass into `bestZone` and `vValue`:

```ts
function score(self: Pos, carried: ParcelBelief[], pickups: ParcelBelief[], zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight, m: CountShaper, g: ZoneShaper): { route: Route; u: number } | null {
  const delivered = [...carried, ...pickups]
  const tail = pickups.length > 0 ? pickups[pickups.length - 1]!.pos : self
  const lPre = routeLength(self, pickups, tail, dist)
  if (!Number.isFinite(lPre)) return null
  const zp = bestZone(delivered, tail, zones, tnow, dc, dist, params.alpha, m, g)
  if (zp === null) return null
  const L = lPre + zp.L
  const u = rate(vValue(delivered, zp.zone, L, tnow, dc, m, g, weight), L, params.alpha)
  return { route: { pickups, zone: zp.zone, delivered, L }, u }
}
```

`bestInsert` (line 49) — append `m`/`g`; forward to `score`:

```ts
function bestInsert(self: Pos, carried: ParcelBelief[], pickups: ParcelBelief[], p: ParcelBelief, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight, m: CountShaper, g: ZoneShaper): { route: Route; u: number } | null {
  let best: { route: Route; u: number } | null = null
  for (let i = 0; i <= pickups.length; i++) {
    const trial = [...pickups.slice(0, i), p, ...pickups.slice(i)]
    const s = score(self, carried, trial, zones, tnow, dc, params, dist, weight, m, g)
    if (s !== null && (best === null || s.u > best.u)) best = s
  }
  return best
}
```

`buildRoute` (line 65) — append `m`/`g` (default identity); forward to every `score`/`bestInsert`:

```ts
export function buildRoute(carried: ParcelBelief[], pool: ParcelBelief[], self: Pos, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight = W1, m: CountShaper = M1, g: ZoneShaper = G1): Route | null {
  let current = carried.length > 0 ? score(self, carried, [], zones, tnow, dc, params, dist, weight, m, g) : null
  const remaining = [...pool]

  if (current === null && carried.length === 0) {
    let seed: { route: Route; u: number; idx: number } | null = null
    for (let idx = 0; idx < remaining.length; idx++) {
      const p = remaining[idx]!
      const s = score(self, carried, [p], zones, tnow, dc, params, dist, weight, m, g)
      if (s !== null && (seed === null || s.u > seed.u)) seed = { ...s, idx }
    }
    if (seed === null) return null
    current = { route: seed.route, u: seed.u }
    remaining.splice(seed.idx, 1)
  }
  if (current === null) return null

  for (;;) {
    let bestAdd: { route: Route; u: number; idx: number } | null = null
    for (let idx = 0; idx < remaining.length; idx++) {
      const p = remaining[idx]!
      const s = bestInsert(self, carried, current!.route.pickups, p, zones, tnow, dc, params, dist, weight, m, g)
      if (s !== null && (bestAdd === null || s.u > bestAdd.u)) bestAdd = { ...s, idx }
    }
    if (bestAdd === null || bestAdd.u <= current.u) break
    current = { route: bestAdd.route, u: bestAdd.u }
    remaining.splice(bestAdd.idx, 1)
  }
  return current.route
}
```

`routeFromClaims` (line 102) — append `m`/`g`; forward to `score`/`bestInsert`:

```ts
export function routeFromClaims(carried: ParcelBelief[], claimed: ParcelBelief[], self: Pos, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight = W1, m: CountShaper = M1, g: ZoneShaper = G1): Route | null {
  if (carried.length === 0 && claimed.length === 0) return null
  let cur = score(self, carried, [], zones, tnow, dc, params, dist, weight, m, g)
  if (cur === null) return null
  for (const p of claimed) {
    const ins = bestInsert(self, carried, cur.route.pickups, p, zones, tnow, dc, params, dist, weight, m, g)
    if (ins !== null) cur = ins
  }
  return cur.route
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/bdi-route.test.ts && bunx tsc --noEmit`
Expected: PASS — existing route tests unchanged (identity defaults); the new g=5 case routes to `{x:6}`.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/route.ts tests/bdi-route.test.ts
git commit -m "feat(bdi): thread count/zone shapers through route value + zone choice (§6.0)"
```

---

## Task 7: Loop threads view shapers into route building

Now feed the view's shapers into the route calls in `tick` so both agents' route value and zone choice are shaper-aware (Task 6 only made `route.ts` *accept* them).

**Files:**
- Modify: `src/bdi/loop.ts`
- Test: `tests/bdi-loop-mission.test.ts` (regression) + full suite

- [ ] **Step 1: Update the route imports**

In `src/bdi/loop.ts`, add `W1` to the utility import and `routeFromClaims`/`buildRoute`/`uRoute` are already imported from `./route.js`. The utility import (edited in Task 5) becomes:

```ts
import { decayConsts, pAvail, tileKey, M1, G1, W1, type DecayConsts, type EnemyThreat } from './utility.js'
```

- [ ] **Step 2: Compute the shapers once per tick and thread them**

In `src/bdi/loop.ts`, inside `tick`, just after `const carried = ...` on line 173 (the candidate-building section), add:

```ts
    const cm = this.mission ? this.mission.view.countShaper() : M1
    const cg = this.mission ? this.mission.view.zoneShaper() : G1
```

Then update the three shaper-relevant route calls:

The main `route` assignment (lines 185–189) — append `weightOf, cm, cg` to each `routeFromClaims`/`buildRoute`:

```ts
    const route = this.coord
      ? routeFromClaims(carried, ownClaimed, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf, cm, cg)
      : ownClaimed.length > 0 || carried.length > 0
        ? routeFromClaims(carried, ownClaimed, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf, cm, cg)
        : buildRoute(carried, pool, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf, cm, cg)
```

The `uRoute` candidate (line 191) — append `weightOf, cm, cg`:

```ts
    if (route !== null) cands.push({ intention: { kind: 'route', route }, u: uRoute(route, tnow, this.dc, this.params, weightOf, cm, cg) })
```

The partner-route call (line 197) — it passes no `weight`, so pass `W1` explicitly before `cm, cg`:

```ts
      const pRoute = (partner !== null && pClaims.length > 0)
        ? routeFromClaims(this.carriedOf(beliefs), pClaims, partner.pos, this.grid.deliveryZones, tnow, this.dc, this.params, dist, W1, cm, cg)
        : null
```

- [ ] **Step 3: Run regression + full suite**

Run: `bun test && bunx tsc --noEmit`
Expected: all green. With no mission, `cm`/`cg` are `M1`/`G1`, so every utility value is identical to before — base play unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/bdi/loop.ts
git commit -m "feat(bdi): loop threads TeamMissionView shapers into route building (§6)"
```

---

## Task 8: Liaison broadcasts the mission on slot change

The Liaison already mirrors the slot into its own view via `onChange`. Extend that callback to also broadcast `{type:'mission'}` so the Courier can mirror it.

**Files:**
- Modify: `src/agents/liaison.ts`
- Test: `tests/mission-replication.test.ts` (new — the seam, exercised without the worker runtime)

- [ ] **Step 1: Write the failing test (broadcast half)**

Create `tests/mission-replication.test.ts`:

```ts
// tests/mission-replication.test.ts
// Exercises the replication SEAM the agents wire (MissionSlot.onChange -> a2a 'mission' ->
// isMission guard -> TeamMissionView). The worker entrypoints are not importable under bun:test,
// so this tests the same units the agents compose, in the same shape.
import { test, expect } from 'bun:test'
import { MissionSlot } from '../src/mission/slot.js'
import { TeamMissionView } from '../src/mission/view.js'
import { isMission, assembleMission } from '../src/mission/kinds.js'
import type { A2AMessage } from '../src/types/a2a.js'

const shaper = () => assembleMission(
  { kind: 'REWARD_SHAPER', payoff: 0, abstractIntent: 'x', params: { m: { '3': 2 } } },
  'raw', 'm-1',
)

// Mirrors src/agents/liaison.ts: onChange both mirrors locally AND broadcasts.
function wireLiaison(sent: A2AMessage[]): { slot: MissionSlot; view: TeamMissionView } {
  const view = new TeamMissionView()
  const slot = new MissionSlot((m) => {
    view.set(m)
    sent.push({ from: 'liaison', to: 'courier', type: 'mission', payload: m })
  })
  return { slot, view }
}

test('installing a mission broadcasts it and mirrors it locally', () => {
  const sent: A2AMessage[] = []
  const { slot, view } = wireLiaison(sent)
  slot.install(shaper())
  expect(sent).toHaveLength(1)
  expect(sent[0]!.type).toBe('mission')
  expect((sent[0]!.payload as { id: string }).id).toBe('m-1')
  expect(view.current()?.id).toBe('m-1')
})

test('superseding broadcasts a null payload', () => {
  const sent: A2AMessage[] = []
  const { slot } = wireLiaison(sent)
  slot.install(shaper())
  slot.supersede()
  expect(sent).toHaveLength(2)
  expect(sent[1]!.payload).toBeNull()
})

// Mirrors src/agents/courier.ts ingest: guard the payload, then view.set.
function ingest(view: TeamMissionView, payload: unknown): void {
  if (payload === null) view.set(null)
  else if (isMission(payload)) view.set(payload)
  // else: dropped (bad payload)
}

test('courier ingest installs a valid mission, clears on null, drops garbage', () => {
  const view = new TeamMissionView()
  ingest(view, shaper())
  expect(view.current()?.id).toBe('m-1')
  expect(view.countShaper()(3)).toBe(2)
  ingest(view, { junk: true })
  expect(view.current()?.id).toBe('m-1') // unchanged — garbage rejected
  ingest(view, null)
  expect(view.current()).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-replication.test.ts`
Expected: PASS already for the seam tests (they don't import the agent). This test guards the *contract*; Steps 3–4 make the real Liaison match it. Confirm green, then proceed.

> If you prefer a strictly-failing TDD step here, temporarily assert `sent[0]!.from === 'courier'` to see red, then revert. The seam logic under test is pure, so the guarding value is in locking the contract the agent must satisfy.

- [ ] **Step 3: Wire the Liaison broadcast**

In `src/agents/liaison.ts`, replace the slot/view construction (lines 38–39):

```ts
  const missionView = new TeamMissionView()
  const missionSlot = new MissionSlot((m) => missionView.set(m))
```

with:

```ts
  const missionView = new TeamMissionView()
  const missionSlot = new MissionSlot((m) => {
    missionView.set(m)
    send({ from: 'liaison', to: 'courier', type: 'mission', payload: m })
  })
```

(`send` is the module-level a2a sender already defined at the top of the file. `m` is `Mission | null`, matching the Courier's guard.)

- [ ] **Step 4: Typecheck + full suite**

Run: `bunx tsc --noEmit && bun test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/agents/liaison.ts tests/mission-replication.test.ts
git commit -m "feat(liaison): broadcast active mission to the Courier on slot change (A1)"
```

---

## Task 9: Courier ingests the mission + reads shapers

Give the Courier a `TeamMissionView` (passed to its loop with `pursue:false` so it reads shapers but builds no `U_mission`), and ingest the `{type:'mission'}` a2a into it.

**Files:**
- Modify: `src/agents/courier.ts`
- Test: full suite + `tsc`

- [ ] **Step 1: Add imports + module-level view**

In `src/agents/courier.ts`, after the existing imports add:

```ts
import { TeamMissionView } from '../mission/view.js'
import { isMission } from '../mission/kinds.js'
```

After `let claims: ClaimStore | null = null` add:

```ts
let missionView: TeamMissionView | null = null
```

- [ ] **Step 2: Construct the view and pass it to the loop**

In `boot`, replace the loop construction (lines 33–40):

```ts
  const loop = new BdiLoop(client, params, {
    info: (obj, msg) => log!.info(obj as object, msg),
    debug: (obj, msg) => log!.debug(obj as object, msg),
    warn: (obj, msg) => log!.warn(obj as object, msg),
  }, claims, {
    partner: 'liaison',
    send,
  })
```

with:

```ts
  missionView = new TeamMissionView()
  const loop = new BdiLoop(client, params, {
    info: (obj, msg) => log!.info(obj as object, msg),
    debug: (obj, msg) => log!.debug(obj as object, msg),
    warn: (obj, msg) => log!.warn(obj as object, msg),
  }, claims, {
    partner: 'liaison',
    send,
  }, {
    view: missionView,
    pursue: false, // Courier honours shapers/zone but never chases the coordinate target (A3)
  })
```

- [ ] **Step 3: Ingest the mission message**

In `src/agents/courier.ts`, in the `a2a` branch of `self.onmessage` (lines 65–71), insert a `mission` case before the `blackboard?.receive` fallback:

```ts
  if (envelope.kind === 'a2a') {
    const msg = envelope.data
    if (msg.type === 'claims' && isClaimMsg(msg.payload)) {
      if (claims !== null) claims.applyMsg(msg.payload, 'courier')
      else log?.debug({ type: msg.type }, 'claims msg dropped — boot in progress')
    } else if (msg.type === 'mission') {
      if (msg.payload === null) missionView?.set(null)
      else if (isMission(msg.payload)) missionView?.set(msg.payload)
      else log?.debug({ type: msg.type }, 'mission msg dropped — bad payload')
    } else blackboard?.receive(msg)
  }
```

- [ ] **Step 4: Typecheck + full suite**

Run: `bunx tsc --noEmit && bun test`
Expected: green. The Courier now mirrors the Liaison's mission and its `doDeliver`/route honour `cm`/`cg`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/courier.ts
git commit -m "feat(courier): ingest replicated mission; read shapers with pursue:false (A1)"
```

---

## Phase 2 Done-When (spec §8)

- A `REWARD_SHAPER` measurably changes **subset** choice — drop-3-hold-1 on `m(3)=2`, split-to-4 on `m(5)=0.3` (Task 3 tests).
- A `REWARD_SHAPER` changes **zone** choice — route to the `g=5` zone over a nearer identity zone (Task 6 test).
- Both agents honour it: the Liaison from its slot, the Courier from the replicated message (Tasks 8–9 + replication test).
- Base play with no mission is byte-for-byte unchanged: every shaper defaults to identity (`M1`/`G1`); full suite stays green at every task boundary.

## Final verification (run before declaring Phase 2 complete)

- [ ] `bun test` — entire suite green.
- [ ] `bunx tsc --noEmit` — no type errors.
- [ ] `bun test tests/mission-no-hotloop.test.ts` — `shapers.ts`/`view.ts` import no `bdi/loop`.
- [ ] Re-read `DESIGN.md` §6 and confirm no behaviour diverges. If code and DESIGN conflict, the code is wrong.

## Out of scope (Phase 3)

Hard constraints (§7): `src/mission/constraints.ts`, A\* tolls + `tollSum` + `c_tick`, absolute `value(S)` filter, and the view's `tolls()`/`absoluteFilter()` accessors. Phase 3 reuses this phase's replication path unchanged.
