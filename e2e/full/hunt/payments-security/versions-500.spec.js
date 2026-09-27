/*
 * Hunt (payments-security) — any signed-in customer turns /api/<collection>/versions into a 500.
 *
 * Payload's default `readVersions` access is "any logged-in user". Only products, recipes and pages set
 * it (they have drafts). On every other collection, and on the store-settings global, a customer passes
 * the access check and Payload then crashes looking for a versions table that doesn't exist
 * ("Cannot read properties of undefined (reading 'id')" + stack in the CMS error log). A guest gets 403.
 * Customers can therefore hit a 500 + ERROR-level log line at will (log/alert flooding), and any future
 * `versions` on orders/customers/settings would be readable by every customer.
 */
import { test, expect } from '../../fixtures.js';
import { signedInCustomer } from './helpers.js';

const PATHS = [
	'orders/versions?limit=1',
	'customers/versions?limit=1',
	'coupons/versions?limit=1',
	'users/versions?limit=1',
	'payment-events/versions?limit=1',
	'globals/store-settings/versions?limit=1'
];

test('a signed-in customer is refused (never a 500) on version history endpoints', async ({ stack, adminSession, unique }) => {
	const customer = await signedInCustomer({ stack, adminSession, unique });
	const got = {};
	for (const p of PATHS) {
		const r = await fetch(`${stack.sfUrl}/api/${p}`, { headers: customer.headers });
		got[p] = r.status;
	}
	expect(got).toEqual(Object.fromEntries(PATHS.map((p) => [p, 403])));
});
