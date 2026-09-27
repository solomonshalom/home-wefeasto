/*
 * Customer-support helpers (roadmap S12). The WhatsApp number comes from the
 * CMS store settings (snapshot `supportWhatsappE164`); nothing renders when it
 * is empty.
 */
import { settings } from '$lib/data/settings.js';

/**
 * wa.me deep link with a pre-filled message, or null when no support number
 * is configured.
 * @param {string} [text]
 * @param {string} [e164]  override (tests); defaults to the store setting
 * @returns {string | null}
 */
export function whatsappLink(text = '', e164 = settings.supportWhatsappE164) {
	const digits = typeof e164 === 'string' ? e164.replace(/\D/g, '') : '';
	if (digits.length < 8 || digits.length > 15) return null;
	const msg = typeof text === 'string' ? text.trim().slice(0, 500) : '';
	return 'https://wa.me/' + digits + (msg ? '?text=' + encodeURIComponent(msg) : '');
}

/** Help text pre-filled with an order number when there is one. */
export function orderHelpText(orderNumber) {
	return typeof orderNumber === 'string' && /^WF-\d{5,12}$/.test(orderNumber)
		? `Hi Wefeasto, I need help with my order ${orderNumber}.`
		: 'Hi Wefeasto, I need help with my order.';
}
