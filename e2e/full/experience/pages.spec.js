/*
 * Every key page on the real stack, at 360 / 390 / 768 / 1280 px: loads and hydrates
 * with no console errors or page errors (the fixture's gate), no sideways scroll from
 * top to bottom, and no announcement bar (S11 is off by default and build-time only).
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/experience/pages.spec.js
 */
import { test, expect } from '../fixtures.js';
import { expectNoHorizontalOverflow, seedBag, waitHydrated } from './helpers.js';

const WIDTHS = [360, 390, 768, 1280];
const BAG = { muesli: 1, cornflakes: 2, 'rolled-oats': 1 };

/** [name, path or (api) => path, { bag?, status? }] */
const PAGES = [
	['home', '/'],
	['shop', '/shop'],
	['PDP muesli', '/products/muesli'],
	['PDP health-mix', '/products/health-mix'],
	['recipes', '/recipes'],
	['recipe page', '/recipes/wf-muesli-yogurt-parfait'],
	['cart (empty)', '/cart'],
	['cart (3 lines)', '/cart', { bag: BAG }],
	['checkout (3 lines)', '/checkout', { bag: BAG }],
	['order (real COD order)', async (api) => {
		const o = await api.placeOrder({ items: { cornflakes: 1, muesli: 1 }, method: 'cod' });
		return `/order?no=${o.number}&t=${o.token}`;
	}],
	['login', '/login'],
	['account (signed out)', '/account'],
	['reset-password', '/reset-password'],
	['terms', '/terms'],
	['privacy', '/privacy'],
	['404', '/nope', { status: 404 }]
];

/** Scroll to the bottom in steps (lazy content, reveals, the crowd) and back to the top. */
async function scrollThrough(page) {
	await page.evaluate(async () => {
		const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
		for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
			window.scrollTo(0, y);
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		}
		window.scrollTo(0, document.documentElement.scrollHeight);
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
}

/** Elements (not fixed, not clipped by an ancestor) whose box ends right of the viewport, plus the document itself. */
function wideElements() {
	const iw = window.innerWidth;
	const out = [];
	if (document.documentElement.scrollWidth > iw) out.push(`documentElement.scrollWidth=${document.documentElement.scrollWidth}`);
	for (const el of document.querySelectorAll('.page-wrapper *, .footer-section *')) {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0 || r.right <= iw + 1 || getComputedStyle(el).position === 'fixed') continue;
		let clipped = false;
		for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
			const s = getComputedStyle(p);
			if (/(hidden|clip|auto|scroll)/.test(s.overflowX) && p.getBoundingClientRect().right <= iw + 1) {
				clipped = true;
				break;
			}
		}
		if (!clipped) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} right=${Math.round(r.right)}`);
		if (out.length > 5) break;
	}
	return out;
}

for (const [name, path, opts = {}] of PAGES) {
	test(`${name}: no console errors, no horizontal overflow at ${WIDTHS.join('/')} px, no announcement bar`, async ({ page, api, consoleErrors }) => {
		const url = typeof path === 'function' ? await path(api) : path;
		if (opts.bag) await seedBag(page, opts.bag);
		if (opts.status === 404) consoleErrors.allow(/status of 404 \(Not Found\) \(http:\/\/localhost:\d+\/nope\)$/);
		for (const width of WIDTHS) {
			await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
			const res = await page.goto(url);
			expect(res.status(), `${url} status`).toBe(opts.status ?? 200);
			await waitHydrated(page);
			if (url.startsWith('/order')) await page.waitForFunction(() => document.querySelector('[data-wf-order-view]')?.getAttribute('data-wf-order-view') === 'confirmed');
			if (url === '/checkout') await page.waitForFunction(() => !document.querySelector('#wf-co-summary')?.textContent.includes('Loading your bag'));
			await scrollThrough(page);
			// No settle wait: the home trailer's scroll-scrubbed parallax (scale 1.06 → 1, scrub 0.8 s)
			// used to stick out by a few px while it caught up with a fast scroll (PI-EXP-4); its
			// .wf-video-frame clips it now, so the layout must be clean at every moment.
			expect(await page.evaluate(wideElements), `${url} @${width}px: elements past the right edge`).toEqual([]);
			await expectNoHorizontalOverflow(page);
			await expect(page.locator('.wf-announce, [data-wf-announce]')).toHaveCount(0);
		}
	});
}

test('S11: an announcement enabled in the CMS does not pop into a live page (build-time only, needs a rebuild)', { tag: '@stateful' }, async ({ page, admin, api, shop }) => {
	await admin.updateSettings({ announcement: { enabled: true, text: 'E2E: free muesli Friday', href: '/shop' } });
	const cat = (await api.get('store/catalog')).json;
	expect(cat.settings.announcement).toMatchObject({ enabled: true, text: 'E2E: free muesli Friday' });
	for (const path of ['/', '/shop', '/cart']) {
		await shop.visit(path);
		await expect(page.locator('.wf-announce')).toHaveCount(0);
	}
});
