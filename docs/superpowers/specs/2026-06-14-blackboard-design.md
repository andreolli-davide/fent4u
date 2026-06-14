# Blackboard — Belief Replication Hub — Design

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Scope:** `src/blackboard/blackboard.ts` v1 — the **replication transport** for the
common belief base: the a2a message protocol, the material-change broadcast
trigger, the (re)connect snapshot handshake, the heartbeat, and the partner-liveness
signal. It wraps the existing `BeliefBase` (`2026-06-14-beliefs-design.md`) and is
its **sole** delta/snapshot driver.

**Explicitly deferred to later increments** (each rides in with its owning
subsystem): the `claims` map (auction, §9.3), the `mission` slot (compiler, §4),
the `contract` slot (§8.1), and the `gate` flag (§8.5). This v1 is the belief-
replication half of the §2.2 blackboard only.

Related: DESIGN.md §2.2 (blackboard fields), §2.3.5 (replication & synchronization —
material change, no conflict resolution, cold-start snapshot), §8.5 (gate freshness
/ partner-loss), §11 (failure & degradation), §12 (config knobs). Consumes the
`Delta` API from `src/blackboard/beliefs.ts`. Uses `A2AMessage` / `AgentId` from
`src/types/a2a.ts`. CLAUDE.md (process model — two Bun workers, main relay;
observability — Pino; TypeScript conventions).

---

## 1. Purpose & boundary

`blackboard.ts` is the agent-local endpoint of the a2a replication described in
§2.3.5. Each agent holds a complete belief replica (`BeliefBase`); this class moves
**changes** between the two replicas so they converge, and exposes whether the
partner is still alive.

```
                 ┌──────────────── Blackboard ────────────────┐
 BDI loop ──onTick(tick)──▶│ drain BeliefBase.computeDelta ──┐ │
                           │                                 ▼ │
                           │                       send(A2AMessage) ──▶ [main relay ──▶ partner]
 main relay ──receive(msg)─▶│ applyDelta / applySnapshot      │ │
                           │ refresh partnerLastSeenTick      │ │
 consumers ──partnerAlive()─│◀── liveness signal              │ │
                           └─────────────────────────────────┘ │
                                        wraps BeliefBase ───────┘
```

The class knows **nothing** about sockets, worker spawning, or the SDK. Transport is
an **injected callback** (`send`); inbound messages are pushed in via `receive`. This
keeps the whole class a pure function of `(tick stream, inbound messages)` —
deterministic and testable with a fake `send` (§11 testing).

### 1.1 The single-drainer rule (load-bearing)

`Blackboard` is the **only** caller of `BeliefBase.computeDelta` /
`applyDelta` / `computeSnapshot` / `applySnapshot`. The BDI loop calls only
`beliefs.foldPerception(...)` and the own-action methods (`applyPickup` /
`applyDelivery` / `applyDrop`), then pumps `blackboard.onTick(tick)`.

Why it matters: `computeDelta` **drains** the belief base's dirty set. If both the
loop and the blackboard called it, one would silently swallow the other's changes.
One owner = no double-drain. This also honours the documented live-reference
invariant on `computeDelta`/`computeSnapshot`: the returned `Delta` aliases live
belief state and must be serialized before the next mutation — `send` →
`worker.postMessage` performs a structured-clone, which **is** that serialization, so
no defensive copy is needed (the postMessage boundary is the clone).

---

## 2. Message protocol

Blackboard traffic rides **one** a2a channel so other subsystems (auction bids,
contract proposals) can claim their own `A2AMessage.type` later without collision.

```
A2AMessage = { from: AgentId; to: AgentId; type: 'blackboard'; payload: BlackboardMsg }
```

`payload` is `unknown` on the wire (per `a2a.ts`) and is narrowed by a type guard on
receipt. The blackboard sub-protocol is a discriminated union:

```ts
export type BlackboardMsg =
  | { kind: 'hello';     tick: number }              // I (re)booted — send me a snapshot
  | { kind: 'snapshot';  tick: number; base: Delta } // full base (computeSnapshot output)
  | { kind: 'delta';     tick: number; delta: Delta } // material change since last drain
  | { kind: 'heartbeat'; tick: number }              // liveness ping while otherwise silent
```

- `tick` is the sender's clock at send time. It stamps liveness (`partnerLastSeenTick`)
  and lets a future `SYNC_GATE` consumer measure gate freshness against
  `GATE_STALE_TTL` (§8.5). Every message carries it, including `hello`/`heartbeat`
  whose `Delta` payload is absent.
- `snapshot.base` and `delta.delta` are both `Delta` values (a snapshot is just a
  full-base Delta produced by `computeSnapshot`, applied additively by
  `applySnapshot`; a delta is the drained-dirty Delta from `computeDelta`).

A `kind`-discriminated **type guard** (`isBlackboardMsg`) validates the narrowed
payload at the boundary (no `any`; `unknown` + guard per CLAUDE.md).

---

## 3. Interface

```ts
export const HEARTBEAT_INTERVAL_TICKS = 1
export const PARTNER_TTL_TICKS = 5

export interface BlackboardOpts {
  self: AgentId
  partner: AgentId
  send: (msg: A2AMessage) => void
  logger: Logger                       // Pino child logger
  heartbeatInterval?: number           // default HEARTBEAT_INTERVAL_TICKS
  partnerTtl?: number                  // default PARTNER_TTL_TICKS
}

export class Blackboard {
  readonly beliefs: BeliefBase
  partnerLastSeenTick: number          // -Infinity until first contact

  constructor(beliefs: BeliefBase, opts: BlackboardOpts)

  hello(tick: number): void            // call once on worker boot
  onTick(tick: number): void           // pump after foldPerception + own-actions
  receive(msg: A2AMessage): void       // feed inbound a2a from the main relay
  partnerAlive(tick: number): boolean  // coarse degradation signal (§11)
}
```

`BeliefBase` is constructed by the agent (it needs `self0`/`consts`/`map`) and
**passed in**, not built by the blackboard — the blackboard wraps a base, it does not
own its construction. This keeps the dependency direction explicit and lets tests
hand in a pre-seeded base.

Private state: `lastSentTick` (last tick we emitted anything; init `-Infinity`),
`heartbeatInterval`, `partnerTtl`, plus the cached `self`/`partner`/`send`/`logger`.

---

## 4. `onTick(tick)` — broadcast trigger

Pumped by the BDI loop **after** the base has folded this tick's perception and own
actions, so the drained delta reflects everything that changed.

```
onTick(tick):
  d = beliefs.computeDelta()           // drains dirty
  if not isEmptyDelta(d):
      emit { kind:'delta', tick, delta:d };  lastSentTick = tick
  else if tick - lastSentTick >= heartbeatInterval:
      emit { kind:'heartbeat', tick };       lastSentTick = tick
```

- **`isEmptyDelta(d)`** ⇔ every `parcels.upsert` / `parcels.remove` / `agents.upsert`
  / `crates.upsert` array is empty **and** `d.self === null`. (A non-null `self` is a
  material change — own movement, §2.3.5.)
- Active ticks self-heartbeat for free: §2.3.5 notes the broadcast "fires almost
  every active tick" because self and enemies move constantly, so a `delta` send
  doubles as a liveness ping (it refreshes `lastSentTick`). The explicit `heartbeat`
  covers only the genuinely silent case — stationary with nothing in view (e.g.
  blocked at a barrier).
- `emit(msg)` wraps the `BlackboardMsg` into `A2AMessage{ from:self, to:partner,
  type:'blackboard', payload:msg }` and calls `send`.

---

## 5. `receive(msg)` — inbound

```
receive(msg):
  if msg.type != 'blackboard' or not isBlackboardMsg(msg.payload): return  // not ours
  bb = msg.payload
  partnerLastSeenTick = max(partnerLastSeenTick, bb.tick)   // every kind refreshes liveness
  switch bb.kind:
    'hello':     base = beliefs.computeSnapshot(); emit { kind:'snapshot', tick: base.tick, base }
    'snapshot':  beliefs.applySnapshot(bb.base)
    'delta':     beliefs.applyDelta(bb.delta)
    'heartbeat': // liveness only — already refreshed above
```

- **`hello` → snapshot reply.** A respawned worker that booted empty announces
  itself; the survivor answers with its full current base. `computeSnapshot` does
  **not** drain the dirty set (it is a full read-only copy), so a snapshot reply never
  disturbs the survivor's own pending delta. `applySnapshot` is additive
  (`mergeByLastSeen`), so a survivor that also receives the booting agent's later
  deltas converges correctly regardless of order (§2.3.5: higher `lastSeen` wins, no
  conflict resolution).
- **Ignore foreign channels.** Messages whose `type !== 'blackboard'` (future auction
  / contract traffic) are silently ignored here — they belong to other handlers.

---

## 6. Liveness model — signal, not policy

One heartbeat stream, **two** consumers with different tolerances:

| Consumer | Threshold | Owner |
|----------|-----------|-------|
| Coarse degradation ("Liaison dies → Courier solo", §11) | `PARTNER_TTL_TICKS` (~5) | **this class** (`partnerAlive`) |
| Gate close-latency guard (stale ⇒ CLOSED, §8.5) | `GATE_STALE_TTL` (~2) | future `SYNC_GATE` arming, reads **raw** `partnerLastSeenTick` |

So the blackboard exposes the **raw** `partnerLastSeenTick` and one coarse helper
`partnerAlive(tick) = (tick - partnerLastSeenTick) <= partnerTtl`. It deliberately
does **not** bake in the tight gate threshold — that arming is contract/execution-
layer logic (only live under an `ACTIVE` SYNC_GATE, §8.5) and is not built in v1.
`partnerAlive` is `false` before first contact (`partnerLastSeenTick = -Infinity`).

Knob rationale: `HEARTBEAT_INTERVAL_TICKS = 1` keeps freshness inside the tight
`GATE_STALE_TTL ≈ 2`; `PARTNER_TTL_TICKS = 5` ≥ a few missed pings, so a transient
one-tick stall never trips a false partner-loss / contract teardown. Both are
constructor-overridable for calibration (§16).

---

## 7. Observability (Pino — mandatory, §CLAUDE)

- `delta` / `snapshot` send **and** apply → `debug`, `{ kind, n, agentId }` where `n`
  = entity count in the payload (per "every blackboard delta at debug" rule).
- `hello` / `heartbeat` send/receive → `debug`, `{ kind, agentId }`.
- **partner-loss / partner-recovered** edge (the `partnerAlive` boolean flips between
  consecutive `onTick`s) → `info`, `{ event:'partner-loss'|'partner-recovered',
  partnerLastSeenTick, tick }` — a degradation event worth surfacing (§11).
- Never `console.log` anywhere; always the injected child logger.

---

## 8. Decisions & divergences

- **(a) Snapshot only on `hello`, not on heartbeat-gap inference.** A respawned
  worker sends `hello`; the survivor replies with a snapshot. Deterministic, matches
  the main.ts worker-respawn model — no timing heuristic that could mis-fire on a
  transient stall vs a true restart.
- **(b) Tick-driven, no real timers.** All heartbeat/liveness cadence is a function
  of the `onTick` stream, so behaviour is reproducible and aligned with the
  tick-stamped logs. No `setInterval`.
- **(c) v1 holds no `claims`/`mission`/`contract`/`gate`.** Those fields' write-logic
  lives in subsystems not yet designed; adding empty container shapes now would be
  speculative coupling (YAGNI). Each lands with its owner.
- **(d) Blackboard exposes raw liveness, not the gate threshold** (§6) — keeps
  transport free of contract semantics.

---

## 9. Testing

Mirror the belief-base round-trip tests: instantiate **two** `Blackboard` instances
(each wrapping its own `BeliefBase`) and wire `A.send → B.receive` and
`B.send → A.receive` to simulate the zero-loss in-process relay (CLAUDE.md). Fake
`send` also used standalone to capture emitted envelopes.

Cases:
1. Material change ships a `delta` and clears the dirty set (next silent `onTick`
   emits `heartbeat`, not a second `delta`).
2. Silent `onTick` emits `heartbeat` once `tick - lastSentTick >= interval`, not
   before.
3. A `delta` send counts as a heartbeat (resets `lastSentTick`; no redundant ping
   the same tick).
4. `hello` → survivor replies `snapshot`; `computeSnapshot` did **not** drain the
   survivor's pending dirty (its next `onTick` still ships its own delta).
5. Snapshot applied additively on the booting side; round-trip converges the two
   bases (reuse a belief fixture).
6. `partnerAlive` is `false` before first contact, `true` after any inbound, flips to
   `false` at `tick - partnerLastSeenTick > partnerTtl`, recovers on next inbound;
   both edges log at `info`.
7. Foreign-channel message (`type !== 'blackboard'`) is ignored (no throw, no base
   mutation, no liveness refresh).
8. `isBlackboardMsg` rejects malformed payloads (boundary guard).
9. No-double-drain contract: a test that the BDI-side never calls `computeDelta`
   (documented invariant; assert via the single-drainer being the only path that
   produces a `delta` message).

`bun test ./tests`, `bunx tsc --noEmit` clean, no `any`, no `console.log`.

---

## 10. File layout

```
src/blackboard/blackboard.ts   # Blackboard class, BlackboardMsg union, isBlackboardMsg guard,
                               # HEARTBEAT_INTERVAL_TICKS / PARTNER_TTL_TICKS, isEmptyDelta helper
tests/blackboard.test.ts       # the §9 cases (two-instance relay harness + fake send)
```

`AgentId` / `A2AMessage` are imported from `src/types/a2a.ts` (already defined).
`Delta` / `BeliefBase` from `src/blackboard/beliefs.ts`. The `Logger` type is from
`pino`, produced by `makeLogger(agentId, 'blackboard', opts)` in `src/logger.ts`
(`beliefs.ts` itself takes no logger; the blackboard is the first belief-layer module
that logs). Following the `deliveroo.ts` precedent, the class may accept a narrow
`LoggerLike` slice (`{ debug, info }`) rather than the full `Logger` if that keeps
tests lighter — a planning-time call.
