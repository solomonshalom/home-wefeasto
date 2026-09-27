/*
 * Structural guarantees of cms/src/commerce/shared: pure ESM, zero
 * dependencies, browser-safe, deterministic, explicit '.js' imports, and an
 * index that re-exports every module.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as index from '$shared/index.js';
import * as viaRelative from '../../../cms/src/commerce/shared/index.js';
import * as settings from '$shared/settings.js';
import * as money from '$shared/money.js';
import * as qty from '$shared/qty.js';
import * as validate from '$shared/validate.js';
import * as pricing from '$shared/pricing.js';
import * as coupons from '$shared/coupons.js';
import * as cartLinks from '$shared/cart-links.js';
import * as errors from '$shared/errors.js';
import * as orderStatus from '$shared/order-status.js';

const MODULES = {
	'settings.js': settings,
	'money.js': money,
	'qty.js': qty,
	'validate.js': validate,
	'pricing.js': pricing,
	'coupons.js': coupons,
	'cart-links.js': cartLinks,
	'errors.js': errors,
	'order-status.js': orderStatus
};

const DIR = resolve(__dirname, '../../../cms/src/commerce/shared');
const files = readdirSync(DIR).filter((f) => f.endsWith('.js'));
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1'); // drop comments

describe('module hygiene', () => {
	it('has the modules SPEC §5 asks for', () => {
		for (const m of ['money.js', 'qty.js', 'validate.js', 'pricing.js', 'coupons.js', 'cart-links.js', 'errors.js', 'order-status.js', 'index.js', 'settings.js']) {
			expect(files).toContain(m);
		}
	});

	it.each(files)('%s: relative imports only, with explicit .js, to files that exist', (f) => {
		const src = readFileSync(join(DIR, f), 'utf8');
		const specs = [...src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		for (const s of specs) {
			expect(s.startsWith('./'), `${f} imports ${s}`).toBe(true);
			expect(s.endsWith('.js'), `${f} imports ${s}`).toBe(true);
			expect(existsSync(join(DIR, s))).toBe(true);
		}
		expect(strip(src)).not.toMatch(/\bimport\s*\(/); // no dynamic imports (JSDoc import() types are fine)
	});

	it.each(files)('%s: no Node-only APIs, globals or clock/randomness', (f) => {
		const code = strip(readFileSync(join(DIR, f), 'utf8'));
		for (const [re, why] of [
			[/\brequire\s*\(/, 'require()'],
			[/['"]node:/, 'node: import'],
			[/\bprocess\.(env|argv|exit|nextTick|platform|versions|cwd|hrtime)\b/, 'process'],
			[/\bBuffer\b/, 'Buffer'],
			[/\b__dirname\b|\b__filename\b/, 'CommonJS globals'],
			[/\bDate\.now\s*\(/, 'Date.now()'],
			[/new Date\(\s*\)/, 'new Date() without an argument'],
			[/\bperformance\.now/, 'performance.now'],
			[/\bMath\.random\b/, 'Math.random'],
			[/\bcrypto\.|\bfrom\s+['"]crypto/, 'crypto'],
			[/\b(window|document|globalThis|self)\.[A-Za-z_$]|\b(localStorage|sessionStorage|navigator)\b/, 'browser globals'],
			[/\bIntl\.|\.toLocale[A-Za-z]*\(/, 'locale-dependent formatting'],
			[/\bconsole\./, 'console']
		]) {
			expect(re.test(code), `${f} uses ${why}`).toBe(false);
		}
	});

	it('source files contain no invisible or bidi control characters', () => {
		for (const f of files) {
			const src = readFileSync(join(DIR, f), 'utf8');
			expect(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), f).toBe(false);
		}
	});

	it('index re-exports every export of every module (no name clashes)', () => {
		expect(Object.keys(MODULES).sort()).toEqual(files.filter((x) => x !== 'index.js').sort()); // register new modules above
		const seen = new Map();
		for (const [f, mod] of Object.entries(MODULES)) {
			for (const [k, v] of Object.entries(mod)) {
				expect(seen.has(k), `${k} exported by ${seen.get(k)} and ${f}`).toBe(false);
				seen.set(k, f);
				expect(index[k], `index is missing ${k} from ${f}`).toBe(v);
			}
		}
		expect(Object.keys(index).sort()).toEqual([...seen.keys()].sort());
	});

	it('the $shared alias and the relative path resolve to the same module instance', () => {
		expect(viaRelative.quote).toBe(index.quote);
		expect(viaRelative.PUBLIC_SETTINGS_DEFAULTS).toBe(index.PUBLIC_SETTINGS_DEFAULTS);
	});
});
