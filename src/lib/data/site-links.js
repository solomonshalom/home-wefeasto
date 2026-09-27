/*
 * Links inside CMS content vs. the pages this build produces.
 *
 * Recipe and page bodies are owner-written HTML (snapshot ingredientsHtml,
 * directionsHtml, whyHtml, pages[].bodyHtml), rendered with {@html}, and the
 * announcement bar links settings.announcement.href. The CMS drops structured
 * references to unpublished or deleted products (cms-catalog.md §3) but can't
 * rewrite a link inside a body, and the prerender crawler fails the whole
 * build on any link that 404s. So one routine action (discontinuing a
 * product that a recipe mentions) or one typo (/shopp) would block every
 * later storefront deploy.
 *
 * Two layers, both driven by this module:
 * - the data layer (site-paths.js) unwraps <a> links whose root-relative
 *   target is not a page this build produces: the words stay, the dead link
 *   goes, and visitors never land on the 404 page from our own content;
 * - svelte.config.js (kit.prerender.handleHttpError / handleMissingId) lets a
 *   crawled 404 or missing #id through with a warning only when CMS content
 *   links it (a file that isn't there, an #anchor the body lacks). The
 *   catalog's own image fields count as CMS content too: they are free text
 *   in the CMS ("Image path"), our templates only render them, so one
 *   mistyped path must not block every later deploy either. Anything else
 *   our own templates link still fails the build.
 *
 * Pure and dependency-free: svelte.config.js and Node scripts import it.
 */

/** Page routes without parameters (tests keep this in step with src/routes). */
export const STATIC_PAGES = Object.freeze(['/', '/404', '/account', '/cart', '/checkout', '/login', '/order', '/privacy', '/recipes', '/reset-password', '/shop', '/terms']);

/**
 * First path segments that are never pages: static/ folders and extensionless
 * files (tests keep this in step with static/), SvelteKit's /_app and the
 * same-origin /api (rewritten to the CMS). Links under these are left to the
 * build and the host.
 */
export const NON_PAGE_ROOTS = Object.freeze(['_app', 'api', 'css', 'fonts', 'images', 'js', 'pin', 'videos']);

const ORIGIN = 'http://wefeasto.invalid';

/** Decode what the crawler decodes; a malformed escape stays as written. */
function decode(s) {
	try {
		return decodeURI(s);
	} catch (e) {
		return s;
	}
}

/** HTML attribute value → text (the entities an editor or serializer emits). */
function unescapeAttr(v) {
	return v.replace(/&(?:amp|#0*38|#x0*26);/gi, '&').replace(/&(?:quot|#0*34|#x0*22);/gi, '"').replace(/&(?:#0*39|#x0*27|apos);/gi, "'").replace(/&(?:#0*47|#x0*2f);/gi, '/');
}

/**
 * Where `href`, as written on the page at `from`, points on this site:
 * `{ path, hash }` (decoded, trailing slash dropped), or null when it leaves
 * the site (https://…, //host, mailto:, tel:, …) or is empty.
 * @param {string} href
 * @param {string} [from]
 */
export function sitePath(href, from = '/') {
	if (typeof href !== 'string' || !href.trim()) return null;
	let url;
	try {
		url = new URL(href.trim(), ORIGIN + from);
	} catch (e) {
		return null;
	}
	if (url.origin !== ORIGIN) return null;
	let path = decode(url.pathname);
	if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
	return { path, hash: url.hash ? decode(url.hash.slice(1)) : '' };
}

/**
 * Every page path this build prerenders, from the snapshot it builds with:
 * STATIC_PAGES, /products/<slug>, /recipes/<slug> and /<slug> for each
 * routable CMS page (pass the routable slugs: src/params/policy.js decides).
 * @param {{ products?: {slug: string}[], recipes?: {slug: string}[], pageSlugs?: string[] }} catalog
 */
export function builtPagePaths({ products = [], recipes = [], pageSlugs = [] } = {}) {
	return new Set([...STATIC_PAGES, ...products.map((p) => `/products/${p.slug}`), ...recipes.map((r) => `/recipes/${r.slug}`), ...pageSlugs.map((s) => `/${s}`)]);
}

/**
 * A link to a page this build does not produce (a dead link)? Off-site links,
 * files (a last segment with a dot) and NON_PAGE_ROOTS are never "dead" here.
 * @param {string} href
 * @param {Set<string>} built builtPagePaths()
 * @param {string} [from] the page the link is on (resolves relative hrefs)
 */
export function isDeadPageLink(href, built, from = '/') {
	const target = sitePath(href, from);
	if (!target || built.has(target.path)) return false;
	const segments = target.path.split('/').filter(Boolean);
	if (segments.length && NON_PAGE_ROOTS.includes(segments[0])) return false;
	if (segments.length && segments[segments.length - 1].includes('.')) return false;
	return true;
}

const HREF_RE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const ANCHOR_RE = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi;

/**
 * `html` with every <a> whose href is a dead page link replaced by its
 * content (text and inline markup stay). `dropped` lists the removed hrefs.
 * @param {string} html
 * @param {Set<string>} built builtPagePaths()
 * @param {string} [from] the page the HTML renders on
 * @returns {{ html: string, dropped: string[] }}
 */
export function unlinkDeadLinks(html, built, from = '/') {
	const dropped = [];
	if (typeof html !== 'string' || !html.includes('<a')) return { html, dropped };
	const out = html.replace(ANCHOR_RE, (whole, attrs, inner) => {
		const m = HREF_RE.exec(attrs);
		if (!m) return whole;
		const href = unescapeAttr(m[1] ?? m[2] ?? m[3] ?? '');
		if (!isDeadPageLink(href, built, from)) return whole;
		dropped.push(href);
		return inner;
	});
	return { html: out, dropped };
}

/** The CMS-authored HTML of a snapshot with the page each renders on: `[{ from, html }]`. */
export function cmsBodies(snapshot) {
	const out = [];
	for (const r of snapshot?.recipes ?? []) {
		for (const key of ['ingredientsHtml', 'directionsHtml', 'whyHtml']) out.push({ from: `/recipes/${r.slug}`, html: r[key] });
	}
	for (const p of snapshot?.pages ?? []) out.push({ from: `/${p.slug}`, html: p.bodyHtml });
	return out.filter((b) => typeof b.html === 'string');
}

const URL_ATTR_RE = /\s(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/**
 * The snapshot's own image fields — owner-entered paths the templates render
 * as <img src>: `[{ field, url }]` (root-relative or https, as stored).
 * @param {any} snapshot
 */
export function cmsImageFields(snapshot) {
	const out = [];
	const push = (field, url) => {
		if (typeof url === 'string' && url) out.push({ field, url });
	};
	for (const p of snapshot?.products ?? []) push(`products[${p?.slug}].image`, p?.image);
	for (const r of snapshot?.recipes ?? []) {
		push(`recipes[${r?.slug}].image`, r?.image);
		push(`recipes[${r?.slug}].iconSrc`, r?.iconSrc);
	}
	return out;
}

/**
 * What CMS content links on this site, as the crawler will see it:
 * `{ paths: Set<path>, hashlinks: Set<'path#id'> }` from the bodies' href /
 * src / srcset, the catalog's image fields (cmsImageFields) and the
 * announcement href (shown on every page, resolved at /).
 * @param {any} snapshot
 */
export function cmsLinkTargets(snapshot) {
	const paths = new Set();
	const hashlinks = new Set();
	const add = (raw, from) => {
		const t = sitePath(unescapeAttr(raw), from);
		if (!t) return;
		paths.add(t.path);
		if (t.hash) hashlinks.add(`${t.path}#${t.hash}`);
	};
	for (const { from, html } of cmsBodies(snapshot)) {
		for (const m of html.matchAll(URL_ATTR_RE)) {
			const value = m[2] ?? m[3] ?? m[4] ?? '';
			if (m[1].toLowerCase() === 'srcset') for (const c of value.split(',')) add(c.trim().split(/\s+/)[0] || '', from);
			else add(value, from);
		}
	}
	for (const { url } of cmsImageFields(snapshot)) add(url, '/');
	const a = snapshot?.settings?.announcement?.href;
	if (typeof a === 'string' && a) add(a, '/');
	return { paths, hashlinks };
}
