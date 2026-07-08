# Port verification tools

Standalone scripts used to prove the Svelte port is 1:1 with the original
static site. They are not part of the app build. To run them:

```bash
cd tools
npm init -y && npm install cheerio playwright pixelmatch pngjs
npx playwright install chromium
```

- `extract.mjs <site-root> <svelte-root>` — regenerates
  `src/lib/data/{products,recipes}-content.js` and the legal-page bodies from
  the original HTML pages.
- `domdiff.mjs <site-root> <build-root>` — parses every original page and its
  prerendered counterpart, normalizes framework noise (scripts, hydration
  comments, URL space, attribute order/booleans, whitespace) and diffs the
  canonical DOM trees. Expect `ALL PAGES DOM-EQUIVALENT`.
- `visual.mjs` — JS-disabled full-page screenshots of both sites (original on
  :8000, build preview on :4173) at desktop + mobile widths, pixel-compared.
- `interact.mjs` — runs the same interaction scenario against both sites
  (cart flow end-to-end, search overlay, filters, checkout, login, hovers,
  anchors, newsletter) and diffs the observed outcomes.
- `nofx.mjs` — checks the `?nofx=1` and `prefers-reduced-motion` kill-switch
  paths on the port (no veil, everything visible, clean client-side nav).

Serve the sites first: `python3 -m http.server 8000` in the original folder,
`npm run preview` (port 4173) here.
