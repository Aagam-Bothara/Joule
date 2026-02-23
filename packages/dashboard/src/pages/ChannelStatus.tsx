import React from 'react';
import { useChannels } from '../hooks/useChannels.ts';

const styles = {
  title: { fontSize: 24, fontWeight: 700, marginBottom: 24 } as React.CSSProperties,
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 } as React.CSSProperties,
  button: { padding: '8px 16px', background: '#333', border: 'none', borderRadius: 6, color: '#ccc', fontWeight: 600, cursor: 'pointer', fontSize: 14 } as React.CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 } as React.CSSProperties,
  card: { padding: 20, background: '#111118', borderRadius: 8, border: '1px solid #222', display: 'flex', flexDirection: 'column' as const, gap: 12 } as React.CSSProperties,
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } as React.CSSProperties,
  channelName: { fontSize: 16, fontWeight: 600, color: '#e0e0e0' } as React.CSSProperties,
  channelType: { fontSize: 12, color: '#666', textTransform: 'uppercase' as const } as React.CSSProperties,
  statusRow: { display: 'flex', alignItems: 'center', gap: 8 } as React.CSSProperties,
  statusText: { fontSize: 13, color: '#999' } as React.CSSProperties,
  messageCount: { fontSize: 13, color: '#888' } as React.CSSProperties,
  empty: { textAlign: 'center' as const, padding: 48, color: '#666' } as React.CSSProperties,
};

interface ChannelInfo {
  name: string;
  type: string;
  status: string;
  messageCount?: number;
}

const DEFAULT_CHANNELS: ChannelInfo[] = [
  { name: 'Slack', type: 'chat', status: 'not configured' },
  { name: 'Discord', type: 'chat', status: 'not configured' },
  { name: 'Telegram', type: 'chat', status: 'not configured' },
  { name: 'WhatsApp', type: 'messaging', status: 'not configured' },
  { name: 'Signal', type: 'messaging', status: 'not configured' },
  { name: 'Teams', type: 'chat', status: 'not configured' },
  { name: 'Email', type: 'email', status: 'not configured' },
  { name: 'Matrix', type: 'chat', status: 'not configured' },
  { name: 'IRC', type: 'chat', status: 'not configured' },
  { name: 'Twilio SMS', type: 'sms', status: 'not configured' },
  { name: 'Webhook', type: 'webhook', status: 'not configured' },
];

function StatusDot({ status }: { status: string }) {
  const isConnected = status === 'connected';
  const color = isConnected ? '#4ecdc4' : '#ff6b6b';
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="6" fill={color} />
    </svg>
  );
}

function mergeChannels(apiChannels: any[]): ChannelInfo[] {
  if (!apiChannels || apiChannels.length === 0) return DEFAULT_CHANNELS;

  const apiMap = new Map<string, any>();
  apiChannels.forEach((ch: any) => {
    apiMap.set(ch.name?.toLowerCase(), ch);
  });

  return DEFAULT_CHANNELS.map(def => {
    const match = apiMap.get(def.name.toLowerCase());
    if (match) {
      return {
        name: def.name,
        type: match.type || def.type,
        status: match.status || 'not configured',
        messageCount: match.messageCount,
      };
    }
    return def;
  });
}

export function ChannelStatus() {
  const { channels, loading, refresh } = useChannels();
  const displayChannels = mergeChannels(channels);

  if (loading) {
    return <div style={styles.empty}>Loading channels...</div>;
  }

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.title}>Channel Status</h1>
        <button onClick={refresh} style={styles.button}>Refresh</button>
      </div>

      <div style={styles.grid}>
        {displayChannels.map(ch => (
          <div key={ch.name} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={styles.channelName}>{ch.name}</span>
              <span style={styles.channelType}>{ch.type}</span>
            </div>
            <div style={styles.statusRow}>
              <StatusDot status={ch.status} />
              <span style={styles.statusText}>{ch.status}</span>
            </div>
            {ch.messageCount !== undefined && (
              <div style={styles.messageCount}>
                {ch.messageCount.toLocaleString()} messages
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
