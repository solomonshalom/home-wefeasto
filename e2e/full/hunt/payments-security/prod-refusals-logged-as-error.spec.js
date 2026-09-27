/*
 * Hunt (payments-security) — on the production build, every routine refusal is logged at ERROR with a
 * full stack trace, so any visitor can flood the error log (and any ERROR alerting) at will.
 *
 * Payload keys `config.loggingLevels` by error NAME and ships defaults that log expected refusals at info:
 * { Forbidden, Locked, MissingFile, NotFound, ValidationError: 'info' } (payload/dist/config/sanitize.js).
 * APIError sets `name = this.constructor.name`, and `next build` minifies the class names (`class u extends
 * APIError`), so in production the lookup misses and logError() falls back to 'error' + stack: a guest's
 * 403 on /api/orders, a signup with a taken email, etc. The project already knows this trap (checkout
 * W2V2-1, e2e-harness "don't match on err.name") and gives its OWN refusals explicit names for exactly
 * this reason (payload.config.ts: "Expected refusals … log at info, not error + stack"), but Payload's
 * built-in refusals were left on the name-keyed defaults, which only work unminified (dev, int tests).
 *
 * Correct behaviour: expected refusals (403 Forbidden, 400 ValidationError) log at info on `next start`,
 * like they do in dev — no ERROR line, no stack.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../fixtures.js';

// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const errorLines = (file, message) =>
	strip(fs.readFileSync(file, 'utf8'))
		.split('\n')
		.filter((l) => /\bERROR\b/.test(l) && l.includes(message)).length;

test('guest refusals (403 Forbidden, 400 ValidationError) are not logged at ERROR on the production build', async ({ stack, unique }) => {
	const log = path.join(stack.logsDir, 'cms.log');
	const FORBIDDEN = 'You are not allowed to perform this action.';
	const INVALID = 'The following field is invalid: email';
	const before = { forbidden: errorLines(log, FORBIDDEN), invalid: errorLines(log, INVALID) };

	// A guest listing orders: Payload's Forbidden (403).
	const forbidden = await fetch(`${stack.cmsUrl}/api/orders?limit=1`);
	expect(forbidden.status).toBe(403);

	// Signing up twice with one email: Payload's ValidationError (400).
	const email = unique.email('hps-log');
	const signup = () =>
		fetch(`${stack.cmsUrl}/api/customers`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password: 'breakfast-club-2026' })
		});
	expect((await signup()).status).toBe(201);
	expect((await signup()).status).toBe(400);

	// Give the server a moment to flush its log.
	await new Promise((r) => setTimeout(r, 750));
	const after = { forbidden: errorLines(log, FORBIDDEN), invalid: errorLines(log, INVALID) };
	expect({ forbidden: after.forbidden - before.forbidden, invalid: after.invalid - before.invalid }).toEqual({ forbidden: 0, invalid: 0 });
});
