<script module>
	/** Short, stable hash of the message (djb2, base 36): a new text shows again after a dismissal. */
	export function announcementHash(text, href = '') {
		const s = String(text) + '\u0000' + String(href);
		let h = 5381;
		for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
		return (h >>> 0).toString(36);
	}

	/** Only root-relative paths and https URLs are linked (the snapshot schema's rule). */
	export function safeHref(href) {
		return typeof href === 'string' && (/^\/(?!\/)/.test(href) || /^https:\/\/[^\s]+$/i.test(href)) ? href : '';
	}

	export const ANNOUNCE_KEY = 'wefeasto_announce_dismissed';
</script>

<script>
	/*
	 * Announcement bar (roadmap S11, bublr SaleBanner), above <Nav/>. Off by
	 * default: when settings.announcement.enabled is false (or the text is
	 * blank) it renders nothing at all. Build-time settings only, so it is in
	 * the prerendered HTML (visible without JS) and never pops in mid-visit.
	 * In-flow, not sticky (the nav already is). Hidden on /checkout.
	 * Dismissal is remembered per message hash; a one-line pre-paint script
	 * hides a dismissed bar before first paint, so it never flashes.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { settings } from '$lib/data/cms-snapshot.json'; // named import: just the settings, not the page bodies
	import { liveHref } from '$lib/data/site-paths.js';

	let { announcement = settings.announcement } = $props();

	const text = $derived(announcement && typeof announcement.text === 'string' ? announcement.text.trim() : '');
	const enabled = $derived(!!(announcement && announcement.enabled === true && text));
	// A link to a page this build doesn't have (an unpublished product, a typo) shows as plain text.
	const href = $derived(enabled ? liveHref(safeHref(announcement.href)) : '');
	const hash = $derived(enabled ? announcementHash(text, href) : '');
	const onCheckout = $derived(page.url.pathname === '/checkout' || page.url.pathname.startsWith('/checkout/'));
	// Runs while the HTML is parsed (before paint); a no-op after hydration.
	const prepaint = $derived(
		`<script>try{if(localStorage.getItem(${JSON.stringify(ANNOUNCE_KEY)})===${JSON.stringify(hash)})document.currentScript.parentNode.style.display='none'}catch(e){}<\/script>`
	);

	let dismissed = $state(false);

	function read() {
		try {
			return window.localStorage.getItem(ANNOUNCE_KEY);
		} catch (e) {
			return null;
		}
	}

	function dismiss(e) {
		e.preventDefault();
		dismissed = true;
		try {
			window.localStorage.setItem(ANNOUNCE_KEY, hash);
		} catch (err) {
			/* dismissed for this page only */
		}
	}

	onMount(() => {
		if (enabled && read() === hash) dismissed = true;
	});
</script>

{#if enabled && !onCheckout && !dismissed}<div class="wf-announce" data-wf-announce={hash}>{@html prepaint}{#if href}<a class="wf-announce-text" href={href}>{text}</a>{:else}<p class="wf-announce-text">{text}</p>{/if}<button type="button" class="wf-announce-close" aria-label="Dismiss announcement" onclick={dismiss}>×</button></div>{/if}
