/*
 * Recipe grids between 480 and 767px (hunt client-ux recipes-horizontal-scroll-480-560).
 * webflow.css keeps `.grid-6._2` three-up down to 480px (its <=991px two-up reset is on the
 * one-class `.grid-6`, which the two-class selector outranks), so three recipe cards + two 42px
 * gaps widened /recipes and every recipe page past a 480-560px screen. wefeasto.css makes the
 * grid two equal minmax(0, 1fr) tracks in that band only; /order's own two-up grid still wins.
 * The layouts themselves are measured in e2e/ui/recipes-widths.spec.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ROOT } from '../data/fixtures.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** CSS with comments removed and whitespace collapsed, for rule matching. */
const flat = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

/** Every `@media <query> { … }` block (top level) of a flattened stylesheet, with its body. */
function mediaBlocks(css) {
	const out = [];
	const re = /@media ([^{]+)\{/g;
	let m;
	while ((m = re.exec(css))) {
		let depth = 1;
		let i = re.lastIndex;
		for (; i < css.length && depth; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
		out.push({ query: m[1].trim(), body: css.slice(re.lastIndex, i - 1), start: m.index, end: i });
		re.lastIndex = i;
	}
	return out;
}

const wefeasto = flat(read('static/css/wefeasto.css'));
const webflow = flat(read('static/css/webflow.css'));
const checkout = flat(read('static/css/wf-checkout.css'));
const BAND = 'screen and (min-width: 480px) and (max-width: 767px)';
const RULE = '.grid-6._2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }';

describe('.grid-6._2 between 480 and 767px', () => {
	it("premise: webflow.css keeps .grid-6._2 three-up until its <=479px block", () => {
		expect(webflow).toContain('.grid-6._2 { grid-template-columns: 1fr 1fr 1fr; grid-auto-flow: row; }');
		const blocks = mediaBlocks(webflow);
		const tablet = blocks.find((b) => b.query === 'screen and (max-width: 991px)' && b.body.includes('.grid-6 {'));
		expect(tablet.body).not.toContain('.grid-6._2');
		const phone = blocks.find((b) => b.query === 'screen and (max-width: 479px)' && b.body.includes('.grid-6._2'));
		expect(phone.body).toContain('.grid-6._2 { grid-template-columns: 1fr; }');
	});

	it('wefeasto.css makes it two equal minmax(0, 1fr) tracks in the 480-767px band', () => {
		const band = mediaBlocks(wefeasto).filter((b) => b.query === BAND && b.body.includes('.grid-6._2'));
		expect(band).toHaveLength(1);
		expect(band[0].body).toContain(RULE);
	});

	it('and nowhere else: below 480px and from 768px Webflow layout is untouched', () => {
		const inBand = mediaBlocks(wefeasto).filter((b) => b.query === BAND);
		let rest = wefeasto;
		for (const b of inBand) rest = rest.replace(wefeasto.slice(b.start, b.end), '');
		expect(rest).not.toMatch(/\.grid-6\._2/);
	});

	it("/order's recipe grid keeps its own two-up rule: same specificity, stylesheet linked after wefeasto.css", () => {
		expect(checkout).toMatch(/@media screen and \(min-width: 480px\) \{ \.grid-6\.wf-order-recipe-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); max-width: 760px;/);
		const app = read('src/app.html');
		expect(app.indexOf('/css/wf-checkout.css')).toBeGreaterThan(app.indexOf('/css/wefeasto.css'));
		expect(app.indexOf('/css/wefeasto.css')).toBeGreaterThan(app.indexOf('/css/webflow.css'));
	});

	it('every page grid that uses it is a recipe / card grid that fits two-up', () => {
		const users = ['src/routes/recipes/+page.svelte', 'src/routes/recipes/[slug]/+page.svelte', 'src/lib/components/NotFound.svelte'];
		for (const f of users) expect(read(f), f).toMatch(/class="grid-6 _2[" ]/);
	});
});
