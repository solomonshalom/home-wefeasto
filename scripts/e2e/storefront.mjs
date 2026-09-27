/*
 * The storefront side of a slot: a private mirror of the repo (so parallel slots and the
 * agents editing the real tree never share a build/ or .svelte-kit/), the catalog sync
 * against the slot CMS, a cached `vite build`, and `vite preview` proxying /api to the CMS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, storefrontEnv } from './config.mjs';
import { hashInputs } from './files.mjs';
import { isAlive, runStep, spawnServer, waitForHttp } from './proc.mjs';

const SNAPSHOT_REL = 'src/lib/data/cms-snapshot.json';

/** rsync filter: everything but deps/build output/other stacks; from cms/ only src/commerce/shared ($shared alias). */
export const MIRROR_FILTERS = [
	'--exclude=/.git',
	'--exclude=/.claude',
	'--exclude=/node_modules',
	'--exclude=/.svelte-kit',
	'--exclude=/build',
	'--exclude=/bublr',
	'--exclude=/.e2e',
	'--exclude=/test-results',
	'--exclude=/playwright-report',
	'--exclude=.DS_Store',
	'--exclude=vite.config.js.timestamp-*',
	'--include=/cms/',
	'--include=/cms/src/',
	'--include=/cms/src/commerce/',
	'--include=/cms/src/commerce/shared/',
	'--include=/cms/src/commerce/shared/**',
	'--exclude=/cms/**'
];

/** Mirror the repo into .e2e/slot-N/site (deletes files gone from the repo) and link node_modules. */
export async function mirrorSite(cfg) {
	const logFile = path.join(cfg.logsDir, 'mirror.log');
	fs.mkdirSync(cfg.siteDir, { recursive: true });
	await runStep('storefront mirror (rsync)', 'rsync', ['-a', '--delete', ...MIRROR_FILTERS, `${REPO}/`, `${cfg.siteDir}/`], {
		cwd: REPO,
		env: process.env,
		logFile,
		timeoutMs: 5 * 60_000
	});
	const link = path.join(cfg.siteDir, 'node_modules');
	const target = path.join(REPO, 'node_modules');
	let current = null;
	try {
		current = fs.readlinkSync(link);
	} catch {
		/* missing or not a link */
	}
	if (current !== target) {
		fs.rmSync(link, { recursive: true, force: true });
		fs.symlinkSync(target, link, 'dir');
	}
}

/**
 * `scripts/sync-cms.mjs` in the mirror with CMS_SYNC=1 CMS_REQUIRED=1: fetch the slot
 * CMS's /api/store/snapshot into the mirror's cms-snapshot.json (a failed sync fails the
 * stack). Returns { matchesCommitted } — the seeded CMS should serve exactly the committed file.
 */
export async function syncSnapshot(cfg) {
	const logFile = path.join(cfg.logsDir, 'sf-sync.log');
	await runStep('storefront catalog sync', process.execPath, ['scripts/sync-cms.mjs'], {
		cwd: cfg.siteDir,
		env: { ...storefrontEnv(cfg), CMS_SYNC: '1', CMS_REQUIRED: '1' },
		logFile,
		timeoutMs: 2 * 60_000
	});
	const committed = fs.readFileSync(path.join(REPO, SNAPSHOT_REL), 'utf8');
	const synced = fs.readFileSync(path.join(cfg.siteDir, SNAPSHOT_REL), 'utf8');
	return { matchesCommitted: committed === synced, logFile };
}

/** Cache key of a storefront build: everything vite reads from the mirror. */
export function sfBuildKey(cfg) {
	const s = cfg.siteDir;
	return hashInputs([
		{
			base: s,
			dirs: ['src', 'static', 'cms/src/commerce/shared'],
			files: ['svelte.config.js', 'vite.config.js', 'package.json', 'package-lock.json', 'jsconfig.json']
		}
	]);
}

const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
};

/** `vite build` in the mirror unless the recorded build has the same key (E2E_REBUILD=1 forces). */
export async function buildStorefront(cfg, { force = false } = {}) {
	const logFile = path.join(cfg.logsDir, 'sf-build.log');
	const key = sfBuildKey(cfg);
	const info = readJson(cfg.sfBuildFile);
	const built = fs.existsSync(path.join(cfg.siteDir, 'build/index.html'));
	if (!force && built && info?.hash === key) return { cached: true, hash: key };
	fs.rmSync(cfg.sfBuildFile, { force: true });
	const t0 = Date.now();
	// CMS_SYNC stays off here: syncSnapshot() already ran the prebuild step with CMS_SYNC=1 CMS_REQUIRED=1.
	await runStep('storefront build (vite build)', process.execPath, [path.join(cfg.siteDir, 'node_modules/vite/bin/vite.js'), 'build'], {
		cwd: cfg.siteDir,
		env: storefrontEnv(cfg),
		logFile,
		timeoutMs: 15 * 60_000
	});
	fs.writeFileSync(cfg.sfBuildFile, JSON.stringify({ hash: key, builtAt: new Date().toISOString(), durationMs: Date.now() - t0 }, null, 2));
	return { cached: false, hash: key };
}

/** `vite preview --port <sfPort> --strictPort` (detached) with CMS_URL → /api proxied to the slot CMS. */
export async function startPreview(cfg, { onSpawn } = {}) {
	const logFile = path.join(cfg.logsDir, 'preview.log');
	const pid = spawnServer(process.execPath, [path.join(cfg.siteDir, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(cfg.sfPort), '--strictPort'], {
		cwd: cfg.siteDir,
		env: storefrontEnv(cfg),
		logFile
	});
	onSpawn?.(pid);
	const alive = () => isAlive(pid);
	await waitForHttp(`${cfg.sfUrl}/`, { timeoutMs: 60_000, alive, logFile, name: 'storefront (vite preview)' });
	await waitForHttp(`${cfg.sfUrl}/api/store/catalog`, { timeoutMs: 30_000, alive, logFile, name: 'storefront /api proxy' });
	return pid;
}
