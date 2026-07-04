// tests/pddl-lane.test.ts
// §17 PDDL lane — problem generation, plan parsing, and the full lane with an INJECTED mock solver
// (no network). Proves the pipeline: snapshot+grid → grounded problem → plan → AgentStep[] → costed
// AGENT_PLAN mission, and that every failure mode degrades to `discard`.
import { test, expect } from 'bun:test'
import { buildDeliverAllProblem } from '../src/mission/pddl/problem.js'
import { solverPlanToSteps, type RawPlanStep } from '../src/mission/pddl/plan.js'
import { makePddlCompile } from '../src/mission/pddl/lane.js'
import { buildGrid } from '../src/planning/astar.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { Tile, GameConsts, Pos } from '../src/types/perception.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 50, PARCEL_DECAY_TICKS: 9999, PARCEL_DECAY_RAW: '0s', PENALTY: 0 }
const DC = decayConsts(CONSTS)

// 3x2 grid (x:0..2, y:0..1), delivery at (0,0).
function grid3x2() {
  const tiles: Tile[] = []
  for (let x = 0; x <= 2; x++) for (let y = 0; y <= 1; y++) tiles.push({ pos: { x, y }, type: x === 0 && y === 0 ? 'delivery' : 'walkable' })
  return buildGrid(tiles)
}
const snap = (parcels: WorldSnapshot['parcels']): WorldSnapshot => ({
  t0: 0, selfPos: { x: 1, y: 0 }, carried: [], delivered: [], parcels, zones: [{ x: 0, y: 0 }], partnerPos: null, sig: 's',
})
const P1 = { id: 'p1', pos: { x: 2, y: 1 } as Pos, reward: 50, carriedBy: null }

test('buildDeliverAllProblem grounds objects, init and a deliver-all goal', () => {
  const built = buildDeliverAllProblem(grid3x2(), snap([P1]))
  expect(built).not.toBeNull()
  const p = built!.problem
  expect(p).toContain('(:domain deliveroo)')
  expect(p).toContain('(at t1_0)')
  expect(p).toContain('(delivery t0_0)')
  expect(p).toContain('(parcel-at pk0 t2_1)')
  expect(p).toContain('(delivered pk0)')
  expect(p).toContain('pk0 - parcel')
  expect(built!.parcelById.get('pk0')).toBe('p1')
})

test('buildDeliverAllProblem declines when there is nothing to plan', () => {
  expect(buildDeliverAllProblem(grid3x2(), snap([]))).toBeNull()                    // no free parcels
  expect(buildDeliverAllProblem(grid3x2(), snap([{ ...P1, carriedBy: 'x' }]))).toBeNull() // all carried
})

test('solverPlanToSteps keeps pickup/deliver order, drops moves, maps parcel ids', () => {
  const raw: RawPlanStep[] = [
    { action: 'move', args: ['t1_0', 't2_0'] },
    { action: 'pickup', args: ['pk0', 't2_1'] },
    { action: 'move', args: ['t2_1', 't0_0'] },
    { action: 'deliver', args: ['pk0', 't0_0'] },
  ]
  const steps = solverPlanToSteps(raw, new Map([['pk0', 'p1']]))
  expect(steps).toEqual([
    { op: 'goto', target: { x: 2, y: 1 } },
    { op: 'pickup', parcelId: 'p1' },
    { op: 'goto', target: { x: 0, y: 0 } },
    { op: 'deliver', zone: { x: 0, y: 0 } },
  ])
})

test('solverPlanToSteps rejects a plan referencing an unknown parcel object', () => {
  const raw: RawPlanStep[] = [{ action: 'pickup', args: ['pk9', 't2_1'] }]
  expect(solverPlanToSteps(raw, new Map([['pk0', 'p1']]))).toBeNull()
})

test('makePddlCompile: mock solver → costed AGENT_PLAN mission', async () => {
  const solve = async (): Promise<RawPlanStep[]> => [
    { action: 'pickup', args: ['pk0', 't2_1'] },
    { action: 'deliver', args: ['pk0', 't0_0'] },
  ]
  const compile = makePddlCompile({
    grid: () => grid3x2(), snapshot: () => snap([P1]), solve, dc: DC, params: DEFAULT_PARAMS, tnow: () => 0, nextId: () => 'm1',
  })
  const res = await compile('deliver everything')
  expect(res.kind).toBe('mission')
  if (res.kind !== 'mission') throw new Error('expected mission')
  expect(res.mission.kind).toBe('AGENT_PLAN')
  expect(res.mission.plan!.steps.length).toBe(4)      // goto,pickup,goto,deliver
  expect(res.mission.plan!.L).toBeGreaterThan(0)      // real A*-priced travel
  expect(res.mission.plan!.vPlan).toBeGreaterThan(0)  // delivered value via the shared kernel
})

test('makePddlCompile: solver finds no plan → discard (safe by omission)', async () => {
  const compile = makePddlCompile({
    grid: () => grid3x2(), snapshot: () => snap([P1]), solve: async () => null, dc: DC, params: DEFAULT_PARAMS, tnow: () => 0, nextId: () => 'm1',
  })
  expect((await compile('x')).kind).toBe('discard')
})

test('makePddlCompile: nothing plannable → discard (no solver call)', async () => {
  let called = false
  const compile = makePddlCompile({
    grid: () => grid3x2(), snapshot: () => snap([]), solve: async () => { called = true; return [] }, dc: DC, params: DEFAULT_PARAMS, tnow: () => 0, nextId: () => 'm1',
  })
  expect((await compile('x')).kind).toBe('discard')
  expect(called).toBe(false)
})
