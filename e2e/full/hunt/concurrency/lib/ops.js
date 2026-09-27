/*
 * Fuzzer operations. A plan is { op, a: [numbers] } generated from the seeded RNG; execute(plan) maps the
 * numbers onto the live world (orders/payments by index modulo the current count), so a trace can be
 * replayed and shrunk. Every op records what it did in w.trace.
 */
import crypto from 'node:crypto';
import { paymentEntity } from './client.js';

export const BAGS = [{ 0: 1 }, { 0: 2, 1: 1 }, { 1: 2 }];

const pickOf = (arr, n) => (arr.length ? arr[n % arr.length] : null);
const latestAttempt = (o) => o.attempts[o.attempts.length - 1] ?? null;

function bodyFor(w, { bag, phone, method, coupon, consent }, totalPaise) {
	const items = Object.entries(BAGS[bag]).map(([i, qty]) => ({ slug: w.products[i].slug, qty }));
	return {
		items,
		contact: { name: 'Hunt Conc', email: w.emails[phone], phone: w.phones[phone] },
		address: { line1: 'Flat 4B, 12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
		method,
		expectedTotalPaise: totalPaise,
		consent: { marketing: consent },
		source: 'web',
		...(coupon >= 0 ? { couponCode: w.coupons[coupon].code } : {})
	};
}

function remember(w, r, key, body) {
	const o = r.json?.order ?? r.json?.error?.details?.order; // 503 PAYMENTS_UNAVAILABLE keeps the order
	if (!o?.number || !o?.token) return null;
	let rec = w.orders.find((x) => x.number === o.number);
	if (!rec) {
		rec = { number: o.number, token: o.token, method: body.method, body, key, attempts: [], lateLocked: new Set() };
		w.orders.push(rec);
	}
	const rz = r.json?.payment?.razorpayOrderId;
	if (rz && !rec.attempts.includes(rz)) rec.attempts.push(rz);
	return rec;
}

export const OPS = {
	async checkout(c, w, [bag, phone, m, coupon, consent]) {
		const method = ['upi', 'cod', 'card'][m % 3];
		const q = await c.quote({ items: Object.entries(BAGS[bag % 3]).map(([i, qty]) => ({ slug: w.products[i].slug, qty })), method });
		const total = q.json?.quote?.totalPaise ?? 0;
		const cp = (coupon % 4) - 2; // -2,-1 → none, 0,1 → coupon
		const body = bodyFor(w, { bag: bag % 3, phone: phone % 3, method, coupon: cp, consent: consent % 2 === 0 }, total);
		// the coupon changes the total: ask the server (PRICE_CHANGED details carry the quote)
		const key = crypto.randomUUID();
		let r = await c.checkout(body, key);
		if (r.status === 409 && r.json?.error?.code === 'PRICE_CHANGED') {
			body.expectedTotalPaise = r.json.error.details.quote.totalPaise;
			r = await c.checkout(body, key);
		}
		w.checkouts.push({ key, body });
		const rec = remember(w, r, key, body);
		return `${method} bag${bag % 3} ph${phone % 3} cp${cp} → ${r.status} ${rec?.number ?? r.json?.error?.code ?? ''}`;
	},
	async replay(c, w, [i, mutate]) {
		const ck = pickOf(w.checkouts, i);
		if (!ck) return 'skip';
		const body = mutate % 5 === 0 ? { ...ck.body, consent: { marketing: !ck.body.consent.marketing } } : ck.body;
		const r = await c.checkout(body, ck.key);
		remember(w, r, ck.key, ck.body);
		return `replay ${ck.key.slice(0, 8)}${mutate % 5 === 0 ? ' (mismatch)' : ''} → ${r.status} ${r.json?.order?.number ?? r.json?.error?.code ?? ''}`;
	},
	async retry(c, w, [i]) {
		const o = pickOf(w.orders, i);
		if (!o) return 'skip';
		const r = await c.retry(o.number, o.token);
		const rz = r.json?.payment?.razorpayOrderId;
		if (rz && !o.attempts.includes(rz)) o.attempts.push(rz);
		return `retry ${o.number} → ${r.status} ${r.json?.error?.code ?? rz ?? ''}`;
	},
	async pay(c, w, [i, k, wh, which]) {
		const o = pickOf(w.orders, i);
		const rz = o && (which % 3 === 0 ? pickOf(o.attempts, which) : latestAttempt(o));
		if (!rz || o.lateLocked.has(rz)) return 'skip';
		const outcome = ['success', 'fail', 'late', 'authorize_only', 'success'][k % 5];
		const webhook = wh % 3 !== 0;
		const amount = (await c.status(o.number, o.token)).json?.totalPaise;
		const r = await c.mockPay(rz, outcome, { webhook, lateAuthDelayMs: 300 + (wh % 7) * 150 });
		const j = r.json ?? {};
		if (outcome === 'late') o.lateLocked.add(rz);
		const money =
			(j.ok === true && (outcome === 'success' || outcome === 'authorize_only')) || (outcome === 'late' && j.ok === false && j.error?.reason === 'payment_timed_out');
		if (j.paymentId)
			w.payments.push({ number: o.number, id: j.paymentId, rz, outcome, money, triple: j.response ?? null, amount, status: outcome === 'authorize_only' ? 'authorized' : outcome === 'fail' || !money ? 'failed' : 'captured' });
		return `pay ${o.number} ${rz.slice(-6)} ${outcome}${webhook ? '' : ' (no webhook)'} → ${r.status} ${j.ok ? 'ok' : j.error?.reason ?? ''} ${j.paymentId ?? ''}`;
	},
	async verify(c, w, [i]) {
		const p = pickOf(w.payments.filter((x) => x.triple), i);
		if (!p) return 'skip';
		const o = w.orders.find((x) => x.number === p.number);
		const r = await c.verify(o.number, o.token, p.triple);
		return `verify ${o.number} ${p.id} → ${r.status} ${r.json?.order?.status ?? r.json?.error?.code ?? ''}`;
	},
	async webhook(c, w, [i, kind, dup]) {
		const p = pickOf(w.payments, i);
		if (!p) return 'skip';
		const status = p.status === 'failed' ? 'failed' : ['authorized', 'captured', 'captured'][kind % 3];
		if (p.status === 'authorized' && status === 'captured') return 'skip'; // never captured at the mock
		const event = status === 'failed' ? 'payment.failed' : status === 'authorized' ? 'payment.authorized' : kind % 2 ? 'payment.captured' : 'order.paid';
		const prev = dup % 3 === 0 ? pickOf(w.events.filter((e) => e.payment === p.id), dup) : null;
		const entities = { payment: paymentEntity({ id: p.id, orderId: p.rz, amount: p.amount, status, wfOrder: p.number }) };
		const r = await c.webhook(event, entities, prev ? { eventId: prev.eventId } : {});
		w.events.push({ payment: p.id, eventId: r.eventId, event });
		return `webhook ${event} ${p.id}${prev ? ' (dup id)' : ''} → ${r.status} ${r.json?.outcome ?? r.text.slice(0, 80)}`;
	},
	async reconcile(c, w, [i]) {
		const o = pickOf(w.orders, i);
		if (!o) return 'skip';
		const r = await c.reconcile(o.number);
		return `reconcile ${o.number} → ${r.status} ${JSON.stringify(r.json ?? {}).slice(0, 120)}`;
	},
	async expire(c, w, [i]) {
		const o = pickOf(w.orders.filter((x) => x.method !== 'cod'), i);
		if (!o) return 'skip';
		await c.db.expireReservation(o.number, { minutesAgo: 5 });
		const r = await c.reconcile(o.number);
		return `expire ${o.number} → ${r.status} expired=${r.json?.expired} paid=${r.json?.paid}`;
	},
	async admin(c, w, [i, k]) {
		const o = pickOf(w.orders, i);
		if (!o) return 'skip';
		const doc = await c.order(o.number);
		const change = [
			{ status: 'cancelled' },
			{ status: 'cod_confirmed' },
			{ fulfilmentStatus: 'packed' },
			{ fulfilmentStatus: 'shipped' },
			{ fulfilmentStatus: 'delivered' },
			{ status: 'refunded' },
			{ status: 'paid' },
			{ status: 'cancelled' }
		][k % 8];
		if (change.status === 'paid' && doc.status !== 'needs_review') return 'skip (admin only resolves needs_review → paid)';
		if (w.isolateAdmin) await new Promise((r) => setTimeout(r, 1200)); // let in-flight webhooks land first
		const r = await c.patchOrder(doc.id, change);
		return `admin ${o.number} ${JSON.stringify(change)} (was ${doc.status}/${doc.fulfilmentStatus}) → ${r.status} ${r.json?.doc?.status ?? r.json?.errors?.[0]?.message?.slice(0, 60) ?? ''}`;
	},
	async stock(c, w, [i, n]) {
		const p = w.products[i % w.products.length];
		const d = (n % 7) - 3 || 2;
		const r = await c.stockAdjust(p.id, d);
		if (r.status === 200) w.adjusted.set(p.id, w.adjusted.get(p.id) + d);
		return `stock ${p.slug} ${d > 0 ? '+' : ''}${d} → ${r.status} ${r.json?.doc?.stock ?? r.json?.errors?.[0]?.message?.slice(0, 50) ?? ''}`;
	},
	async household(c, w, [i, s]) {
		const o = pickOf(w.orders, i);
		if (!o) return 'skip';
		const r = await c.household(o.number, o.token, 1 + (s % 4));
		return `household ${o.number} ${1 + (s % 4)} → ${r.status}`;
	},
	async fault(c, w, [o, k, t, cm]) {
		const op = ['createOrder', 'fetchOrderPayments', 'fetchPayment', 'refund', 'findOrdersByReceipt', 'fetchOrder', 'simulatePayment', '*'][o % 8];
		const kind = ['network', 'timeout', 'rate_limited', 'server', 'not_found', 'bad_request'][k % 6];
		const r = await c.fault(op, kind, { times: 1 + (t % 2), commit: cm % 2 === 0 });
		return `fault ${op} ${kind} x${1 + (t % 2)}${cm % 2 === 0 ? ' commit' : ''} → ${r.status}`;
	},
	async status(c, w, [i]) {
		const o = pickOf(w.orders, i);
		if (!o) return 'skip';
		const r = await c.status(o.number, o.token);
		return `status ${o.number} → ${r.status} ${r.json?.status ?? ''}`;
	}
};

export const WEIGHTS = { checkout: 14, replay: 4, retry: 6, pay: 16, verify: 6, webhook: 10, reconcile: 5, expire: 4, admin: 10, stock: 5, household: 3, status: 3 };
