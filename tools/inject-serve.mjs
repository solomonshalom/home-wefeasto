/*
 * Injects a per-recipe "Bowls & brands we recommend" section into each
 * original recipes/wf-*.html page, right before the Related Posts section.
 * Reuses the existing wf-recs-grid / wf-rec-card pattern (no new CSS).
 * Idempotent: skips pages that already carry the section.
 *   node inject-serve.mjs <site-root>
 */
import fs from 'node:fs';
import path from 'node:path';

const SITE = process.argv[2];
const HEADING = 'Recommended';
const RELATED_MARKER = '<div id="w-node-f4e7aae3-7159-cc67-6f44-315b0015118a-81c6f288" class="section">';

const SERVE = {
	'wf-berry-overnight-steel-cut-oats': {
		intro: 'The right jar or bowl is half the joy of overnight oats — here’s what we reach for when we make this one.',
		cards: [
			['Wide-mouth glass jars — Borosil or Yera', 'Soak and serve in the same 400 ml jar: glass shows off the berry layers, seals well overnight and never holds on to fridge smells.'],
			['Deep opalware bowls — La Opala', 'Tipping it into a chilled 500 ml opal-glass bowl keeps the oats colder for longer than steel, and the white glaze makes the berries pop.'],
			['Leak-proof lids — Milton or Signoraware', 'A properly sealing lid means the jar can ride in a work bag — breakfast travels without a single drip.']
		]
	},
	'wf-muesli-yogurt-parfait': {
		intro: 'A parfait is dressed by its glass — these are the ones that make the layers sing.',
		cards: [
			['Tall parfait glasses — Ocean or Yera', 'Straight-sided 350 ml glasses stack the curd and muesli into neat stripes — half the pleasure is seeing the layers before you dig in.'],
			['Stemless dessert tumblers — Borosil', 'Thick-bottomed glass tumblers sit steady on a breakfast tray and go straight from fridge to table.'],
			['Long sundae spoons — FNS or any steel set', 'A long-handled spoon reaches the bottom layer without toppling the glass, so the last bite is as good as the first.']
		]
	},
	'wf-choco-flakes-energy-bars': {
		intro: 'Set, cut and pack these bars like a pro with the tins and boxes below.',
		cards: [
			['Square steel tray — Vinod or Bergner', 'A 20 cm square tray with sharp corners presses the slab into an even layer, so every bar cuts clean and equal.'],
			['Butter paper — Oddy', 'Line the tray with overhanging flaps and the whole slab lifts out in one piece — no chiselling, no crumbs.'],
			['Steel lunchboxes — Milton or Cello', 'A snug airtight dabba keeps the bars firm in a school bag and stops them picking up tiffin smells.']
		]
	},
	'wf-health-mix-smoothie-bowl': {
		intro: 'Smoothie bowls are all about the bowl — wide, shallow and cold is the rule.',
		cards: [
			['Wide, shallow bowls — La Opala', 'A wide 600 ml opalware bowl gives your fruit-and-nut rows room to sit on top instead of sinking — the classic smoothie-bowl look.'],
			['A sturdy blender jar — Prestige or Wonderchef', 'Frozen bananas ask a lot of a blender; a thick jar with a strong blade blends them silky without stalling.'],
			['The freezer-bowl trick — any Vinod steel bowl', 'Ten minutes in the freezer before serving and a steel bowl keeps the smoothie thick to the last spoon, even in May.']
		]
	},
	'wf-masala-cornflakes-chivda': {
		intro: 'Serve and store this chivda the way Indian kitchens always have — steel, and plenty of it.',
		cards: [
			['Steel serving katoris — Vinod or Neelam', 'Small 150 ml katoris portion out chai-time servings neatly — and what’s not eaten never goes back soggy into the dabba.'],
			['Airtight steel dabbas — Milton or Signoraware', 'A gasket-sealed dabba is the difference between chivda that snaps for three weeks and chivda that sighs in three days.'],
			['A wide kadhai — Prestige or Hawkins', 'Heavy steel spreads the tadka’s heat evenly, so every flake picks up masala without a single scorched corner.']
		]
	},
	'wf-oats-with-berries-sundae': {
		intro: 'A sundae deserves its glass — tall, clear and properly chilled.',
		cards: [
			['Tall sundae glasses — Ocean or Yera', 'Classic 300 ml tulip glasses show every layer of oats, berry and cream — chill them for 10 minutes first so nothing slumps.'],
			['Glass dessert bowls — Borosil', 'For a family-style version, layer the sundae in one wide glass bowl and scoop at the table.'],
			['Long parfait spoons — FNS or any steel set', 'The long neck reaches the berry compote at the bottom without disturbing the cream on top.']
		]
	},
	'wf-honey-nut-cornflake-clusters': {
		intro: 'Good clusters come down to a steady pan and a proper jar.',
		cards: [
			['Heavy-bottomed pan — Prestige or Hawkins', 'Honey scorches fast on thin steel; a heavy base lets it bubble gently to exactly sticky enough.'],
			['Butter paper sheets — Oddy', 'Spoon the clusters onto lined trays and they set glossy and release clean — nothing glued to the plate.'],
			['Counter-top snack jars — Borosil or Cello', 'An airtight glass jar keeps clusters snapping for a fortnight and looks good enough to leave on the shelf.']
		]
	},
	'wf-banana-oat-pancakes': {
		intro: 'Fluffy flourless pancakes ask for the right pan — and a warm plate to land on.',
		cards: [
			['Non-stick tawa or pan — Prestige or Wonderchef', 'Flourless batter is delicate; a good non-stick surface with a whisper of ghee flips each pancake without tearing.'],
			['Warm breakfast plates — La Opala', 'Run the plates under hot water before stacking — pancakes stay soft and warm while the next batch cooks.'],
			['A small steel ladle — Vinod', 'One ladleful is one pancake: even pours mean even sizes, and the stack looks bakery-neat.']
		]
	},
	'wf-savoury-masala-oats': {
		intro: 'A hot, saucy bowl of masala oats stays hot in the right vessel.',
		cards: [
			['Deep ceramic bowls — La Opala', 'A deep 500 ml bowl holds the heat while you finish your chai — savoury oats go gluey when they cool too fast.'],
			['A heavy kadhai — Hawkins or Prestige', 'The veggies want a proper sauté before the oats go in; heavy steel browns them without catching.'],
			['Soup spoons — FNS or any steel set', 'A rounded spoon scoops the saucy oats and veggies together — teaspoons just don’t do it justice.']
		]
	},
	'wf-muesli-breakfast-cookies': {
		intro: 'Bake and store these cookies with the kit below and they stay chewy all week.',
		cards: [
			['Aluminium baking tray and butter paper — Oddy', 'A lined tray browns the bottoms evenly and the cookies slide off without a spatula fight.'],
			['Wire cooling rack — Wonderchef', 'Ten minutes on a rack lets steam escape so the bases stay chewy, never soggy.'],
			['A glass cookie jar — Borosil or Cello', 'Airtight glass on the counter keeps them week-long fresh — and in plain sight for breakfast.']
		]
	},
	'wf-choco-flakes-milkshake': {
		intro: 'Thick shakes deserve tall glasses — and a blender that doesn’t flinch.',
		cards: [
			['Tall milkshake glasses — Ocean or Yera', 'A 400 ml tall glass leaves room for the frothy top and the crunchy flake sprinkle that makes this shake.'],
			['A strong blender jar — Prestige or Wonderchef', 'Blending flakes, milk and ice into a froth needs a tight lid and a sturdy blade — thin jars rattle and leak.'],
			['Steel straws and long spoons — Vinod or any steel set', 'A wide steel straw handles a thick shake, and the long spoon rescues the flakes that sink.']
		]
	},
	'wf-warm-health-mix-porridge': {
		intro: 'A cosy porridge stays cosy in the right bowl — here’s our winter line-up.',
		cards: [
			['Deep porridge bowls — La Opala', 'Thick opalware walls keep the porridge warm to the last spoonful — cup the bowl in your hands on a cold morning.'],
			['A small milk pan — Vinod or Prestige', 'A narrow, heavy pan simmers milk gently and saves you the stove-top boil-over drama.'],
			['Steel katoris for toppings — Neelam', 'Set the toasted nuts and jaggery shavings in little katoris at the table, so everyone crowns their own bowl.']
		]
	}
};

function sectionHtml(entry) {
	const cards = entry.cards
		.map(
			([title, reason]) =>
				'<div class="wf-reveal"><div class="wf-rec-card"><h4 class="heading-11">' +
				title +
				'</h4><p class="wf-rec-reason">' +
				reason +
				'</p></div></div>'
		)
		.join('');
	return (
		'<div class="section"><div class="div-block-90"><div class="div-block-91"><h2>' +
		HEADING +
		'</h2></div><div class="divider _42px"></div><p class="p-large wf-recs-intro">' +
		entry.intro +
		'</p><div class="divider _24px"></div><div class="wf-recs-grid">' +
		cards +
		'</div><div class="divider _64px"></div></div></div>'
	);
}

let changed = 0;
for (const [slug, entry] of Object.entries(SERVE)) {
	const file = path.join(SITE, 'recipes', slug + '.html');
	let html = fs.readFileSync(file, 'utf8');
	if (html.includes(HEADING)) {
		console.log('skip  ' + slug + ' (already has the section)');
		continue;
	}
	const idx = html.indexOf(RELATED_MARKER);
	if (idx === -1) throw new Error(slug + ': related-posts marker not found');
	if (html.indexOf(RELATED_MARKER, idx + 1) !== -1) throw new Error(slug + ': marker not unique');
	html = html.slice(0, idx) + sectionHtml(entry) + html.slice(idx);
	fs.writeFileSync(file, html);
	changed++;
	console.log('ok    ' + slug);
}
console.log(changed + ' pages updated');
