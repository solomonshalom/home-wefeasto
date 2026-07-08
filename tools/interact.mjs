/*
 * Behavioral 1:1 check — runs the same interaction scenarios against the
 * original site (:8000) and the Svelte port (:4173) and compares outcomes.
 *   node interact.mjs
 */
import { chromium } from 'playwright';

const ORIG = { name: 'orig', base: 'http://localhost:8000', toUrl: (p) => (p === '/' ? '/index.html' : p + '.html') };
const PORT = { name: 'port', base: 'http://localhost:4173', toUrl: (p) => p };

const scaleOf = (t) => {
	// computed transform matrix(a, b, c, d, e, f) → a (scaleX); 'none' → 1
	if (!t || t === 'none') return 1;
	const m = t.match(/matrix\(([-\d.e]+),/);
	return m ? Math.round(parseFloat(m[1]) * 100) / 100 : NaN;
};

async function run(site) {
	const browser = await chromium.launch();
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	const obs = {};
	const goto = async (p) => {
		await page.goto(site.base + site.toUrl(p), { waitUntil: 'load', timeout: 30000 });
		await page.waitForTimeout(1200); // veil fade + hero
	};

	/* -- 1. home load: veil cleared, hero visible ------------------------- */
	await goto('/');
	obs.veilGone = await page.evaluate(() => {
		const v = document.getElementById('wf-veil');
		if (!v) return 'no-veil';
		const s = getComputedStyle(v);
		return s.display === 'none' || s.opacity === '0' ? 'cleared' : 'STUCK(' + s.opacity + ')';
	});
	obs.heroVisible = await page.evaluate(() => getComputedStyle(document.querySelector('h1.heading-2')).opacity);

	/* -- 2. card hover machinery ------------------------------------------ */
	const card = page.locator('[data-w-id="6c7bdfcd-c4ed-9b13-3c4b-58161e5af918"]').first();
	await card.scrollIntoViewIfNeeded();
	await page.waitForTimeout(1400); // grid fade-in
	obs.gridFadedIn = await page.evaluate(() => {
		const g = document.querySelector('#bestsellers .grid-6');
		return Math.round(parseFloat(getComputedStyle(g).opacity) * 100) / 100;
	});
	await card.hover();
	await page.waitForTimeout(900);
	obs.hoverDisc = scaleOf(await page.evaluate(() => getComputedStyle(document.querySelector('[data-w-id="6c7bdfcd-c4ed-9b13-3c4b-58161e5af918"] .div-block-95')).transform));
	obs.hoverPill = scaleOf(await page.evaluate(() => getComputedStyle(document.querySelector('[data-w-id="6c7bdfcd-c4ed-9b13-3c4b-58161e5af918"] .link-block-5')).transform));
	await page.mouse.move(10, 10);
	await page.waitForTimeout(700);
	obs.hoverDiscOut = scaleOf(await page.evaluate(() => getComputedStyle(document.querySelector('[data-w-id="6c7bdfcd-c4ed-9b13-3c4b-58161e5af918"] .div-block-95')).transform));

	/* -- 3. same-page anchor smooth scroll -------------------------------- */
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForTimeout(300);
	await page.click('a[href="#about"]');
	await page.waitForTimeout(1600);
	obs.anchorScrolled = (await page.evaluate(() => window.scrollY)) > 300;

	/* -- 4. search overlay ------------------------------------------------- */
	await page.click('.wf-search-open');
	await page.waitForTimeout(900);
	obs.searchOpen = await page.evaluate(() => !document.getElementById('wf-search-overlay').hidden);
	obs.searchAllCount = await page.locator('.wf-search-card').count(); // empty query = browse all (18)
	await page.fill('.wf-search-input', 'oats');
	await page.waitForTimeout(600);
	obs.searchOatsCount = await page.locator('.wf-search-card').count();
	obs.searchFirst = (await page.locator('.wf-search-card-name').first().textContent()).trim();
	await page.keyboard.press('Escape');
	await page.waitForTimeout(600);
	obs.searchClosed = await page.evaluate(() => document.getElementById('wf-search-overlay').hidden);

	/* -- 5. shop: filters + live search ------------------------------------ */
	await goto('/shop');
	const visibleItems = () =>
		page.evaluate(
			() =>
				Array.prototype.filter.call(
					document.querySelectorAll('.wf-shop-item'),
					(el) => el.style.display !== 'none'
				).length
		);
	await page.click('button[data-wf-filter="Oats"]');
	await page.waitForTimeout(800);
	obs.shopOats = await visibleItems();
	obs.shopOatsChipActive = await page.evaluate(() => document.querySelector('button[data-wf-filter="Oats"]').classList.contains('wf-active'));
	await page.click('button[data-wf-filter="all"]');
	await page.waitForTimeout(400);
	await page.fill('#wf-shop-search', 'choco');
	await page.waitForTimeout(800);
	obs.shopChoco = await visibleItems();
	await page.fill('#wf-shop-search', 'zzz');
	await page.waitForTimeout(800);
	obs.shopEmptyNote = await page.evaluate(() => !document.getElementById('wf-shop-empty').hidden);
	await page.fill('#wf-shop-search', '');
	await page.waitForTimeout(800);
	obs.shopAll = await visibleItems();

	/* -- 6. add to cart + badge -------------------------------------------- */
	await page.evaluate(() => localStorage.removeItem('wefeasto_cart'));
	await page.reload({ waitUntil: 'load' });
	await page.waitForTimeout(1200);
	const addBtn = page.locator('[data-wf-add="cornflakes"]').first();
	await addBtn.scrollIntoViewIfNeeded();
	await page.waitForTimeout(600);
	await addBtn.click();
	await page.waitForTimeout(150);
	obs.addedLabel = (await addBtn.locator('div').textContent()).trim();
	obs.badgeAfterAdd = (await page.locator('.wf-cart-count').first().textContent()).trim();
	await page.waitForTimeout(1600);
	obs.labelRestored = (await addBtn.locator('div').textContent()).trim();
	await addBtn.click();
	await page.waitForTimeout(200);
	obs.badgeAfterTwo = (await page.locator('.wf-cart-count').first().textContent()).trim();
	obs.storage = await page.evaluate(() => localStorage.getItem('wefeasto_cart'));

	/* -- 7. PDP: qty stepper, qty-aware add, partners dropdown -------------- */
	await goto('/products/muesli');
	await page.click('[data-wf-qty-plus]');
	await page.click('[data-wf-qty-plus]');
	obs.qtyAfterPlus = await page.inputValue('.wf-qty-input');
	await page.click('[data-wf-add="muesli"]');
	await page.waitForTimeout(300);
	obs.badgeAfterQtyAdd = (await page.locator('.wf-cart-count').first().textContent()).trim(); // 2 + 3
	await page.click('.wf-partners-trigger');
	await page.waitForTimeout(200);
	obs.partnersOpen = await page.evaluate(() => document.querySelector('.wf-partners').classList.contains('wf-open'));
	obs.partnersRows = await page.locator('.wf-partner-row').count();
	await page.mouse.click(20, 400);
	await page.waitForTimeout(300);
	obs.partnersClosed = await page.evaluate(() => !document.querySelector('.wf-partners').classList.contains('wf-open'));

	/* -- 8. cart page -------------------------------------------------------- */
	await goto('/cart');
	await page.waitForTimeout(800);
	obs.cartRows = await page.locator('.wf-cart-row').count();
	obs.cartSubtotal = (await page.locator('[data-wf-subtotal]').textContent()).trim(); // 2×175 + 3×250 = 1100
	obs.cartNote = (await page.locator('[data-wf-note]').textContent()).trim();
	// qty bump on cornflakes row → 3×175 + 3×250 = 1275
	await page.click('[data-wf-row="cornflakes"] [data-wf-qty-plus]');
	await page.waitForTimeout(400);
	obs.cartLineAfterPlus = (await page.locator('[data-wf-row="cornflakes"] [data-wf-line]').textContent()).trim();
	obs.cartSubtotalAfterPlus = (await page.locator('[data-wf-subtotal]').textContent()).trim();
	obs.badgeCartPlus = (await page.locator('.wf-cart-count').first().textContent()).trim();
	// remove muesli row
	await page.click('[data-wf-row="muesli"] .wf-cart-remove');
	await page.waitForTimeout(900);
	obs.cartRowsAfterRemove = await page.locator('.wf-cart-row').count();
	obs.cartSubtotalAfterRemove = (await page.locator('[data-wf-subtotal]').textContent()).trim();
	// remove last → empty state
	await page.click('[data-wf-row="cornflakes"] .wf-cart-remove');
	await page.waitForTimeout(1100);
	obs.cartEmpty = await page.locator('.wf-cart-empty').count();
	obs.badgeEmpty = (await page.locator('.wf-cart-count').first().textContent()).trim();

	/* -- 9. checkout flow ----------------------------------------------------- */
	await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ cornflakes: 2, 'health-mix': 1 })));
	await goto('/checkout');
	await page.waitForTimeout(600);
	obs.coSummaryRows = await page.evaluate(() =>
		Array.prototype.map.call(document.querySelectorAll('#wf-co-summary .wf-summary-row'), (el) => el.textContent.trim())
	);
	// invalid submit blocked
	await page.click('#wf-place-order');
	await page.waitForTimeout(500);
	obs.coBlockedInvalid = await page.evaluate(() => document.getElementById('wf-co-thanks').hidden);
	await page.fill('#wf-co-name', 'Asha Kumar');
	await page.fill('#wf-co-phone', '+91 98452 62777');
	await page.fill('#wf-co-address', '12 MG Road');
	await page.fill('#wf-co-city', 'Bengaluru');
	await page.fill('#wf-co-pin', '560001');
	await page.click('label.wf-pay-pill:has(input[value="cod"])');
	await page.waitForTimeout(200);
	obs.coUpiPanelHidden = await page.evaluate(() => document.getElementById('wf-pay-upi').hidden);
	await page.click('#wf-place-order');
	await page.waitForTimeout(1800);
	obs.coThanksShown = await page.evaluate(() => !document.getElementById('wf-co-thanks').hidden);
	obs.coOrderNo = /Order #WF-\d{4}/.test((await page.locator('#wf-co-order-no').textContent()).trim());
	obs.coCartCleared = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('wefeasto_cart') || '{}')));
	obs.coFormGone = await page.evaluate(() => getComputedStyle(document.getElementById('wf-checkout-form')).display === 'none');

	/* -- 10. login tabs + notice ---------------------------------------------- */
	await goto('/login');
	await page.click('#wf-tab-signup');
	await page.waitForTimeout(1000);
	obs.loginSwap = await page.evaluate(
		() => document.getElementById('wf-panel-login').hidden && !document.getElementById('wf-panel-signup').hidden
	);
	obs.loginTabActive = await page.evaluate(() => document.getElementById('wf-tab-signup').classList.contains('wf-is-active'));
	await page.click('#wf-panel-signup button[type="submit"]');
	await page.waitForTimeout(600);
	obs.noticeShown = await page.evaluate(() => !document.getElementById('wf-auth-notice').hidden);
	await page.waitForTimeout(3400);
	obs.noticeAutoHidden = await page.evaluate(() => document.getElementById('wf-auth-notice').hidden);

	/* -- 11. recipes filter ----------------------------------------------------- */
	await goto('/recipes');
	await page.click('button[data-wf-filter="Snacks"]');
	await page.waitForTimeout(800);
	obs.recipesSnacks = await page.evaluate(
		() => Array.prototype.filter.call(document.querySelectorAll('.wf-recipe-item'), (el) => el.style.display !== 'none').length
	);
	await page.click('button[data-wf-filter="All"]');
	await page.waitForTimeout(600);
	obs.recipesAll = await page.evaluate(
		() => Array.prototype.filter.call(document.querySelectorAll('.wf-recipe-item'), (el) => el.style.display !== 'none').length
	);

	/* -- 12. recipe page: TOC anchor + ingredient product link ------------------ */
	await goto('/recipes/wf-masala-cornflakes-chivda');
	await page.click('a[href="#Directions"]');
	await page.waitForTimeout(1500);
	obs.recipeTocScroll = (await page.evaluate(() => window.scrollY)) > 300;
	obs.recipeIngredientLink = await page.evaluate(() => {
		const a = document.querySelector('.rich-text-block a');
		if (!a) return null;
		// normalize URL space: ../products/x.html (orig) ≡ /products/x (port)
		const m = a.getAttribute('href').match(/products\/([a-z-]+)(?:\.html)?$/);
		return m ? 'product:' + m[1] : a.getAttribute('href');
	});

	/* -- 13. legal pages --------------------------------------------------------- */
	await goto('/terms');
	obs.termsH1 = (await page.locator('h1').first().textContent()).trim();
	obs.termsSections = await page.locator('.wf-legal-section').count();
	await goto('/privacy');
	obs.privacyH1 = (await page.locator('h1').first().textContent()).trim();

	/* -- 14. newsletter form (same live endpoint both sides) --------------------- */
	await goto('/');
	await page.evaluate(() => document.querySelector('#email').scrollIntoView({ block: 'center' }));
	await page.waitForTimeout(1600);
	await page.fill('#email', 'test@example.com');
	await page.click('input[type="submit"].w-button');
	await page.waitForTimeout(4500);
	obs.newsletterResult = await page.evaluate(() => {
		const done = getComputedStyle(document.querySelector('.w-form-done')).display !== 'none';
		const fail = getComputedStyle(document.querySelector('.w-form-fail')).display !== 'none';
		return done ? 'done' : fail ? 'fail' : 'neither';
	});

	/* -- 15. cart persistence across reload -------------------------------------- */
	await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 2 })));
	await page.reload({ waitUntil: 'load' });
	await page.waitForTimeout(1200);
	obs.badgePersisted = (await page.locator('.wf-cart-count').first().textContent()).trim();

	obs.consoleErrors = errors;
	await browser.close();
	return obs;
}

const [a, b] = [await run(ORIG), await run(PORT)];
const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
let mismatches = 0;
for (const k of keys) {
	if (k === 'consoleErrors') continue;
	const va = JSON.stringify(a[k]);
	const vb = JSON.stringify(b[k]);
	const same = va === vb;
	if (!same) mismatches++;
	console.log(`${same ? 'OK  ' : 'DIFF'}  ${k.padEnd(24)} orig=${va}  port=${vb}`);
}
console.log('\nconsole errors — orig:', a.consoleErrors.length ? a.consoleErrors : 'none');
console.log('console errors — port:', b.consoleErrors.length ? b.consoleErrors : 'none');
console.log(mismatches === 0 ? '\nALL BEHAVIOR MATCHES ✓' : `\n${mismatches} behavioral differences`);
