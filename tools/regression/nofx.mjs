/*
 * Kill-switch + page smoke (JS on), baseline vs current.
 *
 * nofx: ?nofx=1, prefers-reduced-motion and normal on /, /shop and a PDP: veil
 *   state, opacity of h1 / .wf-reveal / .grid-6, then a client-side navigation
 *   (nav link → /shop) in the same mode. Observations must be equal on both sides
 *   (allow-list "nofx.expected" can pin intended differences).
 * smoke: every prerendered page of the current build (new routes included) is
 *   loaded with JS on and "no CMS" (/api → 404); page errors and console errors
 *   (other than the /api 404s) must not be new compared to the same page on the
 *   baseline. Catches hydration and prod-only (minified) runtime errors.
 */
import { pageToRoute } from './util.mjs';

const isApiNoise = (m) => /\/api(\/|$|\?)/.test(m.location()?.url || '');

async function probe(browser, base, label, ctxOpts, url) {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...ctxOpts });
	try {
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto(base + url, { waitUntil: 'load' });
		await page.waitForTimeout(900);
		const read = () =>
			page.evaluate(() => {
				const veil = document.getElementById('wf-veil');
				// quantised: exact mid-animation opacities are timing noise
				const op = (sel) => {
					const el = document.querySelector(sel);
					if (!el) return 'missing';
					const o = parseFloat(getComputedStyle(el).opacity);
					return o >= 0.9 ? 'visible' : o <= 0.1 ? 'hidden' : 'partial';
				};
				return {
					path: location.pathname,
					veil: veil ? getComputedStyle(veil).display + '/' + getComputedStyle(veil).opacity : 'absent',
					hero: op('h1'),
					reveal: op('.wf-reveal'),
					grid: op('.grid-6')
				};
			});
		const before = await read();
		await page.click('.navbar a[href="/shop"], a[href="/shop"]');
		await page.waitForTimeout(1200);
		const afterNav = await read();
		return { before, afterNav, errors };
	} finally {
		await ctx.close();
	}
}

export async function runNofx({ browser, baseUrl, curUrl, allow }) {
	const expected = (allow.nofx && allow.nofx.expected) || {};
	const modes = [
		['nofx', {}, '?nofx=1'],
		['reduced', { reducedMotion: 'reduce' }, ''],
		['normal', {}, '']
	];
	const urls = ['/', '/products/muesli', '/recipes/wf-banana-oat-pancakes'];
	const rows = [];
	for (const [label, opts, qs] of modes) {
		for (const u of urls) {
			const key = `${label} ${u}`;
			const [a, b] = await Promise.all([probe(browser, baseUrl, label, opts, u + qs), probe(browser, curUrl, label, opts, u + qs)]);
			const e = expected[key];
			const ok = e ? JSON.stringify(b) === JSON.stringify(e.current) : JSON.stringify(a) === JSON.stringify(b);
			rows.push({ key, ok, baseline: a, current: b, note: e ? `allow-listed: ${e.reason}` : '' });
		}
	}
	return { ok: rows.every((r) => r.ok), rows };
}

async function pageErrors(browser, base, route, vp) {
	const ctx = await browser.newContext({ viewport: vp });
	try {
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
		page.on('console', (m) => {
			if (m.type() === 'error' && !isApiNoise(m)) errors.push('console: ' + m.text());
		});
		const res = await page.goto(base + route, { waitUntil: 'load', timeout: 30000 });
		await page.waitForTimeout(1500);
		await page.mouse.wheel(0, 2500);
		await page.waitForTimeout(700);
		// horizontal overflow (e.g. a nav row pushed off a phone screen)
		const overflowX = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)).catch(() => null);
		return { status: res?.status() ?? null, errors, overflowX };
	} finally {
		await ctx.close();
	}
}

export async function runSmoke({ browser, baseUrl, curUrl, basePages, curPages, allow, concurrency = 4 }) {
	const ignore = ((allow.smoke && allow.smoke.ignoreErrors) || []).map((e) => new RegExp(e.pattern));
	const jobs = [];
	const widths = (allow.smoke && allow.smoke.widths) || [1280, 768, 390];
	for (const w of widths) for (const p of curPages) jobs.push({ p, vp: { width: w, height: w >= 1024 ? 900 : w >= 700 ? 1024 : 844 } });
	const rows = [];
	let next = 0;
	async function worker() {
		while (next < jobs.length) {
			const { p, vp } = jobs[next++];
			const route = pageToRoute(p);
			const inBase = basePages.includes(p);
			const [a, b] = await Promise.all([inBase ? pageErrors(browser, baseUrl, route, vp) : null, pageErrors(browser, curUrl, route, vp)]);
			const newErrors = b.errors.filter((e) => !(a?.errors || []).includes(e) && !ignore.some((re) => re.test(e)));
			const expectStatus = p === '404.html' ? [200, 404] : [200];
			const newOverflow = b.overflowX > Math.max(0, a?.overflowX ?? 0);
			if (newOverflow) newErrors.push(`horizontal overflow ${b.overflowX}px at ${vp.width}px (baseline ${a ? a.overflowX + 'px' : 'n/a'})`);
			const ok = newErrors.length === 0 && expectStatus.includes(b.status);
			rows.push({ page: p, viewport: `${vp.width}`, ok, status: b.status, overflowX: b.overflowX, newErrors, baselineErrors: a?.errors || null });
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
	rows.sort((x, y) => (x.page + x.viewport).localeCompare(y.page + y.viewport));
	return { ok: rows.every((r) => r.ok), rows };
}
