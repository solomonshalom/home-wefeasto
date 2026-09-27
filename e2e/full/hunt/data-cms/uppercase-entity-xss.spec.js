/*
 * HUNT data-cms (round 2): stored XSS through the recipe HTML gate, bypassing the round-1 fix (#27).
 *
 * UNSAFE_HTML_RE matches each letter of "javascript:" as the letter (case-insensitive) OR the numeric
 * character reference of its LOWER-CASE code point. The reference of the upper-case letter
 * (&#74; / &#x4A; = "J") is not matched, yet the browser decodes href="&#74;avascript:…" to
 * "Javascript:…" and URL schemes are case-insensitive, so the link runs script.
 *
 * Shown on the production stack: (1) a browser runs the markup; (2) a PUBLISHED recipe save with it
 * over REST is accepted (200) and it is served verbatim by /api/store/snapshot, which sync-cms accepts
 * and the storefront renders with {@html} on /recipes/<slug>.
 * Correct behaviour: the CMS refuses the save (400 on whyHtml).
 */
import { test, expect } from '../../fixtures.js';

const PAYLOAD = '<p><a id="hunt-x" href="&#74;avascript:window.__huntXss=1">Read more</a></p>';

test('recipe HTML with href="&#74;avascript:…" is refused on a published save', async ({ page, adminSession, api }) => {
	// (1) precondition: this markup executes script when clicked
	await page.setContent(`<!doctype html><body>${PAYLOAD}</body>`);
	await page.locator('#hunt-x').click();
	await expect.poll(() => page.evaluate(() => window.__huntXss)).toBe(1);

	// (2) the CMS accepts it on a published recipe
	const list = await adminSession.ok('GET', 'recipes?depth=0&limit=1&sort=sortOrder&where[_status][equals]=published');
	const recipe = list.docs[0];
	const original = recipe.whyHtml;
	try {
		const r = await adminSession.request('PATCH', `recipes/${recipe.id}?depth=0`, { body: { whyHtml: original + PAYLOAD, _status: 'published' } });
		if (r.status === 200) {
			const snap = await api.get('store/snapshot');
			const inSnapshot = snap.json?.recipes?.find((x) => x.slug === recipe.slug)?.whyHtml?.includes('&#74;avascript:');
			expect.soft(inSnapshot, 'served by /api/store/snapshot').toBe(true);
		}
		expect(r.status, `PATCH recipes/${recipe.id} whyHtml += ${PAYLOAD}`).toBe(400);
	} finally {
		await adminSession.request('PATCH', `recipes/${recipe.id}?depth=0`, { body: { whyHtml: original, _status: 'published' } });
	}
});
