/*
 * Cross-process mutex (mkdir is atomic). Used to serialise `next build` in cms/ across
 * slots: a build may rewrite cms/tsconfig*.json + next-env.d.ts, and two concurrent
 * 8 GB builds would thrash the machine anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isAlive, sleep } from './proc.mjs';

const STALE_MS = 45 * 60_000;

function readOwner(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Acquire the lock `dir`. Waits (polling) while another live process holds it; takes
 * over a lock whose owner died or that is older than 45 minutes. Returns release().
 */
export async function acquireLock(dir, { owner = {}, timeoutMs = 30 * 60_000, onWait } = {}) {
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const end = Date.now() + timeoutMs;
	let announced = false;
	for (;;) {
		try {
			fs.mkdirSync(dir);
			const me = { pid: process.pid, at: Date.now(), ...owner };
			fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(me));
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const cur = readOwner(dir);
				if (!cur || (cur.pid === me.pid && cur.at === me.at)) fs.rmSync(dir, { recursive: true, force: true });
			};
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
		}
		const cur = readOwner(dir);
		let stat = null;
		try {
			stat = fs.statSync(dir);
		} catch {
			continue; // released between mkdir and stat
		}
		const age = Date.now() - (cur?.at ?? stat.mtimeMs);
		// No owner.json yet: give the holder a moment to write it before judging it stale.
		const dead = cur ? !isAlive(cur.pid) : Date.now() - stat.mtimeMs > 10_000;
		if (dead || age > STALE_MS) {
			fs.rmSync(dir, { recursive: true, force: true });
			continue;
		}
		if (Date.now() > end) throw new Error(`timed out waiting for lock ${dir} (held by ${JSON.stringify(cur)})`);
		if (!announced && onWait) onWait(cur);
		announced = true;
		await sleep(1000);
	}
}
