/*
 * Policy pages + footer (roadmap M7), against the committed snapshot (no
 * page published today) and against fixture snapshots with published pages:
 * the param matcher, entries (what gets prerendered), the page and layout
 * loads, the footer links and legal line, and the rendered policy page.
 * The real build with a fixture snapshot is policy-build.test.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
/** svelte/server from the same (reset) module graph as the component, or SSR context is lost. */
let render = null;
const html = (C, props) => render(C, { props }).body.replace(/<!--[^>]*-->/g, '');

const PAGE = (slug, title, extra = {}) => ({ slug, title, bodyHtml: `<h2>About ${slug}</h2><p>${title} body text.</p>`, published: true, ...extra });
const OFFICER = { name: 'Priya Rao', designation: 'Grievance Officer', email: 'grievance@wefeasto.com', phone: '+91 98452 62777' };

/**
 * Fresh copies of the modules under test over a snapshot whose `pages` and
 * `settings.legal` are replaced (cms-snapshot.json and the split catalog).
 */
async function withSnapshot({ pages = [], legal = null } = {}) {
	vi.resetModules();
	vi.doMock('$lib/data/cms-snapshot.json', async (importOriginal) => {
		const orig = await importOriginal();
		const settings = legal ? { ...orig.settings, legal: { ...orig.settings.legal, ...legal } } : orig.settings;
		return { ...orig, pages, settings, default: { ...orig.default, pages, settings } };
	});
	vi.doMock('virtual:cms-snapshot/catalog', async () => {
		const orig = await import('$lib/data/cms-snapshot.json');
		return { ...orig, pages: pages.map(({ bodyHtml, ...lean }) => lean) };
	});
	render = (await import('svelte/server')).render;
	return {
		matcher: await import('../../../src/params/policy.js'),
		layout: await import('../../../src/routes/+layout.server.js'),
		route: await import('../../../src/routes/[policy=policy]/+page.server.js'),
		PolicyPage: (await import('../../../src/routes/[policy=policy]/+page.svelte')).default,
		Footer: (await import('$lib/components/Footer.svelte')).default
	};
}

// Each test re-imports the modules over a fresh graph (slow on a busy machine).
vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
	vi.doUnmock('$lib/data/cms-snapshot.json');
	vi.doUnmock('virtual:cms-snapshot/catalog');
	vi.resetModules();
});

const status404 = (fn) => {
	try {
		fn();
	} catch (e) {
		return e?.status;
	}
	return 'no error';
};

describe('committed snapshot (no policy page published)', () => {
	it('footer data: no links, legal fields empty', async () => {
		const { layout } = await withSnapshot();
		expect(layout.load()).toEqual({ footerPages: [], legal: { entityName: '', fssaiLicence: '' } });
	});

	it('nothing is prerendered (no hub); nothing matches; every slug 404s', async () => {
		const { matcher, route } = await withSnapshot();
		expect(route.entries()).toEqual([]);
		expect(route.prerender).toBe(true);
		expect(matcher.POLICY_HUB).toBeUndefined();
		for (const slug of ['policies', 'shipping', 'refunds', 'grievances', 'terms', 'shop', '']) expect(matcher.match(slug)).toBe(false);
		for (const slug of ['policies', 'shipping', 'refunds', 'grievances']) expect(status404(() => route.load({ params: { policy: slug } }))).toBe(404);
	});

	it('svelte.config.js lets only this route go unseen; any other unseen route still fails the build', async () => {
		const { handleUnseenRoutes, MAY_BE_UNSEEN } = await import('../../../svelte.config.js');
		const config = (await import('../../../svelte.config.js')).default;
		expect(config.kit.prerender.handleUnseenRoutes).toBe(handleUnseenRoutes);
		expect(MAY_BE_UNSEEN).toEqual(['/[policy=policy]']);
		expect(() => handleUnseenRoutes({ routes: ['/[policy=policy]'], message: 'x' })).not.toThrow();
		expect(() => handleUnseenRoutes({ routes: [], message: 'x' })).not.toThrow();
		expect(() => handleUnseenRoutes({ routes: ['/[policy=policy]', '/products/[slug]'], message: 'x' })).toThrow(/- \/products\/\[slug\][^]*policy=policy/);
		expect(() => handleUnseenRoutes({ routes: ['/recipes/[slug]'], message: 'x' })).toThrow(/recipes/);
	});

	it('the unpublished drafts exist only in the server-only drafts file', () => {
		const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/data/cms-snapshot.json'), 'utf8'));
		const drafts = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/data/policy-drafts.server.json'), 'utf8'));
		expect(snapshot.pages).toEqual([]);
		expect(drafts.pages.map((p) => [p.slug, p.published])).toEqual([
			['shipping', false],
			['refunds', false],
			['grievances', false]
		]);
	});

	it('footer: byte-identical legal line and link row when nothing is set', async () => {
		const { Footer } = await withSnapshot();
		const out = html(Footer, {});
		expect(out).toContain('<div class="legal-text">© 2026 Wefeasto. All rights reserved</div>');
		expect(out).toContain('<a href="/terms" class="footer-link">Terms</a><a href="/privacy" class="footer-link">Privacy</a></div>');
		expect(out).toContain('<a href="/login" class="footer-link">Login</a>');
		expect(out).not.toContain('FSSAI');
		// the same with the (empty) layout data passed explicitly
		const again = await withSnapshot();
		const d = again.layout.load();
		expect(html(again.Footer, { pages: d.footerPages, legal: d.legal })).toBe(out);
	});
});

describe('a snapshot with published pages (fixture; no real draft is published)', () => {
	const pages = [PAGE('shipping', 'Shipping Policy'), PAGE('terms', 'Clashing Terms'), PAGE('grievances', 'Grievance Redressal'), PAGE('login', 'Clashing login')];

	it('matcher + entries: published, non-reserved slugs only (no hub)', async () => {
		const { matcher, route } = await withSnapshot({ pages });
		expect(route.entries()).toEqual([{ policy: 'shipping' }, { policy: 'grievances' }]);
		expect(matcher.match('policies')).toBe(false);
		expect(matcher.match('login')).toBe(false);
		expect(matcher.match('shipping')).toBe(true);
		expect(matcher.match('grievances')).toBe(true);
		expect(matcher.match('refunds')).toBe(false); // not published
		expect(matcher.match('terms')).toBe(false); // a real route already
	});

	it('layout load: footer links carry slug + title only, in snapshot order', async () => {
		const { layout } = await withSnapshot({ pages });
		expect(layout.load().footerPages).toStrictEqual([
			{ slug: 'shipping', title: 'Shipping Policy' },
			{ slug: 'grievances', title: 'Grievance Redressal' }
		]);
		expect(JSON.stringify(layout.load())).not.toContain('body text');
	});

	it('page load: the body for a published page, 404 for anything else', async () => {
		const { route } = await withSnapshot({ pages });
		expect(route.load({ params: { policy: 'shipping' } })).toMatchObject({
			slug: 'shipping',
			title: 'Shipping Policy',
			bodyHtml: '<h2>About shipping</h2><p>Shipping Policy body text.</p>',
			links: [
				{ slug: 'shipping', title: 'Shipping Policy' },
				{ slug: 'grievances', title: 'Grievance Redressal' }
			],
			grievance: null,
			seller: null
		});
		expect(status404(() => route.load({ params: { policy: 'refunds' } }))).toBe(404);
		expect(status404(() => route.load({ params: { policy: 'terms' } }))).toBe(404);
	});

	it('renders like /terms: title, tabs with the current page, body, CTA', async () => {
		const { route, PolicyPage } = await withSnapshot({ pages });
		const out = html(PolicyPage, { data: route.load({ params: { policy: 'shipping' } }) });
		expect(out).toContain('<h1 class="heading-2">Shipping Policy</h1>');
		expect(out).toContain('<div class="wf-legal wf-policy-body"><h2>About shipping</h2><p>Shipping Policy body text.</p></div>');
		expect(out).toMatch(/<a href="\/shipping" class="wf-legal-tab wf-is-active" aria-current="page">Shipping Policy<\/a>/);
		expect(out).toContain('<a href="/grievances" class="wf-legal-tab">Grievance Redressal</a>');
		expect(out).toContain('class="wf-legal-cta"');
		expect(out).not.toContain('data-wf-grievance-officer');
	});

	it('/grievances: officer + seller blocks only when set, plus WhatsApp help', async () => {
		let { route, PolicyPage } = await withSnapshot({ pages });
		let data = route.load({ params: { policy: 'grievances' } });
		expect(data.grievance).toBeNull();
		expect(data.seller).toBeNull();
		let out = html(PolicyPage, { data });
		expect(out).not.toContain('Grievance Officer</h2>');
		expect(out).toContain('data-wf-whatsapp');
		expect(data.whatsapp).toContain(encodeURIComponent('complaint'));

		({ route, PolicyPage } = await withSnapshot({ pages, legal: { grievanceOfficer: OFFICER, entityName: 'Wefeasto Foods Pvt Ltd', fssaiLicence: '12345678901234' } }));
		data = route.load({ params: { policy: 'grievances' } });
		expect(data.grievance).toEqual(OFFICER);
		expect(data.seller).toEqual({ entityName: 'Wefeasto Foods Pvt Ltd', address: '', fssaiLicence: '12345678901234', gstin: '' });
		out = html(PolicyPage, { data });
		expect(out).toContain('<h2 id="wf-grievance-title" class="wf-policy-card-title">Grievance Officer</h2>');
		expect(out).toContain('<dt>Name</dt><dd>Priya Rao</dd>');
		expect(out).toContain('<a href="mailto:grievance@wefeasto.com">grievance@wefeasto.com</a>');
		expect(out).toContain('<a href="tel:+919845262777">+91 98452 62777</a>');
		expect(out).toContain('<dt>FSSAI Lic. No.</dt><dd>12345678901234</dd>');
		expect(out).not.toContain('<dt>GSTIN</dt>');
		// other pages never show the officer block
		expect(route.load({ params: { policy: 'shipping' } }).grievance).toBeNull();
	});

	it('footer: policy links after Privacy, entity + FSSAI in the legal line', async () => {
		const { layout, Footer } = await withSnapshot({ pages, legal: { entityName: 'Wefeasto Foods Pvt Ltd', fssaiLicence: '12345678901234' } });
		const d = layout.load();
		expect(d.legal).toEqual({ entityName: 'Wefeasto Foods Pvt Ltd', fssaiLicence: '12345678901234' });
		const out = html(Footer, { pages: d.footerPages, legal: d.legal });
		expect(out).toContain('<a href="/privacy" class="footer-link">Privacy</a><a href="/shipping" class="footer-link">Shipping Policy</a><a href="/grievances" class="footer-link">Grievance Redressal</a></div>');
		expect(out).toContain('<div class="legal-text">© 2026 Wefeasto Foods Pvt Ltd. All rights reserved · FSSAI Lic. No. 12345678901234</div>');
	});

	it('footer: FSSAI alone keeps "Wefeasto"; a malformed licence is never shown', async () => {
		const { Footer } = await withSnapshot();
		expect(html(Footer, { legal: { entityName: '', fssaiLicence: '12345678901234' } })).toContain('© 2026 Wefeasto. All rights reserved · FSSAI Lic. No. 12345678901234</div>');
		expect(html(Footer, { legal: { entityName: '  ', fssaiLicence: '1234' } })).toContain('<div class="legal-text">© 2026 Wefeasto. All rights reserved</div>');
		expect(html(Footer, { legal: { entityName: 'Acme', fssaiLicence: '' } })).toContain('<div class="legal-text">© 2026 Acme. All rights reserved</div>');
		// titles are text, never markup
		const out = html(Footer, { pages: [{ slug: 'refunds', title: '<b>Refunds</b> & more' }] });
		expect(out).toContain('<a href="/refunds" class="footer-link">&lt;b>Refunds&lt;/b> &amp; more</a>');
	});

	it('layout load drops a malformed FSSAI value', async () => {
		const { layout } = await withSnapshot({ legal: { fssaiLicence: 'FSSAI-123', entityName: '  Acme Foods  ' } });
		expect(layout.load().legal).toEqual({ entityName: 'Acme Foods', fssaiLicence: '' });
	});
});

describe('routablePages() / RESERVED_SLUGS', () => {
	it('filters unpublished, malformed, reserved, untitled and duplicate pages', async () => {
		const { matcher } = await withSnapshot();
		const list = [
			PAGE('shipping', 'Shipping'),
			PAGE('shipping', 'Duplicate'),
			PAGE('refunds', 'Refunds', { published: false }),
			PAGE('Bad Slug', 'x'),
			PAGE('cart', 'Clash'),
			PAGE('grievances', '  '),
			PAGE('returns', 'Returns'),
			null,
			'x'
		];
		expect(matcher.routablePages(list).map((p) => p.title)).toEqual(['Shipping', 'Returns']);
		expect(matcher.routablePages(null)).toEqual([]);
	});

	it('every top-level route and static entry is reserved (a page can never shadow one)', async () => {
		const { matcher } = await withSnapshot();
		const routes = fs
			.readdirSync(path.join(ROOT, 'src/routes'), { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('[') && !e.name.startsWith('('))
			.map((e) => e.name);
		const statics = fs.readdirSync(path.join(ROOT, 'static')).map((n) => n.replace(/\.(html|json)$/, ''));
		for (const name of [...routes, ...statics, 'api', '_app']) {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue; // could never be a page slug anyway
			expect(matcher.RESERVED_SLUGS, name).toContain(name);
		}
	});
});
