/**
 * SettingsView
 *
 * 两层导航布局（2026-07-24 重构，解决子卡片平铺拉得过长的问题）：
 *   第一层 = 顶部水平 tab（知识库与同步 / 模型与通道 / 飞书认证 / 应用）
 *   第二层 = 组内左侧侧栏，把每个分组的独立子卡片拆成独立项，点哪个看哪个。
 *
 * 之前所有卡片在一个长 `space-y-6` 列表里垂直堆叠，"模型与通道" 这种
 * 多卡 + 嵌套子面板的分组会拉得非常长。现在侧栏只列该分组的卡片，
 * 右侧内容区同一时刻只渲染一张卡片，侧栏与内容区各自在自己视口里独立滚动。
 *
 * 窄屏策略（按用户明确选择）：侧栏始终常驻显示，不折叠。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  Database,
  FolderTree,
  Info,
  KeyRound,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { KnowledgeSettingsCard } from '../components/KnowledgeSettingsCard';
import { WatchedRootsCard } from '../components/WatchedRootsCard';
import { ModelProviderSettings } from '../components/ModelProviderSettings';
import { LLMChannelSwitcher } from '../components/LLMChannelSwitcher';
import { AuthSettingsCard } from '../components/AuthSettingsCard';
import { AppUpdateCard } from '../components/AppUpdateCard';

type SettingsTab = 'knowledge' | 'models' | 'auth' | 'application';

/** 第二层导航：一个侧栏项 = 一张独立子卡片 */
interface SettingsSubItem {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  render: () => React.ReactNode;
}

interface SettingsTabMeta {
  id: SettingsTab;
  label: string;
  description: string;
  icon: LucideIcon;
  /** 该分组下的侧栏项（子卡片）。顺序即侧栏自上而下的展示顺序。 */
  items: SettingsSubItem[];
}

const SETTINGS_TABS: SettingsTabMeta[] = [
  {
    id: 'knowledge',
    label: '知识库与同步',
    description: '本地知识库、轮询与同步根目录',
    icon: BookOpen,
    items: [
      {
        id: 'kb-base',
        label: '知识库设置',
        description: '本地根目录、轮询间隔与 lark-cli 路径',
        icon: Database,
        render: () => <KnowledgeSettingsCard />,
      },
      {
        id: 'kb-roots',
        label: '同步根目录与布局',
        description: '飞书同步根 URL、本地目录与布局',
        icon: FolderTree,
        render: () => <WatchedRootsCard />,
      },
    ],
  },
  {
    id: 'models',
    label: '模型与通道',
    description: '提供商、模型预设与无头执行器',
    icon: Sparkles,
    items: [
      {
        id: 'md-provider',
        label: '模型提供商与预设',
        description: 'direct / Claude Code 两套端点与模型别名',
        icon: Server,
        render: () => <ModelProviderSettings />,
      },
      {
        id: 'md-channel',
        label: '文档整理通道',
        description: '通道切换、远程模型与无头执行器',
        icon: Sparkles,
        render: () => <LLMChannelSwitcher />,
      },
    ],
  },
  {
    id: 'auth',
    label: '飞书认证',
    description: 'lark-cli 登录状态与权限范围',
    icon: ShieldCheck,
    items: [
      {
        id: 'auth-status',
        label: '飞书认证',
        description: 'lark-cli 登录状态与权限范围',
        icon: KeyRound,
        render: () => <AuthSettingsCard />,
      },
    ],
  },
  {
    id: 'application',
    label: '应用',
    description: '更新、自启动与通知',
    icon: Settings,
    items: [
      {
        id: 'app-about',
        label: '关于与更新',
        description: '版本、更新、自启动与通知',
        icon: Info,
        render: () => <AppUpdateCard />,
      },
    ],
  },
];

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('knowledge');
  const currentTabMeta = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];

  // 第二层导航：当前选中的侧栏项。切 tab 时重置为该分组的第一项。
  const [activeSubId, setActiveSubId] = useState<string>(currentTabMeta.items[0].id);
  useEffect(() => {
    // 切分组时回到该分组第一个侧栏项。
    setActiveSubId(currentTabMeta.items[0].id);
  }, [currentTabMeta]);

  const currentSub = useMemo(
    () => currentTabMeta.items.find((item) => item.id === activeSubId) ?? currentTabMeta.items[0],
    [currentTabMeta, activeSubId],
  );

  // 切侧栏项时把右侧内容滚回顶部（内容区独立滚动，不继承外层位置）。
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeSubId]);

  const TabIcon = currentTabMeta.icon;
  const SubIcon = currentSub.icon;

  return (
    <div className="max-w-6xl space-y-4">
      <div className="border-b border-line pb-3">
        <h1
          className="text-xl text-ink leading-tight"
          style={{ fontFamily: 'var(--kai)', fontWeight: 500 }}
        >
          设置
        </h1>
        <p className="mt-2 text-sm text-ink-soft">{currentTabMeta.description}</p>
      </div>

      {/* 第一层：顶部水平 tab 栏（保留原视觉，仅作分组切换） */}
      <div
        className="flex gap-1 overflow-x-auto rounded-md border border-line bg-paper/60 p-1"
        role="tablist"
        aria-label="设置分类"
      >
        {SETTINGS_TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`settings-panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex min-w-max items-center gap-2 rounded px-3 py-2 text-sm transition-colors ${
                selected
                  ? 'bg-card-bg text-seal shadow-sm'
                  : 'text-ink-soft hover:bg-paper-2 hover:text-ink'
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 第二层 + 内容：左侧侧栏（子卡片列表） + 右侧单卡渲染。
          两者各自在自己视口内独立滚动，避免整页被拉长。 */}
      <section
        id={`settings-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
        className="flex gap-4"
      >
        <aside
          className="flex w-52 shrink-0 flex-col rounded-md border border-line bg-paper-2/60 p-2"
          aria-label={`${currentTabMeta.label} 子项`}
        >
          {/* 侧栏头部：当前分组 + 图标，让侧栏自带语境 */}
          <div className="flex items-center gap-2 px-2 py-2 text-xs font-medium text-ink-faint font-serif">
            <TabIcon className="h-3.5 w-3.5" />
            <span className="truncate">{currentTabMeta.label}</span>
          </div>

          {/* 侧栏项列表：溢出时在自己视口内滚 */}
          <nav
            className="flex flex-1 flex-col gap-1 overflow-y-auto scrollbar-thin"
            role="tablist"
          >
            {currentTabMeta.items.map((item) => {
              const Icon = item.icon;
              const selected = item.id === activeSubId;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveSubId(item.id)}
                  title={item.description}
                  className={`flex items-center gap-2 rounded px-2.5 py-2 text-left text-sm transition-colors ${
                    selected
                      ? 'bg-card-bg text-seal shadow-sm'
                      : 'text-ink-soft hover:bg-paper hover:text-ink'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* 右侧内容区：同一时刻只渲染当前选中的那张卡片。
            max-h 限定让内容在自己视口内滚，不把整页拉长。
            约 100dvh - TopBar(52) - 页面 padding(32) - 标题区(约72) - tab栏(约52) ≈ 160px+。 */}
        <div
          ref={contentRef}
          className="flex-1 min-w-0 overflow-y-auto scrollbar-thin pr-1"
          style={{ maxHeight: 'calc(100dvh - 168px)' }}
        >
          <div className="mb-3 flex items-center gap-2 text-sm text-ink-soft">
            <SubIcon className="h-4 w-4 text-seal" />
            <span className="font-medium text-ink">{currentSub.label}</span>
            <span className="text-ink-faint">·</span>
            <span className="truncate font-serif">{currentSub.description}</span>
          </div>
          {currentSub.render()}
        </div>
      </section>
    </div>
  );
}
