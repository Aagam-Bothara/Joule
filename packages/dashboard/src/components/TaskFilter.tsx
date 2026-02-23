import React, { useState, useCallback } from 'react';

const styles = {
  container: { display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' as const, alignItems: 'center' } as React.CSSProperties,
  input: { flex: 1, minWidth: 200, padding: '8px 12px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#e0e0e0', fontSize: 14 } as React.CSSProperties,
  select: { padding: '8px 12px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#e0e0e0', fontSize: 14 } as React.CSSProperties,
};

export interface FilterState {
  search: string;
  status: string;
  sort: string;
}

interface TaskFilterProps {
  onFilterChange: (filter: FilterState) => void;
}

export function TaskFilter({ onFilterChange }: TaskFilterProps) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('newest');

  const emitChange = useCallback(
    (updates: Partial<FilterState>) => {
      const next: FilterState = {
        search: updates.search ?? search,
        status: updates.status ?? status,
        sort: updates.sort ?? sort,
      };
      onFilterChange(next);
    },
    [search, status, sort, onFilterChange],
  );

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    emitChange({ search: e.target.value });
  };

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatus(e.target.value);
    emitChange({ status: e.target.value });
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSort(e.target.value);
    emitChange({ sort: e.target.value });
  };

  return (
    <div style={styles.container}>
      <input
        style={styles.input}
        type="text"
        placeholder="Search tasks by ID or description..."
        value={search}
        onChange={handleSearchChange}
      />
      <select style={styles.select} value={status} onChange={handleStatusChange}>
        <option value="all">All Statuses</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="budget_exhausted">Budget Exhausted</option>
      </select>
      <select style={styles.select} value={sort} onChange={handleSortChange}>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="most_tokens">Most Tokens</option>
        <option value="least_tokens">Least Tokens</option>
      </select>
    </div>
  );
}
