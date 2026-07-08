# Wefeasto colour-mix combinations — the complete set

Generated 2026-07-08 from the palette + rules in `js/wefeasto.js` (and the
Svelte port's `src/lib/colormix.js`). Companion files: `color-combos.json`
(every combo's ready-to-apply mapping) and `color-combos.html` (visual picker —
open it on the served site, click a combo, preview it live).

## How the space works

The "Mix colors" toggle shuffles two independent rings. Within a ring every
colour must move (a *derangement*) — a 4-colour ring has exactly **9**
derangements. Any accent arrangement can pair with any surface arrangement:

> **9 accent schemes × 9 surface schemes = 81 possible combinations**, named
> `A1-S1` … `A9-S9`. Original palette = no toggle (call it `A0-S0`).

Text/neutrals (`#333`, white, greys) never move, so every combination keeps
the site readable.

## The palette being shuffled

| Colour | Hex | Where you see it |
|----|----|----|
| Coral (accent) | `#ff8d5e` | hero band, footer, category chips |
| Yellow (accent) | `#ffc33a` | CTA buttons |
| Plum (accent) | `#d499eb` | featured chip, newsletter panel |
| Lime (accent) | `#2cdb69` | green category tile |
| Seashell (surface) | `#f9f4ef` | page background, search overlay |
| Cream (surface) | `#fff6e7` | recipe tag background |
| Blush (surface) | `#ffdede` | form-error tint |
| Porcelain (surface) | `#fffdfa` | recommendation card background |

## The 9 accent arrangements (A1–A9)

| ID | Coral (#ff8d5e) → | Yellow (#ffc33a) → | Plum (#d499eb) → | Lime (#2cdb69) → | Pattern |
|----|----|----|----|----|----|
| A1 | Yellow `#ffc33a` | Coral `#ff8d5e` | Lime `#2cdb69` | Plum `#d499eb` | Coral ↔ Yellow · Plum ↔ Lime |
| A2 | Yellow `#ffc33a` | Plum `#d499eb` | Lime `#2cdb69` | Coral `#ff8d5e` | Coral → Yellow → Plum → Lime → Coral |
| A3 | Yellow `#ffc33a` | Lime `#2cdb69` | Coral `#ff8d5e` | Plum `#d499eb` | Coral → Yellow → Lime → Plum → Coral |
| A4 | Plum `#d499eb` | Coral `#ff8d5e` | Lime `#2cdb69` | Yellow `#ffc33a` | Coral → Plum → Lime → Yellow → Coral |
| A5 | Plum `#d499eb` | Lime `#2cdb69` | Coral `#ff8d5e` | Yellow `#ffc33a` | Coral ↔ Plum · Yellow ↔ Lime |
| A6 | Plum `#d499eb` | Lime `#2cdb69` | Yellow `#ffc33a` | Coral `#ff8d5e` | Coral → Plum → Yellow → Lime → Coral |
| A7 | Lime `#2cdb69` | Coral `#ff8d5e` | Yellow `#ffc33a` | Plum `#d499eb` | Coral → Lime → Plum → Yellow → Coral |
| A8 | Lime `#2cdb69` | Plum `#d499eb` | Coral `#ff8d5e` | Yellow `#ffc33a` | Coral → Lime → Yellow → Plum → Coral |
| A9 | Lime `#2cdb69` | Plum `#d499eb` | Yellow `#ffc33a` | Coral `#ff8d5e` | Coral ↔ Lime · Yellow ↔ Plum |

## The 9 surface arrangements (S1–S9)

| ID | Seashell (#f9f4ef) → | Cream (#fff6e7) → | Blush (#ffdede) → | Porcelain (#fffdfa) → | Pattern |
|----|----|----|----|----|----|
| S1 | Cream `#fff6e7` | Seashell `#f9f4ef` | Porcelain `#fffdfa` | Blush `#ffdede` | Seashell ↔ Cream · Blush ↔ Porcelain |
| S2 | Cream `#fff6e7` | Blush `#ffdede` | Porcelain `#fffdfa` | Seashell `#f9f4ef` | Seashell → Cream → Blush → Porcelain → Seashell |
| S3 | Cream `#fff6e7` | Porcelain `#fffdfa` | Seashell `#f9f4ef` | Blush `#ffdede` | Seashell → Cream → Porcelain → Blush → Seashell |
| S4 | Blush `#ffdede` | Seashell `#f9f4ef` | Porcelain `#fffdfa` | Cream `#fff6e7` | Seashell → Blush → Porcelain → Cream → Seashell |
| S5 | Blush `#ffdede` | Porcelain `#fffdfa` | Seashell `#f9f4ef` | Cream `#fff6e7` | Seashell ↔ Blush · Cream ↔ Porcelain |
| S6 | Blush `#ffdede` | Porcelain `#fffdfa` | Cream `#fff6e7` | Seashell `#f9f4ef` | Seashell → Blush → Cream → Porcelain → Seashell |
| S7 | Porcelain `#fffdfa` | Seashell `#f9f4ef` | Cream `#fff6e7` | Blush `#ffdede` | Seashell → Porcelain → Blush → Cream → Seashell |
| S8 | Porcelain `#fffdfa` | Blush `#ffdede` | Seashell `#f9f4ef` | Cream `#fff6e7` | Seashell → Porcelain → Cream → Blush → Seashell |
| S9 | Porcelain `#fffdfa` | Blush `#ffdede` | Cream `#fff6e7` | Seashell `#f9f4ef` | Seashell ↔ Porcelain · Cream ↔ Blush |

## Derived tints (automatic, follow the Yellow slot)

The yellow CTA's hover `#ffce60` and lined-button fill `#fff3d8` are
white-mixes of the yellow (19% / 80%); after a shuffle they re-derive from
whatever colour landed on the buttons:

| Yellow lands on | Hover `#ffce60` becomes | Lined fill `#fff3d8` becomes |
|----|----|----|
| Coral `#ff8d5e` | `#ffa37d` | `#ffe8df` |
| Plum `#d499eb` | `#dcacef` | `#f6ebfb` |
| Lime `#2cdb69` | `#54e286` | `#d5f8e1` |

The chip-markup plum twin `#d498eb` always follows Plum `#d499eb`.

## When the client picks one

1. **Preview it anywhere:** open `color-combos.html` on the served site →
   click the combo → "Preview on the live site". (Or paste the combo's
   `localStorage` object from `color-combos.json` into the console as
   `localStorage.setItem('wefeasto_colormix', JSON.stringify(<combo.localStorage>))`
   and reload.) Every page, both the static site and the Svelte port, will
   render that exact combination — the toggle stays in the "on" position.
2. **Lock it in for good:** tell us the ID (e.g. `A5-S2`) and we bake those
   colours into the stylesheets permanently (no toggle needed), or pin the
   toggle's "on" state to always deal that combination.

Note: the site's own toggle re-shuffles **randomly** on every fresh enable —
to return to a chosen combination, re-apply it from the picker/JSON.
