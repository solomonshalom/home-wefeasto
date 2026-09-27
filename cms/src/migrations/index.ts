import * as migration_20260926_221514_init from './20260926_221514_init';
import * as migration_20260926_230743_orders_revision from './20260926_230743_orders_revision';

export const migrations = [
  {
    up: migration_20260926_221514_init.up,
    down: migration_20260926_221514_init.down,
    name: '20260926_221514_init',
  },
  {
    up: migration_20260926_230743_orders_revision.up,
    down: migration_20260926_230743_orders_revision.down,
    name: '20260926_230743_orders_revision'
  },
];
