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

// §18.5 family 3 — strategy hooks reproduce the typed L2 taxonomy through the LLM's tools.
test('set_reward_shaper installs a REWARD_SHAPER mission', async () => {
  const chat = scripted([call('set_reward_shaper', { m: { '3': 2 } })])
  const r = await reactPlan('deliver stacks of 3 to double', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  expect(r.kind).toBe('mission')
  if (r.kind !== 'mission') throw new Error('unreachable')
  expect(r.mission.kind).toBe('REWARD_SHAPER')
  expect(r.mission.params.m).toEqual({ '3': 2 })
})

test('add_constraint (priced) installs a HARD_CONSTRAINT with a toll', async () => {
  const chat = scripted([call('add_constraint', { tile: { x: 3, y: 0 }, penalty: 50 })])
  const r = await reactPlan('do not cross (3,0) or lose 50', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  if (r.kind !== 'mission') throw new Error('unreachable')
  expect(r.mission.kind).toBe('HARD_CONSTRAINT')
  expect(r.mission.sub).toBe('PRICED')
  expect(r.mission.params.priced).toEqual([{ tile: { tag: 'TEXT_BOUND', x: 3, y: 0 }, toll: 50 }])
})

test('add_constraint (reward cap) installs an ABSOLUTE HARD_CONSTRAINT', async () => {
  const chat = scripted([call('add_constraint', { maxReward: 10 })])
  const r = await reactPlan('parcels over 10 give no reward', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  if (r.kind !== 'mission') throw new Error('unreachable')
  expect(r.mission.kind).toBe('HARD_CONSTRAINT')
  expect(r.mission.params.absolute).toEqual({ kind: 'REWARD_THRESHOLD', max: 10 })
})

// §18.5 family 4 — propose_contract reproduces the typed L3 coordination.
test('propose_contract installs a COORDINATION_CONTRACT mission', async () => {
  const chat = scripted([call('propose_contract', { type: 'HANDOFF', payoff: 200 })])
  const r = await reactPlan('one picks, the other delivers, +200', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  if (r.kind !== 'mission') throw new Error('unreachable')
  expect(r.mission.kind).toBe('COORDINATION_CONTRACT')
  expect(r.mission.params.contractType).toBe('HANDOFF')
  expect(r.mission.payoff).toBe(200)
})

test('message_partner is non-terminal; the plan still finishes', async () => {
  const chat = scripted([
    call('message_partner', { text: 'I take p1' }),
    call('emit_plan', { payoff: 10, steps: [{ op: 'goto', target: { x: 2, y: 0 } }] }),
  ])
  const r = await reactPlan('coordinate then move', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  if (r.kind !== 'mission') throw new Error('unreachable')
  expect(r.mission.kind).toBe('AGENT_PLAN')
})

test('clear_policy installs an identity REWARD_SHAPER (resets valuation)', async () => {
  const chat = scripted([call('clear_policy', {})])
  const r = await reactPlan('reset policy', snap, chat, grid, dc, 0, DEFAULT_PARAMS, ids)
  if (r.kind !== 'mission') throw new Error('unreachable')
  expect(r.mission.kind).toBe('REWARD_SHAPER')
  expect(r.mission.params.m).toBeUndefined()
  expect(r.mission.params.g).toBeUndefined()
})
