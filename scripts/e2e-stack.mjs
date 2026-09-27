#!/usr/bin/env node
/*
 * Full-stack e2e environment, one isolated "slot" per agent/shell (see e2e/full/README.md).
 *
 *   node scripts/e2e-stack.mjs start  [--slot N] [--reuse] [--rebuild]
 *   node scripts/e2e-stack.mjs stop   [--slot N | --all]
 *   node scripts/e2e-stack.mjs status [--slot N | --all] [--json]
 *   npm run e2e:stack -- start --slot 1
 *
 * Slot N (0..4; default $E2E_SLOT or 0): CMS http://localhost:370N (production build,
 * mock payments), storefront http://localhost:470N (vite preview of a private mirror,
 * /api → the slot CMS), database wefeasto_e2e_N (reset + seeded on every start).
 * State for fixtures: .e2e/slot-N/state.json. Logs: .e2e/slot-N/logs/*.log.
 *
 * Env: E2E_SLOT, E2E_REUSE=1 (keep a healthy running stack), E2E_REBUILD=1 (ignore the
 * CMS/storefront build caches), E2E_SEED_STOCK (default 1000), E2E_SCHEMA=migrate|push (default migrate),
 * E2E_MOCK_WEBHOOK_DELAY_MS (default 300), E2E_MOCK_LATE_AUTH_DELAY_MS (default 10000).
 *
 * Importable: import { start, stop, status, health, readState, slotConfig } from './e2e-stack.mjs'
 */
import { pathToFileURL } from 'node:url';
import { parseSlot, slotConfig } from './e2e/config.mjs';
import { ALL_SLOTS, health, readState, start, statusText, stop } from './e2e/stack.mjs';

export { start, stop, health, readState, slotConfig, statusText };
export { ADMIN, CRON_SECRET, MAILPIT, PAYLOAD_SECRET } from './e2e/config.mjs';

/** { status, health, state } of one slot. */
export async function status(slot) {
	return statusText(slot);
}

const USAGE = `usage: node scripts/e2e-stack.mjs <start|stop|status> [--slot N | --all] [--reuse] [--rebuild] [--json]`;

function parseArgs(argv) {
	const out = { cmd: null, slot: undefined, all: false, reuse: undefined, rebuild: undefined, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--slot' || a === '-s') out.slot = argv[++i];
		else if (a.startsWith('--slot=')) out.slot = a.slice('--slot='.length);
		else if (a === '--all') out.all = true;
		else if (a === '--reuse') out.reuse = true;
		else if (a === '--rebuild') out.rebuild = true;
		else if (a === '--json') out.json = true;
		else if (a === '--help' || a === '-h') out.cmd = 'help';
		else if (!out.cmd) out.cmd = a;
		else throw new Error(`unexpected argument ${JSON.stringify(a)}\n${USAGE}`);
	}
	return out;
}

async function main(argv) {
	const args = parseArgs(argv);
	if (!args.cmd || args.cmd === 'help') {
		console.log(USAGE);
		return args.cmd === 'help' ? 0 : 2;
	}
	const slot = parseSlot(args.slot ?? process.env.E2E_SLOT, 0);
	const slots = args.all ? ALL_SLOTS : [slot];
	switch (args.cmd) {
		case 'start': {
			if (args.all) throw new Error('start takes one --slot');
			const opts = { owner: 'cli' };
			if (args.reuse !== undefined) opts.reuse = args.reuse;
			if (args.rebuild !== undefined) opts.rebuild = args.rebuild;
			const state = await start(slot, opts);
			if (args.json) console.log(JSON.stringify(state, null, 2));
			else {
				console.log(`\nstorefront  ${state.sfUrl}\ncms         ${state.cmsUrl}   (admin ${state.admin.email} / ${state.admin.password})`);
				console.log(`db          ${state.dbUri}\nstate       ${slotConfig(slot).stateFile}`);
				console.log(`\nrun specs:  E2E_SLOT=${slot} E2E_REUSE=1 npx playwright test --project=full`);
				console.log(`stop:       node scripts/e2e-stack.mjs stop --slot ${slot}`);
			}
			return 0;
		}
		case 'stop': {
			for (const s of slots) {
				const r = await stop(s);
				if (!r.stopped.length && !args.all) console.log(`[e2e slot ${s}] nothing was running`);
			}
			return 0;
		}
		case 'status': {
			let allHealthy = true;
			const out = [];
			for (const s of slots) {
				const r = await statusText(s);
				allHealthy &&= r.health.healthy;
				out.push(args.json ? { slot: s, health: r.health, state: r.state } : r.text);
			}
			console.log(args.json ? JSON.stringify(out.length === 1 ? out[0] : out, null, 2) : out.join('\n'));
			return args.all || allHealthy ? 0 : 1;
		}
		default:
			throw new Error(`unknown command ${JSON.stringify(args.cmd)}\n${USAGE}`);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(err?.message || err);
			process.exit(1);
		}
	);
}

