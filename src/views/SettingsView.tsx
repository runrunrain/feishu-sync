/**
 * SettingsView
 *
 * 两层导航布局（2026-07-24 重构，解决子卡片平铺拉得过长的问题）：
 *   第一层 = 顶部水平 tab（知识库与同步 / 模型与通道 / 飞书认证 / 应用）
 *   第二层 = 组内左侧侧栏，把每个分组的独立子卡片拆成独立项，点哪个看哪个。
 *
 * 之前所有卡片在一个长 `space-y-6` 列表里垂直堆叠，"模型与通道" 这种
 * 多卡 + 嵌套子面板的分组会拉得非常长。现在侧栏只列该分组的卡片，
 * 右侧同一时刻只显示一张卡片；访问过的卡片保持挂载以保留草稿，
 * 侧栏与内容区各自在自己视口里独立滚动。
 *
 * 窄屏策略（按用户明确选择）：侧栏始终常驻显示，不折叠。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  BookOpen,
  CloudUpload,
  Database,
  FolderArchive,
  FolderTree,
  ImageIcon,
  Info,
  KeyRound,
  PenLine,
  Puzzle,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Save,
} from 'lucide-react';
import { SettingsDraftProvider, useSettingsDraft } from '../hooks/settingsDraft';
import { Button } from '../components/common/Button';
import { KnowledgeSettingsCard } from '../components/KnowledgeSettingsCard';
import { WatchedRootsCard } from '../components/WatchedRootsCard';
import { OrphanFilesCard } from '../components/OrphanFilesCard';
import { SyncBlocklistCard } from '../components/SyncBlocklistCard';
import { CustomArchiveSettingsCard } from '../components/CustomArchiveSettingsCard';
import { SyncMediaSettingsCard } from '../components/SyncMediaSettingsCard';
import { ModelProviderSettings } from '../components/ModelProviderSettings';
import { ModelDefaultsSettings } from '../components/ModelDefaultsSettings';
import { AuthSettingsCard } from '../components/AuthSettingsCard';
import { AppUpdateCard } from '../components/AppUpdateCard';
import { AgentPluginsCard } from '../components/agent/AgentPluginsCard';
import { AgentRuntimeSettingsCard, AgentKbSettingsCard } from '../components/agent/AgentSettingsCard';
import { CliAccessSettingsCard } from '../components/CliAccessSettingsCard';
import { FeishuWriteSettingsCard } from '../components/FeishuWriteSettingsCard';
import { FeishuPublishSettingsCard } from '../components/FeishuPublishSettingsCard';

type SettingsTab = 'knowledge' | 'models' | 'agent' | 'auth' | 'application';

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
        label: '同步根目录',
        description: '飞书同步根 URL 与本地目录',
        icon: FolderTree,
        render: () => <WatchedRootsCard />,
      },
      {
        id: 'kb-sync-media',
        label: '同步媒体选项',
        description: '幻灯片整页截图与白板矢量导出的采集开关',
        icon: ImageIcon,
        render: () => <SyncMediaSettingsCard />,
      },
      {
        id: 'kb-orphan-files',
        label: '孤立文件清理',
        description: '已移除同步根残留的本地同步产物，一键回收到 .trash-bin',
        icon: Trash2,
        render: () => <OrphanFilesCard />,
      },
      {
        id: 'kb-sync-blocklist',
        label: '同步屏蔽名单',
        description: '查看屏蔽文档，多选移出后恢复检测与同步',
        icon: ShieldCheck,
        render: () => <SyncBlocklistCard />,
      },
      {
        id: 'kb-custom-archive',
        label: '自定义归档',
        description: '快捷添加的零散云文档与分类文件夹管理',
        icon: FolderArchive,
        render: () => <CustomArchiveSettingsCard />,
      },
    ],
  },
  {
    id: 'models',
    label: '服务提供商与模型',
    description: '应用模型提供商与模型预设，供 Agent 与文档整理使用',
    icon: Sparkles,
    items: [
      {
        id: 'md-provider',
        label: '模型提供商与预设',
        description: 'Chat Completions、Responses、Anthropic 与模型预设',
        icon: Server,
        render: () => <ModelProviderSettings />,
      },
      {
        id: 'md-defaults',
        label: '默认模型与文档整理',
        description: '应用默认提供商、模型预设与同步整理',
        icon: Settings,
        render: () => <ModelDefaultsSettings />,
      },
    ],
  },
  {
    id: 'agent',
    label: 'Agent 标准库',
    description: 'Pi / Claude Code 运行时、模型来源、标准库目录、Workspace 与 MCP',
    icon: Bot,
    items: [
      {
        id: 'agent-runtime',
        label: '运行时与模型',
        description: 'Node、Pi / Claude Code 路径、模型来源与思考档位',
        icon: Bot,
        render: () => <AgentRuntimeSettingsCard />,
      },
      {
        id: 'agent-plugins',
        label: '应用插件',
        description: 'Pi包安装、启停与内置插件配置',
        icon: Puzzle,
        render: () => <AgentPluginsCard />,
      },
      {
        id: 'agent-kb',
        label: '标准库与 Workspace',
        description: '输出目录、Work 授权目录与 MCP 连接片段',
        icon: Server,
        render: () => <AgentKbSettingsCard />,
      },
    ],
  },
  {
    id: 'auth',
    label: '飞书认证',
    description: 'lark-cli 登录状态、权限范围、文档写入与反向发布授权',
    icon: ShieldCheck,
    items: [
      {
        id: 'auth-status',
        label: '飞书认证',
        description: 'lark-cli 登录状态与权限范围',
        icon: KeyRound,
        render: () => <AuthSettingsCard />,
      },
      {
        id: 'auth-feishu-write',
        label: '飞书写入',
        description: '写回飞书开关与文档写入权限增量授权（S13）',
        icon: PenLine,
        render: () => <FeishuWriteSettingsCard />,
      },
      {
        id: 'auth-feishu-publish',
        label: '飞书发布',
        description: '反向发布开关与发布根校验（P1-S9）',
        icon: CloudUpload,
        render: () => <FeishuPublishSettingsCard />,
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
      {
        id: 'app-cli',
        label: '命令行访问',
        description: '终端调用 feishu-sync 命令：开关、令牌轮换与 feishu-sync 入口生成',
        icon: Terminal,
        render: () => <CliAccessSettingsCard />,
      },
    ],
  },
];

const VISIBLE_SETTINGS_TABS = SETTINGS_TABS;

interface SettingsViewProps {
  /**
   * 请求聚焦到指定分组（如 TopBar「新版本」徽标 → 'application'）。
   * 仅在值变化时生效一次：不持续锁定，用户随后可自由切换。
   */
  focusTabId?: SettingsTab;
  /** 触发信号（时间戳或随机计数），支持在相同 tabId 下重复触发聚焦 */
  focusNonce?: number;
}

export function SettingsView({ focusTabId, focusNonce }: SettingsViewProps) {
  return <SettingsDraftProvider><SettingsContent focusTabId={focusTabId} focusNonce={focusNonce} /></SettingsDraftProvider>;
}

function SettingsContent({ focusTabId, focusNonce }: SettingsViewProps) {
  const draft = useSettingsDraft()!;
  const [activeTab, setActiveTab] = useState<SettingsTab>('knowledge');
  const currentTabMeta = VISIBLE_SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? VISIBLE_SETTINGS_TABS[0];

  useEffect(() => {
    if (focusTabId && VISIBLE_SETTINGS_TABS.some((t) => t.id === focusTabId)) {
      setActiveTab(focusTabId);
    }
  }, [focusTabId, focusNonce]);

  // 第二层导航：当前选中的侧栏项。切 tab 时重置为该分组的第一项。
  const [activeSubId, setActiveSubId] = useState<string>(currentTabMeta.items[0].id);
  const [visited, setVisited] = useState(() => new Set([currentTabMeta.items[0].id]));
  useEffect(() => {
    // 切分组时回到该分组第一个侧栏项。
    setActiveSubId(currentTabMeta.items[0].id);
  }, [currentTabMeta]);

  const currentSub = useMemo(
    () => currentTabMeta.items.find((item) => item.id === activeSubId) ?? currentTabMeta.items[0],
    [currentTabMeta, activeSubId],
  );
  useEffect(() => { setVisited((prev) => prev.has(currentSub.id) ? prev : new Set([...prev, currentSub.id])); }, [currentSub.id]);

  // 切侧栏项时把右侧内容滚回顶部（内容区独立滚动，不继承外层位置）。
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeSubId]);

  const TabIcon = currentTabMeta.icon;

  return (
    <div className="max-w-6xl space-y-3">
      <div className="border-b border-line pb-2">
        <h1
          className="text-xl text-ink leading-tight"
          style={{ fontFamily: 'var(--kai)', fontWeight: 500 }}
        >
          设置
        </h1>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">{currentTabMeta.description}</p>
      </div>

      {/* 分类导航在窄窗口换行，避免入口移出可见范围。 */}
      <div
        className="flex flex-wrap gap-1 rounded-md border border-line bg-paper/60 p-1"
        role="tablist"
        aria-label="设置分类"
      >
        {VISIBLE_SETTINGS_TABS.map((tab) => {
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
              disabled={draft.saving}
              onClick={() => { draft.stageForm(currentSub.id); setActiveTab(tab.id); }}
              className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1.5 text-xs leading-5 transition-colors ${
                selected
                  ? 'bg-card-bg text-seal shadow-sm'
                  : 'text-ink-soft hover:bg-paper-2 hover:text-ink'
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {tab.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2 px-1">
          {draft.dirty ? <span className="text-xs text-ink-faint">有未保存的修改</span> : null}
          {draft.saveMessage ? <span role="status" className="text-xs text-jade">{draft.saveMessage}</span> : null}
          <Button size="sm" loading={draft.saving} disabled={draft.loading || !draft.config} onClick={() => void draft.save()}><Save className="h-3.5 w-3.5" />保存</Button>
        </div>
      </div>
      {draft.saveError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-seal-2">
        <span>保存失败：{draft.saveError}。修改仍保留，可修正后重试。</span>
        {draft.conflict ? <Button size="sm" variant="secondary" loading={draft.saving} onClick={() => void draft.allowConflictOverwrite()}>允许下次保存覆盖该列表</Button> : null}
      </div> : null}

      {/* 多项分组使用子导航，窄窗口放在内容上方。 */}
      <fieldset disabled={draft.saving}>
      <section
        id={`settings-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
        className="flex flex-col gap-3 md:flex-row"
      >
        {currentTabMeta.items.length > 1 ? <aside
          className="flex w-full shrink-0 self-start flex-col md:w-44 rounded-md border border-line bg-paper-2/60 p-2"
          aria-label={`${currentTabMeta.label} 子项`}
        >
          {/* 侧栏头部：当前分组 + 图标，让侧栏自带语境 */}
          <div className="hidden md:flex items-center gap-2 px-2 py-2 text-xs font-medium text-ink-faint font-serif">
            <TabIcon className="h-3.5 w-3.5" />
            <span className="truncate">{currentTabMeta.label}</span>
          </div>

          {/* 侧栏项列表：溢出时在自己视口内滚 */}
          <nav
            className="flex flex-wrap gap-1 md:flex-col"
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
                  onClick={() => { draft.stageForm(currentSub.id); setActiveSubId(item.id); }}
                  title={item.description}
                  className={`flex items-center gap-1.5 rounded px-2.5 py-1.5 text-left text-xs leading-5 transition-colors ${
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
        </aside> : null}

        {/* 桌面内容独立滚动；窄窗口随页面滚动。 */}
        <div
          ref={contentRef}
          className="flex-1 min-w-0 md:max-h-[calc(100dvh-180px)] md:overflow-y-auto scrollbar-thin md:pr-1"
        >
          {VISIBLE_SETTINGS_TABS.flatMap((tab) => tab.items).filter((item) => visited.has(item.id)).map((item) => (
            <div key={item.id} hidden={currentSub.id !== item.id}>{item.render()}</div>
          ))}
        </div>
      </section>
      </fieldset>
    </div>
  );
}
