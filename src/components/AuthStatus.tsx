/**
 * Auth Status Component
 * Displays Feishu authentication readiness with guidance for issues
 */

import { RefreshCw, CheckCircle, AlertCircle, XCircle } from 'lucide-react';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { StatusBadge } from './common/StatusBadge';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';

export function AuthStatus() {
  const { authStatus, loading, ready, error, refresh } = useAuthStatus();

  const getStatusIcon = () => {
    if (loading) return null;
    if (ready) return <CheckCircle className="w-5 h-5 text-success" />;
    if (error) return <XCircle className="w-5 h-5 text-error" />;
    return <AlertCircle className="w-5 h-5 text-warning" />;
  };

  const getHelpText = () => {
    if (loading) return 'Checking authentication status...';
    if (ready) {
      return `Authenticated with lark-cli ${authStatus?.larkCliVersion || 'unknown'}`;
    }
    if (!authStatus) return 'Unable to check authentication status';

    // Specific guidance based on error
    const errorMsg = error || authStatus.error || '';
    if (errorMsg.includes('not installed') || errorMsg.includes('not found')) {
      return 'lark-cli is not installed. Run: npm install -g lark-cli';
    }
    if (errorMsg.includes('not authenticated') || errorMsg.includes('not logged in')) {
      return 'Not authenticated with Feishu. Run: lark-cli auth login --scope';
    }
    if (errorMsg.includes('scope') || errorMsg.includes('permission')) {
      return `Missing required permissions: ${authStatus.missingScopes?.join(', ') || 'unknown'}. Run: lark-cli auth login --scope`;
    }
    if (errorMsg.includes('expired') || errorMsg.includes('token')) {
      return 'Authentication expired. Run: lark-cli auth login --scope';
    }
    return errorMsg || 'Authentication check failed';
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <h2 className="text-lg font-medium">Feishu Authentication</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          loading={loading}
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </CardHeader>
      <CardBody>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Status</span>
            <StatusBadge status={loading ? 'loading' : ready ? 'success' : 'error'}>
              {loading ? 'Checking...' : ready ? 'Ready' : 'Not Ready'}
            </StatusBadge>
          </div>

          {authStatus?.larkCliVersion && ready && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">lark-cli version</span>
              <span className="text-sm text-text-primary font-mono">{authStatus.larkCliVersion}</span>
            </div>
          )}

          <div className="pt-2 border-t border-border-subtle">
            <p className="text-sm text-text-primary">{getHelpText()}</p>
          </div>

          {authStatus?.currentScopes && authStatus.currentScopes.length > 0 && (
            <div className="pt-2 border-t border-border-subtle">
              <p className="text-xs text-text-secondary mb-1">Granted scopes:</p>
              <div className="flex flex-wrap gap-1">
                {authStatus.currentScopes.map(scope => (
                  <span
                    key={scope}
                    className="px-2 py-0.5 text-xs bg-bg-surface text-text-secondary rounded"
                  >
                    {scope}
                  </span>
                ))}
              </div>
            </div>
          )}

          {authStatus?.missingScopes && authStatus.missingScopes.length > 0 && (
            <div className="pt-2 border-t border-border-subtle">
              <p className="text-xs text-error mb-1">Missing required scopes:</p>
              <div className="flex flex-wrap gap-1">
                {authStatus.missingScopes.map(scope => (
                  <span
                    key={scope}
                    className="px-2 py-0.5 text-xs bg-error/10 text-error rounded"
                  >
                    {scope}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
