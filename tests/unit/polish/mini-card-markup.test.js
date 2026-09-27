/*
 * MiniProductCard's new `source` prop (and the setMiniCardSource() context
 * default) changes nothing in the prerendered markup: every variant renders
 * the same bytes as the card did before the prop existed.
 */
import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import MiniProductCard from '$lib/components/MiniProductCard.svelte';
import CardSourceHost from './fixtures/CardSourceHost.svelte';
import { productsContent } from '$lib/data/products-content.js';

const html = (C, props) => render(C, { props }).body.replace(/<!--[^>]*-->/g, '');

const card = productsContent.cornflakes.goesWith[0];

/** The card as it rendered before `source` existed (MiniProductCard + AddToCart's default markup). */
const BEFORE =
	'<div class="wf-reveal"><div class="div-block-84 wf-card"><div class="div-block-85"><a href="/products/steel-cut-oats" aria-label="View Steel-Cut Oats"><img src="/images/wefeasto/product-steel-cut-oats.jpg" loading="lazy" alt="Bowl of Wefeasto Steel-Cut Oats porridge" class="image-4"/></a><div class="text-block-3-copy">Oats</div></div><div class="div-block-83"><div class="wf-card-meta"><div class="wf-stars" role="img" aria-label="Rated 4.3 out of 5" style="--wf-rating:4.3"><span class="wf-stars-fill">★★★★★</span></div><div>500 g · 80 cal</div></div><div class="divider _6px"></div><h4 class="heading-11"><a href="/products/steel-cut-oats" class="wf-card-link">Steel-Cut Oats</a></h4><div class="wf-price">₹135</div><div class="divider _8px"></div><a href="#" role="button" class="button w-inline-block" data-wf-add="steel-cut-oats"><div>Add to Cart</div></a></div></div></div>';

describe('MiniProductCard markup', () => {
	it('the sample card is the one we think it is', () => {
		expect(card).toMatchObject({ slug: 'steel-cut-oats', price: '₹135', meta: '500 g · 80 cal' });
	});

	it.each([undefined, 'card', 'goes-with', 'recipe-ingredients', 'not-found'])('source %j: byte-identical to the card before the prop', (source) => {
		expect(html(MiniProductCard, source === undefined ? { card } : { card, source })).toBe(BEFORE);
	});

	it('under a setMiniCardSource() default, with or without an explicit source: identical too', () => {
		expect(html(CardSourceHost, { inherited: 'not-found', card, explicit: 'goes-with' })).toBe(BEFORE + BEFORE);
		expect(html(CardSourceHost, { inherited: undefined, card, explicit: undefined })).toBe(BEFORE + BEFORE);
	});
});
