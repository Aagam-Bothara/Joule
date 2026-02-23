import { useState, useEffect, useCallback } from 'react';
import { fetchTasks, fetchTask } from '../api/client.ts';

export function useTasks() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchTasks();
      setTasks(data.tasks ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { tasks, loading, error, refresh };
}

export function useTask(id: string | null) {
  const [task, setTask] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetchTask(id)
      .then(data => { setTask(data); setError(null); })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed'))
      .finally(() => setLoading(false));
  }, [id]);

  return { task, loading, error };
}
