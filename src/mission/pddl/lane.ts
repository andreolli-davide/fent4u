// §17 PDDL back-end orchestrator. Frozen snapshot → grounded problem → online planner → AgentStep[]
// → shared A* cost → AGENT_PLAN mission — the SAME {plan, L, vPlan} contract the LLM-agent lane emits
// (§17.6.1), so the per-tick U_mission selector scores both back-ends identically. Off the 50 ms loop.
// Any solver/parse/grounding failure resolves to `discard` (PLAN_FAIL, safe by omission §17.4).
import type { CompileResult } from '../compiler.js'
import type { Params } from '../../bdi/params.js'
import type { Grid } from '../../planning/astar.js'
import type { DecayConsts } from '../../bdi/utility.js'
import type { WorldSnapshot } from '../agent/snapshot.js'
import { assembleMission, type MissionDraft } from '../kinds.js'
import { costPlan } from '../agent/cost.js'
import { DELIVEROO_DOMAIN } from './domain.js'
import { buildDeliverAllProblem } from './problem.js'
import { solverPlanToSteps } from './plan.js'
import type { Solver } from './solver.js'

export interface PddlDeps {
  grid: () => Grid | null // lazy — null until the first perception builds it (liaison boot)
  snapshot: () => WorldSnapshot | null
  solve: Solver
  dc: DecayConsts
  params: Params
  tnow: () => number
  nextId: () => string
}

export function makePddlCompile(deps: PddlDeps): (raw: string) => Promise<CompileResult> {
  const discard = (): CompileResult => ({ kind: 'discard', reason: 'not_applicable' })
  return async (raw: string): Promise<CompileResult> => {
    const grid = deps.grid()
    const snap = deps.snapshot()
    if (grid === null || snap === null) return discard()
    const built = buildDeliverAllProblem(grid, snap)
    if (built === null) return discard() // nothing plannable (no free parcel / no zone)

    let rawPlan
    try {
      rawPlan = await deps.solve(DELIVEROO_DOMAIN, built.problem)
    } catch {
      return discard() // planner/network failure ⇒ safe by omission (§17.4)
    }
    if (rawPlan === null) return discard() // no plan found

    const steps = solverPlanToSteps(rawPlan, built.parcelById)
    if (steps === null || steps.length === 0) return discard()

    const tnow = deps.tnow()
    const cost = costPlan(steps, grid, snap, tnow, deps.dc, deps.params.push_plan_budget_ms)
    if (!cost.reachable) return discard() // grounding fail ⇒ P_feasible 0 (§17.6.2)

    // payoff 0: "deliver-all" carries no stated bonus — its worth is the delivered parcels (V_plan),
    // scored via the shared kernel. abstractIntent keeps the NL for tracing.
    const draft: MissionDraft = {
      kind: 'AGENT_PLAN', payoff: 0, abstractIntent: raw, theta: deps.params.theta_llm, params: {},
      plan: { steps, L: cost.L, vPlan: cost.vPlan },
    }
    return { kind: 'mission', mission: assembleMission(draft, raw, deps.nextId()) }
  }
}
