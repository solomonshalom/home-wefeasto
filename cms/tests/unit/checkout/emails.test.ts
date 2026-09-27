import { describe, expect, it } from 'vitest'

import type { Order } from '@/payload-types'
import {
  buyAgainUrl,
  confirmationVariant,
  orderUrl,
  refundReasonCopy,
  renderOrderConfirmation,
  renderOrderShipped,
  renderRefundNotice,
  whatsappUrl,
} from '@/email/orders/templates'

const ctx = { storefrontUrl: 'https://wefeasto.com', token: 'tok_EN-123', shippingPromiseText: 'Ships in 1–2 days · delivered in 3–7 days', supportWhatsappE164: '+919845262777' }

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 1,
    number: 'WF-10001',
    status: 'paid',
    paymentStatus: 'captured',
    fulfilmentStatus: 'unfulfilled',
    contact: { name: 'Asha Kumar', email: 'asha@example.com', phone: '+919845262777' },
    shippingAddress: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
    items: [
      { slug: 'muesli', name: 'Muesli', unitPaise: 25000, qty: 1, lineTotalPaise: 25000 },
      { slug: 'cornflakes', name: 'Cornflakes', unitPaise: 17500, qty: 1, lineTotalPaise: 17500 },
    ],
    subtotalPaise: 42500,
    discountPaise: 4200,
    deliveryPaise: 4900,
    codFeePaise: 0,
    totalPaise: 43200,
    currency: 'INR',
    coupon: { code: 'WELCOME10', discountPaise: 4200 },
    requestedMethod: 'upi',
    paymentMethod: 'online',
    stockState: 'committed',
    updatedAt: '',
    createdAt: '',
    ...overrides,
  } as Order
}

describe('links', () => {
  it('order, buy-again and WhatsApp links', () => {
    expect(orderUrl(ctx, 'WF-10001')).toBe('https://wefeasto.com/order?no=WF-10001&t=tok_EN-123')
    expect(buyAgainUrl(ctx.storefrontUrl, order())).toBe('https://wefeasto.com/cart?add=muesli%3A1%2Ccornflakes%3A1&src=email')
    expect(buyAgainUrl(ctx.storefrontUrl, order({ items: [] as never }))).toBeNull()
    expect(whatsappUrl('+919845262777', 'Hi & bye')).toBe('https://wa.me/919845262777?text=Hi%20%26%20bye')
    expect(whatsappUrl('', 'x')).toBeNull()
  })
})

describe('confirmation', () => {
  it('online: subject, receipt rows with discount and delivery, links, text part', () => {
    const e = renderOrderConfirmation(order(), ctx, 'online')
    expect(e.subject).toBe('Order WF-10001 confirmed — thank you!')
    expect(e.html).toContain('Discount (WELCOME10)')
    expect(e.html).toContain('−₹42')
    expect(e.html).toContain('₹49')
    expect(e.html).toContain('₹432')
    expect(e.html).toContain('https://wefeasto.com/order?no=WF-10001&amp;t=tok_EN-123')
    expect(e.html).toContain('https://wefeasto.com/cart?add=muesli%3A1%2Ccornflakes%3A1&amp;src=email')
    expect(e.html).toContain('https://wa.me/919845262777')
    expect(e.html).toContain('Ships in 1–2 days')
    expect(e.text).toContain("We've received your payment of ₹432 for order WF-10001.")
    expect(e.text).toContain('Muesli × 1 — ₹250')
    expect(e.text).toContain('View your order: https://wefeasto.com/order?no=WF-10001&t=tok_EN-123')
  })

  it('COD and late variants', () => {
    const cod = order({ paymentMethod: 'cod', requestedMethod: 'cod', status: 'cod_pending', codFeePaise: 1000, totalPaise: 44200, deliveryPaise: 0 })
    expect(confirmationVariant(cod)).toBe('cod')
    const e = renderOrderConfirmation(cod, ctx, confirmationVariant(cod))
    expect(e.subject).toBe('Order WF-10001 placed — pay on delivery')
    expect(e.text).toContain('Please keep ₹442 ready (cash or UPI)')
    expect(e.text).toContain('Cash on delivery fee: ₹10')
    expect(e.text).toContain('Delivery: Free')
    expect(confirmationVariant(order(), { late: true })).toBe('late')
    expect(renderOrderConfirmation(order(), ctx, 'late').subject).toBe('Good news — your payment for WF-10001 went through')
  })

  it('escapes customer-controlled text and drops the WhatsApp line when no number is set', () => {
    const evil = order({ contact: { name: '<img src=x onerror=alert(1)>', email: 'a@b.co', phone: '+919845262777' }, items: [{ slug: 'x', name: '<b>Oats</b>', unitPaise: 100, qty: 1, lineTotalPaise: 100 }] as never })
    const e = renderOrderConfirmation(evil, { ...ctx, supportWhatsappE164: '' }, 'online')
    expect(e.html).not.toContain('<img src=x')
    expect(e.html).not.toContain('<b>Oats</b>')
    expect(e.html).toContain('&lt;b&gt;Oats&lt;/b&gt;')
    expect(e.html).not.toContain('wa.me')
  })
})

describe('shipped and refund', () => {
  it('shipped mentions the COD amount only for COD orders', () => {
    expect(renderOrderShipped(order(), ctx).subject).toBe('Your order WF-10001 is on its way')
    expect(renderOrderShipped(order(), ctx).text).not.toContain('ready')
    expect(renderOrderShipped(order({ paymentMethod: 'cod' }), ctx).text).toContain('Please keep ₹432 ready')
  })

  it('PI-ORD-2: shipped carries the receipt, promise, delivery address, View your order, Buy these again and WhatsApp', () => {
    const e = renderOrderShipped(order(), ctx)
    for (const part of [e.html, e.text]) {
      expect(part).toContain('Ships in 1–2 days · delivered in 3–7 days')
      expect(part).toContain('Delivering to: Flat 4B, 12 MG Road, Bengaluru, Karnataka 560001')
      expect(part).toContain('Buy these again')
      expect(part).toContain('https://wa.me/919845262777')
    }
    expect(e.html).toContain('Discount (WELCOME10)')
    expect(e.html).toContain('https://wefeasto.com/order?no=WF-10001&amp;t=tok_EN-123')
    expect(e.html).toContain('https://wefeasto.com/cart?add=muesli%3A1%2Ccornflakes%3A1&amp;src=email')
    expect(e.text).toContain('Muesli × 1 — ₹250')
    expect(e.text).toContain('Total: ₹432')
    expect(e.text).toContain('Buy these again: https://wefeasto.com/cart?add=muesli%3A1%2Ccornflakes%3A1&src=email')
    expect(e.text).toContain('View your order: https://wefeasto.com/order?no=WF-10001&t=tok_EN-123')
    // Promise left out when empty; no Buy again without items; address is escaped.
    const bare = renderOrderShipped(
      order({ items: [] as never, shippingAddress: { line1: '<b>9</b> & Co', city: 'Pune', state: 'Maharashtra', pin: '411001' } }),
      { ...ctx, shippingPromiseText: '  ', supportWhatsappE164: '' },
    )
    expect(bare.text).not.toContain('Ships in')
    expect(bare.text).not.toContain('Buy these again')
    expect(bare.html).not.toContain('wa.me')
    expect(bare.html).not.toContain('<b>9</b>')
    expect(bare.html).toContain('Delivering to: &lt;b&gt;9&lt;/b&gt; &amp; Co, Pune, Maharashtra 411001')
  })

  it('refund notice stays narrow: no promise, address or Buy these again (checkout-backend.md §5)', () => {
    const e = renderRefundNotice(order(), ctx, { amountPaise: 43200, reason: 'order_cancelled' })
    expect(e.text).not.toContain('Ships in')
    expect(e.text).not.toContain('Delivering to')
    expect(e.text).not.toContain('Buy these again')
    expect(e.text).toContain('View your order: https://wefeasto.com/order?no=WF-10001&t=tok_EN-123')
  })

  it('refund notice copy per reason', () => {
    const e = renderRefundNotice(order(), ctx, { amountPaise: 43200, reason: 'duplicate_payment' })
    expect(e.subject).toBe("We've refunded ₹432 for order WF-10001")
    expect(e.text).toContain('paid twice')
    expect(e.text).toContain('5–7 working days')
    expect(refundReasonCopy('out_of_stock', 'WF-1')).toContain('sold out')
    expect(refundReasonCopy('order_cancelled', 'WF-1')).toContain('cancelled')
    expect(refundReasonCopy('whatever', 'WF-1')).toBe("We've refunded a payment for order WF-1.")
  })
})
