/**
 * Main Application Component
 * Layout shell with sidebar navigation and content views
 */

import { useState } from 'react';
import {
  FileSearch,
  RefreshCw,
  Settings,
  FileText,
  Cloud,
  Server
} from 'lucide-react';

// Views
import { ConfigPanel } from './components/ConfigPanel';
import { AuthStatus } from './components/AuthStatus';
import { ChangeList } from './components/ChangeList';
import { SyncPanel } from './components/SyncPanel';
import { LogViewer } from './components/LogViewer';
import { UpdatePanel } from './components/UpdatePanel';

type ViewType = 'changes' | 'sync' | 'config' | 'logs' | 'updates';

interface NavItem {
  id: ViewType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { id: 'changes', label: 'Changes', icon: FileSearch },
  { id: 'sync', label: 'Sync', icon: RefreshCw },
  { id: 'config', label: 'Config', icon: Settings },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'updates', label: 'Updates', icon: Cloud },
];

function App() {
  const [currentView, setCurrentView] = useState<ViewType>('config');
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);

  const handleSelectionChange = (tokens: string[]) => {
    setSelectedTokens(tokens);
  };

  const renderView = () => {
    switch (currentView) {
      case 'changes':
        return (
          <div className="space-y-4">
            <AuthStatus />
            <ChangeList
              selectedTokens={selectedTokens}
              onSelectionChange={handleSelectionChange}
            />
          </div>
        );
      case 'sync':
        return <SyncPanel />;
      case 'config':
        return <ConfigPanel />;
      case 'logs':
        return <LogViewer />;
      case 'updates':
        return <UpdatePanel />;
      default:
        return <ConfigPanel />;
    }
  };

  return (
    <div className="h-screen w-screen overflow-hidden bg-bg-base text-text-primary">
      {/* Layout Grid */}
      <div
        className="h-full w-full"
        style={{
          display: 'grid',
          gridTemplateColumns: '200px 1fr',
          gridTemplateRows: '48px 1fr',
        }}
      >
        {/* Top Bar */}
        <div className="col-start-1 col-end-3 row-start-1 row-end-2 border-b border-border-subtle bg-bg-elevated flex items-center px-4">
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-accent" />
            <h1 className="text-lg font-medium">Feishu Sync</h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-text-tertiary">v0.1.0</span>
          </div>
        </div>

        {/* Sidebar Navigation */}
        <div className="col-start-1 col-end-2 row-start-2 row-end-3 border-r border-border-subtle bg-bg-base flex flex-col">
          <nav className="flex-1 p-2 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentView === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => setCurrentView(item.id)}
                  className={`
                    w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all duration-fast
                    ${isActive
                      ? 'bg-accent-subtle text-accent'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    }
                  `}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Main Content Area */}
        <div className="col-start-2 col-end-3 row-start-2 row-end-3 min-w-0 min-h-0 overflow-auto">
          <div className="p-6 max-w-4xl mx-auto">
            {renderView()}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
