// §17.4 Call 2 (LLM-PDDL): transcribe ONE natural-language mission into a structured PddlSpec — a
// task (deliver-all / coverage) + constraints (keep-away / stay-on / avoid) + transcribed payoff.
// The LLM only SELECTS from the fixed vocabulary and transcribes stated literals (§17.5.1 closure);
// it never writes raw PDDL, never invents coordinates. Grounding/validation is the caller's gate
// (§17.5.4). Injectable ChatFn so the lane is testable without a network.

import type { ChatFn, ChatMsg, FunctionDef } from '../llm.js'
import type { PddlSpec, RegionRef, PddlConstraints, PddlTask } from './spec.js'

const REGION = {
  type: 'object',
  description: 'A region: either an explicit tile {tag:"TILE",x,y} or a symbolic name {tag:"NAME",rule} (e.g. "left room", "border").',
  properties: {
    tag: { type: 'string', enum: ['TILE', 'NAME'] },
    x: { type: 'number' }, y: { type: 'number' }, rule: { type: 'string' },
  },
  required: ['tag'],
} as const

export const TRANSCRIBE_PDDL_FN: FunctionDef = {
  name: 'transcribe_pddl',
  description:
    'Transcribe the mission into a planning spec. task=DELIVER_ALL to deliver every known parcel, or ' +
    'COVERAGE to visit every tile of a region. Add constraints only if stated: keepAway (stay ≥dist from ' +
    'a region), stayOn (only move within a region), avoid (never enter these tiles/regions). Transcribe ' +
    'the stated payoff/deadline literally; payoff 0 if none stated. Never invent coordinates.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', enum: ['DELIVER_ALL', 'COVERAGE'] },
      region: REGION,
      keepAway: { type: 'array', items: { type: 'object', properties: { of: REGION, dist: { type: 'number' } }, required: ['of', 'dist'] } },
      stayOn: REGION,
      avoid: { type: 'array', items: REGION },
      payoff: { type: 'number' },
      deadline: { type: 'number' },
    },
    required: ['task'],
  },
}

const SYSTEM = [
  'You transcribe ONE mission into a planning spec via transcribe_pddl. You have the fixed vocabulary',
  'only: pick the task, list only stated constraints, transcribe stated numbers. Never invent',
  'coordinates or regions not named in the message. If sign/hardness is ambiguous, prefer a constraint',
  'to avoid. Call transcribe_pddl exactly once.',
].join(' ')

function toRegionRef(v: unknown): RegionRef | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (r.tag === 'TILE' && typeof r.x === 'number' && typeof r.y === 'number') return { tag: 'TILE', x: r.x, y: r.y }
  if (r.tag === 'NAME' && typeof r.rule === 'string') return { tag: 'NAME', rule: r.rule }
  return null
}

function toSpec(args: Record<string, unknown>): PddlSpec | null {
  let task: PddlTask
  if (args.task === 'DELIVER_ALL') task = { kind: 'DELIVER_ALL' }
  else if (args.task === 'COVERAGE') {
    const region = toRegionRef(args.region)
    if (region === null) return null // coverage needs a region
    task = { kind: 'COVERAGE', region }
  } else return null

  const constraints: PddlConstraints = {}
  if (Array.isArray(args.keepAway)) {
    const ka: NonNullable<PddlConstraints['keepAway']> = []
    for (const e of args.keepAway) {
      if (typeof e === 'object' && e !== null) {
        const of = toRegionRef((e as { of?: unknown }).of)
        const dist = (e as { dist?: unknown }).dist
        if (of !== null && typeof dist === 'number' && Number.isFinite(dist)) ka.push({ of, dist })
      }
    }
    if (ka.length > 0) constraints.keepAway = ka
  }
  if (args.stayOn !== undefined) { const s = toRegionRef(args.stayOn); if (s !== null) constraints.stayOn = s }
  if (Array.isArray(args.avoid)) {
    const av: RegionRef[] = []
    for (const e of args.avoid) { const r = toRegionRef(e); if (r !== null) av.push(r) }
    if (av.length > 0) constraints.avoid = av
  }

  const payoff = typeof args.payoff === 'number' && Number.isFinite(args.payoff) ? args.payoff : 0
  const deadline = typeof args.deadline === 'number' && Number.isFinite(args.deadline) ? args.deadline : undefined
  return { task, constraints, payoff, deadline }
}

/** Run Call 2 (LLM-PDDL) for one mission; null ⇒ no usable transcription (→ discard, safe by omission). */
export async function transcribePddl(raw: string, chat: ChatFn): Promise<PddlSpec | null> {
  const msgs: ChatMsg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: raw },
  ]
  const turn = await chat(msgs, [TRANSCRIBE_PDDL_FN])
  if (!('calls' in turn) || turn.calls.length === 0) return null
  const call = turn.calls.find((c) => c.name === TRANSCRIBE_PDDL_FN.name)
  if (call === undefined) return null
  let args: unknown
  try { args = JSON.parse(call.arguments) } catch { return null }
  if (typeof args !== 'object' || args === null) return null
  return toSpec(args as Record<string, unknown>)
}
