/*
 * Shared helpers for the ui-kit Playwright specs (PeepWalk, mobile nav, 404).
 */
import { test as base, expect } from '@playwright/test';

/** Same match as vite.config.js cmsProxy(): /api, /api/… (not /api-docs). */
const isApi = (url) => url.pathname === '/api' || url.pathname.startsWith('/api/');

/**
 * Answer every /api request as if no CMS were running (404, `{}`), on a
 * BrowserContext or a Page. Without it the result depends on the machine:
 * `vite preview` proxies /api to CMS_URL and answers 500 when nothing listens
 * there (Chromium logs that as a console error), while a running CMS feeds
 * live prices into the page. live.js keeps the snapshot on a 404, and
 * collectErrors() ignores 404s. A spec can still page.route() its own /api
 * bodies: page routes win over context routes.
 */
export const stubApi = (target) =>
	target.route(isApi, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));

/**
 * `test` with the API stubbed for the built-in context (so `page` too).
 * Contexts made with browser.newContext() need their own stubApi(ctx).
 */
export const test = base.extend({
	context: async ({ context }, use) => {
		await stubApi(context);
		await use(context);
	}
});

/*
 * Instruments the page before any script runs:
 * - counts drawImage() calls onto .wf-peepwalk canvases (window.__peep.draws);
 * - wraps window.gsap.ticker.add/remove (trapping the moment app.html's
 *   gsap.min.js assigns window.gsap) so every ticker listener is known, and
 *   remembers which listeners drew onto a PeepWalk canvas while they ran.
 *   That identifies PeepWalk loops by behaviour, not by (minified) names —
 *   including leaked ones drawing into detached canvases.
 */
export function instrumentPeeps() {
	const state = { draws: 0, listeners: new Set(), peepers: new Set() };
	window.__peep = state;
	let current = null;
	const drawImage = CanvasRenderingContext2D.prototype.drawImage;
	CanvasRenderingContext2D.prototype.drawImage = function (...args) {
		const c = this.canvas;
		if (c && c.classList && c.classList.contains('wf-peepwalk')) {
			state.draws++;
			if (current) state.peepers.add(current);
		}
		return drawImage.apply(this, args);
	};
	const patch = (gsap) => {
		if (!gsap || !gsap.ticker || gsap.ticker.__wfSpy) return;
		const ticker = gsap.ticker;
		const add = ticker.add.bind(ticker);
		const remove = ticker.remove.bind(ticker);
		const wrappers = new Map();
		ticker.add = (fn, once, prioritize) => {
			const w = function (...a) {
				const prev = current;
				current = fn;
				try {
					return fn.apply(this, a);
				} finally {
					current = prev;
				}
			};
			wrappers.set(fn, w);
			state.listeners.add(fn);
			return add(w, once, prioritize);
		};
		ticker.remove = (fn) => {
			const w = wrappers.get(fn);
			wrappers.delete(fn);
			state.listeners.delete(fn);
			return remove(w || fn);
		};
		ticker.__wfSpy = true;
	};
	let value;
	Object.defineProperty(window, 'gsap', {
		configurable: true,
		enumerable: true,
		get: () => value,
		set: (v) => {
			value = v;
			patch(v);
		}
	});
}

/** Make every localStorage access throw (Safari with storage blocked, etc.). */
export function blockStorage() {
	Object.defineProperty(window, 'localStorage', {
		configurable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		}
	});
}

/** Active ticker listeners that have drawn PeepWalk frames. */
export const peepLoops = (page) =>
	page.evaluate(() => [...window.__peep.peepers].filter((fn) => window.__peep.listeners.has(fn)).length);

export const tickerListeners = (page) => page.evaluate(() => window.__peep.listeners.size);

export const draws = (page) => page.evaluate(() => window.__peep.draws);

/** Draw calls over `ms` milliseconds. */
export async function drawsDuring(page, ms = 1000) {
	const a = await draws(page);
	await page.waitForTimeout(ms);
	return (await draws(page)) - a;
}

export const strip = (page) => page.locator('canvas.wf-peepwalk');

/**
 * Scroll so the strip is fully in view (and stays there), then wait for its
 * sprites. Right after a client navigation, SvelteKit resets the scroll to
 * the top ~300ms after the URL changes (the leave veil runs first), so the
 * strip must stay in view for a settle window before this returns.
 */
export async function scrollToStrip(page, { settle = 600 } = {}) {
	await strip(page).waitFor({ state: 'attached' });
	await expect
		.poll(
			() =>
				page.evaluate(async (settleMs) => {
					const c = () => document.querySelector('canvas.wf-peepwalk');
					const inView = () => {
						const el = c();
						if (!el) return false;
						const r = el.getBoundingClientRect();
						return r.top >= 0 && r.bottom <= window.innerHeight;
					};
					const scroll = () => {
						const el = c();
						if (!el) return;
						const top = el.getBoundingClientRect().top + window.scrollY;
						window.scrollTo(0, Math.max(0, top - window.innerHeight + el.clientHeight + 40));
					};
					if (!inView()) {
						scroll();
						return false;
					}
					await new Promise((r) => setTimeout(r, settleMs));
					if (inView()) return true;
					scroll();
					return false;
				}, settle),
			{ intervals: [50, 100, 200], timeout: 15_000 }
		)
		.toBe(true);
	await expect(strip(page)).toHaveAttribute('data-ready', '', { timeout: 10_000 });
}

export async function scrollToTop(page) {
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
}

/** Sum of the canvas alpha channel (0 = blank). */
export const alphaSum = (page) =>
	strip(page).evaluate((el) => {
		const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
		let s = 0;
		for (let i = 3; i < d.length; i += 4) s += d[i];
		return s;
	});

/** Mean colour of the light, opaque pixels (the peeps' fill). */
export const fillColour = (page) =>
	strip(page).evaluate((el) => {
		const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
		let r = 0;
		let g = 0;
		let b = 0;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			if (d[i + 3] < 250) continue;
			if (d[i] + d[i + 1] + d[i + 2] < 600) continue; // skip ink / edges
			r += d[i];
			g += d[i + 1];
			b += d[i + 2];
			n++;
		}
		return n ? [r / n, g / n, b / n, n] : null;
	});

/**
 * Collect uncaught page errors and console errors (minus expected 404 noise).
 * A failed resource load carries its URL, so a report says which one.
 */
export function collectErrors(page) {
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() !== 'error') return;
		const t = m.text();
		if (/Failed to load resource: the server responded with a status of 404/.test(t)) return;
		const url = /^Failed to load resource/.test(t) ? m.location()?.url : '';
		errors.push(url ? `${t} (${url})` : t);
	});
	return errors;
}

/** The page never scrolls sideways. */
export async function expectNoHorizontalOverflow(page) {
	const o = await page.evaluate(() => ({
		sw: document.documentElement.scrollWidth,
		bw: document.body.scrollWidth,
		iw: window.innerWidth
	}));
	expect(o.sw, `documentElement.scrollWidth ${o.sw} > ${o.iw}`).toBeLessThanOrEqual(o.iw);
	expect(o.bw, `body.scrollWidth ${o.bw} > ${o.iw}`).toBeLessThanOrEqual(o.iw);
}
