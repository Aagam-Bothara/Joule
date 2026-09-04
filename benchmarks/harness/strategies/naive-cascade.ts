import type { Strategy } from '../types.js';

/**
 * EcoAssistant-style hierarchy: run the whole task on the small model; if the
 * run does not complete, rerun the whole task on the large model.
 * Escalation signal = system-observable failure (no scorer).
 */
export const naiveCascade: Strategy = { name: 'naive-cascade', modes: ['slm-only', 'llm-only'], escalateOn: 'failure', description: 'Whole-task cascade on failure (EcoAssistant-style)' };
