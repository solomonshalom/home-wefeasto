/*
 * Round-3 seeded concurrency fuzzer (lib/fuzz-r3.js, lib/ops-r3.js): the round-1 model plus refund / dispute
 * webhooks, admin resolve/refund/cancel and coupon edits, supersede-by-reference, first-order-only offers,
 * whole-queue reconcile and jobs runs, with extra invariants (no Razorpay order opened for a paid order, one
 * first-order claim per customer, refunds never doubled). Opt-in (slow):
 *   HUNT_FUZZ=1 [HUNT_SEEDS=1-5] [HUNT_BURSTS=50] [HUNT_WEIGHTS='{"firstOrder":12}'] E2E_SLOT=N E2E_REUSE=1 npx playwright test --project=full \
 *     e2e/full/hunt/concurrency/fuzz-r3.spec.js
 * Traces (and the plan, for replay) are written to test-results as attachments.
 */
import { test, expect } from '../../fixtures.js';
import { HuntClient } from './lib/client.js';
import { kindOf } from './lib/fuzz.js';
import { makePlanR3, runPlanR3 } from './lib/fuzz-r3.js';
import { WEIGHTS_R3 } from './lib/ops-r3.js';

const [from, to] = (process.env.HUNT_SEEDS ?? '1-3').split('-').map(Number);
const seeds = Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);

test.describe('concurrency fuzzer (round 3)', () => {
	test.skip(process.env.HUNT_FUZZ !== '1', 'opt-in: HUNT_FUZZ=1');
	test.setTimeout(15 * 60_000);

	for (const seed of seeds) {
		test(`seed ${seed}`, async ({ stack }, testInfo) => {
			const c = new HuntClient(stack);
			const lines = [];
			try {
				const weights = { ...WEIGHTS_R3, ...JSON.parse(process.env.HUNT_WEIGHTS || '{}') };
				const plan = makePlanR3(seed, { bursts: Number(process.env.HUNT_BURSTS ?? 50), weights });
				const w = await runPlanR3(c, plan, { seed, log: (l) => lines.push(l) });
				await testInfo.attach('trace.txt', { body: `${lines.join('\n')}\n\nPLAN ${JSON.stringify(plan)}`, contentType: 'text/plain' });
				expect([...new Set(w.violations.map((v) => kindOf(v.v)))], w.violations.slice(0, 20).map((v) => `${v.at}: ${v.v}`).join('\n')).toEqual([]);
			} finally {
				if (process.env.HUNT_TRACE_DIR) {
					const fs = await import('node:fs');
					fs.mkdirSync(process.env.HUNT_TRACE_DIR, { recursive: true });
					fs.writeFileSync(`${process.env.HUNT_TRACE_DIR}/seed-${seed}.txt`, lines.join('\n'));
				}
				await c.close();
			}
		});
	}
});
