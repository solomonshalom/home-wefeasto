/**
 * Mailpit (docker compose: SMTP 54325, API http://127.0.0.1:54326) helpers for integration tests.
 *
 * Other suites may use the same Mailpit concurrently, so NEVER wipe the whole inbox from a test:
 * give every test its own recipient (uniqueEmail()) and scope reads/deletes to it.
 *
 *   const to = uniqueEmail('signup')
 *   await deleteMessagesTo(to)                    // clean slate for this recipient
 *   …trigger the email…
 *   const [msg] = await waitForMessages(to)       // polls until it arrives (default 10 s)
 *   const full = await getMessage(msg.ID)         // { HTML, Text, Subject, … }
 *   extractLinks(full.HTML)
 */

const MAILPIT = (process.env.MAILPIT_URL ?? 'http://127.0.0.1:54326').replace(/\/+$/, '')

export type MailAddress = { Name: string; Address: string }
export type MailSummary = {
  ID: string
  MessageID: string
  From: MailAddress
  To: MailAddress[]
  Subject: string
  Created: string
  Snippet: string
}
export type MailMessage = MailSummary & { HTML: string; Text: string }

let seq = 0
/** A recipient nobody else uses: <tag>-<time>-<n>@test.wefeasto.dev */
export function uniqueEmail(tag = 'user'): string {
  seq += 1
  return `${tag}-${Date.now().toString(36)}-${process.pid}-${seq}@test.wefeasto.dev`.toLowerCase()
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${MAILPIT}/api/v1/${path}`, init)
  if (!res.ok) throw new Error(`Mailpit ${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  return res
}

export async function searchMessages(query: string, limit = 50): Promise<MailSummary[]> {
  const res = await api(`search?query=${encodeURIComponent(query)}&limit=${limit}`)
  return ((await res.json()) as { messages: MailSummary[] }).messages ?? []
}

export const toQuery = (address: string) => `to:"${address}"`

export async function listMessagesTo(address: string): Promise<MailSummary[]> {
  return searchMessages(toQuery(address))
}

export async function getMessage(id: string): Promise<MailMessage> {
  return (await (await api(`message/${encodeURIComponent(id)}`)).json()) as MailMessage
}

/** Deletes only the messages addressed to `address`. */
export async function deleteMessagesTo(address: string): Promise<void> {
  await api(`search?query=${encodeURIComponent(toQuery(address))}`, { method: 'DELETE' })
}

/** Wipes EVERY message. Only for manual/local use: other suites may be reading Mailpit. */
export async function clearMailpit(): Promise<void> {
  await api('messages', { method: 'DELETE' })
}

/**
 * Polls until at least `count` messages to `address` (optionally with `subject` substring) exist.
 * Returns them newest first. Throws after `timeoutMs`.
 */
export async function waitForMessages(
  address: string,
  { count = 1, subject, timeoutMs = 10_000 }: { count?: number; subject?: string; timeoutMs?: number } = {},
): Promise<MailSummary[]> {
  const deadline = Date.now() + timeoutMs
  let last: MailSummary[] = []
  while (Date.now() < deadline) {
    last = (await listMessagesTo(address)).filter((m) => !subject || m.Subject.includes(subject))
    if (last.length >= count) return last
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Timed out waiting for ${count} email(s) to ${address}; saw ${last.length}`)
}

/** Waits `ms` then returns every message to `address` (to assert that no extra email arrived). */
export async function settleAndList(address: string, ms = 750): Promise<MailSummary[]> {
  await new Promise((r) => setTimeout(r, ms))
  return listMessagesTo(address)
}

/** All href targets in an HTML body (entities decoded). */
export function extractLinks(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
}
