/*
 * Shared helpers for the client-ux hunt specs (e2e/full/hunt/client-ux/**).
 */
/**
 * Start recording every distinct #wf-place-order label (text) in this document
 * into window.__wfLabels (client-side navigation keeps the document, so the
 * recording spans /checkout → /order).
 */
export async function recordPayLabels(page) {
	await page.evaluate(() => {
		window.__wfLabels = [];
		const rec = () => {
			const b = document.querySelector('#wf-place-order');
			const s = b ? b.textContent.trim() : null;
			const last = window.__wfLabels[window.__wfLabels.length - 1];
			if (s !== null && last !== s) window.__wfLabels.push(s);
		};
		new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, characterData: true });
		rec();
	});
}
export const payLabels = (page) => page.evaluate(() => window.__wfLabels || []);

/** Hold SvelteKit's client-side data request for /order (a slow network after paying). */
export async function slowOrderRoute(page, ms = 3000) {
	await page.route(/\/order\/__data\.json/, async (route) => {
		await new Promise((r) => setTimeout(r, ms));
		await route.continue();
	});
}

/**
 * Emulate a browser that blocks cookies (Safari "Block All Cookies", strict privacy modes):
 * navigator.cookieEnabled is false, and the session cookie from POST /api/customers/login is
 * never stored (the request is replayed from Node — Playwright's route.fetch() would store it —
 * and answered without Set-Cookie).
 */
export async function blockCookies(page) {
	await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'cookieEnabled', { configurable: true, get: () => false }));
	await page.route('**/api/customers/login', async (route) => {
		const req = route.request();
		const res = await fetch(req.url(), { method: req.method(), headers: { 'content-type': 'application/json', accept: 'application/json' }, body: req.postData() });
		await route.fulfill({ status: res.status, headers: { 'content-type': 'application/json' }, body: await res.text() });
	});
}

/** Init script: this page's clock runs `offsetMs` ahead of real time (Date.now() and new Date()). */
export async function skewClock(page, offsetMs) {
	await page.addInitScript((off) => {
		const Real = Date;
		class Skewed extends Real {
			constructor(...a) {
				if (a.length === 0) super(Real.now() + off);
				else super(...a);
			}
			static now() {
				return Real.now() + off;
			}
		}
		Skewed.parse = Real.parse;
		Skewed.UTC = Real.UTC;
		globalThis.Date = Skewed;
	}, offsetMs);
}

/**
 * The first POST /api/store/checkout reaches the CMS (which places the order), but its answer is
 * lost on the way back (connection reset). Later checkouts go through untouched.
 */
export async function loseFirstCheckoutAnswer(page) {
	let first = true;
	await page.route('**/api/store/checkout', async (route) => {
		if (!first) return route.continue();
		first = false;
		await route.fetch();
		await route.abort('connectionreset');
	});
}

/** #wf-place-order is ready again (not busy / blocked) and the summary quote has settled. */
export async function payReadyAgain(page) {
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready', null, { timeout: 20_000 });
	await page.waitForFunction(() => !document.querySelector('#wf-co-summary')?.classList.contains('wf-loading'), null, { timeout: 20_000 });
}

/**
 * Hold every SvelteKit JS chunk (/_app/immutable/**.js) until the returned `release()` is called:
 * the prerendered page is on screen and usable, but not hydrated yet — what a first visit on a
 * 3G/4G phone looks like for several seconds (Fast 3G, no cache: /login visible at ~2.5 s,
 * hydrated at ~7.4 s; a PDP visible at ~5 s, hydrated at ~11 s).
 */
export async function holdHydration(page) {
	let open;
	const gate = new Promise((r) => (open = r));
	await page.route(/\/_app\/immutable\/.*\.js(\?.*)?$/, async (route) => {
		await gate;
		await route.continue();
	});
	return () => open();
}

/** Every top-level document request the page makes, as { method, url, body }. */
export function recordDocuments(page) {
	const docs = [];
	page.on('request', (r) => {
		if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) docs.push({ method: r.method(), url: r.url(), body: r.postData() || '' });
	});
	return docs;
}
