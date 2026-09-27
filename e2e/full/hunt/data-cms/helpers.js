/*
 * Shared helpers for the data-cms hunt repros (e2e/full/hunt/data-cms/*.spec.js).
 * Throwaway catalog rows are created with unique slugs and removed again by the caller
 * (the `admin` fixture only restores seeded products/settings/coupons).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIRROR_FILTERS } from '../../../../scripts/e2e/storefront.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const OMIT = new Set(['id', 'createdAt', 'updatedAt', 'stockOnHand', 'stockAdjust', 'sortOrder', '_status', 'goesWith', 'slug', 'name', 'stock']);

/** Body for a new published product cloned from a seeded one (array row ids stripped). */
export async function productBody(admin, { from = 'muesli', ...overrides } = {}) {
	const base = await admin.getProduct(from);
	const body = {};
	for (const [k, v] of Object.entries(base)) if (!OMIT.has(k)) body[k] = v;
	body.partners = (base.partners ?? []).map(({ id, ...row }) => row);
	body.goesWith = [];
	body.homeFeatured = false;
	return { ...body, ...overrides };
}

export const uniqueSlug = (tag) => `hunt-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Create a published throwaway product; resolves the doc. Throws unless 201. */
export async function createProduct(admin, overrides = {}) {
	const slug = overrides.slug ?? uniqueSlug('p');
	const body = await productBody(admin, { name: `Hunt ${slug}`, stock: 20, _status: 'published', ...overrides, slug });
	const r = await admin.request('POST', 'products?depth=0', { body });
	if (r.status !== 201) throw new Error(`createProduct ${slug} → ${r.status} ${r.text.slice(0, 400)}`);
	return r.json.doc;
}

export async function deleteProduct(admin, id) {
	return admin.request('DELETE', `products/${id}`);
}

/* ------------------------------------------------ storefront sync + build */

/**
 * What a production storefront deploy does against the slot CMS, in a throwaway mirror of the repo
 * (never in the repo itself): `sync-cms` with CMS_SYNC=1 CMS_REQUIRED=1, then `vite build`
 * (static prerender). Resolves { sync: {code, out}, build: {code, out} | null }; the mirror is removed.
 * The children run asynchronously: a synchronous spawn would block this worker's event loop for the
 * whole build, so the admin session's keep-alive socket, closed by the CMS meanwhile, would be reused
 * afterwards and fail with ECONNRESET (the fixture's restore then fails, not the scenario).
 */
export async function syncAndBuild(cmsUrl, { timeoutMs = 240_000 } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hunt-data-cms-'));
	try {
		const rs = spawnSync('rsync', ['-a', ...MIRROR_FILTERS, `${REPO}/`, `${dir}/`], { encoding: 'utf8' });
		if (rs.status !== 0) throw new Error(`rsync → ${rs.status} ${rs.stderr}`);
		fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
		const env = { ...process.env, CMS_URL: cmsUrl, CMS_SYNC: '1', CMS_REQUIRED: '1' };
		const run = (args) =>
			new Promise((resolve) => {
				const child = spawn(process.execPath, args, { cwd: dir, env, timeout: timeoutMs });
				let out = '';
				child.stdout.on('data', (d) => (out += d));
				child.stderr.on('data', (d) => (out += d));
				child.on('error', (err) => resolve({ code: null, out: `${out}\n${err.message}`.trim() }));
				child.on('close', (code) => resolve({ code, out: out.trim() }));
			});
		const sync = await run(['scripts/sync-cms.mjs']);
		if (sync.code !== 0) return { sync, build: null };
		const build = await run([path.join(dir, 'node_modules/vite/bin/vite.js'), 'build']);
		return { sync, build };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** The last lines of a process output that mention an error (for assertion messages). */
export const errorLines = (out) =>
	String(out ?? '')
		.split('\n')
		.filter((l) => /error|404|fail/i.test(l))
		.slice(-6)
		.join('\n');

/* ---------------------------------------------------------------- media */

/** A valid 1×1 PNG. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Upload a PNG to `media` as the fixture admin; resolves the media doc. Throws unless 201. */
export async function uploadPng(admin, { cmsUrl, filename = `hunt-${Date.now().toString(36)}.png` }) {
	await admin.request('GET', 'users/me'); // make sure the session holds a token
	const fd = new FormData();
	fd.append('file', new Blob([PNG_1X1], { type: 'image/png' }), filename);
	fd.append('_payload', JSON.stringify({ alt: 'hunt test image' }));
	const r = await fetch(`${cmsUrl}/api/media`, { method: 'POST', headers: { Authorization: `JWT ${admin.session.token}` }, body: fd });
	const text = await r.text();
	if (r.status !== 201) throw new Error(`uploadPng → ${r.status} ${text.slice(0, 300)}`);
	return JSON.parse(text).doc;
}
