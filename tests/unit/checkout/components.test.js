/*
 * Server-rendered (prerendered) output of /checkout, /order and the new
 * components: what ships before hydration and without JS.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'svelte/server';

const route = vi.hoisted(() => ({ url: new URL('http://localhost/checkout') }));
vi.mock('$app/state', () => ({ page: route }));

import CheckoutPage from '../../../src/routes/checkout/+page.svelte';
import OrderPage from '../../../src/routes/order/+page.svelte';
import PayButton from '$lib/components/PayButton.svelte';
import CheckoutNote from '$lib/components/CheckoutNote.svelte';
import OrderView from '$lib/components/OrderView.svelte';
import PendingOrderBanner from '$lib/components/PendingOrderBanner.svelte';
import { INDIAN_STATES } from '$shared/validate.js';

const strip = (s) => s.replace(/<!--[^>]*-->/g, '');
const html = (C, props = {}) => strip(render(C, { props }).body);
const head = (C, props = {}) => strip(render(C, { props }).head);

describe('/checkout (prerendered)', () => {
	const out = html(CheckoutPage);

	it('keeps the ids and classes the site and tests rely on', () => {
		for (const id of ['wf-checkout-form', 'wf-place-order', 'wf-co-summary', 'wf-co-header']) expect(out).toContain(`id="${id}"`);
		expect(out).toContain('class="wf-co-grid"');
		expect(out).toContain('class="wf-pay-pills"');
	});

	it('has no card or UPI-ID inputs anywhere', () => {
		for (const bad of ['wf-co-upi', 'wf-co-card', 'cardNumber', 'cardCvv', 'cardExpiry', 'upiId', 'wf-pay-card', 'wf-pay-upi']) expect(out).not.toContain(bad);
		expect(out).not.toMatch(/type="password"/);
		expect(out).not.toContain('Prototype');
	});

	it('fields in order: name, phone, email (+consent), address, PIN before city, state, save details', () => {
		const order = ['wf-co-name', 'wf-co-phone', 'wf-co-email', 'wf-co-consent', 'wf-co-address', 'wf-co-pin', 'wf-co-city', 'wf-co-state', 'wf-co-save'].map((id) => out.indexOf(`id="${id}"`));
		expect(order.every((i) => i > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it('email: required, type/autocomplete/inputmode email; phone placeholder 98765 43210', () => {
		expect(out).toMatch(/<input[^>]*id="wf-co-email"[^>]*>/);
		const email = out.match(/<input[^>]*id="wf-co-email"[^>]*>/)[0];
		for (const a of ['type="email"', 'autocomplete="email"', 'inputmode="email"', 'required']) expect(email).toContain(a);
		expect(out.match(/<input[^>]*id="wf-co-phone"[^>]*>/)[0]).toContain('placeholder="98765 43210"');
	});

	it('marketing consent and save-details are unticked; copy as specified', () => {
		expect(out.match(/<input[^>]*id="wf-co-consent"[^>]*>/)[0]).not.toContain('checked');
		expect(out.match(/<input[^>]*id="wf-co-save"[^>]*>/)[0]).not.toContain('checked');
		expect(out).toContain('Send me refill reminders &amp; recipes. Unsubscribe anytime.');
		expect(out).toContain('Save my details on this device');
	});

	it('state select lists all 36 states and UTs', () => {
		const select = out.match(/<select[^>]*id="wf-co-state"[\s\S]*?<\/select>/)[0];
		expect(select).toContain('autocomplete="address-level1"');
		for (const s of INDIAN_STATES) expect(select).toContain(`>${s}</option>`);
	});

	it('three pills, the trust line, a disabled pay button before hydration, the loading summary', () => {
		for (const v of ['upi', 'card', 'cod']) expect(out).toContain(`value="${v}"`);
		expect(out).toContain('Secure payments by Razorpay · UPI · Cards · NetBanking');
		expect(out.match(/<button[^>]*id="wf-place-order"[^>]*>/)[0]).toContain('disabled');
		expect(out).toContain('Loading your bag…');
	});

	it('W2V2-5: the prerendered Pay button has no amount — "Pay securely", never "Pay ₹0"', () => {
		const btn = out.match(/<button[^>]*id="wf-place-order"[^>]*>([\s\S]*?)<\/button>/);
		expect(btn[1].trim()).toBe('Pay securely');
		expect(out).not.toContain('₹0');
		route.url = new URL('http://localhost/checkout?pay=cod'); // ?pay=cod is read on mount only
		expect(html(CheckoutPage)).not.toContain('₹0');
		route.url = new URL('http://localhost/checkout');
	});

	it('preconnects to checkout.razorpay.com without loading checkout.js', () => {
		const h = head(CheckoutPage);
		expect(h).toContain('<link rel="preconnect" href="https://checkout.razorpay.com"');
		expect(h + out).not.toContain('checkout.js');
	});
});

describe('/order (prerendered shell)', () => {
	it('no-referrer + noindex, loading state, noscript hint — no order data', () => {
		route.url = new URL('http://localhost/order');
		const h = head(OrderPage);
		expect(h).toContain('<meta name="referrer" content="no-referrer"');
		expect(h).toContain('<meta name="robots" content="noindex"');
		const out = html(OrderPage);
		expect(out).toContain('data-wf-order-view="loading"');
		expect(out).toContain('Looking up your order…');
		expect(out).toContain('<noscript>');
		expect(out).not.toContain('Order confirmed');
	});

	it('one live region: the status line only, not the view (hunt a11y-motion live-regions)', () => {
		route.url = new URL('http://localhost/order');
		const out = html(OrderPage);
		expect(out.match(/aria-live=/g)).toHaveLength(1);
		expect(out).toMatch(/<p class="wf-sr-only" role="status" aria-live="polite" data-wf-order-status-line="">Looking up your order…<\/p>/);
		expect(out).toMatch(/<div class="wf-order" data-wf-order-view="loading">/);
	});
});

describe('components', () => {
	it('PayButton: label, busy spinner, disabled', () => {
		expect(html(PayButton, { label: 'Pay ₹474 securely' })).toMatch(/<button type="submit" class="button w-button wf-pay-btn" id="wf-place-order"[^>]*data-wf-pay-state="ready">Pay ₹474 securely<\/button>/);
		const busy = html(PayButton, { label: 'x', busy: true });
		expect(busy).toContain('aria-busy="true"');
		expect(busy).toContain('disabled');
		expect(busy).toContain('wf-spinner');
		expect(busy).toContain('Opening payment…');
		expect(html(PayButton, { label: 'x', disabled: true })).toContain('data-wf-pay-state="disabled"');
	});

	it('CheckoutNote: message, buttons, links, WhatsApp', () => {
		const out = html(CheckoutNote, {
			message: 'Payment didn’t go through — no money was taken.',
			code: 'DISMISSED',
			actions: [{ id: 'try-again', label: 'Try again', onclick() {} }, { id: 'check', label: 'Check status', href: '/order?no=WF-10001&t=x' }],
			help: 'https://wa.me/919845262777'
		});
		expect(out).toContain('data-wf-co-note="DISMISSED"');
		expect(out).toContain('role="alert"');
		expect(out).toContain('data-wf-action="try-again"');
		expect(out).toContain('href="/order?no=WF-10001&amp;t=x"');
		expect(out).toContain('href="https://wa.me/919845262777"');
	});

	it('OrderView: lines, totals, COD and online method lines', () => {
		const order = {
			items: [{ slug: 'muesli', name: 'Muesli', qty: 2, lineTotalPaise: 50000 }],
			subtotalPaise: 50000,
			discountPaise: 5000,
			coupon: { code: 'WELCOME10' },
			deliveryPaise: 0,
			codFeePaise: 0,
			totalPaise: 45000,
			paymentMethod: 'cod'
		};
		const cod = html(OrderView, { order });
		expect(cod).toContain('Muesli × 2');
		expect(cod).toContain('Discount (WELCOME10)');
		expect(cod).toContain('−₹50');
		expect(cod).toContain('FREE');
		expect(cod).toContain('Pay ₹450 on delivery — cash or UPI.');
		expect(html(OrderView, { order: { ...order, paymentMethod: 'online', deliveryPaise: 4900 } })).toContain('Paid ₹450 online.');
	});

	it('PendingOrderBanner renders nothing on the server (client-only)', () => {
		expect(html(PendingOrderBanner).trim()).toBe('');
	});
});
