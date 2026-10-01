import { describe, it, expect } from 'vitest';
import { historyWindow } from '../src/adaptive/step-agent.js';
import { renderConsultation } from '../src/adaptive/execution-state.js';
import type { ChatMessage, ConsultationRequest } from '@joule/shared';

// User and assistant turns alternate, starting with the task message.
const convo = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, content: `m${i}` }));

describe('historyWindow', () => {
  it('returns short histories unchanged', () => {
    const m = convo(10);
    expect(historyWindow(m, 24)).toBe(m);
  });

  it('stays within the window and keeps the first message and the latest turn', () => {
    for (let n = 25; n <= 80; n++) {
      const w = historyWindow(convo(n), 24);
      expect(w.length).toBeLessThanOrEqual(24);
      expect(w.length).toBeGreaterThanOrEqual(12);
      expect(w[0].content).toBe('m0');
      expect(w[1].role).toBe('user');
      expect(w[w.length - 1].content).toBe(`m${n - 1}`);
    }
  });

  it('keeps the sent prefix unchanged across most turns so prompt caches hit', () => {
    // Each turn appends an assistant reply and a user observation.
    let stable = 0;
    let turns = 0;
    for (let n = 25; n <= 79; n += 2) {
      const before = historyWindow(convo(n), 24);
      const after = historyWindow(convo(n + 2), 24);
      turns++;
      if (before.every((m, i) => after[i]?.content === m.content)) stable++;
    }
    // A window sliding one turn at a time would never keep the prefix.
    expect(stable / turns).toBeGreaterThan(0.8);
  });
});

describe('renderConsultation', () => {
  const req: ConsultationRequest = {
    consultId: 'c1',
    goal: 'fix the parser',
    question: 'Should the tokenizer or the grammar change?',
    relevantEvidence: [],
    hypotheses: [],
    attemptedSolutions: [],
    constraints: ['no network access'],
    maxTokens: 300,
    files: [{ path: 'parser.py', content: 'def parse(s):\n    return s' }],
  };

  it('puts the question after the material so repeated consults share a prefix', () => {
    const a = renderConsultation(req);
    const b = renderConsultation({ ...req, consultId: 'c2', question: 'Is the fix in parse() enough?' });
    const q = a.indexOf('QUESTION');
    expect(a.startsWith('GOAL')).toBe(true);
    expect(a.indexOf('CONSTRAINTS')).toBeLessThan(q);
    expect(a.indexOf('CURRENT FILES')).toBeLessThan(q);
    expect(b.startsWith(a.slice(0, q))).toBe(true);
  });
});
