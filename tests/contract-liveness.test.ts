// §8.6 contract liveness: commit-timeout abort, barrier-deadline fail, meeting-tile helper,
// and the odd-row staging tile resolver.
import { test, expect } from 'bun:test'
import {
  ContractRuntime, rendezvousContract, handoffContract, syncGateContract, contractMeetTile,
} from '../src/coordination/contract.js'
import { nearestOddRowTile } from '../src/coordination/bridge.js'
import { buildGrid } from '../src/planning/astar.js'
import type { Tile } from '../src/types/perception.js'

test('tick aborts a PROPOSED contract past COMMIT_TIMEOUT (never strand the proposer)', () => {
  const rt = new ContractRuntime()
  rt.propose(rendezvousContract('r1', { x: 5, y: 5 }, 3, 500, 9999), 100)
  expect(rt.tick(115, 20)).toBeNull()           // within the window
  expect(rt.current()?.status).toBe('PROPOSED')
  const msg = rt.tick(121, 20)                    // 121 - 100 = 21 > 20
  expect(msg).toEqual({ kind: 'teardown', id: 'r1', status: 'ABORTED' })
  expect(rt.current()).toBeNull()
})

test('accept before the timeout keeps the contract ACTIVE (no abort)', () => {
  const rt = new ContractRuntime()
  rt.propose(rendezvousContract('r1', { x: 5, y: 5 }, 3, 500, 9999), 100)
  rt.applyMsg({ kind: 'accept', id: 'r1' }, 'liaison') // partner accepted → ACTIVE
  expect(rt.tick(200, 20)).toBeNull()                  // ACTIVE, deadline 9999 far off
  expect(rt.current()?.status).toBe('ACTIVE')
})

test('tick fails an ACTIVE contract past its BARRIER_DEADLINE', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rendezvousContract('r1', { x: 5, y: 5 }, 3, 500, 300) }, 'courier') // → ACTIVE, deadline 300
  expect(rt.tick(300, 20)).toBeNull()
  const msg = rt.tick(301, 20)
  expect(msg).toEqual({ kind: 'teardown', id: 'r1', status: 'FAILED' })
  expect(rt.current()).toBeNull()
})

test('contractMeetTile picks the staging centre / drop tile', () => {
  expect(contractMeetTile(rendezvousContract('r', { x: 4, y: 2 }, 3, 500, 9999))).toEqual({ x: 4, y: 2 })
  expect(contractMeetTile(syncGateContract('g', { x: 3, y: 3 }, 700, 9999))).toEqual({ x: 3, y: 3 })
  const h = handoffContract('h', 'p1', 'liaison', 'courier',
    { parcel: { x: 0, y: 0 }, drop: { x: 2, y: 2 }, vacate: { x: 2, y: 3 }, approach: { x: 3, y: 2 }, delivery: { x: 1, y: 2 } },
    200, 9999)
  expect(contractMeetTile(h)).toEqual({ x: 2, y: 2 }) // the non-scoring drop tile
})

test('nearestOddRowTile returns a walkable odd-row tile nearest the target', () => {
  const tiles: Tile[] = []
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) tiles.push({ pos: { x, y }, type: 'walkable' })
  const grid = buildGrid(tiles)
  const t = nearestOddRowTile(grid, { x: 2, y: 2 })
  expect(t).not.toBeNull()
  expect(t!.y % 2).toBe(1)                // odd row
  expect(Math.abs(t!.y - 2)).toBe(1)      // row 1 or 3, both distance 1
})
