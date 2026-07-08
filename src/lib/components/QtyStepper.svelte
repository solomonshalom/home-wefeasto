<script>
	/*
	 * Quantity pill (− input +) — port of the .wf-qty stepper from js/wefeasto.js.
	 * Clamps to ≥1 and reports changes so pages (cart) can react like the
	 * original bubbling 'change' event did.
	 */
	let {
		id,
		value = $bindable(1),
		minusLabel = 'Decrease quantity',
		plusLabel = 'Increase quantity',
		inputLabel = 'Quantity',
		onUpdate = null
	} = $props();

	function step(delta, e) {
		e.preventDefault();
		value = Math.max(1, (parseInt(value, 10) || 1) + delta);
		if (onUpdate) onUpdate(value);
	}

	function onChange() {
		value = Math.max(1, parseInt(value, 10) || 1);
		if (onUpdate) onUpdate(value);
	}
</script>

<div class="wf-qty"><button type="button" class="wf-qty-btn" data-wf-qty-minus aria-label={minusLabel} onclick={(e) => step(-1, e)}>−</button><input class="wf-qty-input" {id} type="number" bind:value min="1" aria-label={inputLabel} onchange={onChange}><button type="button" class="wf-qty-btn" data-wf-qty-plus aria-label={plusLabel} onclick={(e) => step(1, e)}>+</button></div>
