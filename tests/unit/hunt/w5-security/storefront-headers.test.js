/*
 * HUNT w5-security (sf-core): the production storefront (Vercel, vercel.json) sends no security headers.
 *
 * The storefront is a static site on Vercel; its only response-header source is vercel.json `headers`
 * (adapter-static cannot set headers, and `frame-ancestors` does not work in a <meta> CSP). vercel.json
 * has no `headers` entry at all, so /login, /account, /checkout and /order (guest token in the URL) are:
 *   - frameable by any site (no X-Frame-Options / CSP frame-ancestors; ASVS V14.4.7),
 *   - served without X-Content-Type-Options: nosniff (V14.4.4),
 *   - without an explicit Referrer-Policy (V14.4.6) or Permissions-Policy,
 *   - without any CSP, not even the report-only one research/razorpay.md §10 recommends for the payment
 *     page (PCI DSS 4.x 6.4.3 / 11.6.1 script inventory on the page that opens Razorpay Checkout).
 * The CMS origin already sends nosniff / Referrer-Policy / X-Frame-Options (cms/next.config.ts); only
 * /api/* responses proxied through the rewrite carry them on the storefront origin.
 *
 * Run: npx vitest run tests/unit/hunt/w5-security/storefront-headers.test.js
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const vercel = JSON.parse(fs.readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8'));

/** Vercel `source` patterns that match every page (path-to-regexp style). */
const ALL_PAGES = new Set(['/(.*)', '/:path*', '/:path(.*)', '/(.*)?']);

/** Header name (lower-case) → value, for the rules that apply to every page. */
function pageHeaders() {
	const out = new Map();
	for (const rule of Array.isArray(vercel.headers) ? vercel.headers : []) {
		if (!ALL_PAGES.has(rule.source) || rule.has || rule.missing) continue;
		for (const { key, value } of rule.headers ?? []) out.set(String(key).toLowerCase(), String(value));
	}
	return out;
}

/** Directive → value of a CSP string. */
const directives = (csp = '') =>
	new Map(
		csp
			.split(';')
			.map((d) => d.trim())
			.filter(Boolean)
			.map((d) => {
				const [name, ...rest] = d.split(/\s+/);
				return [name.toLowerCase(), rest.join(' ')];
			})
	);

describe('storefront security headers (vercel.json)', () => {
	const h = pageHeaders();

	it('refuses to be framed by other sites (X-Frame-Options or CSP frame-ancestors)', () => {
		const xfo = (h.get('x-frame-options') ?? '').toUpperCase();
		const ancestors = directives(h.get('content-security-policy')).get('frame-ancestors') ?? '';
		const ok = xfo === 'DENY' || xfo === 'SAMEORIGIN' || /^('none'|'self')$/.test(ancestors.trim());
		expect(ok, `every page needs X-Frame-Options or frame-ancestors; got ${JSON.stringify(Object.fromEntries(h))}`).toBe(true);
	});

	it('sends X-Content-Type-Options: nosniff', () => {
		expect(h.get('x-content-type-options')).toBe('nosniff');
	});

	it('sets an explicit Referrer-Policy that never sends the full URL cross-origin', () => {
		expect(['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin']).toContain(h.get('referrer-policy'));
	});

	it('sets a Permissions-Policy', () => {
		expect(h.get('permissions-policy') ?? '').not.toBe('');
	});

	it('ships a report-only CSP that already allows Razorpay Checkout (razorpay.md §10)', () => {
		const csp = directives(h.get('content-security-policy-report-only') ?? h.get('content-security-policy'));
		expect(csp.size, 'no Content-Security-Policy(-Report-Only) header at all').toBeGreaterThan(0);
		expect(csp.get('script-src') ?? '').toContain('https://checkout.razorpay.com');
		expect(csp.get('frame-src') ?? '').toContain('https://api.razorpay.com');
		expect(csp.get('object-src') ?? '').toContain("'none'");
		expect(csp.get('base-uri') ?? '').toMatch(/'self'|'none'/);
	});
});
