import http from 'node:http'
import type { AddressInfo } from 'node:net'

import type { PayloadHandler, PayloadRequest } from 'payload'

/**
 * A tiny web server for the mock checkout.js browser tests.
 *
 *   /harness.html                a page that loads /api/payments/mock/checkout.js and exposes window.__open()
 *   /api/payments/mock/*         in-process: the REAL endpoint handlers (src/payments/mockEndpoints.ts)
 *                                against the process-wide MockGateway; proxy mode (cmsUrl): forwarded to a
 *                                running CMS, the way the storefront's /api proxy does
 *   POST /callback               records a redirect-mode form POST and renders it (<pre id="callback">)
 *
 * Webhooks in in-process mode go to a sink (recorded in `webhooks`), never over HTTP.
 */

export interface CallbackRecord {
  query: Record<string, string>
  fields: Record<string, string>
  contentType: string
}

export interface Harness {
  url: string
  callbacks: CallbackRecord[]
  webhooks: { event: string; body: string; signature: string; eventId: string }[]
  keyId: string
  close(): Promise<void>
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function toHeaders(h: http.IncomingHttpHeaders): Headers {
  const out = new Headers()
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) out.append(k, one)
  }
  return out
}

async function send(res: http.ServerResponse, response: Response) {
  const headers: Record<string, string> = {}
  response.headers.forEach((v, k) => (headers[k] = v))
  delete headers['content-encoding']
  delete headers['content-length']
  res.writeHead(response.status, headers)
  res.end(Buffer.from(await response.arrayBuffer()))
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function harnessHtml(keyId: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock checkout harness</title></head>
<body>
<main>
  <h1>Harness</h1>
  <button id="opener" type="button">Open checkout</button>
  <input id="outside" aria-label="Outside field">
</main>
<script src="/api/payments/mock/checkout.js"></script>
<script>
window.__KEY__ = ${JSON.stringify(keyId).replace(/</g, '\\u003c')};
window.__log = [];
window.__open = function (overrides, flags) {
  flags = flags || {};
  var o = Object.assign({
    key: window.__KEY__, amount: 47400, currency: 'INR', name: 'Wefeasto', description: 'Order WF-10001',
    prefill: { name: 'Asha', email: 'asha@example.com', contact: '+919876543210', method: 'upi' },
    notes: { wf_order: 'WF-10001' }
  }, overrides || {});
  if (!flags.noHandler) o.handler = function (r) {
    window.__log.push({ type: 'handler', response: r, modalPresent: !!document.querySelector('[data-wf-mock-rzp]') });
  };
  var modal = Object.assign({}, o.modal || {});
  if (!flags.noDismiss) modal.ondismiss = function () { window.__log.push({ type: 'ondismiss' }); };
  o.modal = modal;
  var rzp = new Razorpay(o);
  rzp.on('payment.failed', function (r) { window.__log.push({ type: 'payment.failed', error: r.error }); });
  window.__rzp = rzp;
  rzp.open();
  return true;
};
document.getElementById('opener').addEventListener('click', function () { window.__open(window.__nextOptions || {}, window.__nextFlags || {}); });
</script>
</body></html>`
}

export async function startHarness(opts: { cmsUrl?: string; keyId?: string } = {}): Promise<Harness> {
  const callbacks: CallbackRecord[] = []
  const webhooks: Harness['webhooks'] = []
  let handlers: { script: PayloadHandler; pay: PayloadHandler } | null = null
  let keyId = opts.keyId ?? ''

  if (!opts.cmsUrl) {
    process.env.PAYMENTS_MODE = 'mock'
    process.env.MOCK_WEBHOOK_DELAY_MS ??= '50'
    process.env.MOCK_LATE_AUTH_DELAY_MS ??= '300'
    process.env.RATE_LIMIT_DISABLED = '1'
    const endpoints = await import('../../src/payments/mockEndpoints')
    const payments = await import('../../src/payments/index')
    const mock = payments.getMockGateway()
    if (!mock) throw new Error('harness: expected mock mode')
    mock.setWebhookSink((d) => {
      webhooks.push({ event: d.event, body: d.body, signature: d.signature, eventId: d.eventId })
      return { status: 200 }
    })
    keyId = mock.keyId
    handlers = { script: endpoints.mockCheckoutScriptHandler, pay: endpoints.mockPayHandler }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://harness.local')
      if (req.method === 'GET' && url.pathname === '/harness.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(harnessHtml(keyId))
        return
      }
      if (req.method === 'POST' && url.pathname === '/callback') {
        const body = (await readBody(req)).toString('utf8')
        const record: CallbackRecord = {
          query: Object.fromEntries(url.searchParams),
          fields: Object.fromEntries(new URLSearchParams(body)),
          contentType: String(req.headers['content-type'] ?? ''),
        }
        callbacks.push(record)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><title>callback</title><h1>Callback received</h1><pre id="callback">${escapeHtml(JSON.stringify(record))}</pre>`)
        return
      }
      if (url.pathname.startsWith('/api/')) {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
        const target = opts.cmsUrl ? `${opts.cmsUrl}${url.pathname}${url.search}` : `http://localhost${url.pathname}${url.search}`
        const headers = toHeaders(req.headers)
        headers.delete('host')
        if (opts.cmsUrl) {
          await send(res, await fetch(target, { method: req.method, headers, body }))
          return
        }
        const request = new Request(target, { method: req.method, headers, body })
        const handler =
          req.method === 'GET' && url.pathname === '/api/payments/mock/checkout.js'
            ? handlers!.script
            : req.method === 'POST' && url.pathname === '/api/payments/mock/pay'
              ? handlers!.pay
              : null
        if (!handler) {
          res.writeHead(404).end()
          return
        }
        await send(res, await handler(request as unknown as PayloadRequest))
        return
      }
      res.writeHead(404).end()
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    callbacks,
    webhooks,
    keyId,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
