/*
 * Process helpers for the e2e stack: logged spawns, process-group kills, port owners,
 * HTTP readiness polling and log tails. macOS / Linux only (process groups, lsof, ps).
 */
import fs from 'node:fs';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Last `lines` lines of a log file ('' when missing). */
export function tail(file, lines = 60) {
	try {
		const text = fs.readFileSync(file, 'utf8');
		return text.split('\n').slice(-lines).join('\n');
	} catch {
		return '';
	}
}

/** An Error whose message ends with the tail of the step's log. */
export function stepError(message, logFile, lines = 60) {
	const t = tail(logFile, lines).trimEnd();
	return new Error(`${message}\n  log: ${logFile}${t ? `\n  ---- last ${lines} lines ----\n${t.replace(/^/gm, '  | ')}` : ''}`);
}

/** Children of steps that are still running (killed on SIGINT/SIGTERM of this process). */
const running = new Set();
/** Synchronous cleanups to run if this process is interrupted (e.g. restore cms/tsconfig*.json). */
const interruptCleanups = new Set();

/** Register a synchronous cleanup for SIGINT/SIGTERM; returns an unregister function. */
export function onInterrupt(fn) {
	hookSignals();
	interruptCleanups.add(fn);
	return () => interruptCleanups.delete(fn);
}

let signalsHooked = false;
function hookSignals() {
	if (signalsHooked) return;
	signalsHooked = true;
	for (const sig of ['SIGINT', 'SIGTERM']) {
		const onSignal = () => {
			for (const pid of running) killGroupNow(pid, 'SIGTERM');
			for (const fn of interruptCleanups) {
				try {
					fn();
				} catch {
					/* best effort */
				}
			}
			// Default behaviour (exit) unless the host (e.g. a Playwright worker) handles the signal itself.
			if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
		};
		process.once(sig, onSignal);
	}
}

/**
 * Run a command to completion in its own process group, output appended to `logFile`.
 * Resolves on exit 0; rejects with the log tail otherwise (or on timeout, after killing
 * the whole group).
 */
export function runStep(name, cmd, args, { cwd, env, logFile, timeoutMs = 15 * 60_000 }) {
	hookSignals();
	return new Promise((resolve, reject) => {
		const fd = fs.openSync(logFile, 'a');
		fs.writeSync(fd, `\n$ (cd ${cwd} && ${[cmd, ...args].join(' ')})   [${new Date().toISOString()}]\n`);
		let child;
		try {
			child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
		} catch (e) {
			fs.closeSync(fd);
			reject(new Error(`${name}: cannot spawn ${cmd}: ${e.message}`));
			return;
		}
		fs.closeSync(fd);
		running.add(child.pid);
		const timer = setTimeout(() => {
			killGroupNow(child.pid, 'SIGKILL');
			reject(stepError(`${name}: timed out after ${Math.round(timeoutMs / 1000)}s`, logFile));
		}, timeoutMs);
		child.on('error', (e) => {
			clearTimeout(timer);
			running.delete(child.pid);
			reject(new Error(`${name}: ${e.message}`));
		});
		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			running.delete(child.pid);
			if (code === 0) resolve();
			else reject(stepError(`${name} failed (${signal ? `signal ${signal}` : `exit ${code}`})`, logFile));
		});
	});
}

/**
 * Start a long-running server detached (own process group, survives this process),
 * output appended to `logFile`. Returns its pid (= process group id).
 */
export function spawnServer(cmd, args, { cwd, env, logFile }) {
	const fd = fs.openSync(logFile, 'a');
	fs.writeSync(fd, `\n$ (cd ${cwd} && ${[cmd, ...args].join(' ')})   [${new Date().toISOString()}]\n`);
	const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
	fs.closeSync(fd);
	child.unref();
	return child.pid;
}

export function isAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

function groupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

function killGroupNow(pgid, signal) {
	try {
		process.kill(-pgid, signal);
	} catch {
		try {
			process.kill(pgid, signal);
		} catch {
			/* gone */
		}
	}
}

/** SIGTERM the process group, wait, then SIGKILL whatever is left. Resolves when it is gone. */
export async function killGroup(pgid, { graceMs = 8000 } = {}) {
	if (!Number.isInteger(pgid) || pgid <= 0) return;
	if (!groupAlive(pgid) && !isAlive(pgid)) return;
	killGroupNow(pgid, 'SIGTERM');
	const end = Date.now() + graceMs;
	while (Date.now() < end) {
		if (!groupAlive(pgid) && !isAlive(pgid)) return;
		await sleep(150);
	}
	killGroupNow(pgid, 'SIGKILL');
	const end2 = Date.now() + 3000;
	while (Date.now() < end2 && (groupAlive(pgid) || isAlive(pgid))) await sleep(100);
}

/** `ps` columns for a pid: { pid, pgid, command } or null. */
export function processInfo(pid) {
	try {
		const out = execFileSync('ps', ['-o', 'pid=,pgid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
		const m = out.match(/^(\d+)\s+(\d+)\s+(.*)$/s);
		return m ? { pid: Number(m[1]), pgid: Number(m[2]), command: m[3] } : null;
	} catch {
		return null;
	}
}

/** `ps -o lstart=` of a pid (its start time; with the pid it identifies one process), or null. */
export function processStart(pid) {
	try {
		return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null;
	} catch {
		return null;
	}
}

/** Current working directory of a pid (lsof), or null. */
export function processCwd(pid) {
	try {
		const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
		const line = out.split('\n').find((l) => l.startsWith('n'));
		return line ? line.slice(1) : null;
	} catch {
		return null;
	}
}

/**
 * True when the process carries `WF_E2E_SLOT=<slot>` in its environment (ps eww shows
 * the environment of our own user's processes on macOS and Linux). Not reliable for
 * `next start`: it renames itself to "next-server (vX)", which hides argv and env.
 */
export function isSlotProcess(pid, slot) {
	try {
		const out = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
		return new RegExp(`(^|\\s)WF_E2E_SLOT=${slot}(\\s|$)`).test(out);
	} catch {
		return false;
	}
}

/** Pids listening on a TCP port (any address). */
export function listeners(port) {
	try {
		const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
		return [...new Set(out.split('\n').filter(Boolean).map(Number))];
	} catch {
		return []; // lsof exits 1 when nothing matches
	}
}

/** Can we open a TCP connection to host:port within timeoutMs? */
export function tcpReachable(host, port, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (ok) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/** GET a URL; resolves { status, body } or { status: 0, error }. Never throws. */
export async function httpGet(url, { timeoutMs = 5000, headers } = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'manual' });
		const body = await res.text();
		return { status: res.status, body };
	} catch (e) {
		return { status: 0, error: e?.cause?.code || e?.name || String(e) };
	} finally {
		clearTimeout(t);
	}
}

/**
 * Poll `url` until it answers `expect` (default 200). Fails fast when `alive()` turns
 * false (the server died) and on timeout; both errors carry the log tail.
 */
export async function waitForHttp(url, { timeoutMs = 120_000, expect = 200, alive, logFile, name = url } = {}) {
	const end = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < end) {
		last = await httpGet(url, { timeoutMs: 15_000 });
		if (last.status === expect) return last;
		if (alive && !alive()) throw stepError(`${name}: the process exited before ${url} answered ${expect}`, logFile);
		await sleep(400);
	}
	throw stepError(`${name}: ${url} did not answer ${expect} within ${Math.round(timeoutMs / 1000)}s (last: ${last?.status || last?.error})`, logFile);
}

/** "1m04.2s" / "12.3s" / "180ms". */
export function fmtMs(ms) {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${(s - m * 60).toFixed(1).padStart(4, '0')}s`;
}
