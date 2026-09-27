<script module>
	/*
	 * Open state shared by the hamburger in Nav.svelte and the panel below
	 * (mounted once in +layout.svelte, outside .page-wrapper so the page
	 * enter transform never traps the fixed panel).
	 */
	export const mobileNav = $state({ open: false });

	export function openMobileNav() {
		mobileNav.open = true;
	}

	export function closeMobileNav() {
		mobileNav.open = false;
	}

	export function toggleMobileNav() {
		mobileNav.open = !mobileNav.open;
	}
</script>

<script>
	/*
	 * Mobile menu (<= 991px, where Webflow hides .nav-menu): a right-hand
	 * sheet with the nav links, Account (/account when logged in, else
	 * /login) and Bag. Dialog semantics with focus
	 * moved in, a Tab/Shift+Tab trap, Esc to close (focus returns to the
	 * hamburger), backdrop click, and it closes on any navigation. Page
	 * scroll is locked (body.wf-no-scroll + lenis.stop()) and the sheet
	 * opts out of Lenis (data-lenis-prevent). Reduced motion / ?nofx=1: no
	 * slide, it simply appears. Styles: wefeasto.css "Phase 2: UI kit".
	 */
	import { tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { cartCount } from '$lib/cart.js';
	import { user } from '$lib/session.js';
	import { lenis } from '$lib/fx.js';
	import { slideX, ms, EASE, DURATION } from '$lib/motion.js';

	const LINKS = [
		{ href: '/shop', label: 'Shop' },
		{ href: '/recipes', label: 'Recipes' },
		{ href: '/#about', label: 'Our Story' },
		{ href: '/#contact', label: 'Contact' }
	];

	let panel = $state();
	let returnTo = null;

	const path = $derived(page.url.pathname);
	const count = $derived($cartCount > 0 ? $cartCount : 0);
	// Account: /account when logged in (the sheet only renders after mount).
	const accountHref = $derived($user ? '/account' : '/login');

	function close(restoreFocus = true) {
		if (!mobileNav.open) return;
		mobileNav.open = false;
		if (!restoreFocus) return;
		// Safari doesn't focus a button on click, so the opener may be <body>.
		const opener = returnTo && returnTo !== document.body && returnTo.isConnected ? returnTo : null;
		(opener || document.getElementById('wf-menu-btn'))?.focus?.();
	}

	// Any navigation (a menu link, back/forward, a link elsewhere) closes it.
	afterNavigate(() => close(false));

	$effect(() => {
		if (!mobileNav.open) return;
		returnTo = document.activeElement;
		document.body.classList.add('wf-no-scroll');
		lenis?.stop();
		tick().then(() => panel?.querySelector('[data-autofocus]')?.focus());
		// Growing past the breakpoint hides the hamburger: don't strand an open sheet.
		const wide = window.matchMedia('(min-width: 992px)');
		const onWide = (e) => {
			if (e.matches) close(false);
		};
		wide.addEventListener('change', onWide);
		return () => {
			wide.removeEventListener('change', onWide);
			document.body.classList.remove('wf-no-scroll');
			lenis?.start();
		};
	});

	function focusables() {
		return panel
			? Array.from(panel.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
			: [];
	}

	function onKeydown(e) {
		if (!mobileNav.open) return;
		if (e.key === 'Escape' || e.key === 'Esc') {
			e.preventDefault();
			close(true);
			return;
		}
		if (e.key !== 'Tab') return;
		const f = focusables();
		if (!f.length) return;
		const first = f[0];
		const last = f[f.length - 1];
		const inside = panel.contains(document.activeElement);
		if (e.shiftKey && (document.activeElement === first || !inside)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (document.activeElement === last || !inside)) {
			e.preventDefault();
			first.focus();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div id="wf-mobile-nav" class="wf-mnav-host">{#if mobileNav.open}<div class="wf-mnav-backdrop" aria-hidden="true" onclick={() => close(true)} transition:fade={{ duration: ms(DURATION.fast) }}></div><div bind:this={panel} class="wf-mnav" role="dialog" aria-modal="true" aria-labelledby="wf-mnav-title" data-lenis-prevent in:slideX={{ duration: DURATION.normal, easing: EASE.enter }} out:slideX={{ duration: DURATION.fast, easing: EASE.exit }}><div class="wf-mnav-head"><h2 id="wf-mnav-title" class="wf-mnav-title">Menu</h2><button type="button" class="wf-mnav-close" aria-label="Close menu" data-autofocus onclick={() => close(true)}><svg viewBox="0 0 256 256" width="24" height="24" aria-hidden="true" focusable="false"><path d="M200 56 56 200M200 200 56 56" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" /></svg></button></div><nav aria-label="Main" class="wf-mnav-nav"><ul class="wf-mnav-links" role="list">{#each LINKS as link (link.href)}<li><a href={link.href} class="wf-mnav-link" aria-current={path === link.href ? 'page' : undefined} onclick={() => close(false)}><span>{link.label}</span><span class="wf-mnav-arrow" aria-hidden="true">→</span></a></li>{/each}</ul></nav><div class="wf-mnav-actions"><a href={accountHref} class="button secondary w-inline-block wf-mnav-btn" aria-current={path === accountHref ? 'page' : undefined} onclick={() => close(false)}><div>Account</div></a><a href="/cart" class="button w-inline-block wf-mnav-btn" aria-label={count ? `Bag, ${count} ${count === 1 ? 'item' : 'items'}` : 'Bag'} aria-current={path === '/cart' ? 'page' : undefined} onclick={() => close(false)}><div>Bag</div>{#if count}<span class="wf-mnav-count" aria-hidden="true">{count}</span>{/if}</a></div></div>{/if}</div>
