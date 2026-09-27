/*
 * Same-origin client for the Payload CMS API behind /api (proxied to the CMS by
 * Vite in dev/preview and rewritten by vercel.json in production, so auth
 * cookies stay first-party).
 *
 * Never throws: every call resolves to { ok, status, data, error } where error
 * is null or { code, message, details } — the shape custom /api/store/*
 * endpoints return. Payload's built-in endpoints ({ errors: [{ message }] }),
 * network failures, timeouts and non-JSON bodies are normalised to the same
 * shape so UI code can branch on error.code alone.
 */
import { browser } from '$app/environment';

export const API_BASE = '/api';

const DEFAULT_TIMEOUT = 15000;

const STATUS_CODES = {
	400: 'VALIDATION',
	401: 'UNAUTHORIZED',
	403: 'FORBIDDEN',
	404: 'NOT_FOUND',
	409: 'CONFLICT',
	422: 'VALIDATION',
	429: 'RATE_LIMITED',
	503: 'UNAVAILABLE'
};

function fallbackMessage(code) {
	switch (code) {
		case 'NETWORK':
			return "We couldn't reach Wefeasto — check your connection and try again.";
		case 'TIMEOUT':
			return 'That took too long — please try again.';
		case 'RATE_LIMITED':
			return 'Too many attempts — please wait a minute and try again.';
		case 'UNAUTHORIZED':
			return 'Please log in to continue.';
		default:
			return 'Something went wrong — please try again.';
	}
}

/** Normalise any error body into { code, message, details }. */
export function toError(status, body) {
	if (body && typeof body === 'object') {
		if (body.error && typeof body.error === 'object' && typeof body.error.code === 'string') {
			return {
				code: body.error.code,
				message: body.error.message || fallbackMessage(body.error.code),
				details: body.error.details ?? null
			};
		}
		if (Array.isArray(body.errors) && body.errors.length) {
			const first = body.errors[0] || {};
			const code = STATUS_CODES[status] || 'INTERNAL';
			return {
				code,
				message: typeof first.message === 'string' && first.message ? first.message : fallbackMessage(code),
				details: first.data ?? null
			};
		}
	}
	const code = STATUS_CODES[status] || (status >= 500 ? 'INTERNAL' : 'UNKNOWN');
	return { code, message: fallbackMessage(code), details: null };
}

/**
 * Read a response body, rejecting as soon as `signal` aborts. Browsers error the body stream
 * on abort anyway; racing the signal makes that independent of the fetch implementation.
 * @param {Response} res
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
function readBody(res, signal) {
	if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
		signal.addEventListener('abort', onAbort, { once: true });
		res.text().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

/**
 * @param {string} path  path under /api, e.g. '/store/quote' (a full '/api/…' path also works)
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any, error: null | { code: string, message: string, details: any } }>}
 */
export async function api(path, opts = {}) {
	const { method = 'GET', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT, signal } = opts;
	if (!browser) {
		return { ok: false, status: 0, data: null, error: { code: 'NETWORK', message: fallbackMessage('NETWORK'), details: null } };
	}
	const url = path.startsWith(API_BASE + '/') ? path : API_BASE + (path.startsWith('/') ? path : '/' + path);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener('abort', onAbort, { once: true });
	}
	const init = {
		method,
		credentials: 'same-origin',
		headers: { Accept: 'application/json', ...headers },
		signal: controller.signal
	};
	if (body !== undefined) {
		init.headers['Content-Type'] = 'application/json';
		init.body = JSON.stringify(body);
	}
	// The deadline covers the whole exchange: fetch() resolves as soon as the response HEADERS
	// arrive, so the timer stays armed until the body has been read too. A body that stalls
	// (headers in, connection dead) would otherwise hang the caller forever.
	let res;
	let text;
	try {
		res = await fetch(url, init);
		text = await readBody(res, controller.signal);
	} catch (e) {
		// A body cut off mid-read is no response at all, never ok/null data.
		const code = timedOut ? 'TIMEOUT' : signal?.aborted ? 'ABORTED' : 'NETWORK';
		return { ok: false, status: 0, data: null, error: { code, message: fallbackMessage(code), details: null } };
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener('abort', onAbort);
	}
	let data = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch (e) {
			if (res.ok) {
				return {
					ok: false,
					status: res.status,
					data: null,
					error: { code: 'BAD_RESPONSE', message: fallbackMessage('BAD_RESPONSE'), details: null }
				};
			}
		}
	}
	if (!res.ok) return { ok: false, status: res.status, data, error: toError(res.status, data) };
	return { ok: true, status: res.status, data, error: null };
}

/** Fresh idempotency key (uuid v4) for POST /api/store/checkout. */
export function newIdempotencyKey() {
	const c = globalThis.crypto;
	// randomUUID needs a secure context; plain-http LAN previews fall back to getRandomValues.
	if (typeof c.randomUUID === 'function') return c.randomUUID();
	const b = new Uint8Array(16);
	c.getRandomValues(b);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
