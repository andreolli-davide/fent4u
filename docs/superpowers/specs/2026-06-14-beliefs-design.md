# Belief Base — Design

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Scope:** `src/blackboard/beliefs.ts` — the stored common belief base: schema,
per-tick perception fold, own-action updates, eviction, and delta/snapshot
production. The *transport* of deltas over the a2a channel and the non-belief
blackboard fields (claims / mission / contract / gate) belong to a later
`src/blackboard/blackboard.ts`.

Related: DESIGN.md §2.2 (blackboard fields), §2.3 (belief base — schema, per-tick
update, replication, stored-vs-derived rule), §5.1–5.3 (derived-on-read quantities
this module deliberately does NOT store), §15 (crate admissibility invariant).
Consumes `PerceptionSnapshot` from `src/external/deliveroo.ts`
(`2026-06-13-deliveroo-client-wrapper-design.md`). CLAUDE.md (TypeScript
conventions, observability, process model).

---

## 1. Purpose & boundary

`src/blackboard/beliefs.ts` owns the **stored** model of the world: facts as last
observed, each tagged with the tick it encodes (`lastSeen`). It is the local
replica each agent reads and writes (§2.3.5); both agents hold a complete copy.

The module has exactly **two inputs** and **two outputs**:

```
PerceptionSnapshot ─┐
own-action calls   ─┼─▶ BeliefBase (mutable) ─┬─▶ Delta        ─▶ [blackboard.ts → a2a]
remote Delta       ─┘                         └─▶ read access  ─▶ [§5 utility, A*]
```

It knows **nothing** about sockets, the partner-as-peer, or a2a wiring. A `Delta`
is simply "what changed in my base since the last `computeDelta()`" — a property of
the base itself, not of the partner. Replication *triggers* and *transport* are
`blackboard.ts`'s job (the chosen scope split: the base owns delta **logic**, the
blackboard owns delta **transport** and the §2.2 non-belief fields).

### 1.1 Stored vs. derived — the load-bearing rule (§2.3.2)

> If a quantity changes when the tick advances **with no new observation**, it is
> **derived** (computed on read elsewhere). If it changes only when the world is
> **observed**, it is **stored** here.

This module stores `rewardSeen` (frozen at observation) and `lastSeen`. It **never**
computes or stores `R_now`, `age`, `P_surv`, `P_avail`, `raceDiscount`, or any
`d(·,·)` path length — those are §5's derived-on-read concern. Storing them would
be a bug: they go stale the instant the tick advances.

---

## 2. Stored schema (§2.3.1)

Domain types live in `src/types/perception.ts` alongside the existing observation
types where they are shared; belief-only types may live in beliefs.ts. Exact
placement is an implementation detail for the plan. The shapes:

```ts
type Rel = 'self' | 'partner' | 'enemy'
type CrateState = 'known' | 'unknown'

interface ParcelBelief {
  id: string
  pos: Pos
  rewardSeen: number          // reward AT lastSeen — frozen, NOT decayed
  carriedBy: string | null    // null ⇒ on the ground and pickable
  lastSeen: number            // tick
}

interface AgentBelief {
  id: string
  pos: Pos
  rel: Rel
  lastSeen: number            // tick
  carrying?: string[]         // partner only, from its self-broadcast
}

interface CrateBelief {
  id: string
  state: CrateState
  pos?: Pos                   // present when state === 'known'
  candidates?: Pos[]          // present when state === 'unknown': adjacent push tiles
  locked: boolean            // advisory only (see §7)
  lastSeen: number            // tick
}

interface SelfBelief {
  id: string
  name: string
  teamId: string
  pos: Pos
  score: number
  carrying: string[]          // derived set { p : carriedBy === self.id }
}
```

The base itself:

```ts
interface BeliefBase {
  readonly parcels: Map<string, ParcelBelief>
  readonly agents: Map<string, AgentBelief>   // partner + enemies; self is separate
  readonly crates: Map<string, CrateBelief>
  self: SelfBelief
  // private internals (not part of the read surface):
  //   tileIndex : Map<"x,y", Tile>   — built once at construction, for crate candidates
  //   consts    : GameConsts          — OBS_DISTANCE, PARCEL_DECAY_TICKS
  //   dirty     : accumulator of touched/removed ids since last computeDelta()
}
```

- **Self is not in `agents`.** `beliefs.self` is the owner's ground truth (§2.3.1).
  Sensing never reports self (the wrapper sources self from the `you` event), so
  `agents` holds only partner + enemies. Self is published to the partner as an
  `AgentBelief` with `rel = 'partner'` inside the emitted `Delta` (§5), but stored
  locally as `SelfBelief`.
- **Maps keyed by id** for O(1) upsert/delete/lookup.

---

## 3. Construction

```ts
function makeBeliefBase(
  self0: SelfObs,
  consts: GameConsts,
  map: Tile[],
): BeliefBase
```

- Builds `tileIndex` once from `map` (key `"x,y"`).
- Seeds `self` from `self0`; all entity Maps start **empty**.
- Crates are **not** pre-seeded from the map (see §7 divergence (a)); they enter on
  first sighting.
- `consts` supplies `OBS_DISTANCE` (the visibility radius) and
  `PARCEL_DECAY_TICKS` (the eviction horizon basis).

---

## 4. Operations

State-mutating methods, each delegating to pure exported helpers (§5):

| Method | Behaviour |
|--------|-----------|
| `foldPerception(snap: PerceptionSnapshot)` | Ingest a perception tick (§4.1). Updates `self`, upserts perceived entities, deletes in-range-but-absent parcels, runs crate KNOWN→UNKNOWN, evicts stale parcels, marks dirty. |
| `applyPickup(ids: string[])` | Own action: set `carriedBy = self.id` for each id; recompute `self.carrying`; mark parcels dirty (§2.3.3). |
| `applyDelivery(ids: string[])` | Own action: delete each delivered parcel; recompute `self.carrying`; mark removed dirty. |
| `applyDrop(ids: string[], pos: Pos)` | Own action: set `carriedBy = null`, `pos = pos` for each id; recompute `self.carrying`; mark dirty. |
| `computeDelta(): Delta` | Materialize the dirty accumulator into a `Delta`; **clear** the accumulator. |
| `applyDelta(d: Delta): void` | Fold a remote delta into the base via the **same** merge helpers. Does **NOT** mark dirty — prevents a broadcast echo loop. |
| `computeSnapshot(): Delta` | Full base as a `Delta` (every record as an upsert + current self), for cold-start / reconnect (§2.3.5). |
| `applySnapshot(d: Delta): void` | Apply a full snapshot into an empty (or any) base; like `applyDelta`, does not mark dirty. |

Read access for consumers (§5 utility, A*) is direct, read-only iteration over the
three Maps and `self`. No accessor ceremony.

### 4.1 `foldPerception` algorithm (§2.3.3)

Let `t = snap.tick`, `me = snap.self`, `OBS = consts.OBS_DISTANCE`.

1. **Self** — overwrite `self` from `snap.self`; preserve `carrying` as the derived
   set `{ p.id : p.carriedBy === self.id }` recomputed after parcel updates. Mark
   self dirty.
2. **Parcels — upsert.** For each `p` in `snap.parcels`: upsert `ParcelBelief`
   (`rewardSeen = p.reward`, `carriedBy = p.carriedBy`, `lastSeen = t`). Mark dirty.
3. **Parcels — delete absent.** For each stored parcel NOT in `snap.parcels` whose
   `inRange(me.pos, parcel.pos, OBS)` is true: the tile is currently visible and the
   parcel is gone (picked up or expired-and-cleared) → **delete**, mark removed.
   Out-of-range stored parcels are **kept** (shared memory still values stale
   regions — §5.1, R21).
4. **Agents — upsert.** For each `a` in `snap.agents`: `rel = classifyRel(self, a)`;
   upsert `AgentBelief` (`lastSeen = t`). Mark dirty. **Agents are never deleted or
   evicted** (§2.3.3) — a stale enemy position simply earns low freshness weight in
   §5.3.
5. **Crates — upsert KNOWN.** For each `c` in `snap.crates`: upsert as
   `state = 'known'`, `pos = c.pos`, `candidates = undefined`, `lastSeen = t`. Mark
   dirty. `locked` defaults `false` on first sight (§7 divergence (b)).
6. **Crates — KNOWN→UNKNOWN.** For each stored KNOWN crate whose `pos` satisfies
   `inRange(me.pos, pos, OBS)` but is absent from `snap.crates`: it has been pushed
   off its tile. Set `state = 'unknown'`, `pos = undefined`,
   `candidates = crateCandidates(tileIndex, oldPos)`, `lastSeen = t`. Mark dirty.
   The vacated tile is thereby positively known free (no KNOWN crate there). Crates
   are never deleted.
7. **Evict stale parcels.** Delete any parcel with `t - lastSeen > STALE_TTL`, where
   `STALE_TTL = STALE_TTL_INTERVALS * consts.PARCEL_DECAY_TICKS` and
   `STALE_TTL_INTERVALS = 9` (default; §2.3.3 — three halvings of `P_surv`,
   ≈ 0.125). Mark removed. Eviction bounds memory only; it is not safety-critical.
   `STALE_TTL_INTERVALS` is a named constant, tunable.

**Ordering note:** delete-absent (step 3) and evict (step 7) both remove parcels but
on different criteria (in-view-absent vs. age); running upserts first ensures a
re-sighted parcel refreshes `lastSeen` before the age check.

### 4.2 Visibility metric

`inRange(a, b, obs) := |a.x − b.x| + |a.y − b.y| <= obs` — **Manhattan distance**,
verified against the SDK server source (`backend/src/deliveroo/Xy.js:62` computes
`|dx| + |dy|`; `Sensor.js:64,71` gate parcels/crates at `distance <= obs`, with no
line-of-sight/wall occlusion for entities). The fold's delete rule must use the same
metric the server uses to decide what it sends, or it would wrongly delete (or
wrongly keep) parcels at the visibility boundary.

### 4.3 `classifyRel`

```ts
function classifyRel(self: SelfBelief, a: AgentObs): Rel  // 'partner' | 'enemy'
```

Same `teamId` as self → `'partner'`; different → `'enemy'`. Self never appears in
`snap.agents`, so `'self'` is never produced here (it exists in the `Rel` union for
the published partner-broadcast and for completeness). A two-agent team has exactly
one partner, so teamId matching is unambiguous.

---

## 5. Delta & snapshot

```ts
interface Delta {
  tick:    number             // sender's current tick (last folded); stamps self→partner
  parcels: { upsert: ParcelBelief[]; remove: string[] }
  agents:  { upsert: AgentBelief[] }
  crates:  { upsert: CrateBelief[] }
  self:    SelfBelief | null  // sender's OWN self; folded into receiver's agents as rel='partner'
}
```

- **Accumulator model.** Mutating methods record touched ids and removed ids in the
  private `dirty` set. `computeDelta()` materializes the current records for those
  ids (and `self` if dirtied) into a `Delta`, then clears `dirty`. Between
  broadcasts, repeated touches to the same id collapse to one upsert — last write
  wins, which is correct since the materialization reads current state. `Delta.tick`
  is the base's `lastTick` (set by the most recent `foldPerception`), tracked so
  own-action deltas (which carry no perception tick) still timestamp the partner's
  view of self.
- **Self → partner-agent on apply.** `Delta.self` is the **sender's** `SelfBelief`.
  The receiver must never write it onto its own `self`. Instead `applyDelta` converts
  it to an `AgentBelief{ id, pos, rel: 'partner', lastSeen: d.tick, carrying:
  self.carrying }` and merges it into `agents` via `mergeByLastSeen` (§2.3.1: self is
  published to the partner as a `rel='partner'` agent). This is the primary channel
  by which each agent learns the other's position when out of view. `SelfBelief` has
  no `lastSeen` of its own, which is exactly why `Delta.tick` exists.
- **`applyDelta` symmetry.** Applying a remote delta routes every upsert through the
  same `mergeByLastSeen` helper used by `foldPerception`, and every `remove` through
  the same deletion path. One merge rule, exercised both directions →
  replication cannot diverge from local folding. Crucially, `applyDelta` does **not**
  touch `dirty`, so an applied remote change is never re-broadcast (no echo).
- **`mergeByLastSeen(existing, incoming)`** — higher `lastSeen` wins (§2.3.5). On
  equal `lastSeen` the records are identical game state (both agents read the same
  world at the same tick), so either is fine; pick `incoming` deterministically.
- **Snapshot = full delta.** `computeSnapshot()` emits every stored record as an
  upsert plus current `self` and `tick = lastTick`; `applySnapshot` is `applyDelta`
  over that. This serves the §2.3.5 one-time cold-start / reconnect hydration, and
  the same self→partner conversion applies.

---

## 6. Pure exported helpers (the testable core)

All pure, no `BeliefBase` instance, unit-tested standalone:

| Helper | Signature | Rule |
|--------|-----------|------|
| `inRange` | `(a: Pos, b: Pos, obs: number) => boolean` | Manhattan ≤ obs (§4.2) |
| `classifyRel` | `(self: SelfBelief, a: AgentObs) => Rel` | teamId match (§4.3) |
| `mergeByLastSeen` | `<T extends {lastSeen:number}>(existing: T \| undefined, incoming: T) => T` | higher tick wins (§5) |
| `crateCandidates` | `(tileIndex: Map<string,Tile>, from: Pos) => Pos[]` | adjacent (4-neighbour) tiles of type `slide` or `crateSpawner` — the push-target tiles per GAME_RULES "type-5" |

This mirrors the wrapper's functional-core / thin-shell discipline: the mutable
`BeliefBase` is a thin imperative shell over pure, exhaustively tested functions.

---

## 7. DESIGN divergences (flagged per CLAUDE.md — code vs. DESIGN must be surfaced)

**(a) Initial crates seed from perception, not map config.** §2.3.1 states crates
are `KNOWN` at startup from the map config. The shipped wrapper exposes
`CrateObs = { id, pos }` only via perception — there is no initial-crate list. v1
therefore seeds crates from **first sighting**. This is safe: §2.3.4 / §15 guarantee
push safety via a runtime invariant that re-checks live perceived state at push
time, so a missing-until-seen crate costs at most path optimality, never safety.
**Revisit** by widening the wrapper to surface the initial crate roster if A* later
needs full-map crate awareness from tick 0.

**(b) `locked` is advisory, defaults `false`.** `CrateObs` drops the SDK's lock
state, so beliefs cannot track the `5!` locked flag per-tick. v1 sets
`locked = false` always. This is advisory only: the §15 admissibility invariant
re-checks lock state against live perception before any push, so an incorrect stored
`locked` cannot cause an illegal push. **Revisit** by widening `CrateObs` to carry
lock state if push planning wants to prune locked targets pre-emptively.

Both are wrapper-data gaps, not belief-logic bugs. The base is correct given its
input; widening the input is a separate, later wrapper change.

---

## 8. Observability (CLAUDE.md mandate)

- Never `console.log`. The base takes no logger for pure helpers; mutating methods
  that warrant a trace accept the module's pino child logger via construction or are
  logged by the caller (`blackboard.ts`) at the broadcast boundary. Per CLAUDE.md
  tracing discipline, **blackboard deltas are logged at `debug`** with
  `{ type, entityId, agentId }` — emitted where the delta is *shipped*
  (blackboard.ts), not inside the pure base. beliefs.ts stays log-light; any
  in-fold anomaly (e.g. a malformed snapshot that slipped the wrapper's trust
  boundary) logs at `warn` with `{ tick }`.
- All records carry `lastSeen` (a tick), keeping emitted deltas queryable in DuckDB
  by tick.

---

## 9. Testing strategy

Pure-helper tests (no base): `inRange` boundary (`obs`, `obs+1`), `classifyRel`
(same/different teamId), `mergeByLastSeen` (newer wins, equal-tick deterministic,
undefined existing), `crateCandidates` (corner with 2 neighbours, open with up to 4,
ignores walls/walkable).

Base-operation tests (hand-built `PerceptionSnapshot`s, no socket):
- Upsert + `lastSeen` stamping from `snap.tick`.
- In-range absent parcel deleted; out-of-range absent parcel retained.
- Crate KNOWN→UNKNOWN populates `candidates`; re-sighting restores KNOWN, clears
  candidates.
- Eviction at `> STALE_TTL`, retention at the boundary.
- Own-action methods: pickup sets `carriedBy`, delivery deletes, drop nulls +
  repositions; `self.carrying` stays the derived set throughout.
- Agents never deleted/evicted even when long unseen.

Delta / replication tests:
- `computeDelta` returns only dirtied entities, then clears (second call empty).
- Round-trip convergence: `b2.applyDelta(b1.computeDelta())` makes the relevant
  records in `b2` equal `b1`'s.
- `applyDelta` does not dirty `b2` (its subsequent `computeDelta` is empty) — no
  echo.
- `mergeByLastSeen` ordering: an older remote upsert does not overwrite a fresher
  local record.
- Snapshot hydrates an empty base to equality with the source.

---

## 10. File layout

```
src/blackboard/beliefs.ts     # this module: types, BeliefBase, methods, pure helpers
src/types/perception.ts       # existing; Pos/Tile/SelfObs/AgentObs/etc. reused
tests/beliefs-helpers.test.ts # pure helpers
tests/beliefs-fold.test.ts    # foldPerception + own-actions + eviction
tests/beliefs-delta.test.ts   # computeDelta/applyDelta/snapshot round-trips
```

Belief-only types (`ParcelBelief`, `AgentBelief`, `CrateBelief`, `SelfBelief`,
`BeliefBase`, `Delta`, `Rel`, `CrateState`) may be declared in `beliefs.ts` or
hoisted to `src/types/perception.ts` if a future consumer needs them without
importing the base — the plan decides. Either keeps the SDK `IO*` wire shapes out
of the belief layer (they already terminate at the wrapper).
