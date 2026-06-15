// src/bdi/loop.ts
import type { DeliverooClient } from '../external/deliveroo.js'
import type { PerceptionSnapshot, Pos, Tile } from '../types/perception.js'
import { BeliefBase, type ParcelBelief } from '../blackboard/beliefs.js'
import { buildGrid, buildObstacles, planPath, isPushAdmissible, type Grid, type PlanCtx, type Dir } from '../planning/astar.js'
import { decayConsts, pAvail, deliverBundle, tileKey, type DecayConsts, type EnemyThreat } from './utility.js'
import { buildRoute, uRoute } from './route.js'
import { select, chooseExplore, matches, type Intention, type Candidate } from './intentions.js'
import type { Params } from './params.js'

type LogFn = {
  info: (obj: Record<string, unknown>, msg?: string) => void
  debug: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
}

export class BdiLoop {
  private readonly grid: Grid
  private readonly dc: DecayConsts
  private readonly spawners: Pos[]
  private readonly seenAt = new Map<string, number>()
  private beliefs: BeliefBase | null = null
  private committed: Intention | null = null
  private committedU = 0
  private acting = false

  constructor(
    private readonly client: DeliverooClient,
    private readonly params: Params,
    private readonly log: LogFn,
  ) {
    this.grid = buildGrid(client.map)
    this.dc = decayConsts(client.consts)
    this.spawners = client.map.filter((t: Tile) => t.type === 'spawner').map((t) => t.pos)
  }

  /** Drive one perception tick → at most one action. Skips if an action is in flight. */
  async tick(snap: PerceptionSnapshot): Promise<void> {
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
    const dist = (a: Pos, b: Pos): number => planPath(this.grid, ctx, a, b).L

    // candidates
    const carried = beliefs.self.carrying.map((id) => beliefs.parcels.get(id)).filter((p): p is ParcelBelief => p !== undefined)
    const { pool, weight } = this.buildPool(beliefs, self, tnow, dist)
    // Pickups weight their P_avail (survival × race); carried parcels are in hand ⇒ 1 (§5.5).
    const weightOf = (p: ParcelBelief): number => weight.get(p.id) ?? 1
    const route = buildRoute(carried, pool, self, this.grid.deliveryZones, tnow, this.dc, this.params, dist, weightOf)
    const cands: Candidate[] = []
    if (route !== null) cands.push({ intention: { kind: 'route', route }, u: uRoute(route, tnow, this.dc, this.params, weightOf) })
    const ex = chooseExplore(this.spawners, this.seenAt, self, tnow, dist, this.params)
    if (ex !== null) cands.push(ex)
    cands.push({ intention: { kind: 'idle' }, u: this.params.eps_idle })

    const chosenCand = select(cands, this.committed, this.params.h_commit)
    const chosen = chosenCand.intention
    if (!matches(this.committed, chosen)) {
      this.log.info({ from: this.committed?.kind ?? 'none', to: chosen.kind, uFrom: this.committedU, uTo: chosenCand.u, tick: tnow }, 'intent switch')
    }
    this.committed = chosen
    this.committedU = chosenCand.u

    await this.act(chosen, beliefs, ctx, tnow)
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
    for (const p of beliefs.parcels.values()) {
      if (p.carriedBy !== null) continue
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
      if (atGoalAction === 'pickup') await this.doPickup(beliefs)
      else if (atGoalAction === 'deliver') await this.doDeliver(beliefs, goal, tnow)
      return
    }

    await this.stepToward(beliefs, ctx, self, goal)
  }

  private async stepToward(beliefs: BeliefBase, ctx: PlanCtx, self: Pos, goal: Pos): Promise<void> {
    let res = planPath(this.grid, ctx, self, goal)
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

  private async doPickup(beliefs: BeliefBase): Promise<void> {
    this.acting = true
    try {
      const got = await this.client.pickup()
      const ids = got.length > 0 ? got.map((g) => g.id) : [...beliefs.parcels.values()].filter((p) => p.pos.x === beliefs.self.pos.x && p.pos.y === beliefs.self.pos.y && p.carriedBy === null).map((p) => p.id)
      beliefs.applyPickup(ids)
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
}
