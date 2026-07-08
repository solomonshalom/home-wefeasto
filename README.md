# Wefeasto

Breakfast ecommerce prototype built with SvelteKit 2 and Svelte 5, fully
prerendered to a static site. Product catalog, live search, recipes, cart and
checkout backed by localStorage, with GSAP and Lenis handling the motion.

This is Phase 1: pure UI/UX design. The logo and imagery are placeholders.
Phase 2 turns it into a working store with real ecommerce.

## Run

```bash
npm install
npm run dev        # development server
npm run build      # prerender every page into build/
npm run preview    # serve the production build
```

Append `?nofx=1` to any URL to disable all motion. The site also honors
`prefers-reduced-motion`.

## Structure

- `src/routes` - pages: home, shop, recipes, cart, checkout, login, terms,
  privacy, plus dynamic `products/[slug]` and `recipes/[slug]` routes
- `src/lib/components` - nav, footer, search overlay, cards, cart controls,
  colour-mix toggle
- `src/lib/data` - product catalog and per-page content
- `src/lib/cart.js` - cart store (localStorage `wefeasto_cart`)
- `src/lib/colormix.js` - "Mix colors" palette shuffle (localStorage
  `wefeasto_colormix`, shared with the original static site)
- `src/lib/fx.js` - scroll reveals, hovers, page transitions, smooth scroll
- `static` - stylesheets, fonts, images, videos; also serves
  `/color-combos.html`, the visual picker for the 81 colour-mix combinations
  (documented in `COLOR-COMBOS.md`)
- `tools` - scripts used to verify this port against the original static site
