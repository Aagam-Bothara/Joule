import type { Migration } from '../migrations.js';
import { migration001 } from './001-initial-schema.js';
import { migration002 } from './002-fts5-indexes.js';
import { migration003 } from './003-vector-tables.js';
import { migration004 } from './004-response-cache.js';
import { migration005 } from './005-rate-limits.js';

export const allMigrations: Migration[] = [migration001, migration002, migration003, migration004, migration005];
