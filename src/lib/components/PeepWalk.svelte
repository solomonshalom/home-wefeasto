<script module>
	/*
	 * The visitor's "pause the crowd" choice (WCAG 2.2.2 Pause, Stop, Hide):
	 * one switch for every crowd (the layout strip and /order's), kept in
	 * localStorage so a paused crowd stays paused on the next page and visit.
	 * Storage can throw (private mode, blocked site data): the choice then
	 * lasts for this page view only.
	 */
	export const PEEPS_PAUSED_KEY = 'wefeasto_peeps_paused';
	export const peepPause = $state({ paused: false });
	let pauseLoaded = false;

	function loadPeepPause() {
		if (pauseLoaded) return;
		pauseLoaded = true;
		try {
			peepPause.paused = window.localStorage.getItem(PEEPS_PAUSED_KEY) === '1';
		} catch (e) {
			/* storage unavailable: not paused */
		}
	}

	export function setPeepsPaused(paused) {
		pauseLoaded = true;
		peepPause.paused = !!paused;
		try {
			if (paused) window.localStorage.setItem(PEEPS_PAUSED_KEY, '1');
			else window.localStorage.removeItem(PEEPS_PAUSED_KEY);
		} catch (e) {
			/* storage unavailable: this page view only */
		}
	}
</script>

<script>
	/*
	 * PeepWalk: a crowd of hand-drawn "Open Peeps" strolling across a canvas.
	 *
	 * A 1:1 port of bublr/src/components/PeepWalk.js (itself based on "Crowd
	 * Simulator" by Szenia Zadvornykh, https://codepen.io/zadvorsky/pen/xxwbBQV,
	 * public CodePen code, MIT licence). Artwork: Open Peeps by Pablo Stanley,
	 * https://www.openpeeps.com (CC0); the sprite sheet is bublr's
	 * characters.png, byte for byte (see static/images/peeps/CREDITS.txt) —
	 * the same file, so Chrome decodes the very same pixels.
	 *
	 * Same crowd, same look, same motion as bublr: all 105 peeps from the
	 * 15 x 7 sheet at their native 240 x 324 px, the full devicePixelRatio,
	 * the same GSAP walk (10s across the stage at a random 0.5-1.5x time
	 * scale, a 10px bob every 0.25s), the same power2.in depth skew, the same
	 * back-to-front draw order, and the same Math.random call order — frames
	 * are pixel-identical to bublr's for the same random sequence and clock
	 * (verified side by side). Default size is bublr's 350px x 100%.
	 *
	 * What is added around that (none of it changes a visible frame):
	 * - Cleanup: bublr returned its cleanup from inside import('gsap').then(),
	 *   so React never ran it (crowds kept walking after unmount). Here every
	 *   timeline, ticker listener and observer goes on destroy.
	 * - Runs on the storefront's global window.gsap (one ticker, shared with
	 *   Lenis); GSAP is never bundled from npm.
	 * - The sheet loads when the strip comes within 300px of the viewport.
	 * - Off screen, in a hidden tab, or paused by the visitor, the walks and the
	 *   render loop are paused (fx.js disables GSAP lag smoothing, so a
	 *   background tab would otherwise fast-forward the whole crowd).
	 * - prefers-reduced-motion, ?nofx=1 or no GSAP: one still frame of the crowd.
	 * - A small pause/play control (WCAG 2.2.2) whenever the crowd walks.
	 * - Runtime-only attributes (never in the prerendered HTML): data-mode
	 *   ("still" | "live" | "paused"), data-ready once drawn, data-failed if the
	 *   sheet could not load.
	 */
	import { onMount, untrack } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { noMotion, refreshNofx } from '$lib/fx.js';

	let {
		height = undefined, // CSS length; default 350px comes from CSS (--peepwalk-h)
		width = undefined, // CSS length; default 100% comes from CSS
		src = '/images/peeps/characters.png', // bublr's characters.png, byte for byte
		class: className = ''
	} = $props();

	let canvas;
	/** The crowd walks here (motion allowed, sheet drawn): offer the pause button. */
	let canPause = $state(false);
	let applyPause = () => {};
	$effect(() => {
		const paused = peepPause.paused;
		untrack(() => applyPause(paused));
	});

	// ?nofx=1 is per-URL: re-check the mode after client-side navigations.
	let recheckMode = () => {};
	afterNavigate((nav) => {
		if (nav.type !== 'enter') recheckMode();
	});

	onMount(() => {
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const gsap = window.gsap; // loaded globally in app.html
		const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');

		// bublr's config (its names: `rows` is the count across, `cols` down).
		const config = {
			rows: 15,
			cols: 7
		};

		// UTILS (bublr)
		const randomRange = (min, max) => min + Math.random() * (max - min);
		const randomIndex = (array) => randomRange(0, array.length) | 0;
		const removeFromArray = (array, i) => array.splice(i, 1)[0];
		const removeItemFromArray = (array, item) => removeFromArray(array, array.indexOf(item));
		const removeRandomFromArray = (array) => removeFromArray(array, randomIndex(array));
		const getRandomFromArray = (array) => array[randomIndex(array) | 0];

		// CLASSES (bublr)
		class Peep {
			constructor({ image, rect }) {
				this.image = image;
				this.setRect(rect);

				this.x = 0;
				this.y = 0;
				this.anchorY = 0;
				this.scaleX = 1;
				this.walk = null;
			}

			setRect(rect) {
				this.rect = rect;
				this.width = rect[2];
				this.height = rect[3];

				this.drawArgs = [this.image, ...rect, 0, 0, this.width, this.height];
			}

			render(ctx) {
				ctx.save();
				ctx.translate(this.x, this.y);
				ctx.scale(this.scaleX, 1);
				ctx.drawImage(...this.drawArgs);
				ctx.restore();
			}
		}

		const stage = {
			width: 0,
			height: 0
		};

		const allPeeps = [];
		const availablePeeps = [];
		const crowd = [];

		// gsap 'power2.in' (cubic); inlined only for the still frame without GSAP.
		const power2In = gsap ? gsap.parseEase('power2.in') : (t) => t * t * t;

		// TWEEN FACTORIES (bublr)
		const resetPeep = ({ stage, peep }) => {
			const direction = Math.random() > 0.5 ? 1 : -1;
			// using an ease function to skew random to lower values to help hide that peeps have no legs
			const offsetY = 100 - 250 * power2In(Math.random());
			// Ensure characters are never cut off at the top (min 10 to account for walk bounce animation)
			const startY = Math.max(10, stage.height - peep.height + offsetY);
			let startX;
			let endX;

			if (direction === 1) {
				startX = -peep.width;
				endX = stage.width;
				peep.scaleX = 1;
			} else {
				startX = stage.width + peep.width;
				endX = 0;
				peep.scaleX = -1;
			}

			peep.x = startX;
			peep.y = startY;
			peep.anchorY = startY;

			return {
				startX,
				startY,
				endX
			};
		};

		const normalWalk = ({ peep, props }) => {
			const { startX, startY, endX } = props;

			const xDuration = 10;
			const yDuration = 0.25;

			const tl = gsap.timeline();
			tl.timeScale(randomRange(0.5, 1.5));
			tl.to(
				peep,
				{
					duration: xDuration,
					x: endX,
					ease: 'none'
				},
				0
			);
			tl.to(
				peep,
				{
					duration: yDuration,
					repeat: xDuration / yDuration,
					yoyo: true,
					y: startY - 10
				},
				0
			);

			return tl;
		};

		const walks = [normalWalk];

		// state around bublr's loop (see header)
		let img = null;
		let isStatic = true;
		loadPeepPause();
		let userPaused = peepPause.paused;
		let visible = !('IntersectionObserver' in window); // the observer reports on its first callback
		let running = false; // render on the ticker + walks playing
		let destroyed = false;

		const wantStatic = () => noMotion() || reducedMq.matches || typeof gsap === 'undefined';
		const shouldRun = () => !isStatic && !userPaused && visible && !document.hidden;

		function setMode() {
			canvas.dataset.mode = isStatic ? 'still' : userPaused ? 'paused' : 'live';
			canPause = !isStatic && !!img;
		}

		function createPeeps() {
			const { rows, cols } = config;
			const { naturalWidth: width, naturalHeight: height } = img;
			const total = rows * cols;
			const rectWidth = width / rows;
			const rectHeight = height / cols;

			for (let i = 0; i < total; i++) {
				allPeeps.push(
					new Peep({
						image: img,
						rect: [(i % rows) * rectWidth, ((i / rows) | 0) * rectHeight, rectWidth, rectHeight]
					})
				);
			}
		}

		function resize() {
			stage.width = canvas.clientWidth;
			stage.height = canvas.clientHeight;
			canvas.width = stage.width * devicePixelRatio;
			canvas.height = stage.height * devicePixelRatio;

			crowd.forEach((peep) => {
				if (peep.walk) peep.walk.kill();
			});

			crowd.length = 0;
			availablePeeps.length = 0;
			availablePeeps.push(...allPeeps);

			if (isStatic) initStill();
			else initCrowd();
			if (img) render(); // canvas.width reset cleared it: draw now, not on the next tick
		}

		function initCrowd() {
			while (availablePeeps.length) {
				// setting random tween progress spreads the peeps out
				addPeepToCrowd().walk.progress(Math.random());
			}
			if (!shouldRun()) crowd.forEach((peep) => peep.walk.pause());
		}

		// The no-motion frame: the same crowd, frozen at random progress, no bob.
		function initStill() {
			while (availablePeeps.length) {
				const peep = removeRandomFromArray(availablePeeps);
				const { startX, endX } = resetPeep({ peep, stage });
				peep.x = startX + (endX - startX) * Math.random();
				peep.walk = null;
				crowd.push(peep);
			}
			crowd.sort((a, b) => a.anchorY - b.anchorY);
		}

		function addPeepToCrowd() {
			const peep = removeRandomFromArray(availablePeeps);
			const walk = getRandomFromArray(walks)({
				peep,
				props: resetPeep({
					peep,
					stage
				})
			}).eventCallback('onComplete', () => {
				removePeepFromCrowd(peep);
				addPeepToCrowd();
			});

			peep.walk = walk;

			crowd.push(peep);
			crowd.sort((a, b) => a.anchorY - b.anchorY);

			return peep;
		}

		function removePeepFromCrowd(peep) {
			removeItemFromArray(crowd, peep);
			availablePeeps.push(peep);
		}

		function render() {
			ctx.setTransform(1, 0, 0, 1, 0, 0); // bublr cleared with canvas.width = canvas.width
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.save();
			ctx.scale(devicePixelRatio, devicePixelRatio);

			crowd.forEach((peep) => {
				peep.render(ctx);
			});

			ctx.restore();
		}

		/* ---------- loop control (additions) ---------- */

		function update() {
			const run = shouldRun() && !!img;
			if (run === running) return;
			running = run;
			if (run) {
				crowd.forEach((peep) => peep.walk && peep.walk.resume());
				gsap.ticker.add(render);
			} else {
				if (gsap) gsap.ticker.remove(render);
				crowd.forEach((peep) => peep.walk && peep.walk.pause());
			}
		}

		function applyMode() {
			const next = wantStatic();
			if (next === isStatic) return;
			if (running) {
				running = false;
				gsap.ticker.remove(render);
			}
			isStatic = next;
			setMode();
			if (img) resize(); // rebuild the crowd for the new mode
			update();
		}

		recheckMode = () => {
			refreshNofx();
			applyMode();
		};

		applyPause = (next) => {
			if (next === userPaused) return;
			userPaused = next;
			setMode();
			update();
		};

		/* ---------- MAIN (bublr) ---------- */

		async function loadImage(url) {
			const image = new Image();
			image.src = url;
			await image.decode(); // bublr used onload; decode first so the first frame never stalls
			return image;
		}

		let loading = false;
		async function load() {
			if (loading || img || destroyed) return;
			loading = true;
			let image;
			try {
				image = await loadImage(src);
			} catch (e) {
				if (!destroyed) canvas.dataset.failed = ''; // sheet missing: a quiet, empty strip
				return;
			}
			if (destroyed) return;
			img = image;
			init();
		}

		function init() {
			createPeeps();
			resize();
			canvas.dataset.ready = '';
			setMode();
			update();
		}

		const resizeObserver = new ResizeObserver(() => {
			if (img) resize();
			else {
				stage.width = canvas.clientWidth;
				stage.height = canvas.clientHeight;
			}
		});
		resizeObserver.observe(canvas);

		// Two observers: the sheet starts loading 300px ahead of the strip; the
		// walks and the loop run only while the canvas is actually on screen.
		let nearIo = null;
		let io = null;
		if ('IntersectionObserver' in window) {
			nearIo = new IntersectionObserver(
				(entries) => {
					if (!entries[entries.length - 1].isIntersecting) return;
					nearIo.disconnect();
					load();
				},
				{ rootMargin: '300px 0px' }
			);
			nearIo.observe(canvas);
			io = new IntersectionObserver((entries) => {
				visible = entries[entries.length - 1].isIntersecting;
				update();
			});
			io.observe(canvas);
		} else {
			load();
		}

		const onVisibility = () => update();
		document.addEventListener('visibilitychange', onVisibility);
		const onReducedChange = () => applyMode();
		reducedMq.addEventListener('change', onReducedChange);

		isStatic = wantStatic();
		setMode();

		return () => {
			destroyed = true;
			if (gsap) gsap.ticker.remove(render);
			running = false;
			crowd.forEach((peep) => {
				if (peep.walk) peep.walk.kill();
			});
			crowd.length = 0;
			availablePeeps.length = 0;
			allPeeps.length = 0;
			resizeObserver.disconnect();
			if (nearIo) nearIo.disconnect();
			if (io) io.disconnect();
			document.removeEventListener('visibilitychange', onVisibility);
			reducedMq.removeEventListener('change', onReducedChange);
			img = null;
			recheckMode = () => {};
			applyPause = () => {};
		};
	});
</script>

{#if canPause}<div class="wf-peepwalk-ctl"><button type="button" class="wf-peepwalk-pause" aria-label={peepPause.paused ? 'Play animation' : 'Pause animation'} title={peepPause.paused ? 'Play animation' : 'Pause animation'} data-wf-peeps-pause onclick={() => setPeepsPaused(!peepPause.paused)}>{#if peepPause.paused}<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>{:else}<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M4 2.5h2.75v11H4zM9.25 2.5H12v11H9.25z" fill="currentColor" /></svg>{/if}</button></div>{/if}<canvas bind:this={canvas} class={['wf-peepwalk', className]} style:height style:width aria-hidden="true"></canvas>
