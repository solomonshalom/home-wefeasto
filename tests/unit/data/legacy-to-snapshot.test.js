/*
 * The generator (scripts/legacy-to-snapshot.mjs): deterministic, reproduces
 * the committed snapshot from the frozen fixtures, and can never re-freeze
 * adapter output as if it were the legacy data.
 */
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import {
	snapshotFromLegacy,
	deriveLegacy,
	daysPerPack,
	policyDrafts,
	generate,
	checkCommitted,
	readsSnapshot
} from '../../../scripts/legacy-to-snapshot.mjs';
import { PUBLIC_SETTINGS_DEFAULTS, UNREVIEWED_TEXT_RE, validatePolicyDrafts } from '$lib/data/snapshot-schema.js';
import { ROOT, LEGACY_DIR, SNAPSHOT_PATH, DRAFTS_PATH, readJSON, snapshotCopy, draftsCopy } from './fixtures.js';

const SCRIPT = path.join(ROOT, 'scripts/legacy-to-snapshot.mjs');
const manifest = readJSON(path.join(LEGACY_DIR, 'manifest.json'));
const fixtures = Object.fromEntries(
	manifest.files.map((f) => [f.replace(/\.json$/, ''), readJSON(path.join(LEGACY_DIR, f))])
);

function run(...args) {
	try {
		return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, stdio: 'pipe' }).toString() };
	} catch (err) {
		return { code: err.status, out: err.stdout.toString() + err.stderr.toString() };
	}
}

describe('frozen legacy fixtures', () => {
	it('record where they came from', () => {
		expect(manifest.gitHead).toMatch(/^[0-9a-f]{40}$/);
		expect(Object.keys(manifest.sources)).toEqual([
			'src/lib/data/products.js',
			'src/lib/data/products-content.js',
			'src/lib/data/recipes-content.js',
			'src/routes/+page.svelte',
			'src/routes/shop/+page.svelte'
		]);
	});

	it('hold the three hard-coded page arrays verbatim', () => {
		expect(fixtures['home-bestsellers']).toHaveLength(4);
		expect(fixtures['home-kitchenRecipes']).toHaveLength(4);
		expect(fixtures['shop-items']).toHaveLength(6);
		expect(fixtures['home-bestsellers'][0]).toEqual({
			url: '/products/cornflakes',
			aria: 'View Cornflakes',
			image: '/images/wefeasto/product-cornflakes.jpg',
			alt: 'Bowl of Wefeasto Cornflakes with cold milk',
			cat: 'Flakes',
			priceLine: '₹175 · 120 cal',
			title: 'Cornflakes',
			starLine: '★ 5.0 · 500 g'
		});
	});
});

describe('snapshotFromLegacy()', () => {
	it('reproduces the committed snapshot exactly (apart from generatedAt)', () => {
		const generated = snapshotFromLegacy(fixtures);
		const committed = snapshotCopy();
		expect({ ...generated, generatedAt: null }).toStrictEqual({ ...committed, generatedAt: null });
	});

	it('is deterministic and does not mutate the fixtures', () => {
		const before = JSON.stringify(fixtures);
		expect(snapshotFromLegacy(fixtures)).toStrictEqual(snapshotFromLegacy(fixtures));
		expect(JSON.stringify(fixtures)).toBe(before);
	});

	it('round-trips: deriving from its output gives back every legacy dataset', () => {
		const derived = deriveLegacy(snapshotFromLegacy(fixtures));
		for (const [name, value] of Object.entries(derived)) {
			expect(JSON.stringify(value), name).toBe(JSON.stringify(fixtures[name]));
		}
	});

	it('only stores mini-card overrides where legacy cards departed from the defaults', () => {
		const overrides = snapshotFromLegacy(fixtures).recipes.flatMap((r) =>
			r.products.filter((x) => x.alt !== null || x.ratingStyle !== 'decimal').map((x) => [r.slug, x])
		);
		expect(overrides).toEqual([
			['wf-muesli-yogurt-parfait', { slug: 'muesli', alt: null, ratingStyle: 'plain' }],
			['wf-health-mix-smoothie-bowl', { slug: 'health-mix', alt: 'Wefeasto Health Mix multigrain porridge in a bowl', ratingStyle: 'plain' }],
			['wf-masala-cornflakes-chivda', { slug: 'cornflakes', alt: null, ratingStyle: 'plain' }]
		]);
	});

	it('puts no policy page in the snapshot (none is published; drafts go to policyDrafts)', () => {
		expect(snapshotFromLegacy(fixtures).pages).toEqual([]);
	});

	it('invents no product facts: every value it fills comes from the legacy data', () => {
		// Regression: countryOfOrigin used to be a hard-coded 'India' that no
		// source gave, and the PDP showed it as a legal-style disclosure.
		const legacyBySlug = Object.fromEntries(fixtures.products.map((p) => [p.slug, p]));
		for (const p of snapshotFromLegacy(fixtures).products) {
			const legacyText = JSON.stringify([legacyBySlug[p.slug], fixtures.productsContent[p.slug]]);
			for (const [key, value] of Object.entries(p.facts)) {
				const values = Array.isArray(value) ? value : [value];
				for (const v of values.filter((x) => x !== null)) {
					expect(legacyText, `${p.slug}.facts.${key} = ${JSON.stringify(v)} has no source`).toContain(JSON.stringify(v));
				}
			}
			expect(p.facts.countryOfOrigin).toBeNull();
			expect(p.facts.netQuantity).toBe(legacyBySlug[p.slug].packSize);
		}
	});

	it('refuses legacy data it cannot represent exactly', () => {
		const bad = structuredClone(fixtures);
		bad.recipesContent['wf-muesli-yogurt-parfait'].shopIngredients[0].starsAria = 'Four stars';
		expect(() => snapshotFromLegacy(bad)).toThrow(/unexpected starsAria/);
		const badPrep = structuredClone(fixtures);
		badPrep.recipesContent['wf-muesli-yogurt-parfait'].card.prepLine = '5 mins';
		expect(() => snapshotFromLegacy(badPrep)).toThrow(/unexpected prepLine/);
	});
});

describe('policyDrafts()', () => {
	const settings = () => structuredClone(PUBLIC_SETTINGS_DEFAULTS);
	const body = (drafts, slug) => drafts.pages.find((p) => p.slug === slug).bodyHtml;

	it('reproduces the committed policy-drafts.server.json from the public settings', () => {
		expect(policyDrafts(snapshotCopy().settings)).toStrictEqual(draftsCopy());
	});

	it('are three valid unpublished drafts, each opening with the Draft line', () => {
		const drafts = policyDrafts(settings());
		expect(validatePolicyDrafts(drafts)).toEqual({ ok: true, errors: [] });
		expect(drafts.pages.map((p) => [p.slug, p.published])).toEqual([
			['shipping', false],
			['refunds', false],
			['grievances', false]
		]);
		for (const p of drafts.pages) expect(p.bodyHtml).toMatch(/^<p><strong>Draft — to be reviewed/);
	});

	it('follow the settings: fee, threshold, COD cap and fee, WhatsApp', () => {
		const s = settings();
		Object.assign(s, { freeDeliveryThresholdPaise: 59900, deliveryFeePaise: 6900, codMaxPaise: 300000, codFeePaise: 2500, supportWhatsappE164: '' });
		const shipping = body(policyDrafts(s), 'shipping');
		expect(shipping).toContain('free on orders of ₹599 or more');
		expect(shipping).toContain('delivery charge of ₹69');
		expect(shipping).toContain('orders up to ₹3,000');
		expect(shipping).toContain('for a fee of ₹25');
		expect(shipping).not.toContain('WhatsApp');
		expect(shipping).toContain('For anything else, contact us with your order number');
	});

	it('leave out the COD section when COD is off', () => {
		const s = settings();
		s.codEnabled = false;
		expect(body(policyDrafts(s), 'shipping')).not.toContain('Cash on Delivery');
	});

	it('fill (and HTML-escape) the grievance details once settings.legal is set; placeholders only for what is missing', () => {
		const s = settings();
		s.legal = {
			entityName: 'Wefeasto Foods <Pvt> Ltd',
			address: 'Bengaluru',
			fssaiLicence: '12345678901234',
			gstin: '',
			grievanceOfficer: { name: 'A. Officer', designation: 'Grievance Officer', email: 'grievance@wefeasto.com', phone: '+91 98452 62777' }
		};
		const grievances = body(policyDrafts(s), 'grievances');
		expect(grievances).toContain('Registered name: Wefeasto Foods &lt;Pvt&gt; Ltd');
		expect(grievances).toContain('Name: A. Officer');
		expect(grievances).toContain('GSTIN: [to be added]');
		expect(grievances.match(/\[to be added\]/g)).toHaveLength(1);
	});

	it('do not mutate the settings', () => {
		const s = settings();
		const before = JSON.stringify(s);
		policyDrafts(s);
		expect(JSON.stringify(s)).toBe(before);
	});
});

describe('generate() / checkCommitted()', () => {
	let tmp;
	afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));
	const copies = () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-legacy-'));
		const snapshotPath = path.join(tmp, 'cms-snapshot.json');
		const draftsPath = path.join(tmp, 'policy-drafts.server.json');
		fs.copyFileSync(SNAPSHOT_PATH, snapshotPath);
		fs.copyFileSync(DRAFTS_PATH, draftsPath);
		return { snapshotPath, draftsPath };
	};

	it('generate() returns both committed files byte for byte (the committed generatedAt is kept)', () => {
		const out = generate();
		expect(out.snapshot).toBe(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
		expect(out.drafts).toBe(fs.readFileSync(DRAFTS_PATH, 'utf8'));
		expect(out.snapshot).not.toMatch(UNREVIEWED_TEXT_RE);
	});

	it('passes on up-to-date copies', () => {
		const paths = copies();
		expect(checkCommitted(paths)).toEqual([expect.stringMatching(/cms-snapshot\.json is up to date$/), expect.stringMatching(/policy-drafts\.server\.json is up to date$/)]);
	});

	it('fails when the snapshot still carries the drafts (the old layout)', () => {
		const paths = copies();
		const s = readJSON(paths.snapshotPath);
		s.pages = draftsCopy().pages;
		fs.writeFileSync(paths.snapshotPath, JSON.stringify(s));
		expect(() => checkCommitted(paths)).toThrow(/cms-snapshot\.json is out of date/);
	});

	it("fails when a product's facts gained an unsourced value", () => {
		const paths = copies();
		const s = readJSON(paths.snapshotPath);
		s.products[0].facts.countryOfOrigin = 'India';
		fs.writeFileSync(paths.snapshotPath, JSON.stringify(s));
		expect(() => checkCommitted(paths)).toThrow(/cms-snapshot\.json is out of date/);
	});

	it.each([
		['edited', (p) => fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('Shipping Policy', 'Shipping'))],
		['reformatted', (p) => fs.writeFileSync(p, JSON.stringify(readJSON(p)))],
		['missing', (p) => fs.rmSync(p)]
	])('fails when the drafts file is %s', (_label, change) => {
		const paths = copies();
		change(paths.draftsPath);
		expect(() => checkCommitted(paths)).toThrow(/policy-drafts\.server\.json is out of date/);
	});
});

describe('daysPerPack()', () => {
	it.each([
		[500, 30, 21],
		[500, 40, 16],
		[400, 45, 11],
		[250, 30, 10],
		[null, 30, null],
		[500, null, null],
		[0, 30, null]
	])('(%j g pack, %j g serving) → %j days', (pack, serving, days) => {
		expect(daysPerPack(pack, serving)).toBe(days);
	});
});

/** The frozen legacy source of `file` (git show at the manifest's commit), or null when git can't reach it. */
function legacySource(file) {
	try {
		return execFileSync('git', ['show', `${manifest.gitHead}:${file}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
	} catch {
		return null;
	}
}
const LEGACY_DATA_MODULES = ['src/lib/data/products.js', 'src/lib/data/products-content.js', 'src/lib/data/recipes-content.js'];
const legacyReachable = LEGACY_DATA_MODULES.every((f) => legacySource(f) !== null);

describe('readsSnapshot() (the `freeze` guard)', () => {
	// W1R2-02: recipes-content.js now reads virtual:cms-snapshot/* only and never
	// names cms-snapshot.json, which the old text check looked for.
	it.each(LEGACY_DATA_MODULES)('recognises the adapter %s as reading the snapshot', (file) => {
		expect(readsSnapshot(fs.readFileSync(path.join(ROOT, file), 'utf8'))).toBe(true);
	});

	it.skipIf(!legacyReachable).each(LEGACY_DATA_MODULES)('does not flag the frozen legacy %s (the one input freeze was for)', (file) => {
		const source = legacySource(file);
		expect(crypto.createHash('sha256').update(source).digest('hex')).toBe(manifest.sources[file]); // really the frozen source
		expect(readsSnapshot(source)).toBe(false);
	});

	it.each([
		["import { products } from './cms-snapshot.json';", true],
		['import { products } from "$lib/data/cms-snapshot.json";', true],
		["import { products, recipes } from 'virtual:cms-snapshot/catalog';", true],
		["import { recipeBodies } from 'virtual:cms-snapshot/recipe-bodies';", true],
		["export { settings } from './cms-snapshot.json';", true],
		["const s = await import('./cms-snapshot.json');", true],
		['const s = await import(`./cms-snapshot.json`);', true],
		["import './cms-snapshot.json?raw';", true],
		['// cms-snapshot.json minus the recipe bodies (vite.config.js)', false],
		[' * derived from the CMS snapshot (cms-snapshot.json, synced from Payload).', false],
		["import { products } from './products.js';", false],
		["import x from './cms-snapshots.json';", false],
		["const label = 'cms-snapshot';", false],
		['', false]
	])('%j → %s', (source, expected) => {
		expect(readsSnapshot(source)).toBe(expected);
	});
});

describe('CLI', () => {
	it('`check` confirms the committed snapshot and policy drafts are up to date', () => {
		const { code, out } = run('check');
		expect(out).toContain('src/lib/data/cms-snapshot.json is up to date');
		expect(out).toContain('src/lib/data/policy-drafts.server.json is up to date');
		expect(code).toBe(0);
	});

	it('`freeze` refuses to overwrite the fixtures now that the modules are adapters', () => {
		const { code, out } = run('freeze');
		expect(code).toBe(1);
		expect(out).toMatch(/already reads the snapshot/);
		expect(readJSON(path.join(LEGACY_DIR, 'manifest.json'))).toEqual(manifest);
	});

	it('rejects unknown commands with usage', () => {
		const { code, out } = run('publish');
		expect(code).toBe(2);
		expect(out).toContain('usage:');
	});
});
