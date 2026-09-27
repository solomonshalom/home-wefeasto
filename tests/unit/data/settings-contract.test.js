/*
 * The snapshot's settings contract and the shared commerce module
 * ($shared/settings.js, used by the CMS and the pricing rules) must agree on
 * every key and default — this fails as soon as either side drifts.
 */
import { describe, it, expect } from 'vitest';
import * as shared from '$shared/settings.js';
import { PUBLIC_SETTINGS_DEFAULTS, SERVER_ONLY_SETTINGS_DEFAULTS, validateSnapshot } from '$lib/data/snapshot-schema.js';
import { settings } from '$lib/data/settings.js';
import { snapshotCopy } from './fixtures.js';

describe('snapshot settings ⇔ $shared/settings.js', () => {
	it('public defaults are identical (keys, nesting, values, order)', () => {
		expect(PUBLIC_SETTINGS_DEFAULTS).toStrictEqual(shared.PUBLIC_SETTINGS_DEFAULTS);
		expect(JSON.stringify(PUBLIC_SETTINGS_DEFAULTS)).toBe(JSON.stringify(shared.PUBLIC_SETTINGS_DEFAULTS));
	});

	it('server-only defaults are identical', () => {
		expect(SERVER_ONLY_SETTINGS_DEFAULTS).toStrictEqual(shared.SERVER_SETTINGS_DEFAULTS);
	});

	it('the CMS serialiser publicSettings() returns the snapshot settings unchanged', () => {
		expect(shared.publicSettings(settings)).toStrictEqual(snapshotCopy().settings);
	});

	it('publicSettings() of the full CMS global (server keys included) yields a valid snapshot.settings', () => {
		const global = { ...snapshotCopy().settings, reservationMinutes: 45, blockedPinPrefixes: ['110'], codBlockedPinPrefixes: [], codMaxOpenPerPhone: 3 };
		const s = snapshotCopy();
		s.settings = shared.publicSettings(global);
		expect(validateSnapshot(s)).toEqual({ ok: true, errors: [] });
	});
});
