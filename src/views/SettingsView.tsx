/**
 * SettingsView - 设置主区（T2/T7/T8，04 §4.3）
 *
 * P4-2 完整版：四张子卡。
 *   - KnowledgeSettingsCard（知识库 + 轮询 + lark-cli 路径，B4 配合）
 *   - LLMChannelSwitcher（bigmodel 通道切换 + 共用配置 + 通道连通性测试）
 *   - AuthSettingsCard（lark-cli 状态 + scope 列表 + 重检）
 *   - AppUpdateCard（版本号 + 检查更新 + 自启动 + 通知开关）
 *
 * 旧的 ConfigPanel/AuthStatus/UpdatePanel 三个组件被本视图的四张子卡取代。
 * 旧组件文件暂留（避免删依赖），不再被 SettingsView 引用。
 */

import { KnowledgeSettingsCard } from '../components/KnowledgeSettingsCard';
import { LLMChannelSwitcher } from '../components/LLMChannelSwitcher';
import { AuthSettingsCard } from '../components/AuthSettingsCard';
import { AppUpdateCard } from '../components/AppUpdateCard';
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

      <KnowledgeSettingsCard />
      <LLMChannelSwitcher />
      <AuthSettingsCard />
      <AppUpdateCard />
    </div>
  );
}
