import { error } from '@sveltejs/kit';
import { recipesContent } from '$lib/data/recipes-content.js';

export function load({ params }) {
	const recipe = recipesContent[params.slug];
	if (!recipe) error(404, 'Not found');
	return { slug: params.slug, recipe };
}

export function entries() {
	return Object.keys(recipesContent).map((slug) => ({ slug }));
}
