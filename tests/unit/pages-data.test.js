/*
 * The home and /shop pages render their catalog cards from the CMS snapshot
 * (catalog-views.js) instead of hand-written literals. The derived lists must
 * equal the frozen pre-CMS arrays exactly, the server-rendered markup must be
 * built from them (in order, every field), and the hero image is the page's
 * LCP element: eager, high fetch priority (roadmap M8).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'svelte/server';
import { JSDOM } from 'jsdom';
import { homeBestsellers, kitchenRecipes, shopItems } from '$lib/data/catalog-views.js';
import HomePage from '../../src/routes/+page.svelte';
import ShopPage from '../../src/routes/shop/+page.svelte';
import { ROOT, legacy } from './data/fixtures.js';

const L = {
	bestsellers: legacy('home-bestsellers'),
	kitchenRecipes: legacy('home-kitchenRecipes'),
	shopItems: legacy('shop-items')
};

/** Deep equality AND identical key order (JSON text). */
function expectSame(actual, expected) {
	expect(actual).toStrictEqual(expected);
	expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

const source = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source without JS comments, so explanatory examples ('₹175 · 120 cal') don't count as copies. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const dom = (Component) => new JSDOM(render(Component).body).window.document;
const text = (el) => el?.textContent ?? null;

describe('derived card lists equal the frozen legacy arrays', () => {
	it('home bestsellers', () => expectSame(homeBestsellers(), L.bestsellers));
	it('home kitchen recipes', () => expectSame(kitchenRecipes(), L.kitchenRecipes));
	it('shop items', () => expectSame(shopItems(), L.shopItems));

	it('returns fresh arrays each call (a page mutating its copy cannot leak)', () => {
		const a = shopItems();
		a[0].priceLine = 'mutated';
		a.pop();
		expectSame(shopItems(), L.shopItems);
	});
});

describe('pages no longer carry hand-written catalog copies', () => {
	const home = source('src/routes/+page.svelte');
	const shop = source('src/routes/shop/+page.svelte');

	it.each([
		['src/routes/+page.svelte', code(home)],
		['src/routes/shop/+page.svelte', code(shop)]
	])('%s has no price, rating or product literals', (_file, src) => {
		expect(src).not.toMatch(/priceLine:\s*['"]/);
		expect(src).not.toMatch(/starLine:\s*['"]/);
		expect(src).not.toMatch(/starsAria:\s*['"]/);
		expect(src).not.toMatch(/['"]₹\d/);
		expect(src).not.toContain("url: '/products/");
		expect(src).not.toContain("url: '/recipes/");
	});

	it('home reads both lists from catalog-views', () => {
		expect(home).toMatch(/from '\$lib\/data\/catalog-views\.js'/);
		expect(home).toMatch(/const bestsellers = homeBestsellers\(\);/);
		expect(home).toMatch(/const kitchenRecipes = homeKitchenRecipes\(\);/);
	});

	it('shop reads its grid from catalog-views', () => {
		expect(shop).toMatch(/import \{ shopItems \} from '\$lib\/data\/catalog-views\.js'/);
		expect(shop).toMatch(/const items = shopItems\(\);/);
	});
});

describe('home page SSR markup', () => {
	const doc = dom(HomePage);

	it('renders one bestseller card per legacy entry, in order, with every field', () => {
		const cards = [...doc.querySelectorAll('#bestsellers [role="listitem"]')];
		expect(cards).toHaveLength(L.bestsellers.length);
		cards.forEach((card, i) => {
			const e = L.bestsellers[i];
			const cover = card.querySelector('a.rp-card-cover');
			expect(cover.getAttribute('href')).toBe(e.url);
			expect(cover.getAttribute('aria-label')).toBe(e.aria);
			const img = card.querySelector('.div-block-85 img');
			expect(img.getAttribute('src')).toBe(e.image);
			expect(img.getAttribute('alt')).toBe(e.alt);
			expect(img.getAttribute('loading')).toBe('lazy');
			expect(text(card.querySelector('.text-block-3-copy'))).toBe(e.cat);
			expect(card.querySelector('a.link-block-5').getAttribute('href')).toBe(e.url);
			expect(text(card.querySelector('.div-block-83 > div'))).toBe(e.priceLine);
			expect(text(card.querySelector('h4.heading-11'))).toBe(e.title);
			expect(text(card.querySelector('.div-block-98 > div'))).toBe(e.starLine);
		});
	});

	it('renders one kitchen card per legacy entry, in order, with every field', () => {
		const section = [...doc.querySelectorAll('.div-block-90')].find((s) =>
			text(s.querySelector('h2'))?.includes('Fresh from the Wefeasto Kitchen')
		);
		const cards = [...section.querySelectorAll('[role="listitem"]')];
		expect(cards).toHaveLength(L.kitchenRecipes.length);
		cards.forEach((card, i) => {
			const e = L.kitchenRecipes[i];
			const cover = card.querySelector('a.rp-card-cover');
			expect(cover.getAttribute('href')).toBe(e.url);
			expect(cover.getAttribute('aria-label')).toBe(e.aria);
			const img = card.querySelector('.div-block-85 img');
			expect(img.getAttribute('src')).toBe(e.image);
			expect(img.getAttribute('alt')).toBe(e.alt);
			expect(text(card.querySelector('.text-block-3-copy'))).toBe(e.cat);
			expect(text(card.querySelector('.text-block-4'))).toBe(e.cat);
			expect(text(card.querySelector('h4'))).toBe(e.title);
			const chip = card.querySelector('.div-block-97._2');
			expect(chip.getAttribute('style')).toBe(`background-color:${e.iconColor}`);
			expect(chip.querySelector('img').getAttribute('src')).toBe(e.iconSrc);
			expect(chip.querySelector('img').getAttribute('alt')).toBe(e.iconAlt);
		});
	});

	it('hero image is the LCP candidate: not lazy, fetchpriority=high, same src/alt/class', () => {
		const hero = doc.querySelectorAll('img[src="/images/wefeasto/hero.jpg"]');
		expect(hero).toHaveLength(1);
		expect(hero[0].hasAttribute('loading')).toBe(false);
		expect(hero[0].getAttribute('fetchpriority')).toBe('high');
		expect(hero[0].getAttribute('alt')).toBe('Wefeasto breakfast bowl of golden flakes with milk and fresh fruit');
		expect(hero[0].getAttribute('class')).toBe('image-4');
	});

	it('only the hero is high priority; the other home images stay lazy', () => {
		expect(doc.querySelectorAll('img[fetchpriority]')).toHaveLength(1);
		const eager = [...doc.querySelectorAll('img:not([loading="lazy"])')].map((img) => img.getAttribute('src'));
		expect(eager).toEqual(['/images/wefeasto/hero.jpg']);
	});

	it('leaves the trailer video untouched', () => {
		const videos = doc.querySelectorAll('video');
		expect(videos).toHaveLength(1);
		const v = videos[0];
		expect([...v.attributes].map((a) => `${a.name}=${a.value}`)).toEqual([
			'class=wf-video wf-parallax-img',
			'autoplay=',
			'muted=',
			'loop=',
			'playsinline=',
			'poster=/images/wefeasto/video-poster-trailer.jpg'
		]);
		const sources = v.querySelectorAll('source');
		expect(sources).toHaveLength(1);
		expect(sources[0].getAttribute('src')).toBe('/videos/wefeasto-trailer.mp4');
		expect(sources[0].getAttribute('type')).toBe('video/mp4');
	});
});

describe('shop page SSR markup', () => {
	const doc = dom(ShopPage);

	it('renders one card per legacy item, in order, with every field', () => {
		const cards = [...doc.querySelectorAll('#wf-shop-grid .wf-shop-item')];
		expect(cards).toHaveLength(L.shopItems.length);
		cards.forEach((card, i) => {
			const e = L.shopItems[i];
			expect(card.getAttribute('data-name')).toBe(e.name);
			expect(card.getAttribute('data-category')).toBe(e.category);
			expect(card.getAttribute('data-terms')).toBe(e.terms);
			const cover = card.querySelector('a.wf-card-cover');
			expect(cover.getAttribute('href')).toBe(`/products/${e.slug}`);
			expect(cover.getAttribute('aria-label')).toBe(e.viewAria);
			const img = card.querySelector('img.image-4');
			expect(img.getAttribute('src')).toBe(e.image);
			expect(img.getAttribute('alt')).toBe(e.alt);
			expect(text(card.querySelector('.text-block-3-copy'))).toBe(e.category);
			expect(text(card.querySelector('h4.heading-11'))).toBe(e.name);
			expect(text(card.querySelector('.wf-price'))).toBe(e.priceLine);
			const stars = card.querySelector('.wf-stars');
			expect(stars.getAttribute('aria-label')).toBe(e.starsAria);
			expect(stars.getAttribute('style')).toBe(`--wf-rating:${e.starsRating}`);
			const meta = [...card.querySelectorAll('.wf-card-meta > div:not(.wf-stars)')].map(text);
			expect(meta).toEqual(e.pack === null ? [] : [e.pack]);
		});
	});

	it('the empty-state stays last in the grid and hidden', () => {
		const grid = doc.querySelector('#wf-shop-grid');
		expect(grid.lastElementChild.id).toBe('wf-shop-empty');
		expect(grid.lastElementChild.hasAttribute('hidden')).toBe(true);
	});
});
