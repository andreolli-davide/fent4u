// src/bdi/rate-tracker.ts
// Per-agent running average of OWN realised delivery rate (reward/tick), windowed.
// Feeds U_mission's rate ceiling (ρ_ref, §5.5) and §7.1's toll exchange rate (ū_forgone).
// Open-loop exception (§1): own pickups/putDowns are ground truth, so this is measurable at
// runtime even though mission payoffs are not. No replication — each agent tracks itself.

export class DeliveryRateTracker {
  private readonly samples: number[] = []
  private lastTick: number | null = null

  /**
   * @param window  max retained reward/tick samples (FIFO eviction)
   * @param bootstrap rate returned until at least one sample exists
   */
  constructor(private readonly window: number, private readonly bootstrap: number) {}

  /** Record a delivery of `reward` points at absolute tick `tnow`. */
  record(reward: number, tnow: number): void {
    if (this.lastTick !== null && tnow > this.lastTick) {
      this.samples.push(reward / (tnow - this.lastTick))
      while (this.samples.length > this.window) this.samples.shift()
    }
    this.lastTick = tnow
  }

  /** Mean reward/tick (ū_forgone, §7.1). Bootstrap until a sample exists. */
  uForgone(): number {
    if (this.samples.length === 0) return this.bootstrap
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length
  }

  /** 90th-percentile reward/tick (ρ_ref, §5.5). Bootstrap until a sample exists. */
  rhoRef(): number {
    if (this.samples.length === 0) return this.bootstrap
    const sorted = [...this.samples].sort((a, b) => a - b)
    // Nearest-rank 90th percentile (0-indexed): ceil(0.9·n) − 1, clamped to [0, n−1].
    const idx = Math.max(0, Math.ceil(0.9 * sorted.length) - 1)
    return sorted[idx]!
  }
}
