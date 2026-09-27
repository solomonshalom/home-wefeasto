/*
 * /account order rows: GET /api/store/orders/mine gives OrderStatusDTOs
 * (SPEC §6); this turns one into what a row shows. Pure (tests call it).
 *
 * - Status chip: the $shared customer labels. Once a confirmed order is on
 *   its way the fulfilment label ("Shipped") says more than "Order confirmed".
 * - Buy again: the stateless /cart?add= deep link (M5); the cart page tops the
 *   bag up to the linked quantities and drops anything no longer sold.
 * - View: /order?no=&t= needs the order's guest token. orders/mine carries
 *   `token` on every order (checkout-backend.md §1.8); the link is built and
 *   checked with /order's own helpers (orderUrl, isToken), so any token the
 *   row links with is one /order reads back. Only a missing/malformed token
 *   (never sent by the backend) leaves a row without View.
 */
import { STATUS_LABELS, FULFILMENT_LABELS, isConfirmed, isOrderNumber } from '$shared/order-status.js';
import { buildCartLink } from '$shared/cart-links.js';
import { formatPaise } from '$shared/money.js';
import { isToken } from '$lib/checkout/storage.js';
import { orderUrl } from '$lib/checkout/order.js';

const DATE_FMT = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' };

/** '2026-09-26T04:30:00.000Z' → '26 Sept 2026' (IST); unparseable → ''. */
export function orderDate(iso) {
	const t = typeof iso === 'string' || typeof iso === 'number' ? Date.parse(String(iso)) : NaN;
	if (!Number.isFinite(t)) return '';
	try {
		return new Intl.DateTimeFormat('en-IN', DATE_FMT).format(new Date(t));
	} catch (e) {
		return new Date(t).toISOString().slice(0, 10);
	}
}

/** Customer-facing status text for a DTO. */
export function statusText(order) {
	const status = order?.status;
	const f = order?.fulfilmentStatus;
	if (isConfirmed(status) && typeof f === 'string' && f !== 'unfulfilled' && FULFILMENT_LABELS[f]) return FULFILMENT_LABELS[f];
	return (typeof status === 'string' && STATUS_LABELS[status]) || 'Order placed';
}

/** 'good' (confirmed / on its way), 'bad' (failed, expired, cancelled) or 'wait'. */
export function statusTone(order) {
	const status = order?.status;
	if (isConfirmed(status) || status === 'refunded') return 'good';
	if (status === 'payment_failed' || status === 'expired' || status === 'cancelled') return 'bad';
	return 'wait';
}

const itemsOf = (order) => (Array.isArray(order?.items) ? order.items.filter((i) => i && typeof i === 'object') : []);

/** 'Muesli ×2 · Cornflakes' (at most `max` names, then '+ 2 more'). */
export function itemsText(order, max = 3) {
	const items = itemsOf(order).filter((i) => typeof i.name === 'string' && i.name);
	const shown = items.slice(0, max).map((i) => (Number.isInteger(i.qty) && i.qty > 1 ? `${i.name} ×${i.qty}` : i.name));
	const rest = items.length - shown.length;
	return shown.join(' · ') + (rest > 0 ? ` + ${rest} more` : '');
}

/** Same-origin image path or https URL, else ''. */
const safeImage = (src) => (typeof src === 'string' && ((src.startsWith('/') && !src.startsWith('//')) || /^https:\/\//i.test(src)) ? src : '');

/**
 * @param {any} order  OrderStatusDTO (+ optional `token`)
 * @param {(slug: string) => { image?: string, name?: string } | undefined} [productBySlug]  image fallback
 */
export function orderRow(order, productBySlug = () => undefined) {
	const number = typeof order?.number === 'string' && isOrderNumber(order.number) ? order.number.trim() : null;
	const items = itemsOf(order);
	const first = items[0];
	const thumb = first ? safeImage(first.image) || safeImage(productBySlug(first.slug)?.image) : '';
	const lines = items.map((i) => ({ slug: i.slug, qty: i.qty }));
	const again = buildCartLink(lines, { src: 'usual' });
	const token = isToken(order?.token) ? order.token : null;
	return {
		number,
		key: number ?? String(order?.createdAt ?? Math.random()),
		date: orderDate(order?.createdAt),
		status: typeof order?.status === 'string' ? order.status : '',
		statusText: statusText(order),
		tone: statusTone(order),
		itemsText: itemsText(order),
		thumb,
		thumbAlt: first && typeof first.name === 'string' ? first.name : '',
		total: formatPaise(Number.isFinite(order?.totalPaise) ? order.totalPaise : 0),
		buyAgainHref: again === '/cart' ? null : again,
		viewHref: number && token ? orderUrl(number, token) : null
	};
}

/** Newest first (the API should already sort; this keeps the page honest if not). */
export function sortOrders(orders) {
	return [...(Array.isArray(orders) ? orders : [])].sort((a, b) => (Date.parse(b?.createdAt) || 0) - (Date.parse(a?.createdAt) || 0));
}
