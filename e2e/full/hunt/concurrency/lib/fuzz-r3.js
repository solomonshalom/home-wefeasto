/*
 * Round-3 runner: the lib/fuzz.js model (bursts under Promise.all, invariants after every burst and after
 * quiescence) with the OPS_R3 operations, a first-order-only coupon in the world, and extra invariants:
 *   - no Razorpay order is opened for an order after it was paid (attempt createdAt > paidAt);
 *   - one customer (email or phone) holds at most one first-order-only claim (reserved/consumed);
 *   - our automatic refunds: at most one live refund per payment; refunds never exceed the payment;
 *   - a paid order's payment status is authorized/captured.
 * Documented behaviour is not reported: a LATE payment on an expired order consumes its released coupon use
 * unchecked (coupons.ts), and money kept on an order an admin cancelled by hand.
 */
import crypto from 'node:crypto';
import { canFulfil } from '../../../../../cms/src/commerce/shared/order-status.js';
import { checkFinal, quiesce } from './final.js';
import { OPS_R3, WEIGHTS_R3 } from './ops-r3.js';
import { checkAlways, rng, setupWorld } from './world.js';

export function makePlanR3(seed, { bursts = 50, maxBurst = 6, weights = WEIGHTS_R3 } = {}) {
	const r = rng(seed * 7919 + 13);
	const table = Object.entries(weights).flatMap(([op, n]) => Array(n).fill(op));
	const plan = [[{ op: 'checkout', a: [r.int(3), r.int(3), 0, r.int(4), r.int(2)] }, { op: 'firstOrder', a: [r.int(3), r.int(3), 0] }]];
	for (let b = 0; b < bursts; b++) {
		plan.push(Array.from({ length: 1 + r.int(maxBurst) }, () => ({ op: r.pick(table), a: Array.from({ length: 5 }, () => r.int(1000)) })));
	}
	return plan;
}

async function lateCouponAllowance(c, w) {
	const rows = await c.db.query(
		`select r.coupon_id as id, count(*)::int as n from coupon_redemptions r join orders o on o.id = r.order_id
		  where o.number = any($1::text[]) and r.status = 'consumed'
		    and exists (select 1 from orders_status_history h where h._parent_id = o.id and h.field = 'status' and h."from" = 'expired' and h."to" in ('paid','needs_review'))
		  group by r.coupon_id`,
		[w.orders.map((o) => o.number)]
	);
	return new Map(rows.map((x) => [Number(x.id), x.n]));
}

/** Drops documented behaviour from a batch of violations. */
async function documented(c, w, list) {
	if (!list.some((v) => /^coupon /.test(v) || /kept on a cancelled order/.test(v))) return list;
	const allow = await lateCouponAllowance(c, w);
	const byCode = new Map(w.coupons.map((cp) => [cp.code, allow.get(Number(cp.id)) ?? 0]));
	const adminCancelled = new Set(
		(await c.db.query(`select o.number from orders o join orders_status_history h on h._parent_id = o.id where o.number = any($1::text[]) and h."to" = 'cancelled' and h.source like 'admin:%'`, [w.orders.map((o) => o.number)])).map((x) => x.number)
	);
	return list.filter((v) => {
		const m = /^coupon (\S+): .*(usedCount|used) (\d+)(?: \+ reserved (\d+))? > usageLimit (\d+)/.exec(v);
		if (m) return Number(m[3]) + Number(m[4] ?? 0) > Number(m[5]) + (byCode.get(m[1]) ?? 0);
		const k = /^(WF-\d+): money \S+ kept on a cancelled order/.exec(v);
		return !(k && adminCancelled.has(k[1]));
	});
}

async function checkR3(c, w, label, { final = false } = {}) {
	const out = [];
	const nums = w.orders.map((o) => o.number);
	const late = await c.db.query(
		`select o.number, o.paid_at, a.order_id, a.created_at from orders o join orders_razorpay_attempts a on a._parent_id = o.id
		  where o.number = any($1::text[]) and o.paid_at is not null and a.created_at > o.paid_at`,
		[nums]
	);
	for (const x of late) out.push(`${x.number}: Razorpay order ${x.order_id} opened ${new Date(x.created_at) - new Date(x.paid_at)} ms after the order was paid`);
	const fo = w.coupons.filter((x) => x.firstOrderOnly);
	if (fo.length) {
		const claims = await c.db.query(
			`select o.number, o.contact_email as email, o.contact_phone as phone from coupon_redemptions r join orders o on o.id = r.order_id
			  where r.coupon_id = any($1::int[]) and r.status in ('reserved','consumed')
			    and not exists (select 1 from orders_status_history h where h._parent_id = o.id and h."from" = 'expired' and h."to" in ('paid','needs_review'))`,
			[fo.map((x) => x.id)]
		);
		for (const [i, email] of w.emails.entries()) {
			const mine = claims.filter((x) => x.email === email || x.phone === w.phones[i]);
			if (mine.length > 1) out.push(`customer ${i}: ${mine.length} first-order claims at once (${mine.map((x) => x.number).join(', ')})`);
		}
	}
	if (final) {
		const refunds = await c.db.query(
			`select o.number, r.payment_id, r.refund_id, r.status, r.reason, r.amount_paise::int as amount from orders_refunds r join orders o on o.id = r._parent_id where o.number = any($1::text[])`,
			[nums]
		);
		const byPay = new Map();
		for (const r of refunds) byPay.set(r.payment_id, [...(byPay.get(r.payment_id) ?? []), r]);
		for (const [pid, list] of byPay) {
			const auto = list.filter((r) => r.reason !== 'external' && r.status !== 'failed');
			if (auto.length > 1) out.push(`${list[0].number}: ${auto.length} automatic refunds of ${pid}`);
			const paid = w.payments.find((p) => p.id === pid)?.amount;
			const done = list.filter((r) => r.status === 'processed' && r.refund_id).reduce((a, r) => a + r.amount, 0);
			if (paid && done > paid) out.push(`${list[0].number}: ${done} refunded of a ${paid} payment ${pid}`);
		}
		// Goods only leave (packed/shipped/delivered) while the order may be fulfilled ($shared canFulfil).
		const hist = await c.db.query(
			`select o.number, h.field, h."from" as f, h."to" as t from orders o join orders_status_history h on h._parent_id = o.id
			  where o.number = any($1::text[]) order by o.number, h._order`,
			[nums]
		);
		const cur = new Map();
		for (const h of hist) {
			if (h.field === 'status') cur.set(h.number, h.t);
			else if (h.field === 'fulfilmentStatus' && ['packed', 'shipped', 'delivered'].includes(h.t) && !canFulfil(cur.get(h.number)))
				out.push(`${h.number}: fulfilment ${h.f} → ${h.t} while the order was ${cur.get(h.number)}`);
		}
		const bad = await c.db.query(`select number, payment_status from orders where number = any($1::text[]) and status = 'paid' and payment_status not in ('authorized','captured')`, [nums]);
		for (const x of bad) out.push(`${x.number}: paid with payment status ${x.payment_status}`);
	}
	for (const v of out) w.violations.push({ at: label, v });
	return out;
}

export async function runPlanR3(c, plan, { seed = 1, stock = 10, log = () => {} } = {}) {
	const w = await setupWorld(c, { seed, stock, slugs: ['steel-cut-oats', 'choco-flakes'] });
	// Two first-order-only offers (a personal welcome code and a store-wide one): the rule is per customer.
	for (const n of [0, 1]) {
		const code = `HCFO${seed % 1000}${crypto.randomBytes(3).toString('hex').toUpperCase()}${n}`;
		const r = await c.adminReq('POST', 'coupons?depth=0', { code, type: 'fixed', value: 1500 + n * 500, active: true, usedCount: 0, firstOrderOnly: true });
		if (r.status !== 201 && r.status !== 200) throw new Error(`first-order coupon: ${r.status} ${r.text.slice(0, 200)}`);
		w.coupons.push({ id: (r.json.doc ?? r.json).id, code, usageLimit: null, firstOrderOnly: true });
	}
	for (const [b, burst] of plan.entries()) {
		const results = await Promise.all(
			burst.map((p) =>
				OPS_R3[p.op](c, w, p.a).catch((err) => {
					w.violations.push({ at: `burst ${b}`, v: `op ${p.op} threw: ${err.stack?.split('\n').slice(0, 3).join(' | ')}` });
					return `THREW ${err.message}`;
				})
			)
		);
		for (const [i, p] of burst.entries()) log(`  [${b}] ${p.op}: ${results[i]}`);
		const before = w.violations.length;
		await checkAlways(c, w, `after burst ${b}`);
		await checkR3(c, w, `after burst ${b}`);
		const fresh = w.violations.splice(before);
		for (const v of await documented(c, w, fresh.map((x) => x.v))) {
			w.violations.push({ at: `after burst ${b}`, v });
			log(`  !! ${v}`);
		}
	}
	await quiesce(c, w);
	const before = w.violations.length;
	await checkAlways(c, w, 'final');
	await checkFinal(c, w, 'final');
	await checkR3(c, w, 'final', { final: true });
	const fresh = w.violations.splice(before);
	for (const v of await documented(c, w, fresh.map((x) => x.v))) {
		w.violations.push({ at: 'final', v });
		log(`  !! final: ${v}`);
	}
	return w;
}
