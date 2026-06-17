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
    <Card variant="elevated">
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {getStatusIcon()}
          <h2 className="text-lg font-display font-medium text-text-primary">Feishu Authentication</h2>
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
        <div className="space-y-5">
          <div className="flex items-center justify-between py-2 border-b border-border-subtle">
            <span className="text-sm text-text-secondary">Status</span>
            <StatusBadge status={loading ? 'loading' : ready ? 'success' : 'error'} size="md">
              {loading ? 'Checking...' : ready ? 'Ready' : 'Not Ready'}
            </StatusBadge>
          </div>

          {authStatus?.larkCliVersion && ready && (
            <div className="flex items-center justify-between py-2 border-b border-border-subtle">
              <span className="text-sm text-text-secondary">lark-cli version</span>
              <span className="text-sm font-mono text-accent bg-accent/10 px-2 py-0.5 rounded">{authStatus.larkCliVersion}</span>
            </div>
          )}

          <div className="p-3 bg-bg-canvas rounded-md border border-border-subtle">
            <p className="text-sm text-text-primary leading-relaxed">{getHelpText()}</p>
          </div>

          {authStatus?.currentScopes && authStatus.currentScopes.length > 0 && (
            <div>
              <p className="text-xs text-text-secondary mb-2 uppercase tracking-wide">Granted Scopes</p>
              <div className="flex flex-wrap gap-2">
                {authStatus.currentScopes.map(scope => (
                  <span
                    key={scope}
                    className="px-2.5 py-1 text-xs bg-success/10 text-success border border-success/20 rounded-md font-mono"
                  >
                    {scope}
                  </span>
                ))}
              </div>
            </div>
          )}

          {authStatus?.missingScopes && authStatus.missingScopes.length > 0 && (
            <div>
              <p className="text-xs text-danger mb-2 uppercase tracking-wide">Missing Required Scopes</p>
              <div className="flex flex-wrap gap-2">
                {authStatus.missingScopes.map(scope => (
                  <span
                    key={scope}
                    className="px-2.5 py-1 text-xs bg-danger/10 text-danger border border-danger/20 rounded-md font-mono"
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
