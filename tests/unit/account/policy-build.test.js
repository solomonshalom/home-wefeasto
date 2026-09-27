/*
 * Real static builds with FIXTURE snapshots (never a real draft): prove the
 * prerender rules end to end.
 * - one published page: it is built (build/<slug>.html) with its body, in
 *   the /terms idiom, and linked from every page's footer after Privacy;
 *   unpublished pages are not built at all (the host answers 404); the legal
 *   line carries the entity name and FSSAI licence when set; the page body
 *   never reaches a JS chunk;
 * - zero published pages (today's snapshot): the build still succeeds and
 *   emits no policy page at all — kit.prerender.handleUnseenRoutes in
 *   svelte.config.js lets exactly /[policy=policy] go unseen;
 * - any OTHER prerenderable route that builds no page still fails the build;
 * - the old /policies hub is never emitted.
 * Each site is copied to a temp dir (never builds in the working tree, where
 * other builds may be running) with the fixture as its cms-snapshot.json;
 * the three builds run in parallel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateSnapshot, serializeSnapshot } from '$lib/data/snapshot-schema.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CANARY = 'fixture-canary-9c41 parcels leave our kitchen';
const FSSAI = '10020042007183';
const ENTITY = 'Fixture Foods Pvt Ltd';

const dirs = [];
let build; // one published page
let emptyBuild; // zero published pages
let unseenFailure; // zero published pages + an extra prerendered route with no entries
const read = (rel, b = build) => fs.readFileSync(path.join(b, rel), 'utf8');
/** Page HTML without Svelte's hydration markers. */
const page = (rel, b = build) => read(rel, b).replace(/<!--[^>]*-->/g, '');
const exists = (rel, b = build) => fs.existsSync(path.join(b, rel));

function filesUnder(d) {
	return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(d, e.name);
		return e.isDirectory() ? filesUnder(full) : [full];
	});
}

/** Copy the site to a temp dir with `pages` (and legal fields) in its snapshot; `extra(dir)` may add files. */
function site({ pages, legal = {}, extra = () => {} }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-policy-build-'));
	dirs.push(dir);
	for (const f of ['package.json', 'svelte.config.js', 'vite.config.js', 'jsconfig.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
	fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
	fs.cpSync(path.join(ROOT, 'cms/src/commerce/shared'), path.join(dir, 'cms/src/commerce/shared'), { recursive: true });
	fs.symlinkSync(path.join(ROOT, 'static'), path.join(dir, 'static'), 'dir');
	fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
	const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/data/cms-snapshot.json'), 'utf8'));
	snapshot.pages = pages;
	Object.assign(snapshot.settings.legal, legal);
	const check = validateSnapshot(snapshot);
	expect(check.errors).toEqual([]);
	fs.writeFileSync(path.join(dir, 'src/lib/data/cms-snapshot.json'), serializeSnapshot(snapshot));
	extra(dir);
	return dir;
}

/** vite build in `dir` → { ok, out } (never throws). */
function viteBuild(dir) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'],
			{ cwd: dir, timeout: 280_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'production' } },
			(err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}\n${stderr}\n${err?.message ?? ''}` })
		);
	});
}

beforeAll(async () => {
	const one = site({
		pages: [{ slug: 'shipping', title: 'Shipping Policy', bodyHtml: `<h2>Where we deliver</h2><p>${CANARY}.</p>`, published: true }],
		legal: { entityName: ENTITY, fssaiLicence: FSSAI }
	});
	const none = site({ pages: [] });
	const unseen = site({
		pages: [],
		extra: (dir) => {
			const r = path.join(dir, 'src/routes/zz-unseen/[x]');
			fs.mkdirSync(r, { recursive: true });
			fs.writeFileSync(path.join(r, '+page.server.js'), 'export const prerender = true;\nexport const entries = () => [];\nexport const load = ({ params }) => ({ x: params.x });\n');
			fs.writeFileSync(path.join(r, '+page.svelte'), '<script>let { data } = $props();</script><p>{data.x}</p>\n');
		}
	});
	const [a, b, c] = await Promise.all([viteBuild(one), viteBuild(none), viteBuild(unseen)]);
	if (!a.ok) throw new Error('fixture build (one page) failed:\n' + a.out.slice(-4000));
	if (!b.ok) throw new Error('fixture build (no pages) failed:\n' + b.out.slice(-4000));
	build = path.join(one, 'build');
	emptyBuild = path.join(none, 'build');
	unseenFailure = c;
}, 300_000);

afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('static build with one published policy page (fixture snapshot)', () => {
	it('builds the published page, in the legal-page idiom, with its body', () => {
		expect(exists('shipping.html')).toBe(true);
		const htmlText = page('shipping.html');
		expect(htmlText).toContain('<title>Wefeasto — Shipping Policy</title>');
		expect(htmlText).toContain('<h1 class="heading-2">Shipping Policy</h1>');
		expect(htmlText).toContain(`<div class="wf-legal wf-policy-body"><h2>Where we deliver</h2><p>${CANARY}.</p></div>`);
		expect(htmlText).toMatch(/<a href="\/shipping" class="wf-legal-tab wf-is-active" aria-current="page">Shipping Policy<\/a>/);
	});

	it('does not build unpublished pages (the static host answers 404)', () => {
		for (const slug of ['refunds', 'grievances']) {
			expect(exists(`${slug}.html`), slug).toBe(false);
			expect(exists(`${slug}/index.html`), slug).toBe(false);
		}
		expect(exists('404.html')).toBe(true);
	});

	it('the /policies hub is not emitted', () => {
		for (const f of ['policies.html', 'policies/index.html', 'policies/__data.json']) expect(exists(f), f).toBe(false);
	});

	it('every page footer links it after Privacy and shows the legal line', () => {
		for (const file of ['index.html', 'shop.html', 'login.html', 'account.html', 'products/muesli.html', '404.html']) {
			const htmlText = page(file);
			expect(htmlText, file).toContain('<a href="/privacy" class="footer-link">Privacy</a><a href="/shipping" class="footer-link">Shipping Policy</a></div>');
			expect(htmlText, file).toContain(`© 2026 ${ENTITY}. All rights reserved · FSSAI Lic. No. ${FSSAI}</div>`);
		}
	});

	it('the body is never in a JS chunk (only in its own HTML and __data.json)', () => {
		const js = filesUnder(path.join(build, '_app')).filter((f) => f.endsWith('.js'));
		expect(js.length).toBeGreaterThan(10);
		const leaks = js.filter((f) => fs.readFileSync(f, 'utf8').includes(CANARY));
		expect(leaks).toEqual([]);
		expect(read('shipping/__data.json')).toContain(CANARY);
		expect(read('index.html')).not.toContain(CANARY);
	});
});

describe('static build with zero published policy pages (today’s snapshot)', () => {
	it('still builds: the site is there, with no policy page and no hub', () => {
		for (const f of ['index.html', 'shop.html', 'terms.html', 'privacy.html', '404.html', 'products/muesli.html']) expect(exists(f, emptyBuild), f).toBe(true);
		for (const f of ['policies.html', 'shipping.html', 'refunds.html', 'grievances.html']) expect(exists(f, emptyBuild), f).toBe(false);
		// every top-level page is a static route or a static/ file: nothing came from [policy=policy]
		const routes = fs.readdirSync(path.join(ROOT, 'src/routes'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('[')).map((e) => e.name);
		const statics = fs.readdirSync(path.join(ROOT, 'static'));
		const top = fs.readdirSync(emptyBuild).filter((n) => n.endsWith('.html'));
		expect(top.filter((n) => n !== 'index.html' && !routes.includes(n.replace(/\.html$/, '')) && !statics.includes(n))).toEqual([]);
	});

	it('the footer is the plain one: no policy links', () => {
		expect(page('index.html', emptyBuild)).toContain('<a href="/terms" class="footer-link">Terms</a><a href="/privacy" class="footer-link">Privacy</a></div>');
	});

	it('any other prerendered route that builds no page still fails the build', () => {
		expect(unseenFailure.ok).toBe(false);
		expect(unseenFailure.out).toContain('/zz-unseen/[x]');
		expect(unseenFailure.out).toContain('not prerendered');
		expect(unseenFailure.out).not.toMatch(/-\s+\/\[policy=policy\]/); // the policy route is never the complaint
	});
});
