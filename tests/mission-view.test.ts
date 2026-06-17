// tests/mission-view.test.ts
import { test, expect } from 'bun:test'
import { TeamMissionView } from '../src/mission/view.js'
import { assembleMission } from '../src/mission/kinds.js'
import { M1, G1 } from '../src/bdi/utility.js'
import { key } from '../src/planning/astar.js'

const mk = (id: string) => assembleMission({ kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: 1, y: 0 } } }, 'raw', id)

test('starts empty', () => {
  expect(new TeamMissionView().current()).toBeNull()
})

test('set installs and clears the current mission', () => {
  const v = new TeamMissionView()
  v.set(mk('m-1'))
  expect(v.current()?.id).toBe('m-1')
  v.set(null)
  expect(v.current()).toBeNull()
})

const shaperMission = () => assembleMission(
  { kind: 'REWARD_SHAPER', payoff: 0, abstractIntent: 'stacks of 3 double',
    params: { m: { '3': 2 }, g: [{ tile: { tag: 'TEXT_BOUND', x: 1, y: 2 }, factor: 5 }] } },
  'raw', 'm-shaper',
)

test('identity shapers when empty or when current mission is not a REWARD_SHAPER', () => {
  const v = new TeamMissionView()
  expect(v.countShaper()).toBe(M1)
  expect(v.zoneShaper()).toBe(G1)
  v.set(mk('m-1')) // a CANDIDATE_INTENTION
  expect(v.countShaper()).toBe(M1)
  expect(v.zoneShaper()).toBe(G1)
})

test('REWARD_SHAPER mission yields the count/zone shapers', () => {
  const v = new TeamMissionView()
  v.set(shaperMission())
  expect(v.countShaper()(3)).toBe(2)
  expect(v.countShaper()(1)).toBe(1)
  expect(v.zoneShaper()({ x: 1, y: 2 })).toBe(5)
  expect(v.zoneShaper()({ x: 0, y: 0 })).toBe(1)
})

const constraintMission = () => assembleMission(
  { kind: 'HARD_CONSTRAINT', payoff: -50, abstractIntent: 'avoid (5,2); no big parcels', sub: 'PRICED',
    params: { priced: [{ tile: { tag: 'TEXT_BOUND', x: 5, y: 2 }, toll: 50 }], absolute: { kind: 'REWARD_THRESHOLD', max: 10 } } },
  'raw', 'm-hc',
)

test('identity constraints when empty or non-HARD_CONSTRAINT', () => {
  const v = new TeamMissionView()
  expect(v.tolls().size).toBe(0)
  expect(v.bundleFilter()([], { x: 0, y: 0 })).toBe(true)
  v.set(mk('m-1')) // a CANDIDATE_INTENTION
  expect(v.tolls().size).toBe(0)
  expect(v.bundleFilter()([], { x: 0, y: 0 })).toBe(true)
})

test('HARD_CONSTRAINT mission yields tolls + bundle filter', () => {
  const v = new TeamMissionView()
  v.set(constraintMission())
  expect(v.tolls().get(key({ x: 5, y: 2 }))).toBe(50)
  const big = { id: 'b', pos: { x: 0, y: 0 }, rewardSeen: 20, carriedBy: null, lastSeen: 0 }
  expect(v.bundleFilter()([big], { x: 0, y: 0 })).toBe(false)
})
