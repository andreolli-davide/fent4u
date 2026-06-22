// src/bdi/mission-intention.ts
// U_mission(m) for a CANDIDATE_INTENTION coordinate target (DESIGN §5.5). V_plan = 0 this slice
// (no parcels delivered by the plan), so the value scale is the signed payoff alone. Returns null
// when the mission is not a candidate this tick (wrong kind/slot, unreachable, below the
// P_FEASIBLE_MIN floor, deadline passed, or non-positive) — distinct from a low-u candidate, so it
// never churns the §5.6 commitment hysteresis.

import type { Pos } from '../types/perception.js'
import type { Params } from './params.js'
import type { Candidate } from './intentions.js'
import type { Mission } from '../mission/kinds.js'

type Dist = (a: Pos, b: Pos) => number

export function uMission(
  mission: Mission,
  self: Pos,
  dist: Dist,
  tnow: number,
  rhoRef: number,
  params: Params,
): Candidate | null {
  if (mission.kind === 'AGENT_PLAN') {
    const plan = mission.plan
    if (plan === undefined || !Number.isFinite(plan.L)) return null
    const Lm = plan.L
    const sm = mission.deadline === undefined ? Infinity : mission.deadline - tnow - Lm
    if (sm < 0) return null                                  // deadline unreachable (§4.3)
    const theta = mission.theta ?? params.theta_llm
    const value = mission.payoff + plan.vPlan                // §18.9 payoff + kernel V_plan
    const completion = 1 / Math.pow(Lm + 1, params.alpha)
    const shadow = sm === Infinity ? 0 : 1 / Math.pow(sm + 1, params.alpha)
    const urgency = Math.max(completion, shadow)
    const raw = theta * 1 * value * urgency                  // P_feasible binary {1,0}; here 1 (§18.9)
    const u = Math.min(raw, params.c_llm * rhoRef)           // tighter LLM rate ceiling
    if (u <= 0) return null
    return { intention: { kind: 'mission', mission }, u }
  }

  const t = mission.params.targetTile
  if (mission.kind !== 'CANDIDATE_INTENTION' || t === undefined || t.tag !== 'TEXT_BOUND') return null

  const target: Pos = { x: t.x, y: t.y }
  const Lm = dist(self, target)
  const pFeasible = Number.isFinite(Lm) ? 1 : 0           // binary reachability (§5.5)
  if (pFeasible < params.p_feasible_min) return null       // floor: unreachable ⇒ out (§12)

  const sm = mission.deadline === undefined ? Infinity : mission.deadline - tnow - Lm
  if (sm < 0) return null                                  // deadline unreachable ⇒ P_feasible 0 (§4.3)

  const theta = mission.theta ?? params.theta_mission
  const value = mission.payoff                             // + V_plan (=0 this slice)
  const completion = 1 / Math.pow(Lm + 1, params.alpha)
  const shadow = sm === Infinity ? 0 : 1 / Math.pow(sm + 1, params.alpha)
  const urgency = Math.max(completion, shadow)             // §5.5 deadline urgency

  const raw = theta * pFeasible * value * urgency
  const u = Math.min(raw, params.c * rhoRef)               // open-loop rate ceiling (§5.5)
  if (u <= 0) return null                                  // negative/zero payoff never wins
  return { intention: { kind: 'mission', mission }, u }
}
