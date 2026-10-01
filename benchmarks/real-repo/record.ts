import type { CrewScalingRecord } from '../crew-scaling/types.js';

/** Count container-side calls from lifecycle events, independent of the host edit gate. */
export function observedRepoTools(records: readonly CrewScalingRecord[]) {
  const callsByName: Record<string, number> = {};
  let unidentifiedCalls = 0;
  for (const record of records) {
    for (const agent of record.agentResults) {
      let named = 0;
      for (const call of agent.tools ?? []) {
        const name = call?.tool;
        if (typeof name !== 'string' || name.length === 0 || name === 'unknown') continue;
        callsByName[name] = (callsByName[name] ?? 0) + 1;
        named++;
      }
      unidentifiedCalls += Math.max(0, (agent.toolCalls ?? 0) - named);
    }
  }
  return {
    callsByName,
    writeAttempts: (callsByName.repo_write ?? 0) + (callsByName.repo_edit ?? 0),
    unidentifiedCalls,
  };
}
