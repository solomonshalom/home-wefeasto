/*
 * Property-style tests: seeded random inputs (reproducible), invariants that
 * must hold for every cart, coupon, link and event sequence.
 */
import { describe, it, expect } from 'vitest';
import { quote, topUpSuggestion, buildLines, parseItems, indexCatalog } from '$shared/pricing.js';
import { evaluateCoupon } from '$shared/coupons.js';
import { parseAddParam, buildAddParam, cartSignature } from '$shared/cart-links.js';
import { normalizeINMobile } from '$shared/validate.js';
import { isPaise, MIN_ORDER_PAISE } from '$shared/money.js';
import { resolveSettings } from '$shared/settings.js';
import { nextStatus, isConfirmed, ORDER_STATUSES, ORDER_EVENTS } from '$shared/order-status.js';
import { makeCatalog, prng, SLUGS } from './_fixtures.js';

const N = 2500;

/* ---------- generators ---------- */

const GARBAGE_QTY = [0, -1, -5, 2.5, '1e3', '0x10', ' 3', '03', '', null, undefined, true, [], {}, NaN, Infinity, 99999, '2.5'];

function randomCatalog(r) {
	return makeCatalog().map((p) => {
		const out = { ...p };
		if (r.bool(0.15)) out.inStock = false;
		if (r.bool(0.2)) out.stock = r.int(0, 12);
		if (r.bool(0.2)) out.maxPerOrder = r.int(1, 12);
		if (r.bool(0.15)) out.codAllowed = false;
		if (r.bool(0.05)) out.published = false;
		if (r.bool(0.1)) out.pricePaise = r.int(1, 60000);
		return out;
	});
}

function randomItems(r) {
	const n = r.int(0, 8);
	const items = [];
	for (let i = 0; i < n; i++) {
		const slug = r.bool(0.85) ? r.pick(SLUGS) : r.pick(['ghost', '__proto__', 'constructor', 'Muesli', '', 'x'.repeat(70)]);
		const qty = r.bool(0.85) ? r.int(1, 12) : r.bool(0.5) ? String(r.int(1, 12)) : r.pick(GARBAGE_QTY);
		items.push({ slug, qty });
	}
	return r.bool(0.5) ? items : Object.fromEntries(items.map((i) => [i.slug, i.qty]));
}

function randomSettings(r) {
	return {
		freeDeliveryThresholdPaise: r.pick([49900, 0, 30000, 100000, r.int(0, 200000)]),
		deliveryFeePaise: r.pick([4900, 3900, 0, r.int(1, 10000)]),
		codEnabled: r.bool(0.85),
		codMaxPaise: r.pick([200000, 50000, r.int(0, 300000)]),
		codFeePaise: r.pick([0, 0, 2500, r.int(0, 5000)]),
		codMinSubtotalPaise: r.pick([0, 0, 19900, r.int(0, 60000)]),
		maxOrderPaise: r.pick([5000000, 100000, r.int(0, 400000)]),
		topUpDiscoveryBiasPaise: r.pick([5000, 0, r.int(0, 20000)]),
		blockedPinPrefixes: r.bool(0.2) ? ['79'] : [],
		codBlockedPinPrefixes: r.bool(0.2) ? ['5'] : []
	};
}

function randomCoupon(r, now) {
	if (r.bool(0.4)) return null;
	const type = r.pick(['percent', 'fixed', 'free_delivery']);
	return {
		code: 'RANDOM1',
		type,
		value: type === 'percent' ? r.int(1, 100) : type === 'fixed' ? r.int(1, 100000) : undefined,
		maxDiscountPaise: r.bool(0.5) ? r.int(0, 20000) : null,
		minSubtotalPaise: r.bool(0.3) ? r.int(0, 60000) : null,
		startsAt: r.bool(0.2) ? now + r.int(-5, 5) * 86400000 : null,
		endsAt: r.bool(0.2) ? now + r.int(-5, 5) * 86400000 : null,
		usageLimit: r.bool(0.2) ? r.int(0, 3) : null,
		usedCount: r.int(0, 3),
		active: r.bool(0.95)
	};
}

/* ---------- quote invariants ---------- */

describe('quote invariants (randomized)', () => {
	const MONEY = ['subtotalPaise', 'discountPaise', 'deliveryPaise', 'codFeePaise', 'totalPaise', 'amountToFreeDeliveryPaise', 'freeDeliveryThresholdPaise'];

	it(`hold for ${N} random carts × settings × coupons × methods`, () => {
		const r = prng(499);
		const now = Date.parse('2026-09-25T10:00:00Z');
		for (let i = 0; i < N; i++) {
			const catalog = randomCatalog(r);
			const items = randomItems(r);
			const settings = randomSettings(r);
			const coupon = randomCoupon(r, now);
			const method = r.pick(['upi', 'card', 'cod', undefined, 'bogus']);
			const pin = r.pick([undefined, '560001', '791001', '500001']);
			const args = { items, catalog, settings, coupon, method, context: { now, pin, couponCode: r.bool(0.1) ? 'NOPE' : undefined } };
			const q = quote(args);
			const s = resolveSettings(settings);
			const ctx = `case ${i}: ${JSON.stringify({ items, settings, coupon, method })}`;

			for (const k of MONEY) expect(isPaise(q[k]), `${k} ${ctx}`).toBe(true);
			expect(q.totalPaise, ctx).toBe(q.subtotalPaise - q.discountPaise + q.deliveryPaise + q.codFeePaise);
			expect(q.discountPaise, ctx).toBeLessThanOrEqual(q.subtotalPaise);
			if (s.deliveryFeePaise > 0) {
				expect(q.deliveryPaise === 0, ctx).toBe(q.subtotalPaise === 0 || q.subtotalPaise >= s.freeDeliveryThresholdPaise);
			}
			if (q.lines.length > 0) {
				expect(q.totalPaise, ctx).toBeGreaterThanOrEqual(Math.min(MIN_ORDER_PAISE, q.subtotalPaise + q.deliveryPaise + q.codFeePaise));
			} else {
				expect(q.totalPaise, ctx).toBe(0);
				expect(q.orderError).toEqual({ code: 'EMPTY_CART' });
			}
			expect(q.subtotalPaise).toBe(q.lines.reduce((a, l) => a + l.lineTotalPaise, 0));
			expect(q.itemCount).toBe(q.lines.reduce((a, l) => a + l.qty, 0));
			const index = indexCatalog(catalog);
			for (const l of q.lines) {
				const p = index.get(l.slug);
				expect(l.lineTotalPaise).toBe(l.unitPaise * l.qty);
				expect(l.unitPaise).toBe(p.pricePaise);
				expect(l.qty).toBeGreaterThanOrEqual(1);
				expect(l.qty).toBeLessThanOrEqual(l.maxPerOrder);
				expect(p.inStock).not.toBe(false);
				if (typeof p.stock === 'number') expect(l.qty).toBeLessThanOrEqual(p.stock);
			}
			const slugsSeen = [...q.lines.map((l) => l.slug), ...q.issues.map((x) => x.slug)];
			expect(new Set(slugsSeen).size, ctx).toBe(slugsSeen.length); // merged: each slug once
			expect(q.canCheckout).toBe(q.issues.length === 0 && q.orderError === null);
			expect(q.codAvailable).toBe(q.codUnavailableReason === null);
			expect(q.freeDeliveryProgress).toBeGreaterThanOrEqual(0);
			expect(q.freeDeliveryProgress).toBeLessThanOrEqual(1);
			// A delivery fee of 0 makes every non-empty bag free delivery: nothing left to go.
			const freeForAll = s.deliveryFeePaise === 0 && q.subtotalPaise > 0;
			expect(q.isFreeDelivery, ctx).toBe(q.subtotalPaise > 0 && (freeForAll || q.subtotalPaise >= s.freeDeliveryThresholdPaise));
			if (q.isFreeDelivery) expect(q.freeDeliveryProgress, ctx).toBe(1);
			expect(q.amountToFreeDeliveryPaise).toBe(q.subtotalPaise === 0 ? s.freeDeliveryThresholdPaise : freeForAll ? 0 : Math.max(0, s.freeDeliveryThresholdPaise - q.subtotalPaise));
			if (q.method !== 'cod') expect(q.codFeePaise).toBe(0);
			if (q.couponError) {
				expect(q.discountPaise).toBe(0);
				expect(q.coupon).toBeNull();
			}
			if (q.orderError?.code === 'ABOVE_MAX') expect(q.totalPaise).toBeGreaterThan(s.maxOrderPaise);
			if (q.lines.length && q.totalPaise <= s.maxOrderPaise && q.totalPaise >= MIN_ORDER_PAISE) expect(q.orderError).toBeNull();

			// deterministic, JSON-safe, container-independent
			expect(quote(args)).toEqual(q);
			expect(JSON.parse(JSON.stringify(q))).toEqual(q);
			expect(quote({ ...args, catalog: indexCatalog(catalog) })).toEqual(q);
		}
	});

	it('totals do not depend on item order', () => {
		const r = prng(7);
		const catalog = makeCatalog();
		for (let i = 0; i < N; i++) {
			const items = Array.from({ length: r.int(1, 7) }, () => ({ slug: r.pick(SLUGS), qty: r.int(1, 6) }));
			const a = quote({ items, catalog, method: 'upi' });
			const b = quote({ items: r.shuffle(items), catalog, method: 'upi' });
			for (const k of ['subtotalPaise', 'discountPaise', 'deliveryPaise', 'totalPaise', 'canCheckout', 'codAvailable']) expect(b[k]).toEqual(a[k]);
			expect([...b.lines].sort((x, y) => (x.slug < y.slug ? -1 : 1))).toEqual([...a.lines].sort((x, y) => (x.slug < y.slug ? -1 : 1)));
		}
	});

	it('parseItems + quote agree with buildLines on well-formed requests', () => {
		const r = prng(11);
		const catalog = makeCatalog();
		for (let i = 0; i < N; i++) {
			const raw = Array.from({ length: r.int(1, 8) }, () => ({ slug: r.pick(SLUGS), qty: r.bool(0.8) ? r.int(1, 9) : String(r.int(1, 9)) }));
			const parsed = parseItems(raw);
			expect(parsed.ok).toBe(true);
			const q = quote({ items: parsed.ok ? parsed.items : [], catalog });
			expect(q.lines).toEqual(buildLines(raw, catalog).lines);
		}
	});
});

/* ---------- coupon invariants ---------- */

describe('evaluateCoupon invariants (randomized)', () => {
	it(`discount is a safe integer, ≤ subtotal, keeps ₹1 and is 0 on error — ${N} cases`, () => {
		const r = prng(1010);
		const now = Date.parse('2026-09-25T10:00:00Z');
		for (let i = 0; i < N; i++) {
			const coupon = randomCoupon(r, now) ?? { code: 'X10', type: 'percent', value: 10 };
			const subtotalPaise = r.pick([0, r.int(1, 1000), r.int(1000, 200000)]);
			const deliveryPaise = r.pick([0, 4900, r.int(0, 10000)]);
			const codFeePaise = r.pick([0, 2500]);
			const res = evaluateCoupon(coupon, { subtotalPaise, deliveryPaise, codFeePaise, now });
			expect(isPaise(res.discountPaise)).toBe(true);
			expect(res.discountPaise).toBeLessThanOrEqual(subtotalPaise);
			if (res.error) expect(res.discountPaise).toBe(0);
			if (subtotalPaise > 0) expect(subtotalPaise - res.discountPaise + deliveryPaise + codFeePaise).toBeGreaterThanOrEqual(Math.min(MIN_ORDER_PAISE, subtotalPaise + deliveryPaise + codFeePaise));
			if (!res.error && coupon.type === 'percent') {
				// whole rupees, unless the cap or the ₹1/subtotal clamp decided the amount
				expect(res.discountPaise % 100 === 0 || res.clamped || res.discountPaise === coupon.maxDiscountPaise).toBe(true);
			}
			expect(evaluateCoupon(coupon, { subtotalPaise, deliveryPaise, codFeePaise, now })).toEqual(res);
		}
	});
});

/* ---------- top-up invariants + independent oracle ---------- */

/** Brute-force reference: enumerate candidates, score, pick — written independently of pricing.js. */
function oracleTopUp(cart, catalog, settings, exclude = []) {
	const s = resolveSettings(settings);
	const { lines, issues } = buildLines(cart, catalog);
	const subtotal = lines.reduce((a, l) => a + l.lineTotalPaise, 0);
	const gap = s.freeDeliveryThresholdPaise - subtotal;
	if (subtotal === 0 || gap <= 0 || s.deliveryFeePaise === 0) return null;
	const bag = new Map();
	for (const l of lines) bag.set(l.slug, l.qty);
	for (const x of issues) if (typeof x.requestedQty === 'number') bag.set(x.slug, x.requestedQty);
	const candidates = [];
	catalog.forEach((p, i) => {
		if (exclude.includes(p.slug) || p.published === false || p.inStock === false) return;
		if (!(Number.isSafeInteger(p.pricePaise) && p.pricePaise > 0)) return;
		const next = (bag.get(p.slug) ?? 0) + 1;
		const max = Number.isSafeInteger(p.maxPerOrder) && p.maxPerOrder >= 1 ? p.maxPerOrder : 10;
		const stock = typeof p.stock === 'number' ? p.stock : Infinity;
		if (next > max || next > stock) return;
		candidates.push({ p, i, inCart: bag.has(p.slug) });
	});
	if (!candidates.length) return null;
	const crossing = candidates.filter((c) => c.p.pricePaise >= gap);
	let best;
	if (crossing.length) {
		const key = (c) => [c.p.pricePaise - gap + (c.inCart ? s.topUpDiscoveryBiasPaise : 0), c.p.pricePaise, c.i];
		best = crossing.reduce((a, b) => {
			const ka = key(a);
			const kb = key(b);
			for (let j = 0; j < 3; j++) if (ka[j] !== kb[j]) return ka[j] < kb[j] ? a : b;
			return a;
		});
	} else {
		const key = (c) => [c.inCart ? 1 : 0, -c.p.pricePaise, c.i];
		best = candidates.reduce((a, b) => {
			const ka = key(a);
			const kb = key(b);
			for (let j = 0; j < 3; j++) if (ka[j] !== kb[j]) return ka[j] < kb[j] ? a : b;
			return a;
		});
	}
	return best.p.slug;
}

describe('topUpSuggestion invariants (randomized)', () => {
	it(`never suggests out-of-stock, is deterministic and matches the oracle — ${N} cases`, () => {
		const r = prng(2026);
		for (let i = 0; i < N; i++) {
			const catalog = randomCatalog(r);
			const cart = {};
			for (let k = r.int(0, 4); k > 0; k--) cart[r.pick(SLUGS)] = r.bool(0.9) ? r.int(1, 11) : r.pick(GARBAGE_QTY);
			const settings = { freeDeliveryThresholdPaise: r.pick([49900, 49900, 30000, 80000, 150000]), topUpDiscoveryBiasPaise: r.pick([5000, 0, r.int(0, 20000)]), deliveryFeePaise: r.pick([4900, 4900, 4900, 0]) };
			const exclude = r.bool(0.2) ? [r.pick(SLUGS)] : [];
			const t = topUpSuggestion(cart, catalog, settings, { exclude });
			const ctx = `case ${i}: ${JSON.stringify({ cart, settings, exclude, catalog })}`;

			expect(t?.slug ?? null, ctx).toBe(oracleTopUp(cart, catalog, settings, exclude));
			// determinism + cart-order independence
			expect(topUpSuggestion(cart, catalog, settings, { exclude })).toEqual(t);
			const reordered = Object.fromEntries(r.shuffle(Object.entries(cart)));
			expect(topUpSuggestion(reordered, catalog, settings, { exclude })).toEqual(t);
			if (!t) continue;

			const p = catalog.find((x) => x.slug === t.slug);
			expect(p.inStock, ctx).not.toBe(false);
			expect(p.published).not.toBe(false);
			if (typeof p.stock === 'number') expect(p.stock).toBeGreaterThan(0);
			expect(exclude).not.toContain(t.slug);
			expect(t.pricePaise).toBe(p.pricePaise);
			expect(t.crosses).toBe(p.pricePaise >= t.gapPaise);
			expect(t.gapPaise).toBeGreaterThan(0);
			expect(t.remainingAfterPaise).toBe(t.crosses ? 0 : t.gapPaise - t.pricePaise);
			expect(t.overshootPaise).toBe(t.crosses ? t.pricePaise - t.gapPaise : 0);
			for (const k of ['pricePaise', 'gapPaise', 'remainingAfterPaise', 'overshootPaise']) expect(isPaise(t[k])).toBe(true);
			// tapping "+ Add" (one more unit) never creates an issue for that line
			const current = cart[t.slug];
			if (current === undefined || (Number.isSafeInteger(current) && current > 0)) {
				const after = buildLines({ ...cart, [t.slug]: (current ?? 0) + 1 }, catalog);
				expect(after.issues.some((x) => x.slug === t.slug), ctx).toBe(false);
				expect(after.lines.some((l) => l.slug === t.slug)).toBe(true);
			}
		}
	});
});

/* ---------- cart links ---------- */

describe('cart-link round trip (randomized)', () => {
	it(`parseAddParam(buildAddParam(lines)) === lines — ${N} cases`, () => {
		const r = prng(314);
		const catalog = makeCatalog();
		for (let i = 0; i < N; i++) {
			const slugs = r.shuffle(SLUGS).slice(0, r.int(1, 6));
			const lines = slugs.map((slug) => ({ slug, qty: r.int(1, 10) }));
			const built = buildAddParam(lines);
			expect(parseAddParam(built, catalog)).toEqual({ lines, dropped: [] });
			// through a real URL (encodes ',' and ':')
			const url = new URL('https://wefeasto.com/cart');
			url.searchParams.set('add', built);
			expect(parseAddParam(new URL(url.href).searchParams.get('add'), catalog).lines).toEqual(lines);
			expect(cartSignature(lines)).toBe(cartSignature(r.shuffle(lines)));
		}
	});

	it(`garbage links never throw and always yield valid, idempotent lines — ${N} cases`, () => {
		const r = prng(2718);
		const catalog = makeCatalog({ 'rolled-oats': { inStock: false } });
		const pieces = [...SLUGS, 'ghost', '__proto__', 'MUESLI', ' muesli ', '%2C', '%3A', ':', ',', '-5', '1e9', '0', '2.5', 'abc', '%', '%E0', '+', ' ', ''];
		for (let i = 0; i < N; i++) {
			const s = Array.from({ length: r.int(0, 20) }, () => r.pick(pieces)).join(r.pick(['', ',', ':']));
			const { lines, dropped } = parseAddParam(s, catalog);
			expect(lines.length).toBeLessThanOrEqual(6);
			expect(new Set(lines.map((l) => l.slug)).size).toBe(lines.length);
			for (const l of lines) {
				expect(SLUGS).toContain(l.slug);
				expect(l.slug).not.toBe('rolled-oats');
				expect(Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= 10).toBe(true);
			}
			for (const d of dropped) expect(['UNKNOWN', 'OUT_OF_STOCK', 'BAD_QTY', 'TOO_MANY']).toContain(d.reason);
			expect(parseAddParam(buildAddParam(lines), catalog).lines).toEqual(lines);
		}
	});
});

/* ---------- phone normalisation ---------- */

describe('normalizeINMobile (randomized)', () => {
	it(`every formatting of a valid mobile normalises to the same E.164 — ${N} cases`, () => {
		const r = prng(9845);
		for (let i = 0; i < N; i++) {
			const national = String(r.int(6, 9)) + String(r.int(0, 999999999)).padStart(9, '0');
			const prefix = r.pick(['', '+91', '+91 ', '91', '0', '0091', '091', '+91-', '(+91) ']);
			const body = r.pick([national, national.slice(0, 5) + ' ' + national.slice(5), national.slice(0, 5) + '-' + national.slice(5), national.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')]);
			expect(normalizeINMobile(prefix + body)).toBe('+91' + national);
		}
	});

	it(`random strings normalise to null or a valid mobile — ${N} cases`, () => {
		const r = prng(2777);
		const chars = '0123456789 +-()abc.';
		for (let i = 0; i < N; i++) {
			const s = Array.from({ length: r.int(0, 18) }, () => r.pick([...chars])).join('');
			const n = normalizeINMobile(s);
			if (n !== null) expect(n).toMatch(/^\+91[6-9][0-9]{9}$/);
		}
	});
});

/* ---------- order status machine under shuffled event sequences ---------- */

describe('order status machine (shuffled sequences)', () => {
	const PAYMENT_EVENTS = ['paid', 'payment_failed', 'expire', 'retry'];

	it(`payment events in any order: final is paid iff a paid event arrived — ${N} cases`, () => {
		const r = prng(55);
		for (let i = 0; i < N; i++) {
			const events = Array.from({ length: r.int(0, 10) }, () => r.pick(PAYMENT_EVENTS));
			let s = 'pending_payment';
			let confirmed = false;
			for (const e of events) {
				const n = nextStatus(s, e);
				if (n !== null) s = n;
				expect(ORDER_STATUSES).toContain(s);
				if (confirmed) expect(isConfirmed(s)).toBe(true); // never un-confirmed
				confirmed = confirmed || isConfirmed(s);
			}
			expect(s === 'paid', JSON.stringify(events)).toBe(events.includes('paid'));
		}
	});

	it(`duplicate deliveries are idempotent and any event sequence stays inside the machine — ${N} cases`, () => {
		const r = prng(56);
		for (let i = 0; i < N; i++) {
			let s = r.pick(['pending_payment', 'cod_pending']);
			for (let k = r.int(1, 12); k > 0; k--) {
				const e = r.pick(ORDER_EVENTS);
				const n = nextStatus(s, e);
				if (n === null) continue;
				const again = nextStatus(n, e); // a duplicate delivery of the same event
				expect(again === n || again === null, `${s} -${e}-> ${n} -${e}-> ${again}`).toBe(true);
				s = n;
				expect(ORDER_STATUSES).toContain(s);
			}
			if (s === 'refunded') for (const e of ORDER_EVENTS) expect([null, 'refunded']).toContain(nextStatus(s, e));
		}
	});
});
