/**
 * SettingsView - 设置主区（T2，04 §4.3）
 *
 * 本 Task（P4-1）：建占位框架 = AuthSettingsCard（复用现有 AuthStatus）+
 * AppUpdateCard（复用现有 UpdatePanel）+ 占位卡片。完整 KnowledgeSettingsCard /
 * LLMChannelSwitcher（P3 集成）/ ChannelConnectivityTester 留 P4-2。
 *
 * 文案中文化（T14）：复用现有组件，但本视图标题与子卡标题统一中文。
 */

import { ConfigPanel } from '../components/ConfigPanel';
import { AuthStatus } from '../components/AuthStatus';
import { UpdatePanel } from '../components/UpdatePanel';
import { Card, CardBody } from '../components/common/Card';

export function SettingsView() {
  return (
    <div className="space-y-3">
      <Card variant="default">
        <CardBody>
          <h2 className="text-base font-kai font-medium text-ink mb-1">设置</h2>
          <p className="text-xs text-ink-soft">
            知识库 · 轮询 · LLM 通道 · 认证 · 应用更新
          </p>
        </CardBody>
      </Card>

      {/* Knowledge + LLM (P3 集成未完，复用现有 ConfigPanel 占位) */}
      <ConfigPanel />

      {/* Auth */}
      <AuthStatus />

      {/* Update */}
      <UpdatePanel />
    </div>
  );
}
