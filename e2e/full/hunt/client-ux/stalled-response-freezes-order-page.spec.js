/*
 * Hunt (client-ux): one stalled response freezes /order for good.
 *
 * $lib/api.js arms its timeout (`timeoutMs`, 8 s for the status look) only around `fetch()`,
 * which resolves as soon as the response HEADERS arrive; the `finally` clears the timer and
 * `await res.text()` then waits with no deadline. On a flaky mobile connection (headers in,
 * connection gone before the body) that read never ends: fetchStatus never resolves, the order
 * watcher's `looking` flag stays true, and every later look (the poll schedule, the look on
 * returning to the tab) is skipped. The page sits on "Looking up your order…" forever, even
 * after the network is back and the payment is confirmed. The same hole leaves COD's
 * "Placing your order…" (20 s timeout) and every other API call spinning indefinitely.
 *
 * Correct: the timeout covers the whole exchange (body included), so a stalled look fails
 * after 8 s and the next one finds the paid order.
 *
 * Run: E2E_SLOT=3 E2E_REUSE=1 npx playwright test --project=full e2e/full/hunt/client-ux/stalled-response-freezes-order-page.spec.js
 */
import http from 'node:http';
import { test, expect } from '../../fixtures.js';

test('a status response whose body stalls does not freeze /order: the paid order shows up', async ({ page, api, mock, consoleErrors }) => {
	consoleErrors.allow(/ERR_INCOMPLETE_CHUNKED_ENCODING/); // the injected dead connection, torn down at the end
	// A server that sends the response head and the first bytes of JSON, then goes silent.
	const sockets = new Set();
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.write('{"number":"WF-');
	});
	server.on('connection', (s) => sockets.add(s));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		const o = await api.placeOrder({ items: { muesli: 1 }, method: 'upi' });
		let stalls = 1; // only the first status look hits the dead connection
		await page.route('**/api/store/orders/status**', (route) =>
			stalls-- > 0 ? route.continue({ url: `http://127.0.0.1:${server.address().port}/status` }) : route.continue()
		);
		await page.goto(`/order?no=${o.number}&t=${encodeURIComponent(o.token)}`);
		await expect(page.locator('[data-wf-order-view]')).toHaveAttribute('data-wf-order-view', 'loading');

		// The customer's payment is confirmed (webhook) while that first look hangs.
		const paid = await mock.pay(o.payment.razorpayOrderId, 'success', { webhook: true });
		expect(paid.status).toBe(200);

		// 8 s status timeout + the 2 s poll: well inside 30 s the page must show the paid order.
		await expect(page.locator('[data-wf-order-view]')).toHaveAttribute('data-wf-order-view', 'confirmed', { timeout: 30_000 });
	} finally {
		for (const s of sockets) s.destroy();
		server.close();
	}
});
