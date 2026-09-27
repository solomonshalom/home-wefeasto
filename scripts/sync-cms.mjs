#!/usr/bin/env node
/*
 * CMS → storefront catalog sync (SPEC §3).
 *
 *   node scripts/sync-cms.mjs            npm `prebuild`: a no-op unless CMS_SYNC=1
 *   node scripts/sync-cms.mjs --force    `npm run sync:cms`: always syncs
 *        [--out=<file>]                  write somewhere else (default src/lib/data/cms-snapshot.json)
 *
 * GET {CMS_URL:-http://localhost:3000}/api/store/snapshot (15 s timeout), then
 * validate it: version 1, non-empty products, unique slugs, integer pricePaise,
 * plus the full snapshot-schema.js validator. The file is written atomically
 * (temp file + rename) in the canonical format (serializeSnapshot: stable key
 * order, 2-space JSON, trailing newline). When the content is identical except
 * for generatedAt the committed file is left untouched, so a sync never churns git.
 *
 * If the CMS can't be reached or serves an invalid snapshot, the committed
 * snapshot is kept and the script warns (exit 0). With CMS_REQUIRED=1 it
 * fails instead (exit 1), which fails the build.
 *
 * A valid snapshot whose image paths name files static/ lacks (a mistyped
 * "Image path" in the CMS) is still written; the script only warns, and the
 * build treats the broken image as CMS content (a warning, never a failure).
 *
 * The pure parts are exported for tests (tests/unit/sync-cms.test.js); the
 * CLI runs only when this file is executed directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_VERSION, validateSnapshot, serializeSnapshot } from '../src/lib/data/snapshot-schema.js';
import { cmsImageFields, sitePath } from '../src/lib/data/site-links.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CMS_URL = 'http://localhost:3000';
export const SNAPSHOT_PATH = '/api/store/snapshot';
export const FETCH_TIMEOUT_MS = 15000;
export const SNAPSHOT_FILE = path.join(ROOT, 'src/lib/data/cms-snapshot.json');
export const STATIC_DIR = path.join(ROOT, 'static');

const MAX_PRINTED_ERRORS = 20;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Env flags: '1' (also 'true'/'yes', any case) is on; anything else is off. */
export const flag = (value) => /^(1|true|yes)$/i.test(String(value ?? '').trim());

/** The snapshot endpoint for a CMS base URL (blank → default; trailing slashes ignored; a path prefix is kept). */
export function snapshotUrl(cmsUrl) {
	const base = String(cmsUrl ?? '').trim() || DEFAULT_CMS_URL;
	return base.replace(/\/+$/, '') + SNAPSHOT_PATH;
}

/* ------------------------------------------------------------ validate */

/** The checks a snapshot must pass before anything else looks at it. */
export function essentialErrors(snapshot) {
	if (!isPlainObject(snapshot)) return ['snapshot: must be a JSON object'];
	const errors = [];
	if (snapshot.version !== SNAPSHOT_VERSION) {
		errors.push(`version: must be ${SNAPSHOT_VERSION}, got ${JSON.stringify(snapshot.version)}`);
	}
	if (!Array.isArray(snapshot.products) || snapshot.products.length === 0) {
		errors.push('products: must be a non-empty array');
		return errors;
	}
	const seen = new Set();
	snapshot.products.forEach((p, i) => {
		const slug = isPlainObject(p) ? p.slug : undefined;
		if (typeof slug !== 'string' || slug === '') errors.push(`products[${i}].slug: must be a non-empty string`);
		else if (seen.has(slug)) errors.push(`products[${i}].slug: duplicate slug "${slug}"`);
		else seen.add(slug);
		if (!isPlainObject(p) || !Number.isInteger(p.pricePaise)) {
			errors.push(`products[${i}].pricePaise: must be an integer, got ${JSON.stringify(p?.pricePaise)}`);
		}
	});
	return errors;
}

/** Essential checks plus the full schema validator (which never runs on a non-object). */
export function checkSnapshot(snapshot) {
	const errors = essentialErrors(snapshot);
	if (isPlainObject(snapshot)) {
		try {
			for (const e of validateSnapshot(snapshot).errors) if (!errors.includes(e)) errors.push(e);
		} catch (e) {
			errors.push(`validator crashed: ${e?.message ?? e}`);
		}
	}
	return { ok: errors.length === 0, errors };
}

/**
 * The snapshot's image fields that name a file this site should ship but
 * static/ lacks (a mistyped "Image path" in the CMS): `['products[muesli].image: /images/x.jpg', …]`.
 * Off-site URLs and /api/… (uploads, served by the CMS) are not checked. Never
 * fatal: the build warns on the broken image and goes on (svelte.config.js).
 * @param {any} snapshot
 * @param {string} [staticDir]
 */
export function missingStaticImages(snapshot, staticDir = STATIC_DIR) {
	const out = [];
	for (const { field, url } of cmsImageFields(snapshot)) {
		const t = sitePath(url);
		if (!t) continue;
		const first = t.path.split('/').filter(Boolean)[0];
		if (first === 'api' || first === '_app') continue;
		const file = path.join(staticDir, t.path);
		let ok = false;
		try {
			ok = file.startsWith(staticDir + path.sep) && fs.statSync(file).isFile();
		} catch {
			ok = false;
		}
		if (!ok) out.push(`${field}: ${url}`);
	}
	return out;
}

/* ----------------------------------------------------------- serialize */

function parseOrNull(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * What to do with a fetched (already validated) snapshot, given the committed
 * file's text (null when there is none):
 * - same content, same bytes            → 'unchanged' (only generatedAt differs, or nothing)
 * - same content, different formatting  → 'write' the canonical text, keeping the committed generatedAt
 * - different content / no usable file  → 'write' the fetched snapshot with its own generatedAt
 * "Same content" = identical canonical JSON once generatedAt is set equal; array order counts.
 * @returns {{ action: 'unchanged' | 'write', text: string, reason: string }}
 */
export function planWrite(committedText, fetched) {
	const fresh = serializeSnapshot(fetched);
	if (typeof committedText !== 'string') return { action: 'write', text: fresh, reason: 'no committed snapshot' };
	const committed = parseOrNull(committedText);
	if (!isPlainObject(committed)) return { action: 'write', text: fresh, reason: 'committed snapshot unreadable' };
	if (typeof committed.generatedAt === 'string') {
		const keepStamp = serializeSnapshot({ ...fetched, generatedAt: committed.generatedAt });
		if (keepStamp === serializeSnapshot(committed) && checkSnapshot(JSON.parse(keepStamp)).ok) {
			if (keepStamp === committedText) return { action: 'unchanged', text: committedText, reason: 'content unchanged' };
			return { action: 'write', text: keepStamp, reason: 'content unchanged, reformatted' };
		}
	}
	return { action: 'write', text: fresh, reason: 'content changed' };
}

/** Write via a temp file in the same directory + rename, so readers never see a half-written file. */
export function writeFileAtomic(file, text) {
	const dir = path.dirname(file);
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		fs.writeFileSync(tmp, text, { flag: 'wx' });
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

/* --------------------------------------------------------------- fetch */

/**
 * GET the snapshot. The timeout covers the whole exchange (headers and body).
 * @returns {Promise<{ ok: true, snapshot: unknown } | { ok: false, error: string }>}
 */
export async function fetchSnapshot(url, { timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
		const body = await res.text();
		if (!res.ok) {
			const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);
			return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
		}
		const snapshot = parseOrNull(body);
		if (snapshot === null) return { ok: false, error: 'response is not JSON' };
		return { ok: true, snapshot };
	} catch (e) {
		if (controller.signal.aborted) return { ok: false, error: `timed out after ${timeoutMs} ms` };
		const cause = e?.cause?.code || e?.cause?.message; // undici: TypeError('fetch failed', { cause: ECONNREFUSED… })
		return { ok: false, error: [e?.message || String(e), cause].filter(Boolean).join(': ') };
	} finally {
		clearTimeout(timer);
	}
}

/* ----------------------------------------------------------------- CLI */

/**
 * The whole sync. Returns the process exit code (0 or 1); never throws.
 * Everything is injectable for tests.
 */
export async function syncCms({
	argv = process.argv.slice(2),
	env = process.env,
	file,
	fetchImpl = globalThis.fetch,
	timeoutMs = FETCH_TIMEOUT_MS,
	log = console.log,
	warn = console.warn
} = {}) {
	const out = file ?? argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? SNAPSHOT_FILE;
	const target = path.relative(process.cwd(), path.resolve(out)) || out;
	if (!argv.includes('--force') && !flag(env.CMS_SYNC)) {
		log(`sync-cms: skipped (set CMS_SYNC=1, or run npm run sync:cms); building from the committed ${target}`);
		return 0;
	}
	const required = flag(env.CMS_REQUIRED);
	const fail = (message, details = []) => {
		const lines = details.slice(0, MAX_PRINTED_ERRORS).map((d) => `  - ${d}`);
		if (details.length > MAX_PRINTED_ERRORS) lines.push(`  … and ${details.length - MAX_PRINTED_ERRORS} more`);
		const verdict = required ? 'CMS_REQUIRED=1, failing' : `keeping the committed ${target}`;
		warn([`sync-cms: ${message}; ${verdict}`, ...lines].join('\n'));
		return required ? 1 : 0;
	};

	try {
		const url = snapshotUrl(env.CMS_URL);
		const got = await fetchSnapshot(url, { timeoutMs, fetchImpl });
		if (!got.ok) return fail(`could not fetch ${url} (${got.error})`);

		const check = checkSnapshot(got.snapshot);
		if (!check.ok) return fail(`${url} served an invalid snapshot (${check.errors.length} errors)`, check.errors);

		const missing = missingStaticImages(got.snapshot);
		if (missing.length) {
			const lines = missing.slice(0, MAX_PRINTED_ERRORS).map((d) => `  - ${d}`);
			if (missing.length > MAX_PRINTED_ERRORS) lines.push(`  … and ${missing.length - MAX_PRINTED_ERRORS} more`);
			warn([`sync-cms: warning: ${missing.length} image path(s) name no file in static/ (they will show as broken images; fix the path in the CMS). The build goes on.`, ...lines].join('\n'));
		}

		let committedText = null;
		try {
			committedText = fs.readFileSync(out, 'utf8');
		} catch {
			committedText = null;
		}
		const plan = planWrite(committedText, got.snapshot);
		const { products, recipes, pages } = got.snapshot;
		const counts = `${products.length} products, ${recipes.length} recipes, ${pages.length} pages`;
		if (plan.action === 'unchanged') {
			log(`sync-cms: ${target} is up to date (${counts}; ${plan.reason})`);
			return 0;
		}
		writeFileAtomic(out, plan.text);
		log(`sync-cms: wrote ${target} from ${url} (${counts}; ${plan.reason})`);
		return 0;
	} catch (e) {
		return fail(`sync failed (${e?.message ?? e})`);
	}
}

const invokedDirectly = (() => {
	try {
		return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	process.exitCode = await syncCms();
}
