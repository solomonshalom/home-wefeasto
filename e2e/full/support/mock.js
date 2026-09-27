/*
 * The mock Razorpay gateway (payments-gateway.md §5–§8), from the browser and over HTTP.
 */

/**
 * Make the mock checkout.js play a scenario on its next open(), for this page and every
 * later navigation of it: { auto: 'success'|'fail'|'fail_then_success'|'dismiss'|'lost'|
 * 'silent'|'late', delayMs = 100, reason?, webhook? } (payments-gateway.md §6).
 */
export async function setMockAuto(page, cfg) {
	const value = cfg ? { delayMs: 100, ...cfg } : null;
	await page.addInitScript((v) => {
		if (v) window.__WF_MOCK_RZP__ = v;
		else delete window.__WF_MOCK_RZP__;
	}, value);
	await page
		.evaluate((v) => {
			if (v) window.__WF_MOCK_RZP__ = v;
			else delete window.__WF_MOCK_RZP__;
		}, value)
		.catch(() => {}); // about:blank before the first navigation
}

/** The mock payment modal (role=dialog, labelled by the checkout `name`). */
export const mockModal = (page) => page.getByRole('dialog', { name: 'Wefeasto' });

export class MockGateway {
	constructor(stack) {
		this.cmsUrl = stack.cmsUrl;
		this.webhookDelayMs = stack.mock?.webhookDelayMs ?? 300;
		this.lateAuthDelayMs = stack.mock?.lateAuthDelayMs ?? 10_000;
	}

	/** See setMockAuto(). */
	setAuto(page, cfg) {
		return setMockAuto(page, cfg);
	}

	/** Back to manual clicks on the modal. */
	clearAuto(page) {
		return setMockAuto(page, null);
	}

	/** Every mock Razorpay instance the page created: [{ id, options, events, redirect, opened, silent? }]. */
	instances(page) {
		return page.evaluate(() => window.__wfMockRzpInstances ?? []);
	}

	/**
	 * Wait until a mock instance on the page has recorded `event` ('open', 'payment.failed',
	 * 'handler', 'lost', 'dismiss', 'ondismiss', 'redirect:success', …); resolves that instance.
	 * Read it before the page navigates away (the list lives in the /checkout document).
	 */
	async waitForEvent(page, event, { timeout = 15_000 } = {}) {
		const h = await page.waitForFunction((e) => (window.__wfMockRzpInstances || []).find((i) => (i.events || []).includes(e)) || null, event, {
			timeout
		});
		return h.jsonValue();
	}

	modal(page) {
		return mockModal(page);
	}

	/**
	 * POST /api/payments/mock/pay: settle a Razorpay order server-side as if the customer
	 * paid in Checkout. outcome: 'success'|'fail'|'late'|'authorize_only'. Options: webhook
	 * (default true: webhooks follow after MOCK_WEBHOOK_DELAY_MS), method, reason,
	 * lateAuthDelayMs, amount, email, contact, description. Resolves { status, json }.
	 */
	async pay(razorpayOrderId, outcome = 'success', opts = {}) {
		const res = await fetch(`${this.cmsUrl}/api/payments/mock/pay`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ razorpayOrderId, outcome, ...opts })
		});
		return { status: res.status, json: await res.json().catch(() => null) };
	}

	/**
	 * Fault injection (MockGateway.failNext) is in-process only today: there is no HTTP
	 * hook, so a browser e2e can't make createOrder/fetchPayment fail yet. Requested from the
	 * gateway owner as POST /api/payments/mock/fault (mock mode only). Until it exists this
	 * throws; guard specs with `test.skip(!(await mock.faultsAvailable()), '…')`.
	 */
	async failNext(op, kind, { times = 1, commit = false } = {}) {
		const res = await fetch(`${this.cmsUrl}/api/payments/mock/fault`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op, kind, times, commit })
		});
		if (res.status === 404) throw new Error('mock fault injection is not available: POST /api/payments/mock/fault does not exist yet (see e2e-harness.md)');
		if (!res.ok) throw new Error(`mock.failNext → ${res.status} ${await res.text()}`);
		return res.json();
	}

	/** Is the (requested) fault-injection endpoint deployed? */
	async faultsAvailable() {
		const res = await fetch(`${this.cmsUrl}/api/payments/mock/fault`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ probe: true })
		});
		return res.status !== 404;
	}
}
