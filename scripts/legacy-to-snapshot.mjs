#!/usr/bin/env node
/*
 * Legacy catalog → CMS snapshot.
 *
 *   node scripts/legacy-to-snapshot.mjs freeze [--force]
 *       ONE-OFF, run before the data modules became snapshot adapters: imports the
 *       hand-written/generated src/lib/data/{products,products-content,recipes-content}.js
 *       and copies the hard-coded card arrays out of src/routes/+page.svelte
 *       (bestsellers, kitchenRecipes) and src/routes/shop/+page.svelte (items),
 *       writing them verbatim to tests/fixtures/legacy/*.json. Refuses to run once
 *       the modules read the snapshot (that would freeze the adapters, not the legacy).
 *
 *   node scripts/legacy-to-snapshot.mjs build
 *       Rebuilds src/lib/data/cms-snapshot.json from those frozen fixtures, and
 *       src/lib/data/policy-drafts.server.json: the unpublished policy pages the
 *       CMS seed creates for the owner to review. Drafts are kept out of the
 *       snapshot because the snapshot is public (API + storefront bundle).
 *
 *   node scripts/legacy-to-snapshot.mjs check
 *       Exit 1 if either committed file differs from what `build` would write
 *       (the snapshot's generatedAt ignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as schema from '../src/lib/data/snapshot-schema.js';
import * as derive from '../src/lib/data/derive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/legacy');
const SNAPSHOT = path.join(ROOT, 'src/lib/data/cms-snapshot.json');
const DRAFTS = path.join(ROOT, 'src/lib/data/policy-drafts.server.json');

const rel = (p) => path.relative(ROOT, p);
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJSON = (p, v) => {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
};
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/* ------------------------------------------------------------------ freeze */

const LEGACY_MODULES = {
	products: 'src/lib/data/products.js',
	productsContent: 'src/lib/data/products-content.js',
	recipesContent: 'src/lib/data/recipes-content.js'
};
const SVELTE_ARRAYS = [
	{ file: 'src/routes/+page.svelte', name: 'bestsellers', out: 'home-bestsellers' },
	{ file: 'src/routes/+page.svelte', name: 'kitchenRecipes', out: 'home-kitchenRecipes' },
	{ file: 'src/routes/shop/+page.svelte', name: 'items', out: 'shop-items' }
];

/** Pull `const <name> = [ … ];` (tab-indented, as written) out of a component
 *  script and evaluate the literal — trusted repo source, plain data only. */
function extractArray(file, name) {
	const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
	const m = src.match(new RegExp(`\\n\\tconst ${name} = (\\[[\\s\\S]*?\\n\\t\\]);`));
	if (!m) throw new Error(`const ${name} = [...] not found in ${file}`);
	return new Function(`return ${m[1]};`)();
}

/** JSON must hold the value exactly (no undefined/NaN/functions dropped). */
function assertJsonSafe(label, value) {
	if (!isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value)) {
		throw new Error(`${label} does not survive a JSON round-trip`);
	}
}

/** True when module source names the CMS snapshot in a string (any import
 *  form): the JSON itself or a virtual:cms-snapshot/* module that vite.config.js
 *  splits it into. A mention in a comment does not count. */
export const readsSnapshot = (source) => /(['"`])[^'"`\n]*cms-snapshot(?:\.json|\/)[^'"`\n]*\1/.test(String(source));

async function freeze(force) {
	for (const file of Object.values(LEGACY_MODULES)) {
		if (readsSnapshot(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
			throw new Error(`${file} already reads the snapshot — refusing to freeze adapter output as "legacy"`);
		}
	}
	if (fs.existsSync(path.join(FIXTURES, 'manifest.json')) && !force) {
		throw new Error(`${rel(FIXTURES)} already frozen (pass --force to overwrite)`);
	}

	const mod = {};
	for (const [key, file] of Object.entries(LEGACY_MODULES)) {
		mod[key] = await import(pathToFileURL(path.join(ROOT, file)).href);
	}
	const out = {
		products: mod.products.products,
		recipes: mod.products.recipes,
		productsContent: mod.productsContent.productsContent,
		recipesContent: mod.recipesContent.recipesContent
	};
	for (const { file, name, out: key } of SVELTE_ARRAYS) out[key] = extractArray(file, name);

	for (const [key, value] of Object.entries(out)) {
		assertJsonSafe(key, value);
		writeJSON(path.join(FIXTURES, key + '.json'), value);
	}

	// formatINR / productBySlug are behaviour, not data: record reference outputs.
	const { formatINR, productBySlug } = mod.products;
	const inputs = [0, 1, 99, 175, 999, 1000, 1250, 1275, 99999, 100000, 1234567, 12.4, 12.5, -3, '250', 'abc', null, undefined];
	writeJSON(path.join(FIXTURES, 'formatINR.json'), inputs.map((n) => [n === undefined ? '__undefined__' : n, formatINR(n)]));
	writeJSON(
		path.join(FIXTURES, 'productBySlug.json'),
		['cornflakes', 'health-mix', 'nope', '', null].map((s) => [s, productBySlug(s)?.slug ?? null])
	);

	let gitHead = null;
	try {
		gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
	} catch {}
	const sources = [...Object.values(LEGACY_MODULES), ...new Set(SVELTE_ARRAYS.map((a) => a.file))];
	writeJSON(path.join(FIXTURES, 'manifest.json'), {
		note: 'Frozen copy of the pre-CMS catalog (data modules + hard-coded page arrays). Never regenerate from the adapters.',
		frozenAt: new Date().toISOString(),
		gitHead,
		sources: Object.fromEntries(sources.map((f) => [f, sha256(path.join(ROOT, f))])),
		files: [...Object.keys(out).map((k) => k + '.json'), 'formatINR.json', 'productBySlug.json']
	});
	console.log(`froze ${Object.keys(out).length} datasets → ${rel(FIXTURES)}`);
}

/* ------------------------------------------------------------------- build */

// Pack maths for refill timing (owner-supplied). Health Mix pack weight is not
// known yet (its packSize is null too) — owner to confirm.
const PACK = {
	cornflakes: { packGrams: 500, servingGrams: 30 },
	'steel-cut-oats': { packGrams: 500, servingGrams: 40 },
	'rolled-oats': { packGrams: 500, servingGrams: 40 },
	muesli: { packGrams: 400, servingGrams: 45 },
	'choco-flakes': { packGrams: 250, servingGrams: 30 },
	'health-mix': { packGrams: null, servingGrams: 30 }
};
/** Days one eater takes to finish a pack: round(packGrams / servingGrams / 0.8); null when unknown. */
export const daysPerPack = (packGrams, servingGrams) =>
	packGrams && servingGrams ? Math.round(packGrams / servingGrams / 0.8) : null;

const DRAFT = '<p><strong>Draft — to be reviewed by Wefeasto before publishing.</strong></p>';
const TODO = '[to be added]';

const escapeHtml = (s) =>
	String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const orTodo = (s) => (s ? escapeHtml(s) : TODO);
/** '+919845262777' → '+91 98452 62777' (other formats are shown as stored). */
const displayPhone = (e164) => (/^\+91\d{10}$/.test(e164) ? `+91 ${e164.slice(3, 8)} ${e164.slice(8)}` : e164);
const inr = (paise) => derive.formatINR(paise / 100);

/**
 * Unpublished policy drafts, worded from the public settings (owner reviews
 * before publishing) → the policy-drafts.server.json object.
 */
export function policyDrafts(settings) {
	const whatsapp = settings.supportWhatsappE164
		? `message us on WhatsApp at ${escapeHtml(displayPhone(settings.supportWhatsappE164))}`
		: 'contact us';
	const cod = settings.codEnabled
		? `<h2>Cash on Delivery</h2><p>Cash on Delivery is available on orders up to ${inr(settings.codMaxPaise)} where our courier partner serves your PIN code${
				settings.codFeePaise ? `, for a fee of ${inr(settings.codFeePaise)}` : ', at no extra charge'
			}.</p>`
		: '';
	const legal = settings.legal;
	const officer = legal.grievanceOfficer;

	const pages = [
		{
			slug: 'shipping',
			title: 'Shipping Policy',
			bodyHtml: [
				DRAFT,
				'<h2>Where we deliver</h2><p>We deliver to serviceable PIN codes across India. If we can’t deliver to your PIN code, checkout tells you before you pay.</p>',
				`<h2>When your order arrives</h2><p>${escapeHtml(settings.shippingPromiseText)}. Orders are packed and handed to our courier partner on working days; remote areas can take a little longer.</p>`,
				`<h2>Delivery charges</h2><p>Delivery is free on orders of ${inr(settings.freeDeliveryThresholdPaise)} or more (the value of your items before any discount). Orders below ${inr(settings.freeDeliveryThresholdPaise)} carry a delivery charge of ${inr(settings.deliveryFeePaise)}, shown in your bag and at checkout before you pay.</p>`,
				cod,
				`<h2>Tracking your order</h2><p>Your order confirmation email has a link to follow your order. For anything else, ${whatsapp} with your order number (it starts with WF-).</p>`,
				'<h2>Damaged or missing parcels</h2><p>If your parcel arrives damaged, opened or incomplete, please take a photo and tell us within 48 hours of delivery — our Refunds &amp; Cancellations policy explains what happens next.</p>'
			].join('')
		},
		{
			slug: 'refunds',
			title: 'Refunds & Cancellations',
			bodyHtml: [
				DRAFT,
				`<h2>Cancelling an order</h2><p>You can cancel an order until it is shipped — ${whatsapp} with your order number (it starts with WF-). Prepaid orders cancelled before dispatch are refunded in full.</p>`,
				'<h2>Returns</h2><p>Our cereals are food, so we can’t take back opened packs. If something is wrong with your order — a damaged or leaking pack, a wrong or missing item, or a product past its best-before date — tell us within 48 hours of delivery with your order number and a photo, and we’ll send a replacement or refund it.</p>',
				'<h2>How refunds are paid</h2><p>Refunds for prepaid orders go back to the original payment method (UPI, card or net banking). We start the refund within 2 working days of approving it, and banks usually show it within 5–7 working days. Cash on Delivery orders are refunded to a UPI ID or bank account you share with us.</p>',
				'<h2>Charged but no order?</h2><p>If money left your account but you didn’t receive an order confirmation, the payment is refunded to you — usually within 5–7 working days. Write to us with the payment reference if it hasn’t arrived.</p>'
			].join('')
		},
		{
			slug: 'grievances',
			title: 'Grievance Redressal',
			bodyHtml: [
				DRAFT,
				'<p>In line with the Consumer Protection (E-Commerce) Rules, 2020, you can reach our Grievance Officer with any complaint about an order, a product or this website.</p>',
				`<h2>Grievance Officer</h2><p>Name: ${orTodo(officer.name)}<br>Designation: ${orTodo(officer.designation)}<br>Email: ${orTodo(officer.email)}<br>Phone: ${orTodo(officer.phone)}</p>`,
				`<h2>Seller details</h2><p>Registered name: ${orTodo(legal.entityName)}<br>Address: ${orTodo(legal.address)}<br>FSSAI licence no.: ${orTodo(legal.fssaiLicence)}<br>GSTIN: ${orTodo(legal.gstin)}</p>`,
				'<h2>How we handle complaints</h2><p>We acknowledge every complaint within 48 hours and resolve it within one month of receiving it. Please include your order number (it starts with WF-) so we can find your order quickly.</p>',
				`<h2>Quick help</h2><p>For questions about an order, ${whatsapp}.</p>`
			].join('')
		}
	];
	return { version: schema.POLICY_DRAFTS_VERSION, pages: pages.map((page) => ({ ...page, published: false })) };
}

function loadFixtures() {
	const manifest = readJSON(path.join(FIXTURES, 'manifest.json'));
	const data = {};
	for (const file of manifest.files) data[file.replace(/\.json$/, '')] = readJSON(path.join(FIXTURES, file));
	return data;
}

const pick = (list, pred, what) => {
	const hit = list.filter(pred);
	if (hit.length > 1) throw new Error(`ambiguous ${what}`);
	return hit[0] ?? null;
};

/** Frozen legacy datasets → snapshot (generatedAt left to the caller). */
export function snapshotFromLegacy(legacy) {
	const settings = structuredClone(schema.PUBLIC_SETTINGS_DEFAULTS);
	const heroAltOf = Object.fromEntries(legacy.products.map((p) => [p.slug, legacy.productsContent[p.slug].heroAlt]));
	const ratingOf = Object.fromEntries(legacy.products.map((p) => [p.slug, p.rating]));

	const products = legacy.products.map((p, i) => {
		const content = legacy.productsContent[p.slug];
		const shop = pick(legacy['shop-items'], (x) => x.slug === p.slug, `shop item ${p.slug}`);
		const home = pick(legacy['home-bestsellers'], (x) => x.url === p.url, `bestseller ${p.slug}`);
		const pack = PACK[p.slug];
		if (!content || !shop || !pack) throw new Error(`no content/shop card/pack data for product ${p.slug}`);
		if (!Number.isInteger(p.price * 100)) throw new Error(`${p.slug}: price ${p.price} is not a whole number of paise`);
		return {
			slug: p.slug,
			name: p.name,
			sortOrder: (i + 1) * 10,
			category: p.category,
			pricePaise: p.price * 100,
			inStock: true,
			maxPerOrder: 10,
			codAllowed: true,
			packSize: p.packSize,
			calories: p.calories,
			rating: p.rating,
			ratingSource: null,
			description: p.description,
			image: p.image,
			heroAlt: content.heroAlt,
			shopAlt: shop.alt,
			homeFeatured: Boolean(home),
			homeAlt: home ? home.alt : null,
			recipesHeading: content.recipesHeading,
			partners: p.partners,
			searchTerms: p.searchTerms,
			goesWith: content.goesWith.map((card) => card.slug),
			packGrams: pack.packGrams,
			servingGrams: pack.servingGrams,
			daysPerPack: daysPerPack(pack.packGrams, pack.servingGrams),
			// Legal-style disclosures: only what a source gives. Net quantity is the
			// legacy pack size; the rest (country of origin included) stays null
			// until the owner supplies it.
			facts: {
				netQuantity: p.packSize,
				ingredients: null,
				allergens: [],
				bestBefore: null,
				manufacturer: null,
				countryOfOrigin: null
			}
		};
	});

	const recipes = legacy.recipes.map((r, i) => {
		const slug = r.url.replace(/^\/recipes\//, '');
		const content = legacy.recipesContent[slug];
		if (!content) throw new Error(`no recipes-content entry for ${slug}`);
		const home = pick(legacy['home-kitchenRecipes'], (x) => x.url === r.url, `kitchen recipe ${slug}`);
		const prep = content.card.prepLine.match(/^Prep (.+) · Cook (.+)$/);
		const serves = content.card.serves.match(/^Serves (.+)$/);
		if (!prep || !serves) throw new Error(`${slug}: unexpected prepLine/serves format`);
		return {
			slug,
			title: r.title,
			sortOrder: (i + 1) * 10,
			category: r.category,
			description: r.description,
			image: r.image,
			heroAlt: content.heroAlt,
			cardAlt: content.card.cardAlt,
			homeFeatured: Boolean(home),
			homeAlt: home ? home.alt : null,
			tagColor: content.tagColor,
			iconColor: content.card.iconColor,
			iconSrc: content.card.iconSrc,
			iconAlt: content.card.iconAlt,
			prepTime: prep[1],
			cookTime: prep[2],
			serves: serves[1],
			intro: content.intro,
			ingredientsHtml: content.ingredientsHtml,
			directionsHtml: content.directionsHtml,
			whyHtml: content.whyHtml,
			authorBio: content.authorBio,
			// Only record where a card departs from the product's defaults.
			products: content.shopIngredients.map((card) => {
				const rating = ratingOf[card.slug];
				let ratingStyle = 'decimal';
				if (card.starsAria !== derive.ratingAria(rating, 'decimal')) {
					if (card.starsAria !== derive.ratingAria(rating, 'plain')) throw new Error(`${slug}: unexpected starsAria ${card.starsAria}`);
					ratingStyle = 'plain';
				}
				return { slug: card.slug, alt: card.alt === heroAltOf[card.slug] ? null : card.alt, ratingStyle };
			}),
			extrasHeading: content.extrasHeading,
			extrasIntro: content.extrasIntro,
			extras: content.extras,
			recommendedHeading: content.recommendedHeading,
			recommendedIntro: content.recommendedIntro,
			recommended: content.recommended,
			related: content.related,
			searchTerms: r.searchTerms
		};
	});

	// No policy page is published yet: the drafts go to policyDrafts(), never here.
	return { version: schema.SNAPSHOT_VERSION, generatedAt: null, settings, products, recipes, pages: [] };
}

/** Every legacy dataset the snapshot must reproduce, re-derived from it. */
export function deriveLegacy(snapshot) {
	return {
		products: derive.buildProducts(snapshot),
		recipes: derive.buildRecipes(snapshot),
		productsContent: derive.buildProductsContent(snapshot),
		recipesContent: derive.buildRecipesContent(snapshot),
		'home-bestsellers': derive.buildHomeBestsellers(snapshot),
		'home-kitchenRecipes': derive.buildKitchenRecipes(snapshot),
		'shop-items': derive.buildShopItems(snapshot)
	};
}

function assertReproducesLegacy(snapshot, legacy) {
	const derived = deriveLegacy(snapshot);
	const bad = Object.keys(derived).filter((k) => JSON.stringify(derived[k]) !== JSON.stringify(legacy[k]));
	if (bad.length) throw new Error(`snapshot does not reproduce legacy ${bad.join(', ')} exactly`);
}

const readIfExists = (p) => {
	try {
		return readJSON(p);
	} catch {
		return null;
	}
};

/** Both generated files as text, `{ snapshot, drafts }`: validated, and the snapshot reproduces legacy. */
export function generate({ snapshotPath = SNAPSHOT } = {}) {
	const legacy = loadFixtures();
	const snapshot = snapshotFromLegacy(legacy);
	// Keep the committed timestamp when nothing else changed (no churn in git).
	let generatedAt = new Date().toISOString();
	const current = readIfExists(snapshotPath);
	if (current && isDeepStrictEqual({ ...current, generatedAt: null }, snapshot)) generatedAt = current.generatedAt;
	snapshot.generatedAt = generatedAt;
	const { ok, errors } = schema.validateSnapshot(snapshot);
	if (!ok) throw new Error('generated snapshot is invalid:\n  ' + errors.join('\n  '));
	assertReproducesLegacy(snapshot, legacy);

	const drafts = policyDrafts(snapshot.settings);
	const checked = schema.validatePolicyDrafts(drafts);
	if (!checked.ok) throw new Error('generated policy drafts are invalid:\n  ' + checked.errors.join('\n  '));
	return { snapshot: schema.serializeSnapshot(snapshot), drafts: schema.serializePolicyDrafts(drafts) };
}

function build() {
	const out = generate();
	fs.writeFileSync(SNAPSHOT, out.snapshot);
	fs.writeFileSync(DRAFTS, out.drafts);
	const s = JSON.parse(out.snapshot);
	const d = JSON.parse(out.drafts);
	console.log(`wrote ${rel(SNAPSHOT)}: ${s.products.length} products, ${s.recipes.length} recipes, ${s.pages.length} pages (valid, reproduces legacy)`);
	console.log(`wrote ${rel(DRAFTS)}: ${d.pages.length} unpublished policy drafts (valid)`);
}

/** Throws unless both committed files match what `build` would write (the snapshot's generatedAt ignored). */
export function checkCommitted({ snapshotPath = SNAPSHOT, draftsPath = DRAFTS } = {}) {
	const expected = generate({ snapshotPath });
	const actual = readIfExists(snapshotPath);
	if (!actual || !isDeepStrictEqual({ ...actual, generatedAt: null }, { ...JSON.parse(expected.snapshot), generatedAt: null })) {
		throw new Error(`${rel(snapshotPath)} is out of date — run: node scripts/legacy-to-snapshot.mjs build`);
	}
	const draftsText = fs.existsSync(draftsPath) ? fs.readFileSync(draftsPath, 'utf8') : null;
	if (draftsText !== expected.drafts) {
		throw new Error(`${rel(draftsPath)} is out of date — run: node scripts/legacy-to-snapshot.mjs build`);
	}
	return [`${rel(snapshotPath)} is up to date`, `${rel(draftsPath)} is up to date`];
}

/* ------------------------------------------------------------------- main */

async function main([cmd, ...flags]) {
	if (cmd === 'freeze') return freeze(flags.includes('--force'));
	if (cmd === 'build') return build();
	if (cmd === 'check') return checkCommitted().forEach((line) => console.log(line));
	console.error('usage: legacy-to-snapshot.mjs freeze [--force] | build | check');
	process.exit(2);
}

// Also importable (tests reuse snapshotFromLegacy / deriveLegacy): only run as a CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main(process.argv.slice(2));
	} catch (err) {
		console.error('legacy-to-snapshot: ' + err.message);
		process.exit(1);
	}
}
