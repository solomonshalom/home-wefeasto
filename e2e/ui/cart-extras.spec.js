/*
 * Around the bag: /cart?add= deep links + &src= attribution (M5), ?offer=
 * chips (S6), "Your usual" (M5) on the empty bag, /shop and home, the
 * announcement bar being off by default (S11), the PDP perks line (S7) and
 * product facts (M7), and the recipe-rail markup (S10). Link and usual flows
 * also run with ?nofx=1 and with localStorage throwing.
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { collectErrors, expectNoHorizontalOverflow, blockStorage } from './helpers.js';

const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));

/**
 * The facts a product's snapshot fills in, in legal-label order: [label, short, value].
 * (The facts are owner data — e.g. country of origin stays null until the owner
 * supplies it — so the PDP checks follow the snapshot instead of hard-coding it.)
 */
const FACT_LABELS = [
	['netQuantity', 'Net quantity', 'net quantity'],
	['ingredients', 'Ingredients', 'ingredients'],
	['allergens', 'Allergens', 'allergens'],
	['bestBefore', 'Best before', 'best before'],
	['manufacturer', 'Manufacturer / packer', 'manufacturer'],
	['countryOfOrigin', 'Country of origin', 'country of origin']
];
function snapshotFacts(slug) {
	const facts = SNAPSHOT.products.find((p) => p.slug === slug).facts || {};
	return FACT_LABELS.map(([key, label, short]) => {
		const raw = facts[key];
		const value = (Array.isArray(raw) ? raw : [raw]).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()).join(', ');
		return [label, short, value];
	}).filter(([, , value]) => value);
}

function breakStorage() {
	for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
		Storage.prototype[m] = function () {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		};
	}
}

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

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_cart') || 'null'));
const rowQty = (page, slug) => page.locator(`[data-wf-row="${slug}"] .wf-qty-input`);
const DAY = 86400000;
const lastOrder = (items, ageDays = 1) => ({ no: 'WF-10001', t: 'tok', items, at: Date.now() - ageDays * DAY });

async function seed(page, key, value) {
	await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [key, value]);
}

for (const variant of ['normal', 'nofx', 'broken']) {
	const nofx = variant === 'nofx' ? '&nofx=1' : '';
	test.describe(`/cart?add= deep links [${variant}]`, () => {
		test.beforeEach(async ({ page }) => setup(page, variant));

		test('adds, strips add/src from the URL, remembers src, and is idempotent', async ({ page }) => {
			const errors = collectErrors(page);
			await page.goto('/cart?add=cornflakes:2,muesli:1&src=email' + nofx);
			await expect(rowQty(page, 'cornflakes')).toHaveValue('2');
			await expect(rowQty(page, 'muesli')).toHaveValue('1');
			await expect(page).toHaveURL(variant === 'nofx' ? /\/cart\?nofx=1$/ : /\/cart$/);
			await expect(page.locator('[data-wf-link-note]')).toHaveText('Added from your link: Cornflakes ×2, Muesli ×1.');
			expect(await page.evaluate(() => window.__adds)).toEqual([expect.objectContaining({ source: 'email', qty: 3 })]);
			await expect(page.locator('[data-wf-toast]')).toHaveCount(0);
			if (variant !== 'broken') {
				expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('wefeasto_src')).src)).toBe('email');
				expect(await stored(page)).toEqual({ cornflakes: 2, muesli: 1 });
				// refresh: the param is gone, nothing more is added
				await page.reload();
				await expect(rowQty(page, 'cornflakes')).toHaveValue('2');
				// opening the same link again tops up to the linked quantities only
				await page.goto('/cart?add=cornflakes:2,muesli:1&src=email' + nofx);
				await expect(page.locator('[data-wf-link-note]')).toHaveText('Everything from your link is already in your bag.');
				expect(await stored(page)).toEqual({ cornflakes: 2, muesli: 1 });
			}
			expect(errors).toEqual([]);
		});

		test('garbage: muesli:-5,foo:3,cornflakes:1e9 → cornflakes ×10 only, with a note', async ({ page }) => {
			await page.goto('/cart?add=muesli:-5,foo:3,cornflakes:1e9' + nofx);
			await expect(rowQty(page, 'cornflakes')).toHaveValue('10');
			await expect(page.locator('[data-wf-row]')).toHaveCount(1);
			await expect(page.locator('[data-wf-link-dropped]')).toHaveText('Skipped: the quantity for Muesli didn’t look right; we couldn’t find “foo”.');
			if (variant !== 'broken') expect(await stored(page)).toEqual({ cornflakes: 10 });
		});
	});
}

test.describe('deep links and offers', () => {
	test.beforeEach(async ({ page }) => setup(page));

	test('merges into an existing bag (never replaces it)', async ({ page }) => {
		await page.goto('/shop');
		await seed(page, 'wefeasto_cart', { 'rolled-oats': 1, cornflakes: 1 });
		await page.goto('/cart?add=cornflakes:3,health-mix');
		await expect(rowQty(page, 'cornflakes')).toHaveValue('3');
		await expect(rowQty(page, 'health-mix')).toHaveValue('1');
		expect(await stored(page)).toEqual({ 'rolled-oats': 1, cornflakes: 3, 'health-mix': 1 });
		await expect(page.locator('[data-wf-link-note]')).toHaveText('Added from your link: Cornflakes ×2, Health Mix ×1.');
	});

	test('encoded commas (%2C / %3A), unknown src ignored, unknown slug in a long link', async ({ page }) => {
		await page.goto('/cart?add=cornflakes%3A1%2Cmuesli%3A2&src=evil');
		await expect(rowQty(page, 'muesli')).toHaveValue('2');
		expect(await page.evaluate(() => sessionStorage.getItem('wefeasto_src'))).toBeNull();
		expect(await page.evaluate(() => window.__adds[0].source)).toBe('link');
		await page.goto('/cart?add=cornflakes,muesli,rolled-oats,steel-cut-oats,choco-flakes,health-mix,ghost-two');
		await expect(page.locator('[data-wf-link-dropped]')).toContainText('we couldn’t find “ghost-two”');
	});

	test('?add= elsewhere is ignored (only /cart reads it)', async ({ page }) => {
		await page.goto('/shop?add=cornflakes:2');
		await page.waitForTimeout(500);
		expect(await stored(page)).toBeNull();
		await expect(page).toHaveURL(/add=cornflakes/);
	});

	test('a link preview without JS never changes a bag', async ({ browser }) => {
		const ctx = await browser.newContext({ javaScriptEnabled: false });
		const page = await ctx.newPage();
		const res = await page.goto('/cart?add=cornflakes:2');
		expect(res.status()).toBe(200);
		expect(await res.text()).toContain('Your bag needs JavaScript to display');
		await expect(page.locator('[data-wf-row]')).toHaveCount(0);
		await ctx.close();
	});

	test('?offer=CODE: stored for 30 days, shown as a removable chip', async ({ page }) => {
		await page.goto('/shop');
		await seed(page, 'wefeasto_cart', { muesli: 1 });
		await page.goto('/cart?offer=welcome10');
		const chip = page.locator('[data-wf-offer]');
		await expect(chip).toHaveText(/Offer WELCOME10\s*will be applied at checkout/);
		await expect(page).toHaveURL(/\/cart$/);
		const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_offer')));
		expect(saved.code).toBe('WELCOME10');
		expect(Math.abs(saved.at - Date.now())).toBeLessThan(60_000);
		await page.reload();
		await expect(chip).toBeVisible();
		await chip.locator('.wf-offer-remove').click();
		await expect(chip).toHaveCount(0);
		expect(await page.evaluate(() => localStorage.getItem('wefeasto_offer'))).toBeNull();
		await page.reload();
		await expect(page.locator('#wf-cart-summary')).toBeVisible();
		await expect(chip).toHaveCount(0);
	});

	test('an expired or malformed offer is not shown', async ({ page }) => {
		await page.goto('/shop');
		await seed(page, 'wefeasto_cart', { muesli: 1 });
		await seed(page, 'wefeasto_offer', { code: 'OLD10', at: Date.now() - 31 * DAY });
		await page.goto('/cart');
		await expect(page.locator('#wf-cart-summary')).toBeVisible();
		await expect(page.locator('[data-wf-offer]')).toHaveCount(0);
		await page.goto('/cart?offer=%3Cscript%3E');
		await expect(page.locator('[data-wf-offer-note]')).toHaveText('That offer link doesn’t look right — nothing was applied.');
		await expect(page.locator('[data-wf-offer]')).toHaveCount(0);
	});

	test('offer chip works for the session when storage throws', async ({ page }) => {
		await page.addInitScript(breakStorage);
		await page.goto('/cart?add=muesli&offer=hello-7k2q');
		await expect(page.locator('[data-wf-offer]')).toHaveText(/Offer HELLO-7K2Q\s*will be applied at checkout/);
	});
});

for (const variant of ['normal', 'nofx', 'broken']) {
	test.describe(`"Your usual" [${variant}]`, () => {
		test.beforeEach(async ({ page }) => setup(page, variant));

		test('empty bag: above "Shop Breakfast"; Add all → one event, rows appear', async ({ page }) => {
			if (variant === 'broken') {
				// storage throwing → no last order can be read → the card stays hidden
				await page.goto('/cart');
				await expect(page.locator('.wf-cart-empty')).toBeVisible();
				await expect(page.locator('[data-wf-usual]')).toHaveCount(0);
				return;
			}
			await page.goto('/shop');
			await seed(page, 'wefeasto_last_order', lastOrder({ cornflakes: 2, muesli: 1 }));
			await page.goto('/cart' + (variant === 'nofx' ? '?nofx=1' : ''));
			const usual = page.locator('.wf-cart-empty [data-wf-usual="cart"]');
			await expect(usual).toHaveText(/Your usual: Cornflakes ×2 · Muesli ×1\s*Add all · ₹600/);
			await expect(usual.locator('.wf-usual-dismiss')).toHaveCount(0);
			// sits above the Shop Breakfast button
			const order = await page.locator('.wf-cart-empty').evaluate((el) => [...el.children].map((c) => c.className));
			expect(order.indexOf('wf-usual wf-usual-cart')).toBeLessThan(order.indexOf('wf-cart-empty-actions'));
			await usual.locator('[data-wf-usual-add]').click();
			await expect(rowQty(page, 'cornflakes')).toHaveValue('2');
			await expect(rowQty(page, 'muesli')).toHaveValue('1');
			await expect(page.locator('[data-wf-total]')).toHaveText('₹600');
			expect(await page.evaluate(() => window.__adds)).toEqual([expect.objectContaining({ source: 'usual', qty: 3 })]);
		});

		test('/shop: between the heading and the chips; dismiss hides it for 14 days', async ({ page }) => {
			const suffix = variant === 'nofx' ? '?nofx=1' : '';
			await page.goto('/shop' + suffix);
			if (variant === 'broken') {
				await expect(page.locator('#wf-shop-grid')).toBeVisible();
				await expect(page.locator('[data-wf-usual]')).toHaveCount(0);
				return;
			}
			await seed(page, 'wefeasto_last_order', lastOrder({ 'steel-cut-oats': 1, 'choco-flakes': 2 }));
			await page.reload();
			const usual = page.locator('[data-wf-usual="shop"]');
			await expect(usual).toHaveText(/Your usual: Steel-Cut Oats ×1 · Choco's ×2\s*Add all · ₹535/);
			const between = await usual.evaluate((el) => [el.previousElementSibling?.previousElementSibling?.className, el.nextElementSibling?.className]);
			expect(between).toEqual([expect.stringContaining('wf-shop-header'), 'wf-shop-toolbar']);
			await usual.locator('.wf-usual-dismiss').click();
			await expect(usual).toHaveCount(0);
			const hiddenAt = await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_usual_hidden')));
			expect(Math.abs(hiddenAt - Date.now())).toBeLessThan(60_000);
			await page.reload();
			await expect(page.locator('#wf-shop-grid')).toBeVisible();
			await expect(usual).toHaveCount(0);
			// 15 days later it's back
			await seed(page, 'wefeasto_usual_hidden', Date.now() - 15 * DAY);
			await page.reload();
			await expect(usual).toBeVisible();
		});
	});
}

test.describe('"Your usual" rules', () => {
	test.beforeEach(async ({ page }) => setup(page));

	test('hidden when the bag already holds it; "Add the rest" when it holds part', async ({ page }) => {
		await page.goto('/shop?nofx=1');
		await seed(page, 'wefeasto_last_order', lastOrder({ cornflakes: 2, muesli: 1 }));
		await seed(page, 'wefeasto_cart', { cornflakes: 1 });
		await page.reload();
		const usual = page.locator('[data-wf-usual="shop"]');
		await expect(usual.locator('[data-wf-usual-add]')).toHaveText('Add the rest · ₹425');
		await usual.locator('[data-wf-usual-add]').click();
		expect(await stored(page)).toEqual({ cornflakes: 2, muesli: 1 });
		await expect(usual).toHaveCount(0);
		await page.reload();
		await expect(page.locator('#wf-shop-grid')).toBeVisible();
		await expect(usual).toHaveCount(0);
	});

	test('hidden when older than 120 days; unknown products are skipped', async ({ page }) => {
		await page.goto('/shop?nofx=1');
		await seed(page, 'wefeasto_last_order', lastOrder({ cornflakes: 2 }, 121));
		await page.reload();
		await expect(page.locator('#wf-shop-grid')).toBeVisible();
		await expect(page.locator('[data-wf-usual]')).toHaveCount(0);
		await seed(page, 'wefeasto_last_order', lastOrder({ 'discontinued-granola': 1, muesli: 1 }, 119));
		await page.reload();
		await expect(page.locator('[data-wf-usual="shop"]')).toHaveText(/Your usual: Muesli ×1\s*Add all · ₹250/);
	});

	test('home: inside Shop Bestsellers, above the grid, never in the first viewport', async ({ page }) => {
		await page.goto('/?nofx=1');
		await seed(page, 'wefeasto_last_order', lastOrder({ muesli: 1 }));
		await page.reload();
		const usual = page.locator('#bestsellers > [data-wf-usual="home"]');
		await expect(usual).toBeAttached();
		expect(await usual.evaluate((el) => el.nextElementSibling.className)).toBe('w-dyn-list');
		const top = await usual.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
		expect(top).toBeGreaterThan(800);
	});

	test('prerendered pages carry no usual markup (client-only)', async ({ request }) => {
		for (const path of ['/', '/shop', '/cart']) {
			const html = await (await request.get(path)).text();
			expect(html).not.toContain('wf-usual');
		}
	});
});

test.describe('announcement bar (off by default)', () => {
	test('no DOM at all when settings.announcement.enabled is false', async ({ page, request }) => {
		await setup(page);
		for (const path of ['/', '/shop', '/products/muesli', '/cart', '/recipes/wf-muesli-yogurt-parfait']) {
			const html = await (await request.get(path)).text();
			expect(html).not.toContain('wf-announce');
			await page.goto(path + '?nofx=1');
			await expect(page.locator('.div-block-79')).toBeVisible();
			await expect(page.locator('.wf-announce')).toHaveCount(0);
		}
	});
});

test.describe('PDP: perks line + product facts', () => {
	test.beforeEach(async ({ page }) => setup(page));

	test('perks sit directly above the partners dropdown, from the settings', async ({ page }) => {
		await page.goto('/products/cornflakes?nofx=1');
		const perks = page.locator('[data-wf-perks]');
		await expect(perks).toHaveText('Buying here: free delivery over ₹499 · COD available · fresh from our kitchen');
		expect(await perks.evaluate((el) => el.nextElementSibling.className)).toContain('wf-partners');
	});

	test('facts: a closed <details> after the partners dropdown, only facts that exist', async ({ page }) => {
		const want = snapshotFacts('cornflakes');
		expect(want.length).toBeGreaterThan(0); // pack size → net quantity, at least
		await page.goto('/products/cornflakes?nofx=1');
		const facts = page.locator('details.wf-facts');
		await expect(facts).toHaveCount(1);
		expect(await facts.evaluate((el) => el.previousElementSibling.className)).toContain('wf-partners');
		expect(await facts.evaluate((el) => el.open)).toBe(false);
		await expect(facts.locator('summary')).toHaveText('Product facts: ' + want.map(([, short]) => short).join(', '));
		await facts.locator('summary').click();
		await expect(facts.locator('.wf-facts-row dt')).toHaveText(want.map(([label]) => label));
		await expect(facts.locator('.wf-facts-row dd')).toHaveText(want.map(([, , value]) => value));
	});

	test('facts: every PDP lists exactly the facts its snapshot fills in (none → no <details>)', async ({ request }) => {
		for (const { slug } of SNAPSHOT.products) {
			const html = await (await request.get('/products/' + slug)).text();
			const want = snapshotFacts(slug);
			const summary = html.match(/<summary class="wf-facts-summary">([^<]*)<\/summary>/);
			if (!want.length) {
				expect(html, slug).not.toContain('class="wf-facts"');
				continue;
			}
			expect(summary?.[1], slug).toBe('Product facts: ' + want.map(([, short]) => short).join(', '));
			const labels = [...html.matchAll(/<div class="wf-facts-row"><dt>([^<]*)<\/dt>/g)].map((m) => m[1]);
			expect(labels, slug).toEqual(want.map(([label]) => label));
			// A fact the snapshot leaves empty is never rendered.
			for (const [, label] of FACT_LABELS.filter(([, l]) => !labels.includes(l))) expect(html, slug).not.toContain(`<dt>${label}</dt>`);
		}
	});

	test('facts open without JS (native <details>), below the Add row', async ({ browser }) => {
		const ctx = await browser.newContext({ javaScriptEnabled: false });
		const page = await ctx.newPage();
		await page.goto('/products/muesli');
		await expect(page.locator('details.wf-facts .wf-facts-row').first()).toBeHidden();
		await page.locator('details.wf-facts summary').click();
		await expect(page.locator('details.wf-facts .wf-facts-row').first()).toBeVisible();
		// The panel is vertically centred, so opening shifts the column by half the
		// facts' height; the Add row stays in view and above the facts.
		const add = await page.locator('[data-wf-add="muesli"]').boundingBox();
		const facts = await page.locator('details.wf-facts').boundingBox();
		expect(add.y + add.height).toBeLessThan(facts.y);
		expect(add.y).toBeGreaterThan(0);
		await expect(page.locator('[data-wf-perks]')).toBeVisible();
		await ctx.close();
	});
});

test.describe('recipe rail (S10)', () => {
	test('fifth rail item, sticky on desktop with the links, prerendered', async ({ page, request }) => {
		await setup(page);
		const html = await (await request.get('/recipes/wf-berry-overnight-steel-cut-oats')).text();
		expect(html).toMatch(/class="button wf-rail-add w-inline-block"[^>]*><div>Add Steel-Cut Oats · ₹135<\/div>/);
		await page.goto('/recipes/wf-berry-overnight-steel-cut-oats?nofx=1');
		const items = page.locator('.div-block-183 .grid-42 > *');
		await expect(items).toHaveCount(5);
		await expect(items.nth(4)).toHaveText('Add Steel-Cut Oats · ₹135');
		expect(await page.locator('.div-block-183').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
	});

	test('phone: static, first thing under the rail links, no overflow', async ({ browser }) => {
		const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
		const page = await ctx.newPage();
		await setup(page);
		await page.goto('/recipes/wf-honey-nut-cornflake-clusters?nofx=1');
		const rail = page.locator('.grid-42 .wf-rail-add');
		await expect(rail).toHaveText('Add Cornflakes · ₹175');
		expect(await page.locator('.div-block-183').evaluate((el) => getComputedStyle(el).position)).toBe('static');
		await rail.tap();
		await expect(page.locator('[data-wf-toast]')).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await ctx.close();
	});
});

test.describe('storage getter throwing (ui-kit blockStorage)', () => {
	test('PDP add → toast → bag, all in memory', async ({ page }) => {
		await setup(page);
		await page.addInitScript(blockStorage);
		const errors = collectErrors(page);
		await page.goto('/products/rolled-oats');
		await page.locator('[data-wf-add="rolled-oats"]').first().click();
		await expect(page.locator('[data-wf-toast]')).toBeVisible();
		await page.locator('[data-wf-toast-bag]').click();
		await expect(rowQty(page, 'rolled-oats')).toHaveValue('1');
		await expect(page.locator('[data-wf-delivery]')).toHaveText('₹49');
		expect(errors).toEqual([]);
	});
});
