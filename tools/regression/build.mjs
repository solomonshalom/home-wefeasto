/*
 * Builds for the regression guard.
 *
 * baseline: a temporary `git worktree` of the baseline commit (never the main
 *   working tree), built with the repo's node_modules, copied to a cache keyed by
 *   the full commit hash, then the worktree is removed. Later runs reuse the cache.
 * current:  the working tree rsynced into a private mirror (same excludes as the
 *   e2e harness), node_modules symlinked, `npm run build` with CMS sync off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, git, run, log, buildEnv, ensureDir, claimDir } from './util.mjs';

const MIRROR_EXCLUDES = ['.regression-mirror', 'node_modules', '.svelte-kit', 'build', 'cms/node_modules', 'cms/.next*', 'bublr', '.e2e', '.git', 'test-results', 'playwright-report', 'tools/node_modules'];

export function resolveCommit(ref) {
	return git(['rev-parse', '--verify', `${ref}^{commit}`]);
}

/** @returns {Promise<{dir: string, commit: string, cached: boolean}>} */
export async function baselineBuild({ ref, cacheRoot, rebuild = false, logDir }) {
	const commit = resolveCommit(ref);
	const cacheDir = path.join(cacheRoot, commit);
	const buildDir = path.join(cacheDir, 'build');
	const done = path.join(cacheDir, 'complete.json');
	if (!rebuild && fs.existsSync(done) && fs.existsSync(path.join(buildDir, 'index.html'))) {
		log(`baseline ${commit.slice(0, 7)}: cached at ${buildDir}`);
		return { dir: buildDir, commit, cached: true };
	}
	fs.rmSync(cacheDir, { recursive: true, force: true });
	ensureDir(cacheDir);
	const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wf-regression-base-'));
	const wt = path.join(tmp, 'wt');
	const logFile = path.join(logDir, 'baseline-build.log');
	log(`baseline ${commit.slice(0, 7)}: git worktree add ${wt}`);
	git(['worktree', 'add', '--detach', wt, commit]);
	try {
		fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
		log(`baseline: building (log ${logFile})`);
		await run('npm', ['run', 'build'], { cwd: wt, env: buildEnv(), logFile, timeoutMs: 600000 });
		fs.cpSync(path.join(wt, 'build'), buildDir, { recursive: true });
		fs.writeFileSync(done, JSON.stringify({ commit, builtAt: new Date().toISOString(), node: process.version }, null, 2) + '\n');
		log(`baseline: cached at ${buildDir}`);
	} finally {
		try {
			git(['worktree', 'remove', '--force', wt]);
		} catch (e) {
			log(`WARN git worktree remove failed: ${e.message.split('\n')[0]}`);
		}
		try {
			git(['worktree', 'prune']);
		} catch {}
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	return { dir: buildDir, commit, cached: false };
}

/** @returns {Promise<{dir: string}>} */
export async function currentBuild({ mirror, logDir }) {
	mirror = claimDir(mirror, '.regression-mirror');
	const logFile = path.join(logDir, 'current-build.log');
	fs.writeFileSync(logFile, '');
	log(`current: rsync working tree → ${mirror}`);
	const args = ['-a', '--delete'];
	for (const x of MIRROR_EXCLUDES) args.push('--exclude', x);
	await run('rsync', [...args, REPO + '/', mirror + '/'], { logFile, timeoutMs: 300000 });
	const nm = path.join(mirror, 'node_modules');
	fs.rmSync(nm, { force: true, recursive: false });
	fs.symlinkSync(path.join(REPO, 'node_modules'), nm);
	log(`current: building (log ${logFile})`);
	await run('npm', ['run', 'build'], { cwd: mirror, env: buildEnv(), logFile, timeoutMs: 600000 });
	return { dir: path.join(mirror, 'build') };
}
