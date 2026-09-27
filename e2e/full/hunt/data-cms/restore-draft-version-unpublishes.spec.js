/*
 * HUNT data-cms (round 3): "Restore this version" on a DRAFT version takes a live product off sale.
 *
 * A product is published; the owner saves a draft (e.g. a new price), later publishes something else,
 * then opens Versions, picks the draft and clicks "Restore this version" — for a draft version that is
 * the ONLY restore option Payload's admin offers (its "Restore as draft" sub-option is hidden when the
 * version's status is draft), and it POSTs /api/products/versions/:id?draft=false.
 * Payload then writes the draft's content WITH `_status: 'draft'` onto the live row: the product drops out
 * of /api/store/catalog (every bag holding it is refused at checkout), public REST can no longer read it,
 * and the deploy hook rebuilds the storefront without its page. The admin just sees "Restored successfully".
 *
 * The project's own rule (src/lib/draftSafeUpdate.ts): "A save that says neither 'draft' nor 'publish'
 * must never unpublish a live document" — but keepPublishStateOnPlainUpdate only runs for operation
 * 'update', and restoreVersion is a different operation.
 *
 * Correct behaviour: restoring a draft version of a published document keeps it on sale (the restored
 * content becomes a pending draft, or is published) — never a silent unpublish.
 */
import { test, expect } from '../../fixtures.js';
import { createProduct, deleteProduct } from './helpers.js';

async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

/** Published product → draft save (price ₹300) → publish (price ₹260). Resolves { doc, draftVersionId }. */
async function productWithOlderDraft(admin) {
	const doc = await createProduct(admin, { pricePaise: 25000 });
	const d = await admin.request('PATCH', `products/${doc.id}?draft=true&depth=0`, { body: { pricePaise: 30000, _status: 'draft' } });
	expect(d.status, d.text.slice(0, 200)).toBe(200);
	const p = await admin.request('PATCH', `products/${doc.id}?depth=0`, { body: { pricePaise: 26000, _status: 'published' } });
	expect(p.status, p.text.slice(0, 200)).toBe(200);
	const vs = await admin.request('GET', `products/versions?where[parent][equals]=${doc.id}&sort=-updatedAt&depth=0&limit=50`);
	const draft = vs.json.docs.find((v) => v.version?._status === 'draft');
	expect(draft, 'the draft version exists').toBeTruthy();
	return { doc, draftVersionId: draft.id };
}

async function onSale(admin, api, doc) {
	const live = await admin.request('GET', `products/${doc.id}?depth=0`);
	const catalog = await api.get('store/catalog');
	return {
		status: live.json?._status,
		inLiveCatalog: (catalog.json?.products ?? []).some((p) => p.slug === doc.slug)
	};
}

test('admin UI: "Restore this version" on a draft version keeps the product on sale', async ({ page, stack, admin, api }) => {
	const { doc, draftVersionId } = await productWithOlderDraft(admin);
	try {
		expect(await onSale(admin, api, doc)).toEqual({ status: 'published', inLiveCatalog: true });
		await adminLogin(page, stack);
		await page.goto(`${stack.cmsUrl}/admin/collections/products/${doc.id}/versions/${draftVersionId}`);
		await page.getByRole('button', { name: /Restore this version/i }).first().click({ timeout: 30_000 });
		const restored = page.waitForResponse((r) => r.url().includes(`/api/products/versions/${draftVersionId}`) && r.request().method() === 'POST');
		await page.getByRole('dialog').getByRole('button', { name: /^Confirm$/i }).click();
		const res = await restored;
		expect(res.url(), 'the only option for a draft version is a non-draft restore').toContain('draft=false');
		expect(res.status()).toBe(200);
		expect(await onSale(admin, api, doc), 'still published and sellable after the restore').toEqual({ status: 'published', inLiveCatalog: true });
	} finally {
		await deleteProduct(admin, doc.id);
	}
});

test('REST: restoring a draft version of a live policy page keeps it on the storefront', async ({ admin }) => {
	const slug = `hunt-restore-${Date.now().toString(36)}`;
	const c = await admin.request('POST', 'pages?depth=0', { body: { title: 'Hunt page', slug, bodyHtml: '<p>v1</p>', published: true, _status: 'published' } });
	expect(c.status, c.text.slice(0, 200)).toBe(201);
	const id = c.json.doc.id;
	try {
		await admin.request('PATCH', `pages/${id}?draft=true&depth=0`, { body: { bodyHtml: '<p>v2 draft</p>', _status: 'draft' } });
		await admin.request('PATCH', `pages/${id}?depth=0`, { body: { bodyHtml: '<p>v3</p>', _status: 'published' } });
		const vs = await admin.request('GET', `pages/versions?where[parent][equals]=${id}&depth=0&limit=50`);
		const draft = vs.json.docs.find((v) => v.version?._status === 'draft');
		const r = await admin.request('POST', `pages/versions/${draft.id}?draft=false`);
		expect(r.status, r.text.slice(0, 200)).toBe(200);
		const snap = await admin.request('GET', 'store/snapshot');
		expect((snap.json?.pages ?? []).map((p) => p.slug), 'the page is still in the storefront snapshot').toContain(slug);
	} finally {
		await admin.request('DELETE', `pages/${id}`);
	}
});

test('REST: restoring a draft version (?draft=false, as the admin does) keeps the product on sale', async ({ admin, api }) => {
	const { doc, draftVersionId } = await productWithOlderDraft(admin);
	try {
		const r = await admin.request('POST', `products/versions/${draftVersionId}?draft=false`);
		expect(r.status, r.text.slice(0, 200)).toBe(200);
		expect(await onSale(admin, api, doc), 'still published and sellable after the restore').toEqual({ status: 'published', inLiveCatalog: true });
	} finally {
		await deleteProduct(admin, doc.id);
	}
});
