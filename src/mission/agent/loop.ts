// §18.4/§18.6 autonomous ReAct loop (lane B). Off-loop: reasons against a frozen snapshot and
// EMITS a plan (or answers a QUERY) — it never drives live moves. Read tools observe the
// (simulated) snapshot; world-action tools record steps and forward-apply; emit_plan/answer
// are terminal. Returns the shared CompileResult so the existing intake/slot path is reused.

import type { ChatFn, ChatMsg } from '../llm.js'
import type { CompileResult } from '../compiler.js'
import type { Params } from '../../bdi/params.js'
import type { Grid } from '../../planning/astar.js'
import type { DecayConsts } from '../../bdi/utility.js'
import { assembleMission, isAgentStep, type AgentStep, type MissionDraft } from '../kinds.js'
import { costPlan } from './cost.js'
import { forwardApply, type WorldSnapshot } from './snapshot.js'
import { AGENT_TOOLS, isReadTool, isActionTool, executeRead, actionStep } from './tools.js'

const SYSTEM = [
  'You are an agent that compiles ONE natural-language mission into a plan, or answers a question.',
  'Reason with Thought then tool calls. Use read tools (get_my_position, scan_world, get_parcel,',
  'list_delivery_zones, get_partner_status) to inspect the world. Use goto/pickup/deliver/wait to',
  'build a plan. For ANY arithmetic call calculate — never compute yourself. Never invent coordinates:',
  'use only positions returned by read tools. For a stateless question, call answer(text). Otherwise',
  'finish with emit_plan(payoff, deadline?, steps[]). Transcribe the payoff sign exactly. If sign or',
  'feasibility is ambiguous, prefer the conservative (safer) interpretation.',
].join(' ')

const discard = (): CompileResult => ({ kind: 'discard', reason: 'malformed' })

function parseArgs(raw: string): Record<string, unknown> | null {
  try { const v = JSON.parse(raw); return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null }
  catch { return null }
}

export async function reactPlan(
  text: string, snap: WorldSnapshot, chat: ChatFn, grid: Grid, dc: DecayConsts,
  tnow: number, params: Params, nextId: () => string,
): Promise<CompileResult> {
  const msgs: ChatMsg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${text}\n\nsnapshot: self=${JSON.stringify(snap.selfPos)} parcels=${JSON.stringify(snap.parcels.map((p) => ({ id: p.id, pos: p.pos, reward: p.reward })))} zones=${JSON.stringify(snap.zones)}` },
  ]
  let sim = snap
  const steps: AgentStep[] = []
  const maxIters = params.max_iters

  for (let iter = 0; iter < maxIters; iter++) {
    const turn = await chat(msgs, AGENT_TOOLS)
    if (!('calls' in turn) || turn.calls.length === 0) return discard()

    // One terminal per turn ends the loop; otherwise process calls in order (actions forward-apply).
    for (const c of turn.calls) {
      const args = parseArgs(c.arguments)
      if (args === null) return discard()

      if (c.name === 'answer') {
        return typeof args.text === 'string' ? { kind: 'query', answer: args.text } : discard()
      }

      if (c.name === 'emit_plan') {
        if (typeof args.payoff !== 'number' || !Number.isFinite(args.payoff)) return discard()
        const emitted = Array.isArray(args.steps) ? args.steps : []
        const planSteps = [...steps, ...emitted.filter(isAgentStep)]
        if (planSteps.length === 0) return discard()
        const cost = costPlan(planSteps, grid, sim, tnow, dc, params.push_plan_budget_ms)
        if (!cost.reachable) return discard()                       // grounding fail ⇒ P_feasible 0
        const deadline = typeof args.deadline === 'number' ? args.deadline : undefined
        const draft: MissionDraft = {
          kind: 'AGENT_PLAN', payoff: args.payoff, abstractIntent: text, deadline,
          theta: params.theta_llm, params: {},
          plan: { steps: planSteps, L: cost.L, vPlan: cost.vPlan },
        }
        return { kind: 'mission', mission: assembleMission(draft, text, nextId()) }
      }

      if (isReadTool(c.name)) {
        const obs = executeRead(sim, c.name, args)
        msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: c.id ?? `c_${iter}`, type: 'function', function: { name: c.name, arguments: c.arguments } }] })
        msgs.push({ role: 'tool', tool_call_id: c.id ?? `c_${iter}`, content: obs })
        continue
      }

      if (isActionTool(c.name)) {
        const step = actionStep(c.name, args)
        if (step === null) return discard()
        steps.push(step)
        sim = forwardApply(sim, step)
        msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: c.id ?? `c_${iter}`, type: 'function', function: { name: c.name, arguments: c.arguments } }] })
        msgs.push({ role: 'tool', tool_call_id: c.id ?? `c_${iter}`, content: 'ok' })
        continue
      }

      return discard() // unknown tool
    }
  }
  return discard() // MAX_ITERS exhausted, no terminal
}
