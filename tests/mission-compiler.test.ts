import { test, expect } from 'bun:test'
import { compile } from '../src/mission/compiler.js'
import type { ChatFn, ChatTurn } from '../src/mission/llm.js'

// Build a fake ChatFn that replays a scripted sequence of turns.
function scripted(turns: ChatTurn[]): ChatFn {
  let i = 0
  return async () => turns[i++] ?? { content: '' }
}
const emit = (args: object): ChatTurn => ({ calls: [{ name: 'emit_mission', arguments: JSON.stringify(args) }] })
const answer = (text: string): ChatTurn => ({ calls: [{ name: 'answer_query', arguments: JSON.stringify({ text }) }] })
const calcCall = (expr: string): ChatTurn => ({ calls: [{ name: 'calculate', arguments: JSON.stringify({ expr }) }] })

test('compiles a CANDIDATE_INTENTION and transcribes the payoff sign', async () => {
  const pos = await compile('Move to (4,7) and get +10', scripted([
    emit({ kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go to tile', params: { targetTile: { tag: 'TEXT_BOUND', x: 4, y: 7 } } }),
  ]))
  expect(pos.kind).toBe('mission')
  if (pos.kind === 'mission') expect(pos.mission.payoff).toBe(10)

  const neg = await compile('Drop in leftmost tile to get -10', scripted([
    emit({ kind: 'CANDIDATE_INTENTION', payoff: -10, abstractIntent: 'drop leftmost', params: { rule: 'leftmost' } }),
  ]))
  expect(neg.kind).toBe('mission')
  if (neg.kind === 'mission') expect(neg.mission.payoff).toBe(-10)
})

test('answers a QUERY without producing a mission', async () => {
  const r = await compile('Capital of Italy?', scripted([answer('Rome')]))
  expect(r).toEqual({ kind: 'query', answer: 'Rome' })
})

test('feeds calculate results back, then emits', async () => {
  const r = await compile('Move to (4*2, (1+3)*3) get +5', scripted([
    calcCall('4*2'),
    calcCall('(1+3)*3'),
    emit({ kind: 'CANDIDATE_INTENTION', payoff: 5, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: 8, y: 12 } } }),
  ]))
  expect(r.kind).toBe('mission')
})

test('normalises an expression left in coordinates via calc', async () => {
  const r = await compile('go', scripted([
    emit({ kind: 'CANDIDATE_INTENTION', payoff: 5, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: '4*2', y: 7 } } }),
  ]))
  expect(r.kind).toBe('mission')
  if (r.kind === 'mission') {
    const t = r.mission.params.targetTile
    expect(t && t.tag === 'TEXT_BOUND' ? t.x : null).toBe(8)
  }
})

test('drops a mission whose coordinate expression is unparseable', async () => {
  const r = await compile('go', scripted([
    emit({ kind: 'CANDIDATE_INTENTION', payoff: 5, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: 'process()', y: 7 } } }),
  ]))
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})

test('FALLBACK is discarded as not_applicable (flag off)', async () => {
  const r = await compile('Visit every tile of the left room', scripted([
    emit({ kind: 'FALLBACK', payoff: 0, abstractIntent: 'coverage', params: {} }),
  ]))
  expect(r).toEqual({ kind: 'discard', reason: 'not_applicable' })
})

test('malformed emit args are discarded', async () => {
  const r = await compile('x', scripted([emit({ kind: 'NONSENSE', payoff: 1, abstractIntent: 'x', params: {} })]))
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})

test('exhausting the iteration cap with no terminal is malformed', async () => {
  const r = await compile('x', scripted([calcCall('1'), calcCall('1'), calcCall('1'), calcCall('1')]))
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})
