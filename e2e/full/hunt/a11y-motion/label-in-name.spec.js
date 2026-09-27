/*
 * HUNT a11y-motion (sf-account): /account "Buy again" fails WCAG 2.5.3 Label in Name.
 *
 * Each order row's button shows "Buy again" but its aria-label is "Buy WF-10008 again".
 * The visible words are not in the accessible name as a phrase, so a speech-input user
 * who says what they see ("click Buy again", Voice Control / Dragon) gets no match on
 * the account page; screen-reader users also hear a different label from the one shown.
 * The row's other button does it right: "View" → "View order WF-10008" starts with
 * the visible text.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/label-in-name.spec.js
 */
import { test, expect } from '../../fixtures.js';
import { signUpAndLogIn } from '../../experience/helpers.js';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

test('/account order rows: every button’s accessible name contains its visible label', async ({ page, shop, mailpit, unique }) => {
	const email = unique.email('hunt-lin');
	await signUpAndLogIn(page, { shop, mailpit, email });
	await shop.placeCodOrder({ items: { cornflakes: 1 }, form: { email } });
	await shop.visit('/account');
	const controls = page.locator('[data-wf-orders] a, [data-wf-orders] button');
	await expect(page.locator('[data-wf-orders] [data-wf-buy-again]').first()).toBeVisible();

	const bad = [];
	for (const el of await controls.all()) {
		const visible = norm(await el.innerText());
		const name = norm(await el.getAttribute('aria-label')) || visible;
		if (visible && !name.includes(visible)) bad.push(`visible "${visible}" vs accessible name "${name}"`);
	}
	expect(bad, 'controls whose accessible name does not contain the visible label').toEqual([]);
});
