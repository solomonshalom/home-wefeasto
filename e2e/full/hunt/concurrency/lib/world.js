/*
 * The fuzzer's world: seeded RNG, the products/coupons/phones it plays with, and the invariants
 * (checked against one SQL snapshot so async webhooks/effects can't tear the view).
 */
import crypto from 'node:crypto';
import { canTransition } from '../../../../../cms/src/commerce/shared/order-status.js';

/** mulberry32: small, fast, seedable. */
export function rng(seed) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { next, int: (n) => Math.floor(next() * n), pick: (arr) => arr[Math.floor(next() * arr.length)], chance: (p) => next() < p };
}

export const CONFIRMED = ['paid', 'cod_pending', 'cod_confirmed', 'partially_refunded'];

/** Products at a known stock, two coupons, a small phone pool (so supersede / COD caps collide). */
export async function setupWorld(c, { seed, stock = 8, slugs = ['cornflakes', 'muesli'], couponLimits = [1, 2] } = {}) {
	const products = [];
	for (const slug of slugs) {
		const doc = (await c.adminReq('GET', `products?where[slug][equals]=${slug}&depth=0&limit=1`)).json.docs[0];
		const live = Number(doc.stock);
		if (live !== stock) {
			const r = await c.stockAdjust(doc.id, stock - live);
			if (r.status !== 200) throw new Error(`setup stock ${slug}: ${r.status} ${r.text.slice(0, 200)}`);
		}
		products.push({ id: doc.id, slug, price: doc.pricePaise });
	}
	const tag = crypto.randomBytes(3).toString('hex').toUpperCase();
	const coupons = [];
	for (const [i, usageLimit] of couponLimits.entries()) {
		const code = `HC${seed % 1000}${tag}${i}`;
		const r = await c.adminReq('POST', 'coupons?depth=0', { code, type: 'fixed', value: 1000, active: true, usedCount: 0, firstOrderOnly: false, usageLimit });
		if (r.status !== 201 && r.status !== 200) throw new Error(`setup coupon: ${r.status} ${r.text.slice(0, 200)}`);
		coupons.push({ id: (r.json.doc ?? r.json).id, code, usageLimit });
	}
	const phones = Array.from({ length: 3 }, () => `+919${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`);
	return {
		seed,
		products,
		base: new Map(products.map((p) => [p.id, stock])),
		adjusted: new Map(products.map((p) => [p.id, 0])),
		coupons,
		phones,
		emails: phones.map((_, i) => `hunt-conc-${tag.toLowerCase()}-${i}@e2e.wefeasto.test`),
		orders: [],
		checkouts: [],
		payments: [],
		events: [],
		trace: [],
		violations: []
	};
}

const numbersOf = (w) => w.orders.map((o) => o.number);

/** Invariants that must hold at every instant (one SQL statement per check). */
export async function checkAlways(c, w, label) {
	const out = [];
	const nums = numbersOf(w);
	const ids = w.products.map((p) => p.id);
	const rows = await c.db.query(
		`select p.id, p.stock::int as stock,
		        coalesce((select sum(i.qty) from orders_items i join orders o on o.id = i._parent_id
		                   where i.product_id = p.id and o.number = any($2::text[]) and o.stock_state in ('reserved','committed')), 0)::int as held
		   from products p where p.id = any($1::int[])`,
		[ids, nums]
	);
	for (const r of rows) {
		const expect = w.base.get(r.id) + w.adjusted.get(r.id);
		if (r.stock < 0) out.push(`stock of product ${r.id} is negative: ${r.stock}`);
		if (r.stock + r.held !== expect) out.push(`stock conservation product ${r.id}: stock ${r.stock} + held ${r.held} = ${r.stock + r.held}, expected ${expect}`);
	}
	const cps = await c.db.query(
		`select c.id, c.code, c.usage_limit::int as lim, c.used_count::int as used,
		        (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'consumed')::int as consumed,
		        (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'reserved')::int as reserved
		   from coupons c where c.id = any($1::int[])`,
		[w.coupons.map((x) => x.id)]
	);
	for (const r of cps) {
		if (r.used !== r.consumed) out.push(`coupon ${r.code}: usedCount ${r.used} != consumed redemptions ${r.consumed}`);
		if (r.lim != null && r.used > r.lim) out.push(`coupon ${r.code}: usedCount ${r.used} > usageLimit ${r.lim}`);
		if (r.lim != null && r.used + r.reserved > r.lim) out.push(`coupon ${r.code}: used ${r.used} + reserved ${r.reserved} > usageLimit ${r.lim}`);
	}
	// status history: continuous and every step allowed by the shared machine
	const hist = await c.db.query(
		`select o.number, o.status, h.field, h."from" as f, h."to" as t from orders o join orders_status_history h on h._parent_id = o.id
		  where o.number = any($1::text[]) order by o.number, h._order`,
		[nums]
	);
	const last = new Map();
	for (const h of hist) {
		if (h.field !== 'status') continue;
		const prev = last.get(h.number);
		if (prev !== undefined && h.f !== prev) out.push(`${h.number}: status history jumps: previous row ended at ${prev}, next row starts from ${h.f} → ${h.t}`);
		if (h.f && !canTransition(h.f, h.t)) out.push(`${h.number}: status history ${h.f} → ${h.t} is not allowed by the shared machine`);
		last.set(h.number, h.t);
	}
	// (same statement as the history rows, so both come from one snapshot)
	const cur = new Map(hist.map((h) => [h.number, h.status]));
	for (const [n, st] of cur) if (last.has(n) && last.get(n) !== st) out.push(`${n}: status ${st} but history ends at ${last.get(n)}`);
	for (const e of c.serverErrors.splice(0)) out.push(`5xx: ${e.what} → ${e.status} ${e.text}`);
	for (const v of out) w.violations.push({ at: label, v });
	return out;
}
