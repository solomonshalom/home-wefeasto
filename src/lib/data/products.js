/*
 * Wefeasto shared catalog data — Svelte port of js/products-data.js.
 * Image paths are absolute (/images/…); URLs live in the SvelteKit route space.
 * Prices are numbers in INR — format for display as '₹' + price (e.g. ₹175).
 */

const BB_BRAND = 'https://www.bigbasket.com/pb/wefeasto/';
const FK_BRAND = 'https://www.flipkart.com/food-products/wefeasto~brand/pr';
const AZ_BRAND = 'https://www.amazon.in/s?k=WEFEASTO';

export const products = [
	{
		slug: 'cornflakes',
		name: 'Cornflakes',
		price: 175,
		packSize: '500 g',
		calories: 120,
		rating: 5.0,
		category: 'Flakes',
		description:
			'Golden corn flakes toasted to an honest, lasting crunch — just add cold milk and breakfast is done. Super delicious, crunchy and healthy at 120 calories a bowl.',
		image: '/images/wefeasto/product-cornflakes.jpg',
		url: '/products/cornflakes',
		partners: [
			{ name: 'BigBasket', url: 'https://www.bigbasket.com/pd/40209972/wefeasto-corn-flakes-500-g/' },
			{ name: 'Flipkart', url: 'https://www.flipkart.com/wefeasto-crunchy-corn-flakes-1-kg-breakfast-cereal-box/p/itm4de97facfed49' },
			{ name: 'Amazon', url: 'https://www.amazon.in/WEFEASTO-Corn-Flakes/dp/B08R4227T1' }
		],
		searchTerms: ['corn flakes', 'corn', 'flakes', 'cereal', 'breakfast', 'chivda']
	},
	{
		slug: 'steel-cut-oats',
		name: 'Steel-Cut Oats',
		price: 135,
		packSize: '500 g',
		calories: 80,
		rating: 4.3,
		category: 'Oats',
		description:
			'Whole oat groats cut, never rolled flat, so every spoonful keeps its bite. Slow-releasing energy at just 80 calories a serve — the fresh, filling start your mornings asked for.',
		image: '/images/wefeasto/product-steel-cut-oats.jpg',
		url: '/products/steel-cut-oats',
		partners: [
			{ name: 'BigBasket', url: 'https://www.bigbasket.com/pd/40209975/wefeasto-steel-cut-oats-500-g/' },
			{ name: 'Flipkart', url: 'https://www.flipkart.com/wefeasto-steel-cut-oats-500-g/p/itm11b5bbf35b655?pid=RYMFX2KPDN5SFU94' },
			{ name: 'Amazon', url: 'https://www.amazon.in/WeFeasto-Cereal-Breakfast-Dietary-Protein/dp/B08NHR9L6K' }
		],
		searchTerms: ['oats', 'steel cut', 'oatmeal', 'porridge', 'overnight oats', 'breakfast']
	},
	{
		slug: 'rolled-oats',
		name: 'Rolled Oats',
		price: 125,
		packSize: '500 g',
		calories: 90,
		rating: 4.4,
		category: 'Oats',
		description:
			'Whole oats steamed soft and rolled into thin flakes that cook creamy in minutes — the quick, comforting porridge base busy mornings were waiting for. High in fibre, naturally wholesome and honestly filling.',
		image: '/images/wefeasto/product-rolled-oats.jpg',
		url: '/products/rolled-oats',
		partners: [
			{ name: 'BigBasket', url: 'https://www.bigbasket.com/pd/40209974/wefeasto-rolled-oats-500-g/' },
			{ name: 'Flipkart', url: 'https://www.flipkart.com/wefeasto-rolled-oats-2-kg-cereal-breakfast-diet-food-500-g/p/itm4b2c33822fb39' },
			{ name: 'Amazon', url: 'https://www.amazon.in/Wefeasto-High-Fiber-Breakfast-Oatmeal-Organic/dp/B0BQC86N3G' }
		],
		searchTerms: ['rolled oats', 'oats', 'oatmeal', 'porridge', 'overnight oats', 'quick oats', 'breakfast']
	},
	{
		slug: 'muesli',
		name: 'Muesli',
		price: 250,
		packSize: '400 g',
		calories: 100,
		rating: 4.0,
		category: 'Muesli',
		description:
			'A toasted tumble of whole grains, nuts and fruit with no shortcuts — crunchy with cold milk, creamy layered with curd. Eat fresh and healthy without thinking twice.',
		image: '/images/wefeasto/product-muesli.jpg',
		url: '/products/muesli',
		partners: [
			{ name: 'Flipkart', url: 'https://www.flipkart.com/wefeasto-muesli-400-g/p/itm788e731f2a37b?pid=RYMFX3TYJX2DF5GW' },
			{ name: 'BigBasket', url: BB_BRAND },
			{ name: 'Amazon', url: AZ_BRAND }
		],
		searchTerms: ['muesli', 'granola', 'cereal', 'nuts', 'fruit', 'parfait', 'breakfast']
	},
	{
		slug: 'choco-flakes',
		name: "Choco's",
		price: 200,
		packSize: '250 g',
		calories: 120,
		rating: 4.5,
		category: 'Flakes',
		description:
			'Crisp chocolatey flakes that stay crunchy to the last spoon — the bowl kids race to the table for, made the Wefeasto way: tasty first, healthy always.',
		image: '/images/wefeasto/product-choco-flakes.jpg',
		url: '/products/choco-flakes',
		partners: [
			{ name: 'BigBasket', url: 'https://www.bigbasket.com/pd/40209969/wefeasto-choco-flakes-250-g/' },
			{ name: 'Flipkart', url: 'https://www.flipkart.com/wefeasto-crunchy-choco-flakes-500-gm-breakfast-cereal-box/p/itm8e8696c2cd86e' },
			{ name: 'Amazon', url: 'https://www.amazon.in/WeFeasto-Breakfast-Essential-Vitamins-Minerals/dp/B0BQRFQ7YD' }
		],
		searchTerms: ['choco', 'chocos', 'chocolate', 'choco flakes', 'kids', 'cereal']
	},
	{
		slug: 'health-mix',
		name: 'Health Mix',
		price: 270,
		packSize: null,
		calories: 120,
		rating: 5.0,
		category: 'Mix',
		description:
			'A multigrain powerhouse of millets, pulses and nuts ground into one hearty mix — stir into warm milk or porridge for a filling, wholesome breakfast in minutes.',
		image: '/images/wefeasto/product-health-mix.jpg',
		url: '/products/health-mix',
		partners: [
			{ name: 'BigBasket', url: 'https://www.bigbasket.com/pd/40209978/wefeasto-instant-health-mix-vanilla-250-g/' },
			{ name: 'Flipkart', url: 'https://www.flipkart.com/wefeasto-instant-health-mix-vanilla-flavour-250-gms-g/p/itm8a38cbb3fabd9' },
			{ name: 'Amazon', url: 'https://www.amazon.in/WEFEASTO-Health-Mix-Vanilla-Flavour/dp/B08NHQJXHK' }
		],
		searchTerms: ['health mix', 'multigrain', 'millet', 'ragi', 'sathu maavu', 'porridge', 'smoothie']
	}
];

export const recipes = [
	{
		slug: 'berry-overnight-steel-cut-oats',
		title: 'Berry Overnight Steel-Cut Oats',
		category: 'Breakfast',
		description:
			"Soak Wefeasto Steel-Cut Oats overnight with milk, honey and berries for a chilled, no-cook breakfast that's ready when you wake up.",
		image: '/images/wefeasto/recipe-berry-overnight-steel-cut-oats.jpg',
		url: '/recipes/wf-berry-overnight-steel-cut-oats',
		productSlugs: ['steel-cut-oats'],
		searchTerms: ['overnight oats', 'berries', 'no cook', 'oats']
	},
	{
		slug: 'muesli-yogurt-parfait',
		title: '5-Minute Muesli Yogurt Parfait',
		category: 'Breakfast',
		description:
			'Layers of Wefeasto Muesli, thick curd, honey and fresh fruit stacked into a glass — a crunchy, creamy breakfast in five minutes flat.',
		image: '/images/wefeasto/recipe-muesli-yogurt-parfait.jpg',
		url: '/recipes/wf-muesli-yogurt-parfait',
		productSlugs: ['muesli'],
		searchTerms: ['parfait', 'yogurt', 'curd', 'muesli', 'quick']
	},
	{
		slug: 'choco-flakes-energy-bars',
		title: 'No-Bake Choco Flakes Energy Bars',
		category: 'Kids',
		description:
			"Crunchy Wefeasto Choco's pressed with peanut butter, honey and roasted peanuts into chocolatey lunchbox bars — no oven needed.",
		image: '/images/wefeasto/recipe-choco-flakes-energy-bars.jpg',
		url: '/recipes/wf-choco-flakes-energy-bars',
		productSlugs: ['choco-flakes'],
		searchTerms: ['energy bars', 'no bake', 'chocolate', 'kids', 'lunchbox']
	},
	{
		slug: 'health-mix-smoothie-bowl',
		title: 'Health Mix Banana Smoothie Bowl',
		category: 'Breakfast',
		description:
			'Frozen banana blended thick with Wefeasto Health Mix and curd, then loaded with fruit and nuts — a spoonable power breakfast.',
		image: '/images/wefeasto/recipe-health-mix-smoothie-bowl.jpg',
		url: '/recipes/wf-health-mix-smoothie-bowl',
		productSlugs: ['health-mix'],
		searchTerms: ['smoothie bowl', 'banana', 'health mix', 'blender']
	},
	{
		slug: 'masala-cornflakes-chivda',
		title: 'Masala Cornflakes Chivda',
		category: 'Snacks',
		description:
			'Wefeasto Cornflakes tossed with curry leaves, peanuts and a light turmeric tadka — a crunchy tea-time namkeen made in ten minutes.',
		image: '/images/wefeasto/recipe-masala-cornflakes-chivda.jpg',
		url: '/recipes/wf-masala-cornflakes-chivda',
		productSlugs: ['cornflakes'],
		searchTerms: ['chivda', 'namkeen', 'masala', 'snack', 'tea time']
	},
	{
		slug: 'oats-with-berries-sundae',
		title: 'Oats With Berries Sundae',
		category: 'Desserts',
		description:
			"Wefeasto's own classic — an oats sundae layered with juicy berries and a fresh topping of fresh cream, served chilled in a tall glass.",
		image: '/images/wefeasto/recipe-oats-with-berries-sundae.jpg',
		url: '/recipes/wf-oats-with-berries-sundae',
		productSlugs: ['steel-cut-oats'],
		searchTerms: ['sundae', 'dessert', 'berries', 'cream', 'oats']
	},
	{
		slug: 'honey-nut-cornflake-clusters',
		title: 'Honey Nut Cornflake Clusters',
		category: 'Snacks',
		description:
			'Crunchy honey-and-ghee clusters of Wefeasto Cornflakes and toasted nuts, set firm for tea-time and lunchboxes.',
		image: '/images/wefeasto/recipe-honey-nut-cornflake-clusters.jpg',
		url: '/recipes/wf-honey-nut-cornflake-clusters',
		productSlugs: ['cornflakes'],
		searchTerms: ['clusters', 'cornflake', 'cornflakes', 'honey', 'nut', 'snacks']
	},
	{
		slug: 'banana-oat-pancakes',
		title: 'Banana Oat Pancakes',
		category: 'Breakfast',
		description:
			'Fluffy flourless blender pancakes made from Wefeasto Rolled Oats, banana and egg (or curd) — a wholesome weekend breakfast kids adore.',
		image: '/images/wefeasto/recipe-banana-oat-pancakes.jpg',
		url: '/recipes/wf-banana-oat-pancakes',
		productSlugs: ['rolled-oats'],
		searchTerms: ['banana', 'breakfast', 'oat', 'oats', 'pancakes', 'rolled']
	},
	{
		slug: 'savoury-masala-oats',
		title: 'Savoury Veggie Masala Oats',
		category: 'Breakfast',
		description:
			'A quick, comforting bowl of savoury masala oats loaded with veggies and a fragrant curry-leaf tadka — ready before your chai goes cold.',
		image: '/images/wefeasto/recipe-savoury-masala-oats.jpg',
		url: '/recipes/wf-savoury-masala-oats',
		productSlugs: ['rolled-oats'],
		searchTerms: ['breakfast', 'masala', 'oats', 'rolled', 'savoury', 'veggie']
	},
	{
		slug: 'muesli-breakfast-cookies',
		title: 'Muesli Breakfast Cookies',
		category: 'Kids',
		description:
			'Chewy, wholesome breakfast cookies made with Wefeasto Muesli, mashed banana and peanut butter — a lightly sweetened grab-and-go treat kids actually finish.',
		image: '/images/wefeasto/recipe-muesli-breakfast-cookies.jpg',
		url: '/recipes/wf-muesli-breakfast-cookies',
		productSlugs: ['muesli'],
		searchTerms: ['breakfast', 'cookies', 'kids', 'muesli']
	},
	{
		slug: 'choco-flakes-milkshake',
		title: 'Choco Flakes Chocolate Milkshake',
		category: 'Kids',
		description:
			"A thick, frothy chocolate milkshake blended with Wefeasto Choco's and topped with crunchy flakes — the after-school treat kids beg for.",
		image: '/images/wefeasto/recipe-choco-flakes-milkshake.jpg',
		url: '/recipes/wf-choco-flakes-milkshake',
		productSlugs: ['choco-flakes'],
		searchTerms: ['choco', 'chocolate', 'flakes', 'kids', 'milkshake', 's']
	},
	{
		slug: 'warm-health-mix-porridge',
		title: 'Warm Health Mix Porridge',
		category: 'Breakfast',
		description:
			'A cosy multigrain porridge simmered with milk and jaggery, finished with toasted nuts for a filling, feel-good morning bowl.',
		image: '/images/wefeasto/recipe-warm-health-mix-porridge.jpg',
		url: '/recipes/wf-warm-health-mix-porridge',
		productSlugs: ['health-mix'],
		searchTerms: ['breakfast', 'health', 'mix', 'porridge', 'warm']
	}
];

export function productBySlug(slug) {
	return products.find((p) => p.slug === slug) || null;
}

export function formatINR(n) {
	const num = Math.round(Number(n) || 0);
	return '₹' + num.toLocaleString('en-IN');
}
