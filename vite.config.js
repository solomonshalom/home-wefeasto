import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, normalizePath } from 'vite';

/*
 * Same-origin API (SPEC §0). The browser only ever calls /api/* on the
 * storefront's own origin. In `vite dev` and `vite preview` that path is
 * forwarded to the Payload CMS, which is what the vercel.json rewrite does in
 * production, so auth cookies stay first-party.
 *
 * - changeOrigin: true only rewrites the Host header to the CMS host. That is
 *   what a Vercel external rewrite sends, and a remote https CMS needs it to
 *   route the request at all. The browser's Origin header is forwarded
 *   untouched, so Payload's cors/csrf allow-lists (STOREFRONT_ORIGINS:
 *   http://localhost:5173 and :4173) still see the storefront origin.
 * - cookieDomainRewrite: '' drops any Domain attribute from Set-Cookie, so the
 *   payload-token cookie becomes a host-only cookie of the storefront origin.
 * - Over plain http (dev/preview) `Secure` is stripped too; see devCookie().
 */
export const CMS_URL = process.env.CMS_URL || 'http://localhost:3000';

/**
 * One Set-Cookie value made usable on a plain-http dev origin: drop `Secure`
 * (and `Partitioned`, which needs it) and turn `SameSite=None` (only valid
 * with Secure) into `Lax`. The proxy is same-origin, so Lax is enough.
 * `__Secure-` / `__Host-` cookies are left alone: browsers require Secure on them.
 */
export function devCookie(cookie) {
	if (typeof cookie !== 'string' || /^\s*__(Secure|Host)-/i.test(cookie)) return cookie;
	return cookie
		.replace(/;\s*Secure\s*(?=;|$)/gi, '')
		.replace(/;\s*Partitioned\s*(?=;|$)/gi, '')
		.replace(/(;\s*SameSite\s*=\s*)None\s*(?=;|$)/gi, '$1Lax');
}

/** Vite `server.proxy` / `preview.proxy` entry forwarding /api/* to the CMS. */
export function cmsProxy(target = CMS_URL) {
	return {
		// Anchored so only /api, /api/… and /api?… are proxied (not e.g. /api-docs).
		'^/api(?=/|\\?|$)': {
			target,
			changeOrigin: true,
			cookieDomainRewrite: '',
			configure(proxy) {
				proxy.on('proxyRes', (proxyRes, req) => {
					const cookies = proxyRes.headers['set-cookie'];
					if (!cookies || req.socket?.encrypted) return;
					proxyRes.headers['set-cookie'] = cookies.map(devCookie);
				});
			}
		}
	};
}

/*
 * Snapshot split (JS weight). cms-snapshot.json is one JSON module. Rollup can
 * drop a top-level key that nothing imports, but never part of an array, so
 * once code that every page loads reads `recipes` (search, cart data), every
 * recipe body rides in the chunk all pages share. This plugin serves the same
 * file as virtual modules, so a body loads only on the pages that render it:
 *
 * - `virtual:cms-snapshot/catalog`: `version`, `generatedAt`, `settings` and
 *   `products` re-exported from the JSON module itself (a direct
 *   `import { products } from '$lib/data/cms-snapshot.json'` shares that one
 *   copy), `recipes` without RECIPE_BODY_FIELDS and `pages` without `bodyHtml`.
 * - `virtual:cms-snapshot/recipe-bodies`: `recipeBodies[slug]`, exactly the
 *   fields the catalog leaves out: `{ ...recipe, ...recipeBodies[recipe.slug] }`
 *   is the snapshot recipe again. Import it only for the recipe pages.
 * - `virtual:cms-snapshot/page-bodies`: `pageBodies[slug] = { bodyHtml }`, for
 *   policy pages rendered in the browser (server-only code can read the JSON).
 *   Separate from recipe-bodies because Rollup never splits one module across
 *   chunks: a module shared by both routes would ship both kinds of body to each.
 *
 * The JSON file is unchanged and can still be imported whole (tests, scripts,
 * .server.js modules). In dev the modules are rebuilt when it changes (sync:cms).
 */
export const SNAPSHOT_FILE = normalizePath(fileURLToPath(new URL('./src/lib/data/cms-snapshot.json', import.meta.url)));
export const SNAPSHOT_CATALOG_ID = 'virtual:cms-snapshot/catalog';
export const SNAPSHOT_RECIPE_BODIES_ID = 'virtual:cms-snapshot/recipe-bodies';
export const SNAPSHOT_PAGE_BODIES_ID = 'virtual:cms-snapshot/page-bodies';
/** The recipe page's long-form sections: read only by recipes-content.js, never by cards or search. */
export const RECIPE_BODY_FIELDS = [
	'intro',
	'ingredientsHtml',
	'directionsHtml',
	'whyHtml',
	'authorBio',
	'extrasHeading',
	'extrasIntro',
	'extras',
	'recommendedHeading',
	'recommendedIntro',
	'recommended'
];
export const PAGE_BODY_FIELDS = ['bodyHtml'];
const PASSTHROUGH_KEYS = ['version', 'generatedAt', 'settings', 'products'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // as snapshot-schema.js; also keeps __proto__ out of the body maps

function splitRows(rows, name, bodyFields) {
	if (!Array.isArray(rows)) throw new Error(`${name} must be an array`);
	const seen = new Set();
	const bodies = {};
	const lean = rows.map((row, i) => {
		if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${name}[${i}] must be an object`);
		if (typeof row.slug !== 'string' || !SLUG_RE.test(row.slug)) {
			throw new Error(`${name}[${i}].slug must be a kebab-case slug, got ${JSON.stringify(row.slug)}`);
		}
		if (seen.has(row.slug)) throw new Error(`${name}[${i}].slug ${JSON.stringify(row.slug)} is a duplicate`);
		seen.add(row.slug);
		const rest = {};
		const body = {};
		for (const [key, value] of Object.entries(row)) (bodyFields.includes(key) ? body : rest)[key] = value;
		bodies[row.slug] = body;
		return rest;
	});
	return { lean, bodies };
}

/** Pure: `{ recipes, pages, recipeBodies, pageBodies }` for a parsed snapshot (not mutated; key order kept). */
export function splitSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('the snapshot must be a JSON object');
	const recipes = splitRows(snapshot.recipes, 'recipes', RECIPE_BODY_FIELDS);
	const pages = splitRows(snapshot.pages, 'pages', PAGE_BODY_FIELDS);
	return { recipes: recipes.lean, pages: pages.lean, recipeBodies: recipes.bodies, pageBodies: pages.bodies };
}

/** Pure: source code of the three virtual modules for a parsed snapshot stored at `file`. */
export function snapshotModules(snapshot, file = SNAPSHOT_FILE) {
	const { recipes, pages, recipeBodies, pageBodies } = splitSnapshot(snapshot);
	const passthrough = PASSTHROUGH_KEYS.filter((key) => Object.hasOwn(snapshot, key));
	return {
		[SNAPSHOT_CATALOG_ID]:
			`export { ${passthrough.join(', ')} } from ${JSON.stringify(file)};\n` +
			`export const recipes = ${JSON.stringify(recipes)};\n` +
			`export const pages = ${JSON.stringify(pages)};\n`,
		[SNAPSHOT_RECIPE_BODIES_ID]: `export const recipeBodies = ${JSON.stringify(recipeBodies)};\n`,
		[SNAPSHOT_PAGE_BODIES_ID]: `export const pageBodies = ${JSON.stringify(pageBodies)};\n`
	};
}

// Vite keys modules (and the catalog's re-export) by real path; match edits the same way.
const realPath = (p) => {
	try {
		return normalizePath(fs.realpathSync(p));
	} catch {
		return normalizePath(p);
	}
};

/**
 * Vite plugin serving the virtual:cms-snapshot/* modules from `file` (default
 * SNAPSHOT_FILE). `read(file)` returns its JSON text; a test that serves an
 * edited snapshot through its own `load` hook passes the same text here.
 */
export function snapshotSplit({ file = SNAPSHOT_FILE, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
	file = realPath(file);
	const ids = [SNAPSHOT_CATALOG_ID, SNAPSHOT_RECIPE_BODIES_ID, SNAPSHOT_PAGE_BODIES_ID];
	return {
		name: 'wefeasto:snapshot-split',
		resolveId(id) {
			if (ids.includes(id)) return '\0' + id;
		},
		load(id) {
			if (!id.startsWith('\0') || !ids.includes(id.slice(1))) return;
			this.addWatchFile(file);
			try {
				return snapshotModules(JSON.parse(read(file)), file)[id.slice(1)];
			} catch (err) {
				this.error(`${id.slice(1)}: cannot split ${file}: ${err.message}`);
			}
		},
		configureServer(server) {
			// The catalog module imports the JSON statically, so Vite would only
			// soft-invalidate it (keeping the old recipes/pages): drop all three outright.
			const name = file.slice(file.lastIndexOf('/') + 1);
			const drop = (changed) => {
				if (!normalizePath(changed).endsWith('/' + name) || realPath(changed) !== file) return;
				for (const env of Object.values(server.environments ?? {})) {
					for (const id of ids) {
						const mod = env.moduleGraph.getModuleById('\0' + id);
						if (mod) env.moduleGraph.invalidateModule(mod);
					}
				}
			};
			for (const event of ['add', 'change', 'unlink']) server.watcher.on(event, drop);
		}
	};
}

export default defineConfig({
	plugins: [snapshotSplit(), sveltekit()],
	server: {
		proxy: cmsProxy(),
		// The CMS lives in ./cms; never watch its dependencies or build output.
		// cms/src/commerce/shared stays watched: the $shared alias points there.
		watch: { ignored: ['**/cms/node_modules/**', '**/cms/.next/**', '**/cms/media/**'] }
	},
	preview: { proxy: cmsProxy() },
	test: {
		include: ['src/**/*.test.js', 'tests/unit/**/*.test.js'],
		environment: 'node'
	}
});
