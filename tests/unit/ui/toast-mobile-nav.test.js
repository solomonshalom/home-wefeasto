// @vitest-environment jsdom
/*
 * The mini-bag toast never sits on top of the open mobile menu (hunt round 4,
 * a11y-motion: "the mini-bag toast covers the open mobile menu"). The menu is
 * an aria-modal sheet at z 1050 and the toast is fixed at z 1100, so a card
 * left open covered the sheet's entries (a tap on Contact opened /cart, focus
 * on Account/Bag was hidden: WCAG 2.4.11). Opening the menu closes the card,
 * without pulling focus back out of the sheet, and no card opens while the
 * menu is up.
 *
 * CartToast is mounted in jsdom with the client build of svelte ('svelte'
 * resolves to the server build under vitest's node conditions), SvelteKit's
 * $app modules stubbed, and Element#animate stubbed (jsdom has no Web
 * Animations; svelte's transitions call it).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { mount, unmount, flushSync } from '../../../node_modules/svelte/src/index-client.js';

vi.mock('svelte', async () => await import('../../../node_modules/svelte/src/index-client.js'));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/products/muesli') } }));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));

const { default: CartToast } = await import('$lib/components/CartToast.svelte');
const { mobileNav } = await import('$lib/components/MobileNav.svelte');
const { CART_ADD_EVENT } = await import('$lib/cart.js');

beforeAll(() => {
	// Transitions finish on the next macrotask.
	Element.prototype.animate = function () {
		const a = { onfinish: null, oncancel: null, currentTime: 0, playState: 'running', cancel() {}, finish() {}, play() {}, pause() {}, effect: { getComputedTiming: () => ({ progress: 1 }) } };
		setTimeout(() => a.onfinish && a.onfinish(), 0);
		return a;
	};
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const card = () => document.querySelector('[data-wf-toast]');
const add = (slug = 'muesli', qty = 1) => {
	window.dispatchEvent(new CustomEvent(CART_ADD_EVENT, { detail: { slug, qty } }));
	flushSync();
};

let toast = null;
let target = null;
function setup() {
	target = document.createElement('div');
	document.body.appendChild(target);
	toast = mount(CartToast, { target, props: {} });
	flushSync();
}
afterEach(async () => {
	mobileNav.open = false;
	flushSync();
	if (toast) unmount(toast);
	toast = null;
	target?.remove();
	document.body.innerHTML = '';
	await settle();
});

describe('CartToast and the mobile menu', () => {
	it('opening the menu closes the card, without moving focus out of the sheet', async () => {
		setup();
		const addButton = document.body.appendChild(document.createElement('button'));
		const sheetClose = document.body.appendChild(document.createElement('button'));
		addButton.focus();
		add();
		expect(card()).not.toBeNull();

		sheetClose.focus(); // the sheet takes focus as it opens
		mobileNav.open = true;
		flushSync();
		// Leaving: taps already go through the card during its out transition.
		expect(card()?.style.pointerEvents ?? 'none').toBe('none');
		await settle();
		expect(card()).toBeNull();
		expect(document.activeElement).toBe(sheetClose); // not sent back to the Add button
	});

	it('no card opens while the menu is open; the next add after it closes opens one', async () => {
		setup();
		mobileNav.open = true;
		flushSync();
		add();
		await settle();
		expect(card()).toBeNull();

		mobileNav.open = false;
		flushSync();
		add('cornflakes', 2);
		expect(card()).not.toBeNull();
		expect(card().textContent).toMatch(/×2/);
	});

	it('a card reopened during its out transition takes taps again', async () => {
		setup();
		add();
		const first = card();
		first.querySelector('.wf-toast-close').click(); // close starts the out transition
		flushSync();
		expect(first.style.pointerEvents).toBe('none');
		add(); // before the transition ends
		expect(card()).not.toBeNull();
		expect(card().style.pointerEvents).toBe('');
		await settle();
		expect(card()).not.toBeNull();
		expect(card().style.pointerEvents).toBe('');
	});

	it('a card stays open while the menu stays closed (control)', async () => {
		setup();
		add();
		await settle();
		expect(card()).not.toBeNull();
	});
});
