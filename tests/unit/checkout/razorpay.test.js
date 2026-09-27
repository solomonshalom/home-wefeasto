// @vitest-environment jsdom
/*
 * checkout.js on demand (allow-list, 15 s timeout, retry after failure, no
 * SRI), PaymentInit → Razorpay options, and the "did anything render"
 * watcher behind the watchdog.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	loadCheckoutScript,
	_resetScriptLoads,
	buildRazorpayOptions,
	isAllowedScript,
	isPaymentInit,
	watchRender,
	HIDE_UPI_COLLECT,
	SCRIPT_TIMEOUT_MS
} from '$lib/checkout/razorpay.js';
import { PAYMENT } from './_helpers.js';

const SRC = 'https://checkout.razorpay.com/v1/checkout.js';

beforeEach(() => {
	_resetScriptLoads();
	delete window.Razorpay;
	document.head.querySelectorAll('script').forEach((s) => s.remove());
});
afterEach(() => vi.useRealTimers());

const scriptTag = () => document.head.querySelector('script[data-wf-checkout-js]');

describe('isAllowedScript', () => {
	it.each([
		[SRC, true],
		['https://checkout.razorpay.com/v2/checkout.js', true],
		['/api/payments/mock/checkout.js', true],
		['http://localhost:3300/api/payments/mock/checkout.js', true],
		['https://evil.example/checkout.js', false],
		['https://checkout.razorpay.com.evil.example/v1/checkout.js', false],
		['javascript:alert(1)', false],
		['/api/payments/mock/checkout.js/../x.js', false],
		['', false],
		[null, false]
	])('%s → %s', (src, ok) => {
		expect(isAllowedScript(src, 'http://localhost:4300/checkout')).toBe(ok);
	});
});

describe('loadCheckoutScript', () => {
	it('adds one async <script> (no integrity attribute) and resolves window.Razorpay on load', async () => {
		const p = loadCheckoutScript(SRC);
		const p2 = loadCheckoutScript(SRC);
		const tags = document.head.querySelectorAll('script');
		expect(tags.length).toBe(1);
		const s = scriptTag();
		expect(s.src).toBe(SRC);
		expect(s.async).toBe(true);
		expect(s.hasAttribute('integrity')).toBe(false);
		window.Razorpay = function Razorpay() {};
		s.onload();
		await expect(p).resolves.toBe(window.Razorpay);
		await expect(p2).resolves.toBe(window.Razorpay);
	});

	it('already on the page → resolves without loading anything', async () => {
		window.Razorpay = function Razorpay() {};
		await expect(loadCheckoutScript(SRC)).resolves.toBe(window.Razorpay);
		expect(scriptTag()).toBeNull();
	});

	it('onerror (ad blocker, offline) → LOAD_ERROR, tag removed, the next call tries again', async () => {
		const p = loadCheckoutScript(SRC);
		scriptTag().onerror();
		await expect(p).rejects.toThrow('LOAD_ERROR');
		expect(scriptTag()).toBeNull();
		const again = loadCheckoutScript(SRC);
		expect(scriptTag()).not.toBeNull();
		window.Razorpay = function Razorpay() {};
		scriptTag().onload();
		await expect(again).resolves.toBe(window.Razorpay);
	});

	it('loads but defines nothing → NO_RAZORPAY', async () => {
		const p = loadCheckoutScript(SRC);
		scriptTag().onload();
		await expect(p).rejects.toThrow('NO_RAZORPAY');
	});

	it('hangs → TIMEOUT after 15 s', async () => {
		vi.useFakeTimers();
		const p = loadCheckoutScript(SRC);
		const settled = vi.fn();
		p.catch(settled);
		await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS - 1);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await expect(p).rejects.toThrow('TIMEOUT');
		expect(scriptTag()).toBeNull();
	});

	it('a script from anywhere else is refused without touching the DOM', async () => {
		await expect(loadCheckoutScript('https://evil.example/x.js')).rejects.toThrow('BLOCKED');
		expect(document.head.querySelector('script')).toBeNull();
	});
});

describe('buildRazorpayOptions', () => {
	const handler = () => {};
	const onDismiss = () => {};

	it('maps PaymentInit to the documented options', () => {
		const o = buildRazorpayOptions(PAYMENT, { method: 'upi', handler, onDismiss });
		expect(o).toEqual({
			key: 'rzp_test_abc',
			order_id: 'order_A1',
			amount: 47400,
			currency: 'INR',
			name: 'Wefeasto',
			description: 'Order WF-10001',
			image: 'https://wefeasto.com/images/webclip.png',
			prefill: { name: 'Asha Kumar', email: 'asha@example.com', contact: '+919845262777', method: 'upi' },
			readonly: { contact: true },
			notes: { wf_order: 'WF-10001' },
			theme: { color: '#333333' },
			modal: { ondismiss: onDismiss, confirm_close: true },
			retry: { enabled: true },
			timeout: 900,
			callback_url: PAYMENT.callbackUrl,
			config: { display: { hide: [{ method: 'upi', flows: ['collect'] }] } },
			handler
		});
		expect(o).not.toHaveProperty('redirect'); // checkout.js decides (forced on iOS / in-app browsers)
	});

	it('card preselects card; anything else preselects nothing', () => {
		expect(buildRazorpayOptions(PAYMENT, { method: 'card', handler, onDismiss }).prefill.method).toBe('card');
		expect(buildRazorpayOptions(PAYMENT, { method: 'cod', handler, onDismiss }).prefill).not.toHaveProperty('method');
		expect(buildRazorpayOptions({ ...PAYMENT, prefill: { ...PAYMENT.prefill, method: 'netbanking' } }, { handler, onDismiss }).prefill).not.toHaveProperty('method');
	});

	it('no contact → contact is not read-only; missing bits get safe defaults', () => {
		const o = buildRazorpayOptions({ keyId: 'k', razorpayOrderId: 'o', amount: 100, notes: { wf_order: 'WF-10009' }, prefill: { email: 'a@b.co' } }, { handler, onDismiss });
		expect(o).not.toHaveProperty('readonly');
		expect(o).not.toHaveProperty('image');
		expect(o).not.toHaveProperty('callback_url');
		expect(o.description).toBe('Order WF-10009');
		expect(o.currency).toBe('INR');
		expect(o.timeout).toBe(900);
		expect(o.name).toBe('Wefeasto');
	});

	it('the UPI-collect hide list is a fresh copy each time', () => {
		const o = buildRazorpayOptions(PAYMENT, { handler, onDismiss });
		o.config.display.hide[0].flows.push('x');
		expect(HIDE_UPI_COLLECT[0].flows).toEqual(['collect']);
	});
});

describe('isPaymentInit', () => {
	it('needs a key, an order id, an amount ≥ ₹1 and a script', () => {
		expect(isPaymentInit(PAYMENT)).toBe(true);
		for (const patch of [{ keyId: '' }, { razorpayOrderId: null }, { amount: 99 }, { amount: 100.5 }, { checkoutScript: 5 }]) {
			expect(isPaymentInit({ ...PAYMENT, ...patch })).toBe(false);
		}
		expect(isPaymentInit(null)).toBe(false);
	});
});

describe('watchRender', () => {
	function box(el, visible = true) {
		el.getBoundingClientRect = () => ({ width: visible ? 400 : 0, height: visible ? 600 : 0 });
		return el;
	}

	it('nothing added → false; a visible element added to <body> → true', async () => {
		const w = watchRender(document);
		expect(w.rendered()).toBe(false);
		const el = box(document.createElement('div'));
		el.className = 'razorpay-container';
		document.body.appendChild(el);
		expect(w.rendered()).toBe(true);
		w.stop();
		el.remove();
	});

	it('seen() latches: a window that opened and closed between checks still counts', async () => {
		const w = watchRender(document);
		const el = box(document.createElement('div'));
		document.body.appendChild(el);
		await Promise.resolve(); // the observer sees it while it is up
		el.remove();
		expect(w.rendered()).toBe(false);
		expect(w.seen()).toBe(true);
		w.stop();
	});

	it('seen() is false when nothing ever showed', () => {
		const w = watchRender(document);
		const el = box(document.createElement('div'), false);
		document.body.appendChild(el);
		expect(w.seen()).toBe(false);
		w.stop();
		el.remove();
	});

	it('an added but hidden container (bad key: no modal) → false', () => {
		const w = watchRender(document);
		const el = box(document.createElement('div'), true);
		el.style.display = 'none';
		document.body.appendChild(el);
		expect(w.rendered()).toBe(false);
		w.stop();
		el.remove();
	});

	it('a Razorpay frame already on screen counts', () => {
		const frame = box(document.createElement('iframe'));
		frame.className = 'razorpay-checkout-frame';
		document.body.appendChild(frame);
		const w = watchRender(document);
		expect(w.rendered()).toBe(true);
		w.stop();
		frame.remove();
	});
});
