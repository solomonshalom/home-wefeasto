<script>
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { cartCount } from '$lib/cart.js';
	import { openSearch } from '$lib/search.js';

	let mounted = $state(false);
	onMount(() => (mounted = true));

	const path = $derived($page.url.pathname);
	const isHome = $derived(path === '/');
	const isShop = $derived(path === '/shop');
	const isRecipes = $derived(path === '/recipes');
	// Badge text/class only apply after hydration — the server-rendered nav is
	// byte-identical to the original static pages (empty badge, no class).
	const badgeText = $derived(mounted && $cartCount > 0 ? String($cartCount) : '');

	function onSearchClick(e) {
		e.preventDefault();
		openSearch();
	}
</script>

<div class="div-block-79"><div data-animation="default" data-collapse="medium" data-duration="400" data-easing="ease" data-easing2="ease" role="banner" class="navbar w-nav"><div class="container"><div class="w-layout-grid grid-7"><a href="/" aria-current={isHome ? 'page' : undefined} class="brand w-nav-brand{isHome ? ' w--current' : ''}" aria-label="Wefeasto home"><img src="/images/wefeasto/logo.png" alt="Wefeasto" class="wf-brand-logo"></a><div id="w-node-a41d7150-e897-30e2-9250-792e96dccbcc-96dccbc0" class="w-layout-grid grid-8"><nav role="navigation" id="w-node-a41d7150-e897-30e2-9250-792e96dccbcd-96dccbc0" class="nav-menu w-nav-menu"><div class="w-layout-grid grid"><a id="w-node-a41d7150-e897-30e2-9250-792e96dccbcf-96dccbc0" href="/shop" aria-current={isShop ? 'page' : undefined} class="link-block w-inline-block{isShop ? ' w--current' : ''}"><div>Shop</div></a><a id="w-node-a41d7150-e897-30e2-9250-792e96dccbd2-96dccbc0" href="/recipes" aria-current={isRecipes ? 'page' : undefined} class="link-block w-inline-block{isRecipes ? ' w--current' : ''}"><div>Recipes</div></a><a id="w-node-a41d7150-e897-30e2-9250-792e96dccbd5-96dccbc0" href="/#about" class="link-block w-inline-block"><div>Our Story</div></a><a id="w-node-a41d7150-e897-30e2-9250-792e96dccbd8-96dccbc0" href="/#contact" class="link-block w-inline-block"><div>Contact</div></a></div></nav><div class="div-block"></div><a id="w-node-a41d7150-e897-30e2-9250-792e96dccbe5-96dccbc0" href="#" class="link-block-3 wf-search-open w-inline-block" aria-label="Search" onclick={onSearchClick}><img src="/images/626ae46f2ad86d0fa10e25c9_magnifying_glass_light.svg" loading="lazy" id="w-node-a41d7150-e897-30e2-9250-792e96dccbe6-96dccbc0" alt="Search" class="image-3"></a><div class="div-block"></div><a href="/login" class="link-block-3 _2 w-inline-block" aria-label="Login"><img src="/images/626ae46f2ad86d45570e25c8_user_light.svg" loading="lazy" id="w-node-a41d7150-e897-30e2-9250-792e96dccbe9-96dccbc0" alt="Account" class="image-3"></a><div class="div-block"></div><a href="/cart" class="link-block-3 _3 wf-cart-anchor w-inline-block" aria-label="Cart"><img src="/images/626ae46f2ad86d515b0e25c7_handbag_light.svg" loading="lazy" id="w-node-a41d7150-e897-30e2-9250-792e96dccbec-96dccbc0" alt="Cart" class="image-3"><span class="wf-cart-count{mounted && $cartCount === 0 ? ' wf-is-hidden' : ''}">{badgeText}</span></a></div></div></div><div class="w-nav-overlay" data-wf-ignore="" id="w-nav-overlay-0"></div></div></div>
