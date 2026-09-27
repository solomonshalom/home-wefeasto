/*
 * - SearchOverlay's focus fix is behaviour only: its server-rendered markup
 *   is the same bytes every page prerendered before (focus, the Tab trap and
 *   focus return are covered in e2e/ui/polish-search.spec.js).
 * - The W1R3 CSS fixes live inside the "Phase 2: cart & toast" section of
 *   static/css/wefeasto.css, scoped as intended (the layouts themselves are
 *   measured in e2e/ui/polish.spec.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import SearchOverlay from '$lib/components/SearchOverlay.svelte';
import { ROOT } from '../data/fixtures.js';

describe('SearchOverlay markup', () => {
	it('prerenders exactly as before: hidden dialog, empty results', () => {
		const html = render(SearchOverlay).body.replace(/<!--[^>]*-->/g, '');
		expect(html).toBe(
			'<div id="wf-search-overlay" class="wf-search-overlay" hidden="" role="dialog" aria-modal="true" aria-label="Search Wefeasto"><div class="wf-search-inner"><div class="wf-search-bar"><input class="wf-search-input" type="text" placeholder="Search products &amp; recipes…" aria-label="Search products and recipes" autocomplete="off" value=""/><button class="wf-search-close" type="button" aria-label="Close search">✕</button></div><div class="wf-search-results" aria-live="polite"></div></div></div>'
		);
	});
});

const css = fs.readFileSync(path.join(ROOT, 'static/css/wefeasto.css'), 'utf8');
const START = '/* ===== Phase 2: cart & toast ===== */';
const END = '/* ===== end Phase 2: cart & toast ===== */';
const section = css.slice(css.indexOf(START), css.indexOf(END) + END.length);
/** CSS with comments removed and whitespace collapsed, for rule matching. */
const flat = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
const outside = flat(css.replace(section, ''));

describe('W1R3 fixes in the cart & toast section of wefeasto.css', () => {
	it('the section exists once', () => {
		expect(css.split(START)).toHaveLength(2);
		expect(css.split(END)).toHaveLength(2);
		expect(css.indexOf(START)).toBeLessThan(css.indexOf(END));
	});

	it('W1R3-02: facts caret (▾, flipped when open, no native marker), and nothing about it outside the section', () => {
		const s = flat(section);
		expect(s).toContain('.wf-facts-summary::-webkit-details-marker { display: none; }');
		expect(s).toMatch(/\.wf-facts-summary::after \{ content: "▾"; content: "▾" \/ ""; [^}]*transition: transform \.2s;[^}]*display: inline-block; \}/);
		expect(s).toContain('.wf-facts[open] > .wf-facts-summary::after { transform: rotate(180deg); }');
		expect(outside).not.toMatch(/wf-facts/);
	});

	it('W1R3-02: reduced motion turns the flip off, after the rule it overrides', () => {
		const s = flat(section);
		const rm = s.lastIndexOf('@media (prefers-reduced-motion: reduce)');
		expect(rm).toBeGreaterThan(s.indexOf('.wf-facts-summary::after {'));
		expect(s.slice(rm)).toMatch(/\.wf-facts-summary::after \{ transition: none; \}/);
	});

	it('W1R3-03: .grid-38 gets a shrinking column only from 992 to 1099px', () => {
		expect(flat(section)).toContain('@media screen and (min-width: 992px) and (max-width: 1099px) { .grid-38 { grid-template-columns: 200px minmax(0, 1fr); } }');
		expect(outside).not.toMatch(/grid-38/);
	});

	it('W1R3-04: the colour-mix pill steps aside below 768px only while a toast is in the DOM', () => {
		expect(flat(section)).toContain('@media screen and (max-width: 767px) { body:has([data-wf-toast]) .wf-colormix { visibility: hidden; } }');
		expect(outside).not.toMatch(/data-wf-toast/);
	});
});
