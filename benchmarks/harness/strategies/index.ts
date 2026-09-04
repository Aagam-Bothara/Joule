import { slmOnly } from './slm-only.js';
import { llmOnly } from './llm-only.js';
import { staticRouter } from './static-router.js';
import { naiveCascade } from './naive-cascade.js';
import { frugalCascade } from './frugal-cascade.js';
import { automix } from './automix.js';
import { preRouter } from './pre-router.js';
import { jouleAdaptive } from './joule-adaptive.js';
import type { Strategy, StrategyName } from '../types.js';

export const STRATEGIES: Record<StrategyName, Strategy> = {
  'slm-only': slmOnly,
  'llm-only': llmOnly,
  'static-router': staticRouter,
  'naive-cascade': naiveCascade,
  'frugal-cascade': frugalCascade,
  'automix': automix,
  'pre-router': preRouter,
  'joule-adaptive': jouleAdaptive,
};

export const DEFAULT_STRATEGY_ORDER: StrategyName[] = [
  'slm-only',
  'llm-only',
  'static-router',
  'naive-cascade',
  'frugal-cascade',
  'automix',
  'pre-router',
  'joule-adaptive',
];

/** Strategies the mock runner can execute (no out-of-band model calls, action-format scripts). */
export const MOCK_STRATEGIES: StrategyName[] = ['slm-only', 'llm-only', 'naive-cascade', 'joule-adaptive'];
