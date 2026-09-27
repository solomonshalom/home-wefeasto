/*
 * cms-checkout (wave 5): the admin order form carries the order's `revision` (a hidden input) so a Save from a
 * page loaded before a server write is refused instead of erasing the review notes / releasing a hold.
 * Regression guard: the form must keep up with its OWN saves (the answer's new revision is merged into the
 * form), so an admin can pack and then ship from the same page without reloading; and a bulk edit from the
 * Orders list where one order is refused saves nothing.
 */
import { test, expect } from '../fixtures.js';

async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

// Right after a Save the form is still busy (fields read-only, then the saved document merged back in), which can
// swallow the click that opens the menu or close it again: open and choose until the choice shows.
async function pick(page, field, option) {
	const select = page.locator(`#field-${field}`);
	await expect(async () => {
		await page.keyboard.press('Escape');
		await select.click({ timeout: 5_000 });
		await page.getByRole('option', { name: option, exact: true }).click({ timeout: 2_000 });
		await expect(select).toContainText(option, { timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
}

async function save(page, id) {
	const res = page.waitForResponse((r) => r.url().includes(`/api/orders/${id}`) && r.request().method() === 'PATCH');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	return res;
}

/** A 200 Save: wait until Payload has finished with it (its toast) before touching the form again. */
async function saved(page, id) {
	const res = await save(page, id);
	expect(res.status(), await res.text()).toBe(200);
	await expect(page.getByText('Updated successfully.').first()).toBeVisible({ timeout: 15_000 });
	return res;
}

test('admin order page: pack, then ship, from the same page (consecutive Saves are not "stale")', async ({ page, stack, api, admin }) => {
	test.setTimeout(90_000);
	const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	expect((await admin.updateOrder(o.number, { status: 'cod_confirmed' })).status).toBe(200);
	const doc = await admin.findOrder(o.number);
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/orders/${doc.id}`);
	await page.locator('#field-fulfilmentStatus').waitFor({ timeout: 30_000 });

	await pick(page, 'fulfilmentStatus', 'packed');
	await saved(page, doc.id);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled(); // saved, nothing pending

	await pick(page, 'fulfilmentStatus', 'shipped');
	await saved(page, doc.id);
	expect(await admin.findOrder(o.number)).toMatchObject({ status: 'cod_confirmed', fulfilmentStatus: 'shipped', revision: doc.revision + 2 });
});

test('admin order page: a Save after another admin changed the order is refused, a reload saves', async ({ page, stack, api, admin }) => {
	test.setTimeout(90_000);
	const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	expect((await admin.updateOrder(o.number, { status: 'cod_confirmed' })).status).toBe(200);
	const doc = await admin.findOrder(o.number);
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/orders/${doc.id}`);
	await page.locator('#field-fulfilmentStatus').waitFor({ timeout: 30_000 });
	await pick(page, 'fulfilmentStatus', 'packed');
	await page.waitForTimeout(1000); // Payload's own stale-data check runs on the first change: nothing moved yet

	// Meanwhile another admin writes a note (no status change).
	expect((await admin.updateOrder(o.number, { reviewReason: 'Customer asked to hold until Monday.' })).status).toBe(200);
	const refused = await save(page, doc.id);
	expect(refused.status()).toBe(400);
	expect(await refused.text()).toContain('changed while you had it open');
	expect(await admin.findOrder(o.number)).toMatchObject({ fulfilmentStatus: 'unfulfilled', reviewReason: 'Customer asked to hold until Monday.' });

	await page.reload();
	await page.locator('#field-fulfilmentStatus').waitFor({ timeout: 30_000 });
	await pick(page, 'fulfilmentStatus', 'packed');
	const ok = await save(page, doc.id);
	expect(ok.status(), await ok.text()).toBe(200);
	expect(await admin.findOrder(o.number)).toMatchObject({ fulfilmentStatus: 'packed', reviewReason: 'Customer asked to hold until Monday.' });
});

test('Orders list bulk edit: one order refused → nothing saved, the answer says why', async ({ api, admin, adminSession }) => {
	const a = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	const b = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	expect((await admin.updateOrder(b.number, { status: 'cod_confirmed' })).status).toBe(200);
	// a is still cod_pending: it can't be packed; b could.
	const r = await adminSession.request('PATCH', `orders?where[number][in]=${a.number},${b.number}&depth=0`, { body: { fulfilmentStatus: 'packed' } });
	expect(r.status, r.text.slice(0, 300)).toBe(400);
	expect(r.text).toContain('Nothing was saved: 1 of 2 orders could not be updated.');
	expect(r.text).toContain(a.number);
	for (const n of [a.number, b.number]) expect((await admin.findOrder(n)).fulfilmentStatus).toBe('unfulfilled');
});
