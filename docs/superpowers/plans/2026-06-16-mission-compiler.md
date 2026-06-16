# Mission Compiler (LLM lane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile a natural-language mission message arriving on the Liaison's channel into a typed `Mission` parked in a single slot (or answer a `QUERY` in the channel), with zero LLM work on the 50 ms BDI loop.

**Architecture:** A standalone `mission/` lane. `onMissionMsg` → a ~1-tick coalescing window → a bounded ReAct loop (`compiler.ts`) over litellm function-calling (`llm.ts`), with a deterministic eval-free calculator (`calc.ts`) the LLM may call. The terminal `emit_mission` / `answer_query` function call is the typed output, guarded by `kinds.ts`, then installed into a single `MissionSlot` under an epoch-guarded latest-wins rule (`intake.ts`). Map-validation, `U_mission`, shapers, and back-ends are out of scope (slices #2/#3/#4/#5).

**Tech Stack:** Bun + `bun:test`, TypeScript `strict`, ESM with `.js` import extensions, litellm JS SDK (`completion`, legacy `functions` API, OpenAI handler only), Pino logging.

---

## Key facts the engineer must know before starting

- **Tests live in `tests/`** (not colocated), run with `bun test`. Import source with `.js` extensions (e.g. `import { calc } from '../src/mission/calc.js'`). Test style: `import { test, expect } from 'bun:test'` (see `tests/bdi-intentions.test.ts`).
- **litellm function calling works ONLY through the OpenAI handler**, selected by model-name prefix `gpt-` or `openai/` (`node_modules/litellm/dist/src/completion.js:24-25`). Other handlers flatten messages to text and silently drop `functions`. We fail fast at boot if `LITELLM_MODEL` doesn't match.
- **litellm forwards unknown fields**: `OpenAIHandler` spreads all params into `openai.chat.completions.create`, so `functions`, `function_call`, and a `name` field on messages all reach the backend even though litellm's TS `Message` type omits them. We declare a minimal local `ChatMsg` type (CLAUDE.md: "write minimal type stubs").
- **Strict TS, no `any`.** Validate the LLM's JSON at the boundary with a hand-written guard on `unknown` (matches `src/types/a2a.ts`, `src/coordination/claims.ts`).
- **Liaison-only.** `say`/`ask` are already Liaison-gated in `src/external/deliveroo.ts:334`. The Courier never wires `onMissionMsg`.
- **No `console.log`** — use the Pino logger child `{ agentId:'liaison', module:'mission' }`.

## File structure

```
src/mission/
  calc.ts       # calc(expr): number | null — closed-grammar safe arithmetic, no eval
  kinds.ts      # Mission types, MissionStatus, TileSlot, MissionParams; EMIT_MISSION_FN /
                #   ANSWER_QUERY_FN / CALCULATE_FN schemas; isMissionDraft guard; assembleMission
  llm.ts        # ChatMsg/FunctionDef/FunctionCall types; makeChat(cfg): ChatFn (litellm wrapper,
                #   model-prefix guard, function_call extraction)
  compiler.ts   # compile(raw, chat): Promise<CompileResult> — bounded ReAct loop, calc normalisation
  slot.ts       # MissionSlot: install/current/supersede/epoch + teardown stub
  intake.ts     # createIntake(deps): coalescing window + epoch-guarded single-flight driver
src/agents/
  liaison.ts    # wire onMissionMsg -> intake (modify)
tests/
  mission-calc.test.ts
  mission-kinds.test.ts
  mission-compiler.test.ts
  mission-slot.test.ts
  mission-intake.test.ts
  mission-no-hotloop.test.ts   # structural: mission/ imports nothing from bdi/loop
```

---

## Task 1: `calc.ts` — eval-free safe arithmetic

**Files:**
- Create: `src/mission/calc.ts`
- Test: `tests/mission-calc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-calc.test.ts
import { test, expect } from 'bun:test'
import { calc } from '../src/mission/calc.js'

test('evaluates basic arithmetic with precedence', () => {
  expect(calc('4*2')).toBe(8)
  expect(calc('(1+3)*3')).toBe(12)
  expect(calc('10 - 2 / 2')).toBe(9)
  expect(calc('-10')).toBe(-10)
})

test('returns null for tokens outside the grammar', () => {
  expect(calc('process.exit(1)')).toBeNull()
  expect(calc('1; 2')).toBeNull()
  expect(calc('() => 1')).toBeNull()
  expect(calc('x + 1')).toBeNull()
  expect(calc('')).toBeNull()
})

test('returns null for malformed expressions and div-by-zero', () => {
  expect(calc('1 +')).toBeNull()
  expect(calc('(1+2')).toBeNull()
  expect(calc('1/0')).toBeNull()
})

test('rejects over-long input', () => {
  expect(calc('1+'.repeat(200) + '1')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-calc.test.ts`
Expected: FAIL — `Cannot find module '../src/mission/calc.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/mission/calc.ts
// Safe arithmetic over a CLOSED grammar: number literals and + - * / ( ) with unary minus.
// NEVER eval / Function: the input originates from an external (server/opponent) NL message
// transcribed by the LLM — eval would be remote code execution in the Liaison worker.

const MAX_EXPR_LEN = 120

type Token = { t: 'num'; v: number } | { t: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' }

function tokenize(s: string): Token[] | null {
  const out: Token[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')') {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i + 1
      while (j < s.length && ((s[j]! >= '0' && s[j]! <= '9') || s[j] === '.')) j++
      const num = Number(s.slice(i, j))
      if (!Number.isFinite(num)) return null
      out.push({ t: 'num', v: num })
      i = j
      continue
    }
    return null // any other character → outside the grammar
  }
  return out
}

class Parser {
  private pos = 0
  constructor(private readonly toks: Token[]) {}

  atEnd(): boolean { return this.pos >= this.toks.length }
  private peek(): Token | undefined { return this.toks[this.pos] }

  // expr = term (('+' | '-') term)*
  parseExpr(): number | null {
    let left = this.parseTerm()
    if (left === null) return null
    for (;;) {
      const tk = this.peek()
      if (tk?.t === 'op' && (tk.v === '+' || tk.v === '-')) {
        this.pos++
        const right = this.parseTerm()
        if (right === null) return null
        left = tk.v === '+' ? left + right : left - right
      } else break
    }
    return left
  }

  // term = factor (('*' | '/') factor)*
  private parseTerm(): number | null {
    let left = this.parseFactor()
    if (left === null) return null
    for (;;) {
      const tk = this.peek()
      if (tk?.t === 'op' && (tk.v === '*' || tk.v === '/')) {
        this.pos++
        const right = this.parseFactor()
        if (right === null) return null
        if (tk.v === '/' && right === 0) return null
        left = tk.v === '*' ? left * right : left / right
      } else break
    }
    return left
  }

  // factor = number | '(' expr ')' | '-' factor
  private parseFactor(): number | null {
    const tk = this.peek()
    if (tk === undefined) return null
    if (tk.t === 'num') { this.pos++; return tk.v }
    if (tk.t === 'op' && tk.v === '-') { this.pos++; const f = this.parseFactor(); return f === null ? null : -f }
    if (tk.t === 'op' && tk.v === '(') {
      this.pos++
      const inner = this.parseExpr()
      if (inner === null) return null
      const close = this.peek()
      if (close?.t === 'op' && close.v === ')') { this.pos++; return inner }
      return null
    }
    return null
  }
}

export function calc(expr: string): number | null {
  if (typeof expr !== 'string' || expr.length === 0 || expr.length > MAX_EXPR_LEN) return null
  const toks = tokenize(expr)
  if (toks === null || toks.length === 0) return null
  const p = new Parser(toks)
  const v = p.parseExpr()
  if (v === null || !p.atEnd()) return null
  return Number.isFinite(v) ? v : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-calc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/calc.ts tests/mission-calc.test.ts
git commit -m "feat(mission): eval-free arithmetic calculator (§3.1)"
```

---

## Task 2: `kinds.ts` — Mission type, function schemas, guard

**Files:**
- Create: `src/mission/kinds.ts`
- Test: `tests/mission-kinds.test.ts`

The LLM emits a *draft* (no `id`/`rawText`/`status`); we guard the draft, then `assembleMission` adds the runtime fields. Coordinate `x`/`y` and `payoff` may arrive as `number | string` (an expression); normalisation to numbers happens in Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-kinds.test.ts
import { test, expect } from 'bun:test'
import { isMissionDraft, assembleMission, type MissionDraft } from '../src/mission/kinds.js'

const goodDraft: MissionDraft = {
  kind: 'CANDIDATE_INTENTION',
  payoff: 10,
  abstractIntent: 'move to a tile for points',
  params: { targetTile: { tag: 'TEXT_BOUND', x: 4, y: 7 } },
}

test('accepts a well-formed draft', () => {
  expect(isMissionDraft(goodDraft)).toBe(true)
})

test('rejects drafts missing required fields or with wrong types', () => {
  expect(isMissionDraft(null)).toBe(false)
  expect(isMissionDraft({ kind: 'NOPE', payoff: 1, abstractIntent: 'x', params: {} })).toBe(false)
  expect(isMissionDraft({ kind: 'QUERY', payoff: 'lots', abstractIntent: 'x', params: {} })).toBe(false)
  expect(isMissionDraft({ kind: 'QUERY', payoff: 1, params: {} })).toBe(false) // no abstractIntent
})

test('assembleMission adds id/rawText/status', () => {
  const m = assembleMission(goodDraft, 'hello text', 'm-1')
  expect(m.id).toBe('m-1')
  expect(m.rawText).toBe('hello text')
  expect(m.status).toBe('CLASSIFIED')
  expect(m.kind).toBe('CANDIDATE_INTENTION')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-kinds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/mission/kinds.ts
// The typed Mission (DESIGN §4.2 subset this slice produces) + the litellm function schemas
// + a hand-written boundary guard on `unknown`.

export type MissionKind =
  | 'QUERY' | 'CANDIDATE_INTENTION' | 'REWARD_SHAPER'
  | 'HARD_CONSTRAINT' | 'COORDINATION_CONTRACT' | 'FALLBACK'

export const MISSION_KINDS: readonly MissionKind[] = [
  'QUERY', 'CANDIDATE_INTENTION', 'REWARD_SHAPER',
  'HARD_CONSTRAINT', 'COORDINATION_CONTRACT', 'FALLBACK',
]

// FALLBACK never becomes a Mission this slice — it is discarded before install, so no
// Mission object ever carries a NOT_APPLICABLE status.
export type MissionStatus = 'CLASSIFIED' | 'SUPERSEDED'

export type TileSlot =
  | { tag: 'TEXT_BOUND'; x: number; y: number }   // transcribed literal (calc-normalised in Task 4)
  | { tag: 'RUNTIME_BOUND'; rule: string }        // runtime binds from map in #2 — unbound here

// Kind-specific transcribed params. Inert data this slice; #3 acts on shaper/constraint fields.
// x/y/payoff may arrive as number | string (an expression) — normalised to number in Task 4.
export interface MissionParams {
  targetTile?: TileSlot
  rule?: string
  m?: Record<string, number>                       // REWARD_SHAPER count→factor
  g?: Array<{ tile: TileSlot; factor: number }>     // REWARD_SHAPER tile→factor
  tile?: TileSlot                                   // HARD_CONSTRAINT
  filter?: string                                   // HARD_CONSTRAINT absolute
  contractType?: string                             // COORDINATION_CONTRACT
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

export function assembleMission(draft: MissionDraft, rawText: string, id: string): Mission {
  return { ...draft, id, rawText, status: 'CLASSIFIED' }
}

// ── litellm function (legacy `functions` API) schemas ─────────────────────────
// `parameters` is a JSON Schema object. `params` is left permissive (validated by the guard +
// normalised in Task 4) because it is kind-discriminated.

export const CALCULATE_FN = {
  name: 'calculate',
  description: 'Evaluate a numeric arithmetic expression (e.g. "4*2", "(1+3)*3"). Use this for any stated formula instead of computing it yourself.',
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
  description: 'Emit one typed mission. Classify into exactly one kind and transcribe ONLY values stated in the message. You have NO map and NO positions — never invent or locate coordinates. Transcribe the payoff SIGN exactly (+10 vs -10). When sign or hardness is ambiguous, treat it as a constraint to AVOID.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['CANDIDATE_INTENTION', 'REWARD_SHAPER', 'HARD_CONSTRAINT', 'COORDINATION_CONTRACT', 'FALLBACK'] },
      payoff: { type: 'number', description: 'Signed reward stated in the message' },
      abstractIntent: { type: 'string', description: 'One-line restatement of the goal' },
      sub: { type: 'string', enum: ['PRICED', 'ABSOLUTE'], description: 'HARD_CONSTRAINT flavour only' },
      deadline: { type: 'number', description: 'Latest tick to complete, if stated' },
      params: { type: 'object', description: 'Kind-specific transcribed params (tiles, count→factor map, filter, …)' },
    },
    required: ['kind', 'payoff', 'abstractIntent', 'params'],
  },
} as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-kinds.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/kinds.ts tests/mission-kinds.test.ts
git commit -m "feat(mission): Mission type, function schemas, draft guard (§4.2)"
```

---

## Task 3: `llm.ts` — typed litellm function-calling wrapper

**Files:**
- Create: `src/mission/llm.ts`
- Test: `tests/mission-kinds.test.ts` (extend — pure type/guard-level checks only; no network)

`llm.ts` owns the litellm types stub, the model-prefix guard, and `function_call` extraction. The compiler depends on the `ChatFn` interface (injected), so the compiler is tested with a fake — `llm.ts` itself has only the model-guard unit-tested (no network in CI).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/mission-kinds.test.ts
import { assertOpenAiModel } from '../src/mission/llm.js'

test('assertOpenAiModel accepts only OpenAI-handler model prefixes', () => {
  expect(() => assertOpenAiModel('gpt-4o-mini')).not.toThrow()
  expect(() => assertOpenAiModel('openai/local-model')).not.toThrow()
  expect(() => assertOpenAiModel('claude-3-5-sonnet')).toThrow(/function calling/i)
  expect(() => assertOpenAiModel('mistral/large')).toThrow(/function calling/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-kinds.test.ts`
Expected: FAIL — `assertOpenAiModel` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// src/mission/llm.ts
// Minimal typed wrapper over litellm `completion` for legacy function calling.
// litellm's TS types omit `functions`-on-call result, `name`-on-message, and `function_call`,
// but its OpenAI handler spreads all params into openai.chat.completions.create, so these
// fields reach the backend at runtime. We declare the wire shape locally (CLAUDE.md: minimal stubs).

import { completion } from 'litellm'
import type { Config } from '../types/config.js'

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'function'
  content: string | null
  name?: string                                  // required on role:'function' results
  function_call?: { name: string; arguments: string } // echoed on the assistant turn that called
}

export interface FunctionDef { name: string; description: string; parameters: Record<string, unknown> }
export interface FunctionCall { name: string; arguments: string }

// One turn: either the model called a function, or it returned plain content.
export type ChatTurn = { call: FunctionCall } | { content: string }
export type ChatFn = (msgs: ChatMsg[], fns: readonly FunctionDef[]) => Promise<ChatTurn>

const OPENAI_MODEL = /^(gpt-|openai\/)/

export function assertOpenAiModel(model: string): void {
  if (!OPENAI_MODEL.test(model)) {
    throw new Error(
      `LITELLM_MODEL="${model}" cannot do function calling: litellm routes only gpt-*/openai/* ` +
      `to the OpenAI handler; other handlers flatten messages and drop functions. ` +
      `Use an OpenAI-compatible model id and set LITELLM_BASE_URL.`,
    )
  }
}

export function makeChat(cfg: Config): ChatFn {
  assertOpenAiModel(cfg.LITELLM_MODEL)
  return async (msgs, fns) => {
    // litellm's HandlerParams type does not list `functions`/`function_call` on messages,
    // but the OpenAI handler forwards them — cast at this single boundary.
    const res = await completion({
      model: cfg.LITELLM_MODEL,
      apiKey: cfg.LITELLM_API_KEY,
      baseUrl: cfg.LITELLM_BASE_URL || undefined,
      temperature: 0,
      messages: msgs as unknown as { role: string; content: string | null }[],
      functions: fns as unknown as never,
      function_call: 'auto' as unknown as never,
      stream: false,
    })
    const msg = 'choices' in res ? res.choices[0]?.message : undefined
    const fc = msg?.function_call
    if (fc && typeof fc.name === 'string' && typeof fc.arguments === 'string') {
      return { call: { name: fc.name, arguments: fc.arguments } }
    }
    return { content: msg?.content ?? '' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-kinds.test.ts`
Expected: PASS (4 tests now).

- [ ] **Step 5: Commit**

```bash
git add src/mission/llm.ts tests/mission-kinds.test.ts
git commit -m "feat(mission): typed litellm function-calling wrapper + model guard"
```

---

## Task 4: `compiler.ts` — bounded ReAct loop

**Files:**
- Create: `src/mission/compiler.ts`
- Test: `tests/mission-compiler.test.ts`

The loop takes an injected `ChatFn` (real one from `llm.ts`, fake in tests). At most `MAX_ITERS = 4` turns. `calculate` results are fed back; `answer_query`/`emit_mission` are terminal. After `emit_mission`, expression-valued fields (`payoff`, `targetTile.x/y`, `tile.x/y`, `g[].tile.x/y`) are normalised via `calc`; an unparseable expression drops the mission as malformed.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-compiler.test.ts
import { test, expect } from 'bun:test'
import { compile } from '../src/mission/compiler.js'
import type { ChatFn, ChatTurn } from '../src/mission/llm.js'

// Build a fake ChatFn that replays a scripted sequence of turns.
function scripted(turns: ChatTurn[]): ChatFn {
  let i = 0
  return async () => turns[i++] ?? { content: '' }
}
const emit = (args: object): ChatTurn => ({ call: { name: 'emit_mission', arguments: JSON.stringify(args) } })
const answer = (text: string): ChatTurn => ({ call: { name: 'answer_query', arguments: JSON.stringify({ text }) } })
const calcCall = (expr: string): ChatTurn => ({ call: { name: 'calculate', arguments: JSON.stringify({ expr }) } })

test('compiles a CANDIDATE_INTENTION and transcribes the payoff sign', async () => {
  const pos = await compile('Move to (4,7) and get +10', scripted([
    emit({ kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go to tile', params: { targetTile: { tag: 'TEXT_BOUND', x: 4, y: 7 } } }),
  ]))
  expect(pos.kind).toBe('mission')
  if (pos.kind === 'mission') expect(pos.mission.payoff).toBe(10)

  const neg = await compile('Drop in leftmost tile to get -10', scripted([
    emit({ kind: 'CANDIDATE_INTENTION', payoff: -10, abstractIntent: 'drop leftmost', params: { rule: 'leftmost' } }),
  ]))
  if (neg.kind === 'mission') expect(neg.mission.payoff).toBe(-10)
})

test('answers a QUERY without producing a mission', async () => {
  const r = await compile('Capital of Italy?', scripted([answer('Rome')]))
  expect(r).toEqual({ kind: 'query', answer: 'Rome' })
})

test('feeds calculate results back, then emits', async () => {
  const r = await compile('Move to (4*2, (1+3)*3) get +5', scripted([
    calcCall('4*2'),
    calcCall('(1+3)*3'),
    emit({ kind: 'CANDIDATE_INTENTION', payoff: 5, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: 8, y: 12 } } }),
  ]))
  expect(r.kind).toBe('mission')
})

test('normalises an expression left in coordinates via calc', async () => {
  const r = await compile('go', scripted([
    emit({ kind: 'CANDIDATE_INTENTION', payoff: 5, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: '4*2', y: 7 } } }),
  ]))
  expect(r.kind).toBe('mission')
  if (r.kind === 'mission') {
    const t = r.mission.params.targetTile
    expect(t && t.tag === 'TEXT_BOUND' ? t.x : null).toBe(8)
  }
})

test('drops a mission whose coordinate expression is unparseable', async () => {
  const r = await compile('go', scripted([
    emit({ kind: 'CANDIDATE_INTENTION', payoff: 5, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: 'process()', y: 7 } } }),
  ]))
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})

test('FALLBACK is discarded as not_applicable (flag off)', async () => {
  const r = await compile('Visit every tile of the left room', scripted([
    emit({ kind: 'FALLBACK', payoff: 0, abstractIntent: 'coverage', params: {} }),
  ]))
  expect(r).toEqual({ kind: 'discard', reason: 'not_applicable' })
})

test('malformed emit args are discarded', async () => {
  const r = await compile('x', scripted([emit({ kind: 'NONSENSE', payoff: 1, abstractIntent: 'x', params: {} })]))
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})

test('exhausting the iteration cap with no terminal is malformed', async () => {
  const r = await compile('x', scripted([calcCall('1'), calcCall('1'), calcCall('1'), calcCall('1')]))
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-compiler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/mission/compiler.ts
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

    if (name === 'calculate') {
      const expr = (args as { expr?: unknown }).expr
      const v = typeof expr === 'string' ? calc(expr) : null
      msgs.push({ role: 'assistant', content: null, function_call: turn.call })
      msgs.push({ role: 'function', name: 'calculate', content: v === null ? 'error: invalid expression' : String(v) })
      continue
    }

    if (name === 'answer_query') {
      const text = (args as { text?: unknown }).text
      return typeof text === 'string'
        ? { kind: 'query', answer: text }
        : { kind: 'discard', reason: 'malformed' }
    }

    if (name === 'emit_mission') {
      if (!isMissionDraft(args)) return { kind: 'discard', reason: 'malformed' }
      if (args.kind === 'FALLBACK') return { kind: 'discard', reason: 'not_applicable' }
      const norm = normalize(args)
      if (norm === null) return { kind: 'discard', reason: 'malformed' }
      return { kind: 'mission', mission: assembleMission(norm, rawText, nextId()) }
    }

    return { kind: 'discard', reason: 'malformed' } // unknown function name
  }
  return { kind: 'discard', reason: 'malformed' } // cap hit, no terminal
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-compiler.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/compiler.ts tests/mission-compiler.test.ts
git commit -m "feat(mission): ReAct compiler loop with calc normalisation (§3/§4/§10)"
```

---

## Task 5: `slot.ts` — single mission slot

**Files:**
- Create: `src/mission/slot.ts`
- Test: `tests/mission-slot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-slot.test.ts
import { test, expect } from 'bun:test'
import { MissionSlot } from '../src/mission/slot.js'
import { assembleMission, type MissionDraft } from '../src/mission/kinds.js'

const draft: MissionDraft = { kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go', params: {} }
const mk = (id: string) => assembleMission(draft, 'raw', id)

test('install sets current and bumps epoch', () => {
  const s = new MissionSlot()
  expect(s.current()).toBeNull()
  const e0 = s.epoch()
  s.install(mk('a'))
  expect(s.current()?.id).toBe('a')
  expect(s.epoch()).toBeGreaterThan(e0)
})

test('install overwrites and bumps epoch again', () => {
  const s = new MissionSlot()
  s.install(mk('a'))
  const e1 = s.epoch()
  s.install(mk('b'))
  expect(s.current()?.id).toBe('b')
  expect(s.epoch()).toBeGreaterThan(e1)
})

test('supersede clears the slot, marks status, bumps epoch', () => {
  const s = new MissionSlot()
  const m = mk('a')
  s.install(m)
  const e1 = s.epoch()
  s.supersede()
  expect(s.current()).toBeNull()
  expect(m.status).toBe('SUPERSEDED')
  expect(s.epoch()).toBeGreaterThan(e1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-slot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/mission/slot.ts
// The single active mission slot (DESIGN §4.3). Overwrite tears down the previous mission's
// installed effects — a stub this slice (no shapers/tolls/locks/contracts exist yet); #3/#5
// fill teardown without changing callers.

import type { Mission } from './kinds.js'

export class MissionSlot {
  private slot: Mission | null = null
  private gen = 0

  install(m: Mission): void {
    if (this.slot) this.teardown(this.slot)
    this.slot = m
    this.gen++
  }

  current(): Mission | null { return this.slot }

  supersede(): void {
    if (this.slot) {
      this.slot.status = 'SUPERSEDED'
      this.teardown(this.slot)
      this.slot = null
      this.gen++
    }
  }

  epoch(): number { return this.gen }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private teardown(_m: Mission): void {
    // #3/#5: release reward shapers, A* tolls, MISSION parcel locks (§9.10), open contracts.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-slot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/slot.ts tests/mission-slot.test.ts
git commit -m "feat(mission): single mission slot with teardown seam (§4.3)"
```

---

## Task 6: `intake.ts` — coalescing window + epoch-guarded driver

**Files:**
- Create: `src/mission/intake.ts`
- Test: `tests/mission-intake.test.ts`

`createIntake` returns `{ onMessage, flush }`. `onMessage` buffers a `(from, raw)` and arms a one-shot window timer (real `setTimeout`); `flush` processes the buffered burst. Tests call `flush()` directly (no fake timers). Each message in the burst is compiled; `query` results are answered via `say(from, answer)`; the **last** `mission` result is installed **only if** the intake generation is unchanged since the flush began (epoch-guarded latest-wins — a newer burst that flushed mid-await wins).

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-intake.test.ts
import { test, expect } from 'bun:test'
import { createIntake } from '../src/mission/intake.js'
import { MissionSlot } from '../src/mission/slot.js'
import { assembleMission, type MissionDraft } from '../src/mission/kinds.js'
import type { CompileResult } from '../src/mission/compiler.js'
import { pino } from 'pino'

const draft: MissionDraft = { kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go', params: {} }
const missionResult = (id: string): CompileResult => ({ kind: 'mission', mission: assembleMission(draft, 'raw', id) })
const queryResult = (answer: string): CompileResult => ({ kind: 'query', answer })
const silentLog = pino({ level: 'silent' })

test('a burst answers every query and installs exactly one mission (the last)', async () => {
  const slot = new MissionSlot()
  const said: Array<[string, unknown]> = []
  const byText: Record<string, CompileResult> = {
    q1: queryResult('Rome'), q2: queryResult('25'), m1: missionResult('a'), m2: missionResult('b'),
  }
  const intake = createIntake({
    slot,
    compile: async (raw) => byText[raw]!,
    say: async (to, msg) => { said.push([to, msg]); return 'successful' },
    logger: silentLog,
  })
  intake.onMessage('srv', 'q1')
  intake.onMessage('srv', 'm1')
  intake.onMessage('srv', 'q2')
  intake.onMessage('srv', 'm2')
  await intake.flush()

  expect(said.map((s) => s[1])).toEqual(['Rome', '25'])
  expect(slot.current()?.id).toBe('b') // last mission wins
})

test('queries never touch the slot', async () => {
  const slot = new MissionSlot()
  const intake = createIntake({
    slot,
    compile: async () => queryResult('Rome'),
    say: async () => 'successful',
    logger: silentLog,
  })
  intake.onMessage('srv', 'capital of Italy?')
  await intake.flush()
  expect(slot.current()).toBeNull()
})

test('a stale flush (superseded mid-await) does not install', async () => {
  const slot = new MissionSlot()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const intake = createIntake({
    slot,
    compile: async (raw) => { if (raw === 'slow') await gate; return missionResult(raw) },
    say: async () => 'successful',
    logger: silentLog,
  })
  intake.onMessage('srv', 'slow')
  const first = intake.flush()        // begins, awaits the gate
  intake.onMessage('srv', 'fast')
  await intake.flush()                // second flush bumps gen, installs 'fast'
  expect(slot.current()?.id).toBe('fast')
  release()
  await first                         // first resolves stale → must NOT overwrite
  expect(slot.current()?.id).toBe('fast')
})

test('discards neither answer nor install', async () => {
  const slot = new MissionSlot()
  const said: unknown[] = []
  const intake = createIntake({
    slot,
    compile: async () => ({ kind: 'discard', reason: 'malformed' }),
    say: async (_to, msg) => { said.push(msg); return 'successful' },
    logger: silentLog,
  })
  intake.onMessage('srv', 'garbage')
  await intake.flush()
  expect(said).toEqual([])
  expect(slot.current()).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-intake.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/mission/intake.ts
// onMissionMsg intake: a ~1-tick coalescing window + epoch-guarded single-flight driver.
// DESIGN §10: every QUERY answered individually; the latest non-query becomes the active mission.

import type { Logger } from 'pino'
import type { MissionSlot } from './slot.js'
import type { CompileResult } from './compiler.js'

export interface IntakeDeps {
  slot: MissionSlot
  compile: (raw: string) => Promise<CompileResult>
  say: (toId: string, msg: unknown) => Promise<unknown>
  logger: Logger
  windowMs?: number // coalescing window; default ~1 tick (50ms)
}

export interface Intake {
  onMessage: (from: string, raw: string) => void
  flush: () => Promise<void>
}

export function createIntake(deps: IntakeDeps): Intake {
  const { slot, compile, say, logger } = deps
  const windowMs = deps.windowMs ?? 50
  let buffer: Array<{ from: string; raw: string }> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let gen = 0

  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null }
    const burst = buffer
    buffer = []
    if (burst.length === 0) return
    const myGen = ++gen // a later flush bumps gen → marks this one's mission install stale

    let lastMission: CompileResult & { kind: 'mission' } | null = null
    for (const { from, raw } of burst) {
      let res: CompileResult
      try {
        res = await compile(raw)
      } catch (err) {
        logger.warn({ module: 'mission', err: String(err) }, 'compile failed; keeping prior state')
        continue
      }
      if (res.kind === 'query') {
        void say(from, res.answer)
      } else if (res.kind === 'mission') {
        lastMission = res
      } else {
        logger.info({ module: 'mission', reason: res.reason }, 'mission discarded')
      }
    }

    if (lastMission && gen === myGen) {
      slot.install(lastMission.mission)
      logger.info(
        { module: 'mission', missionId: lastMission.mission.id, kind: lastMission.mission.kind, status: lastMission.mission.status },
        'mission installed',
      )
    } else if (lastMission) {
      logger.debug({ module: 'mission', missionId: lastMission.mission.id }, 'stale compile result discarded')
    }
  }

  function onMessage(from: string, raw: string): void {
    buffer.push({ from, raw })
    if (!timer) timer = setTimeout(() => { void flush() }, windowMs)
  }

  return { onMessage, flush }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-intake.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/intake.ts tests/mission-intake.test.ts
git commit -m "feat(mission): coalescing intake with epoch-guarded latest-wins (§10)"
```

---

## Task 7: Wire the Liaison + structural off-hot-loop guard

**Files:**
- Modify: `src/agents/liaison.ts`
- Create: `tests/mission-no-hotloop.test.ts`

First read the current `liaison.ts` to place the wiring exactly. The `boot` function already has `config`, `logger`, and a connected `client`; add the mission lane there.

- [ ] **Step 1: Write the failing structural test**

```ts
// tests/mission-no-hotloop.test.ts
import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

test('mission/ imports nothing from the BDI hot loop', () => {
  const dir = join(import.meta.dir, '..', 'src', 'mission')
  const offenders: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue
    const src = readFileSync(join(dir, f), 'utf8')
    for (const line of src.split('\n')) {
      if (/^\s*import\b/.test(line) && /bdi\/loop/.test(line)) offenders.push(`${f}: ${line.trim()}`)
    }
  }
  expect(offenders).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it passes already (guard holds before wiring)**

Run: `bun test tests/mission-no-hotloop.test.ts`
Expected: PASS — no `mission/` file imports `bdi/loop`. (This guard must stay green through Step 3.)

- [ ] **Step 3: Read `liaison.ts`, then wire the lane**

Run: read `src/agents/liaison.ts` fully. Inside `boot`, after the `client` is connected and the logger exists, add:

```ts
// near the other imports at the top of src/agents/liaison.ts
import { MissionSlot } from '../mission/slot.js'
import { makeChat } from '../mission/llm.js'
import { compile } from '../mission/compiler.js'
import { createIntake } from '../mission/intake.js'
```

```ts
// inside boot(), after `client` is connected and `logger` is available:
const missionSlot = new MissionSlot()
const chat = makeChat(config) // throws fast if LITELLM_MODEL is not an OpenAI-handler id
const intake = createIntake({
  slot: missionSlot,
  compile: (raw) => compile(raw, chat),
  say: (toId, msg) => client.say(toId, msg),
  logger: logger.child({ module: 'mission' }),
})
client.onMissionMsg((from, _name, raw) => {
  if (typeof raw === 'string') intake.onMessage(from, raw)
  else intake.onMessage(from, JSON.stringify(raw))
})
log.info({}, 'mission lane online')
```

> The variable names (`config`, `logger`, `log`, `client`) must match what `boot` actually declares — adjust to the real identifiers found when reading the file. Do NOT pass `missionSlot` into the BDI loop this slice (nothing reads it yet — that is slice #2).

- [ ] **Step 4: Verify the whole suite + the structural guard still pass, and the type-checks**

Run: `bun test`
Expected: PASS — all existing tests plus the five new `mission-*` suites. The `mission-no-hotloop` guard stays green (the wiring lives in `agents/liaison.ts`, not in `mission/`).

Run: `bunx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/liaison.ts tests/mission-no-hotloop.test.ts
git commit -m "feat(mission): wire Liaison onMissionMsg into the mission lane"
```

---

## Self-review notes (resolved)

- **Spec coverage:** §3/§3.1 transcribe + calc (Tasks 1,4); §4.1 classification (Task 4 prompt + tests); §4.2 schema (Task 2); §4.3 slot/overwrite/teardown stub (Task 5); §4.4 FALLBACK→discard (Task 4); §10 coalescing + latest-wins + QUERY-individual + never-blocks (Task 6, Task 7 wiring); §11 degradation (Task 6 try/catch, makeChat fail-fast); §12 `LLM_COALESCE_WINDOW` (Task 6 `windowMs`). Map-validation / `U_mission` / shapers / back-ends are explicitly out of scope per the spec.
- **Type consistency:** `MissionDraft`/`Mission`/`assembleMission`/`isMissionDraft` defined in Task 2 and used unchanged in Tasks 4–6; `ChatFn`/`ChatMsg`/`ChatTurn`/`FunctionCall` defined in Task 3 and consumed in Task 4; `CompileResult` defined in Task 4 and consumed in Task 6; `MissionSlot` API (`install`/`current`/`supersede`/`epoch`) defined in Task 5 and used in Task 6.
- **No placeholders:** every code step is complete and runnable; the only "adjust to real identifiers" note is Task 7's wiring against `liaison.ts`, which must be read at execution time.
- **Deviation from spec wording:** the guard is `isMissionDraft` (LLM payload) + `assembleMission`, rather than a single `isMission`, because the LLM does not emit `id`/`rawText`/`status`. Functionally equivalent; cleaner boundary.
