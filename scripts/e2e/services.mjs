/*
 * Docker services the stack needs (Postgres 54329, Mailpit 54325/54326) and the slot
 * database reset. `pg` comes from cms/node_modules (the storefront has no DB driver).
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { CMS_DIR, MAILPIT, PG } from './config.mjs';
import { httpGet, tcpReachable } from './proc.mjs';

let pgModule;
/** The `pg` package from cms/node_modules. */
export function loadPg() {
	if (pgModule) return pgModule;
	try {
		pgModule = createRequire(path.join(CMS_DIR, 'package.json'))('pg');
	} catch (e) {
		throw new Error(`cannot load 'pg' from cms/node_modules (${e.message}). Run 'npm install' in cms/ first.`);
	}
	return pgModule;
}

const pgUri = (db) => `postgres://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${db}`;

async function withClient(db, fn) {
	const { Client } = loadPg();
	const c = new Client({ connectionString: pgUri(db), connectionTimeoutMillis: 5000 });
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.end().catch(() => {});
	}
}

const DOCKER_HINT = "Start them from the repo root with 'docker compose up -d' (see docker-compose.yml).";

/** Throws a clear error unless Postgres and Mailpit (SMTP + API) are reachable. */
export async function checkServices() {
	const problems = [];
	if (!(await tcpReachable(PG.host, PG.port))) problems.push(`Postgres is not reachable at ${PG.host}:${PG.port}`);
	else {
		try {
			await withClient('postgres', (c) => c.query('select 1'));
		} catch (e) {
			problems.push(`Postgres at ${PG.host}:${PG.port} refused user ${PG.user}: ${e.message}`);
		}
	}
	if (!(await tcpReachable(MAILPIT.host, MAILPIT.smtpPort))) problems.push(`Mailpit SMTP is not reachable at ${MAILPIT.host}:${MAILPIT.smtpPort}`);
	const info = await httpGet(`${MAILPIT.apiUrl}/api/v1/info`, { timeoutMs: 3000 });
	if (info.status !== 200) problems.push(`Mailpit API is not reachable at ${MAILPIT.apiUrl} (${info.status || info.error})`);
	if (problems.length) throw new Error(`docker services are not ready:\n  - ${problems.join('\n  - ')}\n  ${DOCKER_HINT}`);
}

/**
 * Empty the slot database: create it when missing (a docker volume made before the
 * e2e databases were added to docker/postgres-init), end every other session on it,
 * then drop and recreate the public schema. `payload migrate` (or, with E2E_SCHEMA=push, the dev push) rebuilds the tables.
 */
export async function resetDatabase(dbName) {
	if (!/^wefeasto_e2e_\d$/.test(dbName)) throw new Error(`refusing to reset ${dbName}: only wefeasto_e2e_<slot> databases`);
	await withClient('postgres', async (c) => {
		const { rows } = await c.query('select 1 from pg_database where datname = $1', [dbName]);
		if (!rows.length) await c.query(`CREATE DATABASE ${dbName} OWNER ${PG.user}`);
		await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [dbName]);
	});
	await withClient(dbName, async (c) => {
		await c.query("SET lock_timeout = '10s'");
		await c.query('DROP SCHEMA IF EXISTS public CASCADE');
		await c.query('CREATE SCHEMA public');
		await c.query(`GRANT ALL ON SCHEMA public TO ${PG.user}`);
		await c.query('GRANT ALL ON SCHEMA public TO public');
	});
}

/** Row counts that prove the seed ran (products, admin users). */
export async function seedSummary(dbName) {
	return withClient(dbName, async (c) => {
		const p = await c.query("select count(*)::int n from products where _status = 'published'");
		const u = await c.query('select count(*)::int n from users');
		return { products: p.rows[0].n, users: u.rows[0].n };
	});
}
