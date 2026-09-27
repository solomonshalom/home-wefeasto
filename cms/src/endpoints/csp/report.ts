/**
 * Content-Security-Policy violation reports → one small, non-personal log record each.
 *
 * Browsers send two formats to the storefront's collector (vercel.json, report-only CSP):
 *   - `report-uri` (Firefox, Safari; Chromium without Reporting-Endpoints):
 *       Content-Type: application/csp-report   {"csp-report": {"document-uri", "blocked-uri", "effective-directive", …}}
 *   - `report-to` + `Reporting-Endpoints` (Chromium, HTTPS only):
 *       Content-Type: application/reports+json [{"type": "csp-violation", "body": {documentURL, blockedURL, effectiveDirective, …}}, …]
 *
 * Only what the owner needs to decide whether the policy can be enforced is kept: which directive, what was
 * blocked, on which page, from which script position. URLs keep origin + path only: the query and fragment are
 * dropped (/order?no=…&t=<guest token>, /login?verify=<token>, /reset-password?token=…), and so are user info,
 * the referrer, the user agent, the policy text and any script sample. Non-HTTP(S) URLs keep their scheme only
 * (data, blob, chrome-extension). Nothing is stored.
 */

export type CspDisposition = 'enforce' | 'report' | 'unknown'

export type CspViolation = {
  /** effective directive, e.g. script-src-elem */
  directive: string
  /** origin + path of what was blocked, a CSP keyword (inline, eval, …) or a bare scheme (data, blob) */
  blocked: string
  /** origin + path of the page */
  document: string
  /** origin + path of the script that triggered it, when the browser says */
  source?: string
  line?: number
  column?: number
  disposition: CspDisposition
  /** HTTP status of the page */
  status?: number
}

export type CspViolationGroup = CspViolation & { count: number }

const MAX_URL = 300
const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])

type Rec = Record<string, unknown>
const isRecord = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Keeps printable ASCII only (log hygiene), clipped. */
const clip = (s: string, max = MAX_URL): string => s.replace(/[^\x20-\x7e]/g, '').slice(0, max)

/** origin + path of a URL; a CSP keyword or scheme as-is; undefined for anything else. */
export function safeCspUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!v) return undefined
  // Keywords browsers put in blocked-uri / blockedURL: inline, eval, wasm-eval, self, data, blob, trusted-types-sink …
  if (/^[a-z][a-z-]{0,31}$/i.test(v)) return v.toLowerCase()
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return undefined
  }
  if (!WEB_SCHEMES.has(url.protocol)) return clip(url.protocol.slice(0, -1), 32) || undefined
  return clip(url.origin + url.pathname)
}

const directiveOf = (effective: unknown, violated: unknown): string => {
  for (const raw of [effective, violated]) {
    if (typeof raw !== 'string') continue
    const name = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    if (/^[a-z][a-z-]{0,39}$/.test(name)) return name
  }
  return 'unknown'
}

const intIn = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined

const dispositionOf = (v: unknown): CspDisposition => (v === 'enforce' || v === 'report' ? v : 'unknown')

function violation(fields: {
  effective: unknown
  violated?: unknown
  blocked: unknown
  document: unknown
  source: unknown
  line: unknown
  column: unknown
  disposition: unknown
  status: unknown
}): CspViolation {
  const out: CspViolation = {
    directive: directiveOf(fields.effective, fields.violated),
    blocked: safeCspUrl(fields.blocked) ?? 'unknown',
    document: safeCspUrl(fields.document) ?? 'unknown',
    disposition: dispositionOf(fields.disposition),
  }
  const source = safeCspUrl(fields.source)
  if (source) out.source = source
  const line = intIn(fields.line, 10_000_000)
  if (line !== undefined) out.line = line
  const column = intIn(fields.column, 10_000_000)
  if (column !== undefined) out.column = column
  const status = intIn(fields.status, 999)
  if (status !== undefined) out.status = status
  return out
}

/** `report-uri` body: {"csp-report": {…}} */
function fromLegacy(r: Rec): CspViolation {
  return violation({
    effective: r['effective-directive'],
    violated: r['violated-directive'],
    blocked: r['blocked-uri'],
    document: r['document-uri'],
    source: r['source-file'],
    line: r['line-number'],
    column: r['column-number'],
    disposition: r.disposition,
    status: r['status-code'],
  })
}

/** Reporting API `csp-violation` body. */
function fromReportingApi(b: Rec): CspViolation {
  return violation({
    effective: b.effectiveDirective,
    blocked: b.blockedURL,
    document: b.documentURL,
    source: b.sourceFile,
    line: b.lineNumber,
    column: b.columnNumber,
    disposition: b.disposition,
    status: b.statusCode,
  })
}

/**
 * The violations in a parsed report body (either format). `other` counts well-formed Reporting API reports of
 * another type (deprecation, intervention, …), which are ignored. Both empty: not a report at all.
 */
export function parseCspReports(body: unknown, { maxReports = 100 } = {}): { violations: CspViolation[]; other: number } {
  if (isRecord(body) && isRecord(body['csp-report'])) return { violations: [fromLegacy(body['csp-report'])], other: 0 }
  const list = Array.isArray(body) ? body : isRecord(body) && typeof body.type === 'string' ? [body] : []
  const violations: CspViolation[] = []
  let other = 0
  for (const item of list.slice(0, maxReports)) {
    if (!isRecord(item) || typeof item.type !== 'string') continue
    if (item.type === 'csp-violation' && isRecord(item.body)) violations.push(fromReportingApi(item.body))
    else other += 1
  }
  return { violations, other }
}

/** Identical violations (a batch often repeats one) become one record with a count, in first-seen order. */
export function groupViolations(violations: CspViolation[]): CspViolationGroup[] {
  const groups = new Map<string, CspViolationGroup>()
  for (const v of violations) {
    const key = JSON.stringify(v)
    const seen = groups.get(key)
    if (seen) seen.count += 1
    else groups.set(key, { ...v, count: 1 })
  }
  return [...groups.values()]
}
