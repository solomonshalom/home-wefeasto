/*
 * Wave 5 runner: the round-3 world (two products, two limited coupons, two first-order-only offers, three
 * customers sharing phones/emails) driven by OPS_W5 in bursts under Promise.all, with the round-1 always-
 * invariants after every burst and checkFinal + checkW5 after quiescence. `skipKinds` drops violation kinds
 * already reported (e.g. /review alert erased/) so a run can look past them.
 */
import crypto from 'node:crypto';
import { checkFinal, quiesce } from '../../concurrency/lib/final.js';
import { checkAlways, rng, setupWorld } from '../../concurrency/lib/world.js';
import { checkW5, documentedW5 } from './invariants-w5.js';
import { OPS_W5, WEIGHTS_W5 } from './ops-w5.js';

export function makePlanW5(seed, { bursts = 40, maxBurst = 5, weights = WEIGHTS_W5, only } = {}) {
	const r = rng(seed * 104729 + 7);
	const table = Object.entries(weights).flatMap(([op, n]) => Array(n).fill(op));
	const plan = [
		[
			{ op: 'checkout', a: [r.int(3), r.int(3), 0, r.int(4), r.int(2)] },
			{ op: 'firstOrder', a: [r.int(3), r.int(3), 0] },
			{ op: 'checkout', a: [r.int(3), r.int(3), 1, 2, 0] }
		],
		[{ op: 'pay', a: [0, 0, 1, 1] }, { op: 'pay', a: [1, 0, 2, 1] }]
	];
	for (let b = 0; b < bursts; b++) {
		plan.push(Array.from({ length: 1 + r.int(maxBurst) }, () => ({ op: only ? r.pick(only) : r.pick(table), a: Array.from({ length: 5 }, () => r.int(1000)) })));
	}
	return plan;
}

async function setupW5(c, seed) {
	const w = await setupWorld(c, { seed, stock: 12, slugs: ['steel-cut-oats', 'choco-flakes'] });
	for (const n of [0, 1]) {
		const code = `W5FO${seed % 1000}${crypto.randomBytes(3).toString('hex').toUpperCase()}${n}`;
		const r = await c.adminReq('POST', 'coupons?depth=0', { code, type: 'fixed', value: 1500 + n * 500, active: true, usedCount: 0, firstOrderOnly: true });
		if (r.status !== 201 && r.status !== 200) throw new Error(`first-order coupon: ${r.status} ${r.text.slice(0, 200)}`);
		w.coupons.push({ id: (r.json.doc ?? r.json).id, code, usageLimit: null, firstOrderOnly: true });
	}
	// Remember every webhook event id we deliver (they must all end processed).
	w.eventIds = [];
	const hook = c.webhook.bind(c);
	c.webhook = async (...args) => {
		const r = await hook(...args);
		w.eventIds.push(r.eventId);
		return r;
	};
	return w;
}

async function checkpoint(c, w, label, { final = false, skipKinds = [], log }) {
	const before = w.violations.length;
	await checkAlways(c, w, label);
	if (final) await checkFinal(c, w, label);
	await checkW5(c, w, label, { final });
	const fresh = w.violations.splice(before).map((x) => x.v);
	for (const v of await documentedW5(c, w, fresh)) {
		if (skipKinds.some((re) => re.test(v))) continue;
		w.violations.push({ at: label, v });
		log(`  !! ${label}: ${v}`);
	}
}

export async function runPlanW5(c, plan, { seed = 1, log = () => {}, skipKinds = [] } = {}) {
	const w = await setupW5(c, seed);
	for (const [b, burst] of plan.entries()) {
		const results = await Promise.all(
			burst.map((p) =>
				OPS_W5[p.op](c, w, p.a).catch((err) => {
					w.violations.push({ at: `burst ${b}`, v: `op ${p.op} threw: ${err.stack?.split('\n').slice(0, 3).join(' | ')}` });
					return `THREW ${err.message}`;
				})
			)
		);
		for (const [i, p] of burst.entries()) log(`  [${b}] ${p.op}: ${results[i]}`);
		await checkpoint(c, w, `after burst ${b}`, { skipKinds, log });
	}
	await quiesce(c, w);
	await checkpoint(c, w, 'final', { final: true, skipKinds, log });
	return w;
}
