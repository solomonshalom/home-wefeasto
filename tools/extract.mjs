/*
 * Extracts all per-page varying content from the original Wefeasto HTML
 * into data modules for the Svelte port. Run from anywhere:
 *   node extract.mjs <site-root> <svelte-root>
 */
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';

const SITE = process.argv[2];
const OUT = process.argv[3];

const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');

/* Rewrites an original href/src to the SvelteKit URL space. */
function rewriteUrl(u) {
  if (!u) return u;
  u = u.replace(/^\.\.\//, '');
  if (/^(https?:|mailto:|tel:|#)/.test(u)) return u;
  if (u === 'index.html') return '/';
  const m = u.match(/^index\.html(#.*)$/);
  if (m) return '/' + m[1];
  const rec = u.match(/^(?:recipes\/)?(wf-[a-z-]+)\.html$/);
  if (rec) return '/recipes/' + rec[1];
  const prod = u.match(/^products\/([a-z-]+)\.html$/);
  if (prod) return '/products/' + prod[1];
  const page = u.match(/^([a-z-]+)\.html(#.*)?$/);
  if (page) return '/' + page[1] + (page[2] || '');
  if (/^(images|videos|css|fonts)\//.test(u)) return '/' + u;
  return u;
}

/* Rewrite every href/src inside an HTML fragment string. */
function rewriteFragment($, el) {
  const $el = $(el);
  $el.find('[href]').each((_, a) => $(a).attr('href', rewriteUrl($(a).attr('href'))));
  $el.find('[src]').each((_, a) => $(a).attr('src', rewriteUrl($(a).attr('src'))));
  return $el;
}

/* Full record of a "mini" product card (Goes-well-with / Shop-the-Ingredients). */
function miniCardRecord($, card) {
  const $c = $(card);
  return {
    slug: $c.find('.div-block-85 a').attr('href').match(/products\/([a-z-]+)\.html/)[1],
    viewAria: $c.find('.div-block-85 a').attr('aria-label'),
    image: rewriteUrl($c.find('img.image-4').attr('src')),
    alt: $c.find('img.image-4').attr('alt'),
    catLabel: $c.find('.text-block-3-copy').text(),
    starsAria: $c.find('.wf-stars').attr('aria-label'),
    starsRating: $c.find('.wf-stars').attr('style').match(/--wf-rating:\s*([^;"]+)/)[1],
    meta: $c.find('.wf-card-meta > div:last-child').text(),
    name: $c.find('.wf-card-link').text(),
    price: $c.find('.wf-price').text()
  };
}

/* ---------------- recipes ---------------- */

const recipeFiles = fs.readdirSync(path.join(SITE, 'recipes')).filter((f) => f.startsWith('wf-') && f.endsWith('.html'));
const recipes = {};
const recipeCardFields = {}; // display fields aggregated from list contexts, keyed by slug

for (const f of recipeFiles) {
  const slug = f.replace(/\.html$/, ''); // keep the wf- prefix (URL is /recipes/wf-…)
  const $ = cheerio.load(read(path.join('recipes', f)));
  const r = {};
  r.title = $('title').text().replace(/^Wefeasto — /, '');
  r.tagColor = $('.tag').first().attr('style').match(/background-color:\s*([^;"]+)/)[1];
  r.tagText = $('.tag').first().find('div').text();
  r.metaLine = $('.text-block-55').text();
  const hero = $('img.image-41');
  r.heroImage = rewriteUrl(hero.attr('src'));
  r.heroAlt = hero.attr('alt');
  r.display = $('h1.display').text();
  r.intro = $('p.p-large-2').text();
  r.authorSub = $('.div-block-170 .p-small').text();
  const rich = $('.rich-text-block.w-richtext');
  if (rich.length !== 3) throw new Error(slug + ': expected 3 richtext blocks');
  r.ingredientsHtml = rewriteFragment($, rich.eq(0)).html().trim();
  r.directionsHtml = rewriteFragment($, rich.eq(1)).html().trim();
  r.whyHtml = rewriteFragment($, rich.eq(2)).html().trim();
  r.authorBio = $('#Author p.p-small').text();

  // Shop the Ingredients — product mini-cards (full records: the original
  // pages carry small per-page differences in alt/aria text, keep them 1:1)
  const shopSection = $('h2').filter((_, e) => $(e).text() === 'Shop the Ingredients').closest('.section');
  r.shopIngredients = shopSection
    .find('.div-block-84.wf-card')
    .map((_, card) => miniCardRecord($, card))
    .get();

  // Card-grid sections that share the wf-recs pattern, in page order:
  // 1st = extras ("Nice things to have on hand" / "Make it even better" / …),
  // 2nd = "Recommended" (bowls & brands). Locate by grid; headings vary.
  const recsSections = $('.wf-recs-grid').map((_, g) => $(g).closest('.section')[0]).get();
  const readRecs = (sectionEl) => {
    const $s = $(sectionEl);
    return {
      heading: $s.find('.div-block-91 h2').text(),
      intro: $s.find('.wf-recs-intro').text(),
      cards: $s
        .find('.wf-rec-card')
        .map((_, c) => ({ title: $(c).find('h4').text(), reason: $(c).find('.wf-rec-reason').text() }))
        .get()
    };
  };
  if (!recsSections.length) throw new Error(slug + ': no wf-recs sections found');
  const extrasSec = readRecs(recsSections[0]);
  r.extrasHeading = extrasSec.heading;
  r.extrasIntro = extrasSec.intro;
  r.extras = extrasSec.cards;
  if (recsSections.length > 1) {
    const rec = readRecs(recsSections[1]);
    r.recommendedHeading = rec.heading;
    r.recommendedIntro = rec.intro;
    r.recommended = rec.cards;
  }

  // Related posts (3 recipe cards)
  const relSection = $('h2').filter((_, e) => $(e).text() === 'Related Posts').closest('.section');
  r.related = relSection
    .find('.wf-recipe-item .wf-card-cover')
    .map((_, a) => $(a).attr('href').match(/(wf-[a-z-]+)\.html/)[1])
    .get();

  // aggregate list-card display fields from the related cards on this page
  relSection.find('.wf-recipe-item').each((_, item) => {
    const $i = $(item);
    const cslug = $i.find('.wf-card-cover').attr('href').match(/(wf-[a-z-]+)\.html/)[1];
    const fields = {
      category: $i.attr('data-wf-category'),
      catLabel: $i.find('.text-block-3-copy').text(),
      title: $i.find('h4.heading-11').text(),
      image: rewriteUrl($i.find('img.image-4').attr('src')),
      cardAlt: $i.find('img.image-4').attr('alt'),
      iconColor: $i.find('.div-block-97._2').attr('style').match(/background-color:\s*([^;"]+)/)[1],
      iconSrc: rewriteUrl($i.find('.div-block-97._2 img').attr('src')),
      iconAlt: $i.find('.div-block-97._2 img').attr('alt'),
      serves: $i.find('.wf-card-meta > div:last-child').text(),
      prepLine: $i.find('.p-small.text-medium.text-secondary').text(),
      coverAria: $i.find('.wf-card-cover').attr('aria-label')
    };
    const prev = recipeCardFields[cslug];
    const key = JSON.stringify(fields);
    if (prev && prev.key !== key) {
      console.error('INCONSISTENT related-card fields for', cslug, '\nA:', prev.key, '\nB:', key);
    }
    recipeCardFields[cslug] = { key, fields, from: slug };
  });

  recipes[slug] = r;
}

/* recipes.html list cards — authoritative display fields */
{
  const $ = cheerio.load(read('recipes.html'));
  $('#wf-recipe-grid .wf-recipe-item').each((_, item) => {
    const $i = $(item);
    const cslug = $i.find('.wf-card-cover').attr('href').match(/(wf-[a-z-]+)\.html/)[1];
    const fields = {
      category: $i.attr('data-wf-category'),
      catLabel: $i.find('.text-block-3-copy').text(),
      title: $i.find('h4.heading-11').text(),
      image: rewriteUrl($i.find('img.image-4').attr('src')),
      cardAlt: $i.find('img.image-4').attr('alt'),
      iconColor: $i.find('.div-block-97._2').attr('style').match(/background-color:\s*([^;"]+)/)[1],
      iconSrc: rewriteUrl($i.find('.div-block-97._2 img').attr('src')),
      iconAlt: $i.find('.div-block-97._2 img').attr('alt'),
      serves: $i.find('.wf-card-meta > div:last-child').text(),
      prepLine: $i.find('.p-small.text-medium.text-secondary').text(),
      coverAria: $i.find('.wf-card-cover').attr('aria-label')
    };
    const prev = recipeCardFields[cslug];
    const key = JSON.stringify(fields);
    if (prev && prev.key !== key) {
      console.error('INCONSISTENT recipes.html vs related-card fields for', cslug, '\nlist:', key, '\nrelated:', prev.key);
    }
    recipeCardFields[cslug] = { key, fields, from: 'recipes.html' };
    if (!recipes[cslug]) console.error('recipes.html card without page:', cslug);
    else recipes[cslug].card = fields;
  });
}

// order recipes as they appear on recipes.html
const $rl = cheerio.load(read('recipes.html'));
const recipeOrder = $rl('#wf-recipe-grid .wf-recipe-item .wf-card-cover')
  .map((_, a) => $rl(a).attr('href').match(/(wf-[a-z-]+)\.html/)[1])
  .get();

/* ---------------- products ---------------- */

const productFiles = fs.readdirSync(path.join(SITE, 'products')).filter((f) => f.endsWith('.html'));
const productExtras = {};
const miniCardAlts = {}; // per product slug → Set of alts seen in mini-cards

for (const f of productFiles) {
  const slug = f.replace(/\.html$/, '');
  const $ = cheerio.load(read(path.join('products', f)));
  const p = {};
  p.title = $('title').text().replace(/^Wefeasto — /, '');
  const hero = $('.wf-pdp-grid img.image-4').first();
  p.heroImage = rewriteUrl(hero.attr('src'));
  p.heroAlt = hero.attr('alt');
  p.h1 = $('h1.heading-2').text();
  const stars = $('.wf-pdp-grid .wf-stars').first();
  p.starsAria = stars.attr('aria-label');
  p.starsRating = stars.attr('style').match(/--wf-rating:\s*([^;"]+)/)[1];
  p.ratingBold = $('.wf-pdp-grid strong').first().text();
  p.priceText = $('.wf-price-large').text();
  p.chips = $('.wf-pdp-grid .wf-chip.wf-chip-small').map((_, c) => $(c).text()).get();
  p.description = $('.wf-pdp-grid p.p-large').text();
  p.qtyId = $('.wf-pdp-grid .wf-qty-input').attr('id');
  p.partners = $('.wf-partners-list .wf-partner-row')
    .map((_, a) => ({ name: $(a).find('span').first().text(), url: $(a).attr('href') }))
    .get();

  // Goes well with — full mini-card records, kept per page for 1:1 fidelity
  const gwSection = $('h2').filter((_, e) => $(e).text() === 'Goes well with').closest('.section');
  p.goesWith = gwSection
    .find('.div-block-84.wf-card')
    .map((_, card) => miniCardRecord($, card))
    .get();

  // Recipes using X
  const ruH2 = $('h2').filter((_, e) => $(e).text().startsWith('Recipes using'));
  p.recipesHeading = ruH2.text();
  const ruSection = ruH2.closest('.section');
  p.recipeCards = ruSection
    .find('.wf-card-cover')
    .map((_, a) => $(a).attr('href').match(/(wf-[a-z-]+)\.html/)[1])
    .get();
  // per-card fields (category line + description) for the product-page recipe card variant
  p.recipeCardDetails = ruSection
    .find('.div-block-84.wf-card')
    .map((_, card) => {
      const $c = $(card);
      return {
        slug: $c.find('.wf-card-cover').attr('href').match(/(wf-[a-z-]+)\.html/)[1],
        coverAria: $c.find('.wf-card-cover').attr('aria-label'),
        catLabel: $c.find('.text-block-3-copy').text(),
        catText: $c.find('.div-block-83 > div').first().text(),
        title: $c.find('h4.heading-11').text(),
        desc: $c.find('p.p-small').text(),
        image: rewriteUrl($c.find('img.image-4').attr('src')),
        alt: $c.find('img.image-4').attr('alt'),
        iconColor: $c.find('.div-block-97._2').attr('style').match(/background-color:\s*([^;"]+)/)[1],
        iconSrc: rewriteUrl($c.find('.div-block-97._2 img').attr('src')),
        iconAlt: $c.find('.div-block-97._2 img').attr('alt')
      };
    })
    .get();

  productExtras[slug] = p;
}

/* ---------------- legal pages ---------------- */

for (const page of ['terms', 'privacy']) {
  const $ = cheerio.load(read(page + '.html'));
  const wrapper = $('.page-wrapper');
  rewriteFragment($, wrapper);
  const html = wrapper.html().trim();
  fs.writeFileSync(path.join(OUT, 'src/lib/data', page + '-body.html'), html + '\n');
  const title = $('title').text();
  const desc = $('meta[name="description"]').attr('content') || null;
  fs.writeFileSync(path.join(OUT, 'src/lib/data', page + '-meta.json'), JSON.stringify({ title, description: desc }, null, 2) + '\n');
}

/* ---------------- write data modules ---------------- */

const ordered = {};
for (const slug of recipeOrder) ordered[slug] = recipes[slug];
for (const slug of Object.keys(recipes)) if (!ordered[slug]) ordered[slug] = recipes[slug];

fs.writeFileSync(
  path.join(OUT, 'src/lib/data/recipes-content.js'),
  '/* Generated from the original recipes/wf-*.html pages — do not edit by hand.\n' +
    ' * Regenerate with scratchpad tools/extract.mjs. */\n' +
    'export const recipesContent = ' + JSON.stringify(ordered, null, 2) + ';\n'
);

fs.writeFileSync(
  path.join(OUT, 'src/lib/data/products-content.js'),
  '/* Generated from the original products/*.html pages — do not edit by hand.\n' +
    ' * Regenerate with scratchpad tools/extract.mjs. */\n' +
    'export const productsContent = ' + JSON.stringify(productExtras, null, 2) + ';\n'
);

console.log('recipes:', Object.keys(ordered).length, '| products:', Object.keys(productExtras).length);
console.log('OK');
