/*
 * DOM regression diff: every prerendered page of the baseline build vs the
 * current build. Both sides are SvelteKit builds, so normalisation is only
 * framework noise (scripts, hydration comments, the display:contents body
 * wrapper, hashed _app assets, svelte-xxxx scoped-class hashes, attribute
 * order/booleans, whitespace, document-relative URLs). <head> is included
 * (title, meta, non-_app links) so new stylesheet links show up.
 *
 * The allow-list (tools/regression-allowlist.json → "dom") is applied to the
 * parsed DOM *before* canonicalisation; whatever differs after that is a
 * regression. See tools/README.md for the rule format.
 */
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { globMatch, listPages, ensureDir } from './util.mjs';

const BOOL_ATTRS = new Set(['hidden', 'required', 'checked', 'disabled', 'novalidate', 'autoplay', 'muted', 'loop', 'playsinline', 'async', 'defer', 'selected', 'open', 'readonly', 'multiple', 'inert']);
const URL_ATTRS = new Set(['href', 'src', 'poster', 'action']);

function normStyle(v) {
	return v
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => s.replace(/\s*:\s*/, ': ').replace(/\s+/g, ' '))
		.join('; ');
}

function normUrl(v, pagePath) {
	if (!v || /^(https?:|mailto:|tel:|data:|#|javascript:)/.test(v)) return v;
	if (!v.startsWith('/')) v = path.posix.normalize(path.posix.join('/' + path.posix.dirname(pagePath), v));
	return v.replace(/\/_app\/immutable\/[^?#"']+/g, '/_app/immutable/X');
}

function normSrcset(v, pagePath) {
	return v
		.split(',')
		.map((part) => {
			const [u, ...rest] = part.trim().split(/\s+/);
			return [normUrl(u, pagePath), ...rest].join(' ');
		})
		.join(', ');
}

function canonAttrs(node, pagePath) {
	const attrs = { ...node.attribs };
	for (const k of Object.keys(attrs)) {
		if (BOOL_ATTRS.has(k)) attrs[k] = '';
		else if (k === 'style') attrs[k] = normStyle(attrs[k]);
		else if (URL_ATTRS.has(k)) attrs[k] = normUrl(attrs[k], pagePath);
		else if (k === 'srcset') attrs[k] = normSrcset(attrs[k], pagePath);
		else if (k === 'class') attrs[k] = attrs[k].replace(/\bsvelte-[a-z0-9]+\b/g, 'svelte-H').replace(/\s+/g, ' ').trim();
	}
	if (node.name === 'input' && attrs.value === '') delete attrs.value;
	if (attrs.class === '') delete attrs.class;
	return Object.keys(attrs)
		.sort()
		.map((k) => `${k}=${JSON.stringify(attrs[k])}`)
		.join(' ');
}

function canonBody($, el, out, depth, pagePath) {
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
		if (name === 'link' && /(^|\s)(modulepreload|preload)(\s|$)/.test(node.attribs.rel || '')) continue;
		if (name === 'div' && (node.attribs.style || '').replace(/\s|;/g, '') === 'display:contents') {
			canonBody($, node, out, depth, pagePath);
			continue;
		}
		const attrStr = canonAttrs(node, pagePath);
		out.push('  '.repeat(depth) + '<' + name + (attrStr ? ' ' + attrStr : '') + '>');
		if (name === 'noscript') {
			const t = $(node).text().replace(/\s+/g, ' ').trim().replace(/\/_app\/immutable\/[^"']+/g, '/_app/immutable/X');
			if (t) out.push('  '.repeat(depth + 1) + JSON.stringify(t));
			continue;
		}
		canonBody($, node, out, depth + 1, pagePath);
	}
}

function canonHead($, pagePath) {
	const out = [];
	$('head')
		.children()
		.each((_, el) => {
			const name = el.name;
			if (name === 'script' || name === 'style') return;
			if (name === 'link') {
				const rel = el.attribs.rel || '';
				if (/modulepreload|preload/.test(rel)) return;
				if (/\/_app\/immutable\//.test(normUrl(el.attribs.href || '', pagePath))) return; // hashed component CSS
			}
			if (name === 'title') return out.push('HEAD <title> ' + JSON.stringify($(el).text()));
			if (name === 'noscript') return out.push('HEAD <noscript> ' + JSON.stringify(($(el).html() || '').replace(/\s+/g, ' ').trim()));
			out.push('HEAD <' + name + ' ' + canonAttrs(el, pagePath) + '>');
		});
	return out;
}

function ruleApplies(rule, page) {
	const pats = rule.pages || ['**'];
	return pats.some((g) => globMatch(g, page)) && !(rule.exceptPages || []).some((g) => globMatch(g, page));
}

/** Apply allow-list rules to one side's DOM; returns per-rule match counts. */
function applyRules($, rules, side, page) {
	const counts = {};
	for (const rule of rules) {
		if (!ruleApplies(rule, page)) continue;
		const ruleSide = rule.side || 'both';
		if (ruleSide !== 'both' && ruleSide !== side) {
			// still count on the other side, to flag "added" selectors that exist in the baseline
			counts[rule.id] = { other: $(rule.selector).length };
			continue;
		}
		const els = $(rule.selector);
		counts[rule.id] = { n: els.length };
		els.each((_, el) => {
			const $el = $(el);
			switch (rule.action || 'remove') {
				case 'remove':
					$el.remove();
					break;
				case 'unwrap':
					$el.replaceWith($el.contents());
					break;
				case 'ignore-attrs':
					for (const a of rule.attrs || []) $el.removeAttr(a);
					break;
				case 'ignore-text':
					$el.text('«text allow-listed: ' + rule.id + '»');
					break;
				case 'ignore-children':
					$el.empty().text('«children allow-listed: ' + rule.id + '»');
					break;
				case 'sort-children': {
					// order of the children is allow-listed (e.g. PIN moved before City); content is still compared
					const kids = $el.children().toArray();
					kids.sort((x, y) => ($.html(x) < $.html(y) ? -1 : $.html(x) > $.html(y) ? 1 : 0));
					$el.empty();
					for (const k of kids) $el.append(k);
					break;
				}
				case 'ignore-classes':
					for (const c of rule.classes || []) $el.removeClass(c);
					break;
				default:
					throw new Error(`unknown dom action ${rule.action} in rule ${rule.id}`);
			}
		});
	}
	return counts;
}

function canonical(file, rules, side, page) {
	const $ = cheerio.load(fs.readFileSync(file, 'utf8'));
	const counts = applyRules($, rules, side, page);
	const out = canonHead($, page);
	canonBody($, $('body')[0], out, 0, page);
	return { text: out.join('\n') + '\n', counts };
}

/**
 * @param {{baseDir: string, curDir: string, allow: any, outDir: string}} o
 * @returns {{ok: boolean, pages: any[], newPages: any[], missingPages: string[], ruleUse: any, warnings: string[]}}
 */
export function runDomDiff({ baseDir, curDir, allow, outDir }) {
	const cfg = allow.dom || {};
	const rules = cfg.rules || [];
	const ids = new Set();
	for (const r of rules) {
		if (!r.id || !r.selector || !r.reason) throw new Error(`dom rule needs id, selector and reason: ${JSON.stringify(r)}`);
		if (ids.has(r.id)) throw new Error(`duplicate dom rule id ${r.id}`);
		ids.add(r.id);
	}
	ensureDir(outDir);
	const basePages = listPages(baseDir);
	const curPages = listPages(curDir);
	const warnings = [];
	const newPages = [];
	for (const p of curPages.filter((p) => !basePages.includes(p))) {
		const entry = (cfg.newPages || []).find((e) => globMatch(e.page, p));
		newPages.push({ page: p, allowed: !!entry, reason: entry?.reason || null });
	}
	const missingPages = basePages.filter((p) => !curPages.includes(p) && !(cfg.removedPages || []).some((e) => globMatch(e.page, p)));
	const ruleUse = Object.fromEntries(rules.map((r) => [r.id, { baseline: 0, current: 0, pages: 0, alsoInBaseline: 0, applied: 0 }]));
	const pages = [];
	for (const page of basePages.filter((p) => curPages.includes(p))) {
		if ((cfg.skipPages || []).some((e) => globMatch(e.page, page))) {
			pages.push({ page, status: 'skipped' });
			continue;
		}
		for (const r of rules) if (ruleApplies(r, page)) ruleUse[r.id].applied++;
		const a = canonical(path.join(baseDir, page), rules, 'baseline', page);
		const b = canonical(path.join(curDir, page), rules, 'current', page);
		for (const [id, c] of Object.entries(a.counts)) {
			if (c.n !== undefined) ruleUse[id].baseline += c.n;
		}
		for (const [id, c] of Object.entries(b.counts)) {
			if (c.n !== undefined) {
				ruleUse[id].current += c.n;
				if (c.n) ruleUse[id].pages++;
			}
		}
		// "added" rules (side: current) whose selector also matches the baseline page
		for (const [id, c] of Object.entries(a.counts)) {
			if (c.other) ruleUse[id].alsoInBaseline += c.other;
		}
		const safe = page.replace(/\//g, '__');
		const fa = path.join(outDir, safe + '.baseline.txt');
		const fb = path.join(outDir, safe + '.current.txt');
		fs.writeFileSync(fa, a.text);
		fs.writeFileSync(fb, b.text);
		if (a.text === b.text) {
			pages.push({ page, status: 'ok' });
			continue;
		}
		let diff = '';
		try {
			execFileSync('diff', ['-u', fa, fb]);
		} catch (e) {
			diff = e.stdout.toString();
		}
		const changed = diff.split('\n').slice(2).filter((l) => /^[-+]/.test(l)).length;
		fs.writeFileSync(path.join(outDir, safe + '.diff'), diff);
		pages.push({ page, status: 'diff', changed, diffFile: path.join(outDir, safe + '.diff'), excerpt: diff.split('\n').slice(2, 42).join('\n') });
	}
	for (const r of rules) {
		const u = ruleUse[r.id];
		const side = r.side || 'both';
		const n = side === 'baseline' ? u.baseline : u.current;
		if (u.applied > 0 && n === 0 && !r.optional) warnings.push(`dom rule "${r.id}" matched nothing (stale? set "optional": true if it is conditional)`);
		if (side === 'current' && (r.action || 'remove') === 'remove' && u.alsoInBaseline > 0)
			warnings.push(`dom rule "${r.id}" is an addition (side: current) but its selector also matches ${u.alsoInBaseline} baseline element(s): narrow it`);
	}
	for (const e of cfg.newPages || []) {
		if (!e.optional && !newPages.some((p) => globMatch(e.page, p.page))) warnings.push(`dom newPages entry "${e.page}" matched no new page`);
	}
	const ok = pages.every((p) => p.status !== 'diff') && newPages.every((p) => p.allowed) && missingPages.length === 0;
	return { ok, pages, newPages, missingPages, ruleUse, warnings };
}
