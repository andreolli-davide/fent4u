// §17.4 — the online planner call. A minimal TypeScript re-implementation of the course's
// PddlOnlineSolver (POST domain+problem to the planning.domains solver, poll, parse the plan) using
// Bun's native fetch — so the lane has a typed, dependency-free solver we can inject and mock. Returns
// the ordered plan steps, or null when the planner finds no plan (⇒ PLAN_FAIL, safe by omission §17.4).
import type { RawPlanStep } from './plan.js'

export type Solver = (domain: string, problem: string) => Promise<RawPlanStep[] | null>

const HOST = process.env.PAAS_HOST ?? 'https://solver.planning.domains:5001'
const PATH = process.env.PAAS_PATH ?? '/package/dual-bfws-ffparser/solve'

interface SolveResponse {
  status?: string
  result?: string | { call?: string; stdout?: string; output?: { plan?: string; sas_plan?: string } }
}

// Parse the ffparser plan text ("(action arg1 arg2)\n…") into ordered steps.
function parsePlan(text: string): RawPlanStep[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('(') && l.endsWith(')'))
    .map((l) => {
      const toks = l.slice(1, -1).trim().split(/\s+/)
      return { action: toks[0] ?? '', args: toks.slice(1) }
    })
    .filter((s) => s.action.length > 0)
}

export const onlineSolver: Solver = async (domain, problem) => {
  const post = await fetch(HOST + PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, problem, number_of_plans: '1' }),
  })
  if (!post.ok) throw new Error(`planner POST ${post.status}`)
  const posted = (await post.json()) as SolveResponse
  if (typeof posted.result !== 'string') throw new Error('planner: no result handle')
  const pollUrl = HOST + posted.result

  // Poll until the job leaves PENDING (the solver runs asynchronously server-side).
  for (let i = 0; i < 60; i++) {
    const res = await fetch(pollUrl, { method: 'GET', headers: { 'Content-Type': 'application/json' } })
    if (!res.ok) throw new Error(`planner GET ${res.status}`)
    const json = (await res.json()) as SolveResponse
    if (json.status === 'PENDING') { await new Promise((r) => setTimeout(r, 250)); continue }
    if (json.status !== 'ok' || typeof json.result === 'string' || json.result === undefined) return null
    const out = json.result.output
    const planText = out?.plan ?? out?.sas_plan
    if (typeof planText !== 'string' || planText.trim().length === 0) return null // no plan found
    const steps = parsePlan(planText)
    return steps.length > 0 ? steps : null
  }
  return null // timed out ⇒ treat as no plan (safe by omission)
}
