// §17.4 — the online planner call. Delegates to the course package's onlineSolver
// (@unitn-asa/pddl-client → planning.domains), adapting its {parallel, action, args} steps to the
// lane's RawPlanStep. Kept behind the injectable `Solver` type so the lane can be tested with a mock
// (no network). A missing plan / planner failure surfaces as null ⇒ PLAN_FAIL, safe by omission.
import { onlineSolver as courseSolver } from '@unitn-asa/pddl-client'
import type { RawPlanStep } from './plan.js'

export type Solver = (domain: string, problem: string) => Promise<RawPlanStep[] | null>

export const onlineSolver: Solver = async (domain, problem) => {
  const plan = await courseSolver(domain, problem)
  if (plan === undefined || plan.length === 0) return null
  return plan.map((s) => ({ action: s.action, args: s.args }))
}
