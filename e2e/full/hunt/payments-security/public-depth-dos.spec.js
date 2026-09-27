/*
 * Hunt (payments-security, round 3) — one anonymous GET freezes the whole CMS: ?depth= on the public
 * REST routes populates the product ↔ product ("Goes with") and recipe → product relations in a cycle.
 *
 * Payload's REST honours ?depth up to config.maxDepth (default 10) for anyone who may read the
 * collection, and products/recipes are public (publishedOrAdmin). goesWith links products to each other,
 * so every level multiplies the response: measured on the production stack (next start, 6 products,
 * 3 recipes) —
 *   GET /api/products?depth=8     → 200, 88 MB in 0.8 s
 *   GET /api/products?depth=10    → 500 after 3.3 s ("Invalid string length": a > 512 MB JSON string)
 *   GET /api/recipes?depth=10     → 500 after 35 s; a /api/store/catalog sent 2 s later waited 33 s
 *                                   (the event loop is blocked), CMS RSS 0.9 GB → 2.7 GB
 * No auth, no rate limit, and it works through the storefront's /api proxy. While it runs every other
 * request waits: checkout, /checkout/verify after a payment, Razorpay webhooks, the admin. One request
 * every ~30 s keeps the shop down; a few in parallel can exhaust the function's memory.
 *
 * Correct behaviour: a public read can't build an unbounded response — depth is capped for non-staff (or
 * the cyclic relations carry maxDepth), so these answer quickly with a small body, never a 500.
 */
import { test, expect } from '../../fixtures.js';

const MB = 1024 * 1024;

async function get(url) {
	const started = Date.now();
	const res = await fetch(url);
	const body = await res.arrayBuffer();
	return { status: res.status, bytes: body.byteLength, ms: Date.now() - started };
}

test('an anonymous ?depth= read of the catalog stays small and never fails', async ({ stack }) => {
	test.setTimeout(120_000);
	// The same catalog at the depth the storefront itself would ever need: ~100 KB.
	const normal = await get(`${stack.sfUrl}/api/products?depth=1&limit=100`);
	expect(normal.status).toBe(200);

	const deep8 = await get(`${stack.sfUrl}/api/products?depth=8&limit=100`);
	expect(deep8.status, JSON.stringify(deep8)).toBe(200);
	expect(deep8.bytes, `depth=8 answered ${(deep8.bytes / MB).toFixed(1)} MB in ${deep8.ms} ms`).toBeLessThan(5 * MB);

	const deep10 = await get(`${stack.sfUrl}/api/products?depth=10&limit=100`);
	expect(deep10.status, `depth=10 → ${deep10.status} after ${deep10.ms} ms`).toBeLessThan(500);
	expect(deep10.bytes).toBeLessThan(5 * MB);
});
