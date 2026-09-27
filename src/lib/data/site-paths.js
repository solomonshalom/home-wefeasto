/*
 * The page paths this build produces, from the snapshot it builds with, and
 * the helpers that keep CMS content from linking anything else (see
 * site-links.js for why). Used by recipes-content.js (recipe bodies),
 * pages.server.js (policy page bodies) and AnnouncementBar (its href).
 * Reads the lean catalog only (slugs; no bodies).
 */
import { products, recipes, pages } from 'virtual:cms-snapshot/catalog';
import { routablePages } from '../../params/policy.js';
import { builtPagePaths, isDeadPageLink, unlinkDeadLinks } from './site-links.js';

/** Every page path the prerender produces for this snapshot. */
export const builtPaths = builtPagePaths({ products, recipes, pageSlugs: routablePages(pages).map((p) => p.slug) });

/**
 * CMS HTML shown on the page at `from`, minus links to pages this build does
 * not produce (the link text stays). At build time each removed link is
 * logged, so the owner can fix the body in the CMS.
 * @param {string} html
 * @param {string} from
 */
export function withLiveLinks(html, from) {
	const { html: out, dropped } = unlinkDeadLinks(html, builtPaths, from);
	if (dropped.length && import.meta.env.SSR) {
		console.warn(`[cms content] ${from}: unlinked ${dropped.join(', ')} (no such page in this build: unpublished, deleted or mistyped). The text stays; fix the link in the CMS.`);
	}
	return out;
}

/** `href` when it leads somewhere this site (or another) actually serves, else ''. */
export function liveHref(href, from = '/') {
	return href && !isDeadPageLink(href, builtPaths, from) ? href : '';
}
