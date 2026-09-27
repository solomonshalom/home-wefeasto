/*
 * The page-level cart wiring, with $app/environment mocked to the browser and
 * a stub window: initial sanitized read, the cross-tab 'storage' listener,
 * the wf:cart-add event on window, bfcache restore, and a page whose
 * localStorage getter throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 'test' }));

function memStorage(init = {}) {
	const m = new Map(Object.entries(init));
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
		get length() {
			return m.size;
		}
	};
}

function stubWindow(localStorage) {
	const target = new EventTarget();
	const win = {
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		dispatchEvent: target.dispatchEvent.bind(target),
		sessionStorage: memStorage(),
		location: { search: '' }
	};
	if (typeof localStorage === 'function') Object.defineProperty(win, 'localStorage', { get: localStorage });
	else win.localStorage = localStorage;
	vi.stubGlobal('window', win);
	return win;
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('page cart in the browser', () => {
	it('reads + sanitizes the stored cart at load and exposes window.WefeastoCart', async () => {
		const win = stubWindow(memStorage({ wefeasto_cart: JSON.stringify({ cornflakes: 2, ghost: 1, muesli: '1e9' }) }));
		const { Cart, cart, cartCount, cartTotal } = await import('$lib/cart.js');
		expect(get(cart)).toEqual({ cornflakes: 2 });
		expect(get(cartCount)).toBe(2);
		expect(get(cartTotal)).toBe(350);
		expect(win.WefeastoCart).toBe(Cart);
	});

	it('dispatches wf:cart-add on window with {slug, qty, source}', async () => {
		const win = stubWindow(memStorage());
		const { Cart } = await import('$lib/cart.js');
		const got = [];
		win.addEventListener('wf:cart-add', (e) => got.push(e.detail));
		Cart.add('muesli', 2, { source: 'pdp' });
		Cart.addMany([{ slug: 'cornflakes', qty: 1 }], { source: 'usual' });
		expect(got).toEqual([
			expect.objectContaining({ slug: 'muesli', qty: 2, source: 'pdp' }),
			expect.objectContaining({ slug: 'cornflakes', qty: 1, source: 'usual' })
		]);
	});

	it("follows another tab's writes via the 'storage' event", async () => {
		const ls = memStorage();
		const win = stubWindow(ls);
		const { cart, cartCount } = await import('$lib/cart.js');
		ls.setItem('wefeasto_cart', JSON.stringify({ 'rolled-oats': 3, junk: 9 }));
		win.dispatchEvent(Object.assign(new Event('storage'), { key: 'wefeasto_cart' }));
		expect(get(cart)).toEqual({ 'rolled-oats': 3 });
		expect(get(cartCount)).toBe(3);
		// other keys are ignored; key null (storage.clear() elsewhere) re-reads
		ls.setItem('wefeasto_cart', '{}');
		win.dispatchEvent(Object.assign(new Event('storage'), { key: 'wefeasto_colormix' }));
		expect(get(cartCount)).toBe(3);
		win.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
		expect(get(cartCount)).toBe(0);
	});

	it('re-reads on a bfcache restore (pageshow persisted)', async () => {
		const ls = memStorage();
		const win = stubWindow(ls);
		const { cart } = await import('$lib/cart.js');
		ls.setItem('wefeasto_cart', JSON.stringify({ muesli: 1 }));
		win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
		expect(get(cart)).toEqual({});
		win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
		expect(get(cart)).toEqual({ muesli: 1 });
	});

	it('a page whose localStorage getter throws still has a working cart', async () => {
		stubWindow(() => {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		});
		const { Cart, cart, readOffer, saveOffer } = await import('$lib/cart.js');
		const { readLastOrder } = await import('$lib/components/YourUsual.svelte');
		Cart.add('cornflakes', 2);
		Cart.addMany({ muesli: 1 });
		expect(get(cart)).toEqual({ cornflakes: 2, muesli: 1 });
		expect(readLastOrder()).toBeNull();
		await saveOffer('WELCOME10');
		expect((await readOffer())?.code).toBe('WELCOME10');
	});
});
