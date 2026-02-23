import { useState, useEffect } from 'react';
import { fetchTools } from '../api/client.ts';

export function useTools() {
  const [tools, setTools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTools()
      .then(data => { setTools(data.tools ?? []); setError(null); })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed'))
      .finally(() => setLoading(false));
  }, []);

  return { tools, loading, error };
}
