/*
 * Round-4 helpers for the data-cms hunt repros: a production storefront built from the slot CMS in a
 * throwaway mirror (sync-cms with CMS_REQUIRED=1, then `vite build`) and served with `vite preview`
 * (/api proxied to the slot CMS), so a spec can open the pages a real deploy would publish.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { MIRROR_FILTERS } from '../../../../scripts/e2e/storefront.mjs';
import { REPO } from './helpers.js';

const freePort = () =>
	new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});

function run(args, { cwd, env, timeoutMs }) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { cwd, env, timeout: timeoutMs });
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('error', (err) => resolve({ code: null, out: `${out}\n${err.message}`.trim() }));
		child.on('close', (code) => resolve({ code, out: out.trim() }));
	});
}

/**
 * Sync + build + preview. Resolves { url, snapshot, close() }; throws (with the tool output) when the sync
 * or the build fails. Always call close() (kills the preview, removes the mirror).
 */
export async function buildAndServe(cmsUrl, { timeoutMs = 240_000 } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hunt-dc4-'));
	let preview = null;
	const close = async () => {
		if (preview && preview.exitCode === null) {
			const gone = new Promise((r) => preview.once('close', r));
			preview.kill('SIGTERM');
			await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
		}
		fs.rmSync(dir, { recursive: true, force: true });
	};
	try {
		const rs = spawnSync('rsync', ['-a', ...MIRROR_FILTERS, `${REPO}/`, `${dir}/`], { encoding: 'utf8' });
		if (rs.status !== 0) throw new Error(`rsync → ${rs.status} ${rs.stderr}`);
		fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
		const env = { ...process.env, CMS_URL: cmsUrl, CMS_SYNC: '1', CMS_REQUIRED: '1' };
		delete env.NODE_ENV;
		const sync = await run(['scripts/sync-cms.mjs'], { cwd: dir, env, timeoutMs });
		if (sync.code !== 0) throw new Error(`sync-cms → ${sync.code}\n${sync.out.slice(-1500)}`);
		const vite = path.join(dir, 'node_modules/vite/bin/vite.js');
		const build = await run([vite, 'build'], { cwd: dir, env, timeoutMs });
		if (build.code !== 0) throw new Error(`vite build → ${build.code}\n${build.out.slice(-1500)}`);
		const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'src/lib/data/cms-snapshot.json'), 'utf8'));
		const port = await freePort();
		preview = spawn(process.execPath, [vite, 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
			cwd: dir,
			env,
			stdio: 'ignore'
		});
		const url = `http://127.0.0.1:${port}`;
		const until = Date.now() + 30_000;
		for (;;) {
			try {
				if ((await fetch(url + '/')).ok) break;
			} catch {
				/* not up yet */
			}
			if (Date.now() > until) throw new Error('vite preview did not come up');
			await new Promise((r) => setTimeout(r, 250));
		}
		return { url, snapshot, close };
	} catch (e) {
		await close();
		throw e;
	}
}

const RECIPE_OMIT = new Set(['id', 'createdAt', 'updatedAt', 'sortOrder', '_status', 'slug', 'title', 'related', 'homeFeatured']);
const stripRowIds = (v) => (Array.isArray(v) ? v.map((row) => (row && typeof row === 'object' ? (({ id, ...rest }) => rest)(row) : row)) : v);

/** Body for a new published recipe cloned from a seeded one (depth 0, array row ids stripped). */
export async function recipeBody(admin, { from, ...overrides } = {}) {
	const q = from ? `recipes?where[slug][equals]=${encodeURIComponent(from)}&depth=0` : 'recipes?limit=1&depth=0&sort=sortOrder';
	const base = (await admin.request('GET', q)).json.docs[0];
	const body = { related: [], homeFeatured: false };
	for (const [k, v] of Object.entries(base)) if (!RECIPE_OMIT.has(k)) body[k] = stripRowIds(v);
	return { ...body, ...overrides };
}
