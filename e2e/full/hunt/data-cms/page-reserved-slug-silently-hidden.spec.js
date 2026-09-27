/*
 * HUNT data-cms (round 3): a CMS page whose slug is a storefront path ("Terms" → terms, privacy, shop, …)
 * saves and publishes fine, and then never appears on the storefront.
 *
 * The storefront gives CMS pages a route (/<slug>) and a footer link only when the slug is not one of its
 * own top-level paths (src/params/policy.js RESERVED_SLUGS: terms, privacy, shop, account, cart, …); a
 * reserved slug is silently skipped (isRoutablePage → false). The Pages collection does not know that list:
 * an owner who creates a page titled "Terms" to update the terms gets slug "terms" filled in, ticks "Show on
 * the storefront", publishes, sees the storefront rebuild — and /terms keeps showing the old built-in terms,
 * with no footer link and no error anywhere. The slug can't be changed afterwards either (guardSlug).
 *
 * Correct behaviour: the CMS refuses (400, path "slug") a page slug the storefront can never route, so the
 * editor picks another one at create time.
 */
import { test, expect } from '../../fixtures.js';

const RESERVED = ['terms', 'privacy', 'shop', 'account', 'checkout'];

for (const slug of RESERVED) {
	test(`a page with the storefront path "/${slug}" as its slug is refused at save`, async ({ admin }) => {
		const existing = await admin.request('GET', `pages?where[slug][equals]=${slug}&depth=0&draft=true`);
		test.skip((existing.json?.docs ?? []).length > 0, `a page "${slug}" already exists`);
		const title = slug[0].toUpperCase() + slug.slice(1);
		const r = await admin.request('POST', 'pages?depth=0', {
			body: { title, bodyHtml: `<p>Our updated ${slug} page.</p>`, published: true, _status: 'published' }
		});
		try {
			expect(r.json?.doc?.slug ?? null, 'no page may be created under a reserved slug').toBeNull();
			expect(r.status, r.text.slice(0, 300)).toBe(400);
			expect(r.text).toMatch(/slug/i);
		} finally {
			if (r.json?.doc?.id) await admin.request('DELETE', `pages/${r.json.doc.id}`);
		}
	});
}
