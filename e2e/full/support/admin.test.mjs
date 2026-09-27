/*
 * Unit tests for AdminClient.messageLog() against an in-process fake of Payload's REST list
 * endpoint (no stack needed): `where[and][i][key][like]` = ILIKE '%word%' per space-separated
 * word (as @payloadcms/drizzle does), sort=createdAt, limit/page, hasNextPage.
 * The real-stack counterpart is admin.spec.js (same folder).
 *
 * Run: node --test e2e/full/support/admin.test.mjs   (or npm run test:e2e:harness)
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AdminSession, AdminClient, orderKeyPattern } from './admin.js';

const CMS = 'http://cms.test';
let rows;
let requests;
let realFetch;

/** Payload-shaped list response for GET /api/message-log?… over `rows`. */
function listMessageLog(url) {
	const p = url.searchParams;
	const likes = [...p.entries()].filter(([k]) => /^where(\[and\]\[\d+\])?\[key\]\[like\]$/.test(k)).map(([, v]) => v);
	const ilike = (key, word) => {
		const re = new RegExp('^' + ('%' + word + '%').split('').map((c) => (c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$', 'is');
		return re.test(key);
	};
	let docs = rows.filter((r) => likes.every((v) => v.split(' ').every((w) => ilike(r.key, w))));
	assert.equal(p.get('sort'), 'createdAt');
	docs = [...docs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const limit = Number(p.get('limit') ?? 10);
	const page = Number(p.get('page') ?? 1);
	const slice = docs.slice((page - 1) * limit, page * limit);
	return { docs: slice, totalDocs: docs.length, limit, page, hasNextPage: page * limit < docs.length, nextPage: page * limit < docs.length ? page + 1 : null };
}

beforeEach(() => {
	rows = [];
	requests = [];
	realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(String(input));
		requests.push({ method: init.method ?? 'GET', url });
		const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
		if (url.pathname === '/api/users/login') return json(200, { token: 't0k' });
		if (url.pathname === '/api/message-log') {
			assert.equal(init.headers?.Authorization, 'JWT t0k');
			return json(200, listMessageLog(url));
		}
		return json(404, { errors: [{ message: `not faked: ${url.pathname}` }] });
	};
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const admin = () => new AdminClient(new AdminSession({ cmsUrl: CMS, admin: { email: 'a@x.test', password: 'p' } }));
let seq = 0;
const row = (key) => ({ id: ++seq, key, status: 'sent', createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString() });
const keys = (docs) => docs.map((d) => d.key);
const logGets = () => requests.filter((r) => r.url.pathname === '/api/message-log');

test('finds a new order behind more than 100 older rows (PI-ORD-H1)', async () => {
	for (let i = 0; i < 250; i++) rows.push(row(`confirm:WF-${20000 + i}`));
	rows.push(row('confirm:WF-10003'), row('ship:WF-10003'), row('refill:WF-10003:1'), row('refill-queue:WF-10003:1:h0'));
	const got = await admin().messageLog({ order: 'WF-10003' });
	assert.deepEqual(keys(got), ['confirm:WF-10003', 'ship:WF-10003', 'refill:WF-10003:1', 'refill-queue:WF-10003:1:h0']);
	// The order number is sent to the server (not filtered client-side over a fixed window).
	assert.equal(logGets()[0].url.searchParams.get('where[and][0][key][like]'), 'WF-10003');
});

test('matches the order number as a whole segment: WF-1009 is not WF-10092 / WF-10090', async () => {
	rows.push(row('confirm:WF-10092'), row('confirm:WF-1009'), row('refill:WF-10090:1'), row('refill:WF-1009:1'), row('refill-queue:WF-1009:1:h2'));
	assert.deepEqual(keys(await admin().messageLog({ order: 'WF-1009' })), ['confirm:WF-1009', 'refill:WF-1009:1', 'refill-queue:WF-1009:1:h2']);
	assert.deepEqual(keys(await admin().messageLog({ order: 'WF-10092' })), ['confirm:WF-10092']);
	assert.deepEqual(await admin().messageLog({ order: 'WF-99999' }), []);
});

test('order + keyPrefix are both sent (and-ed) and keyPrefix is a real prefix', async () => {
	rows.push(row('refill:WF-10003:1'), row('refill-queue:WF-10003:1:h0'), row('confirm:WF-10003'), row('x-refill:WF-10003'));
	const got = await admin().messageLog({ order: 'WF-10003', keyPrefix: 'refill:' });
	assert.deepEqual(keys(got), ['refill:WF-10003:1']);
	const p = logGets()[0].url.searchParams;
	assert.equal(p.get('where[and][0][key][like]'), 'WF-10003');
	assert.equal(p.get('where[and][1][key][like]'), 'refill:');
	assert.deepEqual(keys(await admin().messageLog({ keyPrefix: 'refill' })), ['refill:WF-10003:1', 'refill-queue:WF-10003:1:h0']);
});

test('reads every page (oldest first, no duplicates) when more rows match than one page holds', async () => {
	for (let i = 0; i < 1203; i++) rows.push(row(`newsletter-confirm:p${i}@x.test:${i}`));
	const got = await admin().messageLog({ keyPrefix: 'newsletter-confirm:' });
	assert.equal(got.length, 1203);
	assert.equal(new Set(got.map((d) => d.id)).size, 1203);
	assert.equal(got[0].key, 'newsletter-confirm:p0@x.test:0');
	assert.equal(got.at(-1).key, 'newsletter-confirm:p1202@x.test:1202');
	assert.deepEqual(logGets().map((r) => r.url.searchParams.get('page')), ['1', '2', '3']);
});

test('no filter → every row; regex escapes the order number', async () => {
	rows.push(row('confirm:WF-1'), row('welcome:a@x.test'));
	assert.equal((await admin().messageLog()).length, 2);
	assert.equal(logGets()[0].url.search.includes('where'), false);
	assert.ok(orderKeyPattern('WF-1.0').test('confirm:WF-1.0'));
	assert.ok(!orderKeyPattern('WF-1.0').test('confirm:WF-1x0'));
});
