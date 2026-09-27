/*
 * Which slot this run talks to, and the stack's state.json (written by scripts/e2e-stack.mjs).
 */
import fs from 'node:fs';
import { parseSlot, slotConfig } from '../../../scripts/e2e/config.mjs';

export const SLOT = parseSlot(process.env.E2E_SLOT, 0);
export const CFG = slotConfig(SLOT);

/**
 * The running stack: { slot, cmsUrl, sfUrl, dbUri, admin:{email,password}, cronSecret,
 * mailpitUrl, mock:{webhookDelayMs,lateAuthDelayMs}, pids, startedAt, … }.
 * Throws a helpful error when the slot has no ready stack.
 */
export function readStack() {
	let state;
	try {
		state = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
	} catch {
		throw new Error(
			`no e2e stack state for slot ${SLOT} (${CFG.stateFile}). Run the specs through the 'full' project ` +
				`(npx playwright test --project=full), or start one: npm run e2e:stack -- start --slot ${SLOT}`
		);
	}
	if (state.status !== 'ready') throw new Error(`the e2e stack of slot ${SLOT} is not ready (status ${state.status}); see ${CFG.logsDir}`);
	return state;
}

/** Storefront URL of this slot (from state.json when present; deterministic otherwise). */
export const sfUrl = () => {
	try {
		return readStack().sfUrl;
	} catch {
		return CFG.sfUrl;
	}
};
