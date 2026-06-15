# Coordination — team-optimal allocation (auction · claims · rebalance · dispersion) — design

**Date:** 2026-06-15
**Scope slice:** full DESIGN §9 (two BDI agents cooperate instead of contend)
**Status:** approved for planning

## 1. Goal & scope

Make two selfish rate-maximisers behave as a single **team** maximiser. The objective is `U_team = Σ_X (realised points/tick of X)` (DESIGN §9, R1). Today the two agents share beliefs but allocate independently, so they contend for the same parcel and leave route synergies on the table (§9.1). This slice closes both gaps.

The marginal-route **bid** primitive already exists from the BDI-core slice (`bestInsert` / `uRoute` in `src/bdi/route.ts`, `vValue` in `src/bdi/utility.ts`). This slice adds the **allocation layers** on top.

**In scope (all of §9):**
- Soft, expiring **claims** — stored, replicated coordination state (§9.2 / §9.7 / §9.10 `AUCTION` origin).
- The **marginal-route SSI auction** (§9.3): assign each pool parcel to the agent whose route it improves most.
- **Partner-as-collaborator** (§9.4): a partner-claimed parcel gets `P_avail = 0`; `raceDiscount` stays enemies-only.
- The periodic **global rebalance** (§9.6): 2-opt-style swaps when the team gains more than the physics-derived `switchCost`.
- **Dispersion** (§9.5): a tie-break repulsion that keeps the two agents covering different ground.
- Graceful degradation on partner loss (§9.7 / §11).

**Out of scope (deferred / forward-compat):**
- Missions & contracts (§3 / §4 / §8). No `MISSION`-origin claims are ever created this slice, but the `origin` field and the pool/rebalance exclusions for it are stubbed in so the mission slice plugs in without reshaping claims (§9.10).
- Constraints / tolls (§7): `toll ≡ 0`, so `U_route` is the pure-tick form already shipped. Rebalance and bids see no toll term.
- Reward shapers (§6): `m ≡ g ≡ 1`, inert as today.
- Contract role-binding (§8.3) reuses the same bid machinery but binds **once** at contract commit — it arrives with the mission slice, not here.

## 2. Module layout & data flow

```
src/
  coordination/
    claims.ts       # Claim type + ClaimStore: add/get/expire + a2a replication (mirrors blackboard.ts)
    auction.ts      # runAuction(beliefs, claims, ...) → deterministic SSI rounds, AUCTION_BUDGET
    rebalance.ts    # runRebalance(claims, beliefs, ...) → 2-opt swaps, switchCost hysteresis
    dispersion.ts   # awayFromPartner(x, partnerTarget, D_ref) → [0,1]
  types/
    a2a.ts          # extend: type:'claims' channel + ClaimMsg sub-protocol
  bdi/
    loop.ts         # restructure: claim-sync → expire → auction → rebalance → route-from-own-claims → select
    utility.ts      # buildPool gains the §9.4 partner-claimed exclusion
    intentions.ts   # chooseExplore + zone choice gain the θ_disp·awayFromPartner nudge
config/
  params.yaml       # + CLAIM_TTL, BID_WAIT, REBALANCE_PERIOD, AUCTION_BUDGET, theta_disp
```

### Boundaries

- `claims.ts` owns the **stored** claim state and its replication; it is the only stateful/effectful coordination module (like `blackboard.ts`).
- `auction.ts`, `rebalance.ts`, `dispersion.ts` are **pure**: shared state + params in, claim commits / swaps / a scalar out. No I/O, no client.
- Routes stay **derived** and are never published as blackboard state (§9.7 / §2.3.2): only claims travel the wire.
- `loop.ts` remains the sole orchestrator; it threads the new modules into the existing per-tick pipeline.

### Per-tick pipeline (one agent)

```
foldPerception → blackboard.onTick (belief sync)              [existing]
      │
      ▼
apply inbound ClaimMsgs → ClaimStore converges
      │
      ▼
expire claims past CLAIM_TTL with no progress
      │
      ▼
material change? → runAuction over the UNCLAIMED pool
      │   each round winner (p*, X*): if X*==self → commit + broadcast claim
      ▼
REBALANCE_PERIOD elapsed OR own route finished? → runRebalance → broadcast accepted swaps
      │
      ▼
buildRoute from MY OWN claims (ordered cycle)                 [reuses route.ts]
      │
      ▼
select { U_route, U_explore(+dispersion), U_idle }            [reuses intentions.ts]
      │
      ▼
derive next action → client.move / pickup / putdown
```

Two parcel sets are now distinct:
- **auction pool** = pickable parcels claimed by *no one* and not `MISSION`-locked → fed to the auction.
- **route** = the agent's *own* claimed parcels, ordered into its pickup→deliver cycle.

## 3. The claim — stored, replicated coordination state (§9.2 / §9.7 / §9.10)

```ts
type ClaimOrigin = 'AUCTION' | 'MISSION'   // only AUCTION is created this slice

interface Claim {
  parcelId: string
  agentId: AgentId            // owner
  origin: ClaimOrigin
  epoch: number               // material-change round id; monotone, tick-derived
  commitTick: number          // when committed (audit + age)
  originD: number             // d(committer pos at commit, parcel) — sunk-travel basis (§9.6)
  lastD: number               // most recent d(owner now, parcel) — progress tracking
  lastProgressTick: number    // last tick lastD strictly decreased (§9.7 CLAIM_TTL liveness)
}
```

- Claims are **stored** (sticky across ticks until picked / completed / expired / rebalanced); the route is **derived** from them each tick (§9.7). Storing a claim, not a route, is the stored-vs-derived discipline of §2.3.2.
- `origin = AUCTION` claims are the soft, expiring, non-hoarding reservations of §9.2, governed by `CLAIM_TTL` (§9.7 liveness backstop). `MISSION` claims (not created here) would not expire on `CLAIM_TTL` — their lifetime is the mission/contract (§9.10); the field exists so that exclusion logic is written once.
- `originD`, `lastD`, `lastProgressTick` are all functions of **shared** state (the claim's stored basis + live agent positions from shared beliefs), so both replicas compute identical liveness and switch-cost verdicts.

### ClaimStore

```ts
class ClaimStore {
  byParcel: Map<string, Claim>
  claimedBy(parcelId): AgentId | null
  ownClaims(self): Claim[]
  partnerClaimed(): Set<string>            // §9.4 P_avail=0 set
  add(claim): void                          // local commit OR applied from a2a
  remove(parcelId): void                    // pickup / completion / expiry / yield
  expire(tnow, distOf, CLAIM_TTL): Claim[]  // distOf:(Claim)→d(owner now, parcel); updates lastD/
                                            //   lastProgressTick, returns no-progress claims → re-pool
  applyMsg(msg: ClaimMsg, self): void       // replication: claim | release | swap, with lower-id conflict resolution
}
```

The store is the coordination analogue of `BeliefBase` + the replication role of `Blackboard`: one local replica per agent, kept convergent by broadcasting commits.

## 4. Determinism & claim synchronization (the §9.7 crux)

Both agents run the **identical** SSI auction on the shared belief replica, so they compute identical `(p*, X*)` for every round — there is **no bid-message exchange**; each agent reconstructs the partner's `Δ_X(p)` locally from shared beliefs (§9.3 leader-less & deterministic). Only the **claim outcome** is broadcast.

- **Commit rule.** In each round an agent commits & broadcasts only the claim it *won* (`X* == self`); it applies the partner's winning claims from their broadcast. Happy path → zero conflict.
- **Conflict under replica lag.** If a belief-divergence window makes both commit the same `p` at the same `epoch`, the conflict is resolved deterministically: **lower `agentId` keeps it**, the higher-id owner yields (`remove` + re-pool). Double-chase lasts ≤ 1 tick (§9.3).
- **`BID_WAIT = 1` tick** bounds how long an agent waits for the partner's same-epoch commit before proceeding, so a momentarily silent partner never stalls the auction.
- **Anytime.** The round loop is bounded by `AUCTION_BUDGET`; on timeout, leftover pool parcels stay unassigned and are bid next tick — never a frozen loop (§9.3).

### a2a `claims` channel

`A2AMessage` gains a `type: 'claims'` channel carrying a `ClaimMsg` sub-protocol, mirroring the `type: 'blackboard'` pattern already in `blackboard.ts`:

```ts
type ClaimMsg =
  | { kind: 'claim';   claim: Claim }                 // commit
  | { kind: 'release'; parcelId: string; epoch: number } // yield / expiry
  | { kind: 'swap';    parcelId: string; toAgent: AgentId; epoch: number } // rebalance result
```

The main relay already forwards by `msg.to` with no business logic (CLAUDE.md process model), so no relay change is needed beyond the new `type` passing through.

## 5. The marginal-route SSI auction (§9.3)

`runAuction(beliefs, claims, self, partner, dist, params)`:

1. **Pool** = pickable parcels with finite `d(self, p)` that are unclaimed and not `MISSION`-locked. Co-located parcels are one cluster candidate (§5.5).
2. **Rounds.** Each round, for every pool parcel compute `Δ_A(p)` and `Δ_B(p)` — the marginal `U_route` gain of inserting `p` at its cheapest point into A's resp. B's current route (`bestInsert`, already implemented). Commit the single global-best `(p*, X*)`; ties break by `agentId`. `X*` folds `p*` into its route; the pool is **re-bid** because every remaining `Δ` shifts with `X*`'s new route.
3. Repeat until the pool is empty or `AUCTION_BUDGET` is spent.
4. Each commit where `X* == self` writes a `Claim` (with `originD = d(self_now, p*)`) and broadcasts it.

Bidding the **marginal** (not absolute route value) is what makes greedy assignment track the team optimum: since `U_team` is a sum, `argmax_X Δ_X(p)` is the locally team-optimal move (§9.2). `U_collect(p)` is exactly `Δ` over a length-1 route — the auction reuses the value metric already shipped, no new scoring.

## 6. switchCost, liveness & the global rebalance (§9.6 / §9.7)

`runRebalance(claims, beliefs, self, partner, dist, params)` runs every `REBALANCE_PERIOD` ticks and whenever an agent's route finishes.

- **Union** = both agents' assigned-but-not-yet-picked `AUCTION` parcels. Picked-up parcels and `MISSION`-locked parcels never enter (§9.6).
- **Swap accept rule.** A swap (or transfer) is accepted iff `ΔU_team > switchCost`, with

  ```
  switchCost = forfeited(sunk travel toward the abandoned parcel)
             + re-incurred(the other agent's re-approach)
  ```

  both expressed in points/tick — the same currency as everything else. `sunk = max(0, originD − d(owner_now, p))`; the re-approach is `d(otherAgent_now, p)`. Every input is shared-state-derivable (stored `originD` + live positions), so both replicas reach the identical verdict with no negotiation. Hysteresis is therefore **derived from physics**, not a tuned margin (§9.6): a parcel an agent is already close to has a high switch cost and sticks; one barely started toward moves freely. This is the inter-agent analogue of the private `h_commit` (§5.6).
- Accepted swaps reassign the claim (`swap` ClaimMsg) so both replicas converge.

**CLAIM_TTL liveness (§9.7).** Independently of rebalance, a claim whose `lastD` has not strictly decreased for `CLAIM_TTL` ticks expires and re-enters the pool — a stuck agent cannot hoard a parcel it is making no progress toward. This is a separate backstop from `switchCost`: the two stability levels of §9.7 (shared `switchCost`, private `h_commit`) plus liveness, no third knob.

## 7. Dispersion (§9.5)

`awayFromPartner(x, partnerTarget, D_ref) = min(1, d(x, partnerTarget) / D_ref) ∈ [0, 1]`.

- `partnerTarget` = the head of the partner's **derived** route (its next pickup, or its `z_route` when delivering), read from shared claims + beliefs — the partner's *intention*, not its pixels.
- `D_ref` = map diameter, an a-priori constant; the only knob is `θ_disp` (already in §12).
- `θ_disp · awayFromPartner(x)` is added to `U_explore` region scores and to delivery-zone choice (§6.0). It is **tie-break magnitude only** — bounded in `[0,1]` and weighted small, it reorders near-equal options but never overrides real value.
- Orthogonal to `staleness` (§5.5): `staleness` is temporal and partner-independent ("go where info is old"); dispersion is spatial and instantaneous ("go where your teammate is not"). Both are correct and can point the same or opposite ways.

## 8. Partner-as-collaborator wiring (§9.4)

A parcel **claimed by the partner** gets `P_avail = 0` for me — identical to a parcel `carriedBy` another agent: spoken for, off my candidate list. This is a one-line change in `buildPool` (the `§9.4 P_avail=0 set` from `ClaimStore.partnerClaimed()`): exclude partner-claimed parcels from my route candidacy. `raceDiscount` (§5.3) stays **enemies-only**, unchanged. Cooperation flows through claims (we divide the work), competition through the discount (we cede losing races to enemies); a parcel is never double-charged.

## 9. Degradation (§9.7 / §11)

When `blackboard.partnerAlive(tick)` is false:
- No partner claim broadcasts arrive; the partner's existing claims expire via `CLAIM_TTL` and re-enter the pool.
- The auction runs on the survivor's own replica and wins everything reachable — full base play continues (§11).
- Dispersion has no `partnerTarget`, so it hardens into static **map-region ownership** (each agent prefers parcels in its half), needing no live coordination (§9.5).

The mechanism is leader-less and replica-local, so a dead partner removes *bids*, never the *machinery*.

## 10. Configuration parameters (§12)

Added to `config/params.yaml` and `Params`, with §12 defaults:

| Symbol | Default | Meaning |
|--------|---------|---------|
| `CLAIM_TTL` | 10 ticks | soft-claim expiry if no progress (§9.7) |
| `BID_WAIT` | 1 tick | max wait for the partner's same-epoch commit (§9.3) |
| `REBALANCE_PERIOD` | 15 ticks | cadence of the global rebalance pass (§9.6); also fires on route completion |
| `AUCTION_BUDGET` | per-tick ms slice | anytime cap on the SSI auction (§9.3) |
| `theta_disp` | small | dispersion weight — tie-break-only (§9.5) |

`D_ref` is **derived** from the map (diameter), not a knob. Range validation in `params.ts` extends to the new keys (out-of-range throws loud, as today).

## 11. Testing (TDD, `bun test`)

- **`auction`:** synergy assignment — a cheap-insert into a flying route beats a fewest-assigned heuristic (§9.8 row 1); rounds re-bid after each commit so two parcels on one path go to one agent as a route; deterministic id tie-break; `AUCTION_BUDGET` timeout leaves the pool for next tick (no freeze). Hand-built belief fixtures + manhattan `dist`.
- **`rebalance`:** swap **accepted** when `ΔU_team > switchCost` (cluster near the idle agent, §9.8 row 3); swap **refused** when sunk travel is high (§9.8 row 4) — the same rule, opposite outcomes, no tuned threshold; picked-up and `MISSION` parcels never enter the union.
- **`claims`:** `CLAIM_TTL` expiry on no-progress; conflicting same-epoch claim resolves by lower id; `applyMsg` replication (claim / release / swap) converges two stores.
- **`dispersion`:** `[0,1]` bound; magnitude stays tie-break-sized against real value; degrades to region ownership when `partnerTarget` is absent.
- **`utility` (§9.4):** `buildPool` excludes partner-claimed parcels (`P_avail = 0`); enemy-claimed/`carriedBy` still excluded; own-claimed not in the auction pool.
- **`params`:** new keys default when absent, merge over partial files, out-of-range throws.
- **`loop` integration:** two scripted agents over a shared parcel field divide the work with no double-chase (each parcel claimed by exactly one); partner-loss → survivor takes all reachable.

## 12. Known gaps (accepted for this slice)

- **No missions** create `MISSION` claims, so the precedence machinery (§9.10) is exercised only by the forward-compat stubs, not end-to-end. The mission slice validates it.
- **Greedy auction regret** beyond what one rebalance pass repairs is accepted (§9.2 / §9.6) — the design's stated trade for a cheap, stable hot loop.
- **`AUCTION_BUDGET`/`REBALANCE_PERIOD`** defaults are hand-picked (§12); offline calibration (§16) is a later, separate effort.
