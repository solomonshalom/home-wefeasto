/*
 * Shared helpers for the concurrency-hunt repro specs. They call the slot CMS directly (not through the
 * storefront proxy) so two requests really start together: the races below are a few milliseconds wide.
 */
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST/GET a CMS /api path → { status, json, text }. */
export async function cmsCall(stack, method, path, { body, raw, headers = {} } = {}) {
	const res = await fetch(`${stack.cmsUrl}/api/${path.replace(/^\/+/, '')}`, {
		method,
		headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
		body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* not JSON */
	}
	return { status: res.status, json, text };
}

/** POSTs a Razorpay-style webhook signed with the mock's public dev secret (PAYMENTS_MODE=mock stacks). */
export async function signedWebhook(stack, event, payload) {
	const body = JSON.stringify({ entity: 'event', account_id: 'acc_WefeastoMock01', event, contains: Object.keys(payload), payload: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, { entity: v }])), created_at: Math.floor(Date.now() / 1000) });
	const signature = crypto.createHmac('sha256', 'wefeasto-mock-webhook-secret-dev-only').update(body).digest('hex');
	return cmsCall(stack, 'POST', 'payments/razorpay/webhook', {
		body: JSON.parse(body),
		raw: body,
		headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': `HuntEvt${crypto.randomBytes(6).toString('hex')}` }
	});
}

const freshPhone = () => `+919${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;

/**
 * Places an order straight at the CMS (quote → checkout); method 'upi' (default) or 'cod'.
 * → { number, token, status, id, razorpayOrderId (null for COD), totalPaise, email }
 */
export async function placeOrder(stack, db, { slug, qty = 1, email, method = 'upi' }) {
	const items = [{ slug, qty }];
	const q = await cmsCall(stack, 'POST', 'store/quote', { body: { items, method } });
	if (q.status !== 200) throw new Error(`quote → ${q.status} ${q.text.slice(0, 200)}`);
	const body = {
		items,
		contact: { name: 'Hunt Concurrency', email, phone: freshPhone() },
		address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
		method,
		expectedTotalPaise: q.json.quote.totalPaise,
		consent: { marketing: true },
		source: 'web'
	};
	const r = await cmsCall(stack, 'POST', 'store/checkout', { body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
	if (r.status !== 201) throw new Error(`checkout → ${r.status} ${r.text.slice(0, 300)}`);
	const row = await db.order(r.json.order.number);
	return { ...r.json.order, id: row.id, razorpayOrderId: r.json.payment?.razorpayOrderId ?? null, email };
}

/** The mock gateway settles a Razorpay order server-side (webhooks off unless asked). → the pay response. */
export async function mockPay(stack, razorpayOrderId, outcome = 'success', { webhook = false } = {}) {
	const r = await cmsCall(stack, 'POST', 'payments/mock/pay', { body: { razorpayOrderId, outcome, webhook } });
	if (r.status !== 200) throw new Error(`mock pay → ${r.status} ${r.text.slice(0, 200)}`);
	return r.json;
}

/** The pieces of an order row the repros assert on (plus its refunds). */
export async function orderState(db, number) {
	const [o] = await db.query(
		'select id, status, payment_status, fulfilment_status, stock_state, razorpay_payment_id, household_size from orders where number = $1',
		[number]
	);
	const refunds = await db.query('select payment_id, status, reason from orders_refunds where _parent_id = $1', [o.id]);
	return {
		status: o.status,
		paymentStatus: o.payment_status,
		fulfilmentStatus: o.fulfilment_status,
		stockState: o.stock_state,
		paymentId: o.razorpay_payment_id,
		householdSize: o.household_size === null ? null : Number(o.household_size),
		refundedPayments: refunds.map((r) => r.payment_id)
	};
}
