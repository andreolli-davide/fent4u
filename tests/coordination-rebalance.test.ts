import { test, expect } from 'bun:test'
import { runRebalance, type RebalanceAgent } from '../src/coordination/rebalance.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { GameConsts, Pos } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'
import type { Claim } from '../src/coordination/claims.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const parcel = (id: string, x: number): ParcelBelief => ({ id, pos: { x, y: 0 }, rewardSeen: 10, carriedBy: null, lastSeen: 0 })
const claim = (parcelId: string, agentId: 'liaison' | 'courier', originD: number): Claim => ({ parcelId, agentId, origin: 'AUCTION', epoch: 0, commitTick: 0, originD, lastD: originD, lastProgressTick: 0 })
const zones: Pos[] = [{ x: 0, y: 0 }]

test('transfer accepted: a far parcel barely started moves to the much closer agent', () => {
  // liaison owns q at x=8 but is at x=9 (originD just 1 spent → low sunk); courier sits next to q
  const q = parcel('q', 8)
  const liaison: RebalanceAgent = { id: 'liaison', pos: { x: 9, y: 0 }, carried: [], claimed: [q] }
  const courier: RebalanceAgent = { id: 'courier', pos: { x: 8, y: 0 }, carried: [], claimed: [] }
  const reassign = runRebalance({ agents: [courier, liaison], claims: [claim('q', 'liaison', 1)], enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 1 })
  expect(reassign.find((r) => r.parcelId === 'q')?.toAgent).toBe('courier')
})

test('transfer refused: high sunk travel sticks the parcel to its owner', () => {
  // liaison owns q at x=8, started 8 away, now 1 away (sunk 7) → switchCost huge; courier slightly closer is not enough
  const q = parcel('q', 8)
  const liaison: RebalanceAgent = { id: 'liaison', pos: { x: 7, y: 0 }, carried: [], claimed: [q] }
  const courier: RebalanceAgent = { id: 'courier', pos: { x: 8, y: 0 }, carried: [], claimed: [] }
  const reassign = runRebalance({ agents: [courier, liaison], claims: [claim('q', 'liaison', 8)], enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 1 })
  expect(reassign).toEqual([])
})

test('picked-up parcels never rebalance', () => {
  const carried = { id: 'held', pos: { x: 5, y: 0 }, rewardSeen: 10, carriedBy: 'liaison', lastSeen: 0 } as ParcelBelief
  const liaison: RebalanceAgent = { id: 'liaison', pos: { x: 5, y: 0 }, carried: [carried], claimed: [] }
  const courier: RebalanceAgent = { id: 'courier', pos: { x: 5, y: 0 }, carried: [], claimed: [] }
  const reassign = runRebalance({ agents: [courier, liaison], claims: [claim('held', 'liaison', 0)], enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 1 })
  expect(reassign).toEqual([])
})
