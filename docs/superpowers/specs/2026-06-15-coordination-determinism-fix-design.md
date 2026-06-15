# Coordination determinism fix — design

**Date:** 2026-06-15
**Status:** approved (brainstorming) → ready for plan
**Touches:** BDI loop, coordination (auction/rebalance inputs, claim commit). PR-required.

## Problem

Single agent plays well. Two agents (Liaison + Courier) both degrade: constant
route changes, parcels walked over without pickup, picked parcels not delivered.

### Root cause

DESIGN §9.7 (line 1006) requires:

> "The route used for **coordination** (auction + rebalance) must be a
> deterministic function of *shared* state only — claims, beliefs, config — so
> both replicas reconstruct each other's route identically and the leader-less
> consensus holds."

The §9.3 auction is leaderless: both replicas run the identical `runAuction` and
each commits **only its own wins** (`loop.ts:104` `if (winner !== me) continue`).
That is safe **only if both replicas compute the identical allocation**.

They don't. Each agent feeds the auction its **own live** self position but the
partner's **last-replicated (stale)** position (`loop.ts:95-96`), and `loop.tick()`
runs the auction *before* `blackboard.onTick()` ships the delta (`courier.ts:48-49`).
So the two replicas auction over **different position pairs** — each has the fresh
copy of itself and a stale copy of the partner. The sequential greedy SSI auction
cascades on any input difference → **divergent allocations**.

Consequences, matching the three symptoms:

1. **Orphaned parcels (walk over without pickup).** When two agents converge on
   one parcel from opposite sides, each one's stale view shows the *other* as
   closer → each assigns the parcel to the partner → each commits only its own
   wins → **neither claims it**. In coordinated mode the route derives only from
   `ownClaimed` (`loop.ts:145`), so neither routes to it.
2. **Constant route changes.** Per-tick allocation flips churn each agent's claim
   set → `routeFromClaims` reorders → committed route head changes every tick →
   `h_commit` hysteresis defeated → intent switch every tick.
3. **No deliveries.** Routes never held long enough to reach a zone.

Single agent works because `this.coord` is undefined → no auction, stable greedy
`buildRoute` over all visible parcels (`loop.ts:147-149`).

### Reproduction

`tests/coordination-divergence.test.ts` (currently RED): two cross-wired loops,
one parcel at x=6, real positions courier x=5 / liaison x=7, each with a STALE
view of the partner at x=6. Each agent's auction assigns the parcel to the
partner → neither store claims it. `claimedBy('p')` is `null` in both. The
existing `coordination-integration.test.ts` passes only because it freezes both
partner positions as static constants and runs 2 ticks — the single configuration
where both replicas see byte-identical inputs.

### Why this is a code bug, not a design change

DESIGN §9.7 already mandates shared-only coordination inputs; the code violates
it by leaking the live self position. Per CLAUDE.md ("if code and DESIGN conflict,
the code is wrong"), the fix restores the contract.

## Fix — two complementary levers

### Lever A — feed coordination *shared* positions

Partner position already comes from shared beliefs. The only private leak is the
agent's **own** position. Replace live self with the **last-broadcast self
position** in every coordination input.

**Source of shared self pos.** The loop remembers the self position folded *last
tick* (`prevSelfPos`). Because `blackboard.onTick()` ships the delta *after*
`loop.tick()`, last tick's self == what the partner currently sees. So at tick `t`
both replicas auction over the identical pair `(self_{t-1}, partner_{last-seen})`.
Symmetric staleness → identical allocation. First coordination tick (no prev) →
fall back to live self (no partner contention to diverge on yet).

**Symmetry argument.** A's view of B = B's last-shipped delta = B's `prevSelfPos`.
B's view of A = A's last-shipped delta = A's `prevSelfPos`. Both agents therefore
auction over the same `(A_prev, B_prev)` pair. If an agent did not move (no
self-delta shipped), its `prevSelfPos` equals the older shipped value, so the pair
stays symmetric.

**Touch points (all in `loop.ts`):**

- `meSnap.pos` (`:95`) ← `sharedSelf`
- auction-side `buildPool` call (`:100`) ← `sharedSelf` (execution-side `buildPool`
  at `:134` keeps live `self`)
- `originD` at claim commit (`:107`) ← `dist(sharedSelf, p.pos)` so the rebalance
  sunk-cost basis is shared

`auction.ts` and `rebalance.ts` need **no change**: they read `agent.pos` from the
snaps, which are now both shared; `weightFor` (P_avail) and all `dist(agent.pos,·)`
calls become deterministic automatically.

### Lever B — commit the *full* allocation

Today `loop.ts:104` commits only own wins. Change: commit **and broadcast every**
`[parcelId, winner]` in the allocation, with the claim attributed to the actual
winner and `originD = dist(winnerPos, p.pos)` using shared positions (`sharedSelf`
if `winner === me`, else `partnerSnap.pos`). The existing same-epoch / lower-id
conflict rule (`claims.ts:126`) reconciles any disagreement to one owner within
≤1 tick — DESIGN §9.3 (line 948) already declares that acceptable.

Effect: after the commit loop, every pool parcel is owned by someone in every
replica. **Orphans become structurally impossible**, independent of residual input
divergence (transient desync, A* nondeterminism, pool-gate edges).

### What stays private (unchanged)

- Execution route candidate (`loop.ts:145`), `act`, `stepToward` — live self.
- `h_commit` hysteresis, explore/idle utilities — live self.
- Per DESIGN §101: `P_avail`/`d(self,p)` differing per agent is correct for
  **private derivations** (execution); the fix only moves the **coordination**
  derivation to shared inputs.

## Edge cases

- **First coordination tick / no `prevSelfPos`:** use live self. No partner
  contention has been auctioned yet, so no divergence to cause.
- **Partner absent (degraded mode, §9.7/§11):** determinism moot (solo). Existing
  `dropForeignAuctionClaims` path unchanged.
- **Agent did not move last tick:** `prevSelfPos` == last shipped value; pair stays
  symmetric.
- **Stuck partner-claim (residual wrinkle):** a partner-claim written under B is
  released only when the partner picks the parcel up. Under *persistent* divergence
  a partner-claim could linger and block that parcel from the local pool. Lever A
  prevents persistent divergence (agreement re-reached every tick), and parcel
  decay clears truly-stale claims from beliefs, so this stays a ≤1-tick transient.
  Accepted; no extra machinery (YAGNI).

## Out of scope

- **BID_WAIT synchronization** (§9.3 line 948): not implemented today and not
  needed once A makes allocations identical and B reconciles residuals.
- Any change to `auction.ts` / `rebalance.ts` internals.
- Mission/contract (`origin = MISSION`) claim handling — untouched.

## Testing plan (TDD — failing tests first)

1. **`coordination-divergence.test.ts` (exists, RED → GREEN):** stale partner
   positions no longer orphan the contested parcel; exactly one agent owns it and
   both replicas agree.
2. **New: divergent-but-consistent (Lever B).** Two loops with genuinely different
   stale views that produce different *local* allocations; after cross-wired
   broadcast both stores converge to the same owner per parcel, no orphan.
3. **New: shared-position determinism (Lever A).** Given `prevSelfPos`, assert both
   replicas commit the identical own-win set on a small field (no reliance on
   frozen positions).
4. **Regression:** `coordination-integration.test.ts` stays green;
   `bdi-loop-walkover.test.ts`, `coordination-auction/-rebalance/-claims` stay
   green.
5. **Optional: route stability.** Multi-tick run with a stable claim set asserts
   the committed route head does not switch every tick (no thrash).

## Acceptance

- Repro test green; no orphan reachable under stale positions.
- All existing coordination + loop tests green.
- Manual two-agent session: agents divide the field, pick up and deliver, no
  per-tick route thrash.
