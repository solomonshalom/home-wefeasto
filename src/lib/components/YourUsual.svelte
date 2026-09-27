<script module>
	/*
	 * The last order → "Your usual" (roadmap M5). wefeasto_last_order is
	 * written by the /order page (M3) as {no, t, items: {slug: qty}, at}.
	 */
	import { sanitizeCart, lsGet, lsSet, DAY } from '$lib/cart.js';
	import { products as snapshotProducts } from '$lib/data/cms-snapshot.json';

	export const LAST_ORDER_KEY = 'wefeasto_last_order';
	export const USUAL_HIDDEN_KEY = 'wefeasto_usual_hidden';
	export const USUAL_MAX_AGE_DAYS = 120;
	export const USUAL_HIDE_DAYS = 14;

	/**
	 * The last order as {no, t, items:{slug:qty}, at(ms)}, or null when missing,
	 * malformed, older than 120 days, or storage is unavailable. Items are
	 * sanitized against the catalog (unknown products dropped).
	 * @param {number} [now]
	 * @param {any[]} [catalog]
	 */
	export function readLastOrder(now = Date.now(), catalog = snapshotProducts, stored = lsGet(LAST_ORDER_KEY)) {
		if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
		const at = typeof stored.at === 'number' ? stored.at : typeof stored.at === 'string' ? Date.parse(stored.at) : NaN;
		if (!Number.isFinite(at) || at > now + DAY || now - at > USUAL_MAX_AGE_DAYS * DAY) return null;
		const items = sanitizeCart(stored.items, catalog);
		if (!Object.keys(items).length) return null;
		return { no: typeof stored.no === 'string' ? stored.no : '', t: typeof stored.t === 'string' ? stored.t : '', items, at };
	}

	/**
	 * What "Add all" would add: for each usual line still sold, the units the bag
	 * is missing (usual qty − in bag). Lines already covered, sold out or no
	 * longer sold are left out. [] means the bag already holds the usual.
	 * @param {Record<string, number>} usualItems
	 * @param {Record<string, number>} bag
	 * @param {Array<{slug: string, inStock: boolean}>} catalog
	 */
	export function usualTopUp(usualItems, bag, catalog) {
		const rows = new Map((catalog || []).map((p) => [p.slug, p]));
		const out = [];
		for (const [slug, qty] of Object.entries(usualItems || {})) {
			const p = rows.get(slug);
			if (!p || p.inStock === false) continue;
			const missing = qty - (bag && Object.prototype.hasOwnProperty.call(bag, slug) ? bag[slug] : 0);
			if (missing > 0) out.push({ slug, qty: missing, name: p.name, pricePaise: p.pricePaise });
		}
		return out;
	}

	export function usualHidden(now = Date.now()) {
		const at = lsGet(USUAL_HIDDEN_KEY);
		return typeof at === 'number' && now - at < USUAL_HIDE_DAYS * DAY && at <= now + DAY;
	}

	export function hideUsual(now = Date.now()) {
		return lsSet(USUAL_HIDDEN_KEY, now);
	}
</script>

<script>
	/*
	 * "Your usual" one-tap reorder (roadmap M5), from localStorage
	 * wefeasto_last_order ({no, t, items: {slug: qty}, at}, written by /order).
	 *   variant 'cart'  — in the empty bag, above "Shop Breakfast"
	 *   variant 'shop'  — /shop, between the heading and the chips (dismissible)
	 *   variant 'home'  — home "Shop Bestsellers", above the grid (dismissible)
	 * Hidden when the bag already holds the usual quantities, when the order is
	 * over 120 days old or unreadable, when storage is unavailable, and (shop,
	 * home) for 14 days after ×. "Add all" adds only what the bag is missing,
	 * at today's prices, in one Cart.addMany (source 'usual'). Client-only.
	 * Build-time prices/stock first; the live overlay ($lib/live.js) is only
	 * loaded when there is a last order to show, so home and /shop stay light.
	 */
	import { onMount } from 'svelte';
	import { cart, Cart } from '$lib/cart.js';
	import { buildPricingCatalog } from '$lib/data/derive.js';
	import { formatPaise } from '$shared/money.js';
	import { track } from '$lib/track.js';
	import { keepFocus, headingsBefore } from '$lib/focus.js';

	let { variant = 'shop' } = $props();

	let last = $state(null);
	let hidden = $state(true);
	let catalog = $state.raw(buildPricingCatalog({ products: snapshotProducts }));

	const names = $derived(new Map(catalog.map((p) => [p.slug, p])));
	// The usual lines still sold (for the label) and what "Add all" would add.
	const usual = $derived(last ? Object.entries(last.items).filter(([slug]) => names.get(slug)?.inStock) : []);
	const toAdd = $derived(last ? usualTopUp(last.items, $cart, catalog) : []);
	const pricePaise = $derived(toAdd.reduce((a, l) => a + l.qty * l.pricePaise, 0));
	const partial = $derived(toAdd.length > 0 && usual.some(([slug]) => ($cart[slug] || 0) > 0));
	const visible = $derived(!hidden && last !== null && toAdd.length > 0);
	const dismissible = $derived(variant !== 'cart');

	/*
	 * Add all (the bag now holds the usual) and × both unmount this card with
	 * its focused button. Keyboard focus goes to the nearest heading before
	 * the card that is still on the page (/shop's heading, home's "Shop
	 * Bestsellers", the bag's heading once the empty state gives way to rows):
	 * the next Tab continues right where the card was. What was added is
	 * announced by the toast (on /cart by the bag's live list).
	 */
	function leave(e, change) {
		const card = e.currentTarget.closest('[data-wf-usual]');
		const before = headingsBefore(card);
		keepFocus(card, change, () => [...before, document.querySelector('h1')]);
	}

	function addAll(e) {
		e.preventDefault();
		if (!toAdd.length) return;
		const lines = toAdd.map((l) => ({ slug: l.slug, qty: l.qty }));
		leave(e, () => {
			track('usual_add', { variant, items: lines.length });
			Cart.addMany(lines, { source: 'usual' });
		});
	}

	function dismiss(e) {
		e.preventDefault();
		leave(e, () => {
			hideUsual();
			hidden = true;
		});
	}

	onMount(() => {
		last = readLastOrder();
		hidden = dismissible && usualHidden();
		if (!last || hidden) return;
		let stop = null;
		let gone = false;
		import('$lib/live.js').then(
			(live) => {
				if (gone) return;
				stop = live.liveCatalog.subscribe(() => (catalog = live.catalogForPricing()));
				live.loadLive();
			},
			() => {} // offline: keep the build-time prices
		);
		return () => {
			gone = true;
			if (stop) stop();
		};
	});
</script>

{#if visible}<div class="wf-usual wf-usual-{variant}" data-wf-usual={variant}><div class="wf-usual-text"><span class="wf-usual-label">Your usual:</span> {usual.map(([slug, qty]) => `${names.get(slug).name} ×${qty}`).join(' · ')}</div><div class="wf-usual-actions"><button type="button" class="button wf-usual-add" data-wf-usual-add onclick={addAll}>{partial ? 'Add the rest' : 'Add all'} · {formatPaise(pricePaise)}</button>{#if dismissible}<button type="button" class="wf-usual-dismiss" aria-label="Hide your usual for two weeks" onclick={dismiss}>×</button>{/if}</div></div>{/if}
