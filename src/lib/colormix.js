/*
 * Colour mix — Svelte port of the js/wefeasto.js palette shuffle. When enabled,
 * every stylesheet rule and inline style that uses the visible site palette is
 * re-declared (later in the cascade) with the colours traded around; the
 * original stylesheets are never touched. The chosen mapping persists in
 * localStorage `wefeasto_colormix` — the same key the static site uses — so
 * every page shows the same shuffle until the toggle is turned off.
 */

export const COLORMIX_KEY = 'wefeasto_colormix';

// The palette that is actually visible on the site, straight out of
// webflow.css / wefeasto.css and the data-driven chip colours. Two independent
// shuffle rings keep every pairing readable: saturated accents only trade
// places with accents, pale surfaces with surfaces — the #333 text that sits
// on all of them never moves.
const MIX_RINGS = [
	['#ff8d5e', '#ffc33a', '#d499eb', '#2cdb69'], // coral, yellow, plum, lime
	['#f9f4ef', '#fff6e7', '#ffdede', '#fffdfa'] // seashell, tag cream, form pink, card white
];
// Tints the template derives from the yellow by mixing towards white
// (button hover, lined-button fill). They follow wherever the yellow lands.
const MIX_SHADES = { '#ffce60': ['#ffc33a', 0.19], '#fff3d8': ['#ffc33a', 0.8] };
// Off-by-one spelling of plum used by some chip data.
const MIX_ALIASES = { '#d498eb': '#d499eb' };

function clamp255(n) {
	return Math.max(0, Math.min(255, Math.round(n)));
}

function hexPair(n) {
	const s = n.toString(16);
	return s.length === 1 ? '0' + s : s;
}

function rgbKey(r, g, b) {
	return r + ',' + g + ',' + b;
}

function parseHex(hex) {
	let h = String(hex).slice(1);
	if (h.length === 3 || h.length === 4) {
		h = h
			.split('')
			.map((c) => c + c)
			.join('');
	}
	if (h.length !== 6 && h.length !== 8) return null;
	const n = parseInt(h.slice(0, 6), 16);
	if (isNaN(n)) return null;
	return {
		r: n >> 16,
		g: (n >> 8) & 255,
		b: n & 255,
		a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
	};
}

// Every colour token that can appear in serialized css or a style attribute.
const COLOR_TOKEN_RE =
	/#[0-9a-f]{3,8}\b|rgba?\(\s*\d+(?:\.\d+)?\s*[, ]\s*\d+(?:\.\d+)?\s*[, ]\s*\d+(?:\.\d+)?\s*(?:[,/]\s*[\d.]+%?\s*)?\)/gi;

function parseColorToken(tok) {
	if (tok.charAt(0) === '#') return parseHex(tok.toLowerCase());
	const nums = tok.match(/[\d.]+%?/g);
	if (!nums || nums.length < 3) return null;
	let a = 1;
	if (nums.length > 3) {
		a = parseFloat(nums[3]);
		if (nums[3].indexOf('%') > -1) a /= 100;
	}
	return {
		r: clamp255(parseFloat(nums[0])),
		g: clamp255(parseFloat(nums[1])),
		b: clamp255(parseFloat(nums[2])),
		a
	};
}

// Rewrites palette colours in a css/style string, keeping each token's alpha.
function swapColors(text, lookup) {
	return String(text).replace(COLOR_TOKEN_RE, (tok) => {
		const c = parseColorToken(tok);
		if (!c) return tok;
		const hit = lookup[rgbKey(c.r, c.g, c.b)];
		if (!hit) return tok;
		if (c.a >= 1) return hit.hex;
		return 'rgba(' + hit.rgb[0] + ', ' + hit.rgb[1] + ', ' + hit.rgb[2] + ', ' + +c.a.toFixed(3) + ')';
	});
}

function colorMixLookup(map) {
	const lookup = {};
	for (const from of Object.keys(map)) {
		const f = parseHex(from);
		const t = parseHex(map[from]);
		if (f && t) lookup[rgbKey(f.r, f.g, f.b)] = { hex: map[from], rgb: [t.r, t.g, t.b] };
	}
	return lookup;
}

// Fisher–Yates until no colour keeps its old spot, so "on" always looks on.
function derange(list) {
	const moved = (c, k) => c !== list[k];
	let out;
	let tries = 0;
	do {
		out = list.slice();
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const tmp = out[i];
			out[i] = out[j];
			out[j] = tmp;
		}
		tries++;
	} while (tries < 40 && !out.every(moved));
	if (!out.every(moved)) out = list.slice(1).concat(list[0]);
	return out;
}

/** Deal a fresh random palette mapping (each call reshuffles). */
export function buildColorMixMap() {
	const map = {};
	for (const ring of MIX_RINGS) {
		const shuffled = derange(ring);
		ring.forEach((c, i) => {
			map[c] = shuffled[i];
		});
	}
	for (const shade of Object.keys(MIX_SHADES)) {
		const to = parseHex(map[MIX_SHADES[shade][0]]);
		const t = MIX_SHADES[shade][1];
		map[shade] =
			'#' +
			hexPair(clamp255(to.r + (255 - to.r) * t)) +
			hexPair(clamp255(to.g + (255 - to.g) * t)) +
			hexPair(clamp255(to.b + (255 - to.b) * t));
	}
	for (const alias of Object.keys(MIX_ALIASES)) {
		map[alias] = map[MIX_ALIASES[alias]];
	}
	return map;
}

/** The stored mapping, or null when the toggle is off / the value is invalid. */
export function readColorMixMap() {
	try {
		const raw = window.localStorage.getItem(COLORMIX_KEY);
		if (!raw) return null;
		const map = (JSON.parse(raw) || {}).map;
		if (!map || typeof map !== 'object') return null;
		const keys = Object.keys(map);
		const valid =
			keys.length &&
			keys.every(
				(k) =>
					k.charAt(0) === '#' &&
					parseHex(k) &&
					typeof map[k] === 'string' &&
					map[k].charAt(0) === '#' &&
					parseHex(map[k])
			);
		return valid ? map : null;
	} catch (e) {
		return null;
	}
}

export function storeColorMixMap(map) {
	try {
		window.localStorage.setItem(COLORMIX_KEY, JSON.stringify({ v: 1, map }));
	} catch (e) {
		/* private mode etc. — the shuffle just won't persist */
	}
}

export function clearColorMixMap() {
	try {
		window.localStorage.removeItem(COLORMIX_KEY);
	} catch (e) {
		/* noop */
	}
}

/** Remove the override stylesheet and restore rewritten inline styles. */
export function removeColorMix() {
	const styleEl = document.getElementById('wf-colormix-style');
	if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
	for (const el of document.querySelectorAll('[data-wf-colormix-orig]')) {
		el.setAttribute('style', el.getAttribute('data-wf-colormix-orig'));
		el.removeAttribute('data-wf-colormix-orig');
	}
}

/**
 * Apply a mapping to the current document. Idempotent — call it again after a
 * client-side navigation so freshly rendered rules/inline styles get remapped.
 */
export function applyColorMix(map) {
	removeColorMix();
	const lookup = colorMixLookup(map);
	const overrides = [];

	// Re-declare, later in the cascade, every rule that mentions a palette
	// colour — the shipped stylesheets are never touched.
	function collect(rules, wrap) {
		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			try {
				if (rule.styleSheet) {
					collect(rule.styleSheet.cssRules, wrap); // @import
					continue;
				}
				if (rule.cssRules && (rule.conditionText !== undefined || rule.media)) {
					// @media / @supports
					const head =
						(rule.type === 12 ? '@supports ' : '@media ') +
						(rule.conditionText || (rule.media && rule.media.mediaText) || 'all');
					collect(rule.cssRules, head);
					continue;
				}
				const css = rule.cssText;
				if (!css) continue;
				const next = swapColors(css, lookup);
				if (next !== css) overrides.push(wrap ? wrap + ' {\n' + next + '\n}' : next);
			} catch (e) {
				/* unreadable rule/sheet — skip */
			}
		}
	}

	for (const sheet of Array.from(document.styleSheets)) {
		try {
			collect(sheet.cssRules, '');
		} catch (e) {
			/* cross-origin — skip */
		}
	}

	const styleEl = document.createElement('style');
	styleEl.id = 'wf-colormix-style';
	styleEl.textContent = overrides.join('\n');
	document.head.appendChild(styleEl);

	// Rendered markup carries palette colours inline (category chips, recipe
	// tags, icon dots from tagColor/iconColor data) — rewrite those too,
	// remembering the original.
	for (const el of document.querySelectorAll('[style]')) {
		if (el.id === 'wf-veil') continue;
		const css = el.getAttribute('style');
		const next = swapColors(css, lookup);
		if (next !== css) {
			if (!el.hasAttribute('data-wf-colormix-orig')) el.setAttribute('data-wf-colormix-orig', css);
			el.setAttribute('style', next);
		}
	}
}

/** Keep the page-transition veil on the (possibly remapped) page background. */
export function syncVeilColor(map) {
	const veil = document.getElementById('wf-veil');
	if (veil) veil.style.background = (map && map['#f9f4ef']) || '#f9f4ef';
}
