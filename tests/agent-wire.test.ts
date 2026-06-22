import { test, expect } from 'bun:test'
import { makeMissionCompile } from '../src/mission/agent/wire.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'

const stubDeps = (handler: 'OFF' | 'LLM_AGENT' | 'PDDL') => ({
  handler,
  params: DEFAULT_PARAMS,
  compile: async () => ({ kind: 'discard', reason: 'not_applicable' as const }),
  reactPlan: async () => ({ kind: 'query', answer: 'from-react' as string }),
  snapshot: () => null,            // not used by the OFF/PDDL branches
})

test('OFF routes to the typed compile()', async () => {
  const fn = makeMissionCompile(stubDeps('OFF') as never)
  expect(await fn('hi')).toEqual({ kind: 'discard', reason: 'not_applicable' })
})

test('LLM_AGENT routes to reactPlan', async () => {
  const deps = { ...stubDeps('LLM_AGENT'), snapshot: () => ({ ready: true }) }
  const fn = makeMissionCompile(deps as never)
  expect(await fn('hi')).toEqual({ kind: 'query', answer: 'from-react' })
})

test('PDDL throws not-implemented', async () => {
  const fn = makeMissionCompile(stubDeps('PDDL') as never)
  await expect(fn('hi')).rejects.toThrow(/not implemented/i)
})
