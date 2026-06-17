# Mission → Contract Bridge — Design Spec

**Date:** 2026-06-17
**Status:** Approved (brainstorming) — pending writing-plans
**DESIGN.md anchors:** §2.1 (Liaison/Courier asymmetry), §4 (mission taxonomy), §8 (coordination contracts), §8.3 (HANDOFF), §8.4 (RENDEZVOUS), §8.5 (SYNC_GATE), §8.6 (liveness — *out of scope here*), §9.3 (role bid, "bound once"), §9.10 (mission/contract lock precedence).

## Problem

The mission lane (§4) and the contract lane (§8) are both fully built and **disconnected**. A `COORDINATION_CONTRACT` mission compiles and lands in the slot, but nothing turns it into a `Contract` and calls `ContractRuntime.propose`. The factories (`handoffContract`, `rendezvousContract`, `bindHandoff`) have **zero production callers** — they fire only in tests. This spec builds the single seam — *the bridge* — that classifies an installed `COORDINATION_CONTRACT` mission, binds it from live state, role-bids, and proposes the resulting contract.

§9.10 frames missions and contracts as **one slot, not two subsystems**: a contract *is* a `kind=COORDINATION_CONTRACT` mission. The bridge is the function that realises that framing.

## Scope

**In (one spec, all three contract types — explicit user decision):** a generic bridge spine + three per-type adapters, designed for isolation so the three risk surfaces stay decoupled inside one document.

- **HANDOFF** — all downstream machinery already merged (ACTION steps, `bindHandoff`, §9.10 MISSION-lock); adapter = pure selection + binding.
- **RENDEZVOUS** — factory merged; adapter adds a coordinate-free target binder.
- **SYNC_GATE** — entire §8.5 subsystem new: `syncGateContract` factory, a `'gated'` `advance` outcome, gate flag + freshness fail-safe, a dedicated `type:'gate'` a2a channel, gate scoping, partner-loss teardown.

**Out (documented follow-on hooks, not defects):**
- **Adoption gating (§8.6):** `payoff > combined forgone base utility`. The bridge proposes **unconditionally**; gating is a one-time proposer decision belonging to the lifecycle-hardening slice.
- **Barrier deadlines → FAILED / commit-timeout → ABORTED (§8.6):** lifecycle slice. The bridge does not re-bind or abort a *live* contract; it only builds + proposes.
- **`PARITY_ROW` staging goal (§8.5 "odd row"):** flavor, not requirement — SYNC_GATE stages at a bound zone like RENDEZVOUS. Parity staging is a later refinement.
- **LLM predicate-driven parcel selection:** the compiler schema is unchanged; handoff parcel selection is runtime-only (highest reward).

## Architecture

### The spine (Liaison-only — §2.1: only the Liaison compiles & proposes)

```
LLM say ─▶ intake ─▶ compile ─▶ Mission{ kind:COORDINATION_CONTRACT,
                                          contractType, payoff, deadline,
                                          params.targetTile? (TEXT_BOUND) }
   ─▶ slot.install ─▶ onChange ─▶ view.set(m) + broadcast type:'mission'
```

Then, **deferred in the loop** — each Liaison tick:

```
if  view.current() is COORDINATION_CONTRACT
and contracts.current() is null            // no contract built/proposed yet
and role === 'liaison':                    // proposer only
        c = buildContract(mission, grid, beliefs, partner, me)   // bridge.ts, pure
        if c !== null:  contracts.propose(c) ─▶ send(type:'contract')
        else:           hold (retry next tick — parcel unperceived / unbindable)
```

**Why deferred, not at install.** The LLM is coordinate-free; binding needs live state (parcel position, both agents' positions) that does not exist at `slot.install`. `buildContract` returns `null` to mean *not yet / cannot bind*; the loop's natural per-tick re-entry **is** the retry loop.

**No new state container.** "Pending contract" is *derived*: `(view has a COORDINATION_CONTRACT mission) ∧ (ContractRuntime slot empty)`. Once `propose` fills the slot the predicate goes false and binding stops — idempotent by construction.

**Roles bound once (§9.3 / §9.10).** For HANDOFF, the Liaison computes `picker = argmin Manhattan(agent, parcel)`, `deliverer = other`, id tie-break, inside `buildContract`, and freezes them into the proposed `Contract` (`lockOwner`/step `agent`s). The full bound contract ships in `propose`; the Courier never recomputes. RENDEZVOUS is symmetric (no roles); SYNC_GATE roles are Liaison=gate-source.

**Teardown** reuses merged machinery: `onSatisfied → missionSlot.supersede()` clears the slot; the §9.10 producer releases MISSION locks the tick no contract is active. HANDOFF/RENDEZVOUS add nothing; SYNC_GATE adds gate-clear (below).

### Module boundaries

| Unit | Purpose | Depends on |
|---|---|---|
| `bridge.ts` (new) | pure `(mission, grid, beliefs, me, partner) → Contract \| null` | `contract.ts` factories, belief/grid types |
| `contract.ts` (modify) | `syncGateContract`, `'gated'` action, `advance` SYNC_GATE branch, `GateState`+methods, `GateMsg`/`isGateMsg` | types only (pure) |
| `loop.ts` (modify) | Liaison bind+propose call; `'gated'` fall-through + move-gate; partner-loss abort | bridge, contract |
| `liaison.ts` / `courier.ts` (modify) | route `type:'gate'`; Liaison wires injectable external gate source | contract runtime |

Each unit is independently testable: `bridge.ts` is pure; gate logic on `ContractRuntime` is pure-state; the loop wiring is the only side-effecting seam.

## Adapter detail

### HANDOFF

`buildContract` on `contractType === 'HANDOFF'`:

1. `selectHandoffParcel(beliefs)` — filter to *free* parcels (`carriedBy == null`, not in any claim, `rewardSeen > 0`); `argmax rewardSeen`, id tie-break. None → `null` (hold).
2. `bindHandoff(grid, parcelPos)` → `HandoffTiles | null`. Null → `null` (hold; a better-placed parcel may appear).
3. `bindRoles(parcelPos, tiles.delivery, selfPos, partnerPos)` → `picker = argmin Manhattan(·, parcel)`, `deliverer = other`, id tie-break.
4. `handoffContract(id, parcelId, picker, deliverer, tiles, payoff, deadline)` → propose.

`id = ${missionId}:handoff` — deterministic, both replicas name it identically. Downstream (ACTION execution, MISSION-lock on `lockParcels`, teardown release) **already merged**. A parcel vanishing between propose and pickup is the lifecycle slice's abort path, not the bridge's concern.

### RENDEZVOUS

`contractType === 'RENDEZVOUS'`:

1. `rendezvousTarget(mission, grid)` — `params.targetTile` is `TEXT_BOUND` → use `{x,y}`. Else → delivery zone nearest the map centroid (deterministic landmark). No zones + no TEXT_BOUND → `null` (decline).
2. `radius` — from mission params if transcribed, else `RENDEZVOUS_RADIUS` default (3, §8.4).
3. `rendezvousContract(id, target, radius, payoff, deadline)` → propose.

No parcel, no MISSION-lock, no roles — cannot contend with the auction; rides positional barriers only.

### SYNC_GATE

**Structural mismatch (deliberate).** RENDEZVOUS/HANDOFF terminate (`advance → 'done'`). SYNC_GATE is **perpetual** (§8.5 "loops until mission replaced") and wants base play *during green windows* — inverting the merged "ACTIVE contract preempts base play" rule. So it is a **staging barrier + a movement overlay**, not a pure short-circuit.

**Contract shape (`syncGateContract`):** staging reuses the RENDEZVOUS pattern — `LOCAL(liaison, IN_ZONE target)` + `LOCAL(courier, IN_ZONE target)` + `BARRIER`; target bound exactly like RENDEZVOUS.

**New `advance` outcome:** for `type === 'SYNC_GATE'`, once the staging barrier releases, `advance` returns `{ kind: 'gated' }` (instead of `'done'`).

**Loop ripple (touches merged short-circuit):**
- `'navigate'/'post'/'block'` → unchanged short-circuit (staging preempts base play).
- `'gated'` → do **not** return; fall through to normal base play with the **move-gate armed**: a `move` this tick is allowed only if `gateOpen(now)`; else hold position.

**Gate state** (on `ContractRuntime`, lifetime = contract):
- `GateState { state: 'OPEN' | 'CLOSED'; heartbeat: tick }`, default `OPEN`.
- `gateOpen(now) = state === 'OPEN' && now - heartbeat <= GATE_STALE_TTL` — **stale ⇒ CLOSED** (§8.5 fail-safe: defaults to *stopping* under uncertainty).
- Cleared (`OPEN`, disarmed) on teardown.

**Dedicated `type:'gate'` a2a channel** (separate from `'contract'`): message `{ id, state, tick }`. The Liaison's external red/green source (injectable — tests drive it; the red/green *origin* is the server, the a2a channel is the liaison→courier propagation + heartbeat leg) → `setGate` locally **and** broadcast on `'gate'` → Courier `applyGate`. Both entrypoints route `type:'gate'` into the runtime via `isGateMsg`.

**Gate scoping (§8.5):** the freshness fail-safe is armed **only while a SYNC_GATE contract is ACTIVE**. No SYNC_GATE → gate ignored, agents move freely (a dead Liaison must not freeze base play).

**Partner-loss teardown (§8.5):** partner liveness (staleness of the partner's a2a signal, same clock as `GATE_STALE_TTL`) failing → abort SYNC_GATE (`Active → Failed`) → clear gate `OPEN` → disarm → survivor resumes full base play. Reuse an existing partner-liveness signal if one exists; else add a minimal `lastPartnerSeen` tick.

## Error handling

Guiding rule: **bind-failure is never fatal.**

- `buildContract → null` at any step → loop holds, retries next tick. No throw; `debug` log only.
- Malformed `'gate'` payload → dropped by `isGateMsg` guard (mirrors `isContractMsg`).
- Partner-loss (staging or gated) → uniform `Active → Failed` teardown.
- Adoption gating absent → propose unconditionally (documented hook).

## Testing

Bun, pure-first. Existing suite must stay green (bridge inert unless a COORDINATION_CONTRACT mission sits in the view).

| Test file | Covers |
|---|---|
| `tests/bridge-handoff.test.ts` | `selectHandoffParcel` (free/reward/tie-break), `bindRoles`, `buildContract` HANDOFF → `Contract` + null-holds |
| `tests/bridge-rendezvous.test.ts` | `rendezvousTarget` (TEXT_BOUND vs central zone vs null), radius default |
| `tests/bridge-syncgate.test.ts` | `syncGateContract` shape; `advance` returns `'gated'` post-barrier; `gateOpen` freshness/stale-CLOSED; scoping off when no SYNC_GATE |
| `tests/contract-syncgate.test.ts` | gate channel `setGate`/`applyGate`/`isGateMsg`; teardown clears gate→OPEN |
| `tests/bdi-loop-bridge.test.ts` | Liaison loop: COORD mission + perceived parcel → propose sent; null-bind → holds; non-liaison never proposes; `'gated'` arms move-gate (CLOSED ⇒ no move) |
| `tests/contract-handoff-e2e.test.ts` (extend) | full mission → bridge → handoff → SATISFIED, driven from a `COORDINATION_CONTRACT` mission, not a direct factory call |

## Done when

A `COORDINATION_CONTRACT` mission of each `contractType`, compiled into the Liaison's slot, is bound from live state and proposed over the `'contract'` channel; HANDOFF and RENDEZVOUS drive both loops to `SATISFIED`; SYNC_GATE stages both agents then governs base-play movement via the gate flag (stale ⇒ CLOSED) and tears down on partner loss, clearing the gate. Base play is byte-for-byte unchanged when no COORDINATION_CONTRACT mission is active (`bun test tests/` stays green).

## Follow-on (not this spec)

1. **Lifecycle hardening (§8.6):** adoption gating, barrier deadlines → FAILED, commit-timeout → ABORTED, abort handler refreshing carried-parcel beliefs (the merged `rewardSeen=0` review TODO). Reconcile contract with the single slot.
2. **`PARITY_ROW` staging goal (§8.5):** map-aware `navTarget` for the literal "odd row" sync-gate.
3. **The four review-surfaced handoff TODOs** (auction-claim release on contract pickup, same-tick re-lock race, `rewardSeen=0` synthetic belief on abort, `bindHandoff` vacate/approach mutual blocking) — addressed when their triggering code path (bridge / abort) lands.
