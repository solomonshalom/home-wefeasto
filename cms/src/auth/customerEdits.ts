import { createHash } from 'node:crypto'

import {
  APIError,
  type CollectionAfterReadHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type PayloadRequest,
} from 'payload'

import { userIsAdmin } from '../access/roles'

/**
 * A Save of a customer from a page opened before the row changed must not undo that change (hunt w5 r2).
 *
 * The admin form sends every field as it was loaded (name, phone, email, addresses, marketingOptIn and the
 * "Verified" checkbox), and Payload writes it over the live row. accountWrites.ts serialises writers, but the
 * form itself is stale: the owner opens a new customer's record, the customer clicks the link in their
 * verification email, the owner fixes a typo in the name and saves → `_verified: false` is written back and the
 * customer is refused at login; an address the customer saved meanwhile was deleted the same way.
 *
 * Three-way merge, per field, against what the page was loaded with:
 *   - every document an admin reads carries `editBase` (virtual, admin-only, hidden in the form): a short hash
 *     of each of those fields as read. The admin form sends it back with the Save;
 *   - beforeOperation (update by id, REST) notes the base and hashes what the request actually sent (the raw
 *     body: by beforeChange Payload has filled every field the request left out from the stored row);
 *   - beforeChange (the stored row is locked and current: accountWrites.ts): for each field sent,
 *       unchanged since the page loaded            → the submitted value stands (it is the admin's edit);
 *       changed since, and the page didn't touch it → the stored value stands (an echo of the old value);
 *       changed since, and the page changed it too  → the same value is fine; a different one is refused:
 *                                                    409 CUSTOMER_CHANGED on that field ("reload").
 * Requests without a base (the storefront's own profile save, scripts, bulk edit) are unchanged: they send only
 * what they change. Session bookkeeping (logins, failed attempts, reset tokens) is not compared, so it never
 * makes a Save stale.
 */

export const EDIT_BASE_FIELD = 'editBase'
export const CUSTOMER_EDIT_FIELDS = ['email', 'name', 'phone', 'addresses', 'marketingOptIn', '_verified'] as const
type EditField = (typeof CUSTOMER_EDIT_FIELDS)[number]
type Prints = Partial<Record<EditField, string>>

/** req.context key: customer id → { base, sent } fingerprints of the submitted form. */
const FORM = 'wfCustomerForm'

export const CUSTOMER_CHANGED = 'CUSTOMER_CHANGED'
export const CUSTOMER_WRITE_ERROR = 'CustomerWriteError'

/** 409: the page changed a field that was also changed after the page was loaded. Name is a literal (minified builds). */
export class CustomerWriteError extends APIError<{ code: typeof CUSTOMER_CHANGED; errors: { path: string; message: string }[] }> {
  constructor(fields: EditField[]) {
    const message =
      'This customer changed after you opened the page (they may have verified their email or updated their details). ' +
      'Reload the page to see the latest, then make your change again.'
    super(message, 409, { code: CUSTOMER_CHANGED, errors: fields.map((path) => ({ path, message })) }, true)
    this.name = CUSTOMER_WRITE_ERROR
  }
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** The comparable form of a field's value; undefined when it can't be compared (not sent in a known shape). */
function normalize(field: EditField, value: unknown): unknown {
  switch (field) {
    case 'email':
      return str(value).trim().toLowerCase()
    case 'name':
    case 'phone':
      return str(value)
    case 'marketingOptIn':
    case '_verified':
      return value === true
    case 'addresses': {
      // The admin form sends the rows, or 0 when there are none. A bare row count can't be compared.
      if (value === null || value === 0) return []
      if (!Array.isArray(value)) return undefined
      return value.map((row) => {
        const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
        return [str(r.label), str(r.line1), str(r.city), str(r.state), str(r.pin), r.isDefault === true]
      })
    }
  }
}

function print(field: EditField, value: unknown): string | undefined {
  const n = normalize(field, value)
  if (n === undefined) return undefined
  return createHash('sha256').update(`${field}\u0000${JSON.stringify(n)}`).digest('base64url').slice(0, 16)
}

/** Fingerprints of the edit fields present in `doc`. */
export function fingerprints(doc: Record<string, unknown>): Prints {
  const out: Prints = {}
  for (const f of CUSTOMER_EDIT_FIELDS) {
    if (!(f in doc)) continue
    const p = print(f, doc[f])
    if (p !== undefined) out[f] = p
  }
  return out
}

export const encodeEditBase = (doc: Record<string, unknown>): string => JSON.stringify(fingerprints(doc))

export function decodeEditBase(raw: unknown): Prints | null {
  if (typeof raw !== 'string' || raw.length > 1000) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Prints = {}
    for (const f of CUSTOMER_EDIT_FIELDS) {
      const v = (parsed as Record<string, unknown>)[f]
      if (typeof v === 'string' && v) out[f] = v
    }
    return out
  } catch {
    return null
  }
}

/** afterRead (collection): what an admin loads carries the base the Save will be compared against. */
export const addCustomerEditBase: CollectionAfterReadHook = ({ doc, req }) => {
  if (doc && typeof doc === 'object' && userIsAdmin(req.user)) (doc as Record<string, unknown>)[EDIT_BASE_FIELD] = encodeEditBase(doc)
  return doc
}

type FormNote = { base: Prints; sent: Prints }

function notes(req: PayloadRequest): Record<string, FormNote> {
  const ctx = (req.context ??= {}) as Record<string, unknown>
  const existing = ctx[FORM]
  if (existing && typeof existing === 'object') return existing as Record<string, FormNote>
  const created: Record<string, FormNote> = {}
  ctx[FORM] = created
  return created
}

/** beforeOperation: a REST update by id that carries a base → note it and what was actually sent. */
export const noteCustomerForm: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (operation !== 'update' || req.payloadAPI === 'local') return args
  const a = args as { id?: unknown; data?: unknown }
  if (a.id === undefined || a.id === null || !a.data || typeof a.data !== 'object') return args
  const data = a.data as Record<string, unknown>
  const base = decodeEditBase(data[EDIT_BASE_FIELD])
  if (!base) return args
  notes(req)[String(a.id)] = { base, sent: fingerprints(data) }
  return args
}

/** beforeChange: the three-way merge described above (originalDoc is the locked, current row). */
export const mergeStaleCustomerForm: CollectionBeforeChangeHook = ({ data, operation, originalDoc, req }) => {
  if (operation !== 'update' || !originalDoc || req.payloadAPI === 'local') return data
  const note = notes(req)[String(originalDoc.id)]
  if (!note) return data
  const live = fingerprints(originalDoc as Record<string, unknown>)
  const conflicts: EditField[] = []
  for (const f of CUSTOMER_EDIT_FIELDS) {
    const base = note.base[f]
    const sent = note.sent[f]
    if (base === undefined || sent === undefined || live[f] === base) continue
    if (sent === base) data[f] = (originalDoc as Record<string, unknown>)[f] ?? null
    else if (sent !== live[f]) conflicts.push(f)
  }
  if (conflicts.length) throw new CustomerWriteError(conflicts)
  return data
}
