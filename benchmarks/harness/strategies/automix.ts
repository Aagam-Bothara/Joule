import type { Strategy } from '../types.js';

/**
 * AutoMix-style: the small model answers, then verifies its own answer k times
 * (sampled at temperature); escalate the whole task to the large model on a
 * majority "no". The escalation signal is model self-verification, which is
 * exactly what Joule's confidence engine refuses to trust.
 */
export const automix: Strategy = { name: 'automix', modes: ['slm-only', 'llm-only'], escalateOn: 'self-verify', description: 'Whole-task cascade on self-verification (AutoMix-style)' };
