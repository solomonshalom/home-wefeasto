/*
 * Sessions (roadmap S3, storefront-account.md §1.2–1.3, §2): ?next= redirects only to
 * same-origin paths; logout clears /me and the account links; a session that ends
 * mid-visit sends /account to /login with a notice (no loop), and checkout stays
 * guest-capable when the session dies under it; anonymous visitors never ask /me;
 * no Google button.
 */
import { test, expect } from '../fixtures.js';
import {
	COPY,
	apiLogin,
	createCustomer,
	endSessions,
	footerAccount,
	logInUI,
	me,
	navAccount,
	notice,
	openLogin,
	waitAccountReady
} from './helpers.js';

const BAD_NEXT = [
	'//evil.example',
	'/\\evil.example',
	'https://x.example/',
	'javascript:alert(1)',
	'data:text/html,hi',
	'evil.example',
	'/%2F%2Fevil.example',
	'/%5Cevil.example',
	'/%252F%252Fevil.example',
	'/\t/evil.example',
	'/login?next=//evil.example',
	'/reset-password'
];

/** Every request the page makes to a host other than the local stack. */
function offsiteRequests(page) {
	const seen = [];
	page.on('request', (r) => {
		const h = new URL(r.url()).hostname;
		if (!['localhost', '127.0.0.1'].includes(h)) seen.push(r.url());
	});
	return seen;
}

test.describe('accounts: ?next= sanitisation', () => {
	test('signed in, /login?next=<unsafe> always lands on /account (never off-site); safe paths are kept', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'next' });
		await apiLogin(page, shop, email);
		const offsite = offsiteRequests(page);
		for (const raw of BAD_NEXT) {
			await page.goto(`/login?${new URLSearchParams({ next: raw })}`);
			await page.waitForURL((u) => u.pathname === '/account', { timeout: 15_000 });
			expect(new URL(page.url()).origin, `next=${JSON.stringify(raw)}`).toBe(stack.sfUrl);
		}
		for (const [raw, want] of [
			['/shop?sort=price#grid', '/shop?sort=price#grid'],
			['/a/../cart', '/cart']
		]) {
			await page.goto(`/login?${new URLSearchParams({ next: raw })}`);
			await page.waitForURL((u) => u.pathname + u.search + u.hash === want, { timeout: 15_000 });
		}
		expect(offsite.filter((u) => /evil|x\.example/.test(u))).toEqual([]);
	});

	test('signed in, the one-shot /login links are not bounced away: ?forgot=1 opens the forgot panel, ?session=expired shows its notice', async ({ page, shop, stack, mailpit, unique }) => {
		// storefront-account.md §2: "Already logged in (and none of the above) → goto(next)" — ?forgot=1 is one of "the above".
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'next-forgot' });
		await apiLogin(page, shop, email);
		await page.goto('/login?session=expired');
		await expect(notice(page)).toHaveText(COPY.SESSION_EXPIRED);
		const meCall = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/customers/me');
		await page.goto('/login?forgot=1');
		await expect(page.locator('#wf-panel-forgot')).toBeVisible();
		// The page's own session check answers; whatever it triggers (a client-side goto loads the next
		// route's code and data) has finished once the network is quiet.
		expect((await meCall).status()).toBe(200);
		await page.waitForLoadState('networkidle');
		expect(new URL(page.url()).pathname, 'a signed-in visitor asking for a reset link is bounced to /account').toBe('/login');
		await expect(page.locator('#wf-panel-forgot')).toBeVisible();
	});

	test('logging in through the form honours a safe ?next= and ignores //evil', async ({ page, shop, stack, mailpit, unique, newContext }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'next-form' });
		await openLogin(page, shop, `?${new URLSearchParams({ next: '//evil.example/steal' })}`);
		await logInUI(page, email);
		await waitAccountReady(page);

		const ctx = await newContext();
		const p2 = await ctx.newPage();
		await p2.goto(`/login?${new URLSearchParams({ next: '/cart' })}`);
		await expect(p2.locator('#wf-login-form')).toBeVisible();
		await logInUI(p2, email);
		await p2.waitForURL((u) => u.pathname === '/cart');
	});
});

test.describe('accounts: logout and expiry', () => {
	test('logout → /, /me is null, nav + footer point at /login again, /account bounces to /login', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'logout' });
		await openLogin(page, shop);
		await logInUI(page, email);
		await waitAccountReady(page);
		await expect(navAccount(page)).toHaveAttribute('href', '/account');
		expect(await page.evaluate(() => localStorage.getItem('wefeasto_signed_in'))).toBe('1');

		const out = page.waitForResponse((r) => r.url().endsWith('/api/customers/logout'));
		await page.locator('[data-wf-logout]').click();
		expect((await out).status()).toBe(200);
		await page.waitForURL((u) => u.pathname === '/');
		await shop.waitHydrated();
		await expect(navAccount(page)).toHaveAttribute('href', '/login');
		await expect(navAccount(page)).toHaveAttribute('aria-label', 'Login');
		await expect(footerAccount(page)).toHaveAttribute('href', '/login');
		await expect(footerAccount(page)).toHaveText('Login');
		expect(await me(page)).toBeNull();
		expect(await page.evaluate(() => localStorage.getItem('wefeasto_signed_in'))).toBeNull();
		expect((await page.context().cookies()).filter((c) => c.name === 'payload-token' && c.value)).toEqual([]);

		await page.goto('/account');
		await page.waitForURL((u) => u.pathname === '/login' && u.searchParams.get('next') === '/account');
		await expect(page.locator('#wf-login-form')).toBeVisible();
		await expect(notice(page)).toBeHidden(); // a plain visit: no "session ended" notice
	});

	test('session ends mid-visit → Save on /account goes to /login with the notice (no loop) → log in → back on /account', async ({ page, shop, stack, mailpit, unique, admin, db }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'expiry', name: 'Ravi Menon' });
		await openLogin(page, shop);
		await logInUI(page, email);
		await waitAccountReady(page);

		await endSessions(db, admin, email); // the cookie is still there; the server no longer honours it
		await page.fill('#wf-acct-name', 'Ravi M');
		const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/customers\//.test(r.url()));
		await page.click('#wf-account-form button[type="submit"]');
		expect([401, 403]).toContain((await patch).status());
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(notice(page)).toHaveText(COPY.SESSION_EXPIRED);
		await expect.poll(() => new URL(page.url()).searchParams.get('session'), { message: 'session param stripped' }).toBeNull();
		expect(new URL(page.url()).searchParams.get('next')).toBe('/account');
		expect((await admin.findCustomer(email)).name, 'nothing was saved').toBe('Ravi Menon');

		await logInUI(page, email);
		await waitAccountReady(page);
		await expect(page.locator('[data-wf-hello]')).toContainText('Welcome back, Ravi.');
	});

	test('session ended between visits: the nav notices on the next page (back to /login) and forgets the hint', async ({ page, shop, stack, mailpit, unique, admin, db }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'expiry-nav' });
		await openLogin(page, shop);
		await logInUI(page, email);
		await waitAccountReady(page);
		await shop.visit('/shop');
		await expect(navAccount(page)).toHaveAttribute('href', '/account');

		await endSessions(db, admin, email);
		const meCall = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/customers/me');
		await shop.visit('/recipes');
		await meCall;
		await expect(navAccount(page)).toHaveAttribute('href', '/login');
		await expect(footerAccount(page)).toHaveText('Login');
		await expect.poll(() => page.evaluate(() => localStorage.getItem('wefeasto_signed_in'))).toBeNull();

		await page.goto('/account');
		await page.waitForURL((u) => u.pathname === '/login' && u.searchParams.get('next') === '/account');
	});

	test('session ends mid-checkout → the order still goes through, as a guest order', async ({ page, shop, stack, mailpit, unique, admin, db }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'expiry-co' });
		await openLogin(page, shop);
		await logInUI(page, email);
		await waitAccountReady(page);
		await shop.setCart({ 'rolled-oats': 1 });
		await shop.gotoCheckout();
		const form = await shop.fillCheckout({ method: 'cod', email });
		await endSessions(db, admin, email);
		await page.locator('#wf-place-order').click();
		const view = await shop.waitOrderView(['confirmed']);
		expect(view).toBe('confirmed');
		const { number } = shop.orderFromUrl();
		const order = await admin.findOrder(number);
		expect(order).toMatchObject({ status: 'cod_pending', contact: { email } });
		expect(order.customer ?? null, 'not linked to the (ended) session').toBeNull();
		expect(form.email).toBe(email);
	});
});

test.describe('accounts: anonymous traffic', () => {
	test('a browser that never logged in never calls /api/customers/me on / and /shop', async ({ page, shop }) => {
		const calls = [];
		page.on('request', (r) => new URL(r.url()).pathname === '/api/customers/me' && calls.push(r.url()));
		await shop.visit('/');
		await shop.visit('/shop');
		await shop.clientNav('/recipes');
		await expect(navAccount(page)).toHaveAttribute('href', '/login');
		expect(calls).toEqual([]);
	});

	test('/login has no Google button and no "or" divider', async ({ page, shop }) => {
		const google = [];
		page.on('request', (r) => /google/.test(new URL(r.url()).hostname) && google.push(r.url()));
		await openLogin(page, shop);
		await expect(page.getByText(/continue with google/i)).toHaveCount(0);
		await expect(page.locator('.wf-google, .wf-or')).toHaveCount(0);
		await page.click('#wf-tab-signup');
		await expect(page.getByText(/google/i)).toHaveCount(0);
		expect(google.filter((u) => /accounts\.google|oauth/.test(u))).toEqual([]);
	});
});

test.describe('accounts: phone layout', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the mobile menu "Account" button follows the session: /login → /account after logging in → /login after logging out', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'mnav' });
		const account = page.locator('.wf-mnav .wf-mnav-btn').filter({ hasText: 'Account' });
		const openMenu = async () => {
			await page.locator('#wf-menu-btn').click();
			await expect(page.locator('.wf-mnav')).toBeVisible();
		};
		await shop.visit('/shop');
		await openMenu();
		await expect(account).toHaveAttribute('href', '/login');
		await account.click();
		await page.waitForURL((u) => u.pathname === '/login');
		await expect(page.locator('#wf-login-form')).toBeVisible();
		await logInUI(page, email);
		await waitAccountReady(page);
		await openMenu();
		await expect(account).toHaveAttribute('href', '/account');
		await expect(account).toHaveAttribute('aria-current', 'page');
		await page.keyboard.press('Escape');
		await expect(page.locator('.wf-mnav')).toBeHidden();
		await page.locator('[data-wf-logout]').click();
		await page.waitForURL((u) => u.pathname === '/');
		await shop.waitHydrated();
		await openMenu();
		await expect(account).toHaveAttribute('href', '/login');
	});
});
