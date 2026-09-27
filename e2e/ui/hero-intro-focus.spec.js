/*
 * The page intro (.wf-hero-stagger, fx.js initHero) never hides the page
 * heading from keyboard focus or the accessibility tree (final verification
 * pass 1). It used gsap autoAlpha, i.e. visibility:hidden for the first
 * ~0.4 s, so a keyboard user whose pending-order banner (or bag row, chip)
 * went away during the intro lost focus to <body>. It now fades opacity only.
 *
 * Deterministic on any machine: an init script wraps gsap.to as GSAP installs
 * itself and pauses the hero intro at its first frame (the hidden "from"
 * state), so the test does not race the 0.15 s delay + stagger.
 */
import { test, expect } from '@playwright/test';
import { mockBackend, stubRazorpay, seedBag, hydrated } from './checkout-fixtures.js';

/** Freeze every .wf-hero-stagger intro at its start; window.__wfPlayIntro() lets it run. */
function freezeHeroIntro() {
	let g;
	const frozen = [];
	window.__wfPlayIntro = () => frozen.forEach((t) => t.play());
	Object.defineProperty(window, 'gsap', {
		configurable: true,
		get: () => g,
		set(v) {
			g = v;
			const to = v.to.bind(v);
			v.to = (targets, vars, ...rest) => {
				const tw = to(targets, vars, ...rest);
				const els = v.utils.toArray(targets);
				if (els.length && els.every((el) => el.parentElement?.classList.contains('wf-hero-stagger'))) {
					tw.pause(0);
					frozen.push(tw);
				}
				return tw;
			};
		}
	});
}

const h1State = (page) =>
	page.locator('h1').first().evaluate((el) => {
		const cs = getComputedStyle(el);
		return { visibility: cs.visibility, opacity: cs.opacity, inHero: !!el.closest('.wf-hero-stagger') };
	});

test('keyboard: the pending-order banner goes away mid-intro and focus lands on the page heading, not <body>', async ({ page }) => {
	await page.addInitScript(freezeHeroIntro);
	await mockBackend().install(page);
	await stubRazorpay(page, ['success']);
	await seedBag(page, {}, { wefeasto_pending: { no: 'WF-12345', t: 'x'.repeat(43), at: Date.now(), cartSig: '' } });
	await page.goto('/cart');
	await hydrated(page);
	// Mid-intro: the heading is transparent, but still visible to focus and assistive tech.
	expect(await h1State(page)).toEqual({ visibility: 'visible', opacity: '0', inHero: true });
	const check = page.locator('[data-wf-pending="WF-12345"] [data-wf-pending-check]');
	await check.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('[data-wf-pending]')).toHaveCount(0);
	await expect(page.locator('h1').first()).toBeFocused();
	expect((await h1State(page)).opacity).toBe('0'); // it really happened during the intro
	await page.evaluate(() => window.__wfPlayIntro());
	await expect.poll(async () => (await h1State(page)).opacity).toBe('1');
	await expect(page.locator('h1').first()).toBeFocused();
	expect(await page.locator('h1').first().getAttribute('style')).not.toMatch(/visibility|transform/);
});

for (const path of ['/shop', '/recipes', '/cart', '/checkout', '/no-such-page']) {
	test(`${path}: every hero intro child stays focusable and in the accessibility tree while it fades in`, async ({ page }) => {
		await page.addInitScript(freezeHeroIntro);
		await page.goto(path);
		await expect.poll(() => page.evaluate(() => document.querySelectorAll('.wf-hero-stagger > [style*="opacity"]').length)).toBeGreaterThan(0);
		const kids = await page.evaluate(() =>
			[...document.querySelectorAll('.wf-hero-stagger > *')]
				.filter((el) => el.style.opacity !== '') // the ones the intro animates (IX2 data-w-id children are left alone)
				.map((el) => ({ tag: el.tagName, visibility: getComputedStyle(el).visibility, opacity: getComputedStyle(el).opacity }))
		);
		expect(kids.length).toBeGreaterThan(0);
		for (const k of kids) expect(k, JSON.stringify(k)).toMatchObject({ visibility: 'visible', opacity: '0' });
		const h1 = page.locator('.wf-hero-stagger h1').first();
		await expect(h1).toHaveCount(1);
		await expect(page.getByRole('heading', { level: 1, name: (await h1.textContent()).trim() })).toHaveCount(1); // exposed to AT mid-intro
		await h1.evaluate((el) => {
			el.setAttribute('tabindex', '-1');
			el.focus();
		});
		await expect(h1).toBeFocused();
	});
}
