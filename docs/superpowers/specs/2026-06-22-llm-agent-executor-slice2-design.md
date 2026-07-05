# §18 LLM-agent back-end — Slice 2 (step-list executor) design

**Date:** 2026-06-22
**Source of truth:** DESIGN.md §18, §17.7 (plan lifecycle), §9.9 (execution selector), §15 (push-aware A\*).
**Status:** approved for implementation planning.
**Builds on:** Slice 1 (`2026-06-22-llm-agent-backend-design.md`) — compile + score, merged to `main`.

## Goal

Make a compiled `AGENT_PLAN` actually run. Slice 1 lands a costed plan as a
`U_mission` candidate in the per-tick argmax, but nothing executes its steps:
the `act()` mission branch reads only `params.targetTile` (the
`CANDIDATE_INTENTION` shape), so an `AGENT_PLAN` that wins the argmax takes no
action. Slice 2 adds a tick-by-tick step-list executor on the Liaison's
`BdiLoop`, with the full §17.7 plan lifecycle (prefix re-validation, born-stale
watcher, anti-phantom suppression, K_block masked re-plan) and off-loop
re-planning on invalidation.

**Done when:** an `AGENT_PLAN` that wins the argmax is driven step-by-step
(goto → route, pickup/deliver → act when adjacent, wait → count down, advance
pointer) to completion (`onSatisfied`); a step that goes invalid, a born-stale
signature change, or K_block consecutive blocks triggers an off-loop re-plan;
and an unproductive plan is suppressed by the anti-phantom guard. The QUERY path
and the typed `OFF` path are untouched.

## Scope

### In slice 2
- `PlanCursor` execution state + pure lifecycle helpers (`src/mission/agent/executor.ts`).
- `BdiLoop.actAgentPlan()` driving the committed `AGENT_PLAN` one step per tick,
  reusing the existing `stepToward` / `doPickup` / `doDeliver` primitives.
- Full §17.7 lifecycle: per-tick prefix re-validation, born-stale watcher,
  anti-phantom suppression, K_block masked re-plan.
- Off-loop re-planning on invalidation / K_block / born-stale, routed through the
  existing single-flight intake (re-submit `Mission.rawText`); abort/supersede of
  the in-flight compile is inherited (§17.7.1 SUPERSEDED).
- Masked-tile threading: K_block re-plan marks the blocking tile as an obstacle
  in the snapshot grid handed to `reactPlan` / `costPlan`.
- Suppression gate in `uMission` (`suppressedUntil > tnow` ⇒ candidate withheld).
- New params (offline-calibrated, §16): `kblock_max`, `antiphantom_n`, `suppress_ticks`.

### Out of slice 2 (later slices)
- Multi-agent assignment of an `AGENT_PLAN` (bid/lock §9.10): the plan stays
  Liaison-local — not broadcast to the Courier — so there is no contest.
- Strategy hooks family (§6/§7): `set_reward_shaper`, `add_constraint`,
  `set_zone_value`, `clear_policy`.
- Coordination family (§8): `message_partner`, `claim_parcel`, `propose_contract`.
- PDDL back-end (§17) — switch value still throws.
- Slice-1 known follow-ups out of scope here unless they block the executor:
  `cost.ts` multi-zone valuation, `cost.ts` ignoring `snap.carried`, `route_cost`
  registration, unread `max_iters_query`/`batch_max`.

## Architecture

New module `src/mission/agent/executor.ts` (pure lifecycle state + helpers),
consumed by `BdiLoop` the same way `actContract` consumes the contract runtime.

```
src/mission/agent/
  executor.ts    PlanCursor state + pure helpers: revalidateStep, progressed, nextCursor, freshCursor
```

Edits to existing files:
- `src/bdi/loop.ts` — add `planCursor` field; add `actAgentPlan()`; dispatch to it
  from the `act()` `kind:'mission'` branch when `mission.kind === 'AGENT_PLAN'`;
  reset the cursor when the mission slot id changes; call `requestReplan` on
  invalidation. Add `requestReplan` to the loop's mission deps.
- `src/bdi/mission-intention.ts` — `uMission` AGENT_PLAN branch returns `null`
  while `mission.suppressedUntil > tnow`.
- `src/bdi/params.ts` — add `kblock_max`, `antiphantom_n`, `suppress_ticks` to the
  interface, `DEFAULT_PARAMS`, and `RANGES` (three-place invariant).
- `src/mission/kinds.ts` — add optional `suppressedUntil?: number` to the plan-bearing
  Mission shape (mutated by the executor when the anti-phantom guard fires).
- `src/mission/agent/wire.ts` + `snapshot.ts` — optional `maskTiles` threaded into
  `snapshotFromBeliefs` → snapshot grid obstacles for the K_block re-plan.
- `src/agents/liaison.ts` — wire `requestReplan(rawText, maskTiles?)` to a re-plan
  entry that re-submits `rawText` through the single-flight intake.

### PlanCursor

```
interface PlanCursor {
  missionId: string        // identity — reset the cursor when the slot id changes
  ptr: number              // index of the current step
  sigAtLanding: string     // belief-signature when the plan landed (born-stale watcher §17.7.2-B)
  ticksNoProgress: number  // anti-phantom counter (§17.7.4)
  blockedCount: number     // consecutive blocked ticks (K_block)
  lastL: number            // residual tick-length last tick (progress = L decreased)
}
```

`suppressedUntil` lives on the Mission (it must outlive a null'd cursor so the
scoring gate keeps holding the branch out of the argmax).

**Born-stale signature — exclude what the plan mutates (§17.8, DESIGN ~L1488).**
The slice-1 `beliefSignature(parcels, selfPos)` includes `selfPos`; used as a
per-tick watcher it would change on every `goto` (self moves) and re-plan every
tick. The watcher therefore uses a separate `worldSignature(snap, plan)` that
**excludes the facts the plan itself mutates**: own position, and the mutable
state of the parcels the plan references in its `pickup`/`deliver` steps (those
parcels' validity is tracked per-step by `revalidateStep` instead). It signs the
world *outside* the plan — new parcels appearing, a non-target parcel vanishing,
an enemy shift — i.e. genuine staleness the step check would miss. The slice-1
`beliefSignature` stays as-is for the compile-window landing check in `wire.ts`
(self has not moved yet there).

Pure helpers (unit-testable without a loop):
- `freshCursor(mission, sigAtLanding): PlanCursor` — ptr 0, counters 0, `lastL = plan.L`.
- `worldSignature(snap, plan): string` — stable signature over parcels NOT
  referenced by the plan's steps, ignoring `selfPos` (born-stale watcher).
- `revalidateStep(step, snap, grid): 'ok' | 'invalid'` — per §17.7.2-D:
  - `goto(target)` → invalid if `planPath` reports unreachable.
  - `pickup(parcelId)` → invalid if the parcel is absent, carried by another, or
    no longer at its expected tile.
  - `deliver(zone)` → invalid if `zone` is no longer a delivery tile (static grid ⇒
    practically always ok; checked for completeness).
  - `wait(n)` → always ok.
- `progressed(prevL, curL, ptrAdvanced): boolean` — `ptrAdvanced || curL < prevL`
  (leg-granularity progress, §17.7.4: shrinking distance to the next waypoint counts).

## Components

### executor.ts — lifecycle state + helpers
Pure functions over snapshot + grid; no I/O, no client calls. The loop owns the
`PlanCursor` instance and the side-effecting moves; this module owns the decisions.

### BdiLoop.actAgentPlan — per-tick driver

A fresh per-tick `WorldSnapshot` is built from the live beliefs via the existing
`snapshotFromBeliefs` (O(parcels), off the LLM path); both `revalidateStep` and
the born-stale signature read this one snapshot, so there is a single consistent
source per tick.

```
actAgentPlan(mission, beliefs, ctx, tnow):
  snap = snapshotFromBeliefs(beliefs, grid.deliveryZones, tnow)  # one consistent per-tick source
  sigNow = worldSignature(snap, mission.plan)                    # excludes self + plan-target parcels
  if planCursor === null or planCursor.missionId !== mission.id:
       planCursor = freshCursor(mission, sigNow)                 # first landing (§17.7.2-B)
  step = mission.plan.steps[planCursor.ptr]
  if sigNow !== planCursor.sigAtLanding or revalidateStep(step, snap, grid) === 'invalid':
       planCursor = null
       requestReplan(mission.rawText)                            # off-loop, single-flight
       return                                                    # no plan action this tick
  ptrAdvanced = false
  switch step.op:
     goto:    dir = stepToward(goal=step.target); if dir === 'blocked' blockedCount++
     pickup:  if adjacent/on parcel: doPickup(); ptr++; ptrAdvanced = true
              else stepToward(parcelPos)
     deliver: if on zone: doDeliver(zone); ptr++; ptrAdvanced = true
              else stepToward(zone)
     wait:    step.n--; if step.n <= 0 { ptr++; ptrAdvanced = true }
  curL = residualL(mission.plan, planCursor.ptr, beliefs)        # ticks left over remaining steps
  if progressed(planCursor.lastL, curL, ptrAdvanced):
       ticksNoProgress = 0; blockedCount = 0
  else ticksNoProgress++
  planCursor.lastL = curL
  if blockedCount >= params.kblock_max:
       planCursor = null; requestReplan(mission.rawText, maskTiles=[tileAhead])   # §17.7.4
  else if ticksNoProgress >= params.antiphantom_n:
       mission.suppressedUntil = tnow + params.suppress_ticks; planCursor = null  # §17.7.4
  else if planCursor.ptr >= mission.plan.steps.length:
       onSatisfied()                                             # plan complete
```

`residualL` re-uses the shared push-aware `planPath` over the remaining `goto`
legs — same estimator as `cost.ts` (§18.5/§15), so progress is measured in the
same tick unit the plan was costed in.

### Re-plan boundary (loop → mission lane)
The loop calls `requestReplan(rawText, maskTiles?)`; the Liaison wires it to a
re-plan entry that re-submits `rawText` through the single-flight intake. The
intake already serialises compiles, so a re-plan aborts/supersedes any in-flight
one (§17.7.1). `maskTiles` is carried into `snapshotFromBeliefs`, which marks
those tiles as obstacles in the snapshot grid passed to `reactPlan`/`costPlan`;
absent `maskTiles`, behaviour is identical to slice 1.

### Scoring gate (uMission)
The AGENT_PLAN branch of `uMission` returns `null` while
`mission.suppressedUntil !== undefined && mission.suppressedUntil > tnow` — the
branch leaves the argmax without churning §5.6 commitment hysteresis (same
null-vs-low-u distinction slice 1 established). When `tnow` passes
`suppressedUntil`, the branch re-enters the argmax and a fresh cursor lands.

## Data flow

```
plan lands (slice-1 path) → installed Liaison-local in mission slot
per tick, AGENT_PLAN wins argmax:
  actAgentPlan:
    born-stale OR step invalid  -> null cursor + requestReplan(rawText)        -> off-loop re-plan
    K_block reached             -> null cursor + requestReplan(rawText, [tileAhead])
    anti-phantom reached        -> mission.suppressedUntil = tnow + suppress_ticks; null cursor
    else                        -> execute step (stepToward / doPickup / doDeliver / wait), advance ptr
    ptr == steps.length         -> onSatisfied()  -> slot superseded -> base play resumes
requestReplan(rawText, maskTiles?) -> single-flight intake -> reactPlan(fresh snapshot[+mask]) -> new AGENT_PLAN or discard
```

## Error handling

| Case | Outcome |
|---|---|
| step invalid (parcel gone / carried by other / zone not delivery) | null cursor → re-plan (`rawText`) |
| path blocked `kblock_max` consecutive ticks | re-plan with the tile ahead masked (§17.7.4) |
| born-stale: belief-signature changed vs landing | re-plan from a fresh snapshot (§17.7.2-B) |
| anti-phantom: `antiphantom_n` ticks without progress | suppress the branch `suppress_ticks`, free the cursor (§17.7.4) |
| re-plan `reactPlan` returns discard | slot superseded → base play continues (R8) |
| deadline passes mid-execution | `uMission` already returns null (§4.3) → branch leaves the argmax; cursor reset on next slot change |
| `LlmError` during re-plan (hardened `llm.ts`) | discard mission; base play continues (R8) |

No clarification questions (R13). Open-loop: no payoff confirmation; conservative
compilation is the only safeguard (§18.1).

## Constants

New `params.ts` entries, fixed offline (§16); only `kblock_max` is pinned by DESIGN:
- `kblock_max = 5` (DESIGN §17.7.4 — `K_block = 5 consecutive blocked retries`).
- `antiphantom_n = 8` (consecutive no-progress ticks before suppression — placeholder, calibratable).
- `suppress_ticks = 20` (branch suppression duration — placeholder, calibratable).

## Testing

Mirror the existing suite (`tests/mission-compiler.test.ts`, slice-1 agent tests):
- `executor.test.ts`:
  - `revalidateStep` ok/invalid for every op (goto unreachable, pickup gone /
    carried-by-other / moved, deliver non-zone, wait).
  - `freshCursor` initial state; `progressed` true on ptr advance and on `L`
    decrease, false otherwise.
  - K_block: `kblock_max` consecutive blocks flips to re-plan intent.
  - anti-phantom: `antiphantom_n` no-progress ticks sets `suppressedUntil`.
  - `worldSignature`: stable across self-move and across pickup/deliver of a
    plan-target parcel (no self-invalidation); changes when a non-target parcel
    appears/vanishes.
  - born-stale: `worldSignature` change vs `sigAtLanding` flags re-plan.
- loop integration (scripted ChatFn + fixture grid): AGENT_PLAN installed →
  simulated ticks → assert move/pickup/deliver sequence and `onSatisfied` at end.
- re-plan: invalidation mid-plan asserts `requestReplan` called with `rawText`
  (and `maskTiles` on the K_block path).
- `uMission`: `suppressedUntil > tnow` ⇒ candidate withheld (null); `suppressedUntil`
  in the past ⇒ candidate present.
- snapshot/wire: `maskTiles` marks the tiles as obstacles in the snapshot grid;
  empty/absent `maskTiles` is byte-for-byte the slice-1 snapshot.

## Invariants preserved (§18.1)

1. One decision point — the §9.9 argmax; the executor only drives the step of an
   already-selected `AGENT_PLAN`, it does not add a selector.
2. The utility core is untouched — the suppression gate is a `null` return, the
   same mechanism slice 1 used for non-candidacy.
3. Open-loop — no payoff confirmation; re-plan re-derives from beliefs, never from
   a reward signal.
4. No clarification questions — invalidation re-plans or discards, never asks.
5. The BDI loop never blocks — re-planning runs off the 50 ms loop via the intake;
   the executor only ever emits one move per tick.
6. LLM-agent is a back-end, not a replacement — the `OFF` typed path stays available.
7. The LLM acts only through the tool registry — the executor drives the LLM's
   already-emitted steps through the shared A\* and the existing move primitives;
   it never lets the LLM touch the grid or the wire directly.
