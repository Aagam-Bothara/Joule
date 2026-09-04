import type { Strategy } from '../types.js';

/** Legacy plan-then-execute pipeline with per-call complexity routing (Joule before adaptive execution). */
export const staticRouter: Strategy = { name: 'static-router', modes: ['static-router'], description: 'Plan-then-execute with per-call complexity routing' };
