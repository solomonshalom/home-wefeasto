/*
 * axe scan of a set of storefront pages (serious + critical only), as JSON.
 * Used to (re)build a11y-baseline.json from the pre-Phase-2 build:
 *   node e2e/full/experience/a11y-scan.mjs --static <baseline build dir> > e2e/full/experience/a11y-baseline.json
 * or to scan a running storefront:
 *   node e2e/full/experience/a11y-scan.mjs --url http://localhost:4704
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { AXE_TAGS, BASELINE_PAGES, applyState, scanPage } from './a11y-lib.js';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.otf': 'font/otf', '.json': 'application/json', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

/** Static server with clean URLs (/shop → shop.html); anything else 404. */
export function serveStatic(root) {
	const server = http.createServer((req, res) => {
		const u = new URL(req.url, 'http://x');
		let p = decodeURIComponent(u.pathname);
		const tries = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html', p + '/index.html'];
		for (const t of tries) {
			const f = path.join(root, t);
			if (!f.startsWith(root)) break;
			if (fs.existsSync(f) && fs.statSync(f).isFile()) {
				res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
				fs.createReadStream(f).pipe(res);
				return;
			}
		}
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found');
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://localhost:${server.address().port}` })));
}

const staticDir = opt('--static');
let base = opt('--url');
let srv = null;
if (staticDir) {
	srv = await serveStatic(path.resolve(staticDir));
	base = srv.url;
}
if (!base) throw new Error('--static <dir> or --url <origin>');
const browser = await chromium.launch();
const out = { tags: AXE_TAGS, generatedFrom: staticDir ? 'pre-Phase-2 baseline build' : base, pages: {} };
for (const [name, p] of Object.entries(BASELINE_PAGES)) {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
	await ctx.route(/\/api(\/|$)/, (r) => r.fulfill({ status: 404, body: '{}' }));
	const page = await ctx.newPage();
	if (p.bag) await page.addInitScript((b) => localStorage.setItem('wefeasto_cart', JSON.stringify(b)), p.bag);
	await page.goto(base + p.path + (p.path.includes('?') ? '&' : '?') + 'nofx=1', { waitUntil: 'load' });
	await applyState(page, p.state);
	out.pages[name] = await scanPage(page);
	await ctx.close();
}
await browser.close();
srv?.server.close();
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
