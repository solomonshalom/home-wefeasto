import type { Payload } from 'payload'

/**
 * Expected refusals log at info, without a stack — in the production build too.
 *
 * Payload's route handler logs every error through logError({ err, payload }), which picks the level from
 * `config.loggingLevels[err.name]` and falls back to 'error' + the whole err (stack included). Its defaults
 * ({ Forbidden, Locked, MissingFile, NotFound, ValidationError: 'info' }) are keyed by class NAME, and
 * APIError sets `name = this.constructor.name`: `next build` minifies the class names ("u", "A", …), so on
 * `next start` every guest 403, taken-email signup 400, unverified login, … would be an ERROR line with a
 * stack, which any visitor could repeat at will (and which drowns real errors / trips ERROR alerting).
 *
 * So the decision is made by SHAPE, not name: an APIError (isOperational) with a 4xx status is a refusal
 * the client caused, and logError's `{ err }`-only error call for it is re-issued at info with the message
 * only (exactly what logError itself does for an 'info' level). Everything else — 5xx, plain Errors, and
 * our own `logger.error({ err, msg })` calls, which carry more than `err` — is logged untouched.
 */

type ErrLike = { message?: unknown; status?: unknown; isOperational?: unknown }
type LogFn = (obj: unknown, ...rest: unknown[]) => void
type QuietableLogger = { error: LogFn; info: LogFn; [QUIETED]?: true }

const QUIETED = Symbol.for('wefeasto.quietExpectedRefusals')

/** A client-caused refusal: an APIError-shaped error (isOperational) with a 4xx status. */
export function isExpectedRefusal(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { status, isOperational } = err as ErrLike
  return isOperational === true && typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500
}

/** logError's error-level call: exactly `{ err }` and nothing else. */
function refusalLogged(obj: unknown, rest: unknown[]): obj is { err: ErrLike } {
  if (rest.length > 0 || !obj || typeof obj !== 'object') return false
  const keys = Object.keys(obj)
  return keys.length === 1 && keys[0] === 'err' && isExpectedRefusal((obj as { err: unknown }).err)
}

/** Installs the downgrade on this Payload instance's logger (idempotent). Called from onInit. */
export function quietExpectedRefusals(payload: Pick<Payload, 'logger'>): void {
  const logger = payload.logger as unknown as QuietableLogger
  if (!logger || typeof logger.error !== 'function' || logger[QUIETED]) return
  const error = logger.error
  logger.error = function quietRefusals(this: unknown, obj: unknown, ...rest: unknown[]) {
    if (refusalLogged(obj, rest)) {
      const { message } = obj.err
      return logger.info({ msg: typeof message === 'string' && message ? message : 'Error' })
    }
    return error.call(logger, obj, ...rest)
  }
  logger[QUIETED] = true
}
