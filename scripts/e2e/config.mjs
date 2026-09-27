/*
 * e2e stack: slot layout, fixed credentials and the environment each process gets.
 *
 * A "slot" (0..4) is one isolated full stack: its own Postgres database, CMS port,
 * storefront port, Next build dir and storefront mirror. Several agents / shells can
 * each run a different slot at the same time.
 *
 *   slot N → CMS http://localhost:(3700+N)   storefront http://localhost:(4700+N)
 *            DB  postgres://wefeasto:wefeasto@127.0.0.1:54329/wefeasto_e2e_N
 *            cms/.next-e2e-N (NEXT_DIST_DIR)  .e2e/slot-N/{site,logs,state.json}
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CMS_DIR = path.join(REPO, 'cms');
export const E2E_ROOT = path.join(REPO, '.e2e');
export const LOCKS_DIR = path.join(E2E_ROOT, 'locks');

export const SLOT_COUNT = 5;
export const CMS_BASE_PORT = 3700;
export const SF_BASE_PORT = 4700;

export const PG = Object.freeze({ host: '127.0.0.1', port: 54329, user: 'wefeasto', password: 'wefeasto' });
export const MAILPIT = Object.freeze({ host: '127.0.0.1', smtpPort: 54325, apiPort: 54326, apiUrl: 'http://127.0.0.1:54326' });

/** Seeded admin (users collection). Fixed so fixtures can log in without reading secrets from anywhere. */
export const ADMIN = Object.freeze({ email: 'e2e-admin@wefeasto.test', password: 'e2e-admin-password-0123456789' });
/** ≥ 32 chars (the CMS refuses shorter secrets in production). Also keys the guest order tokens. */
export const PAYLOAD_SECRET = 'e2e-payload-secret-0123456789-abcdefghijklmnopqrstuv';
export const CRON_SECRET = 'e2e-cron-secret';
export const EMAIL_FROM = 'Wefeasto E2E <hello@wefeasto.com>';
/**
 * Stock the seed gives every product it creates (E2E_SEED_STOCK overrides). The whole
 * suite shares it and orders placed by specs are not restored: one full run buys ~100
 * of the busiest products, so 100 ran out before the last specs. 1000 leaves headroom.
 */
export const SEED_STOCK = Number(process.env.E2E_SEED_STOCK || 1000);
/** Mock gateway knobs (payments-gateway.md §7). */
export const MOCK_WEBHOOK_DELAY_MS = String(process.env.E2E_MOCK_WEBHOOK_DELAY_MS || 300);
export const MOCK_LATE_AUTH_DELAY_MS = String(process.env.E2E_MOCK_LATE_AUTH_DELAY_MS || 10000);

/** Parse a slot from a CLI value / env var. Throws on anything but an integer 0..4. */
export function parseSlot(value, fallback = 0) {
	if (value === undefined || value === null || value === '') return fallback;
	const s = String(value).trim();
	if (!/^\d+$/.test(s) || Number(s) >= SLOT_COUNT) {
		throw new Error(`invalid slot ${JSON.stringify(value)}: expected an integer 0..${SLOT_COUNT - 1}`);
	}
	return Number(s);
}

/** Everything about one slot's layout. Pure. */
export function slotConfig(slot) {
	slot = parseSlot(slot);
	const cmsPort = CMS_BASE_PORT + slot;
	const sfPort = SF_BASE_PORT + slot;
	const dbName = `wefeasto_e2e_${slot}`;
	const dir = path.join(E2E_ROOT, `slot-${slot}`);
	return {
		slot,
		cmsPort,
		sfPort,
		cmsUrl: `http://localhost:${cmsPort}`,
		sfUrl: `http://localhost:${sfPort}`,
		dbName,
		dbUri: `postgres://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${dbName}`,
		distDir: `.next-e2e-${slot}`,
		distPath: path.join(CMS_DIR, `.next-e2e-${slot}`),
		dir,
		siteDir: path.join(dir, 'site'),
		logsDir: path.join(dir, 'logs'),
		stateFile: path.join(dir, 'state.json'),
		cmsBuildFile: path.join(dir, 'cms-build.json'),
		sfBuildFile: path.join(dir, 'sf-build.json')
	};
}

/**
 * Environment for every CMS process of a slot (seed, build, start). Every variable the
 * CMS reads is set explicitly, so nothing leaks in from cms/.env (dotenv / Next never
 * override a variable that is already set, even to '').
 */
export function cmsEnv(cfg, { production = true } = {}) {
	const env = {
		...process.env,
		DATABASE_URI: cfg.dbUri,
		DATABASE_POOL_MAX: '10',
		PAYLOAD_SECRET,
		PAYLOAD_PUBLIC_SERVER_URL: cfg.cmsUrl,
		STOREFRONT_URL: cfg.sfUrl,
		STOREFRONT_ORIGINS: cfg.sfUrl,
		PAYMENTS_MODE: 'mock',
		ALLOW_MOCK_PAYMENTS: '1',
		RAZORPAY_KEY_ID: '',
		RAZORPAY_KEY_SECRET: '',
		RAZORPAY_WEBHOOK_SECRET: '',
		RAZORPAY_WEBHOOK_SECRET_OLD: '',
		APP_ENV: '',
		VERCEL_ENV: '',
		CRON_SECRET,
		SMTP_HOST: MAILPIT.host,
		SMTP_PORT: String(MAILPIT.smtpPort),
		SMTP_USER: '',
		SMTP_PASS: '',
		SMTP_SECURE: '',
		EMAIL_FROM,
		VERCEL_DEPLOY_HOOK_URL: '',
		BLOB_READ_WRITE_TOKEN: '',
		RATE_LIMIT_DISABLED: '1',
		MOCK_WEBHOOK_DELAY_MS,
		MOCK_LATE_AUTH_DELAY_MS,
		MOCK_WEBHOOK_URL: '',
		NEXT_DIST_DIR: cfg.distDir,
		NEXT_TELEMETRY_DISABLED: '1',
		// Marks every process of this slot, so `stop` can recognise orphans by their environment.
		WF_E2E_SLOT: String(cfg.slot)
	};
	if (production) env.NODE_ENV = 'production';
	else delete env.NODE_ENV; // payload migrate + seed run outside production (E2E_SCHEMA=push: the dev push creates the schema)
	delete env.PAYLOAD_DB_PUSH;
	return env;
}

/** Environment for the storefront mirror (sync, vite build, vite preview). Nothing secret. */
export function storefrontEnv(cfg) {
	const env = { ...process.env, CMS_URL: cfg.cmsUrl, WF_E2E_SLOT: String(cfg.slot) };
	delete env.NODE_ENV;
	return env;
}

/** The part of the env that shapes a CMS build (hashed into the build cache key). */
export function cmsBuildEnvSignature(cfg) {
	return JSON.stringify({ distDir: cfg.distDir, cmsUrl: cfg.cmsUrl, sfUrl: cfg.sfUrl, node: process.version });
}
