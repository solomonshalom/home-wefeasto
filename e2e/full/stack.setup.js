/*
 * 'full-stack' setup project: start the slot's stack before the 'full' specs run
 * (scripts/e2e-stack.mjs). With E2E_REUSE=1 a healthy running stack is adopted as is
 * (not reset, not stopped afterwards). Durations per step are printed and kept in
 * .e2e/slot-N/state.json; logs in .e2e/slot-N/logs/.
 */
import fs from 'node:fs';
import { test } from '@playwright/test';
import { start, slotConfig } from '../../scripts/e2e-stack.mjs';
import { OWNER_MARKER, slotFromEnv } from './stack-owner.js';

test('start the full stack', async () => {
	const slot = slotFromEnv();
	const cfg = slotConfig(slot);
	const state = await start(slot, { owner: 'playwright' });
	// Teardown stops only a stack this run started.
	if (state.reused) fs.rmSync(OWNER_MARKER(cfg), { force: true });
	else fs.writeFileSync(OWNER_MARKER(cfg), JSON.stringify({ pid: process.ppid, startedAt: state.startedAt }));
});
