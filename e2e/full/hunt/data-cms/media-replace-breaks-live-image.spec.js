/*
 * HUNT data-cms (round 3): replacing the file of an uploaded image that a published product uses breaks
 * that product's image on the live storefront, and nothing rebuilds the site.
 *
 * The storefront is prerendered: the product's `image` is baked in from /api/store/snapshot at build time
 * (an upload resolves to /api/media/file/<filename>). In the admin, Media → the image → × (remove file) →
 * drop a new photo → Save (PATCH /api/media/:id, multipart) gives the doc a NEW filename and Payload deletes
 * the old file. So the URL every built page still uses (product page, /shop card, home, bag, search) stops
 * resolving (404 from the blob store in production; 500 "Something went wrong" from local disk here).
 * The Media collection has no deploy hook (only products/recipes/pages/settings do), and the product itself
 * did not change, so no rebuild is scheduled: the broken image stays until some unrelated publish.
 * (Deleting an in-use image is refused with MediaInUseError; replacing its file is not.)
 *
 * Correct behaviour: after the owner replaces an in-use image, the image the live storefront shows keeps
 * loading (keep the old file / stable URL, or refuse the replacement while products use it), and the
 * change schedules a storefront rebuild so the new photo goes live.
 */
import { test, expect } from '../../fixtures.js';
import { createProduct, deleteProduct, uploadPng } from './helpers.js';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

/** A published product whose only image is a fresh upload. Resolves { product, media, liveImage }. */
async function productWithUpload(admin, stack) {
	const media = await uploadPng(admin, { cmsUrl: stack.cmsUrl, filename: `hunt-replace-${Date.now().toString(36)}.png` });
	const product = await createProduct(admin, { image: '', imageUpload: media.id });
	const snap = await fetch(`${stack.cmsUrl}/api/store/snapshot`).then((r) => r.json());
	const liveImage = snap.products.find((p) => p.slug === product.slug)?.image;
	expect(liveImage, 'the snapshot (what a build bakes in) uses the upload').toMatch(/^\/api\/media\/file\//);
	const before = await fetch(`${stack.sfUrl}${liveImage}`);
	expect(before.status, 'the image loads on the storefront before the change').toBe(200);
	return { product, media, liveImage };
}

test('admin UI: replacing an in-use image file keeps the live storefront image working', async ({ page, stack, admin }) => {
	const { product, media, liveImage } = await productWithUpload(admin, stack);
	try {
		await adminLogin(page, stack);
		await page.goto(`${stack.cmsUrl}/admin/collections/media/${media.id}`);
		await page.locator('.file-details__remove').click({ timeout: 30_000 });
		await page.locator('input[type=file]').first().setInputFiles({ name: `hunt-new-${Date.now().toString(36)}.png`, mimeType: 'image/png', buffer: PNG_1X1 });
		const saved = page.waitForResponse((r) => r.url().includes(`/api/media/${media.id}`) && r.request().method() === 'PATCH');
		await page.getByRole('button', { name: /^Save$/ }).click();
		const status = (await saved).status();
		// Either refused while products use the image (the old file stays) or saved — the live image must keep working.
		expect([200, 400, 409], `admin save → ${status}`).toContain(status);
		const after = await fetch(`${stack.sfUrl}${liveImage}`);
		expect(after.status, `save → ${status}; the storefront built with ${liveImage} now gets ${after.status} for the product image`).toBe(200);
	} finally {
		await deleteProduct(admin, product.id);
		await admin.request('DELETE', `media/${media.id}`);
	}
});

test('REST: PATCH /api/media/:id with a new file keeps the live storefront image working', async ({ stack, admin }) => {
	const { product, media, liveImage } = await productWithUpload(admin, stack);
	try {
		const fd = new FormData();
		fd.append('file', new Blob([PNG_1X1], { type: 'image/png' }), `hunt-new-${Date.now().toString(36)}.png`);
		fd.append('_payload', JSON.stringify({ alt: 'hunt test image' }));
		const r = await fetch(`${stack.cmsUrl}/api/media/${media.id}`, { method: 'PATCH', headers: { Authorization: `JWT ${admin.session.token}` }, body: fd });
		const text = await r.text();
		// Either refused while in use (the old file stays) or accepted — the live image must keep working.
		if (r.status === 200) expect(JSON.parse(text).doc.url).toBeTruthy();
		const after = await fetch(`${stack.sfUrl}${liveImage}`);
		expect(after.status, `replace → ${r.status}; the storefront built with ${liveImage} now gets ${after.status}`).toBe(200);
	} finally {
		await deleteProduct(admin, product.id);
		await admin.request('DELETE', `media/${media.id}`);
	}
});
