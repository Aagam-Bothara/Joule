import React, { useState, useEffect } from 'react';

const styles = {
  container: { display: 'flex', minHeight: '100vh' } as React.CSSProperties,
  sidebar: { width: 220, background: '#111118', borderRight: '1px solid #222', padding: '20px 0', flexShrink: 0, display: 'flex', flexDirection: 'column' as const } as React.CSSProperties,
  sidebarCollapsed: { display: 'none' } as React.CSSProperties,
  logo: { padding: '0 20px 20px', fontSize: 20, fontWeight: 700, color: '#4ecdc4', borderBottom: '1px solid #222' } as React.CSSProperties,
  nav: { padding: '16px 0', flex: 1 } as React.CSSProperties,
  navItem: { display: 'block', padding: '10px 20px', color: '#999', textDecoration: 'none', cursor: 'pointer', border: 'none', background: 'none', width: '100%', textAlign: 'left' as const, fontSize: 14 } as React.CSSProperties,
  navItemActive: { color: '#4ecdc4', background: '#1a1a2e' } as React.CSSProperties,
  main: { flex: 1, padding: 24, overflow: 'auto' } as React.CSSProperties,
  hamburger: { position: 'fixed' as const, top: 12, left: 12, zIndex: 1000, background: '#111118', border: '1px solid #333', borderRadius: 6, color: '#4ecdc4', fontSize: 20, width: 36, height: 36, cursor: 'pointer', display: 'none', alignItems: 'center', justifyContent: 'center' } as React.CSSProperties,
  version: { padding: '16px 20px', fontSize: 11, color: '#555', borderTop: '1px solid #222' } as React.CSSProperties,
};

interface LayoutProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  children: React.ReactNode;
}

const pages = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'stream', label: 'Live Stream' },
  { id: 'channels', label: 'Channels' },
  { id: 'tools', label: 'Tools' },
  { id: 'analytics', label: 'Analytics' },
];

export function Layout({ currentPage, onNavigate, children }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const checkWidth = () => {
      const narrow = window.innerWidth < 768;
      setIsNarrow(narrow);
      if (narrow) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
      }
    };

    checkWidth();
    window.addEventListener('resize', checkWidth);
    return () => window.removeEventListener('resize', checkWidth);
  }, []);

  const handleNavigate = (page: string) => {
    onNavigate(page);
    if (isNarrow) {
      setCollapsed(true);
    }
  };

  const sidebarStyle = collapsed
    ? { ...styles.sidebar, ...styles.sidebarCollapsed }
    : styles.sidebar;

  const hamburgerStyle = isNarrow
    ? { ...styles.hamburger, display: 'flex' }
    : styles.hamburger;

  return (
    <div style={styles.container}>
      <button
        style={hamburgerStyle}
        onClick={() => setCollapsed(!collapsed)}
        aria-label="Toggle sidebar"
      >
        {collapsed ? '\u2630' : '\u2715'}
      </button>
      <aside style={sidebarStyle}>
        <div style={styles.logo}>Joule</div>
        <nav style={styles.nav}>
          {pages.map(p => (
            <button
              key={p.id}
              style={{ ...styles.navItem, ...(currentPage === p.id ? styles.navItemActive : {}) }}
              onClick={() => handleNavigate(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <div style={styles.version}>v0.5.0</div>
      </aside>
      <main style={styles.main}>{children}</main>
    </div>
  );
}
