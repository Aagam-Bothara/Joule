import type { Strategy } from '../types.js';

/** Step agent pinned to the SLM tier. Never consults or hands off. */
export const slmOnly: Strategy = { name: 'slm-only', modes: ['slm-only'], description: 'Small model only' };
