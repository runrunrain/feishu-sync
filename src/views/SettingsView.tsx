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

export function SettingsView() {
  return (
    <div className="space-y-6 max-w-5xl">
      {/*
        设置区布局重构（2026-06-19）：
        - space-y-3→space-y-6：四张卡片之间建立 24px 主区节奏
        - max-w-5xl (1024px)：设置区是表单型，比 Dashboard/SyncView 更窄更聚焦
          （04 §11.3：设置区单列卡片 max-w-4xl；这里取 1024px 兼顾卡片内部 grid）
        - 顶部介绍卡去掉冗余 Card 包装（与 KnowledgeSettingsCard 重复卡片），改用
          纯文字标题区，作为整个设置区的一个清晰的视觉锚点
      */}
      <div className="pb-3 border-b border-line">
        <h1 className="text-xl text-ink leading-tight" style={{ fontFamily: 'var(--kai)', fontWeight: 500 }}>设置</h1>
        <p className="mt-2 text-sm text-ink-soft">
          知识库 · 轮询 · LLM 通道 · 认证 · 应用更新
        </p>
      </div>

      <KnowledgeSettingsCard />
      <LLMChannelSwitcher />
      <AuthSettingsCard />
      <AppUpdateCard />
    </div>
  );
}
