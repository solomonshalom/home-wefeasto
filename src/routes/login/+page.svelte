<script>
	/* Log in / sign up / forgot password (roadmap S3) on the original login.html
	   markup: the segmented tabs, the GSAP panel swap and the notice element
	   are the prototype's; the forms now talk to Payload's customers auth
	   through $lib/session.js.
	   - ?verify=<token>   (link in the signup email) confirm the email, then "log in"
	   - ?next=/path       where to go after logging in (same-origin paths only)
	   - ?reset=1          after /reset-password: "log in with your new password"
	   - ?forgot=1         open on the forgot-password panel
	   - ?signup=1         open on the sign-up panel (/order's "Create an account")
	   - ?session=expired  /account lost its session mid-visit
	   "Send the link again" (POST /api/store/account/resend-verification) sits
	   under the notice after an unverified login and after signing up.
	   Every message goes to #wf-auth-notice (role=status); the field at fault
	   gets aria-invalid and focus. "Continue with Google" stays hidden until
	   OAuth exists (roadmap M8).
	   Before hydration every submit button is disabled (as /checkout's Pay):
	   a native submit would POST the password to the static host and come
	   back to an empty form, and a disabled default button also stops Enter.
	   The ?verify token is kept for this tab until it has worked
	   (./link-token.js): a lost answer offers "Try again", and a reload
	   picks it up again. */
	import { onMount, tick } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import Spinner from '$lib/components/Spinner.svelte';
	import { motionOK } from '$lib/fx.js';
	import { login, signup, forgotPassword, verifyEmail, resendVerification, refresh, safeNext, PASSWORD_MIN, MESSAGES } from '$lib/session.js';
	import { focusIfLost, submitterOf } from './focus.js';
	import { keepLinkToken, keptLinkToken, dropLinkToken, wasReloaded } from './link-token.js';

	/** Flip on when Google OAuth exists: the button and the "or" divider come back. */
	const GOOGLE_AUTH = false;

	let tabLoginEl, tabSignupEl, panelLoginEl, panelSignupEl, panelForgotEl, panelsWrapEl, noticeEl;

	let signupActive = $state(false);
	let noticeHidden = $state(true);
	let noticeText = $state('');
	/* Bumped when a message repeats word for word: the text is put back as a
	   new node, so assistive technology reads it again (a live region only
	   speaks what changes; the shake is for eyes only). */
	let noticeKey = $state(0);
	let noticeTone = $state('error'); // 'error' | 'ok'
	let mounted = $state(false); // false until hydrated: the submit buttons stay disabled
	let busy = $state(''); // '' | 'login' | 'signup' | 'forgot' | 'resend'
	/* "Send the link again" under the notice: the address to resend for ('' = no
	   action) and its lead-in. Lives outside the notice (role=status) so the
	   live region only reads the message. */
	let resendEmail = $state('');
	let resendLead = $state('');
	/* "Try again" under the notice after the ?verify request itself failed
	   (offline, timeout, server trouble); `verifyToken` is what it re-sends. */
	let verifyRetry = $state(false);
	let verifying = $state(false);
	let verifyToken = '';
	let invalid = $state(''); // id of the field at fault
	let next = '/account';

	let loginEmail = $state('');
	let loginPassword = $state('');
	let signupName = $state('');
	let signupEmail = $state('');
	let signupPassword = $state('');
	let forgotEmail = $state('');

	let animating = false;
	let queued = null;
	let current = 'login';
	const ORDER = { login: 0, forgot: 1, signup: 2 };

	function gsapOK() {
		return motionOK();
	}

	const panelEl = (name) => (name === 'signup' ? panelSignupEl : name === 'forgot' ? panelForgotEl : panelLoginEl);

	/** Show one panel (login | signup | forgot); the tabs follow (forgot lives under Log In). */
	function swap(to, { instant = false, shown = null } = {}) {
		if (typeof to === 'boolean') to = to ? 'signup' : 'login';
		if (animating) {
			queued = to; // quick tab flips: run the last one when this swap ends
			return;
		}
		const incoming = panelEl(to);
		const outgoing = panelEl(current);
		if (to === current || !incoming.hidden) return;
		const dir = ORDER[to] > ORDER[current] ? 1 : -1;
		current = to;
		signupActive = to === 'signup';
		invalid = '';

		if (instant || !gsapOK()) {
			outgoing.hidden = true;
			incoming.hidden = false;
			shown?.();
			return;
		}

		animating = true;
		const gsap = window.gsap;
		const startH = panelsWrapEl.offsetHeight;

		gsap.to(outgoing, {
			x: -24 * dir,
			autoAlpha: 0,
			duration: 0.18,
			ease: 'power2.in',
			onComplete() {
				outgoing.hidden = true;
				gsap.set(outgoing, { clearProps: 'all' });
				incoming.hidden = false;
				const endH = panelsWrapEl.offsetHeight;
				gsap.set(panelsWrapEl, { height: startH });
				gsap.set(incoming, { x: 24 * dir, autoAlpha: 0 });
				gsap.to(panelsWrapEl, {
					height: endH,
					duration: 0.35,
					ease: 'power2.out',
					onComplete() {
						gsap.set(panelsWrapEl, { clearProps: 'height' });
					}
				});
				gsap.to(incoming, {
					x: 0,
					autoAlpha: 1,
					duration: 0.35,
					ease: 'power2.out',
					onComplete() {
						gsap.set(incoming, { clearProps: 'all' });
						animating = false;
						shown?.(); // focus only once it is visible (autoAlpha 0 would blur it)
						const q = queued;
						queued = null;
						if (q && q !== current) swap(q);
					}
				});
			}
		});
	}

	/** Tab click: switching tabs clears the old message. */
	function onTab(toSignup) {
		if ((toSignup ? 'signup' : 'login') === current) return;
		hideNotice();
		swap(toSignup);
	}

	function onTabKeydown(e, tab) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
		e.preventDefault();
		const other = tab === 'login' ? tabSignupEl : tabLoginEl;
		const target = e.key === 'Home' ? tabLoginEl : e.key === 'End' ? tabSignupEl : other;
		target.focus();
		onTab(target === tabSignupEl);
	}

	/* Notice motion. A killed GSAP tween never runs its clearProps, so each
	   show/hide first settles whatever was running. Without that, a message
	   that replaced one still fading in (?verify: "Confirming your email…" →
	   "Email verified — log in") stayed frozen mid-tween as a 7px sliver at
	   15% opacity. noticeSeq drops a fade-in whose `await tick()` was
	   overtaken by a later show/hide. */
	let noticeAnim = ''; // '' | 'in' | 'out' | 'shake': the tween running now
	let noticeSeq = 0;
	const COLLAPSED = { height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, y: 10, autoAlpha: 0 };

	/** Where the notice is on screen right now (mid-tween values included). */
	function noticeNow() {
		const get = (el, p) => window.gsap.getProperty(el, p);
		const props = ['height', 'marginBottom', 'paddingTop', 'paddingBottom', 'y'];
		return { ...Object.fromEntries(props.map((p) => [p, get(noticeEl, p)])), autoAlpha: get(noticeEl, 'opacity') };
	}

	/** Stop the running tween and wipe its inline styles; returns which one it was. */
	function settleNotice() {
		const was = noticeAnim;
		noticeAnim = '';
		window.gsap.killTweensOf(noticeEl);
		window.gsap.set(noticeEl, { clearProps: 'all' });
		return was;
	}

	function hideNotice() {
		const seq = ++noticeSeq;
		resendEmail = '';
		verifyRetry = false;
		if (noticeHidden) return;
		if (!gsapOK() || noticeEl.hidden) {
			// no motion, or a fade-in still waiting for its first frame
			if (gsapOK()) settleNotice();
			noticeHidden = true;
			return;
		}
		const gsap = window.gsap;
		gsap.killTweensOf(noticeEl); // collapse from wherever a fade-in / shake got to
		noticeAnim = 'out';
		gsap.to(noticeEl, {
			height: 0,
			marginBottom: 0,
			paddingTop: 0,
			paddingBottom: 0,
			autoAlpha: 0,
			duration: 0.3,
			ease: 'power2.in',
			onComplete() {
				if (seq !== noticeSeq) return;
				noticeAnim = '';
				noticeHidden = true;
				gsap.set(noticeEl, { clearProps: 'all' });
			}
		});
	}

	/**
	 * Show (or re-acknowledge with a shake) a message in #wf-auth-notice.
	 * `resend`: offer "Send the link again" for that address under the notice.
	 * `retry`: offer "Try again" for the email verification.
	 */
	async function showNotice(text, tone = 'error', { resend = '', lead = '', retry = false } = {}) {
		const seq = ++noticeSeq;
		resendEmail = resend;
		verifyRetry = retry;
		resendLead = resend ? lead : '';
		const shown = !noticeHidden && !noticeEl.hidden;
		const same = shown && noticeText === text;
		noticeText = text;
		noticeTone = tone;
		if (same) noticeKey++;
		if (!gsapOK()) {
			noticeHidden = false;
			return;
		}
		const gsap = window.gsap;
		// Caught mid fade-in or mid hide: carry on from where it is on screen
		// (no collapse-and-regrow flicker) towards this message's own height.
		const from = shown && (noticeAnim === 'in' || noticeAnim === 'out') ? noticeNow() : COLLAPSED;
		const was = settleNotice();
		if (!shown || was === 'in' || was === 'out') {
			noticeHidden = false;
			noticeAnim = 'in';
			await tick();
			if (seq !== noticeSeq) return; // a later show/hide took over
			gsap.from(noticeEl, {
				...from,
				duration: 0.35,
				ease: 'power2.out',
				clearProps: 'all',
				onComplete() {
					noticeAnim = '';
				}
			});
		} else if (same) {
			// gentle shake to re-acknowledge repeat submits
			noticeAnim = 'shake';
			gsap.to(noticeEl, {
				keyframes: [{ x: -4 }, { x: 4 }, { x: -2 }, { x: 2 }, { x: 0 }],
				duration: 0.4,
				ease: 'power2.out',
				onComplete() {
					noticeAnim = '';
					gsap.set(noticeEl, { clearProps: 'all' }); // keyframe tweens ignore clearProps
				}
			});
		}
	}

	/**
	 * A failed action: message, plus aria-invalid + focus on the field at fault.
	 * No field at fault: focus goes back to `button` (the busy submit that
	 * dropped it) — never to <body>.
	 */
	async function fail(error, fieldIds = {}, opts = {}, button = null) {
		showNotice(error.message, 'error', opts);
		invalid = (error.field && fieldIds[error.field]) || '';
		await tick();
		if (invalid) document.getElementById(invalid)?.focus();
		else focusIfLost(button);
	}

	async function onLoginSubmit(e) {
		e.preventDefault();
		if (busy) return;
		const button = submitterOf(e);
		busy = 'login';
		invalid = '';
		const tried = loginEmail;
		const r = await login(tried, loginPassword);
		busy = '';
		// COOKIES_BLOCKED lands here too: the password was right but the session
		// cookie didn't stick, so say so and stay (never "Welcome back" + a bounce).
		if (!r.ok) return fail(r.error, { email: 'wf-login-email', password: 'wf-login-password' }, r.error.code === 'UNVERIFIED' ? { resend: tried, lead: '' } : {}, button);
		loginPassword = '';
		showNotice('Welcome back! Taking you to your account…', 'ok');
		goto(next, { replaceState: true });
	}

	async function onSignupSubmit(e) {
		e.preventDefault();
		if (busy) return;
		const button = submitterOf(e);
		busy = 'signup';
		invalid = '';
		const r = await signup({ name: signupName, email: signupEmail, password: signupPassword });
		busy = '';
		if (!r.ok) return fail(r.error, { name: 'wf-signup-name', email: 'wf-signup-email', password: 'wf-signup-password' }, {}, button);
		signupPassword = '';
		loginEmail = r.email;
		swap('login');
		showNotice(`Check your email — we sent a link to ${r.email} to confirm your account.`, 'ok', { resend: r.email, lead: 'Didn’t get it?' });
		// The sign-up panel (and its disabled button) is on its way out: focus the
		// Log In tab now selected (always visible, unlike the fading panels); the
		// notice above is read out, and Tab carries on into the prefilled form.
		await tick();
		focusIfLost(tabLoginEl, { within: [panelSignupEl] });
	}

	/** "Send the link again": neutral copy whatever the answer (no account probing). */
	async function onResend() {
		if (busy || !resendEmail) return;
		const email = resendEmail;
		const lead = resendLead;
		busy = 'resend';
		const r = await resendVerification(email);
		busy = '';
		if (r.ok) {
			showNotice(MESSAGES.RESEND_SENT, 'ok');
			await tick(); // the button is gone: carry focus on to the next step
			document.getElementById('wf-login-password')?.focus();
			return;
		}
		// Offline / server trouble: keep the action to try again; a rate limit won't clear by tapping.
		const again = r.error.code === 'RATE_LIMITED' || r.error.code === 'EMAIL_INVALID' ? {} : { resend: email, lead };
		showNotice(r.error.message, 'error', again);
		await tick(); // back on the (re-enabled) action, or on to the next step when it's gone
		focusIfLost(document.querySelector('[data-wf-resend-verification]') ?? document.getElementById('wf-login-password'));
	}

	async function onForgotSubmit(e) {
		e.preventDefault();
		if (busy) return;
		const button = submitterOf(e);
		busy = 'forgot';
		invalid = '';
		const r = await forgotPassword(forgotEmail);
		busy = '';
		if (!r.ok) return fail(r.error, { email: 'wf-forgot-email' }, {}, button);
		showNotice(`If there’s an account for ${r.email}, a reset link is on its way. It works for one hour.`, 'ok');
		await tick();
		focusIfLost(button);
	}

	function openForgot() {
		if (!forgotEmail && loginEmail) forgotEmail = loginEmail;
		hideNotice();
		swap('forgot', { shown: () => document.getElementById('wf-forgot-email')?.focus() });
	}

	function backToLogin() {
		if (!loginEmail && forgotEmail) loginEmail = forgotEmail;
		hideNotice();
		swap('login', { shown: () => document.getElementById('wf-login-email')?.focus() });
	}

	/**
	 * Confirm the email with the ?verify token. Used or expired
	 * (VERIFY_INVALID) is final, so the kept token goes; anything else
	 * (offline, timeout, rate limit, server trouble) keeps it and offers
	 * "Try again". `button`: the "Try again" tapped — the notice stays while
	 * it works, and focus comes back to it (or moves on to the form).
	 */
	async function runVerify(token, button = null) {
		verifyToken = token;
		verifying = true;
		if (!button) showNotice('Confirming your email…', 'ok');
		const r = await verifyEmail(token);
		verifying = false;
		const final = r.ok || r.error.code === 'VERIFY_INVALID';
		if (final) {
			dropLinkToken('verify');
			verifyToken = '';
		}
		if (r.ok) showNotice('Email verified — log in', 'ok');
		else showNotice(r.error.message, 'error', final ? {} : { retry: true });
		if (!button) return;
		await tick();
		focusIfLost(document.querySelector('[data-wf-verify-retry]') ?? document.getElementById('wf-login-email'));
	}

	function onVerifyRetry(e) {
		if (verifying || !verifyToken) return;
		runVerify(verifyToken, e.currentTarget);
	}

	/** Drop one-shot params (tokens above all) from the address bar. */
	function stripParams(names) {
		const url = new URL(page.url);
		let changed = false;
		for (const n of names) {
			if (url.searchParams.has(n)) {
				url.searchParams.delete(n);
				changed = true;
			}
		}
		if (!changed) return;
		try {
			replaceState(url, page.state);
		} catch (e) {
			history.replaceState(history.state, '', url);
		}
	}

	onMount(() => {
		mounted = true;
		const q = page.url.searchParams;
		next = safeNext(q.get('next'));
		const verify = q.get('verify');
		/* One-shot links that ask to stay on /login even when signed in
		   (storefront-account.md §2: "Already logged in (and none of the
		   above) → goto(next)"): /reset-password's "Get a new reset link"
		   (?forgot=1) — /account has no password change — and the notice
		   after a reset (?reset=1). */
		const stay = q.get('forgot') === '1' || q.get('reset') === '1';
		if (q.get('forgot') === '1') swap('forgot', { instant: true });
		else if (q.get('signup') === '1') swap('signup', { instant: true });
		stripParams(['verify', 'reset', 'session', 'forgot', 'signup']);

		if (verify !== null) {
			keepLinkToken('verify', verify); // until it has worked (a malformed one is never kept)
			runVerify(verify);
			return;
		}
		// Reloaded before the verify link had its answer: carry on with it.
		const kept = wasReloaded() ? keptLinkToken('verify') : null;
		if (kept) {
			runVerify(kept);
			return;
		}
		if (q.get('reset') === '1') showNotice('Password updated — log in with your new password.', 'ok');
		if (q.get('session') === 'expired') {
			// Sent here because a request was refused: never bounce straight back (no loops).
			showNotice('Your session has ended — please log in again.', 'error');
			return;
		}

		// Already logged in (e.g. the account icon before the nav knew): go on —
		// unless a one-shot link asked to stay. The check still runs, so the nav
		// learns about the session either way. A stale answer (a login finished
		// while it was out) is left to that login, which already moved on.
		refresh().then((r) => {
			if (r.ok && r.user && !r.stale && !busy && !stay) goto(next, { replaceState: true });
		});
	});
</script>

<svelte:head>
	<title>Wefeasto — Log In</title>
	<meta name="referrer" content="no-referrer">
</svelte:head>

<div class="page-wrapper">
  <div class="section">
    <div class="container">
      <div class="wf-login-outer">
        <div class="wf-reveal">
          <div class="wf-login-card">
            <a href="/" class="wf-login-brand" aria-label="Wefeasto home"><img src="/images/wefeasto/logo.png" alt="Wefeasto" class="wf-brand-logo"></a>
            <div class="divider _24px"></div>
            <div class="wf-seg" role="tablist" aria-label="Log in or sign up">
              <button type="button" class="wf-seg-btn{signupActive ? '' : ' wf-is-active'}" id="wf-tab-login" role="tab" aria-selected={signupActive ? 'false' : 'true'} aria-controls="wf-panel-login" tabindex={signupActive ? -1 : undefined} bind:this={tabLoginEl} onclick={() => onTab(false)} onkeydown={(e) => onTabKeydown(e, 'login')}>Log In</button>
              <button type="button" class="wf-seg-btn{signupActive ? ' wf-is-active' : ''}" id="wf-tab-signup" role="tab" aria-selected={signupActive ? 'true' : 'false'} aria-controls="wf-panel-signup" tabindex={signupActive ? undefined : -1} bind:this={tabSignupEl} onclick={() => onTab(true)} onkeydown={(e) => onTabKeydown(e, 'signup')}>Sign Up</button>
            </div>
            <div class="divider _24px"></div>
            <div class="wf-auth-notice{noticeTone === 'ok' ? ' wf-is-ok' : ''}" id="wf-auth-notice" role="status" aria-live="polite" hidden={noticeHidden} bind:this={noticeEl}>{#key noticeKey}<span>{noticeText}</span>{/key}</div>
            {#if resendEmail && !noticeHidden}
            <p class="wf-auth-resend" data-wf-resend>{#if resendLead}<span>{resendLead}</span>{' '}{/if}<button type="button" class="wf-auth-small wf-auth-link" data-wf-resend-verification disabled={busy === 'resend'} aria-busy={busy === 'resend'} onclick={onResend}>{#if busy === 'resend'}<Spinner /> Sending…{:else}Send the link again{/if}</button></p>
            {/if}
            {#if verifyRetry && !noticeHidden}
            <p class="wf-auth-resend" data-wf-verify-retry-row><button type="button" class="wf-auth-small wf-auth-link" data-wf-verify-retry disabled={verifying} aria-busy={verifying} onclick={onVerifyRetry}>{#if verifying}<Spinner /> Trying again…{:else}Try again{/if}</button></p>
            {/if}
            <div class="wf-auth-panels" id="wf-auth-panels" bind:this={panelsWrapEl}>
              <div class="wf-auth-panel" id="wf-panel-login" role="tabpanel" aria-labelledby="wf-tab-login" bind:this={panelLoginEl}>
                <form id="wf-login-form" method="post" novalidate onsubmit={onLoginSubmit}>
                <noscript><p class="wf-auth-lead">Logging in needs JavaScript — please turn it on to continue.</p></noscript>
                <div class="wf-field"><label class="wf-label" for="wf-login-email">Email</label><input class="wf-input" type="email" id="wf-login-email" name="email" placeholder="you@example.com" autocomplete="email" bind:value={loginEmail} aria-invalid={invalid === 'wf-login-email' || undefined} aria-describedby={invalid === 'wf-login-email' ? 'wf-auth-notice' : undefined}></div>
                <div class="wf-field"><label class="wf-label" for="wf-login-password">Password</label><input class="wf-input" type="password" id="wf-login-password" name="password" placeholder="••••••••" autocomplete="current-password" bind:value={loginPassword} aria-invalid={invalid === 'wf-login-password' || undefined} aria-describedby={invalid === 'wf-login-password' ? 'wf-auth-notice' : undefined}></div>
                <div class="wf-auth-row"><button type="button" class="wf-auth-small wf-auth-link" data-wf-forgot onclick={openForgot}>Forgot password?</button></div>
                <button type="submit" class="button wf-btn-full" disabled={!mounted || busy === 'login'} aria-busy={busy === 'login'}>{#if busy === 'login'}<Spinner /> Logging in…{:else}Log In{/if}</button>
                </form>
              </div>
              <div class="wf-auth-panel" id="wf-panel-forgot" role="tabpanel" aria-labelledby="wf-tab-login" hidden bind:this={panelForgotEl}>
                <form id="wf-forgot-form" method="post" novalidate onsubmit={onForgotSubmit}>
                <p class="wf-auth-lead">Forgot your password? Enter your email and we’ll send you a link to choose a new one.</p>
                <div class="wf-field"><label class="wf-label" for="wf-forgot-email">Email</label><input class="wf-input" type="email" id="wf-forgot-email" name="email" placeholder="you@example.com" autocomplete="email" bind:value={forgotEmail} aria-invalid={invalid === 'wf-forgot-email' || undefined} aria-describedby={invalid === 'wf-forgot-email' ? 'wf-auth-notice' : undefined}></div>
                <button type="submit" class="button wf-btn-full" disabled={!mounted || busy === 'forgot'} aria-busy={busy === 'forgot'}>{#if busy === 'forgot'}<Spinner /> Sending…{:else}Send reset link{/if}</button>
                <div class="wf-auth-row wf-auth-row-center"><button type="button" class="wf-auth-small wf-auth-link" data-wf-back-to-login onclick={backToLogin}>Back to log in</button></div>
                </form>
              </div>
              <div class="wf-auth-panel" id="wf-panel-signup" role="tabpanel" aria-labelledby="wf-tab-signup" hidden bind:this={panelSignupEl}>
                <form id="wf-signup-form" method="post" novalidate onsubmit={onSignupSubmit}>
                <div class="wf-field"><label class="wf-label" for="wf-signup-name">Name</label><input class="wf-input" type="text" id="wf-signup-name" name="name" placeholder="Your name" autocomplete="name" maxlength="100" bind:value={signupName} aria-invalid={invalid === 'wf-signup-name' || undefined} aria-describedby={invalid === 'wf-signup-name' ? 'wf-auth-notice' : undefined}></div>
                <div class="wf-field"><label class="wf-label" for="wf-signup-email">Email</label><input class="wf-input" type="email" id="wf-signup-email" name="email" placeholder="you@example.com" autocomplete="email" bind:value={signupEmail} aria-invalid={invalid === 'wf-signup-email' || undefined} aria-describedby={invalid === 'wf-signup-email' ? 'wf-auth-notice' : undefined}></div>
                <div class="wf-field"><label class="wf-label" for="wf-signup-password">Password</label><input class="wf-input" type="password" id="wf-signup-password" name="password" placeholder="Choose a password" autocomplete="new-password" minlength={PASSWORD_MIN} bind:value={signupPassword} aria-invalid={invalid === 'wf-signup-password' || undefined} aria-describedby={invalid === 'wf-signup-password' ? 'wf-auth-notice wf-signup-password-hint' : 'wf-signup-password-hint'}><p class="wf-form-note wf-auth-hint" id="wf-signup-password-hint">At least {PASSWORD_MIN} characters.</p></div>
                <div class="divider _8px"></div>
                <button type="submit" class="button wf-btn-full" disabled={!mounted || busy === 'signup'} aria-busy={busy === 'signup'}>{#if busy === 'signup'}<Spinner /> Creating your account…{:else}Create Account{/if}</button>
                </form>
              </div>
            </div>
            {#if GOOGLE_AUTH}
            <div class="wf-or"><span>or</span></div>
            <a href="/login" class="button secondary wf-btn-full wf-google w-inline-block"><div>Continue with Google</div></a>
            {/if}
          </div>
        </div>
        <p class="wf-auth-terms">By continuing you agree to our <a href="/terms">Terms</a> &amp; <a href="/privacy">Privacy Policy</a>.</p>
      </div>
    </div>
  </div>
</div>
