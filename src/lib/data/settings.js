/*
 * Public store settings and commerce views of the CMS snapshot, for the
 * $shared pricing rules (free-delivery meter, top-up, COD).
 * Build-time values: the server re-quotes every order, so a stale snapshot can
 * never change what a customer is charged.
 * Browser code imports this module (live.js, support.js), so it takes only the
 * snapshot keys it needs: policy pages live in pages.server.js (prerender only).
 */
import { settings as snapshotSettings, products } from './cms-snapshot.json';
import { buildPricingCatalog } from './derive.js';

function deepFreeze(value) {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		Object.values(value).forEach(deepFreeze);
	}
	return value;
}

/** Snapshot settings (keys: snapshot-schema.js PUBLIC_SETTINGS_DEFAULTS). Read-only. */
export const settings = deepFreeze(JSON.parse(JSON.stringify(snapshotSettings)));

/** `[{slug, name, pricePaise, inStock, maxPerOrder, codAllowed}]` in catalog order (fresh copies). */
export function catalogForPricing() {
	return buildPricingCatalog({ products });
}

/** Snapshot price of a product in paise, or null for an unknown slug. */
export function productPaise(slug) {
	const product = products.find((p) => p.slug === slug);
	return product ? product.pricePaise : null;
}
