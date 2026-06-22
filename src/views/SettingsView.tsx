/**
 * SettingsView - 设置主区（T2/T7/T8，04 §4.3）
 *
 * P4-2 完整版：五张子卡。
 *   - KnowledgeSettingsCard（知识库根目录 + 轮询 + lark-cli 路径，B4 配合）
 *   - WatchedRootsCard（v0.2.0 structure-align Phase D / D4：watchedRoots 状态面板）
 *   - LLMChannelSwitcher（bigmodel 通道切换 + 共用配置 + 通道连通性测试）
 *   - AuthSettingsCard（lark-cli 状态 + scope 列表 + 重检）
 *   - AppUpdateCard（版本号 + 检查更新 + 自启动 + 通知开关）
 *
 * v0.2.0 structure-align Phase D (D4)：新增 WatchedRootsCard 作为独立的
 * watchedRoots 状态面板，与 KnowledgeSettingsCard 形成"配置 + 状态"分层：
 *   - KnowledgeSettingsCard 仍管理 watchedRootUrls 输入列表（URL 字符串）
 *   - WatchedRootsCard 显示每个 URL 的状态（synced/missing_in_db/error）+ childCount
 *   两者共享 useConfig（修改 watchedRootUrls 后两边都更新）。
 */

import { KnowledgeSettingsCard } from '../components/KnowledgeSettingsCard';
import { WatchedRootsCard } from '../components/WatchedRootsCard';
import { LLMChannelSwitcher } from '../components/LLMChannelSwitcher';
import { AuthSettingsCard } from '../components/AuthSettingsCard';
import { AppUpdateCard } from '../components/AppUpdateCard';

export function SettingsView() {
  return (
    <div className="space-y-6 max-w-5xl">
      <div className="pb-3 border-b border-line">
        <h1 className="text-xl text-ink leading-tight" style={{ fontFamily: 'var(--kai)', fontWeight: 500 }}>设置</h1>
        <p className="mt-2 text-sm text-ink-soft">
          知识库 · watchedRoots · LLM 通道 · 认证 · 应用更新
        </p>
      </div>

      <KnowledgeSettingsCard />
      <WatchedRootsCard />
      <LLMChannelSwitcher />
      <AuthSettingsCard />
      <AppUpdateCard />
    </div>
  );
}
