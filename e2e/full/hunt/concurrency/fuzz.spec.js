/*
 * The seeded concurrency fuzzer (lib/): random bursts of checkout (online/COD, same/different
 * Idempotency-Keys, supersede by bag+phone), retry, verify, mock payments (success/fail/late/authorize_only,
 * webhooks on/off), signed webhook redeliveries / duplicates / out-of-order snapshots, reconcile, expiry by
 * time travel, admin status/fulfilment edits, admin stock ±N, gateway faults and household answers, run with
 * Promise.all against the slot CMS. Invariants after every burst (one SQL snapshot): stock conservation and
 * never negative, coupon usedCount == consumed and within usageLimit (+ documented snapshot honours), status
 * history continuous and allowed by $shared/order-status.js, no 5xx; after quiescence: money kept at most
 * once and only on an order that took it, one confirmation email per ever-confirmed order, one refill job
 * per (order, stamp).
 *
 * Opt-in (it is slow and, today, finds HUNT-CONC-1..3): HUNT_FUZZ=1 [HUNT_SEEDS=1-5] [HUNT_BURSTS=40]
 * [HUNT_WEIGHTS='{"household":0}'] [HUNT_ISO_ADMIN=1] E2E_SLOT=N E2E_REUSE=1 npx playwright test --project=full
 * e2e/full/hunt/concurrency/fuzz.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { HuntClient } from './lib/client.js';
import { kindOf, makePlan, runPlan } from './lib/fuzz.js';
import { WEIGHTS } from './lib/ops.js';

const [from, to] = (process.env.HUNT_SEEDS ?? '1-3').split('-').map(Number);
const seeds = Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);

test.describe('concurrency fuzzer', () => {
	test.skip(process.env.HUNT_FUZZ !== '1', 'opt-in: HUNT_FUZZ=1');
	test.setTimeout(10 * 60_000);

	for (const seed of seeds) {
		test(`seed ${seed}`, async ({ stack }, testInfo) => {
			const c = new HuntClient(stack);
			try {
				const weights = { ...WEIGHTS, ...JSON.parse(process.env.HUNT_WEIGHTS || '{}') };
				const plan = makePlan(seed, { bursts: Number(process.env.HUNT_BURSTS ?? 40), maxBurst: 5, weights });
				const lines = [];
				const w = await runPlan(c, plan, { seed, isolateAdmin: process.env.HUNT_ISO_ADMIN === '1', log: (l) => lines.push(l) });
				await testInfo.attach('trace.txt', { body: `${lines.join('\n')}\n\nPLAN ${JSON.stringify(plan)}`, contentType: 'text/plain' });
				expect([...new Set(w.violations.map((v) => kindOf(v.v)))], w.violations.slice(0, 20).map((v) => `${v.at}: ${v.v}`).join('\n')).toEqual([]);
			} finally {
				await c.close();
			}
		});
	}
});
