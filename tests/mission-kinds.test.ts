import { test, expect } from 'bun:test'
import { isMission, isMissionDraft, assembleMission, type MissionDraft } from '../src/mission/kinds.js'

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

test('isMission accepts an assembled mission and rejects a bare draft / garbage', () => {
  const m = assembleMission(goodDraft, 'hello', 'm-1')
  expect(isMission(m)).toBe(true)
  expect(isMission(goodDraft)).toBe(false) // no id/rawText/status
  expect(isMission(null)).toBe(false)
  expect(isMission({ ...m, status: 'NOPE' })).toBe(false)
  expect(isMission({ ...m, id: 42 })).toBe(false)
})

