import type { Migration } from '../migrations.js';
import { migration001 } from './001-initial-schema.js';

export const allMigrations: Migration[] = [migration001];
