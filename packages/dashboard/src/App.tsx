import React, { useState } from 'react';
import { Layout } from './components/Layout.tsx';
import { TaskList } from './pages/TaskList.tsx';
import { TaskDetail } from './pages/TaskDetail.tsx';
import { LiveStream } from './pages/LiveStream.tsx';
import { Analytics } from './pages/Analytics.tsx';
import { ChannelStatus } from './pages/ChannelStatus.tsx';

export function App() {
  const [page, setPage] = useState('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id);
    setPage('task-detail');
  };

  const renderPage = () => {
    switch (page) {
      case 'tasks':
        return <TaskList onSelectTask={handleSelectTask} />;
      case 'task-detail':
        return (
          <TaskDetail
            taskId={selectedTaskId}
            onBack={() => setPage('tasks')}
          />
        );
      case 'stream':
        return <LiveStream />;
      case 'channels':
        return <ChannelStatus />;
      case 'analytics':
        return <Analytics />;
      default:
        return <TaskList onSelectTask={handleSelectTask} />;
    }
  };

  return (
    <Layout currentPage={page} onNavigate={setPage}>
      {renderPage()}
    </Layout>
  );
}
