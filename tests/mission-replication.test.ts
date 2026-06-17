import { test, expect } from 'bun:test'
import { MissionSlot } from '../src/mission/slot.js'
import { TeamMissionView } from '../src/mission/view.js'
import { isMission, assembleMission } from '../src/mission/kinds.js'
import type { A2AMessage } from '../src/types/a2a.js'

const shaper = () => assembleMission(
  { kind: 'REWARD_SHAPER', payoff: 0, abstractIntent: 'x', params: { m: { '3': 2 } } },
  'raw', 'm-1',
)

// Mirrors src/agents/liaison.ts: onChange both mirrors locally AND broadcasts.
function wireLiaison(sent: A2AMessage[]): { slot: MissionSlot; view: TeamMissionView } {
  const view = new TeamMissionView()
  const slot = new MissionSlot((m) => {
    view.set(m)
    sent.push({ from: 'liaison', to: 'courier', type: 'mission', payload: m })
  })
  return { slot, view }
}

test('installing a mission broadcasts it and mirrors it locally', () => {
  const sent: A2AMessage[] = []
  const { slot, view } = wireLiaison(sent)
  slot.install(shaper())
  expect(sent).toHaveLength(1)
  expect(sent[0]!.type).toBe('mission')
  expect((sent[0]!.payload as { id: string }).id).toBe('m-1')
  expect(view.current()?.id).toBe('m-1')
})

test('superseding broadcasts a null payload', () => {
  const sent: A2AMessage[] = []
  const { slot } = wireLiaison(sent)
  slot.install(shaper())
  slot.supersede()
  expect(sent).toHaveLength(2)
  expect(sent[1]!.payload).toBeNull()
})

// Mirrors src/agents/courier.ts ingest: guard the payload, then view.set.
function ingest(view: TeamMissionView, payload: unknown): void {
  if (payload === null) view.set(null)
  else if (isMission(payload)) view.set(payload)
  // else: dropped (bad payload)
}

test('courier ingest installs a valid mission, clears on null, drops garbage', () => {
  const view = new TeamMissionView()
  ingest(view, shaper())
  expect(view.current()?.id).toBe('m-1')
  expect(view.countShaper()(3)).toBe(2)
  ingest(view, { junk: true })
  expect(view.current()?.id).toBe('m-1') // unchanged — garbage rejected
  ingest(view, null)
  expect(view.current()).toBeNull()
})

test('HARD_CONSTRAINT mission replicates: both views build identical tolls + filter', () => {
  const m = assembleMission(
    { kind: 'HARD_CONSTRAINT', payoff: -50, abstractIntent: 'avoid (5,2)', sub: 'PRICED',
      params: { priced: [{ tile: { tag: 'TEXT_BOUND', x: 5, y: 2 }, toll: 50 }], absolute: { kind: 'REWARD_THRESHOLD', max: 10 } } },
    'avoid', 'm-hc')
  const wire = JSON.parse(JSON.stringify(m)) // a2a serialization round-trip
  expect(isMission(wire)).toBe(true)
  const vA = new TeamMissionView(); vA.set(m)
  const vB = new TeamMissionView(); vB.set(wire)
  expect([...vA.tolls()]).toEqual([...vB.tolls()])
  const big = [{ id: 'b', pos: { x: 0, y: 0 }, rewardSeen: 20, carriedBy: null, lastSeen: 0 }]
  expect(vA.bundleFilter()(big, { x: 0, y: 0 })).toBe(vB.bundleFilter()(big, { x: 0, y: 0 }))
  expect(vB.bundleFilter()(big, { x: 0, y: 0 })).toBe(false) // REWARD_THRESHOLD max 10 voids a reward-20 bundle
})
