/*
 * HUNT-CONC-R2-1: saving a coupon in the admin writes back the `usedCount` it read, undoing the +1 that
 * markPaid made meanwhile (consumeRedemption: `usedCount = usedCount + 1`). A single-use code then has
 * usedCount 0 with one consumed redemption, and checkout (which counts usedCount + reserved rows) accepts
 * the code again: a second order gets the discount.
 *
 *   1. admin UI: the coupon page is open (usedCount 0) while a customer pays with the code; the admin edits
 *      the note and saves (the ordinary "extend the campaign / fix the note" edit).
 *   2. REST: the same save as the form sends it (the whole document as loaded, usedCount included). A partial
 *      PATCH ({note}) that overlaps markPaid loses the increment the same way (Payload's update writes back
 *      the whole document it read), but that window is milliseconds wide.
 *
 * Run: E2E_SLOT=2 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/concurrency/coupon-usedcount-stale-save.spec.js
 */
import { test, expect, uniqueEmail } from '../../fixtures.js';
import { checkoutWithCoupon, couponBook, payAndVerify } from './lib/coupon-orders.js';

test.use({ failOnConsoleErrors: false });

async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

test('admin coupon Save while the code is being paid for keeps usedCount (single-use code stays used)', async ({ page, stack, admin, db }) => {
	test.setTimeout(120_000);
	await admin.setStock('cornflakes', 100);
	const coupon = await admin.createCoupon({ type: 'fixed', value: 1000, usageLimit: 1 });
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/coupons/${coupon.id}`);
	await page.locator('#field-note').waitFor({ timeout: 30_000 });
	// The admin starts editing (Payload checks for stale data once, on the first change: nothing moved yet).
	await page.locator('#field-note').fill('Diwali campaign');
	await page.waitForTimeout(1500);

	// A customer uses the code and pays while the admin is typing.
	const first = await checkoutWithCoupon(stack, { email: uniqueEmail('hc-cpn'), couponCode: coupon.code });
	expect(first.status, first.json && JSON.stringify(first.json)).toBe(201);
	const v = await payAndVerify(stack, first);
	expect(v.json?.order?.status ?? v.json?.status, v.text).toBe('paid');
	expect(await couponBook(db, coupon.code)).toMatchObject({ used: 1, consumed: 1 });

	// The admin finishes the note and saves.
	await page.locator('#field-note').fill('Diwali campaign — extended');
	const saved = page.waitForResponse((r) => r.url().includes(`/api/coupons/${coupon.id}`) && r.request().method() === 'PATCH');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await saved).status()).toBe(200);
	await expect(page.getByRole('dialog', { name: 'document-stale-data' })).toHaveCount(0);

	const book = await couponBook(db, coupon.code);
	expect.soft(book, 'usedCount must still count the paid order').toMatchObject({ used: 1, consumed: 1 });

	// So the single-use code is spent: another customer can't get the discount.
	const second = await checkoutWithCoupon(stack, { email: uniqueEmail('hc-cpn'), couponCode: coupon.code });
	expect.soft(second.status, `second use of a single-use code → ${second.status} ${JSON.stringify(second.json).slice(0, 200)}`).toBe(422);
	if (second.status === 201) await payAndVerify(stack, second);
	const end = await couponBook(db, coupon.code);
	expect(end.consumed, `a usageLimit-1 code was consumed by ${end.consumed} paid orders`).toBeLessThanOrEqual(1);
});

test('REST: a coupon PATCH carrying the document as it was loaded does not roll usedCount back', async ({ stack, admin, db }) => {
	test.setTimeout(60_000);
	await admin.setStock('cornflakes', 100);
	const coupon = await admin.createCoupon({ type: 'fixed', value: 1000, usageLimit: 1 });
	// What the admin form holds (and submits): the document as loaded, usedCount 0.
	const loaded = (await admin.request('GET', `coupons/${coupon.id}?depth=0`)).json;
	const placed = await checkoutWithCoupon(stack, { email: uniqueEmail('hc-cpn'), couponCode: coupon.code });
	expect(placed.status).toBe(201);
	expect((await payAndVerify(stack, placed)).json?.order?.status).toBe('paid');
	const { id, createdAt, updatedAt, ...form } = loaded;
	const r = await admin.request('PATCH', `coupons/${coupon.id}?depth=0`, { body: { ...form, note: 'extended' } });
	expect(r.status).toBe(200);
	expect(await couponBook(db, coupon.code), 'usedCount after the save').toMatchObject({ used: 1, consumed: 1 });
});
