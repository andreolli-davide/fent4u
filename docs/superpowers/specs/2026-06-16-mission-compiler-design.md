# Mission compiler — the LLM lane (type · compiler · calc · intake · slot) — design

**Date:** 2026-06-16
**Scope slice:** DESIGN §3, §4 (typed front), §10 — compile a natural-language mission message into a typed `Mission` and park it; answer `QUERY` in channel. Liaison-only.
**Status:** approved for planning

## 1. Goal & scope

The Liaison (Agent B) is the only agent that holds the mission lane (DESIGN §2.1). Today `src/agents/liaison.ts` is a near-clone of `courier.ts`: it boots a pure BDI loop and never touches missions or the LLM. The `onMissionMsg` intake hook (`src/external/deliveroo.ts:194`) is unbound; `LITELLM_*` config (`src/types/config.ts`) is read by nothing.

This slice builds the **front of the mission lane**: a natural-language message arriving on the Liaison's channel is compiled — strictly off the 50 ms BDI loop — into a typed `Mission` object and written to a single mission slot, or, if it is a `QUERY`, answered in the channel without touching the slot. Nothing in this slice reads the slot or runs the LLM on the tick path.

**Done when:** an NL mission message → typed `Mission` in the slot (`status = CLASSIFIED`), a `QUERY` message → an answer sent via `say()` with the slot untouched, and a structural test proves `mission/` imports nothing from `bdi/loop` (the off-hot-loop invariant, §10).

**In scope:**
- The `Mission` type + JSON shape + runtime guard (DESIGN §4.2 typed subset).
- The async LLM compiler: classify into the 6 kinds, transcribe stated literals (§3.1), no spatial reasoning.
- A standalone safe-arithmetic `calculate` tool (§3.1 "evaluated by a calculator tool, not LLM arithmetic"), reused for coordinate exprs, payoff exprs, and `QUERY` math.
- The §10 cadence: ~1-tick coalescing window, latest non-query authoritative, every `QUERY` answered individually, never blocks the loop.
- Single mission slot with overwrite/teardown seam (§4.3).
- Wiring `liaison.ts onMissionMsg` → intake.

**Out of scope (deferred / forward-compat):**
- `P_feasible` map-validation of transcribed coordinates against the live map (§3.1 runtime gate) — deferred to the **mission-intention slice (#2)**, which owns belief/A* access. This slice only *tags* slots `TEXT_BOUND` vs `RUNTIME_BOUND`; it does not bind or validate them against the map.
- `U_mission`, the mission intention candidate, the selector wiring (§5.5, §9.9) — **#2**.
- `selfCheck` evaluation, reward shapers `m(k)`/`g(tile)`, hard-constraint tolls/filters (§6, §7) — these ride through the compiler as inert transcribed params and are *acted on* in **#3**.
- Coordination contracts (§8), `MISSION`-origin parcel locks (§9.10) — **#5**. Slot teardown is a stub this slice (no installed effects yet exist to release); the seam is present so #3/#5 drop real teardown in without touching callers.
- The `FALLBACK` back-ends (§17 PDDL, §18 LLM-agent). `FALLBACK=false` is a project constant (CLAUDE.md), so `FALLBACK` compiles to a discard (`NOT_APPLICABLE`).
- Mission-slot **replication** to the Courier. Per §4.4 the mission is assigned to one agent by bidding; cross-agent visibility arrives with #2. The slot is Liaison-local this slice.

## 2. Module layout & data flow

```
src/
  mission/
    kinds.ts      # Mission type, 6 MissionKind, MissionStatus, TileSlot tag union,
                  #   MISSION_TOOL_SCHEMA (the emit_mission tool args), isMission(u: unknown) guard
    calc.ts       # calc(expr: string): number | null — safe arithmetic over + - * / ( ) and numbers.
                  #   No eval / Function. Closed-grammar recursive-descent parser. Bounded input length.
    compiler.ts   # compile(rawText, cfg): Promise<CompileResult> — bounded ReAct loop over litellm
                  #   function-calling; pure transform, no game state, no map.
    slot.ts       # MissionSlot: install / current / supersede / epoch. Teardown seam (stub now).
    intake.ts     # onMissionMsg handler: coalescing window + single-flight epoch-guarded driver.
  agents/
    liaison.ts    # wire onMissionMsg -> intake (Courier never wires it)
```

End-to-end flow:

```
server msg --> onMissionMsg(from,name,raw) --> intake coalescing window (~1 tick, LLM_COALESCE_WINDOW)
  on window close:
    each QUERY-looking raw  --> compile() --> say(from, answer)            [slot untouched, §4.3]
    latest non-query raw    --> single-flight compile() (approach B):
        epoch0 = slot.epoch(); result = await compile(raw, cfg)
        if result.kind=='mission' AND slot.epoch()==epoch0 -> slot.install(mission)
        else -> discard (stale: a newer burst already won, §10 latest-wins)
```

Zero contact with beliefs or the BDI tick. The compiler `await`s network and yields between synchronous ticks; it is never called from `bdi/loop`.

## 3. The `Mission` type (`kinds.ts`)

Typed subset of DESIGN §4.2 — only fields this slice produces.

```ts
type MissionKind =
  | 'QUERY' | 'CANDIDATE_INTENTION' | 'REWARD_SHAPER'
  | 'HARD_CONSTRAINT' | 'COORDINATION_CONTRACT' | 'FALLBACK'

type MissionStatus =
  | 'CLASSIFIED'        // typed 1-of-5, parked in slot, not yet ACTIVE (ACTIVE wiring is #2)
  | 'SUPERSEDED'        // overwritten by a newer mission
  // FALLBACK never becomes a Mission this slice — it is discarded ('not_applicable') by the
  // compiler before install, so no Mission object ever carries a NOT_APPLICABLE status.

type TileSlot =
  | { tag: 'TEXT_BOUND'; x: number; y: number }    // transcribed literal (calc-normalised)
  | { tag: 'RUNTIME_BOUND'; rule: string }         // runtime binds from map in #2 — unbound here

interface Mission {
  id: string
  rawText: string                 // original message, for logging
  kind: MissionKind
  payoff: number                  // SIGNED reward; drives pursue/avoid (sign trap, §7.3)
  abstractIntent: string          // LLM always emits it (FALLBACK grounding input, §4.4)
  sub?: 'PRICED' | 'ABSOLUTE'     // HARD_CONSTRAINT flavour only
  theta?: number                  // per-mission weight override (advisory until #2)
  priority?: number               // advisory hint
  deadline?: number               // transcribed literal tick; feeds s_m in #2. Absent => no deadline
  params: MissionParams           // kind-specific transcribed params (tiles, m/g maps, filter, ...)
  assignment?: { mode: 'ANY_ONE' | 'ALL' | 'PREDICATE'; count?: number; predicate?: string }
  status: MissionStatus
  // selfCheck / installed / plan / L / P_feasible -> DEFERRED (#2/#3/#5)
}
```

`MissionParams` is a kind-discriminated record: `CANDIDATE_INTENTION` → `{ targetTile?: TileSlot; rule?: string }`; `REWARD_SHAPER` → `{ m?: Record<number, number>; g?: Array<{ tile: TileSlot; factor: number }> }`; `HARD_CONSTRAINT` → `{ tile?: TileSlot; filter?: string }`; `COORDINATION_CONTRACT` → `{ type: string; condition: string }`; `QUERY`/`FALLBACK` → `{}`. The shaper/constraint params are **inert transcribed data** this slice; #3 reads them.

`kinds.ts` also exports `MISSION_TOOL_SCHEMA` (the `emit_mission` tool's argument JSON schema, sent to litellm) and `isMission(u: unknown): u is Mission` — a hand-written guard on `unknown` matching the codebase pattern (`a2a.ts`, `claims.ts`); no validation dependency. The schema literal and the guard are the two artifacts kept in sync by hand.

## 4. The compiler (`compiler.ts`) — function-calling ReAct loop

`response_format` (structured output) and `tools` cannot be combined on most providers, and we need a callable `calculate`. So the compiler uses **function calling**, and the result is the **terminal tool call's arguments** — the tool-arg schema is the validation gate that `response_format` would otherwise provide.

```ts
type CompileResult =
  | { kind: 'mission'; mission: Mission }   // emit_mission terminal; status CLASSIFIED
  | { kind: 'query'; answer: string }       // answer_query terminal; slot untouched
  | { kind: 'discard'; reason: 'malformed' | 'not_applicable' }

async function compile(rawText: string, cfg: LiteLlmConfig): Promise<CompileResult>
```

Tools offered to the model:

| Tool | Role | Args |
|------|------|------|
| `calculate` | intermediate; loops back | `{ expr: string }` → number (compiler runs `calc.ts`, appends result) |
| `answer_query` | terminal — `QUERY` | `{ text: string }` |
| `emit_mission` | terminal — 1-of-5 typed | `MISSION_TOOL_SCHEMA` |

Loop (cap **4** iterations):

1. `litellm(messages, tools, tool_choice: 'required')`.
2. If the model calls `calculate` → run `calc.ts(expr)`; if `null` (outside grammar) append a tool error (model gets one chance to correct within the cap); else append the numeric result; continue.
3. If the model calls `answer_query` → `{ query, answer }`, exit.
4. If the model calls `emit_mission` → run args through `isMission`; if `kind === 'FALLBACK'` → `{ discard, 'not_applicable' }` (flag const false); else **normalisation pass** (§5) → `{ mission, status: 'CLASSIFIED' }`, exit.
5. Cap hit with no terminal, or `isMission` fails → `{ discard, 'malformed' }`.

System prompt: classify into the 6 kinds and **transcribe stated literals only — no map, no positions, no spatial reasoning** (§3.1); includes the §4.1 worked examples and the +10/−10 sign trap with the §7.3 *bias-to-avoid* rule for ambiguous sign/hardness. The compiler is a **pure transform**: no beliefs, no slot writes, no channel sends — the caller (intake, §6) owns every side effect. This is what makes the whole lane unit-testable with a mock litellm.

> **Single emit tool, cap 4** (decided, not open): one `emit_mission(kind, ...)` keeps `isMission` as one guard (vs. per-kind tools with tighter arg schemas); cap 4 bounds latency/cost (a normal mission needs 0–1 `calculate` calls).

> **Forward-compat (§18).** This 3-tool, stateless loop is a special case of §18's five-family LLM-agent registry. The back-end slice (#4) extends this loop (more tools, a world snapshot) rather than replacing it; `calc.ts` is the first registry member, so both back-ends compute arithmetic identically — same payoff as §4.4's "one shared cost estimator / one shared value scale" contracts.

## 5. The calculator (`calc.ts`) — shared, eval-free

`calc(expr: string): number | null`. A recursive-descent (or shunting-yard) parser over a **closed grammar**: decimal number literals and `+ - * / ( )` only. Any token outside the grammar → `null`. Input length bounded (cheap DoS guard).

**No `eval`, no `Function`/`new Function`.** The mission lane is the one path where external, attacker-influenceable text reaches code: messages originate from the server/opponent and are transcribed by the LLM. `eval` on that string is remote code execution in the Liaison worker — it could exfiltrate `LITELLM_API_KEY` (in config), call `process.exit()`, or hang the loop. The calculator therefore parses a closed grammar; it never interprets arbitrary JS. This is the §3.1 "transcribe, don't reason" rule expressed as a security boundary.

Used in three deterministic, post-parse places, all routing through the same function:
- the `calculate` tool executor (§4),
- a **normalisation pass** over any formula the model emitted *without* calling the tool — coordinate slot `x`/`y` and `payoff` may arrive as expr strings → normalise to numbers (a `TileSlot` `x`/`y` accepts `number | string` in the tool schema; normalisation resolves it),
- `QUERY` math.

A coordinate whose expr is unparseable → mission dropped as `malformed` (the §10 gate). Map-reachability validation remains deferred to #2.

## 6. Intake & slot (`intake.ts`, `slot.ts`) — §10 cadence, approach B

**`slot.ts` — single mission slot (§4.3):**

```ts
class MissionSlot {
  install(m: Mission): void   // teardown old (stub), set new, bump epoch
  current(): Mission | null
  supersede(): void           // mark SUPERSEDED + clear (teardown stub)
  epoch(): number             // generation counter, monotonic
}
```

Teardown is a stub this slice (no installed effects exist yet); #3/#5 fill it (release shapers, tolls, `MISSION` parcel locks, open contracts) without changing callers.

**`intake.ts` — coalescing + single-flight, epoch-guarded (approach B, latest-wins):**

- `onMissionMsg(from, name, raw)` pushes `raw` into a ~1-tick coalescing window (`LLM_COALESCE_WINDOW`, §12).
- On window close: every QUERY-looking message is compiled individually and answered via `say(from, answer)`; the **latest** non-query starts a compile. At most one compile in flight (single-flight); a burst arriving mid-compile buffers and only the latest is kept.
- On compile resolve, `slot.install(mission)` runs **only if `slot.epoch()` is unchanged** since the compile started; otherwise the result is stale (a newer burst won) and is discarded with a debug log. This optimistic compare-and-swap on the epoch counter realises §10's "latest non-query is authoritative" without locks or call cancellation, and mirrors the generation-counter pattern the blackboard already uses for delta liveness.

QUERYs never touch the slot, so a trivia question can never wipe a running mission (§4.3).

## 7. Error handling — degrade to "no new mission", never crash/freeze

Per §10/§11, every failure degrades to "keep the currently installed mission (or none)"; the agent never freezes or crashes on the mission path.

| Failure | Handling |
|---------|----------|
| litellm throws / times out / hangs | catch in intake; log; slot unchanged. Per-call timeout so a hang cannot pin the single-flight queue. Agent keeps old mission (§11). |
| ReAct cap (4) hit, no terminal tool | `discard('malformed')` + log (§10 gate) |
| terminal `emit_mission` args fail `isMission` | `discard('malformed')` + log |
| `calculate` expr outside grammar | tool returns error to model (one in-loop retry); local normalisation → unparseable coord drops the mission |
| `FALLBACK` kind | `discard('not_applicable')` (flag const false, CLAUDE.md) |
| stale resolve (epoch moved) | drop result silently (debug log) — latest already won |
| burst of N messages | N `QUERY` answers + exactly 1 mission install (§10) |

All logging via a Pino child `logger.child({ agentId: 'liaison', module: 'mission' })`; mission lifecycle events at `info` with `{ missionId, kind, status, tick }` (CLAUDE.md observability). Never `console.log`.

## 8. Testing — mock litellm, fully offline

Mirrors the existing 32-file suite; the compiler's pure-transform shape lets every test run with a mock litellm and zero network.

- `calc.test.ts` — closed-grammar eval (`4*2`→8, `(1+3)*3`→12); rejects eval-bait (`process`, `;`, `()=>`, identifiers); bounded length; non-numeric → `null`.
- `compiler.test.ts` — each of the 6 kinds classifies; +10 vs −10 sign trap transcribes the sign; `QUERY`→answer; `FALLBACK`→`discard('not_applicable')`; malformed terminal args→`discard('malformed')`; `calculate` tool-loop resolves a coordinate expr; cap-4 with no terminal→`discard('malformed')`.
- `slot.test.ts` — install/current/supersede; teardown-stub invoked on overwrite; epoch bumps monotonically.
- `intake.test.ts` — coalesce a burst → N answers + exactly 1 install; **stale-epoch resolve is discarded** (approach-B core); `QUERY` never touches the slot.
- structural guard — a test asserting `mission/` imports nothing from `bdi/loop` (encodes the off-hot-loop invariant, §10, as an architectural fitness function).

## 9. DESIGN traceability

| DESIGN | This slice |
|--------|-----------|
| §3 / §3.1 transcribe-vs-bind | compiler transcribes literals only; calc evaluates stated formulas; map-validation deferred to #2 |
| §4.1 classification | system prompt + worked examples; `compiler.test.ts` |
| §4.2 schema | `Mission` typed subset (`kinds.ts`) |
| §4.3 single slot / overwrite / teardown | `MissionSlot`; QUERY leaves slot untouched; teardown seam stubbed |
| §4.4 FALLBACK / switch OFF | `FALLBACK` → `discard('not_applicable')` (flag const false) |
| §10 cadence | coalescing window, latest-wins via epoch CAS, QUERY answered individually, never blocks |
| §11 degradation | §7 error table |
| §12 params | `LLM_COALESCE_WINDOW` |
