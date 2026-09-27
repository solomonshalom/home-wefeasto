<script>
	/*
	 * Site footer. Additions (roadmap M7/S3), all invisible until they apply:
	 * - `pages`: published CMS policy pages ({slug, title}) linked after Privacy;
	 * - `legal`: the entity name replaces "Wefeasto" in the legal line, and
	 *   "· FSSAI Lic. No. …" is appended, each only when set;
	 * - the Login link becomes Account once a logged-in session is known (after
	 *   mount, so the prerendered markup is unchanged).
	 * Both props come from +layout.server.js at prerender time.
	 */
	import { onMount } from 'svelte';
	import { user } from '$lib/session.js';

	let { pages = [], legal = null } = $props();

	let mounted = $state(false);
	onMount(() => (mounted = true));

	const signedIn = $derived(mounted && !!$user);
	const policyLinks = $derived(Array.isArray(pages) ? pages.filter((p) => p && typeof p.slug === 'string' && typeof p.title === 'string') : []);
	const entity = $derived((typeof legal?.entityName === 'string' && legal.entityName.trim()) || 'Wefeasto');
	const fssai = $derived(typeof legal?.fssaiLicence === 'string' && /^\d{14}$/.test(legal.fssaiLicence) ? legal.fssaiLicence : '');
</script>

<div class="footer-section" id="contact"><div class="container-2"><div class="w-layout-grid footer-links-grid"><div id="w-node-d632aeda-f915-af15-d7a9-5ceec78a5207-c78a5204" class="logo-wrap"><a href="/" class="company-logo-link w-inline-block"><img src="/images/wefeasto/logo.png" alt="Wefeasto" class="wf-brand-logo"></a><a href="tel:+919845262777" class="contact-wrap w-inline-block"><img src="/images/626ae46f2ad86d66130e25d4_phone_light.svg" loading="lazy" alt="Phone" class="icon-2"><div class="contact">+91-9845262777</div></a><div class="contact-wrap"><img src="/images/626ae46f2ad86ddb840e25d3_map_pin_light.svg" loading="lazy" alt="Hours" class="icon-2"><div class="contact">Mon–Sat 09:00–18:00 · Sunday closed</div></div></div><div id="w-node-d632aeda-f915-af15-d7a9-5ceec78a521e-c78a5204" class="footer-link-column"><div class="footer-links-title">Browse</div><a href="/shop" class="footer-link">Shop</a><a href="/recipes" class="footer-link">Recipes</a><a href="/cart" class="footer-link">Cart</a><a href={signedIn ? '/account' : '/login'} class="footer-link">{signedIn ? 'Account' : 'Login'}</a></div><div id="w-node-d632aeda-f915-af15-d7a9-5ceec78a5230-c78a5204" class="footer-link-column"><div class="footer-links-title">Company</div><a href="/#about" class="footer-link">Our Story</a><a href="/#contact" class="footer-link">Contact</a><a href="/terms" class="footer-link">Terms</a><a href="/privacy" class="footer-link">Privacy</a>{#each policyLinks as p (p.slug)}<a href="/{p.slug}" class="footer-link">{p.title}</a>{/each}</div><div id="w-node-d632aeda-f915-af15-d7a9-5ceec78a5229-c78a5204" class="footer-link-column"><div class="footer-links-title">Follow</div><a href="https://www.facebook.com/pages/category/Health-Food-Store/Wefeasto-100212491838740/" target="_blank" rel="noopener" class="footer-link">Facebook</a><a href="https://www.instagram.com/wefeasto/?hl=en" target="_blank" rel="noopener" class="footer-link">Instagram</a><a href="https://www.linkedin.com/search/results/all/?keywords=WeFeasto" target="_blank" rel="noopener" class="footer-link">LinkedIn</a></div></div><div class="grey-divider"></div><div class="legal-wrapper"><div class="social-links-grid"><a href="https://www.instagram.com/wefeasto/?hl=en" target="_blank" rel="noopener" class="footer-link-block w-inline-block" aria-label="Wefeasto on Instagram"><img src="/images/626ae46f2ad86d5fb10e25c0_instagram_20_4_.svg" loading="lazy" alt="Instagram" class="social-icon"></a><a href="https://www.youtube.com/channel/UCISwzMH69iOfunyWGJhuuUg/" target="_blank" rel="noopener" class="footer-link-block w-inline-block" aria-label="Wefeasto on YouTube"><img src="/images/626ae46f2ad86d772b0e25c2_youtube_20_2_.svg" loading="lazy" alt="YouTube" class="social-icon"></a></div><div class="legal-text">© 2026 {entity}. All rights reserved{fssai ? ` · FSSAI Lic. No. ${fssai}` : ''}</div></div></div></div>
