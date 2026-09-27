<script>
	/*
	 * The checkout's submit button (#wf-place-order): the amount in the label
	 * ("Pay ₹524 securely" / "Place order · Pay ₹524 on delivery"), and a busy
	 * state with the bublr Spinner ("Opening payment…") that keeps its width
	 * steady. Busy or disabled, it cannot submit (the flow also ignores a
	 * second tap while one is in flight).
	 */
	import Spinner from '$lib/components/Spinner.svelte';

	let { label, busy = false, busyLabel = 'Opening payment…', disabled = false, id = 'wf-place-order' } = $props();
</script>

<button type="submit" class="button w-button wf-pay-btn" {id} disabled={disabled || busy || undefined} aria-busy={busy ? 'true' : undefined} data-wf-pay-state={busy ? 'busy' : disabled ? 'disabled' : 'ready'}>{#if busy}<Spinner /><span>{busyLabel}</span>{:else}{label}{/if}</button>
