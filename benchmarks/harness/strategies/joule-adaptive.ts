import type { Strategy } from '../types.js';

/** Joule: SLM-first step agent with the escalation policy (continue / consult / handoff / abort). */
export const jouleAdaptive: Strategy = { name: 'joule-adaptive', modes: ['adaptive'], ladder: ['slm', 'llm'], description: 'Trajectory-level escalation, two tiers (Joule)' };
