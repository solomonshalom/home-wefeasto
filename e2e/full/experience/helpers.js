/*
 * Domain helpers for the storefront-experience specs (e2e/full/experience/**):
 * toast, meter/top-up, cart links, search, mobile nav, PeepWalk, 404, layout, a11y.
 *
 * Everything runs against the real slot stack (production CMS + storefront preview),
 * so live values come from GET /api/store/catalog and change through `admin`.
 * The PeepWalk instrumentation and overflow check are the ui-kit helpers
 * (e2e/ui/helpers.js — documented as reusable by the full project).
 */
import { expect } from '../fixtures.js';
import { formatPaise } from '../../../cms/src/commerce/shared/money.js';
import { quote as sharedQuote } from '../../../cms/src/commerce/shared/pricing.js';

export {
	instrumentPeeps,
	peepLoops,
	draws,
	drawsDuring,
	strip,
	scrollToStrip,
	scrollToTop,
	alphaSum,
	fillColour,
	expectNoHorizontalOverflow
} from '../../ui/helpers.js';
export { formatPaise, sharedQuote };

/* ---------------------------------------------------------------- locators */

export const toast = (page) => page.locator('[data-wf-toast]');
export const toastTitle = (page) => page.locator('[data-wf-toast] .wf-toast-title');
export const toastLive = (page) => page.locator('[data-wf-toast-live]');
export const badge = (page) => page.locator('.div-block-79 .wf-cart-count');
export const colorMix = (page) => page.locator('.wf-colormix');
export const cartSummary = (page) => page.locator('#wf-cart-summary');
export const coSummary = (page) => page.locator('#wf-co-summary');

/* ---------------------------------------------------------------- wf:cart-add recording */

/** Init script: every wf:cart-add detail lands in window.__adds (survives nothing: per document). */
export function recordAdds() {
	window.__adds = [];
	window.addEventListener('wf:cart-add', (e) => window.__adds.push(e.detail));
}
export const adds = (page) => page.evaluate(() => window.__adds || []);

/* ---------------------------------------------------------------- live catalog */

/** The live catalog as the storefront sees it (through the preview proxy). */
export async function liveCatalog(api) {
	const r = await api.get('store/catalog');
	const body = r.json ?? r;
	if (!body || !Array.isArray(body.products)) throw new Error(`store/catalog: unexpected ${JSON.stringify(r).slice(0, 200)}`);
	return body;
}

/** The $shared quote the cart/toast should show for `bag` over the live catalog. */
export async function expectedQuote(api, bag, extra = {}) {
	const cat = await liveCatalog(api);
	const items = Object.entries(bag).map(([slug, qty]) => ({ slug, qty }));
	return sharedQuote({ items, catalog: cat.products, settings: cat.settings, ...extra });
}

/**
 * page.goto + wait until the page's first GET /api/store/catalog has answered (live
 * values arrive after hydration) and the layout has hydrated.
 */
export async function gotoLive(page, path) {
	const live = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/store/catalog' && r.request().method() === 'GET', { timeout: 20_000 });
	await page.goto(path);
	await waitHydrated(page);
	const res = await live;
	expect(res.status(), 'live catalog status').toBe(200);
	return res;
}

/** The layout has mounted (the nav badge gets its class or count only then). */
export async function waitHydrated(page, { timeout = 15_000 } = {}) {
	await page.waitForFunction(
		() => {
			const b = document.querySelector('.div-block-79 .wf-cart-count');
			return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
		},
		null,
		{ timeout }
	);
}

/** Two animation frames: whatever the last state change rendered is on screen. */
export const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Seed localStorage wefeasto_cart before the first navigation of this page (once per init). */
export async function seedBag(page, bag) {
	await page.addInitScript((b) => {
		try {
			if (sessionStorage.getItem('__wf_exp_seeded')) return;
			sessionStorage.setItem('__wf_exp_seeded', '1');
			localStorage.setItem('wefeasto_cart', JSON.stringify(b));
		} catch {
			/* storage unavailable */
		}
	}, bag);
}

/** The bag as the app sees it. */
export const readBag = (page) => page.evaluate(() => (window.WefeastoCart?.read ? window.WefeastoCart.read() : null));

/** Scroll an element (maybe a not-yet-revealed .wf-reveal) into view and wait until it shows. */
export async function bringIntoView(locator) {
	await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await expect(locator).toBeVisible();
}

/**
 * SvelteKit client-side navigation (a temporary <a> clicked inside the app), so the
 * page session (memoised live data, in-memory state) survives.
 */
export async function clientNav(page, href) {
	const target = new URL(href, page.url());
	await page.evaluate((h) => {
		const a = document.createElement('a');
		a.href = h;
		a.textContent = 'x';
		a.style.display = 'none';
		(document.querySelector('.page-wrapper') || document.body).appendChild(a);
		a.click();
		a.remove();
	}, target.pathname + target.search);
	await page.waitForURL((u) => u.pathname === target.pathname);
	await waitHydrated(page);
}

/** The veil (fx.js page transition) is gone: a client navigation has fully settled. */
export async function navigationSettled(page) {
	await page.waitForFunction(() => {
		const v = document.getElementById('wf-veil');
		return !v || getComputedStyle(v).display === 'none';
	});
}

/* ---------------------------------------------------------------- toast timing (page clock) */

/** Init script: log of the toast appearing/leaving ({on, t: performance.now()}). */
export function recordToastLife() {
	window.__toastLife = [];
	const obs = new MutationObserver(() => {
		const on = !!document.querySelector('[data-wf-toast]');
		const log = window.__toastLife;
		if (log.length ? log[log.length - 1].on !== on : on) log.push({ on, t: performance.now() });
	});
	const start = () => obs.observe(document.documentElement, { childList: true, subtree: true });
	if (document.documentElement) start();
	else document.addEventListener('DOMContentLoaded', start);
}
export const toastLife = (page) => page.evaluate(() => window.__toastLife || []);
export const pageNow = (page) => page.evaluate(() => performance.now());
export const untilPageTime = (page, t) => page.waitForFunction((at) => performance.now() >= at, t, { polling: 50, timeout: 20_000 });

/** The toast module has mounted and seen every add so far (queued adds are replayed). */
export const toastMounted = (page) => expect(toastLive(page)).toBeAttached({ timeout: 15_000 });

/* ---------------------------------------------------------------- accounts */

export const ACCOUNT_PASSWORD = 'breakfast-club-2026';

/**
 * A verified, signed-in customer through the real UI: /login sign-up → the Payload
 * verification email in Mailpit → /login?verify= → log in → /account.
 */
export async function signUpAndLogIn(page, { shop, mailpit, email, name = 'Asha Kumar' }) {
	await shop.visit('/login');
	await page.click('#wf-tab-signup');
	await page.fill('#wf-signup-name', name);
	await page.fill('#wf-signup-email', email);
	await page.fill('#wf-signup-password', ACCOUNT_PASSWORD);
	await page.click('#wf-signup-form button[type="submit"]');
	await expect(page.locator('#wf-auth-notice')).toContainText(`we sent a link to ${email}`);
	const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: 'Confirm your Wefeasto account' });
	const link = mailpit.extractLinks(msg).find((l) => /\/login\?verify=[A-Za-z0-9_-]+/.test(l));
	expect(link, 'verification link').toBeTruthy();
	await page.goto(link);
	await expect(page.locator('#wf-auth-notice')).toHaveText('Email verified — log in');
	await page.fill('#wf-login-email', email);
	await page.fill('#wf-login-password', ACCOUNT_PASSWORD);
	await page.click('#wf-login-form button[type="submit"]');
	await page.waitForURL((u) => u.pathname === '/account');
	await expect(page.locator('[data-wf-hello]')).toBeVisible();
}
