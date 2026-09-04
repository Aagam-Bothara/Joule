import type { Strategy } from '../types.js';

/**
 * FrugalGPT-style cascade: run the small model, score its answer with a cheap
 * scorer, and rerun the whole task on the large model when the score is low.
 * FrugalGPT trains a DistilBERT scorer; here the scorer is a single small-model
 * call with a 0-1 rubric, which is the same signal without the training step.
 */
export const frugalCascade: Strategy = { name: 'frugal-cascade', modes: ['slm-only', 'llm-only'], escalateOn: 'judge', description: 'Whole-task cascade on scorer verdict (FrugalGPT-style)' };
