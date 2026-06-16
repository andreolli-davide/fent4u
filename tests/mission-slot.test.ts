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
