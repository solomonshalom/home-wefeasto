/*
 * Round-2 invariant: only a human releases a hold.
 *   A HOLD starts when an order moves to needs_review because of a chargeback (payment.dispute.created) or
 *   because an admin put it there. Until an admin moves it on (a status-history row with source admin:*),
 *   no status change made by the system may take it to a fulfillable status (paid, partially_refunded,
 *   cod_confirmed), and no fulfilment step into packed/shipped may happen.
 * Read from orders_status_history (one SQL snapshot per check).
 */
const FULFILLABLE = new Set(['paid', 'partially_refunded', 'cod_confirmed']);

export async function checkHold(c, w, label) {
	const out = [];
	const rows = await c.db.query(
		`select o.number, h.field, h."from" as f, h."to" as t, h.source, h.note from orders o join orders_status_history h on h._parent_id = o.id
		  where o.number = any($1::text[]) order by o.number, h._order`,
		[w.orders.map((o) => o.number)]
	);
	const held = new Map();
	for (const h of rows) {
		const admin = /^admin:/.test(h.source ?? '');
		if (h.field === 'status') {
			if (h.t === 'needs_review' && (admin || /payment\.dispute\.created/.test(h.note ?? ''))) {
				held.set(h.number, admin ? 'admin hold' : `chargeback (${h.note})`);
				continue;
			}
			if (!held.has(h.number)) continue;
			if (admin) held.delete(h.number);
			else if (FULFILLABLE.has(h.t)) {
				out.push(`${h.number}: ${held.get(h.number)} released by ${h.source} "${h.note ?? ''}" (${h.f} → ${h.t})`);
				held.delete(h.number);
			}
		} else if (h.field === 'fulfilmentStatus' && held.has(h.number) && (h.t === 'packed' || h.t === 'shipped')) {
			out.push(`${h.number}: ${h.f} → ${h.t} during a ${held.get(h.number)}`);
		}
	}
	w.holdSeen ??= new Set();
	const fresh = out.filter((v) => !w.holdSeen.has(v));
	for (const v of fresh) {
		w.holdSeen.add(v);
		w.violations.push({ at: label, v });
	}
	return fresh;
}
