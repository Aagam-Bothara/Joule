import type { Migration } from '../migrations.js';
import { migration001 } from './001-initial-schema.js';
import { migration002 } from './002-fts5-indexes.js';

export const allMigrations: Migration[] = [migration001, migration002];
