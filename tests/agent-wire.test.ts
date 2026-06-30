import { test, expect } from 'bun:test'
import { makeMissionCompile, snapshotFromBeliefs, makeReplanRequester } from '../src/mission/agent/wire.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { BeliefBase } from '../src/blackboard/beliefs.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'
import type { GameConsts, Pos } from '../src/types/perception.js'

// ── Minimal belief-base fixture for snapshotFromBeliefs tests ───────────────
const BB_CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: Infinity, PARCEL_DECAY_RAW: 'infinite', PENALTY: 0 }
const bb = new BeliefBase({ id: 'me', name: 'me', teamId: 'A', pos: { x: 0, y: 0 }, score: 0 }, BB_CONSTS, [])
const zones: Pos[] = [{ x: 5, y: 0 }]

const stubDeps = (handler: 'OFF' | 'LLM_AGENT' | 'PDDL') => ({
  handler,
  params: DEFAULT_PARAMS,
  compile: async () => ({ kind: 'discard', reason: 'not_applicable' as const }),
  reactPlan: async () => ({ kind: 'query', answer: 'from-react' as string }),
  snapshot: () => null,            // not used by the OFF/PDDL branches
})

const makeSnap = (sig: string): WorldSnapshot => ({
  t0: 0, selfPos: { x: 0, y: 0 }, carried: [], delivered: [],
  parcels: [], zones: [], partnerPos: null, sig,
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

test('LLM_AGENT born-stale: re-plans once when fresh sig differs', async () => {
  let snapCalls = 0
  const snaps = [makeSnap('A'), makeSnap('B')]
  const snapshot = () => snaps[snapCalls++] ?? null

  let reactCalls = 0
  const missions = [
    { kind: 'mission' as const, mission: { id: 'plan-1' } },
    { kind: 'mission' as const, mission: { id: 'plan-2' } },
  ]
  const reactPlan = async () => missions[reactCalls++]

  const deps = { ...stubDeps('LLM_AGENT'), snapshot, reactPlan }
  const fn = makeMissionCompile(deps as never)
  const result = await fn('go somewhere')

  expect(reactCalls).toBe(2)
  expect((result as typeof missions[0]).mission.id).toBe('plan-2')
})

test('snapshotFromBeliefs stores maskTiles (empty/absent ⇒ undefined)', () => {
  // Reuse the bb + zones fixture above.
  const withMask = snapshotFromBeliefs(bb, zones, 0, [{ x: 1, y: 1 }])
  expect(withMask.maskTiles).toEqual([{ x: 1, y: 1 }])
  const without = snapshotFromBeliefs(bb, zones, 0)
  expect(without.maskTiles).toBeUndefined()
})

test('makeReplanRequester sets the pending mask then submits rawText once', () => {
  const submitted: string[] = []
  let mask: Pos[] | undefined
  const requestReplan = makeReplanRequester(
    (raw: string) => submitted.push(raw),
    (m?: Pos[]) => { mask = m },
  )
  requestReplan('fetch the parcel', [{ x: 2, y: 2 }])
  expect(mask).toEqual([{ x: 2, y: 2 }])
  expect(submitted).toEqual(['fetch the parcel'])
  // no mask → mask cleared
  requestReplan('again')
  expect(mask).toBeUndefined()
  expect(submitted).toEqual(['fetch the parcel', 'again'])
})

test('LLM_AGENT born-stale: no re-plan when fresh sig is unchanged', async () => {
  let snapCalls = 0
  const snaps = [makeSnap('A'), makeSnap('A')]
  const snapshot = () => snaps[snapCalls++] ?? null

  let reactCalls = 0
  const missions = [
    { kind: 'mission' as const, mission: { id: 'plan-1' } },
    { kind: 'mission' as const, mission: { id: 'plan-2' } },
  ]
  const reactPlan = async () => missions[reactCalls++]

  const deps = { ...stubDeps('LLM_AGENT'), snapshot, reactPlan }
  const fn = makeMissionCompile(deps as never)
  const result = await fn('go somewhere')

  expect(reactCalls).toBe(1)
  expect((result as typeof missions[0]).mission.id).toBe('plan-1')
})
