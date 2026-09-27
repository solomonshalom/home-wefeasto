/*
 * Storefront policy pages (shipping, refunds, grievances) from the CMS
 * snapshot, for prerender-time code only: +layout.server.js / +page.server.js
 * loads (footer links, the /<slug> routes). The `.server` suffix makes
 * SvelteKit refuse any import from code that runs in the browser, so page
 * bodies never ride along in the shared _app chunks; a load returns only what
 * its page renders.
 * The snapshot holds reviewed, published pages only (validateSnapshot); the
 * published === true filter below is a second lock, not the first.
 */
import { pages } from './cms-snapshot.json';
import { withLiveLinks } from './site-paths.js';

function deepFreeze(value) {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		Object.values(value).forEach(deepFreeze);
	}
	return value;
}

/**
 * `[{slug, title, bodyHtml, published: true}]` in snapshot (footer) order. Read-only. Today: [].
 * Links in a body to pages this build does not produce (an unpublished
 * product, a typo) are unwrapped to plain text (site-links.js).
 */
export const publishedPages = deepFreeze(
	pages.filter((p) => p.published === true).map((p) => ({ ...p, bodyHtml: typeof p.bodyHtml === 'string' ? withLiveLinks(p.bodyHtml, `/${p.slug}`) : p.bodyHtml }))
);

/** The published page with this slug, or null. */
export function publishedPage(slug) {
	return publishedPages.find((p) => p.slug === slug) ?? null;
}
