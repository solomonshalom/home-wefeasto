/*
 * Round-3 fuzzer operations, on top of lib/ops.js: Razorpay refund.* and payment.dispute.* webhooks (dashboard
 * refunds, partial refunds, out-of-order snapshots, duplicate event ids), admin resolve/refund/cancel edits,
 * admin coupon edits, supersede-by-reference checkouts, first-order-only coupon use, whole-queue reconcile and
 * jobs runs. Same shape as OPS: (client, world, [numbers]) → trace line.
 */
import crypto from 'node:crypto';
import { MOCK_WEBHOOK_SECRET, paymentEntity, phpJson } from './client.js';
import { BAGS, OPS } from './ops.js';

const pickOf = (arr, n) => (arr.length ? arr[n % arr.length] : null);
const hex = (n) => crypto.randomBytes(n).toString('hex');

/** Orders of this world that took money and still name it (candidates for refunds / disputes). */
async function moneyOrders(c, w) {
	return c.db.query(
		`select o.id, o.number, o.status, o.total_paise::int as total, o.razorpay_payment_id as pid from orders o
		  where o.number = any($1::text[]) and o.razorpay_payment_id is not null and o.status in ('paid', 'partially_refunded', 'needs_review')
		    and not exists (select 1 from orders_refunds r where r._parent_id = o.id and r.payment_id = o.razorpay_payment_id and r.reason <> 'external')
		  order by o.id`,
		[w.orders.map((o) => o.number)]
	);
}

function refundEntity({ id, paymentId, amount, status, number }) {
	return { id, entity: 'refund', amount, currency: 'INR', payment_id: paymentId, notes: [], receipt: null, acquirer_data: {}, created_at: Math.floor(Date.now() / 1000), batch_id: null, status, speed_processed: 'normal', speed_requested: 'normal', _wf: number };
}

/** Razorpay dispute events carry `contains: ['payment', 'dispute']` (HuntClient.webhook knows no disputes). */
function disputeWebhook(c, event, entities, { eventId = `HuntEvt${hex(6)}` } = {}) {
	const body = phpJson({ entity: 'event', account_id: 'acc_WefeastoMock01', event, contains: ['payment', 'dispute'], payload: { payment: { entity: entities.payment }, dispute: { entity: entities.dispute } }, created_at: Math.floor(Date.now() / 1000) });
	const sig = crypto.createHmac('sha256', MOCK_WEBHOOK_SECRET).update(body).digest('hex');
	return c.call('POST', 'payments/razorpay/webhook', { raw: body, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId } }).then((r) => ({ ...r, eventId }));
}

export const OPS_R3 = {
	...OPS,

	/** A refund made in the Razorpay Dashboard (full or partial), its events possibly out of order / redelivered. */
	async refund(c, w, [i, kind, dup, part]) {
		w.extRefunds ??= [];
		const k = kind % 4;
		if (k >= 2 && w.extRefunds.length) {
			const r = pickOf(w.extRefunds, dup);
			const status = k === 2 ? 'pending' : r.status;
			const event = status === 'pending' ? 'refund.created' : 'refund.processed';
			const payment = { ...paymentEntity({ id: r.paymentId, orderId: r.rz, amount: r.paymentAmount, status: 'captured', wfOrder: r.number }), amount_refunded: status === 'processed' ? r.amount : 0 };
			const res = await c.webhook(event, { refund: refundEntity({ ...r, status }), payment }, dup % 2 === 0 && r.eventId ? { eventId: r.eventId } : {});
			return `refund ${event} ${r.id} (${k === 2 ? 'stale snapshot' : 'redelivery'}) → ${res.status} ${res.json?.outcome ?? ''}`;
		}
		const o = pickOf(await moneyOrders(c, w), i);
		if (!o) return 'skip';
		const p = w.payments.find((x) => x.id === o.pid);
		if (!p) return 'skip';
		const already = w.extRefunds.filter((r) => r.paymentId === o.pid).reduce((a, r) => a + r.amount, 0);
		const amount = part % 2 ? Math.floor(o.total / 2) : o.total - already;
		if (amount <= 0 || already + amount > o.total) return 'skip (fully refunded)';
		const r = { id: `rfnd_Hunt${hex(6)}`, paymentId: o.pid, rz: p.rz, paymentAmount: p.amount, amount, number: o.number, status: 'processed' };
		w.extRefunds.push(r); // claimed before any await: a parallel refund op sees it (Razorpay never over-refunds)
		const payment = { ...paymentEntity({ id: o.pid, orderId: p.rz, amount: p.amount, status: 'captured', wfOrder: o.number }), amount_refunded: already + amount, refund_status: already + amount >= p.amount ? 'full' : 'partial' };
		const res = await c.webhook('refund.processed', { refund: refundEntity(r), payment });
		r.eventId = res.eventId;
		return `refund dashboard ${amount === o.total ? 'full' : 'partial'} ${o.number} ${o.pid} (${o.status}) → ${res.status} ${res.json?.outcome ?? ''}`;
	},

	/** Chargeback lifecycle events for an order's payment, in any order. */
	async dispute(c, w, [i, k, dup]) {
		const o = pickOf(await moneyOrders(c, w), i);
		if (!o) return 'skip';
		w.disputes ??= {};
		const d = (w.disputes[o.number] ??= { id: `disp_Hunt${hex(5)}`, events: [] });
		const [event, status] = [['payment.dispute.created', 'open'], ['payment.dispute.under_review', 'under_review'], ['payment.dispute.action_required', 'open'], ['payment.dispute.won', 'won'], ['payment.dispute.lost', 'lost'], ['payment.dispute.closed', 'closed']][k % 6];
		const dispute = { id: d.id, entity: 'dispute', payment_id: o.pid, amount: o.total, currency: 'INR', reason_code: 'fraud', status, phase: 'chargeback', created_at: Math.floor(Date.now() / 1000) };
		const prev = dup % 3 === 0 ? pickOf(d.events, dup) : null;
		const payment = paymentEntity({ id: o.pid, orderId: w.payments.find((x) => x.id === o.pid)?.rz ?? 'order_Unknown', amount: o.total, status: 'captured', wfOrder: o.number });
		const res = await disputeWebhook(c, event, { payment, dispute }, prev ? { eventId: prev } : {});
		d.events.push(res.eventId);
		return `dispute ${event} ${o.number} (${o.status})${prev ? ' (dup id)' : ''} → ${res.status} ${res.json?.outcome ?? ''}`;
	},

	/** Admin status edits that the base op doesn't make: resolve a review, record a refund, cancel. */
	async resolve(c, w, [i, k]) {
		const o = pickOf(w.orders, i);
		if (!o) return 'skip';
		const doc = await c.order(o.number);
		const status = ['paid', 'refunded', 'partially_refunded', 'cancelled', 'paid'][k % 5];
		// An admin resolves a REVIEW to paid; marking an unpaid online order paid by hand is not modelled.
		if (status === 'paid' && doc.status !== 'needs_review') return 'skip (resolve only from needs_review)';
		const r = await c.patchOrder(doc.id, { status });
		return `resolve ${o.number} ${doc.status} → ${status}: ${r.status} ${r.json?.doc?.status ?? r.json?.errors?.[0]?.message?.slice(0, 60) ?? ''}`;
	},

	/** An admin edits a coupon's limit / active flag while orders use it. */
	async couponEdit(c, w, [ci, k]) {
		const cp = w.coupons[ci % w.coupons.length];
		const cur = (await c.adminReq('GET', `coupons/${cp.id}?depth=0`)).json;
		if (!cur) return 'skip';
		// Raise-only: an admin lowering a limit below the uses already spoken for makes the limit check moot.
		const data = k % 3 === 0 ? { active: !cur.active } : { usageLimit: cur.usageLimit == null ? null : cur.usageLimit + 1 };
		const r = await c.adminReq('PATCH', `coupons/${cp.id}?depth=0`, data);
		return `couponEdit ${cp.code} ${JSON.stringify(data)} → ${r.status}`;
	},

	/** "Pay on delivery instead" (or pay online again) for an earlier online order: supersede by reference. */
	async supersede(c, w, [i, m]) {
		const o = pickOf(w.orders.filter((x) => x.method !== 'cod'), i);
		if (!o) return 'skip';
		const method = m % 2 ? 'cod' : 'upi';
		const q = await c.quote({ items: o.body.items, method, supersede: { number: o.number, token: o.token } });
		const body = { ...o.body, method, expectedTotalPaise: q.json?.quote?.totalPaise ?? 0, supersede: { number: o.number, token: o.token } };
		delete body.couponCode;
		const key = crypto.randomUUID();
		const r = await c.checkout(body, key);
		const n = r.json?.order;
		if (n?.number && !w.orders.some((x) => x.number === n.number)) {
			w.orders.push({ number: n.number, token: n.token, method, body, key, attempts: r.json?.payment?.razorpayOrderId ? [r.json.payment.razorpayOrderId] : [], lateLocked: new Set() });
		}
		return `supersede ${o.number} → ${method}: ${r.status} ${n?.number ?? r.json?.error?.code ?? ''}`;
	},

	/** A checkout with the world's first-order-only coupon (same phone pool, so first-order rules collide). */
	async firstOrder(c, w, [bag, phone, m, which]) {
		const fo = pickOf(w.coupons.filter((x) => x.firstOrderOnly), which ?? 0);
		if (!fo) return 'skip';
		const method = ['upi', 'cod', 'card'][m % 3];
		const items = Object.entries(BAGS[bag % 3]).map(([j, qty]) => ({ slug: w.products[j].slug, qty }));
		const body = {
			items,
			contact: { name: 'Hunt Conc', email: w.emails[phone % 3], phone: w.phones[phone % 3] },
			address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
			method,
			expectedTotalPaise: 0,
			consent: { marketing: false },
			source: 'web',
			couponCode: fo.code
		};
		const key = crypto.randomUUID();
		let r = await c.checkout(body, key);
		if (r.status === 409 && r.json?.error?.code === 'PRICE_CHANGED') {
			body.expectedTotalPaise = r.json.error.details.quote.totalPaise;
			r = await c.checkout(body, key);
		}
		const n = r.json?.order;
		if (n?.number && !w.orders.some((x) => x.number === n.number)) {
			w.orders.push({ number: n.number, token: n.token, method, body, key, attempts: r.json?.payment?.razorpayOrderId ? [r.json.payment.razorpayOrderId] : [], lateLocked: new Set() });
		}
		return `firstOrder ${method} ph${phone % 3} → ${r.status} ${n?.number ?? r.json?.error?.code ?? ''} ${r.json?.error?.details?.reason ?? ''}`;
	},

	async reconcileAll(c) {
		const r = await c.reconcile();
		return `reconcileAll → ${r.status} ${JSON.stringify(r.json ?? {}).slice(0, 100)}`;
	},
	async jobs(c) {
		const r = await c.runJobs();
		return `jobs → ${r.status}`;
	}
};

export const WEIGHTS_R3 = {
	checkout: 12, replay: 3, retry: 8, pay: 16, verify: 5, webhook: 8, reconcile: 4, expire: 5, admin: 6, stock: 3, household: 2, status: 2,
	refund: 6, dispute: 4, resolve: 5, couponEdit: 3, supersede: 5, firstOrder: 5, reconcileAll: 2, jobs: 2
};
