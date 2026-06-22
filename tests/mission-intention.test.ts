// tests/mission-intention.test.ts
import { test, expect } from 'bun:test'
import { uMission } from '../src/bdi/mission-intention.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { assembleMission, type MissionDraft } from '../src/mission/kinds.js'
import type { Pos } from '../src/types/perception.js'
import type { Mission } from '../src/mission/kinds.js'

const self: Pos = { x: 0, y: 0 }
// dist = manhattan; unreachable tiles flagged by a sentinel coordinate (x<0).
const dist = (a: Pos, b: Pos): number => (b.x < 0 ? Infinity : Math.abs(a.x - b.x) + Math.abs(a.y - b.y))

function coordMission(over: Partial<MissionDraft> = {}, x = 3, y = 0): ReturnType<typeof assembleMission> {
  const draft: MissionDraft = {
    kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go',
    params: { targetTile: { tag: 'TEXT_BOUND', x, y } }, ...over,
  }
  return assembleMission(draft, 'raw', 'm-1')
}

test('a reachable positive coordinate mission is a candidate', () => {
  const c = uMission(coordMission(), self, dist, 0, 1.0, DEFAULT_PARAMS)
  expect(c).not.toBeNull()
  expect(c!.intention.kind).toBe('mission')
  expect(c!.u).toBeGreaterThan(0)
})

test('an unreachable target is dropped (P_feasible = 0)', () => {
  expect(uMission(coordMission({}, -1, 0), self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
})

test('a non-positive payoff never wins', () => {
  expect(uMission(coordMission({ payoff: -10 }), self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
  expect(uMission(coordMission({ payoff: 0 }), self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
})

test('a non-coordinate or runtime-bound mission yields no candidate', () => {
  const shaper = assembleMission({ kind: 'REWARD_SHAPER', payoff: 0, abstractIntent: 'x', params: {} }, 'r', 'm-2')
  expect(uMission(shaper, self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
  const runtime = assembleMission({ kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'x', params: { targetTile: { tag: 'RUNTIME_BOUND', rule: 'leftmost' } } }, 'r', 'm-3')
  expect(uMission(runtime, self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
})

test('the rate ceiling clamps a hallucinated payoff to c·rho_ref', () => {
  const huge = uMission(coordMission({ payoff: 1_000_000 }), self, dist, 0, 1.0, DEFAULT_PARAMS)
  expect(huge!.u).toBeCloseTo(DEFAULT_PARAMS.c * 1.0, 6) // min(raw, c·rhoRef) = 1.5
})

test('a passed deadline drops the mission (s_m < 0)', () => {
  // target 3 away, deadline at tick 1, now tick 0 → s_m = 1 - 0 - 3 = -2 < 0
  expect(uMission(coordMission({ deadline: 1 }), self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
})

test('deadline urgency raises u as slack tightens', () => {
  // far deadline: completion rate dominates; tight deadline: shadow term dominates → higher u.
  const far = uMission(coordMission({ deadline: 1000 }), self, dist, 0, 1.0, { ...DEFAULT_PARAMS, c: 1000 })
  const tight = uMission(coordMission({ deadline: 4 }), self, dist, 0, 1.0, { ...DEFAULT_PARAMS, c: 1000 })
  expect(tight!.u).toBeGreaterThan(far!.u)
})

const planMission = (over: Partial<Mission> = {}): Mission => ({
  kind: 'AGENT_PLAN', payoff: 40, abstractIntent: 'x', params: {},
  id: 'm1', rawText: 'x', status: 'CLASSIFIED',
  plan: { steps: [], L: 4, vPlan: 10 },
  ...over,
})
const planDist = () => 0

test('AGENT_PLAN scores value = payoff + vPlan with the LLM ceiling', () => {
  const c = uMission(planMission(), { x: 0, y: 0 }, planDist, 0, 100, DEFAULT_PARAMS)
  expect(c).not.toBeNull()
  // raw = theta_llm * 1 * (40+10) * (1/(4+1)^alpha); alpha=1 ⇒ 0.45*50*0.2 = 4.5; ceiling 1.2*100 high.
  expect(c!.u).toBeCloseTo(4.5, 5)
})

test('AGENT_PLAN past its deadline is dropped', () => {
  const c = uMission(planMission({ deadline: 2 }), { x: 0, y: 0 }, planDist, 0, 100, DEFAULT_PARAMS)
  // slack = 2 - 0 - 4 = -2 < 0 ⇒ null
  expect(c).toBeNull()
})

test('AGENT_PLAN u is clamped by c_llm * rhoRef', () => {
  const c = uMission(planMission({ payoff: 1000 }), { x: 0, y: 0 }, planDist, 0, 1, DEFAULT_PARAMS)
  expect(c!.u).toBeCloseTo(1.2 * 1, 5) // c_llm * rhoRef
})
