/* Frozen pre-CMS catalog (tests/fixtures/legacy, written once by
 * `node scripts/legacy-to-snapshot.mjs freeze` before the adapters existed). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const LEGACY_DIR = path.join(ROOT, 'tests/fixtures/legacy');
export const SNAPSHOT_PATH = path.join(ROOT, 'src/lib/data/cms-snapshot.json');
export const DRAFTS_PATH = path.join(ROOT, 'src/lib/data/policy-drafts.server.json');

export const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const legacy = (name) => readJSON(path.join(LEGACY_DIR, name + '.json'));

/** A fresh deep copy of the committed snapshot, safe to mutate in a test. */
export const snapshotCopy = () => readJSON(SNAPSHOT_PATH);

/** A fresh deep copy of the committed policy drafts (CMS seed input). */
export const draftsCopy = () => readJSON(DRAFTS_PATH);
