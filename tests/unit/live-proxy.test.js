/*
 * vite.config.js: the same-origin /api proxy that live.js, api.js and the
 * auth cookie rely on in `vite dev` / `vite preview`. The cookie rewrite is
 * tested on its own, then real Vite dev and preview servers (using the
 * config's cmsProxy()) are put in front of a fake CMS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer, preview } from 'vite';
import config, { CMS_URL, cmsProxy, devCookie } from '../../vite.config.js';

describe('devCookie (Set-Cookie on a plain-http dev origin)', () => {
	it.each([
		['payload-token=abc; Path=/; HttpOnly; Secure; SameSite=Lax', 'payload-token=abc; Path=/; HttpOnly; SameSite=Lax'],
		['payload-token=abc; Path=/; HttpOnly; SameSite=Lax', 'payload-token=abc; Path=/; HttpOnly; SameSite=Lax'],
		['a=1; Secure', 'a=1'],
		['a=1; secure; Path=/', 'a=1; Path=/'],
		['a=1;Secure;HttpOnly', 'a=1;HttpOnly'],
		['a=1; Path=/; Secure; SameSite=None', 'a=1; Path=/; SameSite=Lax'],
		['a=1; SameSite=none; Secure; Partitioned', 'a=1; SameSite=Lax'],
		['a=1; SameSite=Strict; Secure', 'a=1; SameSite=Strict'],
		// Values that merely contain the words are untouched.
		['token=Secure; Path=/secure', 'token=Secure; Path=/secure'],
		['a=SameSite=None', 'a=SameSite=None'],
		// Prefixed cookies must stay Secure (browsers reject them otherwise).
		['__Host-x=1; Path=/; Secure', '__Host-x=1; Path=/; Secure'],
		['__Secure-x=1; Secure; SameSite=None', '__Secure-x=1; Secure; SameSite=None']
	])('%s → %s', (input, expected) => {
		expect(devCookie(input)).toBe(expected);
	});

	it('passes non-strings through', () => {
		expect(devCookie(undefined)).toBe(undefined);
		expect(devCookie(null)).toBe(null);
	});
});

describe('config', () => {
	it('defaults to the CMS on localhost:3000 unless CMS_URL is set', () => {
		expect(CMS_URL).toBe(process.env.CMS_URL || 'http://localhost:3000');
		expect(Object.values(cmsProxy())[0].target).toBe(CMS_URL);
		expect(Object.values(cmsProxy('http://127.0.0.1:3999'))[0].target).toBe('http://127.0.0.1:3999');
	});

	it('proxies in dev and preview and keeps the vitest block', () => {
		expect(Object.keys(config.server.proxy)).toEqual(Object.keys(cmsProxy()));
		expect(Object.keys(config.preview.proxy)).toEqual(Object.keys(cmsProxy()));
		expect(config.test).toEqual({ include: ['src/**/*.test.js', 'tests/unit/**/*.test.js'], environment: 'node' });
	});

	it('rewrites Host (changeOrigin) and strips cookie domains', () => {
		const [entry] = Object.values(cmsProxy());
		expect(entry.changeOrigin).toBe(true);
		expect(entry.cookieDomainRewrite).toBe('');
		expect(entry.rewrite).toBeUndefined(); // /api/... is forwarded as /api/...
	});

	it.each([
		['/api/store/catalog', true],
		['/api/customers/me?depth=0', true],
		['/api', true],
		['/api/', true],
		['/api?x=1', true],
		['/api-docs', false],
		['/apiary', false],
		['/shop', false],
		['/_app/immutable/api/x.js', false],
		['/src/lib/api.js', false],
		['/products/api', false]
	])('%s proxied: %s', (url, expected) => {
		const [key] = Object.keys(cmsProxy());
		expect(key.startsWith('^')).toBe(true); // Vite treats ^-keys as RegExp
		expect(new RegExp(key).test(url)).toBe(expected);
	});
});

/* ----------------------------------------------- real servers, fake CMS */

async function listenRandom(server) {
	for (let i = 0; i < 50; i++) {
		const port = 4200 + Math.floor(Math.random() * 800);
		const ok = await new Promise((resolve) => {
			server.once('error', () => resolve(false));
			server.listen(port, '127.0.0.1', () => resolve(true));
		});
		if (ok) return port;
	}
	throw new Error('no free port');
}

async function freePort() {
	const s = http.createServer();
	const port = await listenRandom(s);
	await new Promise((r) => s.close(r));
	return port;
}

/** Plain http request with full header control (fetch would hide Origin/Cookie details). */
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (c) => (data += c));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

const EXPIRES = 'Expires=Wed, 01 Oct 2031 00:00:00 GMT';

describe.each(['dev', 'preview'])('vite %s server in front of a fake CMS', { timeout: 60000 }, (mode) => {
	let cms;
	let cmsPort;
	let vite;
	let port;
	let dir;
	const seen = [];
	const storefront = () => `http://localhost:${port}`;

	beforeAll(async () => {
		cms = http.createServer((req, res) => {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				seen.push({ method: req.method, url: req.url, headers: req.headers, body });
				if (req.url.startsWith('/api/customers/login')) {
					res.setHeader('Set-Cookie', [
						`payload-token=jwt123; ${EXPIRES}; Path=/; Domain=127.0.0.1; HttpOnly; Secure; SameSite=None`,
						'wf-other=1; Path=/; Domain=.cms.example; SameSite=Lax',
						'__Host-keep=1; Path=/; Secure'
					]);
				}
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true, url: req.url }));
			});
		});
		cmsPort = await listenRandom(cms);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-proxy-'));
		fs.mkdirSync(path.join(dir, 'dist'));
		fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>storefront</title>');
		fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>storefront</title>');
		port = await freePort();
		const proxy = cmsProxy(`http://127.0.0.1:${cmsPort}`);
		const common = { configFile: false, root: dir, logLevel: 'silent', build: { outDir: 'dist' } };
		if (mode === 'dev') {
			vite = await createServer({ ...common, server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null, proxy } });
			await vite.listen();
		} else {
			vite = await preview({ ...common, preview: { port, strictPort: true, host: '127.0.0.1', proxy } });
		}
	});

	afterAll(async () => {
		await vite?.close();
		await new Promise((r) => cms.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('forwards /api/* with path and query intact, Host rewritten, Origin and Cookie untouched', async () => {
		seen.length = 0;
		const res = await request(port, {
			path: '/api/store/catalog?x=1&y=%2C',
			headers: { Host: `localhost:${port}`, Origin: storefront(), Cookie: 'payload-token=jwt123', 'Sec-Fetch-Site': 'same-origin' }
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ ok: true, url: '/api/store/catalog?x=1&y=%2C' });
		expect(seen).toHaveLength(1);
		const h = seen[0].headers;
		expect(h.host).toBe(`127.0.0.1:${cmsPort}`);
		expect(h.origin).toBe(storefront());
		expect(h.cookie).toBe('payload-token=jwt123');
		expect(h['sec-fetch-site']).toBe('same-origin');
	});

	it('forwards POST bodies', async () => {
		seen.length = 0;
		const body = JSON.stringify({ items: [{ slug: 'muesli', qty: 2 }] });
		const res = await request(port, {
			method: 'POST',
			path: '/api/store/quote',
			headers: { Origin: storefront(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
			body
		});
		expect(res.status).toBe(200);
		expect(seen[0].method).toBe('POST');
		expect(seen[0].body).toBe(body);
		expect(seen[0].headers.origin).toBe(storefront());
	});

	it('makes CMS cookies first-party: no Domain, no Secure, SameSite=None → Lax', async () => {
		const res = await request(port, { method: 'POST', path: '/api/customers/login', headers: { Origin: storefront() } });
		expect(res.headers['set-cookie']).toEqual([
			`payload-token=jwt123; ${EXPIRES}; Path=/; HttpOnly; SameSite=Lax`,
			'wf-other=1; Path=/; SameSite=Lax',
			'__Host-keep=1; Path=/; Secure'
		]);
	});

	it('does not proxy storefront paths', async () => {
		seen.length = 0;
		for (const p of ['/', '/api-docs', '/shop']) await request(port, { path: p });
		expect(seen).toEqual([]);
	});
});

describe('CMS down', { timeout: 60000 }, () => {
	it('the dev proxy answers 5xx quickly instead of hanging (live.js then falls back)', async () => {
		const deadPort = await freePort();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-proxy-'));
		fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
		const port = await freePort();
		const vite = await createServer({
			configFile: false,
			root: dir,
			logLevel: 'silent',
			server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null, proxy: cmsProxy(`http://127.0.0.1:${deadPort}`) }
		});
		await vite.listen();
		try {
			const res = await request(port, { path: '/api/store/catalog' });
			expect(res.status).toBeGreaterThanOrEqual(500);
		} finally {
			await vite.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
