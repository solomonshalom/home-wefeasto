/*
 * In-process Vercel-like static server for a build directory:
 *  - cleanUrls: /x → x.html, /x/ → x/index.html
 *  - unknown files → build/404.html with status 404 (plain 404 when absent)
 *  - /api and /api/* → 404 {} ("no CMS"; live.js keeps the snapshot). Tests can
 *    still override any /api call with page.route().
 * Listens on 127.0.0.1 on a free port; close() stops it.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.txt': 'text/plain; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.otf': 'font/otf',
	'.ttf': 'font/ttf',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm'
};

export function serveStatic(root, { port = 0 } = {}) {
	root = path.resolve(root);
	const server = http.createServer((req, res) => {
		let p;
		try {
			p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		} catch {
			res.writeHead(400);
			return res.end();
		}
		if (/^\/api(\/|$)/.test(p)) {
			res.writeHead(404, { 'content-type': 'application/json' });
			return res.end('{}');
		}
		const cands = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html', p + '/index.html'];
		for (const c of cands) {
			const f = path.join(root, c);
			if (!f.startsWith(root)) break;
			let st;
			try {
				st = fs.statSync(f);
			} catch {
				continue;
			}
			if (!st.isFile()) continue;
			const type = TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';
			const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
			if (range && type.startsWith('video/')) {
				const start = range[1] ? +range[1] : 0;
				const end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
				res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
				return fs.createReadStream(f, { start, end }).pipe(res);
			}
			res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store' });
			if (req.method === 'HEAD') return res.end();
			return fs.createReadStream(f).pipe(res);
		}
		const nf = path.join(root, '404.html');
		if (fs.existsSync(nf)) {
			res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
			return fs.createReadStream(nf).pipe(res);
		}
		res.writeHead(404, { 'content-type': 'text/html' });
		res.end('<h1>404</h1>');
	});
	server.keepAliveTimeout = 65000; // outlive client keep-alive reuse (route.fetch ECONNRESET races)
	server.headersTimeout = 66000;
	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(port, '127.0.0.1', () => {
			const { port: actual } = server.address();
			resolve({
				base: `http://127.0.0.1:${actual}`,
				port: actual,
				close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r())))
			});
		});
	});
}
