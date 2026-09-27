/*
 * Long-form bodies never reach the browser chunks every page shares.
 * Regression (W1R1-03): settings.js imported the snapshot's `pages` and
 * computed publishedPages at module level, so once live.js pulled settings.js
 * into the client, the three draft policy bodies rode along in the _app chunk
 * every page preloads. Now:
 *   - the snapshot holds published pages only (snapshot-schema.test.js),
 *   - unpublished drafts live in policy-drafts.server.json (CMS seed input),
 *   - pages are read by pages.server.js, which SvelteKit keeps server-side.
 * Regression (W1R2-02): products.js, products-content.js and catalog-views.js
 * imported `recipes` from cms-snapshot.json. Rollup never drops part of an
 * array, so all 12 recipe bodies (~14 KB gz) rode in the chunk that /, /shop,
 * /cart, /checkout … preload. Now those modules read the lean
 * `virtual:cms-snapshot/catalog` (vite.config.js snapshotSplit) and only
 * recipes-content.js (recipe routes) merges in `virtual:cms-snapshot/recipe-bodies`.
 * Two checks here: a scan of every storefront source file's imports, and a
 * real Vite production build of the client-facing data modules against a
 * snapshot with canary bodies (Rollup tree-shaking, as in `npm run build`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'vite';
import { ROOT, SNAPSHOT_PATH, snapshotCopy, draftsCopy } from './fixtures.js';
import { snapshotSplit, RECIPE_BODY_FIELDS, SNAPSHOT_CATALOG_ID, SNAPSHOT_RECIPE_BODIES_ID, SNAPSHOT_PAGE_BODIES_ID } from '../../../vite.config.js';

const DATA = path.join(ROOT, 'src/lib/data');
const SERVER_ONLY = /\.server\./; // SvelteKit's rule: *.server.* files never reach the browser

/* ------------------------------------------------ source import scan */

function sourceFiles(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return sourceFiles(full);
		return /\.(js|ts|svelte)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
	});
}

/** Every static import / re-export and dynamic import: `[{ clause, from }]` (clause null = whole module). */
function importsOf(text) {
	const found = [];
	for (const m of text.matchAll(/\b(?:import|export)\s+([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g)) found.push({ clause: m[1].trim(), from: m[2] });
	for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ clause: null, from: m[1] });
	return found;
}

/** Names taken from a module by an import clause; '*' for default or namespace imports. */
function importedNames(clause) {
	if (clause === null) return ['*'];
	const named = clause.match(/^\{([^}]*)\}$/);
	if (!named) return ['*'];
	return named[1]
		.split(',')
		.map((s) => s.trim().split(/\s+as\s+/)[0].trim())
		.filter(Boolean)
		.map((n) => (n === 'default' ? '*' : n));
}

const isSnapshotJson = (spec) => /(^|\/)cms-snapshot\.json(\?.*)?$/.test(spec);
const isSnapshotVirtual = (spec) => spec.startsWith('virtual:cms-snapshot/');
const isSnapshot = (spec) => isSnapshotJson(spec) || isSnapshotVirtual(spec);
const isServerOnlyData = (spec) => /(^|\/)(pages\.server\.js|policy-drafts\.server\.json)(\?.*)?$/.test(spec);
const isRecipesContent = (spec) => /(^|\/)recipes-content(\.js)?(\?.*)?$/.test(spec);
const VIRTUAL_IDS = [SNAPSHOT_CATALOG_ID, SNAPSHOT_RECIPE_BODIES_ID, SNAPSHOT_PAGE_BODIES_ID];
/** Browser files allowed to import each body module: bodies must load only with the routes that render them. */
const BODY_IMPORTERS = {
	[SNAPSHOT_RECIPE_BODIES_ID]: ['src/lib/data/recipes-content.js'],
	[SNAPSHOT_PAGE_BODIES_ID]: [] // policy pages render from a server load (pages.server.js)
};
const RECIPE_ROUTES = 'src/routes/recipes/';

describe('storefront sources (browser-reachable files)', () => {
	const files = sourceFiles(path.join(ROOT, 'src')).filter((f) => !SERVER_ONLY.test(path.basename(f)) && !f.includes(`${path.sep}lib${path.sep}server${path.sep}`));
	const imports = files.flatMap((file) => importsOf(fs.readFileSync(file, 'utf8')).map((imp) => ({ ...imp, file: path.relative(ROOT, file).split(path.sep).join('/') })));
	const importersOf = (test) => [...new Set(imports.filter((i) => test(i.from)).map((i) => i.file))].sort();
	const show = (i) => `${i.file}: import ${i.clause ?? '(dynamic)'} from '${i.from}'`;

	it('the scan sees the known snapshot importers (sanity)', () => {
		const json = importersOf(isSnapshotJson);
		expect(json).toContain('src/lib/data/settings.js');
		expect(json).not.toContain('src/lib/data/pages.server.js'); // server-only: not scanned
		const catalog = importersOf((s) => s === SNAPSHOT_CATALOG_ID);
		for (const f of ['products.js', 'products-content.js', 'catalog-views.js', 'recipes-content.js']) expect(catalog).toContain(`src/lib/data/${f}`);
		expect(importersOf((s) => s === SNAPSHOT_RECIPE_BODIES_ID)).toEqual(['src/lib/data/recipes-content.js']);
		const recipeContent = importersOf(isRecipesContent);
		expect(recipeContent).toContain('src/routes/recipes/[slug]/+page.js');
		expect(recipeContent).toContain('src/routes/recipes/[slug]/+page.svelte');
	});

	it('take only named keys from cms-snapshot.json, never `recipes` or `pages` (whole arrays, bodies included), the default export or the whole module', () => {
		const bad = imports
			.filter((i) => isSnapshotJson(i.from))
			.filter((i) => i.from.includes('?') || importedNames(i.clause).some((n) => n === '*' || n === 'pages' || n === 'recipes'))
			.map(show);
		expect(bad, 'take recipes/pages from virtual:cms-snapshot/catalog (vite.config.js snapshotSplit)').toEqual([]);
	});

	it('take only named keys from the virtual:cms-snapshot/* modules, and only ids snapshotSplit serves', () => {
		const bad = imports
			.filter((i) => isSnapshotVirtual(i.from))
			.filter((i) => !VIRTUAL_IDS.includes(i.from) || importedNames(i.clause).includes('*'))
			.map(show);
		expect(bad).toEqual([]);
	});

	it.each(Object.entries(BODY_IMPORTERS))('only the routes that render them import %s', (id, allowed) => {
		const bad = imports.filter((i) => i.from === id && !allowed.includes(i.file)).map(show);
		expect(bad, `${id} imported elsewhere ships every body to more pages`).toEqual([]);
	});

	it(`recipes-content.js (it merges every recipe body) is imported only under ${RECIPE_ROUTES}`, () => {
		const bad = imports.filter((i) => isRecipesContent(i.from) && !i.file.startsWith(RECIPE_ROUTES)).map(show);
		expect(bad, 'for recipe cards/links use products.js `recipes` or catalog-views.js').toEqual([]);
	});

	it('never import pages.server.js or policy-drafts.server.json (use a +page.server.js / +layout.server.js load)', () => {
		const bad = imports.filter((i) => isServerOnlyData(i.from)).map((i) => `${i.file}: ${i.from}`);
		expect(bad).toEqual([]);
	});

	it.each([
		["import { settings, products } from './cms-snapshot.json';", ['settings', 'products']],
		["import {\n\tproducts as snapshotProducts,\n\trecipes\n} from '$lib/data/cms-snapshot.json';", ['products', 'recipes']],
		["import { settings as s, pages } from './cms-snapshot.json';", ['settings', 'pages']],
		["import snapshot from './cms-snapshot.json';", ['*']],
		["import * as snapshot from './cms-snapshot.json';", ['*']],
		["import snapshot, { settings } from './cms-snapshot.json';", ['*']],
		["import { default as snapshot } from './cms-snapshot.json';", ['*']],
		["const s = await import('./cms-snapshot.json');", ['*']],
		["export { pages } from './cms-snapshot.json';", ['pages']],
		["import { products, recipes as catalogRecipes } from 'virtual:cms-snapshot/catalog';", ['products', 'recipes']],
		["import { recipeBodies } from 'virtual:cms-snapshot/recipe-bodies';", ['recipeBodies']],
		["import * as bodies from 'virtual:cms-snapshot/page-bodies';", ['*']],
		["const b = await import('virtual:cms-snapshot/recipe-bodies');", ['*']]
	])('the scanner reads %j', (source, names) => {
		const [imp] = importsOf(source);
		expect(isSnapshot(imp.from)).toBe(true);
		expect(importedNames(imp.clause)).toEqual(names);
	});

	it.each([
		['$lib/data/recipes-content.js', true],
		['./recipes-content.js', true],
		['$lib/data/recipes-content', true],
		['$lib/data/recipes-content.json', false],
		['$lib/data/products-content.js', false]
	])('isRecipesContent(%j) is %s', (spec, expected) => {
		expect(isRecipesContent(spec)).toBe(expected);
	});
});

/* ------------------------------------------- production bundle check */

const CANARY = 'WF-CANARY-PAGE-BODY-7f3a';
const RECIPE_CANARY = 'WF-CANARY-RECIPE-BODY-2c9e';
const CLIENT_MODULES = ['products.js', 'products-content.js', 'recipes-content.js', 'settings.js', 'catalog-views.js', 'derive.js'];
/** The data modules every page can load (search, cart, toast, home, shop, PDP, 404): no recipe body allowed. */
const EVERY_PAGE_MODULES = ['products.js', 'products-content.js', 'catalog-views.js', 'settings.js', 'derive.js'];

/**
 * The committed snapshot with a published canary page, and a canary tagged
 * `<RECIPE_CANARY>:<slug>:<field>` appended to every recipe body field (strings
 * directly, `extras` / `recommended` in their first item's reason).
 * Deterministic: returns the same snapshot and canary list on every call.
 */
function canarySnapshot() {
	const snapshot = snapshotCopy();
	snapshot.pages = [{ slug: 'canary', title: 'Canary', bodyHtml: `<p>${CANARY}</p>`, published: true }];
	const recipeCanaries = [];
	for (const r of snapshot.recipes) {
		for (const field of RECIPE_BODY_FIELDS) {
			const tag = `${RECIPE_CANARY}:${r.slug}:${field}`;
			if (typeof r[field] === 'string') r[field] += ` ${tag}`;
			else if (Array.isArray(r[field]) && r[field].length) r[field][0] = { ...r[field][0], reason: `${r[field][0].reason} ${tag}` };
			else continue;
			recipeCanaries.push(tag);
		}
	}
	return { snapshot, recipeCanaries };
}

let tmp;
beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-bundle-'));
});
afterAll(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Vite production build (lib mode, ES, not minified) of one or more entries
 * (`{ name: source }`) against canarySnapshot(), served both as the JSON
 * module and through snapshotSplit (as vite.config.js does). Returns Rollup's
 * output chunks: several entries share chunks exactly as SvelteKit routes do.
 */
async function buildChunks(entries) {
	const { snapshot } = canarySnapshot();
	const entry = {};
	for (const [name, source] of Object.entries(entries)) {
		entry[name] = path.join(tmp, `${name}.js`);
		fs.writeFileSync(entry[name], source);
	}
	const out = await build({
		root: tmp,
		configFile: false,
		logLevel: 'silent',
		mode: 'production',
		plugins: [
			{
				name: 'wf-canary-snapshot',
				enforce: 'pre',
				load(id) {
					if (id.split('?')[0] === SNAPSHOT_PATH) return JSON.stringify(snapshot);
				}
			},
			snapshotSplit({ read: () => JSON.stringify(snapshot) })
		],
		build: { write: false, minify: false, lib: { entry, formats: ['es'] } }
	});
	return [out].flat().flatMap((o) => o.output);
}

const codeOf = (chunk) => chunk.code ?? String(chunk.source ?? '');

/** All code of a single-entry build. */
async function bundle(name, entrySource) {
	return (await buildChunks({ [name]: entrySource })).map(codeOf).join('\n');
}

/** Code an entry loads up front: its chunk plus every chunk it imports statically, transitively. */
function staticClosure(chunks, entryName) {
	const byFile = new Map(chunks.map((c) => [c.fileName, c]));
	const start = chunks.find((c) => c.isEntry && c.name === entryName);
	if (!start) throw new Error(`no entry chunk ${entryName}`);
	const seen = new Set();
	const walk = (c) => {
		if (!c || seen.has(c.fileName)) return;
		seen.add(c.fileName);
		for (const f of c.imports ?? []) walk(byFile.get(f));
	};
	walk(start);
	return [...seen].map((f) => byFile.get(f));
}

const abs = (file) => JSON.stringify(path.join(DATA, file));
/** `true` when `text` holds any recipe-body canary (checks the prefix, so no single field can slip past). */
const hasRecipeBody = (text) => text.includes(RECIPE_CANARY);

describe('canarySnapshot (test helper)', () => {
	it('plants a canary in every body field of every recipe, and nothing in the card fields', () => {
		const { snapshot, recipeCanaries } = canarySnapshot();
		const original = snapshotCopy();
		expect(snapshot.recipes.length).toBeGreaterThan(0);
		for (const r of snapshot.recipes) {
			for (const field of RECIPE_BODY_FIELDS) expect(recipeCanaries, `${r.slug}.${field}`).toContain(`${RECIPE_CANARY}:${r.slug}:${field}`);
			const card = Object.fromEntries(Object.entries(r).filter(([k]) => !RECIPE_BODY_FIELDS.includes(k)));
			expect(JSON.stringify(card)).not.toContain(RECIPE_CANARY);
		}
		expect(recipeCanaries).toHaveLength(snapshot.recipes.length * RECIPE_BODY_FIELDS.length);
		expect(canarySnapshot()).toEqual({ snapshot, recipeCanaries }); // deterministic
		expect(snapshotCopy()).toEqual(original); // the committed file is untouched
	});
});

describe('client bundle of the data modules (vite build)', () => {
	const draftBodies = draftsCopy().pages.map((p) => p.bodyHtml.slice(-80));
	const { snapshot: canary, recipeCanaries } = canarySnapshot();
	const everyPageEntry = EVERY_PAGE_MODULES.map((f, i) => `export * as m${i} from ${abs(f)};`).join('\n');

	it('carries every export of every client-facing data module and the named snapshot keys, but no page body', async () => {
		const code = await bundle(
			'client',
			[
				...CLIENT_MODULES.map((f, i) => `export * as m${i} from ${abs(f)};`),
				`export { settings, products, recipes } from ${abs('cms-snapshot.json')};`
			].join('\n')
		);
		expect(code).toContain('buildPricingCatalog'); // really bundled the modules
		expect(code).toContain('freeDeliveryThresholdPaise');
		expect(code).not.toContain(CANARY);
		for (const body of draftBodies) expect(code).not.toContain(body);
		expect(code).not.toContain('Draft — to be reviewed');
		expect(code).not.toContain('[to be added]');
	}, 30000);

	it('what live.js / support.js take from settings.js carries no page body', async () => {
		const code = await bundle('settings-only', `import { settings, catalogForPricing } from ${abs('settings.js')};\nconsole.log(settings, catalogForPricing());`);
		expect(code).toContain('freeDeliveryThresholdPaise');
		expect(code).not.toContain(CANARY);
	}, 30000);

	it('control: pages.server.js does carry the page bodies (so the checks above can see a leak)', async () => {
		const code = await bundle('pages', `export { publishedPages } from ${abs('pages.server.js')};`);
		expect(code).toContain(CANARY);
	}, 30000);

	it('what every page can load (products.js, products-content.js, catalog-views.js, settings.js, derive.js) has the recipe cards but no recipe body', async () => {
		const code = await bundle('every-page', everyPageEntry);
		expect(code).toContain('buildProductsContent'); // really bundled the modules
		expect(code).toContain('buildKitchenRecipes');
		for (const r of canary.recipes) {
			expect(code).toContain(JSON.stringify(r.slug)); // recipe cards, search and links still work
			expect(code).toContain(JSON.stringify(r.cardAlt));
		}
		expect(hasRecipeBody(code)).toBe(false);
		expect(code).not.toContain(CANARY);
	}, 30000);

	it.each([
		['products.js `recipes` (search.js)', `export { recipes, products, productBySlug } from ${abs('products.js')};`],
		['products-content.js ("Recipes using …" on the PDP)', `export { productsContent } from ${abs('products-content.js')};`],
		['catalog-views.js (home "Fresh from the Kitchen")', `export { kitchenRecipes, homeBestsellers, shopItems } from ${abs('catalog-views.js')};`]
	])('%s alone carries no recipe body', async (_, source) => {
		const code = await bundle('one-module', source);
		expect(code).toContain(JSON.stringify(canary.recipes[0].slug));
		expect(hasRecipeBody(code)).toBe(false);
	}, 30000);

	it('split like SvelteKit routes: nothing every page preloads carries a body; the recipe route loads them all', async () => {
		const chunks = await buildChunks({
			every: everyPageEntry,
			recipe: `export { recipesContent } from ${abs('recipes-content.js')};\nexport { productBySlug } from ${abs('products.js')};`
		});
		const every = staticClosure(chunks, 'every');
		const recipe = staticClosure(chunks, 'recipe');
		const shared = every.filter((c) => recipe.includes(c));
		expect(shared.length, 'the two entries share a chunk (derive.js, the catalog)').toBeGreaterThan(0);
		expect(shared.map(codeOf).join('\n')).toContain('buildRecipes');
		expect(hasRecipeBody(every.map(codeOf).join('\n'))).toBe(false);
		const recipeCode = recipe.map(codeOf).join('\n');
		for (const tag of recipeCanaries) expect(recipeCode).toContain(tag);
		// The bodies sit only in chunks that the recipe route alone loads.
		const withBodies = chunks.filter((c) => hasRecipeBody(codeOf(c)));
		expect(withBodies.length).toBeGreaterThan(0);
		for (const c of withBodies) expect(every).not.toContain(c);
	}, 30000);

	it('control: recipes-content.js does carry every recipe body (so the checks above can see a leak)', async () => {
		const code = await bundle('recipe-bodies', `export { recipesContent } from ${abs('recipes-content.js')};`);
		for (const tag of recipeCanaries) expect(code).toContain(tag);
	}, 30000);

	it('control: a direct `recipes` import from cms-snapshot.json does carry the bodies (the W1R2-02 leak)', async () => {
		const code = await bundle('raw-recipes', `export { recipes } from ${abs('cms-snapshot.json')};`);
		expect(hasRecipeBody(code)).toBe(true);
	}, 30000);
});
