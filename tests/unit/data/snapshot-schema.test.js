/*
 * The committed snapshot is the storefront's single source of catalog truth
 * (SPEC §3). These tests pin its schema: types, integer paise, unique slugs,
 * resolvable relationships, exact public settings keys — and prove the
 * validator catches each class of bad snapshot a CMS sync could produce.
 */
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
	SNAPSHOT_VERSION,
	POLICY_DRAFTS_VERSION,
	PUBLIC_SETTINGS_DEFAULTS,
	SERVER_ONLY_SETTINGS_DEFAULTS,
	PRODUCT_CATEGORIES,
	RECIPE_CATEGORIES,
	RECIPE_COLORS,
	UNREVIEWED_TEXT_RE,
	validateSnapshot,
	validatePolicyDrafts,
	canonicalSnapshot,
	serializeSnapshot,
	serializePolicyDrafts
} from '$lib/data/snapshot-schema.js';
import { checkSnapshot } from '../../../scripts/sync-cms.mjs';
import { SNAPSHOT_PATH, DRAFTS_PATH, legacy, snapshotCopy, draftsCopy } from './fixtures.js';

const snapshot = snapshotCopy();
const fileText = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
const drafts = draftsCopy();
const draftsText = fs.readFileSync(DRAFTS_PATH, 'utf8');
const DRAFT_LINE = '<p><strong>Draft — to be reviewed by Wefeasto before publishing.</strong></p>';

/** A reviewed, published policy page (valid in a snapshot). */
const page = (extra = {}) => ({ slug: 'shipping', title: 'Shipping Policy', bodyHtml: '<h2>Where we deliver</h2><p>Across India.</p>', published: true, ...extra });

// The canonical public settings, spelled out independently of the module under test.
const EXPECTED_SETTINGS = {
	freeDeliveryThresholdPaise: 49900,
	deliveryFeePaise: 4900,
	codEnabled: true,
	codMaxPaise: 200000,
	codFeePaise: 0,
	codMinSubtotalPaise: 0,
	maxOrderPaise: 5000000,
	topUpDiscoveryBiasPaise: 5000,
	shippingPromiseText: 'Ships in 1–2 days · delivered in 3–7 days',
	announcement: { enabled: false, text: '', href: '' },
	supportWhatsappE164: '+919845262777',
	legal: {
		entityName: '',
		address: '',
		fssaiLicence: '',
		gstin: '',
		grievanceOfficer: { name: '', designation: '', email: '', phone: '' }
	},
	welcomeOffer: { percent: 10, maxDiscountPaise: 7500, validDays: 30 }
};
const SERVER_ONLY_KEYS = ['reservationMinutes', 'blockedPinPrefixes', 'codBlockedPinPrefixes', 'codMaxOpenPerPhone'];

/** Every leaf key path of an object, e.g. 'legal.grievanceOfficer.email'. */
const keyPaths = (obj, prefix = '') =>
	Object.entries(obj).flatMap(([k, v]) =>
		v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, prefix + k + '.') : [prefix + k]
	);

describe('committed cms-snapshot.json', () => {
	it('passes validateSnapshot', () => {
		expect(validateSnapshot(snapshot)).toEqual({ ok: true, errors: [] });
	});

	it('has the top-level shape { version: 1, generatedAt, settings, products, recipes, pages }', () => {
		expect(Object.keys(snapshot)).toEqual(['version', 'generatedAt', 'settings', 'products', 'recipes', 'pages']);
		expect(snapshot.version).toBe(1);
		expect(SNAPSHOT_VERSION).toBe(1);
		expect(new Date(snapshot.generatedAt).toISOString()).toBe(snapshot.generatedAt);
	});

	it('is written in the stable format (canonical key order, 2-space JSON, trailing newline)', () => {
		expect(serializeSnapshot(snapshot)).toBe(fileText);
		expect(fileText.endsWith('}\n')).toBe(true);
		expect(fileText.startsWith('{\n  "version": 1,\n')).toBe(true);
	});

	it('holds the six legacy products and twelve recipes, in legacy order', () => {
		expect(snapshot.products.map((p) => p.slug)).toEqual(legacy('products').map((p) => p.slug));
		expect(snapshot.recipes.map((r) => r.slug)).toEqual(Object.keys(legacy('recipesContent')));
		const orders = snapshot.products.map((p) => p.sortOrder);
		expect(orders).toEqual([...orders].sort((a, b) => a - b));
		expect(new Set(orders).size).toBe(orders.length);
	});

	it('stores money as integer paise = legacy rupees × 100', () => {
		const legacyPrice = Object.fromEntries(legacy('products').map((p) => [p.slug, p.price]));
		for (const p of snapshot.products) {
			expect(Number.isInteger(p.pricePaise)).toBe(true);
			expect(p.pricePaise).toBe(legacyPrice[p.slug] * 100);
			expect(p).not.toHaveProperty('price');
		}
	});

	it('has unique slugs everywhere', () => {
		for (const list of [snapshot.products, snapshot.recipes, snapshot.pages]) {
			const slugs = list.map((x) => x.slug);
			expect(new Set(slugs).size).toBe(slugs.length);
		}
	});

	it('resolves every relationship (goesWith, recipe products, related)', () => {
		const productSlugs = new Set(snapshot.products.map((p) => p.slug));
		const recipeSlugs = new Set(snapshot.recipes.map((r) => r.slug));
		for (const p of snapshot.products) {
			expect(p.goesWith.length).toBeGreaterThan(0);
			for (const s of p.goesWith) {
				expect(productSlugs.has(s)).toBe(true);
				expect(s).not.toBe(p.slug);
			}
		}
		for (const r of snapshot.recipes) {
			expect(r.products.length).toBeGreaterThan(0);
			for (const x of r.products) expect(productSlugs.has(x.slug)).toBe(true);
			for (const s of r.related) {
				expect(recipeSlugs.has(s)).toBe(true);
				expect(s).not.toBe(r.slug);
			}
		}
	});

	it('uses only known categories and palette colours', () => {
		for (const p of snapshot.products) expect(PRODUCT_CATEGORIES).toContain(p.category);
		for (const r of snapshot.recipes) {
			expect(RECIPE_CATEGORIES).toContain(r.category);
			expect(RECIPE_COLORS).toContain(r.tagColor);
			expect(RECIPE_COLORS).toContain(r.iconColor);
		}
	});

	it('features exactly the legacy home cards', () => {
		expect(snapshot.products.filter((p) => p.homeFeatured).map((p) => p.slug)).toEqual([
			'cornflakes',
			'steel-cut-oats',
			'muesli',
			'choco-flakes'
		]);
		expect(snapshot.recipes.filter((r) => r.homeFeatured).map((r) => r.slug)).toEqual([
			'wf-berry-overnight-steel-cut-oats',
			'wf-muesli-yogurt-parfait',
			'wf-choco-flakes-energy-bars',
			'wf-health-mix-smoothie-bowl'
		]);
		for (const x of [...snapshot.products, ...snapshot.recipes]) {
			expect(x.homeAlt === null).toBe(!x.homeFeatured);
		}
	});
});

describe('settings', () => {
	it('are exactly the canonical public settings', () => {
		expect(snapshot.settings).toStrictEqual(EXPECTED_SETTINGS);
		expect(keyPaths(snapshot.settings)).toEqual(keyPaths(EXPECTED_SETTINGS));
		expect(PUBLIC_SETTINGS_DEFAULTS).toStrictEqual(EXPECTED_SETTINGS);
	});

	it('contain no server-only keys', () => {
		expect(Object.keys(SERVER_ONLY_SETTINGS_DEFAULTS)).toEqual(SERVER_ONLY_KEYS);
		expect(SERVER_ONLY_SETTINGS_DEFAULTS).toStrictEqual({
			reservationMinutes: 30,
			blockedPinPrefixes: [],
			codBlockedPinPrefixes: [],
			codMaxOpenPerPhone: 2
		});
		const text = JSON.stringify(snapshot);
		for (const key of SERVER_ONLY_KEYS) expect(text).not.toContain(`"${key}"`);
		for (const key of ['stock', 'lowStockThreshold']) expect(text).not.toContain(`"${key}"`);
	});

	it('money settings are integer paise', () => {
		for (const [key, value] of Object.entries(snapshot.settings)) {
			if (key.endsWith('Paise')) expect(Number.isInteger(value) && value >= 0).toBe(true);
		}
		expect(Number.isInteger(snapshot.settings.welcomeOffer.maxDiscountPaise)).toBe(true);
	});
});

describe('per-product commerce and facts fields', () => {
	const PACK = {
		cornflakes: [500, 30, 21],
		'steel-cut-oats': [500, 40, 16],
		'rolled-oats': [500, 40, 16],
		muesli: [400, 45, 11],
		'choco-flakes': [250, 30, 10],
		'health-mix': [null, 30, null]
	};

	it.each(Object.keys(PACK))('%s', (slug) => {
		const p = snapshot.products.find((x) => x.slug === slug);
		const legacyProduct = legacy('products').find((x) => x.slug === slug);
		const [packGrams, servingGrams, daysPerPack] = PACK[slug];
		expect(p).toMatchObject({ inStock: true, maxPerOrder: 10, codAllowed: true, ratingSource: null, packGrams, servingGrams, daysPerPack });
		if (packGrams) expect(daysPerPack).toBe(Math.round(packGrams / servingGrams / 0.8));
		expect(p.facts).toStrictEqual({
			netQuantity: legacyProduct.packSize,
			ingredients: null,
			allergens: [],
			bestBefore: null,
			manufacturer: null,
			countryOfOrigin: null
		});
	});

	it('invents no product facts: country of origin, ingredients, allergens, best before and manufacturer wait for the owner', () => {
		// Only netQuantity has a source (the legacy pack size); a disclosure nobody
		// supplied must stay null so the PDP "Product facts" leaves the row out.
		for (const p of snapshot.products) {
			const { netQuantity, allergens, ...rest } = p.facts;
			expect(rest).toStrictEqual({ ingredients: null, bestBefore: null, manufacturer: null, countryOfOrigin: null });
			expect(allergens).toEqual([]);
			expect(netQuantity).toBe(p.packSize);
		}
	});

	it('leaves Health Mix pack size unknown (owner to confirm) rather than inventing one', () => {
		const hm = snapshot.products.find((p) => p.slug === 'health-mix');
		expect(hm.packSize).toBeNull();
		expect(hm.facts.netQuantity).toBeNull();
	});
});

describe('policy pages', () => {
	it('the snapshot (public: API + storefront bundle) holds none — no page has been reviewed and published yet', () => {
		expect(snapshot.pages).toEqual([]);
		expect(fileText).not.toMatch(UNREVIEWED_TEXT_RE);
	});

	it('the three unpublished drafts live in policy-drafts.server.json (CMS seed input only)', () => {
		expect(validatePolicyDrafts(drafts)).toEqual({ ok: true, errors: [] });
		expect(Object.keys(drafts)).toEqual(['version', 'pages']);
		expect(drafts.version).toBe(POLICY_DRAFTS_VERSION);
		expect(drafts.pages.map((p) => [p.slug, p.published])).toEqual([
			['shipping', false],
			['refunds', false],
			['grievances', false]
		]);
		for (const page of drafts.pages) {
			expect(Object.keys(page)).toEqual(['slug', 'title', 'bodyHtml', 'published']);
			expect(page.bodyHtml.startsWith(DRAFT_LINE)).toBe(true);
			expect(page.bodyHtml).toMatch(UNREVIEWED_TEXT_RE);
			expect(page.title.trim()).not.toBe('');
		}
	});

	it('scripts/sync-cms.mjs refuses a CMS response that still carries the drafts (the old /api/store/snapshot shape)', () => {
		const served = { ...snapshotCopy(), generatedAt: '2031-01-02T03:04:05.678Z', pages: draftsCopy().pages };
		const { ok, errors } = checkSnapshot(served);
		expect(ok).toBe(false);
		expect(errors).toContain('pages[0].published: must be true — unpublished pages never enter the snapshot (drafts: policy-drafts.server.json)');
		expect(checkSnapshot({ ...served, pages: [] })).toEqual({ ok: true, errors: [] });
	});

	it('the drafts file is written in the stable format', () => {
		expect(serializePolicyDrafts(drafts)).toBe(draftsText);
		expect(draftsText.startsWith('{\n  "version": 1,\n  "pages": [\n')).toBe(true);
		expect(draftsText.endsWith('}\n')).toBe(true);
	});

	it('word the shipping draft from the settings', () => {
		const body = drafts.pages.find((p) => p.slug === 'shipping').bodyHtml;
		expect(body).toContain(EXPECTED_SETTINGS.shippingPromiseText);
		expect(body).toContain('₹499');
		expect(body).toContain('₹49,');
		expect(body).toContain('₹2,000');
		expect(body).toContain('+91 98452 62777');
	});

	it('leave grievance officer and legal details as visible placeholders until settings.legal is filled', () => {
		const body = drafts.pages.find((p) => p.slug === 'grievances').bodyHtml;
		expect(body).toContain('Grievance Officer');
		expect(body).toContain('Consumer Protection (E-Commerce) Rules, 2020');
		for (const label of ['Name:', 'Designation:', 'Email:', 'Phone:', 'Registered name:', 'FSSAI licence no.:', 'GSTIN:']) {
			expect(body).toContain(`${label} [to be added]`);
		}
	});
});

/* ---------------------------------------------------------- validator */

const errorsFor = (mutate) => {
	const s = snapshotCopy();
	mutate(s);
	return validateSnapshot(s);
};

const INVALID = [
	['version 2', (s) => (s.version = 2), /^version: must be ≤ 1/],
	['missing generatedAt', (s) => delete s.generatedAt, /^generatedAt: required string/],
	['unparseable generatedAt', (s) => (s.generatedAt = 'yesterday'), /^generatedAt: expected an ISO date/],
	['unknown top-level key', (s) => (s.home = {}), /^\(root\): unknown field "home"/],
	['missing settings key', (s) => delete s.settings.codFeePaise, /^settings\.codFeePaise: required integer/],
	['extra settings key', (s) => (s.settings.theme = 'dark'), /^settings: unknown field "theme"/],
	['server-only setting leaked', (s) => (s.settings.reservationMinutes = 30), /^settings\.reservationMinutes: server-only setting/],
	['server-only COD PIN list leaked', (s) => (s.settings.codBlockedPinPrefixes = []), /^settings\.codBlockedPinPrefixes: server-only/],
	['paise as a string', (s) => (s.settings.deliveryFeePaise = '4900'), /^settings\.deliveryFeePaise: expected integer, got string/],
	['fractional paise', (s) => (s.settings.freeDeliveryThresholdPaise = 499.5), /expected integer, got 499\.5/],
	['negative paise', (s) => (s.settings.codFeePaise = -1), /^settings\.codFeePaise: must be ≥ 0/],
	['NaN paise', (s) => (s.settings.codMaxPaise = NaN), /^settings\.codMaxPaise: expected integer, got number/],
	['codEnabled as "true"', (s) => (s.settings.codEnabled = 'true'), /^settings\.codEnabled: expected boolean/],
	['announcement enabled without text', (s) => (s.settings.announcement.enabled = true), /^settings\.announcement\.text: required when/],
	['announcement href to another scheme', (s) => (s.settings.announcement.href = 'javascript:alert(1)'), /^settings\.announcement\.href:/],
	['WhatsApp number not E.164', (s) => (s.settings.supportWhatsappE164 = '98452 62777'), /^settings\.supportWhatsappE164: expected '' or E\.164/],
	['FSSAI licence not 14 digits', (s) => (s.settings.legal.fssaiLicence = '1234'), /^settings\.legal\.fssaiLicence:/],
	['malformed GSTIN', (s) => (s.settings.legal.gstin = '29ABCDE1234F1Z'), /^settings\.legal\.gstin:/],
	['bad grievance email', (s) => (s.settings.legal.grievanceOfficer.email = 'not-an-email'), /grievanceOfficer\.email:/],
	['welcome percent over 100', (s) => (s.settings.welcomeOffer.percent = 150), /^settings\.welcomeOffer\.percent: must be ≤ 100/],
	['no products', (s) => (s.products = []), /^products: needs at least 1 item/],
	['products not an array', (s) => (s.products = {}), /^products: expected array, got object/],
	['duplicate product slug', (s) => (s.products[1].slug = 'cornflakes'), /^products\[1\]\.slug: duplicate slug "cornflakes"/],
	['non-kebab slug', (s) => (s.products[0].slug = 'Corn Flakes'), /^products\[0\]\.slug: expected lower-case kebab-case/],
	['price not integer paise', (s) => (s.products[0].pricePaise = 17550.5), /^products\[0\]\.pricePaise: expected integer/],
	['price not whole rupees', (s) => (s.products[0].pricePaise = 17550), /^products\[0\]\.pricePaise: must be a multiple of 100/],
	['free product', (s) => (s.products[0].pricePaise = 0), /^products\[0\]\.pricePaise: must be ≥ 100/],
	['legacy rupee price field', (s) => (s.products[0].price = 175), /^products\[0\]: unknown field "price"/],
	['server-only stock leaked', (s) => (s.products[2].stock = 40), /^products\[2\]\.stock: server-only field/],
	['CMS id leaked', (s) => (s.products[0].id = 7), /^products\[0\]: unknown field "id"/],
	['unknown category', (s) => (s.products[0].category = 'Granola'), /^products\[0\]\.category: expected one of/],
	['rating above 5', (s) => (s.products[0].rating = 5.5), /^products\[0\]\.rating: must be ≤ 5/],
	['rating with 2 decimals', (s) => (s.products[0].rating = 4.25), /^products\[0\]\.rating: at most 1 decimal/],
	['empty name', (s) => (s.products[0].name = '  '), /^products\[0\]\.name: must not be empty/],
	['missing heroAlt', (s) => delete s.products[0].heroAlt, /^products\[0\]\.heroAlt: required string/],
	['null where not nullable', (s) => (s.products[0].shopAlt = null), /^products\[0\]\.shopAlt: required string, got null/],
	['protocol-relative image', (s) => (s.products[0].image = '//evil.example/x.jpg'), /^products\[0\]\.image: expected root-relative path or https URL/],
	['http partner link', (s) => (s.products[0].partners[0].url = 'http://example.com'), /^products\[0\]\.partners\[0\]\.url: expected https URL/],
	['goesWith unknown product', (s) => (s.products[0].goesWith[0] = 'granola'), /^products\[0\]\.goesWith\[0\]: unknown product "granola"/],
	['goesWith itself', (s) => (s.products[0].goesWith[0] = 'cornflakes'), /^products\[0\]\.goesWith\[0\]: must not reference itself/],
	['goesWith duplicate', (s) => (s.products[0].goesWith[1] = s.products[0].goesWith[0]), /^products\[0\]\.goesWith\[1\]: duplicate reference/],
	['featured without home alt', (s) => (s.products[2].homeFeatured = true), /^products\[2\]\.homeAlt: required when homeFeatured/],
	['sortOrder out of order', (s) => (s.products[1].sortOrder = 5), /^products\[1\]\.sortOrder: array must be ordered/],
	['maxPerOrder 0', (s) => (s.products[0].maxPerOrder = 0), /^products\[0\]\.maxPerOrder: must be ≥ 1/],
	['daysPerPack fractional', (s) => (s.products[0].daysPerPack = 20.8), /^products\[0\]\.daysPerPack: expected integer/],
	['allergens as a string', (s) => (s.products[0].facts.allergens = 'nuts'), /^products\[0\]\.facts\.allergens: expected array/],
	['facts missing', (s) => delete s.products[0].facts, /^products\[0\]\.facts: required object/],
	['recipe uses unknown product', (s) => (s.recipes[0].products[0].slug = 'granola'), /^recipes\[0\]\.products\[0\]: unknown product "granola"/],
	['recipe rating style unknown', (s) => (s.recipes[0].products[0].ratingStyle = 'stars'), /^recipes\[0\]\.products\[0\]\.ratingStyle: expected one of/],
	['related unknown recipe', (s) => (s.recipes[0].related[0] = 'wf-nope'), /^recipes\[0\]\.related\[0\]: unknown recipe "wf-nope"/],
	['related to itself', (s) => (s.recipes[0].related[0] = s.recipes[0].slug), /^recipes\[0\]\.related\[0\]: must not reference itself/],
	['duplicate recipe slug', (s) => (s.recipes[3].slug = s.recipes[2].slug), /^recipes\[3\]\.slug: duplicate slug/],
	['tag colour off-palette', (s) => (s.recipes[0].tagColor = '#123456'), /^recipes\[0\]\.tagColor: expected one of/],
	['recipe category unknown', (s) => (s.recipes[0].category = 'Lunch'), /^recipes\[0\]\.category: expected one of/],
	['script in recipe HTML', (s) => (s.recipes[0].ingredientsHtml += '<script>alert(1)</script>'), /^recipes\[0\]\.ingredientsHtml: HTML contains script/],
	['event handler in recipe HTML', (s) => (s.recipes[0].whyHtml = '<img src=x onerror=alert(1)>'), /^recipes\[0\]\.whyHtml: HTML contains/],
	['javascript: link in recipe HTML', (s) => (s.recipes[0].directionsHtml = '<a href="javascript:alert(1)">x</a>'), /^recipes\[0\]\.directionsHtml: HTML contains/],
	['iframe in page HTML', (s) => (s.pages = [page({ bodyHtml: '<iframe src="https://x"></iframe>' })]), /^pages\[0\]\.bodyHtml: HTML contains/],
	['duplicate page slug', (s) => (s.pages = [page(), page({ title: 'Shipping' })]), /^pages\[1\]\.slug: duplicate slug "shipping"/],
	['published as a string', (s) => (s.pages = [page({ published: 'no' })]), /^pages\[0\]\.published: expected boolean/],
	['page without a body', (s) => (s.pages = [page({ bodyHtml: ' ' })]), /^pages\[0\]\.bodyHtml: must not be empty/],
	// Drafts are public once they are in the snapshot (API + storefront bundle): never.
	['an unpublished draft page', (s) => (s.pages = [page({ published: false })]), /^pages\[0\]\.published: must be true — unpublished pages never enter the snapshot/],
	['a published page still opening with the Draft line', (s) => (s.pages = [page({ bodyHtml: DRAFT_LINE + '<p>Across India.</p>' })]), /^pages\[0\]\.bodyHtml: still contains "Draft — to be reviewed"/],
	['a published page with [to be added] placeholders', (s) => (s.pages = [page({ bodyHtml: '<p>Name: [to be added]</p>' })]), /^pages\[0\]\.bodyHtml: still contains "\[to be added\]"/],
	['a draft marker spelled with a hyphen, in the title', (s) => (s.pages = [page({ title: 'Shipping (draft - to be reviewed)' })]), /^pages\[0\]\.title: still contains/]
];

describe('validateSnapshot rejects', () => {
	it.each(INVALID)('%s', (_name, mutate, expected) => {
		const { ok, errors } = errorsFor(mutate);
		expect(ok).toBe(false);
		expect(errors.some((e) => expected.test(e)), errors.join('\n')).toBe(true);
	});

	it('the policy drafts copied into a snapshot: every page refused, twice over (unpublished + Draft line)', () => {
		const { ok, errors } = errorsFor((s) => (s.pages = draftsCopy().pages));
		expect(ok).toBe(false);
		expect(errors.filter((e) => /^pages\[\d\]\.published: must be true/.test(e))).toHaveLength(3);
		expect(errors.filter((e) => /^pages\[\d\]\.bodyHtml: still contains "Draft — to be reviewed/.test(e))).toHaveLength(3);
	});

	it('the drafts ticked published but not reviewed: still refused', () => {
		const { ok, errors } = errorsFor((s) => (s.pages = draftsCopy().pages.map((p) => ({ ...p, published: true }))));
		expect(ok).toBe(false);
		expect(errors).toHaveLength(3);
		expect(errors.every((e) => /^pages\[\d\]\.bodyHtml: still contains/.test(e))).toBe(true);
	});

	it.each([null, undefined, [], 'snapshot', 42, {}])('a non-snapshot (%j) without throwing', (value) => {
		const { ok, errors } = validateSnapshot(value);
		expect(ok).toBe(false);
		expect(errors.length).toBeGreaterThan(0);
	});

	it('reports structural errors before (and instead of) relationship errors', () => {
		const { errors } = errorsFor((s) => {
			s.products[0].pricePaise = 'free';
			s.products[0].goesWith = ['nope'];
		});
		expect(errors).toEqual(['products[0].pricePaise: expected integer, got string']);
	});

	it('never throws on random garbage in any field (fuzz)', () => {
		const junk = [null, undefined, 0, -1, 1.5, NaN, '', 'x', true, [], {}, [null], { a: 1 }];
		const paths = [];
		const walk = (value, path) => {
			paths.push(path);
			if (value && typeof value === 'object') for (const k of Object.keys(value)) walk(value[k], [...path, k]);
		};
		const withPage = () => Object.assign(snapshotCopy(), { pages: [page()] });
		walk(withPage(), []);
		let seed = 7;
		const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
		for (let i = 0; i < 400; i++) {
			const s = withPage();
			const path = paths[1 + rand(paths.length - 1)];
			let target = s;
			for (const k of path.slice(0, -1)) target = target[k];
			target[path.at(-1)] = junk[rand(junk.length)];
			expect(() => validateSnapshot(s)).not.toThrow();
		}
	});
});

describe('validateSnapshot accepts legitimate variations', () => {
	it.each([
		['a product with no pack size (like Health Mix)', (s) => (s.products[0].packSize = null)],
		['an announcement that is switched on', (s) => (s.settings.announcement = { enabled: true, text: 'Free delivery this week', href: '/shop' })],
		['filled legal details', (s) => (s.settings.legal = {
			entityName: 'Wefeasto Foods Pvt Ltd',
			address: 'Bengaluru, Karnataka',
			fssaiLicence: '12345678901234',
			gstin: '29ABCDE1234F1Z5',
			grievanceOfficer: { name: 'A. Officer', designation: 'Grievance Officer', email: 'grievance@wefeasto.com', phone: '+91 98452 62777' }
		})],
		['a published page', (s) => (s.pages = [page()])],
		['reviewed shipping and refunds drafts: Draft line removed, then published', (s) => {
			s.pages = draftsCopy()
				.pages.filter((p) => p.slug !== 'grievances')
				.map((p) => ({ ...p, bodyHtml: p.bodyHtml.replace(DRAFT_LINE, ''), published: true }));
		}],
		['the words "draft" and "to be reviewed" in ordinary copy', (s) => (s.pages = [page({ bodyHtml: '<p>Our draft rules are to be reviewed yearly.</p>' })])],
		['no recipes and no pages', (s) => ((s.recipes = []), (s.products.forEach((p) => (p.goesWith = []))), (s.pages = []))],
		['an https image from the CMS media store', (s) => (s.products[0].image = 'https://cms.wefeasto.com/api/media/file/cornflakes.jpg')],
		['a recipe slug without the wf- prefix (references renamed with it)', (s) => {
			const old = s.recipes[0].slug;
			s.recipes[0].slug = 'porridge';
			for (const r of s.recipes) r.related = r.related.map((x) => (x === old ? 'porridge' : x));
		}],
		['out of stock with COD off', (s) => Object.assign(s.products[0], { inStock: false, codAllowed: false })],
		['a rating source and filled facts', (s) => Object.assign(s.products[0], { ratingSource: 'Amazon', facts: { ...s.products[0].facts, ingredients: 'Corn grits, sugar, salt', allergens: ['Gluten'] } })]
	])('%s', (_name, mutate) => {
		expect(errorsFor(mutate)).toEqual({ ok: true, errors: [] });
	});
});

describe('canonicalSnapshot / serializeSnapshot', () => {
	const shuffle = (value) => {
		if (Array.isArray(value)) return value.map(shuffle);
		if (!value || typeof value !== 'object') return value;
		return Object.fromEntries(Object.keys(value).reverse().map((k) => [k, shuffle(value[k])]));
	};

	it('restores schema key order from any input order (the CMS may return keys in its own order)', () => {
		const shuffled = shuffle(snapshotCopy());
		expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(snapshot));
		expect(serializeSnapshot(shuffled)).toBe(fileText);
	});

	it('keeps array order and appends unknown keys sorted', () => {
		const s = snapshotCopy();
		s.products[0].zeta = 1;
		s.products[0].alpha = 2;
		const out = canonicalSnapshot(s);
		expect(Object.keys(out.products[0]).slice(-2)).toEqual(['alpha', 'zeta']);
		expect(out.products.map((p) => p.slug)).toEqual(snapshot.products.map((p) => p.slug));
	});

	it('does not mutate its input', () => {
		const s = shuffle(snapshotCopy());
		const before = JSON.stringify(s);
		canonicalSnapshot(s);
		expect(JSON.stringify(s)).toBe(before);
	});
});

/* ------------------------------------------------ policy drafts file */

describe('validatePolicyDrafts', () => {
	const draftErrors = (mutate) => {
		const d = draftsCopy();
		mutate(d);
		return validatePolicyDrafts(d);
	};

	it.each([
		['version 2', (d) => (d.version = 2), /^version: must be ≤ 1/],
		['missing pages', (d) => delete d.pages, /^pages: required array/],
		['unknown top-level key (e.g. a whole snapshot)', (d) => (d.products = []), /^\(root\): unknown field "products"/],
		['a draft marked published', (d) => (d.pages[1].published = true), /^pages\[1\]\.published: must be false/],
		['published as a string', (d) => (d.pages[0].published = 'false'), /^pages\[0\]\.published: expected boolean/],
		['duplicate slug', (d) => (d.pages[2].slug = 'shipping'), /^pages\[2\]\.slug: duplicate slug "shipping"/],
		['non-kebab slug', (d) => (d.pages[0].slug = 'Shipping Policy'), /^pages\[0\]\.slug: expected lower-case kebab-case/],
		['script in a draft', (d) => (d.pages[0].bodyHtml += '<script>alert(1)</script>'), /^pages\[0\]\.bodyHtml: HTML contains script/],
		['empty title', (d) => (d.pages[0].title = ''), /^pages\[0\]\.title: must not be empty/],
		['CMS id leaked', (d) => (d.pages[0].id = 3), /^pages\[0\]: unknown field "id"/]
	])('rejects %s', (_name, mutate, expected) => {
		const { ok, errors } = draftErrors(mutate);
		expect(ok).toBe(false);
		expect(errors.some((e) => expected.test(e)), errors.join('\n')).toBe(true);
	});

	it.each([null, undefined, [], 'drafts', 42, {}])('rejects a non-drafts value (%j) without throwing', (value) => {
		const { ok, errors } = validatePolicyDrafts(value);
		expect(ok).toBe(false);
		expect(errors.length).toBeGreaterThan(0);
	});

	it('accepts an empty drafts list and a draft without the Draft line (the owner edits drafts freely)', () => {
		expect(validatePolicyDrafts({ version: 1, pages: [] })).toEqual({ ok: true, errors: [] });
		expect(draftErrors((d) => (d.pages[0].bodyHtml = '<p>Rewritten by the owner.</p>'))).toEqual({ ok: true, errors: [] });
	});

	it('a snapshot is not a drafts file, and the drafts file is not a snapshot', () => {
		expect(validatePolicyDrafts(snapshotCopy()).ok).toBe(false);
		expect(validateSnapshot(draftsCopy()).ok).toBe(false);
	});

	it('serializePolicyDrafts restores key order and does not mutate its input', () => {
		const reversed = {
			pages: draftsCopy().pages.map((p) => Object.fromEntries(Object.entries(p).reverse())),
			version: 1
		};
		const before = JSON.stringify(reversed);
		expect(serializePolicyDrafts(reversed)).toBe(draftsText);
		expect(JSON.stringify(reversed)).toBe(before);
	});
});

describe('UNREVIEWED_TEXT_RE', () => {
	it.each([
		'Draft — to be reviewed by Wefeasto before publishing.',
		'DRAFT – to be reviewed',
		'Draft - to be reviewed',
		'Draft—to be reviewed',
		'Name: [to be added]',
		'[ To be added ]'
	])('flags %j', (text) => expect(text).toMatch(UNREVIEWED_TEXT_RE));

	it.each(['Our draft rules are to be reviewed yearly.', 'Details to be added soon.', 'Drafted and reviewed', ''])(
		'leaves ordinary copy alone: %j',
		(text) => expect(text).not.toMatch(UNREVIEWED_TEXT_RE)
	);
});
