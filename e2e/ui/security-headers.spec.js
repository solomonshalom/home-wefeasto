/*
 * The production response headers (vercel.json `headers`, hunt w5-security
 * storefront-headers) applied to the built storefront, so the policy is
 * checked against the real pages before anyone relies on it:
 *
 * - Every same-origin response (not /api, which the CMS answers) gets the
 *   vercel.json headers, like Vercel's `/(.*)` rule. The report-only CSP is
 *   ENFORCED here (merged into Content-Security-Policy): a directive that would
 *   block anything the storefront itself loads fails the spec, so the policy can
 *   be switched to enforcing once production reports are clean.
 * - Pages walked with JS and effects on: home (video, GSAP, Lenis, veil, search,
 *   Mix colors), shop, PDP, recipes, policy pages, login, account, 404, /order,
 *   and checkout → Razorpay (stubbed at https://checkout.razorpay.com) → paid.
 * - Another site cannot frame the storefront (X-Frame-Options / frame-ancestors).
 */
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test, collectErrors } from './helpers.js';
import { mockBackend, stubRazorpay, seedBag, checkoutReady, hydrated, fillForm, payButton } from './checkout-fixtures.js';

const VERCEL = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
const ALL_PAGES = new Set(['/(.*)', '/:path*', '/:path(.*)', '/(.*)?']);
const isApi = (url) => url.pathname === '/api' || url.pathname.startsWith('/api/');

/** vercel.json headers for every page (lower-case names); `enforce` merges the report-only CSP into the enforced one. */
function productionHeaders({ enforce = true } = {}) {
	const h = {};
	for (const rule of VERCEL.headers ?? []) {
		if (!ALL_PAGES.has(rule.source) || rule.has || rule.missing) continue;
		for (const { key, value } of rule.headers) h[key.toLowerCase()] = value;
	}
	const ro = h['content-security-policy-report-only'];
	if (enforce && ro) {
		h['content-security-policy'] = [h['content-security-policy'], ro].filter(Boolean).join(', ');
		delete h['content-security-policy-report-only'];
	}
	return h;
}

/**
 * Serve every same-origin, non-/api response with the production headers (the report-only CSP enforced
 * unless `enforce: false`); collect CSP violations across navigations.
 */
async function likeVercel(context, baseURL, { enforce = true } = {}) {
	const origin = new URL(baseURL).origin;
	const extra = productionHeaders({ enforce });
	const violations = [];
	await context.exposeBinding('__wfCspViolation', ({ page }, v) => violations.push({ page: page.url(), ...v }));
	await context.addInitScript(() => {
		document.addEventListener('securitypolicyviolation', (e) =>
			window.__wfCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, source: `${e.sourceFile}:${e.lineNumber}`, sample: e.sample })
		);
	});
	await context.route(
		(url) => url.origin === origin && !isApi(url),
		async (route) => {
			if (route.request().resourceType() === 'media') return route.fallback(); // range requests; no CSP/nosniff effect
			// A request still in flight when the test ends (or a navigation cancels it) loses its response:
			// never let that escape the handler. A real failure still shows as a failed load on the page.
			try {
				const res = await route.fetch();
				const headers = { ...res.headers(), ...extra };
				for (const k of ['content-encoding', 'content-length', 'transfer-encoding']) delete headers[k];
				await route.fulfill({ status: res.status(), headers, body: await res.body() });
			} catch {
				await route.abort().catch(() => {});
			}
		}
	);
	return violations;
}

/** Scroll through the page (lazy images, the PeepWalk strip) and back. */
async function walk(page) {
	await page.evaluate(async () => {
		const step = Math.max(200, innerHeight - 100);
		for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
			window.scrollTo(0, y);
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		}
		window.scrollTo(0, 0);
	});
	await page.waitForFunction(() => [...document.images].every((i) => i.complete));
}

test('the production headers are served on every page, and the CSP (enforced here) blocks nothing the storefront loads', async ({ context, page, baseURL }) => {
	test.setTimeout(120_000);
	const violations = await likeVercel(context, baseURL);
	const errors = collectErrors(page);

	const res = await page.goto('/');
	const h = res.headers();
	expect(h['x-frame-options']).toBe('DENY');
	expect(h['x-content-type-options']).toBe('nosniff');
	expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
	expect(h['permissions-policy']).toContain('camera=()');
	expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(h['content-security-policy']).toContain('script-src ');
	await hydrated(page);
	await walk(page);
	// search overlay (live results) and the Mix colors toggle (injects a <style>)
	await page.locator('.navbar .wf-search-open').click();
	await page.locator('.wf-search-input').fill('muesli');
	await expect(page.locator('.wf-search-card').first()).toBeVisible();
	await page.keyboard.press('Escape');
	await page.locator('button.wf-colormix').click();
	await expect(page.locator('button.wf-colormix')).toHaveAttribute('aria-checked', 'true');
	await page.locator('button.wf-colormix').click();

	const noToken = 'a'.repeat(43);
	for (const path of ['/shop', '/products/muesli', '/recipes', '/recipes/wf-banana-oat-pancakes', '/terms', '/privacy', '/login', '/account', '/404', `/order?no=WF-10001&t=${noToken}`]) {
		const r = await page.goto(path);
		expect(r.headers()['x-frame-options'], path).toBe('DENY');
		await hydrated(page);
		await walk(page);
	}
	expect(violations, JSON.stringify(violations, null, 1)).toEqual([]);
	expect(errors).toEqual([]);
});

test('checkout under the enforced CSP: Razorpay Checkout loads and a paid order lands on /order', async ({ context, page, baseURL }) => {
	const violations = await likeVercel(context, baseURL);
	const errors = collectErrors(page);
	await mockBackend().install(page);
	await stubRazorpay(page, ['success']);
	await seedBag(page, { muesli: 1, cornflakes: 1 });
	await page.goto('/checkout');
	await checkoutReady(page);
	await fillForm(page);
	await payButton(page).click();
	await page.waitForURL(/\/order\?no=WF-10001&t=/);
	await expect(page.locator('[data-wf-order-view="confirmed"]')).toBeVisible();
	expect(await page.evaluate(() => document.querySelectorAll('script[src="https://checkout.razorpay.com/v1/checkout.js"]').length)).toBe(1);
	expect(violations, JSON.stringify(violations, null, 1)).toEqual([]);
	expect(errors).toEqual([]);
});

test('another site cannot frame the storefront (checked against an unprotected control)', async ({ context, page, baseURL, request }) => {
	// The framing page: a real page of the preview under another origin (the loopback address instead of
	// "localhost"). A page Playwright fulfils, or an https one, may not frame the local http preview at all
	// (Local Network Access, mixed content), which would make the control meaningless.
	const { port } = new URL(baseURL);
	let parent = null;
	for (const host of ['127.0.0.1', '[::1]']) {
		const ok = await request.get(`http://${host}:${port}/terms`).then((r) => r.ok(), () => false);
		if (ok) parent = `http://${host}:${port}/terms?nofx=1`;
		if (ok) break;
	}
	expect(parent, 'the preview answers on a loopback address too').not.toBeNull();
	const messages = [];
	page.on('console', (m) => messages.push(m.text()));
	/** Where the iframe ended up, and whether the storefront page rendered in it. */
	const framed = async () => {
		await page.goto(parent);
		await page.evaluate((src) => {
			const f = document.createElement('iframe');
			f.src = src;
			document.body.prepend(f);
		}, `${baseURL}/login`);
		await expect.poll(() => page.frames()[1]?.url() ?? '').toMatch(/^(http:\/\/localhost|chrome-error)/);
		const child = page.frames()[1];
		await child.waitForLoadState('domcontentloaded').catch(() => {});
		const rendered = child.url().startsWith(baseURL) ? await child.locator('.footer-section').count() : 0;
		return { url: child.url().replace(baseURL, ''), rendered };
	};
	expect(await framed(), 'control: without the headers /login renders in the frame').toEqual({ url: '/login', rendered: 1 });
	await likeVercel(context, baseURL, { enforce: false }); // exactly as shipped: the report-only policy blocks nothing
	expect((await framed()).rendered, 'with the production headers the frame stays empty').toBe(0);
	expect(messages.some((m) => /frame-ancestors 'none'|X-Frame-Options/i.test(m)), messages.join('\n')).toBe(true);
});
