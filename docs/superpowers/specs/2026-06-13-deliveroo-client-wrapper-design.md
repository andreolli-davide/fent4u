# Deliveroo Client Wrapper — Design

**Date:** 2026-06-13
**Status:** Approved (pending spec review)
**Scope:** `src/external/deliveroo.ts` — the typed, role-aware boundary between the
`@unitn-asa/deliveroo-js-sdk` and the BDI workers.

Related: DESIGN.md §2.2 (blackboard), §2.3 (belief base + reconnect snapshot), §5
(unified utility / tick model). CLAUDE.md (TypeScript conventions, observability,
process model).

---

## 1. Purpose & boundary

`src/external/deliveroo.ts` is the **only** module in the project that imports the
SDK or `socket.io-client`. It converts the untyped, event-and-promise SDK into a
typed, role-aware client that the Liaison and Courier workers consume.

It does exactly three jobs:

1. **Typed transport** — typed `connect()`, typed event subscriptions, typed async
   actions. No `any`; the untyped SDK is described by an ambient `.d.ts` stub.
2. **Perception normalization** — map the SDK's `IO*` wire shapes to project-owned
   domain types, emitted as a single `PerceptionSnapshot` per sensing event.
3. **Server-authoritative tick** — derive a monotonic, cross-agent-comparable
   `tick()` from the server clock (anchor + interpolate, §6).

It is **stateless with respect to perception/beliefs.** It does not hold the latest
snapshot, does not decay rewards, does not derive utility constants beyond mechanical
unit parsing. `beliefs.ts` owns the belief base (DESIGN §2.3); `utility.ts` owns the
rate formulas (DESIGN §5). This keeps the wrapper inside "transport + normalize +
tick" and nothing more.

### Non-goals

- No belief/perception caching (that is `beliefs.ts`).
- No utility/decay math — only the mechanical `decaying_event` string→ticks parse.
- No action scheduling/queueing — the BDI loop owns one-move-per-tick sequencing.
- No live-server integration tests in this unit (manual/scenario concern, DESIGN §11).

---

## 2. File layout

```
src/external/
  deliveroo-sdk.d.ts   # ambient `declare module '@unitn-asa/deliveroo-js-sdk'`
                       # types ONLY the surface we use (DjsConnect, DjsClientSocket,
                       # IO* shapes). Everything else stays unexposed.
  deliveroo.ts         # connect() factory, DeliverooClient, pure normalizers, tick clock
src/types/
  perception.ts        # Tile, ParcelObs, AgentObs, CrateObs, SelfObs,
                       # GameConsts, PerceptionSnapshot — project-owned domain types
```

`deliveroo.ts` is the imperative shell; the normalizers and tick math are **pure
exported functions** so they are unit-testable without a socket (§9, "functional
core / imperative shell").

---

## 3. Domain types (`src/types/perception.ts`)

Project-owned. `IO*` shapes never escape `deliveroo.ts`. Coordinates are normalized
to integer `{x, y}`. The SDK's optional agent `x?`/`y?` (an agent with no position is
out of view) collapses to the rule **"in view ⇒ has position; otherwise dropped from
the snapshot."**

```ts
export type Pos = { x: number; y: number }

export type TileType =
  | 'wall'         // '0'
  | 'spawner'      // '1'  parcel spawner
  | 'delivery'     // '2'
  | 'base'         // '4'
  | 'walkable'     // '3'
  | 'slide'        // '5'  crate sliding tile
  | 'crateSpawner' // '5!'
  | 'oneway'       // '←' '↑' '→' '↓'  (direction in `dir`)

export interface Tile { pos: Pos; type: TileType; dir?: 'up' | 'down' | 'left' | 'right' }

export interface ParcelObs { id: string; pos: Pos; reward: number; carriedBy: string | null }
export interface AgentObs  { id: string; name: string; teamId: string; pos: Pos; score: number }
export interface CrateObs  { id: string; pos: Pos }
export interface SelfObs   { id: string; name: string; teamId: string; pos: Pos; score: number }

// Action result. The SDK's emitPickup/emitPutdown resolve to { id }[] only —
// no pos/reward/carriedBy. The stateless wrapper passes these through verbatim;
// the BDI belief base holds the full ParcelObs and looks up by id.
export interface PickResult { id: string }

export interface GameConsts {
  CLOCK: number              // ms per frame (top-level IOConfig.CLOCK), default 50
  MOVEMENT_DURATION: number  // GAME.player.movement_duration, default 50
  OBS_DISTANCE: number       // GAME.player.observation_distance, default 5
  PARCEL_DECAY_TICKS: number // decaying_event parsed to ticks; Infinity if 'infinite'
  PARCEL_DECAY_RAW: string   // raw decaying_event ('1s' | '2s' | ... | 'infinite')
  PENALTY: number            // IOConfig.PENALTY
}

export interface PerceptionSnapshot {
  tick: number
  self: SelfObs
  parcels: ParcelObs[]
  agents: AgentObs[]
  crates: CrateObs[]
}
```

The **static tile map** (`Tile[]`) is delivered once at startup via the SDK `map`
promise — it is *not* part of `PerceptionSnapshot`, which carries only dynamic
entities (DESIGN §2.2: tile type map is known a priori).

### Tile type mapping

The SDK `IOTileType` is one of `'0' '1' '2' '3' '4' '5' '5!' '←' '↑' '→' '↓'`. The
normalizer maps each to `{ type, dir? }`. Directional arrows map to
`type:'oneway'` with `dir` set. An **unknown** char maps to `type:'wall'` and logs
`warn` — safe-by-default: a wall blocks pathing and can never trigger an unsafe crate
push (DESIGN §15 admissibility invariant re-checks live state anyway).

---

## 4. Public API

```ts
export type Role = 'liaison' | 'courier'

export interface DeliverooClient {
  readonly role: Role
  readonly consts: GameConsts        // resolved at startup, immutable
  readonly map: Tile[]               // resolved at startup, immutable
  tick(): number                     // server-authoritative, anchor+interpolate (§6)

  // perception & lifecycle
  onPerception(cb: (s: PerceptionSnapshot) => void): void
  onConnect(cb: () => void): void
  onDisconnect(cb: (reason: string) => void): void

  // actions (both roles) — thin typed pass-through; BDI owns sequencing
  move(dir: 'up' | 'down' | 'left' | 'right'): Promise<Pos | false>
  pickup(): Promise<PickResult[]>          // SDK returns { id }[] only (§3)
  putdown(ids?: string[]): Promise<PickResult[]>

  // mission channel — present on the type, role-gated at runtime (liaison only)
  onMissionMsg(cb: (from: string, name: string, msg: unknown) => void): void
  say(toId: string, msg: unknown): Promise<'successful' | 'failed'>
  ask(toId: string, msg: unknown): Promise<unknown>
  shout(msg: unknown): Promise<unknown>

  close(): void                      // clear intervals, disconnect socket
}

export async function connect(
  config: Config,
  role: Role,
  logger: Logger,                    // Pino child; module:'external' (CLAUDE.md: no console.log)
): Promise<DeliverooClient>
```

### `connect` behaviour

1. Select token by role: `role === 'liaison' ? config.TOKEN_LIAISON : config.TOKEN_COURIER`.
2. Build host URL from `config.DELIVEROO_HOST` + `config.DELIVEROO_PORT`; call
   `DjsConnect(host, token, '', true)`.
3. **Await the SDK one-shot promises** `me`, `config`, `map` before resolving — a
   returned client is fully initialized (self id, `GameConsts`, tile map all present).
4. Build `GameConsts` from `IOConfig` (§5).
5. Wire runtime listeners: `onSensing` → emit `PerceptionSnapshot`; `ping` → re-anchor
   tick; `onConnect`/`onDisconnect` → lifecycle (§7); `onMsg` → mission channel
   (liaison only).
6. Resolve the `DeliverooClient`.

### Role gating

For a `'courier'` client, `onMissionMsg`/`say`/`ask`/`shout` throw
`Error('mission channel: liaison only')`. The methods stay on the interface (single
client shape, asymmetry as a `role` field — DESIGN §2.1 "identical loop, one
asymmetry"); the runtime guard prevents misuse. Courier code never wires the SDK
`onMsg` listener at all.

---

## 5. `GameConsts` derivation

The SDK `config` event yields `IOConfig = { CLOCK, PENALTY, AGENT_TIMEOUT,
BROADCAST_LOGS, GAME }`, where `GAME.parcels.decaying_event` and
`GAME.player.{movement_duration, observation_distance}` carry the fields we need.

`decaying_event` is a **clock-event string**, not a number. Conversion:

```
parseDecayEvent(ev: string, clockMs: number): number
  'infinite'        -> Infinity            // no decay
  'frame'           -> 1                    // decay every frame = 1 tick (valid SDK clock event)
  '1s'|'2s'|'5s'|'10s'|'1m'|'1h' -> eventMs(ev) / clockMs   // ticks per 1-point decay
  unknown           -> log warn, default to '1s' equivalent  // matches SDK parseClockEvent fallback
```

`eventMs`: `'1s'→1000, '2s'→2000, '5s'→5000, '10s'→10000, '1m'→60000, '1h'→3600000`.
With defaults (`decaying_event:'1s'`, `CLOCK:50`) ⇒ `PARCEL_DECAY_TICKS = 20`, exactly
DESIGN §5's `DECAY_INTERVAL_TICKS`. The wrapper does **only** this mechanical parse;
`utility.ts` computes `ρ = 1/PARCEL_DECAY_TICKS` and `λ` from it.

`PARCEL_DECAY_RAW` is kept alongside so downstream can distinguish a real interval
from `'infinite'` without re-deriving from `Infinity`.

---

## 6. Tick clock — anchor + interpolate

**Constraint discovered in the server submodule:** the server's `Clock` increments
its authoritative `frame` every `CLOCK` ms (default 50), but the client only *receives*
that frame number via the `ping` event, emitted on a **fixed 1000 ms interval**
(`PING_INTERVAL` in `ioServer.js`). The `sensing` event carries **no** frame, and
fires on a dirty flag (material change), not as a heartbeat. So neither `ping` alone
(too coarse: ~20 ticks between updates) nor a sensing-event counter (diverges across
the two agents) gives a correct per-tick, cross-agent clock.

**Resolution — anchor on `ping`, interpolate with wall time:**

```ts
// state
let anchorFrame = 0
let anchorWallMs = Date.now()

// on socket 'ping' ({ frame, roundTrip })
anchorFrame = ping.frame
anchorWallMs = Date.now()

// pure, exported
export function tickFrom(anchorFrame: number, anchorWallMs: number, nowMs: number, clockMs: number): number {
  return anchorFrame + Math.floor((nowMs - anchorWallMs) / clockMs)
}

// client.tick()
tick() { return tickFrom(anchorFrame, anchorWallMs, Date.now(), consts.CLOCK) }
```

Properties:

- **Server-authoritative**: anchored to the real server frame every second.
- **Per-tick resolution**: interpolation fills the gap between pings.
- **Bounded drift**: error resets to ~0 on every ping; max independent drift < 1 s
  (~20 ticks) and self-corrects — well within the staleness/fresh decay tolerances of
  DESIGN §5.3.
- **Cross-agent comparable**: both agents re-anchor to the *same* server frame each
  second, so blackboard `lastSeen` stamps from the two agents stay on one clock
  (DESIGN §2.3 shared belief base).

`tick()` is read on demand and stamped onto each `PerceptionSnapshot` at emit time.

Before the first `ping`, `tick()` returns `anchorFrame (0) + elapsed-since-connect`
— a local estimate; it is corrected on the first ping (within 1 s of connect).

---

## 7. Data flow & lifecycle

```
startup:
  connect(config, role, logger)
    → DjsConnect(host, token)
    → await { me, config, map }
    → GameConsts ← IOConfig         (§5)
    → wire listeners
    → resolve DeliverooClient

runtime:
  socket 'ping'    → re-anchor tick                                   (§6)
  socket 'sensing' → normalizeSensing(IOSensing, self, tick())
                     → PerceptionSnapshot → onPerception(cb)
  socket 'you'     → update cached self position used by next snapshot
  socket 'msg'     → onMissionMsg(cb)                                 (liaison only)
  BDI → client.move()/pickup()/putdown() → SDK emit* → typed Promise

reconnect (socket.io built-in auto-reconnect):
  'disconnect' → onDisconnect(reason) cb
  'connect' (re)  → server resends you/config/map and resumes sensing
  wrapper re-fires onConnect, and on the next sensing emits a fresh full
  PerceptionSnapshot → triggers blackboard cold-start re-snapshot (DESIGN §2.3:
  "on (re)connection ... a one-time full snapshot; the stream then continues as
  deltas"). Tick re-anchors on the next ping.
```

The wrapper relies on socket.io's built-in reconnection (no custom retry loop). It
holds **no** perception state across a reconnect — the fresh snapshot is reconstructed
from the server's resent `you`/`map` plus the next `sensing`.

`self` position: `sensing` reports other entities, while own position arrives via
`you`. The wrapper keeps the **latest `you`** as the source for `snapshot.self` and
folds it into each emitted snapshot. This is the one tiny piece of transient state the
wrapper holds, and it is transport bookkeeping, not a belief cache.

---

## 8. Error handling

- **Normalizers are the trust boundary.** Unknown tile char → `warn`, treat as
  `wall`. Malformed sensing record (missing id/coords) → drop *that* record, keep the
  rest, `warn`. The snapshot is always well-typed downstream.
- **Action results vs errors.** `move` resolving `false` is a normal game outcome
  (blocked move), returned verbatim — *not* thrown. The SDK's `emitAndResolveOnAck`
  has a 1 s ack timeout; if an action Promise rejects (timeout/disconnect), the
  rejection propagates to the BDI caller to handle (re-plan / retry next tick). The
  wrapper does not swallow it.
- **Logging.** The wrapper receives a Pino child logger (`module:'external'`) and uses
  it exclusively. **No `console.log` anywhere** (CLAUDE.md observability mandate).
  Logged events: connect/disconnect/reconnect (`info`), tick re-anchor drift if
  >2 ticks (`debug`), normalizer drops (`warn`), action rejections (`warn`).

---

## 9. Testing

**Unit (bun test, no socket) — the bulk.** All risky logic is in pure exported
functions:

- `normalizeSensing(io, self, tick)` → snapshot mapping; agents without position
  dropped; `carriedBy` `undefined`→`null`.
- `normalizeTile(ioTile)` → every tile-type char, directional arrows → `dir`,
  unknown → `wall` + warn.
- `parseDecayEvent(ev, clock)` → each clock-event string, `'infinite'`→`Infinity`,
  unknown→`'1s'` fallback.
- `tickFrom(anchorFrame, anchorWallMs, now, clock)` → interpolation math, including
  exact-boundary and pre-first-ping cases.
- Role gating: a `'courier'` client throws on `say`/`onMissionMsg`/`ask`/`shout`.

**Fake-socket test.** A minimal `EventEmitter` stub satisfying the `.d.ts` surface
drives `connect()` end to end: resolves the `me`/`config`/`map` promises, emits a
`sensing`, asserts `onPerception` fires a correctly-shaped, correctly-ticked snapshot.
No live server.

**Out of scope here.** Live-server integration and the 15-example mission scenario
suite (DESIGN §11/§14) are separate efforts.

---

## 10. Decisions locked (from brainstorming)

| Decision | Choice |
|----------|--------|
| Scope | Transport + normalize + tick; no belief state |
| Tick source | `ping.frame` anchored, wall-time interpolated, re-anchored every 1 s |
| Action model | Thin typed async methods; BDI owns sequencing |
| Type boundary | Ambient `.d.ts` SDK stub + project-owned domain types |
| Role split | One `connect(config, role)` factory; mission channel role-gated |
| Lifecycle | socket.io auto-reconnect; wrapper re-emits fresh snapshot on reconnect |
| `GameConsts` | Wrapper does mechanical `decaying_event`→ticks parse; utility owns ρ/λ |

---

## 11. Open items

None blocking. `GameConsts` field sourcing resolved against the server submodule
config (`config/config.js`): `CLOCK` top-level, `parcels.decaying_event`,
`player.movement_duration`, `player.observation_distance`.
