# BDI core — design

**Date:** 2026-06-14
**Scope slice:** solo playable agent
**Status:** approved for planning

## 1. Goal & scope

Turn the existing belief base + blackboard into an agent that actually plays Deliveroo: perceive → update beliefs → score candidate intentions in points/tick → emit one concrete action per tick. This is the `src/bdi/` layer (`loop`, `intentions`, `utility`, plus `route` and `params`) and a new `src/planning/astar.ts`, wired into the two agent workers.

**In scope:**
- Push-aware A* pathfinding (DESIGN §15 safety layer) — the `d(·,·)` every utility term consumes.
- The unified utility model (§5): ρ/λ constants, `Rnow`, `Psurv`, `raceDiscount`, `P_avail`, the `V` kernel, `deliverBundle`, value-aware zone selection.
- Greedy multi-pickup route assembly (§9.2): `bestInsert`, emergent horizon, per-insertion zone recompute.
- The execution selector (§9.9) over three candidates — `U_route`, `U_explore`, `U_idle` — with commitment hysteresis (§5.6).
- Stalest-frontier exploration (an approximation of §5.5 `U_explore`).
- Per-tick loop wiring into `courier.ts` / `liaison.ts`; first action emission.
- YAML-file hyperparameter loading.

**Out of scope (deferred):**
- The SSI marginal-route auction (§9.3) and global rebalance (§9.6). Two BDI agents run independently and share beliefs, but do not coordinate claims yet. Consequence: they may contend for the same parcel until the auction lands (see §6, Known gaps).
- Missions and contracts (§3/§4/§8). `U_mission` is absent from the candidate set; the selector reserves the slot.
- Constraints (§7) — tolls and absolute filters arise only with missions, so `toll ≡ 0` (A* is a pure tick count) and `ū_forgone` is not needed this slice.
- Reward shapers (§6) — `m ≡ g ≡ 1`; the shaper hooks exist in `V`/`deliverBundle`/`bestZone` but are inert.
- Inter-agent push coordination (§15.3): spatio-temporal reservations + lower-id push priority. No partner to deconflict with in solo play; the planned-push list is returned anyway so the field exists when the partner arrives.
- The full region model for exploration (§5.5) — replaced by a stalest-frontier heuristic with an identical selector interface.
- Aggressive `d(·,·)` caching/invalidation (§5.1) — recompute per call within budget.

## 2. Module layout & data flow

```
src/
  planning/
    astar.ts        # push-aware A*; d(a,b)=tick length, firstStep, planned pushes
  bdi/
    params.ts       # Params interface, DEFAULT_PARAMS, loadParams(yaml)
    utility.ts      # ρ/λ, Rnow, Psurv, raceDiscount, P_avail, V kernel, deliverBundle, bestZone, U_*
    route.ts        # greedy assembly: bestInsert, emergent-horizon extend, zone recompute, U_route
    intentions.ts   # Intention union + argmax selector with commitment hysteresis (§9.9)
    loop.ts         # per-tick orchestration: perceive → update → select → act
  agents/
    courier.ts      # WIRE: connect, bootstrap on first perception, drive loop, route a2a→blackboard
    liaison.ts      # WIRE: same BDI core (mission lane idle this slice)
config/
  params.yaml       # user-edited hyperparameters (DESIGN §5.8)
```

Per-tick data flow (one agent):

```
perception ──▶ BeliefBase.foldPerception(snap)          [existing]
                     │
                     ▼
            Blackboard.onTick(tick)                      [existing — ships delta/heartbeat]
                     │
                     ▼
   loop: refresh frozen route on trigger (greedy bestInsert, §9.2)  ── uses astar.d()
                     │
                     ▼
   intentions.select({U_route, U_explore, U_idle}) ×(1+h_commit)^committed
                     │
                     ▼
   derive next action ──▶ client.move / pickup / putdown
                     │
                     ▼
   apply own action to beliefs (applyPickup/Delivery/Drop)  [existing]
```

### Boundaries

- `astar.ts` is the **only** module that knows about crates, walls, one-ways. Everyone upstream consumes a tick count `d` and a first-step direction.
- `utility.ts` is **pure**: beliefs + consts + params + `d` in, points/tick out. No I/O, no game client.
- `route.ts` is **pure**: builds and scores routes from beliefs + `d` + utility.
- `intentions.ts` is **pure**: candidate list + current commitment in, chosen intention out.
- `params.ts` owns file load + validation; the rest of `bdi/` receives a resolved `Params`.
- `loop.ts` is the only stateful/effectful piece: holds the committed intention + frozen route, calls the client, mutates beliefs via own-action methods.

## 3. `planning/astar.ts` — push-aware A* (§15 safety layer)

**Startup (once):** `buildGrid(map: Tile[]) → Grid` — static per-tile type, walkability, one-way direction. Walls blocked; one-ways are directed edges (enter only along `dir`); walkable/spawner/delivery/base/slide passable; crateSpawner passable when crate-free.

**Per call (live state):**
```ts
type Dir = 'up'|'down'|'left'|'right'
type Step =
  | { kind:'move'; dir:Dir }
  | { kind:'push'; dir:Dir; crateId:string }   // agent steps onto the crate's tile; crate slides one tile beyond
interface PlannedPush { crateId:string; from:Pos; to:Pos; tickOffset:number }
interface PathResult {
  reachable:boolean
  L:number                 // tick length; Infinity if unreachable
  firstStep:Step | null    // null iff already at goal
  pushes:PlannedPush[]      // pushes along the chosen path
}
function planPath(grid, crates, agents, from, to, budgetMs): PathResult
function d(grid, crates, agents, from, to, budgetMs): number   // = planPath(...).L
```
`crates` and `agents` are read from the live belief base on each call.

**Search.** A* on a 4-connected grid, Manhattan heuristic (admissible — one-ways and pushes only ever raise true cost). A move edge costs 1 tick. When a neighbour tile holds a crate, generate a **push edge** (also 1 tick) iff the push is admissible per §15.1, evaluated against live state:

1. **Game precondition** — the tile beyond the crate (same direction) is type-5 (slide / crateSpawner), **unlocked**, and **crate-free**. A crate-against-crate push is never attempted (front crate treated as a wall).
2. **No agent on the destination** — read `beliefs.agents` for the beyond-tile.
3. **Connectivity preserved** — flood-fill on the post-push grid keeps the *protected set* mutually reachable. Protected set (solo) = `self`, every delivery zone, every known parcel. Opening pushes always pass; only pushes that would cut off a currently reachable protected member are rejected.

**Anytime budget (§15.3).** `push_plan_budget_ms` per call. The per-candidate connectivity flood-fill is the cost; on timeout, drop push expansion and re-run plain A* (**crates-as-walls** fallback) — always a safe, plannable state.

**Execute-time revalidation (§15.2) lives in `loop.ts`, not here.** `astar.ts` only *plans*. Before the loop emits a push as the tick's action, it re-checks §15.1 against live beliefs; if now inadmissible (an agent stepped onto the destination, the crate already moved), it replans / treats the crate as a wall. Projection never authorizes execution.

**Deferred (solo):** inter-agent reservations + lower-id push priority (§15.3). `pushes[]` is populated regardless so the multi-agent layer can consume it later.

## 4. `bdi/utility.ts` — derived quantities & scoring (§5)

All pure. Decay constants are derived once from `GameConsts` (§5.2/5.3), **not** user knobs:
```
DECAY_INTERVAL_TICKS = PARCEL_DECAY_TICKS
ρ        = (MOVEMENT_DURATION / CLOCK) / DECAY_INTERVAL_TICKS
λ        = ln2 / (3 · DECAY_INTERVAL_TICKS)
λ_agent  = ln2 / 3
```

Derived-on-read quantities (beliefs store facts-as-observed; these compute live):
- `Rnow(p, tnow) = max(0, rewardSeen − ρ·age)` (§5.2)
- `Psurv(p, dSelfP, tnow) = exp(−λ·(age + dSelfP))` (§5.3)
- `grab(enemy, p, dSelf, dEnemy, tnow)` with `fresh(a)=exp(−λ_agent·age)`, combined over **enemies only** into `raceDiscount(p)` (§5.3)
- `P_avail(p) = Psurv · raceDiscount`; hard `0` if `carriedBy ≠ null` (carried parcels are off the table, including partner-carried)
- `V(S, z, L) = g(z)·m(|S|)·Σ max(0, Rnow(i) − ρ·L)` (§5.4). Shapers `m`, `g` are parameters, fixed at the identity maps this slice.
- `deliverBundle(carried, tile, tnow) → S*` — sort carried by `Rnow` desc, take all with `Rnow>0` (the `m≡1` case; tiered subset search stubbed for when shapers land) (§6.1)
- `bestZone(S, from, reachableZones, tnow) → z*` — §6.0 travel-decayed argmax `V(S,z,d(from,z)) / (d(from,z)+1)`
- `U_deliver`, `U_collect(p)`, `U_explore(r)`, `U_idle` (§5.5). `U_route` is defined in `route.ts` but reuses these.

**`reachableZones`** = delivery tiles with finite `d` from `from`; a `g=0` zone drops out (inert this slice).

## 5. `bdi/route.ts` — greedy multi-pickup assembly (§9.2)

```ts
interface Route {
  pickups: string[]      // ordered parcel ids to collect
  zone: Pos              // chosen delivery tile (z*)
  delivered: string[]    // carried ∪ pickups (the delivered set)
  L: number              // total tick length self → q1 → … → qn → zone
}
U_route(route) = V(delivered, zone, L) / (L+1)^α        // tollSum = 0 this slice
```

- **`bestInsert(route, p)`** — try `p` in each of the `n+1` pickup gaps; for each placement **recompute `zone` from the tail `qn`** (§6.0, measured from the departure point, not `self`); compute `L`; keep the (gap, zone) maximizing `U_route`. Per-gap detour `ΔL_i = d(q_{i-1},p) + d(p,q_i) − d(q_{i-1},q_i)`, each `d` from `astar`.
- **`buildRoute(carried, pool, self, tnow)`** — start with a length-0 route (deliver `carried` at `bestZone`). Emergent horizon: repeatedly fold the pool parcel whose `bestInsert` most raises `U_route`, while `U_route(extended) > U_route(current)` (≡ `U_collect(next) > U_deliver`). Stop when no pool parcel improves it. `pool` = pickable parcels with `P_avail>0`, not carried. `P_surv` pre-discounts far pickups, so it terminates in a few iterations.
- Returns a `Route` (length-0 = pure deliver) or `null` when carrying nothing **and** no reachable pool parcel → no route candidate this tick.

## 6. `bdi/intentions.ts` — execution selector (§9.9)

```ts
type Intention =
  | { kind:'route';   route:Route }
  | { kind:'explore'; target:ExploreTarget }
  | { kind:'idle' }
  // | { kind:'mission'; … }  ← slot reserved, not built this slice
type Candidate = { intention:Intention; U:number }

select(cands:Candidate[], committed:Intention|null, p:Params): Intention
//  argmax  U · (1 + h_commit)^[matches(committed)]   subject to U > 0
```

- `matches(committed, cand)` = commitment identity: same route **head pickup** (or same delivery zone for a length-0 route), same explore target, `idle ≡ idle`. Grants the active intention the `h_commit` (15%) anti-thrash bonus (§5.6).
- `U>0` filter plus a caller-supplied plan-validity prune (route head still exists/reachable) drop a commitment gone bad.
- A `{ idle, ε_idle }` floor is always present, so the candidate set is never empty.

`loop.ts` assembles the candidates: `U_route` from `buildRoute`, `U_explore` from the stalest-frontier target, `U_idle`; `select` ranks them.

### Exploration — stalest-frontier heuristic

`ExploreTarget` is the reachable spawner tile / cluster maximizing `spawnValue · staleness`, where `staleness` is the mean `age` from `lastSeen` stamps and `spawnValue` is an a-priori weight from the map's spawner density. No formal region partition; operates over spawner tiles directly. The `U_explore` selector interface is identical to the §5.5 region model, so regions can be swapped in later without touching `intentions.ts`.

### Known gaps (accepted for this slice)

- **No auction.** Two BDI agents both score a shared parcel freely (partner isn't a competitor in `raceDiscount`, and no claims exist yet). They may contend until §9.3 lands. Acceptable for "solo playable".

## 7. `bdi/loop.ts` — orchestration & action emission

The only stateful/effectful module. Holds: `Blackboard` (→ beliefs), `Grid`, `client`, `Params`, current `committed:Intention`, frozen `route`, an in-flight guard, logger.

Per perception tick `loop.tick(snap)`:
1. `beliefs.foldPerception(snap)` → `blackboard.onTick(tick)` *(both existing)*.
2. **Route:** keep the **frozen** route (§9.9) unless a trigger fires — a material belief change (new/lost parcel in the pool or route) or plan invalid (head gone/unreachable) → `buildRoute(...)`. Else advance the frozen route. (Solo has no replica to agree with; freezing is purely for `h_commit` stability.)
3. Build candidates `{route, explore, idle}`, prune invalid, `select(...) → chosen`.
4. **Chosen → action:**
   - `route`: on the head pickup tile → `pickup()`; at `zone` with pickups exhausted → `deliverBundle` → `putdown(S*)`; else `firstStep` toward the head. If `firstStep.kind==='push'` → **re-validate §15.1 against live beliefs**; admissible → `move(dir)`, else replan (rebuild / crate-as-wall).
   - `explore`: first step toward the target (dispersion nudge §9.5 deferred — solo).
   - `idle`: hold position.
5. Apply own action back to beliefs: `applyPickup` / `applyDelivery` / `applyDrop` *(existing)* — self-replicates via the next `onTick`.
6. `committed = chosen`. Log the intent switch at `info {from, to, uFrom, uTo, tick}`; log tick duration at `debug {durationMs}` (CLAUDE.md tracing discipline). In-flight guard: one action per tick; skip if a `move`/`pickup`/`putdown` promise is still pending.

### Agent wiring (`courier.ts` / `liaison.ts`)

On `init`: `connect()` (`consts` + `map` available immediately). **Bootstrap `BeliefBase` + `Blackboard` + `Loop` lazily on the first `PerceptionSnapshot`** (needs `snap.self`). Then:
- `client.onPerception(snap → loop.tick(snap))`
- `client.onConnect(() → blackboard.hello(tick))`
- inbound `a2a` envelope → `blackboard.receive(msg)`

Both workers run the **identical** loop; the liaison's mission lane simply stays idle. `main.ts` / `relay.ts` already spawn the workers and relay blackboard deltas between them.

## 8. `bdi/params.ts` + `config/params.yaml` — hyperparameters (§5.8)

`Params` holds only the free hyperparameters — `alpha`, `beta_comp`, `theta_explore`, `kappa_info`, `h_commit`, `eps_idle`, `push_plan_budget_ms`. ρ/λ/λ_agent are derived from `GameConsts`, not knobs.

```ts
DEFAULT_PARAMS: Params                       // code = source of truth, §5.8 values
loadParams(path='config/params.yaml'): Params
//  read file → YAML.parse → deep-merge over DEFAULT_PARAMS → range-validate → Params
//  missing file or missing keys → defaults (partial files fine); out-of-range → throw loud
```

`config/params.yaml` (committed, user-edited, commented):
```yaml
# BDI hyperparameters (DESIGN §5.8). Edit values; omit a key to take its default.
alpha: 1.0           # rate exponent (1 = pure points/tick)
beta_comp: 0.7       # belief a closer enemy grabs a contested parcel  [0..1]
theta_explore: 0.3   # exploration weight (below real value, above idle)
kappa_info: 0.1      # info bonus per unit staleness
h_commit: 0.15       # commitment anti-thrash bonus  [>=0]
eps_idle: 0.001      # idle floor
push_plan_budget_ms: 8   # anytime push-search budget per call
```

**Flow:** `main.ts` calls `loadParams()` once at startup and adds the resolved `Params` to the worker `init` envelope (alongside `Config`); each worker threads it into `Loop`. Parsed once, shipped to both workers, so the two agents are guaranteed identical params.

**Precedence:** `DEFAULT_PARAMS` (fallback for omitted keys) < `config/params.yaml` (user edits). The §16 calibration harness either writes a `params.yaml` variant per sweep point or passes an alternate path to `loadParams(path)` — no recompile either way.

**New dependency:** `yaml` (^2) — Bun parses TOML/JSON natively but not YAML. `.env`/`Config` are untouched (connection + secrets + logging only).

## 9. Testing (TDD, `bun test`)

- **`astar`:** open-grid Manhattan; wall detour; one-way directed edge; crate-as-wall; admissible push opens a path; connectivity-cut push refused → detour/unreachable; budget timeout → crates-as-walls. Hand-built fixture maps.
- **`utility`:** `Rnow` / `Psurv` / `raceDiscount` / `P_avail` numeric vs formulas; `V` kernel; `bestZone` §6.0 check (near beats far high-multiplier after decay); `deliverBundle` `S*`.
- **`route`:** cheapest-gap insertion; emergent horizon terminates; length-0 deliver; pool `P_avail` filter.
- **`intentions`:** argmax; `h_commit` flips a near-tie toward the committed intention; `U>0` + idle floor.
- **`params`:** defaults when file absent; partial file merges over defaults; out-of-range throws.
- **`loop`:** fake `DeliverooClient` (the interface is already abstract) + scripted perceptions → pickup-on-tile, deliver-at-zone, explore-when-empty, stale-push-refused.
