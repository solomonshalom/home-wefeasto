// @vitest-environment jsdom
/*
 * PeepWalk's pause control (hunt round 4, a11y-motion: "PeepWalk crowd moves
 * indefinitely with no pause/stop control", WCAG 2.2.2 level A).
 *
 * Whenever the crowd would walk, a "Pause animation" button is offered; it
 * takes the crowd off the gsap ticker (frozen where it stands), for every
 * crowd, and the choice is kept in localStorage. No button where the crowd is
 * a still frame anyway (reduced motion, ?nofx=1, no GSAP).
 *
 * The component is mounted in jsdom with the client build of svelte, and the
 * browser pieces jsdom lacks are stubbed: a no-op 2D context, canvas size,
 * Image#decode, Intersection/ResizeObserver, matchMedia, gsap.ticker and a
 * Map-backed localStorage. Tests run in order: the first one mounts before
 * the module has read the stored choice.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { mount, unmount, flushSync } from '../../../node_modules/svelte/src/index-client.js';

vi.mock('svelte', async () => await import('../../../node_modules/svelte/src/index-client.js'));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));

const ticker = new Set();
const timelines = [];
const store = new Map();
let reduced = false;

beforeAll(() => {
	// Just enough GSAP for bublr's walk: parseEase + timelines that record their tweens.
	const timeline = () => {
		const tl = {
			scale: 1,
			tweens: [],
			paused: false,
			killed: false,
			timeScale(v) {
				tl.scale = v;
				return tl;
			},
			to(target, vars, position) {
				tl.tweens.push({ target, vars, position });
				return tl;
			},
			eventCallback() {
				return tl;
			},
			progress() {
				return tl;
			},
			pause() {
				tl.paused = true;
				return tl;
			},
			resume() {
				tl.paused = false;
				return tl;
			},
			kill() {
				tl.killed = true;
			}
		};
		timelines.push(tl);
		return tl;
	};
	window.gsap = { ticker: { add: (fn) => ticker.add(fn), remove: (fn) => ticker.delete(fn) }, parseEase: () => (t) => t * t * t, timeline };
	window.matchMedia = (q) => ({ matches: reduced && /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
	Object.defineProperty(window, 'localStorage', {
		configurable: true,
		value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
	});
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
	const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}), set: (t, k, v) => ((t[k] = v), true) });
	HTMLCanvasElement.prototype.getContext = () => ctx;
	Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
	Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 200 });
	HTMLImageElement.prototype.decode = () => Promise.resolve();
	Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 3600 });
	Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 2268 });
	window.ResizeObserver = class {
		observe() {}
		disconnect() {}
	};
	window.IntersectionObserver = class {
		constructor(cb) {
			this.cb = cb;
		}
		observe(el) {
			setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 0);
		}
		disconnect() {}
	};
});

const { default: PeepWalk, PEEPS_PAUSED_KEY, setPeepsPaused } = await import('$lib/components/PeepWalk.svelte');

const mounted = [];
async function crowd() {
	const target = document.body.appendChild(document.createElement('div'));
	mounted.push({ c: mount(PeepWalk, { target, props: {} }), target });
	await vi.waitFor(() => expect(target.querySelector('canvas').dataset.ready).toBe(''), { timeout: 2000 });
	flushSync();
	return { canvas: target.querySelector('canvas'), button: () => target.querySelector('[data-wf-peeps-pause]') };
}
afterEach(() => {
	for (const { c, target } of mounted.splice(0)) {
		unmount(c);
		target.remove();
	}
	flushSync();
	reduced = false;
});

describe('PeepWalk pause control', () => {
	it('a visitor who paused before: the crowd starts frozen, with a "Play animation" button', async () => {
		store.set(PEEPS_PAUSED_KEY, '1');
		const { canvas, button } = await crowd();
		expect(canvas.dataset.mode).toBe('paused');
		expect(ticker.size).toBe(0);
		expect(button()?.getAttribute('aria-label')).toBe('Play animation');
		button().click();
		flushSync();
		expect(canvas.dataset.mode).toBe('live');
		expect(ticker.size).toBe(1);
		expect(store.has(PEEPS_PAUSED_KEY)).toBe(false);
	});

	it('"Pause animation" takes the crowd off the ticker, remembers it, and "Play" resumes', async () => {
		const { canvas, button } = await crowd();
		expect(canvas.dataset.mode).toBe('live');
		expect(ticker.size).toBe(1);
		const b = button();
		expect(b.getAttribute('aria-label')).toBe('Pause animation');
		expect(b.getAttribute('type')).toBe('button');
		// Before the canvas, so the canvas's next sibling (the footer, in the layout) is unchanged.
		expect(b.closest('.wf-peepwalk-ctl').nextElementSibling).toBe(canvas);

		b.click();
		flushSync();
		expect(ticker.size).toBe(0);
		expect(canvas.dataset.mode).toBe('paused');
		expect(store.get(PEEPS_PAUSED_KEY)).toBe('1');
		expect(button()).toBe(b); // the same button (focus stays on it)
		expect(b.getAttribute('aria-label')).toBe('Play animation');

		b.click();
		flushSync();
		expect(ticker.size).toBe(1);
		expect(canvas.dataset.mode).toBe('live');
		expect(store.has(PEEPS_PAUSED_KEY)).toBe(false);
	});

	it('one switch for every crowd on the page', async () => {
		const a = await crowd();
		const b = await crowd();
		expect(ticker.size).toBe(2);
		a.button().click();
		flushSync();
		expect(ticker.size).toBe(0);
		expect([a.canvas.dataset.mode, b.canvas.dataset.mode]).toEqual(['paused', 'paused']);
		expect(b.button().getAttribute('aria-label')).toBe('Play animation');
		setPeepsPaused(false);
		flushSync();
		expect(ticker.size).toBe(2);
	});

	it("walks exactly like bublr's crowd: every peep, 10s linear walk at 0.5-1.5x, a 10px bob every 0.25s", async () => {
		timelines.length = 0;
		const { canvas } = await crowd();
		const live = timelines.filter((tl) => !tl.killed);
		expect(live).toHaveLength(105); // the whole 15 x 7 sheet
		for (const tl of live) {
			expect(tl.scale).toBeGreaterThanOrEqual(0.5);
			expect(tl.scale).toBeLessThan(1.5);
			const [x, y] = tl.tweens;
			expect(x.vars).toMatchObject({ duration: 10, ease: 'none' });
			expect(x.position).toBe(0);
			expect(y.vars).toMatchObject({ duration: 0.25, repeat: 40, yoyo: true });
			expect(y.vars.y).toBe(y.target.anchorY - 10);
			expect(y.target.width).toBe(240); // native cell size, never rescaled
			expect(y.target.height).toBe(324);
			// bublr's depth: 100 - 250 * power2.in(r) below the fold line, never above 10px
			expect(y.target.anchorY).toBeGreaterThanOrEqual(10);
			expect(y.target.anchorY).toBeLessThanOrEqual(Math.max(10, canvas.clientHeight - 324 + 100));
			expect(Math.abs(x.vars.x - (y.target.scaleX === 1 ? 800 : 0))).toBe(0); // walks right to the edge / left to 0
		}
	});

	it('pausing freezes every walk (timelines paused) and playing resumes them', async () => {
		timelines.length = 0;
		const { button } = await crowd();
		const live = () => timelines.filter((tl) => !tl.killed);
		expect(live().every((tl) => !tl.paused)).toBe(true);
		button().click();
		flushSync();
		expect(live().every((tl) => tl.paused)).toBe(true);
		button().click();
		flushSync();
		expect(live().every((tl) => !tl.paused)).toBe(true);
	});

	it('no button where the crowd is a still frame (reduced motion)', async () => {
		reduced = true;
		const { canvas, button } = await crowd();
		expect(canvas.dataset.mode).toBe('still');
		expect(button()).toBeNull();
		expect(ticker.size).toBe(0);
	});
});
