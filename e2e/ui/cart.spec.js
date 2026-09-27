/*
 * The bag (roadmap M1 honest totals, S4 undo): Delivery row, the ₹498/₹499/
 * ₹500 boundaries, the free-delivery meter and one-tap top-up, the colour
 * mix, the no-motion path, undo on remove, cross-tab sync and the phone
 * layout. Key flows run normal / ?nofx=1 / localStorage-throws.
 * /api is stubbed: 404 (snapshot values), or a crafted /api/store/catalog to
 * drive the live overlay (prices at the free-delivery boundary).
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { collectErrors, expectNoHorizontalOverflow } from './helpers.js';

const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));

/** A /api/store/catalog body from the snapshot, with per-slug and settings overrides. */
function liveCatalog(over = {}, settings = {}) {
	return {
		settings: { ...SNAPSHOT.settings, ...settings },
		products: SNAPSHOT.products.map((p) => ({
			slug: p.slug,
			name: p.name,
			pricePaise: p.pricePaise,
			inStock: p.inStock,
			lowStock: null,
			maxPerOrder: p.maxPerOrder,
			codAllowed: p.codAllowed,
			...(over[p.slug] || {})
		}))
	};
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

/** Stub /api; `api.catalog` (mutable) answers /api/store/catalog when set. */
async function setup(page, variant = 'normal', api = {}) {
	waitForHydrationOnGoto(page);
	await page.route('**/api/**', (route) => {
		if (api.catalog && route.request().url().includes('/api/store/catalog')) {
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(api.catalog) });
		}
		return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
	});
	await page.addInitScript(recordAdds);
	if (variant === 'broken') await page.addInitScript(breakStorage);
}

/**
 * Open /cart holding `bag`. normal/nofx: seed localStorage, then load
 * /cart(?nofx=1). broken: storage throws, so fill the in-memory bag and
 * reach /cart by a client-side navigation (the nav bag icon).
 */
async function openBag(page, bag, variant = 'normal') {
	await page.goto('/shop' + (variant === 'nofx' ? '?nofx=1' : ''));
	if (variant === 'broken') {
		await page.evaluate((b) => {
			for (const [slug, qty] of Object.entries(b)) window.WefeastoCart.setQty(slug, qty);
		}, bag);
		await page.locator('.div-block-79 a[href="/cart"]').click();
		await expect(page).toHaveURL(/\/cart$/);
	} else {
		await page.evaluate((b) => localStorage.setItem('wefeasto_cart', JSON.stringify(b)), bag);
		await page.goto('/cart' + (variant === 'nofx' ? '?nofx=1' : ''));
	}
	await expect(page.locator('#wf-cart-summary')).toBeVisible();
}

const summary = (page) => page.locator('#wf-cart-summary');
const subtotal = (page) => page.locator('[data-wf-subtotal]');
const delivery = (page) => page.locator('[data-wf-delivery]');
const total = (page) => page.locator('[data-wf-total]');
const note = (page) => page.locator('[data-wf-note]');
/**
 * One synchronous count of bag lines (.wf-cart-row), line hooks and undo rows.
 * (Not toHaveCount: its retries outlast the 6 s undo window, so an over-count
 * while an undo row is pending could "pass" once the row expires.)
 */
const bagCounts = (page) =>
	page.evaluate(() => ({
		lines: document.querySelectorAll('.wf-cart-row').length,
		rows: document.querySelectorAll('[data-wf-row]').length,
		undos: document.querySelectorAll('[data-wf-undo]').length,
		undoIsLine: [...document.querySelectorAll('[data-wf-undo]')].some((el) => el.classList.contains('wf-cart-row'))
	}));
const meter = (page) => summary(page).locator('[role="progressbar"]');
const badge = (page) => page.locator('.div-block-79 .wf-cart-count');

test.describe('honest totals: the ₹499 free-delivery boundary', () => {
	for (const [label, pricePaise, want] of [
		['₹498 pays the fee', 49800, { sub: '₹498', del: '₹49', note: 'Free delivery above ₹499 — add ₹1 more', tot: '₹547', pct: '99' }],
		['₹499 is free', 49900, { sub: '₹499', del: 'FREE', note: 'Free delivery above ₹499 — yours is free!', tot: '₹499', pct: '100' }],
		['₹500 is free', 50000, { sub: '₹500', del: 'FREE', note: 'Free delivery above ₹499 — yours is free!', tot: '₹500', pct: '100' }]
	]) {
		test(label + ' (live price overlay)', async ({ page }) => {
			await setup(page, 'normal', { catalog: liveCatalog({ cornflakes: { pricePaise } }) });
			await openBag(page, { cornflakes: 1 });
			await expect(subtotal(page)).toHaveText(want.sub);
			await expect(delivery(page)).toHaveText(want.del);
			await expect(note(page)).toHaveText(want.note);
			await expect(total(page)).toHaveText(want.tot);
			await expect(meter(page)).toHaveAttribute('aria-valuenow', want.pct);
			await expect(page.locator('[data-wf-row="cornflakes"] [data-wf-line]')).toHaveText(want.sub);
			if (want.del === 'FREE') await expect(summary(page).locator('[data-wf-topup]')).toHaveCount(0);
			else await expect(summary(page).locator('[data-wf-topup]')).toHaveCount(1);
		});
	}

	test('fee and threshold come from the (live) settings', async ({ page }) => {
		await setup(page, 'normal', { catalog: liveCatalog({}, { deliveryFeePaise: 5900, freeDeliveryThresholdPaise: 60000 }) });
		await openBag(page, { muesli: 2 });
		await expect(subtotal(page)).toHaveText('₹500');
		await expect(delivery(page)).toHaveText('₹59');
		await expect(note(page)).toHaveText('Free delivery above ₹600 — add ₹100 more');
		await expect(total(page)).toHaveText('₹559');
	});

	test('snapshot values when /api is down; Total = subtotal + fee', async ({ page }) => {
		await setup(page);
		await openBag(page, { muesli: 1, cornflakes: 1 });
		await expect(subtotal(page)).toHaveText('₹425');
		await expect(delivery(page)).toHaveText('₹49');
		await expect(total(page)).toHaveText('₹474');
		// the rows appear before Delivery, which sits right after Subtotal
		const labels = await summary(page).locator('.wf-summary-row > span:first-child').allTextContents();
		expect(labels).toEqual(['Subtotal', 'Delivery', 'Total']);
	});

	test('a sold-out line is flagged and left out of the totals', async ({ page }) => {
		await setup(page, 'normal', { catalog: liveCatalog({ 'rolled-oats': { inStock: false } }) });
		await openBag(page, { muesli: 1, 'rolled-oats': 1 });
		await expect(page.locator('[data-wf-row="rolled-oats"] [data-wf-issue="OUT_OF_STOCK"]')).toHaveText('Rolled Oats just sold out — remove it to continue.');
		await expect(subtotal(page)).toHaveText('₹250');
		await expect(total(page)).toHaveText('₹299');
		// …and never suggested as the top-up
		await expect(summary(page).locator('[data-wf-topup]')).not.toHaveAttribute('data-wf-topup', 'rolled-oats');
	});
});

for (const variant of ['normal', 'nofx', 'broken']) {
	test.describe(`meter + top-up [${variant}]`, () => {
		test.beforeEach(async ({ page }) => setup(page, variant));

		test('Muesli + Cornflakes: 85%, suggests Rolled Oats; tap → 100%, FREE, badge 3, no toast', async ({ page }) => {
			const errors = collectErrors(page);
			await openBag(page, { muesli: 1, cornflakes: 1 }, variant);
			await expect(meter(page)).toHaveAttribute('aria-valuenow', '85');
			await expect(meter(page)).toHaveAttribute('aria-valuetext', '₹74 to go for free delivery');
			const row = summary(page).locator('[data-wf-topup]');
			await expect(row).toHaveAttribute('data-wf-topup', 'rolled-oats');
			await expect(row.locator('.wf-topup-text')).toHaveText('Add Rolled Oats · ₹125 → free delivery');
			await page.evaluate(() => (window.__adds.length = 0));
			await row.locator('.wf-topup-add').click();
			await expect(meter(page)).toHaveAttribute('aria-valuenow', '100');
			await expect(delivery(page)).toHaveText('FREE');
			await expect(note(page)).toHaveText('Free delivery above ₹499 — yours is free!');
			await expect(total(page)).toHaveText('₹550');
			await expect(badge(page)).toHaveText('3');
			await expect(page.locator('[data-wf-row="rolled-oats"]')).toBeVisible();
			await expect(summary(page).locator('[data-wf-topup]')).toHaveCount(0);
			expect(await page.evaluate(() => window.__adds)).toEqual([expect.objectContaining({ slug: 'rolled-oats', qty: 1, source: 'topup' })]);
			await expect(page.locator('[data-wf-toast]')).toHaveCount(0);
			// the fill ends at the bar's full width
			await expect
				.poll(() => page.locator('[data-wf-meter-fill]').evaluate((el) => Math.round((el.getBoundingClientRect().width / el.parentElement.clientWidth) * 100)))
				.toBeGreaterThanOrEqual(99);
			expect(errors).toEqual([]);
		});

		test('re-renders on qty +/−; × asks for a different suggestion', async ({ page }) => {
			await openBag(page, { cornflakes: 1 }, variant);
			// ₹175: nothing single crosses ₹324 → biggest step, "then … to go"
			await expect(summary(page).locator('.wf-topup-text')).toHaveText('Add Health Mix · ₹270 · then ₹54 to go');
			await page.locator('[data-wf-row="cornflakes"] [data-wf-qty-plus]').click();
			await expect(subtotal(page)).toHaveText('₹350');
			await expect(meter(page)).toHaveAttribute('aria-valuenow', '70');
			await expect(summary(page).locator('[data-wf-topup]')).toHaveAttribute('data-wf-topup', 'choco-flakes');
			await summary(page).locator('.wf-topup-skip').click();
			await expect(summary(page).locator('[data-wf-topup]')).not.toHaveAttribute('data-wf-topup', 'choco-flakes');
			await page.locator('[data-wf-row="cornflakes"] [data-wf-qty-minus]').click();
			await expect(subtotal(page)).toHaveText('₹175');
			// nothing is ever added by itself
			expect(await page.evaluate(() => window.__adds.length)).toBe(0);
		});

		test('undo on remove restores quantity and position', async ({ page }) => {
			await openBag(page, { cornflakes: 2, muesli: 4, 'rolled-oats': 1 }, variant);
			await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
			const undo = page.locator('[data-wf-undo="muesli"]');
			await expect(undo).toHaveText(/Removed Muesli ×4\s*Undo/);
			await expect(subtotal(page)).toHaveText('₹475');
			await expect(badge(page)).toHaveText('3');
			// in the removed row's place, focus on Undo
			const order = () => page.locator('.wf-cart-rows > *').evaluateAll((els) => els.map((e) => e.dataset.wfRow || 'undo:' + e.dataset.wfUndo));
			expect(await order()).toEqual(['cornflakes', 'undo:muesli', 'rolled-oats']);
			// the undo row is not a bag line: .wf-cart-row still counts lines only
			expect(await bagCounts(page)).toEqual({ lines: 2, rows: 2, undos: 1, undoIsLine: false });
			await expect(undo.locator('button')).toBeFocused();
			await undo.locator('button').click();
			await expect(page.locator('[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('4');
			expect(await order()).toEqual(['cornflakes', 'muesli', 'rolled-oats']);
			expect(await bagCounts(page)).toEqual({ lines: 3, rows: 3, undos: 0, undoIsLine: false });
			await expect(subtotal(page)).toHaveText('₹1,475');
			await expect(badge(page)).toHaveText('7');
			if (variant !== 'broken') {
				expect(Object.keys(await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_cart'))))).toEqual(['cornflakes', 'muesli', 'rolled-oats']);
			}
		});
	});
}

test.describe('undo details', () => {
	test.beforeEach(async ({ page }) => setup(page));

	/** Computed look of an undo row: it must still read as a line in the list. */
	const undoStyle = (loc) =>
		loc.evaluate((el) => {
			const s = getComputedStyle(el);
			return {
				display: s.display,
				justify: s.justifyContent,
				divider: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}`,
				padding: `${s.paddingTop} ${s.paddingBottom}`,
				overflow: s.overflow
			};
		});
	const UNDO_LOOK = { display: 'flex', justify: 'space-between', divider: '1px solid rgba(51, 51, 51, 0.18)', padding: '14px 14px', overflow: 'hidden' };

	for (const variant of ['normal', 'nofx']) {
		test(`.wf-cart-row counts bag lines only, never pending undo rows (${variant})`, async ({ page }) => {
			// The port's interact regression: {muesli:2, cornflakes:1}, remove muesli → 1 line.
			await openBag(page, { muesli: 2, cornflakes: 1 }, variant);
			await expect(page.locator('.wf-cart-row')).toHaveCount(2);
			if (variant === 'normal') await page.waitForTimeout(900); // entrance stagger done
			await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
			await expect(page.locator('[data-wf-undo="muesli"]')).toBeVisible({ timeout: 3000 });
			expect(await bagCounts(page)).toEqual({ lines: 1, rows: 1, undos: 1, undoIsLine: false });
			expect(await page.locator('.wf-cart-row').evaluateAll((els) => els.map((e) => e.dataset.wfRow))).toEqual(['cornflakes']);
			expect(await undoStyle(page.locator('[data-wf-undo="muesli"]'))).toEqual(UNDO_LOOK);
			await expect(subtotal(page)).toHaveText('₹175');
			// Last line gone → the empty bag, both undo rows still there, zero lines.
			await page.locator('[data-wf-row="cornflakes"] .wf-cart-remove').click();
			await expect(page.locator('.wf-cart-empty h2')).toHaveText('Your bag is empty');
			await expect(page.locator('.wf-cart-empty [data-wf-undo]')).toHaveCount(2);
			expect(await bagCounts(page)).toEqual({ lines: 0, rows: 0, undos: 2, undoIsLine: false });
			expect(await undoStyle(page.locator('[data-wf-undo="cornflakes"]'))).toEqual(UNDO_LOOK);
		});
	}

	test('the undo row expires after ~6 s; several can be pending at once', async ({ page }) => {
		await openBag(page, { cornflakes: 1, muesli: 1, 'rolled-oats': 1 }, 'nofx');
		await page.locator('[data-wf-row="cornflakes"] .wf-cart-remove').click();
		await page.locator('[data-wf-row="rolled-oats"] .wf-cart-remove').click();
		await expect(page.locator('[data-wf-undo]')).toHaveCount(2);
		await page.waitForTimeout(4000);
		await expect(page.locator('[data-wf-undo]')).toHaveCount(2);
		await expect(page.locator('[data-wf-undo]')).toHaveCount(0, { timeout: 4000 });
		await expect(page.locator('.wf-cart-rows > *')).toHaveCount(1);
		expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_cart')))).toEqual({ muesli: 1 });
	});

	test('removing the last item shows the empty bag at once, with Undo still there', async ({ page }) => {
		await openBag(page, { muesli: 3 }, 'nofx');
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
		await expect(page.locator('.wf-cart-empty h2')).toHaveText('Your bag is empty');
		await expect(page.locator('.wf-cart-empty [data-wf-undo="muesli"]')).toBeVisible();
		await page.locator('[data-wf-undo="muesli"] button').click();
		await expect(page.locator('.wf-cart-empty')).toHaveCount(0);
		await expect(page.locator('[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('3');
		await expect(total(page)).toHaveText('₹750');
	});

	test('with motion: the row collapses first, then the undo row takes its place', async ({ page }) => {
		await openBag(page, { cornflakes: 1, muesli: 1 });
		await page.waitForTimeout(900); // entrance stagger done
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
		await expect(page.locator('[data-wf-undo="muesli"]')).toBeVisible({ timeout: 3000 });
		await expect(page.locator('[data-wf-row="muesli"]')).toHaveCount(0);
		await expect(total(page)).toHaveText('₹224');
	});

	/** What has focus: 'BODY' when it was dropped. */
	const focusedDesc = (page) => page.evaluate(() => `${document.activeElement.nodeName}.${document.activeElement.className} ${document.activeElement.textContent.trim().slice(0, 40)}`);

	test('keyboard: an undo row expiring hands focus to the next line, never <body>', async ({ page }) => {
		await openBag(page, { cornflakes: 1, muesli: 1, 'rolled-oats': 1 }, 'nofx');
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-wf-undo="muesli"] button')).toBeFocused();
		await expect(page.locator('[data-wf-undo]')).toHaveCount(0, { timeout: 8000 }); // the 6 s window is the contract
		await expect(page.locator('[data-wf-row="rolled-oats"] .wf-cart-name'), await focusedDesc(page)).toBeFocused();
	});

	test('with motion, keyboard: removing the last line keeps focus on Undo; on expiry it goes to the empty-bag heading', async ({ page }) => {
		await openBag(page, { muesli: 1 });
		await page.waitForTimeout(900); // entrance stagger done
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.wf-cart-empty [data-wf-undo="muesli"]')).toBeVisible({ timeout: 3000 });
		await page.waitForTimeout(900); // the empty state's entrance tween has run (it must not hide the focused Undo)
		await expect(page.locator('[data-wf-undo="muesli"] button'), await focusedDesc(page)).toBeFocused();
		await expect(page.locator('[data-wf-undo]')).toHaveCount(0, { timeout: 8000 });
		await expect(page.locator('.wf-cart-empty h2'), await focusedDesc(page)).toBeFocused();
	});

	test('keyboard: "+" at the per-order cap stays focused and adds nothing more', async ({ page }) => {
		await openBag(page, { muesli: 9 }, 'nofx');
		const plus = page.locator('[data-wf-row="muesli"] [data-wf-qty-plus]');
		await plus.focus();
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('10');
		await expect(plus).toHaveAttribute('aria-disabled', 'true');
		await expect(plus).toBeFocused();
		expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wefeasto_cart')))).toEqual({ muesli: 10 });
	});

	test('another tab adding the item back turns the undo row back into the row', async ({ page, context }) => {
		await openBag(page, { cornflakes: 1, muesli: 2 }, 'nofx');
		await page.locator('[data-wf-row="muesli"] .wf-cart-remove').click();
		await expect(page.locator('[data-wf-undo="muesli"]')).toBeVisible();
		const other = await context.newPage();
		waitForHydrationOnGoto(other);
		await other.route('**/api/**', (r) => r.fulfill({ status: 404, body: '{}' }));
		await other.goto('/shop?nofx=1');
		await other.evaluate(() => window.WefeastoCart.add('muesli', 1));
		await expect(page.locator('[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('1');
		await expect(page.locator('[data-wf-undo]')).toHaveCount(0);
	});
});

test.describe('bag behaviour', () => {
	test.beforeEach(async ({ page }) => setup(page));

	test('another tab’s changes show up live (storage event)', async ({ page, context }) => {
		await openBag(page, { cornflakes: 1 }, 'nofx');
		const other = await context.newPage();
		waitForHydrationOnGoto(other);
		await other.route('**/api/**', (r) => r.fulfill({ status: 404, body: '{}' }));
		await other.goto('/products/muesli?nofx=1');
		await other.locator('[data-wf-add="muesli"]').first().click();
		await expect(page.locator('[data-wf-row="muesli"]')).toBeVisible();
		await expect(subtotal(page)).toHaveText('₹425');
		await expect(badge(page)).toHaveText('2');
		await other.evaluate(() => window.WefeastoCart.remove('cornflakes'));
		await expect(page.locator('[data-wf-row="cornflakes"]')).toHaveCount(0);
		await expect(page.locator('[data-wf-undo]')).toHaveCount(0); // removed elsewhere: no undo here
		await expect(subtotal(page)).toHaveText('₹250');
	});

	test('garbage in the stored cart is ignored everywhere', async ({ page }) => {
		await openBag(page, { cornflakes: '2', ghost: 5, muesli: 'abc', 'rolled-oats': -3, 'health-mix': '1e9', 'choco-flakes': 15 }, 'nofx');
		await expect(page.locator('.wf-cart-rows > [data-wf-row]')).toHaveCount(2);
		await expect(page.locator('[data-wf-row="choco-flakes"] .wf-qty-input')).toHaveValue('10');
		await expect(badge(page)).toHaveText('12');
		await expect(subtotal(page)).toHaveText('₹2,350');
	});

	test('+ stops at maxPerOrder (10)', async ({ page }) => {
		await openBag(page, { muesli: 9 }, 'nofx');
		const plus = page.locator('[data-wf-row="muesli"] [data-wf-qty-plus]');
		await plus.click();
		await expect(page.locator('[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('10');
		await expect(plus).toBeDisabled();
		await page.locator('[data-wf-row="muesli"] .wf-qty-input').fill('50');
		await page.locator('[data-wf-row="muesli"] .wf-qty-input').press('Tab');
		await expect(page.locator('[data-wf-row="muesli"] .wf-qty-input')).toHaveValue('10');
	});

	test('?nofx=1: no meter tweens and the final width is set directly', async ({ page }) => {
		await openBag(page, { muesli: 1, cornflakes: 1 }, 'nofx');
		await expect(meter(page)).toHaveAttribute('aria-valuenow', '85');
		expect(await page.evaluate(() => window.gsap.getTweensOf('.wf-meter-fill').length)).toBe(0);
		expect(await page.locator('[data-wf-meter-fill]').evaluate((el) => el.style.width)).toBe('85%');
		await summary(page).locator('.wf-topup-add').click();
		await expect(meter(page)).toHaveAttribute('aria-valuenow', '100');
		expect(await page.evaluate(() => window.gsap.getTweensOf('.wf-meter-fill').length)).toBe(0);
		expect(await page.locator('[data-wf-meter-fill]').evaluate((el) => el.style.width)).toBe('100%');
	});

	test('with motion the meter tweens (back.out) to its width', async ({ page }) => {
		await openBag(page, { muesli: 1, cornflakes: 1 });
		await summary(page).locator('.wf-topup-add').click();
		expect(await page.evaluate(() => window.gsap.getTweensOf('.wf-meter-fill').length)).toBeGreaterThan(0);
		await expect.poll(() => page.locator('[data-wf-meter-fill]').evaluate((el) => el.style.width)).toBe('100%');
	});

	test('reduced motion: no meter tweens either', async ({ browser }) => {
		const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
		const page = await ctx.newPage();
		await setup(page);
		await openBag(page, { muesli: 1, cornflakes: 1 });
		await expect(meter(page)).toHaveAttribute('aria-valuenow', '85');
		expect(await page.evaluate(() => window.gsap.getTweensOf('.wf-meter-fill').length)).toBe(0);
		expect(await page.locator('[data-wf-meter-fill]').evaluate((el) => el.style.width)).toBe('85%');
		await ctx.close();
	});

	test('colour mix on: the meter fill is remapped away from #ffc33a', async ({ page }) => {
		await page.goto('/shop?nofx=1');
		await page.evaluate(() => {
			localStorage.setItem('wefeasto_colormix', JSON.stringify({ v: 1, map: { '#ffc33a': '#2cdb69', '#2cdb69': '#ffc33a' } }));
			localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 1 }));
		});
		await page.goto('/cart?nofx=1');
		await expect(meter(page)).toBeVisible();
		await expect(page.locator('.wf-colormix')).toHaveCount(0); // pill hidden on /cart, mix still applied
		await expect.poll(() => page.locator('[data-wf-meter-fill]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(44, 219, 105)');
	});

	test('meter fill is the palette yellow without the mix', async ({ page }) => {
		await openBag(page, { muesli: 1 }, 'nofx');
		expect(await page.locator('[data-wf-meter-fill]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 195, 58)');
	});

	test('empty bag: no summary, no meter', async ({ page }) => {
		await page.goto('/cart?nofx=1');
		await expect(page.locator('.wf-cart-empty h2')).toHaveText('Your bag is empty');
		await expect(page.locator('[role="progressbar"], #wf-cart-summary')).toHaveCount(0);
	});

	test('no JS: the prerendered bag carries the noscript note and no client-only UI', async ({ request }) => {
		// (Chromium's JS-off emulation doesn't render <noscript>, so check the HTML itself.)
		const html = await (await request.get('/cart')).text();
		expect(html).toContain('<noscript><p class="p-large">Your bag needs JavaScript to display. Meanwhile, head back to the <a href="/shop">shop</a>.</p></noscript>');
		for (const cls of ['wf-toast', 'wf-summary', 'wf-meter', 'wf-usual', 'wf-cart-undo']) expect(html).not.toContain(cls);
	});
});

test.describe('bag on a 360px phone', () => {
	test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
	test.beforeEach(async ({ page }) => setup(page));

	test('filled bag with top-up, offer chip and undo: no horizontal overflow', async ({ page }) => {
		await page.goto('/shop?nofx=1');
		await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 1, cornflakes: 1, 'steel-cut-oats': 1 })));
		await page.goto('/cart?nofx=1&offer=welcome10');
		await expect(summary(page).locator('[data-wf-offer]')).toBeVisible();
		await page.locator('[data-wf-row="steel-cut-oats"] .wf-cart-remove').tap();
		await expect(page.locator('[data-wf-undo]')).toBeVisible();
		// the phone grid for .wf-cart-row never reaches the undo row: one flex line
		expect(await bagCounts(page)).toEqual({ lines: 2, rows: 2, undos: 1, undoIsLine: false });
		const look = await page.locator('[data-wf-undo]').evaluate((el) => {
			const r = el.getBoundingClientRect();
			const b = el.querySelector('button').getBoundingClientRect();
			return { display: getComputedStyle(el).display, inside: b.right <= r.right + 0.5 && b.top >= r.top && b.bottom <= r.bottom + 0.5 };
		});
		expect(look).toEqual({ display: 'flex', inside: true });
		await expectNoHorizontalOverflow(page);
	});
});
