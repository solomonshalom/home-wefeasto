import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, GlobalAfterChangeHook } from 'payload'

import { publicSettings } from '../commerce/shared/settings.js'
import { getEnv } from '../env'

/**
 * Storefront rebuild trigger (SPEC §4 "Hooks"). The storefront is prerendered from the catalog snapshot,
 * so a published product/recipe/page change or a public settings change must rebuild it: POST to the
 * Vercel Deploy Hook in VERCEL_DEPLOY_HOOK_URL (no-op when unset).
 *
 * - Trailing debounce (default 10 s, DEPLOY_HOOK_DEBOUNCE_MS overrides): an editor saving six products in
 *   a row causes one rebuild, 10 s after the last save.
 * - In memory, per server instance. On serverless hosts the pending POST is kept alive with Next's
 *   `after()` (Vercel `waitUntil`) when a request scope exists; outside one (seed, scripts, tests) the
 *   timer is unref'd and callers can `flush()`.
 * - Never throws into the request: every failure is logged and swallowed.
 * - Skipped for edits that cannot change the published site (never-published drafts, and pages that are
 *   not shown on the storefront) and whenever the operation passes `context: { skipDeployHook: true }`
 *   (the seed does, then triggers once itself).
 */

export const DEFAULT_DEPLOY_HOOK_DELAY_MS = 10_000
const REQUEST_TIMEOUT_MS = 10_000

type Log = { info?: (msg: string) => void; warn: (msg: string) => void }
type FetchLike = (url: string, init: { method: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>

export type DeployHookOptions = {
  /** Deploy hook URL, read at schedule AND fire time. Default: getEnv().vercelDeployHookUrl. */
  url?: () => string | undefined | null
  /** Debounce in ms. Default: DEPLOY_HOOK_DEBOUNCE_MS or 10 s. */
  delayMs?: () => number
  fetch?: FetchLike
  logger?: () => Log
  /** Keeps a serverless invocation alive until `promise` settles (Next `after`). Best effort. */
  keepAlive?: (promise: Promise<void>) => void
}

export type DeployHook = {
  /** Schedule a POST `delayMs` after the last call. Returns false when no URL is configured. Never throws. */
  schedule: (reason: string) => boolean
  /** Cancel the timer and POST now if something is pending (or `force`). Resolves when done. Never rejects. */
  flush: (opts?: { force?: boolean; reason?: string }) => Promise<boolean>
  /** Drop a pending POST. */
  cancel: () => void
  isPending: () => boolean
  /** Resolves once nothing is scheduled or in flight. */
  whenIdle: () => Promise<void>
}

const envDelay = (): number => {
  const raw = Number(process.env.DEPLOY_HOOK_DEBOUNCE_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEPLOY_HOOK_DELAY_MS
}

const consoleLog: Log = {
  info: (msg) => console.info(msg),
  warn: (msg) => console.warn(msg),
}

let payloadLogger: Log | null = null

/** Best effort: Next's after() only works inside a request scope; anywhere else it throws. */
async function nextAfter(promise: Promise<void>): Promise<void> {
  try {
    const mod = (await import('next/server')) as { after?: (task: Promise<unknown>) => void }
    mod.after?.(promise)
  } catch {
    // Outside a request (seed, tests, jobs): the unref'd timer + flush() cover it.
  }
}

export function createDeployHook(opts: DeployHookOptions = {}): DeployHook {
  const getUrl = opts.url ?? (() => getEnv().vercelDeployHookUrl)
  const getDelay = opts.delayMs ?? envDelay
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  const log = (): Log => opts.logger?.() ?? payloadLogger ?? consoleLog

  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null
  let reasons = new Set<string>()
  let waiters: Array<() => void> = []

  const settleIfIdle = () => {
    if (timer || inflight) return
    const w = waiters
    waiters = []
    for (const resolve of w) resolve()
  }

  const whenIdle = () =>
    timer || inflight ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()

  async function post(why: string[]): Promise<boolean> {
    let url: string | undefined | null
    try {
      url = getUrl()
    } catch {
      url = null
    }
    if (!url) return false
    const label = why.length ? why.join(', ') : 'manual'
    try {
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined
      const res = await doFetch(url, { method: 'POST', signal })
      if (!res.ok) {
        log().warn(`deploy hook: POST returned HTTP ${res.status} (${label})`)
        return false
      }
      log().info?.(`deploy hook: storefront rebuild requested (${label})`)
      return true
    } catch (err) {
      log().warn(`deploy hook: POST failed (${label}): ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  function fire(): Promise<boolean> {
    timer = null
    const why = [...reasons]
    reasons = new Set()
    const run = (inflight ?? Promise.resolve()).then(() => post(why))
    const done = run.then(
      () => undefined,
      () => undefined,
    )
    inflight = done
    void done.then(() => {
      if (inflight === done) inflight = null
      settleIfIdle()
    })
    return run.catch(() => false)
  }

  function schedule(reason: string): boolean {
    try {
      if (!getUrl()) return false
      reasons.add(reason)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void fire(), getDelay())
      ;(timer as { unref?: () => void }).unref?.()
      if (opts.keepAlive) {
        try {
          opts.keepAlive(whenIdle())
        } catch {
          /* best effort */
        }
      }
      return true
    } catch (err) {
      try {
        log().warn(`deploy hook: could not schedule (${reason}): ${err instanceof Error ? err.message : String(err)}`)
      } catch {
        /* never throw into the request */
      }
      return false
    }
  }

  async function flush({ force = false, reason = 'manual' }: { force?: boolean; reason?: string } = {}): Promise<boolean> {
    try {
      if (!timer && !force) {
        if (inflight) await inflight
        return false
      }
      if (timer) clearTimeout(timer)
      if (force) reasons.add(reason)
      return await fire()
    } catch {
      return false
    }
  }

  function cancel() {
    if (timer) clearTimeout(timer)
    timer = null
    reasons = new Set()
    settleIfIdle()
  }

  return { schedule, flush, cancel, isPending: () => Boolean(timer || inflight), whenIdle }
}

/** The process-wide debouncer used by the collection and global hooks. */
export const deployHook = createDeployHook({ keepAlive: (p) => void nextAfter(p) })

/* ------------------------------------------------------------------ hooks */

type Ctx = { skipDeployHook?: boolean } | undefined
const skipped = (context: unknown) => Boolean((context as Ctx)?.skipDeployHook)
const status = (doc: unknown) => (doc as { _status?: string } | null | undefined)?._status
const slugOf = (doc: unknown) => (doc as { slug?: string } | null | undefined)?.slug ?? '?'

const remember = (logger: unknown) => {
  if (logger && typeof (logger as Log).warn === 'function') payloadLogger = logger as Log
}

/**
 * Whether the doc can be on the storefront: Payload-published, and for pages also "Show on the storefront"
 * ticked (only those pages enter the snapshot — reviewing a policy draft must not rebuild the site).
 */
const onSite = (collection: string, doc: unknown) =>
  status(doc) === 'published' && (collection !== 'pages' || (doc as { published?: unknown } | null | undefined)?.published === true)

/**
 * products / recipes / pages afterChange. A change can alter the published site when the doc is (or
 * was) on it; edits to a never-published draft, or to a page the storefront does not show, cannot.
 */
export const deployHookAfterChange: CollectionAfterChangeHook = ({ doc, previousDoc, collection, operation, req, context }) => {
  try {
    if (skipped(context)) return doc
    if (!onSite(collection.slug, doc) && !onSite(collection.slug, previousDoc)) return doc
    remember(req?.payload?.logger)
    deployHook.schedule(`${collection.slug}:${slugOf(doc)} ${operation}`)
  } catch {
    /* never throw into the request */
  }
  return doc
}

/** products / recipes / pages afterDelete: only a doc that was on the site disappearing changes it. */
export const deployHookAfterDelete: CollectionAfterDeleteHook = ({ doc, collection, req, context }) => {
  try {
    if (skipped(context) || !onSite(collection.slug, doc)) return doc
    remember(req?.payload?.logger)
    deployHook.schedule(`${collection.slug}:${slugOf(doc)} delete`)
  } catch {
    /* never throw into the request */
  }
  return doc
}

/** store-settings afterChange: rebuild only when a PUBLIC setting changed (server-only keys are not on the site). */
export const deployHookGlobalAfterChange: GlobalAfterChangeHook = ({ doc, previousDoc, global, req, context }) => {
  try {
    if (skipped(context)) return doc
    if (JSON.stringify(publicSettings(doc)) === JSON.stringify(publicSettings(previousDoc))) return doc
    remember(req?.payload?.logger)
    deployHook.schedule(`${global.slug} update`)
  } catch {
    /* never throw into the request */
  }
  return doc
}
