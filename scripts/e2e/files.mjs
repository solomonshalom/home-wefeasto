/*
 * File helpers for the e2e stack: content hashes (build caches) and the guard that keeps
 * cms/tsconfig.json, cms/tsconfig.build.json + cms/next-env.d.ts byte-identical around `next build`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP_NAMES = new Set(['.DS_Store', 'node_modules', '.git']);

/** Sorted relative paths of the regular files under `root` (skips node_modules, .git, .DS_Store). */
export function listFiles(root, { skip = () => false } = {}) {
	const out = [];
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (SKIP_NAMES.has(e.name)) continue;
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (skip(r)) continue;
			if (e.isDirectory()) walk(path.join(dir, e.name), r);
			else if (e.isFile()) out.push(r);
		}
	};
	walk(root, '');
	return out.sort();
}

/**
 * sha256 over (relative path, content) of every file in `entries`:
 * `{ base, files?: string[], dirs?: string[] }` groups, plus extra `strings`.
 * Missing files hash as "<missing>" so a deletion changes the key.
 */
export function hashInputs(groups, strings = []) {
	const h = crypto.createHash('sha256');
	for (const g of groups) {
		const files = [...(g.files || [])];
		for (const d of g.dirs || []) for (const f of listFiles(path.join(g.base, d))) files.push(`${d}/${f}`);
		for (const f of files.sort()) {
			h.update(`\0file:${f}\0`);
			let buf;
			try {
				buf = g.transform ? Buffer.from(g.transform(f, fs.readFileSync(path.join(g.base, f), 'utf8'))) : fs.readFileSync(path.join(g.base, f));
			} catch {
				buf = Buffer.from('<missing>');
			}
			h.update(buf);
		}
	}
	for (const s of strings) h.update(`\0str:${s}`);
	return h.digest('hex');
}

/** `next build` adds `<distDir>/types/**` + `<distDir>/dev/types/**` to tsconfig "include". */
const DIST_TYPES_RE = /^\.next[^/]*\/(dev\/)?types\//;

/**
 * tsconfig text with every Next build-dir include removed (so other agents' builds don't bust
 * our cache). An "include" made only of such entries is dropped altogether, as if absent (a
 * tsconfig without one, like tsconfig.build.json, inherits its parent's). Any other change,
 * including a copied parent include, changes the key: a spurious rebuild, never a missed one.
 */
export function normalizeTsconfig(text) {
	try {
		const cfg = JSON.parse(text);
		if (Array.isArray(cfg.include)) {
			const kept = cfg.include.filter((p) => !(typeof p === 'string' && DIST_TYPES_RE.test(p) && !p.startsWith('.next/')));
			if (kept.length === 0 && cfg.include.length > 0) delete cfg.include;
			else cfg.include = kept;
		}
		return JSON.stringify(cfg);
	} catch {
		return text;
	}
}

function readOrNull(file) {
	try {
		return fs.readFileSync(file);
	} catch {
		return null;
	}
}

function deepEqualJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The tsconfig files at the CMS root (sorted): tsconfig.json, tsconfig.build.json (the program
 * `next build` type-checks: next.config.ts typescript.tsconfigPath, which `extends` tsconfig.json)
 * and any other tsconfig*.json. Both named files are always listed, so deleting one changes a hash.
 */
export function cmsTsconfigFiles(cmsDir) {
	let found = [];
	try {
		found = fs.readdirSync(cmsDir).filter((f) => /^tsconfig(\.[\w-]+)*\.json$/.test(f));
	} catch {
		// missing dir: the two named files hash as <missing>
	}
	return [...new Set(['tsconfig.json', 'tsconfig.build.json', ...found])].sort();
}

/**
 * Put one tsconfig file back after a build. Next adds `<distDir>/types/**` entries to the
 * "include" of the tsconfig it type-checks (and may add an "include" to one that had none).
 * Exact bytes come back when the only change is ours; when another process changed it too,
 * only our distDir's entries are removed. Returns a log note, or null when nothing changed.
 */
function restoreTsconfig(file, orig, distDir, mine) {
	const label = `cms/${path.basename(file)}`;
	const now = readOrNull(file);
	if (!orig || !now || now.equals(orig)) return null;
	let nowJson;
	let origJson;
	try {
		nowJson = JSON.parse(now.toString('utf8'));
		origJson = JSON.parse(orig.toString('utf8'));
	} catch {
		fs.writeFileSync(file, orig);
		return `${label} restored byte-for-byte (unparseable after build)`;
	}
	if (!nowJson || !Array.isArray(nowJson.include)) {
		fs.writeFileSync(file, orig);
		return `${label} restored byte-for-byte`;
	}
	const stripped = { ...nowJson, include: nowJson.include.filter((p) => !mine(p)) };
	// An "include" that was not there before and names our distDir was added by this build.
	if (!('include' in origJson) && nowJson.include.some(mine)) delete stripped.include;
	if (deepEqualJson(stripped, origJson)) {
		fs.writeFileSync(file, orig);
		return `${label} restored byte-for-byte`;
	}
	fs.writeFileSync(file, JSON.stringify(stripped, null, 2) + '\n');
	return `WARNING: ${label} was also changed by another process during the build; removed only our ${distDir} entries`;
}

/**
 * Snapshot the files `next build` may rewrite for a custom distDir: every CMS tsconfig
 * (cmsTsconfigFiles: tsconfig.json and the tsconfig.build.json it type-checks) and
 * next-env.d.ts. Call `restore()` after the build (success or failure): it puts the exact
 * bytes back when the only change is ours; when another process changed them concurrently
 * it removes only our distDir's entries and reports that. Returns { restore(): string[] }
 * (messages for the log).
 */
export function guardNextBuildFiles(cmsDir, distDir) {
	const tsFiles = cmsTsconfigFiles(cmsDir).map((f) => path.join(cmsDir, f));
	const tsOrig = new Map(tsFiles.map((f) => [f, readOrNull(f)]));
	const envFile = path.join(cmsDir, 'next-env.d.ts');
	const envOrig = readOrNull(envFile);
	const mine = (p) => typeof p === 'string' && (p.startsWith(`${distDir}/`) || p.startsWith(`./${distDir}/`));
	let done = false;

	function restore() {
		if (done) return [];
		done = true;
		const notes = [];
		for (const file of tsFiles) {
			const note = restoreTsconfig(file, tsOrig.get(file), distDir, mine);
			if (note) notes.push(note);
		}
		// next-env.d.ts
		const envNow = readOrNull(envFile);
		if (envOrig && envNow && !envNow.equals(envOrig)) {
			if (envNow.toString('utf8').includes(`./${distDir}/`)) {
				fs.writeFileSync(envFile, envOrig);
				notes.push('cms/next-env.d.ts restored byte-for-byte');
			} else notes.push('WARNING: cms/next-env.d.ts was changed by another process during the build (left as is)');
		} else if (!envOrig && envNow && envNow.toString('utf8').includes(`./${distDir}/`)) {
			fs.rmSync(envFile, { force: true });
			notes.push('cms/next-env.d.ts removed (it did not exist before the build)');
		}
		return notes;
	}
	return { restore };
}
