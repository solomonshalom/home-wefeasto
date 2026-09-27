/*
 * scripts/sync-cms.mjs: pull the snapshot from the CMS, validate, write it
 * atomically in the canonical format, never churn git over generatedAt, and
 * honour CMS_SYNC / --force / CMS_REQUIRED. Pure parts are tested directly;
 * the CLI is also run for real against a local HTTP server.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { serializeSnapshot } from '$lib/data/snapshot-schema.js';
import {
	DEFAULT_CMS_URL,
	FETCH_TIMEOUT_MS,
	SNAPSHOT_FILE,
	flag,
	snapshotUrl,
	essentialErrors,
	checkSnapshot,
	planWrite,
	writeFileAtomic,
	fetchSnapshot,
	syncCms
} from '../../scripts/sync-cms.mjs';
import { ROOT, SNAPSHOT_PATH, snapshotCopy } from './data/fixtures.js';

const COMMITTED_TEXT = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
const STAMP = JSON.parse(COMMITTED_TEXT).generatedAt;
const LATER = '2031-01-02T03:04:05.678Z';

/** The committed snapshot as the CMS would serve it: a new generatedAt. */
const served = (mutate = (s) => s) => {
	const s = snapshotCopy();
	s.generatedAt = LATER;
	return mutate(s) ?? s;
};

/** Same data, every object's keys reversed (a CMS serializer with its own key order). */
function reverseKeys(v) {
	if (Array.isArray(v)) return v.map(reverseKeys);
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
	return v;
}

let tmp;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sync-'));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});
const tmpFile = (name = 'cms-snapshot.json', text = COMMITTED_TEXT) => {
	const f = path.join(tmp, name);
	if (text !== null) fs.writeFileSync(f, text);
	return f;
};
const leftovers = () => fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'));

describe('constants and helpers', () => {
	it('defaults: localhost:3000, 15 s, the committed file', () => {
		expect(DEFAULT_CMS_URL).toBe('http://localhost:3000');
		expect(FETCH_TIMEOUT_MS).toBe(15000);
		expect(SNAPSHOT_FILE).toBe(path.join(ROOT, 'src/lib/data/cms-snapshot.json'));
	});

	it.each([
		['1', true],
		['true', true],
		['TRUE', true],
		['yes', true],
		[' 1 ', true],
		['0', false],
		['', false],
		[undefined, false],
		['false', false],
		['no', false],
		['2', false]
	])('flag(%j) → %s', (v, expected) => expect(flag(v)).toBe(expected));

	it.each([
		[undefined, 'http://localhost:3000/api/store/snapshot'],
		['', 'http://localhost:3000/api/store/snapshot'],
		['   ', 'http://localhost:3000/api/store/snapshot'],
		['http://127.0.0.1:3100', 'http://127.0.0.1:3100/api/store/snapshot'],
		['http://127.0.0.1:3100/', 'http://127.0.0.1:3100/api/store/snapshot'],
		['https://cms.wefeasto.com//', 'https://cms.wefeasto.com/api/store/snapshot'],
		['https://example.com/cms', 'https://example.com/cms/api/store/snapshot']
	])('snapshotUrl(%j) → %s', (base, expected) => expect(snapshotUrl(base)).toBe(expected));
});

describe('validation', () => {
	it('the committed snapshot passes', () => {
		expect(essentialErrors(snapshotCopy())).toEqual([]);
		expect(checkSnapshot(snapshotCopy())).toEqual({ ok: true, errors: [] });
	});

	it.each([
		['null', null],
		['an array', []],
		['a string', 'snapshot'],
		['a number', 1]
	])('rejects %s without crashing', (_label, value) => {
		const r = checkSnapshot(value);
		expect(r.ok).toBe(false);
		expect(r.errors).toEqual(['snapshot: must be a JSON object']);
	});

	const cases = [
		['version 2', (s) => void (s.version = 2), /^version: must be 1, got 2$/],
		['version "1"', (s) => void (s.version = '1'), /^version: must be 1, got "1"$/],
		['no version', (s) => void delete s.version, /^version: must be 1, got undefined$/],
		['no products', (s) => void delete s.products, /^products: must be a non-empty array$/],
		['empty products', (s) => void (s.products = []), /^products: must be a non-empty array$/],
		['products an object', (s) => void (s.products = { a: 1 }), /^products: must be a non-empty array$/],
		['duplicate slug', (s) => void (s.products[3].slug = s.products[1].slug), /^products\[3\]\.slug: duplicate slug "steel-cut-oats"$/],
		['blank slug', (s) => void (s.products[0].slug = ''), /^products\[0\]\.slug: must be a non-empty string$/],
		['numeric slug', (s) => void (s.products[0].slug = 7), /^products\[0\]\.slug: must be a non-empty string$/],
		['product not an object', (s) => void (s.products[2] = null), /^products\[2\]\.slug: must be a non-empty string$/],
		['float price', (s) => void (s.products[0].pricePaise = 17550.5), /^products\[0\]\.pricePaise: must be an integer, got 17550.5$/],
		['string price', (s) => void (s.products[0].pricePaise = '17500'), /^products\[0\]\.pricePaise: must be an integer, got "17500"$/],
		['null price', (s) => void (s.products[0].pricePaise = null), /^products\[0\]\.pricePaise: must be an integer, got null$/],
		['missing price', (s) => void delete s.products[5].pricePaise, /^products\[5\]\.pricePaise: must be an integer, got undefined$/]
	];

	it.each(cases)('essential check: %s', (_label, mutate, message) => {
		const s = snapshotCopy();
		mutate(s);
		const errors = essentialErrors(s);
		expect(errors.some((e) => message.test(e))).toBe(true);
		const r = checkSnapshot(s);
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => message.test(e))).toBe(true);
		expect(new Set(r.errors).size).toBe(r.errors.length);
	});

	it.each([
		['leaked server-only stock', (s) => void (s.products[0].stock = 12), /products\[0\]\.stock/],
		['leaked server-only setting', (s) => void (s.settings.reservationMinutes = 30), /settings\.reservationMinutes/],
		['price not a whole rupee', (s) => void (s.products[0].pricePaise = 17550), /multiple of 100/],
		['unknown category', (s) => void (s.products[0].category = 'Snacks'), /products\[0\]\.category/],
		['dangling goesWith', (s) => void (s.products[0].goesWith = ['nope']), /goesWith/],
		['script in recipe HTML', (s) => void (s.recipes[0].whyHtml = '<p>x</p><script>alert(1)</script>'), /recipes\[0\]\.whyHtml/],
		['unknown top-level key', (s) => void (s.extra = 1), /extra/]
	])('full schema validator also runs: %s', (_label, mutate, pattern) => {
		const s = snapshotCopy();
		mutate(s);
		expect(essentialErrors(s)).toEqual([]);
		const r = checkSnapshot(s);
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => pattern.test(e))).toBe(true);
	});
});

describe('stable serialization', () => {
	it('the committed file is already canonical', () => {
		expect(serializeSnapshot(snapshotCopy())).toBe(COMMITTED_TEXT);
	});

	it('key order of the input does not matter; 2-space JSON with one trailing newline', () => {
		const text = serializeSnapshot(reverseKeys(snapshotCopy()));
		expect(text).toBe(COMMITTED_TEXT);
		expect(text.endsWith('}\n')).toBe(true);
		expect(text.endsWith('\n\n')).toBe(false);
		expect(text.split('\n')[1]).toBe('  "version": 1,');
	});
});

describe('planWrite (generatedAt-only changes never churn git)', () => {
	it('identical content with a new generatedAt → unchanged, committed text kept', () => {
		const plan = planWrite(COMMITTED_TEXT, served());
		expect(plan.action).toBe('unchanged');
		expect(plan.text).toBe(COMMITTED_TEXT);
	});

	it('identical content served with a different key order → unchanged', () => {
		expect(planWrite(COMMITTED_TEXT, reverseKeys(served())).action).toBe('unchanged');
	});

	it('identical content including generatedAt → unchanged', () => {
		expect(planWrite(COMMITTED_TEXT, snapshotCopy()).action).toBe('unchanged');
	});

	it('same content but a non-canonical committed file → rewritten canonically, committed generatedAt kept', () => {
		const minified = JSON.stringify(snapshotCopy());
		const plan = planWrite(minified, served());
		expect(plan.action).toBe('write');
		expect(plan.reason).toMatch(/reformatted/);
		expect(plan.text).toBe(COMMITTED_TEXT);
		expect(JSON.parse(plan.text).generatedAt).toBe(STAMP);
	});

	it.each([
		['a price', (s) => void (s.products[0].pricePaise = 19900)],
		['a setting', (s) => void (s.settings.deliveryFeePaise = 5900)],
		['a nested setting', (s) => void (s.settings.announcement.text = 'Hello')],
		['recipe order', (s) => void s.recipes.reverse()],
		['a list inside a record', (s) => void s.products[0].searchTerms.reverse()],
		['a published page', (s) => void s.pages.push({ slug: 'shipping', title: 'Shipping Policy', bodyHtml: '<p>We ship across India.</p>', published: true })],
		['null vs empty string', (s) => void (s.products[0].ratingSource = '')]
	])('a change in %s → write the fetched snapshot with its generatedAt', (_label, mutate) => {
		const fetched = served(mutate);
		const plan = planWrite(COMMITTED_TEXT, fetched);
		expect(plan.action).toBe('write');
		expect(plan.reason).toBe('content changed');
		expect(plan.text).toBe(serializeSnapshot(fetched));
		expect(JSON.parse(plan.text).generatedAt).toBe(LATER);
	});

	it.each([
		['no committed file', null],
		['an empty file', ''],
		['broken JSON', '{"version": 1,'],
		['a JSON array', '[]'],
		['JSON null', 'null']
	])('%s → write the fetched snapshot', (_label, committed) => {
		const plan = planWrite(committed, served());
		expect(plan.action).toBe('write');
		expect(plan.text).toBe(serializeSnapshot(served()));
	});

	it('a committed file without generatedAt → write fresh (never emits a snapshot missing it)', () => {
		const s = snapshotCopy();
		delete s.generatedAt;
		const plan = planWrite(JSON.stringify(s, null, 2) + '\n', served());
		expect(plan.action).toBe('write');
		expect(JSON.parse(plan.text).generatedAt).toBe(LATER);
		expect(checkSnapshot(JSON.parse(plan.text)).ok).toBe(true);
	});

	it('a committed generatedAt that is not a valid date → write fresh', () => {
		const s = snapshotCopy();
		s.generatedAt = 'yesterday';
		const plan = planWrite(serializeSnapshot(s), served());
		expect(plan.action).toBe('write');
		expect(JSON.parse(plan.text).generatedAt).toBe(LATER);
	});
});

describe('writeFileAtomic', () => {
	it('creates a new file', () => {
		const f = tmpFile('new.json', null);
		writeFileAtomic(f, 'hello\n');
		expect(fs.readFileSync(f, 'utf8')).toBe('hello\n');
		expect(leftovers()).toEqual([]);
	});

	it('replaces an existing file in one rename (new inode, no temp left)', () => {
		const f = tmpFile('snap.json', 'old');
		const before = fs.statSync(f).ino;
		writeFileAtomic(f, 'new');
		expect(fs.readFileSync(f, 'utf8')).toBe('new');
		expect(fs.statSync(f).ino).not.toBe(before);
		expect(leftovers()).toEqual([]);
	});

	it('on failure throws, leaves the target alone and cleans up the temp file', () => {
		const dirTarget = path.join(tmp, 'is-a-dir');
		fs.mkdirSync(dirTarget);
		fs.writeFileSync(path.join(dirTarget, 'keep'), 'x');
		expect(() => writeFileAtomic(dirTarget, 'data')).toThrow();
		expect(fs.statSync(dirTarget).isDirectory()).toBe(true);
		expect(leftovers()).toEqual([]);
	});

	it('throws when the directory does not exist', () => {
		expect(() => writeFileAtomic(path.join(tmp, 'missing', 'x.json'), 'data')).toThrow();
	});
});

describe('fetchSnapshot', () => {
	const ok = (body, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

	it('GETs the URL asking for JSON and parses the body', async () => {
		const fetchImpl = ok(served());
		const r = await fetchSnapshot('http://cms.test/api/store/snapshot', { fetchImpl });
		expect(r).toEqual({ ok: true, snapshot: served() });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('http://cms.test/api/store/snapshot');
		expect(init.headers.Accept).toBe('application/json');
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		[500, '{"error":{"code":"INTERNAL"}}', /^HTTP 500: \{"error"/],
		[404, '', /^HTTP 404$/],
		[502, '<html>\n  Bad   gateway\n</html>', /^HTTP 502: <html> Bad gateway <\/html>$/]
	])('HTTP %i → error', async (status, body, pattern) => {
		const r = await fetchSnapshot('http://x', { fetchImpl: ok(body, status) });
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(pattern);
	});

	it('a long error body is truncated', async () => {
		const r = await fetchSnapshot('http://x', { fetchImpl: ok('x'.repeat(5000), 500) });
		expect(r.error.length).toBeLessThan(220);
	});

	it('non-JSON 200 → error', async () => {
		expect(await fetchSnapshot('http://x', { fetchImpl: ok('<!doctype html>') })).toEqual({ ok: false, error: 'response is not JSON' });
	});

	it('network failure → error with the cause code', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
		});
		expect(await fetchSnapshot('http://x', { fetchImpl })).toEqual({ ok: false, error: 'fetch failed: ECONNREFUSED' });
	});

	it('timeout aborts the request', async () => {
		const fetchImpl = vi.fn(
			(_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
		);
		const r = await fetchSnapshot('http://x', { fetchImpl, timeoutMs: 30 });
		expect(r).toEqual({ ok: false, error: 'timed out after 30 ms' });
		expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
	});
});

describe('syncCms (in-process)', () => {
	const run = async (opts) => {
		const log = vi.fn();
		const warn = vi.fn();
		const code = await syncCms({ log, warn, argv: [], env: {}, ...opts });
		return { code, log: log.mock.calls.map((c) => c[0]).join('\n'), warn: warn.mock.calls.map((c) => c[0]).join('\n') };
	};
	const serving = (body, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

	it('without CMS_SYNC=1 or --force: prints skipped, exits 0, no fetch, file untouched', async () => {
		const file = tmpFile();
		const fetchImpl = vi.fn();
		for (const env of [{}, { CMS_SYNC: '0' }, { CMS_SYNC: '' }, { CMS_REQUIRED: '1' }]) {
			const r = await run({ file, fetchImpl, env });
			expect(r.code).toBe(0);
			expect(r.log).toMatch(/skipped/);
		}
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(fs.readFileSync(file, 'utf8')).toBe(COMMITTED_TEXT);
	});

	it('CMS_SYNC=1 fetches {CMS_URL}/api/store/snapshot and writes the canonical file', async () => {
		const file = tmpFile();
		const fetched = served((s) => void (s.products[0].pricePaise = 19900));
		const fetchImpl = serving(reverseKeys(fetched));
		const r = await run({ file, fetchImpl, env: { CMS_SYNC: '1', CMS_URL: 'http://cms.test:3100/' } });
		expect(r.code).toBe(0);
		expect(fetchImpl.mock.calls[0][0]).toBe('http://cms.test:3100/api/store/snapshot');
		expect(fs.readFileSync(file, 'utf8')).toBe(serializeSnapshot(fetched));
		const counts = `${fetched.products.length} products, ${fetched.recipes.length} recipes, ${fetched.pages.length} pages`;
		expect(counts).toMatch(/^6 products, 12 recipes, \d+ pages$/);
		expect(r.log).toContain(`(${counts}; content changed)`);
		expect(r.log).toMatch(/^sync-cms: wrote /);
		expect(leftovers()).toEqual([]);
	});

	it('--force runs without CMS_SYNC; default CMS_URL is localhost:3000', async () => {
		const file = tmpFile();
		const fetchImpl = serving(served());
		const r = await run({ file, fetchImpl, argv: ['--force'] });
		expect(r.code).toBe(0);
		expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:3000/api/store/snapshot');
	});

	it('only generatedAt differs → file not touched at all (same bytes, same mtime)', async () => {
		const file = tmpFile();
		const old = new Date('2020-01-01T00:00:00Z');
		fs.utimesSync(file, old, old);
		const r = await run({ file, fetchImpl: serving(served()), argv: ['--force'] });
		expect(r.code).toBe(0);
		expect(r.log).toMatch(/is up to date/);
		expect(fs.readFileSync(file, 'utf8')).toBe(COMMITTED_TEXT);
		expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
	});

	it('no committed file yet → written', async () => {
		const file = tmpFile('fresh.json', null);
		const r = await run({ file, fetchImpl: serving(served()), argv: ['--force'] });
		expect(r.code).toBe(0);
		expect(fs.readFileSync(file, 'utf8')).toBe(serializeSnapshot(served()));
	});

	it('--out=<file> picks the output file', async () => {
		const file = tmpFile('other.json', null);
		const r = await run({ file: undefined, fetchImpl: serving(served()), argv: ['--force', `--out=${file}`] });
		expect(r.code).toBe(0);
		expect(fs.existsSync(file)).toBe(true);
	});

	const failures = [
		['network error', () => vi.fn(async () => Promise.reject(new TypeError('fetch failed'))), /could not fetch .*fetch failed/],
		['HTTP 500', () => serving('{"error":{"code":"INTERNAL"}}', 500), /could not fetch .*HTTP 500/],
		['non-JSON', () => serving('<html>'), /response is not JSON/],
		['invalid snapshot', () => serving(served((s) => void (s.products = []))), /served an invalid snapshot/],
		['leaked stock', () => serving(served((s) => void (s.products[0].stock = 3))), /products\[0\]\.stock/]
	];

	it.each(failures)('%s, CMS not required → warn, exit 0, committed file kept', async (_label, makeFetch, pattern) => {
		const file = tmpFile();
		const r = await run({ file, fetchImpl: makeFetch(), env: { CMS_SYNC: '1' } });
		expect(r.code).toBe(0);
		expect(r.warn).toMatch(pattern);
		expect(r.warn).toMatch(/keeping the committed/);
		expect(fs.readFileSync(file, 'utf8')).toBe(COMMITTED_TEXT);
		expect(leftovers()).toEqual([]);
	});

	it.each(failures)('%s, CMS_REQUIRED=1 → exit 1, committed file kept', async (_label, makeFetch, pattern) => {
		const file = tmpFile();
		const r = await run({ file, fetchImpl: makeFetch(), env: { CMS_SYNC: '1', CMS_REQUIRED: '1' } });
		expect(r.code).toBe(1);
		expect(r.warn).toMatch(pattern);
		expect(r.warn).toMatch(/CMS_REQUIRED=1, failing/);
		expect(fs.readFileSync(file, 'utf8')).toBe(COMMITTED_TEXT);
	});

	it('prints at most 20 validation errors', async () => {
		const bad = served((s) => {
			s.recipes.forEach((r) => {
				r.category = 'Nope';
				r.tagColor = 'red';
			});
		});
		const r = await run({ file: tmpFile(), fetchImpl: serving(bad), argv: ['--force'] });
		expect(r.warn.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(20);
		expect(r.warn).toMatch(/… and 4 more/);
	});

	it('timeout → warn and keep (uses the timeout it is given)', async () => {
		const file = tmpFile();
		const fetchImpl = vi.fn(
			(_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
		);
		const r = await run({ file, fetchImpl, argv: ['--force'], timeoutMs: 25 });
		expect(r.code).toBe(0);
		expect(r.warn).toMatch(/timed out after 25 ms/);
	});

	it('a write failure is reported like any other failure', async () => {
		const dir = path.join(tmp, 'target-is-dir');
		fs.mkdirSync(dir);
		const fetchImpl = serving(served());
		expect((await run({ file: dir, fetchImpl, argv: ['--force'] })).code).toBe(0);
		const r = await run({ file: dir, fetchImpl, argv: ['--force'], env: { CMS_REQUIRED: '1' } });
		expect(r.code).toBe(1);
		expect(r.warn).toMatch(/sync failed/);
	});
});

/* ------------------------------------------- the real CLI, real HTTP */

const SCRIPT = path.join(ROOT, 'scripts/sync-cms.mjs');

/** Listen on a random free port in 4200–4999. */
async function listenRandom(server) {
	for (let i = 0; i < 50; i++) {
		const port = 4200 + Math.floor(Math.random() * 800);
		const ok = await new Promise((resolve) => {
			server.once('error', () => resolve(false));
			server.listen(port, '127.0.0.1', () => resolve(true));
		});
		if (ok) return port;
	}
	throw new Error('no free port');
}

function cli(args, env) {
	const clean = { ...process.env };
	for (const k of ['CMS_SYNC', 'CMS_REQUIRED', 'CMS_URL']) delete clean[k];
	return new Promise((resolve) => {
		execFile(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env }, cwd: ROOT, timeout: 30000 }, (err, stdout, stderr) =>
			resolve({ code: err ? err.code : 0, stdout, stderr })
		);
	});
}

// Each case spawns node; allow for a loaded machine.
describe('CLI against a local HTTP server', { timeout: 60000 }, () => {
	let server;
	let base;
	let respond;
	const requests = [];

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			requests.push({ method: req.method, url: req.url, accept: req.headers.accept });
			respond(req, res);
		});
		base = `http://127.0.0.1:${await listenRandom(server)}`;
	});
	afterAll(() => new Promise((r) => server.close(r)));
	beforeEach(() => {
		requests.length = 0;
		respond = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify(served()));
		};
	});

	it('no flags → "skipped", exit 0, no request', async () => {
		const out = tmpFile();
		const r = await cli([`--out=${out}`], { CMS_URL: base });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/sync-cms: skipped/);
		expect(requests).toEqual([]);
	});

	it('CMS_SYNC=1, unchanged content → exit 0, file untouched', async () => {
		const out = tmpFile();
		const r = await cli([`--out=${out}`], { CMS_SYNC: '1', CMS_URL: base });
		expect(r.code).toBe(0);
		expect(requests).toEqual([{ method: 'GET', url: '/api/store/snapshot', accept: 'application/json' }]);
		expect(r.stdout).toMatch(/is up to date/);
		expect(fs.readFileSync(out, 'utf8')).toBe(COMMITTED_TEXT);
	});

	it('--force with changed content → writes the canonical file', async () => {
		const out = tmpFile();
		const changed = served((s) => void (s.settings.freeDeliveryThresholdPaise = 59900));
		respond = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(reverseKeys(changed)));
		};
		const r = await cli(['--force', `--out=${out}`], { CMS_URL: base });
		expect(r.code).toBe(0);
		expect(fs.readFileSync(out, 'utf8')).toBe(serializeSnapshot(changed));
		expect(leftovers()).toEqual([]);
	});

	it('HTTP 500 → exit 0 with a warning; CMS_REQUIRED=1 → exit 1', async () => {
		respond = (_req, res) => {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end('{"error":{"code":"INTERNAL","message":"boom"}}');
		};
		const out = tmpFile();
		const soft = await cli(['--force', `--out=${out}`], { CMS_URL: base });
		expect(soft.code).toBe(0);
		expect(soft.stderr).toMatch(/HTTP 500.*keeping the committed/);
		const hard = await cli(['--force', `--out=${out}`], { CMS_URL: base, CMS_REQUIRED: '1' });
		expect(hard.code).toBe(1);
		expect(hard.stderr).toMatch(/CMS_REQUIRED=1, failing/);
		expect(fs.readFileSync(out, 'utf8')).toBe(COMMITTED_TEXT);
	});

	it('CMS down (connection refused) → exit 0; CMS_REQUIRED=1 → exit 1', async () => {
		const closed = http.createServer();
		const port = await listenRandom(closed);
		await new Promise((r) => closed.close(r));
		const out = tmpFile();
		const soft = await cli([`--out=${out}`], { CMS_SYNC: '1', CMS_URL: `http://127.0.0.1:${port}` });
		expect(soft.code).toBe(0);
		expect(soft.stderr).toMatch(/ECONNREFUSED/);
		const hard = await cli([`--out=${out}`], { CMS_SYNC: '1', CMS_REQUIRED: '1', CMS_URL: `http://127.0.0.1:${port}` });
		expect(hard.code).toBe(1);
	});
});
