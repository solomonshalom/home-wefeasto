/*
 * Full-stack smoke: the three flows every change must keep working, end to end against
 * the real CMS (production build, mock Razorpay), the storefront preview, Postgres and
 * Mailpit. Run: E2E_SLOT=0 npx playwright test --project=full e2e/full/smoke.spec.js
 *
 * Each payment test pins the stock it buys from first (the admin fixture puts the original
 * back afterwards): the smoke runs after hundreds of specs that buy the same products, and
 * must never depend on how much of the seed stock they left.
 */
import { test, expect, waitOrderView } from './fixtures.js';

/** Enough of every product a smoke flow buys, whatever earlier specs used up. */
const SMOKE_STOCK = 20;

/** The /order link of an order email (absolute, on this slot's storefront). */
function orderLink(mailpit, msg, stack, number) {
	const links = mailpit.extractLinks(msg).filter((l) => l.startsWith(`${stack.sfUrl}/order?`) && l.includes(`no=${number}`));
	expect(links.length, `an /order link for ${number} in "${msg.Subject}"`).toBeGreaterThan(0);
	return links[0];
}

/** Open an emailed /order link in a fresh context (no bag, no local order memory) and expect it confirmed. */
async function expectOrderLinkWorks(newContext, link, number) {
	const ctx = await newContext();
	const p = await ctx.newPage();
	await p.goto(link);
	expect(await waitOrderView(p, ['confirmed'])).toBe('confirmed');
	await expect(p.locator('#wf-co-order-no')).toContainText(number);
	await ctx.close();
}

test.describe('smoke', () => {
	test('online UPI payment → /order confirmed → exactly one confirmation email with a working /order link', async ({
		page,
		shop,
		stack,
		admin,
		mailpit,
		newContext
	}) => {
		await admin.setStock('muesli', SMOKE_STOCK);
		const { number, token, form, view } = await shop.placeOnlineOrder({ items: { muesli: 1 }, auto: 'success', method: 'upi' });
		expect(number).toMatch(/^WF-\d+$/);
		expect(token).toBeTruthy();
		expect(view).toBe('confirmed');
		await expect(page.locator('[data-wf-order-method]')).toHaveAttribute('data-wf-order-method', 'online');
		await expect(page.locator('[data-wf-order-line="muesli"]')).toBeVisible();

		const order = await admin.findOrder(number);
		expect(order).toMatchObject({ status: 'paid', paymentStatus: 'captured', paymentMethod: 'online', requestedMethod: 'upi', razorpay: { method: 'upi' } });

		const msg = await mailpit.waitForMessage({ to: form.email, subjectIncludes: `Order ${number} confirmed` });
		// Webhook + client verify both confirm the order: still exactly one email.
		const all = await mailpit.settle(form.email, { quietMs: 3000 });
		expect(all.map((m) => m.Subject)).toEqual([msg.Subject]);

		await expectOrderLinkWorks(newContext, orderLink(mailpit, msg, stack, number), number);
	});

	test('cash on delivery → /order confirmed + one "pay on delivery" email', async ({ page, shop, stack, admin, mailpit, newContext }) => {
		await admin.setStock('cornflakes', SMOKE_STOCK);
		const { number, form, view } = await shop.placeCodOrder({ items: { cornflakes: 2 } });
		expect(view).toBe('confirmed');
		await expect(page.locator('[data-wf-order-method]')).toHaveAttribute('data-wf-order-method', 'cod');

		const order = await admin.findOrder(number);
		expect(order).toMatchObject({ status: 'cod_pending', paymentMethod: 'cod' });

		const msg = await mailpit.waitForMessage({ to: form.email, subjectIncludes: `Order ${number} placed` });
		const all = await mailpit.settle(form.email, { quietMs: 3000 });
		expect(all.map((m) => m.Subject)).toEqual([msg.Subject]);

		await expectOrderLinkWorks(newContext, orderLink(mailpit, msg, stack, number), number);
	});

	test('newsletter: subscribe on / → confirmation email → link → /?subscribed=1 notice', async ({ page, shop, admin, mailpit, unique }) => {
		const email = unique.email('nl');
		await shop.visit('/');
		const form = page.locator('#email-form-2');
		await form.locator('input[name="email"]').fill(email);
		await form.locator('input[type="submit"]').click();
		await expect(form).toHaveAttribute('data-wf-nl-state', 'success');
		await expect(page.locator('.w-form-done')).toBeVisible();

		// Stored after the response (Next after()): poll.
		await expect.poll(async () => (await admin.findSubscriber(email))?.status, { message: 'subscriber row' }).toBe('pending');
		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: 'Confirm your Wefeasto subscription' });
		const confirm = mailpit.extractLinks(msg).find((l) => /\/newsletter\/confirm\?t=/.test(l));
		expect(confirm, 'confirm link in the email').toBeTruthy();

		await page.goto(confirm);
		await page.waitForURL((u) => u.pathname === '/');
		await shop.waitHydrated();
		await expect(page.locator('.w-form-done')).toBeVisible();
		await expect(page.locator('.w-form-done')).toContainText('You’re subscribed');
		await expect(form).toBeHidden();
		await expect.poll(() => new URL(page.url()).searchParams.has('subscribed'), { message: 'param stripped' }).toBe(false);

		await expect.poll(async () => (await admin.findSubscriber(email))?.status, { message: 'subscriber confirmed' }).toBe('confirmed');
		await mailpit.waitForMessage({ to: email, subjectIncludes: "You're in" });
	});
});
