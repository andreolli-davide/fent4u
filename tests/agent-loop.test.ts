import { test, expect } from 'bun:test'
import { reactPlan } from '../src/mission/agent/loop.js'
import { buildGrid } from '../src/planning/astar.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { ChatFn, ChatTurn } from '../src/mission/llm.js'
import type { Tile, GameConsts } from '../src/types/perception.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'

const map: Tile[] = []
for (let x = 0; x <= 5; x++) map.push({ pos: { x, y: 0 }, type: x === 5 ? 'delivery' : 'walkable' })
const grid = buildGrid(map)
const consts: GameConsts = { PARCEL_DECAY_TICKS: Infinity, MOVEMENT_DURATION: 50, CLOCK: 50, OBS_DISTANCE: 5, PARCEL_DECAY_RAW: 'infinite', PENALTY: 0 }
const dc = decayConsts(consts)
const snap: WorldSnapshot = {
  t0: 0, selfPos: { x: 0, y: 0 }, carried: [], delivered: [],
  parcels: [{ id: 'p1', pos: { x: 2, y: 0 }, reward: 30, carriedBy: null }],
  zones: [{ x: 5, y: 0 }], partnerPos: null, sig: 's',
}
const ids = () => 'm-test'
function scripted(turns: ChatTurn[]): ChatFn { let i = 0; return async () => turns[i++] ?? { content: '' } }
const call = (name: string, args: object): ChatTurn => ({ calls: [{ name, arguments: JSON.stringify(args) }] })

test('answer terminates as a QUERY', async () => {
  const chat = scripted([call('answer', { text: 'forty-two' })])
  const r = await reactPlan('what is 6*7?', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r).toEqual({ kind: 'query', answer: 'forty-two' })
})

test('emit_plan produces a costed AGENT_PLAN mission', async () => {
  const chat = scripted([call('emit_plan', {
    payoff: 50,
    steps: [
      { op: 'goto', target: { x: 2, y: 0 } },
      { op: 'pickup', parcelId: 'p1' },
      { op: 'goto', target: { x: 5, y: 0 } },
      { op: 'deliver', zone: { x: 5, y: 0 } },
    ],
  })])
  const r = await reactPlan('go get p1', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r.kind).toBe('mission')
  if (r.kind !== 'mission') throw new Error('unreachable')
  expect(r.mission.kind).toBe('AGENT_PLAN')
  expect(r.mission.payoff).toBe(50)
  expect(r.mission.plan?.L).toBe(5)
  expect(r.mission.plan?.vPlan).toBe(30)
})

test('a read tool observation feeds a later turn', async () => {
  const chat = scripted([
    call('get_parcel', { id: 'p1' }),
    call('emit_plan', { payoff: 10, steps: [{ op: 'goto', target: { x: 2, y: 0 } }] }),
  ])
  const r = await reactPlan('inspect then move', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r.kind).toBe('mission')
})

test('emit_plan with an unreachable goto is discarded (P_feasible 0)', async () => {
  const chat = scripted([call('emit_plan', { payoff: 10, steps: [{ op: 'goto', target: { x: 99, y: 99 } }] })])
  const r = await reactPlan('impossible', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})

test('no terminal within MAX_ITERS is discarded', async () => {
  const chat = scripted([call('get_my_position', {}), call('get_my_position', {}), call('get_my_position', {})])
  const r = await reactPlan('loops forever', snap, chat, grid, dc, 0, { ...DEFAULT_PARAMS, max_iters: 3 }, ids)
  expect(r).toEqual({ kind: 'discard', reason: 'malformed' })
})
