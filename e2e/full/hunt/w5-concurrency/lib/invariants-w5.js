/*
 * Wave 5 invariants (on top of world.js checkAlways and final.js checkFinal):
 *   R3 carry-overs  no Razorpay order opened after paid; one first-order claim per customer; at most one
 *                   live automatic refund per payment, never more refunded than paid; goods leave only while
 *                   canFulfil; a paid order's payment status is authorized/captured
 *   coupon/order    a redemption's state matches its order: consumed ⇔ the order was ever paid/confirmed with
 *                   money (online) ; released for cancelled/expired orders that never took it; one row per order
 *   review alerts   a line the SYSTEM wrote into reviewReason is never removed (no admin op edits the field)
 *   events          every webhook event row we delivered ends processed (a stuck row = a 5xx or a crash)
 *   emails          ship:<no> only for orders that were ever shipped; refund:<id> only for refunds on record
 * Documented behaviour is filtered like fuzz-r3.js: a LATE payment on an expired order consumes its released
 * coupon use unchecked; money kept on an order an admin cancelled by hand.
 */
import { canFulfil } from '../../../../../cms/src/commerce/shared/order-status.js';

const lines = (s) => String(s ?? '').split('\n').map((x) => x.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean);

export async function checkW5(c, w, label, { final = false } = {}) {
	const out = [];
	const nums = w.orders.map((o) => o.number);
	for (const x of await c.db.query(
		`select o.number, a.order_id from orders o join orders_razorpay_attempts a on a._parent_id = o.id
		  where o.number = any($1::text[]) and o.paid_at is not null and a.created_at > o.paid_at + interval '50 milliseconds'`,
		[nums]
	))
		out.push(`${x.number}: Razorpay order ${x.order_id} opened after the order was paid`);
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
	// review alerts: every system-written line stays
	w.reasons ??= new Map();
	for (const r of await c.db.query(`select number, review_reason from orders where number = any($1::text[])`, [nums])) {
		const now = new Set(lines(r.review_reason));
		const seen = w.reasons.get(r.number) ?? new Set();
		for (const l of seen) if (!now.has(l)) out.push(`${r.number}: review alert erased: "${l.slice(0, 90)}"`);
		w.reasons.set(r.number, new Set([...seen, ...now]));
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
		const hist = await c.db.query(
			`select o.number, h.field, h."from" as f, h."to" as t from orders o join orders_status_history h on h._parent_id = o.id where o.number = any($1::text[]) order by o.number, h._order`,
			[nums]
		);
		const cur = new Map();
		const ever = new Map();
		for (const h of hist) {
			if (h.field === 'status') {
				cur.set(h.number, h.t);
				ever.set(h.number, new Set([...(ever.get(h.number) ?? []), h.t]));
			} else if (h.field === 'fulfilmentStatus' && ['packed', 'shipped'].includes(h.t) && !canFulfil(cur.get(h.number)))
				out.push(`${h.number}: fulfilment ${h.f} → ${h.t} while the order was ${cur.get(h.number)}`);
			if (h.field === 'fulfilmentStatus') ever.set(h.number, new Set([...(ever.get(h.number) ?? []), `f:${h.t}`]));
		}
		for (const x of await c.db.query(`select number, payment_status from orders where number = any($1::text[]) and status = 'paid' and payment_status not in ('authorized','captured')`, [nums]))
			out.push(`${x.number}: paid with payment status ${x.payment_status}`);
		// coupon redemptions vs their orders
		const red = await c.db.query(
			`select o.number, o.status, o.payment_method as pm, count(r.id)::int as n, string_agg(r.status::text, ',') as st
			   from orders o join coupon_redemptions r on r.order_id = o.id where o.number = any($1::text[]) group by o.number, o.status, o.payment_method`,
			[nums]
		);
		for (const r of red) {
			if (r.n > 1) out.push(`${r.number}: ${r.n} coupon redemption rows (${r.st})`);
			if (r.pm !== 'online') continue; // COD uses stay reserved until an admin cancel releases them
			const tookMoney = [...(ever.get(r.number) ?? [])].some((s) => ['paid', 'partially_refunded'].includes(s));
			if (r.st === 'consumed' && !tookMoney) out.push(`${r.number} (${r.status}): coupon use consumed but the order was never paid`);
			if (['paid', 'partially_refunded'].includes(r.status) && r.st !== 'consumed') out.push(`${r.number} (${r.status}): coupon use ${r.st}`);
			if (['cancelled', 'expired'].includes(r.status) && !tookMoney && r.st !== 'released') out.push(`${r.number} (${r.status}): coupon use still ${r.st}`);
		}
		// webhook events end processed
		const ids = (w.eventIds ?? []).filter(Boolean);
		for (const e of await c.db.query(`select event_id, event from payment_events where event_id = any($1::text[]) and processed_at is null`, [ids]))
			out.push(`webhook ${e.event} ${e.event_id} never finished processing`);
		// emails only for things that happened
		const logs = await c.db.query(`select key from message_log where key like any($1::text[])`, [nums.map((n) => `ship:${n}`)]);
		for (const l of logs) {
			const n = l.key.slice(5);
			if (!(ever.get(n) ?? new Set()).has('f:shipped')) out.push(`${n}: shipped email but never shipped`);
		}
	}
	for (const v of out) w.violations.push({ at: label, v });
	return out;
}

/** Violations the round-3 hunt classified as documented behaviour. */
export async function documentedW5(c, w, list) {
	if (!list.some((v) => /^coupon /.test(v) || /kept on a cancelled order/.test(v))) return list;
	const nums = w.orders.map((o) => o.number);
	const late = await c.db.query(
		`select r.coupon_id as id, count(*)::int as n from coupon_redemptions r join orders o on o.id = r.order_id
		  where o.number = any($1::text[]) and r.status = 'consumed'
		    and exists (select 1 from orders_status_history h where h._parent_id = o.id and h.field = 'status' and h."from" = 'expired' and h."to" in ('paid','needs_review'))
		  group by r.coupon_id`,
		[nums]
	);
	const allow = new Map(late.map((x) => [Number(x.id), x.n]));
	const byCode = new Map(w.coupons.map((cp) => [cp.code, allow.get(Number(cp.id)) ?? 0]));
	const adminCancelled = new Set(
		(await c.db.query(`select o.number from orders o join orders_status_history h on h._parent_id = o.id where o.number = any($1::text[]) and h."to" = 'cancelled' and h.source like 'admin:%'`, [nums])).map((x) => x.number)
	);
	return list.filter((v) => {
		const m = /^coupon (\S+): .*(usedCount|used) (\d+)(?: \+ reserved (\d+))? > usageLimit (\d+)/.exec(v);
		if (m) return Number(m[3]) + Number(m[4] ?? 0) > Number(m[5]) + (byCode.get(m[1]) ?? 0);
		const k = /^(WF-\d+): money \S+ kept on a cancelled order/.exec(v);
		return !(k && adminCancelled.has(k[1]));
	});
}
