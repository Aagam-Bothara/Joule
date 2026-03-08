import { useState, useEffect, useRef } from 'react';

export interface BudgetUpdate {
  agentId?: string;
  agentRole?: string;
  usage: Record<string, number>;
  timestamp: number;
}

export function useBudgetStream(taskId: string | null) {
  const [budgetUpdates, setBudgetUpdates] = useState<BudgetUpdate[]>([]);
  const [agentBudgets, setAgentBudgets] = useState<Map<string, BudgetUpdate>>(new Map());
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!taskId) {
      setBudgetUpdates([]);
      setAgentBudgets(new Map());
      return;
    }

    // Listen to SSE events for budget updates
    const eventSource = new EventSource(`/tasks/${taskId}/budget-stream`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => setConnected(true);

    eventSource.addEventListener('budget_update', (event) => {
      try {
        const data = JSON.parse(event.data) as BudgetUpdate;
        data.timestamp = Date.now();

        setBudgetUpdates(prev => [...prev, data]);

        if (data.agentId) {
          setAgentBudgets(prev => {
            const next = new Map(prev);
            next.set(data.agentId!, data);
            return next;
          });
        }
      } catch {
        // Ignore parse errors
      }
    });

    // Also listen to progress events which contain usage data
    eventSource.addEventListener('progress', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.usage) {
          const update: BudgetUpdate = {
            agentId: data.agentId,
            agentRole: data.agentRole,
            usage: data.usage,
            timestamp: Date.now(),
          };

          setBudgetUpdates(prev => [...prev, update]);

          if (data.agentId) {
            setAgentBudgets(prev => {
              const next = new Map(prev);
              next.set(data.agentId, update);
              return next;
            });
          }
        }
      } catch {
        // Ignore parse errors
      }
    });

    eventSource.onerror = () => {
      setConnected(false);
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
      setConnected(false);
    };
  }, [taskId]);

  return { budgetUpdates, agentBudgets, connected };
}
