/**
 * A tiny in-process counting semaphore with a bounded, first-come-first-served wait.
 *
 *   const slots = new Slots(4)
 *   const release = await slots.acquire(5_000)   // null when no slot freed up in time
 *   try { … } finally { release?.() }
 *
 * Waiters hold nothing while they wait (no DB connection, no lock), which is the point: it caps how many
 * callers can be inside a section that pins a pool connection at once.
 */
export type Release = () => void

export class Slots {
  private active = 0
  private readonly waiters: Array<(release: Release) => void> = []

  constructor(readonly size: number) {}

  /** Slots in use right now (for tests / diagnostics). */
  get inUse(): number {
    return this.active
  }

  /** Callers waiting for a slot right now. */
  get waiting(): number {
    return this.waiters.length
  }

  /** Resolves with a release function, or null when no slot was free within `timeoutMs`. */
  acquire(timeoutMs: number): Promise<Release | null> {
    if (this.active < this.size) {
      this.active += 1
      return Promise.resolve(this.releaser())
    }
    return new Promise((resolve) => {
      const grant = (release: Release) => {
        clearTimeout(timer)
        resolve(release)
      }
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant)
        if (i >= 0) this.waiters.splice(i, 1)
        resolve(null)
      }, Math.max(0, timeoutMs))
      this.waiters.push(grant)
    })
  }

  /** A one-shot release: hands the slot straight to the next waiter, or frees it. */
  private releaser(): Release {
    let done = false
    return () => {
      if (done) return
      done = true
      const next = this.waiters.shift()
      if (next) next(this.releaser())
      else this.active -= 1
    }
  }
}
