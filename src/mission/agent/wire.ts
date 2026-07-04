// Wiring helpers for the mission handler switch (§18.2). Kept out of liaison.ts so the dispatch
// and snapshot construction are unit-testable without a live worker.

import type { CompileResult } from '../compiler.js'
import type { Params } from '../../bdi/params.js'
import type { Pos } from '../../types/perception.js'
import type { BeliefBase } from '../../blackboard/beliefs.js'
import { beliefSignature, type WorldSnapshot } from './snapshot.js'

export interface CompileDeps {
  handler: 'OFF' | 'LLM_AGENT' | 'PDDL'
  params: Params
  compile: (raw: string) => Promise<CompileResult>
  reactPlan: (raw: string, snap: WorldSnapshot) => Promise<CompileResult>
  snapshot: () => WorldSnapshot | null
  pddlCompile?: (raw: string) => Promise<CompileResult> // §17 PDDL lane; required when handler==='PDDL'
}

export function makeMissionCompile(deps: CompileDeps): (raw: string) => Promise<CompileResult> {
  if (deps.handler === 'OFF') return deps.compile
  if (deps.handler === 'PDDL') {
    // §17: the PDDL lane owns compilation. Misconfigured (no lane wired) ⇒ discard, never throw
    // into the intake — a planner-less run must degrade to no missions, not crash the agent.
    return deps.pddlCompile ?? (async () => ({ kind: 'discard', reason: 'not_applicable' }))
  }
  // LLM_AGENT: fresh snapshot per mission; one born-stale re-plan if the world moved during planning.
  return async (raw: string): Promise<CompileResult> => {
    const snap = deps.snapshot()
    if (snap === null) return { kind: 'discard', reason: 'not_applicable' }
    const res = await deps.reactPlan(raw, snap)
    if (res.kind !== 'mission') return res
    const fresh = deps.snapshot()
    if (fresh !== null && fresh.sig !== snap.sig) {
      const re = await deps.reactPlan(raw, fresh)         // born-stale ⇒ one re-plan (§18.4)
      return re
    }
    return res
  }
}

// Build a WorldSnapshot from the live belief base (§18.4). selfPos/parcels/partner are read here;
// zones come from the prebuilt grid. tnow must be passed explicitly because BeliefBase.lastTick
// is private — callers should pass snap.tick or the last observed tick.
export function snapshotFromBeliefs(bb: BeliefBase, zones: Pos[], tnow: number): WorldSnapshot {
  const parcels = [...bb.parcels.values()].map((p) => ({
    id: p.id, pos: p.pos, reward: p.rewardSeen, carriedBy: p.carriedBy,
  }))
  const selfPos = bb.self.pos
  // AgentBelief has rel directly (classifyRel stamps it during foldPerception).
  const partnerEntry = [...bb.agents.values()].find((a) => a.rel === 'partner')
  const partnerPos = partnerEntry ? partnerEntry.pos : null
  return {
    t0: tnow, selfPos, carried: [], delivered: [],
    parcels, zones, partnerPos, sig: beliefSignature(parcels, selfPos),
  }
}
