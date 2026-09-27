/*
 * Hunt (client-ux): a PIN typed the way it's printed — "560 001" — loses its last digit.
 *
 * The shared validator explicitly accepts a spaced PIN (normalizePin: "'560 001' → '560001'"),
 * but /checkout's PIN input has maxlength="6", so the browser stops accepting keystrokes after
 * "560 00": the sixth digit can't be typed (or pasted). The field then holds a 5-digit PIN, City
 * and State aren't prefilled, and Pay says "Enter a valid PIN" until the customer works out that
 * the space is the problem.
 *
 * Correct: the field accepts "560 001" (e.g. maxlength ≥ 7 or strip spaces on input) and the
 * PIN reads as 560001.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/pin-with-space-truncated.spec.js
 */
import { test, expect } from '../../fixtures.js';

test('typing "560 001" into the PIN field keeps all six digits (and prefills Bengaluru)', async ({ page, shop }) => {
	await shop.setCart({ muesli: 1 });
	await shop.gotoCheckout();
	await page.locator('#wf-co-pin').click();
	await page.keyboard.type('560 001');
	const digits = (await page.locator('#wf-co-pin').inputValue()).replace(/\s+/g, '');
	expect(digits, 'the PIN the customer typed').toBe('560001');
	await expect(page.locator('#wf-co-city')).toHaveValue('Bengaluru', { timeout: 10_000 });
});
