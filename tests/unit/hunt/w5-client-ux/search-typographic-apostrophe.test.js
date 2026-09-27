/*
 * iPhone/iPad keyboards (Smart Punctuation, on by default) and macOS autocorrect type ’ (U+2019) for an
 * apostrophe. The search overlay (a plain type=text input) passes the query straight to searchCatalog,
 * which matches it with indexOf against the product name "Choco's" (ASCII '). So typing the product's
 * own name on an iPhone — "Choco’s" — finds nothing: "No matches — try “muesli” or “oats”".
 * Run: npx vitest run tests/unit/hunt/w5-client-ux/search-typographic-apostrophe.test.js
 */
import { describe, it, expect } from 'vitest';
import { searchCatalog } from '$lib/search.js';

const labels = (q) => searchCatalog(q).map((i) => i.label);

describe('search: the product name as an iPhone keyboard types it', () => {
	it('control: "choco\'s" (ASCII apostrophe) finds Choco\'s', () => {
		expect(labels("choco's")[0]).toBe("Choco's");
	});

	it('"Choco’s" (U+2019, iOS Smart Punctuation) finds Choco\'s too', () => {
		expect(labels('Choco’s')).toContain("Choco's");
	});

});
