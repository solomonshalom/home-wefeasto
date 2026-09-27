/* Shared by stack.setup.js / stack.teardown.js (not a spec). */
import path from 'node:path';
import { parseSlot } from '../../scripts/e2e/config.mjs';

export const slotFromEnv = () => parseSlot(process.env.E2E_SLOT, 0);
/** Present while a Playwright run owns (started) the slot's stack. */
export const OWNER_MARKER = (cfg) => path.join(cfg.dir, 'playwright-owner.json');
