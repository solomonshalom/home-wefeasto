/*
 * Wefeasto shared motion runtime — Svelte port of js/wefeasto.js (Lenis smooth
 * scroll, page-transition veil, GSAP reveals/hero/parallax/video) plus the four
 * Webflow IX2 interactions that were live on the original site (card hover,
 * slide-in-bottom, .grid-6/.grid-4 scroll fades, mouse parallax on .image-8).
 *
 * GSAP / ScrollTrigger / ScrollToPlugin / Lenis are the exact minified builds
 * from the original site, loaded as globals in app.html.
 *
 * Content must stay visible without JS: every hidden state is set from here.
 * Kill-switch: append ?nofx=1 to any URL for zero motion — same path as
 * prefers-reduced-motion.
 */
import { browser } from '$app/environment';

/* ---------- environment ---------- */

let nofx = false;
let reduceMotion = false;

if (browser) {
	try {
		reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch (e) {
		/* noop */
	}
	refreshNofx();
}

/** Re-read the ?nofx=1 flag (the original re-evaluated it on every page load). */
export function refreshNofx() {
	nofx = /[?&]nofx=1/.test(window.location.search);
}

function hasGsap() {
	return browser && typeof window.gsap !== 'undefined';
}

function hasST() {
	return hasGsap() && typeof window.ScrollTrigger !== 'undefined';
}

export function motionOK() {
	return hasGsap() && !(nofx || reduceMotion);
}

export function noMotion() {
	return nofx || reduceMotion;
}

function $all(sel, root) {
	return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}

// Never touch elements wired to the (ported) data-w-id interaction machinery —
// on the home page the card reveal wrappers contain data-w-id cards, which the
// original site deliberately left to the .grid-6 IX2 fade instead of wf-reveal.
function safeToAnimate(el) {
	return !el.hasAttribute('data-w-id') && !el.querySelector('[data-w-id]');
}

// Expo-out: fast start, long creamy settle (matches gsap 'expo.out').
export function expoOut(x) {
	return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
}

let pluginsRegistered = false;
function ensurePlugins() {
	if (pluginsRegistered || !hasGsap()) return;
	try {
		window.gsap.registerPlugin(window.ScrollTrigger, window.ScrollToPlugin);
	} catch (e) {
		/* plugins missing — degrade gracefully */
	}
	pluginsRegistered = true;
}

/* ---------- Lenis smooth scroll ---------- */

export let lenis = null;

export function initLenis() {
	if (lenis || !motionOK() || typeof window.Lenis === 'undefined') return;
	ensurePlugins();
	try {
		lenis = new window.Lenis({ lerp: 0.1, wheelMultiplier: 1.0, smoothWheel: true });
	} catch (e) {
		lenis = null;
		return;
	}
	if (hasST()) lenis.on('scroll', window.ScrollTrigger.update);
	window.gsap.ticker.add((t) => lenis.raf(t * 1000));
	window.gsap.ticker.lagSmoothing(0);
}

/** Keep Lenis's internal target in sync after the router jumps the scroll position. */
export function syncLenis() {
	if (lenis) lenis.scrollTo(window.scrollY, { immediate: true, force: true });
}

/* ---------- page-transition veil ----------
   The first-paint veil is created by an inline script in app.html (same
   pre-paint mechanism as the original). Here we drive it for SPA navigations:
   fade in before leaving a page, fade out after the next page mounts. */

function veilEl() {
	return document.getElementById('wf-veil');
}

export function hideVeilNow() {
	const veil = veilEl();
	if (!veil) return;
	if (hasGsap()) window.gsap.killTweensOf(veil);
	veil.style.opacity = '0';
	veil.style.visibility = 'hidden';
	veil.style.display = 'none';
	veil.style.pointerEvents = 'none';
}

export function playEnterTransition() {
	const veil = veilEl();
	if (!veil || !motionOK()) {
		hideVeilNow();
		return;
	}
	veil.style.pointerEvents = 'none'; // fresh-page veils never swallow clicks
	window.gsap.killTweensOf(veil);
	window.gsap.to(veil, {
		autoAlpha: 0,
		duration: 0.55,
		ease: 'power2.out',
		delay: 0.05,
		onComplete() {
			veil.style.display = 'none';
		}
	});
	// Gentle content rise. Transform is transient and cleared on complete —
	// recipe pages keep sticky elements inside .page-wrapper and a lingering
	// ancestor transform would break position:sticky.
	const pw = document.querySelector('.page-wrapper');
	if (pw) {
		window.gsap.from(pw, { y: 18, duration: 0.9, ease: 'expo.out', clearProps: 'transform' });
	}
}

/** Fade the veil in; resolves when the page is fully covered. */
export function playLeaveTransition() {
	return new Promise((resolve) => {
		const veil = veilEl();
		if (!veil || !motionOK()) {
			resolve();
			return;
		}
		veil.style.display = 'block';
		veil.style.visibility = 'visible';
		veil.style.pointerEvents = 'auto'; // swallow further clicks mid-leave
		window.gsap.killTweensOf(veil);
		window.gsap.to(veil, {
			autoAlpha: 1,
			duration: 0.3,
			ease: 'power2.in',
			overwrite: true,
			onComplete: resolve
		});
	});
}

/* ---------- cart badge pop (visual only — counts are reactive) ---------- */

export function popCartBadges() {
	if (!motionOK()) return;
	const badges = $all('.wf-cart-count').filter((b) => !b.classList.contains('wf-is-hidden'));
	if (badges.length) {
		window.gsap.fromTo(
			badges,
			{ scale: 0.4 },
			{ scale: 1, duration: 0.45, ease: 'back.out(2.4)', transformOrigin: '50% 50%', overwrite: true, clearProps: 'transform' }
		);
	}
}

/* ---------- per-page GSAP polish (wf-* hooks) ---------- */

const pageCleanups = [];

function onCleanup(fn) {
	pageCleanups.push(fn);
}

function initReveals() {
	const els = $all('.wf-reveal').filter(safeToAnimate);
	if (!els.length || !motionOK() || !hasST()) return; // no JS/motion: stays visible
	window.gsap.set(els, { y: 28, scale: 0.985, autoAlpha: 0, transformOrigin: '50% 100%' });
	window.ScrollTrigger.batch(els, {
		start: 'top 90%',
		once: true,
		onEnter(batch) {
			window.gsap.to(batch, {
				y: 0,
				scale: 1,
				autoAlpha: 1,
				duration: 1.15,
				ease: 'expo.out',
				stagger: 0.09,
				overwrite: true,
				clearProps: 'transform'
			});
		}
	});
	onCleanup(() => window.gsap.set(els, { clearProps: 'all' }));
}

function initHero() {
	if (!motionOK()) return;
	$all('.wf-hero-stagger').forEach((hero) => {
		const kids = Array.prototype.slice.call(hero.children).filter(safeToAnimate);
		if (!kids.length) return;
		window.gsap.set(kids, { y: 24, autoAlpha: 0 });
		window.gsap.to(kids, {
			y: 0,
			autoAlpha: 1,
			duration: 1.0,
			ease: 'expo.out',
			stagger: 0.11,
			delay: 0.15,
			overwrite: true,
			clearProps: 'transform'
		});
		onCleanup(() => window.gsap.set(kids, { clearProps: 'all' }));
	});
}

function initParallax() {
	if (!motionOK() || !hasST()) return;
	$all('.wf-parallax-img').filter(safeToAnimate).forEach((img) => {
		window.gsap.fromTo(
			img,
			{ scale: 1.06 },
			{
				scale: 1,
				ease: 'none',
				scrollTrigger: {
					trigger: img.closest('.wf-parallax') || img,
					start: 'top bottom',
					end: 'bottom top',
					scrub: 0.8
				}
			}
		);
		onCleanup(() => window.gsap.set(img, { clearProps: 'all' }));
	});
}

function initVideo() {
	$all('.wf-video').forEach((video) => {
		// Play only while on screen (muted autoplay loop) — works without GSAP.
		if (video.tagName === 'VIDEO' && 'IntersectionObserver' in window) {
			const io = new IntersectionObserver(
				(entries) => {
					entries.forEach((entry) => {
						if (entry.isIntersecting) {
							const p = video.play();
							if (p && p.catch) p.catch(() => {});
						} else {
							video.pause();
						}
					});
				},
				{ threshold: 0.25 }
			);
			io.observe(video);
			onCleanup(() => io.disconnect());
		}
		// Scale-in + shadow soften on scroll into view.
		if (motionOK() && hasST() && safeToAnimate(video)) {
			window.gsap.fromTo(
				video,
				{ scale: 0.96, boxShadow: '0 30px 60px rgba(51, 51, 51, 0.24)' },
				{
					scale: 1,
					boxShadow: '0 12px 28px rgba(51, 51, 51, 0.10)',
					duration: 1.1,
					ease: 'power3.out',
					scrollTrigger: { trigger: video, start: 'top 82%', once: true }
				}
			);
			onCleanup(() => window.gsap.set(video, { clearProps: 'all' }));
		}
	});
}

/* ---------- Webflow IX2 interactions (ported) ----------
   Extracted from the ix2 registry embedded in js/webflow.js. Easing notes:
   IX2 '' (empty) easing = linear; 'inOutQuad' = power1.inOut;
   'outQuart' = power3.out; [0.175,0.885,0.32,1.275] = classic ease-out-back.
*/

// e-13 / e-15: SCROLL_INTO_VIEW 'fadeIn' preset on .grid-6 (20% offset) and
// .grid-4 (15% offset): start opacity 0, fade to 1 over 1s outQuart, delay .1s.
function ix2GridFades() {
	if (!motionOK() || !hasST()) return;
	const groups = [
		{ sel: '.grid-6', start: 'top 80%' },
		{ sel: '.grid-4', start: 'top 85%' }
	];
	groups.forEach(({ sel, start }) => {
		$all(sel).forEach((el) => {
			window.gsap.set(el, { opacity: 0 });
			window.ScrollTrigger.create({
				trigger: el,
				start,
				once: true,
				onEnter() {
					window.gsap.to(el, { opacity: 1, duration: 1, delay: 0.1, ease: 'power3.out', overwrite: true });
				}
			});
			onCleanup(() => window.gsap.set(el, { clearProps: 'opacity' }));
		});
	});
}

// e-17…e-20: MOUSE_OVER 'a-5' / MOUSE_OUT 'a-6' on the home-page cards
// (elements carrying the original data-w-id hooks). Children:
//   .div-block-95 (white disc)  and  .link-block-5 (View Product/Recipe pill).
// a-5: initial scale(0,0) both; on hover disc → scale 10 (300ms linear),
//      then pill → scale 1 (200ms ease-out-back).
// a-6: pill → scale 0 (200ms inOutQuad), disc → scale 0 (200ms inOutQuad, +100ms delay).
const HOVER_IDS = ['6c7bdfcd-c4ed-9b13-3c4b-58161e5af918', '3cc77330-55ef-e7ec-3a0e-0f5389db8440'];

function ix2CardHovers() {
	if (!hasGsap()) return;
	const sel = HOVER_IDS.map((id) => '[data-w-id="' + id + '"]').join(', ');
	$all(sel).forEach((card) => {
		const disc = card.querySelector('.div-block-95');
		const pill = card.querySelector('.link-block-5');
		if (!disc || !pill) return;
		// useFirstGroupAsInitialState — matches the inline styles baked into the markup
		window.gsap.set([disc, pill], { scaleX: 0, scaleY: 0 });
		const over = () => {
			window.gsap.killTweensOf([disc, pill]);
			const tl = window.gsap.timeline();
			tl.to(disc, { scaleX: 10, scaleY: 10, duration: 0.3, ease: 'none' });
			tl.to(pill, { scaleX: 1, scaleY: 1, duration: 0.2, ease: 'back.out(1.70158)' });
		};
		const out = () => {
			window.gsap.killTweensOf([disc, pill]);
			window.gsap.to(pill, { scaleX: 0, scaleY: 0, duration: 0.2, ease: 'power1.inOut' });
			window.gsap.to(disc, { scaleX: 0, scaleY: 0, duration: 0.2, delay: 0.1, ease: 'power1.inOut' });
		};
		card.addEventListener('mouseenter', over);
		card.addEventListener('mouseleave', out);
		onCleanup(() => {
			card.removeEventListener('mouseenter', over);
			card.removeEventListener('mouseleave', out);
		});
	});
}

// e-38: SCROLL_INTO_VIEW 'slideInBottom' on the newsletter container
// (data-w-id 2b9dda2d…): opacity 0 + y 100px → opacity 1, y 0 over 1s
// outQuart, 10% offset, 100ms delay.
function ix2SlideInBottom() {
	const els = $all('[data-w-id="2b9dda2d-278b-a834-d4ea-e34e39d0b8cb"]');
	if (!els.length) return;
	if (!motionOK() || !hasST()) {
		// markup bakes opacity:0 — never leave content hidden without motion
		els.forEach((el) => (el.style.opacity = '1'));
		return;
	}
	els.forEach((el) => {
		window.gsap.set(el, { opacity: 0, y: 100 });
		window.ScrollTrigger.create({
			trigger: el,
			start: 'top 90%',
			once: true,
			onEnter() {
				window.gsap.to(el, { opacity: 1, y: 0, duration: 1, delay: 0.1, ease: 'power3.out', overwrite: true });
			}
		});
		onCleanup(() => window.gsap.set(el, { clearProps: 'all' }));
	});
}

// e-37: MOUSE_MOVE 'a-12' over .div-block-100 (data-w-id 246c12c4…) drives the
// child .image-8: translate ±16px on X and Y, resting state centered,
// IX2 smoothing 97.5 → per-frame lerp factor 0.025.
function ix2MouseParallax() {
	if (!motionOK()) return;
	$all('[data-w-id="246c12c4-43c8-2f57-7b51-a7bf5199d844"]').forEach((zone) => {
		const img = zone.querySelector('.image-8');
		if (!img) return;
		let targetX = 0.5,
			targetY = 0.5,
			curX = 0.5,
			curY = 0.5;
		const onMove = (e) => {
			const r = zone.getBoundingClientRect();
			if (!r.width || !r.height) return;
			targetX = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
			targetY = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
		};
		const tick = () => {
			curX += (targetX - curX) * 0.025;
			curY += (targetY - curY) * 0.025;
			window.gsap.set(img, { x: (curX - 0.5) * 32, y: (curY - 0.5) * 32 });
		};
		zone.addEventListener('mousemove', onMove);
		window.gsap.ticker.add(tick);
		onCleanup(() => {
			zone.removeEventListener('mousemove', onMove);
			window.gsap.ticker.remove(tick);
			window.gsap.set(img, { clearProps: 'transform' });
		});
	});
}

/* ---------- page lifecycle ---------- */

let loadRefreshWired = false;

/** Set up all scroll/hover/motion effects for the current document. */
export function pageSetup() {
	if (!browser) return;
	ensurePlugins();
	initReveals();
	initHero();
	initParallax();
	initVideo();
	ix2GridFades();
	ix2CardHovers();
	ix2SlideInBottom();
	ix2MouseParallax();
	if (hasST()) {
		window.ScrollTrigger.refresh();
		// Belt and braces (as the original): re-measure once assets/fonts land.
		if (!loadRefreshWired) {
			loadRefreshWired = true;
			window.addEventListener('load', () => window.ScrollTrigger.refresh());
		}
		window.setTimeout(() => {
			if (hasST()) window.ScrollTrigger.refresh();
		}, 350);
	}
}

/** Kill everything the current page registered (before the DOM is swapped). */
export function pageTeardown() {
	if (!browser) return;
	if (hasST()) window.ScrollTrigger.getAll().forEach((t) => t.kill());
	while (pageCleanups.length) {
		try {
			pageCleanups.pop()();
		} catch (e) {
			/* noop */
		}
	}
}

/* ---------- delegated same-page anchor smooth scroll ---------- */

let anchorsWired = false;

export function initAnchorScroll() {
	if (anchorsWired || !browser) return;
	anchorsWired = true;
	// Capture phase: runs ahead of SvelteKit's router so `#` and same-page
	// anchors behave exactly like the original site (Lenis glide, -24px offset).
	document.addEventListener(
		'click',
		(e) => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			if (!e.target.closest) return;
			const anchor = e.target.closest('a[href^="#"]');
			if (!anchor) return;
			const href = anchor.getAttribute('href');
			if (!href || href.length <= 1) return;
			const target = document.getElementById(href.slice(1));
			if (!target) return;
			e.preventDefault();
			if (lenis) {
				lenis.scrollTo(target, { offset: -24, duration: 1.1, easing: expoOut });
			} else if (motionOK() && typeof window.ScrollToPlugin !== 'undefined') {
				window.gsap.to(window, { scrollTo: { y: target, offsetY: 24 }, duration: 0.8, ease: 'power2.inOut' });
			} else {
				target.scrollIntoView(noMotion() ? {} : { behavior: 'smooth' });
			}
		},
		true
	);
}
