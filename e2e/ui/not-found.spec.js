/*
 * S9 branded 404: +error.svelte under `vite preview` and client-side, and
 * build/404.html (the prerendered /404 route, root-absolute) on a static host.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test, blockStorage, collectErrors } from './helpers.js';
import { rootAbsolute } from '../../svelte.config.js';

const heading = (page) => page.getByRole('heading', { level: 1, name: 'This page wandered off.' });

/**
 * The layout has mounted (the nav badge gets its wf-is-hidden class or its
 * count only then). A click before that hits server-rendered markup: the
 * Search button does nothing and a link makes a full page load.
 */
const hydrated = (page) =>
	page.waitForFunction(() => {
		const b = document.querySelector('.div-block-79 .wf-cart-count');
		return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
	});

/** The directory holding playwright.config.js (relative build dirs resolve against it, not the shell's cwd). */
const CONFIG_DIR = fileURLToPath(new URL('../..', import.meta.url));

let servedBuildDir = null;
/**
 * The build directory of the build the preview at `baseURL` is serving:
 * PW_BUILD_DIR when set, else build/ next to playwright.config.js, and only
 * if its _app/version.json matches the served one. With reuseExistingServer
 * the preview can belong to another checkout or an older build; reading some
 * other build/404.html would then test (or serve) the wrong files, so a
 * mismatch fails loudly instead.
 */
async function servedBuild(baseURL) {
	if (servedBuildDir) return servedBuildDir;
	const res = await fetch(new URL('/_app/version.json', baseURL));
	const served = res.ok ? (await res.text()).trim() : `(HTTP ${res.status})`;
	const candidates = [...new Set([process.env.PW_BUILD_DIR, 'build'].filter(Boolean).map((dir) => path.resolve(CONFIG_DIR, dir)))];
	for (const dir of candidates) {
		let local = null;
		try {
			local = fs.readFileSync(path.join(dir, '_app', 'version.json'), 'utf8').trim();
		} catch {
			/* not a build */
		}
		if (local === served) return (servedBuildDir = dir);
	}
	throw new Error(`${baseURL} serves app version ${served}, but no candidate build dir holds it (${candidates.join(', ')}): set PW_BUILD_DIR to the build the preview serves`);
}

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.txt': 'text/plain',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm'
};

/**
 * build/ served the way Vercel serves it (vercel.json cleanUrls): the file,
 * or <path>.html, or <path>/index.html; anything else gets 404.html with a
 * 404 status, at whatever depth it was asked for.
 */
function staticHost(root) {
	const send = (res, status, file) => {
		res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
		fs.createReadStream(file).pipe(res);
	};
	return http.createServer((req, res) => {
		let rel;
		try {
			rel = decodeURIComponent(new URL(req.url, 'http://host').pathname).replace(/\/+$/, '') || '/index';
		} catch {
			rel = '/';
		}
		for (const candidate of [rel, rel + '.html', rel + '/index.html']) {
			const file = path.join(root, candidate);
			if (!file.startsWith(root + path.sep)) break;
			if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, 200, file);
		}
		send(res, 404, path.join(root, '404.html'));
	});
}

/** Listen on a random free port in 4200-4999. */
async function listen(server) {
	for (let i = 0; i < 40; i++) {
		const port = 4200 + Math.floor(Math.random() * 800);
		try {
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, '127.0.0.1', () => {
					server.off('error', reject);
					resolve();
				});
			});
			return port;
		} catch (e) {
			if (e.code !== 'EADDRINUSE') throw e;
		}
	}
	throw new Error('no free port in 4200-4999');
}

/**
 * Every sub-request that failed or came back >= 400 (the document itself
 * excluded). With JavaScript disabled Chromium blocks every script load
 * ("csp"), so `scripts: false` leaves scripts out: what matters then is that
 * the styles, fonts and images arrive.
 */
function brokenLoads(page, { scripts = true } = {}) {
	const broken = [];
	const counts = (r) => scripts || !(r.resourceType() === 'script' || new URL(r.url()).pathname.endsWith('.js'));
	page.on('requestfailed', (r) => {
		if (counts(r)) broken.push(`${r.url()} (${r.failure()?.errorText})`);
	});
	page.on('response', (r) => {
		if (r.status() >= 400 && r.request().resourceType() !== 'document' && counts(r.request())) broken.push(`${r.url()} (${r.status()})`);
	});
	return broken;
}

/** The site's stylesheets applied: the page background and the chip's border. */
async function expectStyled(page) {
	await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(249, 244, 239)');
	await expect(page.locator('.wf-notfound .wf-chip')).toHaveCSS('border-top-style', 'solid');
}

/** The PDP's own price for a product slug — the source of truth for cards. */
async function pdpPrice(request, slug) {
	const html = await (await request.get(`/products/${slug}`)).text();
	const m = html.match(/wf-price wf-price-large">([^<]+)</);
	return m && m[1];
}

test('unknown URL: 404 status with the branded page', async ({ page }) => {
	const errors = collectErrors(page);
	const res = await page.goto('/nope');
	expect(res.status()).toBe(404);
	await expect(page).toHaveTitle('Wefeasto — Page not found');
	await expect(heading(page)).toBeVisible();
	await expect(page.locator('.wf-notfound .wf-chip')).toHaveText('Error 404');
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
	// site chrome around it: nav, footer, and the crowd walking below
	await expect(page.locator('.navbar')).toBeVisible();
	await expect(page.locator('.footer-section')).toBeVisible();
	await expect(page.locator('canvas.wf-peepwalk')).toHaveCount(1);
	await expect(page.getByRole('link', { name: 'Shop Breakfast' })).toHaveAttribute('href', '/shop');
	expect(errors).toEqual([]);
});

test('shows three bestsellers with live catalog prices', async ({ page, request }) => {
	await page.goto('/nope');
	const grid = page.locator('.page-wrapper .grid-6 .wf-card');
	await expect(grid).toHaveCount(3);
	const data = await grid.evaluateAll((els) =>
		els.map((el) => ({
			href: el.querySelector('a[href^="/products/"]').getAttribute('href'),
			name: el.querySelector('.heading-11').textContent.trim(),
			price: el.querySelector('.wf-price').textContent.trim(),
			cat: el.querySelector('.text-block-3-copy').textContent.trim(),
			stars: el.querySelector('.wf-stars').getAttribute('aria-label'),
			add: el.querySelector('[data-wf-add]').getAttribute('data-wf-add')
		}))
	);
	expect(new Set(data.map((d) => d.href)).size).toBe(3);
	for (const d of data) {
		const slug = d.href.replace('/products/', '');
		expect(d.add).toBe(slug);
		expect(d.price).toMatch(/^₹[\d,]+$/);
		expect(d.price).toBe(await pdpPrice(request, slug));
		expect(d.stars).toMatch(/^Rated \d\.\d out of 5$/);
		expect(d.cat).toMatch(/^(Flakes|Oats|Muesli|Mix)$/);
	}
});

// Focus goes into the search field (with motion, as soon as the panel's
// tween makes it visible; under ?nofx=1 once Svelte has unhidden it) and
// back to the button on Esc. More in polish-search.spec.js.
for (const q of ['', '?nofx=1']) {
	test(`the search button opens search${q ? ' (' + q + ')' : ''}`, async ({ page }) => {
		await page.goto('/nope' + q);
		await hydrated(page);
		const overlay = page.locator('#wf-search-overlay');
		const button = page.getByRole('button', { name: 'Search Wefeasto' });
		await expect(overlay).toBeHidden();
		await button.click();
		await expect(overlay).toBeVisible();
		await expect(page.getByRole('dialog', { name: 'Search Wefeasto' })).toBeVisible();
		await expect(page.locator('.wf-search-input')).toBeFocused();
		await page.keyboard.type('muesli'); // lands in the field: focus is really there
		await expect(page.locator('.wf-search-input')).toHaveValue('muesli');
		await expect(page.locator('.wf-search-card').first()).toBeVisible();
		await expect(page.locator('.wf-search-card').first()).toContainText('Muesli');
		await page.keyboard.press('Escape');
		await expect(overlay).toBeHidden();
		await expect(button).toBeFocused();
	});
}

test('a missing product is a 404 too', async ({ page }) => {
	const res = await page.goto('/products/not-a-cereal');
	expect(res.status()).toBe(404);
	await expect(heading(page)).toBeVisible();
});

test('client-side navigation to a missing product renders the 404 without a reload', async ({ page }) => {
	// The route matches (products/[slug]) and its load() throws 404 in the
	// browser, so SvelteKit renders +error.svelte client-side.
	await page.goto('/shop');
	await hydrated(page); // the client router must be running, or the click is a full page load
	await page.evaluate(() => (window.__noReload = true));
	await page.evaluate(() => {
		const a = document.createElement('a');
		a.href = '/products/not-a-cereal';
		a.textContent = 'x';
		document.querySelector('.page-wrapper').appendChild(a);
		a.click();
	});
	await expect(heading(page)).toBeVisible();
	expect(await page.evaluate(() => window.__noReload)).toBe(true);
	await expect(page.locator('canvas.wf-peepwalk')).toHaveCount(1);
	// and back to a real page
	await page.locator('.nav-menu a[href="/shop"]').click();
	await page.waitForURL('**/shop');
	await expect(heading(page)).toHaveCount(0);
});

test('a link to an unknown route falls through to the server 404', async ({ page }) => {
	// No route matches, so the client router hands over to a full page load
	// (on the static host that is build/404.html).
	await page.goto('/shop');
	await hydrated(page); // so this really is the client router handing over
	const [res] = await Promise.all([
		page.waitForResponse((r) => new URL(r.url()).pathname === '/wandered/off'),
		page.evaluate(() => {
			const a = document.createElement('a');
			a.href = '/wandered/off';
			a.textContent = 'x';
			document.querySelector('.page-wrapper').appendChild(a);
			a.click();
		})
	]);
	expect(res.status()).toBe(404);
	await expect(heading(page)).toBeVisible();
});

test('/404 itself (the page prerendered to build/404.html) renders the same page', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/404');
	await expect(heading(page)).toBeVisible();
	await expect(page).toHaveTitle('Wefeasto — Page not found');
	await expect(page.locator('.wf-notfound .wf-chip')).toHaveText('Error 404');
	await expect(page.locator('.page-wrapper .grid-6 .wf-card')).toHaveCount(3);
	expect(errors).toEqual([]);
});

test('build/404.html is the real page, with root-absolute URLs', async ({ request, baseURL }) => {
	const build = await servedBuild(baseURL);
	const html = fs.readFileSync(path.join(build, '404.html'), 'utf8');
	// the served build's own /404 page, made root-absolute: not some other build's file
	const served = await (await request.get('/404')).text();
	expect(rootAbsolute(served) === html, `${build}/404.html is not the served /404 made root-absolute`).toBe(true);
	// the copy, both calls to action and the bestsellers, before any JS runs
	expect(html).toContain('This page wandered off.');
	expect(html).toContain('Error 404');
	expect(html).toContain('>Search Wefeasto</button>');
	expect(html).toContain('<a href="/shop" class="button secondary w-inline-block"><div>Shop Breakfast</div></a>');
	expect(html.match(/ wf-card"/g)).toHaveLength(3);
	expect(html).toMatch(/<meta name="robots" content="noindex"\/?>/);
	// served at any depth: nothing may resolve against the requested path
	expect(html).not.toMatch(/\s(?:href|src|srcset|poster)=["']\.{1,2}\//);
	expect(html).not.toMatch(/import\(["']\./);
	expect(html).not.toContain(', location)');
	expect(html).toMatch(/base: ""/);
	expect(html).toMatch(/href="\/css\/wefeasto\.css"/);
});

test.describe('on a static host (build/ served like Vercel: cleanUrls, 404.html for anything else)', () => {
	let server;
	let origin;
	test.beforeAll(async ({}, testInfo) => {
		server = staticHost(await servedBuild(testInfo.project.use.baseURL));
		origin = `http://127.0.0.1:${await listen(server)}`;
	});
	test.afterAll(async () => {
		await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
	});

	const UNKNOWN = ['/nope', '/some/old-link', '/products/not-a-cereal/reviews'];

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		for (const url of UNKNOWN) {
			test(`${url}: the whole page is there and styled`, async ({ page }) => {
				const broken = brokenLoads(page, { scripts: false });
				let assets = 0;
				page.on('response', (r) => {
					if (r.ok() && /\.(css|png|jpe?g|svg|webp|woff2?)$/.test(new URL(r.url()).pathname)) assets++;
				});
				const res = await page.goto(origin + url);
				expect(res.status()).toBe(404);
				await expect(heading(page)).toBeVisible();
				await expect(page).toHaveTitle('Wefeasto — Page not found');
				await expect(page.locator('.wf-notfound .wf-chip')).toHaveText('Error 404');
				await expectStyled(page);
				await expect(page.getByRole('link', { name: 'Shop Breakfast' })).toHaveAttribute('href', '/shop');
				await expect(page.getByRole('link', { name: 'Shop Breakfast' })).toBeVisible();
				await expect(page.locator('.wf-notfound-search')).toBeHidden(); // needs JS: no dead button
				await expect(page.locator('.navbar a[href="/"]').first()).toBeVisible(); // home, via the logo
				await expect(page.locator('.page-wrapper .grid-6 .wf-card')).toHaveCount(3);
				await expect(page.locator('.page-wrapper .grid-6 .wf-card img').first()).toHaveJSProperty('complete', true);
				await expect(page.locator('.footer-section')).toBeVisible();
				expect(broken).toEqual([]);
				expect(assets, 'stylesheets and images loaded from the root').toBeGreaterThanOrEqual(5);
			});
		}

		test('its links lead back into the shop', async ({ page }) => {
			await page.goto(origin + '/some/old-link');
			await page.getByRole('link', { name: 'Shop Breakfast' }).click();
			await expect(page).toHaveURL(origin + '/shop');
			await expect(page.locator('h1').first()).toBeVisible();
			await expect(heading(page)).toHaveCount(0);
		});
	});

	test('with JavaScript, a deep unknown URL hydrates: no errors, search works, links navigate client-side', async ({ page }) => {
		// The bestsellers' Add buttons ask for the live catalog (live-catalog.md §2).
		// On Vercel /api is rewritten to the CMS (vercel.json), so answer it as the
		// CMS would: the snapshot's catalog. The context's 404 stub stands for "no
		// CMS", which would count as a broken load here.
		const snapshot = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'src/lib/data/cms-snapshot.json'), 'utf8'));
		const catalog = {
			settings: snapshot.settings,
			products: snapshot.products.map(({ slug, name, pricePaise, inStock, maxPerOrder, codAllowed }) => ({ slug, name, pricePaise, inStock, lowStock: null, maxPerOrder, codAllowed }))
		};
		const live = [];
		await page.route('**/api/store/catalog*', (route) => {
			live.push(new URL(route.request().url()).pathname);
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) });
		});
		const errors = collectErrors(page);
		const broken = brokenLoads(page);
		const res = await page.goto(origin + '/products/not-a-cereal/reviews');
		expect(res.status()).toBe(404);
		await expect(heading(page)).toBeVisible();
		await hydrated(page);
		await expectStyled(page);
		await expect(page.locator('.page-wrapper .grid-6 .wf-card')).toHaveCount(3);
		await expect(page.locator('canvas.wf-peepwalk')).toHaveCount(1);
		// hydrated: the search button is there and works
		await page.getByRole('button', { name: 'Search Wefeasto' }).click();
		await expect(page.getByRole('dialog', { name: 'Search Wefeasto' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('#wf-search-overlay')).toBeHidden();
		// and the client router took over with the right base: no reload to /shop
		await page.evaluate(() => (window.__noReload = true));
		await page.getByRole('link', { name: 'Shop Breakfast' }).click();
		await page.waitForURL(origin + '/shop');
		await expect(heading(page)).toHaveCount(0);
		expect(await page.evaluate(() => window.__noReload)).toBe(true);
		expect(errors).toEqual([]);
		expect(broken).toEqual([]);
		expect(live[0]).toBe('/api/store/catalog'); // root-absolute, like every other load
	});

	test('with ?nofx=1 and blocked storage it still renders fully', async ({ page }) => {
		await page.addInitScript(blockStorage);
		const errors = collectErrors(page);
		await page.goto(origin + '/some/old-link?nofx=1');
		await expect(heading(page)).toBeVisible();
		expect(await heading(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		expect(errors).toEqual([]);
	});
});

test('renders fully with ?nofx=1', async ({ page }) => {
	await page.goto('/nope?nofx=1');
	await expect(heading(page)).toBeVisible();
	expect(await heading(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

test('renders when localStorage throws', async ({ page }) => {
	await page.addInitScript(blockStorage);
	const errors = collectErrors(page);
	await page.goto('/nope');
	await expect(heading(page)).toBeVisible();
	expect(errors).toEqual([]);
});

test.describe('without JavaScript (server-rendered by preview)', () => {
	test.use({ javaScriptEnabled: false });

	test('content is visible', async ({ page }) => {
		const res = await page.goto('/nope');
		expect(res.status()).toBe(404);
		await expect(heading(page)).toBeVisible();
		await expect(page.locator('.page-wrapper .grid-6 .wf-card')).toHaveCount(3);
		await expect(page.getByRole('link', { name: 'Shop Breakfast' })).toBeVisible();
		await expect(page.locator('.wf-notfound-search')).toBeHidden();
	});
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('fits and keeps the actions reachable', async ({ page }) => {
		await page.goto('/nope');
		await expect(heading(page)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Search Wefeasto' })).toBeInViewport();
		const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(o).toBeLessThanOrEqual(0);
	});
});

/** The two calls to action: box, font size, and whether the label overflows. */
const actionBoxes = (page) =>
	page.locator('.wf-notfound-actions > .button').evaluateAll((els) =>
		els.map((el) => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return { left: r.left, top: r.top, width: r.width, height: r.height, font: cs.fontSize, scrollW: el.scrollWidth, clientW: el.clientWidth };
		})
	);

test.describe('the two calls to action match at every width', () => {
	// Webflow sizes .button (44px, 12px text) and .button.secondary (40px,
	// 14px, 12px top margin) differently at <=479px.
	for (const width of [320, 360, 390, 414, 479, 480, 768, 1280]) {
		test(`${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			await page.goto('/nope?nofx=1');
			const [search, shop] = await actionBoxes(page);
			const phone = width <= 479;
			expect(search.height).toBe(phone ? 44 : 50);
			expect(shop.height).toBe(search.height);
			expect(shop.font).toBe(search.font);
			expect(search.font).toBe(phone ? '14px' : '16px');
			for (const b of [search, shop]) expect(b.scrollW, 'label fits on one line').toBeLessThanOrEqual(b.clientW);
			if (shop.top === search.top) {
				// one row: the pair lines up (equal halves on a phone)
				if (phone) expect(Math.abs(shop.width - search.width)).toBeLessThanOrEqual(1);
				expect(shop.left).toBeGreaterThan(search.left + search.width);
			} else {
				// stacked (narrow phones only): same column, same width, 12px apart
				expect(phone && width < 390, 'only below 390px may they stack').toBe(true);
				expect(shop.left).toBe(search.left);
				expect(shop.width).toBe(search.width);
				expect(shop.top - (search.top + search.height)).toBe(12);
			}
			const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			expect(o).toBeLessThanOrEqual(0);
		});
	}
});
