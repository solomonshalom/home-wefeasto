/*
 * Playwright for the storefront.
 *
 * Projects
 * - ui:   storefront-only UI tests (e2e/ui/**) against the production build
 *         served by `vite preview` — no CMS needed (the webServer below).
 * - full: full-stack scenarios (e2e/full/**): Payload CMS production build with
 *         mock payments + storefront preview + Postgres + Mailpit, one isolated
 *         "slot" per run (E2E_SLOT=0..4). Its stack is started by the
 *         'full-stack' setup project and stopped by 'full-stack-teardown'
 *         (scripts/e2e-stack.mjs). See e2e/full/README.md.
 *
 *   npx playwright test --project=ui                        UI suite (starts its preview on PW_PORT)
 *   E2E_SLOT=1 npx playwright test --project=full           full suite on slot 1 (starts + stops its stack)
 *   E2E_SLOT=1 E2E_REUSE=1 npx playwright test --project=full e2e/full/smoke.spec.js
 *                                                           reuse a healthy stack (npm run e2e:stack -- start --slot 1)
 *
 * Project selection
 * - The full-stack projects are opt-in: they exist only when a --project flag
 *   names them (full, full-stack*, a matching glob) or E2E_FULL=1 is set. So a
 *   bare `npx playwright test` / `npm run test:e2e` / `npx playwright test
 *   e2e/ui/x.spec.js` runs the ui suite exactly as before and never starts a
 *   stack. `E2E_FULL=1 npx playwright test` runs both.
 * - The ui webServer only starts when the ui project is selected: no --project
 *   flag, or --project=ui among them. `--project=full` alone never builds or
 *   serves the ui preview. PW_UI_SERVER=0 disables it outright (e.g. when you
 *   already serve a build on PW_PORT and don't want reuseExistingServer to probe).
 * - Workers re-load this file without the CLI flags, so the decision is passed
 *   on in process.env.WF_PW_FULL.
 *
 * @playwright/test is pinned to 1.62.0 so it uses the cached chromium-1234
 * (1.63 wants a browser build that isn't downloaded on this machine).
 *
 * PW_PORT overrides the ui preview port (default 4173) — handy when another
 * preview already owns 4173, since reuseExistingServer would otherwise test
 * whatever build that server is serving.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PW_PORT || 4173);
const BASE_URL = `http://localhost:${PORT}`;

/* ---------------------------------------------------------------- full-stack slot */

const SLOT = (() => {
	const raw = process.env.E2E_SLOT ?? '0';
	if (!/^[0-4]$/.test(String(raw).trim())) throw new Error(`E2E_SLOT must be 0..4, got ${JSON.stringify(raw)}`);
	return Number(raw);
})();
const FULL_BASE_URL = `http://localhost:${4700 + SLOT}`;
const FULL_WORKERS = Number(process.env.E2E_WORKERS || 1);

/* ------------------------------------------------- which projects did the CLI ask for? */

/** Values of every --project flag (`--project=a`, `--project a b`), or [] when none. */
function selectedProjects(argv = process.argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--project=')) out.push(a.slice('--project='.length));
		else if (a === '--project') {
			while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.push(argv[++i]);
		}
	}
	return out;
}
/** Does a --project value (name or glob with *) select `name`? Case-insensitive like Playwright. */
const selects = (pattern, name) =>
	new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(name);
const PROJECTS = selectedProjects();
const UI_SELECTED = PROJECTS.length === 0 || PROJECTS.some((p) => selects(p, 'ui'));
const UI_SERVER = UI_SELECTED && process.env.PW_UI_SERVER !== '0';
const FULL_NAMES = ['full', 'full-stack', 'full-stack-teardown'];
const FULL_SELECTED =
	process.env.WF_PW_FULL === '1' ||
	/^(1|true|yes)$/i.test(process.env.E2E_FULL || '') ||
	PROJECTS.some((p) => FULL_NAMES.some((n) => selects(p, n)));
if (FULL_SELECTED) process.env.WF_PW_FULL = '1'; // inherited by the workers, which re-load this file without argv

const fullProjects = [
	// Starts (or with E2E_REUSE=1 adopts) the slot's stack before any 'full' test.
	{
		name: 'full-stack',
		testDir: './e2e/full',
		testMatch: /stack\.setup\.js$/,
		teardown: 'full-stack-teardown',
		timeout: 25 * 60_000,
		retries: 0,
		outputDir: `./test-results/full-slot-${SLOT}/setup`
	},
	// Stops the stack after the 'full' tests (unless it was reused or E2E_KEEP=1).
	{
		name: 'full-stack-teardown',
		testDir: './e2e/full',
		testMatch: /stack\.teardown\.js$/,
		timeout: 2 * 60_000,
		retries: 0,
		outputDir: `./test-results/full-slot-${SLOT}/teardown`
	},
	{
		name: 'full',
		testDir: './e2e/full',
		testMatch: /.*\.spec\.js$/,
		dependencies: ['full-stack'],
		// Specs share one database per slot (stock, prices, settings): one worker unless asked.
		workers: FULL_WORKERS,
		fullyParallel: false,
		retries: Number(process.env.E2E_RETRIES || 0),
		timeout: 90_000,
		expect: { timeout: 10_000 },
		// Per-slot output: parallel runs on other slots must not wipe each other's artefacts.
		outputDir: `./test-results/full-slot-${SLOT}`,
		use: {
			...devices['Desktop Chrome'],
			viewport: { width: 1280, height: 800 },
			baseURL: FULL_BASE_URL,
			trace: 'retain-on-failure',
			screenshot: 'only-on-failure',
			actionTimeout: 15_000,
			navigationTimeout: 30_000
		}
	}
];

export default defineConfig({
	testDir: './e2e',
	outputDir: './test-results',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	timeout: 45_000,
	expect: { timeout: 7_000 },
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'ui',
			testDir: './e2e/ui',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
		},
		...(FULL_SELECTED ? fullProjects : [])
	],
	webServer: UI_SERVER
		? [
				{
					command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
					url: BASE_URL,
					reuseExistingServer: true,
					timeout: 240_000,
					stdout: 'ignore',
					stderr: 'pipe'
				}
			]
		: undefined
});
