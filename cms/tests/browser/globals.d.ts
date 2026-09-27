/** Globals the mock checkout harness page and checkout.js define (tests/browser only). */
export {}

type HarnessLogEntry =
  | { type: 'handler'; response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }; modalPresent: boolean }
  | { type: 'ondismiss' }
  | { type: 'payment.failed'; error: { code: string; description: string; source: string; step: string; reason: string; metadata: { order_id: string; payment_id?: string } } }

declare global {
  interface Window {
    __KEY__: string
    __log: HarnessLogEntry[]
    __open: (overrides?: Record<string, unknown>, flags?: { noHandler?: boolean; noDismiss?: boolean }) => boolean
    __nextOptions?: Record<string, unknown>
    __nextFlags?: { noHandler?: boolean; noDismiss?: boolean }
    __rzp?: { close(): void; open(): void }
    __WF_MOCK_RZP__?: { auto?: string; delayMs?: number; reason?: string; webhook?: boolean }
    __wfMockRzpInstances?: { id: number; options: Record<string, unknown>; events: string[]; redirect: boolean; silent?: string; opened: number }[]
    Razorpay: new (options: Record<string, unknown>) => { open(): void; close(): void; on(event: string, cb: (r: unknown) => void): void }
  }
}
