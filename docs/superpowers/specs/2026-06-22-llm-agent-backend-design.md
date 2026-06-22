# §18 LLM-agent back-end — Slice 1 (vertical) design

**Date:** 2026-06-22
**Source of truth:** DESIGN.md §18 (LLM-agent back-end), §4.4, §5.5, §17.7.
**Status:** approved for implementation planning.

## Goal

Deliver the first vertical slice of the §18 LLM-agent back-end: a natural-language
mission, under the `LLM_AGENT` switch, is handled by an autonomous off-loop ReAct
loop that either answers (atomic L1) or emits a step-list, which is costed by the
shared push-aware A\* into `L`, valued by the kernel into `V_plan`, and reintegrated
into the existing `U_mission` selector candidate (`θ_llm` / `c_llm`). Zero LLM work
on the 50 ms BDI tick path.

**Done when:** a mission routed to `LLM_AGENT` executes end-to-end — answer posted for
a QUERY, or a step-list plan scored in the per-tick argmax and executed by the BDI
runtime — with the typed-utility path (`OFF`) untouched.

## Scope

### In slice 1
- Autonomous §18 lane (decision B): the ReAct loop classifies, answers, and plans on
  its own. `compile()` is **not** reused — it remains the `OFF` typed path.
- Three of the five tool families: **Perception (read)**, **World actions (steps)**,
  **Free-form** (`calculate`, `answer`, `emit_plan`).
- payoff/deadline come from a terminal `emit_plan(payoff, deadline, steps[])` tool
  (decision: no shared Call-1). `answer(text)` is the QUERY terminal.
- Frozen `WorldSnapshot` at t0 + deterministic egocentric forward-apply.
- Static three-way switch `OFF | LLM_AGENT | PDDL` (PDDL throws "not implemented").
- Reintegration into `U_mission` with `θ_llm`, `c_llm`, binary `P_feasible`.
- Minimal born-stale guard: one freshness re-check at landing.

### Out of slice 1 (later slices)
- Strategy hooks family (§6/§7): `set_reward_shaper`, `add_constraint`,
  `set_zone_value`, `clear_policy`.
- Coordination family (§8): `message_partner`, `claim_parcel`, `propose_contract`.
- Full §17.7 lifecycle (prefix re-validation, invalidation, anti-phantom guard,
  suppression counters). Slice 1 ships only the single landing freshness check.
- PDDL back-end (§17) — switch value stubbed.

## Architecture

New module `src/mission/agent/` (autonomous lane, separate from `compiler.ts`):

```
src/mission/agent/
  loop.ts        reactPlan(): bounded ReAct off-loop, native function-calling (ChatFn)
  snapshot.ts    WorldSnapshot frozen from BeliefBase at t0 + forward-apply
  tools.ts       slice-1 registry: perception(read) + world-actions + answer + calculate + emit_plan
  cost.ts        cost step-list via planPath (sum legs -> L) + V_plan via kernel vValue
```

Edits to existing files:
- `src/types/config.ts` — add `MISSION_HANDLER: 'OFF' | 'LLM_AGENT' | 'PDDL'` (default `OFF`).
- `src/agents/liaison.ts` — dispatch on the switch.
- `src/bdi/mission-intention.ts` + `src/bdi/params.ts` — extend `uMission` for a
  plan-bearing mission (multi-step `L`, `V_plan`, `θ_llm`, `c_llm`).
- `src/mission/kinds.ts` — add the `AgentPlan` / plan-bearing Mission shape
  (`deadline` already exists).

### Switch dispatch (in liaison)

```
onMissionMsg(text):
  OFF        -> compile(text)                    # current typed path, unchanged
  LLM_AGENT  -> reactPlan(text, snapshot, chat)  # new §18 lane
  PDDL       -> throw 'not implemented (future slice)'
```

The switch is runtime policy read from config; the LLM knows nothing of it (§18.2).

## Components

### loop.ts — ReAct engine
- Signature: `reactPlan(text, snapshot, chat, params)`
  → `{ kind: 'plan', mission } | { kind: 'query', answer } | { kind: 'discard', reason }`.
- scratchpad = `[system_prompt, mission_text, snapshot_brief]`; `temperature 0`.
- bounds: `MAX_ITERS = 12`, `MAX_ITERS_QUERY = 3`.
- Uses the hardened `ChatFn` (`{ calls: FunctionCall[] }`, see
  `src/mission/llm.ts`): read tools are **batchable** (`BATCH_MAX = 6`, resolved in
  one round-trip); action tools are **sequential** (each forward-applies, so step
  `n+1`'s observation depends on step `n`). No terminal in a turn with pending calls.
- Terminals: `emit_plan` (plan) or `answer` (QUERY).
- The system prompt sets the role, the tool protocol, the "for any arithmetic call
  `calculate`, never compute yourself" rule, and the conservative bias (ambiguous
  sign/hardness → constraint to avoid). A **symbolic** snapshot brief is injected —
  own position, zones, relevant parcels as POIs (id + reward), partner status — never
  the raw grid (§18.7). Few-shot examples cover L1 (answer) and a plan.

### snapshot.ts — frozen world + forward-apply
- `WorldSnapshot` cloned from `BeliefBase` at t0: `{ selfPos, parcels[], zones[],
  partner, grid }`.
- Read tools read the snapshot and return real observations (no latency, off-loop).
- Forward-apply (deterministic, egocentric, own effects only — enemies not modelled,
  consistent with the static-world assumption §17.7.4):
  - `goto(target)` → `selfPos = target`
  - `pickup(parcelId)` → parcel added to carried
  - `deliver(zone)` → carried parcels delivered at zone
  - `wait(n)` → no positional effect
- A later `get_my_position` returns the **simulated** position after the steps chosen
  so far.

### tools.ts — slice-1 registry

| Family | Tools | Effect |
|---|---|---|
| Perception (read) | `get_my_position`, `scan_world`, `get_parcel(id)`, `list_delivery_zones`, `route_cost(from,to)`, `get_partner_status` | read snapshot; batchable |
| World actions (steps) | `goto(target)`, `pickup(parcelId)`, `deliver(zone)`, `wait(n)` | recorded as step + forward-applied |
| Free-form | `calculate(expr)`, `answer(text)`, `emit_plan(payoff,deadline,steps[])` | exact arithmetic + terminals |

- `calculate` reuses the existing safe evaluator `src/mission/calc.ts` — no new
  evaluator.
- `route_cost(from,to)` calls `planPath` on the snapshot grid → same A\* as costing,
  so the LLM never computes geometry (§3.1); coordinates are transcribed-and-validated
  against the grid or returned by `route_cost`.
- `goto` is the plan step (a leg ≈ `TaskNav`), not `move(direction)`, so `L` comes out
  in the same tick unit as every typed mission.

### cost.ts — reintegration
- After `emit_plan`: sum the `goto` legs via `planPath` → `L` (ticks); compute
  `V_plan = vValue(deliveredParcels, zone, L, …)` from the kernel (`src/bdi/utility.ts`).
- Build a plan-bearing Mission carrying `{ payoff, deadline, L, V_plan }` precomputed.

### Scoring — uMission extension
- `value = payoff + V_plan` (currently payoff only with `V_plan = 0`).
- `θ = θ_llm` (set `mission.theta` to `params.theta_llm`).
- rate ceiling `c_llm · ρ_ref` (tighter than the global `c`).
- `P_feasible ∈ {1, 0}` from validity + grounding; all extra humility lives in
  `θ_llm` (no double-counting).
- `params.ts` additions: `theta_llm = 0.45`, `c_llm = 1.2`, `MAX_ITERS = 12`,
  `MAX_ITERS_QUERY = 3`, `BATCH_MAX = 6`.

## Data flow

```
onMissionMsg(text) [switch = LLM_AGENT]
  -> snapshot = freeze(BeliefBase)            # t0
  -> reactPlan(text, snapshot, chat)
       loop (<= MAX_ITERS, temp 0):
         read tools (batched)   -> observe snapshot
         action tools (seq)     -> record step + forward-apply
         calculate(expr)        -> exact arithmetic
         terminal:
           answer(text)         -> { kind: 'query', answer }   # DONE
           emit_plan(p,d,steps) -> { kind: 'plan', ... }
  -> cost.ts: sum goto legs via planPath -> L ; kernel vValue -> V_plan
  -> born-stale check: belief-signature changed vs t0?
        yes -> one re-plan from fresh snapshot; still stale -> discard
        no  -> proceed
  -> Mission { payoff, deadline, L, V_plan } -> mission slot
  -> uMission candidate (θ_llm, c_llm) in the per-tick argmax
  -> BDI runtime executes the step-list tick-by-tick
```

## Error handling

| Case | Outcome |
|---|---|
| coordinate unparseable / off-map | `P_feasible = 0` → discard |
| `MAX_ITERS` exhausted / no terminal | `RETRY = 1` (error fed back in prompt) → `PLAN_FAIL` discard |
| `emit_plan` with empty / invalid steps | discard |
| `LlmError` (timeout etc, from hardened `llm.ts`) | discard mission; base play continues (R8) |
| born-stale at landing (belief-signature changed vs t0) | one re-plan from fresh snapshot, else discard |

No clarification questions (R13): ambiguous / non-groundable → discarded. Open-loop:
no payoff confirmation; conservative compilation is the only safeguard (§18.1).

## Testing

Mirror the existing suite (e.g. `tests/mission-compiler.test.ts`):
- Scripted `ChatFn` replaying tool-call turns → assert `plan` / `query` / `discard`.
- `snapshot.ts`: unit tests for forward-apply (goto / pickup / deliver / wait →
  simulated state).
- `cost.ts`: `planPath` integration on a fixture grid → correct `L`.
- `uMission`: scoring with `θ_llm` / `c_llm` / `V_plan`.
- Switch dispatch: `OFF` → `compile`, `LLM_AGENT` → `reactPlan`, `PDDL` → throw.

## Invariants preserved (§18.1)

1. One decision point — the §9.9 argmax; the plan enters as the single `U_mission`
   candidate.
2. The utility core is untouched — the back-end adds an option, not a new selector.
3. Open-loop — no payoff confirmation.
4. No clarification questions.
5. The BDI loop never blocks — ReAct runs off the 50 ms loop; the selector reads only
   ready plans.
6. LLM-agent is a back-end, not a replacement — `OFF` typed path stays available.
7. The LLM acts only through the tool registry — never reads the raw grid, never
   computes geometry, never touches the a2a wire directly.
