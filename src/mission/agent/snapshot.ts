// §18.4 frozen world snapshot + deterministic egocentric forward-application of the agent's
// OWN action effects (enemies not modelled — static-world assumption §17.7.4). Pure: every
// forwardApply returns a fresh snapshot, so a later read tool observes the simulated state.

import type { Pos } from '../../types/perception.js'
import type { AgentStep } from '../kinds.js'

export interface SnapParcel { id: string; pos: Pos; reward: number; carriedBy: string | null }

export interface WorldSnapshot {
  t0: number
  selfPos: Pos
  carried: string[]
  delivered: Array<{ id: string; zone: Pos }>
  parcels: SnapParcel[]
  zones: Pos[]
  partnerPos: Pos | null
  sig: string
}

export function forwardApply(s: WorldSnapshot, step: AgentStep): WorldSnapshot {
  switch (step.op) {
    case 'goto':
      return { ...s, selfPos: { ...step.target } }
    case 'pickup': {
      if (s.carried.includes(step.parcelId)) return s
      return {
        ...s,
        carried: [...s.carried, step.parcelId],
        parcels: s.parcels.map((p) => (p.id === step.parcelId ? { ...p, carriedBy: 'self' } : p)),
      }
    }
    case 'deliver': {
      if (s.carried.length === 0) return s
      const newlyDelivered = s.carried.map((id) => ({ id, zone: { ...step.zone } }))
      return { ...s, carried: [], delivered: [...s.delivered, ...newlyDelivered] }
    }
    case 'wait':
      return s
  }
}

// A stable string of the volatile beliefs used for the born-stale freshness check (§18.4).
export function beliefSignature(parcels: SnapParcel[], selfPos: Pos): string {
  const ps = [...parcels]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}:${p.pos.x},${p.pos.y}:${p.carriedBy ?? ''}`)
    .join('|')
  return `${selfPos.x},${selfPos.y}#${ps}`
}
