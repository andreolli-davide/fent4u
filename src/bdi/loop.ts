// src/bdi/loop.ts
import type { DeliverooClient } from '../external/deliveroo.js'
import type { PerceptionSnapshot, Pos, Tile } from '../types/perception.js'
import { BeliefBase, type ParcelBelief, type AgentBelief } from '../blackboard/beliefs.js'
import { buildGrid, buildObstacles, planPath, isPushAdmissible, type Grid, type PlanCtx, type Dir } from '../planning/astar.js'
import { decayConsts, pAvail, deliverBundle, tileKey, type DecayConsts, type EnemyThreat } from './utility.js'
import { buildRoute, uRoute, routeFromClaims } from './route.js'
import { select, chooseExplore, matches, type Intention, type Candidate } from './intentions.js'
import type { Params } from './params.js'
import { ClaimStore, type ClaimMsg, type Claim } from '../coordination/claims.js'
import { runAuction, type AgentSnap } from '../coordination/auction.js'
import { runRebalance, type RebalanceAgent } from '../coordination/rebalance.js'
import type { A2AMessage, AgentId } from '../types/a2a.js'
import { uMission } from './mission-intention.js'
import { DeliveryRateTracker } from './rate-tracker.js'
import type { TeamMissionView } from '../mission/view.js'

type LogFn = {
  info: (obj: Record<string, unknown>, msg?: string) => void
  debug: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
}

export class BdiLoop {
  private readonly grid: Grid
  private readonly dc: DecayConsts
  private readonly spawners: Pos[]
  private readonly rateTracker: DeliveryRateTracker
  private readonly seenAt = new Map<string, number>()
  private beliefs: BeliefBase | null = null
  private committed: Intention | null = null
  private committedU = 0
  private acting = false
  private lastRebalanceTick = -Infinity
  private prevOwnClaims = 0 // own-claim count last tick — for the route-finished falling edge (§9.6)
  private prevSelf: Pos | null = null // self pos folded last tick == value last shipped to partner; the SHARED self pos for coordination (§9.7)

  constructor(
    private readonly client: DeliverooClient,
    private readonly params: Params,
    private readonly log: LogFn,
    private readonly claims: ClaimStore = new ClaimStore(),
    private readonly coord?: { partner: AgentId; send: (msg: A2AMessage) => void },
    private readonly mission?: { view: TeamMissionView; pursue: boolean; onSatisfied?: () => void },
  ) {
    this.grid = buildGrid(client.map)
    this.dc = decayConsts(client.consts)
    this.spawners = client.map.filter((t: Tile) => t.type === 'spawner').map((t) => t.pos)
    this.rateTracker = new DeliveryRateTracker(params.rate_window, params.rate_bootstrap)
  }

  /**
   * Drive one perception tick → at most one action. Skips if an action is in flight.
   * `partnerAlive` is the CHANNEL-liveness signal (heartbeat-backed; Blackboard.partnerAlive).
   * It is the authority for §9.7/§11 degradation — see the partner block below for why the
   * partner's agent-belief `lastSeen` must NOT be used for this. Defaults to alive so solo
   * callers/tests (no Blackboard) degrade purely on partner-belief absence.
   */
  async tick(snap: PerceptionSnapshot, partnerAlive = true): Promise<void> {
    if (this.acting) {
      this.log.debug({ tick: snap.tick }, 'tick skipped — action in flight')
      return
    }
    const t0 = performance.now()
    if (this.beliefs === null) this.beliefs = new BeliefBase(snap.self, this.client.consts, this.client.map)
    const beliefs = this.beliefs
    beliefs.foldPerception(snap)
    this.markSeen(snap.self.pos, snap.tick)

    const tnow = snap.tick
    const self = beliefs.self.pos
    const ctx = this.planCtx(beliefs)
    // Per-tick memo: ctx is fixed for the tick, and route/auction/rebalance/explore all
    // re-query the same (a,b) pairs many times (bestInsert is O(n²) in dist calls). Keyed
    // by ordered (a,b) — planPath is directional (push asymmetry, tolls), so never symmetric.
    const distMemo = new Map<string, number>()
    const dist = (a: Pos, b: Pos): number => {
      const k = `${a.x},${a.y}|${b.x},${b.y}`
      const hit = distMemo.get(k)
      if (hit !== undefined) return hit
      const L = planPath(this.grid, ctx, a, b).L
      distMemo.set(k, L)
      return L
    }

    // §9.7: coordination (auction/rebalance/pool) must read SHARED state only. The only
    // private leak is our OWN position — partner pos already comes from shared beliefs.
    // prevSelf is last tick's self = the value last shipped to the partner, so both
    // replicas auction over the identical (self_{t-1}, partner_{last-seen}) pair.
    const sharedSelf = this.prevSelf ?? self

    // ── coordination (§9.3/§9.6/§9.7) ──
    // 1. liveness: expire own stuck claims (distOf reads live d from this agent)
    const dropped = this.claims.expire(tnow, (c) => {
      const p = beliefs.parcels.get(c.parcelId)
      return p ? dist(self, p.pos) : Infinity
    }, this.params.claim_ttl, this.client.role)
    for (const c of dropped) this.broadcast({ kind: 'release', parcelId: c.parcelId, epoch: tnow })

    if (this.coord) {
      const me = this.client.role
      // §9.7: resolve the partner by belief `rel`, NOT by `coord.partner`. The agents map is
      // keyed by SERVER agent id (UUID, from perception / self-broadcast); `coord.partner` is the
      // ROLE label ('liaison'|'courier'). A role-keyed get() always misses → partner wrongly null →
      // degraded-solo flap. There is exactly one teammate (2-agent team), so rel==='partner' is unique.
      const partner = this.partnerBelief(beliefs)
      // §9.7/§11 degradation keys off CHANNEL liveness (partnerAlive, heartbeat-backed), NOT
      // the partner's agent-belief lastSeen. The belief only advances on self-bearing deltas —
      // ticks where the partner FOLDS perception — so it freezes while the partner executes a
      // (multi-tick interpolated) action, during which it heartbeats instead of delta-ing. Keyed
      // off the belief, the loop would declare the partner lost every partner_lost_ticks and
      // flap (reclaim → action completes → recover → repeat). Degraded ⇔ channel dead OR partner
      // never seen. On degrade, drop its soft AUCTION claims so we reclaim its parcels and play
      // solo (region ownership). MISSION locks survive.
      const partnerLive = partnerAlive && partner !== null
      if (!partnerLive) {
        const reclaimed = this.claims.dropForeignAuctionClaims(me)
        if (reclaimed.length > 0) this.log.info({ tick: tnow, count: reclaimed.length, partner: this.coord.partner }, 'partner lost — reclaimed soft claims')
      }
      // build both agent snapshots from shared beliefs
      const carried = beliefs.self.carrying.map((id) => beliefs.parcels.get(id)).filter((p): p is ParcelBelief => p !== undefined)
      const meSnap: AgentSnap = { id: me, pos: sharedSelf, carried, claimed: this.claimedParcels(beliefs, me) }
      const partnerSnap: AgentSnap = partnerLive && partner
        ? { id: this.coord.partner, pos: partner.pos, carried: this.carriedOf(beliefs), claimed: this.claimedParcels(beliefs, this.coord.partner) }
        : { id: this.coord.partner, pos: self, carried: [], claimed: [] } // degraded: no partner bids
      const enemies = [...beliefs.agents.values()].filter((a) => a.rel === 'enemy')
      const { pool } = this.buildPool(beliefs, sharedSelf, tnow, dist)
      // 2. auction the unclaimed pool (deterministic; commit full allocation)
      const agents: [AgentSnap, AgentSnap] = me < this.coord.partner ? [meSnap, partnerSnap] : [partnerSnap, meSnap]
      const alloc = runAuction({ pool, agents, enemies, zones: this.grid.deliveryZones, dist, dc: this.dc, params: this.params, tnow, epoch: tnow, budgetMs: this.params.auction_budget_ms })
      // §9.3/Lever B: commit & broadcast the FULL allocation (claims for BOTH agents),
      // not just our own wins. Under any residual input divergence a parcel one replica
      // assigns to the partner would otherwise be committed by neither → orphaned. The
      // same-epoch / lower-id conflict rule (claims.ts) reconciles disagreements to one
      // owner within ≤1 tick (DESIGN §9.3). originD/lastD use the winner's SHARED pos
      // (sharedSelf for me, partnerSnap.pos for the partner) — both are shared state, so
      // the claim is identical on both replicas.
      for (const [parcelId, winner] of alloc) {
        // Degraded mode (partner not live → partnerSnap is a phantom at our own pos): do NOT
        // materialize the phantom's wins as claims — that would exclude those parcels from
        // our own pool and strand them. Solo survivor keeps own wins only (pre-Lever-B
        // behaviour). When the partner is live, commit the FULL allocation (Lever B).
        if (winner !== me && !partnerLive) continue
        const p = beliefs.parcels.get(parcelId)! // safe: pool ⊆ beliefs.parcels, parcels not mutated between buildPool and here
        const winnerPos = winner === me ? sharedSelf : partnerSnap.pos
        const d = dist(winnerPos, p.pos)
        const claim: Claim = { parcelId, agentId: winner, origin: 'AUCTION', epoch: tnow, commitTick: tnow, originD: d, lastD: d, lastProgressTick: tnow }
        this.claims.add(claim)
        this.broadcast({ kind: 'claim', claim })
      }
      // 3. periodic rebalance, or on the tick the route JUST finished (§9.6: "whenever an
      //    agent finishes its route"). Use the falling edge (had claims → now none), NOT a
      //    level test on emptiness — the latter re-runs the rebalance (and its A* recompute)
      //    every idle tick and can oscillate swaps when margins flip sign tick-to-tick.
      const ownCount = this.claims.ownClaims(me).length
      const routeJustFinished = ownCount === 0 && this.prevOwnClaims > 0
      if (tnow - this.lastRebalanceTick >= this.params.rebalance_period || routeJustFinished) {
        this.lastRebalanceTick = tnow
        const ra: [RebalanceAgent, RebalanceAgent] = [
          { id: agents[0].id, pos: agents[0].pos, carried: agents[0].carried, claimed: agents[0].claimed },
          { id: agents[1].id, pos: agents[1].pos, carried: agents[1].carried, claimed: agents[1].claimed },
        ]
        const swaps = runRebalance({ agents: ra, claims: [...this.claims.ownClaims(me), ...this.claims.ownClaims(this.coord.partner)], enemies, zones: this.grid.deliveryZones, dist, dc: this.dc, params: this.params, tnow, epoch: tnow })
        for (const s of swaps) {
          this.claims.applyMsg({ kind: 'swap', parcelId: s.parcelId, toAgent: s.toAgent, epoch: tnow }, me)
          this.broadcast({ kind: 'swap', parcelId: s.parcelId, toAgent: s.toAgent, epoch: tnow })
        }
      }
      this.prevOwnClaims = this.claims.ownClaims(me).length // post-coordination count for next tick's edge
    }

    // candidates
    const carried = beliefs.self.carrying.map((id) => beliefs.parcels.get(id)).filter((p): p is ParcelBelief => p !== undefined)
    const { pool, weight } = this.buildPool(beliefs, self, tnow, dist)
    // Pickups weight their P_avail (survival × race); carried parcels are in hand ⇒ 1 (§5.5).
    const weightOf = (p: ParcelBelief): number => weight.get(p.id) ?? 1
    const ownClaimed = this.claims.ownClaims(this.client.role)
      .map((c) => beliefs.parcels.get(c.parcelId))
      .filter((p): p is ParcelBelief => p !== undefined && p.carriedBy === null)
    // Coordinated: the auction is the sole authority on what I own, so the route is derived
    // ONLY from my committed claims (§9.7) — never opportunistically grab a parcel the team
    // auction declined (emergent horizon) or merely hasn't bid yet this tick (anytime, §9.3:
    // leftover pool waits for the next tick). Solo (no partner channel): no auction runs, so
    // fall back to greedy buildRoute over the pool to still pursue visible parcels.
    const route = this.coord
      ? routeFromClaims(carried, ownClaimed, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf)
      : ownClaimed.length > 0 || carried.length > 0
        ? routeFromClaims(carried, ownClaimed, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf)
        : buildRoute(carried, pool, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf)
    const cands: Candidate[] = []
    if (route !== null) cands.push({ intention: { kind: 'route', route }, u: uRoute(route, tnow, this.dc, this.params, weightOf) })
    let partnerTarget: Pos | null = null
    if (this.coord) {
      const partner = this.partnerBelief(beliefs)
      const pClaims = this.claimedParcels(beliefs, this.coord.partner)
      const pRoute = (partner !== null && pClaims.length > 0)
        ? routeFromClaims(this.carriedOf(beliefs), pClaims, partner.pos, this.grid.deliveryZones, tnow, this.dc, this.params, dist)
        : null
      partnerTarget = pRoute?.pickups[0]?.pos ?? partner?.pos ?? null
    }
    const dRef = this.grid.w + this.grid.h
    const ex = chooseExplore(this.spawners, this.seenAt, self, tnow, dist, this.params, partnerTarget, dRef)
    if (ex !== null) cands.push(ex)
    if (this.mission?.pursue) {
      const m = this.mission.view.current()
      if (m !== null) {
        const mc = uMission(m, self, dist, tnow, this.rateTracker.rhoRef(), this.params)
        if (mc !== null) cands.push(mc)
      }
    }
    cands.push({ intention: { kind: 'idle' }, u: this.params.eps_idle })

    const chosenCand = select(cands, this.committed, this.params.h_commit)
    const chosen = chosenCand.intention
    if (!matches(this.committed, chosen)) {
      this.log.info({ from: this.committed?.kind ?? 'none', to: chosen.kind, uFrom: this.committedU, uTo: chosenCand.u, tick: tnow }, 'intent switch')
    }
    this.committed = chosen
    this.committedU = chosenCand.u

    await this.act(chosen, beliefs, ctx, tnow)
    this.prevSelf = self // recorded so that if blackboard.onTick ships self this tick, both replicas share the same value next tick
    this.log.debug({ durationMs: performance.now() - t0, tick: tnow }, 'tick')
  }

  /** Lazily construct (once) and return the shared belief base for the blackboard to replicate. */
  beliefBase(snap: PerceptionSnapshot): BeliefBase {
    if (this.beliefs === null) this.beliefs = new BeliefBase(snap.self, this.client.consts, this.client.map)
    return this.beliefs
  }

  private planCtx(beliefs: BeliefBase): PlanCtx {
    const obstacles = buildObstacles([...beliefs.crates.values()], [...beliefs.agents.values()])
    const protectedTiles: Pos[] = [
      beliefs.self.pos,
      ...this.grid.deliveryZones,
      ...[...beliefs.parcels.values()].filter((p) => p.carriedBy === null).map((p) => p.pos),
    ]
    return { obstacles, protectedTiles, budgetMs: this.params.push_plan_budget_ms }
  }

  /** Pickable parcels with P_avail>0, plus the per-parcel P_avail used to weight route value (§5.5). */
  private buildPool(beliefs: BeliefBase, self: Pos, tnow: number, dist: (a: Pos, b: Pos) => number): { pool: ParcelBelief[]; weight: Map<string, number> } {
    const enemies = [...beliefs.agents.values()].filter((a) => a.rel === 'enemy')
    const pool: ParcelBelief[] = []
    const weight = new Map<string, number>()
    const partnerClaimed = this.claims.partnerClaimed(this.client.role)
    for (const p of beliefs.parcels.values()) {
      if (p.carriedBy !== null) continue
      if (partnerClaimed.has(p.id)) continue // §9.4: partner-claimed ⇒ P_avail = 0 for me
      if (this.claims.claimedBy(p.id) === this.client.role) continue // own claim already committed — exclude from pool to prevent re-auction resetting originD
      const dSelfP = dist(self, p.pos)
      if (!Number.isFinite(dSelfP)) continue
      const threats: EnemyThreat[] = enemies.map((e) => ({ age: tnow - e.lastSeen, dToP: dist(e.pos, p.pos) }))
      const pa = pAvail(p, dSelfP, threats, this.params.beta_comp, tnow, this.dc)
      if (pa > 0) { pool.push(p); weight.set(p.id, pa) }
    }
    return { pool, weight }
  }

  private async act(chosen: Intention, beliefs: BeliefBase, ctx: PlanCtx, tnow: number): Promise<void> {
    if (chosen.kind === 'idle') return
    const self = beliefs.self.pos
    let goal: Pos
    let atGoalAction: 'pickup' | 'deliver' | null = null

    if (chosen.kind === 'explore') {
      goal = chosen.target.tile
    } else if (chosen.kind === 'mission') {
      const t = chosen.mission.params.targetTile
      // uMission only emits a candidate for a TEXT_BOUND target, so this is safe.
      if (t === undefined || t.tag !== 'TEXT_BOUND') return
      const target: Pos = { x: t.x, y: t.y }
      if (self.x === target.x && self.y === target.y) {
        this.mission?.onSatisfied?.()
        return
      }
      await this.stepToward(beliefs, ctx, self, target)
      return
    } else {
      const route = chosen.route
      if (route.pickups.length > 0) {
        goal = route.pickups[0].pos
        atGoalAction = 'pickup'
      } else {
        goal = route.zone
        atGoalAction = 'deliver'
      }
    }

    if (self.x === goal.x && self.y === goal.y) {
      if (atGoalAction === 'pickup') await this.doPickup(beliefs, tnow)
      else if (atGoalAction === 'deliver') await this.doDeliver(beliefs, goal, tnow)
      return
    }

    await this.stepToward(beliefs, ctx, self, goal)
  }

  private async stepToward(beliefs: BeliefBase, ctx: PlanCtx, self: Pos, goal: Pos): Promise<void> {
    let res = planPath(this.grid, ctx, self, goal)
    // Push-aware search hit its budget — NOT proof of unreachability. Re-plan with
    // crates-as-walls, the safe anytime fallback (§15.3), instead of giving up.
    if (res.timedOut) {
      res = planPath(this.grid, { ...ctx, cratesAsWalls: true }, self, goal)
    }
    if (res.firstStep?.kind === 'push') {
      const dir = res.firstStep.dir
      const cratePos = this.ahead(self, dir)
      if (!isPushAdmissible(this.grid, ctx, cratePos, dir)) {
        res = planPath(this.grid, { ...ctx, cratesAsWalls: true }, self, goal)
      }
    }
    if (res.firstStep === null) return
    this.acting = true
    try {
      await this.client.move(res.firstStep.dir as Dir)
    } finally {
      this.acting = false
    }
  }

  private async doPickup(beliefs: BeliefBase, tnow: number): Promise<void> {
    this.acting = true
    try {
      const got = await this.client.pickup()
      const ids = got.length > 0 ? got.map((g) => g.id) : [...beliefs.parcels.values()].filter((p) => p.pos.x === beliefs.self.pos.x && p.pos.y === beliefs.self.pos.y && p.carriedBy === null).map((p) => p.id)
      beliefs.applyPickup(ids)
      for (const id of ids) {
        if (this.claims.claimedBy(id) === this.client.role) {
          this.claims.remove(id)
          this.broadcast({ kind: 'release', parcelId: id, epoch: tnow })
        }
      }
    } finally {
      this.acting = false
    }
  }

  private async doDeliver(beliefs: BeliefBase, tile: Pos, tnow: number): Promise<void> {
    const carried = beliefs.self.carrying.map((id) => beliefs.parcels.get(id)).filter((p): p is ParcelBelief => p !== undefined)
    const bundle = deliverBundle(carried, tile, tnow, this.dc)
    const ids = bundle.set.map((p) => p.id)
    if (ids.length === 0) return
    this.acting = true
    try {
      await this.client.putdown(ids)
      beliefs.applyDelivery(ids)
      this.rateTracker.record(bundle.value, tnow)
    } finally {
      this.acting = false
    }
  }

  // Server convention (GAME_RULES.md §Movement): up = dy +1, down = dy -1.
  private ahead(p: Pos, dir: Dir): Pos {
    if (dir === 'up') return { x: p.x, y: p.y + 1 }
    if (dir === 'down') return { x: p.x, y: p.y - 1 }
    if (dir === 'left') return { x: p.x - 1, y: p.y }
    return { x: p.x + 1, y: p.y }
  }

  private markSeen(self: Pos, tick: number): void {
    const obs = this.client.consts.OBS_DISTANCE
    for (const s of this.spawners) {
      if (Math.abs(s.x - self.x) + Math.abs(s.y - self.y) <= obs) this.seenAt.set(tileKey(s), tick)
    }
  }

  private broadcast(msg: ClaimMsg): void {
    if (!this.coord) return
    this.coord.send({ from: this.client.role, to: this.coord.partner, type: 'claims', payload: msg })
  }

  /** Parcels claimed by `who` that are present and not yet picked, as ParcelBeliefs. */
  private claimedParcels(beliefs: BeliefBase, who: AgentId): ParcelBelief[] {
    return this.claims.ownClaims(who)
      .map((c) => beliefs.parcels.get(c.parcelId))
      .filter((p): p is ParcelBelief => p !== undefined && p.carriedBy === null)
  }

  /** Parcels the partner is carrying (per its self-broadcast). Partner resolved by rel, not role. */
  private carriedOf(beliefs: BeliefBase): ParcelBelief[] {
    const ag = this.partnerBelief(beliefs)
    const ids = ag?.carrying ?? []
    return ids.map((id) => beliefs.parcels.get(id)).filter((p): p is ParcelBelief => p !== undefined)
  }

  /**
   * The teammate's belief, resolved by `rel === 'partner'`. The agents map is keyed by SERVER
   * agent id (UUID), so `agents.get(coord.partner)` (a role label) never hits — see §9.7. A
   * 2-agent team has exactly one partner, so the first rel==='partner' match is authoritative.
   */
  private partnerBelief(beliefs: BeliefBase): AgentBelief | null {
    for (const a of beliefs.agents.values()) if (a.rel === 'partner') return a
    return null
  }
}
