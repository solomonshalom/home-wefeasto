/*
 * Mailpit client (API http://127.0.0.1:54326). Mailpit is SHARED by every slot, suite and
 * agent: always scope by a unique recipient (uniqueEmail()), never wipe the inbox.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const matchSubject = (subject, want) => {
	if (!want) return true;
	return want instanceof RegExp ? want.test(subject) : subject.toLowerCase().includes(String(want).toLowerCase());
};

export class Mailpit {
	constructor(apiUrl = 'http://127.0.0.1:54326') {
		this.apiUrl = apiUrl.replace(/\/+$/, '');
	}

	async #json(path, init) {
		const res = await fetch(`${this.apiUrl}${path}`, init);
		if (!res.ok) throw new Error(`mailpit ${init?.method || 'GET'} ${path} → ${res.status} ${await res.text()}`);
		const text = await res.text();
		return text ? JSON.parse(text) : null;
	}

	/**
	 * Message summaries addressed to `to` (exact address match, case-insensitive), oldest
	 * first: [{ ID, Subject, From, To, Created, Snippet, … }].
	 */
	async messages(to) {
		const addr = String(to).toLowerCase();
		const q = encodeURIComponent(`to:"${addr}"`);
		const out = [];
		for (let start = 0; ; start += 200) {
			const page = await this.#json(`/api/v1/search?query=${q}&limit=200&start=${start}`);
			const msgs = page?.messages ?? [];
			out.push(...msgs);
			if (msgs.length < 200) break;
		}
		return out
			.filter((m) => (m.To || []).some((r) => String(r.Address).toLowerCase() === addr))
			.sort((a, b) => String(a.Created).localeCompare(String(b.Created)));
	}

	/** The full message: { ID, Subject, From, To, HTML, Text, … }. */
	message(id) {
		return this.#json(`/api/v1/message/${encodeURIComponent(id)}`);
	}

	/** Raw headers of a message: { 'List-Unsubscribe': [...], … }. */
	headers(id) {
		return this.#json(`/api/v1/message/${encodeURIComponent(id)}/headers`);
	}

	/**
	 * Wait until `count` messages to `to` (subject containing `subjectIncludes`, a string
	 * or RegExp) exist; resolves the first matching FULL message (use waitForMessages for all).
	 */
	async waitForMessage({ to, subjectIncludes, timeout = 20_000, count = 1 } = {}) {
		const [first] = await this.waitForMessages({ to, subjectIncludes, timeout, count });
		return first;
	}

	/** Like waitForMessage, but resolves every matching full message (oldest first). */
	async waitForMessages({ to, subjectIncludes, timeout = 20_000, count = 1 } = {}) {
		if (!to) throw new Error('mailpit.waitForMessage: `to` is required (Mailpit is shared: always scope by recipient)');
		const end = Date.now() + timeout;
		let last = [];
		while (Date.now() < end) {
			last = (await this.messages(to)).filter((m) => matchSubject(m.Subject, subjectIncludes));
			if (last.length >= count) return Promise.all(last.map((m) => this.message(m.ID)));
			await sleep(250);
		}
		const all = await this.messages(to);
		throw new Error(
			`mailpit: expected ${count} message(s) to ${to}${subjectIncludes ? ` with subject ~ ${subjectIncludes}` : ''} within ${timeout}ms; ` +
				`got ${last.length}. All subjects to that address: ${JSON.stringify(all.map((m) => m.Subject))}`
		);
	}

	/**
	 * Wait until no new message to `to` has arrived for `quietMs` (default 2 s), then
	 * resolve the summaries: use it to prove "exactly one email" (nothing else follows).
	 */
	async settle(to, { quietMs = 2000, timeout = 15_000 } = {}) {
		const end = Date.now() + timeout;
		let prev = -1;
		let since = Date.now();
		let msgs = [];
		while (Date.now() < end) {
			msgs = await this.messages(to);
			if (msgs.length !== prev) {
				prev = msgs.length;
				since = Date.now();
			} else if (Date.now() - since >= quietMs) return msgs;
			await sleep(250);
		}
		return msgs;
	}

	/** Every link of a message: hrefs from the HTML part (&amp; decoded) + bare URLs in the text part, de-duplicated. */
	extractLinks(msg) {
		const out = [];
		for (const m of String(msg?.HTML || '').matchAll(/href\s*=\s*"([^"]+)"/gi)) out.push(m[1].replace(/&amp;/g, '&'));
		for (const m of String(msg?.Text || '').matchAll(/https?:\/\/[^\s<>"')\]]+/g)) out.push(m[0]);
		return [...new Set(out)];
	}

	/** Delete every message to `to` (by id, exact address match only). */
	async cleanup(to) {
		const ids = (await this.messages(to)).map((m) => m.ID);
		if (!ids.length) return 0;
		const res = await fetch(`${this.apiUrl}/api/v1/messages`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ IDs: ids })
		});
		if (!res.ok) throw new Error(`mailpit cleanup ${to} → ${res.status} ${await res.text()}`);
		return ids.length;
	}
}
