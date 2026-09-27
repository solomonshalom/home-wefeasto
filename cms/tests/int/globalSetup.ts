import pg from 'pg'

import { assertTestDatabase, TEST_DATABASE_URI } from './env'

/**
 * Runs once before the integration project: wipe the test database (drop + recreate the public schema).
 * Payload's dev push then recreates every table on the first getPayload().
 */
export default async function setup(): Promise<void> {
  assertTestDatabase(TEST_DATABASE_URI)
  const client = new pg.Client({ connectionString: TEST_DATABASE_URI })
  try {
    await client.connect()
  } catch (err) {
    throw new Error(
      `Cannot reach the test database (${new URL(TEST_DATABASE_URI).host}). Start it with \`docker compose up -d\` in the repo root.\n${String(err)}`,
    )
  }
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
    await client.query('GRANT ALL ON SCHEMA public TO public')
  } finally {
    await client.end()
  }
}
