/*
 * Home "Stay Crunchy" newsletter (roadmap M6) with /api stubbed: POST
 * /api/store/newsletter (never webflow.com), the idle → loading → success |
 * error states in the existing .w-form-done / .w-form-fail regions, the
 * honeypot, and the notices the confirm / unsubscribe redirects land with.
 */
import { test, expect } from '@playwright/test';
import { stubApi, blockStorage, expectNoHorizontalOverflow } from './helpers.js';

const SUCCESS = 'Check your inbox to confirm — then breakfast recipes are on their way.';

test.beforeEach(async ({ context }) => {
	await stubApi(context);
});

/** Every request the page makes, to prove nothing goes to webflow.com. */
function recordRequests(page) {
	const urls = [];
	page.on('request', (r) => urls.push(r.url()));
	return urls;
}

async function hydrated(page) {
	await page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});
}

/** Route POST /api/store/newsletter; returns the recorded request bodies. */
async function newsletterApi(page, respond = () => ({ status: 200, json: { ok: true } })) {
	const bodies = [];
	await page.route('**/api/store/newsletter', async (route) => {
		const body = route.request().postDataJSON();
		bodies.push(body);
		const res = await respond(body, bodies.length);
		if (res === 'abort') return route.abort('internetdisconnected');
		if (res.delay) await new Promise((r) => setTimeout(r, res.delay));
		if (res.gate) await res.gate; // held until the test has seen the busy state
		await route.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.json ?? {}) });
	});
	return bodies;
}

const form = (page) => page.locator('#email-form-2');
const done = (page) => page.locator('.w-form-done');
const fail = (page) => page.locator('.w-form-fail');

async function subscribe(page, email = 'Asha@Example.com ') {
	await page.locator('#email').scrollIntoViewIfNeeded();
	await page.fill('#email', email);
	await page.click('#email-form-2 input[type="submit"]');
}

for (const variant of ['normal', 'nofx', 'no-storage']) {
	test(`subscribe: loading spinner → success copy; nothing goes to webflow.com (${variant})`, async ({ page }) => {
		if (variant === 'no-storage') await page.addInitScript(blockStorage);
		const urls = recordRequests(page);
		let release;
		const gate = new Promise((r) => (release = r));
		const bodies = await newsletterApi(page, () => ({ status: 200, json: { ok: true }, gate }));
		await page.goto(variant === 'nofx' ? '/?nofx=1' : '/');
		await hydrated(page);
		await subscribe(page);
		const submit = form(page).locator('input[type="submit"]');
		await expect(submit).toBeDisabled();
		await expect(submit).toHaveValue('Please wait...');
		await expect(form(page)).toHaveAttribute('aria-busy', 'true');
		await expect(form(page).locator('.wf-nl-spinner svg.wf-spinner')).toBeVisible();
		await expect(done(page)).toBeHidden();
		release();
		await expect(done(page)).toBeVisible();
		await expect(done(page)).toHaveText(SUCCESS);
		await expect(done(page)).toBeFocused();
		await expect(form(page)).toBeHidden();
		await expect(fail(page)).toBeHidden();
		expect(bodies).toEqual([{ email: 'Asha@Example.com', website: '' }]);
		expect(urls.filter((u) => /webflow\.com/i.test(u))).toEqual([]);
	});
}

const errors = [
	['malformed email (400)', { status: 400, json: { error: { code: 'VALIDATION', message: 'x', details: { fields: { email: 'invalid' } } } } }, 'That email doesn’t look right — check it and try again.'],
	['rate limited (429)', { status: 429, json: { error: { code: 'RATE_LIMITED', message: 'x' } } }, 'Too many tries — please wait a minute and try again.'],
	['server error (500)', { status: 500, json: { error: { code: 'INTERNAL', message: 'x' } } }, 'Oops! Something went wrong while submitting the form.'],
	['offline', 'abort', 'We couldn’t reach Wefeasto — check your connection and try again.']
];
for (const [name, res, copy] of errors) {
	test(`error: ${name} → .w-form-fail, form stays; typing clears it`, async ({ page }) => {
		await newsletterApi(page, () => res);
		await page.goto('/');
		await hydrated(page);
		await subscribe(page, 'asha@example.com');
		await expect(fail(page)).toBeVisible();
		await expect(fail(page)).toHaveText(copy);
		await expect(fail(page)).toBeFocused();
		await expect(form(page)).toBeVisible();
		await expect(done(page)).toBeHidden();
		await expect(form(page).locator('input[type="submit"]')).toBeEnabled();
		await page.locator('#email').press('End');
		await page.locator('#email').type('m');
		await expect(fail(page)).toBeHidden();
	});
}

test('retry after an error succeeds', async ({ page }) => {
	await newsletterApi(page, (_, n) => (n === 1 ? { status: 500, json: {} } : { status: 200, json: { ok: true } }));
	await page.goto('/');
	await hydrated(page);
	await subscribe(page, 'asha@example.com');
	await expect(fail(page)).toBeVisible();
	await page.click('#email-form-2 input[type="submit"]');
	await expect(done(page)).toHaveText(SUCCESS);
	await expect(fail(page)).toBeHidden();
});

test('honeypot: off-screen, out of the tab order, and sent as `website`', async ({ page }) => {
	const bodies = await newsletterApi(page);
	await page.goto('/');
	await hydrated(page);
	const hp = form(page).locator('input[name="website"]');
	await expect(hp).toHaveAttribute('tabindex', '-1');
	await expect(hp).toHaveAttribute('autocomplete', 'off');
	await expect(hp).toHaveAttribute('aria-hidden', 'true');
	const box = await hp.boundingBox();
	expect(box === null || box.x + box.width <= 0 || box.width <= 1).toBe(true);
	await page.locator('#email').focus();
	await page.keyboard.press('Tab');
	await expect(form(page).locator('input[type="submit"]')).toBeFocused();
	// a bot fills everything: the server gets the trap value (and drops it silently)
	await hp.evaluate((el) => {
		el.value = 'https://spam.example';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await subscribe(page, 'bot@example.com');
	await expect(done(page)).toHaveText(SUCCESS);
	expect(bodies).toEqual([{ email: 'bot@example.com', website: 'https://spam.example' }]);
});

const notices = [
	['?subscribed=1', 'done', 'You’re subscribed — check your inbox for your welcome treat.', false],
	['?subscribed=expired', 'fail', 'That confirmation link has expired or was replaced — sign up again below.', true],
	['?subscribed=error', 'fail', 'Something went wrong confirming — please tap the link in your email again.', true],
	['?unsubscribed=1', 'done', 'You’re unsubscribed. You won’t get marketing emails from us.', true],
	['?unsubscribed=invalid', 'fail', 'That unsubscribe link didn’t work — reply to any of our emails and we’ll take you off.', true],
	['?unsubscribed=error', 'fail', 'Something went wrong — please try the link again.', true]
];
for (const [query, region, copy, formVisible] of notices) {
	test(`${query}#newsletter → notice in the block, param stripped`, async ({ page }) => {
		await page.goto(`/${query}#newsletter`);
		await hydrated(page);
		const box = region === 'done' ? done(page) : fail(page);
		await expect(box).toBeVisible();
		await expect(box).toHaveText(copy);
		await expect(form(page)).toBeVisible({ visible: formVisible });
		await expect.poll(() => new URL(page.url()).search).toBe('');
		expect(new URL(page.url()).hash).toBe('#newsletter');
		await expect(page.locator('#newsletter')).toBeInViewport();
	});
}

/*
 * Where the confirm / unsubscribe redirect leaves the visitor (W2V-7). The
 * browser's own jump to #newsletter happened while the block's slide-in
 * transform (y 100px) was applied. When the slide ended, the block sat 100px
 * higher, with the heading under the sticky nav at 1280px, and its 96px
 * scroll-margin-top had no effect. These wait for everything to settle, then
 * measure against the nav.
 */
const landing = (page) =>
	page.evaluate(() => {
		const nl = document.getElementById('newsletter');
		return {
			top: Math.round(nl.getBoundingClientRect().top),
			heading: Math.round(nl.querySelector('h2').getBoundingClientRect().top),
			nav: Math.round(document.querySelector('.div-block-79').getBoundingClientRect().bottom),
			margin: parseFloat(getComputedStyle(nl).scrollMarginTop)
		};
	});

/** The block sits its scroll-margin below the top, the heading clear of the nav, and it stays there. */
async function expectLanded(page) {
	const onMark = async () => {
		const l = await landing(page);
		return Math.abs(l.top - l.margin) <= 2;
	};
	await expect.poll(onMark, { timeout: 8000 }).toBe(true);
	await page.waitForTimeout(1500); // past the 1.1s slide-in and fx.js's delayed ScrollTrigger refresh
	const l = await landing(page);
	expect(l.margin).toBe(96);
	expect(Math.abs(l.top - l.margin)).toBeLessThanOrEqual(2);
	expect(l.heading).toBeGreaterThanOrEqual(l.nav + 8);
}

for (const [w, h] of [[1280, 800], [390, 844]]) {
	for (const variant of ['motion', 'nofx']) {
		test(`${w}px landing on ?subscribed=1#newsletter: heading clear of the nav (${variant})`, async ({ page }) => {
			await page.setViewportSize({ width: w, height: h });
			await page.goto(variant === 'nofx' ? '/?subscribed=1&nofx=1#newsletter' : '/?subscribed=1#newsletter');
			await hydrated(page);
			await expect(done(page)).toBeVisible();
			await expectLanded(page);
		});
	}
}

for (const path of ['/?unsubscribed=invalid#newsletter', '/#newsletter']) {
	test(`1280px landing on ${path}: heading clear of the nav`, async ({ page }) => {
		await page.goto(path);
		await hydrated(page);
		await expectLanded(page);
	});
}

/** Hold the hero image so the load event waits for the test. */
async function holdLoad(page) {
	let release;
	const gate = new Promise((r) => (release = r));
	await page.route('**/images/wefeasto/hero.jpg', async (route) => {
		await gate;
		await route.continue();
	});
	return release;
}

test('a slow load still ends on the block', async ({ page }) => {
	const release = await holdLoad(page);
	await page.goto('/?subscribed=1#newsletter', { waitUntil: 'domcontentloaded' });
	await hydrated(page);
	await page.waitForTimeout(1500); // slide-in done while the page is still loading
	expect(await page.evaluate(() => document.readyState)).not.toBe('complete');
	release();
	await page.waitForFunction(() => document.readyState === 'complete');
	await expectLanded(page);
});

test('scrolling during the landing is never undone when loading ends', async ({ page }) => {
	const release = await holdLoad(page);
	await page.goto('/?subscribed=1#newsletter', { waitUntil: 'domcontentloaded' });
	await hydrated(page);
	await expect.poll(async () => Math.abs((await landing(page)).top - 96) <= 2, { timeout: 8000 }).toBe(true);
	await page.mouse.move(640, 400);
	await page.mouse.wheel(0, -700);
	await expect.poll(async () => (await landing(page)).top, { timeout: 5000 }).toBeGreaterThan(500);
	release();
	await page.waitForFunction(() => document.readyState === 'complete');
	await page.waitForTimeout(1000);
	expect((await landing(page)).top).toBeGreaterThan(500);
});

test('unknown values are ignored (and still stripped)', async ({ page }) => {
	await page.goto('/?subscribed=<b>x</b>');
	await hydrated(page);
	await expect.poll(() => new URL(page.url()).search).toBe('');
	await expect(done(page)).toBeHidden();
	await expect(fail(page)).toBeHidden();
	await expect(form(page)).toBeVisible();
});

test('390px: the busy form does not overflow', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let release;
	const gate = new Promise((r) => (release = r));
	await newsletterApi(page, () => ({ status: 200, json: { ok: true }, gate }));
	await page.goto('/');
	await hydrated(page);
	await subscribe(page, 'asha@example.com');
	await expect(form(page).locator('.wf-nl-spinner')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	release();
});
