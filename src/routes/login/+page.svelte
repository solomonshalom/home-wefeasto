<script>
	/* Non-functional auth prototype — port of the login.html page script
	   (panel swap + prototype notice with the same GSAP choreography). */
	import { onMount } from 'svelte';

	let tabLoginEl, tabSignupEl, panelLoginEl, panelSignupEl, panelsWrapEl, noticeEl;

	let signupActive = $state(false);
	let noticeHidden = $state(true);

	let animating = false;
	let noticeTimer = null;
	let reduceMotion = false;

	function gsapOK() {
		return typeof window.gsap !== 'undefined' && !reduceMotion;
	}

	function swap(toSignup) {
		const incoming = toSignup ? panelSignupEl : panelLoginEl;
		const outgoing = toSignup ? panelLoginEl : panelSignupEl;
		if (animating || !incoming.hidden) return;
		signupActive = toSignup;

		if (!gsapOK()) {
			outgoing.hidden = true;
			incoming.hidden = false;
			return;
		}

		animating = true;
		const gsap = window.gsap;
		const dir = toSignup ? 1 : -1;
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
					}
				});
			}
		});
	}

	function onTabKeydown(e, tab) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		const other = tab === 'login' ? tabSignupEl : tabLoginEl;
		other.focus();
		swap(other === tabSignupEl);
	}

	function hideNotice() {
		if (noticeEl.hidden) return;
		if (!gsapOK()) {
			noticeHidden = true;
			return;
		}
		window.gsap.to(noticeEl, {
			height: 0,
			marginBottom: 0,
			paddingTop: 0,
			paddingBottom: 0,
			autoAlpha: 0,
			duration: 0.3,
			ease: 'power2.in',
			onComplete() {
				noticeHidden = true;
				window.gsap.set(noticeEl, { clearProps: 'all' });
			}
		});
	}

	function showNotice() {
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(hideNotice, 3000);
		if (!gsapOK()) {
			noticeHidden = false;
			return;
		}
		const gsap = window.gsap;
		gsap.killTweensOf(noticeEl);
		if (noticeEl.hidden) {
			noticeHidden = false;
			gsap.set(noticeEl, { clearProps: 'all' });
			gsap.from(noticeEl, {
				height: 0,
				marginBottom: 0,
				paddingTop: 0,
				paddingBottom: 0,
				y: 10,
				autoAlpha: 0,
				duration: 0.35,
				ease: 'power2.out',
				clearProps: 'all'
			});
		} else {
			gsap.set(noticeEl, { clearProps: 'all' });
			// gentle shake to re-acknowledge repeat submits
			gsap.to(noticeEl, { keyframes: [{ x: -4 }, { x: 4 }, { x: -2 }, { x: 2 }, { x: 0 }], duration: 0.4, ease: 'power2.out' });
		}
	}

	function onPanelSubmit(e) {
		e.preventDefault();
		showNotice();
	}

	function onGoogleClick(e) {
		e.preventDefault();
		showNotice();
	}

	onMount(() => {
		reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		return () => {
			if (noticeTimer) clearTimeout(noticeTimer);
		};
	});
</script>

<svelte:head>
	<title>Wefeasto — Log In</title>
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
              <button type="button" class="wf-seg-btn{signupActive ? '' : ' wf-is-active'}" id="wf-tab-login" role="tab" aria-selected={signupActive ? 'false' : 'true'} aria-controls="wf-panel-login" tabindex={signupActive ? -1 : undefined} bind:this={tabLoginEl} onclick={() => swap(false)} onkeydown={(e) => onTabKeydown(e, 'login')}>Log In</button>
              <button type="button" class="wf-seg-btn{signupActive ? ' wf-is-active' : ''}" id="wf-tab-signup" role="tab" aria-selected={signupActive ? 'true' : 'false'} aria-controls="wf-panel-signup" tabindex={signupActive ? undefined : -1} bind:this={tabSignupEl} onclick={() => swap(true)} onkeydown={(e) => onTabKeydown(e, 'signup')}>Sign Up</button>
            </div>
            <div class="divider _24px"></div>
            <div class="wf-auth-notice" id="wf-auth-notice" role="status" aria-live="polite" hidden={noticeHidden} bind:this={noticeEl}>Prototype only — accounts arrive in Phase 2 ✨</div>
            <div class="wf-auth-panels" id="wf-auth-panels" bind:this={panelsWrapEl}>
              <form class="wf-auth-panel" id="wf-panel-login" role="tabpanel" aria-labelledby="wf-tab-login" novalidate bind:this={panelLoginEl} onsubmit={onPanelSubmit}>
                <div class="wf-field"><label class="wf-label" for="wf-login-email">Email</label><input class="wf-input" type="email" id="wf-login-email" name="email" placeholder="you@example.com" autocomplete="email"></div>
                <div class="wf-field"><label class="wf-label" for="wf-login-password">Password</label><input class="wf-input" type="password" id="wf-login-password" name="password" placeholder="••••••••" autocomplete="current-password"></div>
                <div class="wf-auth-row"><a href="#" class="wf-auth-small" onclick={(e) => { e.preventDefault(); window.scrollTo(0, 0); }}>Forgot password?</a></div>
                <button type="submit" class="button wf-btn-full">Log In</button>
              </form>
              <form class="wf-auth-panel" id="wf-panel-signup" role="tabpanel" aria-labelledby="wf-tab-signup" novalidate hidden bind:this={panelSignupEl} onsubmit={onPanelSubmit}>
                <div class="wf-field"><label class="wf-label" for="wf-signup-name">Name</label><input class="wf-input" type="text" id="wf-signup-name" name="name" placeholder="Your name" autocomplete="name"></div>
                <div class="wf-field"><label class="wf-label" for="wf-signup-email">Email</label><input class="wf-input" type="email" id="wf-signup-email" name="email" placeholder="you@example.com" autocomplete="email"></div>
                <div class="wf-field"><label class="wf-label" for="wf-signup-password">Password</label><input class="wf-input" type="password" id="wf-signup-password" name="password" placeholder="Choose a password" autocomplete="new-password"></div>
                <div class="divider _8px"></div>
                <button type="submit" class="button wf-btn-full">Create Account</button>
              </form>
            </div>
            <div class="wf-or"><span>or</span></div>
            <a href="#" class="button secondary wf-btn-full wf-google w-inline-block" onclick={onGoogleClick}><div>Continue with Google</div></a>
          </div>
        </div>
        <p class="wf-auth-terms">By continuing you agree to our <a href="/terms">Terms</a> &amp; <a href="/privacy">Privacy Policy</a>.</p>
      </div>
    </div>
  </div>
</div>
