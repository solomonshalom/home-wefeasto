/*
 * DOM-equivalence check: original static pages vs prerendered Svelte build.
 * Normalizes framework noise (scripts, hydration comments, wrapper div,
 * URL space, attribute order/booleans, whitespace) then diffs canonical trees.
 *   node domdiff.mjs <site-root> <build-root>
 */
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SITE = process.argv[2];
const BUILD = process.argv[3];
const OUTDIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'domdiff-out');
fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(OUTDIR, { recursive: true });

const PAGES = [
	'index.html', 'shop.html', 'cart.html', 'checkout.html', 'login.html',
	'recipes.html', 'terms.html', 'privacy.html',
	...fs.readdirSync(path.join(SITE, 'products')).filter((f) => f.endsWith('.html')).map((f) => 'products/' + f),
	...fs.readdirSync(path.join(SITE, 'recipes')).filter((f) => f.startsWith('wf-') && f.endsWith('.html')).map((f) => 'recipes/' + f)
];

function rewriteUrl(u) {
	if (!u) return u;
	u = u.replace(/^\.\.\//, '');
	if (/^(https?:|mailto:|tel:|#)/.test(u)) return u;
	if (u === 'index.html') return '/';
	const m = u.match(/^index\.html(#.*)$/);
	if (m) return '/' + m[1];
	const rec = u.match(/^(?:recipes\/)?(wf-[a-z-]+)\.html$/);
	if (rec) return '/recipes/' + rec[1];
	const prod = u.match(/^products\/([a-z-]+)\.html$/);
	if (prod) return '/products/' + prod[1];
	const page = u.match(/^([a-z-]+)\.html(#.*)?$/);
	if (page) return '/' + page[1] + (page[2] || '');
	if (/^(images|videos|css|fonts)\//.test(u)) return '/' + u;
	return u;
}

const BOOL_ATTRS = new Set(['hidden', 'required', 'checked', 'disabled', 'novalidate', 'autoplay', 'muted', 'loop', 'playsinline', 'async', 'defer']);

function normStyle(v) {
	return v
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => s.replace(/\s*:\s*/, ': ').replace(/\s+/g, ' '))
		.join('; ');
}

function canonicalize($, el, out, depth, side, pagePath) {
	for (const node of el.childNodes || []) {
		if (node.type === 'comment') continue;
		if (node.type === 'text') {
			const t = node.data.replace(/\s+/g, ' ').trim();
			if (t) out.push('  '.repeat(depth) + JSON.stringify(t));
			continue;
		}
		if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') continue;
		const name = node.name.toLowerCase();
		if (name === 'script' || name === 'style') continue;
		if (name === 'link' && (node.attribs.rel === 'modulepreload' || node.attribs.rel === 'preload')) continue;
		// unwrap the SvelteKit body wrapper
		if (name === 'div' && (node.attribs.style || '').replace(/\s|;/g, '') === 'display:contents') {
			canonicalize($, node, out, depth, side, pagePath);
			continue;
		}
		// inert empty Webflow custom-code embeds (position differs; visually nothing)
		const cls = node.attribs.class || '';
		if (/(^|\s)w-embed(\s|$)/.test(cls) && $(node).children().length === 0 && !$(node).text().trim() && !/marquee/.test(cls)) {
			continue;
		}
		const attrs = { ...node.attribs };
		for (const k of Object.keys(attrs)) {
			if (BOOL_ATTRS.has(k)) attrs[k] = '';
			else if (k === 'style') attrs[k] = normStyle(attrs[k]);
			else if ((k === 'href' || k === 'src' || k === 'poster') && side === 'orig') attrs[k] = rewriteUrl(attrs[k]);
			else if ((k === 'href' || k === 'src' || k === 'poster') && side === 'port') {
				// prerendered relative asset links (../css/…) → absolute for comparison
				let v = attrs[k];
				if (/^\.\.?\//.test(v) || (!v.startsWith('/') && !/^(https?:|mailto:|tel:|#)/.test(v))) {
					const baseDir = '/' + path.posix.dirname(pagePath);
					v = path.posix.normalize(path.posix.join(baseDir, v));
				}
				attrs[k] = v;
			}
		}
		// input value="" (SSR of empty bound values) ≡ no value attribute
		if (name === 'input' && attrs.value === '') delete attrs.value;
		const attrStr = Object.keys(attrs)
			.sort()
			.map((k) => `${k}=${JSON.stringify(attrs[k])}`)
			.join(' ');
		out.push('  '.repeat(depth) + '<' + name + (attrStr ? ' ' + attrStr : '') + '>');
		if (name === 'noscript') {
			// scripting on → contents parse as text; normalize URLs inside
			let t = $(node).text().replace(/\s+/g, ' ').trim();
			if (side === 'orig') t = t.replace(/href="([^"]+)"/g, (m, u) => `href="${rewriteUrl(u)}"`);
			if (t) out.push('  '.repeat(depth + 1) + JSON.stringify(t));
			continue;
		}
		canonicalize($, node, out, depth + 1, side, pagePath);
	}
}

function canonical(file, side, pagePath) {
	const $ = cheerio.load(fs.readFileSync(file, 'utf8'));
	const out = [];
	const title = $('title').text();
	const desc = $('meta[name="description"]').attr('content');
	out.push('TITLE ' + JSON.stringify(title));
	if (desc) out.push('META-DESC ' + JSON.stringify(desc));
	canonicalize($, $('body')[0], out, 0, side, pagePath);
	return out.join('\n') + '\n';
}

let failed = 0;
const summary = [];
for (const page of PAGES) {
	const a = canonical(path.join(SITE, page), 'orig', page);
	const b = canonical(path.join(BUILD, page), 'port', page);
	const safe = page.replace(/[\/]/g, '__');
	fs.writeFileSync(path.join(OUTDIR, safe + '.orig.txt'), a);
	fs.writeFileSync(path.join(OUTDIR, safe + '.port.txt'), b);
	if (a === b) {
		summary.push('OK    ' + page);
		continue;
	}
	failed++;
	let diff = '';
	try {
		execFileSync('diff', ['-u', path.join(OUTDIR, safe + '.orig.txt'), path.join(OUTDIR, safe + '.port.txt')]);
	} catch (e) {
		diff = e.stdout.toString();
	}
	const lines = diff.split('\n').slice(2);
	const changed = lines.filter((l) => /^[-+]/.test(l)).length;
	summary.push('DIFF  ' + page + '  (' + changed + ' changed lines)');
	fs.writeFileSync(path.join(OUTDIR, safe + '.diff'), diff);
}

console.log(summary.join('\n'));
console.log(failed === 0 ? '\nALL PAGES DOM-EQUIVALENT ✓' : `\n${failed}/${PAGES.length} pages differ — diffs in ${OUTDIR}`);
