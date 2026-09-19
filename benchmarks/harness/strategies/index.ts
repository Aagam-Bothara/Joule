import { slmOnly } from './slm-only.js';
import { llmOnly } from './llm-only.js';
import { staticRouter } from './static-router.js';
import { naiveCascade } from './naive-cascade.js';
import { frugalCascade } from './frugal-cascade.js';
import { automix } from './automix.js';
import { preRouter } from './pre-router.js';
import { jouleAdaptive } from './joule-adaptive.js';
import { jouleLadder } from './joule-ladder.js';
import { midOnly } from './mid-only.js';
import { jouleNoConsult, jouleAdvice, jouleNoVerify, jouleSelfConf, jouleNoStatic, jouleLadderStrict, jouleRungLocal } from './ablations.js';
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
  'joule-ladder': jouleLadder,
  'mid-only': midOnly,
  'joule-no-consult': jouleNoConsult,
  'joule-advice': jouleAdvice,
  'joule-no-verify': jouleNoVerify,
  'joule-self-conf': jouleSelfConf,
  'joule-no-static': jouleNoStatic,
  'joule-ladder-strict': jouleLadderStrict,
  'joule-rung-local': jouleRungLocal,
};

/** The ablation set, in the order the README reports them. */
export const ABLATION_STRATEGIES: StrategyName[] = ['joule-adaptive', 'joule-no-consult', 'joule-advice', 'joule-no-verify', 'joule-self-conf', 'joule-no-static'];

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
