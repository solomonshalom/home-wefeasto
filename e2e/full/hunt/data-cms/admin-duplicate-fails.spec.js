/*
 * HUNT data-cms (round 2): the admin "Duplicate" action fails for every product, recipe and page.
 *
 * Payload offers ⋯ → Duplicate on each document (POST /api/<collection>/:id/duplicate). The copy gets a
 * derived slug that the collections' own guard rejects (guardSlug: SLUG_RE / RECIPE_SLUG_RE), so the
 * editor gets a red toast "The following field is invalid: slug" for a field they never touched, and
 * no copy. (The copy would also carry the unique sortOrder.) Seen in the admin UI and over REST.
 *
 * Correct behaviour: Duplicate is not offered (disableDuplicate), or it creates a draft copy with a valid,
 * unused slug and sortOrder.
 */
import { test, expect } from '../../fixtures.js';

async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

test('admin UI: Duplicate on a product is either not offered or makes a copy', async ({ page, stack, admin }) => {
	const p = await admin.getProduct('health-mix');
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/products/${p.id}`);
	await page.locator('#field-name').waitFor({ timeout: 30_000 });
	await page.locator('.doc-controls__popup button, button.popup-button').first().click();
	const dup = page.getByRole('button', { name: /^Duplicate$/ });
	if (!(await dup.isVisible())) return; // not offered: fine
	await dup.click();
	const error = page.locator('[data-sonner-toast][data-type="error"]');
	await expect.poll(async () => ((await error.count()) ? await error.first().innerText() : new URL(page.url()).pathname), { timeout: 15_000 })
		.not.toBe(`/admin/collections/products/${p.id}`);
	const newId = new URL(page.url()).pathname.split('/').pop();
	if (newId !== String(p.id)) await admin.request('DELETE', `products/${newId}`);
	expect(await error.count(), `error toast: ${(await error.allInnerTexts()).join(' | ')}`).toBe(0);
});

for (const collection of ['products', 'recipes', 'pages']) {
	test(`REST: POST /api/${collection}/:id/duplicate is refused as not offered or succeeds`, async ({ adminSession }) => {
		const { docs } = await adminSession.ok('GET', `${collection}?depth=0&limit=1`);
		test.skip(!docs.length, `no ${collection}`);
		const r = await adminSession.request('POST', `${collection}/${docs[0].id}/duplicate?depth=0`, { body: {} });
		if (r.json?.doc?.id) await adminSession.request('DELETE', `${collection}/${r.json.doc.id}`);
		const invalidSlug = r.status === 400 && /slug/.test(r.text);
		expect(invalidSlug, `duplicate → ${r.status} ${r.text.slice(0, 200)}`).toBe(false);
	});
}
