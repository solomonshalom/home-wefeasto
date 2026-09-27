/*
 * A CMS edit (a new snapshot) must reach every storefront surface with no
 * other code change: the home cards, the /shop grid, the PDP data, recipe
 * mini cards and bodies, search/cart data and the pricing catalog all derive
 * from the one snapshot. Here the snapshot module is replaced by an edited
 * copy, and so are the virtual:cms-snapshot/* modules vite.config.js splits
 * it into (whichever of the two a data module reads, it sees the edit).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'svelte/server';
import { JSDOM } from 'jsdom';

vi.mock('$lib/data/cms-snapshot.json', async (importOriginal) => {
	const orig = await importOriginal();
	const products = orig.products.map((p) => {
		if (p.slug === 'cornflakes') return { ...p, pricePaise: 19900, rating: 4.2, name: 'Cornflakes Classic' };
		// Owner features Rolled Oats on the home page.
		if (p.slug === 'rolled-oats') return { ...p, homeFeatured: true, homeAlt: 'Rolled oats in a bowl' };
		// Owner un-features Muesli.
		if (p.slug === 'muesli') return { ...p, homeFeatured: false };
		return p;
	});
	const recipes = orig.recipes.map((r, i) => (i === 0 ? { ...r, title: 'Berry Overnight Oats (new)', whyHtml: '<p>Why it works (new)</p>' } : r));
	return { ...orig, products, recipes, default: { ...orig.default, products, recipes } };
});

/** The split modules, built from the edited snapshot above (vi.mock factories are hoisted: import inside). */
async function editedSplit() {
	const edited = await import('$lib/data/cms-snapshot.json');
	const { splitSnapshot } = await import('../../vite.config.js');
	return { edited, ...splitSnapshot(edited) };
}
vi.mock('virtual:cms-snapshot/catalog', async () => {
	const { edited, recipes, pages } = await editedSplit();
	const { version, generatedAt, settings, products } = edited;
	return { version, generatedAt, settings, products, recipes, pages };
});
vi.mock('virtual:cms-snapshot/recipe-bodies', async () => ({ recipeBodies: (await editedSplit()).recipeBodies }));
vi.mock('virtual:cms-snapshot/page-bodies', async () => ({ pageBodies: (await editedSplit()).pageBodies }));

const { default: HomePage } = await import('../../src/routes/+page.svelte');
const { default: ShopPage } = await import('../../src/routes/shop/+page.svelte');
const { productBySlug } = await import('$lib/data/products.js');
const { productsContent } = await import('$lib/data/products-content.js');
const { recipesContent } = await import('$lib/data/recipes-content.js');
const { catalogForPricing, productPaise } = await import('$lib/data/settings.js');

const dom = (Component) => new JSDOM(render(Component).body).window.document;
const text = (el) => el?.textContent ?? null;

describe('an edited snapshot flows to every surface', () => {
	it('/shop grid shows the new price, rating and name', () => {
		const doc = dom(ShopPage);
		const card = doc.querySelector('.wf-shop-item[data-name="Cornflakes Classic"]');
		expect(card).not.toBeNull();
		expect(text(card.querySelector('.wf-price'))).toBe('₹199 · 120 cal');
		expect(card.querySelector('.wf-stars').getAttribute('aria-label')).toBe('Rated 4.2 out of 5');
		expect(card.querySelector('.wf-stars').getAttribute('style')).toBe('--wf-rating:4.2');
		expect(card.querySelector('a.wf-card-cover').getAttribute('aria-label')).toBe('View Cornflakes Classic');
	});

	it('home bestsellers follow the price and the homeFeatured flags (catalog order)', () => {
		const doc = dom(HomePage);
		const cards = [...doc.querySelectorAll('#bestsellers [role="listitem"]')];
		expect(cards.map((c) => c.querySelector('a.rp-card-cover').getAttribute('href'))).toEqual([
			'/products/cornflakes',
			'/products/steel-cut-oats',
			'/products/rolled-oats',
			'/products/choco-flakes'
		]);
		expect(text(cards[0].querySelector('.div-block-83 > div'))).toBe('₹199 · 120 cal');
		expect(text(cards[0].querySelector('.div-block-98 > div'))).toBe('★ 4.2 · 500 g');
		expect(cards[2].querySelector('.div-block-85 img').getAttribute('alt')).toBe('Rolled oats in a bowl');
	});

	it('home kitchen cards follow recipe edits', () => {
		const doc = dom(HomePage);
		const titles = [...doc.querySelectorAll('.collection-item h4')].map(text);
		expect(titles[0]).toBe('Berry Overnight Oats (new)');
	});

	it('the recipe page follows card and body edits alike', () => {
		const first = recipesContent['wf-berry-overnight-steel-cut-oats'];
		expect(first.title).toBe('Berry Overnight Oats (new)');
		expect(first.card.title).toBe('Berry Overnight Oats (new)');
		expect(first.whyHtml).toBe('<p>Why it works (new)</p>');
		expect(recipesContent['wf-muesli-yogurt-parfait'].whyHtml).not.toBe('<p>Why it works (new)</p>');
	});

	it('the mocked split modules agree with the mocked snapshot', async () => {
		const raw = await import('$lib/data/cms-snapshot.json');
		const catalog = await import('virtual:cms-snapshot/catalog');
		const { recipeBodies } = await import('virtual:cms-snapshot/recipe-bodies');
		expect(catalog.products).toBe(raw.products);
		expect(catalog.recipes[0].title).toBe('Berry Overnight Oats (new)');
		expect(recipeBodies[catalog.recipes[0].slug].whyHtml).toBe('<p>Why it works (new)</p>');
		expect(catalog.recipes.map((r) => ({ ...r, ...recipeBodies[r.slug] }))).toStrictEqual(raw.recipes);
	});

	it('PDP, recipe mini cards, cart/search data and pricing agree', () => {
		expect(productBySlug('cornflakes').price).toBe(199);
		expect(productsContent.cornflakes.priceText).toBe('₹199');
		expect(productsContent.cornflakes.starsAria).toBe('Rated 4.2 out of 5');
		const minis = Object.values(recipesContent)
			.flatMap((r) => r.shopIngredients)
			.filter((m) => m.slug === 'cornflakes');
		expect(minis.length).toBeGreaterThan(0);
		minis.forEach((m) => expect(m.price).toBe('₹199'));
		expect(productPaise('cornflakes')).toBe(19900);
		expect(catalogForPricing().find((p) => p.slug === 'cornflakes').pricePaise).toBe(19900);
	});
});
