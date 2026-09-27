#!/usr/bin/env node
/*
 * Storefront regression guard: the ORIGINAL storefront (baseline commit, before
 * Phase 2) vs the working tree. See tools/README.md.
 *
 *   npm run test:regression [-- options]      (= node tools/regression.mjs)
 *
 * Options:
 *   --baseline <ref>          baseline commit (default: allow-list baseline.commit, 2f60a63)
 *   --baseline-build <dir>    use this baseline build instead of building one
 *   --rebuild-baseline        ignore the cached baseline build
 *   --current-build <dir>     use this current build instead of mirroring + building
 *   --mirror <dir>            private mirror for the current build (default .e2e/regression/mirror)
 *   --cache <dir>             baseline build cache (default .e2e/regression/baseline/<commit>)
 *   --out <dir>               report + artefacts (default .e2e/regression/out)
 *   --allowlist <file>        default tools/regression-allowlist.json
 *   --only a,b / --skip a,b   phases: dom, visual, visualjs, interact, nofx, smoke
 *   --pages <regex>           limit dom/visual/smoke to matching build-relative pages
 *   --concurrency <n>         parallel page workers (default 4)
 * Exit: 0 = no unlisted differences, 1 = regressions (see report.md), 2 = tool/build error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOOLS, REPO, log, ensureDir, listPages, claimDir } from './regression/util.mjs';

const PHASES = ['dom', 'visual', 'visualjs', 'interact', 'nofx', 'smoke'];

function parseArgs(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
		const [k, inline] = a.slice(2).split('=', 2);
		if (k === 'rebuild-baseline' || k === 'help') o[k] = true;
		else o[k] = inline ?? argv[++i];
	}
	return o;
}

function ensureDeps() {
	const need = ['playwright', 'cheerio', 'pixelmatch', 'pngjs'].filter((d) => !fs.existsSync(path.join(TOOLS, 'node_modules', d, 'package.json')));
	if (!need.length) return;
	log(`installing tool deps into tools/node_modules (${need.join(', ')}) — root package.json is not touched`);
	const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: TOOLS, stdio: 'inherit' });
	if (r.status !== 0) throw new Error('npm ci in tools/ failed');
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
		return 0;
	}
	const started = Date.now();
	ensureDeps();
	const [{ chromium }, { baselineBuild, currentBuild, resolveCommit }, { serveStatic }, { runDomDiff }, { runVisual }, { runInteract }, { runNofx, runSmoke }, { loadProducts }, { renderReport }] =
		await Promise.all([
			import('playwright'),
			import('./regression/build.mjs'),
			import('./regression/serve.mjs'),
			import('./regression/dom.mjs'),
			import('./regression/visual.mjs'),
			import('./regression/interact.mjs'),
			import('./regression/nofx.mjs'),
			import('./regression/stub-api.mjs'),
			import('./regression/report.mjs')
		]);
	const allowFile = path.resolve(args.allowlist || path.join(TOOLS, 'regression-allowlist.json'));
	const allow = JSON.parse(fs.readFileSync(allowFile, 'utf8'));
	const outDir = claimDir(args.out || path.join(REPO, '.e2e/regression/out'), '.regression-out');
	for (const f of fs.readdirSync(outDir)) if (f !== '.regression-out') fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
	const logDir = ensureDir(path.join(outDir, 'logs'));
	const only = args.only ? args.only.split(',') : PHASES;
	const skip = args.skip ? args.skip.split(',') : [];
	for (const p of [...only, ...skip]) if (!PHASES.includes(p)) throw new Error(`unknown phase ${p} (${PHASES.join(', ')})`);
	const phases = PHASES.filter((p) => only.includes(p) && !skip.includes(p));
	const pageFilter = args.pages ? new RegExp(args.pages) : null;
	const concurrency = Number(args.concurrency || 4);

	// ---- builds -------------------------------------------------------------
	const ref = args.baseline || allow.baseline?.commit || '2f60a63';
	let base;
	if (args['baseline-build']) {
		let commit = ref;
		try {
			commit = resolveCommit(ref);
		} catch {}
		base = { dir: path.resolve(args['baseline-build']), commit, source: `given build ${args['baseline-build']}` };
	}
	else {
		const b = await baselineBuild({ ref, cacheRoot: path.resolve(args.cache || path.join(REPO, '.e2e/regression/baseline')), rebuild: !!args['rebuild-baseline'], logDir });
		base = { ...b, source: `${b.cached ? 'cached' : 'fresh'} worktree build ${b.dir}` };
	}
	let cur;
	const mirror = path.resolve(args.mirror || path.join(REPO, '.e2e/regression/mirror'));
	if (args['current-build']) cur = { dir: path.resolve(args['current-build']), source: `given build ${args['current-build']}`, root: REPO };
	else {
		const c = await currentBuild({ mirror, logDir });
		cur = { ...c, source: `working tree mirrored to ${mirror}, npm run build`, root: mirror };
	}
	for (const d of [base.dir, cur.dir]) if (!fs.existsSync(path.join(d, 'index.html'))) throw new Error(`no index.html in ${d}`);

	// ---- serve + run ----------------------------------------------------------
	const [sb, sc] = [await serveStatic(base.dir), await serveStatic(cur.dir)];
	log(`serving baseline ${sb.base}  current ${sc.base}`);
	const browser = await chromium.launch();
	const results = {};
	try {
		const basePages = listPages(base.dir);
		const curPages = listPages(cur.dir);
		const common = basePages.filter((p) => curPages.includes(p) && (!pageFilter || pageFilter.test(p)));
		if (phases.includes('dom')) {
			log('dom: diffing prerendered pages');
			const r = runDomDiff({ baseDir: base.dir, curDir: cur.dir, allow: pageFilter ? { ...allow, dom: { ...allow.dom, skipPages: [...(allow.dom?.skipPages || []), ...basePages.filter((p) => !pageFilter.test(p)).map((page) => ({ page }))] } } : allow, outDir: path.join(outDir, 'dom') });
			const bad = r.pages.filter((p) => p.status === 'diff').length;
			r.summary = `${r.pages.filter((p) => p.status === 'ok').length}/${r.pages.filter((p) => p.status !== 'skipped').length} pages equivalent; ${bad} differ; new pages ${r.newPages.length} (${r.newPages.filter((p) => !p.allowed).length} not listed); missing ${r.missingPages.length}`;
			results.dom = r;
			log(`dom: ${r.ok ? 'PASS' : 'FAIL'} — ${r.summary}`);
		}
		if (phases.includes('visual')) {
			log(`visual: ${common.length} pages x 2 viewports (JS off)`);
			const r = await runVisual({ browser, baseUrl: sb.base, curUrl: sc.base, pages: common, allow, outDir: path.join(outDir, 'visual'), concurrency, log: (m) => log('visual ' + m) });
			const bad = r.results.filter((x) => !x.ok).length;
			r.summary = `${r.results.length - bad}/${r.results.length} within threshold; ${r.results.filter((x) => x.ratio === 0).length} pixel-identical`;
			results.visual = r;
			log(`visual: ${r.ok ? 'PASS' : 'FAIL'} — ${r.summary}`);
		}
		if (phases.includes('visualjs')) {
			log(`visualjs: ${(allow.visualJs?.targets || []).length} targets x 2 viewports (JS on, ?nofx=1, reduced motion)`);
			const r = await runVisual({ browser, baseUrl: sb.base, curUrl: sc.base, pages: common, allow, outDir: path.join(outDir, 'visual-js'), concurrency, js: true, log: (m) => log('visualjs ' + m) });
			const bad = r.results.filter((x) => !x.ok).length;
			r.summary = `${r.results.length - bad}/${r.results.length} within threshold; ${r.results.filter((x) => x.ratio === 0).length} pixel-identical`;
			results.visualjs = r;
			log(`visualjs: ${r.ok ? 'PASS' : 'FAIL'} — ${r.summary}`);
		}
		if (phases.includes('interact')) {
			log('interact: running the scenario suite on both sides');
			const r = await runInteract({ browser, baseUrl: sb.base, curUrl: sc.base, products: loadProducts(cur.root), allow });
			const bad = r.rows.filter((x) => !x.ok).length;
			r.summary = `${r.rows.length - bad}/${r.rows.length} observations ok (${r.rows.filter((x) => x.note && x.ok).length} allow-listed); new console errors ${r.errors.newInCurrent.length}`;
			results.interact = r;
			log(`interact: ${r.ok ? 'PASS' : 'FAIL'} — ${r.summary}`);
		}
		if (phases.includes('nofx')) {
			log('nofx: ?nofx=1 / reduced motion / normal');
			const r = await runNofx({ browser, baseUrl: sb.base, curUrl: sc.base, allow });
			r.summary = `${r.rows.filter((x) => x.ok).length}/${r.rows.length} probes match`;
			results.nofx = r;
			log(`nofx: ${r.ok ? 'PASS' : 'FAIL'} — ${r.summary}`);
		}
		if (phases.includes('smoke')) {
			const pages = curPages.filter((p) => !pageFilter || pageFilter.test(p));
			log(`smoke: ${pages.length} pages x ${(allow.smoke?.widths || [1280, 768, 390]).join('/')}px (JS on)`);
			const r = await runSmoke({ browser, baseUrl: sb.base, curUrl: sc.base, basePages, curPages: pages, allow, concurrency });
			r.summary = `${r.rows.filter((x) => x.ok).length}/${r.rows.length} page loads without new errors`;
			results.smoke = r;
			log(`smoke: ${r.ok ? 'PASS' : 'FAIL'} — ${r.summary}`);
		}
	} finally {
		await browser.close();
		await sb.close();
		await sc.close();
	}

	const meta = {
		finishedAt: new Date().toISOString(),
		durationS: Math.round((Date.now() - started) / 1000),
		baseline: { commit: base.commit, source: base.source },
		current: { source: cur.source },
		allowlist: path.relative(REPO, allowFile)
	};
	const md = renderReport({ meta, results, outDir });
	fs.writeFileSync(path.join(outDir, 'report.md'), md);
	fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ meta, results }, null, 2));
	const ok = Object.values(results).every((r) => r.ok);
	log(`${ok ? 'PASS' : 'FAIL'} — report: ${path.join(outDir, 'report.md')}`);
	return ok ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(e) => {
		console.error(`[regression] ERROR: ${e.stack || e.message}`);
		process.exit(2);
	}
);
