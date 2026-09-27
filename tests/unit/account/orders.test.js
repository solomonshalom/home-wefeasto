/*
 * /account order rows (src/routes/account/orders.js): OrderStatusDTO →
 * what a row shows, Buy again deep links and the View link rule.
 */
import { describe, it, expect } from 'vitest';
import { orderRow, orderDate, statusText, statusTone, itemsText, sortOrders } from '../../../src/routes/account/orders.js';
import { parseAddParam } from '$shared/cart-links.js';
import { STATUS_LABELS, FULFILMENT_LABELS, ORDER_STATUSES } from '$shared/order-status.js';
import { catalogForPricing } from '$lib/data/settings.js';
import { productBySlug } from '$lib/data/products.js';
import { parseArrival } from '$lib/checkout/order.js';
import { createHash } from 'node:crypto';

/** A 43-char base64url token, the shape of the backend's deriveOrderToken (HMAC-SHA256, base64url). */
const deriveLikeBackend = (seed) => createHash('sha256').update('order:' + seed).digest('base64url');

const dto = (over = {}) => ({
	number: 'WF-10001',
	status: 'paid',
	paymentStatus: 'captured',
	paymentMethod: 'online',
	requestedMethod: 'upi',
	fulfilmentStatus: 'unfulfilled',
	createdAt: '2026-09-25T20:15:00.000Z',
	paidAt: '2026-09-25T20:16:00.000Z',
	items: [
		{ slug: 'muesli', name: 'Muesli', qty: 2, unitPaise: 25000, lineTotalPaise: 50000, image: '/images/wefeasto/product-muesli.jpg' },
		{ slug: 'cornflakes', name: 'Cornflakes', qty: 1, unitPaise: 17500, lineTotalPaise: 17500, image: '/images/wefeasto/product-cornflakes.jpg' }
	],
	subtotalPaise: 67500,
	discountPaise: 0,
	deliveryPaise: 0,
	codFeePaise: 0,
	totalPaise: 67500,
	...over
});

describe('orderRow()', () => {
	it('maps a paid order', () => {
		const r = orderRow(dto());
		expect(r).toMatchObject({
			number: 'WF-10001',
			key: 'WF-10001',
			status: 'paid',
			statusText: STATUS_LABELS.paid,
			tone: 'good',
			itemsText: 'Muesli ×2 · Cornflakes',
			thumb: '/images/wefeasto/product-muesli.jpg',
			thumbAlt: 'Muesli',
			total: '₹675',
			buyAgainHref: '/cart?add=muesli:2,cornflakes:1&src=usual',
			viewHref: null
		});
		expect(r.date).toMatch(/^26 Sept? 2026$/); // 20:15 UTC is 26 Sep in IST
	});

	it('Buy again round-trips through the cart link parser', () => {
		const href = orderRow(dto()).buyAgainHref;
		const add = new URL(href, 'https://x').searchParams.get('add');
		expect(parseAddParam(add, catalogForPricing()).lines).toEqual([
			{ slug: 'muesli', qty: 2 },
			{ slug: 'cornflakes', qty: 1 }
		]);
	});

	it('View links to /order only when the DTO carries a usable token', () => {
		const token = 'q2Jx8b0v3M4sQ1eN7lK5pZ9wY6tR2uH8cD0fG4aB1iE';
		expect(orderRow(dto({ token })).viewHref).toBe(`/order?no=WF-10001&t=${token}`);
		for (const bad of [undefined, null, '', 'short', 'has space in the token value', 42, 'x'.repeat(300), 'a/b/c/d/e/f', 'tok%2Fen12']) {
			expect(orderRow(dto({ token: bad })).viewHref).toBeNull();
		}
		expect(orderRow(dto({ token, number: 'not-a-number' })).viewHref).toBeNull();
	});

	// orders/mine now carries `token` on every order (checkout-backend.md §1.8): every row gets View,
	// whatever its status, and /order reads back exactly the number and token the row linked with.
	it.each(ORDER_STATUSES)('a %s order with a backend token gets View, and /order reads the link back', (status) => {
		const token = deriveLikeBackend(status);
		const r = orderRow(dto({ status, token }));
		expect(r.viewHref).not.toBeNull();
		const a = parseArrival(new URL(r.viewHref, 'https://x').search);
		expect(a).toEqual({ no: 'WF-10001', t: token, failed: false, reason: null });
	});

	it('clamps buy-again quantities and drops malformed lines', () => {
		const r = orderRow(dto({ items: [{ slug: 'muesli', name: 'Muesli', qty: 40 }, { slug: 'Bad Slug', name: 'x', qty: 1 }, { slug: 'oats', name: 'Oats', qty: 0 }] }));
		expect(r.buyAgainHref).toBe('/cart?add=muesli:10&src=usual');
	});

	it('no buyable lines → no Buy again', () => {
		expect(orderRow(dto({ items: [] })).buyAgainHref).toBeNull();
		expect(orderRow(dto({ items: null })).buyAgainHref).toBeNull();
	});

	it('image: DTO image, else the product image, never other origins', () => {
		expect(orderRow(dto({ items: [{ slug: 'muesli', name: 'Muesli', qty: 1, image: '' }] }), productBySlug).thumb).toBe(productBySlug('muesli').image);
		expect(orderRow(dto({ items: [{ slug: 'muesli', name: 'Muesli', qty: 1, image: '//evil.com/x.png' }] })).thumb).toBe('');
		expect(orderRow(dto({ items: [{ slug: 'muesli', name: 'Muesli', qty: 1, image: 'javascript:alert(1)' }] })).thumb).toBe('');
		expect(orderRow(dto({ items: [{ slug: 'muesli', name: 'Muesli', qty: 1, image: 'https://cdn.example.com/m.jpg' }] })).thumb).toBe('https://cdn.example.com/m.jpg');
	});

	it('survives garbage', () => {
		for (const bad of [null, undefined, {}, { items: 'x' }, { number: 5, totalPaise: 'NaN' }]) {
			const r = orderRow(bad);
			expect(r.total).toBe('₹0');
			expect(r.number).toBeNull();
			expect(r.buyAgainHref).toBeNull();
			expect(typeof r.key).toBe('string');
		}
	});
});

describe('statusText() / statusTone()', () => {
	it('every order status has a label', () => {
		for (const status of ORDER_STATUSES) expect(statusText({ status })).toBe(STATUS_LABELS[status]);
	});

	it('a confirmed order on its way shows the fulfilment label', () => {
		expect(statusText({ status: 'paid', fulfilmentStatus: 'shipped' })).toBe(FULFILMENT_LABELS.shipped);
		expect(statusText({ status: 'cod_confirmed', fulfilmentStatus: 'delivered' })).toBe(FULFILMENT_LABELS.delivered);
		expect(statusText({ status: 'paid', fulfilmentStatus: 'unfulfilled' })).toBe(STATUS_LABELS.paid);
		// not confirmed → the payment state wins
		expect(statusText({ status: 'payment_failed', fulfilmentStatus: 'shipped' })).toBe(STATUS_LABELS.payment_failed);
	});

	it('unknown → "Order placed"', () => {
		expect(statusText({ status: 'weird' })).toBe('Order placed');
		expect(statusText(null)).toBe('Order placed');
	});

	it.each([
		['paid', 'good'],
		['cod_pending', 'good'],
		['cod_confirmed', 'good'],
		['partially_refunded', 'good'],
		['refunded', 'good'],
		['payment_failed', 'bad'],
		['expired', 'bad'],
		['cancelled', 'bad'],
		['pending_payment', 'wait'],
		['needs_review', 'wait']
	])('%s → %s', (status, tone) => {
		expect(statusTone({ status })).toBe(tone);
	});
});

describe('itemsText()', () => {
	it('names with ×qty, at most 3, then "+ n more"', () => {
		const items = ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ name, qty: i + 1 }));
		expect(itemsText({ items })).toBe('A · B ×2 · C ×3 + 2 more');
		expect(itemsText({ items: [{ name: 'A', qty: 1 }] })).toBe('A');
		expect(itemsText({ items: [{ qty: 2 }, null, { name: 'B', qty: '3' }] })).toBe('B');
		expect(itemsText({})).toBe('');
	});
});

describe('orderDate()', () => {
	it('formats in IST and tolerates junk', () => {
		expect(orderDate('2026-01-31T19:00:00.000Z')).toMatch(/^1 Feb 2026$/);
		expect(orderDate('nope')).toBe('');
		expect(orderDate(null)).toBe('');
		expect(orderDate(undefined)).toBe('');
	});
});

describe('sortOrders()', () => {
	it('newest first, without mutating', () => {
		const list = [dto({ number: 'WF-10001', createdAt: '2026-01-01T00:00:00Z' }), dto({ number: 'WF-10003', createdAt: '2026-03-01T00:00:00Z' }), dto({ number: 'WF-10002', createdAt: '2026-02-01T00:00:00Z' })];
		expect(sortOrders(list).map((o) => o.number)).toEqual(['WF-10003', 'WF-10002', 'WF-10001']);
		expect(list[0].number).toBe('WF-10001');
		expect(sortOrders(null)).toEqual([]);
	});
});
