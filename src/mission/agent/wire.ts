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
}

export function makeMissionCompile(deps: CompileDeps): (raw: string) => Promise<CompileResult> {
  if (deps.handler === 'OFF') return deps.compile
  if (deps.handler === 'PDDL') {
    return async () => { throw new Error('MISSION_HANDLER=PDDL not implemented (future slice)') }
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

// The re-plan requester the BdiLoop calls on invalidation/K_block (§17.7). It stages the
// (one-shot) mask the snapshot builder will read, then re-submits the original rawText through
// the single-flight intake — which aborts/supersedes any in-flight compile (§17.7.1).
export function makeReplanRequester(
  submit: (raw: string) => void,
  setMask: (maskTiles?: Pos[]) => void,
): (rawText: string, maskTiles?: Pos[]) => void {
  return (rawText, maskTiles) => {
    setMask(maskTiles)
    submit(rawText)
  }
}

// Build a WorldSnapshot from the live belief base (§18.4). selfPos/parcels/partner are read here;
// zones come from the prebuilt grid. tnow must be passed explicitly because BeliefBase.lastTick
// is private — callers should pass snap.tick or the last observed tick.
export function snapshotFromBeliefs(bb: BeliefBase, zones: Pos[], tnow: number, maskTiles?: Pos[]): WorldSnapshot {
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
    maskTiles,
  }
}
