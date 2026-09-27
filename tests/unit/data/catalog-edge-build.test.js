/*
 * Real static builds with FIXTURE snapshots that sync-cms accepts but that
 * used to fail every later deploy (hunt data-cms round 2):
 * - no recipes at all (snapshot-schema.md: `recipes` may be empty — the owner
 *   unpublished them all): the build succeeds, /recipes says so, home has no
 *   empty "Fresh from the Wefeasto Kitchen" shelf and no PDP shows an empty
 *   recipes section;
 * - mistyped image paths (a home-featured product, a recipe image and icon)
 *   and an uploaded image (/api/media/file/…, served by the CMS at runtime):
 *   the build succeeds, the typos are named in the build log as CMS content,
 *   the upload gets no "fix the link in the CMS" warning.
 * Sites are copied to temp dirs (never built in the working tree); the two
 * builds run in parallel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateSnapshot, serializeSnapshot } from '$lib/data/snapshot-schema.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const TYPO = '/images/wefeasto/product-muesli-typo.jpg';
const RECIPE_TYPO = '/images/typo-recipe.jpg';
const UPLOAD = '/api/media/file/hunt-upload.png';

const dirs = [];
let empty; // { dir, ok, out }
let images;
const page = (b, rel) => fs.readFileSync(path.join(b.dir, 'build', rel), 'utf8').replace(/<!--[^>]*-->/g, '');

function site(tag, edit) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wf-catalog-edge-${tag}-`));
	dirs.push(dir);
	for (const f of ['package.json', 'svelte.config.js', 'vite.config.js', 'jsconfig.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
	fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
	fs.cpSync(path.join(ROOT, 'cms/src/commerce/shared'), path.join(dir, 'cms/src/commerce/shared'), { recursive: true });
	fs.symlinkSync(path.join(ROOT, 'static'), path.join(dir, 'static'), 'dir');
	fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
	const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/data/cms-snapshot.json'), 'utf8'));
	edit(s);
	expect(validateSnapshot(s).errors).toEqual([]);
	fs.writeFileSync(path.join(dir, 'src/lib/data/cms-snapshot.json'), serializeSnapshot(s));
	return dir;
}

function viteBuild(dir) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'],
			{ cwd: dir, timeout: 280_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'production' } },
			(err, stdout, stderr) => resolve({ dir, ok: !err, out: `${stdout}\n${stderr}\n${err?.message ?? ''}` })
		);
	});
}

beforeAll(async () => {
	const a = site('empty', (s) => {
		s.recipes = [];
	});
	const b = site('images', (s) => {
		const muesli = s.products.find((p) => p.slug === 'muesli');
		expect(muesli.homeFeatured).toBe(true); // rendered on / as well as /shop and its PDP
		muesli.image = TYPO;
		s.products.find((p) => p.slug === 'cornflakes').image = UPLOAD;
		const home = s.recipes.find((r) => r.homeFeatured);
		home.image = RECIPE_TYPO;
		home.iconSrc = '/images/typo-icon.svg';
	});
	[empty, images] = await Promise.all([viteBuild(a), viteBuild(b)]);
}, 300_000);

afterAll(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('no recipes in the snapshot', () => {
	it('the build succeeds and emits no recipe page', () => {
		expect(empty.ok, empty.out.slice(-3000)).toBe(true);
		const recipesDir = path.join(empty.dir, 'build/recipes');
		const recipePages = fs.existsSync(recipesDir) ? fs.readdirSync(recipesDir, { recursive: true }).map(String).filter((f) => f.endsWith('.html')) : [];
		expect(recipePages).toEqual([]); // (build/recipes/__data.json is the /recipes list's own data)
		expect(fs.existsSync(path.join(empty.dir, 'build/recipes.html'))).toBe(true);
	});

	it('/recipes says there are none (no count, no filter chips) and links the shop', () => {
		const html = page(empty, 'recipes.html');
		expect(html).toContain('data-wf-recipes-empty');
		expect(html).not.toMatch(/kitchen-tested way/);
		expect(html).not.toContain('data-wf-filter=');
		expect(html).toMatch(/<a href="\/shop" class="button w-inline-block"><div>Shop the Range<\/div><\/a>/);
	});

	it('home drops the empty kitchen shelf; PDPs drop the empty recipes section', () => {
		expect(page(empty, 'index.html')).not.toContain('Fresh from the Wefeasto Kitchen');
		const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/data/cms-snapshot.json'), 'utf8'));
		const muesli = s.products.find((p) => p.slug === 'muesli');
		expect(page(empty, 'products/muesli.html')).not.toContain(`<h2>${muesli.recipesHeading}</h2>`);
	});
});

describe('mistyped image paths and an uploaded image', () => {
	it('the build succeeds', () => {
		expect(images.ok, images.out.slice(-3000)).toBe(true);
	});

	it('the typos are warned about as CMS content; the upload is not', () => {
		for (const p of [TYPO, RECIPE_TYPO, '/images/typo-icon.svg']) expect(images.out).toMatch(new RegExp(`\\[prerender\\] 404 ${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^\\n]*\\n {2}\\(linked from CMS content`));
		// (SvelteKit itself lists every crawled 404, "[404] GET …"; our CMS warning must not add one for the upload)
		expect(images.out).not.toMatch(/\[prerender\] 404 \/api\//);
	});

	it('the pages render what the CMS says (the broken image is only a broken image)', () => {
		expect(page(images, 'index.html')).toContain(`src="${TYPO}"`);
		expect(page(images, 'index.html')).toContain(`src="${RECIPE_TYPO}"`);
		expect(page(images, 'shop.html')).toContain(`src="${UPLOAD}"`);
	});
});
