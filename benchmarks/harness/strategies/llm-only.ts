import type { Strategy } from '../types.js';

/** Step agent pinned to the LLM tier. The quality ceiling and the cost ceiling. */
export const llmOnly: Strategy = { name: 'llm-only', modes: ['llm-only'], description: 'Large model only' };
