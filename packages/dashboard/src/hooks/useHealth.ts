import { useState, useEffect } from 'react';
import { fetchHealth } from '../api/client.ts';

export function useHealth() {
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null))
      .finally(() => setLoading(false));
  }, []);

  return { health, loading };
}
