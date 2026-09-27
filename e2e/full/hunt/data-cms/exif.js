/*
 * Minimal EXIF reader for the media-exif hunt repro: finds the TIFF block in a JPEG's APP1 "Exif" segment
 * and reports whether IFD0 points at a GPS IFD (tag 0x8825) and which string tags IFD0 carries.
 * Enough to prove metadata survives an upload; not a general parser.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { CMS_DIR } from '../../../../scripts/e2e/config.mjs';

/** sharp from the CMS's node_modules (the storefront has none). */
export const sharp = createRequire(path.join(CMS_DIR, 'package.json'))('sharp');

/** A small JPEG carrying camera make/model, an owner name and GPS coordinates, like a phone photo. */
export async function phoneJpeg() {
	return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } })
		.jpeg()
		.withExif({
			IFD0: { Make: 'Apple', Model: 'iPhone 15', Artist: 'Shop Owner Name' },
			IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '12/1 58/1 1234/100', GPSLongitudeRef: 'E', GPSLongitude: '77/1 35/1 2345/100' }
		})
		.toBuffer();
}

function tiffOf(jpeg) {
	let i = 2; // after SOI
	while (i + 4 < jpeg.length && jpeg[i] === 0xff) {
		const marker = jpeg[i + 1];
		const len = jpeg.readUInt16BE(i + 2);
		if (marker === 0xe1 && jpeg.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') return jpeg.subarray(i + 10, i + 2 + len);
		if (marker === 0xda) break; // start of scan: no more metadata segments
		i += 2 + len;
	}
	return null;
}

/** { hasExif, gps: boolean, strings: {Make?, Model?, Artist?} } for a JPEG buffer. */
export function readExif(jpeg) {
	const t = tiffOf(jpeg);
	if (!t) return { hasExif: false, gps: false, strings: {} };
	const le = t.toString('latin1', 0, 2) === 'II';
	const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
	const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
	const ifd0 = u32(4);
	const n = u16(ifd0);
	const names = { 0x010f: 'Make', 0x0110: 'Model', 0x013b: 'Artist' };
	const strings = {};
	let gps = false;
	for (let k = 0; k < n; k++) {
		const e = ifd0 + 2 + k * 12;
		const tag = u16(e);
		if (tag === 0x8825) gps = true;
		if (names[tag]) {
			const count = u32(e + 4);
			const off = count <= 4 ? e + 8 : u32(e + 8);
			strings[names[tag]] = t.toString('latin1', off, off + count).replace(/\0+$/, '');
		}
	}
	return { hasExif: true, gps, strings };
}
