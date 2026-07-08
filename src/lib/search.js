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

function buildSearchIndex() {
	if (searchIndex) return searchIndex;
	searchIndex = [];
	products.forEach((p) => {
		searchIndex.push({
			type: 'product',
			label: p.name,
			category: p.category || '',
			terms: (p.searchTerms || []).join(' ').toLowerCase(),
			image: p.image,
			url: p.url,
			price: p.price
		});
	});
	recipes.forEach((r) => {
		searchIndex.push({
			type: 'recipe',
			label: r.title,
			category: r.category || '',
			terms: (r.searchTerms || []).join(' ').toLowerCase(),
			image: r.image,
			url: r.url
		});
	});
	return searchIndex;
}

// Lower score = better. -1 = no match. Name-prefix matches rank first.
function scoreItem(item, q) {
	const label = item.label.toLowerCase();
	if (label.indexOf(q) === 0) return 0;
	if (label.indexOf(q) > -1) return 1;
	if (item.category.toLowerCase().indexOf(q) > -1) return 2;
	if (item.terms.indexOf(q) > -1) return 3;
	return -1;
}

export function searchCatalog(query) {
	const items = buildSearchIndex();
	const q = String(query || '').trim().toLowerCase();
	if (!q) return items.slice(); // empty query: browse everything
	const scored = [];
	items.forEach((item) => {
		const s = scoreItem(item, q);
		if (s > -1) scored.push({ s, item });
	});
	scored.sort((a, b) => a.s - b.s);
	return scored.map((x) => x.item);
}
