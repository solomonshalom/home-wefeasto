/*
 * Shared axe helpers for the a11y smoke (a11y.spec.js) and the baseline scanner
 * (a11y-scan.mjs). Only `serious` and `critical` violations are kept. A violation node
 * is identified by rule id + a normalised selector, and also by rule id + a normalised
 * HTML snippet, so that a node the pre-Phase-2 build already had is recognised even when
 * a new sibling shifts its :nth-child index.
 */
import AxeBuilder from '@axe-core/playwright';

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
export const SEVERE = new Set(['serious', 'critical']);

/** Pages the pre-Phase-2 build also had (same paths), scanned for the baseline. */
export const BASELINE_PAGES = {
	home: { path: '/' },
	shop: { path: '/shop' },
	pdp: { path: '/products/muesli' },
	cart: { path: '/cart', bag: { muesli: 1, cornflakes: 2 } },
	checkout: { path: '/checkout', bag: { muesli: 1, cornflakes: 2 } },
	login: { path: '/login' },
	// Pre-Phase-2 UI in an open state: the search overlay with results for "oat".
	search: { path: '/', state: 'search' },
	// The old checkout after "Place order" on an empty form (its validation state).
	'checkout-errors': { path: '/checkout', bag: { muesli: 1, cornflakes: 2 }, state: 'submit-empty' }
};

/** Put a page into a named state before scanning (same steps on the old and new build). */
export async function applyState(page, state) {
	if (state === 'search') {
		await page.waitForFunction(() => !!document.querySelector('.navbar .wf-search-open'));
		await page.waitForFunction(() => {
			const b = document.querySelector('.div-block-79 .wf-cart-count');
			return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
		});
		await page.locator('.navbar .wf-search-open').click();
		await page.locator('.wf-search-input').waitFor({ state: 'visible' });
		await page.locator('.wf-search-input').fill('oat');
		await page.locator('.wf-search-card').first().waitFor({ state: 'visible' });
	} else if (state === 'submit-empty') {
		await page.waitForFunction(() => {
			const b = document.querySelector('.div-block-79 .wf-cart-count');
			return !!b && (b.classList.contains('wf-is-hidden') || b.textContent.trim() !== '');
		});
		await page.locator('#wf-place-order').click();
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	} else if (state) {
		throw new Error(`unknown a11y state ${state}`);
	}
}

const normTarget = (t) =>
	(Array.isArray(t) ? t.flat().join(' ') : String(t))
		.replace(/\.svelte-[a-z0-9]+/gi, '')
		.replace(/\s+/g, ' ')
		.trim();
const normHtml = (h) =>
	String(h || '')
		.replace(/\s(class|style|data-[\w-]+|aria-[\w-]+|id|href|src|srcset)="[^"]*"/g, '')
		.replace(/\s+/g, ' ')
		.slice(0, 160);

export const nodeKeys = (ruleId, node) => [`${ruleId}|t|${normTarget(node.target)}`, `${ruleId}|h|${normHtml(node.html)}`];

/** Run axe once the page has settled (fonts, two frames); serious/critical only. */
export async function scanPage(page, { exclude = [] } = {}) {
	await page.evaluate(async () => {
		await document.fonts?.ready;
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	let builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
	for (const sel of exclude) builder = builder.exclude(sel);
	const r = await builder.analyze();
	return r.violations
		.filter((v) => SEVERE.has(v.impact))
		.map((v) => ({
			id: v.id,
			impact: v.impact,
			help: v.help,
			nodes: v.nodes.map((n) => ({ target: normTarget(n.target), html: String(n.html).slice(0, 200), summary: (n.failureSummary || '').split('\n').slice(0, 3).join(' ') }))
		}));
}

/** Every key of a baseline file (all pages), plus per page. */
export function baselineKeys(baseline) {
	const all = new Set();
	const perPage = {};
	for (const [name, violations] of Object.entries(baseline.pages || {})) {
		const s = new Set();
		for (const v of violations) for (const n of v.nodes) for (const k of nodeKeys(v.id, n)) (s.add(k), all.add(k));
		perPage[name] = s;
	}
	return { all, perPage };
}

/**
 * Split a scan into [pre-existing, new] nodes against the baseline: a node is pre-existing
 * when the same page of the baseline (or, for pages the old build did not have, any
 * baseline page — the shared nav/footer) has the same rule on the same selector or HTML.
 */
export function splitNew(scan, keys, pageName) {
	const known = keys.perPage[pageName] ?? keys.all;
	const pre = [];
	const fresh = [];
	for (const v of scan) {
		for (const n of v.nodes) {
			const item = { id: v.id, impact: v.impact, help: v.help, target: n.target, html: n.html, summary: n.summary };
			(nodeKeys(v.id, n).some((k) => known.has(k) || (!keys.perPage[pageName] && keys.all.has(k))) ? pre : fresh).push(item);
		}
	}
	return { pre, fresh };
}
