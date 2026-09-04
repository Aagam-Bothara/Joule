import type { Strategy } from '../types.js';

/** Step agent pinned to the middle rung (efficient large model). */
export const midOnly: Strategy = { name: 'mid-only', modes: ['mid-only'], description: 'Middle-rung model only' };
