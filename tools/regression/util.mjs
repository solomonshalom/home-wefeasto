/*
 * Shared helpers for tools/regression.mjs (node built-ins only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(TOOLS, '..');

const t0 = Date.now();
export function log(...args) {
	const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
	console.log(`[regression ${s}s]`, ...args);
}

/** git in REPO (read-only commands + worktree add/remove only). */
export function git(args, opts = {}) {
	return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

/**
 * Run a command, stream output to a log file, resolve on exit 0, reject otherwise.
 * The child is killed on timeout; nothing is left running.
 */
export function run(cmd, args, { cwd, env, logFile, timeoutMs = 600000 } = {}) {
	return new Promise((resolve, reject) => {
		const out = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
		const child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
		let tail = '';
		const onData = (d) => {
			out?.write(d);
			tail = (tail + d.toString()).slice(-4000);
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 3000).unref();
		}, timeoutMs);
		child.on('error', (e) => {
			clearTimeout(timer);
			out?.end();
			reject(e);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			out?.end();
			if (code === 0) resolve(tail);
			else reject(new Error(`${cmd} ${args.join(' ')} exited ${code ?? signal}${logFile ? ` (log: ${logFile})` : ''}\n${tail.slice(-1500)}`));
		});
	});
}

/** Env for storefront builds: never sync from a CMS, never require one. */
export function buildEnv() {
	const env = { ...process.env, NODE_ENV: 'production' };
	delete env.CMS_SYNC;
	delete env.CMS_REQUIRED;
	return env;
}

/** Every prerendered page of a build, as build-relative paths ('index.html', 'products/muesli.html', …). */
export function listPages(buildDir) {
	const skip = new Set(['_app', 'images', 'videos', 'fonts', 'css', 'js', 'pin', 'peeps']);
	const pages = [];
	(function walk(rel) {
		for (const f of fs.readdirSync(path.join(buildDir, rel))) {
			const p = rel ? `${rel}/${f}` : f;
			const st = fs.statSync(path.join(buildDir, p));
			if (st.isDirectory()) {
				if (!skip.has(f)) walk(p);
			} else if (f.endsWith('.html')) pages.push(p);
		}
	})('');
	return pages.sort();
}

/** 'products/muesli.html' → '/products/muesli'; 'index.html' → '/'. */
export function pageToRoute(page) {
	if (page === 'index.html') return '/';
	return '/' + page.replace(/\.html$/, '').replace(/\/index$/, '');
}

/** Tiny glob: '*' = one path segment, '**' = anything. Matches build-relative pages or routes. */
export function globMatch(glob, value) {
	const re = new RegExp(
		'^' +
			glob
				.split('**')
				.map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
				.join('.*') +
			'$'
	);
	return re.test(value);
}

export function ensureDir(d) {
	fs.mkdirSync(d, { recursive: true });
	return d;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim a directory this tool may wipe: it must not exist, be empty, or carry our
 * marker file from an earlier run. Anything else (a typo like --out . or --mirror ~)
 * is refused instead of being deleted.
 */
export function claimDir(dir, marker) {
	const resolved = path.resolve(dir);
	if (resolved === REPO || REPO.startsWith(resolved + path.sep) || resolved === path.parse(resolved).root) throw new Error(`refusing to use ${resolved} (it contains the repo)`);
	if (fs.existsSync(resolved) && fs.readdirSync(resolved).length && !fs.existsSync(path.join(resolved, marker)))
		throw new Error(`refusing to wipe ${resolved}: not empty and not created by tools/regression.mjs (no ${marker})`);
	fs.mkdirSync(resolved, { recursive: true });
	fs.writeFileSync(path.join(resolved, marker), 'created by tools/regression.mjs; safe to delete\n');
	return resolved;
}
