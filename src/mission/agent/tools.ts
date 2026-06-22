// §18.5 slice-1 tool registry (three families): perception(read) + world-actions(steps)
// + free-form (calculate / answer / emit_plan). The LLM never computes geometry — reads hit
// the snapshot; route_cost and grid validation live in cost.ts / the loop.

import type { FunctionDef } from '../llm.js'
import type { AgentStep } from '../kinds.js'
import type { WorldSnapshot } from './snapshot.js'
import { calc } from '../calc.js'

const READ = new Set(['get_my_position', 'scan_world', 'get_parcel', 'list_delivery_zones',
  'get_partner_status', 'calculate'])
const ACTION = new Set(['goto', 'pickup', 'deliver', 'wait'])

export const isReadTool = (name: string): boolean => READ.has(name)
export const isActionTool = (name: string): boolean => ACTION.has(name)

const POS = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }

export const AGENT_TOOLS: readonly FunctionDef[] = [
  { name: 'get_my_position', description: 'Return your current (simulated) position.', parameters: { type: 'object', properties: {} } },
  { name: 'scan_world', description: 'List visible parcels (id, position, reward) and delivery zones.', parameters: { type: 'object', properties: {} } },
  { name: 'get_parcel', description: 'Return one parcel by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_delivery_zones', description: 'List delivery-zone positions.', parameters: { type: 'object', properties: {} } },
  { name: 'get_partner_status', description: 'Return the partner agent position if known.', parameters: { type: 'object', properties: {} } },
  { name: 'goto', description: 'Plan step: walk to a tile. Costed by A*.', parameters: { type: 'object', properties: { target: POS }, required: ['target'] } },
  { name: 'pickup', description: 'Plan step: pick up a parcel by id.', parameters: { type: 'object', properties: { parcelId: { type: 'string' } }, required: ['parcelId'] } },
  { name: 'deliver', description: 'Plan step: deliver carried parcels at a zone.', parameters: { type: 'object', properties: { zone: POS }, required: ['zone'] } },
  { name: 'wait', description: 'Plan step: wait n ticks.', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
  { name: 'calculate', description: 'Evaluate an arithmetic expression exactly. Use for any stated formula instead of computing yourself.', parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } },
  { name: 'answer', description: 'Terminal for a QUERY: post a natural-language reply to the mission-agent.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'emit_plan', description: 'Terminal for a plan: emit the signed payoff, optional deadline tick, and the ordered step-list.', parameters: { type: 'object', properties: { payoff: { type: 'number' }, deadline: { type: 'number' }, steps: { type: 'array', items: { type: 'object' } } }, required: ['payoff', 'steps'] } },
]

const isPos = (v: unknown): v is { x: number; y: number } =>
  typeof v === 'object' && v !== null &&
  typeof (v as { x: unknown }).x === 'number' && typeof (v as { y: unknown }).y === 'number'

export function executeRead(snap: WorldSnapshot, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'get_my_position':
      return `${snap.selfPos.x},${snap.selfPos.y}`
    case 'scan_world':
      return JSON.stringify({
        parcels: snap.parcels.map((p) => ({ id: p.id, pos: p.pos, reward: p.reward, carriedBy: p.carriedBy })),
        zones: snap.zones,
      })
    case 'get_parcel': {
      const p = snap.parcels.find((q) => q.id === args.id)
      return p ? JSON.stringify({ id: p.id, pos: p.pos, reward: p.reward, carriedBy: p.carriedBy }) : 'error: no such parcel'
    }
    case 'list_delivery_zones':
      return snap.zones.map((z) => `${z.x},${z.y}`).join('; ')
    case 'get_partner_status':
      return snap.partnerPos ? `${snap.partnerPos.x},${snap.partnerPos.y}` : 'unknown'
    case 'calculate': {
      const v = typeof args.expr === 'string' ? calc(args.expr) : null
      return v === null ? 'error: invalid expression' : String(v)
    }
    default:
      return 'error: unknown read tool'
  }
}

export function actionStep(name: string, args: Record<string, unknown>): AgentStep | null {
  switch (name) {
    case 'goto': return isPos(args.target) ? { op: 'goto', target: { x: args.target.x, y: args.target.y } } : null
    case 'pickup': return typeof args.parcelId === 'string' ? { op: 'pickup', parcelId: args.parcelId } : null
    case 'deliver': return isPos(args.zone) ? { op: 'deliver', zone: { x: args.zone.x, y: args.zone.y } } : null
    case 'wait': return typeof args.n === 'number' && Number.isFinite(args.n) ? { op: 'wait', n: args.n } : null
    default: return null
  }
}
