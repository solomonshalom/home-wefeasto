<script>
	/*
	 * One-line checkout / order notice with its actions ("Payment didn't go
	 * through — no money was taken. [Try again] [Pay on delivery instead]").
	 * Used by /checkout, the pending-order banner and /order. `code` lands in
	 * data-wf-co-note for tests; the node is focusable so the page can move
	 * focus to it when it appears.
	 * actions: [{id, label, onclick?, href?, disabled?}]
	 */
	let { message, actions = [], help = null, code = '', role = 'alert', element = $bindable(null) } = $props();
</script>

<div class="wf-co-note" data-wf-co-note={code || undefined} {role} tabindex="-1" bind:this={element}><p class="wf-co-note-text">{message}</p>{#if actions.length || help}<div class="wf-co-note-actions">{#each actions as a (a.id)}{#if a.href}<a class="wf-chip wf-co-note-btn" href={a.href} data-wf-action={a.id}>{a.label}</a>{:else}<button type="button" class="wf-chip wf-co-note-btn" data-wf-action={a.id} disabled={a.disabled || undefined} onclick={a.onclick}>{a.label}</button>{/if}{/each}{#if help}<a class="wf-co-note-help" href={help} target="_blank" rel="noopener noreferrer" data-wf-whatsapp>Need help? WhatsApp us</a>{/if}</div>{/if}</div>
