/*
 * The e2e specs must agree with the add-to-cart `source` each page really
 * emits (W2V-3: e2e/ui/toast.spec.js kept expecting 'card' for a recipe's
 * "Shop the Ingredients" cards after they became 'recipe-ingredients').
 *
 * Static and cheap, so it runs with the unit suite rather than waiting for a
 * full Playwright run:
 * - `sourcesOf(route)` walks a route file and the components it imports
 *   (static and `import()`), collecting the literal sources it can emit:
 *   `<AddToCart source="…">` (no attribute → AddToCart's default),
 *   `<MiniProductCard source="…">` (no attribute → the `setMiniCardSource`
 *   context set on the way down, else the card's own fallback), and
 *   `source: '…'` in component scripts (TopUp, YourUsual). The layout's own
 *   walk (CartToast → TopUp) counts on every page.
 * - Every `test(…)` in e2e/ui/*.spec.js that visits a page with mini product
 *   cards (PDP, recipe page, 404) may only expect sources that the pages it
 *   names can emit. The pages are every quoted '/path' literal in the test
 *   (goto, open, a client-side a.href, even a comment), so a test that
 *   reaches a page only by clicking can name it in a comment. A test whose
 *   navigation isn't a literal is skipped; `?add=` links allow 'link' and
 *   their `src`; sources a test emits itself via WefeastoCart.add are allowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ROOT } from '../data/fixtures.js';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const snapshot = JSON.parse(read('src/lib/data/cms-snapshot.json'));
const productSlugs = new Set(snapshot.products.map((p) => p.slug));
const recipeSlugs = new Set(snapshot.recipes.map((r) => r.slug));

/** cart.js cleanSource(): anything else is sent as null. */
const SOURCE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** AddToCart's `source` default and MiniProductCard's last-resort fallback, read from the components. */
const ADD_DEFAULT = /let\s*\{[^}]*\bsource\s*=\s*'([^']+)'/.exec(read('src/lib/components/AddToCart.svelte'))?.[1];
const MINI_DEFAULT = /\bsource\s*\?\?\s*inherited\s*\?\?\s*'([^']+)'/.exec(read('src/lib/components/MiniProductCard.svelte'))?.[1];

/** `<Tag …>` openings of a component, attributes included (braces and quotes may hold '>'). */
function tags(text, name) {
	const out = [];
	for (const m of text.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
		let depth = 0;
		let quote = '';
		let i = m.index + m[0].length;
		for (; i < text.length; i++) {
			const c = text[i];
			if (quote) quote = c === quote ? '' : quote;
			else if (c === '"' || c === "'") quote = c;
			else if (c === '{') depth++;
			else if (c === '}') depth--;
			else if (c === '>' && depth === 0) break;
		}
		out.push(text.slice(m.index, i + 1));
	}
	return out;
}

/** 'literal' | 'dynamic' | 'none' for a tag's `source` attribute. */
function sourceAttr(tag) {
	const lit = /\bsource="([^"{}]*)"/.exec(tag);
	if (lit) return { kind: 'literal', value: lit[1] };
	if (/\bsource=\{|\{source\}|\{\.\.\./.test(tag)) return { kind: 'dynamic' };
	return { kind: 'none' };
}

const IMPORTS = [
	/import\s+\w+\s+from\s+'(\$lib\/components\/[\w-]+\.svelte|\.{1,2}\/[\w./-]+\.svelte)'/g,
	/import\(\s*'(\$lib\/components\/[\w-]+\.svelte|\.{1,2}\/[\w./-]+\.svelte)'\s*\)/g
];

/**
 * Literal add-to-cart sources a route (or the layout) and everything it
 * imports can emit, plus whether it renders MiniProductCards.
 */
function sourcesOf(root) {
	const seen = new Set();
	const queue = [root];
	const sources = new Set();
	const ctx = new Set();
	let bareMini = false;
	let hasMini = false;
	while (queue.length) {
		const file = queue.shift();
		if (seen.has(file)) continue;
		seen.add(file);
		const text = read(file);
		for (const re of IMPORTS) {
			for (const [, spec] of text.matchAll(re)) {
				queue.push(spec.startsWith('$lib/') ? 'src/lib/' + spec.slice(5) : path.posix.join(path.posix.dirname(file), spec));
			}
		}
		for (const tag of tags(text, 'AddToCart')) {
			const a = sourceAttr(tag);
			if (a.kind === 'literal') sources.add(a.value);
			else if (a.kind === 'none') sources.add(ADD_DEFAULT);
		}
		for (const tag of tags(text, 'MiniProductCard')) {
			hasMini = true;
			const a = sourceAttr(tag);
			if (a.kind === 'literal') sources.add(a.value);
			else if (a.kind === 'none') bareMini = true;
		}
		for (const [, s] of text.matchAll(/setMiniCardSource\(\s*'([^']*)'\s*\)/g)) ctx.add(s);
		for (const [, s] of text.matchAll(/\bsource:\s*'([^']*)'/g)) sources.add(s);
	}
	if (bareMini) for (const s of ctx.size ? ctx : [MINI_DEFAULT]) sources.add(s);
	return { sources, hasMini };
}

const LAYOUT = 'src/routes/+layout.svelte';
const NOT_FOUND = ['src/routes/404/+page.svelte', 'src/routes/+error.svelte'];

/** The page file(s) a storefront URL renders; an unknown product/recipe/path is the 404 page. */
function routeFiles(url) {
	const p = new URL(url, 'http://x').pathname.replace(/\/+$/, '') || '/';
	if (p === '/') return ['src/routes/+page.svelte'];
	const seg = p.slice(1).split('/');
	if (seg.length === 2 && seg[0] === 'products') return productSlugs.has(seg[1]) ? ['src/routes/products/[slug]/+page.svelte'] : NOT_FOUND;
	if (seg.length === 2 && seg[0] === 'recipes') return recipeSlugs.has(seg[1]) ? ['src/routes/recipes/[slug]/+page.svelte'] : NOT_FOUND;
	const file = `src/routes/${seg.join('/')}/+page.svelte`;
	if (!seg.some((s) => s.startsWith('[')) && exists(file)) return [file];
	// maybe a published policy page (src/params/policy.js reads a virtual module), maybe a 404
	if (seg.length === 1 && exists('src/routes/[policy=policy]/+page.svelte')) return ['src/routes/[policy=policy]/+page.svelte', ...NOT_FOUND];
	return NOT_FOUND;
}

/** Sorted sources a URL's page can emit, without the layout's. */
const pageSources = (url) => [...new Set(routeFiles(url).flatMap((f) => [...sourcesOf(f).sources]))].sort();

/** Text of the call argument list opening at `i` (just past the '('). */
function argsAt(text, i) {
	let depth = 1;
	let quote = '';
	for (let j = i; j < text.length; j++) {
		const c = text[j];
		if (quote) {
			if (c === '\\') j++;
			else if (c === quote) quote = '';
		} else if (c === "'" || c === '"' || c === '`') quote = c;
		else if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') {
			if (--depth === 0) return text.slice(i, j);
		}
	}
	return text.slice(i);
}

/** Add sources a test expects: `source: '…'`, `….source).toBe('…')`, `.map((d) => d.source|[…, d.source, …])).toEqual(…)`. */
function expectedSources(text) {
	const out = [];
	for (const [, s] of text.matchAll(/\bsource:\s*'([^']*)'/g)) out.push(s);
	for (const [, s] of text.matchAll(/\.source\)+\s*\.toBe\(\s*'([^']*)'\s*\)/g)) out.push(s);
	for (const m of text.matchAll(/\.map\(\(\s*(\w+)\s*\)\s*=>\s*(\[[^\]]*\]|\w+\.source)\s*\)\s*\)\s*\.toEqual\(/g)) {
		const [whole, v, expr] = m;
		const arg = argsAt(text, m.index + whole.length);
		if (expr === `${v}.source`) {
			for (const [, s] of arg.matchAll(/'([^']*)'/g)) out.push(s);
			continue;
		}
		const at = expr.slice(1, -1).split(',').map((s) => s.trim()).indexOf(`${v}.source`);
		if (at < 0) continue;
		for (const [, row] of arg.matchAll(/\[([^[\]]*)\]/g)) {
			const lit = /^'([^']*)'$/.exec(row.split(',')[at]?.trim() ?? '');
			if (lit) out.push(lit[1]);
		}
	}
	return out;
}

/** Every `test('title', …)` call in a spec, up to the next one. */
function testChunks(src) {
	const starts = [...src.matchAll(/(?<![.\w])test(?:\.only|\.skip|\.fixme)?\(\s*[`'"]/g)].map((m) => m.index);
	return starts.map((s, i) => {
		const text = src.slice(s, starts[i + 1] ?? src.length);
		return { title: /^[\w.]+\(\s*([`'"])([\s\S]*?)\1/.exec(text)[2], text };
	});
}

/** A navigation whose URL isn't a plain literal (a variable, or a template with ${…}). */
function hasOpaqueNavigation(text) {
	for (const m of text.matchAll(/(?:\.goto\(|\bopen\(\s*page\s*,)\s*/g)) {
		const rest = text.slice(m.index + m[0].length);
		if (rest[0] === "'" || rest[0] === '"') continue;
		if (rest[0] === '`' && !/^`[^`]*\$\{/.test(rest)) continue;
		return true;
	}
	return false;
}

const layoutSources = sourcesOf(LAYOUT).sources;

/**
 * Violations in one test: expected sources none of its pages can emit. `null`
 * when the test isn't checked (no mini-card page, or opaque navigation).
 */
function checkChunk(text) {
	if (hasOpaqueNavigation(text)) return null;
	const urls = [...text.matchAll(/(['"`])(\/(?![/*])[^'"`\s$]*)\1/g)]
		.map((m) => m[2])
		.filter((u) => !/^\/(api|_app)\//.test(u) && !/\.\w+$/.test(new URL(u, 'http://x').pathname));
	if (!urls.length) return null;
	const walks = [...new Set(urls.flatMap(routeFiles))].map(sourcesOf);
	if (!walks.some((w) => w.hasMini)) return null;
	const allowed = new Set([...layoutSources, ...walks.flatMap((w) => [...w.sources])]);
	for (const [, s] of text.matchAll(/WefeastoCart\.add(?:Many)?\([^)]*?\bsource:\s*'([^']*)'/g)) allowed.add(s);
	for (const u of urls) {
		const q = new URL(u, 'http://x').searchParams;
		if (q.has('add')) {
			allowed.add('link');
			if (q.get('src')) allowed.add(q.get('src'));
		}
	}
	const bad = expectedSources(text).filter((s) => !allowed.has(s));
	return { urls, allowed: [...allowed].sort(), bad };
}

const SPEC_DIR = 'e2e/ui';
const specs = fs
	.readdirSync(path.join(ROOT, SPEC_DIR))
	.filter((f) => f.endsWith('.spec.js'))
	.map((f) => ({ file: `${SPEC_DIR}/${f}`, src: read(`${SPEC_DIR}/${f}`) }));

describe('add-to-cart sources per page (read from the route and component files)', () => {
	it('the component defaults are found', () => {
		expect(ADD_DEFAULT).toBe('card');
		expect(MINI_DEFAULT).toBe('card');
	});

	it.each([
		['/recipes/wf-muesli-yogurt-parfait', ['recipe', 'recipe-ingredients']],
		['/products/cornflakes', ['goes-with', 'pdp']],
		['/products/not-a-cereal', ['not-found']],
		['/nope', ['not-found']],
		['/shop', ['card', 'usual']]
	])('%s → %j', (url, sources) => {
		expect(pageSources(url)).toEqual(sources);
	});

	it('the layout (CartToast → TopUp) adds topup on every page', () => {
		expect([...layoutSources].sort()).toEqual(['topup']);
	});

	it('mini product cards render on the PDP, the recipe page and both 404s only', () => {
		const pages = ['/', '/shop', '/recipes', '/cart', '/checkout', '/products/muesli', '/recipes/wf-banana-oat-pancakes', '/nope'];
		expect(pages.filter((u) => routeFiles(u).some((f) => sourcesOf(f).hasMini))).toEqual(['/products/muesli', '/recipes/wf-banana-oat-pancakes', '/nope']);
		for (const f of NOT_FOUND) expect(sourcesOf(f)).toEqual({ sources: new Set(['not-found']), hasMini: true });
	});

	it("every literal source a page can emit survives cart.js's cleanSource()", () => {
		const routes = fs
			.readdirSync(path.join(ROOT, 'src/routes'), { recursive: true })
			.filter((f) => String(f).endsWith('.svelte'))
			.map((f) => `src/routes/${String(f).split(path.sep).join('/')}`);
		const all = new Set(routes.flatMap((f) => [...sourcesOf(f).sources]));
		expect(all.size).toBeGreaterThan(5);
		for (const s of all) expect(s, s).toMatch(SOURCE_RE);
	});
});

describe('the lint itself', () => {
	it('reads the three expectation shapes', () => {
		const text = `
			expect(await adds(page)).toEqual([expect.objectContaining({ slug: 'muesli', source: 'pdp' })]);
			expect(await page.evaluate(() => window.__adds[0].source)).toBe('link');
			await expect.poll(async () => (await adds(page)).map((d) => d.source)).toEqual(['goes-with', 'pdp']);
			expect((await adds(page)).map((d) => [d.slug, d.qty, d.source])).toEqual([
				['muesli', 1, 'pdp'],
				['health-mix', 1, 'topup']
			]);`;
		expect(expectedSources(text)).toEqual(['pdp', 'link', 'goes-with', 'pdp', 'pdp', 'topup']);
	});

	it("flags the pre-fix toast.spec expectation (W2V-3): 'card' on a recipe page", () => {
		const stale = `test('recipe rail and "Shop the Ingredients" → toast', async ({ page }) => {
			await page.goto('/recipes/wf-muesli-yogurt-parfait');
			await page.locator('.grid-42 .wf-rail-add').click();
			await page.locator('.section .grid-6 [data-wf-add="muesli"]').click();
			expect((await adds(page)).map((d) => d.source)).toEqual(['recipe', 'card']);
		});`;
		expect(checkChunk(stale)).toMatchObject({ bad: ['card'], allowed: ['recipe', 'recipe-ingredients', 'topup'] });
		expect(checkChunk(stale.replace("'card'", "'recipe-ingredients'")).bad).toEqual([]);
	});

	it("flags 'card' for a PDP's \"Goes well with\" and for a 404's bestsellers", () => {
		const pdp = `test('x', async ({ page }) => { await page.goto('/products/cornflakes?nofx=1'); expect(await adds(page)).toEqual([expect.objectContaining({ source: 'card' })]); });`;
		const lost = `test('x', async ({ page }) => { await open(page, '/nope'); expect((await adds(page)).map((d) => [d.slug, d.source])).toEqual([['muesli', 'card']]); });`;
		expect(checkChunk(pdp).bad).toEqual(['card']);
		expect(checkChunk(lost).bad).toEqual(['card']);
	});

	it('allows what the test emits itself, ?add= links and pages it names; skips opaque navigation and card-less pages', () => {
		const own = `test('x', async ({ page }) => { await page.goto('/nope'); await page.evaluate(() => window.WefeastoCart.add('muesli', 1, { source: 'pdp' })); expect((await adds(page)).map((d) => d.source)).toEqual(['pdp']); });`;
		const link = `test('x', async ({ page }) => { await page.goto('/cart?add=muesli&src=email'); await page.goto('/products/muesli'); expect((await adds(page)).map((d) => d.source)).toEqual(['email', 'link']); });`;
		const named = `test('x', async ({ page }) => { await page.goto('/shop'); /* → '/products/muesli' by clicking */ expect(await adds(page)).toEqual([expect.objectContaining({ source: 'goes-with' })]); });`;
		const opaque = `test('x', async ({ page }) => { await page.goto(\`/products/\${slug}\`); expect(await adds(page)).toEqual([expect.objectContaining({ source: 'nope' })]); });`;
		const shopOnly = `test('x', async ({ page }) => { await page.goto('/shop'); expect(await adds(page)).toEqual([expect.objectContaining({ source: 'nope' })]); });`;
		expect(checkChunk(own).bad).toEqual([]);
		expect(checkChunk(link).bad).toEqual([]);
		expect(checkChunk(named).bad).toEqual([]);
		expect(checkChunk(opaque)).toBeNull();
		expect(checkChunk(shopOnly)).toBeNull();
	});
});

describe('e2e/ui specs expect only sources their pages emit', () => {
	const results = specs.flatMap(({ file, src }) => testChunks(src).map(({ title, text }) => ({ file, title, result: checkChunk(text) })));
	const checked = results.filter((r) => r.result);

	it('checks the specs that cover mini-card sources', () => {
		const titles = checked.map((r) => `${r.file} › ${r.title}`);
		for (const t of [
			'e2e/ui/toast.spec.js › recipe rail "Add Muesli · ₹250" and "Shop the Ingredients" → toast',
			'e2e/ui/polish.spec.js › PDP "Goes well with" → goes-with (the main button stays pdp)',
			'e2e/ui/polish.spec.js › recipe "Shop the Ingredients" → recipe-ingredients (the rail stays recipe)',
			'e2e/ui/polish.spec.js › 404 page bestsellers (server-rendered error page) → not-found',
			'e2e/ui/polish.spec.js › 404 rendered client-side (missing product) → not-found'
		]) {
			expect(titles).toContain(t);
		}
		expect(checked.filter((r) => expectedSources(testChunks(read(r.file)).find((c) => c.title === r.title).text).length).length).toBeGreaterThanOrEqual(7);
	});

	it('no test expects a source its pages cannot emit', () => {
		const bad = checked.filter((r) => r.result.bad.length).map((r) => ({ test: `${r.file} › ${r.title}`, expected: r.result.bad, pagesEmit: r.result.allowed }));
		expect(bad).toEqual([]);
	});
});
