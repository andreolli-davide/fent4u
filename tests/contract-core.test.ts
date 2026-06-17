// tests/contract-core.test.ts
import { test, expect } from 'bun:test'
import { goalSatisfied, navTarget } from '../src/coordination/contract.js'

test('AT_TILE goal is satisfied only on the exact tile', () => {
  const goal = { kind: 'AT_TILE' as const, tile: { x: 3, y: 2 } }
  expect(goalSatisfied(goal, { x: 3, y: 2 })).toBe(true)
  expect(goalSatisfied(goal, { x: 3, y: 1 })).toBe(false)
})

test('IN_ZONE goal uses Manhattan radius (server metric, §8.4)', () => {
  const goal = { kind: 'IN_ZONE' as const, center: { x: 5, y: 5 }, radius: 3 }
  expect(goalSatisfied(goal, { x: 5, y: 5 })).toBe(true)  // d=0
  expect(goalSatisfied(goal, { x: 7, y: 6 })).toBe(true)  // d=3
  expect(goalSatisfied(goal, { x: 8, y: 6 })).toBe(false) // d=4
})

test('navTarget returns the tile for AT_TILE and the centre for IN_ZONE', () => {
  expect(navTarget({ kind: 'AT_TILE', tile: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2 })
  expect(navTarget({ kind: 'IN_ZONE', center: { x: 4, y: 4 }, radius: 2 })).toEqual({ x: 4, y: 4 })
})

import { advance, type Contract } from '../src/coordination/contract.js'

// A rendezvous: both reach within r=3 of (5,5); barrier needs both milestones.
function rdv(posted: Record<string, boolean> = {}): Contract {
  return {
    id: 'c1', type: 'RENDEZVOUS',
    steps: [
      { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'liaison_ready' },
      { kind: 'LOCAL', agent: 'courier', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'courier_ready' },
      { kind: 'BARRIER', needs: ['liaison_ready', 'courier_ready'] },
    ],
    posted, payoff: 500, deadline: 9999, status: 'ACTIVE',
  }
}

test('advance: navigate toward my zone when I am outside it', () => {
  expect(advance(rdv(), 'liaison', { x: 0, y: 0 })).toEqual({ kind: 'navigate', to: { x: 5, y: 5 } })
})

test('advance: post my milestone when I am inside the zone', () => {
  expect(advance(rdv(), 'liaison', { x: 5, y: 6 })).toEqual({ kind: 'post', milestone: 'liaison_ready' })
})

test('advance: block at the barrier when only I have posted', () => {
  const c = rdv({ liaison_ready: true })
  // I (liaison) am in-zone and already posted; the barrier still needs courier_ready.
  expect(advance(c, 'liaison', { x: 5, y: 5 })).toEqual({ kind: 'block' })
})

test('advance: done once the barrier is released (both posted)', () => {
  const c = rdv({ liaison_ready: true, courier_ready: true })
  expect(advance(c, 'liaison', { x: 5, y: 5 })).toEqual({ kind: 'done' })
})

test('advance: I skip the OTHER agent\'s LOCAL step', () => {
  // courier, far from zone, liaison not yet ready: courier works on ITS own local.
  expect(advance(rdv(), 'courier', { x: 0, y: 0 })).toEqual({ kind: 'navigate', to: { x: 5, y: 5 } })
})

import { isContractMsg } from '../src/coordination/contract.js'

test('isContractMsg accepts the four sub-protocol kinds', () => {
  expect(isContractMsg({ kind: 'propose', contract: rdv() })).toBe(true)
  expect(isContractMsg({ kind: 'accept', id: 'c1' })).toBe(true)
  expect(isContractMsg({ kind: 'post', id: 'c1', milestone: 'liaison_ready' })).toBe(true)
  expect(isContractMsg({ kind: 'teardown', id: 'c1', status: 'SATISFIED' })).toBe(true)
})

test('isContractMsg rejects malformed payloads', () => {
  expect(isContractMsg(null)).toBe(false)
  expect(isContractMsg({ kind: 'nope' })).toBe(false)
  expect(isContractMsg({ kind: 'accept' })).toBe(false)              // missing id
  expect(isContractMsg({ kind: 'post', id: 'c1' })).toBe(false)      // missing milestone
})
