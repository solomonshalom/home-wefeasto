import { describe, it, expect } from 'vitest';
import { parseQty, clampQty, QTY_PARSE_MAX, DEFAULT_MAX_PER_ORDER, CART_QTY_CAP, LINK_QTY_MAX, LINK_MAX_LINES } from '$shared/qty.js';

describe('parseQty (strict)', () => {
	it.each([
		[1, 1],
		[3, 3],
		[10, 10],
		[9999, 9999],
		['1', 1],
		['12', 12],
		['9999', 9999],
		[3.0, 3] // indistinguishable from 3 in JS
	])('accepts %j → %s', (raw, out) => {
		expect(parseQty(raw)).toBe(out);
	});

	it.each([
		[0],
		[-1],
		[-0],
		[2.5],
		[NaN],
		[Infinity],
		[-Infinity],
		[2 ** 53],
		[10000], // > QTY_PARSE_MAX
		['0'],
		['00'],
		['03'],
		['-1'],
		['+1'],
		['2.5'],
		['2.0'],
		['1e3'],
		['0x10'],
		[' 3'],
		['3 '],
		['3\n'],
		[''],
		['99999'],
		['١٢'], // Arabic-Indic digits
		['１２'], // full-width digits
		[true],
		[false],
		[null],
		[undefined],
		[[]],
		[[3]],
		[{}],
		[new Number(3)]
	])('rejects %j', (raw) => {
		expect(parseQty(raw)).toBeNull();
	});

	it('rejects BigInt', () => {
		expect(parseQty(3n)).toBeNull();
	});

	it('never returns more than QTY_PARSE_MAX', () => {
		expect(QTY_PARSE_MAX).toBe(9999);
		for (let n = 1; n <= 20000; n += 37) {
			const v = parseQty(n);
			expect(v === null || v <= QTY_PARSE_MAX).toBe(true);
			expect(parseQty(String(n))).toBe(v);
		}
	});
});

describe('clampQty (lenient)', () => {
	it.each([
		[1, 10, 1],
		[5, 10, 5],
		[10, 10, 10],
		[11, 10, 10],
		[1e9, 10, 10],
		[Infinity, 10, 10],
		[2.9, 10, 2],
		['2', 10, 2],
		['2.7', 10, 2],
		['1e9', 10, 10],
		[' 4 ', 10, 4],
		['007', 10, 7],
		[25, 20, 20],
		[3, undefined, 3],
		[30, undefined, DEFAULT_MAX_PER_ORDER],
		[5, 0, 5], // invalid max → default 10
		[50, -3, 10]
	])('clampQty(%j, %j) → %s', (q, max, out) => {
		expect(clampQty(q, max)).toBe(out);
	});

	it.each([[0], [-1], [-5], [0.5], [NaN], [-Infinity], ['-5'], ['0'], ['abc'], ['0x10'], [''], [null], [undefined], [true], [{}], [[2]]])(
		'garbage %j → 0',
		(q) => {
			expect(clampQty(q, 10)).toBe(0);
		}
	);

	it('constants match the roadmap', () => {
		expect(DEFAULT_MAX_PER_ORDER).toBe(10);
		expect(CART_QTY_CAP).toBe(20);
		expect(LINK_QTY_MAX).toBe(10);
		expect(LINK_MAX_LINES).toBe(6);
	});
});
