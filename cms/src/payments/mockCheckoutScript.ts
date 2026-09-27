/**
 * Source of GET /api/payments/mock/checkout.js: a self-contained stand-in for Razorpay's
 * https://checkout.razorpay.com/v1/checkout.js, covering the subset the storefront uses (razorpay.md §4):
 *
 *   var rzp = new Razorpay(options); rzp.on('payment.failed', cb); rzp.open(); rzp.close();
 *
 * Supported options: key (must equal the server's key id, else nothing opens, like real Checkout with a
 * bogus key), order_id, amount, currency, name, description, prefill {name,email,contact,method}, notes,
 * theme.color, handler, callback_url, redirect, retry (true/false/{enabled}), timeout (seconds),
 * modal {ondismiss, escape, backdropclose, confirm_close}, target.
 *
 * `amount`, when passed, must equal the order amount (like real Checkout's order_amount_mismatch): the
 * modal then shows the error and nothing fires.
 *
 * Behaviour mirrors checkout.js (2026-09-24 build):
 *   - success: the modal closes, then `handler(response)` runs 200 ms later; `ondismiss` is NOT called.
 *     Without a handler, the response is form-POSTed to callback_url (Razorpay's default handler).
 *   - failure: `payment.failed` fires with {error:{code,description,source,step,reason,metadata}} and the
 *     modal stays open for another attempt on the same order (retry enabled, the default). With retry
 *     disabled it closes, `ondismiss` is scheduled and `alert("Payment Failed.\n"+description)` shows.
 *   - dismiss (Cancel, Esc unless modal.escape === false, backdrop when modal.backdropclose): the modal
 *     closes and `ondismiss` runs via setTimeout. modal.confirm_close asks first. timeout: auto-dismiss.
 *   - REDIRECT MODE when callback_url is set AND (redirect === true OR the user agent is one Razorpay
 *     forces into redirect mode: iPhone/iPad, CriOS, Instagram, FBAN/FB_IAB, Android WebView "; wv) ",
 *     old Android WebView, Windows Phone, Opera Mini, UCBrowser, Android 4). Paying then form-POSTs
 *     razorpay_payment_id / razorpay_order_id / razorpay_signature to callback_url (target _top), and a
 *     failed payment POSTs error[code], error[description], error[source], error[step], error[reason] and
 *     error[metadata] (a JSON string). `handler` is never called. Cancel still just dismisses.
 *
 * The page never sees a secret: every attempt is a POST to /api/payments/mock/pay (same origin as this
 * script), where the MockGateway records the payment, signs the response with the key secret and
 * schedules signed webhooks.
 *
 * e2e automation: set `window.__WF_MOCK_RZP__ = { auto, delayMs?, reason?, webhook? }` before open():
 *   auto: 'success' | 'fail' | 'fail_then_success' | 'dismiss' | 'lost' | 'silent' | 'late'
 *     success            pays after delayMs (default 100)
 *     fail               one failed attempt (payment.failed), then the customer closes the modal (ondismiss);
 *                        in redirect mode: the error POST to callback_url
 *     fail_then_success  payment.failed, then a successful retry on the same order (in-modal)
 *     dismiss            ondismiss, no payment
 *     lost               the payment succeeds server-side (webhooks fire) but the modal just closes:
 *                        no handler, no ondismiss, no redirect (tab closed / network died)
 *     silent             open() renders nothing and fires nothing (bad key, blocked iframe)
 *     late               a failed attempt that the bank authorises later (see /mock/pay 'late'), then dismiss
 *   reason: Razorpay error.reason for failures (default payment_failed); webhook: false suppresses webhooks.
 * Every instance is recorded in `window.__wfMockRzpInstances` ({id, options (functions as '[fn]'),
 * events[], redirect, silent?}) so tests can assert what the storefront passed.
 */

export interface MockCheckoutScriptConfig {
  /** Public key id the storefront must pass as `options.key`. */
  keyId: string
  /** Absolute path of the pay endpoint on the script's origin, e.g. '/api/payments/mock/pay'. */
  payPath: string
}

/** JSON that is safe inside a <script> body and a JS source file. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function renderMockCheckoutScript(config: MockCheckoutScriptConfig): string {
  return SCRIPT.replace('__WF_MOCK_CONFIG__', () => scriptJson({ keyId: config.keyId, payPath: config.payPath }))
}

// Plain ES2017 browser code. No template literals inside (String.raw keeps every backslash verbatim).
const SCRIPT = String.raw`/*! Wefeasto mock of Razorpay Checkout (checkout.js). PAYMENTS_MODE=mock only; no real payments. */
(function () {
  'use strict';
  var CONFIG = __WF_MOCK_CONFIG__;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.Razorpay && window.Razorpay.__wfMock) return;

  var currentScript = document.currentScript;
  var API_ORIGIN = (function () {
    try {
      if (currentScript && currentScript.src) return new URL(currentScript.src, location.href).origin;
    } catch (e) {}
    return location.origin;
  })();
  var PAY_URL = API_ORIGIN + CONFIG.payPath;

  // checkout.js: callback_url && (UA below) forces options.redirect = true.
  var FORCED_REDIRECT_UA = /; wv\) |Gecko\) Version\/[^ ]+ Chrome|Windows Phone|Opera Mini|UCBrowser|CriOS/;
  var FORCED_REDIRECT_APPS = /FB_IAB|FBAN|Instagram|iPhone|iPad|Android 4/;
  function isForcedRedirectUA(ua) {
    ua = String(ua || '');
    return FORCED_REDIRECT_UA.test(ua) || FORCED_REDIRECT_APPS.test(ua);
  }

  var METHODS = [['upi', 'UPI'], ['card', 'Card'], ['netbanking', 'Netbanking'], ['wallet', 'Wallet']];
  var instances = (window.__wfMockRzpInstances = window.__wfMockRzpInstances || []);
  var seq = 0;

  var CSS = [
    '.wf-mock-rzp{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1f2328;text-align:left}',
    '.wf-mock-rzp *{box-sizing:border-box}',
    '.wf-mock-rzp__backdrop{position:absolute;inset:0;background:rgba(17,24,39,.6)}',
    '.wf-mock-rzp__dialog{position:relative;width:100%;max-width:380px;max-height:100%;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:20px 20px 16px}',
    '.wf-mock-rzp__dialog:focus{outline:none}',
    '.wf-mock-rzp__badge{display:inline-block;margin:0 0 12px;padding:2px 10px;border-radius:999px;background:#fff4d6;color:#5c4300;font-size:12px;font-weight:600}',
    '.wf-mock-rzp__title{margin:0;font-size:18px;font-weight:700}',
    '.wf-mock-rzp__desc{margin:2px 0 0;color:#57606a}',
    '.wf-mock-rzp__amount{margin:14px 0 4px;font-size:26px;font-weight:700;letter-spacing:-.01em}',
    '.wf-mock-rzp__who{margin:0 0 12px;color:#57606a;font-size:13px;word-break:break-all}',
    '.wf-mock-rzp__label{display:block;font-size:13px;font-weight:600;margin:0 0 4px}',
    '.wf-mock-rzp__select{display:block;width:100%;padding:9px 10px;border:1px solid #8c959f;border-radius:8px;background:#fff;color:#1f2328;font:inherit}',
    '.wf-mock-rzp__error{margin:12px 0 0;padding:8px 10px;border-radius:8px;background:#ffebe9;color:#82071e;font-size:14px}',
    '.wf-mock-rzp__status{margin:10px 0 0;min-height:1.45em;color:#57606a;font-size:13px}',
    '.wf-mock-rzp__btn{display:block;width:100%;margin:8px 0 0;padding:11px 14px;border:1px solid #8c959f;border-radius:8px;background:#f6f8fa;color:#1f2328;font:inherit;font-weight:600;cursor:pointer;text-align:center}',
    '.wf-mock-rzp__btn--pay{background:#1f4fbf;border-color:transparent;color:#fff}',
    '.wf-mock-rzp__btn--fail{color:#82071e}',
    '.wf-mock-rzp__btn:focus-visible,.wf-mock-rzp__select:focus-visible{outline:3px solid #0969da;outline-offset:2px}',
    '.wf-mock-rzp__btn[disabled],.wf-mock-rzp__select[disabled]{opacity:.6;cursor:progress}',
    '.wf-mock-rzp__note{margin:12px 0 0;color:#6e7781;font-size:12px}',
    '.wf-mock-rzp [hidden]{display:none!important}',
    '@media (prefers-reduced-motion:no-preference){.wf-mock-rzp__dialog{animation:wf-mock-rzp-in .16s ease-out}}',
    '@keyframes wf-mock-rzp-in{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById('wf-mock-rzp-style')) return;
    var style = document.createElement('style');
    style.id = 'wf-mock-rzp-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      }
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatAmount(amount, currency) {
    var n = Number(amount);
    if (!isFinite(n) || n <= 0) return '';
    var cur = String(currency || 'INR').toUpperCase();
    var value = n / 100;
    var digits = n % 100 === 0 ? 0 : 2;
    var text;
    try {
      text = value.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: 2 });
    } catch (e) {
      text = value.toFixed(digits);
    }
    return (cur === 'INR' ? '\u20b9' : cur + ' ') + text;
  }

  // Readable text colour for theme.color (#rgb or #rrggbb); null when the colour is not a hex value.
  function textOn(hex) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var h = m[1].length === 3 ? m[1].replace(/(.)/g, '$1$1') : m[1];
    var rgb = [0, 2, 4].map(function (i) {
      var c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return lum > 0.179 ? '#000000' : '#ffffff';
  }

  function serialisable(options) {
    try {
      return JSON.parse(JSON.stringify(options, function (k, v) { return typeof v === 'function' ? '[fn]' : v; }));
    } catch (e) {
      return {};
    }
  }

  function retryEnabled(opts) {
    var r = opts.retry;
    if (r === false) return false;
    if (r && typeof r === 'object' && r.enabled === false) return false;
    return true;
  }

  function modalOpt(opts, key, fallback) {
    var m = opts.modal && typeof opts.modal === 'object' ? opts.modal : {};
    return m[key] === undefined ? fallback : m[key];
  }

  function focusables(container) {
    var nodes = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return Array.prototype.filter.call(nodes, function (n) {
      return !n.disabled && n.getClientRects().length > 0;
    });
  }

  function formPost(url, fields, target) {
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = url;
    form.target = target || '_top';
    form.style.display = 'none';
    form.setAttribute('data-wf-mock-rzp-redirect', '');
    Object.keys(fields).forEach(function (name) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = fields[name] === null || fields[name] === undefined ? '' : String(fields[name]);
      form.appendChild(input);
    });
    (document.body || document.documentElement).appendChild(form);
    HTMLFormElement.prototype.submit.call(form);
  }

  function errorFields(error) {
    var e = error || {};
    var fields = {
      'error[code]': e.code || 'BAD_REQUEST_ERROR',
      'error[description]': e.description || 'Payment failed',
      'error[source]': e.source || '',
      'error[step]': e.step || '',
      'error[reason]': e.reason || '',
      'error[metadata]': JSON.stringify(e.metadata || {})
    };
    if (e.field) fields['error[field]'] = e.field;
    return fields;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function Razorpay(options) {
    if (!(this instanceof Razorpay)) return new Razorpay(options);
    if (!options || typeof options !== 'object' || !options.key) throw new Error('No key passed');
    this._opts = options;
    this._listeners = {};
    this._root = null;
    this._busy = false;
    this._record = { id: ++seq, options: serialisable(options), events: [], redirect: false, opened: 0 };
    instances.push(this._record);
  }

  Razorpay.__wfMock = true;

  Razorpay.prototype.on = function (event, cb) {
    if (typeof cb === 'function') (this._listeners[event] = this._listeners[event] || []).push(cb);
    return this;
  };

  Razorpay.prototype.get = function (key) {
    return arguments.length ? this._opts[key] : this._opts;
  };

  Razorpay.prototype._emit = function (event, payload) {
    var self = this;
    this._record.events.push(event);
    (this._listeners[event] || []).slice().forEach(function (cb) {
      try {
        cb.call(self, payload);
      } catch (err) {
        setTimeout(function () { throw err; });
      }
    });
  };

  Razorpay.prototype.open = function () {
    if (this._root) return this;
    var opts = this._opts;
    var auto = window.__WF_MOCK_RZP__ && typeof window.__WF_MOCK_RZP__ === 'object' ? window.__WF_MOCK_RZP__ : null;
    this._auto = auto;
    this._redirect = Boolean(opts.callback_url) && (opts.redirect === true || isForcedRedirectUA(navigator.userAgent));
    this._record.redirect = this._redirect;
    this._record.opened += 1;
    this._record.events.push('open');
    if (CONFIG.keyId && opts.key !== CONFIG.keyId) {
      // Real Checkout with a key it does not know shows nothing and fires nothing (razorpay.md section 4.2).
      console.warn('[wefeasto mock checkout] options.key does not match the server key id; nothing opens.');
      this._record.silent = 'key_mismatch';
      return this;
    }
    if (auto && auto.auto === 'silent') {
      this._record.silent = 'auto';
      return this;
    }
    this._render();
    var seconds = Number(opts.timeout);
    if (seconds > 0) this._timeoutTimer = setTimeout(this._onTimeout.bind(this), seconds * 1000);
    if (auto && auto.auto) {
      var self = this;
      setTimeout(function () { self._runAuto(auto); }, typeof auto.delayMs === 'number' ? auto.delayMs : 100);
    }
    return this;
  };

  Razorpay.prototype.close = function () {
    if (!this._root) return;
    this._record.events.push('close');
    this._teardown();
  };

  Razorpay.prototype._render = function () {
    injectStyle();
    var self = this;
    var opts = this._opts;
    var prefill = opts.prefill && typeof opts.prefill === 'object' ? opts.prefill : {};
    var uid = 'wf-mock-rzp-' + this._record.id + '-' + this._record.opened;
    var amountText = formatAmount(opts.amount, opts.currency);

    var root = el('div', { 'class': 'wf-mock-rzp', 'data-wf-mock-rzp': '' });
    var backdrop = el('div', { 'class': 'wf-mock-rzp__backdrop', 'data-part': 'backdrop' });
    var dialog = el('div', {
      'class': 'wf-mock-rzp__dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': uid + '-title',
      'aria-describedby': uid + '-desc',
      tabindex: '-1'
    });

    var main = el('div', { 'data-step': 'pay' });
    main.appendChild(el('p', { 'class': 'wf-mock-rzp__badge' }, 'Test mode \u00b7 mock payment'));
    main.appendChild(el('h2', { 'class': 'wf-mock-rzp__title', id: uid + '-title' }, opts.name || 'Checkout'));
    main.appendChild(el('p', { 'class': 'wf-mock-rzp__desc', id: uid + '-desc' }, opts.description || 'Complete your payment'));
    if (amountText) main.appendChild(el('p', { 'class': 'wf-mock-rzp__amount', 'data-part': 'amount' }, amountText));
    var who = [prefill.contact, prefill.email].filter(Boolean).join(' \u00b7 ');
    if (who) main.appendChild(el('p', { 'class': 'wf-mock-rzp__who' }, who));

    main.appendChild(el('label', { 'class': 'wf-mock-rzp__label', 'for': uid + '-method' }, 'Pay with'));
    var select = el('select', { 'class': 'wf-mock-rzp__select', id: uid + '-method', name: 'method' });
    var preferred = String(prefill.method || 'upi');
    METHODS.forEach(function (m) {
      var option = el('option', { value: m[0] }, m[1]);
      if (m[0] === preferred) option.selected = true;
      select.appendChild(option);
    });
    main.appendChild(select);

    var error = el('p', { 'class': 'wf-mock-rzp__error', role: 'alert', 'data-part': 'error' });
    error.hidden = true;
    main.appendChild(error);
    var status = el('p', { 'class': 'wf-mock-rzp__status', 'aria-live': 'polite', 'data-part': 'status' });
    main.appendChild(status);

    var payBtn = el('button', { type: 'button', 'class': 'wf-mock-rzp__btn wf-mock-rzp__btn--pay', 'data-action': 'pay' }, amountText ? 'Pay ' + amountText : 'Pay');
    var themeColor = opts.theme && opts.theme.color;
    var ink = textOn(themeColor);
    if (ink) {
      payBtn.style.background = String(themeColor);
      payBtn.style.color = ink;
    }
    var failBtn = el('button', { type: 'button', 'class': 'wf-mock-rzp__btn wf-mock-rzp__btn--fail', 'data-action': 'fail' }, 'Fail payment');
    var cancelBtn = el('button', { type: 'button', 'class': 'wf-mock-rzp__btn', 'data-action': 'cancel' }, 'Cancel');
    main.appendChild(payBtn);
    main.appendChild(failBtn);
    main.appendChild(cancelBtn);
    main.appendChild(el('p', { 'class': 'wf-mock-rzp__note' },
      this._redirect ? 'Redirect mode: the result is posted to the callback URL.' : 'No real money moves in mock mode.'));

    var confirm = el('div', { 'data-step': 'confirm' });
    confirm.hidden = true;
    confirm.appendChild(el('p', { 'class': 'wf-mock-rzp__title', id: uid + '-confirm' }, 'Are you sure you want to cancel the payment?'));
    var yesBtn = el('button', { type: 'button', 'class': 'wf-mock-rzp__btn', 'data-action': 'confirm-yes' }, 'Yes, cancel');
    var noBtn = el('button', { type: 'button', 'class': 'wf-mock-rzp__btn wf-mock-rzp__btn--pay', 'data-action': 'confirm-no' }, 'No, go back');
    confirm.appendChild(yesBtn);
    confirm.appendChild(noBtn);

    dialog.appendChild(main);
    dialog.appendChild(confirm);
    root.appendChild(backdrop);
    root.appendChild(dialog);

    this._els = { root: root, dialog: dialog, main: main, confirm: confirm, select: select, error: error, status: status, pay: payBtn, fail: failBtn, cancel: cancelBtn, no: noBtn };

    payBtn.addEventListener('click', function () { self._attempt('success'); });
    failBtn.addEventListener('click', function () { self._attempt('fail'); });
    cancelBtn.addEventListener('click', function () { self._requestDismiss(); });
    yesBtn.addEventListener('click', function () { self._dismiss(); });
    noBtn.addEventListener('click', function () { self._showStep('pay'); self._els.cancel.focus(); });
    backdrop.addEventListener('click', function () {
      if (modalOpt(opts, 'backdropclose', false)) self._requestDismiss();
    });

    this._onKeydown = function (e) {
      if (!self._root) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        if (!self._els.confirm.hidden) {
          self._showStep('pay');
          self._els.cancel.focus();
          return;
        }
        if (modalOpt(opts, 'escape', true) !== false && !self._busy) self._requestDismiss();
        return;
      }
      if (e.key !== 'Tab') return;
      var list = focusables(dialog);
      if (!list.length) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      var first = list[0];
      var last = list[list.length - 1];
      var active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active) || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    this._onFocusIn = function (e) {
      if (self._root && !dialog.contains(e.target)) {
        var list = focusables(dialog);
        (list[0] || dialog).focus();
      }
    };
    document.addEventListener('keydown', this._onKeydown, true);
    document.addEventListener('focusin', this._onFocusIn, true);

    this._returnFocus = document.activeElement;
    this._prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    (document.body || document.documentElement).appendChild(root);
    this._root = root;
    payBtn.focus();
  };

  Razorpay.prototype._showStep = function (step) {
    if (!this._els) return;
    this._els.main.hidden = step !== 'pay';
    this._els.confirm.hidden = step !== 'confirm';
  };

  Razorpay.prototype._setBusy = function (busy) {
    this._busy = busy;
    if (!this._els) return;
    var e = this._els;
    [e.pay, e.fail, e.cancel, e.select].forEach(function (n) { n.disabled = busy; });
    if (busy) e.dialog.setAttribute('aria-busy', 'true');
    else e.dialog.removeAttribute('aria-busy');
    e.status.textContent = busy ? 'Processing payment\u2026' : '';
  };

  Razorpay.prototype._showError = function (text) {
    if (!this._els) return;
    this._els.error.textContent = text || '';
    this._els.error.hidden = !text;
  };

  Razorpay.prototype._method = function () {
    return this._els ? this._els.select.value : 'upi';
  };

  Razorpay.prototype._attempt = function (outcome, flags) {
    var self = this;
    var opts = this._opts;
    flags = flags || {};
    if (this._busy || !this._root) return Promise.resolve(null);
    this._setBusy(true);
    this._showError('');
    var auto = this._auto || {};
    var prefill = opts.prefill && typeof opts.prefill === 'object' ? opts.prefill : {};
    var body = { razorpayOrderId: opts.order_id, outcome: outcome, method: this._method(), webhook: auto.webhook !== false };
    if (auto.reason && outcome !== 'success') body.reason = String(auto.reason);
    if (prefill.email) body.email = String(prefill.email);
    if (prefill.contact) body.contact = String(prefill.contact);
    if (opts.description) body.description = String(opts.description).slice(0, 255);
    if (opts.amount !== undefined && opts.amount !== null && opts.amount !== '') body.amount = Number(opts.amount);
    return fetch(PAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin'
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        self._setBusy(false);
        if (!r.data || r.status >= 400 || typeof r.data.ok !== 'boolean') {
          var message = (r.data && r.data.error && r.data.error.message) || 'The mock payment server answered HTTP ' + r.status + '.';
          self._record.events.push('server_error');
          self._showError(message);
          return { ok: null, status: r.status, error: message };
        }
        if (r.data.ok) self._succeed(r.data.response, flags);
        else self._failed(r.data.error, flags);
        return r.data;
      }, function () {
        self._setBusy(false);
        self._record.events.push('server_error');
        self._showError('Could not reach the mock payment server.');
        return { ok: null, status: 0 };
      });
  };

  Razorpay.prototype._succeed = function (response, flags) {
    var opts = this._opts;
    var self = this;
    if (flags.lost) {
      this._record.events.push('lost');
      this._teardown();
      return;
    }
    if (this._redirect) {
      this._record.events.push('redirect:success');
      this._teardown();
      formPost(opts.callback_url, response, opts.target);
      return;
    }
    this._teardown();
    if (typeof opts.handler === 'function') {
      setTimeout(function () {
        self._record.events.push('handler');
        opts.handler.call(self, response);
      }, 200);
    } else if (opts.callback_url) {
      this._record.events.push('redirect:success');
      formPost(opts.callback_url, response, opts.target);
    }
  };

  Razorpay.prototype._failed = function (error, flags) {
    var opts = this._opts;
    this._record.lastError = error;
    if (this._redirect && !flags.inline) {
      this._record.events.push('redirect:error');
      this._teardown();
      formPost(opts.callback_url, errorFields(error), opts.target);
      return;
    }
    this._emit('payment.failed', { error: error });
    if (retryEnabled(opts)) {
      this._showError((error && error.description ? error.description : 'Payment failed') + '. You can try again.');
      if (this._els) this._els.pay.focus();
      return;
    }
    // retry disabled: checkout.js onfailure = ondismiss(); alert(...)
    this._dismiss();
    this._record.events.push('alert');
    try {
      window.alert('Payment Failed.\n' + (error && error.description ? error.description : ''));
    } catch (e) {}
  };

  Razorpay.prototype._requestDismiss = function () {
    if (this._busy || !this._root) return;
    if (modalOpt(this._opts, 'confirm_close', false)) {
      this._showStep('confirm');
      this._els.no.focus();
      return;
    }
    this._dismiss();
  };

  Razorpay.prototype._dismiss = function () {
    if (!this._root) return;
    var cb = modalOpt(this._opts, 'ondismiss', null);
    var self = this;
    this._teardown();
    this._record.events.push('dismiss');
    if (typeof cb === 'function') setTimeout(function () { self._record.events.push('ondismiss'); cb(); });
  };

  Razorpay.prototype._onTimeout = function () {
    if (!this._root) return;
    if (this._busy) {
      this._timeoutTimer = setTimeout(this._onTimeout.bind(this), 500);
      return;
    }
    this._record.events.push('timeout');
    this._dismiss();
  };

  Razorpay.prototype._teardown = function () {
    if (this._timeoutTimer) clearTimeout(this._timeoutTimer);
    this._timeoutTimer = null;
    if (this._onKeydown) document.removeEventListener('keydown', this._onKeydown, true);
    if (this._onFocusIn) document.removeEventListener('focusin', this._onFocusIn, true);
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
    this._els = null;
    this._busy = false;
    document.documentElement.style.overflow = this._prevOverflow || '';
    var back = this._returnFocus;
    this._returnFocus = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) {
      try { back.focus(); } catch (e) {}
    }
  };

  Razorpay.prototype._runAuto = function (auto) {
    var self = this;
    if (!this._root) return;
    var pause = typeof auto.delayMs === 'number' ? auto.delayMs : 100;
    switch (auto.auto) {
      case 'success':
        return this._attempt('success');
      case 'fail':
      case 'late':
        return this._attempt(auto.auto).then(function (r) {
          if (r && r.ok === false && self._root) return wait(pause).then(function () { self._dismiss(); });
        });
      case 'fail_then_success':
        return this._attempt('fail', { inline: true }).then(function (r) {
          if (!r || r.ok !== false || !self._root) return;
          return wait(pause).then(function () { return self._attempt('success'); });
        });
      case 'dismiss':
        return this._dismiss();
      case 'lost':
        return this._attempt('success', { lost: true });
      default:
        console.warn('[wefeasto mock checkout] unknown __WF_MOCK_RZP__.auto value: ' + auto.auto);
    }
  };

  window.Razorpay = Razorpay;
})();
`
