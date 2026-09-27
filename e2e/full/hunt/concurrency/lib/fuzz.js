/*
 * Seeded model-based fuzzer: generate a plan (bursts of ops), run each burst with Promise.all against the
 * live CMS, check the always-invariants after every burst and the final ones after quiescence. A failing
 * plan can be re-run (runPlan) and shrunk (shrink) by dropping bursts / ops while it still fails.
 */
import { checkFinal, quiesce } from './final.js';
import { OPS, WEIGHTS } from './ops.js';
import { checkAlways, rng, setupWorld } from './world.js';

export function makePlan(seed, { bursts = 40, maxBurst = 4, weights = WEIGHTS } = {}) {
	const r = rng(seed);
	const table = Object.entries(weights).flatMap(([op, n]) => Array(n).fill(op));
	const plan = [];
	// a few checkouts first so the other ops have something to act on
	plan.push([{ op: 'checkout', a: [r.int(3), r.int(3), 0, r.int(4), r.int(2)] }, { op: 'checkout', a: [r.int(3), r.int(3), r.int(3), r.int(4), r.int(2)] }]);
	for (let b = 0; b < bursts; b++) {
		const n = 1 + r.int(maxBurst);
		plan.push(Array.from({ length: n }, () => ({ op: r.pick(table), a: Array.from({ length: 5 }, () => r.int(1000)) })));
	}
	return plan;
}

export async function runPlan(c, plan, { seed = 1, stock = 8, log = () => {}, stopOnViolation = false, world, isolateAdmin = false } = {}) {
	const w = world ?? (await setupWorld(c, { seed, stock }));
	w.isolateAdmin = isolateAdmin;
	for (const [b, burst] of plan.entries()) {
		const solo = isolateAdmin && burst.some((p) => p.op === 'admin');
		const ops = solo ? burst.filter((p) => p.op === 'admin').slice(0, 1) : burst;
		const results = await Promise.all(
			ops.map((p) =>
				OPS[p.op](c, w, p.a).catch((err) => {
					w.violations.push({ at: `burst ${b}`, v: `op ${p.op} threw: ${err.stack?.split('\n').slice(0, 3).join(' | ')}` });
					return `THREW ${err.message}`;
				})
			)
		);
		w.trace.push({ burst: b, ops: ops.map((p, i) => `${p.op}: ${results[i]}`) });
		for (const line of w.trace.at(-1).ops) log(`  [${b}] ${line}`);
		const v = await checkAlways(c, w, `after burst ${b}`);
		for (const x of v) log(`  !! ${x}`);
		if (v.length && stopOnViolation) return w;
	}
	await quiesce(c, w);
	const a = await checkAlways(c, w, 'final');
	const f = await checkFinal(c, w, 'final');
	for (const x of [...a, ...f]) log(`  !! ${x}`);
	return w;
}

/** Normalises a violation to its kind (numbers / ids stripped), so shrinking keeps the same failure. */
export const kindOf = (v) => v.replace(/WF-\d+/g, 'WF-#').replace(/pay_\w+/g, 'pay_#').replace(/\d+/g, '#');

/**
 * Greedy shrink: drop whole bursts, then single ops, keeping any change that still reproduces `target`
 * (a violation kind) within `tries` runs (the failure may be timing-dependent).
 */
export async function shrink(c, plan, target, { seed, stock, tries = 3, log = () => {} } = {}) {
	const fails = async (p) => {
		for (let t = 0; t < tries; t++) {
			const w = await runPlan(c, p, { seed, stock });
			if (w.violations.some((x) => kindOf(x.v) === target)) return true;
		}
		return false;
	};
	let cur = plan;
	for (let i = cur.length - 1; i >= 1; i--) {
		const cand = cur.filter((_, j) => j !== i);
		if (await fails(cand)) {
			cur = cand;
			log(`shrink: dropped burst ${i} → ${cur.length} bursts`);
		}
	}
	for (let i = cur.length - 1; i >= 0; i--) {
		for (let k = cur[i].length - 1; k >= 0 && cur[i].length > 1; k--) {
			const cand = cur.map((b, j) => (j === i ? b.filter((_, x) => x !== k) : b));
			if (await fails(cand)) {
				cur = cand;
				log(`shrink: dropped op ${i}.${k}`);
			}
		}
	}
	return cur;
}
