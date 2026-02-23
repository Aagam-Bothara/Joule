import React from 'react';

const styles = {
  badge: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 12, background: '#1a2a1a', fontSize: 12, fontWeight: 500 } as React.CSSProperties,
  energy: { color: '#50fa7b' } as React.CSSProperties,
  carbon: { color: '#bd93f9' } as React.CSSProperties,
  separator: { color: '#333' } as React.CSSProperties,
};

interface EnergyBadgeProps {
  energyWh: number;
  carbonGrams?: number;
}

export function EnergyBadge({ energyWh, carbonGrams }: EnergyBadgeProps) {
  const formatEnergy = (wh: number) => {
    if (wh < 0.001) return `${(wh * 1000).toFixed(2)} mWh`;
    return `${wh.toFixed(4)} Wh`;
  };

  const formatCarbon = (g: number) => {
    if (g < 0.001) return `${(g * 1000).toFixed(2)} mg`;
    return `${g.toFixed(4)} g`;
  };

  return (
    <span style={styles.badge}>
      <span style={styles.energy}>{formatEnergy(energyWh)}</span>
      {carbonGrams !== undefined && (
        <>
          <span style={styles.separator}>|</span>
          <span style={styles.carbon}>{formatCarbon(carbonGrams)} CO2</span>
        </>
      )}
    </span>
  );
}
