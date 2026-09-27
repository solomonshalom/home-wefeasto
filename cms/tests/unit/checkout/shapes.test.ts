import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Order } from '@/payload-types'
import { toOrderStatusDTO } from '@/commerce/checkout/dto'
import { buildPaymentInit, callbackUrlFor } from '@/commerce/checkout/paymentInit'
import { appendReason, razorpayGroup, upsertPaymentLog, withAttemptStatus } from '@/commerce/checkout/orderWrite'
import { queueRefund } from '@/commerce/checkout/refunds'
import { redactEvent } from '@/commerce/checkout/webhook'
import { MockGateway } from '@/payments/mock'
import { parseWebhookBody } from '@/payments/webhookPayload'

const ENV_KEYS = ['PAYLOAD_PUBLIC_SERVER_URL', 'STOREFRONT_URL'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.wefeasto.com'
  process.env.STOREFRONT_URL = 'https://wefeasto.com'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 42,
    number: 'WF-10042',
    status: 'pending_payment',
    paymentStatus: 'created',
    fulfilmentStatus: 'unfulfilled',
    contact: { name: 'Asha Kumar', email: 'Asha.K@Gmail.com', phone: '+919845262777' },
    shippingAddress: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
    items: [{ slug: 'muesli', name: 'Muesli', unitPaise: 25000, qty: 2, lineTotalPaise: 50000, image: '/images/m.jpg', product: 7 }],
    subtotalPaise: 50000,
    discountPaise: 5000,
    deliveryPaise: 0,
    codFeePaise: 0,
    totalPaise: 45000,
    currency: 'INR',
    coupon: { code: 'WELCOME10', discountPaise: 5000 },
    requestedMethod: 'upi',
    paymentMethod: 'online',
    stockState: 'reserved',
    razorpay: { attempts: [{ orderId: 'order_Mock00000000000001', receipt: 'WF-10042-a1', amount: 45000, status: 'created' }] },
    tokenNonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    updatedAt: '2026-09-26T00:00:00.000Z',
    createdAt: '2026-09-26T00:00:00.000Z',
    ...overrides,
  } as Order
}

describe('toOrderStatusDTO', () => {
  it('masks contact details and exposes only the SPEC §6 fields', () => {
    const dto = toOrderStatusDTO(order(), { shippingPromiseText: 'Ships in 1–2 days' })
    expect(dto).toEqual({
      number: 'WF-10042',
      status: 'pending_payment',
      paymentStatus: 'created',
      paymentMethod: 'online',
      requestedMethod: 'upi',
      fulfilmentStatus: 'unfulfilled',
      createdAt: '2026-09-26T00:00:00.000Z',
      paidAt: null,
      items: [{ slug: 'muesli', name: 'Muesli', qty: 2, unitPaise: 25000, lineTotalPaise: 50000, image: '/images/m.jpg' }],
      subtotalPaise: 50000,
      discountPaise: 5000,
      deliveryPaise: 0,
      codFeePaise: 0,
      totalPaise: 45000,
      currency: 'INR',
      coupon: { code: 'WELCOME10', discountPaise: 5000 },
      contact: { firstName: 'Asha', emailMasked: 'a•••@gmail.com', phoneMasked: '+91 ••••• ••777' },
      address: { city: 'Bengaluru', state: 'Karnataka' },
      canRetryPayment: true,
      isConfirmed: false,
      shippingPromiseText: 'Ships in 1–2 days',
      householdSize: null,
    })
    const text = JSON.stringify(dto)
    for (const s of ['Flat 4B', '560001', 'Gmail.com', '9845262777', 'AAAA', 'order_Mock']) expect(text).not.toContain(s)
  })

  it('token only when asked (the signed-in owner\'s list); flags follow the shared rules', () => {
    expect(toOrderStatusDTO(order(), { token: 'tok' }).token).toBe('tok')
    expect(toOrderStatusDTO(order({ status: 'paid', paymentStatus: 'captured' }))).toMatchObject({ isConfirmed: true, canRetryPayment: false })
    expect(toOrderStatusDTO(order({ status: 'cod_pending', paymentMethod: 'cod', requestedMethod: 'cod' }))).toMatchObject({ isConfirmed: true, canRetryPayment: false })
    expect(toOrderStatusDTO(order({ status: 'expired' }))).toMatchObject({ isConfirmed: false, canRetryPayment: true })
    expect(toOrderStatusDTO(order({ coupon: { code: null, discountPaise: null } })).coupon).toBeNull()
  })
})

describe('PaymentInit', () => {
  it('carries everything checkout.js needs, amounts from the attempt, ids-only notes', () => {
    const gateway = new MockGateway({ runId: 'UNIT01' })
    const o = order()
    const init = buildPaymentInit({ gateway, order: o, attempt: o.razorpay!.attempts![0], token: 'tok-en_1' })
    expect(init).toEqual({
      provider: 'mock',
      keyId: gateway.keyId,
      razorpayOrderId: 'order_Mock00000000000001',
      amount: 45000,
      currency: 'INR',
      checkoutScript: '/api/payments/mock/checkout.js',
      callbackUrl: 'https://cms.wefeasto.com/api/payments/razorpay/callback?no=WF-10042&t=tok-en_1',
      name: 'Wefeasto',
      description: 'Order WF-10042',
      image: 'https://wefeasto.com/images/webclip.png',
      prefill: { name: 'Asha Kumar', email: 'Asha.K@Gmail.com', contact: '+919845262777', method: 'upi' },
      notes: { wf_order: 'WF-10042' },
      timeoutSeconds: 900,
    })
    expect(buildPaymentInit({ gateway, order: order({ requestedMethod: 'cod' }), attempt: o.razorpay!.attempts![0], token: 't' }).prefill.method).toBeUndefined()
  })

  it('callbackUrl encodes the token', () => {
    expect(callbackUrlFor('WF-1', 'a+b/c=', 'https://x')).toBe('https://x/api/payments/razorpay/callback?no=WF-1&t=a%2Bb%2Fc%3D')
  })
})

describe('payment log, attempts, reasons', () => {
  const pay = (status: string, extra: Record<string, unknown> = {}) =>
    ({ id: 'pay_A', order_id: 'order_1', status, method: 'upi', amount: 100, ...extra }) as never

  it('upsertPaymentLog adds, upgrades, and never regresses a payment\'s status', () => {
    const a = upsertPaymentLog({ razorpay: {} }, pay('failed', { error_reason: 'card_declined' }), 'webhook')
    expect(a).toMatchObject({ isNew: true, changed: true })
    expect(a.log[0]).toMatchObject({ paymentId: 'pay_A', status: 'failed', errorReason: 'card_declined', via: 'webhook' })
    const same = upsertPaymentLog({ razorpay: { payments: a.log } }, pay('failed'), 'reconcile')
    expect(same.changed).toBe(false)
    const up = upsertPaymentLog({ razorpay: { payments: a.log } }, pay('captured'), 'webhook')
    expect(up).toMatchObject({ isNew: false, changed: true })
    expect(up.log[0]).toMatchObject({ status: 'captured', errorReason: 'card_declined' })
    const down = upsertPaymentLog({ razorpay: { payments: up.log } }, pay('authorized'), 'webhook')
    expect(down.changed).toBe(false)
    expect(down.log[0].status).toBe('captured')
  })

  it('upsertPaymentLog keeps at most 50 entries', () => {
    let log: never[] = []
    for (let i = 0; i < 60; i++) log = upsertPaymentLog({ razorpay: { payments: log } }, { ...(pay('failed') as object), id: `pay_${i}` } as never, 'x').log as never[]
    expect(log).toHaveLength(50)
  })

  it('withAttemptStatus never downgrades a paid attempt; razorpayGroup keeps every sibling field', () => {
    const o = { razorpay: { attempts: [{ orderId: 'order_1', receipt: 'r1', amount: 1, status: 'paid' }, { orderId: 'order_2', receipt: 'r2', amount: 1, status: 'created' }] } }
    expect(withAttemptStatus(o, 'order_1', 'attempted')[0].status).toBe('paid')
    expect(withAttemptStatus(o, 'order_2', 'attempted')[1].status).toBe('attempted')
    expect(razorpayGroup({ razorpay: { paymentId: 'pay_1' } }, { method: 'upi' })).toEqual({ attempts: [], paymentId: 'pay_1', method: 'upi', capturedAt: null, payments: [] })
  })

  it('appendReason stamps lines and caps the text', () => {
    const one = appendReason(null, 'first')
    expect(one).toMatch(/^\[\d{4}-\d\d-\d\d \d\d:\d\dZ\] first$/)
    expect(appendReason(one, 'second').split('\n')).toHaveLength(2)
    expect(appendReason('x'.repeat(5000), 'tail').length).toBeLessThanOrEqual(4000)
  })

  it('queueRefund queues once per payment', () => {
    const r = { paymentId: 'pay_B', amountPaise: 100, receipt: 'WF-1-dup-abc', reason: 'duplicate_payment' as const }
    const a = queueRefund({ refunds: [] }, r)
    expect(a.added).toBe(true)
    expect(a.refunds[0]).toMatchObject({ status: 'queued', attempts: 0, receipt: 'WF-1-dup-abc' })
    expect(queueRefund({ refunds: a.refunds }, r).added).toBe(false)
    expect(queueRefund({ refunds: a.refunds }, { ...r, receipt: 'WF-1-cxl-abc' }).added).toBe(false)
    expect(queueRefund({ refunds: [{ ...a.refunds[0], status: 'failed' }] }, { ...r, receipt: 'WF-1-cxl-abc' }).added).toBe(true)
  })
})

describe('redactEvent', () => {
  it('keeps ids, statuses and amounts; drops email, phone, vpa and card details', async () => {
    const m = new MockGateway({ runId: 'UNIT02' })
    const o = await m.createOrder({ amountPaise: 47400, receipt: 'WF-10001-a1', notes: { wf_order: 'WF-10001' } })
    const r = await m.simulatePayment(o.id, { outcome: 'success', method: 'card', email: 'asha@example.com', contact: '+919845262777' })
    const built = m.buildWebhook(r.events[2].event, r.events[2].entities)
    const parsed = parseWebhookBody(built.body)!
    const red = redactEvent(parsed, JSON.parse(built.body))
    expect(red).toMatchObject({ event: 'order.paid', payment: { id: r.payment.id, status: 'captured', amount: 47400, notes: { wf_order: 'WF-10001' } }, order: { id: o.id, receipt: 'WF-10001-a1' } })
    const text = JSON.stringify(red)
    for (const pii of ['asha@example.com', '9845262777', '1111', 'okhdfcbank']) expect(text).not.toContain(pii)
  })
})
