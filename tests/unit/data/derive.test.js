/*
 * Derivation rules over synthetic snapshots: a CMS edit to one stored field
 * must reach every display string that depends on it, and shapes must hold
 * for content the legacy files never had (no pack size, no recipes, …).
 */
import { describe, it, expect } from 'vitest';
import {
	formatINR,
	priceText,
	ratingAria,
	priceLine,
	cardMeta,
	starLine,
	prepLine,
	servesLine,
	recipesUsing,
	miniProductCard,
	buildProducts,
	buildRecipes,
	buildProductsContent,
	buildRecipesContent,
	buildHomeBestsellers,
	buildKitchenRecipes,
	buildShopItems,
	buildPricingCatalog
} from '$lib/data/derive.js';
import { validateSnapshot } from '$lib/data/snapshot-schema.js';
import { snapshotCopy } from './fixtures.js';

const product = (s, slug) => s.products.find((p) => p.slug === slug);

describe('formatting helpers', () => {
	it.each([
		[17500, '₹175'],
		[100, '₹1'],
		[99900, '₹999'],
		[100000, '₹1,000'],
		[123400, '₹1,234'],
		[10000000, '₹1,00,000'],
		[123456700, '₹12,34,567']
	])('priceText(%i paise) → %s (Indian digit grouping)', (paise, text) => {
		expect(priceText(paise)).toBe(text);
		expect(priceText(paise)).toBe(formatINR(paise / 100));
	});

	it.each([
		[5, 'decimal', 'Rated 5.0 out of 5'],
		[5, 'plain', 'Rated 5 out of 5'],
		[4, 'decimal', 'Rated 4.0 out of 5'],
		[4, 'plain', 'Rated 4 out of 5'],
		[4.3, 'decimal', 'Rated 4.3 out of 5'],
		[4.3, 'plain', 'Rated 4.3 out of 5'],
		[0, 'decimal', 'Rated 0.0 out of 5']
	])('ratingAria(%s, %s) → %s', (rating, style, text) => {
		expect(ratingAria(rating, style)).toBe(text);
	});

	it('ratingAria defaults to the decimal style', () => {
		expect(ratingAria(4)).toBe('Rated 4.0 out of 5');
	});

	it('card lines omit a missing pack size instead of printing "null"', () => {
		const p = { pricePaise: 27000, calories: 120, rating: 5, packSize: null };
		expect(cardMeta(p)).toBe('120 cal');
		expect(starLine(p)).toBe('★ 5.0');
		expect(priceLine(p)).toBe('₹270 · 120 cal');
		expect(cardMeta({ ...p, packSize: '250 g' })).toBe('250 g · 120 cal');
		expect(starLine({ ...p, packSize: '250 g' })).toBe('★ 5.0 · 250 g');
	});

	it('recipe meta lines compose from prep/cook/serves', () => {
		const r = { prepTime: '5 mins', cookTime: 'No cook', serves: '2 tall glasses' };
		expect(prepLine(r)).toBe('Prep 5 mins · Cook No cook');
		expect(servesLine(r)).toBe('Serves 2 tall glasses');
	});
});

describe('a single CMS edit reaches every display string', () => {
	it('price: products.js, PDP, mini cards, recipe cards, home, shop and pricing all follow pricePaise', () => {
		const s = snapshotCopy();
		product(s, 'muesli').pricePaise = 129900;
		expect(validateSnapshot(s).ok).toBe(true);

		expect(buildProducts(s).find((p) => p.slug === 'muesli').price).toBe(1299);
		expect(buildProductsContent(s).muesli.priceText).toBe('₹1,299');
		expect(buildProductsContent(s).cornflakes.goesWith.find((c) => c.slug === 'muesli').price).toBe('₹1,299');
		expect(buildRecipesContent(s)['wf-muesli-yogurt-parfait'].shopIngredients[0].price).toBe('₹1,299');
		expect(buildHomeBestsellers(s).find((c) => c.title === 'Muesli').priceLine).toBe('₹1,299 · 100 cal');
		expect(buildShopItems(s).find((c) => c.slug === 'muesli').priceLine).toBe('₹1,299 · 100 cal');
		expect(buildPricingCatalog(s).find((c) => c.slug === 'muesli').pricePaise).toBe(129900);
	});

	it('rating: PDP stars, mini cards (both styles), home starLine and shop stars follow rating', () => {
		const s = snapshotCopy();
		product(s, 'muesli').rating = 4.6;
		const pc = buildProductsContent(s).muesli;
		expect([pc.starsAria, pc.starsRating, pc.ratingBold]).toEqual(['Rated 4.6 out of 5', '4.6', '4.6']);
		// the parfait's card uses the 'plain' spelling; for 4.6 both spellings agree
		expect(buildRecipesContent(s)['wf-muesli-yogurt-parfait'].shopIngredients[0].starsAria).toBe('Rated 4.6 out of 5');
		expect(buildHomeBestsellers(s).find((c) => c.title === 'Muesli').starLine).toBe('★ 4.6 · 400 g');
		expect(buildShopItems(s).find((c) => c.slug === 'muesli').starsRating).toBe('4.6');
	});

	it('name: titles, aria labels and cards follow name', () => {
		const s = snapshotCopy();
		product(s, 'choco-flakes').name = 'Choco Flakes';
		expect(buildProductsContent(s)['choco-flakes']).toMatchObject({ title: 'Choco Flakes', h1: 'Choco Flakes' });
		expect(buildProductsContent(s).cornflakes.goesWith[2]).toMatchObject({ name: 'Choco Flakes', viewAria: 'View Choco Flakes' });
		expect(buildShopItems(s)[4]).toMatchObject({ name: 'Choco Flakes', viewAria: 'View Choco Flakes' });
		expect(buildHomeBestsellers(s)[3]).toMatchObject({ title: 'Choco Flakes', aria: 'View Choco Flakes' });
	});

	it('recipe title and timings reach the recipe page, list card, PDP card and home card', () => {
		const s = snapshotCopy();
		const r = s.recipes[0];
		Object.assign(r, { title: 'Overnight Berry Oats', prepTime: '12 mins', cookTime: 'No cook', serves: '3' });
		const rc = buildRecipesContent(s)[r.slug];
		expect([rc.title, rc.display, rc.card.title, rc.card.coverAria]).toEqual([
			'Overnight Berry Oats',
			'Overnight Berry Oats',
			'Overnight Berry Oats',
			'Open recipe: Overnight Berry Oats'
		]);
		expect(rc.metaLine).toBe('Prep 12 mins · Cook No cook · Serves 3');
		expect([rc.card.prepLine, rc.card.serves]).toEqual(['Prep 12 mins · Cook No cook', 'Serves 3']);
		expect(buildProductsContent(s)['steel-cut-oats'].recipeCardDetails[0].title).toBe('Overnight Berry Oats');
		expect(buildKitchenRecipes(s)[0].aria).toBe('Open recipe: Overnight Berry Oats');
		expect(buildRecipes(s)[0].title).toBe('Overnight Berry Oats');
	});

	it('category: filter attributes, tag text and author line follow category', () => {
		const s = snapshotCopy();
		s.recipes[0].category = 'Desserts';
		const rc = buildRecipesContent(s)[s.recipes[0].slug];
		expect([rc.tagText, rc.authorSub, rc.card.category, rc.card.catLabel]).toEqual(['Desserts', 'Desserts recipe', 'Desserts', 'Desserts']);
	});
});

describe('home and shop lists', () => {
	it('bestsellers are the homeFeatured products in catalog order', () => {
		const s = snapshotCopy();
		Object.assign(product(s, 'rolled-oats'), { homeFeatured: true, homeAlt: 'Rolled oats in a bowl' });
		product(s, 'cornflakes').homeFeatured = false;
		expect(buildHomeBestsellers(s).map((c) => c.url)).toEqual([
			'/products/steel-cut-oats',
			'/products/rolled-oats',
			'/products/muesli',
			'/products/choco-flakes'
		]);
		expect(buildHomeBestsellers(s)[1].alt).toBe('Rolled oats in a bowl');
	});

	it('a featured product with no pack size gets a clean star line', () => {
		const s = snapshotCopy();
		Object.assign(product(s, 'health-mix'), { homeFeatured: true, homeAlt: 'Health Mix' });
		expect(buildHomeBestsellers(s).at(-1).starLine).toBe('★ 5.0');
	});

	it('kitchen recipes are the homeFeatured recipes in recipe order', () => {
		const s = snapshotCopy();
		s.recipes.forEach((r) => Object.assign(r, { homeFeatured: false, homeAlt: null }));
		Object.assign(s.recipes[11], { homeFeatured: true, homeAlt: 'Porridge' });
		expect(buildKitchenRecipes(s)).toEqual([
			expect.objectContaining({ url: '/recipes/wf-warm-health-mix-porridge', alt: 'Porridge' })
		]);
	});

	it('nothing featured → empty lists, not a crash', () => {
		const s = snapshotCopy();
		s.products.forEach((p) => (p.homeFeatured = false));
		s.recipes.forEach((r) => (r.homeFeatured = false));
		expect(buildHomeBestsellers(s)).toEqual([]);
		expect(buildKitchenRecipes(s)).toEqual([]);
	});

	it('the shop shows an out-of-stock product (availability is a live overlay, not a filter)', () => {
		const s = snapshotCopy();
		product(s, 'muesli').inStock = false;
		expect(buildShopItems(s).map((i) => i.slug)).toContain('muesli');
		expect(buildPricingCatalog(s).find((c) => c.slug === 'muesli').inStock).toBe(false);
	});
});

describe('relationship-driven content', () => {
	it('"Recipes using X" is every recipe that lists X, in recipe order', () => {
		const s = snapshotCopy();
		expect(recipesUsing(s, 'cornflakes').map((r) => r.slug)).toEqual([
			'wf-masala-cornflakes-chivda',
			'wf-honey-nut-cornflake-clusters'
		]);
		s.recipes[0].products.push({ slug: 'cornflakes', alt: null, ratingStyle: 'decimal' });
		expect(buildProductsContent(s).cornflakes.recipeCards).toEqual([
			'wf-berry-overnight-steel-cut-oats',
			'wf-masala-cornflakes-chivda',
			'wf-honey-nut-cornflake-clusters'
		]);
	});

	it('a product no recipe uses gets empty recipe lists', () => {
		const s = snapshotCopy();
		s.recipes.forEach((r) => (r.products = r.products.filter((x) => x.slug !== 'muesli')));
		const pc = buildProductsContent(s).muesli;
		expect(pc.recipeCards).toEqual([]);
		expect(pc.recipeCardDetails).toEqual([]);
	});

	it('mini-card overrides: alt falls back to the product hero alt; ratingStyle picks the spelling', () => {
		const p = { slug: 'x', name: 'X', image: '/i.jpg', heroAlt: 'Hero alt', category: 'Mix', rating: 4, packSize: null, calories: 90, pricePaise: 10000 };
		expect(miniProductCard(p)).toMatchObject({ alt: 'Hero alt', starsAria: 'Rated 4.0 out of 5', meta: '90 cal', price: '₹100' });
		expect(miniProductCard(p, { slug: 'x', alt: null, ratingStyle: 'plain' })).toMatchObject({ alt: 'Hero alt', starsAria: 'Rated 4 out of 5' });
		expect(miniProductCard(p, { slug: 'x', alt: 'Own alt', ratingStyle: 'decimal' }).alt).toBe('Own alt');
	});

	it('a recipe slug without the wf- prefix keeps its slug and URL in products.js recipes', () => {
		const s = snapshotCopy();
		s.recipes[0].slug = 'porridge';
		expect(buildRecipes(s)[0]).toMatchObject({ slug: 'porridge', url: '/recipes/porridge' });
		expect(buildRecipes(s)[1]).toMatchObject({ slug: 'muesli-yogurt-parfait', url: '/recipes/wf-muesli-yogurt-parfait' });
	});

	it('products-content keys stay alphabetical whatever the catalog order', () => {
		const s = snapshotCopy();
		s.products.reverse();
		expect(Object.keys(buildProductsContent(s))).toEqual(['choco-flakes', 'cornflakes', 'health-mix', 'muesli', 'rolled-oats', 'steel-cut-oats']);
	});
});
