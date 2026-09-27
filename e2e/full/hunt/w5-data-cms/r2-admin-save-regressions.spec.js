/*
 * Regressions for the wave-5 round-2 cms-platform fixes, driven through the real admin UI (production build):
 *   - "Adjust stock by (±N)" is editable; a Publish applies it ONCE (the field is blank again afterwards, so a
 *     second Publish without typing changes nothing), and Save draft applies a negative adjustment;
 *   - a customer page kept open across the customer's own changes: the Save keeps them (merge per field,
 *     src/auth/customerEdits.ts), a second Save from the same page works, and a field both sides changed is
 *     refused with a "reload" error instead of overwriting the customer's value.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/w5-data-cms/r2-admin-save-regressions.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { createCustomer, sfApi } from '../../accounts/helpers.js';
import { signedInCustomer } from './helpers.js';

test.use({ failOnConsoleErrors: false });

async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

const stockOf = async (db, slug) => Number((await db.query('select stock from products where slug = $1', [slug]))[0].stock);

test('admin UI: stock adjustments apply once per save (Publish, Publish again, Save draft)', async ({ page, stack, admin, db }) => {
	test.setTimeout(120_000);
	// Stock and the threshold (changed through the UI below) are restored by the fixture after the test.
	const before = await admin.getProduct('choco-flakes');
	await admin.updateProduct('choco-flakes', { stock: 40, lowStockThreshold: before.lowStockThreshold });
	const p = await admin.getProduct('choco-flakes');
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/products/${p.id}`);
	await page.getByRole('button', { name: 'Stock & ordering' }).click();
	const adjust = page.locator('#field-stockAdjust');
	await expect(adjust).toBeEditable({ timeout: 30_000 });
	await expect(page.locator('#field-stockOnHand')).not.toBeEditable();

	const saveAndWait = async (button) => {
		const saved = page.waitForResponse((r) => r.url().includes(`/api/products/${p.id}`) && r.request().method() === 'PATCH', { timeout: 20_000 });
		await page.getByRole('button', { name: button }).click();
		expect((await saved).status()).toBe(200);
	};
	await adjust.fill('5');
	await saveAndWait('Publish changes');
	await expect.poll(() => stockOf(db, 'choco-flakes'), { timeout: 15_000 }).toBe(45);
	await expect(adjust, 'the adjustment field is blank again after the save').toHaveValue('', { timeout: 10_000 });

	// An unrelated edit + Publish: the earlier +5 is not applied a second time.
	const threshold = page.locator('#field-lowStockThreshold');
	await threshold.fill(String((before.lowStockThreshold ?? 5) + 1));
	await saveAndWait('Publish changes');
	expect(await stockOf(db, 'choco-flakes')).toBe(45);

	await adjust.fill('-3');
	await saveAndWait('Save draft');
	await expect.poll(() => stockOf(db, 'choco-flakes'), { timeout: 15_000 }).toBe(42);
	await expect(adjust).toHaveValue('', { timeout: 10_000 });
	// Publishing the draft (so the fixture can restore the product) doesn't apply the -3 again.
	await saveAndWait('Publish changes');
	expect(await stockOf(db, 'choco-flakes')).toBe(42);
});

async function openCustomer(page, stack, id) {
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/customers/${id}`);
	await page.locator('#field-name').waitFor({ timeout: 30_000 });
}

async function saveCustomer(page, id) {
	const saved = page.waitForResponse((r) => r.url().includes(`/api/customers/${id}`) && r.request().method() === 'PATCH', { timeout: 20_000 });
	await page.getByRole('button', { name: 'Save' }).click();
	return saved;
}

test('admin UI: an open customer page keeps the verification that happened meanwhile, and saves twice', async ({ page, stack, mailpit, unique, admin }) => {
	test.setTimeout(120_000);
	const c = await createCustomer({ stack, mailpit, unique }, { verify: false, tag: 'w5r2fix' });
	const { id } = await admin.findCustomer(c.email);
	await openCustomer(page, stack, id);
	const token = new URL(c.verifyUrl).searchParams.get('verify');
	expect((await sfApi(stack, 'POST', `customers/verify/${encodeURIComponent(token)}`)).status).toBe(200);

	await page.locator('#field-name').fill('Asha K. Kumar');
	expect((await saveCustomer(page, id)).status()).toBe(200);
	expect(await admin.findCustomer(c.email)).toMatchObject({ name: 'Asha K. Kumar', _verified: true });

	// Same page, second Save: not stale (the response carried the new base).
	await page.locator('#field-phone').fill('+919812345678');
	expect((await saveCustomer(page, id)).status()).toBe(200);
	expect(await admin.findCustomer(c.email)).toMatchObject({ name: 'Asha K. Kumar', phone: '+919812345678', _verified: true });
});

test('admin UI: a name both the customer and the page changed is refused with a reload message', async ({ page, stack, adminSession, unique, admin }) => {
	test.setTimeout(120_000);
	const c = await signedInCustomer({ stack, adminSession, unique }, { tag: 'w5r2conf' });
	await openCustomer(page, stack, c.id);
	// The customer's own "Save details" on /account (name + phone) while the page is open.
	const own = await fetch(`${stack.sfUrl}/api/customers/${c.id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', ...c.headers },
		body: JSON.stringify({ name: 'Asha Nair', phone: null })
	});
	expect(own.status).toBe(200);

	await page.locator('#field-name').fill('Asha K.');
	const res = await saveCustomer(page, c.id);
	expect(res.status()).toBe(409);
	await expect(page.getByText(/changed after you opened the page/i).first()).toBeVisible({ timeout: 10_000 });
	expect((await admin.findCustomer(c.email)).name).toBe('Asha Nair');
});
