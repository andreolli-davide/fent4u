# Mission as a First-Class Intention — U_mission, Shapers, Constraints (Design)

> **Scope:** Handoff item #2. Make a compiled, parked `Mission` actually influence behaviour:
> the `U_mission` candidate in the intention selector (DESIGN §5.5), reward shapers (§6), and
> hard constraints (§7). Builds directly on the mission compiler lane (item #1, already landed)
> and the existing utility-based BDI core. **DESIGN.md is the source of truth — if this spec and
> DESIGN conflict, DESIGN wins.**

**Status:** approved design, pre-implementation.
**Date:** 2026-06-16.
**Depends on:** `src/mission/{slot,compiler,kinds,intake,llm,calc}.ts` (item #1); `src/bdi/{loop,intentions,utility,route,params}.ts`; `src/planning/astar.ts`; `src/blackboard/`, `src/relay.ts`, `src/types/a2a.ts`.

---

## 1. Goal & non-goals

**Goal.** A natural-language mission already compiled into a typed `Mission` and parked in the
Liaison's `MissionSlot` must now change what the agents *do*:

1. A `CANDIDATE_INTENTION` with a coordinate `targetTile` competes in the §9.9 per-tick argmax via
   `U_mission` (§5.5), so the Liaison diverts to it exactly when it beats route/explore/idle.
2. A `REWARD_SHAPER` reshapes **which subset** to deliver (count shaper `m(k)`) and **which zone**
   to deliver at (location shaper `g(tile)`), for **both** agents (§6).
3. A `HARD_CONSTRAINT` priced tile becomes an A\* edge toll; an absolute constraint becomes a
   `value(S)` filter — for **both** agents, with no special resolver (§7).

**Non-goals (explicitly deferred):**

- `V_plan` (decayed value of parcels a *plan* delivers) — `0` for the coordinate/shaper/constraint
  missions this slice handles, so it stays `0` here; the non-zero case arrives with the §17/§18
  back-ends.
- Parcel-targeted and `FALLBACK` missions, and the back-ends themselves (§17 PDDL, §18 LLM-agent).
- `COORDINATION_CONTRACT` missions, the §8 contract primitive, and §9.10 bid-based mission
  assignment with lock precedence. The coordinate intention is pursued by the Liaison directly,
  **no bid** (see §3 decision A3).
- A team-shared `ρ_ref` on the blackboard. Each agent uses its **own** observed delivery rate; the
  blackboard share described in DESIGN §17.6.3 is out of scope.

---

## 2. Decisions (settled in brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | **Shapers/constraints apply team-wide.** The active mission is replicated Liaison→Courier; both `BdiLoop`s read `m`/`g`/tolls/filters. | DESIGN §6 examples ("deliver in (x1,y1) → 5×") reshape *team* delivery value; a Courier ignoring them would deliver to the wrong zone / cross tolls. |
| A2 | **Real delivery-rate tracker.** A per-agent windowed tracker over ground-truth own putDowns exposes `ρ_ref` (90th-pct) and `ū_forgone` (mean). | The §5.5 rate ceiling and the §7.1 toll exchange rate both need it; DESIGN §16 wants these measured, not hard-coded (open-loop exception: own deliveries are ground truth). |
| A3 | **Liaison pursues the coordinate intention, no bid.** Only the Liaison builds `U_mission`. | Smallest correct behaviour for a single coordinate target; bid-based assignment (§9.10) belongs to the deferred contracts slice. |

---

## 3. Architecture & data flow

The slice rides on top of the BDI core (DESIGN §1: core untouched). No existing utility/selector
signature changes meaning — `U_mission` is a 4th candidate; shapers/constraints flow into the
**existing** kernel `V` and A\* through new **optional** params that default to identity/empty, so
base play with no mission is byte-for-byte unchanged.

```
Liaison worker                                    Courier worker
─────────────                                     ──────────────
MissionSlot.install(m) ──(a2a 'mission' msg)──▶   TeamMissionView.set(m)
   │                       via relay (main)             │
   ▼                                                    ▼
TeamMissionView (local, read model)               TeamMissionView (local)
   │   countShaper / zoneShaper / tolls / filter      │  (same accessors)
   ▼                                                   ▼
kernel V · deliverBundle · bestZone · PlanCtx.tolls (both agents)
   │
   ▼
U_mission candidate (Liaison only) → select()     (no U_mission: Courier has
                                                   no coordinate target to pursue)
```

- **One-way replication, separate from belief sync.** Liaison owns the slot. On `install`/
  `supersede` it broadcasts `{ from, to, type:'mission', payload: Mission | null }` through the
  existing dumb main-thread relay. The Courier holds a read-only `TeamMissionView`. This is *not*
  folded into the belief delta-sync channel: beliefs are union-merged perceived state; a mission is
  single-author (Liaison) last-write-wins authored state. Mixing them would muddy the CRDT-free
  delta-sync invariant.
- **Both agents read shapers/constraints** from their local `TeamMissionView`.
- **Only the Liaison builds `U_mission`** (decision A3).
- **`DeliveryRateTracker` is per-agent**, reads only own putDowns (no replication needed for
  `ū_forgone`); each agent uses its own `ρ_ref`.

---

## 4. Modules

### 4.1 New files

| File | Purpose |
|------|---------|
| `src/mission/view.ts` | `TeamMissionView` — local read model. `set(m\|null)`, `current()`, and derived accessors `countShaper(): CountShaper`, `zoneShaper(): ZoneShaper`, `tolls(): Map<string,number>`, `absoluteFilter(): ParcelFilter`. Returns identity/empty when no mission or the kind carries no shaper/constraint. The loop asks the view for shapers and stays oblivious to mission *kinds*. |
| `src/mission/shapers.ts` | Pure builders `buildCountShaper(params.m)`, `buildZoneShaper(params.g)` → the `CountShaper`/`ZoneShaper` types in `utility.ts`; and `bestSubset(carried, tile, tnow, dc, m, filter)` — the §6.1 sorted-prefix argmax over relevant counts. |
| `src/mission/constraints.ts` | `buildTolls(params)` → priced-tile `Map<tileKey, number>`; `buildAbsoluteFilter(params)` → `(set: ParcelBelief[]) => boolean` predicate, **worst-case bundle void** (§7.3). |
| `src/bdi/rate-tracker.ts` | `DeliveryRateTracker` — windowed reward/tick samples from own putDowns; `rhoRef(): number` (90th-pct), `uForgone(): number` (mean). Bootstrap default until enough samples. |
| `src/bdi/mission-intention.ts` | `uMission(...): Candidate \| null` — the §5.5 formula for `CANDIDATE_INTENTION`: `L_m`, `s_m`, binary `P_feasible`, `P_FEASIBLE_MIN` floor (returns `null` below it), rate ceiling `min(·, c·ρ_ref)`. |

### 4.2 Edits to existing files

| File | Change |
|------|--------|
| `src/planning/astar.ts` | `PlanCtx.tolls?: Map<string, number>` and `PlanCtx.cTick?: number` (the points-per-tick exchange rate); accumulate a **separate** `tollSum` in `PathResult` (rule §7.1b: `L` stays a pure tick count, toll returned alongside). Toll adds to A\* node cost only for routing choice; `L` is unaffected. |
| `src/bdi/utility.ts` | Replace the deferred subset stub in `deliverBundle` (currently lines ~96–103) with the real §6.1 sorted-prefix argmax (delegating to `bestSubset`); add the §6.2 expiry-floor guard (force-deliver a carried parcel projected to decay to 0 within a few ticks). `bestZone` already accepts `g`. |
| `src/bdi/intentions.ts` | `Intention` union gains `{ kind: 'mission'; mission: Mission }`; `matches` gains a mission-identity case (same mission `id`); update the "three this slice" doc to four. |
| `src/bdi/params.ts` | Add `theta_mission`, `c` (rate-ceiling factor, default `1.5`), `p_feasible_min` (default `0.3`), and the rate-tracker window size, each with a `RANGES` entry and default. |
| `src/bdi/loop.ts` | Accept optional `missionView: TeamMissionView` and `rateTracker: DeliveryRateTracker`. Thread shapers/tolls/filter into `route`/`bestZone`/`deliverBundle`/`planCtx`. Build the `U_mission` candidate when `missionView.current()` is a Liaison-pursued coordinate intention. Feed each putDown into the rate tracker in `doDeliver`. On mission satisfaction (arrived at `targetTile`) call `slot.supersede()` via an injected hook. |
| `src/agents/liaison.ts` | Construct `TeamMissionView` + `DeliveryRateTracker`; on `slot.install`/`supersede`, broadcast `{type:'mission'}`; pass view + tracker into `BdiLoop`. |
| `src/agents/courier.ts` | Construct `TeamMissionView` + `DeliveryRateTracker`; on incoming `{type:'mission'}` a2a, `view.set(...)`; pass view + tracker into `BdiLoop`. |
| `src/relay.ts`, `src/types/a2a.ts` | Allow `type:'mission'` messages (Liaison→Courier) through the relay; add a payload guard (`Mission | null`). |

---

## 5. The U_mission formula (§5.5) for a coordinate intention

```
U_mission(m) = min( θ_m · P_feasible(m) · (payoff(m) + V_plan(m)) · max(1/(L_m+1)^α, 1/(s_m+1)^α),
                    c · ρ_ref )
s_m = deadline_next(m) − t_now − L_m         (∞ when no deadline ⇒ shadow term vanishes)
```

For `CANDIDATE_INTENTION` with `targetTile`:

- `V_plan(m) = 0` (delivers no parcels) ⇒ value scale is just `payoff(m)` (signed: negative
  missions never win).
- `L_m = d(self, targetTile)` via the same push-aware A\* `dist` the loop already memoises.
- `θ_m` = mission's own `theta` override or the global `theta_mission` default.
- `P_feasible(m)` = **binary reachability**: `1` if `targetTile` reachable (finite `L_m`), else `0`.
- `P_FEASIBLE_MIN` floor (§5.5/§12, default `0.3`): a mission with `P_feasible < P_FEASIBLE_MIN`
  is **dropped from the candidate set** — `uMission` returns `null` (distinct from a low score), so
  it never enters the argmax and never churns the commitment hysteresis. For a coordinate mission
  this just means "unreachable ⇒ out."
- Rate ceiling `min(·, c·ρ_ref)`: caps a hallucinated payoff's implausible points/tick at
  `c · ρ_ref` (`c = 1.5`, `ρ_ref` = this agent's 90th-pct observed delivery rate). Bites only when
  the rate is implausible; a long legitimate mission is untouched.
- Deadline urgency `max(1/(L_m+1)^α, 1/(s_m+1)^α)`: far from the deadline the completion rate
  dominates (behaviour unchanged); as `s_m → 0` the slack shadow price rises toward `payoff` and the
  agent commits at the latest departure. `s_m < 0` ⇒ `P_feasible = 0` (Active→Expired, §4.3).

On arrival at `targetTile`, the mission is satisfied: the loop tears down the slot (`supersede`),
which broadcasts the cleared mission to the Courier.

---

## 6. Shapers (§6)

A `REWARD_SHAPER` supplies up to two multiplier maps in `params`:

- **count→factor** `m(k)` over `|putDown|`;
- **location→factor** `g(tile)` over the delivery zone.

Both default to identity (`≡ 1`), so base play is recovered exactly.

- **Zone choice (§6.0).** `bestZone` already maximises the **travel-decayed** kernel
  `V(S, z, d(self,z)) / (d+1)`; passing a non-identity `g` makes a 5× zone worth a detour up to the
  decay it costs, and a 0× zone drops out. No new selector.
- **Subset choice (§6.1).** `deliverBundle`'s current stub (best = all positive-`R_now`) is replaced
  by the real argmax: sort carried by `R_now` desc (`O(n log n)`), evaluate `value` only over
  relevant counts — `k = |carried|` plus every `k` with `m(k) ≠ 1` — and pick the max. Absolute
  filters (§7.2) pre-remove violating parcels so a forfeiting bundle is never assembled.
- **Hold/collect (§6.1 touch point 2).** Already emergent from `U_collect` vs `U_deliver`; because
  `V` is evaluated on `carried ∪ {p}`, the shaper's marginal multiplier is already inside
  `U_collect`. No new formula.
- **Guards (§6.2).** (1) A tier `m(k)` stays dormant until ≥ `k` carried (no carry cap). (2) Expiry
  floor: never hold a stack until a carried parcel decays to 0; force its delivery regardless of the
  bonus.

Both agents read `m`/`g` from their `TeamMissionView`, so the shaper steers the whole team.

---

## 7. Hard constraints (§7)

Two flavours, both collapsing into existing machinery — **no special resolver**.

### 7.1 Priced constraint → A\* edge toll

`cost(enter t) = c_tick + toll(t)` where `c_tick = ρ·|{i ∈ S : R_now(i) > 0}| + ū_forgone`. Without
`ū_forgone`, an empty-handed agent has `c_tick ≈ 0` and A\* would take an arbitrarily long detour to
dodge any toll. The toll is a **point** penalty, not ticks:

- A\* uses `c_tick + toll` to **choose** the path, but returns the chosen path's pure tick length
  `L` and its `tollSum` as **separate** numbers (§7.1b — `V`'s decay math needs real ticks).
- The toll subtracts from the numerator of the rate utility:
  `U_deliver = (V(S*, z*, L) − tollSum) / (L+1)^α`. Tolls load onto **every** planned leg
  (`U_collect` cycle, exploration, future contract legs), not just the delivery run (§7.1a).
- Emergent: a recurring toll makes the agent batch deliveries to amortise it (§7.1 worked example
  — straight = −20 reject, detour = +24 take, amortise on a fat bundle = +20 pay once).

### 7.2 Absolute constraint → `value(S)` filter

`value(S) = 0 if S violates the filter, else m(|S|)·Σ r_i`. The subset optimizer never assembles a
forfeiting bundle; a zero-value zone drops from `reachableDeliveries`. No new code path.

### 7.3 The one explicit decision (no clarification allowed)

"Deliver parcels with score >10 → no reward" — does one bad parcel void the **whole** `putDown` or
just that parcel? Cannot ask. **Bias to the worst case** (whole bundle voided). Asymmetric caution:
the conservative reading costs a little efficiency; the optimistic reading risks zeroing a real
delivery, which is unrecoverable open-loop.

---

## 8. Implementation phases

Each phase ends green and shippable.

**Phase 1 — U_mission core (coordinate intention).** No replication, no shapers.
- `rate-tracker.ts`; `mission-intention.ts`; `intentions.ts` mission variant + `matches`; params;
  `loop.ts` builds the candidate (Liaison) and `act()` steps toward `targetTile`, superseding on
  arrival.
- **Done when:** the Liaison diverts to a +payoff coordinate tile when `U_mission` beats
  route/explore, and ignores it below the floor / when unreachable / when payoff ≤ 0.

**Phase 2 — shapers (§6), team-wide.** Adds the replication path (reused by Phase 3).
- `view.ts`; a2a `mission` message + relay passthrough + Liaison broadcast / Courier ingest;
  `shapers.ts`; real subset argmax + expiry floor in `utility.ts`; loop threads `m`/`g`.
- **Done when:** a `REWARD_SHAPER` measurably changes subset choice (drop-3-hold-1 on ×2) and zone
  choice (route to the 5× zone) on **both** agents.

**Phase 3 — constraints (§7), team-wide.** Reuses Phase-2 replication; only part touching A\*.
- `constraints.ts`; `astar.ts` tolls + separate `tollSum` + `c_tick`; subtract `tollSum` from
  `U_deliver`/`U_collect` numerator; apply absolute filter in `bestSubset` and zone.
- **Done when:** the priced tile is detoured/amortised per the §7.1 worked example; the absolute
  filter never assembles a forfeiting bundle; both agents honor it.

---

## 9. Testing strategy

Mirrors the existing `bun:test` suite (tests in `tests/`, `.js` imports). Pure functions tested
directly with fakes; loop integration via a fake `DeliverooClient` + scripted snapshots (the
`tests/bdi-*.test.ts` pattern).

**Phase 1:**
- `tests/rate-tracker.test.ts` — bootstrap default when empty; mean (`ū_forgone`) and 90th-pct
  (`ρ_ref`) over samples; window evicts old samples.
- `tests/mission-intention.test.ts` — positive reachable → finite `u`; unreachable → `null`
  (P_feasible 0); payoff ≤ 0 → not selected; below `P_FEASIBLE_MIN` → `null`; deadline urgency
  (`s_m → 0` raises `u`); ceiling clamps a huge hallucinated payoff to `c·ρ_ref`; no deadline →
  shadow term vanishes.
- `tests/bdi-intentions.test.ts` (extend) — `matches` mission-identity case; `select` picks the
  mission when it dominates and keeps it under hysteresis.

**Phase 2:**
- `tests/mission-shapers.test.ts` — count/zone builders map correctly, identity off-map; `bestSubset`
  drop-3-hold-1 (×2), never the penalised count (m(5)=0.3), respects the expiry floor.
- `tests/mission-view.test.ts` — `set`/`current`/accessors; identity when null.
- `tests/mission-replication.test.ts` — Liaison broadcast → relay → Courier `view.set`; teardown
  clears; payload guard rejects garbage.
- A `utility` subset-argmax test replacing the deferred-stub assumption.

**Phase 3:**
- `tests/astar-tolls.test.ts` — toll raises node cost; `tollSum` returned separate from `L`; detour
  chosen when toll > bundle gain; `c_tick` keeps an empty-handed agent from over-detouring.
- `tests/mission-constraints.test.ts` — absolute filter voids the whole bundle (worst-case §7.3);
  g=0 zone drops from `reachableDeliveries`.
- Loop integration golden test: the §7.1 worked example (straight = −20 / detour = +24 /
  amortise = +20).

**Cross-cutting:** extend the structural guard — `mission/{view,shapers,constraints}.ts` import
nothing from `bdi/loop`; `rate-tracker` does no LLM/IO. Run full `bun test` + `bunx tsc --noEmit`
green at each phase boundary.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| A non-identity shaper accidentally leaks into base play (no mission). | `TeamMissionView` returns identity/empty when `current()` is null; a regression test asserts base-play utilities are unchanged with no mission. |
| Toll folded into `L` corrupts decay math downstream. | A\* returns `tollSum` strictly separate from `L`; `astar-tolls.test.ts` asserts `L` is the pure tick count. |
| Mission replication races base belief sync. | Separate a2a `type:'mission'` channel; last-write-wins; the Courier never authors a mission, so no conflict. |
| `P_FEASIBLE_MIN` low-utility lingering churns hysteresis. | `uMission` returns `null` (eviction), not a small positive `u`. |
| Rate tracker cold-start gives a meaningless ceiling/toll rate. | Bootstrap default until enough samples; `c·ρ_ref` ceiling only bites on implausibly high rates, so a conservative bootstrap is safe. |
