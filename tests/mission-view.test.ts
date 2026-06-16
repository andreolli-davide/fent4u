// tests/mission-view.test.ts
import { test, expect } from 'bun:test'
import { TeamMissionView } from '../src/mission/view.js'
import { assembleMission } from '../src/mission/kinds.js'

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
