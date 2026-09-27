/*
 * Hunt (payments-security, round 3) — safeNext() hands back a protocol-relative URL.
 *
 * safeNext (src/lib/session.js) promises "a same-origin path only … rejects protocol-relative ('//evil')".
 * It checks the RAW value (single leading slash, no backslash/whitespace, up to 3 decodings), then returns
 * `url.pathname` of `new URL(raw, origin)`. URL parsing removes dot segments AFTER those checks, so
 * '/.//evil.example' (or '/x/..//evil.example', '/%2e%2e//evil.example') passes every check and comes back
 * as '//evil.example' — a different host. /login does `goto(next)` with it after a successful sign-in;
 * today SvelteKit's goto() refuses the external URL ("goto: invalid URL"), so the shopper is left on /login
 * under "Welcome back! Taking you to your account…", and any future `location.assign(next)` / `<a href>`
 * use of the helper becomes an open redirect. Correct behaviour: the unsafe value falls back to /account.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api.js', () => ({ api: vi.fn() }));
vi.mock('$lib/track.js', () => ({ track: vi.fn() }));

const { safeNext } = await import('$lib/session.js');

describe('safeNext() never returns another origin', () => {
	it.each(['/.//evil.example', '/x/..//evil.example', '/././/evil.example/steal', '/%2e%2e//evil.example', '/x/%2E%2E//evil.example'])(
		'%s falls back to /account',
		(raw) => {
			const out = safeNext(raw);
			expect(new URL(out, 'https://shop.test').origin, `safeNext(${JSON.stringify(raw)}) → ${JSON.stringify(out)}`).toBe('https://shop.test');
			expect(out.startsWith('//')).toBe(false);
		}
	);
});
