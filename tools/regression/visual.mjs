/*
 * JS-off full-page visual diff, baseline vs current, at 1280x900 and 390x844.
 *
 * With JavaScript disabled the page is pure markup + CSS. Allow-listed regions
 * are handled by rewriting the served HTML (no page JS needed): a <style> is
 * appended to <head> that
 *   - "hide"s intended additions (display:none, so the layout collapses back to
 *     the baseline's), on the side(s) given, and
 *   - "mask"s intentionally changed regions (visibility:hidden, layout kept),
 * then both screenshots are pixel-compared (pixelmatch threshold 0.1). A page
 * passes when the differing share is under its maxDiffRatio (default 0.001 =
 * 0.1%). Height differences count every pixel of the extra rows as differing.
 */
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import fs from 'node:fs';
import path from 'node:path';
import { globMatch, pageToRoute, ensureDir } from './util.mjs';

export const VIEWPORTS = [
	{ tag: 'desktop', width: 1280, height: 900 },
	{ tag: 'mobile', width: 390, height: 844 }
];

const applies = (r, page, vp) =>
	(r.pages || ['**']).some((g) => globMatch(g, page)) &&
	!(r.exceptPages || []).some((g) => globMatch(g, page)) &&
	(!r.viewports || r.viewports.includes(vp.tag));

function styleFor(rules, side, page, vp) {
	const css = [];
	for (const r of rules) {
		if (!applies(r, page, vp)) continue;
		const s = r.side || 'both';
		if (s !== 'both' && s !== side) continue;
		if (r.mode === 'hide') css.push(`${r.selector}{display:none!important}`);
		else if (r.mode === 'mask') css.push(`${r.selector}{visibility:hidden!important}`);
		else throw new Error(`visual rule ${r.id}: mode must be hide|mask`);
	}
	return css.join('\n');
}

async function shoot(browser, base, job, vp, css, file) {
	const js = !!job.js;
	const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, javaScriptEnabled: js, deviceScaleFactor: 1, ...(js ? { reducedMotion: 'reduce' } : {}) });
	try {
		if (job.seed) {
			await ctx.addInitScript((seed) => {
				try {
					for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
				} catch {}
			}, job.seed);
		}
		const p = await ctx.newPage();
		const route = job.route || pageToRoute(job.page);
		const url = base + route + (js ? (route.includes('?') ? '&' : '?') + 'nofx=1' : '');
		if (css) {
			await p.route(url, async (route) => {
				// never let a handler error escape (it would be an unhandled rejection):
				// retry the fetch (keep-alive races), else abort so goto fails and shootRetry retries
				for (let i = 0; i < 3; i++) {
					try {
						const res = await route.fetch();
						const html = (await res.text()).replace('</head>', `<style data-regression-allowlist>${css}</style></head>`);
						await route.fulfill({ status: res.status(), body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(html)) } });
						return;
					} catch {}
				}
				await route.abort().catch(() => {});
			});
		}
		await p.goto(url, { waitUntil: 'load', timeout: 45000 });
		await p.waitForTimeout(js ? 1500 : 250); // JS: hydration + client-rendered content
		// native key scrolling loads lazy images (no page JS available)
		for (let i = 0; i < 12; i++) {
			await p.keyboard.press('PageDown');
			await p.waitForTimeout(60);
		}
		await p.keyboard.press('End');
		await p.waitForTimeout(250);
		await p.keyboard.press('Home');
		await p.waitForTimeout(350);
		await p.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
		return file;
	} finally {
		await ctx.close();
	}
}

async function shootRetry(...args) {
	for (let i = 1; ; i++) {
		try {
			return await shoot(...args);
		} catch (e) {
			if (i >= 3) throw e;
		}
	}
}

function compare(fa, fb, diffFile) {
	const a = PNG.sync.read(fs.readFileSync(fa));
	const b = PNG.sync.read(fs.readFileSync(fb));
	const w = Math.min(a.width, b.width);
	const h = Math.min(a.height, b.height);
	const crop = (img) => {
		if (img.width === w && img.height === h) return img.data;
		const out = Buffer.alloc(w * h * 4);
		for (let y = 0; y < h; y++) img.data.copy(out, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
		return out;
	};
	const diff = new PNG({ width: w, height: h });
	const n = pixelmatch(crop(a), crop(b), diff.data, w, h, { threshold: 0.1 });
	const total = Math.max(a.width, b.width) * Math.max(a.height, b.height);
	const extra = total - w * h;
	const ratio = (n + extra) / total;
	if (n + extra > 0) fs.writeFileSync(diffFile, PNG.sync.write(diff));
	return { diffPx: n, extraPx: extra, ratio, baseSize: `${a.width}x${a.height}`, curSize: `${b.width}x${b.height}`, heightDelta: b.height - a.height };
}

/**
 * @param {{browser: any, baseUrl: string, curUrl: string, pages: string[], allow: any, outDir: string, concurrency?: number, log?: Function}} o
 */
export async function runVisual({ browser, baseUrl, curUrl, pages, allow, outDir, concurrency = 4, log = () => {}, js = false }) {
	const cfg = (js ? allow.visualJs : allow.visual) || {};
	const rules = cfg.rules || [];
	const thresholds = cfg.thresholds || [];
	ensureDir(outDir);
	const jobs = [];
	// JS off: every common page. JS on: the targets listed in the allow-list (route + localStorage seed).
	const targets = js ? (cfg.targets || []).filter((t) => pages.includes(t.page)) : pages.map((page) => ({ page }));
	for (const vp of cfg.viewports ? VIEWPORTS.filter((v) => cfg.viewports.includes(v.tag)) : VIEWPORTS) {
		for (const t of targets) {
			if ((cfg.skipPages || []).some((e) => globMatch(e.page, t.page))) continue;
			jobs.push({ ...t, js, vp, name: t.name || t.page.replace(/\.html$/, '') });
		}
	}
	const results = [];
	let next = 0;
	async function worker() {
		while (next < jobs.length) {
			const job = jobs[next++];
			const { page, vp } = job;
			const stem = path.join(outDir, `${job.name.replace(/\//g, '__')}.${vp.tag}`);
			const [fa, fb] = await Promise.all([
				shootRetry(browser, baseUrl, job, vp, styleFor(rules, 'baseline', page, vp), stem + '.baseline.png'),
				shootRetry(browser, curUrl, job, vp, styleFor(rules, 'current', page, vp), stem + '.current.png')
			]);
			const c = compare(fa, fb, stem + '.diff.png');
			const th = [...thresholds].reverse().find((t) => applies(t, page, vp));
			const max = th ? th.maxDiffRatio : 0.001;
			const ok = c.ratio <= max;
			results.push({ page: job.name === page.replace(/\.html$/, '') ? page : job.name, viewport: vp.tag, ok, max, thresholdReason: th?.reason || null, ...c, files: { baseline: fa, current: fb, diff: c.ratio > 0 ? stem + '.diff.png' : null } });
			log(`${ok ? 'OK  ' : 'DIFF'} ${vp.tag.padEnd(7)} ${(job.js ? job.name : page).padEnd(48)} ${(c.ratio * 100).toFixed(3)}% (max ${(max * 100).toFixed(2)}%) ${c.heightDelta ? `height ${c.heightDelta > 0 ? '+' : ''}${c.heightDelta}px` : ''}`);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
	results.sort((x, y) => (x.page + x.viewport).localeCompare(y.page + y.viewport));
	const warnings = [];
	return { ok: results.every((r) => r.ok), results, warnings };
}
