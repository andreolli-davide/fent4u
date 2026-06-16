// The single active mission slot (DESIGN §4.3). Overwrite tears down the previous mission's
// installed effects — a stub this slice (no shapers/tolls/locks/contracts exist yet); #3/#5
// fill teardown without changing callers.

import type { Mission } from './kinds.js'

export class MissionSlot {
  private slot: Mission | null = null
  private gen = 0

  // onChange fires after every slot mutation with the new current() value — the seam the Liaison
  // uses to mirror the slot into its TeamMissionView (and, Phase 2, broadcast to the Courier).
  constructor(private readonly onChange?: (m: Mission | null) => void) {}

  install(m: Mission): void {
    if (this.slot) this.teardown(this.slot)
    this.slot = m
    this.gen++
    this.onChange?.(this.slot)
  }

  current(): Mission | null { return this.slot }

  supersede(): void {
    if (this.slot) {
      this.slot.status = 'SUPERSEDED'
      this.teardown(this.slot)
      this.slot = null
      this.gen++
      this.onChange?.(this.slot)
    }
  }

  epoch(): number { return this.gen }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private teardown(_m: Mission): void {
    // #3/#5: release reward shapers, A* tolls, MISSION parcel locks (§9.10), open contracts.
  }
}
