import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const { api, toError, newIdempotencyKey } = await import('$lib/api.js');

function respond(status, body, { raw = false } = {}) {
	return new Response(raw ? body : JSON.stringify(body), {
		status,
		headers: { 'Content-Type': raw ? 'text/html' : 'application/json' }
	});
}

describe('api()', () => {
	let fetchMock;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('prefixes /api, sends JSON with same-origin credentials and returns data', async () => {
		fetchMock.mockResolvedValue(respond(200, { quote: { totalPaise: 52400 } }));
		const r = await api('/store/quote', { method: 'POST', body: { items: [] } });
		expect(r).toEqual({ ok: true, status: 200, data: { quote: { totalPaise: 52400 } }, error: null });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/store/quote');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('same-origin');
		expect(init.headers['Content-Type']).toBe('application/json');
		expect(JSON.parse(init.body)).toEqual({ items: [] });
	});

	it('accepts full /api paths and paths without a leading slash', async () => {
		fetchMock.mockResolvedValue(respond(200, {}));
		await api('/api/customers/me');
		await api('store/catalog');
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/customers/me', '/api/store/catalog']);
	});

	it('passes through custom endpoint error bodies', async () => {
		fetchMock.mockResolvedValue(
			respond(409, { error: { code: 'OUT_OF_STOCK', message: 'Rolled Oats just sold out', details: { slug: 'rolled-oats', available: 0 } } })
		);
		const r = await api('/store/checkout', { method: 'POST', body: {} });
		expect(r.ok).toBe(false);
		expect(r.status).toBe(409);
		expect(r.error).toEqual({ code: 'OUT_OF_STOCK', message: 'Rolled Oats just sold out', details: { slug: 'rolled-oats', available: 0 } });
	});

	it("normalises Payload's built-in { errors: [...] } shape", async () => {
		fetchMock.mockResolvedValue(respond(401, { errors: [{ message: 'The email or password provided is incorrect.' }] }));
		const r = await api('/customers/login', { method: 'POST', body: {} });
		expect(r.error.code).toBe('UNAUTHORIZED');
		expect(r.error.message).toBe('The email or password provided is incorrect.');
	});

	it('maps network failures to NETWORK without throwing', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		const r = await api('/store/catalog');
		expect(r).toMatchObject({ ok: false, status: 0, error: { code: 'NETWORK' } });
	});

	it('times out slow requests as TIMEOUT', async () => {
		fetchMock.mockImplementation(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				})
		);
		const r = await api('/store/catalog', { timeoutMs: 20 });
		expect(r.error.code).toBe('TIMEOUT');
	});

	it('reports caller aborts as ABORTED', async () => {
		fetchMock.mockImplementation(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				})
		);
		const ctrl = new AbortController();
		const p = api('/store/catalog', { signal: ctrl.signal });
		ctrl.abort();
		expect((await p).error.code).toBe('ABORTED');
	});

	// Headers in, body never finishes (a connection that dies mid-response): the deadline must
	// still fire — fetch() resolves on headers, so a timer cleared there leaves callers hanging.
	function stalledBody(status = 200) {
		return (_url, init) => {
			const stream = new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode('{"number":"WF-'));
					// never closes; an abort errors it the way browsers do
					init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
				}
			});
			return Promise.resolve(new Response(stream, { status, headers: { 'Content-Type': 'application/json' } }));
		};
	}

	it('times out a response whose body stalls after the headers as TIMEOUT', async () => {
		fetchMock.mockImplementation(stalledBody());
		const r = await api('/store/orders/status', { timeoutMs: 30 });
		expect(r).toEqual({ ok: false, status: 0, data: null, error: expect.objectContaining({ code: 'TIMEOUT' }) });
	});

	it('times out a stalled body even when the fetch implementation ignores the abort for the body', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }), { status: 200 }))
		);
		const r = await api('/store/orders/status', { timeoutMs: 30 });
		expect(r.error?.code).toBe('TIMEOUT');
	});

	it('reports a caller abort during the body read as ABORTED', async () => {
		fetchMock.mockImplementation(stalledBody());
		const ctrl = new AbortController();
		const p = api('/store/orders/status', { signal: ctrl.signal, timeoutMs: 5000 });
		await new Promise((r) => setTimeout(r, 10));
		ctrl.abort();
		expect((await p).error?.code).toBe('ABORTED');
	});

	it('maps a body that errors mid-read to NETWORK, never ok with null data', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode('{"ok":'));
							setTimeout(() => c.error(new TypeError('network error')), 5);
						}
					}),
					{ status: 200 }
				)
			)
		);
		const r = await api('/store/catalog');
		expect(r).toMatchObject({ ok: false, status: 0, data: null, error: { code: 'NETWORK' } });
	});

	it('keeps the deadline armed only until the body is read (no late abort after success)', async () => {
		const signals = [];
		fetchMock.mockImplementation((_url, init) => {
			signals.push(init.signal);
			return Promise.resolve(respond(200, { ok: 1 }));
		});
		const r = await api('/store/catalog', { timeoutMs: 20 });
		expect(r.ok).toBe(true);
		await new Promise((res) => setTimeout(res, 40));
		expect(signals[0].aborted).toBe(false);
	});

	it('flags a 200 with a non-JSON body as BAD_RESPONSE', async () => {
		fetchMock.mockResolvedValue(respond(200, '<html>proxy error</html>', { raw: true }));
		const r = await api('/store/catalog');
		expect(r).toMatchObject({ ok: false, status: 200, error: { code: 'BAD_RESPONSE' } });
	});

	it('maps a 502 HTML page to INTERNAL', async () => {
		fetchMock.mockResolvedValue(respond(502, '<html>Bad gateway</html>', { raw: true }));
		const r = await api('/store/catalog');
		expect(r).toMatchObject({ ok: false, status: 502, error: { code: 'INTERNAL' } });
	});
});

describe('toError()', () => {
	it('falls back by status', () => {
		expect(toError(429, null).code).toBe('RATE_LIMITED');
		expect(toError(503, 'x').code).toBe('UNAVAILABLE');
		expect(toError(418, {}).code).toBe('UNKNOWN');
	});
});

describe('newIdempotencyKey()', () => {
	it('returns distinct v4 uuids', () => {
		const a = newIdempotencyKey();
		const b = newIdempotencyKey();
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(a).not.toBe(b);
	});
});
