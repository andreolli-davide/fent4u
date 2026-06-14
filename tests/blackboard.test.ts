// tests/blackboard.test.ts
import { test, expect } from 'bun:test'
import {
  Blackboard,
  isBlackboardMsg,
  isEmptyDelta,
  HEARTBEAT_INTERVAL_TICKS,
  PARTNER_TTL_TICKS,
  type BlackboardMsg,
  type LoggerLike,
} from '../src/blackboard/blackboard.js'
import { BeliefBase, type Delta } from '../src/blackboard/beliefs.js'
import type { GameConsts, Tile, SelfObs, PerceptionSnapshot, ParcelObs } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = {
  CLOCK: 50,
  MOVEMENT_DURATION: 50,
  OBS_DISTANCE: 5,
  PARCEL_DECAY_TICKS: 20,
  PARCEL_DECAY_RAW: '1s',
  PENALTY: 1,
}
const MAP: Tile[] = [{ pos: { x: 5, y: 5 }, type: 'walkable' }]
const SELF_A: SelfObs = { id: 'A', name: 'A', teamId: 'T', pos: { x: 5, y: 5 }, score: 0 }
const SELF_B: SelfObs = { id: 'B', name: 'B', teamId: 'T', pos: { x: 1, y: 1 }, score: 0 }

function fakeLogger(): { log: LoggerLike; debugs: Record<string, unknown>[]; infos: Record<string, unknown>[] } {
  const debugs: Record<string, unknown>[] = []
  const infos: Record<string, unknown>[] = []
  const log: LoggerLike = {
    debug: (o) => debugs.push(typeof o === 'string' ? { msg: o } : o),
    info: (o) => infos.push(typeof o === 'string' ? { msg: o } : o),
  }
  return { log, debugs, infos }
}

const emptyDelta = (): Delta => ({
  tick: 0,
  parcels: { upsert: [], remove: [] },
  agents: { upsert: [] },
  crates: { upsert: [] },
  self: null,
})

function snap(self: SelfObs, tick: number, parcels: ParcelObs[] = []): PerceptionSnapshot {
  return {
    tick,
    self: { id: self.id, name: self.name, teamId: self.teamId, pos: self.pos, score: self.score },
    parcels,
    agents: [],
    crates: [],
  }
}

function payloads(sent: A2AMessage[]): BlackboardMsg[] {
  return sent.map((m) => m.payload as BlackboardMsg)
}

test('constants have the spec defaults', () => {
  expect(HEARTBEAT_INTERVAL_TICKS).toBe(1)
  expect(PARTNER_TTL_TICKS).toBe(5)
})

test('isEmptyDelta is true for a blank delta, false when any field is populated', () => {
  expect(isEmptyDelta(emptyDelta())).toBe(true)
  const d = emptyDelta()
  d.parcels.remove.push('p1')
  expect(isEmptyDelta(d)).toBe(false)
  const d2 = emptyDelta()
  d2.self = { id: 'A', name: 'A', teamId: 'T', pos: { x: 0, y: 0 }, score: 0, carrying: [] }
  expect(isEmptyDelta(d2)).toBe(false)
})

test('isBlackboardMsg accepts each kind and rejects malformed payloads', () => {
  expect(isBlackboardMsg({ kind: 'hello', tick: 3 })).toBe(true)
  expect(isBlackboardMsg({ kind: 'heartbeat', tick: 3 })).toBe(true)
  expect(isBlackboardMsg({ kind: 'delta', tick: 3, delta: emptyDelta() })).toBe(true)
  expect(isBlackboardMsg({ kind: 'snapshot', tick: 3, base: emptyDelta() })).toBe(true)
  expect(isBlackboardMsg({ kind: 'delta', tick: 3 })).toBe(false) // missing delta
  expect(isBlackboardMsg({ kind: 'bogus', tick: 3 })).toBe(false)
  expect(isBlackboardMsg({ tick: 3 })).toBe(false)
  expect(isBlackboardMsg(null)).toBe(false)
  expect(isBlackboardMsg('x')).toBe(false)
})

test('partnerAlive is false before any contact', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
  })
  expect(bb.partnerLastSeenTick).toBe(-Infinity)
  expect(bb.partnerAlive(100)).toBe(false)
})

test('onTick ships a delta on material change and addresses it to the partner', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
  })
  bb.beliefs.foldPerception(snap(SELF_A, 10, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  bb.onTick(10)
  expect(sent).toHaveLength(1)
  expect(sent[0].from).toBe('liaison')
  expect(sent[0].to).toBe('courier')
  expect(sent[0].type).toBe('blackboard')
  const msg = sent[0].payload as BlackboardMsg
  expect(msg.kind).toBe('delta')
  if (msg.kind === 'delta') {
    expect(msg.tick).toBe(10)
    expect(msg.delta.parcels.upsert.map((p) => p.id)).toEqual(['p1'])
  }
})

test('onTick drains the base: a second onTick with no new observation does not re-ship the delta', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
    heartbeatInterval: 100,
  })
  bb.beliefs.foldPerception(snap(SELF_A, 10, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  bb.onTick(10)
  bb.onTick(10) // same tick, nothing new, heartbeat interval not reached
  expect(payloads(sent).filter((m) => m.kind === 'delta')).toHaveLength(1)
  expect(sent).toHaveLength(1)
})

test('onTick emits a heartbeat only once the interval since the last send has elapsed', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
    heartbeatInterval: 3,
  })
  bb.beliefs.foldPerception(snap(SELF_A, 10, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  bb.onTick(10) // delta, lastSentTick = 10
  bb.onTick(11) // 11-10=1 < 3 -> silent
  bb.onTick(12) // 12-10=2 < 3 -> silent
  expect(sent).toHaveLength(1)
  bb.onTick(13) // 13-10=3 >= 3 -> heartbeat
  expect(sent).toHaveLength(2)
  const last = sent[1].payload as BlackboardMsg
  expect(last.kind).toBe('heartbeat')
  if (last.kind === 'heartbeat') expect(last.tick).toBe(13)
})

test('a delta send counts as a heartbeat (resets the silence clock)', () => {
  const { log } = fakeLogger()
  const sent: A2AMessage[] = []
  const bb = new Blackboard(new BeliefBase(SELF_A, CONSTS, MAP), {
    self: 'liaison',
    partner: 'courier',
    send: (m) => sent.push(m),
    logger: log,
    heartbeatInterval: 2,
  })
  bb.beliefs.foldPerception(snap(SELF_A, 10, [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }]))
  bb.onTick(10) // delta at 10
  bb.onTick(11) // 11-10=1 < 2 -> silent, no redundant ping right after a delta
  expect(sent).toHaveLength(1)
})
