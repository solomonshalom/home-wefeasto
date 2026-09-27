/*
 * HUNT data-cms (round 2): with no recipe published, every storefront build fails.
 *
 * The snapshot schema allows `recipes: []` (no minItems) and the CMS lets the owner unpublish every
 * recipe (e.g. while rewriting them), so sync-cms accepts the snapshot. The build then stops:
 *   Error: The following routes were marked as prerenderable, but were not prerendered because they
 *   were not found while crawling your app:  - /recipes/[slug]
 *   (Only /[policy=policy] may build no page: see handleUnseenRoutes in svelte.config.js.)
 * svelte.config.js MAY_BE_UNSEEN only allows the policy route to build no page.
 *
 * Correct behaviour: a snapshot sync-cms accepts also builds (an empty /recipes list), or the CMS/sync
 * refuses to take the last recipe off the site with a clear message.
 */
import { test, expect } from '../../fixtures.js';
import { errorLines, syncAndBuild } from './helpers.js';

test.describe.configure({ timeout: 300_000 });

test('unpublishing every recipe keeps the storefront buildable', async ({ adminSession, stack }) => {
	const { docs } = await adminSession.ok('GET', 'recipes?depth=0&limit=100&where[_status][equals]=published');
	expect(docs.length).toBeGreaterThan(0);
	const unpublished = [];
	try {
		for (const r of docs) {
			const res = await adminSession.request('PATCH', `recipes/${r.id}?depth=0`, { body: { _status: 'draft' } });
			if (res.status >= 400) return; // refusing to unpublish the last recipe is fine
			unpublished.push(r.id);
		}
		const { sync, build } = await syncAndBuild(stack.cmsUrl);
		expect(sync.code, `sync-cms refused the CMS snapshot:\n${errorLines(sync.out)}`).toBe(0);
		expect(build?.code, `storefront build failed:\n${String(build?.out).split('\n').filter((l) => /^\s*(Error|- \/)/.test(l)).slice(-4).join('\n')}`).toBe(0);
	} finally {
		for (const id of unpublished) await adminSession.ok('PATCH', `recipes/${id}?depth=0`, { body: { _status: 'published' } });
	}
});
