/*
 * A real static build with a FIXTURE snapshot that links pages the build
 * doesn't produce (hunt data-cms unpublish-breaks-build):
 * - steel-cut-oats dropped from the snapshot the way the CMS drops an
 *   unpublished product (structured references gone, the links inside the
 *   recipe bodies still there);
 * - a published page whose body links a typo (/shopp), a missing file and
 *   an #anchor it lacks;
 * - the announcement bar linking the dropped product.
 * The build succeeds; dead page links render as plain text (their words
 * stay), live ones stay links, and the build log names what was unlinked.
 * The site is copied to a temp dir (never built in the working tree).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateSnapshot, serializeSnapshot } from '$lib/data/snapshot-schema.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const GONE = 'steel-cut-oats';
const PAGE = 'hunt-help';

let dir;
let result;
const page = (rel) => fs.readFileSync(path.join(dir, 'build', rel), 'utf8').replace(/<!--[^>]*-->/g, '');

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dead-links-build-'));
	for (const f of ['package.json', 'svelte.config.js', 'vite.config.js', 'jsconfig.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
	fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
	fs.cpSync(path.join(ROOT, 'cms/src/commerce/shared'), path.join(dir, 'cms/src/commerce/shared'), { recursive: true });
	fs.symlinkSync(path.join(ROOT, 'static'), path.join(dir, 'static'), 'dir');
	fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

	const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/data/cms-snapshot.json'), 'utf8'));
	// What the CMS snapshot does for an unpublished product (cms-catalog.md §3).
	s.products = s.products.filter((p) => p.slug !== GONE);
	for (const p of s.products) p.goesWith = p.goesWith.filter((x) => x !== GONE);
	for (const r of s.recipes) r.products = r.products.filter((x) => x.slug !== GONE);
	s.pages = [
		{
			slug: PAGE,
			title: 'Help',
			bodyHtml: '<p>Browse our <a href="/shopp">shop</a>, the <a href="/products/muesli">muesli</a>, <a href="/images/no-such-menu.pdf">the menu</a> and <a href="/shop#no-such-id">the filters</a>.</p>',
			published: true
		}
	];
	s.settings.announcement = { enabled: true, text: 'Steel-cut oats are back', href: `/products/${GONE}` };
	expect(validateSnapshot(s).errors).toEqual([]);
	fs.writeFileSync(path.join(dir, 'src/lib/data/cms-snapshot.json'), serializeSnapshot(s));

	result = await new Promise((resolve) => {
		execFile(
			process.execPath,
			[path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'],
			{ cwd: dir, timeout: 280_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'production' } },
			(err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}\n${stderr}\n${err?.message ?? ''}` })
		);
	});
}, 300_000);

afterAll(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a snapshot whose CMS content links pages the build does not produce', () => {
	it('still builds', () => {
		expect(result.ok, result.out.split('\n').filter((l) => /error|404|fail/i.test(l)).slice(-8).join('\n')).toBe(true);
		expect(fs.existsSync(path.join(dir, 'build', `products/${GONE}.html`))).toBe(false);
	});

	it('recipe bodies: the dropped product is plain text, every other product link stays', () => {
		const html = page('recipes/wf-berry-overnight-steel-cut-oats.html');
		expect(html).not.toContain(`href="/products/${GONE}"`);
		expect(html).toContain('Wefeasto Steel-Cut Oats');
		const other = fs
			.readdirSync(path.join(dir, 'build/recipes'))
			.filter((f) => f.endsWith('.html'))
			.map((f) => page(`recipes/${f}`))
			.join('\n');
		expect(other).toContain('href="/products/muesli"');
		expect(other).not.toContain(`href="/products/${GONE}"`);
	});

	it('page body: the typo is plain text; live pages, files and #anchors keep their links', () => {
		const html = page(`${PAGE}.html`);
		expect(html).toContain('Browse our shop,');
		expect(html).not.toContain('href="/shopp"');
		expect(html).toContain('href="/products/muesli"');
		expect(html).toContain('href="/images/no-such-menu.pdf"'); // a file: the backstop warns, the host decides
		expect(html).toContain('href="/shop#no-such-id"');
	});

	it('the announcement bar shows its text without the dead link', () => {
		const html = page('index.html');
		expect(html).toContain('Steel-cut oats are back');
		expect(html).not.toContain(`href="/products/${GONE}"`);
	});

	it('the build log names what was unlinked and what the backstop let through', () => {
		expect(result.out).toMatch(/\[cms content\] \/recipes\/wf-berry-overnight-steel-cut-oats: unlinked \/products\/steel-cut-oats/);
		expect(result.out).toMatch(/\[cms content\] \/hunt-help: unlinked \/shopp/);
		expect(result.out).toMatch(/\[prerender\] 404 \/images\/no-such-menu\.pdf/);
		expect(result.out).toMatch(/\[prerender\] .*no-such-id/);
	});
});
