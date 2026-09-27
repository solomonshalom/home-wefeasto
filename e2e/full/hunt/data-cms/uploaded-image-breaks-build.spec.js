/*
 * HUNT data-cms (round 2, merged into image-path-typo-breaks-build): an uploaded product image must
 * not block the storefront build.
 *
 * Products → Images → upload: the snapshot's `image` becomes the upload's root-relative URL
 * (/api/media/file/<name>, serialize.ts resolveImage), which the storefront serves through its /api
 * proxy/rewrite at runtime. The prerender crawler follows the <img src> on /shop, can't fetch /api/…
 * (the CMS is not part of the static build) and used to fail the build with a 404, exactly like a
 * mistyped static path.
 *
 * Correct behaviour: sync + build succeed, the page renders the upload's URL, and the build log gets
 * no "fix the link in the CMS" warning for it (the file is fine; only the crawler can't see it).
 */
import { test, expect } from '../../fixtures.js';
import { createProduct, deleteProduct, errorLines, syncAndBuild, uploadPng } from './helpers.js';

test.describe.configure({ timeout: 300_000 });

test('a product whose only image is an upload keeps the storefront buildable', async ({ admin, api, stack }) => {
	const media = await uploadPng(admin, { cmsUrl: stack.cmsUrl });
	const product = await createProduct(admin, { image: '', imageUpload: media.id });
	try {
		const snap = await api.get('store/snapshot');
		expect(snap.json.products.find((p) => p.slug === product.slug)?.image).toBe(`/api/media/file/${media.filename}`);

		const { sync, build } = await syncAndBuild(stack.cmsUrl);
		expect(sync.code, `sync-cms refused the CMS snapshot:\n${errorLines(sync.out)}`).toBe(0);
		expect(build?.code, `storefront build failed:\n${errorLines(build?.out)}`).toBe(0);
		expect(build.out).not.toMatch(/\[prerender\] 404 \/api\//);
	} finally {
		await deleteProduct(admin, product.id);
		await admin.request('DELETE', `media/${media.id}`);
	}
});
