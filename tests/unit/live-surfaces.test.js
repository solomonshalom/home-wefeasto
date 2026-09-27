/*
 * The live catalog on the browse surfaces (PI-EXP-1; SPEC §1 "Live price and
 * stock overlays are fetched client-side"). Once loadLive() has settled, the
 * PDP, /shop, the home bestsellers, the mini cards (goes-with, recipe
 * ingredients, the error page) and the recipe rail show the CMS's current
 * price; a product the CMS has none of is flagged, and its AddToCart is
 * aria-disabled and adds nothing. Before that (prerender, hydration) every
 * surface renders the snapshot, as before.
 *
 * Svelte's server render reads `$liveCatalog` from the same live.js state the
 * browser would, so rendering after a (mocked-fetch) load shows what the
 * client renders once the live catalog lands. Browser behaviour:
 * e2e/ui/live-catalog.spec.js; full stack: e2e/full/experience/live-catalog.spec.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { get } from 'svelte/store';
import { settings as SNAP_SETTINGS, catalogForPricing as snapCatalog } from '$lib/data/settings.js';

// `browser` is read at call time (vite-node rewrites named imports to property reads),
// so loadLive() can run "in the browser" while module top levels (cart.js) see the server.
const env = vi.hoisted(() => ({ browser: false }));
vi.mock('$app/environment', () => ({
	get browser() {
		return env.browser;
	},
	dev: false,
	building: false,
	version: 'test'
}));
const route = vi.hoisted(() => ({ status: 404, url: new URL('http://localhost/nope') }));
vi.mock('$app/state', () => ({ page: route }));

const SNAP = snapCatalog();

/** A /api/store/catalog body: the snapshot catalog with per-slug overrides; `drop` leaves slugs out. */
function catalogBody(overrides = {}, settings = {}, drop = []) {
	return {
		settings: { ...structuredClone(SNAP_SETTINGS), ...settings },
		products: SNAP.filter((p) => !drop.includes(p.slug)).map((p) => ({ ...p, lowStock: null, ...(overrides[p.slug] || {}) }))
	};
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The CMS now: Cornflakes costs ₹199, Choco Flakes is sold out, Health Mix is no longer listed, COD is off.
const LIVE = catalogBody({ cornflakes: { pricePaise: 19900 }, 'choco-flakes': { inStock: false } }, { codEnabled: false }, ['health-mix']);

let fetchMock;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	env.browser = false;
});
afterEach(() => {
	vi.unstubAllGlobals();
	env.browser = false;
});

/**
 * Fresh modules (live.js state is module state). `response`: undefined = no
 * load yet; a number = that HTTP status; else a 200 JSON body.
 */
async function surfaces(response) {
	vi.resetModules();
	const live = await import('$lib/live.js');
	if (response !== undefined) {
		fetchMock.mockResolvedValue(typeof response === 'number' ? json(response, {}) : json(200, response));
		env.browser = true;
		await live.loadLive();
		env.browser = false;
	}
	// The svelte server runtime is reset with everything else: render with this generation's.
	const { render } = await import('svelte/server');
	const html = (C, props = {}) => render(C, { props }).body;
	return {
		live,
		html,
		doc: (C, props) => new JSDOM(html(C, props)).window.document,
		AddToCart: await import('$lib/components/AddToCart.svelte'),
		MiniProductCard: (await import('$lib/components/MiniProductCard.svelte')).default,
		ProductPage: (await import('../../src/routes/products/[slug]/+page.svelte')).default,
		loadProduct: (await import('../../src/routes/products/[slug]/+page.js')).load,
		RecipePage: (await import('../../src/routes/recipes/[slug]/+page.svelte')).default,
		loadRecipe: (await import('../../src/routes/recipes/[slug]/+page.js')).load,
		ShopPage: (await import('../../src/routes/shop/+page.svelte')).default,
		HomePage: (await import('../../src/routes/+page.svelte')).default,
		ErrorPage: (await import('../../src/routes/+error.svelte')).default,
		productsContent: (await import('$lib/data/products-content.js')).productsContent,
		recipesContent: (await import('$lib/data/recipes-content.js')).recipesContent
	};
}

const text = (el) => el?.textContent ?? null;
const addButton = (d, slug) => d.querySelector(`a[data-wf-add="${slug}"]`);

describe('AddToCart guard (addFromButton)', () => {
	const fakeCart = () => ({
		calls: [],
		add(slug, qty, opts) {
			this.calls.push([slug, qty, opts]);
		}
	});

	it('before the live catalog settles it adds, as it always did', async () => {
		const { live, AddToCart } = await surfaces();
		const cart = fakeCart();
		expect(AddToCart.addFromButton('choco-flakes', 2, 'pdp', get(live.liveCatalog), cart)).toBe(true);
		expect(cart.calls).toEqual([['choco-flakes', 2, { source: 'pdp' }]]);
	});

	it('sold out in the CMS (stock 0, or no longer listed): adds nothing', async () => {
		const { live, AddToCart } = await surfaces(LIVE);
		const cart = fakeCart();
		const state = get(live.liveCatalog);
		expect(AddToCart.addFromButton('choco-flakes', 1, 'card', state, cart)).toBe(false);
		expect(AddToCart.addFromButton('health-mix', 3, 'pdp', state, cart)).toBe(false);
		expect(cart.calls).toEqual([]);
	});

	it('in stock in the CMS: adds with qty and source', async () => {
		const { live, AddToCart } = await surfaces(LIVE);
		const cart = fakeCart();
		expect(AddToCart.addFromButton('cornflakes', 3, 'recipe', get(live.liveCatalog), cart)).toBe(true);
		expect(cart.calls).toEqual([['cornflakes', 3, { source: 'recipe' }]]);
	});

	it('the CMS unreachable (404, static host): the snapshot rules, so it adds', async () => {
		const { live, AddToCart } = await surfaces(404);
		expect(get(live.liveCatalog)).toMatchObject({ ready: true, error: 'NOT_FOUND' });
		const cart = fakeCart();
		expect(AddToCart.addFromButton('choco-flakes', 1, 'card', get(live.liveCatalog), cart)).toBe(true);
	});

	it('an unknown slug is passed on (Cart.add ignores it)', async () => {
		const { live, AddToCart } = await surfaces(LIVE);
		const cart = fakeCart();
		expect(AddToCart.addFromButton('nope', 1, 'card', get(live.liveCatalog), cart)).toBe(true);
	});
});

describe('AddToCart markup', () => {
	it('before the load: the unchanged snapshot markup (no aria-disabled)', async () => {
		const { AddToCart, html } = await surfaces();
		const out = html(AddToCart.default, { slug: 'choco-flakes' }).replace(/<!--[^>]*-->/g, '');
		expect(out).toBe('<a href="#" role="button" class="button w-inline-block" data-wf-add="choco-flakes"><div>Add to Cart</div></a>');
	});

	it('sold out: aria-disabled, data-wf-soldout, "Sold out" (or soldOutLabel), still a focusable button', async () => {
		const { AddToCart, doc } = await surfaces(LIVE);
		const a = doc(AddToCart.default, { slug: 'choco-flakes', extraClass: 'wf-shop-add' }).querySelector('a');
		expect(a.getAttribute('role')).toBe('button');
		expect(a.getAttribute('aria-disabled')).toBe('true');
		expect(a.hasAttribute('data-wf-soldout')).toBe(true);
		expect(a.hasAttribute('disabled')).toBe(false);
		expect(a.getAttribute('href')).toBe('#');
		expect(a.className).toBe('button wf-shop-add wf-soldout w-inline-block');
		expect(text(a)).toBe('Sold out');
		const rail = doc(AddToCart.default, { slug: 'choco-flakes', label: 'Add Choco · ₹200', soldOutLabel: 'Choco · Sold out' }).querySelector('a');
		expect(text(rail)).toBe('Choco · Sold out');
	});

	it('in stock after the load: unchanged markup', async () => {
		const { AddToCart, doc } = await surfaces(LIVE);
		const a = doc(AddToCart.default, { slug: 'cornflakes' }).querySelector('a');
		expect(a.hasAttribute('aria-disabled')).toBe(false);
		expect(a.hasAttribute('data-wf-soldout')).toBe(false);
		expect(a.className).toBe('button w-inline-block');
		expect(text(a)).toBe('Add to Cart');
	});
});

describe('product page', () => {
	const pdp = (s, slug) => s.doc(s.ProductPage, { data: s.loadProduct({ params: { slug } }) });
	const perks = (d) => text(d.querySelector('[data-wf-perks]'));

	it('before the load: the prerendered snapshot price, no flag, COD perk from the snapshot', async () => {
		const s = await surfaces();
		const d = pdp(s, 'cornflakes');
		expect(text(d.querySelector('.wf-price-large'))).toBe('₹175');
		expect(d.querySelectorAll('[data-wf-soldout]').length).toBe(0);
		expect(perks(d)).toContain('COD available');
	});

	it('after the load: the CMS price, and the live settings in the perks line', async () => {
		const s = await surfaces(LIVE);
		const d = pdp(s, 'cornflakes');
		expect(text(d.querySelector('.wf-price-large'))).toBe('₹199');
		expect(d.querySelectorAll('.div-block-76 [data-wf-soldout]').length).toBe(0);
		expect(addButton(d, 'cornflakes').hasAttribute('aria-disabled')).toBe(false);
		expect(perks(d)).toBe('Buying here: free delivery over ₹499 · fresh from our kitchen'); // COD off in the CMS
	});

	it.each(['choco-flakes', 'health-mix'])('%s sold out (stock 0 / unlisted): a "Sold out" chip, the main button blocked', async (slug) => {
		const s = await surfaces(LIVE);
		const d = pdp(s, slug);
		const chip = d.querySelector('.div-block-76 .wf-chip[data-wf-soldout]');
		expect(text(chip)).toBe('Sold out');
		const main = d.querySelector(`a[data-wf-add="${slug}"][data-wf-qty-input]`);
		expect(main.getAttribute('aria-disabled')).toBe('true');
		expect(text(main)).toBe('Sold out');
	});

	it('"Goes well with" cards: live prices and sold-out buttons', async () => {
		const s = await surfaces(LIVE);
		const pageWith = (x) => Object.keys(s.productsContent).find((k) => s.productsContent[k].goesWith.some((c) => c.slug === x));
		const card = (x) => [...pdp(s, pageWith(x)).querySelectorAll('.grid-6 .wf-card')].find((c) => c.querySelector(`[data-wf-add="${x}"]`));
		expect(text(card('cornflakes').querySelector('.wf-price'))).toBe('₹199');
		expect(card('cornflakes').querySelector('[data-wf-add]').hasAttribute('aria-disabled')).toBe(false);
		expect(card('choco-flakes').querySelector('[data-wf-add]').getAttribute('aria-disabled')).toBe('true');
		expect(text(card('choco-flakes').querySelector('[data-wf-add]'))).toBe('Sold out');
	});
});

describe('mini cards, recipe rail, error page', () => {
	it('MiniProductCard: snapshot price before the load, live after', async () => {
		let s = await surfaces();
		const card = s.productsContent.muesli.goesWith.find((c) => c.slug === 'cornflakes') || { ...s.productsContent.cornflakes.goesWith[0], slug: 'cornflakes', price: '₹175' };
		expect(text(s.doc(s.MiniProductCard, { card }).querySelector('.wf-price'))).toBe('₹175');
		s = await surfaces(LIVE);
		expect(text(s.doc(s.MiniProductCard, { card }).querySelector('.wf-price'))).toBe('₹199');
	});

	it('recipe rail: live price in the label; sold out, it says so and is blocked', async () => {
		const s = await surfaces(LIVE);
		const bySlug = (slug) => Object.keys(s.recipesContent).find((k) => s.recipesContent[k].shopIngredients[0]?.slug === slug);
		const rail = (recipe) => s.doc(s.RecipePage, { data: s.loadRecipe({ params: { slug: recipe } }) }).querySelector('a.wf-rail-add');
		const corn = bySlug('cornflakes');
		const choco = bySlug('choco-flakes');
		expect(corn && choco).toBeTruthy();
		const name = (recipe) => s.recipesContent[recipe].shopIngredients[0].name;
		expect(text(rail(corn))).toBe(`Add ${name(corn)} · ₹199`);
		expect(text(rail(choco))).toBe(`${name(choco)} · Sold out`);
		expect(rail(choco).getAttribute('aria-disabled')).toBe('true');
	});

	it('error page bestsellers: live prices', async () => {
		const s = await surfaces(LIVE);
		const d = s.doc(s.ErrorPage, {});
		const cards = [...d.querySelectorAll('.wf-card')];
		expect(cards).toHaveLength(3);
		for (const c of cards) {
			const slug = c.querySelector('[data-wf-add]').getAttribute('data-wf-add');
			const want = s.live.pricePaise(slug);
			expect(text(c.querySelector('.wf-price'))).toBe('₹' + (want / 100).toLocaleString('en-IN'));
		}
	});
});

describe('/shop and home cards', () => {
	const shopCard = (d, slug) => d.querySelector(`.wf-shop-item:has([data-wf-add="${slug}"])`);

	it('/shop before the load: snapshot price lines, nothing blocked', async () => {
		const s = await surfaces();
		const d = s.doc(s.ShopPage);
		expect(text(shopCard(d, 'cornflakes').querySelector('.wf-price'))).toBe('₹175 · 120 cal');
		expect(d.querySelectorAll('[aria-disabled]')).toHaveLength(0);
	});

	it('/shop after the load: live price lines, sold-out cards say so and are blocked, order unchanged', async () => {
		const s = await surfaces(LIVE);
		const d = s.doc(s.ShopPage);
		expect([...d.querySelectorAll('.wf-shop-item [data-wf-add]')].map((a) => a.getAttribute('data-wf-add'))).toEqual(SNAP.map((p) => p.slug));
		expect(text(shopCard(d, 'cornflakes').querySelector('.wf-price'))).toBe('₹199 · 120 cal');
		for (const slug of ['choco-flakes', 'health-mix']) {
			const add = shopCard(d, slug).querySelector('[data-wf-add]');
			expect(add.getAttribute('aria-disabled')).toBe('true');
			expect(text(add)).toBe('Sold out');
		}
		expect(shopCard(d, 'muesli').querySelector('[data-wf-add]').hasAttribute('aria-disabled')).toBe(false);
	});

	it('home bestsellers: snapshot before the load; live price and a sold-out note after', async () => {
		const line = (d, slug) => text(d.querySelector(`#bestsellers [role="listitem"]:has(a[href="/products/${slug}"]) .div-block-83 > div`));
		let s = await surfaces();
		let d = s.doc(s.HomePage);
		expect(line(d, 'cornflakes')).toBe('₹175 · 120 cal');
		expect(line(d, 'choco-flakes')).toBe('₹200 · 120 cal');
		expect(d.querySelectorAll('#bestsellers [data-wf-soldout]').length).toBe(0);
		s = await surfaces(LIVE);
		d = s.doc(s.HomePage);
		expect(line(d, 'cornflakes')).toBe('₹199 · 120 cal');
		expect(line(d, 'choco-flakes')).toBe('₹200 · 120 cal · Sold out');
		expect(d.querySelectorAll('#bestsellers [data-wf-soldout]')).toHaveLength(1);
	});
});
