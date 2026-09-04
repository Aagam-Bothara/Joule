import type { Strategy } from '../types.js';

/** Joule with the three-rung ladder: small -> efficient -> frontier, climbing one rung on evidence. */
export const jouleLadder: Strategy = { name: 'joule-ladder', modes: ['adaptive'], ladder: ['slm', 'mid', 'llm'], description: 'Trajectory-level escalation over a three-rung ladder (Joule)' };
