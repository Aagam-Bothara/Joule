import { Joule } from '@joule/core';
import type { ExecutionMode } from '@joule/shared';
import { MOCK_WORKLOADS, scriptedProvider } from '../workloads/mock.js';
import { STRATEGIES, MOCK_STRATEGIES } from '../strategies/index.js';
import { runStrategy } from './run-strategy.js';
import type { Strategy, StrategyName, TaskReport, Workload } from '../types.js';

/**
 * Mock runner: the real Joule engine, tools and prompts; only the model is
 * scripted. Deterministic and free — this is the harness's unit test.
 *
 * static-router is skipped here: its planner expects plan-format JSON, and the
 * mock scripts speak the step-agent action format. Use the live runner for it.
 */
export async function runMockBenchmarks(strategyNames: StrategyName[], taskIds?: string[]): Promise<TaskReport[]> {
  const workloads = taskIds ? MOCK_WORKLOADS.filter(w => taskIds.includes(w.id)) : MOCK_WORKLOADS;
  const reports: TaskReport[] = [];

  const createJoule = async (workload: Workload, _mode: ExecutionMode, _strategy: Strategy): Promise<Joule> => {
    const joule = new Joule({
      providers: { ollama: { enabled: false, baseUrl: 'http://localhost:11434', models: { slm: 'bench-slm' } } } as any,
      routing: {
        preferLocal: true,
        slmConfidenceThreshold: 0.6,
        complexityThreshold: 0.7,
        providerPriority: { slm: ['ollama'], llm: ['ollama'] },
        maxReplanDepth: 2,
      },
      logging: { level: 'error', traceOutput: 'memory' },
    });
    await joule.initialize();
    joule.providers.register(scriptedProvider(workload.scripts!) as any);
    for (const tool of workload.tools?.() ?? []) joule.registerTool(tool);
    return joule;
  };

  for (const workload of workloads) {
    for (const name of strategyNames) {
      if (!MOCK_STRATEGIES.includes(name)) continue;
      const report = await runStrategy(workload, STRATEGIES[name], createJoule);
      reports.push(report);
      process.stderr.write(`  ${workload.id.padEnd(16)} ${name.padEnd(15)} ${report.success ? 'ok  ' : 'FAIL'} $${report.cost.toFixed(4)}  c=${report.consultations} h=${report.handoffs}\n`);
    }
  }
  return reports;
}
