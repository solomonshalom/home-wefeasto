/*
 * Markdown report for tools/regression.mjs.
 */
import path from 'node:path';

const j = (v) => '`' + JSON.stringify(v)?.replace(/`/g, "'").slice(0, 300) + '`';
const mark = (ok) => (ok ? 'PASS' : 'FAIL');
const rel = (outDir, f) => (f ? path.relative(outDir, f) : '');

export function renderReport({ meta, results, outDir }) {
	const L = [];
	const { dom, visual, visualjs, interact, nofx, smoke } = results;
	const phases = [
		['DOM diff (prerendered HTML, allow-listed)', dom],
		['Visual, JS off (1280 + 390)', visual],
		['Visual, JS on + ?nofx=1 (seeded bag)', visualjs],
		['Interaction scenarios (JS on)', interact],
		['Kill switches (?nofx=1, reduced motion)', nofx],
		['Page smoke (JS on, every page)', smoke]
	];
	const ran = phases.filter(([, r]) => r);
	const allOk = ran.every(([, r]) => r.ok);
	L.push(`# Storefront regression report`);
	L.push('');
	L.push(`**Result: ${allOk ? 'PASS' : 'FAIL'}** — ${meta.finishedAt}`);
	L.push('');
	L.push(`- Baseline: \`${meta.baseline.commit}\` (${meta.baseline.source})`);
	L.push(`- Current: ${meta.current.source}`);
	L.push(`- Allow-list: \`${meta.allowlist}\``);
	L.push(`- Duration: ${meta.durationS}s`);
	L.push('');
	L.push('| Phase | Result | Detail |');
	L.push('|---|---|---|');
	for (const [name, r] of phases) {
		if (!r) {
			L.push(`| ${name} | skipped | |`);
			continue;
		}
		L.push(`| ${name} | ${mark(r.ok)} | ${r.summary || ''} |`);
	}
	L.push('');
	const warnings = ran.flatMap(([, r]) => r.warnings || []);
	if (warnings.length) {
		L.push('## Warnings (allow-list maintenance)');
		for (const w of warnings) L.push(`- ${w}`);
		L.push('');
	}
	if (dom) {
		L.push('## DOM diff');
		const bad = dom.pages.filter((p) => p.status === 'diff');
		L.push(`${dom.pages.filter((p) => p.status === 'ok').length} pages equivalent after the allow-list, ${bad.length} differ, ${dom.missingPages.length} missing.`);
		L.push('');
		for (const p of bad) {
			L.push(`### ${p.page} (${p.changed} changed lines) — \`${rel(outDir, p.diffFile)}\``);
			L.push('```diff');
			L.push(p.excerpt);
			L.push('```');
		}
		if (dom.missingPages.length) L.push(`**Pages missing from the current build:** ${dom.missingPages.join(', ')}`);
		L.push('');
		L.push('New pages:');
		for (const p of dom.newPages) L.push(`- \`${p.page}\` — ${p.allowed ? p.reason : '**NOT allow-listed**'}`);
		L.push('');
		L.push('<details><summary>Allow-list rule usage (elements matched: baseline / current, pages)</summary>');
		L.push('');
		L.push('| rule | baseline | current | pages |');
		L.push('|---|---|---|---|');
		for (const [id, u] of Object.entries(dom.ruleUse)) L.push(`| ${id} | ${u.baseline} | ${u.current} | ${u.pages} |`);
		L.push('');
		L.push('</details>');
		L.push('');
	}
	for (const [title, v] of [['Visual (JS off)', visual], ['Visual (JS on, ?nofx=1, reduced motion)', visualjs]]) {
		if (!v) continue;
		L.push('## ' + title);
		L.push('| page | viewport | diff | max | size baseline → current | result |');
		L.push('|---|---|---|---|---|---|');
		for (const r of v.results) {
			if (r.ok && r.ratio === 0) continue;
			L.push(`| ${r.page} | ${r.viewport} | ${(r.ratio * 100).toFixed(3)}% | ${(r.max * 100).toFixed(2)}% | ${r.baseSize} → ${r.curSize} | ${r.ok ? 'ok' : `**FAIL** \`${rel(outDir, r.files.diff)}\``} |`);
		}
		L.push('');
		L.push(`${v.results.filter((r) => r.ratio === 0).length}/${v.results.length} comparisons pixel-identical (rows with 0% omitted).`);
		L.push('');
	}
	if (interact) {
		L.push('## Interaction scenarios');
		L.push('| observation | baseline | current | result |');
		L.push('|---|---|---|---|');
		for (const r of interact.rows) {
			if (r.ok && !r.note) continue;
			L.push(`| ${r.key} | ${j(r.baseline)} | ${j(r.current)} | ${r.ok ? r.note : `**FAIL** ${r.note}`} |`);
		}
		L.push('');
		L.push(`${interact.rows.filter((r) => r.ok && !r.note).length} observations identical on both sides (omitted above).`);
		L.push('');
		L.push(`Console/page errors — baseline: ${interact.errors.baseline.length}, current: ${interact.errors.current.length}, new in current: ${interact.errors.newInCurrent.length}`);
		for (const e of interact.errors.newInCurrent) L.push(`- **${e}**`);
		L.push('');
	}
	if (nofx) {
		L.push('## Kill switches');
		L.push('| mode + page | baseline | current | result |');
		L.push('|---|---|---|---|');
		for (const r of nofx.rows) L.push(`| ${r.key} | ${j(r.baseline)} | ${j(r.current)} | ${r.ok ? r.note || 'same' : '**FAIL**'} |`);
		L.push('');
	}
	if (smoke) {
		L.push('## Page smoke (JS on, no CMS)');
		const bad = smoke.rows.filter((r) => !r.ok);
		L.push(`${smoke.rows.length - bad.length}/${smoke.rows.length} page loads clean.`);
		for (const r of bad) L.push(`- **${r.page} @${r.viewport}px** status ${r.status}: ${r.newErrors.map((e) => '`' + e.slice(0, 300) + '`').join('; ')}`);
		L.push('');
	}
	return L.join('\n') + '\n';
}
