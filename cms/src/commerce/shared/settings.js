/*
 * Wefeasto store settings — canonical keys + defaults shared by the storefront
 * snapshot (`snapshot.settings`), GET /api/store/catalog and the CMS
 * `store-settings` global.
 *
 * PUBLIC keys may ship to the browser. SERVER keys (reservation TTL, blocked
 * PIN prefixes, open-COD cap) must never leave the CMS: use publicSettings()
 * when serialising settings for the snapshot or any public endpoint.
 *
 * resolveSettings() is forgiving on purpose: a missing or malformed value falls
 * back to its default instead of corrupting totals (money stays integer paise).
 */

/**
 * @typedef {object} GrievanceOfficer
 * @property {string} name
 * @property {string} designation
 * @property {string} email
 * @property {string} phone
 */

/**
 * @typedef {object} PublicSettings
 * @property {number} freeDeliveryThresholdPaise  Free delivery when the PRE-discount subtotal reaches this.
 * @property {number} deliveryFeePaise
 * @property {boolean} codEnabled
 * @property {number} codMaxPaise                COD only when the COD total (incl. COD fee) is <= this.
 * @property {number} codFeePaise
 * @property {number} codMinSubtotalPaise
 * @property {number} maxOrderPaise              Orders above this total are refused (ABOVE_MAX).
 * @property {number} topUpDiscoveryBiasPaise    Top-up penalty for suggesting a SKU already in the bag.
 * @property {string} shippingPromiseText
 * @property {{enabled: boolean, text: string, href: string}} announcement
 * @property {string} supportWhatsappE164
 * @property {{entityName: string, address: string, fssaiLicence: string, gstin: string, grievanceOfficer: GrievanceOfficer}} legal
 * @property {{percent: number, maxDiscountPaise: number, validDays: number}} welcomeOffer
 */

/**
 * @typedef {object} ServerSettings
 * @property {number} reservationMinutes
 * @property {string[]} blockedPinPrefixes      No delivery at all to PINs starting with these.
 * @property {string[]} codBlockedPinPrefixes   No COD to PINs starting with these.
 * @property {number} codMaxOpenPerPhone
 */

/** @typedef {PublicSettings & ServerSettings} StoreSettings */

/** @type {Readonly<PublicSettings>} */
export const PUBLIC_SETTINGS_DEFAULTS = deepFreeze({
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
});

/** @type {Readonly<ServerSettings>} */
export const SERVER_SETTINGS_DEFAULTS = deepFreeze({
	reservationMinutes: 30,
	blockedPinPrefixes: [],
	codBlockedPinPrefixes: [],
	codMaxOpenPerPhone: 2
});

/** Top-level keys that may be exposed publicly (snapshot, catalog API). */
export const PUBLIC_SETTINGS_KEYS = Object.freeze(Object.keys(PUBLIC_SETTINGS_DEFAULTS));
/** Top-level keys that must stay on the server. */
export const SERVER_SETTINGS_KEYS = Object.freeze(Object.keys(SERVER_SETTINGS_DEFAULTS));

/* ---------- field coercers (fall back to the default on anything odd) ---------- */

/** @type {(v: any, d: number) => number} */
const paise = (v, d) => (Number.isSafeInteger(v) && v >= 0 ? v : d);
/** @type {(v: any, d: number, min: number, max: number) => number} */
const int = (v, d, min, max) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : d);
/** @type {(v: any, d: boolean) => boolean} */
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
/** @type {(v: any, d: string) => string} */
const str = (v, d) => (typeof v === 'string' ? v : d);
/** @type {(v: any) => any} */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** Digit-only PIN prefixes (1–6 digits); numbers are accepted and stringified. Empty strings are dropped — '' would block every PIN.
 * @type {(v: any) => string[]} */
const prefixes = (v) =>
	Array.isArray(v)
		? v
				.map((p) => (typeof p === 'number' && Number.isSafeInteger(p) && p >= 0 ? String(p) : p))
				.filter((p) => typeof p === 'string' && /^[0-9]{1,6}$/.test(p))
		: [];

/**
 * Merge raw settings (from the CMS global, the snapshot or a test) over the
 * defaults, coercing every field. Never throws; unknown keys are dropped.
 * Also accepts `{ blockedPinPrefixes: [{prefix:'110'}] }` (Payload array rows).
 * @param {any} [raw]
 * @returns {StoreSettings}
 */
export function resolveSettings(raw) {
	const s = obj(raw);
	const d = PUBLIC_SETTINGS_DEFAULTS;
	const ann = obj(s.announcement);
	const legal = obj(s.legal);
	const go = obj(legal.grievanceOfficer);
	const wo = obj(s.welcomeOffer);
	return {
		freeDeliveryThresholdPaise: paise(s.freeDeliveryThresholdPaise, d.freeDeliveryThresholdPaise),
		deliveryFeePaise: paise(s.deliveryFeePaise, d.deliveryFeePaise),
		codEnabled: bool(s.codEnabled, d.codEnabled),
		codMaxPaise: paise(s.codMaxPaise, d.codMaxPaise),
		codFeePaise: paise(s.codFeePaise, d.codFeePaise),
		codMinSubtotalPaise: paise(s.codMinSubtotalPaise, d.codMinSubtotalPaise),
		maxOrderPaise: paise(s.maxOrderPaise, d.maxOrderPaise),
		topUpDiscoveryBiasPaise: paise(s.topUpDiscoveryBiasPaise, d.topUpDiscoveryBiasPaise),
		shippingPromiseText: str(s.shippingPromiseText, d.shippingPromiseText),
		announcement: {
			enabled: bool(ann.enabled, d.announcement.enabled),
			text: str(ann.text, d.announcement.text),
			href: str(ann.href, d.announcement.href)
		},
		supportWhatsappE164: str(s.supportWhatsappE164, d.supportWhatsappE164),
		legal: {
			entityName: str(legal.entityName, ''),
			address: str(legal.address, ''),
			fssaiLicence: str(legal.fssaiLicence, ''),
			gstin: str(legal.gstin, ''),
			grievanceOfficer: {
				name: str(go.name, ''),
				designation: str(go.designation, ''),
				email: str(go.email, ''),
				phone: str(go.phone, '')
			}
		},
		welcomeOffer: {
			percent: int(wo.percent, d.welcomeOffer.percent, 1, 100),
			maxDiscountPaise: paise(wo.maxDiscountPaise, d.welcomeOffer.maxDiscountPaise),
			validDays: int(wo.validDays, d.welcomeOffer.validDays, 1, 3650)
		},
		reservationMinutes: int(s.reservationMinutes, SERVER_SETTINGS_DEFAULTS.reservationMinutes, 1, 24 * 60),
		blockedPinPrefixes: prefixes(unwrapRows(s.blockedPinPrefixes)),
		codBlockedPinPrefixes: prefixes(unwrapRows(s.codBlockedPinPrefixes)),
		codMaxOpenPerPhone: int(s.codMaxOpenPerPhone, SERVER_SETTINGS_DEFAULTS.codMaxOpenPerPhone, 0, 1000)
	};
}

/**
 * The public subset of resolveSettings(raw) — exactly PUBLIC_SETTINGS_KEYS.
 * Use this for snapshot.settings and GET /api/store/catalog.
 * @param {any} [raw]
 * @returns {PublicSettings}
 */
export function publicSettings(raw) {
	const all = resolveSettings(raw);
	/** @type {any} */
	const out = {};
	for (const k of PUBLIC_SETTINGS_KEYS) out[k] = /** @type {any} */ (all)[k];
	return out;
}

/**
 * Payload array fields arrive as [{prefix:'110', id:'…'}]; accept both shapes.
 * @param {any} v
 * @returns {any}
 */
function unwrapRows(v) {
	if (!Array.isArray(v)) return v;
	return v.map((r) => (r && typeof r === 'object' && 'prefix' in r ? r.prefix : r));
}

/**
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
	if (o && typeof o === 'object') {
		for (const v of Object.values(o)) deepFreeze(v);
		Object.freeze(o);
	}
	return o;
}
