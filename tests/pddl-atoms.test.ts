// §17 PDDL atom pipeline (v2): constraint masks, ValidationGate, coverage problem, LLM-PDDL
// transcription, PlanCache, and the full lane driving deliver-all + coverage + constrained tasks.
import { test, expect } from 'bun:test'
import { buildGrid } from '../src/planning/astar.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { constraintMask, validateSpec, type PddlSpec } from '../src/mission/pddl/spec.js'
import { buildCoverageProblem } from '../src/mission/pddl/problem.js'
import { coveragePlanToSteps, type RawPlanStep } from '../src/mission/pddl/plan.js'
import { transcribePddl } from '../src/mission/pddl/transcribe.js'
import { PlanCache } from '../src/mission/pddl/cache.js'
import { makePddlCompile } from '../src/mission/pddl/lane.js'
import type { Tile, GameConsts, Pos } from '../src/types/perception.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'
import type { ChatFn, ChatTurn } from '../src/mission/llm.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 50, PARCEL_DECAY_TICKS: 9999, PARCEL_DECAY_RAW: '0s', PENALTY: 0 }
const DC = decayConsts(CONSTS)

// 4x2 grid (x:0..3, y:0..1), delivery at (0,0).
function grid4x2() {
  const tiles: Tile[] = []
  for (let x = 0; x <= 3; x++) for (let y = 0; y <= 1; y++) tiles.push({ pos: { x, y }, type: x === 0 && y === 0 ? 'delivery' : 'walkable' })
  return buildGrid(tiles)
}
const snap = (parcels: WorldSnapshot['parcels'] = []): WorldSnapshot => ({
  t0: 0, selfPos: { x: 0, y: 0 }, carried: [], delivered: [], parcels, zones: [{ x: 0, y: 0 }], partnerPos: null, sig: 's',
})

test('constraintMask: avoid tile, keepAway radius, stayOn complement', () => {
  const g = grid4x2()
  expect(constraintMask(g, { avoid: [{ tag: 'TILE', x: 2, y: 1 }] })).toEqual([{ x: 2, y: 1 }])
  const ka = constraintMask(g, { keepAway: [{ of: { tag: 'TILE', x: 0, y: 0 }, dist: 1 }] })
  const kk = new Set(ka.map((p) => `${p.x},${p.y}`))
  expect(kk.has('0,0')).toBe(true); expect(kk.has('1,0')).toBe(true); expect(kk.has('0,1')).toBe(true)
  expect(kk.has('2,0')).toBe(false)
  // stayOn left half → the right half (x>=2 here: mid=1.5) is masked
  const so = constraintMask(g, { stayOn: { tag: 'NAME', rule: 'left room' } })
  expect(so.every((p) => p.x >= 2)).toBe(true)
})

test('validateSpec grounds regions and rejects an unresolvable one', () => {
  const g = grid4x2()
  const ok = validateSpec(g, { task: { kind: 'DELIVER_ALL' }, constraints: {}, payoff: 0 }, { x: 0, y: 0 })
  expect(ok.ok).toBe(true)
  const bad = validateSpec(g, { task: { kind: 'COVERAGE', region: { tag: 'NAME', rule: 'moon base' } }, constraints: {}, payoff: 5 }, { x: 0, y: 0 })
  expect(bad).toEqual({ ok: false, reason: 'coverage region unresolved' })
  const masksSelf = validateSpec(g, { task: { kind: 'DELIVER_ALL' }, constraints: { avoid: [{ tag: 'TILE', x: 0, y: 0 }] }, payoff: 0 }, { x: 0, y: 0 })
  expect(masksSelf.ok).toBe(false)
})

test('buildCoverageProblem grounds a visited-all goal over the target set', () => {
  const built = buildCoverageProblem(grid4x2(), snap(), [{ x: 3, y: 0 }, { x: 3, y: 1 }])
  expect(built).not.toBeNull()
  expect(built!.problem).toContain('(:domain deliveroo-coverage)')
  expect(built!.problem).toContain('(visited t3_0)')
  expect(built!.problem).toContain('(visited t3_1)')
  expect(buildCoverageProblem(grid4x2(), snap(), [])).toBeNull() // no targets ⇒ decline
})

test('coveragePlanToSteps keeps ordered move destinations, collapses dupes', () => {
  const raw: RawPlanStep[] = [
    { action: 'move', args: ['t0_0', 't1_0'] },
    { action: 'move', args: ['t1_0', 't2_0'] },
    { action: 'move', args: ['t2_0', 't2_0'] }, // dup dest
  ]
  expect(coveragePlanToSteps(raw)).toEqual([
    { op: 'goto', target: { x: 1, y: 0 } },
    { op: 'goto', target: { x: 2, y: 0 } },
  ])
})

test('PlanCache returns on identical (raw,sig), misses on a changed sig', () => {
  const c = new PlanCache<number>()
  c.set('m', 'sig1', 42)
  expect(c.get('m', 'sig1')).toBe(42)
  expect(c.get('m', 'sig2')).toBeUndefined()
})

function scripted(turn: ChatTurn): ChatFn { return async () => turn }

test('transcribePddl parses a coverage-with-keepAway spec', async () => {
  const chat = scripted({ calls: [{ name: 'transcribe_pddl', arguments: JSON.stringify({
    task: 'COVERAGE', region: { tag: 'NAME', rule: 'left room' },
    keepAway: [{ of: { tag: 'NAME', rule: 'the border' }, dist: 3 }], payoff: 100,
  }) }] })
  const spec = await transcribePddl('cover the left room staying 3 from the border, +100', chat)
  expect(spec).not.toBeNull()
  expect(spec!.task).toEqual({ kind: 'COVERAGE', region: { tag: 'NAME', rule: 'left room' } })
  expect(spec!.constraints.keepAway).toEqual([{ of: { tag: 'NAME', rule: 'the border' }, dist: 3 }])
  expect(spec!.payoff).toBe(100)
})

test('full lane: COVERAGE spec → costed AGENT_PLAN with the stated payoff', async () => {
  const spec: PddlSpec = { task: { kind: 'COVERAGE', region: { tag: 'NAME', rule: 'right room' } }, constraints: {}, payoff: 80 }
  const solve = async (): Promise<RawPlanStep[]> => [
    { action: 'move', args: ['t0_0', 't1_0'] },
    { action: 'move', args: ['t1_0', 't2_0'] },
    { action: 'move', args: ['t2_0', 't3_0'] },
  ]
  const compile = makePddlCompile({
    grid: () => grid4x2(), snapshot: () => snap(), solve, dc: DC, params: DEFAULT_PARAMS,
    tnow: () => 0, nextId: () => 'm1', transcribe: async () => spec,
  })
  const res = await compile('cover the right room for 80')
  expect(res.kind).toBe('mission')
  if (res.kind !== 'mission') throw new Error('unreachable')
  expect(res.mission.kind).toBe('AGENT_PLAN')
  expect(res.mission.payoff).toBe(80)
  expect(res.mission.plan!.steps.every((s) => s.op === 'goto')).toBe(true)
  expect(res.mission.plan!.L).toBeGreaterThan(0)
})

test('full lane: an avoid constraint that masks the agent tile → discard (gate)', async () => {
  const spec: PddlSpec = { task: { kind: 'DELIVER_ALL' }, constraints: { avoid: [{ tag: 'TILE', x: 0, y: 0 }] }, payoff: 0 }
  let solverCalled = false
  const compile = makePddlCompile({
    grid: () => grid4x2(), snapshot: () => snap([{ id: 'p1', pos: { x: 3, y: 1 } as Pos, reward: 20, carriedBy: null }]),
    solve: async () => { solverCalled = true; return [] }, dc: DC, params: DEFAULT_PARAMS,
    tnow: () => 0, nextId: () => 'm1', transcribe: async () => spec,
  })
  expect((await compile('deliver but never stand on 0,0')).kind).toBe('discard')
  expect(solverCalled).toBe(false) // gate rejects before the planner
})
