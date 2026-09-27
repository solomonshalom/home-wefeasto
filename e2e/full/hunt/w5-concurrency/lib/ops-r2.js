/*
 * Wave 5 round-2 fuzzer operations, on top of OPS_W5 (./ops-w5.js):
 *   refundLater   a Razorpay Dashboard PARTIAL refund that is created now (refund.created, pending: the
 *                 payment's amount_refunded already counts it) and settled later by settleRefund
 *   settleRefund  a pending refund's refund.processed (or, one time in four, refund.failed) — delivered
 *                 whenever the plan says, e.g. days after a chargeback opened
 *   adminHold     an admin puts a paid / partly refunded order on hold (status → needs_review by hand)
 *   packTry       an admin tries to pack an order (plain REST, only the fulfilment step)
 * Refunds never exceed the payment: every refund of this world is counted in w.extRefunds before any await,
 * and a failed one gives its amount back. The round-2 weights leave out OPS_R3.refund (its redelivery branch
 * re-sends a failed refund as refund.processed) and OPS_W5.refundRace (next to OPS_R3.refund in one burst it
 * can refund more than the payment): refundLater + settleRefund model Dashboard refunds instead.
 */
import crypto from 'node:crypto';
import { paymentEntity } from '../../concurrency/lib/client.js';
import { OPS_W5, WEIGHTS_W5 } from './ops-w5.js';

const pickOf = (arr, n) => (arr.length ? arr[n % arr.length] : null);
const hex = (n) => crypto.randomBytes(n).toString('hex');
const live = (w, pid) => (w.extRefunds ?? []).filter((r) => r.paymentId === pid && r.status !== 'failed').reduce((a, r) => a + r.amount, 0);

/** Orders of this world whose own payment took money and that are not fully refunded. */
async function moneyOrders(c, w) {
	return c.db.query(
		`select o.id, o.number, o.status, o.payment_status as ps, o.total_paise::int as total, o.razorpay_payment_id as pid from orders o
		  where o.number = any($1::text[]) and o.razorpay_payment_id is not null and o.status in ('paid', 'partially_refunded', 'needs_review')
		  order by o.id`,
		[w.orders.map((o) => o.number)]
	);
}

const refundBody = (r, status) => ({
	id: r.id,
	entity: 'refund',
	amount: r.amount,
	currency: 'INR',
	payment_id: r.paymentId,
	notes: [],
	receipt: null,
	acquirer_data: {},
	created_at: r.createdAt,
	batch_id: null,
	status,
	speed_processed: 'normal',
	speed_requested: 'normal'
});

export const OPS_R2 = {
	...OPS_W5,

	async refundLater(c, w, [i]) {
		// Razorpay refunds only captured payments, never more than was captured (automatic refunds included).
		const o = pickOf((await moneyOrders(c, w)).filter((x) => x.ps === 'captured' || x.ps === 'partially_refunded'), i);
		const p = o && w.payments.find((x) => x.id === o.pid);
		if (!p) return 'skip';
		const amount = Math.max(100, Math.floor(o.total / 5 / 100) * 100);
		const booked = await c.db.query(`select refund_id, amount_paise::int as amount from orders_refunds where payment_id = $1 and status <> 'failed'`, [o.pid]);
		const ids = new Set(booked.map((b) => b.refund_id));
		const unbooked = (w.extRefunds ?? []).filter((r) => r.paymentId === o.pid && r.status !== 'failed' && !ids.has(r.id));
		const already = booked.reduce((a, b) => a + b.amount, 0) + unbooked.reduce((a, r) => a + r.amount, 0);
		if (already + amount > o.total) return 'skip (nothing left to refund)';
		w.extRefunds ??= [];
		const r = { id: `rfnd_W5R2${hex(5)}`, paymentId: o.pid, rz: p.rz, paymentAmount: p.amount, amount, number: o.number, status: 'pending', createdAt: Math.floor(Date.now() / 1000) };
		w.extRefunds.push(r);
		const payment = { ...paymentEntity({ id: o.pid, orderId: p.rz, amount: p.amount, status: 'captured', wfOrder: o.number }), amount_refunded: already + amount, refund_status: 'partial' };
		const res = await c.webhook('refund.created', { refund: refundBody(r, 'pending'), payment });
		return `refundLater ${o.number} ${amount}/${o.total} (${o.status}) → ${res.status} ${res.json?.outcome ?? ''}`;
	},

	async settleRefund(c, w, [j, f]) {
		const r = pickOf((w.extRefunds ?? []).filter((x) => x.status === 'pending'), j);
		if (!r) return 'skip';
		const fail = f % 4 === 0;
		r.status = fail ? 'failed' : 'processed';
		const payment = { ...paymentEntity({ id: r.paymentId, orderId: r.rz, amount: r.paymentAmount, status: 'captured', wfOrder: r.number }), amount_refunded: live(w, r.paymentId) };
		const res = await c.webhook(fail ? 'refund.failed' : 'refund.processed', { refund: refundBody(r, r.status), payment });
		return `settleRefund ${r.number} ${r.id} ${r.status} → ${res.status} ${res.json?.outcome ?? ''}`;
	},

	async adminHold(c, w, [i]) {
		const o = pickOf(
			(await moneyOrders(c, w)).filter((x) => x.status === 'paid' || x.status === 'partially_refunded'),
			i
		);
		if (!o) return 'skip';
		const r = await c.patchOrder(o.id, { status: 'needs_review' });
		return `adminHold ${o.number} (${o.status}) → ${r.status} ${r.json?.errors?.[0]?.message?.slice(0, 60) ?? ''}`;
	},

	async packTry(c, w, [i]) {
		const o = pickOf(w.orders, i);
		if (!o) return 'skip';
		const doc = await c.order(o.number);
		if (!doc || doc.fulfilmentStatus !== 'unfulfilled') return 'skip';
		const r = await c.patchOrder(doc.id, { fulfilmentStatus: 'packed' });
		return `packTry ${o.number} (${doc.status}) → ${r.status}`;
	}
};

export const WEIGHTS_R2 = { ...WEIGHTS_W5, refund: 0, refundRace: 0, refundLater: 6, settleRefund: 6, adminHold: 3, packTry: 5, dispute: 6 };
