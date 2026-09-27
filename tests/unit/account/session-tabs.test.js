/*
 * $lib/session.js across tabs (hunt client-ux: logout-other-tab-keeps-account).
 * Every tab shares the session cookie; the wefeasto_signed_in hint is how a
 * tab hears about the others. A logout elsewhere (hint removed) → this tab
 * asks /me again and goes anonymous (so /account sends it to /login); a login
 * elsewhere (hint set) → it asks /me too; coming back to a signed-in tab
 * re-checks at most every RECHECK_MS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
const apiMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/api.js', () => ({ api: apiMock }));
vi.mock('$lib/track.js', () => ({ track: vi.fn() }));

const S = await import('$lib/session.js');
const { session } = S;

const ok = (data) => ({ ok: true, status: 200, data, error: null });
const netErr = () => ({ ok: false, status: 0, data: null, error: { code: 'NETWORK', message: 'x', details: null } });
const CUSTOMER = { id: 7, name: 'Asha Kumar', phone: '', email: 'asha@example.com', collection: 'customers' };
const BOB = { id: 8, name: 'Bob', phone: '', email: 'bob@example.com', collection: 'customers' };

function memoryStorage() {
	const m = new Map();
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => void m.set(k, String(v)),
		removeItem: (k) => void m.delete(k),
		clear: () => m.clear()
	};
}

let storage, win, doc, unsubscribe;
const flush = () => new Promise((r) => setTimeout(r, 0));
const meCalls = () => apiMock.mock.calls.filter((c) => c[0] === '/customers/me').length;

/** What another tab's localStorage write looks like here. */
function storageEvent(key, newValue) {
	win.dispatchEvent(Object.assign(new Event('storage'), { key, newValue }));
}
const logoutElsewhere = () => {
	storage.removeItem(S.SESSION_HINT_KEY);
	storageEvent(S.SESSION_HINT_KEY, null);
};
const loginElsewhere = () => {
	storage.setItem(S.SESSION_HINT_KEY, '1');
	storageEvent(S.SESSION_HINT_KEY, '1');
};

async function signedIn(customer = CUSTOMER) {
	apiMock.mockResolvedValueOnce(ok({ user: customer }));
	await S.refresh();
	apiMock.mockReset();
	expect(get(session).status).toBe('authenticated');
}

beforeEach(() => {
	apiMock.mockReset();
	storage = memoryStorage();
	win = Object.assign(new EventTarget(), { localStorage: storage });
	doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
	vi.stubGlobal('window', win);
	vi.stubGlobal('document', doc);
	S._resetSession();
	unsubscribe = session.subscribe(() => {}); // the nav: always listening
});
afterEach(() => {
	unsubscribe?.();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('a logout in another tab (the hint is removed)', () => {
	it('asks /me again and goes anonymous: /account then leaves for /login', async () => {
		await signedIn();
		apiMock.mockResolvedValue(ok({ user: null }));
		logoutElsewhere();
		await flush();
		expect(meCalls()).toBe(1);
		expect(get(session)).toEqual({ status: 'anonymous', user: null });
	});

	it('offline: anonymous anyway (trust the other tab, hide the account)', async () => {
		await signedIn();
		apiMock.mockResolvedValue(netErr());
		logoutElsewhere();
		await flush();
		expect(get(session).status).toBe('anonymous');
	});

	it('the server still knows us (a stale answer elsewhere wiped the hint): stays signed in, hint restored', async () => {
		await signedIn();
		apiMock.mockResolvedValue(ok({ user: CUSTOMER }));
		logoutElsewhere();
		await flush();
		expect(get(session).status).toBe('authenticated');
		expect(storage.getItem(S.SESSION_HINT_KEY)).toBe('1');
	});

	it('an /me answer that left before the logout cannot sign this tab back in', async () => {
		storage.setItem(S.SESSION_HINT_KEY, '1');
		let answerOld;
		apiMock.mockReturnValueOnce(new Promise((r) => (answerOld = r)));
		const first = S.refresh();
		apiMock.mockResolvedValueOnce(ok({ user: null }));
		logoutElsewhere();
		await flush();
		answerOld(ok({ user: CUSTOMER }));
		expect((await first).stale).toBe(true);
		expect(get(session).status).toBe('anonymous');
		expect(meCalls()).toBe(2);
	});

	it('storage.clear() elsewhere (key null) counts too', async () => {
		await signedIn();
		apiMock.mockResolvedValue(ok({ user: null }));
		storage.clear();
		storageEvent(null, null);
		await flush();
		expect(get(session).status).toBe('anonymous');
	});

	it('already anonymous, or another key: no request', async () => {
		apiMock.mockResolvedValue(ok({ user: null }));
		await S.refresh();
		apiMock.mockReset();
		logoutElsewhere();
		await flush();
		expect(apiMock).not.toHaveBeenCalled();
		await signedIn();
		storageEvent('wefeasto_cart', '{}');
		await flush();
		expect(apiMock).not.toHaveBeenCalled();
	});

	it('nothing listens once nobody shows the session', async () => {
		await signedIn();
		unsubscribe();
		unsubscribe = null;
		logoutElsewhere();
		await flush();
		expect(apiMock).not.toHaveBeenCalled();
	});
});

describe('a login in another tab (the hint is set)', () => {
	it('an anonymous tab asks /me and learns who is signed in (the nav follows)', async () => {
		apiMock.mockResolvedValue(ok({ user: CUSTOMER }));
		loginElsewhere();
		await flush();
		expect(meCalls()).toBe(1);
		expect(get(session).user).toMatchObject({ id: 7 });
	});

	it('offline: the state is left as it was', async () => {
		apiMock.mockResolvedValue(netErr());
		loginElsewhere();
		await flush();
		expect(get(session).status).toBe('unknown');
	});
});

describe('coming back to a signed-in tab', () => {
	const visible = () => doc.dispatchEvent(new Event('visibilitychange'));

	it('re-checks when last checked RECHECK_MS ago or more, not sooner', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		await signedIn();
		apiMock.mockResolvedValue(ok({ user: BOB })); // someone else logged in since
		visible();
		await flush();
		expect(apiMock).not.toHaveBeenCalled();
		vi.setSystemTime(Date.now() + S.RECHECK_MS);
		visible();
		await flush();
		expect(meCalls()).toBe(1);
		expect(get(session).user).toMatchObject({ id: 8 });
	});

	it('hidden, anonymous, or a fresh page load (pageshow without persisted): no request', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		await signedIn();
		vi.setSystemTime(Date.now() + S.RECHECK_MS);
		doc.visibilityState = 'hidden';
		doc.dispatchEvent(new Event('visibilitychange'));
		win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
		await flush();
		expect(apiMock).not.toHaveBeenCalled();
		apiMock.mockResolvedValue(ok({ user: null }));
		win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); // back from the bfcache
		await flush();
		expect(meCalls()).toBe(1);
		expect(get(session).status).toBe('anonymous');
		doc.visibilityState = 'visible';
		vi.setSystemTime(Date.now() + S.RECHECK_MS);
		visible();
		await flush();
		expect(meCalls()).toBe(1);
	});
});
