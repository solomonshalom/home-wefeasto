/*
 * The Payload CMS side of a slot: schema (payload migrate) + seed, cached production build, next start.
 *
 * The e2e CMS is ALWAYS a production build (`next build` + `next start`, NODE_ENV=production):
 * Wave 2 found error-name checks that passed under `next dev` / vitest and broke once the
 * server bundle was minified. Never switch this to `next dev`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, CMS_DIR, LOCKS_DIR, SEED_STOCK, cmsBuildEnvSignature, cmsEnv } from './config.mjs';
import { acquireLock } from './lock.mjs';
import { cmsTsconfigFiles, guardNextBuildFiles, hashInputs, normalizeTsconfig } from './files.mjs';
import { isAlive, onInterrupt, runStep, spawnServer, waitForHttp } from './proc.mjs';
import { loadPg } from './services.mjs';

const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
};

/** Names of the migrations in cms/src/migrations/index.ts (the list prodMigrations applies). */
export function migrationNames(cmsDir = CMS_DIR) {
	let text = '';
	try {
		text = fs.readFileSync(path.join(cmsDir, 'src/migrations/index.ts'), 'utf8');
	} catch {
		return [];
	}
	return [...text.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * Push mode only: after the dev push, record every committed migration as applied and drop
 * Payload's `dev` marker (batch -1). Otherwise the production `next start` (prodMigrations)
 * finds the marker and waits forever on an interactive "you've run Payload in dev mode" prompt.
 */
async function baselinePushedDb(cfg) {
	const names = migrationNames();
	const { Client } = loadPg();
	const c = new Client({ connectionString: cfg.dbUri, connectionTimeoutMillis: 5000 });
	await c.connect();
	try {
		await c.query('BEGIN');
		await c.query('DELETE FROM payload_migrations WHERE batch = -1');
		for (const name of names) await c.query('INSERT INTO payload_migrations (name, batch) VALUES ($1, 1)', [name]);
		await c.query('COMMIT');
	} finally {
		await c.end().catch(() => {});
	}
	return names;
}

/**
 * Create the schema in the (freshly emptied) slot DB and seed it: the committed catalog
 * snapshot, the policy drafts, stock SEED_STOCK for every product, and the e2e admin.
 *
 * Schema strategy (E2E_SCHEMA):
 * - 'migrate' (default): `payload migrate` applies cms/src/migrations, then the seed runs with
 *   PAYLOAD_DB_PUSH=false, so e2e runs on exactly the schema production gets. The production
 *   `next start` then finds every migration applied (prodMigrations is a no-op).
 * - 'push': Payload's dev push creates the schema from the config (the seed runs with NODE_ENV
 *   unset); the committed migrations are then recorded as applied (baselinePushedDb). Only for
 *   trying a schema change before its migration exists (`npm run migrate:create` in cms/).
 * `onSeedStart` is called when the schema step is done and the seed process starts.
 */
export async function seedCms(cfg, { log, onSeedStart } = {}) {
	const logFile = path.join(cfg.logsDir, 'seed.log');
	const strategy = process.env.E2E_SCHEMA || 'migrate';
	if (strategy !== 'migrate' && strategy !== 'push') throw new Error(`E2E_SCHEMA must be 'migrate' or 'push', got ${JSON.stringify(strategy)}`);
	const env = {
		...cmsEnv(cfg, { production: false }),
		SEED_ADMIN_EMAIL: ADMIN.email,
		SEED_ADMIN_PASSWORD: ADMIN.password
	};
	if (strategy === 'migrate') {
		if (!migrationNames().length) throw new Error('cms/src/migrations/index.ts lists no migrations: nothing would create the schema (E2E_SCHEMA=push to use the dev push)');
		await runStep('payload migrate', 'npm', ['run', 'migrate'], { cwd: CMS_DIR, env, logFile, timeoutMs: 10 * 60_000 });
		env.PAYLOAD_DB_PUSH = 'false';
	}
	onSeedStart?.();
	await runStep('seed', 'npm', ['run', 'seed', '--', `--stock=${SEED_STOCK}`], { cwd: CMS_DIR, env, logFile, timeoutMs: 10 * 60_000 });
	if (strategy === 'push') {
		const names = await baselinePushedDb(cfg);
		log?.(`E2E_SCHEMA=push: dev-pushed schema, ${names.length} migration(s) recorded as applied`);
	}
	return { strategy, logFile };
}

/**
 * Cache key of a CMS build: sources, config, lockfile, Next version, env signature and every
 * normalised CMS tsconfig — tsconfig.json AND tsconfig.build.json, the program `next build`
 * type-checks (next.config.ts typescript.tsconfigPath), so e.g. un-excluding tests/ or a
 * strictness change there rebuilds instead of reusing a build that skipped that check.
 * `cmsDir` is for tests.
 */
export function cmsBuildKey(cfg, cmsDir = CMS_DIR) {
	const nextPkg = readJson(path.join(cmsDir, 'node_modules/next/package.json'));
	return hashInputs(
		[
			{ base: cmsDir, dirs: ['src'], files: ['next.config.ts', 'package.json', 'package-lock.json'] },
			{ base: cmsDir, files: cmsTsconfigFiles(cmsDir), transform: (_f, text) => normalizeTsconfig(text) }
		],
		[`next@${nextPkg?.version}`, cmsBuildEnvSignature(cfg)]
	);
}

/**
 * `next build` into cms/<distDir>, unless the recorded build for this slot has the same
 * key and its BUILD_ID is still there (E2E_REBUILD=1 forces a build). Builds are
 * serialised across slots with a lock, and cms/tsconfig*.json + cms/next-env.d.ts (which
 * Next may rewrite for a custom distDir) are put back byte-for-byte afterwards.
 */
export async function buildCms(cfg, { log, force = false }) {
	const logFile = path.join(cfg.logsDir, 'cms-build.log');
	const buildIdFile = path.join(cfg.distPath, 'BUILD_ID');
	const cached = () => {
		const info = readJson(cfg.cmsBuildFile);
		if (!info || !fs.existsSync(buildIdFile)) return null;
		return fs.readFileSync(buildIdFile, 'utf8').trim() === info.buildId ? info : null;
	};
	let key = cmsBuildKey(cfg);
	let info = cached();
	if (!force && info?.hash === key) return { cached: true, hash: key, buildId: info.buildId };

	const release = await acquireLock(path.join(LOCKS_DIR, 'cms-build'), {
		owner: { slot: cfg.slot, what: `next build ${cfg.distDir}` },
		onWait: (o) => log(`waiting for the CMS build lock (held by ${o?.what || 'another build'}, pid ${o?.pid})…`)
	});
	try {
		key = cmsBuildKey(cfg); // sources may have changed while we waited
		fs.rmSync(cfg.cmsBuildFile, { force: true });
		const guard = guardNextBuildFiles(CMS_DIR, cfg.distDir);
		const unhook = onInterrupt(() => guard.restore());
		const t0 = Date.now();
		try {
			await runStep('cms build (next build)', 'npm', ['run', 'build'], { cwd: CMS_DIR, env: cmsEnv(cfg), logFile, timeoutMs: 20 * 60_000 });
		} catch (err) {
			// `next build` type-checks the cms/tsconfig.build.json program (next.config.ts tsconfigPath:
			// src/** and config, tests/** excluded), so these are errors a production deploy would hit too.
			// Tests are type-checked separately: `npm run typecheck` in cms/. Say which files, up front.
			const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
			if (/Failed to type check/.test(text)) {
				const files = [...new Set([...text.matchAll(/^([\w./()[\]-]+\.tsx?)\(\d+,\d+\): error TS/gm)].map((m) => m[1]))];
				err.message = `TypeScript errors in cms/ (tsconfig.build.json program) stop next build${files.length ? ` (${files.join(', ')})` : ''} — the same errors would fail a production deploy.\n${err.message}`;
			}
			throw err;
		} finally {
			for (const note of guard.restore()) log(note);
			unhook();
		}
		const buildId = fs.readFileSync(buildIdFile, 'utf8').trim();
		info = { hash: key, buildId, distDir: cfg.distDir, builtAt: new Date().toISOString(), durationMs: Date.now() - t0 };
		fs.writeFileSync(cfg.cmsBuildFile, JSON.stringify(info, null, 2));
		return { cached: false, hash: key, buildId };
	} finally {
		release();
	}
}

/** `next start -p <cmsPort>` (detached); resolves with its pid once GET /api/store/catalog answers 200. */
export async function startCms(cfg, { onSpawn } = {}) {
	const logFile = path.join(cfg.logsDir, 'cms.log');
	const pid = spawnServer(process.execPath, [path.join(CMS_DIR, 'node_modules/next/dist/bin/next'), 'start', '-p', String(cfg.cmsPort)], {
		cwd: CMS_DIR,
		env: { ...cmsEnv(cfg), NODE_OPTIONS: '--no-deprecation' },
		logFile
	});
	onSpawn?.(pid);
	await waitForHttp(`${cfg.cmsUrl}/api/store/catalog`, { timeoutMs: 180_000, alive: () => isAlive(pid), logFile, name: 'cms (next start)' });
	return pid;
}
