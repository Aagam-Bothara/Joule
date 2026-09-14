import type { Strategy } from '../types.js';

/**
 * Ablations: Joule adaptive with exactly one design choice removed. Each maps
 * to one policy switch; everything else (engine, tools, prompts, ladder) is
 * identical to `joule-adaptive`, so the difference is the choice itself.
 */

/** No consultations: every escalation is a handoff. Tests "consult before handoff". */
export const jouleNoConsult: Strategy = { name: 'joule-no-consult', modes: ['adaptive'], ladder: ['slm', 'llm'], policy: { maxConsultations: 0 }, description: 'Joule without consultations (handoff only)' };

/** Consultations return prose advice only (the pre-patch behaviour). Tests patch-mode consults. */
export const jouleAdvice: Strategy = { name: 'joule-advice', modes: ['adaptive'], ladder: ['slm', 'llm'], policy: { consultMode: 'advice' }, description: 'Joule with prose-only consultations' };

/** No step verification: no declared checks, no exit-code checks, no static checks. Tests "deterministic verification". */
export const jouleNoVerify: Strategy = { name: 'joule-no-verify', modes: ['adaptive'], ladder: ['slm', 'llm'], policy: { verification: 'none' }, description: 'Joule without the step verifier' };

/** The agent's self-reported confidence replaces the evidence-based composite. Tests "no self-reported confidence". */
export const jouleSelfConf: Strategy = { name: 'joule-self-conf', modes: ['adaptive'], ladder: ['slm', 'llm'], policy: { confidenceSource: 'self-report' }, description: 'Joule with self-reported confidence' };

/**
 * Ladder with the two repository fixes: a final answer needs a verified check
 * after the last edit, and each rung gets its own step allowance. Tests whether
 * the small model's silent failures (confident wrong fixes, aimless reading)
 * were what let the middle model alone pull ahead on SWE-bench.
 */
export const jouleLadderStrict: Strategy = { name: 'joule-ladder-strict', modes: ['adaptive'], ladder: ['slm', 'mid', 'llm'], policy: { finalAnswerRequires: 'verified', rungLocalSteps: true }, description: 'Joule ladder, verified finish and per-rung step budget' };

/** No compile check on written files. Tests the static-check evidence signal. */
export const jouleNoStatic: Strategy = { name: 'joule-no-static', modes: ['adaptive'], ladder: ['slm', 'llm'], policy: { staticChecks: false }, description: 'Joule without static checks' };
