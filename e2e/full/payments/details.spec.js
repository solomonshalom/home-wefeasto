/*
 * S1 "Save my details on this device" and S5 PIN → City/State autofill, end to end.
 * S1: unticked → nothing stored; ticked → the next /checkout is prefilled (+ "Not you? Forget me",
 *     which clears it); a tampered saved object only prefills what is valid.
 * S5: 560001 fills Bengaluru / Karnataka; a City the customer typed is never overwritten; an answer
 *     that lands while the caret is in City waits until they leave it; an unknown PIN never blocks.
 * Run: E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/payments/details.spec.js
 */
import { test, expect } from '../fixtures.js';
import { orderPage } from './helpers.js';

const saved = (page) => page.evaluate(() => localStorage.getItem('wefeasto_checkout'));
const val = (page, id) => page.locator(`#${id}`);

test.describe('S1 save my details', () => {
	test('ticked → stored on order → next /checkout prefilled + "Forget me" clears it', async ({ page, shop }) => {
		const first = await shop.placeCodOrder({ items: { muesli: 1 }, form: { save: true } });
		const stored = JSON.parse(await saved(page));
		expect(stored).toEqual({
			name: first.form.name,
			phone: first.form.phone,
			email: first.form.email,
			address: first.form.address,
			city: first.form.city,
			state: first.form.state,
			pin: first.form.pin
		});

		await shop.setCart({ cornflakes: 1 });
		await shop.gotoCheckout();
		await expect(page.locator('[data-wf-saved]')).toContainText('Welcome back');
		await expect(val(page, 'wf-co-name')).toHaveValue(first.form.name);
		await expect(val(page, 'wf-co-phone')).toHaveValue(first.form.phone);
		await expect(val(page, 'wf-co-email')).toHaveValue(first.form.email);
		await expect(val(page, 'wf-co-address')).toHaveValue(first.form.address);
		await expect(val(page, 'wf-co-pin')).toHaveValue(first.form.pin);
		await expect(val(page, 'wf-co-city')).toHaveValue(first.form.city);
		await expect(val(page, 'wf-co-state')).toHaveValue(first.form.state);
		await expect(val(page, 'wf-co-save')).toBeChecked();

		await page.locator('[data-wf-forget]').click();
		await expect.poll(() => saved(page)).toBeNull();
		await expect(val(page, 'wf-co-name')).toBeFocused();
		for (const id of ['wf-co-name', 'wf-co-phone', 'wf-co-email', 'wf-co-address', 'wf-co-pin', 'wf-co-city', 'wf-co-state']) await expect(val(page, id)).toHaveValue('');
		await expect(val(page, 'wf-co-save')).not.toBeChecked();
		await expect(page.locator('[data-wf-saved]')).toHaveCount(0);
		await page.reload();
		await shop.waitHydrated();
		await expect(val(page, 'wf-co-name')).toHaveValue('');
	});

	test('unticked (the default) → nothing is stored and the next /checkout is empty', async ({ page, shop }) => {
		await shop.setCart({ 'rolled-oats': 1 });
		await shop.gotoCheckout();
		await expect(val(page, 'wf-co-save')).not.toBeChecked();
		await shop.fillCheckout({ method: 'cod' });
		await page.locator('#wf-place-order').click();
		await orderPage(page);
		expect(await saved(page)).toBeNull();
		await shop.setCart({ 'rolled-oats': 1 });
		await shop.gotoCheckout();
		await expect(val(page, 'wf-co-name')).toHaveValue('');
		await expect(page.locator('[data-wf-saved]')).toHaveCount(0);
	});

	test('a tampered saved object prefills only what is valid (unknown state, junk PIN dropped)', async ({ page, shop }) => {
		await page.addInitScript(() => {
			if (sessionStorage.getItem('__wf_saved_seed')) return;
			sessionStorage.setItem('__wf_saved_seed', '1');
			localStorage.setItem('wefeasto_checkout', JSON.stringify({ name: 'Ravi Menon', city: 'Pune', state: 'Atlantis', pin: 'abc', email: 42, extra: '<script>' }));
		});
		await shop.setCart({ cornflakes: 1 });
		await shop.gotoCheckout();
		await expect(val(page, 'wf-co-name')).toHaveValue('Ravi Menon');
		await expect(val(page, 'wf-co-city')).toHaveValue('Pune');
		await expect(val(page, 'wf-co-state')).toHaveValue('');
		await expect(val(page, 'wf-co-pin')).toHaveValue('');
		await expect(val(page, 'wf-co-email')).toHaveValue('');
	});
});

test.describe('S5 PIN autofill', () => {
	test('560001 fills City + State (with the GeoNames credit); both stay editable', async ({ page, shop }) => {
		await shop.setCart({ muesli: 1 });
		await shop.gotoCheckout();
		await val(page, 'wf-co-pin').fill('560001');
		await expect(val(page, 'wf-co-city')).toHaveValue('Bengaluru');
		await expect(val(page, 'wf-co-state')).toHaveValue('Karnataka');
		await expect(page.locator('[data-wf-pin-hint]')).toContainText('Filled in from your PIN');
		await expect(page.locator('[data-wf-pin-hint] a[href="https://www.geonames.org"]')).toBeVisible();
		await val(page, 'wf-co-city').fill('Bangalore');
		await expect(val(page, 'wf-co-city')).toHaveValue('Bangalore');
		// A new PIN never overwrites the City the customer has since typed.
		await val(page, 'wf-co-pin').fill('600001');
		await expect(val(page, 'wf-co-state')).toHaveValue('Tamil Nadu');
		await expect(val(page, 'wf-co-city')).toHaveValue('Bangalore');
	});

	test('City typed first → the PIN answer fills only State', async ({ page, shop }) => {
		await shop.setCart({ muesli: 1 });
		await shop.gotoCheckout();
		await val(page, 'wf-co-city').fill('Whitefield');
		const shard = page.waitForResponse((r) => r.url().endsWith('/pin/560.json'));
		await val(page, 'wf-co-pin').fill('560066');
		await shard;
		await expect(val(page, 'wf-co-state')).toHaveValue('Karnataka');
		await expect(val(page, 'wf-co-city')).toHaveValue('Whitefield');
	});

	test('the answer lands while the caret is in City → held, filled on leaving it untouched', async ({ page, shop }) => {
		let release;
		const gate = new Promise((r) => (release = r));
		await page.route('**/pin/110.json', async (route) => {
			await gate;
			await route.continue();
		});
		await shop.setCart({ muesli: 1 });
		await shop.gotoCheckout();
		await val(page, 'wf-co-pin').fill('110001');
		await val(page, 'wf-co-city').focus();
		const answered = page.waitForResponse((r) => r.url().endsWith('/pin/110.json'));
		release();
		await answered;
		await expect(val(page, 'wf-co-state')).toHaveValue('Delhi');
		await expect(val(page, 'wf-co-city'), 'never under the caret').toHaveValue('');
		await expect(val(page, 'wf-co-city')).toBeFocused();
		await val(page, 'wf-co-address').focus();
		await expect(val(page, 'wf-co-city')).toHaveValue('Central Delhi');
	});

	test('a PIN with no data (no shard for its prefix) fetches nothing, fills nothing and never blocks checkout', async ({ page, shop, admin, unique }) => {
		// PI-PAY-4: /pin/150.json doesn't exist; the lookup must not even ask (a 404 is a console error and counts in RUM).
		// The consoleErrors fixture (auto) fails the test on any console error, so no allow() here.
		await shop.setCart({ 'steel-cut-oats': 1 });
		await shop.gotoCheckout();
		const pinFetches = [];
		page.on('request', (r) => {
			if (/\/pin\/\d{3}\.json/.test(r.url())) pinFetches.push(r.url());
		});
		await val(page, 'wf-co-pin').fill('150001');
		await expect(val(page, 'wf-co-city')).toHaveValue('');
		await expect(val(page, 'wf-co-state')).toHaveValue('');
		await expect(page.locator('[data-wf-pin-hint]')).toHaveCount(0);
		const f = unique.form();
		await val(page, 'wf-co-name').fill(f.name);
		await val(page, 'wf-co-phone').fill(f.phone);
		await val(page, 'wf-co-email').fill(f.email);
		await val(page, 'wf-co-address').fill(f.address);
		await val(page, 'wf-co-city').fill('Rajpura');
		await page.selectOption('#wf-co-state', 'Punjab');
		await page.locator('label.wf-pay-pill:has(input[value="cod"])').click();
		await shop.payReady();
		await page.locator('#wf-place-order').click();
		const { number } = await orderPage(page);
		expect((await admin.findOrder(number)).shippingAddress).toMatchObject({ pin: '150001', city: 'Rajpura', state: 'Punjab' });
		expect(pinFetches, 'no request for a prefix without a shard').toEqual([]);
	});
});
