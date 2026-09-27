/*
 * Unit tests for scripts/e2e/config.mjs values that are read from the environment at
 * import time, so each case imports the module in a fresh node process.
 *
 * Run: node --test scripts/e2e/config.test.mjs   (or npm run test:e2e:harness)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const CONFIG_URL = new URL('./config.mjs', import.meta.url).href;

/** SEED_STOCK as config.mjs computes it under `seedStock` (undefined = variable unset). */
function seedStockWith(seedStock) {
	const env = { ...process.env };
	delete env.E2E_SEED_STOCK;
	if (seedStock !== undefined) env.E2E_SEED_STOCK = seedStock;
	const r = spawnSync(
		process.execPath,
		['--input-type=module', '-e', `import { SEED_STOCK } from ${JSON.stringify(CONFIG_URL)}; process.stdout.write(JSON.stringify(SEED_STOCK));`],
		{ env, encoding: 'utf8', timeout: 30_000 }
	);
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout);
}

test('SEED_STOCK defaults to 1000: a full run buys ~100 of the busiest products, so 100 ran out before smoke.spec.js', () => {
	assert.equal(seedStockWith(undefined), 1000);
	assert.equal(seedStockWith(''), 1000);
});

test('E2E_SEED_STOCK overrides the seed stock', () => {
	assert.equal(seedStockWith('7'), 7);
	assert.equal(seedStockWith('0'), 0);
});
