/*
 * HUNT data-cms (wave 5, round 2): a paid order refunded in full BEFORE it ships never gives its stock back.
 *
 * "Cancel is for orders without captured money; paid orders are refunded instead" (order-status.js). So when a
 * customer who paid online asks to cancel, the owner refunds the payment (Razorpay Dashboard → Issue Refund, per
 * docs/RAZORPAY-TEST-MODE.md check 8, or the order's Status → refunded in /admin). The order becomes `refunded`
 * (terminal: it can't be cancelled afterwards) and can no longer be packed or shipped (R3-3 guard), but its
 * stockState stays `committed`: the packs that never left the shelf are gone from the shop's stock for good.
 * Only an admin *cancel* gives unshipped stock back (orderHooks.ts), and a paid order can't be cancelled.
 * The product shows fewer packs (eventually "Sold out") while they sit in the warehouse; nothing tells the owner
 * to "Adjust stock by +N".
 *
 * Correct behaviour: a full refund of an order that never shipped (fulfilment unfulfilled / packed) releases its
 * stock, exactly like an admin cancel of an unshipped order does.
 */
import { test, expect } from '../../fixtures.js';
import { apiCodOrder, apiOnlineOrder, deliverWebhook, eventId, mockPay, paymentEntity, waitOrder } from '../../orders/helpers.js';

const SLUG = 'rolled-oats';

test('control: an admin cancel of an unshipped COD order gives its 2 packs back', async ({ api, admin, db }) => {
	await admin.setStock(SLUG, 10);
	const o = await apiCodOrder(api, { items: { [SLUG]: 2 } });
	expect(await db.stock(SLUG)).toBe(8);
	const r = await admin.cancelOrder(o.number);
	expect(r.status, JSON.stringify(r.error ?? '')).toBe(200);
	await expect.poll(() => db.stock(SLUG)).toBe(10);
});

test('Razorpay Dashboard full refund of a paid, unshipped order gives its 2 packs back', async ({ stack, api, mock, admin, db }) => {
	await admin.setStock(SLUG, 10);
	const o = await apiOnlineOrder(api, { items: { [SLUG]: 2 } });
	const paid = await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
	await waitOrder(admin, o.number, { status: 'paid', stockState: 'committed', fulfilmentStatus: 'unfulfilled' });
	expect(await db.stock(SLUG)).toBe(8);

	// The owner refunds the whole payment in the Razorpay Dashboard (customer asked to cancel before shipping).
	const refundId = `rfnd_W5dc${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`;
	const r = await deliverWebhook(stack, {
		event: 'refund.processed',
		payload: {
			refund: { id: refundId, entity: 'refund', amount: o.totalPaise, currency: 'INR', payment_id: paid.paymentId, notes: [], receipt: null, status: 'processed', speed_processed: 'normal', created_at: Math.floor(Date.now() / 1000) },
			payment: paymentEntity({ paymentId: paid.paymentId, rzpOrderId: o.rzpOrderId, amount: o.totalPaise, number: o.number, status: 'refunded', amountRefunded: o.totalPaise })
		},
		eventId: eventId('w5dcrf')
	});
	expect(r.status, JSON.stringify(r.json)).toBe(200);
	const doc = await waitOrder(admin, o.number, { status: 'refunded', paymentStatus: 'refunded', fulfilmentStatus: 'unfulfilled' });

	// It can never ship now, and it can't be cancelled either (refunded is terminal)…
	expect((await admin.updateOrder(o.number, { fulfilmentStatus: 'packed' })).status).toBe(400);
	expect((await admin.cancelOrder(o.number)).status).toBe(400);
	// …so the two packs must be back on the shelf.
	await expect.poll(() => db.stock(SLUG), { message: `stock after refunding unshipped ${o.number} (stockState ${doc.stockState})` }).toBe(10);
});

test('admin sets Status → refunded on a paid, unshipped order: its 2 packs come back', async ({ api, mock, admin, db }) => {
	await admin.setStock(SLUG, 10);
	const o = await apiOnlineOrder(api, { items: { [SLUG]: 2 } });
	await mockPay(mock, o.rzpOrderId, 'success', { webhook: true });
	await waitOrder(admin, o.number, { status: 'paid', stockState: 'committed' });
	expect(await db.stock(SLUG)).toBe(8);
	const r = await admin.updateOrder(o.number, { status: 'refunded' });
	expect(r.status, JSON.stringify(r.error ?? '')).toBe(200);
	await expect.poll(() => db.stock(SLUG), { message: 'stock after the admin marked the unshipped order refunded' }).toBe(10);
});
