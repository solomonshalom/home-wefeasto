<script>
	/* Choose a new password from the emailed link (/reset-password?token=…,
	   sent by Payload's forgot-password flow). Same card as /login. The token
	   is read once on mount and dropped from the address bar, but kept for
	   this tab until it is used (../login/link-token.js): a reload of an
	   unused link still shows the form. Rule: PASSWORD_MIN
	   to PASSWORD_MAX characters (session.js; the CMS enforces the same 8–128,
	   and its 400 maps to the same copy), typed twice.
	   Success → /login?reset=1 ("log in with your new password"). */
	import { onMount, tick } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import Spinner from '$lib/components/Spinner.svelte';
	import { resetPassword, isAuthToken, MESSAGES, PASSWORD_MIN } from '$lib/session.js';
	import { focusIfLost, submitterOf } from '../login/focus.js';
	import { keepLinkToken, keptLinkToken, dropLinkToken } from '../login/link-token.js';

	let token = $state(null); // null until mounted; '' = none to use
	/* Why there is none: 'malformed' (the link lost part of its token) or
	   'none' (no token in the address and none kept for this tab). */
	let missing = $state('malformed');
	let password = $state('');
	let confirm = $state('');
	let busy = $state(false);
	let error = $state(null); // { message, field? }
	let expired = $state(false);

	async function onSubmit(e) {
		e.preventDefault();
		if (busy) return;
		error = null;
		if (password.length < PASSWORD_MIN) return fail({ code: 'WEAK_PASSWORD', message: MESSAGES.WEAK_PASSWORD, field: 'password' });
		if (password !== confirm) return fail({ code: 'PASSWORD_MISMATCH', message: MESSAGES.PASSWORD_MISMATCH, field: 'confirm' });
		const button = submitterOf(e);
		busy = true;
		const r = await resetPassword(token, password);
		busy = false;
		if (r.ok) {
			dropLinkToken('reset');
			password = confirm = '';
			goto('/login?reset=1', { replaceState: true });
			return;
		}
		if (r.error.code === 'RESET_INVALID') {
			expired = true;
			dropLinkToken('reset'); // used or expired: a reload must not bring it back
		}
		fail(r.error, button);
	}

	/**
	 * Show the error; focus the field at fault. With none, the busy (disabled)
	 * button dropped focus: a used link moves it on to "Ask for a new reset
	 * link", anything else puts it back on the button.
	 * The alert is taken out and put back first, so the same words twice (a
	 * second too-short password) are still announced twice: a role=alert only
	 * speaks when it is inserted or its text changes.
	 */
	let failSeq = 0;
	async function fail(err, button = null) {
		const seq = ++failSeq;
		error = null;
		await tick();
		if (seq !== failSeq) return; // a later attempt took over
		error = err;
		await tick();
		if (err.field) document.getElementById(err.field === 'confirm' ? 'wf-reset-confirm' : 'wf-reset-password')?.focus();
		else focusIfLost(expired ? document.querySelector('[data-wf-reset-again]') : button);
	}

	onMount(() => {
		const raw = page.url.searchParams.get('token');
		if (raw === null) {
			// A reload (or a return to this tab) after the token left the address bar.
			token = keptLinkToken('reset') ?? '';
			missing = 'none';
			return;
		}
		if (isAuthToken(raw)) {
			token = raw;
			keepLinkToken('reset', raw);
		} else {
			token = '';
			missing = 'malformed';
			dropLinkToken('reset'); // a different (broken) link replaces whatever was kept
		}
		const url = new URL(page.url);
		url.searchParams.delete('token');
		try {
			replaceState(url, page.state);
		} catch (e) {
			history.replaceState(history.state, '', url);
		}
	});
</script>

<svelte:head>
	<title>Wefeasto — Choose a New Password</title>
	<meta name="robots" content="noindex">
	<meta name="referrer" content="no-referrer">
</svelte:head>

<div class="page-wrapper">
  <div class="section">
    <div class="container">
      <div class="wf-login-outer">
        <div class="wf-reveal">
          <div class="wf-login-card wf-reset-card">
            <a href="/" class="wf-login-brand" aria-label="Wefeasto home"><img src="/images/wefeasto/logo.png" alt="Wefeasto" class="wf-brand-logo"></a>
            <div class="divider _24px"></div>
            <h1 class="wf-reset-title">Choose a new password</h1>
            <div class="divider _16px"></div>
            <noscript><p class="wf-auth-lead">Resetting your password needs JavaScript.</p></noscript>
            {#if token === ''}
              <div class="wf-auth-notice" id="wf-reset-notice" role="alert" data-wf-reset-missing={missing}>{#if missing === 'none'}To choose a new password, open the reset link from your email again, or ask for a new one.{:else}This reset link is incomplete. Open the link from your email again, or ask for a new one.{/if}</div>
              <a href="/login?forgot=1" class="button wf-btn-full w-inline-block"><div>Get a new reset link</div></a>
            {:else}
              {#if error}<div class="wf-auth-notice" id="wf-reset-notice" role="alert">{error.message}</div>{/if}
              <form id="wf-reset-form" method="post" novalidate onsubmit={onSubmit}>
                <div class="wf-field"><label class="wf-label" for="wf-reset-password">New password</label><input class="wf-input" type="password" id="wf-reset-password" name="password" autocomplete="new-password" minlength={PASSWORD_MIN} bind:value={password} aria-invalid={error?.field === 'password' || undefined} aria-describedby={error?.field === 'password' ? 'wf-reset-notice wf-reset-hint' : 'wf-reset-hint'}><p class="wf-form-note wf-auth-hint" id="wf-reset-hint">At least {PASSWORD_MIN} characters.</p></div>
                <div class="wf-field"><label class="wf-label" for="wf-reset-confirm">Type it again</label><input class="wf-input" type="password" id="wf-reset-confirm" name="confirm" autocomplete="new-password" bind:value={confirm} aria-invalid={error?.field === 'confirm' || undefined} aria-describedby={error?.field === 'confirm' ? 'wf-reset-notice' : undefined}></div>
                <div class="divider _8px"></div>
                <button type="submit" class="button wf-btn-full" disabled={busy || token === null} aria-busy={busy}>{#if busy}<Spinner /> Saving…{:else}Save new password{/if}</button>
              </form>
              {#if expired}<div class="wf-auth-row wf-auth-row-center"><a href="/login?forgot=1" class="wf-auth-small" data-wf-reset-again>Ask for a new reset link</a></div>{/if}
            {/if}
          </div>
        </div>
        <p class="wf-auth-terms">Remembered it? <a href="/login">Log in</a>.</p>
      </div>
    </div>
  </div>
</div>
