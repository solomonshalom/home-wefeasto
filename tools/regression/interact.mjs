/*
 * Behavioural regression: the tools/interact.mjs scenarios, run against the
 * baseline and the current build (JS on) and compared observation by
 * observation. Phase 2 changed some flows on purpose (checkout → real order
 * via /api + /order, login, newsletter); those observations are listed in the
 * allow-list ("interact.expected": the value each side must show, with a reason).
 * Every other observation must be equal on both sides.
 *
 * Baseline: the webflow.com newsletter POST is stubbed (200).
 * Current: /api is stubbed by stub-api.mjs (checkout COD order, order status,
 * newsletter); everything else under /api is 404 = "no CMS" (snapshot data).
 */
import { installApiStub } from './stub-api.mjs';

const scaleOf = (t) => {
	if (!t || t === 'none') return 1;
	const m = t.match(/matrix\(([-\d.e]+),/);
	return m ? Math.round(parseFloat(m[1]) * 100) / 100 : NaN;
};

/** Console noise that is not a regression: /api 404s from the "no CMS" static server. */
const isApiNoise = (m) => /\/api\//.test(m.location()?.url || '') || /status of 404/.test(m.text()) && /\/api\//.test(m.location()?.url || '');

async function sharedSteps(browser, { base, side, products }) {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error' && !isApiNoise(m)) errors.push('console: ' + m.text() + (m.location()?.url ? ` @ ${m.location().url}` : ''));
	});
	let stub = { calls: [] };
	if (side === 'baseline') {
		await page.route(/webflow\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200 }) }));
	} else {
		stub = await installApiStub(page, { products });
	}
	const obs = {};
	const step = async (name, fn) => {
		try {
			await fn();
		} catch (e) {
			obs['ERROR:' + name] = e.message.split('\n')[0];
		}
	};
	const goto = async (p) => {
		await page.goto(base + p, { waitUntil: 'load', timeout: 30000 });
		await page.waitForTimeout(1200); // veil fade + hero
	};
	const text = async (sel) => ((await page.locator(sel).first().textContent({ timeout: 5000 })) || '').trim();

	/* -- 1. home load: veil cleared, hero visible ------------------------- */
	await step('home', async () => {
		await goto('/');
		obs.veilGone = await page.evaluate(() => {
			const v = document.getElementById('wf-veil');
			if (!v) return 'no-veil';
			const s = getComputedStyle(v);
			return s.display === 'none' || s.opacity === '0' ? 'cleared' : 'STUCK(' + s.opacity + ')';
		});
		obs.heroVisible = await page.evaluate(() => getComputedStyle(document.querySelector('h1.heading-2')).opacity);
	});

	/* -- 2. card hover machinery ------------------------------------------ */
	await step('hover', async () => {
		const id = '6c7bdfcd-c4ed-9b13-3c4b-58161e5af918';
		const card = page.locator(`[data-w-id="${id}"]`).first();
		await card.scrollIntoViewIfNeeded();
		await page.waitForTimeout(1400);
		obs.gridFadedIn = await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.querySelector('#bestsellers .grid-6')).opacity) * 100) / 100);
		await card.hover();
		await page.waitForTimeout(900);
		const tf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).transform, sel);
		obs.hoverDisc = scaleOf(await tf(`[data-w-id="${id}"] .div-block-95`));
		obs.hoverPill = scaleOf(await tf(`[data-w-id="${id}"] .link-block-5`));
		await page.mouse.move(10, 10);
		await page.waitForTimeout(700);
		obs.hoverDiscOut = scaleOf(await tf(`[data-w-id="${id}"] .div-block-95`));
	});

	/* -- 3. same-page anchor smooth scroll -------------------------------- */
	await step('anchor', async () => {
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.waitForTimeout(300);
		await page.click('a[href="#about"]');
		await page.waitForTimeout(1600);
		obs.anchorScrolled = (await page.evaluate(() => window.scrollY)) > 300;
	});

	/* -- 4. search overlay ------------------------------------------------- */
	await step('search', async () => {
		await page.click('.wf-search-open');
		await page.waitForTimeout(900);
		obs.searchOpen = await page.evaluate(() => !document.getElementById('wf-search-overlay').hidden);
		obs.searchAllCount = await page.locator('.wf-search-card').count();
		await page.fill('.wf-search-input', 'oats');
		await page.waitForTimeout(600);
		obs.searchOatsCount = await page.locator('.wf-search-card').count();
		obs.searchFirst = await text('.wf-search-card-name');
		await page.keyboard.press('Escape');
		await page.waitForTimeout(600);
		obs.searchClosed = await page.evaluate(() => document.getElementById('wf-search-overlay').hidden);
	});

	/* -- 5. shop: filters + live search ------------------------------------ */
	const visibleItems = (sel) =>
		page.evaluate((s) => Array.prototype.filter.call(document.querySelectorAll(s), (el) => el.style.display !== 'none').length, sel);
	await step('shop', async () => {
		await goto('/shop');
		await page.click('button[data-wf-filter="Oats"]');
		await page.waitForTimeout(800);
		obs.shopOats = await visibleItems('.wf-shop-item');
		obs.shopOatsChipActive = await page.evaluate(() => document.querySelector('button[data-wf-filter="Oats"]').classList.contains('wf-active'));
		await page.click('button[data-wf-filter="all"]');
		await page.waitForTimeout(400);
		await page.fill('#wf-shop-search', 'choco');
		await page.waitForTimeout(800);
		obs.shopChoco = await visibleItems('.wf-shop-item');
		await page.fill('#wf-shop-search', 'zzz');
		await page.waitForTimeout(800);
		obs.shopEmptyNote = await page.evaluate(() => !document.getElementById('wf-shop-empty').hidden);
		await page.fill('#wf-shop-search', '');
		await page.waitForTimeout(800);
		obs.shopAll = await visibleItems('.wf-shop-item');
	});

	/* -- 6. add to cart + badge -------------------------------------------- */
	await step('add', async () => {
		await page.evaluate(() => localStorage.removeItem('wefeasto_cart'));
		await page.reload({ waitUntil: 'load' });
		await page.waitForTimeout(1200);
		const addBtn = page.locator('[data-wf-add="cornflakes"]').first();
		await addBtn.scrollIntoViewIfNeeded();
		await page.waitForTimeout(600);
		await addBtn.click();
		await page.waitForTimeout(150);
		obs.addedLabel = ((await addBtn.locator('div').textContent()) || '').trim();
		obs.badgeAfterAdd = await text('.wf-cart-count');
		await page.waitForTimeout(1600);
		obs.labelRestored = ((await addBtn.locator('div').textContent()) || '').trim();
		await addBtn.click();
		await page.waitForTimeout(200);
		obs.badgeAfterTwo = await text('.wf-cart-count');
		obs.storage = await page.evaluate(() => localStorage.getItem('wefeasto_cart'));
	});

	/* -- 7. PDP: qty stepper, qty-aware add, partners dropdown -------------- */
	await step('pdp', async () => {
		await goto('/products/muesli');
		await page.click('[data-wf-qty-plus]');
		await page.click('[data-wf-qty-plus]');
		obs.qtyAfterPlus = await page.inputValue('.wf-qty-input');
		await page.click('[data-wf-add="muesli"]');
		await page.waitForTimeout(300);
		obs.badgeAfterQtyAdd = await text('.wf-cart-count');
		await page.click('.wf-partners-trigger');
		await page.waitForTimeout(200);
		obs.partnersOpen = await page.evaluate(() => document.querySelector('.wf-partners').classList.contains('wf-open'));
		obs.partnersRows = await page.locator('.wf-partner-row').count();
		await page.mouse.click(20, 400);
		await page.waitForTimeout(300);
		obs.partnersClosed = await page.evaluate(() => !document.querySelector('.wf-partners').classList.contains('wf-open'));
	});

	/* -- 8. cart page -------------------------------------------------------- */
	await step('cart', async () => {
		await goto('/cart');
		await page.waitForTimeout(800);
		obs.cartRows = await page.locator('.wf-cart-row').count();
		obs.cartSubtotal = await text('[data-wf-subtotal]');
		obs.cartNote = await text('[data-wf-note]');
		await page.click('[data-wf-row="cornflakes"] [data-wf-qty-plus]');
		await page.waitForTimeout(400);
		obs.cartLineAfterPlus = await text('[data-wf-row="cornflakes"] [data-wf-line]');
		obs.cartSubtotalAfterPlus = await text('[data-wf-subtotal]');
		obs.badgeCartPlus = await text('.wf-cart-count');
		await page.click('[data-wf-row="muesli"] .wf-cart-remove');
		await page.waitForTimeout(900);
		obs.cartRowsAfterRemove = await page.locator('.wf-cart-row').count();
		obs.cartSubtotalAfterRemove = await text('[data-wf-subtotal]');
		await page.click('[data-wf-row="cornflakes"] .wf-cart-remove');
		await page.waitForTimeout(1100);
		obs.cartEmpty = await page.locator('.wf-cart-empty').count();
		obs.badgeEmpty = await text('.wf-cart-count');
	});

	return { page, ctx, obs, errors, stub, step, goto, text, side, base };
}

/* -- 9. checkout ------------------------------------------------------------
 * baseline: the prototype form (UPI/card inputs, fake "Order confirmed" +
 * random #WF-xxxx on the same page).
 * current: M2 form (email, state; no card/UPI inputs), COD → POST
 * /api/store/checkout (stubbed) → /order?no=&t= → status (stubbed) → confirmed.
 * Shared observations keep their meaning on both sides; side-only facts are
 * separate keys, pinned in the allow-list. */
async function checkoutSteps({ page, obs, stub, step, goto, text, side }) {
	await step('checkout', async () => {
		await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ cornflakes: 2, 'health-mix': 1 })));
		await goto('/checkout');
		await page.waitForTimeout(600);
		obs.coSummaryRows = await page.evaluate(() =>
			Array.prototype.map.call(document.querySelectorAll('#wf-co-summary .wf-summary-row'), (el) => el.textContent.replace(/\s+/g, ' ').trim())
		);
		obs.coFakeThanksOnCheckout = await page.evaluate(() => !!document.getElementById('wf-co-thanks'));
		obs.coCardUpiInputs = await page.locator('#wf-co-upi, #wf-co-card-number, #wf-co-card-cvv').count();
		obs.coNewFields = await page.evaluate(() => ['wf-co-email', 'wf-co-state', 'wf-co-consent', 'wf-co-save'].filter((id) => document.getElementById(id)));
		obs.coPayLabel = (await text('#wf-place-order')).replace(/\s+/g, ' ');
		// invalid submit is blocked
		await page.click('#wf-place-order');
		await page.waitForTimeout(700);
		obs.coBlockedInvalid =
			side === 'baseline'
				? await page.evaluate(() => document.getElementById('wf-co-thanks').hidden)
				: stub.calls.filter((c) => c.path === '/store/checkout').length === 0 && new URL(page.url()).pathname === '/checkout';
		obs.coInvalidMarked = side === 'baseline' ? null : await page.locator('#wf-checkout-form [aria-invalid="true"]').count() > 0;
		await page.fill('#wf-co-name', 'Asha Kumar');
		await page.fill('#wf-co-phone', '+91 98452 62777');
		if (side === 'current') await page.fill('#wf-co-email', 'asha.regression@example.com');
		await page.fill('#wf-co-address', '12 MG Road');
		await page.fill('#wf-co-pin', '560001');
		await page.fill('#wf-co-city', 'Bengaluru');
		if (side === 'current') await page.selectOption('#wf-co-state', 'Karnataka');
		await page.click('label.wf-pay-pill:has(input[value="cod"])');
		await page.waitForTimeout(400);
		obs.coUpiPanelHidden = side === 'baseline' ? await page.evaluate(() => document.getElementById('wf-pay-upi').hidden) : null;
		obs.coCodPayLabel = side === 'baseline' ? null : (await text('#wf-place-order')).replace(/\s+/g, ' ');
		await page.click('#wf-place-order');
		if (side === 'current') await page.waitForURL(/\/order\?/, { timeout: 10000 }).catch(() => {});
		await page.waitForTimeout(1800);
		if (side === 'current') await page.locator('[data-wf-order-view="confirmed"]').waitFor({ timeout: 8000 }).catch(() => {});
		obs.coPathAfterPlace = new URL(page.url()).pathname;
		obs.coThanksShown = await page.evaluate(() => {
			const t = document.getElementById('wf-co-thanks');
			return !!t && !t.hidden && getComputedStyle(t).display !== 'none';
		});
		obs.coOrderNo = /WF-\d{4,}/.test(await text('#wf-co-order-no').catch(() => ''));
		obs.coCartCleared = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('wefeasto_cart') || '{}')));
		obs.coFormGone = await page.evaluate(() => {
			const f = document.getElementById('wf-checkout-form');
			return !f || getComputedStyle(f).display === 'none';
		});
		if (side === 'current') {
			const req = stub.calls.find((c) => c.method === 'POST' && c.path === '/store/checkout');
			obs.coRequest = req
				? {
						method: req.body?.method,
						items: req.body?.items,
						phone: req.body?.contact?.phone,
						email: req.body?.contact?.email,
						state: req.body?.address?.state,
						pin: req.body?.address?.pin,
						keyIsUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.key || ''),
						expectedTotalPaise: req.body?.expectedTotalPaise
					}
				: null;
			obs.coOrderView = await page.evaluate(() => document.querySelector('[data-wf-order-view]')?.getAttribute('data-wf-order-view') || null);
			obs.coOrderMethod = await page.evaluate(() => document.querySelector('[data-wf-order-method]')?.getAttribute('data-wf-order-method') || null);
		} else {
			obs.coRequest = null;
			obs.coOrderView = null;
			obs.coOrderMethod = null;
		}
	});
}

async function laterSteps({ page, obs, stub, step, goto, text, side }) {
	/* -- 10. login tabs + notice ---------------------------------------------- */
	await step('login', async () => {
		await goto('/login');
		await page.click('#wf-tab-signup');
		await page.waitForTimeout(1000);
		obs.loginSwap = await page.evaluate(() => document.getElementById('wf-panel-login').hidden && !document.getElementById('wf-panel-signup').hidden);
		obs.loginTabActive = await page.evaluate(() => document.getElementById('wf-tab-signup').classList.contains('wf-is-active'));
		await page.click('#wf-panel-signup button[type="submit"]');
		await page.waitForTimeout(600);
		obs.noticeShown = await page.evaluate(() => !document.getElementById('wf-auth-notice').hidden);
		obs.noticeText = (await text('#wf-auth-notice')).replace(/\s+/g, ' ');
		obs.signupInvalidMarked = side === 'baseline' ? null : (await page.locator('#wf-panel-signup [aria-invalid="true"]').count()) > 0;
		obs.signupRequestSent = side === 'baseline' ? null : stub.calls.some((c) => c.path.startsWith('/customers') && c.method === 'POST');
		await page.waitForTimeout(3400);
		obs.noticeAutoHidden = await page.evaluate(() => document.getElementById('wf-auth-notice').hidden);
		obs.googleButton = await page.locator('a.wf-google').count();
	});

	/* -- 11. recipes filter ----------------------------------------------------- */
	const visible = (sel) => page.evaluate((s) => Array.prototype.filter.call(document.querySelectorAll(s), (el) => el.style.display !== 'none').length, sel);
	await step('recipes', async () => {
		await goto('/recipes');
		await page.click('button[data-wf-filter="Snacks"]');
		await page.waitForTimeout(800);
		obs.recipesSnacks = await visible('.wf-recipe-item');
		await page.click('button[data-wf-filter="All"]');
		await page.waitForTimeout(600);
		obs.recipesAll = await visible('.wf-recipe-item');
	});

	/* -- 12. recipe page: TOC anchor + ingredient product link ------------------ */
	await step('recipe', async () => {
		await goto('/recipes/wf-masala-cornflakes-chivda');
		await page.click('a[href="#Directions"]');
		await page.waitForTimeout(1500);
		obs.recipeTocScroll = (await page.evaluate(() => window.scrollY)) > 300;
		obs.recipeIngredientLink = await page.evaluate(() => {
			const a = document.querySelector('.rich-text-block a');
			if (!a) return null;
			const m = a.getAttribute('href').match(/products\/([a-z-]+)(?:\.html)?$/);
			return m ? 'product:' + m[1] : a.getAttribute('href');
		});
	});

	/* -- 13. legal pages --------------------------------------------------------- */
	await step('legal', async () => {
		await goto('/terms');
		obs.termsH1 = await text('h1');
		obs.termsSections = await page.locator('.wf-legal-section').count();
		await goto('/privacy');
		obs.privacyH1 = await text('h1');
	});

	/* -- 14. newsletter form ----------------------------------------------------- */
	await step('newsletter', async () => {
		await goto('/');
		await page.evaluate(() => document.querySelector('#email').scrollIntoView({ block: 'center' }));
		await page.waitForTimeout(1600);
		await page.fill('#email', 'regression@example.com');
		await page.click('input[type="submit"].w-button');
		await page.waitForTimeout(side === 'baseline' ? 4500 : 2000);
		obs.newsletterResult = await page.evaluate(() => {
			const done = getComputedStyle(document.querySelector('.w-form-done')).display !== 'none';
			const fail = getComputedStyle(document.querySelector('.w-form-fail')).display !== 'none';
			return done ? 'done' : fail ? 'fail' : 'neither';
		});
		const nl = stub.calls.find((c) => c.path === '/store/newsletter');
		obs.newsletterRequest = side === 'baseline' ? null : nl ? { email: nl.body?.email, website: nl.body?.website } : null;
	});

	/* -- 16. "Mix colors" palette toggle (baseline feature, not in the old suite) -- */
	await step('colormix', async () => {
		await goto('/shop');
		const footerBg = () => page.evaluate(() => getComputedStyle(document.querySelector('.footer-section')).backgroundColor);
		const before = await footerBg();
		await page.click('button.wf-colormix');
		await page.waitForTimeout(500);
		const state = () =>
			page.evaluate(() => {
				let stored = null;
				try {
					stored = JSON.parse(localStorage.getItem('wefeasto_colormix') || 'null');
				} catch {}
				const st = document.getElementById('wf-colormix-style');
				return { stored: !!(stored && stored.map), override: !!(st && st.textContent.trim()) };
			});
		obs.mixOn = await page.getAttribute('button.wf-colormix', 'aria-checked');
		obs.mixState = await state();
		await goto('/cart');
		obs.mixPillOnCart = await page.locator('button.wf-colormix').count();
		obs.mixStateOnCart = await state();
		await goto('/shop');
		obs.mixOnAfterNav = await page.getAttribute('button.wf-colormix', 'aria-checked');
		await page.click('button.wf-colormix');
		await page.waitForTimeout(500);
		obs.mixOff = await page.getAttribute('button.wf-colormix', 'aria-checked');
		obs.mixStateOff = await state();
		obs.mixRestored = (await footerBg()) === before;
	});

	/* -- 15. cart persistence across reload -------------------------------------- */
	await step('persist', async () => {
		await page.evaluate(() => localStorage.setItem('wefeasto_cart', JSON.stringify({ muesli: 2 })));
		await page.reload({ waitUntil: 'load' });
		await page.waitForTimeout(1200);
		obs.badgePersisted = await text('.wf-cart-count');
	});
}

async function runSide(browser, opts) {
	const env = await sharedSteps(browser, opts);
	try {
		await checkoutSteps(env);
		await laterSteps(env);
	} finally {
		await env.ctx.close();
	}
	return { obs: env.obs, errors: env.errors };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {{browser: any, baseUrl: string, curUrl: string, products: Map<string, any>, allow: any}} o
 */
export async function runInteract({ browser, baseUrl, curUrl, products, allow }) {
	const expected = (allow.interact && allow.interact.expected) || {};
	const [a, b] = await Promise.all([
		runSide(browser, { base: baseUrl, side: 'baseline', products }),
		runSide(browser, { base: curUrl, side: 'current', products })
	]);
	const keys = [...new Set([...Object.keys(a.obs), ...Object.keys(b.obs), ...Object.keys(expected)])];
	const rows = [];
	for (const k of keys) {
		const va = a.obs[k];
		const vb = b.obs[k];
		const e = expected[k];
		let ok;
		let why = '';
		if (k.startsWith('ERROR:')) {
			ok = false;
			why = 'scenario step threw';
		} else if (e) {
			const okA = !('baseline' in e) || same(va, e.baseline);
			const okB = !('current' in e) || same(vb, e.current);
			ok = okA && okB;
			why = ok ? `allow-listed: ${e.reason}` : `expected ${!okA ? `baseline=${JSON.stringify(e.baseline)} ` : ''}${!okB ? `current=${JSON.stringify(e.current)}` : ''}`.trim();
		} else {
			ok = same(va, vb);
		}
		rows.push({ key: k, ok, baseline: va, current: vb, note: why });
	}
	const ignore = (allow.interact && allow.interact.ignoreErrors) || [];
	const newErrors = b.errors.filter((e) => !a.errors.includes(e) && !ignore.some((re) => new RegExp(re.pattern).test(e)));
	return { ok: rows.every((r) => r.ok) && newErrors.length === 0, rows, errors: { baseline: a.errors, current: b.errors, newInCurrent: newErrors } };
}
