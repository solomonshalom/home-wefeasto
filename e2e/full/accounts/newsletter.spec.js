/*
 * Newsletter double opt-in (roadmap M6 + S6; retention-backend.md §1–4;
 * storefront-account.md §3): the home form posts to our own /api (never webflow.com),
 * one confirmation email, the confirm link lands on /?subscribed=1, the welcome email
 * carries a HELLO- code bound to the address and List-Unsubscribe headers; confirming
 * twice is idempotent; expired / replaced / unknown links land on /?subscribed=expired.
 */
import { test, expect } from '../fixtures.js';
import { COPY, SUBJECT, confirmLink, expectHomeNotice, header, subscribeUI, unsubscribeLink, welcomeCode } from './helpers.js';

const DAY = 86_400_000;

test.describe('newsletter: subscribe and confirm', () => {
	test('home form → no webflow.com request → one confirmation email → /?subscribed=1 → welcome email with HELLO- code + List-Unsubscribe', async ({ page, shop, stack, admin, mailpit, unique }) => {
		const webflow = [];
		page.on('request', (r) => /(^|\.)webflow\.com$/.test(new URL(r.url()).hostname) && webflow.push(r.url()));
		const email = unique.email('nl-full');
		await subscribeUI(page, shop, email);
		await expect(page.locator('#email-form-2')).toBeHidden();
		await expect(page.locator('.w-form-done')).toBeFocused();

		await expect.poll(async () => (await admin.findSubscriber(email))?.status, { message: 'pending row (written after the response)' }).toBe('pending');
		const sub = await admin.findSubscriber(email);
		expect(sub).toMatchObject({ email, source: 'newsletter' });
		expect(sub.consentText).toBeTruthy();

		const msg = await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM });
		expect((await mailpit.settle(email, { quietMs: 2000 })).map((m) => m.Subject), 'exactly one confirmation email').toEqual([msg.Subject]);
		const link = confirmLink(mailpit, msg);
		expect(new URL(link).origin, 'confirm links go to the CMS, which 303s to the storefront').toBe(stack.cmsUrl);
		expect(header(await mailpit.headers(msg.ID), 'List-Unsubscribe'), 'not on the list yet: no List-Unsubscribe').toEqual([]);

		await page.goto(link);
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_SUBSCRIBED, formHidden: true });
		await expect.poll(async () => (await admin.findSubscriber(email))?.status).toBe('confirmed');

		const welcome = await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.WELCOME });
		expect(welcome.Subject).toBe("You're in — here's 10% off your first order");
		const code = welcomeCode(welcome);
		expect(welcome.Text).toContain('up to ₹75');
		const links = mailpit.extractLinks(welcome);
		expect(links, 'the CTA opens the bag with the offer').toContain(`${stack.sfUrl}/cart?offer=${code}`);
		// Every storefront link in the welcome email resolves (two recipes, the shop, the offer).
		const recipes = links.filter((l) => l.startsWith(`${stack.sfUrl}/recipes/`));
		expect(recipes.length, 'two published recipes').toBe(2);
		for (const l of links.filter((l) => l.startsWith(stack.sfUrl))) {
			expect((await fetch(l)).status, l).toBe(200);
		}
		expect(unsubscribeLink(mailpit, welcome).startsWith(`${stack.cmsUrl}/api/store/newsletter/unsubscribe?t=`)).toBe(true);

		const h = await mailpit.headers(welcome.ID);
		const lu = header(h, 'List-Unsubscribe');
		expect(lu.length).toBe(1);
		expect(lu[0]).toMatch(new RegExp(`^<${stack.cmsUrl.replace(/[.:/]/g, '\\$&')}/api/store/newsletter/unsubscribe\\?t=[A-Za-z0-9_-]+>`));
		expect(header(h, 'List-Unsubscribe-Post')).toEqual(['List-Unsubscribe=One-Click']);

		// S6 coupon record: unique, 10% capped at ₹75, one use, first order only, bound to this address, 30 days.
		const coupon = await admin.getCoupon(code);
		expect(coupon).toMatchObject({ code, type: 'percent', value: 10, maxDiscountPaise: 7500, usageLimit: 1, perCustomerLimit: 1, firstOrderOnly: true, boundEmail: email, active: true });
		const days = (Date.parse(coupon.endsAt) - Date.parse(coupon.startsAt)) / DAY;
		expect(days).toBeCloseTo(30, 1);
		// The terms name the last valid day (endsAt is exclusive), in IST.
		const lastDay = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(Date.parse(coupon.endsAt) - 1));
		expect(welcome.Text.replace(/\s+/g, ' ')).toContain(`until ${lastDay}.`);
		const row = await admin.findSubscriber(email);
		expect(row.welcomeCoupon === coupon.id || row.welcomeCoupon?.id === coupon.id).toBe(true);

		// Confirming twice is idempotent: same landing, no second welcome email or code.
		const again = await fetch(link, { redirect: 'manual' });
		expect(again.status).toBe(303);
		expect(again.headers.get('location')).toBe(`${stack.sfUrl}/?subscribed=1#newsletter`);
		const all = await mailpit.settle(email, { quietMs: 2500 });
		expect(all.map((m) => m.Subject).filter((s) => s.startsWith("You're in"))).toHaveLength(1);
		expect(webflow).toEqual([]);
	});

	test('mixed-case, padded email → one lower-cased row; a repeat sign-up sends nothing new; honeypot → nothing stored', async ({ page, shop, admin, api, mailpit, unique }) => {
		const email = unique.email('nl-case');
		const shouty = `  ${email.replace(/^[a-z]+/, (m) => m.toUpperCase()).replace('@e2e', '@E2E')}  `;
		await subscribeUI(page, shop, shouty);
		await expect.poll(async () => (await admin.listSubscribers({ email })).map((s) => s.email)).toEqual([email]);
		await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM });
		expect((await api.newsletter(email.toUpperCase())).status).toBe(200); // pending, within the 10-minute cooldown
		expect(await admin.listSubscribers({ email })).toHaveLength(1);

		const bot = unique.email('nl-bot');
		const r = await api.newsletter(bot, { website: 'https://spam.example' });
		expect(r).toMatchObject({ status: 200, json: { ok: true } });
		// A control address posted after the bot: once its row exists, the bot's would too.
		const control = unique.email('nl-control');
		await api.newsletter(control);
		await expect.poll(async () => (await admin.findSubscriber(control))?.status).toBe('pending');
		await mailpit.waitForMessage({ to: control, subjectIncludes: SUBJECT.NL_CONFIRM });
		expect(await admin.findSubscriber(bot)).toBeNull();
		expect(await mailpit.messages(bot)).toEqual([]);
		expect((await mailpit.settle(email, { quietMs: 1500 })).length, 'still one confirmation email').toBe(1);
	});

	test('an address the server refuses shows the field error, and typing clears it', async ({ page, shop }) => {
		await shop.visit('/');
		const form = page.locator('#email-form-2');
		await form.locator('input[name="email"]').fill('asha@localhost'); // passes the browser's check, not the server's
		const res = page.waitForResponse((r) => r.url().endsWith('/api/store/newsletter'));
		await form.locator('input[type="submit"]').click();
		expect((await res).status()).toBe(400);
		await expect(form).toHaveAttribute('data-wf-nl-state', 'error');
		await expect(page.locator('.w-form-fail')).toHaveText('That email doesn’t look right — check it and try again.');
		await expect(form).toBeVisible();
		await form.locator('input[name="email"]').pressSequentially('x');
		await expect(page.locator('.w-form-fail')).toBeHidden();
		await expect(form).toHaveAttribute('data-wf-nl-state', 'idle');
	});
});

test.describe('newsletter: dead confirm links', () => {
	test('unknown, missing and expired (7 days) confirm links → /?subscribed=expired', async ({ page, shop, stack, admin, api, db, mailpit, unique }) => {
		for (const q of ['?t=not-a-real-token-0000000000000000000000000', '']) {
			await page.goto(`${stack.cmsUrl}/api/store/newsletter/confirm${q}`);
			await expectHomeNotice(page, shop, { tone: 'fail', text: COPY.NL_EXPIRED, formHidden: false });
		}
		const email = unique.email('nl-expired');
		await api.newsletter(email);
		const link = confirmLink(mailpit, await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM }));
		await db.query("update subscribers set confirm_token_expires_at = now() - interval '1 minute' where email = $1", [email]);
		await page.goto(link);
		await expectHomeNotice(page, shop, { tone: 'fail', text: COPY.NL_EXPIRED, formHidden: false });
		expect((await admin.findSubscriber(email)).status).toBe('pending');
	});

	test('a new sign-up after the cooldown replaces the link: the old one is dead, the new one confirms', async ({ page, shop, admin, api, db, mailpit, unique }) => {
		const email = unique.email('nl-replaced');
		await api.newsletter(email);
		const first = confirmLink(mailpit, await mailpit.waitForMessage({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM }));
		await db.query("update subscribers set last_confirm_sent_at = now() - interval '11 minutes' where email = $1", [email]);
		await api.newsletter(email);
		const both = await mailpit.waitForMessages({ to: email, subjectIncludes: SUBJECT.NL_CONFIRM, count: 2 });
		const second = confirmLink(mailpit, both[both.length - 1]);
		expect(second).not.toBe(first);
		await page.goto(first);
		await expectHomeNotice(page, shop, { tone: 'fail', text: COPY.NL_EXPIRED });
		await page.goto(second);
		await expectHomeNotice(page, shop, { tone: 'done', text: COPY.NL_SUBSCRIBED, formHidden: true });
		await expect.poll(async () => (await admin.findSubscriber(email))?.status).toBe('confirmed');
	});
});

test.describe('newsletter: landing notices', () => {
	test('every redirect outcome shows its copy (errors in the fail region); unknown values show nothing; the param is stripped', async ({ page, shop }) => {
		const cases = [
			['subscribed=1', 'done', COPY.NL_SUBSCRIBED, true],
			['subscribed=expired', 'fail', COPY.NL_EXPIRED, false],
			['subscribed=error', 'fail', 'Something went wrong confirming — please tap the link in your email again.', false],
			['unsubscribed=1', 'done', COPY.NL_UNSUBSCRIBED, false],
			['unsubscribed=invalid', 'fail', COPY.NL_UNSUB_INVALID, false],
			['unsubscribed=error', 'fail', 'Something went wrong — please try the link again.', false]
		];
		for (const [q, tone, text, formHidden] of cases) {
			await page.goto(`/?${q}#newsletter`);
			await expectHomeNotice(page, shop, { tone, text, formHidden });
		}
		await page.goto('/?subscribed=bogus#newsletter');
		await shop.waitHydrated();
		await expect.poll(() => new URL(page.url()).searchParams.has('subscribed')).toBe(false);
		await expect(page.locator('.w-form-done')).toBeHidden();
		await expect(page.locator('.w-form-fail')).toBeHidden();
		await expect(page.locator('#email-form-2')).toBeVisible();
		await expect(page.locator('#email-form-2')).not.toContainText(/already subscribed/i);
	});
});
