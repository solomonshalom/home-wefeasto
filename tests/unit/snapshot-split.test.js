/*
 * vite.config.js snapshotSplit(): cms-snapshot.json served as a lean catalog
 * module plus recipe-bodies and page-bodies modules, so recipe bodies and
 * policy pages load only on the pages that render them instead of riding in
 * the chunk every page shares. Covered here: the pure split, the modules this
 * vitest run gets from the real config, a Vite dev server (including a
 * snapshot edit), and a Rollup build (what lands in each entry's chunks).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, createServer } from 'vite';
import config, {
	SNAPSHOT_FILE,
	SNAPSHOT_CATALOG_ID,
	SNAPSHOT_RECIPE_BODIES_ID,
	SNAPSHOT_PAGE_BODIES_ID,
	RECIPE_BODY_FIELDS,
	PAGE_BODY_FIELDS,
	splitSnapshot,
	snapshotModules,
	snapshotSplit
} from '../../vite.config.js';
import { SNAPSHOT_SCHEMA, validateSnapshot } from '$lib/data/snapshot-schema.js';
import * as derive from '$lib/data/derive.js';
import * as raw from '$lib/data/cms-snapshot.json';
import * as catalog from 'virtual:cms-snapshot/catalog';
import * as recipeBodiesModule from 'virtual:cms-snapshot/recipe-bodies';
import * as pageBodiesModule from 'virtual:cms-snapshot/page-bodies';
import { SNAPSHOT_PATH, snapshotCopy, legacy } from './data/fixtures.js';

const RECIPE_FIELDS = Object.keys(SNAPSHOT_SCHEMA.fields.recipes.of.fields);
const PAGE_FIELDS = Object.keys(SNAPSHOT_SCHEMA.fields.pages.of.fields);
const IDS = [SNAPSHOT_CATALOG_ID, SNAPSHOT_RECIPE_BODIES_ID, SNAPSHOT_PAGE_BODIES_ID];

/** Deep equality AND identical key order. */
function expectSame(actual, expected) {
	expect(actual).toStrictEqual(expected);
	expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

const merge = (rows, map) => rows.map((row) => ({ ...row, ...map[row.slug] }));

// The committed snapshot may hold no policy page (drafts stay outside it until
// the owner publishes one), so the page half of the split runs on a copy with one.
const EXTRA_PAGE = {
	slug: 'split-test-policy',
	title: 'Split test policy',
	bodyHtml: '<h2>Where we deliver</h2><p>Parcels travel across every serviceable PIN code in India within a week.</p>',
	published: true
};
const snapWithPage = () => {
	const snap = snapshotCopy();
	snap.pages.push({ ...EXTRA_PAGE });
	return snap;
};

describe('the field split', () => {
	const snap = snapWithPage();
	const split = splitSnapshot(snap);

	it('moves only real schema fields, and never the ones cards, search or links read', () => {
		expect(RECIPE_BODY_FIELDS.every((f) => RECIPE_FIELDS.includes(f))).toBe(true);
		expect(PAGE_BODY_FIELDS.every((f) => PAGE_FIELDS.includes(f))).toBe(true);
		expect(new Set(RECIPE_BODY_FIELDS).size).toBe(RECIPE_BODY_FIELDS.length);
		const cardFields = ['slug', 'title', 'sortOrder', 'category', 'description', 'image', 'cardAlt', 'homeFeatured', 'homeAlt', 'iconColor', 'iconSrc', 'iconAlt', 'prepTime', 'cookTime', 'serves', 'products', 'searchTerms'];
		for (const f of cardFields) expect(RECIPE_BODY_FIELDS).not.toContain(f);
		expect(PAGE_BODY_FIELDS).toEqual(['bodyHtml']);
	});

	it('the committed snapshot (and the copy with a page) is valid, so the split below covers every field', () => {
		expect(validateSnapshot(snapshotCopy())).toEqual({ ok: true, errors: [] });
		expect(validateSnapshot(snap)).toEqual({ ok: true, errors: [] });
		expect(snap.recipes.length).toBeGreaterThan(0);
		expect(snap.pages.length).toBeGreaterThan(0);
	});

	it('catalog recipes keep every other field, in the snapshot key order', () => {
		const lean = RECIPE_FIELDS.filter((f) => !RECIPE_BODY_FIELDS.includes(f));
		expect(split.recipes).toHaveLength(snap.recipes.length);
		split.recipes.forEach((r, i) => {
			expect(Object.keys(r)).toEqual(lean);
			for (const f of lean) expect(r[f]).toStrictEqual(snap.recipes[i][f]);
		});
	});

	it('catalog pages are {slug, title, published}', () => {
		expect(split.pages).toEqual(snap.pages.map(({ slug, title, published }) => ({ slug, title, published })));
		split.pages.forEach((p) => expect(Object.keys(p)).toEqual(['slug', 'title', 'published']));
	});

	it('bodies are keyed by slug (catalog order) and hold exactly the body fields', () => {
		expect(Object.keys(split.recipeBodies)).toEqual(snap.recipes.map((r) => r.slug));
		expect(Object.keys(split.pageBodies)).toEqual(snap.pages.map((p) => p.slug));
		for (const r of snap.recipes) {
			expect(Object.keys(split.recipeBodies[r.slug])).toEqual(RECIPE_BODY_FIELDS);
			for (const f of RECIPE_BODY_FIELDS) expect(split.recipeBodies[r.slug][f]).toStrictEqual(r[f]);
		}
		for (const p of snap.pages) expect(split.pageBodies[p.slug]).toStrictEqual({ bodyHtml: p.bodyHtml });
	});

	it('catalog + bodies is the snapshot again (the recipe and policy pages lose nothing)', () => {
		expect(merge(split.recipes, split.recipeBodies)).toStrictEqual(snap.recipes);
		expect(merge(split.pages, split.pageBodies)).toStrictEqual(snap.pages);
		const merged = { ...snap, recipes: merge(split.recipes, split.recipeBodies), pages: merge(split.pages, split.pageBodies) };
		expect(validateSnapshot(merged)).toEqual({ ok: true, errors: [] });
	});

	it('the body fields are the bulk of the recipe bytes', () => {
		const size = (v) => JSON.stringify(v).length;
		expect(size(split.recipes)).toBeLessThan(size(snap.recipes) / 3);
		expect(size(split.pages)).toBeLessThan(size(snap.pages));
	});

	it('every view outside the recipe page derives identically from the catalog alone', () => {
		const lean = { ...snap, recipes: split.recipes, pages: split.pages };
		for (const name of ['buildProducts', 'buildRecipes', 'buildProductsContent', 'buildHomeBestsellers', 'buildKitchenRecipes', 'buildShopItems', 'buildPricingCatalog']) {
			expectSame(derive[name](lean), derive[name](snap));
		}
		// ...and still matches the pre-CMS data files.
		expectSame(derive.buildProducts(lean), legacy('products'));
		expectSame(derive.buildRecipes(lean), legacy('recipes'));
		expectSame(derive.buildProductsContent(lean), legacy('productsContent'));
		expectSame(derive.buildHomeBestsellers(lean), legacy('home-bestsellers'));
		expectSame(derive.buildKitchenRecipes(lean), legacy('home-kitchenRecipes'));
		expectSame(derive.buildShopItems(lean), legacy('shop-items'));
	});

	it('the recipe page needs the bodies, and catalog + bodies reproduces it exactly', () => {
		const lean = { ...snap, recipes: split.recipes, pages: split.pages };
		const content = derive.buildRecipesContent({ ...lean, recipes: merge(split.recipes, split.recipeBodies) });
		expectSame(content, derive.buildRecipesContent(snap));
		expectSame(content, legacy('recipesContent'));
		// Without them it cannot be built (extras/recommended are lists).
		expect(() => derive.buildRecipesContent(lean)).toThrow(TypeError);
	});
});

describe('splitSnapshot input handling', () => {
	const recipe = (slug, extra = {}) => ({ slug, title: slug, intro: 'i', ingredientsHtml: '<p>x</p>', ...extra });
	const page = (slug, extra = {}) => ({ slug, title: slug, bodyHtml: '<p>b</p>', published: false, ...extra });

	it('does not mutate its input and returns fresh rows', () => {
		const snap = snapWithPage();
		const before = JSON.stringify(snap);
		const deepFreeze = (v) => (v && typeof v === 'object' ? (Object.values(v).forEach(deepFreeze), Object.freeze(v)) : v);
		deepFreeze(snap);
		const split = splitSnapshot(snap);
		expect(JSON.stringify(snap)).toBe(before);
		expect(split.recipes[0]).not.toBe(snap.recipes[0]);
		split.recipes[0].title = 'changed';
		expect(snap.recipes[0].title).not.toBe('changed');
	});

	it('empty recipes and pages', () => {
		expect(splitSnapshot({ recipes: [], pages: [] })).toEqual({ recipes: [], pages: [], recipeBodies: {}, pageBodies: {} });
	});

	it('a row without some body fields gets a body without them (no undefined keys)', () => {
		const out = splitSnapshot({ recipes: [{ slug: 'a', title: 'A' }, recipe('b')], pages: [{ slug: 'p', title: 'P', published: true }] });
		expect(out.recipeBodies).toEqual({ a: {}, b: { intro: 'i', ingredientsHtml: '<p>x</p>' } });
		expect(Object.keys(out.recipeBodies.a)).toEqual([]);
		expect(out.pageBodies).toEqual({ p: {} });
		expect(out.pages).toEqual([{ slug: 'p', title: 'P', published: true }]);
	});

	it('unknown fields stay in the catalog', () => {
		const out = splitSnapshot({ recipes: [recipe('a', { future: 1 })], pages: [page('p', { future: 2 })] });
		expect(out.recipes).toEqual([{ slug: 'a', title: 'a', future: 1 }]);
		expect(out.pages).toEqual([{ slug: 'p', title: 'p', published: false, future: 2 }]);
	});

	it('slugs that look like Object.prototype members are plain own keys', () => {
		const out = splitSnapshot({ recipes: [recipe('constructor'), recipe('to-string')], pages: [] });
		expect(Object.keys(out.recipeBodies)).toEqual(['constructor', 'to-string']);
		expect(out.recipeBodies.constructor.intro).toBe('i');
	});

	it.each([
		['null snapshot', null, /snapshot must be a JSON object/],
		['array snapshot', [], /snapshot must be a JSON object/],
		['string snapshot', 'x', /snapshot must be a JSON object/],
		['recipes missing', { pages: [] }, /^recipes must be an array$/],
		['recipes an object', { recipes: {}, pages: [] }, /^recipes must be an array$/],
		['pages missing', { recipes: [] }, /^pages must be an array$/],
		['row null', { recipes: [null], pages: [] }, /^recipes\[0\] must be an object$/],
		['row an array', { recipes: [], pages: [[]] }, /^pages\[0\] must be an object$/],
		['row a string', { recipes: [recipe('a'), 'b'], pages: [] }, /^recipes\[1\] must be an object$/],
		['slug missing', { recipes: [{ title: 'x' }], pages: [] }, /^recipes\[0\]\.slug must be a kebab-case slug, got undefined$/],
		['slug a number', { recipes: [], pages: [page(7)] }, /^pages\[0\]\.slug must be a kebab-case slug, got 7$/],
		['slug with spaces', { recipes: [recipe('Bad Slug')], pages: [] }, /got "Bad Slug"/],
		['slug empty', { recipes: [recipe('')], pages: [] }, /got ""/],
		['slug __proto__', { recipes: [recipe('__proto__')], pages: [] }, /got "__proto__"/],
		['duplicate recipe slug', { recipes: [recipe('a'), recipe('b'), recipe('a')], pages: [] }, /^recipes\[2\]\.slug "a" is a duplicate$/],
		['duplicate page slug', { recipes: [], pages: [page('p'), page('p')] }, /^pages\[1\]\.slug "p" is a duplicate$/]
	])('%s → throws', (_name, input, message) => {
		expect(() => splitSnapshot(input)).toThrow(message);
	});

	it('a recipe slug may equal a page slug (separate maps)', () => {
		const out = splitSnapshot({ recipes: [recipe('same')], pages: [page('same')] });
		expect(out.recipeBodies.same.intro).toBe('i');
		expect(out.pageBodies.same.bodyHtml).toBe('<p>b</p>');
	});
});

describe('snapshotModules (generated source)', () => {
	it('one source per module id', () => {
		expect(Object.keys(snapshotModules(snapWithPage()))).toEqual(IDS);
	});

	it('catalog re-exports the unsplit keys from the JSON file and inlines the lean lists', () => {
		const code = snapshotModules(snapWithPage(), '/x/cms-snapshot.json')[SNAPSHOT_CATALOG_ID];
		expect(code.split('\n')[0]).toBe('export { version, generatedAt, settings, products } from "/x/cms-snapshot.json";');
		for (const f of [...RECIPE_BODY_FIELDS, ...PAGE_BODY_FIELDS]) expect(code).not.toContain(`"${f}"`);
	});

	it('only re-exports keys the file has', () => {
		const code = (snap) => snapshotModules(snap, '/x.json')[SNAPSHOT_CATALOG_ID].split('\n')[0];
		expect(code({ products: [], recipes: [], pages: [] })).toBe('export { products } from "/x.json";');
		expect(code({ recipes: [], pages: [] })).toBe('export {  } from "/x.json";');
	});

	it('each body module holds only its own kind of body', () => {
		const out = snapshotModules(snapWithPage());
		expect(out[SNAPSHOT_RECIPE_BODIES_ID]).toMatch(/^export const recipeBodies = \{.*\};\n$/s);
		expect(out[SNAPSHOT_PAGE_BODIES_ID]).toMatch(/^export const pageBodies = \{.*\};\n$/s);
		expect(out[SNAPSHOT_RECIPE_BODIES_ID]).not.toContain('bodyHtml');
		expect(out[SNAPSHOT_RECIPE_BODIES_ID]).not.toContain(EXTRA_PAGE.slug);
		expect(out[SNAPSHOT_PAGE_BODIES_ID]).not.toContain('ingredientsHtml');
	});

	it('body sources evaluate to the split: plain objects, exotic text intact', async () => {
		const LS = String.fromCharCode(0x2028);
		const PS = String.fromCharCode(0x2029);
		const snap = snapWithPage();
		snap.recipes[0].intro = `quote " backslash \\ line${LS}sep ${PS} </script> \${x} \`tick\``;
		snap.pages[0].bodyHtml = `<p>“curly” ₹499 ${LS}</p>`;
		const out = snapshotModules(snap);
		const load = (id) => import('data:text/javascript,' + encodeURIComponent(out[id]));
		const recipeMod = await load(SNAPSHOT_RECIPE_BODIES_ID);
		const pageMod = await load(SNAPSHOT_PAGE_BODIES_ID);
		const split = splitSnapshot(snap);
		expect(Object.keys(recipeMod)).toEqual(['recipeBodies']);
		expect(Object.keys(pageMod)).toEqual(['pageBodies']);
		expect(recipeMod.recipeBodies).toStrictEqual(split.recipeBodies);
		expect(pageMod.pageBodies).toStrictEqual(split.pageBodies);
		expect(Object.getPrototypeOf(recipeMod.recipeBodies)).toBe(Object.prototype);
		expect(recipeMod.recipeBodies[snap.recipes[0].slug].intro).toBe(snap.recipes[0].intro);
		expect(pageMod.pageBodies[snap.pages[0].slug].bodyHtml).toBe(snap.pages[0].bodyHtml);
	});
});

describe('the modules this test run gets from vite.config.js', () => {
	it('the config registers the plugin before SvelteKit', () => {
		expect(config.plugins[0].name).toBe('wefeasto:snapshot-split');
		expect(SNAPSHOT_FILE).toBe(SNAPSHOT_PATH.split(path.sep).join('/'));
		expect(IDS).toEqual(['virtual:cms-snapshot/catalog', 'virtual:cms-snapshot/recipe-bodies', 'virtual:cms-snapshot/page-bodies']);
	});

	it('export exactly the documented names', () => {
		expect(Object.keys(catalog).sort()).toEqual(['generatedAt', 'pages', 'products', 'recipes', 'settings', 'version']);
		expect(Object.keys(recipeBodiesModule)).toEqual(['recipeBodies']);
		expect(Object.keys(pageBodiesModule)).toEqual(['pageBodies']);
	});

	it('share products and settings with the JSON module (one copy in a bundle)', () => {
		expect(catalog.products).toBe(raw.products);
		expect(catalog.settings).toBe(raw.settings);
		expect(catalog.version).toBe(raw.version);
		expect(catalog.generatedAt).toBe(raw.generatedAt);
	});

	it('serve the split of the committed file', () => {
		const split = splitSnapshot(snapshotCopy());
		expect(catalog.recipes).toStrictEqual(split.recipes);
		expect(catalog.pages).toStrictEqual(split.pages);
		expect(recipeBodiesModule.recipeBodies).toStrictEqual(split.recipeBodies);
		expect(pageBodiesModule.pageBodies).toStrictEqual(split.pageBodies);
		expect(merge(catalog.recipes, recipeBodiesModule.recipeBodies)).toStrictEqual(raw.recipes);
		expect(merge(catalog.pages, pageBodiesModule.pageBodies)).toStrictEqual(raw.pages);
	});
});

/* --------------------------------------------------- real Vite, temp files */

const tmpSnapshot = () => {
	// realpath: macOS tmpdir is a symlink, and Vite keys modules by real path.
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-split-')));
	const file = path.join(dir, 'cms-snapshot.json');
	fs.writeFileSync(file, JSON.stringify(snapWithPage(), null, 2));
	return { dir, file };
};

/** 30 plain characters from one text run of `text` (never across a tag): they survive any string escaping, so built code can be searched for them. */
function marker(text) {
	for (const run of String(text).split(/<[^>]*>/)) {
		const m = run.match(/[A-Za-z][A-Za-z ,.]{29,}/);
		if (m) return m[0].slice(0, 30);
	}
	throw new Error('no marker in ' + text);
}

describe('Vite dev server', { timeout: 60000 }, () => {
	let vite;
	let dir;
	let file;

	beforeAll(async () => {
		({ dir, file } = tmpSnapshot());
		vite = await createServer({
			configFile: false,
			root: dir,
			logLevel: 'silent',
			appType: 'custom',
			server: { middlewareMode: true, hmr: false, ws: false },
			plugins: [snapshotSplit({ file })]
		});
	});

	afterAll(async () => {
		await vite?.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const edit = (fn) => {
		const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
		fn(snap);
		fs.writeFileSync(file, JSON.stringify(snap, null, 2));
		vite.watcher.emit('change', file); // what chokidar reports; don't wait on fs events
	};

	it('serves all three modules (SSR), sharing products with the JSON module', async () => {
		const cat = await vite.ssrLoadModule(SNAPSHOT_CATALOG_ID);
		const rb = await vite.ssrLoadModule(SNAPSHOT_RECIPE_BODIES_ID);
		const pb = await vite.ssrLoadModule(SNAPSHOT_PAGE_BODIES_ID);
		const json = await vite.ssrLoadModule(file);
		const split = splitSnapshot(snapWithPage());
		expect(cat.pages).toEqual([{ slug: EXTRA_PAGE.slug, title: EXTRA_PAGE.title, published: true }]);
		expect(cat.recipes).toStrictEqual(split.recipes);
		expect(rb.recipeBodies).toStrictEqual(split.recipeBodies);
		expect(pb.pageBodies).toStrictEqual(split.pageBodies);
		expect(cat.products).toBe(json.products);
		expect(cat.settings).toBe(json.settings);
	});

	it('client code imports the JSON by URL and carries no body field', async () => {
		const res = await vite.environments.client.transformRequest(SNAPSHOT_CATALOG_ID);
		expect(res.code).toMatch(/^export \{ version, generatedAt, settings, products \} from "\/cms-snapshot\.json(\?[^"]*)?";$/m);
		for (const f of [...RECIPE_BODY_FIELDS, ...PAGE_BODY_FIELDS]) expect(res.code).not.toContain(`"${f}"`);
		expect(res.code).not.toContain(marker(snapshotCopy().recipes[0].directionsHtml));
	});

	it('a snapshot edit (npm run sync:cms) reaches every module, SSR and client', async () => {
		for (const id of IDS) {
			await vite.ssrLoadModule(id);
			await vite.environments.client.transformRequest(id);
		}
		edit((s) => {
			s.recipes[0].title = 'Edited title';
			s.recipes[0].whyHtml = '<p>Edited why</p>';
			s.pages[0].title = 'Edited page title';
			s.pages[0].bodyHtml = '<p>Edited page</p>';
			s.products[0].pricePaise = 12300;
		});
		const cat = await vite.ssrLoadModule(SNAPSHOT_CATALOG_ID);
		const rb = await vite.ssrLoadModule(SNAPSHOT_RECIPE_BODIES_ID);
		const pb = await vite.ssrLoadModule(SNAPSHOT_PAGE_BODIES_ID);
		expect(cat.recipes[0].title).toBe('Edited title');
		expect(cat.pages[0].title).toBe('Edited page title');
		expect(cat.products[0].pricePaise).toBe(12300);
		expect(rb.recipeBodies[cat.recipes[0].slug].whyHtml).toBe('<p>Edited why</p>');
		expect(pb.pageBodies[cat.pages[0].slug].bodyHtml).toBe('<p>Edited page</p>');
		const client = async (id) => (await vite.environments.client.transformRequest(id)).code;
		expect(await client(SNAPSHOT_CATALOG_ID)).toContain('Edited title');
		expect(await client(SNAPSHOT_RECIPE_BODIES_ID)).toContain('Edited why');
		expect(await client(SNAPSHOT_PAGE_BODIES_ID)).toContain('Edited page');
	});

	it('a change to another file keeps the modules cached', async () => {
		const before = await vite.environments.client.transformRequest(SNAPSHOT_CATALOG_ID);
		const other = path.join(dir, 'other.json');
		fs.writeFileSync(other, '{}');
		vite.watcher.emit('change', other);
		expect(await vite.environments.client.transformRequest(SNAPSHOT_CATALOG_ID)).toBe(before);
	});

	it('a broken file fails loudly (naming the file), and recovers once fixed', async () => {
		const good = fs.readFileSync(file, 'utf8');
		fs.writeFileSync(file, '{ not json');
		vite.watcher.emit('change', file);
		await expect(vite.ssrLoadModule(SNAPSHOT_RECIPE_BODIES_ID)).rejects.toThrow(/virtual:cms-snapshot\/recipe-bodies: cannot split .*cms-snapshot\.json: .*JSON/);
		const dup = JSON.parse(good);
		dup.recipes.push(dup.recipes[0]);
		fs.writeFileSync(file, JSON.stringify(dup));
		vite.watcher.emit('change', file);
		await expect(vite.ssrLoadModule(SNAPSHOT_CATALOG_ID)).rejects.toThrow(/recipes\[12\]\.slug ".*" is a duplicate/);
		fs.writeFileSync(file, good);
		vite.watcher.emit('change', file);
		const cat = await vite.ssrLoadModule(SNAPSHOT_CATALOG_ID);
		expect(cat.recipes).toHaveLength(JSON.parse(good).recipes.length);
	});

	it('read(file) supplies the JSON text (a test serving an edited snapshot), and load watches the file', () => {
		const custom = snapWithPage();
		custom.recipes[0].title = 'Canary recipe title';
		const reads = [];
		const plugin = snapshotSplit({ file, read: (f) => (reads.push(f), JSON.stringify(custom)) });
		const watched = [];
		const ctx = { addWatchFile: (f) => watched.push(f), error: (m) => { throw new Error(m); } };
		const code = plugin.load.call(ctx, '\0' + SNAPSHOT_CATALOG_ID);
		expect(code).toBe(snapshotModules(custom, file)[SNAPSHOT_CATALOG_ID]);
		expect(code).toContain('Canary recipe title');
		expect(reads).toEqual([file]);
		expect(watched).toEqual([file]);
	});

	it('load reports read and parse failures through this.error', () => {
		const errors = [];
		const ctx = { addWatchFile() {}, error: (m) => { errors.push(m); throw new Error(m); } };
		const failing = snapshotSplit({ file, read: () => { throw new Error('EACCES'); } });
		expect(() => failing.load.call(ctx, '\0' + SNAPSHOT_PAGE_BODIES_ID)).toThrow(/virtual:cms-snapshot\/page-bodies: cannot split .*cms-snapshot\.json: EACCES$/);
		const invalid = snapshotSplit({ file, read: () => '{"recipes": {}, "pages": []}' });
		expect(() => invalid.load.call(ctx, '\0' + SNAPSHOT_CATALOG_ID)).toThrow(/cannot split .*: recipes must be an array$/);
		expect(errors).toHaveLength(2);
	});

	it('leaves other ids alone', () => {
		const plugin = snapshotSplit({ file });
		const ctx = { addWatchFile() {}, error() {} };
		expect(plugin.resolveId('virtual:cms-snapshot/other')).toBeUndefined();
		expect(plugin.resolveId('virtual:cms-snapshot/bodies')).toBeUndefined();
		expect(plugin.resolveId('./cms-snapshot.json')).toBeUndefined();
		for (const id of IDS) expect(plugin.resolveId(id)).toBe('\0' + id);
		expect(plugin.load.call(ctx, SNAPSHOT_CATALOG_ID)).toBeUndefined(); // unresolved form
		expect(plugin.load.call(ctx, '\0virtual:cms-snapshot/other')).toBeUndefined();
		expect(plugin.load.call(ctx, file)).toBeUndefined();
	});
});

describe('Vite dev server, snapshot reached through a symlink', { timeout: 60000 }, () => {
	let vite;
	let dir;
	let file;
	let link;

	beforeAll(async () => {
		({ dir, file } = tmpSnapshot());
		link = dir + '-link';
		fs.symlinkSync(dir, link, 'dir');
		vite = await createServer({
			configFile: false,
			root: dir,
			logLevel: 'silent',
			appType: 'custom',
			server: { middlewareMode: true, hmr: false, ws: false },
			plugins: [snapshotSplit({ file: path.join(link, 'cms-snapshot.json') })]
		});
	});

	afterAll(async () => {
		await vite?.close();
		fs.rmSync(link, { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('shares the JSON module Vite resolves (real path) and refreshes on a change under either path', async () => {
		const json = await vite.ssrLoadModule(file);
		expect((await vite.ssrLoadModule(SNAPSHOT_CATALOG_ID)).products).toBe(json.products);
		for (const [changed, title] of [
			[file, 'Seen via the real path'],
			[path.join(link, 'cms-snapshot.json'), 'Seen via the link']
		]) {
			const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
			snap.recipes[0].title = title;
			fs.writeFileSync(file, JSON.stringify(snap));
			vite.watcher.emit('change', changed);
			expect((await vite.ssrLoadModule(SNAPSHOT_CATALOG_ID)).recipes[0].title).toBe(title);
		}
	});
});

describe('production build (what each page actually downloads)', { timeout: 120000 }, () => {
	let dir;
	let file;
	let closure;
	const snap = snapWithPage();
	const M = {
		product: marker(snap.products[0].description),
		recipeCard: marker(snap.recipes[0].description),
		recipeBody: marker(snap.recipes[0].directionsHtml),
		recipeIntro: marker(snap.recipes[1].intro),
		pageBody: marker(EXTRA_PAGE.bodyHtml)
	};

	beforeAll(async () => {
		({ dir, file } = tmpSnapshot());
		const entries = {
			// Every page: the catalog, plus a direct JSON import like cart.js or AnnouncementBar.
			every: `import { products, recipes, pages, settings, version } from 'virtual:cms-snapshot/catalog';
				import { products as rawProducts, settings as rawSettings } from './cms-snapshot.json';
				globalThis.out = [products.map((p) => p.description), recipes.map((r) => r.description), pages.map((p) => p.title), settings, rawSettings, version, rawProducts === products];`,
			recipe: `import { recipes } from 'virtual:cms-snapshot/catalog';
				import { recipeBodies } from 'virtual:cms-snapshot/recipe-bodies';
				globalThis.out = recipes.map((r) => ({ ...r, ...recipeBodies[r.slug] }));`,
			policy: `import { pages } from 'virtual:cms-snapshot/catalog';
				import { pageBodies } from 'virtual:cms-snapshot/page-bodies';
				globalThis.out = pages.map((p) => ({ ...p, ...pageBodies[p.slug] }));`
		};
		const input = {};
		for (const [name, code] of Object.entries(entries)) {
			input[name] = path.join(dir, name + '.js');
			fs.writeFileSync(input[name], code);
		}
		const out = await build({
			configFile: false,
			root: dir,
			logLevel: 'silent',
			plugins: [snapshotSplit({ file })],
			build: { write: false, minify: false, modulePreload: false, rollupOptions: { input } }
		});
		const chunks = new Map(out.output.filter((o) => o.type === 'chunk').map((c) => [c.fileName, c]));
		closure = (name) => {
			const entry = [...chunks.values()].find((c) => c.isEntry && c.name === name);
			const seen = new Set();
			const walk = (c) => {
				if (seen.has(c.fileName)) return;
				seen.add(c.fileName);
				c.imports.forEach((f) => walk(chunks.get(f)));
			};
			walk(entry);
			return [...seen].map((f) => chunks.get(f).code).join('\n');
		};
	});

	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	const count = (code, needle) => code.split(needle).length - 1;

	it('a page using the catalog (and the raw JSON products) gets no recipe or page body, and one copy of the products', () => {
		const code = closure('every');
		expect(count(code, M.product)).toBe(1);
		expect(count(code, M.recipeCard)).toBe(1);
		expect(count(code, M.recipeBody)).toBe(0);
		expect(count(code, M.recipeIntro)).toBe(0);
		expect(count(code, M.pageBody)).toBe(0);
		for (const f of [...RECIPE_BODY_FIELDS, ...PAGE_BODY_FIELDS]) expect(code).not.toMatch(new RegExp(`["']?\\b${f}\\b["']?\\s*:`));
	});

	it('a recipe page gets the recipe bodies but no policy page', () => {
		const code = closure('recipe');
		expect(count(code, M.recipeBody)).toBe(1);
		expect(count(code, M.recipeIntro)).toBe(1);
		expect(count(code, M.pageBody)).toBe(0);
	});

	it('a policy page gets its body but no recipe body', () => {
		const code = closure('policy');
		expect(count(code, M.pageBody)).toBe(1);
		expect(count(code, M.recipeBody)).toBe(0);
		expect(count(code, M.recipeIntro)).toBe(0);
	});
});
