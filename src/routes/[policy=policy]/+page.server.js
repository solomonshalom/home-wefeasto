/*
 * Policy pages from the CMS snapshot (roadmap M7), prerendered at build time.
 * `entries` lists only published, routable pages, so an unpublished page is
 * never built and the static host answers 404 for it; with none published the
 * route builds nothing (allowed for this route only: handleUnseenRoutes in
 * svelte.config.js). Server-only: the page body never ships in a JS chunk,
 * only in its own prerendered HTML (and that page's __data.json).
 */
import { error } from '@sveltejs/kit';
import { publishedPages, publishedPage } from '$lib/data/pages.server.js';
import { settings } from '$lib/data/settings.js';
import { whatsappLink } from '$lib/support.js';
import { routablePages, isRoutablePage } from '../../params/policy.js';
import { grievanceOfficer, sellerDetails } from './legal.js';

export const prerender = true;

export function entries() {
	return routablePages(publishedPages).map((p) => ({ policy: p.slug }));
}

/** @param {{ params: { policy: string } }} event */
export function load({ params }) {
	const links = routablePages(publishedPages).map(({ slug, title }) => ({ slug, title }));
	const whatsapp = whatsappLink('Hi Wefeasto, I have a question about your store policies.');
	const page = publishedPage(params.policy);
	if (!page || !isRoutablePage(page)) error(404, 'Not found');
	const isGrievances = page.slug === 'grievances';
	return {
		slug: page.slug,
		title: page.title,
		bodyHtml: page.bodyHtml,
		links,
		seller: isGrievances ? sellerDetails(settings.legal) : null,
		grievance: isGrievances ? grievanceOfficer(settings.legal) : null,
		whatsapp: isGrievances ? whatsappLink('Hi Wefeasto, I’d like to raise a complaint.') : whatsapp
	};
}
