/*
 * HUNT data-cms (round 4): the CMS publishes products the checkout can never sell.
 *
 * The shared checkout rules ($shared/validate.js isSlug, $shared/pricing.js) treat a product slug longer than
 * SLUG_MAX = 64 characters as malformed, and a unit price above MAX_UNIT_PAISE (₹1 crore) as a catalog error.
 * The Products collection checks neither: the slug is only matched against the kebab-case pattern, and when
 * it is left empty it is made from the name with no length cap (fillSlugAndSortOrder → slugify). So a product
 * named like a real listing ("Wefeasto Crunchy Muesli with Real Almonds Honey and Raisins Family Pack …")
 * is saved and published, appears in GET /api/store/catalog and the snapshot (so the storefront builds its
 * page and card with an Add to Cart), but every quote and checkout answers
 *   400 BAD_SLUG "An item in your bag is no longer available — remove it to continue."
 * Nothing tells the owner; the product just never sells.
 *
 * Correct behaviour: either the CMS refuses (or shortens) such a product when it is saved, or the checkout
 * prices it like any other published product.
 */
import { test, expect } from '../../fixtures.js';
import { productBody } from './helpers.js';

const created = [];
test.afterEach(async ({ admin }) => {
	while (created.length) await admin.request('DELETE', `products/${created.pop()}`);
});

/** POST a published product; resolves { status, doc, text }. */
async function publish(admin, overrides) {
	const body = await productBody(admin, { stock: 20, _status: 'published', ...overrides });
	const r = await admin.request('POST', 'products?depth=0', { body });
	if (r.status === 201) created.push(r.json.doc.id);
	return { status: r.status, doc: r.json?.doc, text: r.text };
}

test('a product whose slug is made from a long name is either refused or can be bought', async ({ admin, api }) => {
	const tag = Date.now().toString(36);
	const name = `Wefeasto Crunchy Muesli with Real Almonds Honey and Raisins Family Pack ${tag}`;
	const r = await publish(admin, { name }); // slug left empty: the CMS makes it from the name
	if (r.status === 400) return; // refused on save (or shortened below): fine
	expect(r.status, r.text.slice(0, 300)).toBe(201);
	const slug = r.doc.slug;

	const live = await api.get('store/catalog');
	expect(live.json.products.map((p) => p.slug), 'published → in the live catalog').toContain(slug);

	const q = await api.quote({ items: [{ slug, qty: 1 }], method: 'upi', pin: '560001' });
	expect(q.status, `slug ${slug} (${slug.length} chars): ${q.text.slice(0, 300)}`).toBe(200);
	expect(q.json.quote.lines.map((l) => l.slug)).toEqual([slug]);
});

test('a product priced above ₹1 crore is either refused or can be bought', async ({ admin, api }) => {
	const slug = `hunt-crore-${Date.now().toString(36)}`;
	const r = await publish(admin, { name: `Hunt ${slug}`, slug, pricePaise: 1_000_000_100 }); // ₹1,00,00,001
	if (r.status === 400) return; // refused on save: fine
	expect(r.status, r.text.slice(0, 300)).toBe(201);

	const live = await api.get('store/catalog');
	expect(live.json.products.map((p) => p.slug), 'published → in the live catalog').toContain(slug);

	await admin.updateSettings({ maxOrderPaise: 2_000_000_000 }); // restored after the test
	const q = await api.quote({ items: [{ slug, qty: 1 }], method: 'upi', pin: '560001' });
	expect(q.status, q.text.slice(0, 300)).toBe(200);
	expect(q.json.quote.lines.map((l) => l.slug), JSON.stringify(q.json.quote.issues)).toEqual([slug]);
});
