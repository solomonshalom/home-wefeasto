/*
 * $lib/focus.js: keyboard focus never falls to <body> when the focused bag
 * control unmounts (hunt a11y-motion bag-focus: undo expiry, top-up row,
 * offer chip, "Your usual"). JSDOM lays nothing out, so getClientRects is
 * stubbed: an element is "rendered" unless it (or an ancestor) has
 * data-test-hidden.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { keepFocus, focusFirst, focusWithin, focusLost, firstTabbable, headingsBefore } from '../../src/lib/focus.js';

let dom;
let document;

beforeEach(() => {
	dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
	document = dom.window.document;
	vi.stubGlobal('document', document);
	vi.stubGlobal('window', dom.window);
	vi.stubGlobal('Node', dom.window.Node);
	dom.window.Element.prototype.getClientRects = function () {
		return this.closest('[data-test-hidden]') ? [] : [{}];
	};
});
afterEach(() => vi.unstubAllGlobals());

const $ = (sel) => document.querySelector(sel);

describe('keepFocus', () => {
	beforeEach(() => {
		document.body.innerHTML =
			'<h1>Bag</h1><div id="rows"><div id="a"><a href="/x" tabindex="-1">thumb</a><a class="name" href="/products/a">A</a><button class="rm">×</button></div>' +
			'<div id="undo"><p>Removed B</p><button id="undo-btn">Undo</button></div>' +
			'<div id="c"><a class="name" href="/products/c">C</a></div></div><h3 id="summary">Order Summary</h3>';
	});

	it('moves focus to the first usable candidate when the focused control is removed', async () => {
		$('#undo-btn').focus();
		const next = $('#undo').nextElementSibling;
		const got = await keepFocus($('#undo'), () => $('#undo').remove(), () => [firstTabbable(next)]);
		expect(got).toBe($('#c .name'));
		expect(document.activeElement).toBe($('#c .name'));
	});

	it('skips candidates that left the document, are hidden or disabled, then gives a heading tabindex=-1', async () => {
		$('#undo-btn').focus();
		const gone = $('#c');
		const hidden = document.createElement('button');
		hidden.setAttribute('data-test-hidden', '');
		document.body.append(hidden);
		const disabled = document.createElement('button');
		disabled.disabled = true;
		document.body.append(disabled);
		await keepFocus($('#undo'), () => {
			$('#undo').remove();
			gone.remove();
		}, () => [firstTabbable(gone), hidden, disabled, null, $('#summary')]);
		expect(document.activeElement).toBe($('#summary'));
		expect($('#summary').getAttribute('tabindex')).toBe('-1'); // reachable by script, never a Tab stop
	});

	it('leaves focus alone when it was not inside the scope (the user already moved on)', async () => {
		$('#a .rm').focus();
		const got = await keepFocus($('#undo'), () => $('#undo').remove(), [$('#summary')]);
		expect(got).toBe(null);
		expect(document.activeElement).toBe($('#a .rm'));
	});

	it('leaves focus alone when the focused control survives the change', async () => {
		$('#undo-btn').focus();
		const got = await keepFocus($('#undo'), () => $('#undo p').remove(), [$('#summary')]);
		expect(got).toBe(null);
		expect(document.activeElement).toBe($('#undo-btn'));
	});

	it('runs the change even when nothing has focus', async () => {
		let ran = false;
		await keepFocus($('#undo'), () => (ran = true), [$('#summary')]);
		expect(ran).toBe(true);
		expect(focusLost()).toBe(true);
	});

	it('treats a focused control that got disabled as lost focus', async () => {
		$('#undo-btn').focus();
		await keepFocus($('#undo'), () => ($('#undo-btn').disabled = true), [$('#summary')]);
		expect(document.activeElement).toBe($('#summary'));
	});
});

describe('helpers', () => {
	it('firstTabbable skips tabindex=-1 (the cart thumb link) and disabled controls', () => {
		document.body.innerHTML = '<div id="r"><a href="/t" tabindex="-1">t</a><button disabled>x</button><a class="n" href="/n">n</a></div>';
		expect(firstTabbable($('#r'))).toBe($('.n'));
		expect(firstTabbable(null)).toBe(null);
	});

	it('focusWithin / focusLost', () => {
		document.body.innerHTML = '<div id="w"><button id="b">b</button></div><button id="o">o</button>';
		expect(focusLost()).toBe(true);
		$('#b').focus();
		expect(focusWithin($('#w'))).toBe(true);
		expect(focusWithin($('#o'))).toBe(false);
		expect(focusLost()).toBe(false);
	});

	it('focusFirst calls function candidates and returns null when none is usable', () => {
		document.body.innerHTML = '<p id="p">note</p>';
		expect(focusFirst([() => null, () => $('#p')])).toBe($('#p'));
		expect(focusFirst([null, undefined])).toBe(null);
	});

	it('visibility:hidden (e.g. a gsap autoAlpha 0 intro) is not usable: focusFirst falls through, firstTabbable skips it', () => {
		// Browsers refuse focus() on it and it is out of the accessibility tree
		// (final pass 1: a heading hidden by the page intro sent focus to <body>).
		document.body.innerHTML =
			'<h1 id="h" style="visibility:hidden">Bag</h1><div id="fade" style="visibility:hidden"><h2 id="inherit">Summary</h2></div>' +
			'<h3 id="c" style="visibility:collapse">c</h3><p id="note">note</p>' +
			'<div id="r"><a id="gone" href="/a" style="visibility:hidden">a</a><a id="ok" href="/b">b</a></div>';
		expect(focusFirst([$('#h'), $('#inherit'), $('#c')])).toBe(null);
		expect(document.activeElement).toBe(document.body);
		expect($('#h').hasAttribute('tabindex')).toBe(false);
		expect(focusFirst([$('#h'), $('#inherit'), $('#note')])).toBe($('#note'));
		expect(firstTabbable($('#r'))).toBe($('#ok'));
		$('#h').style.visibility = '';
		expect(focusFirst([$('#h'), $('#note')])).toBe($('#h')); // opacity-only fades stay focusable
	});

	it('headingsBefore: the headings before the element, nearest first, none inside it', () => {
		document.body.innerHTML = '<h1 id="h1">Shop</h1><h2 id="h2">Bestsellers</h2><div id="card"><h3>inside</h3><button>Add all</button></div><h2 id="after">After</h2>';
		expect(headingsBefore($('#card')).map((h) => h.id)).toEqual(['h2', 'h1']);
		expect(headingsBefore(null)).toEqual([]);
	});
});
