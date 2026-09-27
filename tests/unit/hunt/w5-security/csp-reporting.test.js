/*
 * HUNT w5-security r2 (sf-core): the storefront's report-only CSP has nowhere to report to.
 *
 * vercel.json ships `Content-Security-Policy-Report-Only` so the owner can find out, before enforcing, what
 * the real payment page loads (research/razorpay.md §10: "Roll it out as Content-Security-Policy-Report-Only
 * first"; PCI DSS 4.x 6.4.3 / 11.6.1 script inventory). A report-only policy with no `report-uri` /
 * `report-to` only prints to each shopper's own DevTools console: nothing ever reaches the owner, so the
 * rollout can never gather the evidence it exists for, and a script injected into /checkout goes unnoticed.
 *
 * Correct: the report-only policy names a collector (`report-uri <url>`, or `report-to <group>` with a
 * matching `Reporting-Endpoints` header on the same rule).
 *
 * Run: npx vitest run tests/unit/hunt/w5-security/csp-reporting.test.js
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const vercel = JSON.parse(fs.readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8'));

const ALL_PAGES = new Set(['/(.*)', '/:path*', '/:path(.*)', '/(.*)?']);

function pageHeaders() {
	const out = new Map();
	for (const rule of Array.isArray(vercel.headers) ? vercel.headers : []) {
		if (!ALL_PAGES.has(rule.source) || rule.has || rule.missing) continue;
		for (const { key, value } of rule.headers ?? []) out.set(String(key).toLowerCase(), String(value));
	}
	return out;
}

const directives = (csp = '') =>
	new Map(
		csp
			.split(';')
			.map((d) => d.trim())
			.filter(Boolean)
			.map((d) => {
				const [name, ...rest] = d.split(/\s+/);
				return [name.toLowerCase(), rest.join(' ').trim()];
			})
	);

describe('storefront report-only CSP (vercel.json)', () => {
	const h = pageHeaders();
	const ro = h.get('content-security-policy-report-only');

	it('exists (precondition)', () => {
		expect(ro, 'no Content-Security-Policy-Report-Only on every page').toBeTruthy();
	});

	it('sends its violation reports somewhere (report-uri, or report-to + Reporting-Endpoints)', () => {
		const csp = directives(ro);
		const uri = csp.get('report-uri') ?? '';
		const group = csp.get('report-to') ?? '';
		const endpoints = h.get('reporting-endpoints') ?? '';
		const viaUri = /^(https:\/\/|\/)\S+/.test(uri);
		const viaGroup = group !== '' && new RegExp(`(^|,)\\s*${group.replace(/[^\w-]/g, '')}\\s*=\\s*"`).test(endpoints);
		expect(
			viaUri || viaGroup,
			`report-only CSP has no collector: report-uri=${JSON.stringify(uri)} report-to=${JSON.stringify(group)} Reporting-Endpoints=${JSON.stringify(endpoints)}`
		).toBe(true);
	});
});
