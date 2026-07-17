/**
 * SettingsView - 设置主区（T2/T7/T8，04 §4.3）
 *
 * P4-2 完整版：五张子卡。
 *   - KnowledgeSettingsCard（知识库根目录 + 轮询 + lark-cli 路径，B4 配合）
 *   - WatchedRootsCard（P2：同步根目录、布局与状态）
 *   - LLMChannelSwitcher（bigmodel 通道切换 + 共用配置 + 通道连通性测试）
 *   - AuthSettingsCard（lark-cli 状态 + scope 列表 + 重检）
 *   - AppUpdateCard（版本号 + 检查更新 + 自启动 + 通知开关）
 *
 * P2：WatchedRootsCard 是 watchedRoots 的唯一配置入口，集中维护根 token、
 * URL、本地目录、布局 profile 与启用状态；KnowledgeSettingsCard 只维护
 * 知识库路径、轮询和 lark-cli 路径，避免 URL-only 编辑破坏路径契约。
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
