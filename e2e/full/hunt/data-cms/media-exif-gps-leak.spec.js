/*
 * HUNT data-cms (round 3): uploaded product photos are published with their EXIF metadata intact —
 * GPS coordinates, camera make/model and the owner's name — to every shopper.
 *
 * Media has no image sizes, resize or format options, so Payload stores the original bytes untouched and
 * serves them at /api/media/file/<name> (on the storefront origin through the /api proxy, and baked into
 * product pages via imageUpload). A photo taken on the owner's phone at home or at the warehouse carries
 * the GPS position of where it was taken; anyone can download it from the shop and read it.
 *
 * Correct behaviour: images are re-encoded (or their metadata stripped) on upload, keeping orientation,
 * so no EXIF/GPS/author data is ever served.
 */
import { test, expect } from '../../fixtures.js';
import { phoneJpeg, readExif } from './exif.js';

test('an uploaded phone photo is served without GPS / camera / author EXIF', async ({ stack, admin }) => {
	const jpeg = await phoneJpeg();
	const local = readExif(jpeg);
	expect(local, 'the test photo carries GPS + author EXIF, like a phone photo').toMatchObject({ gps: true, strings: { Artist: 'Shop Owner Name' } });

	await admin.request('GET', 'users/me'); // make sure the session holds a token
	const fd = new FormData();
	fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), `hunt-exif-${Date.now().toString(36)}.jpg`);
	fd.append('_payload', JSON.stringify({ alt: 'hunt exif photo' }));
	const r = await fetch(`${stack.cmsUrl}/api/media`, { method: 'POST', headers: { Authorization: `JWT ${admin.session.token}` }, body: fd });
	const text = await r.text();
	expect(r.status, text.slice(0, 200)).toBe(201);
	const doc = JSON.parse(text).doc;
	try {
		const path = new URL(doc.url, stack.cmsUrl).pathname; // what a product page would use: /api/media/file/…
		const served = Buffer.from(await (await fetch(`${stack.sfUrl}${path}`)).arrayBuffer());
		const exif = readExif(served);
		expect({ gps: exif.gps, strings: exif.strings }, `served ${path} still carries EXIF`).toEqual({ gps: false, strings: {} });
	} finally {
		await admin.request('DELETE', `media/${doc.id}`);
	}
});
