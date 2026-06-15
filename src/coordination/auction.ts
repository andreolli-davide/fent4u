// src/coordination/auction.ts
// §9.3 sequential single-item (SSI) marginal-route auction. Deterministic and
// leader-less: both replicas run this identical function over shared beliefs and
// reach the identical full allocation. Each round commits the global-best (p*, X*)
// only if it strictly improves X*'s route (emergent horizon, team level); the pool
// is then re-bid because every Δ shifts with X*'s new route.
import type { ParcelBelief, AgentBelief } from '../blackboard/beliefs.js'
import type { Pos } from '../types/perception.js'
import type { Params } from '../bdi/params.js'
import type { AgentId } from '../types/a2a.js'
import { routeFromClaims, uRoute } from '../bdi/route.js'
import { pAvail, type DecayConsts, type EnemyThreat, type ParcelWeight } from '../bdi/utility.js'

export interface AgentSnap {
  id: AgentId
  pos: Pos
  carried: ParcelBelief[]
  claimed: ParcelBelief[] // own already-committed claims (the base route)
}

export interface AuctionInput {
  pool: ParcelBelief[]
  agents: [AgentSnap, AgentSnap]
  enemies: AgentBelief[]
  zones: Pos[]
  dist: (a: Pos, b: Pos) => number
  dc: DecayConsts
  params: Params
  tnow: number
  epoch: number
  budgetMs: number
}

/** Per-agent P_avail weight for a parcel, from that agent's vantage (§5.5). */
function weightFor(agent: AgentSnap, enemies: AgentBelief[], dist: AuctionInput['dist'], dc: DecayConsts, params: Params, tnow: number): ParcelWeight {
  return (p: ParcelBelief): number => {
    if (p.carriedBy !== null) return 0
    const threats: EnemyThreat[] = enemies.map((e) => ({ age: tnow - e.lastSeen, dToP: dist(e.pos, p.pos) }))
    return pAvail(p, dist(agent.pos, p.pos), threats, params.beta_comp, tnow, dc)
  }
}

export function runAuction(inp: AuctionInput): Map<string, AgentId> {
  const t0 = performance.now()
  const alloc = new Map<string, AgentId>()
  const weights = new Map<AgentId, ParcelWeight>(inp.agents.map((a) => [a.id, weightFor(a, inp.enemies, inp.dist, inp.dc, inp.params, inp.tnow)]))
  // mutable per-agent claimed sets (start from existing claims)
  const claimed = new Map<AgentId, ParcelBelief[]>(inp.agents.map((a) => [a.id, [...a.claimed]]))
  const baseU = new Map<AgentId, number>()
  const routeU = (a: AgentSnap, set: ParcelBelief[]): number => {
    const sorted = [...set].sort((x, y) => x.id.localeCompare(y.id))
    const r = routeFromClaims(a.carried, sorted, a.pos, inp.zones, inp.tnow, inp.dc, inp.params, inp.dist, weights.get(a.id)!)
    return r === null ? 0 : uRoute(r, inp.tnow, inp.dc, inp.params, weights.get(a.id)!)
  }
  for (const a of inp.agents) baseU.set(a.id, routeU(a, claimed.get(a.id)!))

  // sorted pool for determinism; remaining shrinks each round
  const remaining = [...inp.pool].sort((a, b) => a.id.localeCompare(b.id))
  while (remaining.length > 0) {
    if (performance.now() - t0 >= inp.budgetMs) break // anytime cap
    let best: { p: ParcelBelief; idx: number; agent: AgentSnap; gain: number } | null = null
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i]!
      for (const a of inp.agents) {
        const gain = routeU(a, [...claimed.get(a.id)!, p]) - baseU.get(a.id)!
        // tie-break: larger gain, then lower agentId, then lower parcelId (sorted scan ⇒ id order stable)
        if (gain > 0 && (best === null || gain > best.gain || (gain === best.gain && a.id < best.agent.id))) {
          best = { p, idx: i, agent: a, gain }
        }
      }
    }
    if (best === null) break // emergent horizon: nothing improves any route
    claimed.get(best.agent.id)!.push(best.p)
    baseU.set(best.agent.id, routeU(best.agent, claimed.get(best.agent.id)!))
    alloc.set(best.p.id, best.agent.id)
    remaining.splice(best.idx, 1)
  }
  return alloc
}
