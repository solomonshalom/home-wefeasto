/*
 * HUNT data-cms: deleting a media file that is a published product's only image makes the CMS serve an
 * invalid snapshot.
 *
 * Products may leave `image` empty when `imageUpload` is set (cms-catalog.md §1). Media delete has no
 * in-use guard (editors and admins can delete), the FK sets products.image_upload_id to NULL, and the
 * product stays published with neither. GET /api/store/snapshot then emits `image: ""`, which the
 * storefront validator rejects ("products[i].image: must not be empty"): sync-cms refuses it, so with
 * CMS_REQUIRED=1 every storefront build fails, and without it the site silently stops picking up any
 * catalog change. cms-catalog.md §3 promises the snapshot "always validates".
 *
 * Correct behaviour: the media delete is refused while a product uses it, or the snapshot still validates.
 */
import { test, expect } from '../../fixtures.js';
import { validateSnapshot } from '../../../../src/lib/data/snapshot-schema.js';
import { createProduct, deleteProduct, uploadPng } from './helpers.js';

test('deleting the media a published product uses as its only image keeps /api/store/snapshot valid', async ({ admin, api, stack }) => {
	const media = await uploadPng(admin, { cmsUrl: stack.cmsUrl });
	const product = await createProduct(admin, { image: '', imageUpload: media.id });
	try {
		const before = await api.get('store/snapshot');
		expect(validateSnapshot(before.json).ok).toBe(true);
		expect(before.json.products.find((p) => p.slug === product.slug)?.image).toBe(`/api/media/file/${media.filename}`);

		const del = await admin.request('DELETE', `media/${media.id}`);
		if (del.status >= 400) return; // refused while in use: fine

		const after = await api.get('store/snapshot');
		expect(after.status).toBe(200);
		const { ok, errors } = validateSnapshot(after.json);
		expect(ok, errors.join('\n')).toBe(true);
	} finally {
		await deleteProduct(admin, product.id);
		await admin.request('DELETE', `media/${media.id}`);
	}
});
