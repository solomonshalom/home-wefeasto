/*
 * Hunt (client-ux, round 3): on a slow connection /checkout's prerendered form is on screen well
 * before its JavaScript has run. A customer who fills it in meanwhile — typically one tap on a
 * browser autofill suggestion, which fills name, phone, email, address, PIN, city AND State —
 * keeps every text field and the payment pill through hydration, but the State <select> is
 * silently reset to "Choose your state" (bind:value={form.state} hydrates with form.state = ''
 * and writes it to the DOM; text inputs keep what was typed). Pay then answers "Choose your
 * state." for a field the customer already filled.
 *
 * Correct: whatever the customer (or autofill) put in the form before hydration is still there
 * afterwards — State included — and Pay goes through.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/state-cleared-on-hydration.spec.js
 */
import { test, expect, setMockAuto, checkoutForm } from '../../fixtures.js';

test('a State picked (or autofilled) while /checkout loads survives hydration', async ({ page, shop }) => {
	await shop.setCart({ muesli: 1 });
	await setMockAuto(page, { auto: 'dismiss' });
	// Slow network: the page's JavaScript arrives only after the customer has filled the form.
	let release;
	const scripts = new Promise((r) => (release = r));
	await page.route(/\/_app\/immutable\/(entry|nodes|chunks)\//, async (route) => {
		await scripts;
		await route.continue();
	});
	await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
	const f = checkoutForm({ state: 'Karnataka' });
	for (const [id, v] of [['name', f.name], ['phone', f.phone], ['email', f.email], ['address', f.address], ['pin', f.pin], ['city', f.city]]) await page.fill('#wf-co-' + id, v);
	await page.selectOption('#wf-co-state', f.state);

	release();
	await page.waitForFunction(() => document.querySelector('#wf-place-order')?.getAttribute('data-wf-pay-state') === 'ready', null, { timeout: 20_000 });
	await expect(page.locator('#wf-co-name'), 'text fields keep their value').toHaveValue(f.name);
	await expect(page.locator('#wf-co-state'), 'the State the customer picked').toHaveValue('Karnataka');

	await page.locator('#wf-place-order').click();
	await expect(page.locator('#wf-co-state-err')).toHaveCount(0);
});
