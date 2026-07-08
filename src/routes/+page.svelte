<script>
	import { tick } from 'svelte';

	// Inline transform baked into the original markup — the hidden initial
	// state of the card-hover machinery (Webflow IX2 useFirstGroupAsInitialState).
	const HOVER_HIDDEN =
		'transform: translate3d(0px, 0px, 0px) scale3d(0, 0, 1) rotateX(0deg) rotateY(0deg) rotateZ(0deg) skew(0deg, 0deg); transform-style: preserve-3d;';

	const bestsellers = [
		{
			url: '/products/cornflakes',
			aria: 'View Cornflakes',
			image: '/images/wefeasto/product-cornflakes.jpg',
			alt: 'Bowl of Wefeasto Cornflakes with cold milk',
			cat: 'Flakes',
			priceLine: '₹175 · 120 cal',
			title: 'Cornflakes',
			starLine: '★ 5.0 · 500 g'
		},
		{
			url: '/products/steel-cut-oats',
			aria: 'View Steel-Cut Oats',
			image: '/images/wefeasto/product-steel-cut-oats.jpg',
			alt: 'Warm bowl of Wefeasto Steel-Cut Oats porridge topped with fruit',
			cat: 'Oats',
			priceLine: '₹135 · 80 cal',
			title: 'Steel-Cut Oats',
			starLine: '★ 4.3 · 500 g'
		},
		{
			url: '/products/muesli',
			aria: 'View Muesli',
			image: '/images/wefeasto/product-muesli.jpg',
			alt: 'Wefeasto Muesli with toasted grains, nuts and dried fruit',
			cat: 'Muesli',
			priceLine: '₹250 · 100 cal',
			title: 'Muesli',
			starLine: '★ 4.0 · 400 g'
		},
		{
			url: '/products/choco-flakes',
			aria: "View Choco's",
			image: '/images/wefeasto/product-choco-flakes.jpg',
			alt: "Bowl of Wefeasto Choco's chocolate flakes with milk",
			cat: 'Flakes',
			priceLine: '₹200 · 120 cal',
			title: "Choco's",
			starLine: '★ 4.5 · 250 g'
		}
	];

	const kitchenRecipes = [
		{
			url: '/recipes/wf-berry-overnight-steel-cut-oats',
			aria: 'Open recipe: Berry Overnight Steel-Cut Oats',
			image: '/images/wefeasto/recipe-berry-overnight-steel-cut-oats.jpg',
			alt: 'Jar of overnight steel-cut oats layered with fresh berries',
			cat: 'Breakfast',
			title: 'Berry Overnight Steel-Cut Oats',
			iconColor: '#ff8d5e',
			iconSrc: '/images/626aeef4f317e035c740e924_heart_fill_20_2_.svg',
			iconAlt: 'Breakfast category heart icon'
		},
		{
			url: '/recipes/wf-muesli-yogurt-parfait',
			aria: 'Open recipe: 5-Minute Muesli Yogurt Parfait',
			image: '/images/wefeasto/recipe-muesli-yogurt-parfait.jpg',
			alt: 'Muesli yogurt parfait layered in a glass with fresh fruit',
			cat: 'Breakfast',
			title: '5-Minute Muesli Yogurt Parfait',
			iconColor: '#ff8d5e',
			iconSrc: '/images/626aeef4f317e035c740e924_heart_fill_20_2_.svg',
			iconAlt: 'Breakfast category heart icon'
		},
		{
			url: '/recipes/wf-choco-flakes-energy-bars',
			aria: 'Open recipe: No-Bake Choco Flakes Energy Bars',
			image: '/images/wefeasto/recipe-choco-flakes-energy-bars.jpg',
			alt: 'Stack of no-bake choco flakes energy bars',
			cat: 'Kids',
			title: 'No-Bake Choco Flakes Energy Bars',
			iconColor: '#d498eb',
			iconSrc: '/images/626aeeee73f41522db4989fb_hamburger_fill.svg',
			iconAlt: 'Kids category hamburger icon'
		},
		{
			url: '/recipes/wf-health-mix-smoothie-bowl',
			aria: 'Open recipe: Health Mix Banana Smoothie Bowl',
			image: '/images/wefeasto/recipe-health-mix-smoothie-bowl.jpg',
			alt: 'Health mix banana smoothie bowl topped with fruit and nuts',
			cat: 'Breakfast',
			title: 'Health Mix Banana Smoothie Bowl',
			iconColor: '#ff8d5e',
			iconSrc: '/images/626aeef4f317e035c740e924_heart_fill_20_2_.svg',
			iconAlt: 'Breakfast category heart icon'
		}
	];

	/* Newsletter form — port of the Webflow runtime's form handler: POST the
	   same payload to the same endpoint; code 200 → done block replaces the
	   form, anything else (incl. offline) → fail block below the form. */
	let email = $state('');
	let btnLabel = $state('Submit');
	let submitting = $state(false);
	let formDone = $state(false);
	let formFail = $state(false);

	async function onSubmit(e) {
		e.preventDefault();
		if (submitting) return;
		submitting = true;
		btnLabel = 'Please wait...';
		const body = new URLSearchParams();
		body.set('name', 'Email Form 2');
		body.set('pageId', '626ae46f2ad86d3fbf0e2538');
		body.set('elementId', '444d9879-d39a-e4ca-9e12-648151df61f2');
		body.set('domain', 'the-foodie-fact-v2.webflow.io');
		body.set('source', window.location.href);
		body.set('test', 'false');
		body.set('fields[Email]', email.trim());
		body.set('dolphin', 'false');
		let success = false;
		try {
			const res = await fetch('https://webflow.com/api/v1/form/626ae46f2ad86d0f390e253b', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString()
			});
			const json = await res.json();
			success = !!(json && json.code === 200);
		} catch (err) {
			success = false;
		}
		formDone = success;
		formFail = !success;
		btnLabel = 'Submit';
		submitting = false;
		await tick();
		const region = document.querySelector(success ? '.w-form-done' : '.w-form-fail');
		if (region) region.focus();
	}
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
<img src="/images/wefeasto/hero.jpg" loading="lazy" alt="Wefeasto breakfast bowl of golden flakes with milk and fresh fruit" class="image-4">
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
<div class="wf-reveal">
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
<div>{card.priceLine}</div>
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
<div id="w-node-_101e6ef3-ed37-5812-100c-d8e0cac85cb8-bf0e2538" class="section">
<div class="div-block-93"></div>
</div>
<div id="w-node-_86d9c826-757d-dd28-4265-6af9138000de-bf0e2538" class="section">
<div data-w-id="2b9dda2d-278b-a834-d4ea-e34e39d0b8cb" style="opacity: 0;" class="container">
<div data-w-id="246c12c4-43c8-2f57-7b51-a7bf5199d844" class="div-block-100">
<div class="div-block-101">
<div class="text-block-3">Stay Crunchy</div>
<div class="divider"></div>
<h2 class="heading-3">Fresh recipes and offers, monthly.</h2>
<div class="divider _32px mobile-24px"></div>
<p class="p-large">Join the Wefeasto breakfast club — one email a month with fresh recipes from our kitchen, early access to offers, and first taste of new packs. No spam, just breakfast.</p>
<div class="divider _42px mobile-32px"></div>
<div class="form-block-2 w-form">
<form id="email-form-2" name="email-form-2" data-name="Email Form 2" method="get" class="form" data-wf-page-id="626ae46f2ad86d3fbf0e2538" data-wf-element-id="444d9879-d39a-e4ca-9e12-648151df61f2" aria-label="Email Form 2" style={formDone ? 'display: none;' : undefined} onsubmit={onSubmit}>
<input class="text-field-2 text-field-3 w-input" maxlength="256" name="email" data-name="Email" placeholder="Your Email Address" type="email" id="email" required bind:value={email}>
<input type="submit" data-wait="Please wait..." class="button w-button" value={btnLabel} disabled={submitting || undefined}>
</form>
<div class="w-form-done" tabindex="-1" role="region" aria-label="Email Form 2 success" style={formDone ? 'display: block;' : undefined}>
<div>Thank you! Your submission has been received!</div>
</div>
<div class="w-form-fail" tabindex="-1" role="region" aria-label="Email Form 2 failure" style={formFail ? 'display: block;' : undefined}>
<div>Oops! Something went wrong while submitting the form.</div>
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
