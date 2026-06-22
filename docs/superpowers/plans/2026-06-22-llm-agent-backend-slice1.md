# §18 LLM-agent back-end — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under the `LLM_AGENT` switch, an autonomous off-loop ReAct lane answers a QUERY end-to-end or compiles a step-list plan that is costed (`L`, `V_plan`) and scored as a `U_mission` candidate — with zero LLM work on the 50 ms tick path and the `OFF` typed path untouched.

**Architecture:** New module `src/mission/agent/` (snapshot + tools + cost + loop), separate from the existing `compile()` typed lane. The ReAct engine reasons against a frozen `WorldSnapshot`, records `goto/pickup/deliver/wait` as forward-applied steps, and terminates via `emit_plan` (→ AGENT_PLAN mission) or `answer` (→ QUERY). A 3-way `MISSION_HANDLER` switch in liaison dispatches `OFF`→`compile`, `LLM_AGENT`→`reactPlan`, `PDDL`→throw. Tick-by-tick execution of the step-list is a later slice; slice 1 stops at compile-and-score.

**Tech Stack:** Bun + TypeScript (strict, ESM, `.js` import suffixes). OpenAI SDK via the hardened `src/mission/llm.ts` wrapper. Tests with `bun test`.

## Global Constraints

- `strict: true` tsconfig — no `any`; use `unknown` + type guards at boundaries.
- ESM: `import`/`export`, `.js` suffix on relative imports.
- One concept per file; keep files focused.
- No `console.log` — use the Pino logger.
- No LLM/planner work inside the 50 ms BDI loop — the ReAct lane is async, off-loop.
- The LLM acts ONLY through the tool registry — never reads the raw grid, never computes geometry, never touches the a2a wire.
- LLM-branch constants (verbatim): `theta_llm = 0.45`, `c_llm = 1.2`, `MAX_ITERS = 12`, `MAX_ITERS_QUERY = 3`, `BATCH_MAX = 6`, `RETRY = 1`.
- `reactPlan` returns the existing `CompileResult` union from `src/mission/compiler.ts` so the intake/slot path is reused unchanged.
- Slice 1 keeps an AGENT_PLAN mission **liaison-local** (not broadcast to the courier) — no multi-agent assignment yet.

---

## File Structure

- Create: `src/mission/agent/snapshot.ts` — `WorldSnapshot`, `forwardApply`, `beliefSignature`.
- Create: `src/mission/agent/tools.ts` — tool schemas (`FunctionDef[]`) + `executeRead` / `applyAction` dispatch.
- Create: `src/mission/agent/cost.ts` — `costPlan(steps, grid, snap, …) → { L, vPlan, reachable }`.
- Create: `src/mission/agent/loop.ts` — `reactPlan(text, snap, chat, params) → CompileResult`.
- Modify: `src/types/config.ts` — add `MISSION_HANDLER`.
- Modify: `src/bdi/params.ts` — add LLM-branch constants.
- Modify: `src/mission/kinds.ts` — add `AgentStep`, `AGENT_PLAN` kind, `plan` field on `Mission`/`MissionDraft`, guard.
- Modify: `src/bdi/mission-intention.ts` — `uMission` AGENT_PLAN branch.
- Modify: `src/agents/liaison.ts` — switch dispatch, snapshot build, born-stale, liaison-local install, PDDL throw.

---

### Task 1: `MISSION_HANDLER` config switch

**Files:**
- Modify: `src/types/config.ts`
- Test: `tests/config.test.ts` (append)

**Interfaces:**
- Produces: `Config.MISSION_HANDLER: 'OFF' | 'LLM_AGENT' | 'PDDL'` (default `'OFF'`).

- [ ] **Step 1: Write the failing test** — append to `tests/config.test.ts`:

```ts
test('MISSION_HANDLER defaults to OFF and rejects unknown values', () => {
  const base = {
    DELIVEROO_HOST: 'h', DELIVEROO_PORT: '8080',
    TOKEN_LIAISON: 'a', TOKEN_COURIER: 'b',
    OPENAI_MODEL: 'm', OPENAI_API_KEY: 'k',
  }
  expect(parseConfig({ ...base }).MISSION_HANDLER).toBe('OFF')
  expect(parseConfig({ ...base, MISSION_HANDLER: 'LLM_AGENT' }).MISSION_HANDLER).toBe('LLM_AGENT')
  expect(() => parseConfig({ ...base, MISSION_HANDLER: 'bogus' })).toThrow(/MISSION_HANDLER/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL (`MISSION_HANDLER` is `undefined`).

- [ ] **Step 3: Implement** — in `src/types/config.ts`:

Add to the `Config` interface:
```ts
  MISSION_HANDLER: 'OFF' | 'LLM_AGENT' | 'PDDL'
```
Inside `parseConfig`, before the `return`:
```ts
  const handler = env.MISSION_HANDLER ?? 'OFF'
  if (!['OFF', 'LLM_AGENT', 'PDDL'].includes(handler)) {
    throw new Error(`Invalid MISSION_HANDLER: ${handler}`)
  }
```
Add to the returned object:
```ts
    MISSION_HANDLER: handler as Config['MISSION_HANDLER'],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/config.ts tests/config.test.ts
git commit -m "feat(config): add MISSION_HANDLER three-way switch (default OFF)"
```

---

### Task 2: LLM-branch params

**Files:**
- Modify: `src/bdi/params.ts`
- Test: `tests/bdi-params.test.ts` (append)

**Interfaces:**
- Produces on `Params`: `theta_llm`, `c_llm`, `max_iters`, `max_iters_query`, `batch_max` (all `number`).

- [ ] **Step 1: Write the failing test** — append to `tests/bdi-params.test.ts`:

```ts
test('LLM-branch params have the spec defaults', () => {
  expect(DEFAULT_PARAMS.theta_llm).toBe(0.45)
  expect(DEFAULT_PARAMS.c_llm).toBe(1.2)
  expect(DEFAULT_PARAMS.max_iters).toBe(12)
  expect(DEFAULT_PARAMS.max_iters_query).toBe(3)
  expect(DEFAULT_PARAMS.batch_max).toBe(6)
})
```
(Ensure the file imports `DEFAULT_PARAMS` from `../src/bdi/params.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-params.test.ts`
Expected: FAIL (`undefined`).

- [ ] **Step 3: Implement** — in `src/bdi/params.ts`:

Add to the `Params` interface:
```ts
  theta_llm: number        // §18.9 humility weight for the LLM-agent branch (< theta_mission)
  c_llm: number            // §18.9 tighter rate ceiling for the LLM-agent branch
  max_iters: number        // §18.9 max ReAct turns per plan mission
  max_iters_query: number  // §18.9 max ReAct turns for an atomic QUERY
  batch_max: number        // §18.4 independent tool calls per turn
```
Add to `DEFAULT_PARAMS`:
```ts
  theta_llm: 0.45,
  c_llm: 1.2,
  max_iters: 12,
  max_iters_query: 3,
  batch_max: 6,
```
Add to `RANGES`:
```ts
  theta_llm: [0, 4],
  c_llm: [0, 10],
  max_iters: [1, 100],
  max_iters_query: [1, 100],
  batch_max: [1, 50],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bdi-params.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/params.ts tests/bdi-params.test.ts
git commit -m "feat(params): add LLM-agent branch constants (theta_llm, c_llm, iters)"
```

---

### Task 3: `AGENT_PLAN` mission shape

**Files:**
- Modify: `src/mission/kinds.ts`
- Test: `tests/mission-kinds.test.ts` (append)

**Interfaces:**
- Produces:
  - `AgentStep = { op:'goto'; target:Pos } | { op:'pickup'; parcelId:string } | { op:'deliver'; zone:Pos } | { op:'wait'; n:number }`
  - `AgentPlan = { steps: AgentStep[]; L: number; vPlan: number }`
  - `'AGENT_PLAN'` added to `MissionKind` / `MISSION_KINDS`.
  - optional `plan?: AgentPlan` on `MissionDraft` (inherited by `Mission`).
  - `isAgentStep(u): u is AgentStep` guard.

- [ ] **Step 1: Write the failing test** — append to `tests/mission-kinds.test.ts`:

```ts
import { isAgentStep, MISSION_KINDS } from '../src/mission/kinds.js'

test('AGENT_PLAN is a known kind and AgentStep guard discriminates ops', () => {
  expect(MISSION_KINDS).toContain('AGENT_PLAN')
  expect(isAgentStep({ op: 'goto', target: { x: 1, y: 2 } })).toBe(true)
  expect(isAgentStep({ op: 'pickup', parcelId: 'p1' })).toBe(true)
  expect(isAgentStep({ op: 'deliver', zone: { x: 0, y: 0 } })).toBe(true)
  expect(isAgentStep({ op: 'wait', n: 3 })).toBe(true)
  expect(isAgentStep({ op: 'fly' })).toBe(false)
  expect(isAgentStep({ op: 'goto' })).toBe(false)
  expect(isAgentStep(null)).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-kinds.test.ts`
Expected: FAIL (`isAgentStep` not exported).

- [ ] **Step 3: Implement** — in `src/mission/kinds.ts`:

Add the import at the top:
```ts
import type { Pos } from '../types/perception.js'
```
Add `'AGENT_PLAN'` to both `MissionKind` and the `MISSION_KINDS` array.
After `MissionParams`, add:
```ts
export type AgentStep =
  | { op: 'goto'; target: Pos }
  | { op: 'pickup'; parcelId: string }
  | { op: 'deliver'; zone: Pos }
  | { op: 'wait'; n: number }

// A costed agent plan (§18.9): the ordered steps plus the shared-A* tick length and kernel value.
export interface AgentPlan {
  steps: AgentStep[]
  L: number
  vPlan: number
}

const isPos = (v: unknown): v is Pos =>
  typeof v === 'object' && v !== null &&
  typeof (v as Pos).x === 'number' && typeof (v as Pos).y === 'number'

export function isAgentStep(u: unknown): u is AgentStep {
  if (typeof u !== 'object' || u === null) return false
  const s = u as Record<string, unknown>
  switch (s.op) {
    case 'goto': return isPos(s.target)
    case 'pickup': return typeof s.parcelId === 'string'
    case 'deliver': return isPos(s.zone)
    case 'wait': return typeof s.n === 'number' && Number.isFinite(s.n)
    default: return false
  }
}
```
Add `plan?: AgentPlan` to the `MissionDraft` interface (it is inherited by `Mission`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-kinds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mission/kinds.ts tests/mission-kinds.test.ts
git commit -m "feat(kinds): add AGENT_PLAN mission kind, AgentStep, AgentPlan"
```

---

### Task 4: `WorldSnapshot` + forward-apply + signature

**Files:**
- Create: `src/mission/agent/snapshot.ts`
- Test: `tests/agent-snapshot.test.ts`

**Interfaces:**
- Consumes: `AgentStep` (Task 3), `Pos` (`src/types/perception.js`).
- Produces:
  - `interface SnapParcel { id:string; pos:Pos; reward:number; carriedBy:string|null }`
  - `interface WorldSnapshot { t0:number; selfPos:Pos; carried:string[]; delivered:Array<{ id:string; zone:Pos }>; parcels:SnapParcel[]; zones:Pos[]; partnerPos:Pos|null; sig:string }`
  - `forwardApply(s: WorldSnapshot, step: AgentStep): WorldSnapshot` (pure, returns a new object)
  - `beliefSignature(parcels: SnapParcel[], selfPos: Pos): string`

- [ ] **Step 1: Write the failing test** — create `tests/agent-snapshot.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { forwardApply, beliefSignature, type WorldSnapshot } from '../src/mission/agent/snapshot.js'

const base = (): WorldSnapshot => ({
  t0: 100,
  selfPos: { x: 0, y: 0 },
  carried: [],
  delivered: [],
  parcels: [{ id: 'p1', pos: { x: 2, y: 0 }, reward: 30, carriedBy: null }],
  zones: [{ x: 5, y: 0 }],
  partnerPos: null,
  sig: 'x',
})

test('goto moves the simulated self position', () => {
  const s = forwardApply(base(), { op: 'goto', target: { x: 2, y: 0 } })
  expect(s.selfPos).toEqual({ x: 2, y: 0 })
})

test('pickup adds the parcel to carried and marks it carried by self', () => {
  const s = forwardApply(base(), { op: 'pickup', parcelId: 'p1' })
  expect(s.carried).toEqual(['p1'])
  expect(s.parcels.find((p) => p.id === 'p1')?.carriedBy).toBe('self')
})

test('deliver moves carried parcels into delivered at the zone', () => {
  const picked = forwardApply(base(), { op: 'pickup', parcelId: 'p1' })
  const s = forwardApply(picked, { op: 'deliver', zone: { x: 5, y: 0 } })
  expect(s.carried).toEqual([])
  expect(s.delivered).toEqual([{ id: 'p1', zone: { x: 5, y: 0 } }])
})

test('wait does not change position or carried', () => {
  const s = forwardApply(base(), { op: 'wait', n: 3 })
  expect(s.selfPos).toEqual({ x: 0, y: 0 })
  expect(s.carried).toEqual([])
})

test('forwardApply does not mutate the input snapshot', () => {
  const b = base()
  forwardApply(b, { op: 'goto', target: { x: 9, y: 9 } })
  expect(b.selfPos).toEqual({ x: 0, y: 0 })
})

test('beliefSignature changes when a parcel position changes', () => {
  const a = beliefSignature(base().parcels, base().selfPos)
  const moved = [{ id: 'p1', pos: { x: 3, y: 0 }, reward: 30, carriedBy: null }]
  expect(beliefSignature(moved, base().selfPos)).not.toBe(a)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-snapshot.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/mission/agent/snapshot.ts`:

```ts
// §18.4 frozen world snapshot + deterministic egocentric forward-application of the agent's
// OWN action effects (enemies not modelled — static-world assumption §17.7.4). Pure: every
// forwardApply returns a fresh snapshot, so a later read tool observes the simulated state.

import type { Pos } from '../../types/perception.js'
import type { AgentStep } from '../kinds.js'

export interface SnapParcel { id: string; pos: Pos; reward: number; carriedBy: string | null }

export interface WorldSnapshot {
  t0: number
  selfPos: Pos
  carried: string[]
  delivered: Array<{ id: string; zone: Pos }>
  parcels: SnapParcel[]
  zones: Pos[]
  partnerPos: Pos | null
  sig: string
}

export function forwardApply(s: WorldSnapshot, step: AgentStep): WorldSnapshot {
  switch (step.op) {
    case 'goto':
      return { ...s, selfPos: { ...step.target } }
    case 'pickup': {
      if (s.carried.includes(step.parcelId)) return s
      return {
        ...s,
        carried: [...s.carried, step.parcelId],
        parcels: s.parcels.map((p) => (p.id === step.parcelId ? { ...p, carriedBy: 'self' } : p)),
      }
    }
    case 'deliver': {
      if (s.carried.length === 0) return s
      const newlyDelivered = s.carried.map((id) => ({ id, zone: { ...step.zone } }))
      return { ...s, carried: [], delivered: [...s.delivered, ...newlyDelivered] }
    }
    case 'wait':
      return s
  }
}

// A stable string of the volatile beliefs used for the born-stale freshness check (§18.4).
export function beliefSignature(parcels: SnapParcel[], selfPos: Pos): string {
  const ps = [...parcels]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}:${p.pos.x},${p.pos.y}:${p.carriedBy ?? ''}`)
    .join('|')
  return `${selfPos.x},${selfPos.y}#${ps}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent-snapshot.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/agent/snapshot.ts tests/agent-snapshot.test.ts
git commit -m "feat(agent): WorldSnapshot, forward-apply, belief signature"
```

---

### Task 5: Tool registry (schemas + dispatch)

**Files:**
- Create: `src/mission/agent/tools.ts`
- Test: `tests/agent-tools.test.ts`

**Interfaces:**
- Consumes: `WorldSnapshot`, `forwardApply` (Task 4); `AgentStep` (Task 3); `calc` (`src/mission/calc.js`); `FunctionDef` (`src/mission/llm.js`).
- Produces:
  - `AGENT_TOOLS: readonly FunctionDef[]` — the slice-1 registry (perception + world + free-form + `emit_plan`).
  - `isReadTool(name: string): boolean` and `isActionTool(name: string): boolean`.
  - `executeRead(snap: WorldSnapshot, name: string, args: Record<string, unknown>): string` — observation text for a read/calculate tool.
  - `actionStep(name: string, args: Record<string, unknown>): AgentStep | null` — maps a world-action call to a step (or null if invalid).

- [ ] **Step 1: Write the failing test** — create `tests/agent-tools.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { AGENT_TOOLS, isReadTool, isActionTool, executeRead, actionStep } from '../src/mission/agent/tools.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'

const snap: WorldSnapshot = {
  t0: 0, selfPos: { x: 1, y: 1 }, carried: [], delivered: [],
  parcels: [{ id: 'p1', pos: { x: 2, y: 2 }, reward: 40, carriedBy: null }],
  zones: [{ x: 5, y: 5 }], partnerPos: { x: 0, y: 0 }, sig: 's',
}

test('registry exposes the slice-1 tools', () => {
  const names = AGENT_TOOLS.map((t) => t.name)
  for (const n of ['get_my_position', 'scan_world', 'get_parcel', 'list_delivery_zones',
                   'get_partner_status', 'goto', 'pickup', 'deliver', 'wait',
                   'calculate', 'answer', 'emit_plan']) {
    expect(names).toContain(n)
  }
})

test('tool classification', () => {
  expect(isReadTool('get_my_position')).toBe(true)
  expect(isReadTool('calculate')).toBe(true)
  expect(isActionTool('goto')).toBe(true)
  expect(isActionTool('answer')).toBe(false)
})

test('executeRead returns observations from the snapshot', () => {
  expect(executeRead(snap, 'get_my_position', {})).toContain('1,1')
  expect(executeRead(snap, 'get_parcel', { id: 'p1' })).toContain('40')
  expect(executeRead(snap, 'list_delivery_zones', {})).toContain('5,5')
  expect(executeRead(snap, 'calculate', { expr: '6*7' })).toBe('42')
  expect(executeRead(snap, 'calculate', { expr: 'junk' })).toContain('error')
})

test('actionStep maps world-action calls to steps', () => {
  expect(actionStep('goto', { target: { x: 2, y: 2 } })).toEqual({ op: 'goto', target: { x: 2, y: 2 } })
  expect(actionStep('pickup', { parcelId: 'p1' })).toEqual({ op: 'pickup', parcelId: 'p1' })
  expect(actionStep('goto', { target: { x: 'a', y: 2 } })).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-tools.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/mission/agent/tools.ts`:

```ts
// §18.5 slice-1 tool registry (three families): perception(read) + world-actions(steps)
// + free-form (calculate / answer / emit_plan). The LLM never computes geometry — reads hit
// the snapshot; route_cost and grid validation live in cost.ts / the loop.

import type { FunctionDef } from '../llm.js'
import type { AgentStep } from '../kinds.js'
import type { WorldSnapshot } from './snapshot.js'
import { calc } from '../calc.js'

const READ = new Set(['get_my_position', 'scan_world', 'get_parcel', 'list_delivery_zones',
  'get_partner_status', 'calculate'])
const ACTION = new Set(['goto', 'pickup', 'deliver', 'wait'])

export const isReadTool = (name: string): boolean => READ.has(name)
export const isActionTool = (name: string): boolean => ACTION.has(name)

const POS = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }

export const AGENT_TOOLS: readonly FunctionDef[] = [
  { name: 'get_my_position', description: 'Return your current (simulated) position.', parameters: { type: 'object', properties: {} } },
  { name: 'scan_world', description: 'List visible parcels (id, position, reward) and delivery zones.', parameters: { type: 'object', properties: {} } },
  { name: 'get_parcel', description: 'Return one parcel by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_delivery_zones', description: 'List delivery-zone positions.', parameters: { type: 'object', properties: {} } },
  { name: 'get_partner_status', description: 'Return the partner agent position if known.', parameters: { type: 'object', properties: {} } },
  { name: 'goto', description: 'Plan step: walk to a tile. Costed by A*.', parameters: { type: 'object', properties: { target: POS }, required: ['target'] } },
  { name: 'pickup', description: 'Plan step: pick up a parcel by id.', parameters: { type: 'object', properties: { parcelId: { type: 'string' } }, required: ['parcelId'] } },
  { name: 'deliver', description: 'Plan step: deliver carried parcels at a zone.', parameters: { type: 'object', properties: { zone: POS }, required: ['zone'] } },
  { name: 'wait', description: 'Plan step: wait n ticks.', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
  { name: 'calculate', description: 'Evaluate an arithmetic expression exactly. Use for any stated formula instead of computing yourself.', parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } },
  { name: 'answer', description: 'Terminal for a QUERY: post a natural-language reply to the mission-agent.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'emit_plan', description: 'Terminal for a plan: emit the signed payoff, optional deadline tick, and the ordered step-list.', parameters: { type: 'object', properties: { payoff: { type: 'number' }, deadline: { type: 'number' }, steps: { type: 'array', items: { type: 'object' } } }, required: ['payoff', 'steps'] } },
]

const isPos = (v: unknown): v is { x: number; y: number } =>
  typeof v === 'object' && v !== null &&
  typeof (v as { x: unknown }).x === 'number' && typeof (v as { y: unknown }).y === 'number'

export function executeRead(snap: WorldSnapshot, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'get_my_position':
      return `${snap.selfPos.x},${snap.selfPos.y}`
    case 'scan_world':
      return JSON.stringify({
        parcels: snap.parcels.map((p) => ({ id: p.id, pos: p.pos, reward: p.reward, carriedBy: p.carriedBy })),
        zones: snap.zones,
      })
    case 'get_parcel': {
      const p = snap.parcels.find((q) => q.id === args.id)
      return p ? JSON.stringify({ id: p.id, pos: p.pos, reward: p.reward, carriedBy: p.carriedBy }) : 'error: no such parcel'
    }
    case 'list_delivery_zones':
      return JSON.stringify(snap.zones)
    case 'get_partner_status':
      return snap.partnerPos ? `${snap.partnerPos.x},${snap.partnerPos.y}` : 'unknown'
    case 'calculate': {
      const v = typeof args.expr === 'string' ? calc(args.expr) : null
      return v === null ? 'error: invalid expression' : String(v)
    }
    default:
      return 'error: unknown read tool'
  }
}

export function actionStep(name: string, args: Record<string, unknown>): AgentStep | null {
  switch (name) {
    case 'goto': return isPos(args.target) ? { op: 'goto', target: { x: args.target.x, y: args.target.y } } : null
    case 'pickup': return typeof args.parcelId === 'string' ? { op: 'pickup', parcelId: args.parcelId } : null
    case 'deliver': return isPos(args.zone) ? { op: 'deliver', zone: { x: args.zone.x, y: args.zone.y } } : null
    case 'wait': return typeof args.n === 'number' && Number.isFinite(args.n) ? { op: 'wait', n: args.n } : null
    default: return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/agent/tools.ts tests/agent-tools.test.ts
git commit -m "feat(agent): slice-1 tool registry with read/action dispatch"
```

---

### Task 6: Plan costing (`L`, `V_plan`)

**Files:**
- Create: `src/mission/agent/cost.ts`
- Test: `tests/agent-cost.test.ts`

**Interfaces:**
- Consumes: `AgentStep` (Task 3); `WorldSnapshot`, `SnapParcel` (Task 4); `planPath`, `buildGrid`, `Grid`, `PlanCtx` (`src/planning/astar.js`); `vValue`, `DecayConsts` (`src/bdi/utility.js`); `ParcelBelief` (`src/blackboard/beliefs.js`); `Tile` (`src/types/perception.js`).
- Produces: `interface PlanCost { L: number; vPlan: number; reachable: boolean }` and `costPlan(steps: AgentStep[], grid: Grid, snap: WorldSnapshot, tnow: number, dc: DecayConsts, budgetMs: number): PlanCost`.

- [ ] **Step 1: Write the failing test** — create `tests/agent-cost.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { buildGrid } from '../src/planning/astar.js'
import { decayConsts } from '../src/bdi/utility.js'
import { costPlan } from '../src/mission/agent/cost.js'
import type { Tile, GameConsts } from '../src/types/perception.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'

// 1x6 open corridor, y=0, x=0..5; delivery zone at x=5 (TileType '2' = delivery).
const map: Tile[] = []
for (let x = 0; x <= 5; x++) map.push({ pos: { x, y: 0 }, type: x === 5 ? '2' : '1' })
const grid = buildGrid(map)
const consts: GameConsts = { PARCEL_DECAY_TICKS: Infinity, MOVEMENT_DURATION: 50, CLOCK: 50 } as GameConsts
const dc = decayConsts(consts)

const snap: WorldSnapshot = {
  t0: 0, selfPos: { x: 0, y: 0 }, carried: [], delivered: [],
  parcels: [{ id: 'p1', pos: { x: 2, y: 0 }, reward: 30, carriedBy: null }],
  zones: [{ x: 5, y: 0 }], partnerPos: null, sig: 's',
}

test('costs goto legs into L and values a delivered parcel into vPlan', () => {
  const steps = [
    { op: 'goto', target: { x: 2, y: 0 } },
    { op: 'pickup', parcelId: 'p1' },
    { op: 'goto', target: { x: 5, y: 0 } },
    { op: 'deliver', zone: { x: 5, y: 0 } },
  ] as const
  const cost = costPlan([...steps], grid, snap, 0, dc, 8)
  expect(cost.reachable).toBe(true)
  expect(cost.L).toBe(5)        // 0->2 (2) + 2->5 (3)
  expect(cost.vPlan).toBe(30)   // p1 reward, no decay (infinite decay), delivered at zone
})

test('unreachable goto marks the plan not reachable', () => {
  const walled: Tile[] = [{ pos: { x: 0, y: 0 }, type: '1' }]
  const g2 = buildGrid(walled)
  const cost = costPlan([{ op: 'goto', target: { x: 9, y: 9 } }], g2, snap, 0, dc, 8)
  expect(cost.reachable).toBe(false)
})
```
(If `'2'`/`'1'` are not the delivery/walkable `TileType` codes in `src/types/perception.ts`, use the correct codes — check the `TileType` union there before writing the fixture.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-cost.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/mission/agent/cost.ts`:

```ts
// §18.9 reintegration: cost the emitted step-list with the SAME push-aware A* (so L is in the
// same tick unit as every typed mission), and value the delivered set with the §5.4 kernel.

import { planPath, type Grid, type PlanCtx } from '../../planning/astar.js'
import { vValue, type DecayConsts } from '../../bdi/utility.js'
import type { ParcelBelief } from '../../blackboard/beliefs.js'
import type { AgentStep } from '../kinds.js'
import type { Pos } from '../../types/perception.js'
import type { WorldSnapshot, SnapParcel } from './snapshot.js'

export interface PlanCost { L: number; vPlan: number; reachable: boolean }

const emptyCtx = (budgetMs: number): PlanCtx => ({
  obstacles: { crateAt: new Map(), agentAt: new Set() }, // enemies not modelled (§17.7.4)
  protectedTiles: [],
  budgetMs,
})

const asBelief = (p: SnapParcel, t0: number): ParcelBelief =>
  ({ id: p.id, pos: p.pos, rewardSeen: p.reward, carriedBy: p.carriedBy, lastSeen: t0 })

export function costPlan(
  steps: AgentStep[], grid: Grid, snap: WorldSnapshot, tnow: number, dc: DecayConsts, budgetMs: number,
): PlanCost {
  const ctx = emptyCtx(budgetMs)
  let cur: Pos = snap.selfPos
  let L = 0
  const carried: string[] = []
  const delivered: Array<{ id: string; zone: Pos }> = []

  for (const step of steps) {
    if (step.op === 'goto') {
      const res = planPath(grid, ctx, cur, step.target)
      if (!res.reachable) return { L: Infinity, vPlan: 0, reachable: false }
      L += res.L
      cur = step.target
    } else if (step.op === 'pickup') {
      if (!carried.includes(step.parcelId)) carried.push(step.parcelId)
    } else if (step.op === 'deliver') {
      for (const id of carried) delivered.push({ id, zone: step.zone })
      carried.length = 0
    } else if (step.op === 'wait') {
      L += step.n
    }
  }

  // Value the delivered parcels at the last delivery zone with the shared kernel.
  let vPlan = 0
  if (delivered.length > 0) {
    const zone = delivered[delivered.length - 1]!.zone
    const byId = new Map(snap.parcels.map((p) => [p.id, p]))
    const beliefs = delivered
      .map((d) => byId.get(d.id))
      .filter((p): p is SnapParcel => p !== undefined)
      .map((p) => asBelief(p, snap.t0))
    vPlan = vValue(beliefs, zone, L, tnow, dc)
  }
  return { L, vPlan, reachable: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent-cost.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/agent/cost.ts tests/agent-cost.test.ts
git commit -m "feat(agent): cost step-list via shared A* + kernel V_plan"
```

---

### Task 7: ReAct engine (`reactPlan`)

**Files:**
- Create: `src/mission/agent/loop.ts`
- Test: `tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: `ChatFn`, `ChatMsg` (`src/mission/llm.js`); `CompileResult` (`src/mission/compiler.js`); `Params` (`src/bdi/params.js`); `Grid` (`src/planning/astar.js`); `DecayConsts` (`src/bdi/utility.js`); `WorldSnapshot`, `forwardApply` (Task 4); `AGENT_TOOLS`, `isReadTool`, `isActionTool`, `executeRead`, `actionStep` (Task 5); `costPlan` (Task 6); `assembleMission`, `isAgentStep`, `AgentStep` (Task 3).
- Produces: `reactPlan(text: string, snap: WorldSnapshot, chat: ChatFn, grid: Grid, dc: DecayConsts, tnow: number, params: Params, nextId: () => string): Promise<CompileResult>`.

- [ ] **Step 1: Write the failing test** — create `tests/agent-loop.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { reactPlan } from '../src/mission/agent/loop.js'
import { buildGrid } from '../src/planning/astar.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { ChatFn, ChatTurn } from '../src/mission/llm.js'
import type { Tile, GameConsts } from '../src/types/perception.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'

const map: Tile[] = []
for (let x = 0; x <= 5; x++) map.push({ pos: { x, y: 0 }, type: x === 5 ? '2' : '1' })
const grid = buildGrid(map)
const consts: GameConsts = { PARCEL_DECAY_TICKS: Infinity, MOVEMENT_DURATION: 50, CLOCK: 50 } as GameConsts
const dc = decayConsts(consts)
const snap: WorldSnapshot = {
  t0: 0, selfPos: { x: 0, y: 0 }, carried: [], delivered: [],
  parcels: [{ id: 'p1', pos: { x: 2, y: 0 }, reward: 30, carriedBy: null }],
  zones: [{ x: 5, y: 0 }], partnerPos: null, sig: 's',
}
const ids = () => 'm-test'
function scripted(turns: ChatTurn[]): ChatFn { let i = 0; return async () => turns[i++] ?? { content: '' } }
const call = (name: string, args: object): ChatTurn => ({ calls: [{ name, arguments: JSON.stringify(args) }] })

test('answer terminates as a QUERY', async () => {
  const chat = scripted([call('answer', { text: 'forty-two' })])
  const r = await reactPlan('what is 6*7?', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r).toEqual({ kind: 'query', answer: 'forty-two' })
})

test('emit_plan produces a costed AGENT_PLAN mission', async () => {
  const chat = scripted([call('emit_plan', {
    payoff: 50,
    steps: [
      { op: 'goto', target: { x: 2, y: 0 } },
      { op: 'pickup', parcelId: 'p1' },
      { op: 'goto', target: { x: 5, y: 0 } },
      { op: 'deliver', zone: { x: 5, y: 0 } },
    ],
  })])
  const r = await reactPlan('go get p1', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r.kind).toBe('mission')
  if (r.kind !== 'mission') throw new Error('unreachable')
  expect(r.mission.kind).toBe('AGENT_PLAN')
  expect(r.mission.payoff).toBe(50)
  expect(r.mission.plan?.L).toBe(5)
  expect(r.mission.plan?.vPlan).toBe(30)
})

test('a read tool observation feeds a later turn', async () => {
  const chat = scripted([
    call('get_parcel', { id: 'p1' }),
    call('emit_plan', { payoff: 10, steps: [{ op: 'goto', target: { x: 2, y: 0 } }] }),
  ])
  const r = await reactPlan('inspect then move', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r.kind).toBe('mission')
})

test('emit_plan with an unreachable goto is discarded (P_feasible 0)', async () => {
  const chat = scripted([call('emit_plan', { payoff: 10, steps: [{ op: 'goto', target: { x: 99, y: 99 } }] })])
  const r = await reactPlan('impossible', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})

test('no terminal within MAX_ITERS is discarded', async () => {
  const chat = scripted([call('get_my_position', {}), call('get_my_position', {}), call('get_my_position', {})])
  const r = await reactPlan('loops forever', snap, chat, grid, dc, 0, { ...DEFAULT_PARAMS, max_iters: 3 }, ids)
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-loop.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/mission/agent/loop.ts`:

```ts
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
    { role: 'user', content: text },
    { role: 'user', content: `snapshot: self=${JSON.stringify(snap.selfPos)} parcels=${JSON.stringify(snap.parcels.map((p) => ({ id: p.id, pos: p.pos, reward: p.reward })))} zones=${JSON.stringify(snap.zones)}` },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent-loop.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/agent/loop.ts tests/agent-loop.test.ts
git commit -m "feat(agent): ReAct loop compiling NL into answer or costed plan"
```

---

### Task 8: `uMission` AGENT_PLAN branch

**Files:**
- Modify: `src/bdi/mission-intention.ts`
- Test: `tests/mission-intention.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: `Mission.plan` (Task 3); `Params.theta_llm`, `Params.c_llm` (Task 2).
- Produces: `uMission` returns a candidate for an `AGENT_PLAN` mission using `value = payoff + plan.vPlan`, `L = plan.L`, `θ = theta_llm`, ceiling `c_llm · ρ_ref`, binary `P_feasible = 1`.

- [ ] **Step 1: Write the failing test** — append to `tests/mission-intention.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { uMission } from '../src/bdi/mission-intention.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { Mission } from '../src/mission/kinds.js'

const planMission = (over: Partial<Mission> = {}): Mission => ({
  kind: 'AGENT_PLAN', payoff: 40, abstractIntent: 'x', params: {},
  id: 'm1', rawText: 'x', status: 'CLASSIFIED',
  plan: { steps: [], L: 4, vPlan: 10 },
  ...over,
})
const dist = () => 0

test('AGENT_PLAN scores value = payoff + vPlan with the LLM ceiling', () => {
  const c = uMission(planMission(), { x: 0, y: 0 }, dist, 0, 100, DEFAULT_PARAMS)
  expect(c).not.toBeNull()
  // raw = theta_llm * 1 * (40+10) * (1/(4+1)^alpha); alpha=1 ⇒ 0.45*50*0.2 = 4.5; ceiling 1.2*100 high.
  expect(c!.u).toBeCloseTo(4.5, 5)
})

test('AGENT_PLAN past its deadline is dropped', () => {
  const c = uMission(planMission({ deadline: 2 }), { x: 0, y: 0 }, dist, 0, 100, DEFAULT_PARAMS)
  // slack = 2 - 0 - 4 = -2 < 0 ⇒ null
  expect(c).toBeNull()
})

test('AGENT_PLAN u is clamped by c_llm * rhoRef', () => {
  const c = uMission(planMission({ payoff: 1000 }), { x: 0, y: 0 }, dist, 0, 1, DEFAULT_PARAMS)
  expect(c!.u).toBeCloseTo(1.2 * 1, 5) // c_llm * rhoRef
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-intention.test.ts`
Expected: FAIL (AGENT_PLAN returns null — current guard only allows CANDIDATE_INTENTION).

- [ ] **Step 3: Implement** — in `src/bdi/mission-intention.ts`, at the top of `uMission` (before the existing CANDIDATE_INTENTION guard), add:

```ts
  if (mission.kind === 'AGENT_PLAN') {
    const plan = mission.plan
    if (plan === undefined || !Number.isFinite(plan.L)) return null
    const Lm = plan.L
    const sm = mission.deadline === undefined ? Infinity : mission.deadline - tnow - Lm
    if (sm < 0) return null                                  // deadline unreachable (§4.3)
    const theta = mission.theta ?? params.theta_llm
    const value = mission.payoff + plan.vPlan                // §18.9 payoff + kernel V_plan
    const completion = 1 / Math.pow(Lm + 1, params.alpha)
    const shadow = sm === Infinity ? 0 : 1 / Math.pow(sm + 1, params.alpha)
    const urgency = Math.max(completion, shadow)
    const raw = theta * 1 * value * urgency                  // P_feasible binary {1,0}; here 1 (§18.9)
    const u = Math.min(raw, params.c_llm * rhoRef)           // tighter LLM rate ceiling
    if (u <= 0) return null
    return { intention: { kind: 'mission', mission }, u }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-intention.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bdi/mission-intention.ts tests/mission-intention.test.ts
git commit -m "feat(mission): score AGENT_PLAN in uMission (payoff+V_plan, theta_llm, c_llm)"
```

---

### Task 9: Liaison wiring (switch dispatch + snapshot + born-stale)

**Files:**
- Modify: `src/agents/liaison.ts`
- Create: `src/mission/agent/wire.ts` (snapshot builder + dispatching compile-fn factory — keeps liaison.ts thin and unit-testable)
- Test: `tests/agent-wire.test.ts`

**Interfaces:**
- Consumes: `Config.MISSION_HANDLER` (Task 1); `reactPlan` (Task 7); `WorldSnapshot`, `beliefSignature` (Task 4); `BeliefBase` (`src/blackboard/beliefs.js`); `buildGrid` (`src/planning/astar.js`); `CompileResult` (`src/mission/compiler.js`).
- Produces:
  - `snapshotFromBeliefs(bb: BeliefBase, zones: Pos[], tnow: number): WorldSnapshot`
  - `makeMissionCompile(deps): (raw: string) => Promise<CompileResult>` — returns `compile`-bound for OFF, `reactPlan`-bound (with a fresh snapshot per call + born-stale re-plan) for LLM_AGENT, and a thrower for PDDL.

- [ ] **Step 1: Write the failing test** — create `tests/agent-wire.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { makeMissionCompile } from '../src/mission/agent/wire.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'

const stubDeps = (handler: 'OFF' | 'LLM_AGENT' | 'PDDL') => ({
  handler,
  params: DEFAULT_PARAMS,
  compile: async () => ({ kind: 'discard', reason: 'not_applicable' as const }),
  reactPlan: async () => ({ kind: 'query', answer: 'from-react' as string }),
  snapshot: () => null,            // not used by the OFF/PDDL branches
})

test('OFF routes to the typed compile()', async () => {
  const fn = makeMissionCompile(stubDeps('OFF') as never)
  expect(await fn('hi')).toEqual({ kind: 'discard', reason: 'not_applicable' })
})

test('LLM_AGENT routes to reactPlan', async () => {
  const deps = { ...stubDeps('LLM_AGENT'), snapshot: () => ({ ready: true }) }
  const fn = makeMissionCompile(deps as never)
  expect(await fn('hi')).toEqual({ kind: 'query', answer: 'from-react' })
})

test('PDDL throws not-implemented', async () => {
  const fn = makeMissionCompile(stubDeps('PDDL') as never)
  await expect(fn('hi')).rejects.toThrow(/not implemented/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-wire.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/mission/agent/wire.ts`:

```ts
// Wiring helpers for the mission handler switch (§18.2). Kept out of liaison.ts so the dispatch
// and snapshot construction are unit-testable without a live worker.

import type { CompileResult } from '../compiler.js'
import type { Params } from '../../bdi/params.js'
import type { Pos } from '../../types/perception.js'
import type { BeliefBase } from '../../blackboard/beliefs.js'
import type { Grid } from '../../planning/astar.js'
import type { DecayConsts } from '../../bdi/utility.js'
import { beliefSignature, type WorldSnapshot } from './snapshot.js'

export interface CompileDeps {
  handler: 'OFF' | 'LLM_AGENT' | 'PDDL'
  params: Params
  compile: (raw: string) => Promise<CompileResult>
  reactPlan: (raw: string, snap: WorldSnapshot) => Promise<CompileResult>
  snapshot: () => WorldSnapshot | null
}

export function makeMissionCompile(deps: CompileDeps): (raw: string) => Promise<CompileResult> {
  if (deps.handler === 'OFF') return deps.compile
  if (deps.handler === 'PDDL') {
    return async () => { throw new Error('MISSION_HANDLER=PDDL not implemented (future slice)') }
  }
  // LLM_AGENT: fresh snapshot per mission; one born-stale re-plan if the world moved during planning.
  return async (raw: string): Promise<CompileResult> => {
    const snap = deps.snapshot()
    if (snap === null) return { kind: 'discard', reason: 'not_applicable' }
    const res = await deps.reactPlan(raw, snap)
    if (res.kind !== 'mission') return res
    const fresh = deps.snapshot()
    if (fresh !== null && fresh.sig !== snap.sig) {
      const re = await deps.reactPlan(raw, fresh)         // born-stale ⇒ one re-plan (§18.4)
      return re
    }
    return res
  }
}

// Build a WorldSnapshot from the live belief base (§18.4). selfPos/parcels/partner are read here;
// zones come from the prebuilt grid.
export function snapshotFromBeliefs(bb: BeliefBase, zones: Pos[], tnow: number): WorldSnapshot {
  const parcels = [...bb.parcels.values()].map((p) => ({
    id: p.id, pos: p.pos, reward: p.rewardSeen, carriedBy: p.carriedBy,
  }))
  const selfPos = bb.self.pos
  const partnerEntry = [...bb.agents.values()].find((a) => bb.relOf(a) === 'partner')
  const partnerPos = partnerEntry ? partnerEntry.pos : null
  return {
    t0: tnow, selfPos, carried: [], delivered: [],
    parcels, zones, partnerPos, sig: beliefSignature(parcels, selfPos),
  }
}
```
**Before writing `snapshotFromBeliefs`, verify the BeliefBase accessor names** in `src/blackboard/beliefs.ts` (the `parcels` map, the self accessor, and how the partner agent is found). Adjust `bb.self.pos`, `bb.agents`, and `bb.relOf(...)` to the actual API (e.g. it may be `bb.self()` or a `SelfBelief` field, and partner may be looked up via `classifyRel`). The `makeMissionCompile` tests do not exercise this function; the integration is validated by `tsc` + a live run.

- [ ] **Step 4: Wire into `src/agents/liaison.ts`**

Add imports:
```ts
import { reactPlan } from '../mission/agent/loop.js'
import { makeMissionCompile, snapshotFromBeliefs } from '../mission/agent/wire.js'
import { buildGrid } from '../planning/astar.js'
import { decayConsts } from '../bdi/utility.js'
```
Replace the `intake` construction (the `compile: (raw) => compile(raw, chat)` line) so the compile-fn comes from the switch. After `const chat = makeChat(config)` and once the grid/consts are available from the first perception, build the dispatcher. Concretely, inside the `client.onPerception` boot block (where `blackboard` is created), capture the grid and a snapshot accessor:

```ts
  let grid: Grid | null = null
  let consts: GameConsts | null = null
  let beliefs: BeliefBase | null = null
  const seq = { n: 0 }
  const nextId = () => `m-${Date.now()}-${seq.n++}`

  const missionCompile = makeMissionCompile({
    handler: config.MISSION_HANDLER,
    params,
    compile: (raw) => compile(raw, chat),
    reactPlan: (raw, snap) =>
      reactPlan(raw, snap, chat, grid!, decayConsts(consts!), beliefs!.lastTick ?? 0, params, nextId),
    snapshot: () =>
      grid && consts && beliefs ? snapshotFromBeliefs(beliefs, grid.deliveryZones, beliefs.lastTick ?? 0) : null,
  })
```
Pass `compile: missionCompile` into `createIntake`. Set `grid`/`consts`/`beliefs` in the first-perception block:
```ts
    if (!booted) {
      beliefs = loop.beliefBase(snap)
      grid = buildGrid(snap.map)         // use the map field carried by the perception snapshot
      consts = snap.consts               // use the GameConsts field on the perception snapshot
      blackboard = new Blackboard(beliefs, { ... })   // pass the same beliefs instance
      ...
    }
```
For `MISSION_HANDLER=LLM_AGENT`, make the slot **liaison-local** (slice-1: no broadcast). Construct the slot callback without the `send(...)` line when the handler is `LLM_AGENT`:
```ts
  const broadcast = config.MISSION_HANDLER !== 'LLM_AGENT'
  const missionSlot = new MissionSlot((m) => {
    missionView.set(m)
    if (broadcast) send({ from: 'liaison', to: 'courier', type: 'mission', payload: m })
  })
```
**Confirm the actual field names** on the perception snapshot (`snap.map`, `snap.consts`) and the `BeliefBase` tick accessor (`beliefs.lastTick`) against `src/types/perception.ts`, `src/external/deliveroo.ts`, and `src/blackboard/beliefs.ts`; adjust to the real names. If `loop.beliefBase(snap)` returns a new instance each call, capture it once (as above) and reuse it.

- [ ] **Step 5: Typecheck + full suite + run**

Run: `bunx tsc --noEmit`
Expected: clean (exit 0).

Run: `bun test`
Expected: all tests pass.

Run (smoke, with `MISSION_HANDLER=LLM_AGENT` and a server up): `bun run src/main.ts`
Expected: a NL mission message is answered (QUERY) or installed as an AGENT_PLAN (see the `mission installed` log line); no error in the tick loop.

- [ ] **Step 6: Commit**

```bash
git add src/agents/liaison.ts src/mission/agent/wire.ts tests/agent-wire.test.ts
git commit -m "feat(liaison): dispatch mission handler switch; wire LLM_AGENT lane"
```

---

## Notes for the implementer

- Run `bunx tsc --noEmit` after each task; the project is `strict` with no `any`. (`bun-types` is a devDep — installed.)
- The `ChatTurn` contract is `{ calls: FunctionCall[] } | { content: string }` (parallel tool calls) — see `src/mission/llm.ts`. Scripted test fakes use `{ calls: [...] }`.
- `reactPlan` returns the **same** `CompileResult` union as `compile()`, so the existing `createIntake`/`MissionSlot` path needs no change beyond which compile-fn is passed in.
- Where a task says "confirm the actual field names", do it before writing the code — the surrounding tasks are unit-tested against hand-built fixtures and will pass regardless, so only `tsc` + the live run catch a wrong accessor.

## Self-Review

- **Spec coverage:** switch (T1) · params θ_llm/c_llm/iters (T2) · AGENT_PLAN shape (T3) · frozen snapshot + forward-apply + born-stale signature (T4, T9) · 3-family tool registry incl. emit_plan/answer/calculate (T5) · cost via shared A* + kernel V_plan (T6) · ReAct engine answer/plan/discard/MAX_ITERS (T7) · U_mission reintegration with humility belts (T8) · liaison dispatch + liaison-local install + PDDL throw (T9). Strategy/coordination tools, full §17.7 lifecycle, and step-list execution are explicitly out of slice 1.
- **Placeholder scan:** none — every code step carries complete code; the two "confirm field names" notes are verification instructions for real-but-uncertain external accessors, not deferred logic.
- **Type consistency:** `WorldSnapshot`, `AgentStep`, `AgentPlan`, `PlanCost`, `CompileResult`, `CompileDeps` names and signatures match across T3–T9; `theta_llm`/`c_llm` consumed in T8 are defined in T2; `reactPlan` signature in T7 matches its call site in T9.
