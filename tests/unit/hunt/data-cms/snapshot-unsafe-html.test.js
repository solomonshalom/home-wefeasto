/*
 * HUNT data-cms: the storefront's own gate (validateSnapshot, which sync-cms and the seed run) accepts
 * recipe/page HTML that executes script once rendered with {@html} on the prerendered pages.
 * It mirrors the CMS's UNSAFE_HTML_RE (same bypasses; see cms/tests/unit/hunt-data-cms-safe-html.test.ts),
 * so a recipe saved in the CMS with <svg/onload=…> is synced and built into /recipes/<slug>.html.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { validateSnapshot } from '$lib/data/snapshot-schema.js';

const committed = JSON.parse(fs.readFileSync(new URL('../../../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));

const EXECUTABLE = [
	'<svg/onload=alert(1)>',
	'<img src=x/onerror=alert(1)>',
	'<details/open/ontoggle=alert(1)>',
	'<a href="jav&#x61;script:alert(1)">x</a>',
	'<a href="javascript&colon;alert(1)">x</a>',
	'<a href="java\tscript:alert(1)">x</a>'
];

describe('validateSnapshot refuses recipe HTML that executes script', () => {
	it('the committed snapshot is valid (baseline)', () => {
		expect(validateSnapshot(committed).ok).toBe(true);
	});

	it.each(EXECUTABLE)('whyHtml + %s', (payload) => {
		const s = structuredClone(committed);
		s.recipes[0].whyHtml += payload;
		const { ok, errors } = validateSnapshot(s);
		expect(ok, `accepted: ${payload}`).toBe(false);
		expect(errors.join('\n')).toMatch(/recipes\[0\]\.whyHtml/);
	});
});
