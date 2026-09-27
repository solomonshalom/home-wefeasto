/*
 * HUNT data-cms (round 4): a product photo uploaded as TIFF is published as a TIFF, which Chrome, Edge,
 * Firefox and every Android browser cannot display: the product's image is broken on the live storefront
 * for most shoppers (Safari shows it, so the owner checking on a Mac sees nothing wrong).
 *
 * Media accepts `image/*` (collections/Media.ts), and stripUploadMetadata (src/lib/imageMetadata.ts)
 * re-encodes a TIFF "in its own format" (sharp .tiff()). The upload is then a valid "Uploaded image" for a
 * product, the snapshot publishes /api/media/file/<name>.tif as the product image, and every card and the
 * product page point <img> at it. (Same for other image/* types browsers can't show that sharp can't
 * decode, e.g. Photoshop .psd or JPEG XL: they are stored untouched.)
 *
 * Correct behaviour: an upload the storefront will show is in a web format (JPEG/PNG/WebP/AVIF/GIF/SVG),
 * e.g. TIFF is converted to JPEG/PNG on upload, or the upload is refused with a clear message.
 */
import { test, expect } from '../../fixtures.js';
import { createProduct, deleteProduct } from './helpers.js';

// An 8×6 RGB TIFF (what sharp writes; any scanner / "Export as TIFF" produces the same kind of file).
const TIFF_8X6 = Buffer.from(
	'SUkqAJgAAADIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDLIZDIPAAABAwABAAAACAAAAAEBAwABAAAABgAAAAIBAwADAAAAYgEAAAMBAwABAAAAAQAAAAYBAwABAAAAAgAAABEBBAABAAAACAAAABIBAwABAAAAAQAAABUBAwABAAAAAwAAABYBAwABAAAAAAEAABcBBAABAAAAkAAAABoBBQABAAAAUgEAABsBBQABAAAAWgEAABwBAwABAAAAAQAAACgBAwABAAAAAgAAAFMBAwADAAAAaAEAAAAAAAAzM8sAAAAIADMzywAAAAgACAAIAAgAAQABAAEA',
	'base64'
);

test('a TIFF product photo is published in a format the browser can display', async ({ page, admin, api, stack }) => {
	await admin.request('GET', 'users/me'); // make sure the session holds a token
	const fd = new FormData();
	fd.append('file', new Blob([TIFF_8X6], { type: 'image/tiff' }), `hunt-photo-${Date.now().toString(36)}.tif`);
	fd.append('_payload', JSON.stringify({ alt: 'Hunt TIFF photo' }));
	const up = await fetch(`${stack.cmsUrl}/api/media`, { method: 'POST', headers: { Authorization: `JWT ${admin.session.token}` }, body: fd });
	const upText = await up.text();
	if (up.status === 400) return; // refused with a message: fine
	expect(up.status, upText.slice(0, 300)).toBe(201);
	const media = JSON.parse(upText).doc;

	let product = null;
	try {
		product = await createProduct(admin, { imageUpload: media.id });
		const snap = await api.get('store/snapshot');
		const image = snap.json.products.find((p) => p.slug === product.slug)?.image;
		expect(image, 'the upload is the published product image').toMatch(/^\/api\/media\/file\//);

		// What a shopper's browser (Chromium here) makes of the product image on the storefront origin.
		await page.goto(stack.sfUrl + '/');
		const shown = await page.evaluate(
			(src) =>
				new Promise((resolve) => {
					const img = new Image();
					img.onload = () => resolve({ ok: img.naturalWidth > 0, w: img.naturalWidth });
					img.onerror = () => resolve({ ok: false, w: 0 });
					img.src = src;
				}),
			image
		);
		const type = (await fetch(stack.sfUrl + image)).headers.get('content-type');
		expect(shown.ok, `${image} (served as ${type}) must display in the browser`).toBe(true);
	} finally {
		if (product) await deleteProduct(admin, product.id);
		await admin.request('DELETE', `media/${media.id}`);
	}
});
