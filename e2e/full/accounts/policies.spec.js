/*
 * Policy pages + footer legal line (roadmap M7; storefront-account.md §4;
 * storefront-fixes.md §4; cms-catalog Pages). The storefront is prerendered from the
 * catalog snapshot, so publishing is build-time: here we check that with zero published
 * pages there are no links or routes, that a page published in the CMS (both switches)
 * reaches GET /api/store/snapshot, and that the review guard refuses unreviewed drafts.
 * @serial: these tests change the shared `pages` collection (restored after each test) and assert
 * the snapshot holds no other page, so they run serially and never beside another spec that publishes.
 */
import { test, expect } from '../fixtures.js';
import { PagesAdmin, apiLogin, createCustomer, pageFetch } from './helpers.js';

test.describe.configure({ mode: 'serial' });

const REVIEWED = '<h2>Where we deliver</h2><p>Across India. Message us on WhatsApp with your order number.</p>';
const snapshotPages = async (stack) => (await (await fetch(`${stack.cmsUrl}/api/store/snapshot`)).json()).pages;
const publicPages = async (stack) => (await (await fetch(`${stack.cmsUrl}/api/pages?depth=0&limit=100`)).json()).docs;
const fieldErrors = (r) => r.json?.errors?.flatMap((e) => e.data?.errors ?? []) ?? [];

let pages;
test.beforeEach(async ({ adminSession }) => {
	pages = new PagesAdmin(adminSession);
});
test.afterEach(async () => {
	await pages.restore();
});

test.describe('policies: nothing published', { tag: '@serial' }, () => {
	test('the seeded drafts are staff-only: no footer links, no routes, not in the snapshot or the public API', async ({ page, shop, stack, request }) => {
		const drafts = await pages.list();
		expect(drafts.map((p) => p.slug).sort()).toEqual(['grievances', 'refunds', 'shipping']);
		expect(drafts.every((p) => p.published === false)).toBe(true);
		expect(await snapshotPages(stack)).toEqual([]);
		expect(await publicPages(stack)).toEqual([]);

		for (const path of ['/', '/shop', '/terms']) {
			await shop.visit(path);
			const company = page.locator('.footer-link-column').nth(1).locator('a.footer-link');
			await expect(company).toHaveText(['Our Story', 'Contact', 'Terms', 'Privacy']);
			await expect(page.locator('.legal-text')).toHaveText('© 2026 Wefeasto. All rights reserved');
		}
		for (const path of ['/shipping', '/refunds', '/grievances', '/policies']) {
			const res = await request.get(`${stack.sfUrl}${path}`);
			expect(res.status(), path).toBe(404);
		}
		expect((await request.get(`${stack.sfUrl}/terms`)).status()).toBe(200);
	});
});

test.describe('policies: publishing in the CMS', { tag: '@serial' }, () => {
	test('a reviewed page with both switches on is in GET /api/store/snapshot and the public API; either switch off hides it', async ({ stack, unique }) => {
		const slug = `e2e-policy-${unique.code('').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
		const created = await pages.create({ slug, title: 'Delivery & Returns', bodyHtml: REVIEWED, published: true, sortOrder: 5, _status: 'published' });
		expect(created.status, created.text.slice(0, 300)).toBe(201);

		let snap = await snapshotPages(stack);
		expect(snap.map((p) => p.slug)).toEqual([slug]);
		expect(snap[0]).toMatchObject({ slug, title: 'Delivery & Returns', bodyHtml: REVIEWED });
		expect((await publicPages(stack)).map((p) => p.slug)).toEqual([slug]);

		// Box unticked (still published): gone.
		expect((await pages.update(slug, { published: false })).status).toBe(200);
		expect(await snapshotPages(stack)).toEqual([]);
		expect(await publicPages(stack)).toEqual([]);

		// Box ticked on a draft only: the published version (unticked) stays what the site sees.
		const draft = await pages.s.request('PATCH', `pages/${created.json.doc.id}?draft=true&depth=0`, { body: { published: true, _status: 'draft' } });
		expect(draft.status, draft.text.slice(0, 200)).toBe(200);
		snap = await snapshotPages(stack);
		expect(snap).toEqual([]);
	});

	test('the review guard: a page with the "Draft — to be reviewed" line or a "[to be added]" placeholder cannot go live', async ({ stack }) => {
		const before = await pages.list();
		for (const slug of ['shipping', 'grievances']) {
			const r = await pages.update(slug, { published: true, _status: 'published' });
			expect(r.status, `${slug}: ${r.text.slice(0, 200)}`).toBe(400);
			const errs = fieldErrors(r);
			expect(errs.find((e) => e.path === 'bodyHtml')?.message, slug).toMatch(/Draft — to be reviewed|\[to be added\]/);
		}
		// Same for a new page and for the title.
		const body = await pages.create({ slug: 'e2e-unreviewed', title: 'Grievances', bodyHtml: '<p>Name: [to be added]</p>', published: true, _status: 'published' });
		expect(body.status).toBe(400);
		expect(fieldErrors(body).map((e) => e.path)).toContain('bodyHtml');
		const title = await pages.create({ slug: 'e2e-unreviewed-t', title: 'Draft - to be reviewed', bodyHtml: REVIEWED, published: true, _status: 'published' });
		expect(title.status).toBe(400);
		expect(fieldErrors(title).map((e) => e.path)).toContain('title');
		// Unsafe HTML is refused as well.
		const unsafe = await pages.create({ slug: 'e2e-unsafe', title: 'Unsafe', bodyHtml: '<p>hi</p><script>alert(1)</script>', published: true, _status: 'published' });
		expect(unsafe.status).toBe(400);

		expect(await snapshotPages(stack)).toEqual([]);
		const after = await pages.list();
		expect(after.map(({ slug, published, _status, bodyHtml }) => ({ slug, published, _status, bodyHtml }))).toEqual(
			before.map(({ slug, published, _status, bodyHtml }) => ({ slug, published, _status, bodyHtml }))
		);
	});

	test('a customer cannot read the drafts through REST', async ({ page, shop, stack, mailpit, unique }) => {
		const { email } = await createCustomer({ stack, mailpit, unique }, { tag: 'pages-reader' });
		await apiLogin(page, shop, email);
		const r = await pageFetch(page, 'GET', '/api/pages?depth=0&limit=100&draft=true');
		expect(r.status).toBe(200);
		expect(r.json.docs).toEqual([]);
		const v = await pageFetch(page, 'GET', '/api/pages/versions?limit=10');
		expect([401, 403]).toContain(v.status);
	});
});
