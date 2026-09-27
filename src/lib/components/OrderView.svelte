<script>
	/*
	 * An order's lines and totals as the server has them (OrderStatusDTO,
	 * SPEC §6) — the /order page's receipt card, in the checkout summary's
	 * look. The method line says how it was (or will be) paid.
	 */
	import { formatPaise } from '$shared/money.js';

	let { order } = $props();

	const items = $derived(Array.isArray(order?.items) ? order.items : []);
	const cod = $derived(order?.paymentMethod === 'cod' || order?.requestedMethod === 'cod');
	const methodLine = $derived(
		cod ? `Pay ${formatPaise(order.totalPaise)} on delivery — cash or UPI.` : `Paid ${formatPaise(order.totalPaise)} online.`
	);
</script>

<div class="wf-summary wf-order-summary" data-wf-order-summary><h3 class="wf-summary-heading">Order Summary</h3><div class="wf-summary-divider"></div>{#each items as it, i (it.slug + ':' + i)}<div class="wf-summary-row" data-wf-order-line={it.slug}><span>{it.name || it.slug} × {it.qty}</span><span>{formatPaise(it.lineTotalPaise)}</span></div>{/each}<div class="wf-summary-divider"></div><div class="wf-summary-row"><span>Subtotal</span><span>{formatPaise(order.subtotalPaise)}</span></div>{#if order.discountPaise > 0}<div class="wf-summary-row"><span>Discount{order.coupon?.code ? ' (' + order.coupon.code + ')' : ''}</span><span>−{formatPaise(order.discountPaise)}</span></div>{/if}<div class="wf-summary-row"><span>Delivery</span><span class:wf-free={!order.deliveryPaise}>{order.deliveryPaise ? formatPaise(order.deliveryPaise) : 'FREE'}</span></div>{#if order.codFeePaise > 0}<div class="wf-summary-row"><span>Cash on delivery fee</span><span>{formatPaise(order.codFeePaise)}</span></div>{/if}<div class="wf-summary-divider"></div><div class="wf-summary-row wf-summary-total"><span>Total</span><span data-wf-order-total>{formatPaise(order.totalPaise)}</span></div><p class="wf-summary-note wf-order-method" data-wf-order-method={cod ? 'cod' : 'online'}>{methodLine}</p></div>
