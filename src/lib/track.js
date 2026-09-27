/*
 * Funnel-event shim. A no-op until an analytics snippet is added: events are
 * pushed to window.dataLayer when one exists (GTM/GA4-style), and re-emitted as
 * a 'wf:track' window event so anything else can listen. Never throws.
 *
 * Event names in use: view_item, add_to_cart {source}, toast_checkout_click,
 * topup_add, usual_add, begin_checkout, pay_click, payment_failed {code},
 * checkout_dismissed, purchase, outbound_partner_click, newsletter_signup,
 * account_signup, account_login.
 */
import { browser } from '$app/environment';

/**
 * @param {string} name
 * @param {Record<string, unknown>} [props]
 */
export function track(name, props = {}) {
	if (!browser || typeof name !== 'string' || !name) return;
	try {
		const event = { event: name, ...props };
		if (Array.isArray(window.dataLayer)) window.dataLayer.push(event);
		window.dispatchEvent(new CustomEvent('wf:track', { detail: event }));
	} catch (e) {
		/* analytics must never break the shop */
	}
}
