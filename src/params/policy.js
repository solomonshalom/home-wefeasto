/*
 * Route matcher for src/routes/[policy=policy] (roadmap M7): the CMS policy
 * pages (shipping, refunds, grievances, …) at /<slug>.
 *
 * Only pages the owner has reviewed and published reach the snapshot, and
 * only those get a route, a prerendered file and a footer link; an unpublished
 * page is not built at all, so the static host answers 404 for it. With no
 * page published the route builds nothing: svelte.config.js lets exactly this
 * route go unseen (kit.prerender.handleUnseenRoutes) and still fails the
 * build for any other prerenderable route that renders no page.
 *
 * Browser code (the client router runs matchers), so it reads the lean
 * `virtual:cms-snapshot/catalog` pages ({slug, title, published}; the bodies
 * stay in pages.server.js).
 */
import { pages } from 'virtual:cms-snapshot/catalog';

/**
 * Top-level paths that already mean something (routes, static folders and
 * files, the API). A CMS page with one of these slugs would collide, so it
 * gets no route or footer link (tests keep this list in step with
 * src/routes and static/).
 */
export const RESERVED_SLUGS = Object.freeze([
	'404',
	'_app',
	'account',
	'api',
	'cart',
	'checkout',
	'color-combos',
	'css',
	'fonts',
	'images',
	'js',
	'login',
	'order',
	'pin',
	'privacy',
	'products',
	'recipes',
	'reset-password',
	'shop',
	'terms',
	'videos'
]);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A published page that can have a route of its own. */
export function isRoutablePage(p) {
	return !!p && p.published === true && typeof p.slug === 'string' && SLUG_RE.test(p.slug) && !RESERVED_SLUGS.includes(p.slug) && typeof p.title === 'string' && p.title.trim() !== '';
}

/** The routable pages, in snapshot (footer) order, first of each slug only. */
export function routablePages(list) {
	const seen = new Set();
	return (Array.isArray(list) ? list : []).filter((p) => {
		if (!isRoutablePage(p) || seen.has(p.slug)) return false;
		seen.add(p.slug);
		return true;
	});
}

const SLUGS = new Set(routablePages(pages).map((p) => p.slug));

/** @param {string} param */
export function match(param) {
	return SLUGS.has(param);
}
