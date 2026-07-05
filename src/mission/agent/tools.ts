// §18.5 tool registry (five families): perception(read) + world-actions(steps) + strategy(policy
// hooks) + coordination + free-form (calculate / answer / emit_plan). The LLM never computes
// geometry — reads hit the snapshot; grid validation lives in cost.ts / the loop. The strategy and
// coordination tools are TERMINAL: each one installs the corresponding typed effect (a REWARD_SHAPER
// / HARD_CONSTRAINT / COORDINATION_CONTRACT mission), so the LLM_AGENT handler reproduces the whole
// §4 taxonomy through its tools (a shaper becomes set_reward_shaper, a contract propose_contract, …).

import type { FunctionDef } from '../llm.js'
import type { AgentStep, MissionDraft, MissionParams } from '../kinds.js'
import type { WorldSnapshot } from './snapshot.js'
import { calc } from '../calc.js'

const READ = new Set(['get_my_position', 'scan_world', 'get_parcel', 'list_delivery_zones',
  'get_partner_status', 'calculate'])
const ACTION = new Set(['goto', 'pickup', 'deliver', 'wait'])
// Strategy (§18.5 family 3) + coordination (family 4): terminal policy/coordination installers.
const STRATEGY = new Set(['set_reward_shaper', 'set_zone_value', 'add_constraint', 'clear_policy'])
const COORD = new Set(['propose_contract', 'claim_parcel', 'message_partner'])

export const isReadTool = (name: string): boolean => READ.has(name)
export const isActionTool = (name: string): boolean => ACTION.has(name)
export const isStrategyTool = (name: string): boolean => STRATEGY.has(name)
export const isCoordTool = (name: string): boolean => COORD.has(name)

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
  // Strategy (level-2 "adapt your strategy"): reshape the shared utility core. Terminal.
  { name: 'set_reward_shaper', description: 'TERMINAL. Reshape delivery valuation. m = count->factor map (e.g. {"3":2} doubles stacks of 3); g = list of {tile:{x,y},factor} zone multipliers (5x zone, 0 avoids). Transcribe stated numbers only.', parameters: { type: 'object', properties: { m: { type: 'object' }, g: { type: 'array', items: { type: 'object', properties: { tile: POS, factor: { type: 'number' } }, required: ['tile', 'factor'] } } } } },
  { name: 'set_zone_value', description: 'TERMINAL. Set one delivery zone multiplier (convenience for a single g entry): tile {x,y}, factor (5 = 5x, 0 = avoid).', parameters: { type: 'object', properties: { tile: POS, factor: { type: 'number' } }, required: ['tile', 'factor'] } },
  { name: 'add_constraint', description: 'TERMINAL. Install a HARD_CONSTRAINT. Priced toll: {tile:{x,y}, penalty}. Absolute reward cap: {maxReward}. Avoid a delivery zone: {tile:{x,y}} with no penalty.', parameters: { type: 'object', properties: { tile: POS, penalty: { type: 'number' }, maxReward: { type: 'number' } } } },
  { name: 'clear_policy', description: 'TERMINAL. Remove any active reward shaper / constraint (reset to base valuation).', parameters: { type: 'object', properties: {} } },
  // Coordination (level-3): joint goals & partner communication over the blackboard. Terminal.
  { name: 'propose_contract', description: 'TERMINAL. Propose a joint contract with the partner. type = HANDOFF (one picks, the other delivers), RENDEZVOUS (both meet near a point), or SYNC_GATE (move on a green signal). payoff is the stated reward; the runtime binds tiles/roles.', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['HANDOFF', 'RENDEZVOUS', 'SYNC_GATE'] }, payoff: { type: 'number' }, deadline: { type: 'number' } }, required: ['type', 'payoff'] } },
  { name: 'claim_parcel', description: 'Announce that YOU will collect a parcel (locks it away from the partner). Folded into the plan you emit.', parameters: { type: 'object', properties: { parcelId: { type: 'string' } }, required: ['parcelId'] } },
  { name: 'message_partner', description: 'Announce a committed intention to the partner (structured, enters its beliefs). Non-terminal.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
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
      return JSON.stringify(snap.zones)
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

const textBound = (p: { x: number; y: number }) => ({ tag: 'TEXT_BOUND' as const, x: p.x, y: p.y })

/**
 * §18.5 family 3 — turn a terminal strategy tool call into the equivalent typed policy mission
 * (REWARD_SHAPER / HARD_CONSTRAINT). null ⇒ malformed args (discard). The runtime installs the
 * mission; TeamMissionView then applies the shaper/toll/filter to BOTH agents (broadcast, §18.8).
 */
export function strategyDraft(name: string, args: Record<string, unknown>, intent: string): MissionDraft | null {
  const base = { payoff: 0, abstractIntent: intent }
  switch (name) {
    case 'set_reward_shaper': {
      const params: MissionParams = {}
      if (typeof args.m === 'object' && args.m !== null) {
        const m: Record<string, number> = {}
        for (const [k, v] of Object.entries(args.m as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) m[k] = v
        if (Object.keys(m).length > 0) params.m = m
      }
      if (Array.isArray(args.g)) {
        const g: NonNullable<MissionParams['g']> = []
        for (const e of args.g as unknown[]) {
          if (typeof e === 'object' && e !== null && isPos((e as { tile?: unknown }).tile) && typeof (e as { factor?: unknown }).factor === 'number') {
            const ee = e as { tile: { x: number; y: number }; factor: number }
            g.push({ tile: textBound(ee.tile), factor: ee.factor })
          }
        }
        if (g.length > 0) params.g = g
      }
      return { kind: 'REWARD_SHAPER', ...base, params }
    }
    case 'set_zone_value':
      if (!isPos(args.tile) || typeof args.factor !== 'number') return null
      return { kind: 'REWARD_SHAPER', ...base, params: { g: [{ tile: textBound(args.tile), factor: args.factor }] } }
    case 'add_constraint': {
      if (isPos(args.tile) && typeof args.penalty === 'number' && Number.isFinite(args.penalty)) {
        return { kind: 'HARD_CONSTRAINT', ...base, sub: 'PRICED', payoff: -Math.abs(args.penalty), params: { priced: [{ tile: textBound(args.tile), toll: Math.abs(args.penalty) }] } }
      }
      if (typeof args.maxReward === 'number' && Number.isFinite(args.maxReward)) {
        return { kind: 'HARD_CONSTRAINT', ...base, sub: 'ABSOLUTE', params: { absolute: { kind: 'REWARD_THRESHOLD', max: args.maxReward } } }
      }
      if (isPos(args.tile)) {
        return { kind: 'HARD_CONSTRAINT', ...base, sub: 'ABSOLUTE', params: { absolute: { kind: 'ZONE', tile: textBound(args.tile) } } }
      }
      return null
    }
    case 'clear_policy':
      // An identity REWARD_SHAPER overwrites the single slot, tearing down any active shaper/toll/filter.
      return { kind: 'REWARD_SHAPER', ...base, params: {} }
    default:
      return null
  }
}

/**
 * §18.5 family 4 — propose_contract → a COORDINATION_CONTRACT mission the §8 bridge binds and
 * (adoption-gated) proposes. claim_parcel / message_partner are handled inline by the loop (they
 * fold into the plan / are announced), so this returns null for them.
 */
export function coordDraft(name: string, args: Record<string, unknown>, intent: string): MissionDraft | null {
  if (name !== 'propose_contract') return null
  const type = args.type
  if (type !== 'HANDOFF' && type !== 'RENDEZVOUS' && type !== 'SYNC_GATE') return null
  if (typeof args.payoff !== 'number' || !Number.isFinite(args.payoff)) return null
  const deadline = typeof args.deadline === 'number' ? args.deadline : undefined
  return { kind: 'COORDINATION_CONTRACT', payoff: args.payoff, abstractIntent: intent, deadline, params: { contractType: type } }
}
