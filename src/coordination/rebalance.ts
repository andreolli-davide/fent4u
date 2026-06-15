// src/coordination/rebalance.ts
// §9.6 periodic global rebalance: 2-opt-style single-claim transfers between the two
// agents, accepted only when the team rate gain beats the physics-derived switchCost
// (sunk travel forfeited + the other agent's re-approach). Deterministic: both replicas
// compute the identical verdict from shared state, so no negotiation is needed.
import type { ParcelBelief, AgentBelief } from '../blackboard/beliefs.js'
import type { Pos } from '../types/perception.js'
import type { Params } from '../bdi/params.js'
import type { AgentId } from '../types/a2a.js'
import type { Claim } from './claims.js'
import { routeFromClaims, uRoute } from '../bdi/route.js'
import { pAvail, type DecayConsts, type EnemyThreat, type ParcelWeight } from '../bdi/utility.js'

export interface RebalanceAgent {
  id: AgentId
  pos: Pos
  carried: ParcelBelief[]
  claimed: ParcelBelief[] // own AUCTION-claimed, not-yet-picked parcels (the route)
}

export interface RebalanceInput {
  agents: [RebalanceAgent, RebalanceAgent]
  claims: Claim[] // current AUCTION claims (for originD / sunk travel)
  enemies: AgentBelief[]
  zones: Pos[]
  dist: (a: Pos, b: Pos) => number
  dc: DecayConsts
  params: Params
  tnow: number
  epoch: number
}

export interface Reassign {
  parcelId: string
  toAgent: AgentId
}

function weightFor(agent: RebalanceAgent, inp: RebalanceInput): ParcelWeight {
  return (p: ParcelBelief): number => {
    if (p.carriedBy !== null) return 0
    const threats: EnemyThreat[] = inp.enemies.map((e) => ({ age: inp.tnow - e.lastSeen, dToP: inp.dist(e.pos, p.pos) }))
    return pAvail(p, inp.dist(agent.pos, p.pos), threats, inp.params.beta_comp, inp.tnow, inp.dc)
  }
}

function routeU(a: RebalanceAgent, set: ParcelBelief[], inp: RebalanceInput): number {
  const sorted = [...set].sort((x, y) => x.id.localeCompare(y.id))
  const r = routeFromClaims(a.carried, sorted, a.pos, inp.zones, inp.tnow, inp.dc, inp.params, inp.dist, weightFor(a, inp))
  return r === null ? 0 : uRoute(r, inp.tnow, inp.dc, inp.params, weightFor(a, inp))
}

export function runRebalance(inp: RebalanceInput): Reassign[] {
  const originD = new Map<string, number>(inp.claims.map((c) => [c.parcelId, c.originD]))
  const [a0, a1] = inp.agents
  let best: { parcelId: string; toAgent: AgentId; margin: number } | null = null

  // consider transferring each not-picked claim from its owner X to the other agent Y
  for (const [X, Y] of [[a0, a1], [a1, a0]] as const) {
    for (const p of [...X.claimed].sort((m, n) => m.id.localeCompare(n.id))) {
      if (p.carriedBy !== null) continue // never reassign picked-up goods
      const without = X.claimed.filter((q) => q.id !== p.id)
      const gainY = routeU(Y, [...Y.claimed, p], inp) - routeU(Y, Y.claimed, inp)
      const lossX = routeU(X, X.claimed, inp) - routeU(X, without, inp)
      const dUteam = gainY - lossX
      const sunk = Math.max(0, (originD.get(p.id) ?? inp.dist(X.pos, p.pos)) - inp.dist(X.pos, p.pos))
      const reApproach = inp.dist(Y.pos, p.pos)
      const switchCost = inp.dc.rho * (sunk + reApproach)
      const margin = dUteam - switchCost
      if (margin > 0 && (best === null || margin > best.margin || (margin === best.margin && Y.id < best.toAgent))) {
        best = { parcelId: p.id, toAgent: Y.id, margin }
      }
    }
  }
  return best === null ? [] : [{ parcelId: best.parcelId, toAgent: best.toAgent }]
}
