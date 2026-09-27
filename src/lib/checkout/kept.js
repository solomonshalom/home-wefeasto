/*
 * "We kept the order your first tap placed" (hunt round 3, client-ux). A tap
 * that never heard back may have placed an order; the next checkout of the bag
 * finds it (flow.js place(): IDEMPOTENCY_MISMATCH, then that tap's own request
 * replayed). When that order can't be replaced — a COD order (supersede never
 * cancels one) or one money has reached — the customer lands on it rather than
 * on a second shipment. Whatever they changed since (a corrected address or
 * phone, UPI instead of COD, a top-up) is then NOT in it, and /order must say
 * so and show where it ships: the status DTO never carries the street address.
 */

const onlineOf = (m) => (m === 'cod' ? 'cod' : 'online');
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const bagOf = (items) =>
	(Array.isArray(items) ? items : [])
		.map((i) => `${i?.slug}:${i?.qty}`)
		.sort()
		.join(',');

/**
 * What the kept order holds, and what the customer had changed since.
 * @param {string} no  the kept order's number
 * @param {any} was   the unheard tap's request body (the order's details)
 * @param {any} now   the body of the attempt that found it
 */
export function keptRecord(no, was, now) {
	const c = was?.contact || {};
	const a = was?.address || {};
	const nc = now?.contact || {};
	const na = now?.address || {};
	const changed = [];
	if (!same(a.line1, na.line1) || !same(a.city, na.city) || !same(a.state, na.state) || !same(a.pin, na.pin)) changed.push('address');
	if (!same(c.phone, nc.phone)) changed.push('phone');
	if (!same(c.name, nc.name)) changed.push('name');
	if (!same(c.email, nc.email)) changed.push('email');
	if (onlineOf(was?.method) !== onlineOf(now?.method)) changed.push('method');
	if (bagOf(was?.items) !== bagOf(now?.items)) changed.push('items');
	if (!same(was?.couponCode, now?.couponCode)) changed.push('offer');
	return { no, name: c.name || '', phone: c.phone || '', line1: a.line1 || '', city: a.city || '', state: a.state || '', pin: a.pin || '', method: was?.method || '', changed };
}

/** "+919845262777" → "+91 98452 62777" (anything else as is). */
export function showPhone(p) {
	const m = /^\+91(\d{5})(\d{5})$/.exec(String(p || ''));
	return m ? `+91 ${m[1]} ${m[2]}` : String(p || '');
}

/** The one-line address the kept order ships to. */
export function keptAddress(rec) {
	const place = [rec.city, [rec.state, rec.pin].filter(Boolean).join(' ')].filter(Boolean).join(', ');
	return [rec.line1, place].filter(Boolean).join(', ');
}

/**
 * The /order notice for a kept order: {lead, shipsTo, extra[]}.
 * @param {ReturnType<typeof keptRecord>} rec
 */
export function keptCopy(rec) {
	const ch = new Set(rec.changed || []);
	const lead = 'Your earlier tap had already placed this order, so the changes you made after it aren’t in it.';
	const who = [rec.name, showPhone(rec.phone)].filter(Boolean).join(', ');
	const shipsTo = `Delivering to ${keptAddress(rec)}${who ? ' (' + who + ')' : ''}.`;
	const extra = [];
	if (ch.has('method')) extra.push(rec.method === 'cod' ? 'It’s a Pay on delivery order — nothing to pay online.' : 'It’s paid online — nothing to pay on delivery.');
	if (ch.has('items')) extra.push('Anything you added since is still in your bag.');
	extra.push('Need a change? Message us and we’ll fix it before it ships.');
	return { lead, shipsTo, extra };
}
