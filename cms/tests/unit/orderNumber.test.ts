import { describe, expect, it } from 'vitest'

import { formatOrderNumber, ORDER_COUNTER_START, parseOrderNumber } from '@/commerce/orderNumber'

describe('order number format', () => {
  it('formats WF-<n> and starts at WF-10001', () => {
    expect(formatOrderNumber(ORDER_COUNTER_START + 1)).toBe('WF-10001')
    expect(formatOrderNumber(123456)).toBe('WF-123456')
  })

  it('parses only well-formed numbers', () => {
    expect(parseOrderNumber('WF-10001')).toBe(10001)
    expect(parseOrderNumber(' wf-10002 ')).toBe(10002)
    for (const bad of ['WF-1', 'WF-', '10001', 'WF-10001x', 'XX-10001', 'WF--10001', 'WF-1e5', '', null, undefined, 10001]) {
      expect(parseOrderNumber(bad as unknown)).toBeNull()
    }
  })

  it('round-trips', () => {
    for (const n of [10001, 10050, 99999, 100000, 2_000_000]) expect(parseOrderNumber(formatOrderNumber(n))).toBe(n)
  })
})
