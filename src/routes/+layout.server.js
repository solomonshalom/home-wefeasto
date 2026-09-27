/*
 * Footer data for every page (roadmap M7), resolved at prerender time from the
 * CMS snapshot: links to the published policy pages that have a route, and
 * the legal line's entity name and FSSAI licence (empty strings = not set:
 * the footer then keeps "Wefeasto" and no licence). Returns only what the
 * footer renders; policy bodies stay server-side (pages.server.js).
 */
import { publishedPages } from '$lib/data/pages.server.js';
import { settings } from '$lib/data/settings.js';
import { routablePages } from '../params/policy.js';

const text = (v) => (typeof v === 'string' ? v.trim() : '');

export function load() {
	const fssai = text(settings.legal?.fssaiLicence);
	return {
		footerPages: routablePages(publishedPages).map(({ slug, title }) => ({ slug, title })),
		legal: {
			entityName: text(settings.legal?.entityName),
			fssaiLicence: /^\d{14}$/.test(fssai) ? fssai : ''
		}
	};
}
