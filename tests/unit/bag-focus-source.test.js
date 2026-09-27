/*
 * Bag controls that remove or disable themselves keep keyboard focus on the
 * page (hunt a11y-motion bag-focus; behaviour: e2e/full/hunt/a11y-motion/
 * bag-focus.spec.js, helper: tests/unit/focus.test.js). These source checks
 * keep the wiring from quietly coming undone:
 * - /cart: the undo row's expiry and the offer chip's × go through keepFocus;
 *   "+" at the per-order cap is aria-disabled (focusable), never `disabled`;
 * - TopUp (+ Add / ×) and "Your usual" (Add all / ×) go through keepFocus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Body of `function name(` … up to the next top-level `\n\t}` (Svelte script indentation). */
function fn(text, name) {
	const start = text.indexOf(`function ${name}(`);
	expect(start, `function ${name} exists`).toBeGreaterThan(-1);
	return text.slice(start, text.indexOf('\n\t}', start) + 3);
}

describe('/cart', () => {
	const cart = src('src/routes/cart/+page.svelte');

	it('"+" at the cap is aria-disabled with a no-op click, never disabled', () => {
		const plus = cart.match(/<button[^<]*data-wf-qty-plus[\s\S]*?>\+<\/button>/)[0];
		expect(plus).toContain("aria-disabled={n >= capOf(row.slug) ? 'true' : undefined}");
		expect(plus).not.toMatch(/\sdisabled=/);
		expect(plus).toContain('if (n < capOf(row.slug)) setQty(row.slug, n + 1)');
	});

	it('the undo row expiring hands focus to a neighbour row or a heading', () => {
		const body = fn(cart, 'expireUndo');
		expect(body).toContain('keepFocus(');
		expect(body).toMatch(/firstTabbable\(next\), firstTabbable\(prev\), \.\.\.bagHeadings\(\)/);
		expect(fn(cart, 'bagHeadings')).toContain('.wf-summary-heading');
	});

	it('removing the offer chip keeps focus', () => {
		expect(fn(cart, 'removeOffer')).toMatch(/keepFocus\(\s*e\.currentTarget\.closest\('\[data-wf-offer\]'\)/);
	});

	it('the CSS styles an aria-disabled "+" like a disabled one', () => {
		const css = src('static/css/wefeasto.css');
		expect(css).toMatch(/\.wf-qty-btn:disabled,\s*\.wf-qty-btn\[aria-disabled="true"\]\s*\{[^}]*opacity:\s*\.35/);
	});
});

describe('TopUp', () => {
	const topup = src('src/lib/components/TopUp.svelte');

	it.each(['add', 'skip'])('%s goes through keepFocus, landing on the note, the meter or the block', (name) => {
		expect(fn(topup, name)).toMatch(/keepFocus\(\s*e\.currentTarget\.closest\('\.wf-topup'\)/);
		expect(topup).toContain("const focusTargets = () => [block?.querySelector('[data-wf-topup-note]'), block?.querySelector('.wf-meter'), block];");
		expect(topup).toContain('<div class="wf-topup-block" bind:this={block}>');
	});
});

describe('YourUsual', () => {
	const usual = src('src/lib/components/YourUsual.svelte');

	it('Add all and × leave through keepFocus to the nearest heading before the card', () => {
		expect(fn(usual, 'leave')).toContain('keepFocus(card, change, () => [...before, document.querySelector(\'h1\')])');
		expect(fn(usual, 'addAll')).toContain('leave(e, ');
		expect(fn(usual, 'dismiss')).toContain('leave(e, ');
	});
});
