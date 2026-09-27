import type { Payload } from 'payload'

import { errMessage } from './util'

/**
 * Runs `task` after the response when a Next request scope exists (Next `after()` = Vercel waitUntil),
 * otherwise (tests, scripts, jobs) awaits it before returning. Errors are logged, never thrown.
 *
 * Used so the newsletter endpoints answer in the same time whether or not an email goes out: response
 * timing can't reveal whether an address is already subscribed.
 */
export async function afterResponse(payload: Payload, label: string, task: () => Promise<unknown>): Promise<void> {
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
      payload.logger.debug({ msg: `${label}: deferred until after the response` })
      return
    }
  } catch {
    // No request scope: run inline below.
  }
  await run()
}
