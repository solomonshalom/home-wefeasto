# Storefront verification tools

Standalone scripts. They are not part of the app build. Every other test suite (unit, CMS integration, e2e, prod
smoke, migrations) is described in [docs/TESTING.md](../docs/TESTING.md).

## Regression guard: `npm run test:regression`

`tools/regression.mjs` compares the **original storefront** (git commit `2f60a63`, the Svelte port before Phase 2)
with the **working tree**, and fails on any difference that `tools/regression-allowlist.json` does not list with a reason.

```bash
npm run test:regression                         # everything (about 3.5–4 minutes)
npm run test:regression -- --only dom,visual    # a subset of phases
npm run test:regression -- --pages 'products/'  # limit dom/visual/smoke to matching pages
npm run test:regression -- --current-build build --skip interact
node tools/regression.mjs --help
```

Exit code: `0` means no unlisted differences, `1` means regressions (see the report), `2` means a tool or build error.
The report is at `.e2e/regression/out/report.md` (with `report.json`, plus the diffs and screenshots next to it).
The `--out` and `--mirror` directories are wiped or `rsync --delete`d on each run. The tool refuses any directory that
is non-empty and lacks its marker file (`.regression-out` / `.regression-mirror`), and any directory that contains the repo.

### What it does

1. **Baseline build.** A temporary `git worktree add --detach <tmp> 2f60a63` (under the OS temp dir) is built with
   the repo's `node_modules`, copied to `.e2e/regression/baseline/<full-hash>/build`, and the worktree is removed.
   Later runs reuse that cache (`--rebuild-baseline` forces a fresh build; `--baseline-build <dir>` uses a given one).
   The main working tree's checkout, index and branches are never touched.
2. **Current build.** The working tree is rsynced to a private mirror (`.e2e/regression/mirror`, or `--mirror <dir>`),
   using the e2e harness excludes (node_modules, .svelte-kit, build, cms/node_modules, cms/.next*, bublr, .e2e, .git).
   `node_modules` is symlinked, and `npm run build` runs with `CMS_SYNC`/`CMS_REQUIRED` unset, so the build uses the
   committed snapshot. `--current-build <dir>` skips this step.
3. **Serving.** Both builds are served in-process by a Vercel-like static server (`regression/serve.mjs`): clean URLs,
   `404.html` with status 404, and `/api/*` → `404 {}` ("no CMS", so live.js keeps the snapshot).
   Random localhost ports are used, and everything stops when the run ends.
4. **Phases** (`--only` / `--skip`):

| phase | module | checks |
|---|---|---|
| `dom` | `regression/dom.mjs` | Every prerendered page, canonicalised: head (title, meta, non-`_app` links, noscript) and body. Scripts, hydration comments, the `display:contents` wrapper, hashed `_app` URLs, `svelte-xxxx` classes, attribute order and whitespace are ignored. New pages must be listed. Missing pages fail. |
| `visual` | `regression/visual.mjs` | JS **off**, full-page screenshots of every common page at 1280×900 and 390×844, pixelmatch (threshold 0.1). A page passes under `maxDiffRatio` (default 0.1% of pixels). A height difference counts as differing pixels. |
| `visualjs` | `regression/visual.mjs` | JS **on**, with `?nofx=1` and reduced motion, for the targets in the allow-list. Each target seeds localStorage (for example a bag), which covers client-rendered UI (cart rows, summaries) that JS-off cannot see. |
| `interact` | `regression/interact.mjs` | The `interact.mjs` scenarios (veil, hovers, anchors, search, shop filters, add to cart, PDP qty/partners, cart maths, checkout, login, recipes, TOC, legal, newsletter, persistence) plus the colour-mix toggle, run on both sides. Observations must be equal. Intended changes are pinned per side. Checkout on the current side fills the new form, places a COD order through a stubbed `/api/store/checkout` (`regression/stub-api.mjs`), and must land on `/order` confirmed, with no fake "Order confirmed" on `/checkout`. |
| `nofx` | `regression/nofx.mjs` | `?nofx=1`, reduced motion and normal on `/`, a PDP and a recipe: veil, h1, `.wf-reveal` and `.grid-6` visibility, then a client navigation. Must match the baseline. |
| `smoke` | `regression/nofx.mjs` | Every page of the current build (new routes included), JS on, at 1280, 768 and 390. Page errors, console errors (other than the `/api` 404s), or horizontal overflow not seen on the same baseline page all fail. |

### Allow-list (`tools/regression-allowlist.json`)

Every entry has a `reason`. Page globs are build-relative (`index.html`, `products/*.html`, `**`). In a glob, `*` is
one path segment and `**` is anything.

- `dom.newPages[]` `{page, reason, optional?}`: routes that exist only now. `dom.removedPages[]` and `dom.skipPages[]` work the same way.
- `dom.rules[]` `{id, pages, exceptPages?, side, selector, action, reason, optional?}` are applied to the parsed HTML
  *before* diffing. `side` is `current` (an addition), `baseline` (a removal) or `both`. Each `action`:
  - `remove` (default) removes the element;
  - `unwrap` keeps the element's children;
  - `ignore-attrs` (`attrs: []`) drops the listed attributes;
  - `ignore-classes` (`classes: []`) drops the listed classes;
  - `ignore-text` replaces the element's text;
  - `ignore-children` empties the element;
  - `sort-children` makes child order not matter, while the content is still compared.

  Warnings (in the report) flag rules that matched nothing, and `side: current` removals whose selector also matches the baseline.
- `visual` / `visualJs`: `rules[]` `{id, pages, side, mode: hide|mask, selector, reason}` are injected as a `<style>`
  into the served HTML (no page JS needed). `hide` = `display:none` for additions/removals, so the layout collapses to the other side's.
  `mask` = `visibility:hidden` for content changed in place. Also `thresholds[]` `{pages, viewports?, maxDiffRatio, reason}`,
  `skipPages[]`, `viewports`, and `visualJs.targets[]` `{page, route, seed, name}`.
- `interact.expected` `{key: {baseline?, current?, reason}}`: the exact value each side must show. `interact.ignoreErrors[]` `{pattern, reason}`.
- `nofx.expected` `{"<mode> <path>": {current, reason}}`; `smoke.widths`; `smoke.ignoreErrors[]` `{pattern, reason}`.

**When a Phase 2 change is intended**, add the narrowest rule that describes it (an addition → `side: current` +
`remove` / `hide`; changed copy → `ignore-text` / `mask`), with a reason pointing at the roadmap item or contract, then
re-run. Do not raise thresholds to absorb layout changes. Hide the region instead. **When it is not intended**, fix the code.

### Dependencies

`tools/package.json` pins `cheerio`, `pixelmatch`, `pngjs` and `playwright@1.62.0` (the version whose chromium-1234 is
in the machine cache and the same as the root `@playwright/test`). They install into `tools/node_modules`, which is
gitignored, and the root `package.json` dependencies are untouched. `regression.mjs` runs `npm ci` in `tools/` the first
time if they are missing. If Chromium is missing: `npx --prefix tools playwright install chromium`.

### Proving it catches regressions

Seeded faults in a copy of the current build are reported and exit 1:
- a heading typo → `dom` (terms);
- an extra element → `dom` (PDP);
- a footer colour in `wefeasto.css` → `visual` (every page);
- a thrown error → `smoke` (shop, at every width).

With the old build posing as "current", `interact` fails 22 observations (every pinned checkout, login, newsletter and colour-mix change, plus a step error).

## Legacy port-verification scripts

These were written to prove the Svelte port was 1:1 with the original static Webflow site (a folder not in this repo,
served with `python3 -m http.server 8000`) against `npm run preview` (:4173). `regression.mjs` supersedes them for
day-to-day use. They still work with the same deps (`cd tools && npm ci`).

- `extract.mjs <site-root> <svelte-root>` regenerates the `*-content.js` data and legal bodies from the original HTML.
  It is obsolete now that the catalog comes from the CMS snapshot.
- `domdiff.mjs <site-root> <build-root>` gives the canonical DOM diff of the original pages against the prerendered build.
- `visual.mjs`, `interact.mjs` and `nofx.mjs` cover JS-off screenshots, the interaction scenarios and the kill switches.
  Repoint them with `WF_ORIG_URL`, `WF_PORT_URL` and `WF_ORIG_CLEAN=1` (set it when the "original" side serves clean
  URLs, like a build).
- `inject-serve.mjs <site-root>` injected "Recommended" sections into the original recipe HTML. It is obsolete.
