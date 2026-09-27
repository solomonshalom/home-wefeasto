/*
 * Wave 5 round-2 seeded concurrency fuzzer (lib/fuzz-r2.js): the round-1 model plus Dashboard partial refunds
 * that are created now and settled (processed / failed) later, admin holds, pack attempts and chargeback
 * lifecycles, with the invariant "only a human releases a hold". Opt-in (slow):
 *   HUNT_FUZZ=1 [HUNT_SEEDS=1-3] [HUNT_BURSTS=40] [HUNT_MAX_BURST=5] [HUNT_ONLY=refundLater,settleRefund] [HUNT_SKIP='released by webhook']
 *   E2E_SLOT=N E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-concurrency/fuzz-r2.spec.js
 * The trace (and the plan, for replay) is attached; HUNT_TRACE_DIR also writes it to disk.
 * Minimal repro of what it finds: r2-refund-releases-chargeback-hold.spec.js.
 */
import fs from 'node:fs';
import { test, expect } from '../../fixtures.js';
import { HuntClient } from '../concurrency/lib/client.js';
import { kindOf } from '../concurrency/lib/fuzz.js';
import { makePlanR2, runPlanR2 } from './lib/fuzz-r2.js';

const [from, to] = (process.env.HUNT_SEEDS ?? '1-3').split('-').map(Number);
const seeds = Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);
const only = process.env.HUNT_ONLY ? process.env.HUNT_ONLY.split(',') : undefined;
const skipKinds = process.env.HUNT_SKIP ? process.env.HUNT_SKIP.split('|').map((s) => new RegExp(s)) : [];

test.describe('concurrency fuzzer (wave 5, round 2)', () => {
	test.skip(process.env.HUNT_FUZZ !== '1', 'opt-in: HUNT_FUZZ=1');
	test.setTimeout(20 * 60_000);

	for (const seed of seeds) {
		test(`seed ${seed}`, async ({ stack }, testInfo) => {
			const c = new HuntClient(stack);
			const lines = [];
			try {
				const plan = makePlanR2(seed, { bursts: Number(process.env.HUNT_BURSTS ?? 40), maxBurst: Number(process.env.HUNT_MAX_BURST ?? 5), only });
				const w = await runPlanR2(c, plan, { seed, log: (l) => lines.push(l), skipKinds });
				await testInfo.attach('trace.txt', { body: `${lines.join('\n')}\n\nPLAN ${JSON.stringify(plan)}`, contentType: 'text/plain' });
				expect([...new Set(w.violations.map((v) => kindOf(v.v)))], w.violations.slice(0, 25).map((v) => `${v.at}: ${v.v}`).join('\n')).toEqual([]);
			} finally {
				if (process.env.HUNT_TRACE_DIR) {
					fs.mkdirSync(process.env.HUNT_TRACE_DIR, { recursive: true });
					fs.writeFileSync(`${process.env.HUNT_TRACE_DIR}/r2-seed-${seed}.txt`, lines.join('\n'));
				}
				await c.close();
			}
		});
	}
});
