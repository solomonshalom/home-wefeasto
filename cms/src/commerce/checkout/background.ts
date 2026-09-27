import type { Payload } from 'payload'

/**
 * Post-commit side effects (emails, order events, gateway refunds).
 *
 * Inside a Next request scope the work runs after the response via `after()` (Vercel `waitUntil`), so the
 * webhook answers Razorpay well under 5 s and verify/checkout are not slowed by SMTP. Outside a request
 * scope (tests, scripts, jobs) it runs inline before returning, which keeps tests deterministic.
 * Errors are logged, never thrown: every effect is re-driven by the reconcile job if it never completes
 * (unsent confirmations, queued refunds).
 *
 * `pendingEffects()` lets tests await work started by a hook without a request (see runAfterCommit).
 */

const PENDING_KEY = Symbol.for('wefeasto.checkout.pendingEffects')

function pendingSet(): Set<Promise<unknown>> {
  const g = globalThis as unknown as Record<symbol, Set<Promise<unknown>> | undefined>
  let s = g[PENDING_KEY]
  if (!s) {
    s = new Set()
    g[PENDING_KEY] = s
  }
  return s
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function runEffects(payload: Payload, label: string, task: () => Promise<unknown>): Promise<void> {
  const run = async () => {
    try {
      await task()
    } catch (err) {
      payload.logger.error({ msg: `${label} failed`, err: errMessage(err) })
    }
  }
  try {
    const mod = (await import('next/server')) as { after?: (task: () => Promise<unknown>) => void }
    if (typeof mod.after === 'function') {
      mod.after(run) // throws synchronously outside a request scope
      return
    }
  } catch {
    // No request scope: run inline below.
  }
  await run()
}

/**
 * Fire-and-forget for work that must wait for someone else's transaction (Orders hooks): tracked so tests
 * can `await flushPendingEffects()`. In a request scope it is also handed to `after()` so the platform
 * keeps the function alive until it finishes.
 */
export function detach(payload: Payload, label: string, task: () => Promise<unknown>): void {
  const set = pendingSet()
  const p: Promise<unknown> = (async () => {
    try {
      await task()
    } catch (err) {
      payload.logger.error({ msg: `${label} failed`, err: errMessage(err) })
    }
  })().finally(() => set.delete(p))
  set.add(p)
  void import('next/server')
    .then((mod: { after?: (t: () => Promise<unknown>) => void }) => {
      try {
        mod.after?.(() => p)
      } catch {
        // outside a request scope
      }
    })
    .catch(() => {})
}

/** Tests: resolves when every detached effect has finished (loops until none are left). */
export async function flushPendingEffects(): Promise<void> {
  const set = pendingSet()
  while (set.size) await Promise.allSettled([...set])
}
