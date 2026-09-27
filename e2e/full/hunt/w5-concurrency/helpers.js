/*
 * Wave 5 concurrency hunt helpers: place / pay orders straight at the slot CMS, signed Razorpay-style
 * webhooks (the mock's public dev secret), the Payload admin UI login, and small SQL readers.
 */
import crypto from 'node:crypto';
import { cmsCall, mockPay, placeOrder } from '../concurrency/helpers.js';
import { paymentEntity, phpJson, MOCK_WEBHOOK_SECRET } from '../concurrency/lib/client.js';

export { cmsCall, mockPay, placeOrder, paymentEntity };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hex = (n) => crypto.randomBytes(n).toString('hex');

/** POSTs a signed webhook: `payload` maps entity names (payment, refund, dispute, order) to entities. */
export async function webhook(stack, event, payload, { eventId = `W5Evt${hex(6)}` } = {}) {
	const keys = Object.keys(payload);
	const body = phpJson({
		entity: 'event',
		account_id: 'acc_WefeastoMock01',
		event,
		contains: keys,
		payload: Object.fromEntries(keys.map((k) => [k, { entity: payload[k] }])),
		created_at: Math.floor(Date.now() / 1000)
	});
	const sig = crypto.createHmac('sha256', MOCK_WEBHOOK_SECRET).update(body).digest('hex');
	const r = await cmsCall(stack, 'POST', 'payments/razorpay/webhook', { raw: body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId } });
	return { ...r, eventId };
}

/** A Razorpay refund entity. */
export const refundEntity = ({ id = `rfnd_W5${hex(6)}`, paymentId, amount, status = 'processed', receipt = null }) => ({
	id,
	entity: 'refund',
	amount,
	currency: 'INR',
	payment_id: paymentId,
	notes: [],
	receipt,
	acquirer_data: {},
	created_at: Math.floor(Date.now() / 1000),
	batch_id: null,
	status,
	speed_processed: 'normal',
	speed_requested: 'normal'
});

/** Places an online order and pays it (mock + /checkout/verify). → the placed order + { paymentId } */
export async function placePaid(stack, db, { slug = 'steel-cut-oats', email }) {
	const o = await placeOrder(stack, db, { slug, email });
	const paid = await mockPay(stack, o.razorpayOrderId, 'success', { webhook: false });
	const v = await cmsCall(stack, 'POST', 'store/checkout/verify', { body: { number: o.number, token: o.token, ...paid.response } });
	if (v.json?.order?.status !== 'paid') throw new Error(`verify → ${v.status} ${v.text.slice(0, 200)}`);
	return { ...o, paymentId: paid.paymentId };
}

/** Logs the page into the Payload admin as the seeded admin. */
export async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

/** One order row (the columns the specs assert on). */
export async function orderRow(db, number) {
	const [o] = await db.query(
		`select id, status, payment_status, fulfilment_status, stock_state, review_reason, razorpay_payment_id from orders where number = $1`,
		[number]
	);
	return o;
}
