/*
 * HUNT data-cms (round 2): the storefront's own gate (validateSnapshot, run by sync-cms and the seed)
 * mirrors the CMS's UNSAFE_HTML_RE and has the same gap: a javascript: URL whose letters are written as
 * numeric references to their UPPER-CASE forms (&#74; = "J", &#x41; = "A") is not recognised, although
 * URL schemes are case-insensitive and the browser runs it (see
 * cms/tests/unit/hunt-data-cms-uppercase-entity.test.ts). Such a recipe is synced and built verbatim
 * into /recipes/<slug>.html through {@html}.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { validateSnapshot } from '$lib/data/snapshot-schema.js';

const committed = JSON.parse(fs.readFileSync(new URL('../../../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));

const EXECUTABLE = [
	'<a href="&#74;avascript:alert(1)">x</a>',
	'<a href="&#x4A;avascript:alert(1)">x</a>',
	'<a href="jav&#65;script:alert(1)">x</a>',
	'<a href="JAV&#x41;SCRIPT:alert(1)">x</a>'
];

describe('validateSnapshot refuses javascript: spelled with upper-case character references', () => {
	it.each(EXECUTABLE)('whyHtml + %s', (payload) => {
		const s = structuredClone(committed);
		s.recipes[0].whyHtml += payload;
		const { ok, errors } = validateSnapshot(s);
		expect(ok, `accepted: ${payload}`).toBe(false);
		expect(errors.join('\n')).toMatch(/recipes\[0\]\.whyHtml/);
	});
});
