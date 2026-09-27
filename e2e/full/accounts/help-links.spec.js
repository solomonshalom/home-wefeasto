/*
 * WhatsApp help (roadmap S12; $lib/support.js): a wa.me link to the store's support number
 * (settings.supportWhatsappE164) in the checkout trust line and on /order's problem
 * states, pre-filled with the order number where there is one. Opens in a new tab.
 * (The /grievances link is only built once a policy page is published: build-time, see
 * policies.spec.js.)
 */
import { test, expect } from '../fixtures.js';

const WA = 'https://wa.me/919845262777?text=';
const orderText = (no) => `Hi Wefeasto, I need help with my order ${no}.`;

async function expectWhatsapp(link, text) {
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute('href', WA + encodeURIComponent(text));
	await expect(link).toHaveAttribute('target', '_blank');
	await expect(link).toHaveAttribute('rel', /noopener/);
}

test.describe('WhatsApp help links', () => {
	test('the support number comes from the CMS settings', async ({ stack }) => {
		const snap = await (await fetch(`${stack.cmsUrl}/api/store/snapshot`)).json();
		expect(snap.settings.supportWhatsappE164).toBe('+919845262777');
	});

	test('checkout trust line → WhatsApp with a checkout message', async ({ page, shop }) => {
		await shop.setCart({ cornflakes: 1 });
		await shop.gotoCheckout();
		await expectWhatsapp(page.locator('[data-wf-trust] [data-wf-whatsapp]'), 'Hi Wefeasto, I need help with checkout.');
	});

	test('/order: cancelled and failed orders offer WhatsApp with the order number; a confirmed order does not nag', async ({ page, shop, admin, api, mock }) => {
		const cod = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
		await shop.visit(`/order?no=${cod.number}&t=${cod.token}`);
		expect(await shop.waitOrderView(['confirmed'])).toBe('confirmed');
		await expect(page.locator('[data-wf-whatsapp]')).toHaveCount(0);

		expect((await admin.cancelOrder(cod.number)).status).toBe(200);
		await shop.visit(`/order?no=${cod.number}&t=${cod.token}`);
		expect(await shop.waitOrderView(['cancelled'])).toBe('cancelled');
		await expectWhatsapp(page.locator('[data-wf-whatsapp]').first(), orderText(cod.number));

		const online = await api.placeOrder({ items: { 'rolled-oats': 1 }, method: 'upi' });
		expect((await mock.pay(online.payment.razorpayOrderId, 'fail', { reason: 'card_declined' })).status).toBe(200);
		await expect.poll(async () => (await api.status(online.number, online.token)).json?.status).toBe('payment_failed');
		await shop.visit(`/order?no=${online.number}&t=${online.token}`);
		expect(await shop.waitOrderView(['failed'])).toBe('failed');
		await expectWhatsapp(page.locator('[data-wf-whatsapp]').first(), orderText(online.number));
	});

	test('/order with a wrong token → "couldn’t find" + WhatsApp (never the order details)', async ({ page, shop, api }) => {
		const cod = await api.placeOrder({ items: { cornflakes: 1 }, method: 'cod' });
		const bad = cod.token.slice(0, -4) + (cod.token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
		await shop.visit(`/order?no=${cod.number}&t=${bad}`);
		await expect(page.locator('[data-wf-notfound]')).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-wf-notfound]')).not.toContainText(cod.form.name);
		await expectWhatsapp(page.locator('[data-wf-notfound] [data-wf-whatsapp]'), orderText(cod.number));
	});
});
