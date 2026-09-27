/*
 * HUNT data-cms (wave 5, round 2): an admin Save of a customer from a page opened a moment earlier writes the
 * whole stale form back over what the customer did meanwhile.
 *
 * Customers → a customer → the form carries every field: `_verified` (the admin "Verified" checkbox), name, phone,
 * addresses, marketingOptIn. Payload's update merges that form over the live row, and Customers has no guard for
 * a form that is behind the live document (Orders has `revision`, Subscribers keep their consent server-owned). So:
 *   - the owner opens a new customer's record (e.g. the customer phoned about a typo in their name) before the
 *     customer clicks the link in their verification email; the customer verifies; the owner saves the name fix
 *     → `_verified: false` is written back: the customer is locked out ("Please verify your email before logging
 *     in"), and the one-time link they used is spent;
 *   - a signed-in customer adds a delivery address on /account while the owner has the record open → the owner's
 *     Save deletes it (the stale form has `addresses: 0`).
 *
 * Correct behaviour: saving a name change keeps the verification and the addresses the customer has now (a stale
 * form is refused, or only the fields the admin changed are written).
 */
import { test, expect } from '../../fixtures.js';
import { createCustomer, sfApi, PASSWORD } from '../../accounts/helpers.js';
import { signedInCustomer } from './helpers.js';

async function adminLogin(page, stack) {
	await page.goto(`${stack.cmsUrl}/admin/login`);
	await page.locator('#field-email').fill(stack.admin.email);
	await page.locator('#field-password').fill(stack.admin.password);
	await page.locator('button[type=submit]').click();
	await page.waitForURL(/\/admin(?!\/login)/, { timeout: 30_000 });
}

/** Opens the customer's admin page, runs `meanwhile`, then changes the name and clicks Save (→ the PATCH status). */
async function staleNameFix(page, stack, id, meanwhile) {
	await adminLogin(page, stack);
	await page.goto(`${stack.cmsUrl}/admin/collections/customers/${id}`);
	const name = page.locator('#field-name');
	await name.waitFor({ timeout: 30_000 });
	await meanwhile();
	await name.fill('Asha K. Kumar');
	const saved = page.waitForResponse((r) => r.url().includes(`/api/customers/${id}`) && r.request().method() === 'PATCH', { timeout: 20_000 });
	await page.getByRole('button', { name: 'Save' }).click();
	return (await saved).status();
}

test('the owner fixes a new customer\'s name while they verify their email: they stay verified and can log in', async ({ page, stack, mailpit, unique, admin }) => {
	test.setTimeout(90_000);
	const c = await createCustomer({ stack, mailpit, unique }, { verify: false, tag: 'w5stale' });
	const { id } = await admin.findCustomer(c.email);
	const status = await staleNameFix(page, stack, id, async () => {
		const token = new URL(c.verifyUrl).searchParams.get('verify');
		const v = await sfApi(stack, 'POST', `customers/verify/${encodeURIComponent(token)}`);
		expect(v.status, v.text.slice(0, 200)).toBe(200);
		expect((await admin.findCustomer(c.email))._verified).toBe(true);
	});
	expect(status).toBe(200);
	const after = await admin.findCustomer(c.email);
	expect(after.name).toBe('Asha K. Kumar');
	expect(after._verified, 'the Save must not un-verify the customer').toBe(true);
	const login = await sfApi(stack, 'POST', 'customers/login', { email: c.email, password: PASSWORD });
	expect(login.status, `customer login after the owner's Save: ${login.text.slice(0, 200)}`).toBe(200);
});

test('a delivery address the customer saves while the owner has their record open survives the owner\'s Save', async ({ page, stack, adminSession, unique, admin }) => {
	test.setTimeout(90_000);
	const c = await signedInCustomer({ stack, adminSession, unique }, { tag: 'w5addr' });
	const address = { label: 'Home', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001', isDefault: true };
	const status = await staleNameFix(page, stack, c.id, async () => {
		const res = await fetch(`${stack.sfUrl}/api/customers/${c.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', ...c.headers },
			body: JSON.stringify({ addresses: [address] })
		});
		expect(res.status, (await res.text()).slice(0, 200)).toBe(200);
		expect((await admin.findCustomer(c.email)).addresses).toHaveLength(1);
	});
	expect(status).toBe(200);
	const after = await admin.findCustomer(c.email);
	expect(after.name).toBe('Asha K. Kumar');
	expect(after.addresses, "the customer's saved address after the owner's Save").toMatchObject([{ line1: '12 MG Road', pin: '560001' }]);
});
