// §17 PDDL back-end orchestrator. Frozen snapshot → (Call 2) transcribe NL to a PddlSpec → ValidationGate
// → grounded problem (deliver-all OR coverage, constraint-masked) → online planner → AgentStep[] → shared
// A* cost → AGENT_PLAN mission — the SAME {plan, L, vPlan} contract the LLM-agent lane emits (§17.6.1), so
// the per-tick U_mission selector scores both back-ends identically. Off the 50 ms loop. Any transcribe/
// gate/solver/parse/grounding failure resolves to `discard` (PLAN_FAIL, safe by omission §17.4).
// A PlanCache keyed on (rawText, beliefSignature) skips the planner for an unchanged world (§17.5.5).
import type { CompileResult } from '../compiler.js'
import type { Params } from '../../bdi/params.js'
import type { Grid } from '../../planning/astar.js'
import type { DecayConsts } from '../../bdi/utility.js'
import type { Pos } from '../../types/perception.js'
import type { WorldSnapshot } from '../agent/snapshot.js'
import { assembleMission, type AgentStep, type MissionDraft } from '../kinds.js'
import { costPlan } from '../agent/cost.js'
import { DELIVEROO_DOMAIN, COVERAGE_DOMAIN } from './domain.js'
import { buildDeliverAllProblem, buildCoverageProblem } from './problem.js'
import { solverPlanToSteps, coveragePlanToSteps } from './plan.js'
import { validateSpec, type PddlSpec } from './spec.js'
import { PlanCache } from './cache.js'
import type { Solver } from './solver.js'

export interface PddlDeps {
  grid: () => Grid | null // lazy — null until the first perception builds it (liaison boot)
  snapshot: () => WorldSnapshot | null
  solve: Solver
  dc: DecayConsts
  params: Params
  tnow: () => number
  nextId: () => string
  // §17.4 Call 2 (LLM-PDDL). Absent ⇒ the lane runs the plain deliver-all task (payoff 0), so a
  // planner-only deployment (no LLM) still works and existing behaviour is unchanged.
  transcribe?: (raw: string) => Promise<PddlSpec | null>
}

interface CachedPlan { steps: AgentStep[]; payoff: number; deadline?: number; mask: Pos[] }

export function makePddlCompile(deps: PddlDeps): (raw: string) => Promise<CompileResult> {
  const discard = (): CompileResult => ({ kind: 'discard', reason: 'not_applicable' })
  const cache = new PlanCache<CachedPlan>()

  // Cost a cached/fresh plan and assemble the AGENT_PLAN mission (shared tail, §17.6.1).
  const assemble = (raw: string, plan: CachedPlan, grid: Grid, snap: WorldSnapshot): CompileResult => {
    const masked: WorldSnapshot = { ...snap, maskTiles: [...(snap.maskTiles ?? []), ...plan.mask] }
    const cost = costPlan(plan.steps, grid, masked, deps.tnow(), deps.dc, deps.params.push_plan_budget_ms)
    if (!cost.reachable) return discard() // grounding fail ⇒ P_feasible 0 (§17.6.2)
    const draft: MissionDraft = {
      kind: 'AGENT_PLAN', payoff: plan.payoff, deadline: plan.deadline, abstractIntent: raw,
      theta: deps.params.theta_llm, params: {},
      plan: { steps: plan.steps, L: cost.L, vPlan: cost.vPlan },
    }
    return { kind: 'mission', mission: assembleMission(draft, raw, deps.nextId()) }
  }

  return async (raw: string): Promise<CompileResult> => {
    const grid = deps.grid()
    const snap = deps.snapshot()
    if (grid === null || snap === null) return discard()

    // §17.5.5 cache hit: unchanged world ⇒ reuse the plan, skip transcription + planner.
    const hit = cache.get(raw, snap.sig)
    if (hit !== undefined) return assemble(raw, hit, grid, snap)

    // §17.4 Call 2: transcribe (or default to deliver-all when no LLM lane is wired).
    const spec: PddlSpec = deps.transcribe
      ? (await deps.transcribe(raw).catch(() => null)) ?? { task: { kind: 'DELIVER_ALL' }, constraints: {}, payoff: 0 }
      : { task: { kind: 'DELIVER_ALL' }, constraints: {}, payoff: 0 }

    // §17.5.4 ValidationGate: ground the spec (regions resolve, agent not masked, coverage non-empty).
    const gate = validateSpec(grid, spec, snap.selfPos)
    if (!gate.ok) return discard()

    // Build the grounded problem for the task, with masked tiles filtered from adjacency (§17.5.2).
    const built = spec.task.kind === 'COVERAGE'
      ? buildCoverageProblem(grid, snap, gate.targets ?? [], gate.mask)
      : buildDeliverAllProblem(grid, snap, gate.mask)
    if (built === null) return discard() // nothing plannable (no free parcel / no zone / empty targets)
    const domain = spec.task.kind === 'COVERAGE' ? COVERAGE_DOMAIN : DELIVEROO_DOMAIN

    let rawPlan
    try {
      rawPlan = await deps.solve(domain, built.problem)
    } catch {
      return discard() // planner/network failure ⇒ safe by omission (§17.4)
    }
    if (rawPlan === null) return discard() // no plan found

    const steps = spec.task.kind === 'COVERAGE' ? coveragePlanToSteps(rawPlan) : solverPlanToSteps(rawPlan, built.parcelById)
    if (steps === null || steps.length === 0) return discard()

    const plan: CachedPlan = { steps, payoff: spec.payoff, deadline: spec.deadline, mask: gate.mask }
    cache.set(raw, snap.sig, plan)
    return assemble(raw, plan, grid, snap)
  }
}
