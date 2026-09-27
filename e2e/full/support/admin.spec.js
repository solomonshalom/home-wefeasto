/*
 * AdminClient.messageLog() against the real CMS REST API (PI-ORD-H1). The slot DB is made
 * "busy" first: 150 message-log rows older than everything else are inserted, which is exactly
 * what hid new orders from the old client (it read the 100 OLDEST rows and filtered them here).
 * Also proves the whole-segment match (WF-1009 ≠ WF-10092), keyPrefix, and order + keyPrefix.
 * Unit counterpart (no stack): admin.test.mjs.
 *
 *   E2E_SLOT=0 npx playwright test --project=full e2e/full/support/admin.spec.js
 */
import crypto from 'node:crypto';
import { test, expect } from '../fixtures.js';

const FILLER = 150;

test.describe('admin.messageLog', { tag: ['@harness'] }, () => {
	test('finds a new order behind 150 older rows, matches whole segments, and-s keyPrefix', async ({ admin, api, db }) => {
		const tag = crypto.randomBytes(4).toString('hex');
		const fillerPrefix = `e2e-filler-${tag}:`;
		let traps = [];
		try {
			await db.query(
				`insert into message_log (key, type, status, created_at, updated_at)
				 select $1::text || t.i::text, 'e2e-filler', 'sent', timestamptz '2000-01-01T00:00:00Z' + t.i * interval '1 second', now()
				   from generate_series(1, $2::int) as t(i)`,
				[fillerPrefix, FILLER]
			);

			// A real COD order: its confirmation writes `confirm:<number>` (sendOnce, before sending).
			const o = await api.placeOrder({ items: { muesli: 1 }, method: 'cod' });
			const confirm = `confirm:${o.number}`;
			await expect
				.poll(async () => (await admin.messageLog({ order: o.number })).map((d) => d.key), { message: `${confirm} logged`, timeout: 20_000 })
				.toContain(confirm);

			// Keys that contain the number but name another order (or none) must not match.
			traps = [`confirm:${o.number}7`, `refill:${o.number}0:1`, `x-confirm:X${o.number}`, `refill-queue:${o.number}9:1:h0`];
			await db.query(`insert into message_log (key, type, status) select k, 'e2e-trap', 'sent' from unnest($1::text[]) as k`, [traps]);

			const mine = await admin.messageLog({ order: o.number });
			expect(mine.map((d) => d.key)).toEqual([confirm]);
			expect(mine[0]).toMatchObject({ key: confirm, type: 'order-confirmation', to: o.form.email.toLowerCase() });

			// keyPrefix narrows on the server too and is a real prefix; all 150 come back, oldest first.
			const filler = await admin.messageLog({ keyPrefix: fillerPrefix });
			expect(filler.map((d) => d.key)).toEqual(Array.from({ length: FILLER }, (_, i) => `${fillerPrefix}${i + 1}`));

			// order + keyPrefix together.
			expect((await admin.messageLog({ order: o.number, keyPrefix: 'confirm:' })).map((d) => d.key)).toEqual([confirm]);
			expect(await admin.messageLog({ order: o.number, keyPrefix: 'ship:' })).toEqual([]);
			expect((await admin.messageLog({ order: `${o.number}7` })).map((d) => d.key)).toEqual([`confirm:${o.number}7`]);
		} finally {
			await db.query('delete from message_log where key like $1 or key = any($2::text[])', [`${fillerPrefix}%`, traps]);
		}
	});
});
