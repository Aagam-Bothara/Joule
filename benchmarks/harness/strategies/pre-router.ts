import type { Strategy } from '../types.js';

/**
 * RouteLLM / Hybrid-LLM-style pre-routing: one cheap classification call
 * decides, before any work, whether the small model can handle the task.
 * The learned router is approximated by a small-model judgement.
 */
export const preRouter: Strategy = { name: 'pre-router', modes: ['slm-only', 'llm-only'], preRoute: true, description: 'Pre-route whole task by predicted difficulty (RouteLLM-style)' };
