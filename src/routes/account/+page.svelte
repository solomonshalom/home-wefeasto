<script>
	/*
	 * /account (roadmap S3): "Your breakfast shelf". A prerendered shell (the
	 * site is static); everything personal is fetched after mount.
	 * - Not logged in → /login?next=/account. A 401/403 mid-session (the
	 *   session expired or was revoked elsewhere) → the same, with a notice.
	 * - Orders from GET /api/store/orders/mine, newest first, as bag-style rows
	 *   (thumb, items, date, status chip, total, Buy again, View when the order
	 *   link can be built). Rows animate in with the reveal attachment.
	 * - Details: name and phone (Indian mobile, stored as +91…); the login
	 *   email is read-only (the CMS refuses email changes). Log out.
	 * Styles: static/css/wf-account.css.
	 */
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { session, refresh, logout, updateProfile, loadMyOrders, MESSAGES } from '$lib/session.js';
	import { productBySlug } from '$lib/data/products.js';
	import { reveal } from '$lib/reveal.js';
	import Spinner from '$lib/components/Spinner.svelte';
	import { firstName } from '$shared/validate.js';
	import { orderRow, sortOrders } from './orders.js';
	import { focusIfLost, submitterOf } from '../login/focus.js';

	let phase = $state('loading'); // loading | ready | error
	let loadError = $state('');
	let orders = $state.raw([]);
	let ordersState = $state('loading'); // loading | ready | error
	let ordersError = $state('');

	let name = $state('');
	let phone = $state('');
	let saving = $state(false);
	/** @type {{ tone: 'ok' | 'error', text: string, field?: string } | null} */
	let saveNote = $state(null);
	let loggingOut = $state(false);
	let logoutError = $state('');
	let leaving = false;

	const me = $derived($session.user);
	const hello = $derived(me ? firstName(me.name) : '');
	const rows = $derived(sortOrders(orders).map((o) => orderRow(o, productBySlug)));

	/** '+919845262777' → '+91 98452 62777' (what the input shows). */
	const showPhone = (p) => (typeof p === 'string' ? p.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2') : '');
	const loginUrl = (expired) => '/login?next=/account' + (expired ? '&session=expired' : '');

	function toLogin(expired = false) {
		if (leaving) return;
		leaving = true;
		goto(loginUrl(expired), { replaceState: true });
	}

	async function start() {
		phase = 'loading';
		const r = await refresh();
		if (!r.ok) {
			loadError = r.error?.message || MESSAGES.UNKNOWN;
			phase = 'error';
			return;
		}
		if (!r.user) return toLogin(false);
		show(r.user);
	}

	/** The customer whose details and orders are on screen. */
	let shownId = null;
	function show(u) {
		shownId = u.id;
		name = u.name;
		phone = showPhone(u.phone);
		saveNote = null;
		orders = [];
		phase = 'ready';
		loadOrders();
	}

	/* Drops an answer overtaken by a later load (Try again, another customer shown). */
	let ordersSeq = 0;
	async function loadOrders() {
		const seq = ++ordersSeq;
		ordersState = 'loading';
		const r = await loadMyOrders();
		if (seq !== ordersSeq) return;
		if (r.ok) {
			orders = r.orders;
			ordersState = 'ready';
			return;
		}
		if (r.error.code === 'SESSION_EXPIRED') return toLogin(true);
		ordersError = r.error.code === 'UNKNOWN' ? 'We couldn’t load your orders just now.' : r.error.message;
		ordersState = 'error';
	}

	/* The busy buttons below are `disabled`, which drops keyboard focus to
	   <body>: once they settle, focus goes back to them (or to the field at
	   fault) unless the customer has moved it (see ../login/focus.js). */
	async function saveDetails(e) {
		e.preventDefault();
		if (saving) return;
		const button = submitterOf(e);
		saving = true;
		saveNote = null;
		const r = await updateProfile({ name, phone });
		saving = false;
		if (r.ok) {
			name = r.user.name;
			phone = showPhone(r.user.phone);
			saveNote = { tone: 'ok', text: 'Saved — thanks!' };
		} else {
			if (r.error.code === 'SESSION_EXPIRED') return toLogin(true);
			saveNote = { tone: 'error', text: r.error.message, field: r.error.field };
			if (r.error.field) return document.getElementById('wf-acct-' + r.error.field)?.focus();
		}
		await tick(); // "Saved — thanks!" / the error is read from #wf-acct-note (role=status)
		focusIfLost(button);
	}

	async function doLogout(e) {
		if (loggingOut) return;
		const button = e?.currentTarget instanceof HTMLElement ? e.currentTarget : document.querySelector('[data-wf-logout]');
		loggingOut = true;
		logoutError = '';
		const r = await logout();
		if (!r.ok) {
			loggingOut = false;
			logoutError = r.error.message;
			await tick();
			focusIfLost(button);
			return;
		}
		leaving = true;
		goto('/');
	}

	onMount(() => {
		start();
		// Logged out in the middle of things: the session expired on another
		// request, or the customer logged out in another tab ($lib/session.js
		// hears about that). Someone else logged in since → show them instead.
		const unsubscribe = session.subscribe((s) => {
			if (phase !== 'ready' || loggingOut) return;
			if (s.status === 'anonymous') toLogin(true);
			else if (s.status === 'authenticated' && String(s.user.id) !== String(shownId)) show(s.user);
		});
		return unsubscribe;
	});
</script>

<svelte:head>
	<title>Wefeasto — Your Account</title>
	<meta name="robots" content="noindex">
</svelte:head>

<div class="page-wrapper">
<div class="section"><div class="container">
<div class="wf-hero-stagger"><div class="wf-chip">Your Account</div><div class="divider"></div><h1 class="heading-2">Your breakfast shelf</h1></div>
<div class="divider _32px mobile-24px"></div>
<div id="wf-account" class="wf-account" aria-busy={phase === 'loading'}><noscript><p class="p-large">Your account needs JavaScript. <a href="/login">Log in</a> with JavaScript on, or head back to the <a href="/shop">shop</a>.</p></noscript>{#if phase === 'loading'}<p class="wf-account-wait" role="status"><Spinner /> <span>Opening your shelf…</span></p>{:else if phase === 'error'}<div class="wf-account-problem" role="alert"><p class="p-large">{loadError}</p><button type="button" class="button w-button" onclick={start}>Try again</button></div>{:else}<p class="p-large wf-account-hello" data-wf-hello {@attach reveal()}>{hello ? `Welcome back, ${hello}.` : 'Welcome back.'} Your orders and details live here.</p><div class="wf-account-layout"><section class="wf-account-orders" aria-labelledby="wf-orders-title"><h2 id="wf-orders-title" class="wf-account-h">Your orders</h2>{#if ordersState === 'loading'}<p class="wf-account-wait" role="status"><Spinner /> <span>Fetching your orders…</span></p>{:else if ordersState === 'error'}<div class="wf-account-problem" role="alert" data-wf-orders-error><p>{ordersError}</p><button type="button" class="button secondary w-button" onclick={loadOrders}>Try again</button></div>{:else if rows.length === 0}<div class="wf-account-empty" data-wf-orders-empty {@attach reveal()}><p class="p-large">No orders yet — your shelf is waiting for its first box.</p><div class="divider _24px"></div><div class="wf-account-actions"><a href="/shop" class="button w-inline-block"><div>Shop Breakfast</div></a></div></div>{:else}<ul class="wf-order-list" role="list" data-wf-orders {@attach reveal({ children: true, stagger: 0.04 })}>{#each rows as r (r.key)}<li class="wf-order-row" data-wf-order={r.number}><span class="wf-cart-thumb wf-order-thumb" aria-hidden="true">{#if r.thumb}<img src={r.thumb} alt="" loading="lazy">{/if}</span><div class="wf-cart-info"><p class="wf-cart-name">{r.number ?? 'Your order'}</p><p class="wf-cart-unit" data-wf-order-items>{r.itemsText}</p>{#if r.date}<p class="wf-order-date">Placed {r.date}</p>{/if}</div><span class="wf-chip wf-chip-small wf-order-status" data-tone={r.tone} data-wf-status={r.status}>{r.statusText}</span><span class="wf-price wf-order-total" data-wf-order-total>{r.total}</span><div class="wf-order-actions">{#if r.buyAgainHref}<a class="button w-inline-block wf-order-btn" href={r.buyAgainHref} data-wf-buy-again aria-label={r.number ? `Buy again: order ${r.number}` : undefined}><div>Buy again</div></a>{/if}{#if r.viewHref}<a class="button secondary w-inline-block wf-order-btn" href={r.viewHref} data-wf-view-order aria-label={`View order ${r.number}`}><div>View</div></a>{/if}</div></li>{/each}</ul>{/if}</section><section class="wf-account-details" aria-labelledby="wf-details-title" {@attach reveal({ delay: 0.1 })}><h2 id="wf-details-title" class="wf-account-h">Your details</h2><form id="wf-account-form" method="post" class="wf-account-form" novalidate onsubmit={saveDetails}><div class="wf-field"><label class="wf-label" for="wf-acct-name">Name</label><input class="wf-input" type="text" id="wf-acct-name" name="name" autocomplete="name" maxlength="100" required bind:value={name} aria-invalid={saveNote?.field === 'name' || undefined} aria-describedby={saveNote?.field === 'name' ? 'wf-acct-note' : undefined}></div><div class="wf-field"><label class="wf-label" for="wf-acct-phone">Mobile <span class="wf-label-soft">(optional)</span></label><input class="wf-input" type="tel" id="wf-acct-phone" name="phone" autocomplete="tel" inputmode="tel" placeholder="98452 62777" maxlength="20" bind:value={phone} aria-invalid={saveNote?.field === 'phone' || undefined} aria-describedby={saveNote?.field === 'phone' ? 'wf-acct-note' : undefined}></div><div class="wf-field"><label class="wf-label" for="wf-acct-email">Email</label><input class="wf-input wf-input-readonly" type="email" id="wf-acct-email" name="email" value={me?.email ?? ''} readonly aria-describedby="wf-acct-email-note"><p class="wf-form-note" id="wf-acct-email-note">This is your login email. To change it, message us.</p></div><p id="wf-acct-note" class="wf-account-note" data-tone={saveNote?.tone} role="status" aria-live="polite">{saveNote?.text ?? ''}</p><button type="submit" class="button w-button wf-btn-full" disabled={saving} aria-busy={saving}>{#if saving}<Spinner /> Saving…{:else}Save details{/if}</button></form><div class="wf-account-out"><button type="button" class="button secondary w-button wf-btn-full" data-wf-logout disabled={loggingOut} aria-busy={loggingOut} onclick={doLogout}>{#if loggingOut}<Spinner /> Logging out…{:else}Log out{/if}</button>{#if logoutError}<p class="wf-account-note" data-tone="error" role="alert">{logoutError}</p>{/if}</div></section></div>{/if}</div>
</div></div>
</div>
