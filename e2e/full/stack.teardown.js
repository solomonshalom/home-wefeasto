/*
 * 'full-stack-teardown' project: stop the slot's stack after the 'full' specs —
 * only when this run started it (not when E2E_REUSE=1 adopted a running one), and
 * not with E2E_KEEP=1 (leave it up to poke at; stop it later with
 * `npm run e2e:stack -- stop --slot N`).
 */
import fs from 'node:fs';
import { test } from '@playwright/test';
import { stop, slotConfig } from '../../scripts/e2e-stack.mjs';
import { OWNER_MARKER, slotFromEnv } from './stack-owner.js';

test('stop the full stack', async () => {
	const slot = slotFromEnv();
	const cfg = slotConfig(slot);
	const marker = OWNER_MARKER(cfg);
	if (!fs.existsSync(marker)) {
		console.log(`[e2e slot ${slot}] leaving the stack running (it was reused, not started by this run)`);
		return;
	}
	if (/^(1|true|yes)$/i.test(process.env.E2E_KEEP || '')) {
		console.log(`[e2e slot ${slot}] E2E_KEEP=1: leaving the stack running — stop it with: npm run e2e:stack -- stop --slot ${slot}`);
		fs.rmSync(marker, { force: true });
		return;
	}
	await stop(slot);
	fs.rmSync(marker, { force: true });
});
