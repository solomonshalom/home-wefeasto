/*
 * Server-rendered output of the ui-cart components and page additions (what
 * prerendered pages ship before hydration): the announcement bar (no DOM at
 * all when off), product facts, the AddToCart DOM contract, the PDP perks
 * line, the recipe-rail button, and client-only pieces rendering nothing.
 * Browser behaviour is in e2e/ui/{cart,cart-extras,toast}.spec.js.
 */
import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'svelte/server';

// SvelteKit's page state outside a request (AnnouncementBar hides on /checkout).
const route = vi.hoisted(() => ({ url: new URL('http://localhost/') }));
vi.mock('$app/state', () => ({ page: route }));
import AnnouncementBar, { announcementHash, safeHref, ANNOUNCE_KEY } from '$lib/components/AnnouncementBar.svelte';
import ProductFacts, { factRows, factsFor } from '$lib/components/ProductFacts.svelte';
import AddToCart from '$lib/components/AddToCart.svelte';
import CartToast from '$lib/components/CartToast.svelte';
import YourUsual from '$lib/components/YourUsual.svelte';
import TopUp from '$lib/components/TopUp.svelte';
import FreeDeliveryMeter from '$lib/components/FreeDeliveryMeter.svelte';
import ProductPage from '../../src/routes/products/[slug]/+page.svelte';
import RecipePage from '../../src/routes/recipes/[slug]/+page.svelte';
import { load as loadProduct } from '../../src/routes/products/[slug]/+page.js';
import { load as loadRecipe } from '../../src/routes/recipes/[slug]/+page.js';
import { settings } from '$lib/data/settings.js';
import { products as snapshotProducts } from '$lib/data/cms-snapshot.json';

const html = (C, props) => render(C, { props }).body.replace(/<!--[^>]*-->/g, '');

describe('AnnouncementBar', () => {
	it('renders nothing at all with the default (disabled) settings', () => {
		expect(settings.announcement.enabled).toBe(false);
		expect(html(AnnouncementBar, {})).toBe('');
	});

	it.each([
		['disabled with text', { enabled: false, text: 'Diwali: 10% off', href: '' }],
		['enabled but blank', { enabled: true, text: '   ', href: '' }],
		['enabled: "true" string', { enabled: 'true', text: 'x', href: '' }],
		['missing', null]
	])('%s → no DOM', (_, announcement) => {
		expect(html(AnnouncementBar, { announcement })).toBe('');
	});

	it('enabled: in-flow bar with text, dismiss button and a pre-paint hide script', () => {
		const out = html(AnnouncementBar, { announcement: { enabled: true, text: 'Diwali box is back', href: '/shop' } });
		const hash = announcementHash('Diwali box is back', '/shop');
		expect(out).toContain(`<div class="wf-announce" data-wf-announce="${hash}">`);
		expect(out).toContain('<a class="wf-announce-text" href="/shop">Diwali box is back</a>');
		expect(out).toContain('aria-label="Dismiss announcement"');
		expect(out).toContain(`localStorage.getItem("${ANNOUNCE_KEY}")==="${hash}"`);
		expect(out).toContain('document.currentScript.parentNode.style.display');
	});

	it('hidden on /checkout (and below it), shown elsewhere', () => {
		const announcement = { enabled: true, text: 'Hello', href: '' };
		for (const [path, shown] of [['/checkout', false], ['/checkout/x', false], ['/checkouts', true], ['/cart', true], ['/', true]]) {
			route.url = new URL('http://localhost' + path);
			expect(html(AnnouncementBar, { announcement }) !== '', path).toBe(shown);
		}
		route.url = new URL('http://localhost/');
	});

	it('text is escaped; unsafe hrefs are not linked', () => {
		const out = html(AnnouncementBar, { announcement: { enabled: true, text: '<b>hi</b> & bye', href: 'javascript:alert(1)' } });
		expect(out).toContain('<p class="wf-announce-text">&lt;b>hi&lt;/b> &amp; bye</p>');
		expect(out).not.toContain('javascript:');
	});

	it('safeHref: root-relative or https only', () => {
		expect(safeHref('/shop')).toBe('/shop');
		expect(safeHref('https://wefeasto.com/x')).toBe('https://wefeasto.com/x');
		for (const bad of ['//evil.com', 'http://x.com', 'javascript:alert(1)', 'data:text/html,x', '', null, 42]) expect(safeHref(bad)).toBe('');
	});

	it('hash: stable, and a new text or link gives a new hash', () => {
		expect(announcementHash('a', '/x')).toBe(announcementHash('a', '/x'));
		expect(announcementHash('a', '/x')).not.toBe(announcementHash('a', '/y'));
		expect(announcementHash('a', '')).not.toBe(announcementHash('b', ''));
		expect(announcementHash('a')).toMatch(/^[0-9a-z]+$/);
	});
});

describe('ProductFacts', () => {
	it('factRows: only facts that exist, in label order, as text', () => {
		expect(
			factRows({
				netQuantity: '500 g',
				ingredients: '  ',
				allergens: ['Nuts', ' ', 'Gluten'],
				bestBefore: null,
				manufacturer: 'Wefeasto Foods, Bengaluru',
				countryOfOrigin: 'India'
			})
		).toEqual([
			{ key: 'netQuantity', label: 'Net quantity', short: 'net quantity', value: '500 g' },
			{ key: 'allergens', label: 'Allergens', short: 'allergens', value: 'Nuts, Gluten' },
			{ key: 'manufacturer', label: 'Manufacturer / packer', short: 'manufacturer', value: 'Wefeasto Foods, Bengaluru' },
			{ key: 'countryOfOrigin', label: 'Country of origin', short: 'country of origin', value: 'India' }
		]);
		expect(factRows(null)).toEqual([]);
		expect(factRows({ allergens: [] })).toEqual([]);
	});

	it('renders a closed native <details> with exactly the facts given', () => {
		const out = html(ProductFacts, { slug: 'cornflakes', facts: { netQuantity: '500 g', countryOfOrigin: 'India', manufacturer: null } });
		expect(out).toBe(
			'<details class="wf-facts"><summary class="wf-facts-summary">Product facts: net quantity, country of origin</summary><dl class="wf-facts-list"><div class="wf-facts-row"><dt>Net quantity</dt><dd>500 g</dd></div><div class="wf-facts-row"><dt>Country of origin</dt><dd>India</dd></div></dl></details>'
		);
		expect(html(ProductFacts, { slug: 'cornflakes', facts: { netQuantity: '500 g' } })).toBe(
			'<details class="wf-facts"><summary class="wf-facts-summary">Product facts: net quantity</summary><dl class="wf-facts-list"><div class="wf-facts-row"><dt>Net quantity</dt><dd>500 g</dd></div></dl></details>'
		);
	});

	// The facts are owner data (country of origin stays null until the owner
	// supplies it), so this follows the snapshot rather than hard-coding it.
	it.each(snapshotProducts.map((p) => [p.slug, p.facts]))('%s: reads its facts from the snapshot, never inventing one', (slug, facts) => {
		expect(factsFor(slug)).toBe(facts);
		const out = html(ProductFacts, { slug });
		const filled = (v) => (Array.isArray(v) ? v.some((x) => typeof x === 'string' && x.trim()) : typeof v === 'string' && v.trim() !== '');
		const labels = { netQuantity: 'Net quantity', ingredients: 'Ingredients', allergens: 'Allergens', bestBefore: 'Best before', manufacturer: 'Manufacturer / packer', countryOfOrigin: 'Country of origin' };
		for (const [key, label] of Object.entries(labels)) {
			if (filled(facts?.[key])) expect(out).toContain(`<dt>${label}</dt>`);
			else expect(out).not.toContain(`<dt>${label}</dt>`);
		}
		if (!Object.keys(labels).some((k) => filled(facts?.[k]))) expect(out).toBe('');
		else expect(out).toMatch(/^<details class="wf-facts"><summary class="wf-facts-summary">Product facts: [a-z ,/]+<\/summary>/);
	});

	it('no facts → no element; values with HTML are escaped', () => {
		expect(html(ProductFacts, { slug: 'nope' })).toBe('');
		expect(html(ProductFacts, { facts: { ingredients: '<img src=x onerror=alert(1)>' } })).toContain('<dd>&lt;img src=x onerror=alert(1)></dd>');
	});
});

describe('AddToCart DOM contract', () => {
	it('default markup is unchanged', () => {
		expect(html(AddToCart, { slug: 'muesli' })).toBe('<a href="#" role="button" class="button w-inline-block" data-wf-add="muesli"><div>Add to Cart</div></a>');
		expect(html(AddToCart, { slug: 'muesli', qtyInputId: 'qty-muesli', source: 'pdp' })).toBe(
			'<a href="#" role="button" class="button w-inline-block" data-wf-add="muesli" data-wf-qty-input="#qty-muesli"><div>Add to Cart</div></a>'
		);
		expect(html(AddToCart, { slug: 'rolled-oats', extraClass: 'wf-shop-add' })).toBe(
			'<a href="#" role="button" class="button wf-shop-add w-inline-block" data-wf-add="rolled-oats"><div>Add to Cart</div></a>'
		);
	});

	it('custom resting label (recipe rail)', () => {
		expect(html(AddToCart, { slug: 'muesli', extraClass: 'wf-rail-add', label: 'Add Muesli · ₹250', source: 'recipe' })).toBe(
			'<a href="#" role="button" class="button wf-rail-add w-inline-block" data-wf-add="muesli"><div>Add Muesli · ₹250</div></a>'
		);
	});
});

describe('client-only pieces prerender nothing', () => {
	it.each([
		['CartToast', CartToast, {}],
		['YourUsual (shop)', YourUsual, { variant: 'shop' }],
		['YourUsual (cart)', YourUsual, { variant: 'cart' }],
		['TopUp, empty bag', TopUp, { bag: {} }]
	])('%s', (_, C, props) => {
		expect(html(C, props)).toBe('');
	});

	it('TopUp for a bag renders the meter + suggestion; FreeDeliveryMeter is an ARIA progressbar', () => {
		const out = html(TopUp, { bag: { muesli: 1, cornflakes: 1 } });
		expect(out).toContain('role="progressbar"');
		expect(out).toContain('aria-valuenow="85"');
		expect(out).toContain('data-wf-topup="rolled-oats"');
		expect(out).toContain('Add <strong>Rolled Oats · ₹125</strong> → free delivery');
		expect(html(FreeDeliveryMeter, { progress: 0.998 })).toContain('aria-valuenow="99"');
		expect(html(FreeDeliveryMeter, { progress: 1 })).toContain('aria-valuenow="100"');
		expect(html(FreeDeliveryMeter, { progress: -3 })).toContain('aria-valuenow="0"');
		expect(html(FreeDeliveryMeter, { progress: 'x' })).toContain('aria-valuenow="0"');
	});
});

describe('page additions (prerendered)', () => {
	it('PDP: perks line right before the partners dropdown, facts right after it', () => {
		const data = loadProduct({ params: { slug: 'muesli' } });
		const out = html(ProductPage, { data });
		expect(out).toContain(
			'<p class="p-small wf-perks" data-wf-perks="">Buying here: free delivery over ₹499 · COD available · fresh from our kitchen</p><div class="wf-partners">'
		);
		expect(out).toMatch(/<\/div><\/div><details class="wf-facts">/);
		expect(out).toContain('data-wf-add="muesli" data-wf-qty-input="#qty-muesli"');
	});

	it('recipe page: the rail buy button is the fifth rail item', () => {
		const data = loadRecipe({ params: { slug: 'wf-choco-flakes-energy-bars' } });
		const out = html(RecipePage, { data });
		expect(out).toContain(
			`<div>Author</div></a><a href="#" role="button" class="button wf-rail-add w-inline-block" data-wf-add="choco-flakes"><div>Add Choco's · ₹200</div></a></div>`
		);
	});
});

/*
 * The bag page is client-rendered (nothing to SSR), so its undo-row contract
 * is checked on the source: .wf-cart-row means "a bag line" to legacy
 * selectors and the port's regression tools, so only real lines carry it.
 * (e2e/ui/cart.spec.js checks the same in the browser.)
 */
describe('bag: .wf-cart-row is for bag lines only', () => {
	const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
	const cartPage = read('../../src/routes/cart/+page.svelte');
	const css = read('../../static/css/wefeasto.css').replace(/\/\*[\s\S]*?\*\//g, '');
	const tokenRe = (cls) => new RegExp(`(^|\\s)${cls}(\\s|$)`);
	const selRe = (cls) => new RegExp(`\\.${cls}(?![\\w-])`);
	/** Innermost `selectors { body }` rules (media-query contents included). */
	const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((x) => x.trim()), body: m[2] }));

	it('the undo row is .wf-cart-undo only, with its data-wf-undo hook', () => {
		const snippet = cartPage.match(/\{#snippet undoRow\(r\)\}([\s\S]*?)\{\/snippet\}/);
		expect(snippet).not.toBeNull();
		const root = snippet[1].match(/^<div\b([^>]*)>/);
		expect(root).not.toBeNull();
		expect(root[1]).toContain('class="wf-cart-undo"');
		expect(root[1]).toContain('data-wf-undo={r.slug}');
		expect(snippet[1]).not.toMatch(/wf-cart-row(?![\w-])/);
	});

	it('every element classed wf-cart-row is a bag line ([data-wf-row])', () => {
		const tags = [...cartPage.matchAll(/<[a-z][^>]*\bclass="([^"]*)"[^>]*>/g)].filter((m) => tokenRe('wf-cart-row').test(m[1]));
		expect(tags.length).toBe(1);
		for (const [tag] of tags) expect(tag).toMatch(/\bdata-wf-row=\{row\.slug\}/);
	});

	it('the CSS styles the undo row on its own, never through .wf-cart-row', () => {
		const undoSelectors = rules.flatMap((r) => r.selectors).filter((sel) => selRe('wf-cart-undo').test(sel));
		expect(undoSelectors).toContain('.wf-cart-undo');
		for (const sel of undoSelectors) expect(sel).not.toMatch(selRe('wf-cart-row'));
		const own = rules.find((r) => r.selectors.includes('.wf-cart-undo'));
		// It keeps the line's divider and the one-line flex layout it had as a .wf-cart-row.
		expect(own.body).toMatch(/border-bottom:\s*1px solid rgba\(51, 51, 51, \.18\)/);
		expect(own.body).toMatch(/display:\s*flex/);
		expect(own.body).toMatch(/justify-content:\s*space-between/);
	});
});
