/*
 * /checkout status messages (WCAG 4.1.3). The summary is server-driven — a
 * top-up "+ Add", an offer that starts (or stops) applying, delivery and COD
 * fees, lines that sell out — and none of it moves focus, so the page says
 * what changed in one polite live region once the summary has settled:
 * "Added Health Mix. Offer WELCOME10 applied. Total now ₹445."
 * Pure: the page hands in settled quotes and bags, and speaks the result.
 */
import { formatPaise } from '$shared/money.js';
import { checkoutErrorCopy, couponReasonCopy } from '$shared/errors.js';

const end = (s) => (/[.!?…]$/.test(s) ? s : s + '.');

/**
 * What a status message compares between two settled summaries.
 * @param {any} q  $shared Quote (the server's, or the local stand-in)
 * @param {{ offerCode?: string|null, method?: string, nameOf?: (slug: string) => string }} [ctx]
 */
export function summarySnapshot(q, { offerCode = null, method = 'upi', nameOf = (s) => s } = {}) {
	const lines = new Map((q.lines || []).map((l) => [l.slug, l]));
	const name = (slug, issue) => lines.get(slug)?.name || (issue && issue.name && issue.name !== slug ? issue.name : null) || nameOf(slug);
	const issues = (q.issues || []).map((i) => ({ slug: i.slug, code: i.code, text: end(checkoutErrorCopy(i.code, { ...i, name: name(i.slug, i) })) }));
	let offer = null;
	if (offerCode) {
		const state = q.coupon ? 'applied' : q.couponError ? 'invalid' : 'pending';
		const why = state === 'invalid' ? end(couponReasonCopy(q.couponError.reason, { minSubtotalPaise: q.couponError.minSubtotalPaise, subtotalPaise: q.subtotalPaise })) : null;
		offer = { code: offerCode, state, why };
	}
	const blocked = issues.length > 0 && !(q.lines || []).length; // quoteView's allBlocked: every line needs a fix
	return {
		totalPaise: q.totalPaise,
		free: !!q.isFreeDelivery,
		deliveryPaise: q.deliveryPaise || 0,
		codFeePaise: method === 'cod' ? q.codFeePaise || 0 : 0,
		offer,
		issues,
		blocked
	};
}

/**
 * What the customer (or another tab) did to the bag: {slug: qty} before → after.
 * @param {Record<string, number>} prev
 * @param {Record<string, number>} next
 * @param {(slug: string) => string} nameOf
 */
export function bagChanges(prev, next, nameOf) {
	const out = [];
	const a = prev || {};
	const b = next || {};
	for (const [slug, qty] of Object.entries(b)) {
		const was = a[slug] || 0;
		if (!was) out.push(qty > 1 ? `Added ${nameOf(slug)} × ${qty}.` : `Added ${nameOf(slug)}.`);
		else if (was !== qty) out.push(`${nameOf(slug)}: quantity now ${qty}.`);
	}
	for (const slug of Object.keys(a)) if (!b[slug]) out.push(`Removed ${nameOf(slug)}.`);
	return out;
}

/**
 * What changed between two settled summaries, in reading order.
 * @param {ReturnType<typeof summarySnapshot>} prev
 * @param {ReturnType<typeof summarySnapshot>} next
 */
export function summaryChanges(prev, next) {
	const out = [];
	const po = prev.offer;
	const no = next.offer;
	if (no && (!po || po.code !== no.code || po.state !== no.state)) {
		if (no.state === 'applied') out.push(`Offer ${no.code} applied.`);
		else if (no.state === 'invalid') out.push(`Offer ${no.code} can’t be used: ${no.why}`);
	} else if (po && !no) out.push(`Offer ${po.code} removed.`);
	const had = new Map(prev.issues.map((i) => [i.slug, i.code]));
	for (const i of next.issues) if (had.get(i.slug) !== i.code) out.push(i.text);
	if (next.blocked) return out; // nothing to pay yet: no delivery, fee or total to speak of
	if (prev.free !== next.free && !prev.blocked) out.push(next.free ? 'Delivery is now free.' : `Delivery ${formatPaise(next.deliveryPaise)} added.`);
	if (!prev.codFeePaise && next.codFeePaise) out.push(`Cash on delivery fee ${formatPaise(next.codFeePaise)} added.`);
	else if (prev.codFeePaise && !next.codFeePaise) out.push('Cash on delivery fee removed.');
	if (prev.totalPaise !== next.totalPaise) out.push(`Total now ${formatPaise(next.totalPaise)}.`);
	return out;
}

/**
 * S5: City / State written from the PIN change fields the customer isn't in, without moving focus —
 * a status message (WCAG 4.1.3), naming what was filled and asking them to check it.
 * "City and state filled in from your PIN: Bengaluru, Karnataka. Change them if they’re not right."
 * @param {{ city?: string, state?: string }} filled  only the fields actually changed
 * @returns {string}  '' when nothing was filled
 */
export function pinFillMessage(filled) {
	const f = filled || {};
	const names = [];
	const values = [];
	for (const [field, label] of [['city', 'City'], ['state', 'State']]) {
		if (typeof f[field] === 'string' && f[field]) {
			names.push(names.length ? label.toLowerCase() : label);
			values.push(f[field]);
		}
	}
	if (!names.length) return '';
	const both = names.length > 1;
	return `${names.join(' and ')} filled in from your PIN: ${values.join(', ')}. Change ${both ? 'them' : 'it'} if ${both ? 'they’re' : 'it’s'} not right.`;
}
