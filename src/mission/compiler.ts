// Bounded ReAct loop over litellm function calling. Pure transform: no game state, no map,
// no side effects (the caller owns slot writes / channel replies). DESIGN §3, §4, §10.

import { calc } from './calc.js'
import {
  isMissionDraft, assembleMission, CALCULATE_FN, ANSWER_QUERY_FN, EMIT_MISSION_FN,
  type Mission, type MissionDraft, type TileSlot,
} from './kinds.js'
import type { ChatFn, ChatMsg } from './llm.js'

export type CompileResult =
  | { kind: 'mission'; mission: Mission }
  | { kind: 'query'; answer: string }
  | { kind: 'discard'; reason: 'malformed' | 'not_applicable' }

const MAX_ITERS = 4
let seq = 0
const nextId = (): string => `m-${Date.now()}-${seq++}`

const SYSTEM = [
  'You compile ONE natural-language message into ONE typed mission, or answer a question.',
  'You have NO map and NO positions. Never invent or locate coordinates — transcribe only values',
  'written in the message. For any stated arithmetic, call calculate (do not compute yourself).',
  'Transcribe the payoff sign exactly (+10 vs -10). If sign or hardness is ambiguous, treat it as a',
  'constraint to AVOID. For a stateless question with no game effect, call answer_query. Otherwise',
  'call emit_mission exactly once.',
].join(' ')

// Resolve a number-or-expression field to a number, or null if an expression is unparseable.
function resolveNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return calc(v)
  return null
}

function normalizeTile(t: TileSlot | undefined): TileSlot | null | undefined {
  if (t === undefined || t.tag === 'RUNTIME_BOUND') return t
  const x = resolveNum((t as { x: unknown }).x)
  const y = resolveNum((t as { y: unknown }).y)
  if (x === null || y === null) return null // unparseable expression → caller drops mission
  return { tag: 'TEXT_BOUND', x, y }
}

// Returns the normalised mission, or null if any expression field is unparseable.
function normalize(draft: MissionDraft): MissionDraft | null {
  const payoff = resolveNum(draft.payoff as unknown)
  if (payoff === null) return null
  const p = draft.params
  const target = normalizeTile(p.targetTile)
  if (target === null) return null
  const tile = normalizeTile(p.tile)
  if (tile === null) return null
  let g = p.g
  if (g) {
    const ng: typeof g = []
    for (const e of g) {
      const nt = normalizeTile(e.tile)
      if (nt === null || nt === undefined) return null
      ng.push({ tile: nt, factor: e.factor })
    }
    g = ng
  }
  return { ...draft, payoff, params: { ...p, targetTile: target, tile, g } }
}

export async function compile(rawText: string, chat: ChatFn): Promise<CompileResult> {
  const msgs: ChatMsg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: rawText },
  ]
  const fns = [CALCULATE_FN, ANSWER_QUERY_FN, EMIT_MISSION_FN]

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const turn = await chat(msgs, fns)
    if (!('call' in turn)) return { kind: 'discard', reason: 'malformed' }
    const { name, arguments: rawArgs } = turn.call

    let args: unknown
    try { args = JSON.parse(rawArgs) } catch { return { kind: 'discard', reason: 'malformed' } }

    if (name === CALCULATE_FN.name) {
      const expr = (args as { expr?: unknown }).expr
      const v = typeof expr === 'string' ? calc(expr) : null
      msgs.push({ role: 'assistant', content: null, function_call: turn.call })
      msgs.push({ role: 'function', name: CALCULATE_FN.name, content: v === null ? 'error: invalid expression' : String(v) })
      continue
    }

    if (name === ANSWER_QUERY_FN.name) {
      const text = (args as { text?: unknown }).text
      return typeof text === 'string'
        ? { kind: 'query', answer: text }
        : { kind: 'discard', reason: 'malformed' }
    }

    if (name === EMIT_MISSION_FN.name) {
      if (!isMissionDraft(args)) return { kind: 'discard', reason: 'malformed' }
      if (args.kind === 'FALLBACK') return { kind: 'discard', reason: 'not_applicable' }
      if (args.kind === 'QUERY') return { kind: 'discard', reason: 'malformed' }
      const norm = normalize(args)
      if (norm === null) return { kind: 'discard', reason: 'malformed' }
      return { kind: 'mission', mission: assembleMission(norm, rawText, nextId()) }
    }

    return { kind: 'discard', reason: 'malformed' } // unknown function name
  }
  return { kind: 'discard', reason: 'malformed' } // cap hit, no terminal
}
