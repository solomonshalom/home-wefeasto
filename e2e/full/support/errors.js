/*
 * Collects uncaught page errors and console.error messages from every page of the
 * contexts it watches. The `consoleErrors` fixture fails a test that otherwise passed
 * when anything unexpected was collected.
 *
 * Allowed by default: "Failed to load resource: … status of 4xx/5xx" for /api/* requests —
 * expected API refusals the pages handle (404 order lookups, 409 checkout conflicts, 401
 * for signed-out sessions, …). Anything else counts, including a failed static asset.
 * Allow more per test with `consoleErrors.allow(/pattern/)` (matched against
 * "<text> (<url>)"), or opt out with `test.use({ failOnConsoleErrors: false })`.
 */
export class ConsoleErrors {
	constructor() {
		this.errors = [];
		this.allowed = [];
		this.ignoredCount = 0;
	}

	/** Also accept errors whose "<text> (<url>)" matches `pattern` (string = substring). */
	allow(pattern) {
		this.allowed.push(pattern);
		return this;
	}

	#isAllowed(entry) {
		const line = `${entry.text} (${entry.url || ''})`;
		if (entry.type === 'console' && /^Failed to load resource: the server responded with a status of [45]\d\d/.test(entry.text)) {
			try {
				if (new URL(entry.url).pathname.startsWith('/api/')) return true;
			} catch {
				/* no url */
			}
		}
		return this.allowed.some((p) => (p instanceof RegExp ? p.test(line) : line.includes(String(p))));
	}

	#push(entry) {
		if (this.#isAllowed(entry)) this.ignoredCount++;
		else this.errors.push(entry);
	}

	/** Start collecting from a BrowserContext (all its current and future pages). */
	watch(context) {
		context.on('weberror', (we) => {
			const e = we.error();
			this.#push({ type: 'pageerror', text: e?.message || String(e), url: we.page()?.url() ?? '', stack: e?.stack });
		});
		context.on('console', (msg) => {
			if (msg.type() !== 'error') return;
			this.#push({ type: 'console', text: msg.text(), url: msg.location()?.url || msg.page()?.url() || '' });
		});
		return this;
	}

	/** The unexpected errors so far: [{ type, text, url }]. */
	list() {
		return [...this.errors];
	}

	/** Forget what was collected (e.g. after deliberately breaking something). */
	clear() {
		this.errors.length = 0;
	}

	summary() {
		return this.errors.map((e) => `  - [${e.type}] ${e.text}${e.url ? ` (${e.url})` : ''}`).join('\n');
	}
}
