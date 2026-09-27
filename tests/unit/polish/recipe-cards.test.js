/*
 * /recipes (the list) reads its cards from the lean catalog, so it stops
 * downloading every recipe body (~14 KB gz). Checks:
 *   - recipeCards() is exactly what the page used before (recipesContent[slug].card,
 *     in key order), the frozen legacy cards, and the same on the lean catalog;
 *   - the page renders the same cards, byte for byte;
 *   - import rules (extending tests/unit/data/client-bundle.test.js): the list
 *     page never imports recipes-content.js again, and recipes-content.js
 *     stays under src/routes/recipes/[slug]/;
 *   - a real Vite production build of recipe-cards.js carries the cards but
 *     no recipe body (canary in every body field), with a control.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render } from 'svelte/server';
import { build } from 'vite';
import { recipeCards } from '$lib/data/recipe-cards.js';
import { recipesContent } from '$lib/data/recipes-content.js';
import { buildRecipeCards, buildRecipesContent, recipeListCard } from '$lib/data/derive.js';
import RecipeListCard from '$lib/components/RecipeListCard.svelte';
import RecipesPage from '../../../src/routes/recipes/+page.svelte';
import { snapshotSplit, splitSnapshot, RECIPE_BODY_FIELDS } from '../../../vite.config.js';
import { ROOT, SNAPSHOT_PATH, snapshotCopy, legacy } from '../data/fixtures.js';

const strip = (html) => html.replace(/<!--[^>]*-->/g, '');

/** Deep equality AND identical key order (JSON text). */
function expectSame(actual, expected) {
	expect(actual).toStrictEqual(expected);
	expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

describe('recipeCards() (src/lib/data/recipe-cards.js)', () => {
	it('is recipesContent[slug].card for every recipe, in recipesContent key order (what /recipes rendered before)', () => {
		expectSame(
			recipeCards(),
			Object.entries(recipesContent).map(([slug, rc]) => ({ slug, card: rc.card }))
		);
	});

	it('matches the frozen pre-CMS cards (tests/fixtures/legacy/recipesContent.json)', () => {
		const L = legacy('recipesContent');
		expectSame(
			recipeCards(),
			Object.entries(L).map(([slug, rc]) => ({ slug, card: rc.card }))
		);
	});

	it('returns fresh objects on every call', () => {
		const a = recipeCards();
		a[0].card.title = 'mutated';
		a.pop();
		const b = recipeCards();
		expect(b).toHaveLength(12);
		expect(b[0].card.title).not.toBe('mutated');
	});

	it('only needs the card fields: the lean catalog (bodies split off) gives the same cards', () => {
		const snap = snapshotCopy();
		const { recipes: lean } = splitSnapshot(snap);
		for (const r of lean) for (const f of RECIPE_BODY_FIELDS) expect(r).not.toHaveProperty(f);
		expectSame(buildRecipeCards({ recipes: lean }), buildRecipeCards(snap));
	});

	it('recipeListCard() is the card buildRecipesContent() puts on each recipe', () => {
		const snap = snapshotCopy();
		const content = buildRecipesContent(snap);
		for (const r of snap.recipes) expectSame(recipeListCard(r), content[r.slug].card);
	});

	it('follows CMS edits: title, category, times and serves re-derive', () => {
		const snap = snapshotCopy();
		const r = { ...snap.recipes[2], title: 'Crunch Bars', category: 'Snacks', prepTime: '5 min', cookTime: '0 min', serves: 6 };
		const card = recipeListCard(r);
		expect(card).toMatchObject({
			category: 'Snacks',
			catLabel: 'Snacks',
			title: 'Crunch Bars',
			serves: 'Serves 6',
			prepLine: 'Prep 5 min · Cook 0 min',
			coverAria: 'Open recipe: Crunch Bars'
		});
		expect(Object.keys(card)).toEqual(['category', 'catLabel', 'title', 'image', 'cardAlt', 'iconColor', 'iconSrc', 'iconAlt', 'serves', 'prepLine', 'coverAria']);
	});

	it('an empty recipe list gives an empty grid', () => {
		expect(buildRecipeCards({ recipes: [] })).toEqual([]);
	});
});

describe('/recipes page markup', () => {
	it('renders exactly the cards it rendered from recipesContent, in order', () => {
		const page = strip(render(RecipesPage).body);
		const cards = Object.entries(recipesContent)
			.map(([slug, rc]) => strip(render(RecipeListCard, { props: { slug, card: rc.card } }).body))
			.join('');
		expect(page).toContain(`<div class="grid-6 _2" id="wf-recipe-grid">${cards}</div>`);
		expect(page.match(/class="wf-reveal wf-recipe-item"/g)).toHaveLength(12);
	});
});

/* ------------------------------------------- import rules (source scan) */

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const importsOf = (text) => [...text.matchAll(/\b(?:import|export)\s+([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => (m.length > 2 ? { clause: m[1].trim(), from: m[2] } : { clause: null, from: m[1] }));

function sourceFiles(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return sourceFiles(full);
		return /\.(js|ts|svelte)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
	});
}

describe('import rules for the recipe bodies', () => {
	it('src/routes/recipes/+page.svelte (the list) takes its cards from recipe-cards.js, never recipes-content.js', () => {
		const imports = importsOf(read('src/routes/recipes/+page.svelte'));
		expect(imports.map((i) => i.from)).toContain('$lib/data/recipe-cards.js');
		expect(imports.filter((i) => /recipes-content|recipe-bodies|cms-snapshot/.test(i.from))).toEqual([]);
	});

	it('recipes-content.js (it merges every body) is imported only by the recipe page route (src/routes/recipes/[slug]/)', () => {
		const importers = sourceFiles(path.join(ROOT, 'src'))
			.filter((f) => importsOf(fs.readFileSync(f, 'utf8')).some((i) => /(^|\/)recipes-content(\.js)?$/.test(i.from)))
			.map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
			.sort();
		expect(importers.length).toBeGreaterThan(0);
		for (const f of importers) expect(f, `${f} imports recipes-content.js`).toMatch(/^src\/routes\/recipes\/\[slug\]\//);
	});

	it('recipe-cards.js reads only `recipes` from the lean catalog', () => {
		const imports = importsOf(read('src/lib/data/recipe-cards.js'));
		expect(imports).toEqual([
			{ clause: '{ recipes }', from: 'virtual:cms-snapshot/catalog' },
			{ clause: '{ buildRecipeCards }', from: './derive.js' }
		]);
	});
});

/* ------------------------------------------- production bundle (canaries) */

const RECIPE_CANARY = 'WF-POLISH-RECIPE-BODY-8d1b';

/** The committed snapshot with a tagged canary in every body field of every recipe. */
function canarySnapshot() {
	const snapshot = snapshotCopy();
	const tags = [];
	for (const r of snapshot.recipes) {
		for (const field of RECIPE_BODY_FIELDS) {
			const tag = `${RECIPE_CANARY}:${r.slug}:${field}`;
			if (typeof r[field] === 'string') r[field] += ` ${tag}`;
			else if (Array.isArray(r[field]) && r[field].length) r[field][0] = { ...r[field][0], reason: `${r[field][0].reason} ${tag}` };
			else continue;
			tags.push(tag);
		}
	}
	return { snapshot, tags };
}

let tmp;
beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-polish-bundle-'));
});
afterAll(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Vite production build (lib mode, not minified) of one entry against the canary snapshot, as vite.config.js serves it. */
async function bundle(name, source) {
	const { snapshot } = canarySnapshot();
	const entry = path.join(tmp, `${name}.js`);
	fs.writeFileSync(entry, source);
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
		build: { write: false, minify: false, lib: { entry: { [name]: entry }, formats: ['es'] } }
	});
	return [out]
		.flat()
		.flatMap((o) => o.output)
		.map((c) => c.code ?? String(c.source ?? ''))
		.join('\n');
}

const abs = (file) => JSON.stringify(path.join(ROOT, 'src/lib/data', file));

describe('client bundle of recipe-cards.js (vite build)', () => {
	it('carries every card and no recipe body', async () => {
		const { snapshot } = canarySnapshot();
		const code = await bundle('cards', `export { recipeCards } from ${abs('recipe-cards.js')};`);
		expect(code).toContain('buildRecipeCards'); // really bundled
		for (const r of snapshot.recipes) {
			expect(code).toContain(JSON.stringify(r.slug));
			expect(code).toContain(JSON.stringify(r.cardAlt));
		}
		expect(code).not.toContain(RECIPE_CANARY);
	}, 30000);

	it('control: recipes-content.js carries every body (so the check above can see a leak)', async () => {
		const { tags } = canarySnapshot();
		const code = await bundle('content', `export { recipesContent } from ${abs('recipes-content.js')};`);
		for (const tag of tags) expect(code).toContain(tag);
	}, 30000);
});
