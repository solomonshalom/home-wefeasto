import { describe, it, expect } from 'vitest';
import { whatsappLink, orderHelpText } from '$lib/support.js';
import { settings } from '$lib/data/settings.js';

describe('whatsappLink()', () => {
	it('uses the store setting by default', () => {
		const digits = settings.supportWhatsappE164.replace(/\D/g, '');
		expect(whatsappLink()).toBe('https://wa.me/' + digits);
	});

	it('encodes the pre-filled text', () => {
		expect(whatsappLink('Order WF-10001 & help?', '+919845262777')).toBe(
			'https://wa.me/919845262777?text=Order%20WF-10001%20%26%20help%3F'
		);
	});

	it('returns null without a usable number', () => {
		expect(whatsappLink('hi', '')).toBeNull();
		expect(whatsappLink('hi', '+91')).toBeNull();
		expect(whatsappLink('hi', null)).toBeNull();
		expect(whatsappLink('hi', '+1234567890123456')).toBeNull();
	});

	it('caps very long messages', () => {
		const url = whatsappLink('x'.repeat(2000), '+919845262777');
		expect(decodeURIComponent(url.split('text=')[1])).toHaveLength(500);
	});
});

describe('orderHelpText()', () => {
	it('mentions a valid order number only', () => {
		expect(orderHelpText('WF-10001')).toContain('WF-10001');
		expect(orderHelpText('<script>')).not.toContain('<script>');
		expect(orderHelpText()).toBe('Hi Wefeasto, I need help with my order.');
	});
});
