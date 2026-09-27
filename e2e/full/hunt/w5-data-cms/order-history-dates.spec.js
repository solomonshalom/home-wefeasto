/*
 * HUNT data-cms (wave 5): the order's timeline in /admin shows dates only, US style, no time.
 *
 * Orders → an order → "Status History": each row's "At" (and Razorpay → Captured At, Refunds → Created At /
 * Processed At, Dispute → At, Consent → At, the attempt/payment log dates) is a date field without
 * admin.date.pickerAppearance, so Payload's DatePicker shows its default format "MM/dd/yyyy": 09/10/2026 for
 * a status change on 9 October at 14:05 IST. The owner (India, dd/mm) reads it as 10 September, and the time
 * of each payment / cancel / refund step — what a human needs when sorting out a needs_review order — is not
 * shown at all. (List columns use the root dateFormat and do show the time.)
 *
 * Correct behaviour: the order's timeline shows an unambiguous date with the time (e.g. "Oct 9, 2026 2:05 PM").
 */
import { test, expect } from '../../fixtures.js';

async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

test.use({ timezoneId: 'Asia/Kolkata', locale: 'en-IN' });

test('admin order view: the Status History "At" shows the time of each change, not only MM/dd/yyyy', async ({ page, stack, api, admin, db }) => {
	test.setTimeout(90_000);
	const o = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
	const doc = await admin.findOrder(o.number);
	// A status change on 9 October 2026, 14:05 IST (08:35 UTC): day and month tell apart only with a time/format.
	await db.query(`update orders_status_history set at = '2026-10-09T08:35:00.000Z' where _parent_id = $1`, [doc.id]);
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/orders/${doc.id}`);
	const history = page.locator('#field-statusHistory');
	await history.waitFor({ timeout: 30_000 });
	// Rows start collapsed: expand them all.
	for (const toggle of await history.locator('button.collapsible__toggle, .collapsible__toggle').all()) await toggle.click().catch(() => {});
	const at = history.locator('input[id$="-at"], .date-time-picker input, input[type="text"]').first();
	await at.waitFor({ timeout: 15_000 });
	const shown = await at.inputValue();
	expect(shown, `Status History → At shows "${shown}"`).toMatch(/2:05|14:05/);
	expect(shown).not.toBe('10/09/2026');
});
