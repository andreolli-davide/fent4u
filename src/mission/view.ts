// src/mission/view.ts
// Local read model of the active mission, as seen by ONE agent's BDI loop. The Liaison feeds it
// from its MissionSlot.onChange; the Courier (Phase 2) feeds it from the replicated a2a 'mission'
// message. The loop reads this — never the slot directly — so both agents share one code path.
// Shaper/toll/filter accessors are added in Phase 2; this phase needs only set/current.

import type { Mission } from './kinds.js'

export class TeamMissionView {
  private mission: Mission | null = null

  set(m: Mission | null): void { this.mission = m }
  current(): Mission | null { return this.mission }
}
