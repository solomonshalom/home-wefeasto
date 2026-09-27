/*
 * Minimal same-origin /api stub for the interact suite (current side only).
 * The static server already answers every /api call with 404 {} ("no CMS":
 * live.js keeps the snapshot, /store/quote falls back to the local $shared
 * quote). This adds just enough backend for the scenarios to reach real UI:
 *   POST /api/store/checkout        → 201 COD order, payment null (SPEC §6)
 *   GET  /api/store/orders/status   → OrderStatusDTO, status cod_pending (confirmed)
 *   POST /api/store/newsletter      → 200 {ok:true}
 * Every /api request is recorded in `calls` ({method, path, body, key}).
 * Totals mirror SPEC §0 (₹49 delivery under ₹499), computed from the snapshot.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadProducts(repoOrMirror) {
	const snap = JSON.parse(fs.readFileSync(path.join(repoOrMirror, 'src/lib/data/cms-snapshot.json'), 'utf8'));
	return new Map(snap.products.map((p) => [p.slug, p]));
}

export async function installApiStub(page, { products }) {
	const calls = [];
	const orders = new Map();
	let seq = 10000;
	const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
	await page.route(/\/api(\/|$|\?)/, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const p = url.pathname.replace(/^\/api/, '');
		let body = null;
		try {
			body = req.postData() ? JSON.parse(req.postData()) : null;
		} catch {}
		calls.push({ method: req.method(), path: p, body, key: req.headers()['idempotency-key'] || null });
		const k = `${req.method()} ${p}`;
		if (k === 'POST /store/checkout') {
			const items = (body?.items || []).map((i) => {
				const prod = products.get(i.slug);
				return { slug: i.slug, name: prod?.name || i.slug, qty: i.qty, unitPaise: prod?.pricePaise || 0, lineTotalPaise: (prod?.pricePaise || 0) * i.qty, image: null };
			});
			const subtotalPaise = items.reduce((s, l) => s + l.lineTotalPaise, 0);
			const deliveryPaise = subtotalPaise < 49900 ? 4900 : 0;
			const number = 'WF-' + ++seq;
			const token = crypto.randomBytes(32).toString('base64url');
			const o = {
				number,
				token,
				status: body?.method === 'cod' ? 'cod_pending' : 'pending_payment',
				paymentStatus: body?.method === 'cod' ? 'none' : 'created',
				paymentMethod: body?.method === 'cod' ? 'cod' : 'online',
				requestedMethod: body?.method,
				fulfilmentStatus: 'unfulfilled',
				createdAt: new Date().toISOString(),
				paidAt: null,
				items,
				subtotalPaise,
				discountPaise: 0,
				deliveryPaise,
				codFeePaise: 0,
				totalPaise: subtotalPaise + deliveryPaise,
				coupon: null,
				contact: { firstName: String(body?.contact?.name || '').split(/\s+/)[0], emailMasked: 'a***@example.com', phoneMasked: '+91 ******2777' },
				address: { city: body?.address?.city, state: body?.address?.state },
				canRetryPayment: false,
				isConfirmed: body?.method === 'cod',
				shippingPromiseText: 'Ships in 1–2 business days.'
			};
			orders.set(number, o);
			if (body?.method !== 'cod') return route.fulfill(json(503, { error: { code: 'PAYMENTS_UNAVAILABLE', message: 'stub: online payments are not stubbed', details: {} } }));
			return route.fulfill(json(201, { order: { number, token, status: o.status, totalPaise: o.totalPaise }, payment: null }));
		}
		if (k === 'GET /store/orders/status') {
			const o = orders.get(url.searchParams.get('no'));
			if (!o || o.token !== url.searchParams.get('t')) return route.fulfill(json(404, { error: { code: 'NOT_FOUND', message: 'Not found', details: {} } }));
			const { token, ...dto } = o;
			return route.fulfill(json(200, dto));
		}
		if (k === 'POST /store/newsletter') return route.fulfill(json(200, { ok: true }));
		return route.fallback();
	});
	return { calls, orders };
}
