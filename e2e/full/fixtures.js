/*
 * Fixtures for full-stack specs (e2e/full/**). Import `test` and `expect` from here:
 *
 *   import { test, expect } from '../fixtures.js';          // from e2e/full/<domain>/x.spec.js
 *   test('…', async ({ page, stack, admin, db, cron, mailpit, mock, api, shop, unique }) => { … });
 *
 * Worker-scoped: stack (state.json of the slot), adminSession, db, cron, mock, api, mailpit.
 * Test-scoped:   admin (restores what it changed), consoleErrors (fails the test on
 *                unexpected console errors / page errors), shop (page helpers bound to
 *                `page`), unique, newContext (extra contexts with the same variant + error
 *                collection). Automatic: mail to the test's unique addresses is deleted after it.
 * Options:       variant: 'normal' | 'nofx' | 'storage-throws' | 'storage-blocked'
 *                failOnConsoleErrors: true
 *
 * Reference with examples: e2e/full/README.md.
 */
import { test as base, expect } from '@playwright/test';
import { readStack } from './support/env.js';
import { AdminClient, AdminSession, Cron } from './support/admin.js';
import { Db } from './support/db.js';
import { Mailpit } from './support/mailpit.js';
import { MockGateway } from './support/mock.js';
import { StoreApi } from './support/api.js';
import { ConsoleErrors } from './support/errors.js';
import { checkoutForm, pin, phone, trackEmail, trackedEmails, uniqueCode, uniqueEmail } from './support/unique.js';
import * as pageHelpers from './support/page.js';

const flag = (v) => /^(1|true|yes)$/i.test(String(v ?? '').trim());

/** Page helpers bound to one page: shop.addToCart('muesli', 2), shop.placeCodOrder({ items }) … */
function bindShop(page) {
	const h = pageHelpers;
	return {
		page,
		variant: () => h.variantOf(page),
		waitHydrated: (o) => h.waitHydrated(page, o),
		visit: (path) => h.visit(page, path),
		clientNav: (path) => h.clientNav(page, path),
		cartCount: () => h.cartCount(page),
		readCart: () => h.readCart(page),
		addToCart: (slug, qty) => h.addToCart(page, slug, qty),
		setCart: (map) => h.setCart(page, map),
		gotoCart: () => h.gotoCart(page),
		gotoCheckout: () => h.gotoCheckout(page),
		fillCheckout: (overrides) => h.fillCheckout(page, overrides),
		payReady: (o) => h.payReady(page, o),
		waitOrderView: (views, o) => h.waitOrderView(page, views, o),
		orderFromUrl: () => h.orderFromUrl(page.url()),
		placeOnlineOrder: (o) => h.placeOnlineOrder(page, o),
		placeCodOrder: (o) => h.placeCodOrder(page, o)
	};
}

export const test = base.extend({
	/* ------------------------------------------------------------ options */
	variant: ['normal', { option: true }],
	failOnConsoleErrors: [true, { option: true }],

	/* ------------------------------------------------------------ worker-scoped clients */
	stack: [
		// eslint-disable-next-line no-empty-pattern
		async ({}, use) => {
			await use(readStack());
		},
		{ scope: 'worker' }
	],
	adminSession: [
		async ({ stack }, use) => {
			const s = new AdminSession(stack);
			await s.login();
			await use(s);
		},
		{ scope: 'worker' }
	],
	db: [
		async ({ stack }, use) => {
			const db = new Db(stack.dbUri);
			await use(db);
			await db.close();
		},
		{ scope: 'worker' }
	],
	cron: [async ({ stack }, use) => use(new Cron(stack)), { scope: 'worker' }],
	mock: [async ({ stack }, use) => use(new MockGateway(stack)), { scope: 'worker' }],
	api: [async ({ stack }, use) => use(new StoreApi(stack)), { scope: 'worker' }],

	/* ------------------------------------------------------------ test-scoped */
	admin: async ({ adminSession }, use) => {
		const admin = new AdminClient(adminSession);
		await use(admin);
		await admin.restoreAll(); // throws → the test fails: a leaked change would poison later tests
	},

	mailpit: [async ({ stack }, use) => use(new Mailpit(stack.mailpitUrl)), { scope: 'worker' }],

	/**
	 * After every test: delete the mail sent to the addresses it created (uniqueEmail(),
	 * checkoutForm(), trackEmail()), whether or not it used `mailpit`. On failure the
	 * subjects are attached first. E2E_KEEP_MAIL=1 keeps everything.
	 */
	_mailCleanup: [
		async ({ mailpit }, use, testInfo) => {
			await use();
			const addrs = trackedEmails(testInfo);
			if (!addrs.length) return;
			if (testInfo.status !== testInfo.expectedStatus) {
				const lines = [];
				for (const a of addrs) for (const m of await mailpit.messages(a).catch(() => [])) lines.push(`${a}\t${m.Created}\t${m.Subject}`);
				await testInfo.attach('mailpit-messages.txt', { body: lines.join('\n') || '(none)', contentType: 'text/plain' });
			}
			if (flag(process.env.E2E_KEEP_MAIL)) return;
			for (const a of addrs) await mailpit.cleanup(a).catch(() => {});
		},
		{ auto: true }
	],

	unique: async ({}, use) => {
		await use({ email: uniqueEmail, phone, pin, code: uniqueCode, form: checkoutForm, track: trackEmail });
	},

	consoleErrors: async ({}, use) => {
		await use(new ConsoleErrors());
	},

	/** Every context gets the variant's init scripts and the console-error collector. */
	context: async ({ context, variant, consoleErrors, stack }, use) => {
		await pageHelpers.prepareContext(context, { variant, sfOrigin: stack.sfUrl });
		consoleErrors.watch(context);
		await use(context);
	},

	/** Extra contexts (second device / tab group), prepared like `context` and closed after the test. */
	newContext: async ({ browser, variant, consoleErrors, stack, contextOptions, viewport, userAgent, locale }, use) => {
		const made = [];
		await use(async (opts = {}) => {
			const { variant: v = variant, ...rest } = opts;
			const base = { ...contextOptions, viewport, ...(userAgent ? { userAgent } : {}), ...(locale ? { locale } : {}), baseURL: stack.sfUrl };
			const ctx = await browser.newContext({ ...base, ...rest });
			await pageHelpers.prepareContext(ctx, { variant: v, sfOrigin: stack.sfUrl });
			consoleErrors.watch(ctx);
			made.push(ctx);
			return ctx;
		});
		for (const c of made) await c.close().catch(() => {});
	},

	/** Fails a test that passed when the collector saw unexpected errors (runs after the page closes). */
	_consoleGate: [
		async ({ consoleErrors, failOnConsoleErrors }, use, testInfo) => {
			await use();
			const errs = consoleErrors.list();
			if (!errs.length) return;
			await testInfo.attach('console-errors.txt', { body: consoleErrors.summary(), contentType: 'text/plain' });
			if (failOnConsoleErrors && testInfo.status === testInfo.expectedStatus) {
				throw new Error(
					`unexpected console errors / page errors (${errs.length}):\n${consoleErrors.summary()}\n` +
						`Allow expected ones with consoleErrors.allow(/pattern/) or test.use({ failOnConsoleErrors: false }).`
				);
			}
		},
		{ auto: true }
	],

	shop: async ({ page }, use) => {
		await use(bindShop(page));
	}
});

export { expect };
export * from './support/page.js';
export { setMockAuto, mockModal } from './support/mock.js';
export { uniqueEmail, phone, pin, uniqueCode, checkoutForm, trackEmail, DEFAULT_ADDRESS } from './support/unique.js';
export { SLOT, CFG, readStack } from './support/env.js';
