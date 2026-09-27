/*
 * vercel.json `headers` (hunt w5-security storefront-headers): the storefront's
 * only source of response headers on Vercel. These checks keep the policy
 * consistent with the code it has to allow; e2e/ui/security-headers.spec.js
 * serves the built pages with these headers (the report-only CSP enforced) and
 * walks them, checkout and Razorpay included.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RAZORPAY_SCRIPT_ORIGIN } from '../../src/lib/checkout/razorpay.js';

const vercel = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
const rule = (vercel.headers ?? []).find((r) => r.source === '/(.*)');
const headers = new Map((rule?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]));

/** Directive → list of sources. */
const csp = (value = '') =>
	new Map(
		value
			.split(';')
			.map((d) => d.trim().split(/\s+/))
			.filter((d) => d[0])
			.map(([name, ...sources]) => [name.toLowerCase(), sources])
	);
const enforced = csp(headers.get('content-security-policy'));
const reportOnly = csp(headers.get('content-security-policy-report-only'));
const CSP_COLLECTOR = '/api/store/csp-report';

describe('vercel.json security headers', () => {
	it('one rule for every path, each header once, no conditions', () => {
		expect(rule, 'a headers rule with source "/(.*)"').toBeTruthy();
		expect(rule.has ?? rule.missing).toBeUndefined();
		expect(headers.size).toBe(rule.headers.length);
		for (const [key, value] of headers) expect(value, key).toMatch(/^[\x20-\x7e]+$/); // one printable ASCII line
	});

	it('framing is refused twice over: X-Frame-Options DENY and frame-ancestors none (enforced)', () => {
		expect(headers.get('x-frame-options')).toBe('DENY');
		expect(enforced.get('frame-ancestors')).toEqual(["'none'"]);
	});

	it('the enforced CSP is never stricter than the report-only one it is being rolled out from', () => {
		expect(reportOnly.size).toBeGreaterThan(0);
		for (const [name, sources] of enforced) expect(reportOnly.get(name), name).toEqual(sources);
	});

	it("the report-only CSP allows Razorpay Checkout's script, iframe and form POST (razorpay.md §10)", () => {
		expect(reportOnly.get('script-src')).toContain(RAZORPAY_SCRIPT_ORIGIN);
		expect(reportOnly.get('script-src')).toContain('https://cdn.razorpay.com');
		expect(reportOnly.get('frame-src')).toContain('https://api.razorpay.com');
		expect(reportOnly.get('connect-src')).toContain('https://lumberjack.razorpay.com');
		expect(reportOnly.get('form-action')).toContain('https://api.razorpay.com');
	});

	it('form-action allows the CMS origin the /api rewrite points at (redirect-mode callback_url POST)', () => {
		const api = vercel.rewrites.find((r) => r.source.startsWith('/api/'));
		expect(reportOnly.get('form-action')).toContain(new URL(api.destination.replace(/:path\*$/, '')).origin);
	});

	it('the report-only CSP reports to the CMS collector, same origin through the /api rewrite (hunt csp-reporting)', () => {
		// report-uri for Firefox/Safari; Chromium uses report-to (and then ignores report-uri), HTTPS only.
		expect(reportOnly.get('report-uri')).toEqual([CSP_COLLECTOR]);
		expect(reportOnly.get('report-to')).toEqual(['csp']);
		expect(headers.get('reporting-endpoints')).toBe(`csp="${CSP_COLLECTOR}"`);
		const api = vercel.rewrites.find((r) => r.source.startsWith('/api/'));
		expect(api.source).toBe('/api/:path*');
		expect(CSP_COLLECTOR.startsWith('/api/')).toBe(true);
		// The CMS serves exactly that path (root custom endpoints mount at /api<path>).
		const cms = fs.readFileSync(new URL('../../cms/src/endpoints/csp/index.ts', import.meta.url), 'utf8');
		expect(cms).toContain(`export const CSP_REPORT_PATH = '${CSP_COLLECTOR.replace(/^\/api/, '')}'`);
		expect(fs.readFileSync(new URL('../../cms/src/endpoints/index.ts', import.meta.url), 'utf8')).toMatch(/\.\.\.cspEndpoints/);
		// The enforced policy has no collector of its own: a framing site could flood it.
		expect(enforced.has('report-uri') || enforced.has('report-to')).toBe(false);
	});

	it('no eval, no wildcard hosts, no plugins, no <base> hijack', () => {
		for (const name of ['default-src', 'script-src', 'connect-src', 'frame-src', 'form-action']) {
			const sources = reportOnly.get(name) ?? [];
			expect(sources, name).not.toContain("'unsafe-eval'");
			expect(sources.filter((s) => s === '*' || s.includes('*.') || s === 'https:'), name).toEqual([]);
		}
		expect(reportOnly.get('object-src')).toEqual(["'none'"]);
		expect(reportOnly.get('base-uri')).toEqual(["'self'"]);
	});

	it('Permissions-Policy: camera/microphone/geolocation off; payment for this page and every Razorpay frame it may embed', () => {
		const pp = new Map(
			headers
				.get('permissions-policy')
				.split(/,\s*(?=[a-z-]+=)/)
				.map((entry) => {
					const m = /^([a-z-]+)=\(([^)]*)\)$/.exec(entry.trim());
					expect(m, `malformed entry ${entry}`).not.toBeNull();
					return [m[1], m[2].split(/\s+/).filter(Boolean)];
				})
		);
		for (const f of ['camera', 'microphone', 'geolocation']) expect(pp.get(f), f).toEqual([]);
		expect(pp.get('payment')[0]).toBe('self');
		for (const origin of reportOnly.get('frame-src')) expect(pp.get('payment'), origin).toContain(JSON.stringify(origin));
	});

	it('nosniff and a Referrer-Policy that keeps paths (the /order guest token) on this origin', () => {
		expect(headers.get('x-content-type-options')).toBe('nosniff');
		expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
	});
});
