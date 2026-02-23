import { useState, useEffect } from 'react';
import { fetchChannelStatus } from '../api/client.ts';

export function useChannels() {
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchChannelStatus()
      .then(setChannels)
      .catch(() => setChannels([]))
      .finally(() => setLoading(false));
  }, []);

  const refresh = () => {
    setLoading(true);
    fetchChannelStatus()
      .then(setChannels)
      .catch(() => setChannels([]))
      .finally(() => setLoading(false));
  };

  return { channels, loading, refresh };
}
