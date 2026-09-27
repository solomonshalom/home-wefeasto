/*
 * start / stop / status of one slot's full stack. The CLI (scripts/e2e-stack.mjs) and
 * the Playwright 'full' project setup/teardown (e2e/full/stack.{setup,teardown}.js)
 * both call these.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, CMS_DIR, CRON_SECRET, MAILPIT, MOCK_LATE_AUTH_DELAY_MS, MOCK_WEBHOOK_DELAY_MS, SLOT_COUNT, slotConfig } from './config.mjs';
import { checkServices, resetDatabase, seedSummary } from './services.mjs';
import { buildCms, seedCms, startCms } from './cms.mjs';
import { buildStorefront, mirrorSite, startPreview, syncSnapshot } from './storefront.mjs';
import { fmtMs, httpGet, isAlive, isSlotProcess, killGroup, listeners, processCwd, processInfo, processStart } from './proc.mjs';

const flag = (v) => /^(1|true|yes)$/i.test(String(v ?? '').trim());

/** state.json of a slot, or null. */
export function readState(slot) {
	const cfg = slotConfig(slot);
	try {
		return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
	} catch {
		return null;
	}
}

function writeState(cfg, state) {
	fs.mkdirSync(cfg.dir, { recursive: true });
	const tmp = `${cfg.stateFile}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
	fs.renameSync(tmp, cfg.stateFile);
}

/**
 * Is a recorded pid still the server we started? Alive, and the same process: its start
 * time matches the one recorded at spawn (pids get reused), else it carries WF_E2E_SLOT=<slot>.
 */
function ours(pid, slot, started) {
	if (!isAlive(pid)) return false;
	if (started) return processStart(pid) === started;
	return isSlotProcess(pid, slot);
}

/**
 * A process listening on a slot port that belongs to this slot although state.json lost
 * it: WF_E2E_SLOT=<slot> in its environment, or (next start hides its env by renaming
 * itself) a "next-server" whose cwd is cms/ on the slot's CMS port — 37xx is reserved
 * for e2e slots.
 */
function slotOrphan(pid, port, cfg) {
	if (isSlotProcess(pid, cfg.slot)) return true;
	if (port !== cfg.cmsPort) return false;
	const cmd = processInfo(pid)?.command || '';
	return /^next-server\b/.test(cmd) && processCwd(pid) === CMS_DIR;
}

/**
 * Health of a slot: each server's pid is ours and alive, the CMS answers
 * /api/store/catalog and the storefront answers / and proxies /api.
 */
export async function health(slot) {
	const cfg = slotConfig(slot);
	const state = readState(slot);
	const out = { slot, state: state ? state.status || 'ready' : 'absent', cms: {}, storefront: {}, healthy: false };
	out.cms.pid = state?.pids?.cms ?? null;
	out.cms.alive = !!out.cms.pid && ours(out.cms.pid, slot, state?.pidStarts?.cms);
	out.cms.http = (await httpGet(`${cfg.cmsUrl}/api/store/catalog`, { timeoutMs: 5000 })).status;
	out.storefront.pid = state?.pids?.storefront ?? null;
	out.storefront.alive = !!out.storefront.pid && ours(out.storefront.pid, slot, state?.pidStarts?.storefront);
	out.storefront.http = (await httpGet(`${cfg.sfUrl}/`, { timeoutMs: 5000 })).status;
	out.storefront.proxy = (await httpGet(`${cfg.sfUrl}/api/store/catalog`, { timeoutMs: 5000 })).status;
	out.healthy =
		out.state === 'ready' && out.cms.alive && out.storefront.alive && out.cms.http === 200 && out.storefront.http === 200 && out.storefront.proxy === 200;
	return out;
}

/** Processes listening on the slot's ports that carry WF_E2E_SLOT=<slot> (orphans of a crashed start). */
function slotListeners(cfg) {
	const found = [];
	for (const port of [cfg.cmsPort, cfg.sfPort]) {
		for (const pid of listeners(port)) {
			if (slotOrphan(pid, port, cfg)) found.push({ port, pid, pgid: processInfo(pid)?.pgid ?? pid });
		}
	}
	return found;
}

function makeLogger(cfg, { quiet = false } = {}) {
	fs.mkdirSync(cfg.logsDir, { recursive: true });
	const file = path.join(cfg.logsDir, 'stack.log');
	return (msg) => {
		const line = `[e2e slot ${cfg.slot}] ${msg}`;
		fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
		if (!quiet) console.log(line);
	};
}

/**
 * Stop a slot: kill the recorded process groups (only when they are really ours), any
 * orphan listening on the slot ports with WF_E2E_SLOT=<slot>, and remove state.json.
 * Never touches anything else. Returns what was stopped.
 */
export async function stop(slot, { log = makeLogger(slotConfig(slot)) } = {}) {
	const cfg = slotConfig(slot);
	const state = readState(slot);
	const stopped = [];
	for (const [role, pid] of Object.entries(state?.pids || {})) {
		if (!pid) continue;
		if (ours(pid, slot, state?.pidStarts?.[role])) {
			await killGroup(pid);
			stopped.push(`${role} (pid ${pid})`);
		}
	}
	for (const o of slotListeners(cfg)) {
		await killGroup(o.pgid);
		stopped.push(`orphan on :${o.port} (pid ${o.pid})`);
	}
	fs.rmSync(cfg.stateFile, { force: true });
	const busy = [cfg.cmsPort, cfg.sfPort].filter((p) => listeners(p).length);
	if (stopped.length) log(`stopped ${stopped.join(', ')}`);
	if (busy.length) log(`WARNING: port(s) ${busy.join(', ')} still in use by something that is not this slot's stack`);
	return { stopped, busyPorts: busy };
}

/** Fail early when a slot port belongs to a process that is not this slot's. */
function assertPortsFree(cfg) {
	for (const port of [cfg.cmsPort, cfg.sfPort]) {
		const pids = listeners(port);
		if (!pids.length) continue;
		const who = pids.map((p) => `pid ${p}: ${processInfo(p)?.command?.slice(0, 120) ?? '?'}`).join('; ');
		throw new Error(
			`port ${port} (slot ${cfg.slot}) is in use by a process that is not this slot's stack (${who}).\n` +
				`  Pick another slot (E2E_SLOT / --slot) or stop that process.`
		);
	}
}

/**
 * Start (or, with reuse, adopt) the full stack of a slot. Steps, each timed:
 *   services → stop previous → reset DB → [seed ‖ CMS build ‖ mirror] → CMS start →
 *   catalog sync → storefront build → preview → state.json
 * Options: reuse (E2E_REUSE=1: keep a healthy running stack as is), rebuild (E2E_REBUILD=1:
 * ignore the build caches), owner (who started it, recorded in state.json).
 * On failure everything this call started is stopped again and the error carries the log tail.
 */
export async function start(slot, { reuse = flag(process.env.E2E_REUSE), rebuild = flag(process.env.E2E_REBUILD), owner = 'cli', quiet = false } = {}) {
	const cfg = slotConfig(slot);
	fs.mkdirSync(cfg.dir, { recursive: true });

	if (reuse) {
		const h = await health(slot);
		if (h.healthy) {
			const state = readState(slot);
			makeLogger(cfg, { quiet })(`reusing the healthy stack (E2E_REUSE=1): ${state.sfUrl} → ${state.cmsUrl}`);
			return { ...state, reused: true };
		}
	}

	// Fresh logs for this run (the previous run's are kept in logs.prev/).
	const prev = path.join(cfg.dir, 'logs.prev');
	fs.rmSync(prev, { recursive: true, force: true });
	if (fs.existsSync(cfg.logsDir)) fs.renameSync(cfg.logsDir, prev);
	const log = makeLogger(cfg, { quiet });
	const t0 = Date.now();
	const durations = {};
	const step = async (name, fn) => {
		const s = Date.now();
		log(`${name} …`);
		const result = await fn();
		durations[name] = Date.now() - s;
		const extra = typeof result === 'string' ? ` ${result}` : '';
		log(`${name} done in ${fmtMs(durations[name])}${extra}`);
		return result;
	};

	const state = {
		slot: cfg.slot,
		status: 'starting',
		cmsUrl: cfg.cmsUrl,
		sfUrl: cfg.sfUrl,
		dbUri: cfg.dbUri,
		dbName: cfg.dbName,
		admin: { ...ADMIN },
		cronSecret: CRON_SECRET,
		mailpitUrl: MAILPIT.apiUrl,
		mock: { webhookDelayMs: Number(MOCK_WEBHOOK_DELAY_MS), lateAuthDelayMs: Number(MOCK_LATE_AUTH_DELAY_MS) },
		pids: {},
		pidStarts: {},
		ports: { cms: cfg.cmsPort, storefront: cfg.sfPort },
		distDir: cfg.distDir,
		siteDir: cfg.siteDir,
		logsDir: cfg.logsDir,
		owner,
		startedAt: new Date().toISOString()
	};

	try {
		await step('docker services', () => checkServices());
		await step('stop previous stack', async () => {
			const r = await stop(slot, { log });
			return r.stopped.length ? `(${r.stopped.length} process group(s))` : '(nothing running)';
		});
		assertPortsFree(cfg);
		writeState(cfg, state); // from here on `stop` can find whatever we spawn
		await step(`reset database ${cfg.dbName}`, () => resetDatabase(cfg.dbName));

		// Schema + seed (DB) and the CMS build (CPU) are independent, and so is the mirror copy.
		let seedStarted;
		const seedStart = new Promise((r) => (seedStarted = r));
		const seedP = step('schema + seed (catalog, admin)', async () => {
			const r = await seedCms(cfg, { log, onSeedStart: seedStarted });
			const s = await seedSummary(cfg.dbName);
			if (s.products < 1 || s.users < 1) throw new Error(`seed left ${s.products} published products and ${s.users} users (see ${r.logFile})`);
			return `(${s.products} products, schema: ${r.strategy})`;
		});
		// Let `payload migrate` finish and the seed's tsx read cms/tsconfig.json before next build can rewrite it.
		await Promise.race([seedStart, seedP.catch(() => {})]);
		await new Promise((r) => setTimeout(r, 1500));
		const buildP = step('cms build', async () => {
			const r = await buildCms(cfg, { log, force: rebuild });
			state.cmsBuild = { hash: r.hash.slice(0, 12), buildId: r.buildId, cached: r.cached };
			return r.cached ? `(cached, ${r.hash.slice(0, 12)})` : `(built ${r.hash.slice(0, 12)})`;
		});
		const mirrorP = step('storefront mirror', () => mirrorSite(cfg));
		const results = await Promise.allSettled([seedP, buildP, mirrorP]);
		const failed = results.find((r) => r.status === 'rejected');
		if (failed) throw failed.reason;

		await step(`cms start :${cfg.cmsPort}`, () =>
			startCms(cfg, {
				onSpawn: (pid) => {
					state.pids.cms = pid;
					state.pidStarts.cms = processStart(pid);
					writeState(cfg, state);
				}
			})
		);
		await step('storefront catalog sync', async () => {
			const r = await syncSnapshot(cfg);
			state.snapshotMatchesCommitted = r.matchesCommitted;
			if (!r.matchesCommitted) {
				log(`WARNING: the CMS snapshot differs from the committed src/lib/data/cms-snapshot.json (the mirror builds with the CMS copy; see ${r.logFile})`);
			}
			return r.matchesCommitted ? '(matches the committed snapshot)' : '(DIFFERS from the committed snapshot)';
		});
		await step('storefront build', async () => {
			const r = await buildStorefront(cfg, { force: rebuild });
			state.sfBuild = { hash: r.hash.slice(0, 12), cached: r.cached };
			return r.cached ? `(cached, ${r.hash.slice(0, 12)})` : `(built ${r.hash.slice(0, 12)})`;
		});
		await step(`storefront preview :${cfg.sfPort}`, () =>
			startPreview(cfg, {
				onSpawn: (pid) => {
					state.pids.storefront = pid;
					state.pidStarts.storefront = processStart(pid);
					writeState(cfg, state);
				}
			})
		);

		Object.assign(state, { status: 'ready', readyAt: new Date().toISOString(), durations: { ...durations, total: Date.now() - t0 } });
		writeState(cfg, state);
		log(`ready in ${fmtMs(Date.now() - t0)}: storefront ${cfg.sfUrl} → CMS ${cfg.cmsUrl} (db ${cfg.dbName}); state ${path.relative(process.cwd(), cfg.stateFile)}`);
		return { ...state, reused: false };
	} catch (err) {
		log(`FAILED after ${fmtMs(Date.now() - t0)}: ${err.message.split('\n')[0]}`);
		await stop(slot, { log }).catch(() => {});
		err.message = `e2e stack slot ${slot} failed to start: ${err.message}`;
		throw err;
	}
}

/** Human-readable status lines for a slot. */
export async function statusText(slot) {
	const cfg = slotConfig(slot);
	const h = await health(slot);
	const state = readState(slot);
	const lines = [
		`slot ${slot}: ${h.healthy ? 'HEALTHY' : state ? `NOT HEALTHY (state ${h.state})` : 'not running'}`,
		`  storefront ${cfg.sfUrl}  pid ${h.storefront.pid ?? '-'} ${h.storefront.alive ? 'alive' : 'down'}  GET / ${h.storefront.http || '-'}  /api proxy ${h.storefront.proxy || '-'}`,
		`  cms        ${cfg.cmsUrl}  pid ${h.cms.pid ?? '-'} ${h.cms.alive ? 'alive' : 'down'}  GET /api/store/catalog ${h.cms.http || '-'}`,
		`  db         ${cfg.dbUri}`,
		`  logs       ${cfg.logsDir}`
	];
	if (state?.startedAt) lines.push(`  started    ${state.startedAt} by ${state.owner}${state.durations ? ` (ready in ${fmtMs(state.durations.total)})` : ''}`);
	return { text: lines.join('\n'), health: h, state };
}

export const ALL_SLOTS = Array.from({ length: SLOT_COUNT }, (_, i) => i);
