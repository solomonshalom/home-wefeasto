/*
 * The checkout flow wired to the browser: same-origin /api, checkout.js on
 * demand, a /order navigation that survives a network blip (navigate.js),
 * the track() shim. The checkout page, the pending-order banner and /order
 * each make one. Plus the COD-availability check the banner and /order ask
 * before offering "Pay on delivery instead".
 */
import { goto, preloadCode } from '$app/navigation';
import { page } from '$app/state';
import { api, newIdempotencyKey } from '$lib/api.js';
import { track } from '$lib/track.js';
import { createCheckoutFlow } from './flow.js';
import { loadCheckoutScript, watchRender } from './razorpay.js';
import { createCodCheck } from './cod-check.js';
import { createSafeNavigate, nextOnline } from './navigate.js';
import { catalogForPricing, liveSettings, loadLive } from '$lib/live.js';
import { quote as localQuote } from '$shared/pricing.js';

/**
 * Fetch /order's page code now (best effort, never rejects): a page that may
 * send a customer there after a payment calls it on mount, and the flow again
 * before a payment window opens, so getting there later needs no request.
 */
export function preloadOrderPage() {
	try {
		return preloadCode('/order').catch(() => {});
	} catch (e) {
		return Promise.resolve(); // not in a browser
	}
}

/**
 * goto() for pages a customer who may have just paid is sent to (see
 * navigate.js): the page code first, a full page load when it can't be had.
 */
export const safeGoto = createSafeNavigate({
	goto: (url) => goto(url),
	preload: (path) => preloadCode(path),
	errorAt: () => ({ path: page.url?.pathname ?? '', error: !!page.error || (page.status ?? 200) >= 500 }),
	hard: (url) => window.location.assign(url),
	online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
	whenOnline: () => nextOnline(window)
});

/**
 * @param {{ navigate?: (url: string) => void, onOrder?: (order: any) => void }} [opts]
 */
export function browserFlow({ navigate = (url) => safeGoto(url), onOrder } = {}) {
	return createCheckoutFlow({
		api,
		loadScript: (src) => {
			preloadOrderPage(); // wherever the window ends, /order is next
			return loadCheckoutScript(src);
		},
		navigate,
		track,
		newKey: newIdempotencyKey,
		watchRender: () => watchRender(document),
		onOrder
	});
}

/**
 * The COD-availability check wired to the browser: the server quote through
 * /api, else the $shared quote over the live catalog (cod-check.js).
 */
export function browserCodCheck() {
	return createCodCheck({
		api,
		// The live catalog first (never rejects; the snapshot when /api is down too).
		localQuote: async (items, pin) => {
			await loadLive();
			return localQuote({ items, catalog: catalogForPricing(), settings: liveSettings(), method: 'cod', context: pin ? { pin } : {} });
		}
	});
}
