import { test, expect } from 'bun:test'
import { isMission, isMissionDraft, assembleMission, isAgentStep, MISSION_KINDS, type MissionDraft } from '../src/mission/kinds.js'

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

test('isMissionDraft accepts a HARD_CONSTRAINT draft carrying priced + absolute params', () => {
  const draft = {
    kind: 'HARD_CONSTRAINT', payoff: -50, abstractIntent: 'avoid (5,2); no big parcels', sub: 'PRICED',
    params: { priced: [{ tile: { tag: 'TEXT_BOUND', x: 5, y: 2 }, toll: 50 }], absolute: { kind: 'REWARD_THRESHOLD', max: 10 } },
  }
  expect(isMissionDraft(draft)).toBe(true)
})

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

