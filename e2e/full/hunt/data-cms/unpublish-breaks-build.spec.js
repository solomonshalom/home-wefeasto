/*
 * HUNT data-cms: a snapshot the CMS serves and sync-cms accepts must also BUILD.
 *
 * Every committed recipe links its products inside the HTML body (`<a href="/products/steel-cut-oats">`).
 * Unpublishing (or deleting) such a product drops it from the snapshot (cms-catalog.md §3 drops the
 * structured references: goesWith, recipe product rows, related) but the link inside the recipe HTML stays.
 * sync-cms accepts that snapshot, and SvelteKit's prerender crawler then fails the whole storefront build:
 *   Error: 404 /products/steel-cut-oats (linked from /recipes/wf-berry-overnight-steel-cut-oats)
 * The same happens for any root-relative link in recipe/page HTML that the build doesn't produce (a typo).
 * Result: after the owner unpublishes one product, every later storefront deploy fails.
 *
 * Correct behaviour (any of): the CMS refuses the change, or the snapshot never carries a link the build
 * can't produce, or the storefront build tolerates it. Either way: sync + build must succeed.
 */
import { test, expect } from '../../fixtures.js';
import { errorLines, syncAndBuild } from './helpers.js';

test.describe.configure({ timeout: 300_000 });

test('unpublishing a product linked from recipe HTML keeps the storefront buildable', async ({ admin, stack }) => {
	let refused = false;
	try {
		await admin.updateProduct('steel-cut-oats', { _status: 'draft' }); // restored after the test
	} catch {
		refused = true; // the CMS refusing to unpublish a product that published content links to is fine
	}
	test.skip(refused, 'CMS refused the unpublish: nothing can break');

	const { sync, build } = await syncAndBuild(stack.cmsUrl);
	expect(sync.code, `sync-cms refused the CMS snapshot:\n${errorLines(sync.out)}`).toBe(0);
	expect(build?.code, `storefront build failed:\n${errorLines(build?.out)}`).toBe(0);
});

test('a published page whose HTML links a path the site does not have keeps the storefront buildable', async ({ admin, stack }) => {
	const slug = `hunt-help-${Date.now().toString(36)}`;
	const create = await admin.request('POST', 'pages?depth=0', {
		body: { slug, title: 'Help', bodyHtml: '<p>Browse our <a href="/shopp">shop</a>.</p>', published: true, _status: 'published' }
	});
	try {
		if (create.status >= 400) return; // refusing the broken link at save time is fine
		expect(create.status).toBe(201);
		const { sync, build } = await syncAndBuild(stack.cmsUrl);
		expect(sync.code, `sync-cms refused the CMS snapshot:\n${errorLines(sync.out)}`).toBe(0);
		expect(build?.code, `storefront build failed:\n${errorLines(build?.out)}`).toBe(0);
	} finally {
		if (create.json?.doc?.id) await admin.request('DELETE', `pages/${create.json.doc.id}`);
	}
});
