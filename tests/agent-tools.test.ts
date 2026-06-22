import { test, expect } from 'bun:test'
import { AGENT_TOOLS, isReadTool, isActionTool, executeRead, actionStep } from '../src/mission/agent/tools.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'

const snap: WorldSnapshot = {
  t0: 0, selfPos: { x: 1, y: 1 }, carried: [], delivered: [],
  parcels: [{ id: 'p1', pos: { x: 2, y: 2 }, reward: 40, carriedBy: null }],
  zones: [{ x: 5, y: 5 }], partnerPos: { x: 0, y: 0 }, sig: 's',
}

test('registry exposes the slice-1 tools', () => {
  const names = AGENT_TOOLS.map((t) => t.name)
  for (const n of ['get_my_position', 'scan_world', 'get_parcel', 'list_delivery_zones',
                   'get_partner_status', 'goto', 'pickup', 'deliver', 'wait',
                   'calculate', 'answer', 'emit_plan']) {
    expect(names).toContain(n)
  }
})

test('tool classification', () => {
  expect(isReadTool('get_my_position')).toBe(true)
  expect(isReadTool('calculate')).toBe(true)
  expect(isActionTool('goto')).toBe(true)
  expect(isActionTool('answer')).toBe(false)
})

test('executeRead returns observations from the snapshot', () => {
  expect(executeRead(snap, 'get_my_position', {})).toContain('1,1')
  expect(executeRead(snap, 'get_parcel', { id: 'p1' })).toContain('40')
  expect(executeRead(snap, 'list_delivery_zones', {})).toContain('"x":5')
  expect(executeRead(snap, 'calculate', { expr: '6*7' })).toBe('42')
  expect(executeRead(snap, 'calculate', { expr: 'junk' })).toContain('error')
})

test('actionStep maps world-action calls to steps', () => {
  expect(actionStep('goto', { target: { x: 2, y: 2 } })).toEqual({ op: 'goto', target: { x: 2, y: 2 } })
  expect(actionStep('pickup', { parcelId: 'p1' })).toEqual({ op: 'pickup', parcelId: 'p1' })
  expect(actionStep('goto', { target: { x: 'a', y: 2 } })).toBeNull()
})
