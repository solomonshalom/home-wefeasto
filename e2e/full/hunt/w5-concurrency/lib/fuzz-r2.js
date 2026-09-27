/*
 * Wave 5 round-2 runner: the round-1 world and invariants (./fuzz-w5.js) driven by OPS_R2, plus the
 * round-2 invariant checkHold (only a human releases a chargeback / admin hold) after every burst.
 */
import crypto from 'node:crypto';
import { checkFinal, quiesce } from '../../concurrency/lib/final.js';
import { checkAlways, rng, setupWorld } from '../../concurrency/lib/world.js';
import { checkW5, documentedW5 } from './invariants-w5.js';
import { checkHold } from './invariants-r2.js';
import { OPS_R2, WEIGHTS_R2 } from './ops-r2.js';

export function makePlanR2(seed, { bursts = 40, maxBurst = 5, weights = WEIGHTS_R2, only } = {}) {
	const r = rng(seed * 7919 + 13);
	const table = Object.entries(weights).flatMap(([op, n]) => Array(n).fill(op));
	const plan = [
		[
			{ op: 'checkout', a: [r.int(3), r.int(3), 0, r.int(4), r.int(2)] },
			{ op: 'checkout', a: [r.int(3), r.int(3), 1, 2, 0] },
			{ op: 'checkout', a: [r.int(3), r.int(3), 2, 3, 0] }
		],
		[{ op: 'pay', a: [0, 0, 1, 1] }, { op: 'pay', a: [1, 0, 2, 1] }, { op: 'pay', a: [2, 0, 1, 1] }]
	];
	for (let b = 0; b < bursts; b++) {
		plan.push(Array.from({ length: 1 + r.int(maxBurst) }, () => ({ op: only ? r.pick(only) : r.pick(table), a: Array.from({ length: 5 }, () => r.int(1000)) })));
	}
	return plan;
}

async function setupR2(c, seed) {
	const w = await setupWorld(c, { seed, stock: 12, slugs: ['steel-cut-oats', 'choco-flakes'] });
	for (const n of [0, 1]) {
		const code = `W5R2FO${seed % 1000}${crypto.randomBytes(3).toString('hex').toUpperCase()}${n}`;
		const r = await c.adminReq('POST', 'coupons?depth=0', { code, type: 'fixed', value: 1500 + n * 500, active: true, usedCount: 0, firstOrderOnly: true });
		if (r.status !== 201 && r.status !== 200) throw new Error(`first-order coupon: ${r.status} ${r.text.slice(0, 200)}`);
		w.coupons.push({ id: (r.json.doc ?? r.json).id, code, usageLimit: null, firstOrderOnly: true });
	}
	w.eventIds = [];
	const hook = c.webhook.bind(c);
	c.webhook = async (...args) => {
		const res = await hook(...args);
		w.eventIds.push(res.eventId);
		return res;
	};
	return w;
}

async function checkpoint(c, w, label, { final = false, skipKinds = [], log }) {
	const before = w.violations.length;
	await checkAlways(c, w, label);
	if (final) await checkFinal(c, w, label);
	await checkW5(c, w, label, { final });
	await checkHold(c, w, label);
	const fresh = w.violations.splice(before).map((x) => x.v);
	for (const v of await documentedW5(c, w, fresh)) {
		if (skipKinds.some((re) => re.test(v))) continue;
		w.violations.push({ at: label, v });
		log(`  !! ${label}: ${v}`);
	}
}

export async function runPlanR2(c, plan, { seed = 1, log = () => {}, skipKinds = [] } = {}) {
	const w = await setupR2(c, seed);
	for (const [b, burst] of plan.entries()) {
		const results = await Promise.all(
			burst.map((p) =>
				OPS_R2[p.op](c, w, p.a).catch((err) => {
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
