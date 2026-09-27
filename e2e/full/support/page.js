/*
 * Page helpers for full-stack specs: hydration, bag setup, checkout, orders, and the
 * three storage/motion variants the SPEC asks for (normal, ?nofx=1, storage throwing).
 *
 * Variant semantics (set per test with `test.use({ variant })`, applied per context):
 * - 'normal'
 * - 'nofx':           every page.goto() to the storefront gets ?nofx=1 (the site reads it
 *                     per URL; a client-side navigation drops it, as for a real visitor).
 * - 'storage-throws': every Storage method (localStorage AND sessionStorage) throws, like
 *                     a full quota / hardened browser. The bag then lives in memory for the
 *                     page session only: a full reload empties it. The helpers below keep
 *                     to client-side navigation in this variant (clientNav).
 * - 'storage-blocked': the localStorage/sessionStorage getters throw (Safari "block all
 *                     cookies"). Same rules as storage-throws.
 */
import { expect } from '@playwright/test';
import { checkoutForm } from './unique.js';
import { setMockAuto } from './mock.js';
import { sfUrl } from './env.js';

export const VARIANTS = ['normal', 'nofx', 'storage-throws'];
const ALL_VARIANTS = [...VARIANTS, 'storage-blocked'];

/** BrowserContext → variant (set by prepareContext). */
const contextVariant = new WeakMap();
let cartSeq = 0;

export function variantOf(page) {
	return contextVariant.get(page.context()) ?? 'normal';
}
const memoryOnly = (page) => /^storage-/.test(variantOf(page));

/** `url` with nofx=1 when it points at the storefront (relative or absolute on `sfOrigin`). */
export function withNofx(url, sfOrigin) {
	const u = new URL(url, sfOrigin);
	if (u.origin !== new URL(sfOrigin).origin || u.searchParams.get('nofx') === '1') return url;
	u.searchParams.set('nofx', '1');
	return u.toString();
}

/* Init scripts (run in the page before any site script). */
function throwingStorage() {
	const fail = () => {
		throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
	};
	for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
		Object.defineProperty(Storage.prototype, m, { configurable: true, writable: true, value: fail });
	}
	Object.defineProperty(Storage.prototype, 'length', { configurable: true, get: fail });
}
function blockedStorage() {
	for (const name of ['localStorage', 'sessionStorage']) {
		Object.defineProperty(window, name, {
			configurable: true,
			get() {
				throw new DOMException('The operation is insecure.', 'SecurityError');
			}
		});
	}
}

/**
 * Apply a variant to a context (init scripts; page.goto wrapper for nofx). The fixtures
 * call it for the built-in context and for every newContext().
 */
export async function prepareContext(context, { variant = 'normal', sfOrigin }) {
	if (!ALL_VARIANTS.includes(variant)) throw new Error(`unknown variant ${JSON.stringify(variant)} (${ALL_VARIANTS.join(', ')})`);
	contextVariant.set(context, variant);
	if (variant === 'storage-throws') await context.addInitScript(throwingStorage);
	if (variant === 'storage-blocked') await context.addInitScript(blockedStorage);
	if (variant === 'nofx') {
		const wrap = (page) => {
			if (page.__wfGotoWrapped) return;
			const goto = page.goto.bind(page);
			page.goto = (url, opts) => goto(withNofx(url, sfOrigin), opts);
			page.__wfGotoWrapped = true;
		};
		context.pages().forEach(wrap);
		context.on('page', wrap);
	}
}

/* ---------------------------------------------------------------- navigation */

/** Wait until the layout has mounted (the nav bag badge is either hidden or shows a count). */
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

/** Is the page currently showing the storefront (not about:blank, not the CMS)? */
const onStorefront = (page) => {
	try {
		return new URL(page.url()).origin === new URL(sfUrl()).origin;
	} catch {
		return false;
	}
};

/**
 * SvelteKit client-side navigation to `path` (no reload: the in-memory bag survives).
 * Clicks a temporary <a> inside the app root, which the router intercepts.
 */
export async function clientNav(page, path) {
	const target = new URL(path, page.url());
	await page.evaluate((href) => {
		const root = document.querySelector('body > div[style*="contents"]') || document.body;
		const a = document.createElement('a');
		a.href = href;
		a.style.display = 'none';
		root.appendChild(a);
		a.click();
		a.remove();
	}, target.pathname + target.search + target.hash);
	await page.waitForURL((u) => u.pathname === target.pathname, { timeout: 15_000 });
	await waitHydrated(page);
}

/**
 * Go to a storefront path: page.goto normally; in the storage variants a client-side
 * navigation once the site is loaded (a reload would empty the in-memory bag).
 */
export async function visit(page, path) {
	if (memoryOnly(page) && onStorefront(page)) return clientNav(page, path);
	await page.goto(path);
	await waitHydrated(page);
}

/** Units in the bag, read from the app (works with storage throwing). */
export const cartCount = (page) =>
	page.evaluate(() => {
		if (window.WefeastoCart?.count) return window.WefeastoCart.count();
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return b && !b.classList.contains('wf-is-hidden') ? parseInt(b.textContent, 10) || 0 : 0;
	});

/** The bag as the app sees it ({slug: qty}). */
export const readCart = (page) => page.evaluate(() => (window.WefeastoCart?.read ? window.WefeastoCart.read() : null));

/**
 * Add `qty` of `slug` through the product page UI (qty stepper + "Add to Cart"), and wait
 * until the bag has them. In the storage variants the PDP is reached client-side.
 */
export async function addToCart(page, slug, qty = 1) {
	await visit(page, `/products/${slug}`);
	const btn = page.locator(`[data-wf-add="${slug}"][data-wf-qty-input]`);
	await expect(btn).toBeVisible();
	const before = await cartCount(page);
	if (qty !== 1) {
		const input = await btn.getAttribute('data-wf-qty-input');
		await page.locator(input).fill(String(qty));
	}
	await btn.click();
	await expect.poll(() => cartCount(page), { message: `bag count after adding ${qty} × ${slug}` }).toBe(before + qty);
}

/**
 * Make the bag exactly `map` ({slug: qty}) before the next navigation.
 * - normal/nofx: localStorage `wefeasto_cart`, written by an init script on the next
 *   navigation (once), or right away when the page is already on the storefront.
 * - storage variants: opens `/cart?add=slug:qty,…` (the cart deep link fills the
 *   in-memory bag) and stays on /cart; continue with client-side navigation (visit()).
 */
export async function setCart(page, map) {
	if (memoryOnly(page)) {
		const add = Object.entries(map)
			.map(([s, q]) => `${s}:${q}`)
			.join(',');
		await page.goto(`/cart?add=${encodeURIComponent(add)}`);
		await waitHydrated(page);
		const want = Object.values(map).reduce((a, b) => a + Number(b), 0);
		await expect.poll(() => cartCount(page), { message: 'bag filled from /cart?add=' }).toBe(want);
		return;
	}
	const key = `__wf_e2e_setcart_${++cartSeq}`;
	const cart = JSON.stringify(map);
	await page.addInitScript(
		({ key, cart }) => {
			try {
				if (sessionStorage.getItem(key)) return;
				sessionStorage.setItem(key, '1');
				localStorage.setItem('wefeasto_cart', cart);
			} catch {
				/* storage unavailable */
			}
		},
		{ key, cart }
	);
	if (onStorefront(page)) {
		await page.evaluate(
			({ key, cart }) => {
				sessionStorage.setItem(key, '1');
				localStorage.setItem('wefeasto_cart', cart);
			},
			{ key, cart }
		);
	}
}

/** /cart (client-side in the storage variants). */
export const gotoCart = (page) => visit(page, '/cart');

/** /checkout (client-side in the storage variants). */
export const gotoCheckout = (page) => visit(page, '/checkout');

/* ---------------------------------------------------------------- checkout */

/** Pay button ready and the debounced server quote settled. */
export async function payReady(page, { timeout = 20_000 } = {}) {
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready', null, { timeout });
	await page.waitForFunction(() => !document.querySelector('#wf-co-summary')?.classList.contains('wf-loading'), null, { timeout });
}

/**
 * Fill /checkout (the page must be open) and pick the payment method; waits until Pay is
 * ready. `overrides` are checkoutForm() keys (name, phone, email, address, pin, city,
 * state, method, consent, save). Resolves the values used (email is unique per call).
 */
export async function fillCheckout(page, overrides = {}) {
	const f = checkoutForm(overrides);
	await page.waitForFunction(() => {
		const s = document.querySelector('#wf-co-summary');
		return !!s && !s.textContent.includes('Loading your bag');
	});
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') !== null);
	await page.fill('#wf-co-name', f.name);
	await page.fill('#wf-co-phone', f.phone);
	await page.fill('#wf-co-email', f.email);
	await page.fill('#wf-co-address', f.address);
	await page.fill('#wf-co-city', f.city);
	await page.selectOption('#wf-co-state', f.state);
	await page.fill('#wf-co-pin', f.pin);
	if (f.consent !== undefined) await page.locator('#wf-co-consent').setChecked(!!f.consent);
	if (f.save !== undefined) await page.locator('#wf-co-save').setChecked(!!f.save);
	await page.locator(`label.wf-pay-pill:has(input[value="${f.method}"])`).click();
	await payReady(page);
	return f;
}

/** Order number + guest token from an /order?no=&t= URL. */
export function orderFromUrl(url) {
	const u = new URL(url);
	return { number: u.searchParams.get('no'), token: u.searchParams.get('t') };
}

/** The /order view (data-wf-order-view) once it is one of `views`. */
export async function waitOrderView(page, views = ['confirmed'], { timeout = 30_000 } = {}) {
	await page.waitForURL(/\/order\?(.*&)?no=WF-\d+/, { timeout });
	await page.waitForFunction((v) => v.includes(document.querySelector('[data-wf-order-view]')?.getAttribute('data-wf-order-view') ?? ''), views, { timeout });
	return page.locator('[data-wf-order-view]').getAttribute('data-wf-order-view');
}

/**
 * Online order end to end through the UI: bag → /checkout → form → Pay → mock Checkout
 * plays `auto` → /order. Options: items ({slug: qty}; omit to keep the current bag),
 * auto ('success' default; see setMockAuto), delayMs, method ('upi'|'card'), form
 * (checkoutForm overrides), expect (views to wait for; default ['confirmed'], null = don't wait).
 * Resolves { number, token, form, view } (number/token null when not waited).
 */
export async function placeOnlineOrder(page, { items, auto = 'success', delayMs, reason, webhook, method = 'upi', form = {}, expect: views = ['confirmed'] } = {}) {
	if (items) await setCart(page, items);
	await setMockAuto(page, { auto, ...(delayMs !== undefined ? { delayMs } : {}), ...(reason ? { reason } : {}), ...(webhook !== undefined ? { webhook } : {}) });
	await gotoCheckout(page);
	const f = await fillCheckout(page, { ...form, method });
	await page.locator('#wf-place-order').click();
	if (!views) return { number: null, token: null, form: f, view: null };
	const view = await waitOrderView(page, views);
	return { ...orderFromUrl(page.url()), form: f, view };
}

/**
 * Cash-on-delivery order through the UI: bag → /checkout → form (method cod) → Place order
 * → /order confirmed. Options: items, form. Resolves { number, token, form, view }.
 */
export async function placeCodOrder(page, { items, form = {}, expect: views = ['confirmed'] } = {}) {
	if (items) await setCart(page, items);
	await gotoCheckout(page);
	const f = await fillCheckout(page, { ...form, method: 'cod' });
	await page.locator('#wf-place-order').click();
	const view = await waitOrderView(page, views);
	return { ...orderFromUrl(page.url()), form: f, view };
}
