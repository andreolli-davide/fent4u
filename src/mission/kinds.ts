// The typed Mission (DESIGN §4.2 subset this slice produces) + the OpenAI function schemas
// + a hand-written boundary guard on `unknown`.

export type MissionKind =
  | 'QUERY'
  | 'CANDIDATE_INTENTION'
  | 'REWARD_SHAPER'
  | 'HARD_CONSTRAINT'
  | 'COORDINATION_CONTRACT'
  | 'FALLBACK'

export const MISSION_KINDS: readonly MissionKind[] = [
  'QUERY',
  'CANDIDATE_INTENTION',
  'REWARD_SHAPER',
  'HARD_CONSTRAINT',
  'COORDINATION_CONTRACT',
  'FALLBACK',
]

// FALLBACK never becomes a Mission this slice — it is discarded before install, so no
// Mission object ever carries a NOT_APPLICABLE status.
export type MissionStatus = 'CLASSIFIED' | 'SUPERSEDED'

export type TileSlot =
  | { tag: 'TEXT_BOUND'; x: number; y: number } // transcribed literal (calc-normalised in Task 4)
  | { tag: 'RUNTIME_BOUND'; rule: string } // runtime binds from map in #2 — unbound here

// Kind-specific transcribed params. Inert data this slice; #3 acts on shaper/constraint fields.
// x/y/payoff may arrive as number | string (an expression) — normalised to number in Task 4.
export interface MissionParams {
  targetTile?: TileSlot
  rule?: string
  m?: Record<string, number> // REWARD_SHAPER count→factor
  g?: Array<{ tile: TileSlot; factor: number }> // REWARD_SHAPER tile→factor
  tile?: TileSlot // HARD_CONSTRAINT
  filter?: string // HARD_CONSTRAINT absolute
  contractType?: string // COORDINATION_CONTRACT
  condition?: string
}

// What the LLM emits via emit_mission (no id/rawText/status).
export interface MissionDraft {
  kind: MissionKind
  payoff: number
  abstractIntent: string
  sub?: 'PRICED' | 'ABSOLUTE'
  theta?: number
  priority?: number
  deadline?: number
  params: MissionParams
  assignment?: { mode: 'ANY_ONE' | 'ALL' | 'PREDICATE'; count?: number; predicate?: string }
}

export interface Mission extends MissionDraft {
  id: string
  rawText: string
  status: MissionStatus
}

export function isMissionDraft(u: unknown): u is MissionDraft {
  if (typeof u !== 'object' || u === null) return false
  const d = u as Record<string, unknown>
  if (typeof d.kind !== 'string' || !MISSION_KINDS.includes(d.kind as MissionKind)) return false
  if (typeof d.payoff !== 'number' || !Number.isFinite(d.payoff)) return false
  if (typeof d.abstractIntent !== 'string') return false
  if (typeof d.params !== 'object' || d.params === null) return false
  return true
}

export function isMission(u: unknown): u is Mission {
  if (!isMissionDraft(u)) return false
  const d = u as unknown as Record<string, unknown>
  return (
    typeof d.id === 'string' &&
    typeof d.rawText === 'string' &&
    (d.status === 'CLASSIFIED' || d.status === 'SUPERSEDED')
  )
}

export function assembleMission(draft: MissionDraft, rawText: string, id: string): Mission {
  return { ...draft, id, rawText, status: 'CLASSIFIED' }
}

// ── OpenAI tool (function-calling) schemas ────────────────────────────────────
// `parameters` is a JSON Schema object. `params` is left permissive (validated by the guard +
// normalised in Task 4) because it is kind-discriminated.

export const CALCULATE_FN = {
  name: 'calculate',
  description:
    'Evaluate a numeric arithmetic expression (e.g. "4*2", "(1+3)*3"). Use this for any stated formula instead of computing it yourself.',
  parameters: {
    type: 'object',
    properties: { expr: { type: 'string', description: 'Arithmetic over + - * / ( ) and numbers only' } },
    required: ['expr'],
  },
} as const

export const ANSWER_QUERY_FN = {
  name: 'answer_query',
  description: 'Answer a stateless question that has no game effect (trivia, arithmetic result).',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The answer to send back in the channel' } },
    required: ['text'],
  },
} as const

export const EMIT_MISSION_FN = {
  name: 'emit_mission',
  description:
    'Emit one typed mission. Classify into exactly one kind and transcribe ONLY values stated in the message. You have NO map and NO positions — never invent or locate coordinates. Transcribe the payoff SIGN exactly (+10 vs -10). When sign or hardness is ambiguous, treat it as a constraint to AVOID.',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['CANDIDATE_INTENTION', 'REWARD_SHAPER', 'HARD_CONSTRAINT', 'COORDINATION_CONTRACT', 'FALLBACK'],
      },
      payoff: { type: 'number', description: 'Signed reward stated in the message' },
      abstractIntent: { type: 'string', description: 'One-line restatement of the goal' },
      sub: { type: 'string', enum: ['PRICED', 'ABSOLUTE'], description: 'HARD_CONSTRAINT flavour only' },
      deadline: { type: 'number', description: 'Latest tick to complete, if stated' },
      params: { type: 'object', description: 'Kind-specific transcribed params (tiles, count→factor map, filter, …)' },
    },
    required: ['kind', 'payoff', 'abstractIntent', 'params'],
  },
} as const
