<script>
	/*
	 * "Also available at" dropdown — port of the .wf-partners delegated toggle
	 * (opens on trigger click, closes on any click outside the box).
	 */
	import { onMount } from 'svelte';

	let { partners } = $props();

	let open = $state(false);
	let box;

	function toggle(e) {
		e.preventDefault();
		open = !open;
	}

	onMount(() => {
		const onDocClick = (e) => {
			if (open && box && !box.contains(e.target)) open = false;
		};
		document.addEventListener('click', onDocClick);
		return () => document.removeEventListener('click', onDocClick);
	});
</script>

<div class="wf-partners{open ? ' wf-open' : ''}" bind:this={box}><button type="button" class="wf-partners-trigger" onclick={toggle}>Also available at <span class="wf-partners-caret">▾</span></button><div class="wf-partners-list">{#each partners as partner (partner.url)}<a href={partner.url} target="_blank" rel="noopener" class="wf-partner-row"><span>{partner.name}</span><span class="wf-partner-buy">Buy ↗</span></a>{/each}</div></div>
