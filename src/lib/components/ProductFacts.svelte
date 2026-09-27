<script module>
	import { products as snapshotProducts } from '$lib/data/cms-snapshot.json';

	const LABELS = [
		['netQuantity', 'Net quantity', 'net quantity'],
		['ingredients', 'Ingredients', 'ingredients'],
		['allergens', 'Allergens', 'allergens'],
		['bestBefore', 'Best before', 'best before'],
		['manufacturer', 'Manufacturer / packer', 'manufacturer'],
		['countryOfOrigin', 'Country of origin', 'country of origin']
	];

	const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

	/**
	 * The facts that exist, in legal-label order: [{key, label, short, value}].
	 * Blank strings, null and empty allergen lists are left out.
	 */
	export function factRows(facts) {
		if (!facts || typeof facts !== 'object') return [];
		const rows = [];
		for (const [key, label, short] of LABELS) {
			const raw = facts[key];
			const value = Array.isArray(raw) ? raw.map(clean).filter(Boolean).join(', ') : clean(raw);
			if (value) rows.push({ key, label, short, value });
		}
		return rows;
	}

	/** Snapshot facts for a product slug (null when unknown). */
	export function factsFor(slug) {
		const p = snapshotProducts.find((x) => x.slug === slug);
		return p ? p.facts : null;
	}
</script>

<script>
	/*
	 * PDP "Product facts" (roadmap M7): a native <details> after the partners
	 * dropdown, so it opens and closes without JS and the Add row never moves.
	 * Only facts that exist are rendered (none → no element at all); values
	 * are plain text. Data: the snapshot's products[].facts (CMS-editable).
	 */
	let { slug, facts = undefined } = $props();

	const rows = $derived(factRows(facts === undefined ? factsFor(slug) : facts));
</script>

{#if rows.length}<details class="wf-facts"><summary class="wf-facts-summary">Product facts: {rows.map((r) => r.short).join(', ')}</summary><dl class="wf-facts-list">{#each rows as row (row.key)}<div class="wf-facts-row"><dt>{row.label}</dt><dd>{row.value}</dd></div>{/each}</dl></details>{/if}
