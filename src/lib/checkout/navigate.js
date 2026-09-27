/*
 * Reaching /order after money may have moved (the payment handler, a COD
 * "Place order", the banner's Check status finding it paid, ALREADY_PAID).
 *
 * A client-side goto() to a page whose code isn't loaded yet needs one more
 * request (/_app/immutable/nodes/<n>.js). Right after a UPI app hands back,
 * that request is the likeliest to fail (Wi-Fi ↔ mobile data, a dead zone),
 * and when it does SvelteKit renders the site's error page with status 500
 * on the /order URL: "ERROR 500 · Something went wrong" to someone who has
 * just paid, the order view never mounts, nothing polls, and nothing
 * recovers when the network comes back. So:
 *   1. the page code is loaded first (preloadCode; instant once /checkout
 *      preloaded it on mount, or a payment window was opened);
 *   2. loaded → goto(); if that still lands on an error page at the target
 *      path, fall through;
 *   3. otherwise a full page load of the same URL — after the browser is
 *      back online if it knows it's offline — which /order handles on its own
 *      ("We can't reach Wefeasto right now — we'll keep trying" while down).
 * A goto that ends somewhere else (the customer navigated meanwhile) is left
 * alone.
 */

/** '/order?no=…&t=…' → '/order' (a same-origin path; anything else as given). */
export function pathOf(url) {
	const s = String(url || '');
	const cut = s.search(/[?#]/);
	return cut === -1 ? s : s.slice(0, cut);
}

/**
 * @param {{
 *   goto: (url: string) => Promise<any>,
 *   preload: (path: string) => Promise<any>,
 *   errorAt: () => {path: string, error: boolean},
 *   hard: (url: string) => void,
 *   online?: () => boolean,
 *   whenOnline?: () => Promise<void>,
 * }} deps
 */
export function createSafeNavigate(deps) {
	const { goto, preload, errorAt, hard, online = () => true, whenOnline = () => Promise.resolve() } = deps;
	return async function navigate(url) {
		const path = pathOf(url);
		let ready = true;
		try {
			await preload(path);
		} catch (e) {
			ready = false; // the page code can't be fetched right now: a client-side goto would render the 500 page
		}
		if (ready) {
			let failed = false;
			try {
				await goto(url);
			} catch (e) {
				failed = true;
			}
			const at = errorAt();
			if (at.path !== path) return failed ? 'elsewhere' : 'client';
			if (!at.error) return 'client';
		}
		if (!online()) await whenOnline();
		hard(url);
		return 'full';
	};
}

/**
 * Resolves on the next 'online' event (at once if `win` has no event target).
 * @param {any} [win]
 */
export function nextOnline(win = globalThis) {
	return new Promise((resolve) => {
		if (!win || typeof win.addEventListener !== 'function') return resolve();
		win.addEventListener('online', () => resolve(), { once: true });
	});
}
