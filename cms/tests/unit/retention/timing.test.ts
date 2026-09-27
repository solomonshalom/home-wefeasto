import { afterEach, describe, expect, it } from 'vitest'

import {
  atIst,
  daysPerPackOf,
  eatersOf,
  istDate,
  planRefill,
  reminderOffsetDays,
  remindAtFrom,
  runOutDays,
  type RefillItem,
} from '@/retention/timing'

const oats = (qty: number, daysPerPack: number | null = 14): RefillItem => ({ slug: 'rolled-oats', qty, daysPerPack })

describe('eatersOf / daysPerPackOf', () => {
  it.each([
    [1, 1],
    [4, 4],
    [20, 20],
    [null, 2],
    [undefined, 2],
    [0, 2],
    [-1, 2],
    [21, 2],
    [2.5, 2],
    ['3', 2],
    [Number.NaN, 2],
  ])('eatersOf(%s) = %s', (input, expected) => {
    expect(eatersOf(input)).toBe(expected)
  })

  it.each([
    [14, 14],
    [30, 30],
    [7.5, 7.5],
    [null, 14],
    [undefined, 14],
    [0, 14],
    [-3, 14],
    [Number.NaN, 14],
    [Number.POSITIVE_INFINITY, 14],
    ['21', 14],
  ])('daysPerPackOf(%s) = %s', (input, expected) => {
    expect(daysPerPackOf(input)).toBe(expected)
  })
})

describe('runOutDays = clamp(min(qty × daysPerPack) / eaters, 7, 45)', () => {
  it.each<[string, RefillItem[], unknown, number | null]>([
    ['one pack, default 2 eaters → exactly the 7-day floor', [oats(1)], null, 7],
    ['two packs, 2 eaters', [oats(2)], null, 14],
    ['one pack, one eater', [oats(1)], 1, 14],
    ['one pack, three eaters (4.67) → clamped up to 7', [oats(1)], 3, 7],
    ['tiny pack, 4 eaters (0.75) → clamped up to 7', [oats(1, 3)], 4, 7],
    ['exactly 45 → 45', [oats(3, 15)], 1, 45],
    ['10 packs × 30 days, 1 eater (300) → clamped down to 45', [oats(10, 30)], 1, 45],
    ['just above the floor', [oats(1, 15)], 2, 7.5],
    ['missing daysPerPack counts as 14', [oats(2, null)], 2, 14],
    ['zero / negative daysPerPack count as 14', [oats(2, 0), { slug: 'muesli', qty: 2, daysPerPack: -5 }], 2, 14],
    ['mixed basket: the earliest run-out wins', [oats(4, 14), { slug: 'muesli', qty: 1, daysPerPack: 20 }], 2, 10],
    ['mixed basket: a missing daysPerPack can be the earliest', [oats(3, 10), { slug: 'muesli', qty: 1, daysPerPack: null }], 2, 7],
    ['mixed basket: order of lines does not matter', [{ slug: 'muesli', qty: 1, daysPerPack: 20 }, oats(4, 14)], 2, 10],
    ['bad quantities are ignored', [oats(0), oats(-1), { slug: 'x', qty: 2.5, daysPerPack: 14 }, oats(3)], 1, 42],
    ['invalid household size → 2 eaters', [oats(2)], 99, 14],
    ['no usable line → null', [oats(0)], 2, null],
    ['empty basket → null', [], 2, null],
  ])('%s', (_label, items, household, expected) => {
    expect(runOutDays(items, household)).toBe(expected)
  })

  it('null/undefined items → null', () => {
    expect(runOutDays(null)).toBeNull()
    expect(runOutDays(undefined, 2)).toBeNull()
  })
})

describe('reminderOffsetDays = round(runOut × 0.75) − 2', () => {
  it.each([
    [7, 3], // 5.25 → 5
    [7.5, 4], // 5.625 → 6
    [10, 6], // 7.5 → 8 (half rounds up)
    [14, 9], // 10.5 → 11
    [30, 21], // 22.5 → 23
    [45, 32], // 33.75 → 34
  ])('runOut %s → %s days after payment', (runOut, expected) => {
    expect(reminderOffsetDays(runOut)).toBe(expected)
  })
})

describe('IST calendar maths (UTC+05:30, no DST)', () => {
  it('istDate: the IST day flips at 18:30 UTC', () => {
    expect(istDate(new Date('2026-09-26T18:29:59.999Z'))).toEqual({ year: 2026, month: 8, day: 26 })
    expect(istDate(new Date('2026-09-26T18:30:00.000Z'))).toEqual({ year: 2026, month: 8, day: 27 })
    expect(istDate(new Date('2026-12-31T18:30:00.000Z'))).toEqual({ year: 2027, month: 0, day: 1 })
  })

  it('atIst: 10:00 IST is 04:30 UTC, with day/month/year overflow', () => {
    expect(atIst(2026, 8, 29).toISOString()).toBe('2026-09-29T04:30:00.000Z')
    expect(atIst(2026, 11, 33).toISOString()).toBe('2027-01-02T04:30:00.000Z')
    expect(atIst(2026, 0, 1, 0, 0).toISOString()).toBe('2025-12-31T18:30:00.000Z')
  })

  it.each([
    // [label, paidAt (UTC), offset days, expected remindAt (UTC)]
    ['10:00 IST payment', '2026-09-26T04:30:00.000Z', 3, '2026-09-29T04:30:00.000Z'],
    ['last instant of the IST day', '2026-09-26T18:29:59.999Z', 3, '2026-09-29T04:30:00.000Z'],
    ['first instant of the next IST day', '2026-09-26T18:30:00.000Z', 3, '2026-09-30T04:30:00.000Z'],
    ['UTC midnight is already 05:30 IST (same IST day)', '2026-09-27T00:00:00.000Z', 3, '2026-09-30T04:30:00.000Z'],
    ['paid late evening IST, reminder still 10:00 IST', '2026-09-26T17:00:00.000Z', 9, '2026-10-05T04:30:00.000Z'],
    ['across a year end', '2026-12-30T10:00:00.000Z', 3, '2027-01-02T04:30:00.000Z'],
    ['across a leap day', '2028-02-27T06:00:00.000Z', 3, '2028-03-01T04:30:00.000Z'],
    ['US DST start weekend makes no difference', '2026-03-08T12:00:00.000Z', 3, '2026-03-11T04:30:00.000Z'],
    ['EU DST end weekend makes no difference', '2026-10-25T01:00:00.000Z', 32, '2026-11-26T04:30:00.000Z'],
  ])('remindAtFrom: %s', (_label, paidAt, offset, expected) => {
    expect(remindAtFrom(new Date(paidAt), offset as number).toISOString()).toBe(expected)
  })
})

describe('planRefill', () => {
  const originalTz = process.env.TZ
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  it('computes the whole plan (default household, one pack)', () => {
    const plan = planRefill({ paidAt: '2026-09-26T04:30:00.000Z', items: [oats(1)], householdSize: null })
    expect(plan).toEqual({
      eaters: 2,
      runOutDays: 7,
      offsetDays: 3,
      remindAt: new Date('2026-09-29T04:30:00.000Z'),
      runsOutAt: new Date('2026-10-03T04:30:00.000Z'),
    })
  })

  it('a bigger household brings the reminder forward', () => {
    const two = planRefill({ paidAt: '2026-09-26T04:30:00.000Z', items: [oats(4)], householdSize: 2 })!
    const four = planRefill({ paidAt: '2026-09-26T04:30:00.000Z', items: [oats(4)], householdSize: 4 })!
    expect(two.runOutDays).toBe(28)
    expect(two.remindAt.toISOString()).toBe('2026-10-15T04:30:00.000Z') // +19
    expect(four.runOutDays).toBe(14)
    expect(four.remindAt.toISOString()).toBe('2026-10-05T04:30:00.000Z') // +9
    expect(four.remindAt.getTime()).toBeLessThan(two.remindAt.getTime())
  })

  it('clamp edges: 7-day floor → +3 days, 45-day ceiling → +32 days', () => {
    expect(planRefill({ paidAt: '2026-09-26T04:30:00.000Z', items: [oats(1, 1)], householdSize: 20 })!.offsetDays).toBe(3)
    expect(planRefill({ paidAt: '2026-09-26T04:30:00.000Z', items: [oats(10, 60)], householdSize: 1 })!.offsetDays).toBe(32)
  })

  it('accepts Date, ISO string and epoch ms; rejects missing/invalid dates', () => {
    const iso = '2026-09-26T04:30:00.000Z'
    const a = planRefill({ paidAt: iso, items: [oats(2)] })!
    expect(planRefill({ paidAt: new Date(iso), items: [oats(2)] })).toEqual(a)
    expect(planRefill({ paidAt: Date.parse(iso), items: [oats(2)] })).toEqual(a)
    expect(planRefill({ paidAt: null, items: [oats(2)] })).toBeNull()
    expect(planRefill({ paidAt: undefined, items: [oats(2)] })).toBeNull()
    expect(planRefill({ paidAt: '', items: [oats(2)] })).toBeNull()
    expect(planRefill({ paidAt: 'not a date', items: [oats(2)] })).toBeNull()
  })

  it('no usable items → null', () => {
    expect(planRefill({ paidAt: '2026-09-26T04:30:00.000Z', items: [] })).toBeNull()
  })

  it('does not depend on the server time zone', () => {
    const at = { paidAt: '2026-11-01T06:00:00.000Z', items: [oats(3), { slug: 'muesli', qty: 1, daysPerPack: 21 }], householdSize: 3 }
    process.env.TZ = 'UTC'
    const utc = planRefill(at)
    process.env.TZ = 'America/New_York'
    const ny = planRefill(at)
    process.env.TZ = 'Asia/Kolkata'
    const ist = planRefill(at)
    expect(ny).toEqual(utc)
    expect(ist).toEqual(utc)
    expect(utc!.remindAt.toISOString().endsWith('T04:30:00.000Z')).toBe(true)
  })
})
