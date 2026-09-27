/**
 * Refill-reminder timing (roadmap S2). Pure functions, no clock reads: callers pass the dates.
 *
 *   runOutDays = clamp(min over items of (qty × daysPerPack) / eaters, 7, 45)
 *   remindAt   = IST calendar day of the payment + round(runOutDays × 0.75) − 2 days, at 10:00 IST
 *
 * All calendar maths is in Asia/Kolkata (UTC+05:30, no daylight saving, so a fixed offset is exact).
 * The earliest run-out in a mixed basket wins; a product without `daysPerPack` counts as 14 days; an
 * unanswered "Breakfast for how many?" counts as 2 eaters.
 */

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_EATERS = 2
export const MAX_EATERS = 20
export const DEFAULT_DAYS_PER_PACK = 14
export const MIN_RUN_OUT_DAYS = 7
export const MAX_RUN_OUT_DAYS = 45
/** Remind when three quarters of the supply is gone… */
export const REMIND_FRACTION = 0.75
/** …minus two days for delivery. */
export const DELIVERY_LEAD_DAYS = 2
export const REMIND_HOUR_IST = 10

export type RefillItem = {
  slug?: string | null
  qty?: number | null
  /** Days one person takes to finish one pack; null/invalid → DEFAULT_DAYS_PER_PACK. */
  daysPerPack?: number | null
}

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** Valid household size (1..20) or the default of 2. */
export function eatersOf(householdSize: unknown): number {
  return posInt(householdSize) && householdSize <= MAX_EATERS ? householdSize : DEFAULT_EATERS
}

/** A product's days-per-pack, or 14 when it is missing or nonsense. */
export function daysPerPackOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_DAYS_PER_PACK
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/**
 * Days until the first product in the basket runs out, clamped to 7..45.
 * Lines with a missing or non-positive quantity are ignored; `null` when no line is usable
 * (nothing to remind about).
 */
export function runOutDays(items: readonly RefillItem[] | null | undefined, householdSize?: unknown): number | null {
  const eaters = eatersOf(householdSize)
  let earliest = Infinity
  for (const item of items ?? []) {
    if (!item || !posInt(item.qty)) continue
    const days = (item.qty * daysPerPackOf(item.daysPerPack)) / eaters
    if (days < earliest) earliest = days
  }
  return Number.isFinite(earliest) ? clamp(earliest, MIN_RUN_OUT_DAYS, MAX_RUN_OUT_DAYS) : null
}

/** Whole days between the payment day and the reminder day: round(runOut × 0.75) − 2. */
export function reminderOffsetDays(runOut: number): number {
  return Math.round(runOut * REMIND_FRACTION) - DELIVERY_LEAD_DAYS
}

/** The Asia/Kolkata calendar date of an instant. Month is 0-based (like Date). */
export function istDate(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() }
}

/** The instant that is `hour`:`minute` IST on the given IST calendar date (day overflow is fine). */
export function atIst(year: number, month: number, day: number, hour = REMIND_HOUR_IST, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - IST_OFFSET_MS)
}

/** 10:00 IST, `offsetDays` IST calendar days after `base`. */
export function remindAtFrom(base: Date, offsetDays: number): Date {
  const { year, month, day } = istDate(base)
  return atIst(year, month, day + offsetDays)
}

export type RefillPlan = {
  eaters: number
  runOutDays: number
  offsetDays: number
  /** When to send the reminder (10:00 IST). */
  remindAt: Date
  /** When the earliest product is expected to run out (the same IST day + runOutDays, 10:00 IST). */
  runsOutAt: Date
}

/**
 * The whole plan for one order: `paidAt` (online) or the COD placement time as the base.
 * Returns null when the base date is invalid or no line is usable.
 */
export function planRefill(
  { paidAt, items, householdSize }: { paidAt: Date | string | number | null | undefined; items: readonly RefillItem[] | null | undefined; householdSize?: unknown },
): RefillPlan | null {
  if (paidAt === null || paidAt === undefined || paidAt === '') return null
  const base = paidAt instanceof Date ? paidAt : new Date(paidAt)
  if (!Number.isFinite(base.getTime())) return null
  const runOut = runOutDays(items, householdSize)
  if (runOut === null) return null
  const offsetDays = reminderOffsetDays(runOut)
  return {
    eaters: eatersOf(householdSize),
    runOutDays: runOut,
    offsetDays,
    remindAt: remindAtFrom(base, offsetDays),
    runsOutAt: remindAtFrom(base, Math.round(runOut)),
  }
}
