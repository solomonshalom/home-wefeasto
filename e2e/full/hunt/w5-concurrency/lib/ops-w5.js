/*
 * Wave 5 fuzzer operations, on top of the round-3 model (../../concurrency/lib/ops-r3.js):
 *   formSave      an admin UI order Save: the whole document as a page loaded it (GET), a think time, then
 *                 PATCH back with one change (fulfilment step, cancel, COD confirm, resolve, or none)
 *   couponForm    an admin coupon Save of the whole loaded document (usedCount included) + note/limit/active
 *   productForm   an admin product Save as the admin UI sends it (no `stock`): ±N, sale toggle, plain save
 *   whBurst       one payment's authorized / captured / order.paid webhooks at once, each delivered twice
 *   reconcile2    two reconcile cron runs at once (optionally after expiring an order by time travel)
 *   jobs2         two jobs-runner calls at once
 *   refundRace    a Dashboard refund (full or partial) at the same instant as an admin fulfilment Save
 *   householdPay  "Breakfast for how many?" at the same instant as the payment lands
 *   lateSupersede a late UPI authorisation racing "Pay on delivery instead" for the same order
 */
import crypto from 'node:crypto';
import { paymentEntity } from '../../concurrency/lib/client.js';
import { OPS_R3 } from '../../concurrency/lib/ops-r3.js';

const pickOf = (arr, n) => (arr.length ? arr[n % arr.length] : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => crypto.randomBytes(n).toString('hex');
const strip = ({ id, createdAt, updatedAt, ...doc }) => doc;
const FULFIL_NEXT = { unfulfilled: 'packed', packed: 'shipped', shipped: 'delivered' };

async function formSaveOf(c, o, k, thinkMs) {
	const loaded = await c.order(o.number);
	if (!loaded) return 'skip';
	if (thinkMs) await sleep(thinkMs);
	const change = [
		{ fulfilmentStatus: FULFIL_NEXT[loaded.fulfilmentStatus] ?? loaded.fulfilmentStatus },
		{ status: 'cancelled' },
		{ status: 'cod_confirmed' },
		loaded.status === 'needs_review' ? { status: 'paid' } : {},
		{}
	][k % 5];
	const r = await c.patchOrder(loaded.id, { ...strip(loaded), ...change });
	return `formSave ${o.number} ${JSON.stringify(change)} (loaded ${loaded.status}/${loaded.fulfilmentStatus}, ${thinkMs}ms) → ${r.status} ${r.json?.errors?.[0]?.message?.slice(0, 70) ?? ''}`;
}

export const OPS_W5 = {
	...OPS_R3,

	async formSave(c, w, [i, k, t]) {
		const o = pickOf(w.orders, i);
		return o ? formSaveOf(c, o, k, (t % 6) * Number(process.env.HUNT_THINK_MS ?? 15)) : 'skip';
	},

	async couponForm(c, w, [ci, k, t]) {
		const cp = w.coupons[ci % w.coupons.length];
		const cur = (await c.adminReq('GET', `coupons/${cp.id}?depth=0`)).json;
		if (!cur) return 'skip';
		await sleep((t % 6) * Number(process.env.HUNT_THINK_MS ?? 15));
		const change = [{ note: `w5 ${hex(2)}` }, { usageLimit: cur.usageLimit == null ? null : cur.usageLimit + 1 }, { active: true }][k % 3];
		const r = await c.adminReq('PATCH', `coupons/${cp.id}?depth=0`, { ...strip(cur), ...change });
		return `couponForm ${cp.code} ${JSON.stringify(change)} (loaded used ${cur.usedCount}) → ${r.status}`;
	},

	async productForm(c, w, [pi, k, n]) {
		const p = w.products[pi % w.products.length];
		const cur = (await c.adminReq('GET', `products/${p.id}?depth=0&draft=false`)).json;
		if (!cur) return 'skip';
		const { stock, stockOnHand, stockAdjust, ...form } = strip(cur);
		const d = (n % 5) - 2 || 1;
		const change = [{ stockAdjust: d }, { inStock: true }, {}][k % 3];
		const r = await c.adminReq('PATCH', `products/${p.id}?depth=0`, { ...form, ...change });
		if (r.status === 200 && change.stockAdjust) w.adjusted.set(p.id, w.adjusted.get(p.id) + d);
		return `productForm ${p.slug} ${JSON.stringify(change)} → ${r.status} ${r.json?.errors?.[0]?.message?.slice(0, 60) ?? ''}`;
	},

	async whBurst(c, w, [i, dupAll]) {
		const p = pickOf(w.payments.filter((x) => x.money && x.status === 'captured'), i);
		if (!p) return 'skip';
		const events = ['payment.authorized', 'payment.captured', 'order.paid'];
		const ids = events.map(() => `W5Evt${hex(6)}`);
		const send = (ev, j) =>
			c.webhook(ev, { payment: paymentEntity({ id: p.id, orderId: p.rz, amount: p.amount, status: ev === 'payment.authorized' ? 'authorized' : 'captured', wfOrder: p.number }) }, { eventId: ids[j] });
		const rs = await Promise.all([...events.map(send), ...(dupAll % 2 ? events.map(send) : [])]);
		return `whBurst ${p.number} ${p.id} → ${rs.map((r) => `${r.status}:${r.json?.outcome ?? ''}`).join(' ')}`;
	},

	async reconcile2(c, w, [i, exp]) {
		const o = pickOf(w.orders.filter((x) => x.method !== 'cod'), i);
		if (o && exp % 2) await c.db.expireReservation(o.number, { minutesAgo: 5 });
		const rs = await Promise.all([c.reconcile(), c.reconcile(), ...(o ? [c.reconcile(o.number)] : [])]);
		return `reconcile2${o && exp % 2 ? ` (expired ${o.number})` : ''} → ${rs.map((r) => `${r.status}:p${r.json?.paid ?? '-'}e${r.json?.expired ?? '-'}`).join(' ')}`;
	},

	async jobs2(c) {
		const rs = await Promise.all([c.runJobs(), c.runJobs()]);
		return `jobs2 → ${rs.map((r) => r.status).join(' ')}`;
	},

	async refundRace(c, w, [i, part, k]) {
		const [o] = (await c.db.query(
			`select o.number, o.total_paise::int as total, o.razorpay_payment_id as pid from orders o where o.number = any($1::text[]) and o.status in ('paid','partially_refunded') order by o.id`,
			[w.orders.map((x) => x.number)]
		)).slice(i % 3);
		const p = o && w.payments.find((x) => x.id === o.pid);
		if (!p) return 'skip';
		w.extRefunds ??= [];
		const already = w.extRefunds.filter((r) => r.paymentId === o.pid).reduce((a, r) => a + r.amount, 0);
		const amount = part % 2 ? Math.floor(o.total / 4) : o.total - already;
		if (amount <= 0) return 'skip';
		const r = { id: `rfnd_W5${hex(6)}`, paymentId: o.pid, rz: p.rz, paymentAmount: p.amount, amount, number: o.number, status: 'processed' };
		w.extRefunds.push(r);
		const payment = { ...paymentEntity({ id: o.pid, orderId: p.rz, amount: p.amount, status: 'captured', wfOrder: o.number }), amount_refunded: already + amount };
		const refund = { id: r.id, entity: 'refund', amount, currency: 'INR', payment_id: o.pid, notes: [], receipt: null, status: 'processed', created_at: Math.floor(Date.now() / 1000) };
		const rec = w.orders.find((x) => x.number === o.number);
		const [wh, adm] = await Promise.all([c.webhook('refund.processed', { refund, payment }), formSaveOf(c, rec, k % 2 ? 0 : 4, 0)]);
		return `refundRace ${o.number} ${amount}/${o.total} → ${wh.status}:${wh.json?.outcome ?? ''} | ${adm}`;
	},

	async householdPay(c, w, [i, s, wh]) {
		const o = pickOf(w.orders.filter((x) => x.attempts.length), i);
		if (!o) return 'skip';
		const [h, p] = await Promise.all([c.household(o.number, o.token, 1 + (s % 4)), OPS_R3.pay(c, w, [w.orders.indexOf(o), 0, wh, 1])]);
		return `householdPay ${o.number} h${1 + (s % 4)} → ${h.status} | ${p}`;
	},

	async lateSupersede(c, w, [i, m]) {
		const o = pickOf(w.orders.filter((x) => x.method !== 'cod' && x.attempts.length), i);
		if (!o) return 'skip';
		const idx = w.orders.indexOf(o);
		const [p, s] = await Promise.all([OPS_R3.pay(c, w, [idx, 2, 1, 1]), OPS_R3.supersede(c, w, [w.orders.filter((x) => x.method !== 'cod').indexOf(o), m])]);
		return `lateSupersede ${o.number} → ${p} | ${s}`;
	}
};

export const WEIGHTS_W5 = {
	checkout: 10, replay: 2, retry: 5, pay: 12, verify: 4, webhook: 5, reconcile: 3, expire: 4, admin: 2, stock: 2, household: 2, status: 1,
	refund: 3, dispute: 4, resolve: 3, couponEdit: 1, supersede: 3, firstOrder: 4, reconcileAll: 1, jobs: 1,
	formSave: 10, couponForm: 4, productForm: 4, whBurst: 4, reconcile2: 3, jobs2: 2, refundRace: 4, householdPay: 3, lateSupersede: 3
};
