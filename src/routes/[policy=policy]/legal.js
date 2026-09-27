/*
 * Legal display fields for the policy pages, from the public store settings
 * (snapshot `settings.legal`). Only fields the owner has set are shown; an
 * all-empty block is null, and then nothing renders. Pure (unit-tested).
 */
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** settings.legal.grievanceOfficer with only the fields that are set; null when none is. */
export function grievanceOfficer(legal) {
	const o = legal?.grievanceOfficer ?? {};
	const view = {
		name: text(o.name),
		designation: text(o.designation),
		email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(o.email)) ? text(o.email) : '',
		phone: text(o.phone)
	};
	return Object.values(view).some(Boolean) ? view : null;
}

/** Seller details for the hub/grievances (Consumer Protection (E-Commerce) Rules 2020): set fields only, or null. */
export function sellerDetails(legal) {
	const view = {
		entityName: text(legal?.entityName),
		address: text(legal?.address),
		fssaiLicence: /^\d{14}$/.test(text(legal?.fssaiLicence)) ? text(legal.fssaiLicence) : '',
		gstin: text(legal?.gstin)
	};
	return Object.values(view).some(Boolean) ? view : null;
}
