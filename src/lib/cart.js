/*
 * Wefeasto cart — Svelte port of the WefeastoCart runtime from js/wefeasto.js.
 * Same storage contract: localStorage 'wefeasto_cart' holding {slug: qty}.
 * A cart saved by the original static site carries straight over.
 */
import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';
import { productBySlug } from '$lib/data/products.js';

const CART_KEY = 'wefeasto_cart';

function readRaw() {
	if (!browser) return {};
	try {
		const raw = window.localStorage.getItem(CART_KEY);
		const obj = raw ? JSON.parse(raw) : {};
		return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
	} catch (e) {
		return {};
	}
}

export const cart = writable(readRaw());

function write(obj) {
	if (browser) {
		try {
			window.localStorage.setItem(CART_KEY, JSON.stringify(obj));
		} catch (e) {
			/* private mode etc. — cart just won't persist */
		}
	}
	cart.set(obj);
}

function countOf(c) {
	let n = 0;
	for (const k in c) n += parseInt(c[k], 10) || 0;
	return n;
}

function totalOf(c) {
	let sum = 0;
	for (const k in c) {
		const p = productBySlug(k);
		if (p) sum += (parseInt(c[k], 10) || 0) * p.price;
	}
	return sum;
}

let current = readRaw();
cart.subscribe((c) => (current = c));

export const Cart = {
	read: () => ({ ...current }),
	add(slug, qty) {
		qty = Math.max(1, parseInt(qty, 10) || 1);
		const c = { ...current };
		c[slug] = (parseInt(c[slug], 10) || 0) + qty;
		write(c);
		// badge pop hook (mirrors popCartBadges in the original runtime)
		if (browser) window.dispatchEvent(new CustomEvent('wf:cart-add'));
		return c[slug];
	},
	setQty(slug, qty) {
		qty = parseInt(qty, 10) || 0;
		const c = { ...current };
		if (qty <= 0) delete c[slug];
		else c[slug] = qty;
		write(c);
	},
	remove(slug) {
		const c = { ...current };
		delete c[slug];
		write(c);
	},
	count: () => countOf(current),
	total: () => totalOf(current),
	items() {
		return Object.keys(current).map((k) => ({
			slug: k,
			qty: parseInt(current[k], 10) || 0,
			product: productBySlug(k)
		}));
	}
};

export const cartCount = derived(cart, countOf);
export const cartTotal = derived(cart, totalOf);
export const cartItems = derived(cart, (c) =>
	Object.keys(c).map((k) => ({ slug: k, qty: parseInt(c[k], 10) || 0, product: productBySlug(k) }))
);

// Console/debug parity with the original runtime.
if (browser) window.WefeastoCart = Cart;
