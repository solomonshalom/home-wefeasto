/*
 * Found while driving admin product Saves for the concurrency hunt (W5 r2): the documented way to change
 * stock in the admin, "Adjust stock by (±N)" on a product's "Stock & ordering" tab, is a disabled input.
 * Payload's field sanitizer forces `admin.readOnly = true` on every `virtual: true` field unless the config
 * says `admin.readOnly: false` (payload/dist/fields/config/sanitize.js), and `stockAdjust` is virtual.
 * So the owner cannot restock (or write off) a product from the admin at all; the stored `stock` is not in
 * the form either (admin.disabled), and "Stock (packs)" is read-only by design.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-concurrency/r2-admin-stock-adjust-ui.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { adminLogin } from './helpers.js';

test.use({ failOnConsoleErrors: false });

test('admin UI: "Adjust stock by" +5 then "Publish changes" adds 5 packs', async ({ page, stack, admin, db }) => {
	test.setTimeout(120_000);
	await admin.setStock('choco-flakes', 40);
	const p = await admin.getProduct('choco-flakes');
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/products/${p.id}`);
	const tab = page.getByRole('button', { name: 'Stock & ordering' });
	await tab.waitFor({ timeout: 30_000 });
	await tab.click();
	const adjust = page.locator('#field-stockAdjust');
	await adjust.waitFor({ timeout: 30_000 });
	await expect(adjust, 'the "Adjust stock by (±N)" input').toBeEditable({ timeout: 10_000 });
	await adjust.fill('5');
	await page.getByRole('button', { name: 'Publish changes' }).click();
	await expect.poll(async () => Number((await db.query(`select stock from products where slug = 'choco-flakes'`))[0].stock), { timeout: 15_000 }).toBe(45);
});
