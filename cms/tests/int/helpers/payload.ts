import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'

import config from '@/payload.config'

/**
 * One Payload instance for the whole integration run (the int project runs with isolate:false, so this
 * module — and the instance — is shared by every test file). The first call pushes the schema.
 */
let instance: Promise<Payload> | undefined

export function getTestPayload(): Promise<Payload> {
  instance ??= getPayload({ config })
  return instance
}

export { config }

/** A Local-API request object (optionally as a user), e.g. to run code that expects `req`. */
export async function makeReq(user?: PayloadRequest['user']): Promise<PayloadRequest> {
  const payload = await getTestPayload()
  return createLocalReq({ user: user ?? undefined }, payload)
}
