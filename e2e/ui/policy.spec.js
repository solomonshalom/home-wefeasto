/*
 * Policy pages and the footer legal line (roadmap M7) on the committed
 * snapshot, where no policy page is published yet: nothing unreviewed is
 * reachable, the footer is unchanged, and there is no /policies hub (the
 * route builds nothing until a page is published: handleUnseenRoutes in
 * svelte.config.js).
 * (A published page end to end: tests/unit/account/policy-build.test.js
 * builds the site with a fixture snapshot.)
 */
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './helpers.js';

const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('../../src/lib/data/cms-snapshot.json', import.meta.url), 'utf8'));

test('unpublished drafts are not built: /shipping, /refunds, /grievances answer 404', async ({ page }) => {
	expect(SNAPSHOT.pages).toEqual([]); // the premise of this spec
	for (const path of ['/shipping', '/refunds', '/grievances']) {
		const res = await page.goto(path);
		expect(res.status(), path).toBe(404);
		await expect(page.locator('body')).not.toContainText('Draft — to be reviewed');
		await expect(page.locator('body')).not.toContainText('[to be added]');
	}
});

test('footer: Terms and Privacy only; the legal line is unchanged', async ({ page }) => {
	await page.goto('/');
	const company = page.locator('.footer-link-column').nth(1);
	await expect(company.locator('a')).toHaveText(['Our Story', 'Contact', 'Terms', 'Privacy']);
	await expect(page.locator('.legal-text')).toHaveText('© 2026 Wefeasto. All rights reserved');
	await expect(page.locator('.footer-section')).not.toContainText('FSSAI');
});

test('no /policies hub: it answers 404 like any unknown page, and nothing links to it', async ({ page }) => {
	const res = await page.goto('/policies');
	expect(res.status()).toBe(404);
	await expect(page.locator('h1')).not.toHaveText('Store policies');
	await expect(page.locator('a[href="/policies"]')).toHaveCount(0);
	await page.goto('/');
	await expect(page.locator('a[href="/policies"]')).toHaveCount(0);
});
