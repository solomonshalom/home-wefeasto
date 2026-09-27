/*
 * HUNT-CONC-3 (cms-platform, src/lib/productStock.ts): two admins (or an admin and a script) saving two
 * products that list each other under "Goes with" at the same moment deadlock in Postgres, and one of them
 * gets `500 Something went wrong.` (nothing saved).
 *
 * productStockBeforeChange locks the product row with `SELECT … FOR UPDATE`. The save then rewrites the
 * product's `products_rels` / `_products_v_rels` rows, whose foreign keys take FOR KEY SHARE on every
 * related product. FOR UPDATE conflicts with FOR KEY SHARE, so save(A) holding A waits for B while save(B)
 * holding B waits for A. (cms.log: `insert into "products_rels" … deadlock detected`.)
 * The seed links cornflakes ↔ muesli, so any two concurrent saves of those two products hit it.
 */
import { test, expect } from '../../fixtures.js';

test('concurrent saves of two products that "go with" each other never answer 5xx', async ({ adminSession, admin }) => {
	const a = await admin.getProduct('cornflakes');
	const b = await admin.getProduct('muesli');
	const rel = (p) => (p.goesWith ?? []).map((x) => (typeof x === 'object' ? x.id : x));
	expect(rel(a), 'seed: cornflakes goes with muesli').toContain(b.id);
	expect(rel(b), 'seed: muesli goes with cornflakes').toContain(a.id);

	const original = { [a.id]: a.lowStockThreshold ?? null, [b.id]: b.lowStockThreshold ?? null };
	const statuses = [];
	try {
		for (let i = 0; i < 8; i++) {
			const body = { lowStockThreshold: 3 + (i % 2) };
			const rs = await Promise.all([a.id, b.id].map((id) => adminSession.request('PATCH', `products/${id}?depth=0`, { body })));
			statuses.push(...rs.map((r) => (r.status >= 500 ? `${r.status} ${r.text.slice(0, 80)}` : r.status)));
		}
	} finally {
		for (const [id, v] of Object.entries(original)) await adminSession.ok('PATCH', `products/${id}?depth=0`, { body: { lowStockThreshold: v } });
	}
	expect(statuses.filter((s) => s !== 200)).toEqual([]);
});
