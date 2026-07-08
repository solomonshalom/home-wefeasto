import { error } from '@sveltejs/kit';
import { products } from '$lib/data/products.js';
import { productsContent } from '$lib/data/products-content.js';

export function load({ params }) {
	const product = products.find((p) => p.slug === params.slug) || null;
	const content = productsContent[params.slug];
	if (!product || !content) error(404, 'Not found');
	return { product, content };
}

export function entries() {
	return products.map((p) => ({ slug: p.slug }));
}
