# §7 Hard Constraints — Design

**Date:** 2026-06-17
**Scope:** DESIGN.md §7 (both halves: §7.1 priced toll + §7.2 absolute filter, with §7.3 worst-case bias).
**Status:** approved, pre-implementation.

## Goal

Land DESIGN.md §7 hard constraints by collapsing them into existing machinery — **no special resolver**. Two flavours:

- **§7.1 priced constraint** ("do not go through (x,y) or lose 50"): entering a tile is allowed but costs `toll` points, paid in the unified currency via an A\* edge toll.
- **§7.2 absolute constraint** ("deliver reward >10 → no reward" / "deliver in (x1,y1) → 0 pts"): nullifies bundle value via a predicate inside `value(S)`.

Both arrive over the existing `HARD_CONSTRAINT` mission + a2a replication path (unchanged). Both agents (Liaison `pursue:true`, Courier `pursue:false`) honour them at the BDI loop level.

## Invariant: identity = base play byte-identical

This mirrors the §6 shaper discipline (`M1`/`G1` recover base play exactly):

- No `HARD_CONSTRAINT` active ⇒ toll map empty ⇒ A\* runs the existing pure-tick search verbatim; `tollSum ≡ 0`.
- No absolute constraint ⇒ filter is `F1` (passes every bundle).
- Snapshot test asserts routes are byte-identical to pre-§7.

## Decisions taken by precedent (shaper phase)

- **TEXT_BOUND tiles only** this slice. RUNTIME_BOUND tiles stay unbound (exactly as `buildZoneShaper` defers them). §7 worked examples use literal coords, so this covers them.
- **Structured LLM emission** over runtime string-parse. Matches the `m`/`g` shaper precedent; avoids a runtime NL parser and any eval surface (cf. `calc.ts` safety stance).

---

## 1. Data model — structured emission

Extend `MissionParams` (src/mission/kinds.ts) and the `emit_mission` schema with structured constraint fields. The raw `filter`/`rule`/`tile` strings are no longer the constraint carriers.

```ts
// priced (§7.1) — a list: "don't go through (x,y)" may name several tiles
priced?: Array<{ tile: TileSlot; toll: number }>

// absolute (§7.2) — at most one predicate per mission
absolute?:
  | { kind: 'REWARD_THRESHOLD'; max: number }   // any parcel reward > max ⇒ forfeit whole bundle
  | { kind: 'ZONE'; tile: TileSlot }            // delivering at this tile ⇒ forfeit
```

`sub: 'PRICED' | 'ABSOLUTE'` already exists on `MissionDraft` and discriminates which field the LLM fills. `emit_mission` schema description updated to instruct structured emission of `priced[]` / `absolute`.

Builders (new, in src/mission/shapers.ts or a sibling — pure closures, one-way `mission → utility` import, TEXT_BOUND-only, identity when absent):

- `buildTolls(priced): Map<string, number>` — tileKey → toll points. Empty map when absent. Skips RUNTIME_BOUND tiles and non-finite tolls.
- `buildBundleFilter(absolute): BundleFilter` — see §3. `F1` when absent.

## 2. A\* toll integration (§7.1)

**Types (src/planning/astar.ts):**

- `PlanCtx` gains `tolls?: Map<string, number>` (tileKey→points) and `cTick?: number`.
- `PathResult` gains `tollSum: number`.

**Opt-in switch:** when `tolls` is empty/undefined, the existing pure-tick search runs unchanged (`g = steps`, `h = manhattan(from,to)`, `tollSum = 0`). This preserves base play exactly **and** dodges the `cTick = 0` degeneracy (an empty-handed agent with bootstrap-only `uForgone` could otherwise make all path costs collapse).

**Toll mode** (tolls non-empty):

- Cost minimised is `cTick·steps + Σ toll(tile)`. The heap `before`/`f` ordering uses this cost.
- Each `Node` additionally tracks `steps` and `tollAccum` (separately from the cost used for ordering).
- Heuristic `h = cTick · manhattan(from, to)` — admissible because every step costs ≥ `cTick` (tolls ≥ 0).
- At goal: return `L = steps`, `tollSum = tollAccum`. **`L` stays a pure tick count** (§7.1 rule b — the decay math in `V` needs real time).
- Determinism: the existing `seq` insertion-order tie-break is retained as the final tie-breaker; revisit the `g`-based tie-break (currently "prefer larger g") so it stays well-defined under cost-ordering.

**Exchange rate** `c_tick` (§7.1):

```
cTick = ρ · |{ i ∈ carried : Rnow(i) > 0 }| + tracker.uForgone()
```

`DeliveryRateTracker.uForgone()` already exists and is documented for this use. `cTick` is computed once per BDI tick (carried set is fixed within a tick) and fed into `ctx`; the per-tick `distMemo` therefore stays valid.

**Leg coverage (§7.1 rule a):** because all route building goes through `dist` (§4), tolls load onto every planned leg — collect cycles, exploration, contract legs — with no per-call-site work.

## 3. Value-filter integration (§7.2)

One unified predicate over (bundle, zone), applied at the single chokepoint `vValue` (src/bdi/utility.ts):

```ts
export type BundleFilter = (S: ParcelBelief[], z: Pos) => boolean  // true = valid
export const F1: BundleFilter = () => true

// vValue gains a `filter: BundleFilter = F1` param:
//   if (!filter(parcels, z)) return 0
//   else g(z) · m(|parcels|) · Σ weight·max(0, Rnow − ρL)
```

Predicate semantics from the builder:

- `REWARD_THRESHOLD { max }`: violated iff **any** parcel in `S` has `rewardSeen > max`. **Whole bundle voided** (§7.3 worst-case — no clarification allowed; conservative reading). Threshold is checked against nominal `rewardSeen`, not decayed `Rnow`: the constraint refers to the parcel's identity ("parcels with score >10"), not its current decayed value, so it must not flip as the parcel decays past the threshold mid-carry.
- `ZONE { tile }`: violated iff `z` equals the forbidden tile (TEXT_BOUND coords).

Because `bestZone`, `bestSubset`, and route scoring all funnel through `vValue`, the filter inherits everywhere:

- A forbidden delivery zone scores 0 → naturally drops out of `bestZone` selection (`reachableDeliveries` effectively shrinks; if all zones forbidden, the least-bad 0-value zone is returned — acceptable).
- `bestSubset`'s argmax never assembles a forfeiting bundle — a subset containing a `>max` parcel scores 0 and loses.

**Edge note (not a new rule):** the §6.2 expiry-floor guard *forces* expiring parcels into every candidate subset. If a forced parcel is itself `>max`, every candidate forfeits → a 0-value delivery happens anyway. This is the accepted worst-case intersection of two non-utility guards; documented, not special-cased.

## 4. `dist` signature and view wiring

**`Dist` type** becomes pair-returning:

```ts
type Dist = (a: Pos, b: Pos) => { L: number; toll: number }
```

- The loop's `distMemo` stores the `{ L, toll }` pair from one `planPath` call (single honest source — `L` and `tollSum` describe the *same* chosen path, which is required because toll-aware A\* picks a toll-dependent path).
- Call sites updated to read `.L` (and `.toll` where route value is computed): `route.ts` (`routeLength`, `score`, `bestInsert`), `utility.ts` (`bestZone`), `coordination/auction.ts`, `coordination/rebalance.ts`, `loop.ts` `buildPool`, `chooseExplore`.
- Route value subtracts the path's toll from the numerator (§7.1):

```
U_deliver = ( V(S*, z*, L) − Σ_{t∈path} toll(t) ) / (L + 1)^α
```

The toll sum for a route is the sum of `.toll` over its legs (self→q1→…→qn→z).

**`TeamMissionView` Phase-3 accessors** (the file already names these as "arrive in Phase 3"):

```ts
tolls(): Map<string, number>      // buildTolls(mission.params.priced) or empty
bundleFilter(): BundleFilter      // buildBundleFilter(mission.params.absolute) or F1
```

Replication unchanged: the Courier ingests the same `HARD_CONSTRAINT` mission over a2a and builds identical closures → deterministic replicas. Loop reads both accessors from the view only (never the slot, never mission kinds) — one code path for both agents.

## 5. Invariants & tests

- **Base-play identity:** no `HARD_CONSTRAINT` active ⇒ `dist(...).toll ≡ 0`, filter ≡ `F1`, A\* search untouched. Snapshot test: routes byte-identical to pre-§7 fixtures.
- **§7.1 worked example** (DESIGN.md §7.1 table, `ρ=1` single-parcel assumption): delivery (8,2), priced (5,2) toll 50, bundle 30 → go-straight net −20 (reject) / detour +6 ticks net +24 (take) / hold-and-batch to bundle 70 net +20 (pay toll once). Reproduce as a unit test on the value math + A\* path choice.
- **A\* toll admissibility:** detour chosen only when bundle value justifies paying; with no toll, identical path to pure-tick A\*.
- **§7.3 worst-case:** bundle with one `reward > max` parcel ⇒ `value = 0`; `bestSubset` prefers the subset excluding it; if forced by expiry, 0-value delivery accepted.
- **Zone filter:** forbidden zone drops out of `bestZone`; non-forbidden zone selected even if closer-forbidden exists.
- **Both agents:** Courier (`pursue:false`) honours tolls + filter at loop level, mirroring the §6 both-agents replication test.
- **BDI tick budget:** toll-mode A\* stays within `budgetMs`; verify large-map path with tolls does not regress tick duration past the 40ms alert threshold.

## Out of scope (deferred)

- RUNTIME_BOUND constraint tiles (bind-from-map rule) — same deferral as the shaper phase.
- §8 coordination contracts, §9 auction polish.
