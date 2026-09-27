/*
 * HUNT a11y-motion (sf-core): the mini-bag toast's aria-live region is created together
 * with its first message when the shopper adds before the toast chunk has loaded.
 *
 * The layout fetches CartToast.svelte lazily (requestIdleCallback, 4 s timeout; Safari has
 * no requestIdleCallback → a 2.5 s timer) and queues adds that happen earlier; CartToast
 * replays them in onMount. `mounted = true` and the replayed onAdd() land in the same
 * update, so `<div aria-live="polite" data-wf-toast-live>` is first rendered already
 * holding "Muesli ×1 added to your bag." A live region that appears with its text is not
 * announced by screen readers (the component's own header says "a live region must predate
 * its text"), so the very first add on a freshly loaded page, or any add while the chunk
 * is still downloading on a slow connection, gives a screen-reader user no feedback.
 *
 * Repro: hold the toast chunk until after the add (a slow network), then watch the region
 * frame by frame.
 *
 * Run: E2E_SLOT=4 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/a11y-motion/toast-first-add-live.spec.js
 */
import { test, expect } from '../../fixtures.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

/** Record [data-wf-toast-live] every frame: when it exists and what it says. */
function watchToastLive() {
	window.__toastLive = [];
	const tick = () => {
		const n = document.querySelector('[data-wf-toast-live]');
		const text = n ? n.textContent : null;
		const last = window.__toastLive[window.__toastLive.length - 1];
		if (!last || last.node !== n || last.text !== text) window.__toastLive.push({ node: n, text });
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

test('first add before the toast chunk loads: the live region exists (empty) before the message', async ({ page, shop }) => {
	let release;
	const held = new Promise((r) => (release = r));
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const res = await route.fetch();
		const body = await res.text();
		if (body.includes('data-wf-toast-live')) await held; // slow network for the toast chunk only
		await route.fulfill({ response: res, body });
	});
	await page.addInitScript(watchToastLive);

	await shop.visit('/products/muesli');
	await page.locator('[data-wf-add="muesli"][data-wf-qty-input]').click();
	await expect.poll(() => page.evaluate(() => window.WefeastoCart.read().muesli)).toBe(1);
	release();
	await expect(page.locator('[data-wf-toast]')).toBeVisible();
	await expect(page.locator('[data-wf-toast-live]')).toContainText('added to your bag');

	const log = await page.evaluate(() => window.__toastLive.filter((e) => e.node).map((e) => e.text));
	// A screen reader only announces a change to a region that was already there.
	expect(log[0], `first rendered state of the toast live region (then: ${JSON.stringify(log.slice(1))})`).toBe('');
});
