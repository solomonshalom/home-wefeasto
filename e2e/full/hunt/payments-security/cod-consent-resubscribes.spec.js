/*
 * Hunt (payments-security) — anyone can put any address back on the marketing list, even after it
 * unsubscribed, with a free cash-on-delivery order.
 *
 * retention/subscribers.ts upsertCheckoutConsent runs on `order.confirmed` and makes the order's email a
 * CONFIRMED subscriber (no confirmation email), on the premise that "buying proves the address". A COD
 * order proves nothing: it is placed without paying, with any email typed into the form, and it emits
 * `order.confirmed` at once (cod_pending). The rule also RE-subscribes an address that unsubscribed, as long
 * as the order's consent is newer than the unsubscribe — which a stranger's order always is. So a stranger
 * can override someone's unsubscribe (and start refill-reminder marketing to them) at no cost, bypassing
 * the newsletter's double opt-in.
 *
 * Correct behaviour: an order's marketing consent may only subscribe an address that has been proven
 * (e.g. a pending subscriber goes through the normal confirmation email, or consent is applied once the
 * order is actually paid/delivered), and never overrides an explicit unsubscribe without the owner
 * confirming it.
 */
import { test, expect } from '../../fixtures.js';
import { subscribeAndConfirm, unsubscribeLink } from '../../accounts/helpers.js';

test('a stranger’s COD order with a ticked consent box does not re-subscribe an address that unsubscribed', async ({ api, admin, mailpit, unique }) => {
	// The address owner joins, then leaves, through the emailed links.
	const { email, welcome } = await subscribeAndConfirm({ api, mailpit, unique }, { tag: 'hps-consent' });
	const left = await fetch(unsubscribeLink(mailpit, welcome), { redirect: 'manual' });
	expect(left.status).toBe(303);
	expect((await admin.findSubscriber(email)).status).toBe('unsubscribed');

	// A stranger (own name, phone and address) places a free COD order with that email and ticks the box.
	const order = await api.placeOrder({
		method: 'cod',
		consent: true,
		form: { email, name: 'Mallory Stranger', address: '99 Elsewhere Lane, Indiranagar' }
	});
	expect(order.status).toBe('cod_pending');
	// order.confirmed handlers (checkout consent) run before the confirmation email goes out.
	await mailpit.waitForMessage({ to: email, subjectIncludes: `Order ${order.number} placed` });

	expect((await admin.findSubscriber(email)).status, "a stranger's order must not override the unsubscribe").toBe('unsubscribed');
});
