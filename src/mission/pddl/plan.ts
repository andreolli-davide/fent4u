// §17.6 — convert a solver plan into the shared AgentStep[] contract. We keep only pickup/deliver
// actions (in the planner's chosen ORDER) and drop the tile-by-tile `move`s: the shared push-aware A*
// (costPlan) re-routes between goto targets, so the plan supplies the ordering and A* supplies the
// real travel cost. Emits goto(parcelTile)→pickup and goto(zone)→deliver.
import type { AgentStep } from '../kinds.js'
import type { Pos } from '../../types/perception.js'

// One step as returned by the online solver (PddlOnlineSolver): action name + positional args.
export interface RawPlanStep { action: string; args: string[] }

// Parse a t{x}_{y} tile object back to a Pos (case-insensitive; the solver may upper-case).
function parseTile(name: string): Pos | null {
  const m = /^t(\d+)_(\d+)$/.exec(name.toLowerCase())
  return m === null ? null : { x: Number(m[1]), y: Number(m[2]) }
}

export function solverPlanToSteps(raw: RawPlanStep[], parcelById: Map<string, string>): AgentStep[] | null {
  const steps: AgentStep[] = []
  for (const s of raw) {
    const action = s.action.toLowerCase()
    const args = s.args.map((a) => a.toLowerCase())
    if (action === 'pickup') {
      const realId = parcelById.get(args[0])
      const pos = parseTile(args[1] ?? '')
      if (realId === undefined || pos === null) return null // grounding mismatch ⇒ reject the plan
      steps.push({ op: 'goto', target: pos }, { op: 'pickup', parcelId: realId })
    } else if (action === 'deliver') {
      const pos = parseTile(args[1] ?? '')
      if (pos === null) return null
      steps.push({ op: 'goto', target: pos }, { op: 'deliver', zone: pos })
    }
    // 'move' (and anything else) ignored — A* prices travel between goto targets.
  }
  return steps
}
