/*
 * Live catalog search — port of the search index/scoring from js/wefeasto.js.
 */
import { writable } from 'svelte/store';
import { products, recipes } from '$lib/data/products.js';

export const searchOpen = writable(false);
// Bumped on route changes: the overlay snaps shut with no animation, like the
// fresh document a full page load gave the original site.
export const searchSnap = writable(0);

export function openSearch() {
	searchOpen.set(true);
}

export function closeSearch() {
	searchOpen.set(false);
}

export function snapCloseSearch() {
	searchOpen.set(false);
	searchSnap.update((n) => n + 1);
}

let searchIndex = null;

/*
 * Apostrophe-like characters a keyboard may type for "'": ’ ‘ (iOS Smart
 * Punctuation, macOS autocorrect), ʼ ʹ, ` ´ ′ (and ＇, which NFKC folds).
 */
const APOSTROPHES = /[\u2018\u2019\u201A\u201B\u02BC\u02B9\u0060\u00B4\u2032]/g;
// Hyphen and dash variants (smart dashes turn "--" into "—") → "-".
const DASHES = /[\u2010-\u2015\u2212]/g;

/**
 * Match key for a query or an indexed field: NFKC (full-width forms,
 * no-break spaces, ligatures), lower case, one kind of apostrophe and dash,
 * single spaces. The same folding on both sides, so "Choco’s" typed on an
 * iPhone finds "Choco's", and a curly apostrophe in a CMS name is found by an
 * ASCII one.
 * @param {unknown} text
 * @returns {string}
 */
export function searchKey(text) {
	return String(text ?? '')
		.replace(APOSTROPHES, "'") // before NFKC, which turns ´ into a space + combining accent
		.normalize('NFKC')
		.toLowerCase()
		.replace(DASHES, '-')
		.replace(/\s+/g, ' ')
		.trim();
}

function indexEntry(type, label, category, searchTerms, rest) {
	return {
		type,
		label,
		category: category || '',
		terms: searchKey((searchTerms || []).join(' ')),
		key: { label: searchKey(label), category: searchKey(category) },
		...rest
	};
}

function buildSearchIndex() {
	if (searchIndex) return searchIndex;
	searchIndex = [];
	products.forEach((p) => {
		searchIndex.push(indexEntry('product', p.name, p.category, p.searchTerms, { image: p.image, url: p.url, price: p.price }));
	});
	recipes.forEach((r) => {
		searchIndex.push(indexEntry('recipe', r.title, r.category, r.searchTerms, { image: r.image, url: r.url }));
	});
	return searchIndex;
}

// Lower score = better. -1 = no match. Name-prefix matches rank first.
// `q` is already a searchKey().
function scoreItem(item, q) {
	const label = item.key.label;
	if (label.indexOf(q) === 0) return 0;
	if (label.indexOf(q) > -1) return 1;
	if (item.key.category.indexOf(q) > -1) return 2;
	if (item.terms.indexOf(q) > -1) return 3;
	return -1;
}

export function searchCatalog(query) {
	const items = buildSearchIndex();
	const q = searchKey(query);
	if (!q) return items.slice(); // empty query: browse everything
	const scored = [];
	items.forEach((item) => {
		const s = scoreItem(item, q);
		if (s > -1) scored.push({ s, item });
	});
	scored.sort((a, b) => a.s - b.s);
	return scored.map((x) => x.item);
}
