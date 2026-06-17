// tests/contract-handoff-e2e.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime, handoffContract, bindHandoff, isContractMsg } from '../src/coordination/contract.js'
import { buildGrid } from '../src/planning/astar.js'
import { ClaimStore, isClaimMsg } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage, AgentId } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// 3x2 walkable grid (x:0..2, y:0..1) with (0,0) the delivery tile.
function hMap(): Tile[] {
  const tiles: Tile[] = []
  for (let x = 0; x <= 2; x++) for (let y = 0; y <= 1; y++) {
    tiles.push({ pos: { x, y }, type: x === 0 && y === 0 ? 'delivery' : 'walkable' })
  }
  return tiles
}

// A fake client whose position is mutated by move(), so successive ticks advance the agent.
function movingClient(map: Tile[], role: AgentId, start: Pos): { client: DeliverooClient; pos: Pos } {
  const state = { pos: { ...start } }
  const client: DeliverooClient = {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => {
      if (dir === 'right') state.pos.x++
      else if (dir === 'left') state.pos.x--
      else if (dir === 'up') state.pos.y++
      else state.pos.y--
      return { ...state.pos } as Pos
    },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (): Promise<PickResult[]> => [],
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return { client, pos: state.pos }
}

const log = { info: () => {}, debug: () => {}, warn: () => {} }
const snapAt = (pos: Pos): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos, score: 0 }, parcels: [], agents: [], crates: [],
})

test('two loops complete a handoff and the MISSION lock is installed then released', async () => {
  const grid = buildGrid(hMap())
  const tiles = bindHandoff(grid, { x: 2, y: 1 })!
  expect(tiles).not.toBeNull()

  // Picker = liaison (starts on the parcel); deliverer = courier (starts away from the corridor).
  const L = movingClient(hMap(), 'liaison', { x: 2, y: 1 })
  const C = movingClient(hMap(), 'courier', { x: 0, y: 1 })
  const lc = new ContractRuntime()
  const cc = new ContractRuntime()
  const lClaims = new ClaimStore()
  const cClaims = new ClaimStore()

  // In-memory a2a buses: each agent's outbound msgs are routed to the OTHER's runtime/store.
  const inbox: Record<AgentId, A2AMessage[]> = { liaison: [], courier: [] }
  const send = (m: A2AMessage): void => { inbox[m.to].push(structuredClone(m)) }
  const rts: Record<AgentId, ContractRuntime> = { liaison: lc, courier: cc }
  const stores: Record<AgentId, ClaimStore> = { liaison: lClaims, courier: cClaims }
  function drain(self: AgentId): void {
    for (const m of inbox[self].splice(0)) {
      if (m.type === 'contract' && isContractMsg(m.payload)) {
        const reply = rts[self].applyMsg(m.payload, self)
        if (reply !== null) send({ from: self, to: m.from, type: 'contract', payload: reply })
      } else if (m.type === 'claims' && isClaimMsg(m.payload)) {
        stores[self].applyMsg(m.payload, self)
      }
    }
  }

  const loopL = new BdiLoop(L.client, DEFAULT_PARAMS, log, lClaims,
    { partner: 'courier', send }, { view: new TeamMissionView(), pursue: true, contracts: lc })
  const loopC = new BdiLoop(C.client, DEFAULT_PARAMS, log, cClaims,
    { partner: 'liaison', send }, { view: new TeamMissionView(), pursue: false, contracts: cc })

  // Liaison proposes the handoff; wrap in an A2AMessage envelope (mirrors sendContract()).
  const proposeMsg = lc.propose(handoffContract('h1', 'p1', 'liaison', 'courier', tiles, 200, 9999))
  send({ from: 'liaison', to: 'courier', type: 'contract', payload: proposeMsg })

  // Drive until both runtimes have torn the contract down AND the MISSION lock is released.
  let guard = 0
  let lockSeen = false
  while ((lc.current() !== null || cc.current() !== null ||
          lClaims.claimedBy('p1') !== null || cClaims.claimedBy('p1') !== null) && guard++ < 60) {
    drain('liaison'); drain('courier')
    await loopL.tick(snapAt(L.pos))
    await loopC.tick(snapAt(C.pos))
    drain('liaison'); drain('courier')
    if (lClaims.claimedBy('p1') === 'liaison') lockSeen = true
  }

  expect(guard).toBeLessThan(60)          // converged, did not spin out
  expect(lc.current()).toBeNull()         // both tore down on SATISFIED
  expect(cc.current()).toBeNull()
  expect(lockSeen).toBe(true)             // picker MISSION-locked p1 during the contract (§9.10)
  expect(lClaims.claimedBy('p1')).toBeNull()  // released on teardown
  expect(cClaims.claimedBy('p1')).toBeNull()  // release replicated to the partner
  expect(L.pos).toEqual({ x: 1, y: 1 })   // picker ended on the vacate tile
  expect(C.pos).toEqual({ x: 0, y: 0 })   // deliverer ended on the delivery tile
})
