/*
 * Catalog snapshot schema — the CMS ↔ storefront content contract (SPEC §3).
 * Pure ESM, no imports: used by the storefront adapters' tests, by
 * scripts/legacy-to-snapshot.mjs and by the CMS sync (scripts/sync-cms.mjs) to
 * validate a snapshot and to write it with a stable key order.
 * Also the schema of policy-drafts.server.json, the unpublished policy pages
 * the CMS seed starts from (never part of the snapshot, which is public).
 * Human-readable version: SCRATCH/contracts/snapshot-schema.md.
 */

export const SNAPSHOT_VERSION = 1;
export const POLICY_DRAFTS_VERSION = 1;

// Text that marks a page as not yet reviewed by the owner: the Draft line the
// policy drafts open with, and the "[to be added]" placeholders for missing
// legal details. A page carrying either can never be published.
export const UNREVIEWED_TEXT_RE = /Draft\s*[—–-]+\s*to be reviewed|\[\s*to be added\s*\]/i;

export const PRODUCT_CATEGORIES = ['Flakes', 'Oats', 'Muesli', 'Mix']; // = the /shop filter chips
export const RECIPE_CATEGORIES = ['Breakfast', 'Kids', 'Snacks', 'Desserts']; // = the /recipes filter chips

// Recipe tag / icon chip colours. The first four are the colour-mix accent ring
// (src/lib/colormix.js) and are what new content should use; the last two are
// legacy spellings kept so today's pages stay byte-identical.
export const RECIPE_COLORS = ['#ff8d5e', '#ffc33a', '#d499eb', '#2cdb69', '#d498eb', 'hsla(141, 70.74%, 51.53%, 1.00)'];

// How a mini product card spells its star rating for screen readers:
// 'decimal' → "Rated 4.0 out of 5", 'plain' → "Rated 4 out of 5".
export const RATING_STYLES = ['decimal', 'plain'];

// Public store settings, with today's values. Key set and nesting are exact:
// the shared commerce module and the CMS global use these names.
export const PUBLIC_SETTINGS_DEFAULTS = {
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

// Live only in the CMS `store-settings` global — never in a snapshot or public API.
export const SERVER_ONLY_SETTINGS_DEFAULTS = {
	reservationMinutes: 30,
	blockedPinPrefixes: [],
	codBlockedPinPrefixes: [],
	codMaxOpenPerPhone: 2
};

// Product fields that exist in the CMS but must never be published.
const SERVER_ONLY_PRODUCT_FIELDS = ['stock', 'lowStockThreshold'];

/* ---------------------------------------------------------------- schema
 * A small declarative schema: it drives validation AND the canonical key
 * order (object fields are listed in the order they are written). */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH_OR_URL_RE = /^(\/(?!\/)|https:\/\/)\S*$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FSSAI_RE = /^\d{14}$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// {@html} is rendered verbatim, so the published HTML may not carry script. Kept identical to the CMS's
// UNSAFE_HTML_RE (cms/src/endpoints/catalog/rules.ts, same builder; drift-tested there): the tags below,
// on…= handlers after whitespace, "/" or a closing quote (<svg/onload=…>), javascript: with any letter as
// a numeric character reference of either case (schemes are case-insensitive: &#106; and &#74; are both
// "j") and tab/LF/CR between letters (jav&#x61;script:, &#74;avascript:, java&#9;script:), data:text/html.
const htmlChar = (/** @type {string} */ c) => {
	const codes = [...new Set([c.toLowerCase().charCodeAt(0), c.toUpperCase().charCodeAt(0)])];
	const refs = codes.map((code) => `&#0*${code};?|&#x0*${code.toString(16)};?`).join('|');
	return `(?:${c === ':' ? ':|&colon;' : c}|${refs})`;
};
const URL_GAP = '(?:[\\t\\n\\r]|&#0*(?:9|10|13);?|&#x0*[9ad];?|&tab;|&newline;)*';
const JS_SCHEME = [...'javascript:'].map(htmlChar).join(URL_GAP);
const UNSAFE_HTML_RE = new RegExp(
	`<\\s*(?:script|iframe|object|embed|style|link|meta|base|form)\\b|[\\s/"']on[a-z]+\\s*=|${JS_SCHEME}|data:text\\/html`,
	'i'
);

const str = (extra) => ({ type: 'string', ...extra }); // non-empty unless empty:true
const text = (extra) => str({ empty: true, ...extra }); // may be ''
const html = () => str({ html: true });
const bool = () => ({ type: 'boolean' });
const int = (extra) => ({ type: 'integer', min: 0, ...extra });
const num = (extra) => ({ type: 'number', ...extra });
const oneOf = (values) => ({ type: 'enum', values });
const nullable = (spec) => ({ ...spec, nullable: true });
const arrayOf = (of, extra) => ({ type: 'array', of, ...extra });
const object = (fields) => ({ type: 'object', fields });
const slug = () => str({ pattern: SLUG_RE, patternHint: 'lower-case kebab-case slug' });
const pathOrUrl = () => str({ pattern: PATH_OR_URL_RE, patternHint: 'root-relative path or https URL' });
const optional = (re, hint) => text({ pattern: new RegExp(`^$|${re.source}`), patternHint: `'' or ${hint}` });

const SETTINGS = object({
	freeDeliveryThresholdPaise: int(),
	deliveryFeePaise: int(),
	codEnabled: bool(),
	codMaxPaise: int(),
	codFeePaise: int(),
	codMinSubtotalPaise: int(),
	maxOrderPaise: int({ min: 1 }),
	topUpDiscoveryBiasPaise: int(),
	shippingPromiseText: text(),
	announcement: object({ enabled: bool(), text: text(), href: optional(PATH_OR_URL_RE, 'root-relative path or https URL') }),
	supportWhatsappE164: optional(E164_RE, 'E.164 number (+91…)'),
	legal: object({
		entityName: text(),
		address: text(),
		fssaiLicence: optional(FSSAI_RE, '14-digit FSSAI licence number'),
		gstin: optional(GSTIN_RE, '15-character GSTIN'),
		grievanceOfficer: object({
			name: text(),
			designation: text(),
			email: optional(EMAIL_RE, 'email address'),
			phone: text()
		})
	}),
	welcomeOffer: object({ percent: int({ min: 1, max: 100 }), maxDiscountPaise: int(), validDays: int({ min: 1 }) })
});

const PRODUCT = object({
	slug: slug(),
	name: str(),
	sortOrder: int(),
	category: oneOf(PRODUCT_CATEGORIES),
	pricePaise: int({ min: 100, multipleOf: 100 }),
	inStock: bool(),
	maxPerOrder: int({ min: 1 }),
	codAllowed: bool(),
	packSize: nullable(str()),
	calories: int(),
	rating: num({ min: 0, max: 5, decimals: 1 }),
	ratingSource: nullable(str()),
	description: str(),
	image: pathOrUrl(),
	heroAlt: str(),
	shopAlt: str(),
	homeFeatured: bool(),
	homeAlt: nullable(str()),
	recipesHeading: str(),
	partners: arrayOf(object({ name: str(), url: str({ pattern: /^https:\/\/\S+$/, patternHint: 'https URL' }) })),
	searchTerms: arrayOf(str()),
	goesWith: arrayOf(slug()),
	packGrams: nullable(int({ min: 1 })),
	servingGrams: nullable(int({ min: 1 })),
	daysPerPack: nullable(int({ min: 1 })),
	facts: object({
		netQuantity: nullable(str()),
		ingredients: nullable(str()),
		allergens: arrayOf(str()),
		bestBefore: nullable(str()),
		manufacturer: nullable(str()),
		countryOfOrigin: nullable(str())
	})
});

const TITLED_REASON = object({ title: str(), reason: str() });

const RECIPE = object({
	slug: slug(),
	title: str(),
	sortOrder: int(),
	category: oneOf(RECIPE_CATEGORIES),
	description: str(),
	image: pathOrUrl(),
	heroAlt: str(),
	cardAlt: str(),
	homeFeatured: bool(),
	homeAlt: nullable(str()),
	tagColor: oneOf(RECIPE_COLORS),
	iconColor: oneOf(RECIPE_COLORS),
	iconSrc: pathOrUrl(),
	iconAlt: str(),
	prepTime: str(),
	cookTime: str(),
	serves: str(),
	intro: str(),
	ingredientsHtml: html(),
	directionsHtml: html(),
	whyHtml: html(),
	authorBio: str(),
	products: arrayOf(object({ slug: slug(), alt: nullable(str()), ratingStyle: oneOf(RATING_STYLES) })),
	extrasHeading: str(),
	extrasIntro: str(),
	extras: arrayOf(TITLED_REASON),
	recommendedHeading: str(),
	recommendedIntro: str(),
	recommended: arrayOf(TITLED_REASON),
	related: arrayOf(slug()),
	searchTerms: arrayOf(str())
});

// Same shape in the snapshot (published pages only) and in the drafts file
// (unpublished only); validateSnapshot / validatePolicyDrafts check `published`.
const PAGE = object({ slug: slug(), title: str(), bodyHtml: html(), published: bool() });

export const SNAPSHOT_SCHEMA = object({
	version: int({ min: SNAPSHOT_VERSION, max: SNAPSHOT_VERSION }),
	generatedAt: str({ isoDate: true }),
	settings: SETTINGS,
	products: arrayOf(PRODUCT, { minItems: 1 }),
	recipes: arrayOf(RECIPE),
	pages: arrayOf(PAGE)
});

export const POLICY_DRAFTS_SCHEMA = object({
	version: int({ min: POLICY_DRAFTS_VERSION, max: POLICY_DRAFTS_VERSION }),
	pages: arrayOf(PAGE)
});

/* ------------------------------------------------------------ validation */

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function check(spec, value, path, errors) {
	const fail = (msg) => errors.push(`${path || '(root)'}: ${msg}`);
	if (value === null || value === undefined) {
		if (value === null && spec.nullable) return;
		return fail(`required ${spec.type}${spec.nullable ? ' or null' : ''}, got ${typeName(value)}`);
	}
	switch (spec.type) {
		case 'string':
			if (typeof value !== 'string') return fail(`expected string, got ${typeName(value)}`);
			if (!spec.empty && value.trim() === '') return fail('must not be empty');
			if (spec.pattern && !spec.pattern.test(value)) return fail(`expected ${spec.patternHint}, got ${JSON.stringify(value)}`);
			if (spec.isoDate && Number.isNaN(Date.parse(value))) return fail(`expected an ISO date, got ${JSON.stringify(value)}`);
			if (spec.html && UNSAFE_HTML_RE.test(value)) return fail('HTML contains script, event handlers or other unsafe markup');
			return;
		case 'boolean':
			if (typeof value !== 'boolean') fail(`expected boolean, got ${typeName(value)}`);
			return;
		case 'integer':
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`expected ${spec.type}, got ${typeName(value)}`);
			if (spec.type === 'integer' && !Number.isInteger(value)) return fail(`expected integer, got ${value}`);
			if (spec.min !== undefined && value < spec.min) return fail(`must be ≥ ${spec.min}, got ${value}`);
			if (spec.max !== undefined && value > spec.max) return fail(`must be ≤ ${spec.max}, got ${value}`);
			if (spec.multipleOf && value % spec.multipleOf !== 0) return fail(`must be a multiple of ${spec.multipleOf}, got ${value}`);
			if (spec.decimals !== undefined && Math.abs(value * 10 ** spec.decimals - Math.round(value * 10 ** spec.decimals)) > 1e-9) {
				return fail(`at most ${spec.decimals} decimal place(s), got ${value}`);
			}
			return;
		case 'enum':
			if (!spec.values.includes(value)) fail(`expected one of ${spec.values.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`);
			return;
		case 'array':
			if (!Array.isArray(value)) return fail(`expected array, got ${typeName(value)}`);
			if (spec.minItems && value.length < spec.minItems) return fail(`needs at least ${spec.minItems} item(s)`);
			value.forEach((item, i) => check(spec.of, item, `${path}[${i}]`, errors));
			return;
		case 'object': {
			if (typeName(value) !== 'object') return fail(`expected object, got ${typeName(value)}`);
			for (const [key, child] of Object.entries(spec.fields)) {
				check(child, value[key], path ? `${path}.${key}` : key, errors);
			}
			for (const key of Object.keys(value)) {
				if (!has(spec.fields, key)) fail(`unknown field ${JSON.stringify(key)}`);
			}
			return;
		}
		default:
			throw new Error(`snapshot-schema: unknown spec type ${spec.type}`);
	}
}

function uniqueSlugs(list, label, errors) {
	const seen = new Set();
	list.forEach((item, i) => {
		if (seen.has(item?.slug)) errors.push(`${label}[${i}].slug: duplicate slug ${JSON.stringify(item.slug)}`);
		seen.add(item?.slug);
	});
	return seen;
}

function refs(list, path, known, self, errors, what) {
	const seen = new Set();
	list.forEach((ref, i) => {
		if (!known.has(ref)) errors.push(`${path}[${i}]: unknown ${what} ${JSON.stringify(ref)}`);
		if (ref === self) errors.push(`${path}[${i}]: must not reference itself`);
		if (seen.has(ref)) errors.push(`${path}[${i}]: duplicate reference ${JSON.stringify(ref)}`);
		seen.add(ref);
	});
}

function sortedBySortOrder(list, label, errors) {
	for (let i = 1; i < list.length; i++) {
		if (!(list[i].sortOrder > list[i - 1].sortOrder)) {
			errors.push(`${label}[${i}].sortOrder: array must be ordered by strictly increasing sortOrder`);
		}
	}
}

/**
 * Validate a snapshot. Structural errors first; relationship checks only run
 * once the structure is sound (so every message points at a real cause).
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSnapshot(snapshot) {
	const errors = [];
	if (typeName(snapshot) === 'object' && typeName(snapshot.settings) === 'object') {
		for (const key of Object.keys(SERVER_ONLY_SETTINGS_DEFAULTS)) {
			if (has(snapshot.settings, key)) errors.push(`settings.${key}: server-only setting must not be published`);
		}
	}
	if (typeName(snapshot) === 'object' && Array.isArray(snapshot.products)) {
		snapshot.products.forEach((p, i) => {
			for (const key of SERVER_ONLY_PRODUCT_FIELDS) {
				if (p && has(p, key)) errors.push(`products[${i}].${key}: server-only field must not be published`);
			}
		});
	}
	check(SNAPSHOT_SCHEMA, snapshot, '', errors);
	if (errors.length) return { ok: false, errors };

	const { settings, products, recipes, pages } = snapshot;
	const productSlugs = uniqueSlugs(products, 'products', errors);
	const recipeSlugs = uniqueSlugs(recipes, 'recipes', errors);
	uniqueSlugs(pages, 'pages', errors);
	sortedBySortOrder(products, 'products', errors);
	sortedBySortOrder(recipes, 'recipes', errors);

	products.forEach((p, i) => {
		const at = `products[${i}]`;
		refs(p.goesWith, `${at}.goesWith`, productSlugs, p.slug, errors, 'product');
		if (p.homeFeatured && p.homeAlt === null) errors.push(`${at}.homeAlt: required when homeFeatured`);
	});
	recipes.forEach((r, i) => {
		const at = `recipes[${i}]`;
		refs(r.products.map((x) => x.slug), `${at}.products`, productSlugs, null, errors, 'product');
		refs(r.related, `${at}.related`, recipeSlugs, r.slug, errors, 'recipe');
		if (r.homeFeatured && r.homeAlt === null) errors.push(`${at}.homeAlt: required when homeFeatured`);
	});
	// The snapshot is public (GET /api/store/snapshot, the storefront's JS), so
	// it carries reviewed, storefront-visible pages only.
	pages.forEach((page, i) => {
		if (page.published !== true) {
			errors.push(`pages[${i}].published: must be true — unpublished pages never enter the snapshot (drafts: policy-drafts.server.json)`);
		}
		unreviewed(page, `pages[${i}]`, errors);
	});
	if (settings.announcement.enabled && settings.announcement.text.trim() === '') {
		errors.push('settings.announcement.text: required when the announcement is enabled');
	}
	return { ok: errors.length === 0, errors };
}

function unreviewed(page, at, errors) {
	for (const key of ['title', 'bodyHtml']) {
		const hit = page[key].match(UNREVIEWED_TEXT_RE);
		if (hit) errors.push(`${at}.${key}: still contains ${JSON.stringify(hit[0])} — the owner must review the page (and remove it) before publishing`);
	}
}

/**
 * Validate policy-drafts.server.json: `{version: 1, pages[]}` of unpublished
 * pages (same page shape as the snapshot) that the CMS seed creates for the
 * owner to review. Server-side input only — never served, never bundled.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePolicyDrafts(drafts) {
	const errors = [];
	check(POLICY_DRAFTS_SCHEMA, drafts, '', errors);
	if (errors.length) return { ok: false, errors };
	uniqueSlugs(drafts.pages, 'pages', errors);
	drafts.pages.forEach((page, i) => {
		if (page.published !== false) errors.push(`pages[${i}].published: must be false — a draft is published through the CMS, not this file`);
	});
	return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------- stable output */

function canonical(spec, value) {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((item) => canonical(spec?.type === 'array' ? spec.of : undefined, item));
	const fields = spec?.type === 'object' ? spec.fields : {};
	const out = {};
	for (const key of Object.keys(fields)) if (has(value, key)) out[key] = canonical(fields[key], value[key]);
	for (const key of Object.keys(value).filter((k) => !has(fields, k)).sort()) out[key] = canonical(undefined, value[key]);
	return out;
}

/** Deep copy with every object's keys in schema order (unknown keys last, sorted). */
export function canonicalSnapshot(snapshot) {
	return canonical(SNAPSHOT_SCHEMA, snapshot);
}

/** The committed file format: canonical key order, 2-space JSON, trailing newline. */
export function serializeSnapshot(snapshot) {
	return JSON.stringify(canonicalSnapshot(snapshot), null, 2) + '\n';
}

/** policy-drafts.server.json in the same stable format. */
export function serializePolicyDrafts(drafts) {
	return JSON.stringify(canonical(POLICY_DRAFTS_SCHEMA, drafts), null, 2) + '\n';
}
