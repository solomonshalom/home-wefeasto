/*
 * Snapshot → storefront shapes. Pure functions over a catalog snapshot (see
 * snapshot-schema.js); the data modules bind them to cms-snapshot.json. Every
 * display string that used to be hand-copied ('₹175 · 120 cal', 'Rated 4.0 out
 * of 5', 'qty-cornflakes', …) is derived here, once, so a price or rating edit
 * in the CMS reaches every card. Output shapes and key order match the
 * pre-CMS data files exactly (tests/fixtures/legacy).
 */

/** '₹' + whole rupees in Indian digit grouping, e.g. formatINR(1275) → '₹1,275'. */
export function formatINR(n) {
	const num = Math.round(Number(n) || 0);
	return '₹' + num.toLocaleString('en-IN');
}

export const rupees = (pricePaise) => pricePaise / 100;
export const priceText = (pricePaise) => formatINR(rupees(pricePaise));
export const productUrl = (slug) => '/products/' + slug;
export const recipeUrl = (slug) => '/recipes/' + slug;

/** Screen-reader rating: 'decimal' → "Rated 4.0 out of 5", 'plain' → "Rated 4 out of 5". */
export function ratingAria(rating, style = 'decimal') {
	return `Rated ${style === 'plain' ? String(rating) : rating.toFixed(1)} out of 5`;
}

/** '₹175 · 120 cal' — home bestseller and shop cards. */
export const priceLine = (p) => `${priceText(p.pricePaise)} · ${p.calories} cal`;
/** '500 g · 120 cal' — mini product cards (pack size omitted when unknown). */
export const cardMeta = (p) => [p.packSize, `${p.calories} cal`].filter(Boolean).join(' · ');
/** '★ 5.0 · 500 g' — home bestseller cards. */
export const starLine = (p) => [`★ ${p.rating.toFixed(1)}`, p.packSize].filter(Boolean).join(' · ');

export const prepLine = (r) => `Prep ${r.prepTime} · Cook ${r.cookTime}`;
export const servesLine = (r) => `Serves ${r.serves}`;

const bySlug = (list) => new Map(list.map((x) => [x.slug, x]));
const copyPairs = (list) => list.map(({ title, reason }) => ({ title, reason }));

/** Recipes that use a product, in recipe order. */
export function recipesUsing(snapshot, productSlug) {
	return snapshot.recipes.filter((r) => r.products.some((x) => x.slug === productSlug));
}

/* ------------------------------------------------------- shared cards */

/** Mini product card ("Goes well with", "Shop the Ingredients"). */
export function miniProductCard(p, { alt = null, ratingStyle = 'decimal' } = {}) {
	return {
		slug: p.slug,
		viewAria: `View ${p.name}`,
		image: p.image,
		alt: alt ?? p.heroAlt,
		catLabel: p.category,
		starsAria: ratingAria(p.rating, ratingStyle),
		starsRating: String(p.rating),
		meta: cardMeta(p),
		name: p.name,
		price: priceText(p.pricePaise)
	};
}

/** Recipe card on a product page ("Recipes using …"). */
function productRecipeCard(r) {
	return {
		slug: r.slug,
		coverAria: `Open recipe: ${r.title}`,
		catLabel: r.category,
		catText: r.category,
		title: r.title,
		desc: r.description,
		image: r.image,
		alt: r.cardAlt,
		iconColor: r.iconColor,
		iconSrc: r.iconSrc,
		iconAlt: r.iconAlt
	};
}

/**
 * Recipe list card (/recipes, "Related Posts"): card fields only, so it can be
 * built from the lean catalog (no recipe bodies).
 */
export function recipeListCard(r) {
	return {
		category: r.category,
		catLabel: r.category,
		title: r.title,
		image: r.image,
		cardAlt: r.cardAlt,
		iconColor: r.iconColor,
		iconSrc: r.iconSrc,
		iconAlt: r.iconAlt,
		serves: servesLine(r),
		prepLine: prepLine(r),
		coverAria: `Open recipe: ${r.title}`
	};
}

/* --------------------------------------------- products.js (catalog) */

export function buildProducts(snapshot) {
	return snapshot.products.map((p) => ({
		slug: p.slug,
		name: p.name,
		price: rupees(p.pricePaise),
		packSize: p.packSize,
		calories: p.calories,
		rating: p.rating,
		category: p.category,
		description: p.description,
		image: p.image,
		url: productUrl(p.slug),
		partners: p.partners.map(({ name, url }) => ({ name, url })),
		searchTerms: [...p.searchTerms]
	}));
}

export function buildRecipes(snapshot) {
	return snapshot.recipes.map((r) => ({
		slug: r.slug.replace(/^wf-/, ''), // legacy list slugs drop the route's wf- prefix
		title: r.title,
		category: r.category,
		description: r.description,
		image: r.image,
		url: recipeUrl(r.slug),
		productSlugs: r.products.map((x) => x.slug),
		searchTerms: [...r.searchTerms]
	}));
}

/* ------------------------------------------------- products-content.js */

export function buildProductsContent(snapshot) {
	const products = bySlug(snapshot.products);
	// Keyed alphabetically by slug, like the generated file (nothing iterates it).
	const sorted = [...snapshot.products].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	return Object.fromEntries(
		sorted.map((p) => {
			const recipes = recipesUsing(snapshot, p.slug);
			return [
				p.slug,
				{
					title: p.name,
					heroImage: p.image,
					heroAlt: p.heroAlt,
					h1: p.name,
					starsAria: ratingAria(p.rating, 'decimal'),
					starsRating: String(p.rating),
					ratingBold: p.rating.toFixed(1),
					priceText: priceText(p.pricePaise),
					chips: [p.packSize, `${p.calories} cal per serving`].filter(Boolean),
					description: p.description,
					qtyId: `qty-${p.slug}`,
					partners: p.partners.map(({ name, url }) => ({ name, url })),
					goesWith: p.goesWith.map((s) => miniProductCard(products.get(s))),
					recipesHeading: p.recipesHeading,
					recipeCards: recipes.map((r) => r.slug),
					recipeCardDetails: recipes.map(productRecipeCard)
				}
			];
		})
	);
}

/* -------------------------------------------------- recipes-content.js */

export function buildRecipesContent(snapshot) {
	const products = bySlug(snapshot.products);
	return Object.fromEntries(
		snapshot.recipes.map((r) => [
			r.slug,
			{
				title: r.title,
				tagColor: r.tagColor,
				tagText: r.category,
				metaLine: `${prepLine(r)} · ${servesLine(r)}`,
				heroImage: r.image,
				heroAlt: r.heroAlt,
				display: r.title,
				intro: r.intro,
				authorSub: `${r.category} recipe`,
				ingredientsHtml: r.ingredientsHtml,
				directionsHtml: r.directionsHtml,
				whyHtml: r.whyHtml,
				authorBio: r.authorBio,
				shopIngredients: r.products.map((x) => miniProductCard(products.get(x.slug), x)),
				extrasHeading: r.extrasHeading,
				extrasIntro: r.extrasIntro,
				extras: copyPairs(r.extras),
				recommendedHeading: r.recommendedHeading,
				recommendedIntro: r.recommendedIntro,
				recommended: copyPairs(r.recommended),
				related: [...r.related],
				card: recipeListCard(r)
			}
		])
	);
}

/** /recipes grid: `[{slug, card}]` for every recipe, in recipe order (= recipesContent key order). */
export function buildRecipeCards(snapshot) {
	return snapshot.recipes.map((r) => ({ slug: r.slug, card: recipeListCard(r) }));
}

/* --------------------------------------- page card lists (home, shop) */

/** Home "Shop Bestsellers": products flagged homeFeatured, in catalog order. */
export function buildHomeBestsellers(snapshot) {
	return snapshot.products
		.filter((p) => p.homeFeatured)
		.map((p) => ({
			url: productUrl(p.slug),
			aria: `View ${p.name}`,
			image: p.image,
			alt: p.homeAlt,
			cat: p.category,
			priceLine: priceLine(p),
			title: p.name,
			starLine: starLine(p)
		}));
}

/** Home "Fresh from the Wefeasto Kitchen": recipes flagged homeFeatured, in recipe order. */
export function buildKitchenRecipes(snapshot) {
	return snapshot.recipes
		.filter((r) => r.homeFeatured)
		.map((r) => ({
			url: recipeUrl(r.slug),
			aria: `Open recipe: ${r.title}`,
			image: r.image,
			alt: r.homeAlt,
			cat: r.category,
			title: r.title,
			iconColor: r.iconColor,
			iconSrc: r.iconSrc,
			iconAlt: r.iconAlt
		}));
}

/** /shop grid: every product, in catalog order. */
export function buildShopItems(snapshot) {
	return snapshot.products.map((p) => ({
		slug: p.slug,
		name: p.name,
		category: p.category,
		terms: p.searchTerms.join(' '),
		image: p.image,
		alt: p.shopAlt,
		viewAria: `View ${p.name}`,
		priceLine: priceLine(p),
		starsAria: ratingAria(p.rating, 'plain'),
		starsRating: String(p.rating),
		pack: p.packSize
	}));
}

/* ------------------------------------------------ commerce (paise) */

/** Catalog items for $shared/pricing.js — `{slug, name, pricePaise, inStock, maxPerOrder, codAllowed}`. */
export function buildPricingCatalog(snapshot) {
	return snapshot.products.map(({ slug, name, pricePaise, inStock, maxPerOrder, codAllowed }) => ({
		slug,
		name,
		pricePaise,
		inStock,
		maxPerOrder,
		codAllowed
	}));
}
