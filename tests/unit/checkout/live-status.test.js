// @vitest-environment jsdom
/*
 * Live regions and keyboard focus on the payment-recovery surfaces (hunt
 * a11y-motion: live-regions, order-focus; WCAG 4.1.3 + 2.4.3).
 * - /order: one visually hidden role=status line holds only the status; the
 *   views (receipt, Buy again, household pills, recipe cards) are not live.
 * - Pending-order banner: one role=status node for every view (idle →
 *   checking → stuck / review), text only, with the actions outside it;
 *   Check status keeps focus while checking, and when the view replaces it,
 *   focus moves to the new view's first action (Retry payment, View order).
 * End to end: e2e/full/hunt/a11y-motion/{live-regions,order-focus}.spec.js.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from '../../../node_modules/svelte/src/index-client.js';
import { TOKEN, ok } from './_helpers.js';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/cart'), state: {} }));
const net = vi.hoisted(() => ({ api: null }));
vi.mock('svelte', async () => await import('../../../node_modules/svelte/src/index-client.js'));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), preloadCode: vi.fn(async () => {}), afterNavigate: () => {}, replaceState: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api.js', () => ({ api: (...a) => net.api(...a), newIdempotencyKey: () => 'k' }));
vi.mock('$lib/track.js', () => ({ track: vi.fn() }));
vi.mock('$lib/fx.js', () => ({ motionOK: () => false, noMotion: () => true }));
vi.mock('$lib/session.js', async (orig) => ({ ...(await orig()), refresh: vi.fn(async () => ({ ok: true, user: null })) }));

const { default: Banner } = await import('$lib/components/PendingOrderBanner.svelte');
const { default: OrderPage } = await import('../../../src/routes/order/+page.svelte');

const NO = 'WF-10001';
const dto = (status, extra = {}) => ({ number: NO, status, paymentMethod: 'razorpay', requestedMethod: 'upi', totalPaise: 47400, items: [{ slug: 'muesli', qty: 1, name: 'Muesli', unitPaise: 47400, linePaise: 47400 }], contact: { firstName: 'Asha' }, canRetryPayment: true, createdAt: new Date().toISOString(), ...extra });
const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
	flushSync();
};

const store = new Map();
beforeAll(() => {
	// jsdom's localStorage is not usable under Node 25 + vitest: a Map-backed one.
	const local = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
	Object.defineProperty(window, 'localStorage', { configurable: true, value: local });
	// jsdom lays nothing out: focus.js only focuses rendered elements.
	Element.prototype.getClientRects = function () {
		return this.isConnected ? [{ top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10 }] : [];
	};
	window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
	window.scrollTo = () => {};
});

let app = null;
let target = null;
function open(C, path, props = {}) {
	route.url = new URL(path, 'http://localhost');
	window.history.replaceState(null, '', path);
	target = document.createElement('div');
	document.body.appendChild(target);
	app = mount(C, { target, props });
	flushSync();
	return target;
}
beforeEach(() => {
	store.clear();
	sessionStorage.clear();
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	target?.remove();
	vi.useRealTimers();
});

describe('pending-order banner: one live region, focus kept', () => {
	/** A status answer the test hands over when it chooses. */
	function gatedApi() {
		const waiting = [];
		net.api = () => new Promise((r) => waiting.push(r));
		return { answer: (res) => waiting.shift()(res), get count() { return waiting.length; } };
	}
	function banner() {
		window.localStorage.setItem('wefeasto_pending', JSON.stringify({ no: NO, t: TOKEN, at: Date.now(), cartSig: '' }));
		open(Banner, '/cart');
		const b = target.querySelector('[data-wf-pending]');
		expect(b).not.toBeNull();
		return b;
	}
	const statuses = (b) => b.querySelectorAll('[role="status"], [aria-live]:not([aria-live="off"])');

	it('idle: one status line, text only; Check status and × are outside it', () => {
		const b = banner();
		expect(statuses(b)).toHaveLength(1);
		const live = statuses(b)[0];
		expect(live.getAttribute('aria-live')).toBe('polite');
		expect(live.textContent).toBe(`Your order ${NO} is waiting for payment`);
		expect(live.querySelectorAll('a, button')).toHaveLength(0);
		expect(b.textContent).toContain(`Your order ${NO} is waiting for payment`);
	});

	it('Check status: focus stays on the button while checking; stuck → same status node, focus on Retry payment', async () => {
		const gate = gatedApi();
		const b = banner();
		const live = statuses(b)[0];
		const btn = b.querySelector('[data-wf-pending-check]');
		btn.focus();
		btn.click();
		flushSync();
		expect(b.getAttribute('data-wf-pending-view')).toBe('checking');
		expect(btn.isConnected).toBe(true);
		expect(document.activeElement).toBe(btn);
		expect(btn.getAttribute('aria-disabled')).toBe('true');
		expect(live.isConnected && live.textContent).toContain(`Checking order ${NO}…`);
		btn.click(); // a second press while checking does nothing
		await settle();
		expect(gate.count).toBe(1);
		gate.answer(ok({ order: dto('payment_failed') }));
		await settle();
		expect(b.getAttribute('data-wf-pending-view')).toBe('stuck');
		expect(statuses(b)[0]).toBe(live);
		expect(live.textContent).toContain('hasn’t come through');
		expect(live.querySelectorAll('a, button')).toHaveLength(0);
		expect(document.activeElement).toBe(b.querySelector('[data-wf-action="retry-payment"]'));
	});

	it('needs_review → focus moves to View order, the status says so in the same node', async () => {
		const gate = gatedApi();
		const b = banner();
		const live = statuses(b)[0];
		const btn = b.querySelector('[data-wf-pending-check]');
		btn.focus();
		btn.click();
		flushSync();
		gate.answer(ok({ order: dto('needs_review') }));
		await settle();
		expect(b.getAttribute('data-wf-pending-view')).toBe('review');
		expect(statuses(b)[0]).toBe(live);
		expect(live.textContent).toBe(`We’re checking order ${NO}`);
		expect(document.activeElement).toBe(b.querySelector('[data-wf-pending-review]'));
	});

	it('a mouse user who moved on keeps their place: nothing is focused for them', async () => {
		const gate = gatedApi();
		const b = banner();
		b.querySelector('[data-wf-pending-check]').click(); // Safari: a click never focuses a button
		flushSync();
		gate.answer(ok({ order: dto('payment_failed') }));
		await settle();
		expect(b.getAttribute('data-wf-pending-view')).toBe('stuck');
		expect(document.activeElement).toBe(document.body);
	});
});

describe('/order: the live region is the status line only', () => {
	const regions = (root) => [...root.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"]')];

	it('confirmed: one aria-live status line ("Order confirmed"); the view itself is not live', async () => {
		net.api = async (path) => (String(path).startsWith('/store/orders/status') ? ok({ order: dto('paid', { paymentMethod: 'razorpay' }) }) : ok({}));
		const root = open(OrderPage, `/order?no=${NO}&t=${TOKEN}`);
		const line = root.querySelector('[data-wf-order-status-line]');
		expect(line.getAttribute('role')).toBe('status');
		expect(line.getAttribute('aria-live')).toBe('polite');
		expect(line.classList.contains('wf-sr-only')).toBe(true);
		await settle();
		const view = root.querySelector('[data-wf-order-view]');
		expect(view.getAttribute('data-wf-order-view')).toBe('confirmed');
		expect(view.hasAttribute('aria-live')).toBe(false);
		expect(root.querySelector('[data-wf-order-status-line]')).toBe(line);
		expect(line.textContent).toBe('Order confirmed');
		const live = root.querySelectorAll('[aria-live]:not([aria-live="off"])');
		expect(live).toHaveLength(1);
		expect(line.querySelectorAll('a, button')).toHaveLength(0);
		for (const r of regions(root)) expect(r.querySelector('.wf-order-receipt, .wf-summary')).toBeNull();
	});

	it('failed: the line carries the failure copy; unknown order → "We couldn’t find that order"', async () => {
		net.api = async () => ok({ order: dto('payment_failed') });
		let root = open(OrderPage, `/order?no=${NO}&t=${TOKEN}&payment=failed&reason=BAD_REQUEST_ERROR`);
		await settle();
		expect(root.querySelector('[data-wf-order-view]').getAttribute('data-wf-order-view')).toBe('failed');
		expect(root.querySelector('[data-wf-order-status-line]').textContent).toMatch(/^Payment didn’t go through/);
		unmount(app);
		app = null;
		target.remove();
		root = open(OrderPage, '/order?no=WF-10002');
		await settle();
		expect(root.querySelector('[data-wf-order-status-line]').textContent).toBe('We couldn’t find that order');
	});
});
