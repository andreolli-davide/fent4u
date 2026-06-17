# Handoff Contract (§8.3) + MISSION-claim Producer (§9.10) — Design

**Date:** 2026-06-17
**Status:** approved (brainstorming → ready for writing-plans)
**DESIGN.md sections:** §8.1 (contract primitive), §8.3 (handoff template), §9.10 (mission/contract lock precedence)
**Builds on:** the rendezvous slice (`2026-06-17-coordination-contracts-rendezvous.md`), follow-on plan item #1.

## Goal

Implement the HANDOFF coordination contract ("+200 if a *different* agent delivers") and,
with it, the first producer of `origin:'MISSION'` parcel claims. The lock *consumers* already
exist and are complete (`ClaimStore.expire` / `dropForeignAuctionClaims` skip MISSION,
`rebalance.ts` skips MISSION, the auction pool excludes any claimed parcel); nothing emits a
MISSION claim yet (`ClaimOrigin` comment: "only AUCTION is created this slice"). This slice
adds the producer, so the lock mechanism becomes live end-to-end.

## Scope

In scope:
- `ACTION` step kind (atomic `pickUp`/`putDown` with explicit ids, self-navigating).
- `advance()` extension to execute ACTION steps + a terminal-condition fix.
- `actContract()` execution of pickup/putdown primitives.
- `handoffContract()` builder (the §8.3 step list) + `bindHandoff()` runtime tile binder.
- Loop-side MISSION-lock reconcile (the producer), released on teardown.
- Unit + two-loop e2e tests.

Out of scope (follow-on, per the rendezvous plan):
- LLM-compiler → `COORDINATION_CONTRACT` mission → contract bridge (#4).
- Lifecycle hardening: barrier deadlines → `FAILED`, commit timeout → `ABORTED`, adoption
  gating, per-tick urgency (#3).
- Opportunistic base-play pickups while blocked at a barrier.

## Decisions (resolved in brainstorming)

1. **Lock producer = loop reconciles from a contract field**, not ContractRuntime-owns-ClaimStore
   and not return-side-effect-intents. Level-triggered reconcile ("make claims match the active
   contract's desired locks") is idempotent and replica-safe — survives doubled or dropped a2a,
   matching `advance()`'s rescan-from-0 philosophy. ContractRuntime stays a pure protocol object.
2. **Role binding = proposer-side, deterministic from shared beliefs.** The Liaison computes
   `d(liaison,p1)` vs `d(courier,p1)` from the replicated blackboard, assigns picker = closer,
   freezes it in the contract before proposing. No extra a2a round; both replicas share beliefs
   so it is deterministic. Matches "roles bound once at commit" (§9.10).
3. **ACTION steps are self-contained.** Each ACTION carries the tile it fires on (`at`) and
   `advance()` navigates there before emitting the primitive. Decoupled from step ordering,
   robust to replan/drift, keeps `advance()` a pure rescan.

## Schema extensions (`src/coordination/contract.ts`)

`Step` gains:
```ts
| { kind: 'ACTION'; agent: AgentId; primitive: 'pickUp' | 'putDown'
    ids: string[]; at: Pos; post: string; onDelivery?: boolean }
```
- `at` — the tile the primitive fires on; `advance` self-navigates there first.
- `ids` — explicit parcel ids (§8.3 binding rule 1: never dump base-play parcels on the corridor).
- `onDelivery` — `true` only for the deliverer's final scoring putDown; selects the belief
  update (`applyDelivery` deletes the parcel; otherwise `applyDrop` sets `carriedBy=null`).

`Contract` gains two optional fields (rendezvous omits both ⇒ byte-for-byte unchanged):
```ts
lockOwner?: AgentId      // the single party that installs MISSION locks (the handoff picker)
lockParcels?: string[]   // parcels the contract MISSION-locks for its life
```

`ContractAction` gains:
```ts
| { kind: 'pickup'; ids: string[]; post: string }
| { kind: 'putdown'; ids: string[]; post: string; onDelivery: boolean }
```

## `advance()` — two backward-compatible changes

**(a) Execute ACTION steps.** For my unposted ACTION step: if `self !== at` return
`{ navigate, to: at }`; else return `{ pickup|putdown, ids, post, onDelivery }`. The loop fires
the primitive then posts `post` — re-entrant: a lost post re-fires the idempotent primitive and
re-posts next tick.

**(b) Terminal-condition fix.** Today `advance` returns `done` when it falls off the step list
with no actionable step. In handoff the picker runs out of steps *after the barrier* but before
the deliverer delivers — returning `done` there tears the contract down early. Fix: after the
loop, return `done` **only if every non-barrier step's `post` is set**, else `block`.

This generalizes rendezvous without breaking it: there, both LOCALs posted ⇒ all-posted ⇒ `done`
for both (barrier release *is* satisfaction). In handoff, satisfaction is the terminal
`delivered` post, so the picker correctly `block`s after vacating until the deliverer scores.

## `actContract()` — execute primitives

New branch on `pickup` / `putdown`: set `acting`, call `client.pickup()` / `client.putdown(ids)`,
update beliefs (`applyPickup(ids)`; `applyDrop(ids, at)` when `!onDelivery`; `applyDelivery(ids)`
when `onDelivery`), then `runtime.post(action.post)` and broadcast over the `'contract'` channel.

## `handoffContract()` builder — the §8.3 step list

Picker bound proposer-side (closer to parcel). Step list:
```
1 ACTION  picker    pickUp  [p1] at parcel    post 'picked'
2 ACTION  picker    putDown [p1] at drop      post 'dropped'   (onDelivery:false)
3 LOCAL   picker    AT_TILE vacate            post 'H_clear'
4 LOCAL   deliverer AT_TILE approach          post 'b_ready'
5 BARRIER needs ['H_clear','b_ready']
6 ACTION  deliverer pickUp  [p1] at drop      post 'b_picked'
7 ACTION  deliverer putDown [p1] at delivery  post 'delivered' (onDelivery:true)
```
Sets `lockOwner = picker`, `lockParcels = [p1]`. The barrier guarantees the picker has dropped
**and vacated** (`H_clear`) and the deliverer is staged (`b_ready`) before the deliverer steps
onto the now-free drop tile — agents never share a tile.

## `bindHandoff()` — runtime tile binding (the 3 §8.3 rules)

Pure function over the grid + delivery tiles + the picker/deliverer/parcel positions. Returns
`{ parcel, drop, vacate, approach, delivery }` or `null` (⇒ decline the bid, don't propose):
- **drop** — walkable, **non-delivery**, adjacent (Manhattan 1) to a delivery tile, reachable.
  (A delivery-tile drop would score for the picker solo, voiding the cross-agent condition.)
- **vacate** — walkable, adjacent to drop, ≠ delivery; where the picker steps off.
- **approach** — walkable, adjacent to drop, distinct from vacate; where the deliverer stages.
- **delivery** — the delivery tile adjacent to drop; the deliverer's final scoring putDown target.

If no tile set satisfies all three rules → `null`.

Lives in `contract.ts` alongside `rendezvousContract` (parallel structure); split to a `handoff.ts`
only if the file bloats.

## Loop MISSION-lock reconcile (the producer)

In the contract short-circuit branch (`loop.ts`), before `actContract`, a level-triggered reconcile:
```
if active contract c and me === c.lockOwner:
    for id in (c.lockParcels ?? []) not already MISSION-claimed by me:
        claims.add({ parcelId:id, agentId:me, origin:'MISSION', epoch:tnow, commitTick:tnow, ... })
        broadcast claim{ origin:'MISSION' }
        track id in this.contractLocks
if no active contract:
    for id in this.contractLocks: claims.remove(id); broadcast release{id, epoch:tnow}
    clear this.contractLocks
```
- **Single writer:** only the picker (`me === lockOwner`) installs, so no claim race. The partner's
  replica receives the lock via the existing `'claims'` channel; its auction pool and rebalance
  union already exclude `origin==='MISSION'`.
- **Lifetime:** the lock persists for the whole contract (picker carries p1 → ground at drop tile
  → deliverer carries → delivered). A carried parcel is out of the pool anyway; the lock matters
  during the ~1 ground tick at the drop tile, keeping both agents' auctions off it.
- **Teardown release** mirrors §4.3 installed-effect teardown.
- Loop tracks installed ids in a `Set<string>` (`this.contractLocks`).

## Testing

Unit (`tests/contract-*.test.ts`):
- `advance()` handoff walk-through: picker acts (pickup → carry → drop → vacate), `block`s after
  `H_clear` until `b_ready`, barrier releases, deliverer acts (pickup → deliver), `done` returned
  **only after** `delivered` is posted (not when the picker runs out of steps).
- `bindHandoff` returns a valid tile set on a normal map; returns `null` when no non-delivery tile
  is adjacent to a delivery tile.
- `handoffContract` builder: step list shape, `lockOwner`/`lockParcels` set, explicit ids on ACTIONs.

e2e (`tests/contract-handoff-e2e.test.ts`, mirrors `contract-rendezvous-e2e`):
- Two `BdiLoop`s, fake clients, relay routing the `'contract'` + `'claims'` channels. Map with a
  parcel and a delivery zone. Assert the full sequence drives both loops to `SATISFIED` with the
  slot cleared on both replicas, p1 delivered (removed), and the MISSION claim present during the
  contract and released after teardown.

## Done when

A `handoffContract` (with `bindHandoff`-resolved tiles) proposed on one `ContractRuntime` and
accepted by the other drives two `BdiLoop`s — each reading only its own perception — through
pickup → carry → ground-drop → vacate → barrier → cross-agent pickup → scoring delivery, both
reaching `SATISFIED` with the slot cleared on both replicas and the MISSION lock installed for the
contract's life and released on teardown, proven by `tests/contract-handoff-e2e.test.ts`. Base play
is byte-for-byte unchanged when no contract is active (`bun test tests/` stays green).
