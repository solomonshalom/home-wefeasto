/*
 * Mini-bag toast (roadmap M4): placements, suppression, merge, timers, Esc,
 * navigation cleanup, the live region and the phone layout. Key flows run in
 * three variants: normal, ?nofx=1, and localStorage whose methods throw.
 * /api is stubbed (404 → the live overlay falls back to the snapshot), so no
 * CMS is needed and a CMS on :3000 can't change the numbers.
 */
import { test, expect } from '@playwright/test';
import { collectErrors, expectNoHorizontalOverflow } from './helpers.js';

const toast = (page) => page.locator('[data-wf-toast]');
const toastTitle = (page) => page.locator('[data-wf-toast] .wf-toast-title');
const badge = (page) => page.locator('.div-block-79 .wf-cart-count');

/** Every Storage method throws (Safari "block all cookies", some in-app browsers). */
function breakStorage() {
	for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
		Storage.prototype[m] = function () {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		};
	}
}

/** Record every wf:cart-add detail in window.__adds. */
function recordAdds() {
	window.__adds = [];
	window.addEventListener('wf:cart-add', (e) => window.__adds.push(e.detail));
}

/**
 * Wait for hydration: the nav badge only gets its wf-is-hidden class (empty
 * bag) or its count after the layout has mounted. Clicking an "Add to Cart"
 * <a href="#"> before that would just follow the '#'.
 */
async function hydrated(page) {
	await page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
}

/** page.goto that also waits for hydration (a real click needs the handler). */
function waitForHydrationOnGoto(page) {
	const goto = page.goto.bind(page);
	page.goto = async (...args) => {
		const res = await goto(...args);
		if (res && res.status() < 400) await hydrated(page);
		return res;
	};
	const reload = page.reload.bind(page);
	page.reload = async (...args) => {
		const res = await reload(...args);
		await hydrated(page);
		return res;
	};
}

async function setup(page, variant = 'normal') {
	waitForHydrationOnGoto(page);
	await page.route('**/api/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
	await page.addInitScript(recordAdds);
	if (variant === 'broken') await page.addInitScript(breakStorage);
}

const q = (variant) => (variant === 'nofx' ? '?nofx=1' : '');
const adds = (page) => page.evaluate(() => window.__adds);

/** Seed the stored bag (normal/nofx) — call on any page of the site first. */
async function seedBag(page, bag) {
	await page.evaluate((b) => localStorage.setItem('wefeasto_cart', JSON.stringify(b)), bag);
}

/** Scroll a (possibly not-yet-revealed .wf-reveal) element into view and wait until it shows. */
async function bringIntoView(locator) {
	await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await expect(locator).toBeVisible();
}

/**
 * Record every text `locator` shows from now on (a MutationObserver in the
 * page), so a transient label like "Added ✓" (1.4 s) is caught however slow
 * the runner is. Returns a getter for the list.
 */
async function recordTexts(locator) {
	await locator.evaluate((el) => {
		const log = [el.textContent.trim()];
		el.__wfTexts = log;
		new MutationObserver(() => {
			const t = el.textContent.trim();
			if (log[log.length - 1] !== t) log.push(t);
		}).observe(el, { childList: true, subtree: true, characterData: true });
	});
	return () => locator.evaluate((el) => el.__wfTexts);
}

/** In-page log of the toast appearing / leaving ({on, t: performance.now()}), for timing checks that don't depend on the runner. */
function recordToastLife() {
	window.__toastLife = [];
	const obs = new MutationObserver(() => {
		const on = !!document.querySelector('[data-wf-toast]');
		const log = window.__toastLife;
		if (log.length ? log[log.length - 1].on !== on : on) log.push({ on, t: performance.now() });
	});
	obs.observe(document, { childList: true, subtree: true });
}
const toastLife = (page) => page.evaluate(() => window.__toastLife);
/** Wait until the page's own clock reaches `t` (performance.now()). */
const untilPageTime = (page, t) => page.waitForFunction((at) => performance.now() >= at, t, { polling: 50, timeout: 20_000 });
/** How long the toast stayed after `from` (page time): it must be gone by now. */
async function closedAfter(page, from) {
	await expect(toast(page)).toHaveCount(0, { timeout: 12_000 });
	const last = (await toastLife(page)).at(-1);
	expect(last.on).toBe(false);
	return last.t - from;
}
const DISMISS_MS = 5000;

/** The toast module has mounted (its live region exists): every add so far — queued ones are replayed — has been seen by it. */
const toastMounted = (page) => expect(page.locator('[data-wf-toast-live]')).toBeAttached({ timeout: 15_000 });
/** In-page: log what [data-wf-toast-live] says at every animation frame (only changes) in window.__liveFrames. */
function recordLiveFrames() {
	const log = (window.__liveFrames = []);
	const tick = () => {
		const n = document.querySelector('[data-wf-toast-live]');
		const text = n ? n.textContent : null;
		if (!log.length || log[log.length - 1] !== text) log.push(text);
		requestAnimationFrame(tick);
	};
	tick();
}
const liveFrames = (page) => page.evaluate(() => window.__liveFrames);
/** Two animation frames: whatever the last add rendered is on screen by now. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const VARIANTS = ['normal', 'nofx', 'broken'];

for (const variant of VARIANTS) {
	test.describe(`toast [${variant}]`, () => {
		test.beforeEach(async ({ page }) => setup(page, variant));

		test('PDP add opens the mini-bag: title, meter, top-up, Checkout total, View bag', async ({ page }) => {
			const errors = collectErrors(page);
			await page.goto('/products/muesli' + q(variant));
			const addBtn = page.locator('[data-wf-add="muesli"]').first();
			const labels = await recordTexts(addBtn);
			await addBtn.click();
			await expect(toast(page)).toBeVisible();
			await expect(toastTitle(page)).toHaveText('Muesli ×1 added to your bag');
			await expect(toast(page).locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '50'); // ₹250 of ₹499
			await expect(toast(page).locator('[data-wf-topup-note]')).toHaveText('₹249 away from free delivery');
			// Muesli alone → Health Mix crosses the threshold (roadmap F1 worked example)
			await expect(toast(page).locator('[data-wf-topup]')).toHaveAttribute('data-wf-topup', 'health-mix');
			await expect(toast(page).locator('.wf-topup-text')).toHaveText('Add Health Mix · ₹270 → free delivery');
			await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText('Checkout · ₹299'); // 250 + 49 delivery
			await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveAttribute('href', '/checkout');
			await expect(toast(page).locator('[data-wf-toast-bag]')).toHaveAttribute('href', '/cart');
			await expect(page.locator('[data-wf-toast-live]')).toContainText('Muesli ×1 added to your bag');
			await expect(badge(page)).toHaveText('1');
			expect(await adds(page)).toEqual([expect.objectContaining({ slug: 'muesli', qty: 1, source: 'pdp' })]);
			// the "Added ✓" swap is kept (recorded as it happens, then back to the resting label)
			const rest = (await labels())[0];
			await expect.poll(labels, { timeout: 6000 }).toEqual([rest, 'Added ✓', rest]);
			expect(errors).toEqual([]);
		});

		test('5 rapid adds → one toast reading ×5, badge 5', async ({ page }) => {
			await page.goto('/products/cornflakes' + q(variant));
			const add = page.locator('[data-wf-add="cornflakes"]').first();
			for (let i = 0; i < 5; i++) await add.click();
			await expect(toast(page)).toHaveCount(1);
			await expect(toastTitle(page)).toHaveText('Cornflakes ×5 added to your bag');
			await expect(badge(page)).toHaveText('5');
			expect((await adds(page)).length).toBe(5);
			await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText('Checkout · ₹875'); // 5 × 175, free delivery
			await expect(toast(page).locator('[data-wf-topup-note]')).toHaveText('Free delivery unlocked — yours is free!');
			await expect(toast(page).locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '100');
		});

		test('top-up inside the toast updates it in place (no second toast)', async ({ page }) => {
			await page.goto('/products/muesli' + q(variant));
			await page.locator('[data-wf-add="muesli"]').first().click();
			await toast(page).locator('.wf-topup-add').click();
			await expect(toast(page)).toHaveCount(1);
			await expect(toastTitle(page)).toHaveText('2 items added to your bag');
			await expect(toast(page).locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '100');
			await expect(toast(page).locator('[data-wf-topup]')).toHaveCount(0);
			await expect(badge(page)).toHaveText('2');
			expect((await adds(page)).map((d) => [d.slug, d.qty, d.source])).toEqual([
				['muesli', 1, 'pdp'],
				['health-mix', 1, 'topup']
			]);
		});

		test('closes on navigation and leaves no nodes behind', async ({ page }) => {
			await page.goto('/products/muesli' + q(variant));
			await page.locator('[data-wf-add="muesli"]').first().click();
			await expect(toast(page)).toBeVisible();
			await toast(page).locator('[data-wf-toast-bag]').click();
			await expect(page).toHaveURL(/\/cart$/);
			await expect(toast(page)).toHaveCount(0);
			await expect(page.locator('.wf-toast, .wf-toast *')).toHaveCount(0);
			await expect(page.locator('[data-wf-toast-live]')).toHaveText('');
			// in-memory bag survives the SPA navigation even when storage throws
			await expect(page.locator('[data-wf-row="muesli"]')).toBeVisible();
		});
	});
}

test.describe('toast', () => {
	test.beforeEach(async ({ page }) => setup(page));

	test('shop card add → toast with source card', async ({ page }) => {
		await page.goto('/shop');
		await page.locator('.wf-shop-add[data-wf-add="rolled-oats"]').click();
		await expect(toastTitle(page)).toHaveText('Rolled Oats ×1 added to your bag');
		expect((await adds(page))[0]).toMatchObject({ slug: 'rolled-oats', source: 'card' });
	});

	// hunt a11y-motion toast-first-add-live: an add made before the lazy toast chunk has mounted is
	// replayed on mount; the live region must be in the page (empty) before that message lands in it,
	// or screen readers never announce it.
	test('an add before the toast chunk loads: the live region exists empty first, then speaks', async ({ page }) => {
		let release;
		const held = new Promise((r) => (release = r));
		await page.route('**/_app/immutable/**/*.js', async (route) => {
			const res = await route.fetch();
			const body = await res.text();
			if (body.includes('data-wf-toast-live')) await held; // a slow network for the toast chunk only
			await route.fulfill({ response: res, body });
		});
		await page.addInitScript(() => {
			window.__live = [];
			const tick = () => {
				const n = document.querySelector('[data-wf-toast-live]');
				const text = n ? n.textContent : null;
				const last = window.__live[window.__live.length - 1];
				if (!last || last.node !== n || last.text !== text) window.__live.push({ node: n, text });
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await page.goto('/products/muesli');
		await page.locator('[data-wf-add="muesli"]').first().click();
		await expect.poll(() => page.evaluate(() => window.WefeastoCart.read().muesli)).toBe(1);
		await expect(page.locator('[data-wf-toast-live]')).toHaveCount(0); // still downloading
		release();
		await expect(toastTitle(page)).toHaveText('Muesli ×1 added to your bag');
		await expect(page.locator('[data-wf-toast-live]')).toContainText('Muesli ×1 added to your bag');
		const states = await page.evaluate(() => window.__live.filter((e) => e.node).map((e) => e.text));
		expect(states[0], `first state of the live region (then ${JSON.stringify(states.slice(1))})`).toBe('');
		expect(states.slice(1).some((t) => t.startsWith('Muesli ×1 added to your bag'))).toBe(true);
	});

	// hunt a11y-motion toast-cap-repeat: at the per-order cap every press gives the same words, so
	// writing them again changed nothing and a screen reader heard nothing (WCAG 4.1.3). Each add
	// must be spoken: the region is emptied for a few frames (an accessibility-tree update sees the
	// gap), then says the words again. Words that change are written straight away, with no gap.
	test('a repeat press at the per-order cap is spoken again: the live region empties, then says it', async ({ page }) => {
		await page.goto('/products/muesli');
		await seedBag(page, { muesli: 10 }); // muesli's maxPerOrder
		await page.reload();
		const add = page.locator('[data-wf-add="muesli"]').first();
		const live = page.locator('[data-wf-toast-live]');
		await add.click();
		await expect(toastTitle(page)).toHaveText('Muesli ×10 is in your bag — 10 is the most we can send in one order');
		await expect(live).toContainText('Bag total ₹2,500.'); // settled: the quote is in
		const cap = await live.textContent();
		expect(cap).toBe('Muesli ×10 is in your bag — 10 is the most we can send in one order. Bag total ₹2,500.');

		await page.evaluate(recordLiveFrames);
		await add.click();
		await expect.poll(() => liveFrames(page), { timeout: 3_000 }).toEqual([cap, '', cap]);
		await add.click();
		await expect.poll(() => liveFrames(page), { timeout: 3_000 }).toEqual([cap, '', cap, '', cap]);
		await expect(toast(page)).toHaveCount(1);
		await expect(badge(page)).toHaveText('10');
		expect((await adds(page)).map((d) => [d.qty, d.capped])).toEqual([
			[0, true],
			[0, true],
			[0, true]
		]);
	});

	test('an add that changes the words is written straight into the live region (no empty gap)', async ({ page }) => {
		await page.goto('/products/cornflakes');
		const add = page.locator('[data-wf-add="cornflakes"]').first();
		const live = page.locator('[data-wf-toast-live]');
		await add.click();
		await expect(live).toContainText('Cornflakes ×1 added to your bag. Bag total');
		await page.evaluate(recordLiveFrames);
		await add.click();
		await expect(live).toContainText('Cornflakes ×2 added to your bag. Bag total');
		await frames(page);
		const log = await liveFrames(page);
		expect(log[0]).toMatch(/^Cornflakes ×1 added/);
		expect(log.at(-1)).toMatch(/^Cornflakes ×2 added/);
		expect(log, 'never emptied between two different messages').not.toContain('');
	});

	test('"Goes well with" card on a PDP → toast', async ({ page }) => {
		await page.goto('/products/cornflakes');
		const card = page.locator('.grid-6._2 [data-wf-add]').first();
		const slug = await card.getAttribute('data-wf-add');
		await bringIntoView(card);
		await card.click();
		await expect(toast(page)).toBeVisible();
		await expect(toastTitle(page)).toContainText('×1 added to your bag');
		expect((await adds(page))[0]).toMatchObject({ slug, qty: 1 });
	});

	test('recipe rail "Add Muesli · ₹250" and "Shop the Ingredients" → toast', async ({ page }) => {
		await page.goto('/recipes/wf-muesli-yogurt-parfait');
		const rail = page.locator('.grid-42 .wf-rail-add');
		await expect(rail).toHaveText('Add Muesli · ₹250');
		const labels = await recordTexts(rail);
		await rail.click();
		await expect(toastTitle(page)).toHaveText('Muesli ×1 added to your bag');
		await expect.poll(labels, { timeout: 6000 }).toEqual(['Add Muesli · ₹250', 'Added ✓', 'Add Muesli · ₹250']);
		const card = page.locator('.section .grid-6 [data-wf-add="muesli"]');
		await bringIntoView(card);
		await card.click();
		await expect(toastTitle(page)).toHaveText('Muesli ×2 added to your bag');
		expect((await adds(page)).map((d) => d.source)).toEqual(['recipe', 'recipe-ingredients']); // ingredient cards say where they are
	});

	test('home: "Your usual" inside Shop Bestsellers → toast (the bestseller cards have no add button)', async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() =>
			localStorage.setItem('wefeasto_last_order', JSON.stringify({ no: 'WF-10001', t: 't', items: { cornflakes: 2, muesli: 1 }, at: Date.now() - 86400000 }))
		);
		await page.reload();
		const usual = page.locator('#bestsellers [data-wf-usual="home"]');
		await expect(usual).toBeVisible();
		await usual.locator('[data-wf-usual-add]').click();
		await expect(toastTitle(page)).toHaveText('3 items added to your bag');
		expect(await adds(page)).toEqual([expect.objectContaining({ source: 'usual', qty: 3 })]);
		await expect(toast(page).locator('[data-wf-toast-checkout]')).toHaveText('Checkout · ₹600');
	});

	test('never on /cart, /checkout or /order', async ({ page }) => {
		// No fixed sleeps: each check waits until the toast module has seen the add (mounted, queued
		// adds replayed) and the frame after it has painted — then there must be no toast.
		await page.goto('/shop');
		await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 1 })));
		await page.goto('/cart');
		await page.locator('#wf-cart-summary .wf-topup-add').click();
		await expect(page.locator('[data-wf-row="health-mix"]')).toBeVisible();
		await toastMounted(page);
		await frames(page);
		await expect(toast(page)).toHaveCount(0);

		await page.goto('/checkout');
		await page.evaluate(() => window.WefeastoCart.add('cornflakes', 1, { source: 'pdp' }));
		await toastMounted(page); // this add was queued, then replayed by the module
		await frames(page);
		await expect(toast(page)).toHaveCount(0);
		await page.evaluate(() => window.WefeastoCart.add('cornflakes', 1, { source: 'pdp' })); // straight to the mounted module
		await frames(page);
		await expect(toast(page)).toHaveCount(0);

		// /order is a real page with no Add buttons: add through the cart API, as a card would —
		// once before the toast module is loaded (queued + replayed) and once after.
		await page.goto('/order');
		await hydrated(page);
		const before = (await adds(page)).length;
		await page.evaluate(() => window.WefeastoCart.add('muesli', 1, { source: 'card' }));
		await toastMounted(page);
		await frames(page);
		await expect(toast(page)).toHaveCount(0);
		await page.evaluate(() => window.WefeastoCart.add('muesli', 1, { source: 'card' }));
		await frames(page);
		await expect(toast(page)).toHaveCount(0);
		expect((await adds(page)).length).toBe(before + 2);

		// Control: the same add through the cart API on an ordinary page does open the toast.
		await page.goto('/shop');
		await page.evaluate(() => window.WefeastoCart.add('muesli', 1, { source: 'card' }));
		await expect(toastTitle(page)).toHaveText('Muesli ×1 added to your bag');
	});

	test('auto-dismisses 5 s after it opens (timed in the page)', async ({ page }) => {
		await page.addInitScript(recordToastLife);
		await page.goto('/products/muesli?nofx=1');
		await page.locator('[data-wf-add="muesli"]').first().click();
		await expect(toast(page)).toBeVisible();
		const [opened] = await toastLife(page);
		expect(opened.on).toBe(true);
		const stayed = await closedAfter(page, opened.t);
		expect(stayed).toBeGreaterThanOrEqual(DISMISS_MS - 100);
		expect(stayed).toBeLessThan(DISMISS_MS + 3000);
	});

	test('hover holds it open; leaving restarts the timer', async ({ page }) => {
		await page.addInitScript(recordToastLife);
		await page.goto('/products/muesli?nofx=1');
		await page.locator('[data-wf-add="muesli"]').first().click();
		await toast(page).hover();
		const [opened] = await toastLife(page);
		await untilPageTime(page, opened.t + DISMISS_MS + 1500); // well past when it would have gone
		await expect(toast(page)).toBeVisible();
		await toast(page).evaluate((el) => el.addEventListener('mouseleave', () => (window.__leftAt = performance.now()), { once: true }));
		await page.mouse.move(5, 400);
		await expect.poll(() => page.evaluate(() => window.__leftAt ?? null)).not.toBeNull();
		const stayed = await closedAfter(page, await page.evaluate(() => window.__leftAt));
		expect(stayed).toBeGreaterThanOrEqual(DISMISS_MS - 100); // a fresh 5 s from leaving
		expect(stayed).toBeLessThan(DISMISS_MS + 3000);
	});

	test('focus inside holds it open; Esc closes it and focus goes back', async ({ page }) => {
		await page.addInitScript(recordToastLife);
		await page.goto('/products/muesli?nofx=1');
		const add = page.locator('[data-wf-add="muesli"]').first();
		await add.click();
		await toast(page).locator('.wf-toast-close').focus();
		await page.mouse.move(5, 400);
		const [opened] = await toastLife(page);
		await untilPageTime(page, opened.t + DISMISS_MS + 1000);
		await expect(toast(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(toast(page)).toHaveCount(0);
		expect(await page.evaluate(() => document.activeElement?.getAttribute('data-wf-add'))).toBe('muesli');
	});

	test('a press holds it open until release', async ({ page }) => {
		await page.addInitScript(recordToastLife);
		await page.goto('/products/muesli?nofx=1');
		await page.locator('[data-wf-add="muesli"]').first().click();
		const box = await toast(page).locator('.wf-topup-note').boundingBox();
		await page.mouse.move(box.x + 5, box.y + 5);
		await page.mouse.down();
		await page.mouse.move(5, 400); // pointer leaves while still pressed
		const [opened] = await toastLife(page);
		await untilPageTime(page, opened.t + DISMISS_MS + 1000);
		await expect(toast(page)).toBeVisible();
		await page.evaluate(() => window.addEventListener('pointerup', () => (window.__upAt = performance.now()), { once: true, capture: true }));
		await page.mouse.up();
		await expect.poll(() => page.evaluate(() => window.__upAt ?? null)).not.toBeNull();
		const stayed = await closedAfter(page, await page.evaluate(() => window.__upAt));
		expect(stayed).toBeGreaterThanOrEqual(DISMISS_MS - 100); // a fresh 5 s from the release
		expect(stayed).toBeLessThan(DISMISS_MS + 3000);
	});

	test('non-modal: the page still scrolls and takes clicks while it is open', async ({ page }) => {
		await page.goto('/products/muesli?nofx=1');
		await page.locator('[data-wf-add="muesli"]').first().click();
		await expect(toast(page)).toBeVisible();
		await page.mouse.wheel(0, 600);
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
		expect(await page.evaluate(() => document.body.classList.contains('wf-no-scroll'))).toBe(false);
		const card = page.locator('[data-wf-add]').nth(1); // a "Goes well with" card
		await bringIntoView(card);
		await card.click();
		await expect(toastTitle(page)).toHaveText('2 items added to your bag');
	});

	test('Checkout button goes to /checkout and the toast closes', async ({ page }) => {
		await page.goto('/products/muesli');
		await page.locator('[data-wf-add="muesli"]').first().click();
		await toast(page).locator('[data-wf-toast-checkout]').click();
		await expect(page).toHaveURL(/\/checkout$/);
		await expect(toast(page)).toHaveCount(0);
	});

	test('z-index 1100, bottom-right 360px on desktop, clear of the colour-mix pill', async ({ page }) => {
		await page.goto('/products/muesli?nofx=1');
		await page.locator('[data-wf-add="muesli"]').first().click();
		const s = await toast(page).evaluate((el) => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return { z: cs.zIndex, pos: cs.position, w: r.width, right: innerWidth - r.right, bottom: innerHeight - r.bottom, parent: el.parentElement.className };
		});
		expect(s).toMatchObject({ z: '1100', pos: 'fixed', w: 360, right: 24, bottom: 24 });
		expect(await page.locator('.page-wrapper [data-wf-toast]').count()).toBe(0);
		const pill = await page.locator('.wf-colormix').boundingBox();
		const card = await toast(page).boundingBox();
		expect(pill.x + pill.width).toBeLessThan(card.x);
	});
});

test.describe('toast on a 360px phone', () => {
	test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
	test.beforeEach(async ({ page }) => setup(page));

	for (const variant of ['normal', 'nofx']) {
		test(`full-width at the bottom, no horizontal overflow [${variant}]`, async ({ page }) => {
			await page.goto('/products/choco-flakes' + q(variant));
			await page.locator('[data-wf-add="choco-flakes"]').first().tap();
			await expect(toast(page)).toBeVisible();
			// measure once the slide-in (a Web Animation) has finished
			await toast(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
			const r = await toast(page).boundingBox();
			expect(Math.round(r.x)).toBe(16);
			expect(Math.round(r.x + r.width)).toBe(344);
			expect(Math.round(740 - (r.y + r.height))).toBe(16);
			const inner = await toast(page).evaluate((el) =>
				[...el.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow === 'visible').map((n) => n.className)
			);
			expect(inner).toEqual([]);
			await expectNoHorizontalOverflow(page);
			// the buttons fit side by side
			const [a, b] = await toast(page).locator('.wf-toast-actions .button').all();
			const ba = await a.boundingBox();
			const bb = await b.boundingBox();
			expect(ba.y).toBe(bb.y);
			expect(bb.x + bb.width).toBeLessThanOrEqual(344);
		});
	}
});

/*
 * Card-level "Add to Cart" on phones (W1R2-03). webflow.css gives the card
 * body (.div-block-83) `position:relative; z-index:2` at <= 479px, which
 * trapped the add button's z-index 5 below the card's full-bleed
 * .wf-card-cover (z-index 4): a tap on /shop opened the PDP instead of
 * adding. These run with real touch taps at phone widths.
 */

/**
 * Scroll each element matching `sel` to the middle of the viewport and ask
 * the browser what a finger at its centre would hit. Returns the ones that
 * are covered ("slug → what covers it"); [] means every one is tappable.
 */
const coveredAdds = (page, sel) =>
	page.evaluate((s) => {
		const out = [];
		for (const el of document.querySelectorAll(s)) {
			el.scrollIntoView({ block: 'center', behavior: 'instant' });
			const r = el.getBoundingClientRect();
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			if (!hit || !el.contains(hit)) out.push(`${el.getAttribute('data-wf-add')} → ${hit ? hit.className || hit.tagName : 'nothing'}`);
		}
		return out;
	}, sel);

/** Centre of a locator after scrolling it into view (for raw touchscreen taps). */
async function centreOf(locator) {
	await bringIntoView(locator);
	const b = await locator.boundingBox();
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test.describe('card add on a 390px phone', () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	for (const variant of VARIANTS) {
		test(`tapping a /shop card's "Add to Cart" adds it — toast, badge 1 — and stays on /shop [${variant}]`, async ({ page }) => {
			await setup(page, variant);
			const errors = collectErrors(page);
			await page.goto('/shop' + q(variant));
			const add = page.locator('.wf-shop-add[data-wf-add="rolled-oats"]');
			await bringIntoView(add);
			await add.tap(); // actionability: fails if .wf-card-cover intercepts the tap
			await expect(toast(page)).toBeVisible();
			await expect(toastTitle(page)).toHaveText('Rolled Oats ×1 added to your bag');
			await expect(badge(page)).toHaveText('1');
			expect(new URL(page.url()).pathname).toBe('/shop');
			expect(await adds(page)).toEqual([expect.objectContaining({ slug: 'rolled-oats', qty: 1, source: 'card' })]);
			if (variant !== 'broken') {
				expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_cart')))).toEqual({ 'rolled-oats': 1 });
			}
			expect(errors).toEqual([]);
		});
	}

	test('a raw touch at the Add button centre adds (no navigation); a touch on the name or image still opens the PDP', async ({ page }) => {
		await setup(page);
		await page.goto('/shop');
		const item = page.locator('.wf-shop-item').filter({ has: page.locator('[data-wf-add="health-mix"]') });
		// no actionability checks here: this is exactly what a finger does
		const addAt = await centreOf(item.locator('.wf-shop-add'));
		await page.touchscreen.tap(addAt.x, addAt.y);
		await expect(toastTitle(page)).toHaveText('Health Mix ×1 added to your bag');
		expect(new URL(page.url()).pathname).toBe('/shop');
		await toast(page).locator('.wf-toast-close').tap(); // the phone toast spans the width
		await expect(toast(page)).toHaveCount(0);

		const nameAt = await centreOf(item.locator('.heading-11'));
		await page.touchscreen.tap(nameAt.x, nameAt.y);
		await expect(page).toHaveURL(/\/products\/health-mix$/);

		await page.goto('/shop');
		const imgAt = await centreOf(page.locator('.wf-shop-item').filter({ has: page.locator('[data-wf-add="cornflakes"]') }).locator('.image-4'));
		await page.touchscreen.tap(imgAt.x, imgAt.y);
		await expect(page).toHaveURL(/\/products\/cornflakes$/);
		// the add above went to the bag, the navigations added nothing
		await expect(badge(page)).toHaveText('1');
	});
});

test.describe('card add hit-testing across phone widths', () => {
	test.use({ isMobile: true, hasTouch: true });
	test.beforeEach(async ({ page }) => setup(page));

	for (const width of [360, 390, 479, 480, 767, 768]) {
		test(`every card add is the top element at its centre; the card body still hits the cover [${width}px]`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			await page.goto('/shop?nofx=1');
			await expect(page.locator('.wf-shop-add')).toHaveCount(6);
			expect(await coveredAdds(page, '.wf-shop-add')).toEqual([]);
			// the rest of each shop card is still one big link to its PDP
			const names = await page.evaluate(() =>
				[...document.querySelectorAll('.wf-shop-item')].map((item) => {
					const h = item.querySelector('.heading-11');
					h.scrollIntoView({ block: 'center', behavior: 'instant' });
					const r = h.getBoundingClientRect();
					const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
					return [item.querySelector('[data-wf-add]').getAttribute('data-wf-add'), hit?.closest('.wf-card-cover')?.getAttribute('href') ?? hit?.className];
				})
			);
			for (const [slug, href] of names) expect(href, slug).toBe(`/products/${slug}`);

			// the other card-level adds (MiniProductCard: PDP "Goes well with",
			// recipe "Shop the Ingredients", 404 bestsellers) stay tappable too
			for (const path of ['/products/cornflakes?nofx=1', '/recipes/wf-muesli-yogurt-parfait?nofx=1', '/nope?nofx=1']) {
				await page.goto(path);
				await expect(page.locator('.wf-card [data-wf-add]').first()).toBeAttached();
				expect(await coveredAdds(page, '.wf-card [data-wf-add]'), path).toEqual([]);
			}
		});
	}
});
