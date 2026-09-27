/*
 * Soft (secondary) text keeps WCAG 1.4.3 AA contrast under every "Mix colors"
 * combination. Softness comes from a solid grey, never from `opacity` on #333:
 * faded text blends with whatever surface is behind it, and the colour mix can
 * put any of the four palette surfaces on the page (blush #ffdede in every
 * S4/S5/S6 combo), where `#333 @ .7` is only 4.43:1.
 *
 * - "Placed <date>" on /account (.wf-order-date, wf-account.css) and the
 *   GeoNames PIN credit on /checkout (.wf-pin-credit, wf-checkout.css) use
 *   #595959, which is no palette colour, so the mix leaves it alone.
 * - Any other faded text rule in wf-account.css must still clear 4.5:1 on
 *   every surface (disabled controls and the 0-opacity honeypot are exempt).
 * The rendered pages under combo A1-S4 are e2e/full/hunt/a11y-motion/colormix-contrast.spec.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const COMBOS = JSON.parse(read('static/color-combos.json'));

const BODY_TEXT = '#333333'; // the site's text colour (wefeasto.css body, .wf-form-note)
const AA = 4.5;

/** #rgb / #rrggbb → [r, g, b] (0-255). */
function rgb(hex) {
	let h = hex.trim().toLowerCase().replace('#', '');
	if (h.length === 3) h = [...h].map((c) => c + c).join('');
	if (!/^[0-9a-f]{6}$/.test(h)) throw new Error(`not a solid hex colour: ${hex}`);
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const norm = (hex) => '#' + rgb(hex).map((v) => v.toString(16).padStart(2, '0')).join('');
function luminance(c) {
	const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
	const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}
/** `fg` at `alpha` composited over the opaque `bg`. */
const blend = (fg, alpha, bg) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

/** Every surface the mix can put behind page text: the palette surfaces, where any combo moves them, plus white cards. */
const SURFACES = [
	...new Set([
		'#ffffff',
		...COMBOS.palette.surfaces.map((s) => norm(s.hex)),
		...COMBOS.surfaceArrangements.flatMap((a) => Object.values(a.moves).map(norm))
	])
];
/** Every colour the mix knows about (and so may remap). */
const MIX_COLOURS = new Set((JSON.stringify(COMBOS).match(/#[0-9a-f]{6}\b/gi) ?? []).map(norm));

/** Flat rules of a stylesheet: [{ selector, decls: { prop: value } }] (top-level and inside @media). */
function rules(css) {
	const out = [];
	const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
	for (const m of flat.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
		const decls = {};
		for (const d of m[2].split(';')) {
			const i = d.indexOf(':');
			if (i > 0) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim().toLowerCase();
		}
		out.push({ selector: m[1].trim().replace(/\s+/g, ' '), decls });
	}
	return out;
}
const ACCOUNT = rules(read('static/css/wf-account.css'));
const CHECKOUT = rules(read('static/css/wf-checkout.css'));
const rulesFor = (sheet, selector) => sheet.filter((r) => r.selector.split(',').map((s) => s.trim()).includes(selector));

describe('surfaces under the colour mix', () => {
	it('blush is among them, and faded #333 (the old styles) fails AA there', () => {
		expect(SURFACES).toContain('#ffdede');
		expect(SURFACES).toContain('#f9f4ef');
		expect(contrast(blend(rgb(BODY_TEXT), 0.7, rgb('#ffdede')), rgb('#ffdede'))).toBeLessThan(AA);
	});
});

describe.each([
	{ file: 'static/css/wf-account.css', sheet: ACCOUNT, selector: '.wf-order-date' },
	{ file: 'static/css/wf-checkout.css', sheet: CHECKOUT, selector: '.wf-pin-credit' }
])('$file $selector', ({ sheet, selector }) => {
	const found = rulesFor(sheet, selector);

	it('is softened by a solid colour, not opacity', () => {
		expect(found.length).toBeGreaterThan(0);
		for (const r of found) expect(r.decls).not.toHaveProperty('opacity');
		expect(found.some((r) => r.decls.color)).toBe(true);
	});

	it('uses a colour the mix never remaps, clearing AA on every surface', () => {
		const colour = found.map((r) => r.decls.color).filter(Boolean).at(-1);
		expect(MIX_COLOURS.has(norm(colour))).toBe(false);
		for (const s of SURFACES) {
			expect(contrast(rgb(colour), rgb(s)), `${colour} on ${s}`).toBeGreaterThanOrEqual(AA);
		}
	});
});

describe('faded text in wf-account.css', () => {
	const EXEMPT = /disabled|aria-busy/i; // inactive controls: WCAG 1.4.3 exempts them
	const faded = ACCOUNT.filter((r) => {
		const o = Number(r.decls.opacity);
		return r.decls.opacity !== undefined && o > 0 && o < 1 && !EXEMPT.test(r.selector);
	});

	it('clears AA on every surface the mix can put behind it', () => {
		for (const r of faded) {
			const alpha = Number(r.decls.opacity);
			const fg = rgb(r.decls.color ?? BODY_TEXT);
			for (const s of SURFACES) {
				const ratio = contrast(blend(fg, alpha, rgb(s)), rgb(s));
				expect(ratio, `${r.selector} (opacity ${alpha}) on ${s}`).toBeGreaterThanOrEqual(AA);
			}
		}
	});
});
