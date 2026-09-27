/*
 * HUNT a11y-motion (sf-account + sf-checkout): two Phase 2 text styles fade #333 with
 * `opacity: .7` instead of using a solid grey, so their contrast depends on the page
 * surface. On the default seashell page they pass (4.66:1), but in the 27 colour-mix
 * combinations that put blush (#ffdede) on the page background (every A*-S4, A*-S5, A*-S6
 * in static/color-combos.json) they drop to 4.43:1, below WCAG 1.4.3 AA (4.5:1):
 *
 *   - /account order history: "Placed <date>" (.wf-order-date, 13px);
 *   - /checkout PIN autofill hint: "PIN data © GeoNames (CC BY 4.0)" (.wf-pin-credit).
 *
 * The pre-Phase-2 site (2f60a63) has no text that fails under any of the 81 combos on
 * home, shop, PDP, cart, checkout, login, recipes and a recipe page, so these are the
 * only regressions. The mix is applied the way a shopper gets it: the stored
 * `wefeasto_colormix` mapping (here A1-S4, straight from static/color-combos.json).
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/colormix-contrast.spec.js
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../../fixtures.js';
import { signUpAndLogIn } from '../../experience/helpers.js';
import { seedStorage } from './helpers.js';

const COMBOS = JSON.parse(readFileSync(new URL('../../../../static/color-combos.json', import.meta.url), 'utf8')).combos;
const A1_S4 = COMBOS.find((c) => c.id === 'A1-S4').localStorage; // seashell → blush

test.use({ contextOptions: { reducedMotion: 'reduce' } });

/** axe color-contrast on `selector` once the mix is applied and colour transitions have settled. */
async function contrastFailures(page, selector) {
	await expect(page.locator('#wf-colormix-style')).toHaveCount(1); // the stored mix is applied
	await page.waitForTimeout(400); // .25 s colour transitions
	const r = await new AxeBuilder({ page }).include(selector).withRules(['color-contrast']).analyze();
	return r.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')}: ${(n.failureSummary || '').split('\n')[1]?.trim()}`));
}

test('/account "Placed <date>" keeps AA contrast under colour mix A1-S4', async ({ page, shop, mailpit, unique }) => {
	test.setTimeout(60_000);
	await seedStorage(page, { wefeasto_colormix: A1_S4 });
	const email = unique.email('hunt-cm-date');
	await signUpAndLogIn(page, { shop, mailpit, email });
	await shop.placeCodOrder({ items: { cornflakes: 1 }, form: { email } });
	await shop.visit('/account');
	await expect(page.locator('.wf-order-date').first()).toBeVisible();
	expect(await contrastFailures(page, '.wf-order-date')).toEqual([]);
});

test('/checkout PIN credit keeps AA contrast under colour mix A1-S4', async ({ page, shop }) => {
	await seedStorage(page, { wefeasto_colormix: A1_S4, wefeasto_cart: { muesli: 1 } });
	await shop.visit('/checkout');
	await shop.payReady();
	await page.fill('#wf-co-pin', '560001');
	await expect(page.locator('[data-wf-pin-hint] .wf-pin-credit')).toBeVisible({ timeout: 10_000 });
	expect(await contrastFailures(page, '.wf-pin-credit')).toEqual([]);
});
