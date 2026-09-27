import type { Order } from '@/payload-types'

import { canRetryPayment, isConfirmed } from '../shared/order-status.js'
import { firstName, maskEmail, maskPhone } from '../shared/validate.js'

/**
 * OrderStatusDTO (SPEC §6): what /order, the pending banner and /account may know about an order.
 * No address beyond city/state, no full email or phone, no payment ids, no token (except for the signed-in
 * owner's list, which needs it to link to /order).
 */
export type OrderStatusDTO = {
  number: string
  status: Order['status']
  paymentStatus: Order['paymentStatus']
  paymentMethod: Order['paymentMethod']
  requestedMethod: Order['requestedMethod']
  fulfilmentStatus: Order['fulfilmentStatus']
  createdAt: string
  paidAt: string | null
  items: { slug: string; name: string; qty: number; unitPaise: number; lineTotalPaise: number; image: string | null }[]
  subtotalPaise: number
  discountPaise: number
  deliveryPaise: number
  codFeePaise: number
  totalPaise: number
  currency: string
  coupon: { code: string; discountPaise: number } | null
  contact: { firstName: string; emailMasked: string; phoneMasked: string }
  address: { city: string; state: string }
  canRetryPayment: boolean
  isConfirmed: boolean
  shippingPromiseText: string
  householdSize: number | null
  token?: string
}

export function toOrderStatusDTO(
  order: Order,
  opts: { shippingPromiseText?: string; token?: string } = {},
): OrderStatusDTO {
  const code = order.coupon?.code
  return {
    number: order.number,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    requestedMethod: order.requestedMethod,
    fulfilmentStatus: order.fulfilmentStatus,
    createdAt: order.createdAt,
    paidAt: order.paidAt ?? null,
    items: (order.items ?? []).map((it) => ({
      slug: it.slug,
      name: it.name,
      qty: it.qty,
      unitPaise: it.unitPaise,
      lineTotalPaise: it.lineTotalPaise,
      image: it.image ?? null,
    })),
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    deliveryPaise: order.deliveryPaise,
    codFeePaise: order.codFeePaise,
    totalPaise: order.totalPaise,
    currency: order.currency,
    coupon: code ? { code, discountPaise: order.coupon?.discountPaise ?? order.discountPaise } : null,
    contact: {
      firstName: firstName(order.contact?.name ?? ''),
      emailMasked: maskEmail(order.contact?.email ?? ''),
      phoneMasked: maskPhone(order.contact?.phone ?? ''),
    },
    address: { city: order.shippingAddress?.city ?? '', state: order.shippingAddress?.state ?? '' },
    canRetryPayment: canRetryPayment(order as Parameters<typeof canRetryPayment>[0]),
    isConfirmed: isConfirmed(order.status),
    shippingPromiseText: opts.shippingPromiseText ?? '',
    householdSize: order.householdSize ?? null,
    ...(opts.token ? { token: opts.token } : {}),
  }
}
