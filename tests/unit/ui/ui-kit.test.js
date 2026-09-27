/*
 * ui-kit unit tests: motion tokens + transition helpers, the reveal
 * attachment's no-motion path, the server-rendered markup of the UI-kit
 * components (what prerendered pages ship before hydration), and the
 * build step that makes build/404.html work at any URL depth.
 * Browser behaviour is covered by the Playwright specs in e2e/ui/.
 */
import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import { bezier, EASE, CSS_EASE, DURATION, STAGGER, ms, slideX, rise, exitX, scaleIn } from '$lib/motion.js';
import { reveal } from '$lib/reveal.js';
import Spinner from '$lib/components/Spinner.svelte';
import Squiggle from '$lib/components/Squiggle.svelte';
import PeepWalk from '$lib/components/PeepWalk.svelte';
import MobileNav, { mobileNav, openMobileNav, closeMobileNav, toggleMobileNav } from '$lib/components/MobileNav.svelte';
import NotFound from '$lib/components/NotFound.svelte';
import { rootAbsolute, relativeRefs } from '../../../svelte.config.js';

/** Reference cubic-bezier by brute-force sampling of the parametric curve. */
function refBezier(x1, y1, x2, y2, x) {
	const B = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
	let best = 0;
	let bestErr = Infinity;
	for (let i = 0; i <= 20000; i++) {
		const t = i / 20000;
		const e = Math.abs(B(t, x1, x2) - x);
		if (e < bestErr) {
			bestErr = e;
			best = t;
		}
	}
	return B(best, y1, y2);
}

const strip = (html) => html.replace(/<!--[^>]*-->/g, '');

describe('motion tokens', () => {
	it('bublr durations and staggers, in ms', () => {
		expect(DURATION).toEqual({ instant: 100, fast: 150, normal: 200, slow: 300 });
		expect(STAGGER).toEqual({ fast: 30, normal: 50, list: 40 });
	});

	it('CSS strings match the easing functions', () => {
		const parse = (s) => s.match(/[\d.]+/g).map(Number);
		for (const key of Object.keys(EASE)) {
			const [a, b, c, d] = parse(CSS_EASE[key]);
			for (const x of [0.1, 0.33, 0.5, 0.8]) {
				expect(EASE[key](x)).toBeCloseTo(refBezier(a, b, c, d, x), 3);
			}
		}
	});

	it('bezier(): endpoints, linear case, CSS "ease", monotonic', () => {
		const ease = bezier(0.25, 0.1, 0.25, 1);
		expect(ease(0)).toBe(0);
		expect(ease(1)).toBe(1);
		expect(ease(-0.5)).toBe(0);
		expect(ease(1.5)).toBe(1);
		expect(bezier(0, 0, 1, 1)(0.37)).toBeCloseTo(0.37, 5);
		expect(ease(0.5)).toBeCloseTo(0.8024, 3); // the well-known CSS 'ease' midpoint
		let prev = 0;
		for (let i = 1; i <= 100; i++) {
			const v = EASE.settle(i / 100);
			expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = v;
		}
	});

	it('ms() passes durations through when motion is allowed (server/no flags)', () => {
		expect(ms(200)).toBe(200);
		expect(ms(0)).toBe(0);
	});
});

describe('Svelte transition helpers', () => {
	it('slideX: bublr panel (x 100% -> 0, opacity .5 -> 1, .2s enter)', () => {
		const t = slideX(null);
		expect(t.duration).toBe(200);
		expect(t.easing).toBe(EASE.enter);
		expect(t.css(0, 1)).toBe('transform: translateX(100%); opacity: 0.5;');
		expect(t.css(1, 0)).toBe('transform: translateX(0%); opacity: 1;');
		expect(slideX(null, { from: -1 }).css(0, 1)).toBe('transform: translateX(-100%); opacity: 0.5;');
		expect(slideX(null, { duration: 150, easing: EASE.exit }).duration).toBe(150);
	});

	it('rise / exitX / scaleIn', () => {
		const r = rise(null, { delay: 40 });
		expect(r.duration).toBe(250);
		expect(r.delay).toBe(40);
		expect(r.css(0, 1)).toBe('opacity: 0; transform: translateY(6px);');
		expect(r.css(1, 0)).toBe('opacity: 1; transform: translateY(0px);');
		expect(exitX(null).css(0, 1)).toBe('opacity: 0; transform: translateX(-20px);');
		expect(exitX(null).duration).toBe(150);
		expect(scaleIn(null).css(0, 1)).toBe('opacity: 0; transform: scale(0.95);');
		expect(scaleIn(null).css(1, 0)).toBe('opacity: 1; transform: scale(1);');
	});
});

describe('reveal attachment', () => {
	it('returns an attachment that is a no-op without GSAP/motion', () => {
		const attach = reveal({ children: true, stagger: 0.04 });
		expect(typeof attach).toBe('function');
		const node = { children: [], style: {} };
		expect(attach(node)).toBeUndefined(); // nothing hidden, nothing to clean up
		expect(node.style).toEqual({});
	});
});

describe('server-rendered markup', () => {
	it('Spinner: decorative currentColor SVG by default', () => {
		const html = strip(render(Spinner).body);
		expect(html).toContain('class="wf-spinner"');
		expect(html).toContain('aria-hidden="true"');
		expect(html).not.toContain('role=');
		expect(html).toContain('stroke="currentColor"');
		expect(html).toContain('fill="currentColor"');
		expect(html).toContain('d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"');
		expect(html).toMatch(/style="width: 1em; height: 1em;"/);
	});

	it('Spinner: labelled when it is the only signal', () => {
		const html = strip(render(Spinner, { props: { label: 'Confirming your payment', size: '24px', class: 'x' } }).body);
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-label="Confirming your payment"');
		expect(html).not.toContain('aria-hidden');
		expect(html).toContain('class="wf-spinner x"');
		expect(html).toContain('width: 24px');
	});

	it('Squiggle: bublr path, palette tone classes, drawn without JS', () => {
		const html = strip(render(Squiggle).body);
		expect(html).toContain('class="wf-squiggle"');
		expect(html).toContain('viewBox="0 0 200 12"');
		expect(html).toContain('width="200" height="12"');
		expect(html).toContain('d="M3 8 Q12.5 1.5 22 8 T41 8 T60 8 T79 8 T98 8 T117 8 T136 8 T155 8 T174 8 T193 8"');
		expect(html).toContain('stroke-width="2.5"');
		expect(html).not.toContain('stroke-dash'); // hidden state only ever comes from JS
		const coral = strip(render(Squiggle, { props: { tone: 'coral', width: 100 } }).body);
		expect(coral).toContain('class="wf-squiggle wf-squiggle-coral"');
		expect(coral).toContain('width="100" height="6"');
	});

	it('PeepWalk: a bare decorative canvas (runtime attributes only after mount)', () => {
		const html = strip(render(PeepWalk).body);
		expect(html).toBe('<canvas class="wf-peepwalk" aria-hidden="true"></canvas>');
		// bublr's props: height / width (CSS lengths; defaults 350px x 100% come from CSS)
		expect(strip(render(PeepWalk, { props: { height: '350px', width: '100%' } }).body)).toBe(
			'<canvas class="wf-peepwalk" aria-hidden="true" style="height: 350px; width: 100%;"></canvas>'
		);
		expect(strip(render(PeepWalk, { props: { height: '240px', class: 'wf-order-crowd' } }).body)).toBe(
			'<canvas class="wf-peepwalk wf-order-crowd" aria-hidden="true" style="height: 240px;"></canvas>'
		);
	});

	it('MobileNav: an empty host until opened; shared open state', () => {
		closeMobileNav();
		expect(strip(render(MobileNav).body)).toBe('<div id="wf-mobile-nav" class="wf-mnav-host"></div>');
		openMobileNav();
		expect(mobileNav.open).toBe(true);
		toggleMobileNav();
		expect(mobileNav.open).toBe(false);
		toggleMobileNav();
		expect(mobileNav.open).toBe(true);
		closeMobileNav();
		expect(mobileNav.open).toBe(false);
	});
});

describe('404 page', () => {
	const cardsIn = (html) => [...html.matchAll(/<a[^>]*href="(\/products\/[a-z-]+)"[^>]*class="[^"]*wf-card-link/g)].map((m) => m[1]);

	it('NotFound (404): the branded copy, both calls to action and three bestsellers, all in the markup', () => {
		const { head, body } = render(NotFound, { props: { status: 404 } });
		const html = strip(body);
		expect(head).toContain('<title>Wefeasto — Page not found</title>');
		expect(head).toMatch(/<meta name="robots" content="noindex"\/?>/);
		expect(head).toContain('<noscript><style>.wf-notfound-search{display:none!important}</style></noscript>');
		expect(html).toContain('<div class="wf-chip">Error 404</div>');
		expect(html).toContain('<h1 class="heading-2">This page wandered off.</h1>');
		expect(html).toMatch(/<button type="button" class="button w-button wf-notfound-search"[^>]*>Search Wefeasto<\/button>/);
		expect(html).toContain('<a href="/shop" class="button secondary w-inline-block"><div>Shop Breakfast</div></a>');
		expect((html.match(/ wf-card"/g) || []).length).toBe(3);
		const links = cardsIn(html);
		expect(links).toHaveLength(3);
		expect(new Set(links).size).toBe(3);
		expect(html).toContain('wf-notfound-actions');
	});

	it('NotFound (other status): the generic error copy', () => {
		const { head, body } = render(NotFound, { props: { status: 500 } });
		const html = strip(body);
		expect(head).toContain('<title>Wefeasto — Something went wrong</title>');
		expect(html).toContain('<div class="wf-chip">Error 500</div>');
		expect(html).toContain('Something went wrong.');
		expect(html).not.toContain('wandered off');
		expect(strip(render(NotFound).body)).toContain('Error 404'); // default status
	});

	// What SvelteKit prerenders at the root with paths.relative (the default).
	const ROOT_PAGE = [
		'<link href="./css/webflow.css" rel="stylesheet" type="text/css">',
		"<link rel='icon' href='./images/wefeasto/favicon.png'>",
		'<script src="./js/gsap.min.js"></script>',
		'<link href="./_app/immutable/entry/start.X.js" rel="modulepreload">',
		'<img src="/images/a.jpg" srcset="./images/a-1x.jpg 1x, ./images/a-2x.jpg 2x" alt="">',
		'<a href="/shop">Shop</a><a href="#">Top</a><a href="tel:+911">Call</a><a href="https://x.test/a">X</a>',
		'<a href="?q=1">Q</a><img src="data:image/png;base64,AAAA" alt=""><div data-wf-add="./not-a-url"></div>',
		'<script>{ __sveltekit_1 = { base: new URL(".", location).pathname.slice(0, -1) };',
		'Promise.all([import("./_app/immutable/entry/start.X.js"), import("./_app/immutable/entry/app.Y.js")]); }</script>'
	].join('\n');

	it('rootAbsolute(): "./" becomes "/" in URL attributes, srcset lists and the boot imports; base becomes ""', () => {
		const out = rootAbsolute(ROOT_PAGE);
		expect(out).toContain('<link href="/css/webflow.css" rel="stylesheet" type="text/css">');
		expect(out).toContain("<link rel='icon' href='/images/wefeasto/favicon.png'>");
		expect(out).toContain('<script src="/js/gsap.min.js"></script>');
		expect(out).toContain('<link href="/_app/immutable/entry/start.X.js" rel="modulepreload">');
		expect(out).toContain('srcset="/images/a-1x.jpg 1x, /images/a-2x.jpg 2x"');
		expect(out).toContain('import("/_app/immutable/entry/start.X.js"), import("/_app/immutable/entry/app.Y.js")');
		expect(out).toContain('__sveltekit_1 = { base: "" }');
		expect(relativeRefs(out)).toEqual([]);
	});

	it('rootAbsolute(): leaves absolute, external, hash, query, data and non-URL attributes alone; idempotent', () => {
		const out = rootAbsolute(ROOT_PAGE);
		for (const keep of [
			'<a href="/shop">',
			'<a href="#">',
			'<a href="tel:+911">',
			'<a href="https://x.test/a">',
			'<a href="?q=1">',
			'src="data:image/png;base64,AAAA"',
			'data-wf-add="./not-a-url"',
			'<img src="/images/a.jpg"'
		])
			expect(out).toContain(keep);
		expect(rootAbsolute(out)).toBe(out);
		expect(rootAbsolute("<script>{ x = { base: new URL('.', location).pathname.slice(0, -1) } }</script>")).toBe(
			'<script>{ x = { base: "" } }</script>'
		);
	});

	it('relativeRefs(): finds everything that would resolve against the served path', () => {
		expect(relativeRefs(ROOT_PAGE)).toEqual([
			'href="./css/webflow.css"',
			'href="./images/wefeasto/favicon.png"',
			'src="./js/gsap.min.js"',
			'href="./_app/immutable/entry/start.X.js"',
			'srcset="./images/a-1x.jpg"',
			'srcset="./images/a-2x.jpg"',
			'import("./_app/immutable/entry/start.X.js")',
			'import("./_app/immutable/entry/app.Y.js")',
			'new URL(".", location)'
		]);
		// A deeper page's "../" and bare paths are not rewritten, so the build fails on them.
		const deeper = '<link href="../css/a.css"><img src="images/b.png"><script>import("../_app/c.js"); new URL("..", location)</script>';
		expect(rootAbsolute(deeper)).toBe(deeper);
		expect(relativeRefs(deeper)).toEqual(['href="../css/a.css"', 'src="images/b.png"', 'import("../_app/c.js")', 'new URL("..", location)']);
	});
});
