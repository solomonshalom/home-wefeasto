import fs from 'node:fs';
import path from 'node:path';
import adapter from '@sveltejs/adapter-static';
import { cmsLinkTargets, STATIC_PAGES } from './src/lib/data/site-links.js';

const PAGES = 'build';

/*
 * Unknown URLs on the static host (Vercel serves build/404.html with a 404
 * status). That file is the prerendered /404 route (src/routes/404), a real
 * page: nav, the "This page wandered off" copy, links and bestsellers, so it
 * reads fine without JS; with JS it hydrates like any other page. (An
 * adapter `fallback` would overwrite it with an empty SPA shell.)
 *
 * Prerendered pages use document-relative paths ("./_app/…", "./css/…", and a
 * base computed from `location`), which only resolve at the page's own depth.
 * The host serves 404.html at any depth (/products/a/b), so its paths are
 * rewritten to root-absolute ones, exactly what SvelteKit emits for fallback
 * pages. The build fails if anything relative survives.
 */
const NOT_FOUND = '404.html';

/** Attributes whose values are URLs (srcset holds a list of them). */
const URL_ATTRS = ['href', 'src', 'srcset', 'poster', 'action', 'data'];

/** `name="value"` / `name='value'` for those attributes: [, prefix, name, double-quoted, single-quoted]. */
const ATTR_RE = () => new RegExp(`(\\s(${URL_ATTRS.join('|')})=)(?:"([^"]*)"|'([^']*)')`, 'gi');

/** A URL that resolves against the document's own path. */
const isDocRelative = (url) => url !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(url);

/**
 * Rewrite a root-depth prerendered page so it works when served at any path:
 * "./x" → "/x" in URL attributes and the boot script's imports, and the
 * relative base expression → "" (the site lives at the domain root).
 * @param {string} html
 * @returns {string}
 */
export function rootAbsolute(html) {
	return html
		.replace(ATTR_RE(), (m, pre, name, dq, sq) => {
			const q = dq === undefined ? "'" : '"';
			const fixed = (dq ?? sq).replace(/(^|,\s*)\.\/(?!\.)/g, '$1/');
			return `${pre}${q}${fixed}${q}`;
		})
		.replace(/\bimport\((["'])\.\/(?!\.)/g, 'import($1/')
		.replace(/new URL\((["'])\.\1, location\)\.pathname\.slice\(0, -1\)/g, '""');
}

/**
 * Everything in `html` that would still resolve against the page's own path.
 * @param {string} html
 * @returns {string[]}
 */
export function relativeRefs(html) {
	const found = [];
	for (const [, , name, dq, sq] of html.matchAll(ATTR_RE())) {
		const value = dq ?? sq;
		const urls = name.toLowerCase() === 'srcset' ? value.split(',').map((s) => s.trim().split(/\s+/)[0]) : [value.trim()];
		for (const url of urls) if (isDocRelative(url)) found.push(`${name}="${url}"`);
	}
	for (const m of html.matchAll(/\bimport\((["'])([^"']*)\1\)/g)) if (isDocRelative(m[2])) found.push(`import("${m[2]}")`);
	for (const m of html.matchAll(/new URL\([^)]*,\s*location\)/g)) found.push(m[0]);
	return found;
}

/** adapter-static, then the root-absolute 404 page. */
function staticWith404(options) {
	const base = adapter(options);
	return {
		...base,
		name: `${base.name} + ${NOT_FOUND}`,
		async adapt(builder) {
			await base.adapt(builder);
			const file = path.join(options.pages, NOT_FOUND);
			if (!fs.existsSync(file)) throw new Error(`${file} was not prerendered: src/routes/404/+page.svelte is missing`);
			const html = rootAbsolute(fs.readFileSync(file, 'utf8'));
			const left = relativeRefs(html);
			if (left.length) throw new Error(`${file} still has document-relative URLs: ${left.slice(0, 5).join(', ')}`);
			fs.writeFileSync(file, html);
			builder.log.minor(`Made ${file} root-absolute`);
		}
	};
}

/*
 * Prerendered routes that may legitimately build no page at all: the CMS
 * policy pages (src/routes/[policy=policy]) exist only once the owner
 * publishes one, and until then the route has no entries. Every other
 * prerenderable route that ends up with no page still fails the build (the
 * SvelteKit default), so a route that silently stopped building is caught.
 */
export const MAY_BE_UNSEEN = Object.freeze(['/[policy=policy]']);

/*
 * Routes whose pages come from a snapshot collection that may be empty
 * (snapshot-schema.md: `recipes` "may be empty", e.g. while the owner
 * unpublishes every recipe to rewrite them). They may build no page only
 * when that collection is empty in the snapshot this build uses; with
 * recipes in it, an unseen /recipes/[slug] is still a broken build.
 */
export const MAY_BE_EMPTY = Object.freeze({ '/recipes/[slug]': 'recipes' });

/**
 * kit.prerender.handleUnseenRoutes: ignore MAY_BE_UNSEEN (and MAY_BE_EMPTY
 * routes whose collection is empty), fail on anything else.
 * @param {{ routes: string[], message?: string }} details
 */
export function handleUnseenRoutes({ routes }) {
	const snapshot = buildSnapshot();
	const emptyCollection = (id) => Object.hasOwn(MAY_BE_EMPTY, id) && Array.isArray(snapshot?.[MAY_BE_EMPTY[id]]) && snapshot[MAY_BE_EMPTY[id]].length === 0;
	const unexpected = routes.filter((id) => !MAY_BE_UNSEEN.includes(id) && !emptyCollection(id));
	if (unexpected.length === 0) return;
	const allowed = Object.entries(MAY_BE_EMPTY).map(([id, key]) => `${id} (only with no ${key})`);
	throw new Error(
		`The following routes were marked as prerenderable, but were not prerendered because they were not found while crawling your app:\n${unexpected
			.map((id) => `  - ${id}`)
			.join('\n')}\n\n(Only ${[...MAY_BE_UNSEEN, ...allowed].join(', ')} may build no page: see handleUnseenRoutes in svelte.config.js.)`
	);
}

/*
 * Links inside CMS content (recipe / page bodies, the announcement href) and
 * the catalog's own image fields (products[].image, recipes[].image /
 * iconSrc: free text in the CMS) are the owner's, not ours. The data layer
 * already unwraps links to pages this build doesn't produce
 * (src/lib/data/site-links.js); what can still reach the crawler from CMS
 * content is a missing file (/images/typo.png) or an #anchor the body lacks.
 * Those warn instead of failing every later deploy. An uploaded image
 * (/api/media/file/…) is served by the CMS through the /api rewrite, never by
 * this build: the crawler can't fetch it, and that is expected (no warning).
 * A 404 or missing #id that only our own templates link, or on one of our own
 * page routes, still fails the build (the SvelteKit default).
 */
const SNAPSHOT_FILE = new URL('./src/lib/data/cms-snapshot.json', import.meta.url);
/** @type {any} undefined = not read yet; null = unreadable */
let snapshotCache;
let cmsTargets = null;

/** The snapshot this build uses (read once, lazily: the prebuild sync writes it first). */
function buildSnapshot() {
	if (snapshotCache === undefined) {
		try {
			snapshotCache = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
		} catch (e) {
			snapshotCache = null;
		}
	}
	return snapshotCache;
}

/** What CMS content links. */
function cmsLinked() {
	if (!cmsTargets) {
		try {
			cmsTargets = cmsLinkTargets(buildSnapshot());
		} catch (e) {
			cmsTargets = { paths: new Set(), hashlinks: new Set() };
		}
	}
	return cmsTargets;
}

/*
 * Prerendering runs in a worker thread that is dropped as soon as it reports
 * back, so its async console output can be lost: write the warning straight
 * to stderr, synchronously, so it always reaches the build log.
 */
function buildWarning(message) {
	const text = `[prerender] ${message}\n  (linked from CMS content: fix the link in the CMS; the build goes on)\n`;
	try {
		fs.writeSync(2, text);
	} catch (e) {
		console.warn(text);
	}
}

/** For tests: forget the cached CMS link targets (or use `targets`). */
export function resetCmsLinks(targets = null) {
	cmsTargets = targets;
}

/** For tests: build from `snapshot` (undefined: read the file again); resets the link targets too. */
export function resetBuildSnapshot(snapshot = undefined) {
	snapshotCache = snapshot;
	cmsTargets = null;
}

/**
 * kit.prerender.handleHttpError: warn on a 404 that CMS content links (and
 * no page route of ours owns); fail on everything else.
 * @param {{ status: number, path: string, referrer: string | null, referenceType: string, message: string }} details
 */
export function handleHttpError({ status, path, message }) {
	const bare = path.length > 1 ? path.replace(/\/+$/, '') || '/' : path; // cmsLinkTargets drops the trailing slash too
	if (status === 404 && !STATIC_PAGES.includes(bare) && cmsLinked().paths.has(bare)) {
		if (!/^\/api\//.test(bare)) buildWarning(message); // /api/…: the CMS serves it at runtime
		return;
	}
	throw new Error(message);
}

/**
 * kit.prerender.handleMissingId: warn when CMS content links the missing
 * #id; fail on everything else.
 * @param {{ path: string, id: string, referrers: string[], message: string }} details
 */
export function handleMissingId({ path, id, message }) {
	if (cmsLinked().hashlinks.has(`${path}#${id}`)) {
		buildWarning(message);
		return;
	}
	throw new Error(message);
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticWith404({
			// Fully prerendered static site — mirrors the original page-per-file layout
			// (build/shop.html, build/products/cornflakes.html, …).
			pages: PAGES,
			assets: PAGES,
			precompress: false,
			strict: true
		}),
		prerender: {
			handleUnseenRoutes,
			handleHttpError,
			handleMissingId
		},
		alias: {
			// Pure commerce rules shared with the Payload CMS (pricing, validation,
			// cart links) — one source of truth for what the UI shows and the server enforces.
			$shared: 'cms/src/commerce/shared'
		}
	}
};

export default config;
