<script>
	import { tick, onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api.js';
	import { track } from '$lib/track.js';
	import { syncLenis } from '$lib/fx.js';
	import Spinner from '$lib/components/Spinner.svelte';
	import { homeBestsellers, kitchenRecipes as homeKitchenRecipes } from '$lib/data/catalog-views.js';
	import YourUsual from '$lib/components/YourUsual.svelte';
	import { liveCatalog, loadLive, withLivePrices, soldOutIn } from '$lib/live.js';

	// Inline transform baked into the original markup — the hidden initial
	// state of the card-hover machinery (Webflow IX2 useFirstGroupAsInitialState).
	const HOVER_HIDDEN =
		'transform: translate3d(0px, 0px, 0px) scale3d(0, 0, 1) rotateX(0deg) rotateY(0deg) rotateZ(0deg) skew(0deg, 0deg); transform-style: preserve-3d;';

	// Card lists derived from the CMS snapshot (src/lib/data/cms-snapshot.json):
	// products and recipes flagged homeFeatured, in catalog order, with display
	// strings ('₹175 · 120 cal', '★ 5.0 · 500 g') computed from pricePaise,
	// rating and packSize. A price edit in the CMS reaches the prerendered cards
	// on the next build, and the browser shows it at once: after the live
	// catalog loads (onMount), the price lines are re-derived from it.
	const bestsellers = homeBestsellers();
	const kitchenRecipes = homeKitchenRecipes();
	const liveCards = $derived(
		$liveCatalog.ready
			? new Map(homeBestsellers(withLivePrices).map((c) => [c.url, { priceLine: c.priceLine, soldOut: soldOutIn($liveCatalog, c.url.replace(/^\/products\//, '')) }]))
			: null
	);
	onMount(() => {
		loadLive();
	});

	/* Newsletter ("Stay Crunchy", roadmap M6): double opt-in through the CMS,
	   POST /api/store/newsletter (same origin; nothing goes to webflow.com).
	   bublr subscribe-newsletter states: idle → loading (spinner) → success |
	   error. The server answers 200 for every well-formed address, so there
	   is no "already subscribed" state. `website` is a honeypot: people never
	   see or fill it; the server silently drops submissions that do.
	   The confirm / unsubscribe links in the emails land back here with
	   ?subscribed=1|expired|error or ?unsubscribed=1|invalid|error
	   (#newsletter; copy from contracts/retention-backend.md §2): the matching
	   notice shows in this block and the param is dropped.
	   Submit stays disabled until hydrated (nlReady): before that a tap or
	   Enter would submit natively and subscribe nobody. The form is
	   method="post" (was Webflow's "get") so the address can never end up in
	   a URL, history or host logs even so. */
	const NL_SUCCESS = 'Check your inbox to confirm — then breakfast recipes are on their way.';
	const NL_FAIL = 'Oops! Something went wrong while submitting the form.';
	const NL_NOTICES = {
		'subscribed=1': { tone: 'done', text: 'You’re subscribed — check your inbox for your welcome treat.', hideForm: true },
		'subscribed=expired': { tone: 'fail', text: 'That confirmation link has expired or was replaced — sign up again below.' },
		'subscribed=error': { tone: 'fail', text: 'Something went wrong confirming — please tap the link in your email again.' },
		'unsubscribed=1': { tone: 'done', text: 'You’re unsubscribed. You won’t get marketing emails from us.' },
		'unsubscribed=invalid': { tone: 'fail', text: 'That unsubscribe link didn’t work — reply to any of our emails and we’ll take you off.' },
		'unsubscribed=error': { tone: 'fail', text: 'Something went wrong — please try the link again.' }
	};

	let email = $state('');
	let website = $state(''); // honeypot
	let nlState = $state('idle'); // idle | loading | success | error
	let nlReady = $state(false); // hydrated: onSubmit is listening
	let doneText = $state(NL_SUCCESS);
	let failText = $state(NL_FAIL);
	let formHidden = $state(false);
	let doneShown = $state(false);
	let failShown = $state(false);
	const btnLabel = $derived(nlState === 'loading' ? 'Please wait...' : 'Submit');

	async function onSubmit(e) {
		e.preventDefault();
		if (nlState === 'loading') return;
		nlState = 'loading';
		failShown = false;
		const r = await api('/store/newsletter', { method: 'POST', body: { email: email.trim(), website } });
		const success = r.ok;
		if (success) {
			nlState = 'success';
			doneText = NL_SUCCESS;
			formHidden = true;
			doneShown = true;
			track('newsletter_signup');
		} else {
			nlState = 'error';
			failText =
				r.error?.code === 'VALIDATION'
					? 'That email doesn’t look right — check it and try again.'
					: r.error?.code === 'RATE_LIMITED'
						? 'Too many tries — please wait a minute and try again.'
						: r.error?.code === 'NETWORK' || r.error?.code === 'TIMEOUT'
							? 'We couldn’t reach Wefeasto — check your connection and try again.'
							: NL_FAIL;
			failShown = true;
		}
		await tick();
		const region = document.querySelector(success ? '.w-form-done' : '.w-form-fail');
		if (region) region.focus();
	}

	/** Typing again clears the error (bublr behaviour). */
	function onEmailInput() {
		if (nlState !== 'error') return;
		nlState = 'idle';
		failShown = false;
	}

	/* The confirm / unsubscribe redirects land on /#newsletter. The browser
	   jumps to the hash while the page is still loading, and it measures the
	   block with its slide-in transform applied (fx.js ix2SlideInBottom,
	   y 100px). At 1280px that left the heading under the sticky nav once the
	   slide finished. So the page lands again on the block's layout box
	   (offsetTop ignores transforms) minus its scroll-margin-top: once after
	   mount, and again when loading ends. It stops as soon as the visitor
	   scrolls or presses anything. Returns a cleanup. */
	function landOnNewsletter() {
		const el = document.getElementById('newsletter');
		if (!el) return () => {};
		const stop = new AbortController();
		const opts = { passive: true, capture: true, signal: stop.signal };
		for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(type, () => stop.abort(), opts);
		const land = () => {
			if (stop.signal.aborted) return;
			let top = 0;
			// offsetTop counts from the offsetParent's padding edge: add its border
			for (let n = el; n; n = n.offsetParent) top += n.offsetTop + (n === el ? 0 : n.clientTop);
			const y = Math.max(0, Math.round(top - (parseFloat(getComputedStyle(el).scrollMarginTop) || 0)));
			if (Math.abs(scrollY - y) < 1) return;
			scrollTo({ top: y, behavior: 'instant' });
			syncLenis();
		};
		// A frame after mount, so the layout's effects (Lenis, ScrollTriggers) exist.
		const frame = requestAnimationFrame(() => {
			land();
			if (document.readyState === 'complete') stop.abort();
			else addEventListener('load', () => requestAnimationFrame(() => (land(), stop.abort())), { once: true, signal: stop.signal });
		});
		return () => {
			cancelAnimationFrame(frame);
			stop.abort();
		};
	}

	onMount(() => {
		nlReady = true;
		const url = new URL(page.url);
		const unland = url.hash === '#newsletter' ? landOnNewsletter() : undefined;
		const key = ['subscribed', 'unsubscribed'].map((k) => url.searchParams.has(k) && `${k}=${url.searchParams.get(k)}`).find(Boolean);
		if (!key) return unland;
		const notice = NL_NOTICES[key];
		if (notice) {
			if (notice.tone === 'done') {
				doneText = notice.text;
				doneShown = true;
				formHidden = !!notice.hideForm;
			} else {
				failText = notice.text;
				failShown = true;
			}
		}
		url.searchParams.delete('subscribed');
		url.searchParams.delete('unsubscribed');
		try {
			replaceState(url, page.state);
		} catch (err) {
			history.replaceState(history.state, '', url);
		}
		return unland;
	});
</script>

<svelte:head>
	<title>Wefeasto — Wake up early, eat fresh &amp; healthy</title>
</svelte:head>

<div class="w-embed"></div>
<div class="page-wrapper">
<div class="section">
<div class="container">
<div class="container">
<div class="w-layout-grid grid-2">
<div id="w-node-_51053bcf-c72f-aa4b-4359-85a29d098b45-bf0e2538" class="div-block-76">
<div class="div-block-78">
<div class="text-block-3">Oats &amp; Muesli</div>
<div class="divider"></div>
<h1 class="heading-2">Wake up early, eat fresh &amp; healthy.</h1>
<div class="divider _32px mobile-24px"></div>
<p class="p-large">Healthy, tasty and honestly affordable — Wefeasto breakfasts are toasted in small batches so every bowl stays super delicious, crunchy and healthy from the first spoon to the last.</p>
<div class="divider _32px mobile-24px"></div>
<div class="w-layout-grid grid-3">
<a href="/shop" class="button w-inline-block"><div>Shop Breakfast</div></a>
<a href="#about" class="button third w-inline-block"><div>Our Story</div></a>
</div>
</div>
</div>
<div id="w-node-_51053bcf-c72f-aa4b-4359-85a29d098b57-bf0e2538" class="div-block-77 _2">
<img src="/images/wefeasto/hero.jpg" fetchpriority="high" alt="Wefeasto breakfast bowl of golden flakes with milk and fresh fruit" class="image-4">
<div class="text-block-3-copy big featured">small batches · big crunch</div>
</div>
</div>
</div>
</div>
</div>
<div id="w-node-ba0f4985-f2b0-39b9-a7d7-445a396a510d-bf0e2538" class="section">
<div id="about" class="w-layout-grid grid-9 _2">
<div class="w-layout-grid grid-4" style="opacity: 1;">
<div id="w-node-a8641b10-905e-c405-8ba3-6c288f282a7e-bf0e2538" class="div-block-81 _3">
<div class="div-block-80">
<div class="text-block-3">Our Story</div>
<div class="divider"></div>
<h2>Healthy, tasty, and honestly affordable.</h2>
<div class="divider"></div>
<p class="p-medium">Discover our true story: here at Wefeasto we wanted to truly make a product that isn't just healthy — it had to be tasty and affordable too. From that one stubborn promise we created the brand you know today.</p>
</div>
</div>
<div id="w-node-a8641b10-905e-c405-8ba3-6c288f282a88-bf0e2538" class="div-block-77">
<img src="/images/wefeasto/story-1.jpg" loading="lazy" alt="Wefeasto kitchen — whole grains and fresh ingredients being prepared" class="image-4 _2">
</div>
</div>
<div class="w-layout-grid grid-4" style="opacity: 1;">
<div id="w-node-a8641b10-905e-c405-8ba3-6c288f282a8b-bf0e2538" class="div-block-81 _3">
<div class="div-block-80">
<div class="text-block-3">Why Wefeasto</div>
<div class="divider"></div>
<h2>Crunchy &amp; delicious, done right.</h2>
<div class="divider"></div>
<p class="p-medium">Just providing you with a crunchy and delicious food — that's the whole job. Every batch of flakes, oats and muesli is toasted for a crunch that lasts in milk, with nothing you wouldn't want in your morning bowl.</p>
</div>
</div>
<div id="w-node-a8641b10-905e-c405-8ba3-6c288f282a95-bf0e2538" class="div-block-77">
<img src="/images/wefeasto/story-2.jpg" loading="lazy" alt="Overhead spread of Wefeasto breakfast bowls topped with berries, banana, nuts and seeds" class="image-4 _2">
</div>
</div>
</div>
</div>
<div id="video" class="section">
<div class="div-block-90">
<div class="div-block-91">
<h2>Watch The Trailer</h2>
<a href="/shop" class="button secondary w-inline-block"><div>Shop the Range</div></a>
</div>
<div class="divider _42px"></div>
<div class="wf-reveal wf-video-frame">
<video class="wf-video wf-parallax-img" autoplay muted loop playsinline poster="/images/wefeasto/video-poster-trailer.jpg"><source src="/videos/wefeasto-trailer.mp4" type="video/mp4"></video>
</div>
</div>
</div>
<div id="w-node-dd144b5c-6379-06c9-58cd-ef630ce39c50-bf0e2538" class="section">
<div id="bestsellers" class="div-block-90">
<div class="div-block-91">
<h2>Shop Bestsellers</h2>
<a href="/shop" class="button secondary w-inline-block"><div>View All</div></a>
</div>
<div class="divider _42px"></div>
<YourUsual variant="home" />
<div class="w-dyn-list">
<div role="list" class="grid-6 w-dyn-items">
{#each bestsellers as card (card.url)}
<div role="listitem" class="collection-item-2 w-dyn-item wf-reveal">
<div data-w-id="6c7bdfcd-c4ed-9b13-3c4b-58161e5af918" class="div-block-84">
<a class="rp-card-cover" href={card.url} aria-label={card.aria} style="position:absolute;inset:0;z-index:4"></a>
<div class="div-block-85">
<img src={card.image} loading="lazy" alt={card.alt} class="image-4">
<div class="text-block-3-copy">{card.cat}</div>
<div style={HOVER_HIDDEN} class="div-block-95"></div>
<a style={HOVER_HIDDEN} href={card.url} class="link-block-5 w-inline-block"><div>View Product</div></a>
</div>
<div class="div-block-83">
<div>{liveCards?.get(card.url)?.priceLine ?? card.priceLine}{#if liveCards?.get(card.url)?.soldOut}{' · '}<span class="wf-soldout-note" data-wf-soldout>Sold out</span>{/if}</div>
<div class="divider _6px"></div>
<h4 class="heading-11">{card.title}</h4>
<div>
<div class="w-layout-grid grid-10">
<div id="w-node-c6a114c0-7923-9e01-402b-b2559d482793-bf0e2538" class="div-block-98">
<div>{card.starLine}</div>
</div>
</div>
</div>
</div>
</div>
</div>
{/each}
</div>
</div>
</div>
</div>
{#if kitchenRecipes.length}<!-- no home-featured recipe: no empty "Fresh from the Kitchen" shelf -->
<div id="w-node-c86b9e10-674e-deca-4b65-44d9e93e9bd3-bf0e2538" class="section">
<div class="div-block-93"></div>
</div>
<div id="w-node-fc8d4fb0-64c7-31d0-d876-e1316ba83454-bf0e2538" class="section">
<div class="div-block-90">
<div class="div-block-91">
<h2>Fresh from the Wefeasto Kitchen</h2>
<a href="/recipes" class="button secondary w-inline-block"><div>View All</div></a>
</div>
<div class="divider _42px"></div>
<div class="collection-list-wrapper w-dyn-list">
<div role="list" class="grid-6 w-dyn-items">
{#each kitchenRecipes as card (card.url)}
<div role="listitem" class="collection-item w-dyn-item wf-reveal">
<div data-w-id="3cc77330-55ef-e7ec-3a0e-0f5389db8440" class="div-block-84">
<a class="rp-card-cover" href={card.url} aria-label={card.aria} style="position:absolute;inset:0;z-index:4"></a>
<div class="div-block-85">
<img src={card.image} loading="lazy" alt={card.alt} class="image-4">
<div class="text-block-3-copy">{card.cat}</div>
<div style={HOVER_HIDDEN} class="div-block-95"></div>
<a style={HOVER_HIDDEN} href={card.url} class="link-block-5 w-inline-block"><div>View Recipe</div></a>
</div>
<div class="div-block-83">
<div class="text-block-4">{card.cat}</div>
<div class="divider _6px"></div>
<h4>{card.title}</h4>
<div>
<div class="w-layout-grid grid-10">
<div class="div-block-96">
<div class="div-block-97"><img src="/images/webclip.png" loading="lazy" alt="Wefeasto Kitchen avatar — dark Wefeasto brand mark" class="image-5"></div>
<div style="background-color:{card.iconColor}" class="div-block-97 _2"><img src={card.iconSrc} loading="lazy" alt={card.iconAlt} class="image-7"></div>
</div>
<div id="w-node-_3cc77330-55ef-e7ec-3a0e-0f5389db8454-bf0e2538" class="div-block-98">
<div>Wefeasto Kitchen</div>
</div>
</div>
</div>
</div>
</div>
</div>
{/each}
</div>
<div role="navigation" aria-label="List" class="w-pagination-wrapper pagination"></div>
</div>
</div>
</div>
{/if}
<div id="w-node-_101e6ef3-ed37-5812-100c-d8e0cac85cb8-bf0e2538" class="section">
<div class="div-block-93"></div>
</div>
<div id="w-node-_86d9c826-757d-dd28-4265-6af9138000de-bf0e2538" class="section">
<div data-w-id="2b9dda2d-278b-a834-d4ea-e34e39d0b8cb" style="opacity: 0;" class="container">
<div data-w-id="246c12c4-43c8-2f57-7b51-a7bf5199d844" class="div-block-100">
<div class="div-block-101" id="newsletter">
<div class="text-block-3">Stay Crunchy</div>
<div class="divider"></div>
<h2 class="heading-3">Fresh recipes and offers, monthly.</h2>
<div class="divider _32px mobile-24px"></div>
<p class="p-large">Join the Wefeasto breakfast club — one email a month with fresh recipes from our kitchen, early access to offers, and first taste of new packs. No spam, just breakfast.</p>
<div class="divider _42px mobile-32px"></div>
<div class="form-block-2 w-form">
<form id="email-form-2" name="email-form-2" data-name="Email Form 2" method="post" class="form" data-wf-page-id="626ae46f2ad86d3fbf0e2538" data-wf-element-id="444d9879-d39a-e4ca-9e12-648151df61f2" aria-label="Email Form 2" aria-busy={nlState === 'loading' || undefined} data-wf-nl-state={nlState} style={formHidden ? 'display: none;' : undefined} onsubmit={onSubmit}>
<input class="text-field-2 text-field-3 w-input" maxlength="256" name="email" data-name="Email" placeholder="Your Email Address" type="email" id="email" required bind:value={email} oninput={onEmailInput}>
<div class="wf-hp"><input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" bind:value={website}></div>
{#if nlState === 'loading'}<span class="wf-nl-spinner"><Spinner label="Subscribing" /></span>{/if}
<input type="submit" data-wait="Please wait..." class="button w-button" value={btnLabel} disabled={!nlReady || nlState === 'loading' || undefined}>
</form>
<div class="w-form-done" tabindex="-1" role="region" aria-label="Email Form 2 success" style={doneShown ? 'display: block;' : undefined}>
<div>{doneText}</div>
</div>
<div class="w-form-fail" tabindex="-1" role="region" aria-label="Email Form 2 failure" style={failShown ? 'display: block;' : undefined}>
<div>{failText}</div>
</div>
</div>
</div>
<img src="/images/wefeasto/bowl-hero.png" loading="lazy" alt="Overhead view of a white bowl of Wefeasto cornflakes in milk with a spoon" class="image-8" style="will-change: transform; transform: translate3d(0px, 0px, 0px) scale3d(1, 1, 1) rotateX(0deg) rotateY(0deg) rotateZ(0deg) skew(0deg, 0deg); transform-style: preserve-3d;">
</div>
</div>
</div>
</div>
<div class="div-block-70">
<div class="marquee-horizontal">
<div class="track-horizontal-alt">
<div class="marquee-text">Wefeasto</div>
<div class="marquee-text">Eat Fresh &amp; Healthy</div>
<div class="marquee-text">Wefeasto</div>
<div class="marquee-text">Small Batches, Big Crunch</div>
<div class="marquee-text">Wefeasto</div>
<div class="marquee-text">Super Delicious, Crunchy &amp; Healthy</div>
<div class="marquee-text">Wefeasto</div>
<div class="marquee-text">Oats &amp; Muesli</div>
<div class="marquee-text">Wefeasto</div>
<div class="marquee-text">Eat Fresh &amp; Healthy</div>
<div class="marquee-text">Wefeasto</div>
<div class="marquee-text">Small Batches, Big Crunch</div>
<div class="marquee-text">Wefeasto</div>
<div class="marquee-text">Super Delicious, Crunchy &amp; Healthy</div>
<div class="marquee-text">Wefeasto</div>
<div class="marquee-text">Oats &amp; Muesli</div>
</div>
<div class="marquee-horizontal-alt-css w-embed"></div>
</div>
</div>
