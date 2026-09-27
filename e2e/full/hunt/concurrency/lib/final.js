/*
 * End-of-run invariants (after quiescence): money kept at most once and only on an order that took it,
 * exactly one confirmation email per ever-confirmed order, refill jobs at most one per (order, stamp).
 */
import { paymentEntity } from './client.js';
import { CONFIRMED } from './world.js';

export async function checkFinal(c, w, label = 'final') {
	const out = [];
	const nums = w.orders.map((o) => o.number);
	const orders = await c.db.query(
		`select id, number, status, payment_method, razorpay_payment_id as pid, stock_state, household_size from orders where number = any($1::text[])`,
		[nums]
	);
	const refunds = await c.db.query(
		`select o.number, r.payment_id, r.status, r.reason from orders_refunds r join orders o on o.id = r._parent_id where o.number = any($1::text[])`,
		[nums]
	);
	const hist = await c.db.query(
		`select o.number, h."to" as t from orders_status_history h join orders o on o.id = h._parent_id where h.field = 'status' and o.number = any($1::text[])`,
		[nums]
	);
	const logs = await c.db.query(`select key, status from message_log where key like any($1::text[])`, [nums.map((n) => `%:${n}%`)]);
	const jobs = await c.db.query(`select input->>'number' as number, input->>'stamp' as stamp from payload_jobs where task_slug::text = 'refillReminder' and input->>'number' = any($1::text[])`, [nums]);

	const everConfirmed = new Set(hist.filter((h) => CONFIRMED.includes(h.t)).map((h) => h.number));
	for (const o of orders) {
		// money: every authorised/captured payment we made is either the order's payment or refunded
		const money = w.payments.filter((p) => p.number === o.number && p.money);
		const refunded = new Set(refunds.filter((r) => r.number === o.number).map((r) => r.payment_id));
		const kept = money.filter((p) => !refunded.has(p.id));
		if (kept.length > 1) out.push(`${o.number} (${o.status}): ${kept.length} payments kept without a refund: ${kept.map((p) => p.id).join(', ')}`);
		for (const p of kept) {
			if (p.id !== o.pid) out.push(`${o.number} (${o.status}): payment ${p.id} kept but the order's payment is ${o.pid}`);
			else if (!['paid', 'partially_refunded', 'refunded', 'needs_review'].includes(o.status)) out.push(`${o.number}: money ${p.id} kept on a ${o.status} order`);
		}
		if (o.status === 'paid' && !o.pid) out.push(`${o.number}: paid without a payment id`);
		// emails
		const confirms = logs.filter((l) => l.key === `confirm:${o.number}`);
		if (everConfirmed.has(o.number) && confirms.length !== 1) out.push(`${o.number}: ever confirmed but ${confirms.length} confirm:${o.number} rows`);
		if (!everConfirmed.has(o.number) && confirms.length) out.push(`${o.number}: never confirmed but has a confirmation email`);
		const stamps = jobs.filter((j) => j.number === o.number).map((j) => j.stamp);
		if (new Set(stamps).size !== stamps.length) out.push(`${o.number}: duplicate refill jobs ${JSON.stringify(stamps)}`);
		// held stock only for orders that can still ship or be paid
		if (['cancelled', 'expired'].includes(o.status) && o.stock_state !== 'released' && o.payment_method === 'online')
			out.push(`${o.number}: ${o.status} but stock ${o.stock_state}`);
		if (['pending_payment', 'payment_failed'].includes(o.status) && o.stock_state !== 'reserved') out.push(`${o.number}: ${o.status} but stock ${o.stock_state}`);
		if (['paid', 'cod_pending', 'cod_confirmed'].includes(o.status) && o.stock_state !== 'committed') out.push(`${o.number}: ${o.status} but stock ${o.stock_state}`);
	}
	for (const v of out) w.violations.push({ at: label, v });
	return out;
}

/** Wait for in-flight webhooks/effects, reconcile every order once, run the jobs queue. */
export async function quiesce(c, w, { waitMs = 1500 } = {}) {
	await c.clearFaults();
	await new Promise((r) => setTimeout(r, waitMs));
	// Razorpay retries webhooks until they are acknowledged: deliver each payment's final state once more.
	for (const p of w.payments) {
		const status = p.money ? p.status : 'failed';
		const event = status === 'failed' ? 'payment.failed' : status === 'authorized' ? 'payment.authorized' : 'payment.captured';
		await c.webhook(event, { payment: paymentEntity({ id: p.id, orderId: p.rz, amount: p.amount, status, wfOrder: p.number }) });
	}
	await new Promise((r) => setTimeout(r, 500));
	for (const o of w.orders) await c.reconcile(o.number);
	await new Promise((r) => setTimeout(r, 800));
	await c.runJobs();
	await new Promise((r) => setTimeout(r, 400));
}
