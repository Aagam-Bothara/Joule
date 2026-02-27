import React, { useState } from 'react';

interface CanvasViewerProps {
  html: string;
  title?: string;
  artifactId?: string;
  version?: number;
}

export const CanvasViewer: React.FC<CanvasViewerProps> = ({ html, title, artifactId, version }) => {
  const [expanded, setExpanded] = useState(false);

  const containerStyle: React.CSSProperties = {
    border: '1px solid #2a2a3e',
    borderRadius: 8,
    overflow: 'hidden',
    background: '#111118',
    marginTop: 12,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    background: '#1a1a2e',
    borderBottom: '1px solid #2a2a3e',
    fontSize: 13,
  };

  const iframeStyle: React.CSSProperties = {
    width: '100%',
    height: expanded ? '80vh' : 400,
    border: 'none',
    background: '#0f0f17',
  };

  const badgeStyle: React.CSSProperties = {
    background: '#4ecdc4',
    color: '#0a0a0f',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
  };

  const versionBadge: React.CSSProperties = {
    background: '#333',
    color: '#aaa',
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 500,
  };

  const btnStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid #444',
    color: '#aaa',
    padding: '4px 10px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={badgeStyle}>CANVAS</span>
          <span style={{ color: '#e0e0e0' }}>{title || 'Untitled'}</span>
          {version != null && version > 0 && (
            <span style={versionBadge}>v{version}</span>
          )}
          {artifactId && (
            <span style={{ color: '#666', fontSize: 11 }}>{artifactId}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={btnStyle} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
          <button
            style={btnStyle}
            onClick={() => {
              const blob = new Blob([html], { type: 'text/html' });
              const url = URL.createObjectURL(blob);
              window.open(url, '_blank');
            }}
          >
            Pop Out
          </button>
        </div>
      </div>
      <iframe
        srcDoc={html}
        sandbox="allow-scripts allow-forms"
        style={iframeStyle}
        title={title || 'Canvas'}
      />
    </div>
  );
};
