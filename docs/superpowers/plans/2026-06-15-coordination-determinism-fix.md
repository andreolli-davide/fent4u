# Coordination Determinism Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the two-agent coordination breakdown (route thrash, walk-over, no delivery) by making the §9.3 auction a deterministic function of shared state only, and making any residual divergence unable to orphan a parcel.

**Architecture:** Two complementary levers in `src/bdi/loop.ts`. Lever A: the coordination block reads a SHARED self position (the value last shipped to the partner = last tick's self), not the live self, so both replicas auction over identical inputs. Lever B: each agent commits and broadcasts the FULL auction allocation (claims for both agents), and the existing same-epoch / lower-id conflict rule reconciles any disagreement — so no parcel is ever left unclaimed by both.

**Tech Stack:** Bun + TypeScript (strict ESM, `.js` import extensions), `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-15-coordination-determinism-fix-design.md`

**Branch:** `fix/coordination-determinism` (already created; spec + RED repro committed).

---

## File Structure

- **Modify:** `src/bdi/loop.ts` — only file with logic changes. Add a `prevSelf` field, derive `sharedSelf`, thread it into the coordination block (`meSnap.pos`, the auction-side `buildPool` call, and the claim-commit loop), and rewrite the commit loop to commit the full allocation.
- **Modify (test):** `tests/coordination-divergence.test.ts` — existing RED repro; strengthen to assert both replicas agree on the owner.
- **Create (test):** `tests/coordination-shared-self.test.ts` — proves the coordination commit uses `sharedSelf` (last-tick pos), not live self, via the claim's `originD`.

No changes to `auction.ts` / `rebalance.ts`: they read `agent.pos` from the snapshots, which become shared automatically.

---

## Task 1: Lever A — coordination reads the SHARED self position

**Files:**
- Modify: `src/bdi/loop.ts` (field near `:31`, derive `sharedSelf` near `:58`, use at `:95`, `:100`, `:107`, set `prevSelf` near `:174`)
- Test: `tests/coordination-shared-self.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/coordination-shared-self.test.ts`:

```ts
// tests/coordination-shared-self.test.ts
// Lever A (§9.7): the coordination commit must use the SHARED self position —
// the value last shipped to the partner (== last tick's self) — not the live
// self, so both replicas auction over identical inputs. Observable proxy: a
// claim's originD is measured from the shared self pos, not the live one.
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { ClaimStore } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 20, PARCEL_DECAY_TICKS: 100, PARCEL_DECAY_RAW: '5s', PENALTY: 0 }

function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x <= 11; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

function fakeClient(role: 'courier' | 'liaison', map: Tile[]): DeliverooClient {
  return {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (): Promise<Pos | false> => ({ x: 0, y: 0 } as Pos),
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (ids?: string[]): Promise<PickResult[]> => (ids ?? []).map((id) => ({ id })),
    onMissionMsg: () => {}, say: async () => 'successful' as const, ask: async () => ({}), shout: async () => ({}), close: () => {},
  } as DeliverooClient
}

const noopLog = { info: () => {}, debug: () => {}, warn: () => {} }

test('coordination commit uses shared (last-tick) self pos for originD, not live self', async () => {
  const map = rowMap()
  const claims = new ClaimStore()
  const loop = new BdiLoop(fakeClient('courier', map), DEFAULT_PARAMS, noopLog, claims, {
    partner: 'liaison',
    send: (_msg: A2AMessage) => {}, // partner store not needed for this assertion
  })

  // Tick 1: self at x=5, partner far at x=11, parcel A at x=2 (courier wins it).
  // After tick 1, prevSelf := x=5.
  const snap1: PerceptionSnapshot = {
    tick: 1,
    self: { id: 'courier', name: 'courier', teamId: 'T', pos: { x: 5, y: 0 }, score: 0 },
    agents: [{ id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 11, y: 0 }, score: 0 }],
    parcels: [{ id: 'A', pos: { x: 2, y: 0 }, reward: 10, carriedBy: null }],
    crates: [],
  }
  await loop.tick(snap1)

  // Tick 2: agent has "moved" to x=9 (live), but the SHARED self pos is still x=5
  // (last tick). New parcel B at x=6. dist(sharedSelf x5, B x6) = 1; dist(live x9, B x6) = 3.
  const snap2: PerceptionSnapshot = {
    tick: 2,
    self: { id: 'courier', name: 'courier', teamId: 'T', pos: { x: 9, y: 0 }, score: 0 },
    agents: [{ id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 11, y: 0 }, score: 0 }],
    parcels: [
      { id: 'A', pos: { x: 2, y: 0 }, reward: 10, carriedBy: null },
      { id: 'B', pos: { x: 6, y: 0 }, reward: 10, carriedBy: null },
    ],
    crates: [],
  }
  await loop.tick(snap2)

  const claimB = claims.ownClaims('courier').find((c) => c.parcelId === 'B')
  expect(claimB).toBeDefined()
  expect(claimB!.originD).toBe(1) // from shared self x=5, NOT live x=9 (which would be 3)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/coordination-shared-self.test.ts`
Expected: FAIL — `expect(claimB!.originD).toBe(1)` receives `3` (current code measures originD from live self x=9).

- [ ] **Step 3: Add the `prevSelf` field**

In `src/bdi/loop.ts`, after the `prevOwnClaims` field (`:31`), add:

```ts
  private prevOwnClaims = 0 // own-claim count last tick — for the route-finished falling edge (§9.6)
  private prevSelf: Pos | null = null // self pos folded last tick == value last shipped to partner; the SHARED self pos for coordination (§9.7)
```

`Pos` is already imported at the top of the file (`import type { ... Pos, Tile } from '../types/perception.js'`).

- [ ] **Step 4: Derive `sharedSelf`**

In `tick()`, immediately after the `dist` memo closure is defined (right before the `// ── coordination` comment, ~`:72`), add:

```ts
    // §9.7: coordination (auction/rebalance/pool) must read SHARED state only. The only
    // private leak is our OWN position — partner pos already comes from shared beliefs.
    // prevSelf is last tick's self = the value last shipped to the partner, so both
    // replicas auction over the identical (self_{t-1}, partner_{last-seen}) pair.
    const sharedSelf = this.prevSelf ?? self
```

- [ ] **Step 5: Use `sharedSelf` in the three coordination inputs**

In `tick()`:

Line ~`:95` — `meSnap`:
```ts
      const meSnap: AgentSnap = { id: me, pos: sharedSelf, carried, claimed: this.claimedParcels(beliefs, me) }
```

Line ~`:100` — the auction-side pool (the execution-side `buildPool` at `:134` stays on live `self`):
```ts
      const { pool } = this.buildPool(beliefs, sharedSelf, tnow, dist)
```

Line ~`:107` — the claim `originD`/`lastD` (still own-wins-only in this task; Lever B rewrites the loop body next):
```ts
        const claim: Claim = { parcelId, agentId: me, origin: 'AUCTION', epoch: tnow, commitTick: tnow, originD: dist(sharedSelf, p.pos), lastD: dist(sharedSelf, p.pos), lastProgressTick: tnow }
```

- [ ] **Step 6: Record `prevSelf` at end of tick**

In `tick()`, immediately after `await this.act(chosen, beliefs, ctx, tnow)` (~`:174`), add:

```ts
    await this.act(chosen, beliefs, ctx, tnow)
    this.prevSelf = self // shipped to partner by blackboard.onTick after this returns ⇒ next tick's shared self
    this.log.debug({ durationMs: performance.now() - t0, tick: tnow }, 'tick')
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/coordination-shared-self.test.ts`
Expected: PASS.

- [ ] **Step 8: Confirm the repro is still RED (Lever B not done yet)**

Run: `bun test tests/coordination-divergence.test.ts`
Expected: still FAIL (orphan) — Lever A alone does not fix the one-tick repro (tick 1 has no `prevSelf`, so it falls back to live self). Task 2 fixes it. This is expected; do not act on it here.

- [ ] **Step 9: Commit**

```bash
git add src/bdi/loop.ts tests/coordination-shared-self.test.ts
git commit -m "$(cat <<'EOF'
fix(coordination): feed auction the shared self pos, not live (§9.7)

Lever A: the auction/rebalance/pool now read prevSelf (last tick's pos =
the value last shipped to the partner), so both replicas compute over the
identical (self_{t-1}, partner_{last-seen}) pair. Execution route keeps
live self. Removes the divergence source behind the two-agent thrash.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Lever B — commit the full allocation (no orphans)

**Files:**
- Modify: `src/bdi/loop.ts` (commit loop, ~`:104-110`)
- Test: `tests/coordination-divergence.test.ts` (strengthen)

- [ ] **Step 1: Strengthen the failing repro test**

In `tests/coordination-divergence.test.ts`, replace the two final assertions with:

```ts
  // §9.3 promises exactly one agent owns each reachable parcel, and both replicas
  // agree. With orphans fixed, neither store is null AND they name the same owner.
  const courierOwner = courierClaims.claimedBy('p')
  const liaisonOwner = liaisonClaims.claimedBy('p')
  expect(courierOwner).not.toBeNull()
  expect(liaisonOwner).not.toBeNull()
  expect(courierOwner).toBe(liaisonOwner!) // replicas converge on one owner
```

- [ ] **Step 2: Run the repro to verify it fails**

Run: `bun test tests/coordination-divergence.test.ts`
Expected: FAIL — `courierOwner` is `null` (parcel orphaned by "commit own wins" under divergent allocations).

- [ ] **Step 3: Rewrite the commit loop to commit the full allocation**

In `src/bdi/loop.ts`, replace the commit loop (currently ~`:104-110`):

```ts
      for (const [parcelId, winner] of alloc) {
        if (winner !== me) continue
        const p = beliefs.parcels.get(parcelId)! // safe: pool ⊆ beliefs.parcels, parcels not mutated between buildPool and here
        const claim: Claim = { parcelId, agentId: me, origin: 'AUCTION', epoch: tnow, commitTick: tnow, originD: dist(sharedSelf, p.pos), lastD: dist(sharedSelf, p.pos), lastProgressTick: tnow }
        this.claims.add(claim)
        this.broadcast({ kind: 'claim', claim })
      }
```

with:

```ts
      // §9.3/Lever B: commit & broadcast the FULL allocation (claims for BOTH agents),
      // not just our own wins. Under any residual input divergence a parcel one replica
      // assigns to the partner would otherwise be committed by neither → orphaned. The
      // same-epoch / lower-id conflict rule (claims.ts) reconciles disagreements to one
      // owner within ≤1 tick (DESIGN §9.3). originD uses the winner's SHARED pos.
      for (const [parcelId, winner] of alloc) {
        const p = beliefs.parcels.get(parcelId)! // safe: pool ⊆ beliefs.parcels, parcels not mutated between buildPool and here
        const winnerPos = winner === me ? sharedSelf : partnerSnap.pos
        const d = dist(winnerPos, p.pos)
        const claim: Claim = { parcelId, agentId: winner, origin: 'AUCTION', epoch: tnow, commitTick: tnow, originD: d, lastD: d, lastProgressTick: tnow }
        this.claims.add(claim)
        this.broadcast({ kind: 'claim', claim })
      }
```

`partnerSnap` is already in scope (declared ~`:96`). `sharedSelf` is in scope from Task 1.

- [ ] **Step 4: Run the repro to verify it passes**

Run: `bun test tests/coordination-divergence.test.ts`
Expected: PASS — both stores name the same owner; no orphan.

- [ ] **Step 5: Verify the shared-self test still passes**

Run: `bun test tests/coordination-shared-self.test.ts`
Expected: PASS — `claimB.originD` is still `1` (own win, `winnerPos === sharedSelf`).

- [ ] **Step 6: Commit**

```bash
git add src/bdi/loop.ts tests/coordination-divergence.test.ts
git commit -m "$(cat <<'EOF'
fix(coordination): commit the full auction allocation (§9.3)

Lever B: each agent now commits & broadcasts claims for BOTH agents, not
only its own wins. Combined with the same-epoch/lower-id conflict rule,
a contested parcel can no longer be orphaned (assigned to the partner by
both replicas → committed by neither). Repro test now green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Full regression sweep + verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `bun test`
Expected: PASS for all files. Pay special attention that these stay green:
- `tests/coordination-integration.test.ts` (frozen positions: `sharedSelf === self`, full-commit converges to the same owners → courier owns p1, liaison owns p2; movement unchanged).
- `tests/bdi-loop-walkover.test.ts`, `tests/bdi-loop.test.ts`, `tests/bdi-loop-claims.test.ts`.
- `tests/coordination-auction.test.ts`, `tests/coordination-rebalance.test.ts`, `tests/coordination-claims.test.ts`.

If any fail, STOP and investigate — do not patch tests to pass. A real regression means the levers interact with an assumption the test encodes; surface it.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors (strict mode; `Pos` import already present, no `any` introduced).

- [ ] **Step 3: Manual two-agent smoke (optional but recommended)**

Start a local two-agent session against `external/deliveroo.js` and watch `logs/session-*.ndjson` for `intent switch` events. Expected after the fix: agents divide the field, pick up and deliver, and the committed route head does NOT switch every tick (no thrash). Query example:

```bash
duckdb -c "SELECT tick, agentId, \"from\", \"to\" FROM read_json_auto('logs/session-*.ndjson') WHERE msg='intent switch' ORDER BY tick LIMIT 40"
```

A healthy run shows sparse switches (on genuine new/lost parcels), not one per tick per agent.

- [ ] **Step 4: Final commit (only if Step 1/2 required any doc tweak)**

If everything passed with no further edits, nothing to commit here. Otherwise commit the verification notes/fixups with a `chore(coordination): ...` message.

---

## Self-review notes (author)

- **Spec coverage:** Lever A → Task 1; Lever B → Task 2; testing plan items 1 (repro green) → Task 2, 3 (shared-self determinism) → Task 1, 4 (regression) → Task 3. Item 2 (divergent-but-consistent) is exactly the strengthened repro (Task 2 Step 1, `toBe(liaisonOwner)`). Item 5 (route stability) → Task 3 Step 3 (manual). BID_WAIT explicitly out of scope — no task, correct.
- **Edge cases:** first-tick fallback (`prevSelf ?? self`) covered by Task 1 Step 4; partner-absent path untouched (degraded mode still builds `partnerSnap.pos = self`); `expire` deliberately left on LIVE self (owner-private liveness, releases broadcast — not a coordination determinism input).
- **Type consistency:** `sharedSelf: Pos`, `prevSelf: Pos | null`, `winnerPos: Pos`, `claim.originD: number` — all consistent with `Claim` in `claims.ts` and `AgentSnap` in `auction.ts`. No new exports.
