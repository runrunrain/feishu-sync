/** Browser-only synthetic fixture for v2 build orchestration UI. No production
 * entry imports this file. Run Vite dev, open
 * /src/test-fixtures/kb-build-orchestration.html — all fetches are intercepted
 * in this page; it never calls a real server, never uses real model backends.
 * The leader-progress data below is HAND-WRITTEN MOCK DATA shaped exactly like
 * the integration contract (server/src/types/agent-knowledge.ts
 * LeaderRunProgressDto, GET /api/kb/builds/:id/leader). It is for layout and
 * interaction verification only and does not represent real model or
 * orchestration capability.
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '../components/common/Toast'
import { BuildOrchestrationSettings } from '../components/settings/BuildOrchestrationSettings'
import { KbBuildPanel, type BuildLogLine } from '../components/kb/KbBuildPanel'
import type { KbLeaderRunProgressDto, KbLeaderRunTaskDto } from '../types/agent'
import '../styles/index.css'

if (!(import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV) {
  throw new Error('This synthetic UI fixture is development-only')
}

// ---- mock state (switchable from the control bar) ------------------------
type Scene = 'running' | 'idle-reminded' | 'cancelling' | 'ended' | 'unavailable'
type HostState = 'installed' | 'not-installed' | 'unwired' | 'probe-error'
let scene: Scene = 'running'
let hostState: HostState = 'installed'
let buildStatus: 'running' | 'failed' | 'published' = 'running'
const t0 = Date.now()

let standardKb: Record<string, unknown> = {
  outputRoot: '/tmp/standard-kb',
  retainReleases: 3,
  buildBatchSize: 10,
  buildBatchWordBudget: 40_000,
  promptTimeoutMinutes: 15,
  buildTimeoutMinutes: 180,
  buildParallelism: 2,
  buildConcurrency: 4,
  buildRoles: { writer: { modelPresetId: 'glm-r', providerId: 'vp', thinking: 'high' }, reviewer: { modelPresetId: '' }, plannerEnabled: false },
  reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
  publishMode: 'confirm',
  orchestrationMode: 'pi-amagi',
  autoBuildAfterSync: false,
}

const config = {
  llm: {
    providers: [{
      id: 'vp', name: '示例智谱', enabled: true, apiKey: 'sk-mock',
      openAiCompatBaseUrl: 'https://api.example.com/v1', protocol: 'openai-completions',
      defaultModelId: 'glm-t',
      models: [
        { id: 'glm-t', name: 'GLM 文本', openAiModel: 'glm-4', enabled: true },
        { id: 'glm-r', name: 'GLM 推理', openAiModel: 'glm-4-plus', enabled: true, reasoning: true, thinkingLevels: ['off', 'low', 'high'] as Array<'off' | 'low' | 'high'> },
      ],
    }],
    activeProviderId: 'vp', activeModelId: 'glm-t', primaryChannel: 'direct',
    temperature: 0.2, apiKey: 'k', openAiCompatBaseUrl: 'https://x', model: 'm', fallbackOnFailure: false,
  },
  standardKb,
  pollIntervalMinutes: 30, knowledgeBaseRoot: '/tmp/kb', watchedRoots: [], watchedRootUrls: [],
  requiredScopes: [], enableAutoStart: false, enableNotifications: false,
}

function makeTask(over: Partial<KbLeaderRunTaskDto> = {}): KbLeaderRunTaskDto {
  return {
    nativeTaskId: 'b559b30e-0f40-45ea-b96e-84206aa65078',
    role: 'luban',
    parentTaskId: null,
    status: 'confirmed',
    execState: 'running',
    lastEventAt: new Date().toISOString(),
    ...over,
  }
}

/** Mock LeaderRunProgressDto（集成契约形状）。 */
function leaderProgressDto(): KbLeaderRunProgressDto {
  const tick = Math.floor((Date.now() - t0) / 2500)
  if (scene === 'ended') {
    return {
      buildId: BUILD_ID, orchestrationMode: 'pi-amagi', generation: 1,
      leader: { sessionId: 'sess-8f21c4aa9e', pid: null, resumeCapability: 'artifact' },
      tasks: [
        makeTask({ nativeTaskId: 'task-w-01', execState: 'done' }),
        makeTask({ nativeTaskId: 'task-r-01', role: 'diting', execState: 'done' }),
        makeTask({ nativeTaskId: 'task-w-03', execState: 'done', parentTaskId: 'task-w-01' }),
      ],
      rounds: { started: 7, ended: 7 },
      idle: { remindedAt: null, lastActivityAt: '2026-11-02T08:58:00Z' },
      publishRequest: { requestId: 'req-1', candidateRevision: 'rev-7f3a2b', summary: '8 篇候选（2 篇沿用）', accepted: true, status: 'accepted', decidedAt: '2026-11-02T08:59:00Z' },
      summary: { acceptedDocumentCount: 8, openBlockingCount: 0, activeAssignments: 0, queueReason: null, lastUsage: { inputTokens: 903_800, outputTokens: 121_600, at: '2026-11-02T08:58:30Z' }, cumulativeUsage: null },
      endedReason: 'published',
      termination: 'finished',
      skill: { path: '/data/agent/builds/b_202611020800_demo1/home/skills/kb-build/SKILL.md', revision: 'd41d8cd98f00b204e9800998ecf8427e' },
      eventCursor: { 'leader-rpc': 'evt-91', 'tool-service': 'ts-40' },
      updatedAt: '2026-11-02T08:59:01Z',
    }
  }
  if (scene === 'cancelling') {
    return {
      buildId: BUILD_ID, orchestrationMode: 'pi-amagi', generation: 1,
      leader: { sessionId: 'sess-8f21c4aa9e', pid: 4310, resumeCapability: 'session' },
      tasks: [
        makeTask({ nativeTaskId: 'task-w-01', execState: 'running' }),
        makeTask({ nativeTaskId: 'task-w-02', execState: 'queued', status: 'pending' }),
      ],
      rounds: { started: 6, ended: 5 },
      idle: { remindedAt: null, lastActivityAt: '2026-11-02T09:00:00Z' },
      publishRequest: null,
      summary: { acceptedDocumentCount: 3, openBlockingCount: 1, activeAssignments: 2, queueReason: '准入池满（writer 池 4）', lastUsage: { inputTokens: 30_100, outputTokens: 6_400, at: '2026-11-02T09:00:00Z' }, cumulativeUsage: null },
      endedReason: null,
      termination: 'cancelling',
      eventCursor: { 'leader-rpc': 'evt-60' },
      updatedAt: '2026-11-02T09:00:01Z',
    }
  }
  if (scene === 'idle-reminded') {
    return {
      buildId: BUILD_ID, orchestrationMode: 'pi-amagi', generation: 1,
      leader: { sessionId: 'sess-8f21c4aa9e', pid: 4310, resumeCapability: 'session' },
      tasks: [
        makeTask({ nativeTaskId: 'task-w-01', execState: 'done' }),
        makeTask({ nativeTaskId: 'task-w-02', execState: 'running' }),
        makeTask({ nativeTaskId: 'task-w-04', execState: 'queued', status: 'pending' }),
      ],
      rounds: { started: 5, ended: 4 },
      idle: { remindedAt: '2026-11-02T08:55:00Z', lastActivityAt: '2026-11-02T08:50:00Z' },
      publishRequest: null,
      summary: { acceptedDocumentCount: 4, openBlockingCount: 1, activeAssignments: 2, queueReason: null, lastUsage: { inputTokens: 45_200, outputTokens: 9_800, at: '2026-11-02T08:50:00Z' }, cumulativeUsage: null },
      endedReason: null,
      termination: 'none',
      eventCursor: { 'leader-rpc': 'evt-77' },
      updatedAt: '2026-11-02T08:55:01Z',
    }
  }
  return {
    buildId: BUILD_ID, orchestrationMode: 'pi-amagi', generation: 1,
    leader: { sessionId: 'sess-8f21c4aa9e', pid: 4310, resumeCapability: 'session' },
    tasks: [
      makeTask({ nativeTaskId: 'task-w-01', execState: 'running' }),
      makeTask({ nativeTaskId: 'task-w-02', execState: 'queued', status: 'pending' }),
      makeTask({ nativeTaskId: 'task-r-01', role: 'diting', execState: 'done' }),
      makeTask({ nativeTaskId: 'task-w-03', execState: 'running', parentTaskId: 'task-w-01' }),
      makeTask({ nativeTaskId: 'task-b-01', role: 'baize', execState: null, status: 'pending' }),
    ],
    rounds: { started: 3 + tick, ended: 2 + tick },
    idle: { remindedAt: null, lastActivityAt: new Date().toISOString() },
    publishRequest: null,
    summary: { acceptedDocumentCount: 5, openBlockingCount: 2, activeAssignments: 3, queueReason: null, lastUsage: { inputTokens: 12_400, outputTokens: 3_100, at: new Date().toISOString() }, cumulativeUsage: null },
    endedReason: null,
    termination: 'none',
    eventCursor: { 'leader-rpc': `evt-${42 + tick}` },
    updatedAt: new Date().toISOString(),
  }
}

function hostStatusDto() {
  if (hostState === 'unwired') {
    return { error: 'build_runtime_unavailable', message: '构建运行宿主未接线（服务端未完成集成）', orchestrationMode: 'legacy' }
  }
  if (hostState === 'probe-error') {
    return {
      orchestrationMode: 'pi-amagi',
      runtime: null,
      amagi: { pinnedVersion: '2.21.31', installed: false, version: null, installDir: null, contentHash: null, layout: null },
      probe: null,
      error: 'probe 执行失败：pi CLI 不可用（mock）',
    }
  }
  const installed = hostState === 'installed'
  return {
    orchestrationMode: (standardKb.orchestrationMode as string) ?? 'legacy',
    runtime: { nodePath: '/usr/local/bin/node', nodeVersion: null, piCliPath: '/usr/local/bin/pi', piVersion: '1.4.0' },
    amagi: installed
      ? { pinnedVersion: '2.21.31', installed: true, version: '2.21.31', installDir: '/data/agent/runtime-packages/amagi-pi@2.21.31', contentHash: '9c2f1a', layout: null }
      : { pinnedVersion: '2.21.31', installed: false, version: null, installDir: null, contentHash: null, layout: null },
    probe: {
      staticOk: true,
      fullyVerified: false,
      checks: [
        { id: 'extension-load', title: '扩展加载与工具白名单', kind: 'static', state: 'pass', detail: '' },
        { id: 'model-key-mapping', title: '模型密钥映射', kind: 'static', state: 'pass', detail: '' },
        { id: 'mcp-bridge', title: 'MCP 桥接调用', kind: 'measured', state: 'not-measured', detail: '待接入试验实测' },
        { id: 'cancel-residual', title: '取消残留清理', kind: 'measured', state: 'not-measured', detail: '待接入试验实测' },
      ],
    },
    error: null,
  }
}

const BUILD_ID = 'b_202611020800_demo1'
const buildDto = () => ({
  id: BUILD_ID,
  mode: 'incremental' as const,
  status: buildStatus,
  noChanges: false,
  baseReleaseId: null,
  releaseId: null,
  model: 'zhipuai/glm-5.3-flash',
  orchestrationMode: 'pi-amagi' as const,
  counts: { sourceTotal: 6, added: 2, changed: 1, removed: 0, docsWritten: 5, docsDeleted: 0 },
  progress: {
    batchIndex: 0, batchTotal: 0, stage: null,
    units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 },
    workers: [],
    images: { total: 0, described: 0, cached: 0, unavailable: 0 },
  },
  parallelism: 4,
  warnings: [],
  error: null,
  createdAt: '2026-11-02T08:00:00Z',
  startedAt: '2026-11-02T08:01:00Z',
  finishedAt: null,
})

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
  const json = (value: unknown, code = 200) =>
    new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } })

  if (path.endsWith('/api/config')) {
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
      if (body.standardKb && typeof body.standardKb === 'object') standardKb = { ...standardKb, ...(body.standardKb as Record<string, unknown>) }
      return json({ success: true, config: { ...config, standardKb } })
    }
    return json({ ...config, standardKb })
  }
  if (path.endsWith('/api/kb/build-runtime/install')) {
    if (hostState === 'unwired') return json({ error: 'build_runtime_unavailable', message: '构建运行宿主未接线（服务端未完成集成）' }, 503)
    const sourceDir = typeof body.sourceDir === 'string' ? body.sourceDir.trim() : ''
    if (sourceDir !== '' && !sourceDir.startsWith('/')) {
      return json({ error: 'invalid_request', message: 'sourceDir 必须是指向本地 amagi-pi 包根的绝对路径' }, 400)
    }
    await new Promise((resolve) => setTimeout(resolve, 800)) // 模拟安装耗时（mock）
    hostState = 'installed'
    return json({ installed: true, fresh: true, version: '2.21.31', installDir: '/data/agent/runtime-packages/amagi-pi@2.21.31', contentHash: '9c2f1a' })
  }
  if (path.endsWith('/api/kb/build-runtime')) {
    if (hostState === 'unwired') return json(hostStatusDto(), 503)
    return json(hostStatusDto())
  }
  if (path.endsWith(`/api/kb/builds/${BUILD_ID}/leader`)) {
    if (scene === 'unavailable') return json({ error: 'build_not_found', message: '构建不存在或非 Leader 监督构建' }, 404)
    return json(leaderProgressDto())
  }
  if (path.endsWith(`/api/kb/builds/${BUILD_ID}/orchestration`)) return json({ error: 'build_not_found' }, 404)
  if (path.endsWith(`/api/kb/builds/${BUILD_ID}`)) return json(buildDto())
  return json({ error: 'not_found' }, 404)
}

const LOGS: BuildLogLine[] = [
  { id: 1, kind: 'info', text: '[mock] Leader 会话启动（fixture 手写数据，非真实运行）' },
  { id: 2, kind: 'tool-start', text: 'task_submit · luban · 世界金字塔 · 地理与地图' },
  { id: 3, kind: 'assistant', text: '已按材料清单拆分主题，先派发写作与审查。' },
]

function ControlBar({ onBump }: { onBump: () => void }) {
  const btn = (active: boolean) =>
    `rounded px-2 py-1 text-[11px] border ${active ? 'border-seal/50 bg-seal/10 text-seal' : 'border-line text-ink-soft hover:bg-paper'}`
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-card-bg px-3 py-2">
      <span className="text-[11px] text-ink-faint">场景：</span>
      {([
        ['running', '监督中'],
        ['idle-reminded', '空闲提醒'],
        ['cancelling', '终止中'],
        ['ended', '已收束'],
        ['unavailable', 'leader 404'],
      ] as const).map(([item, label]) => (
        <button key={item} type="button" className={btn(scene === item)}
          onClick={() => {
            scene = item
            buildStatus = item === 'ended' ? 'published' : item === 'idle-reminded' ? 'failed' : 'running'
            onBump()
          }}>
          {label}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-line" />
      <span className="text-[11px] text-ink-faint">宿主：</span>
      {([
        ['installed', '已安装'],
        ['not-installed', '未安装'],
        ['unwired', '未接线'],
        ['probe-error', '探测失败'],
      ] as const).map(([item, label]) => (
        <button key={item} type="button" className={btn(hostState === item)}
          onClick={() => { hostState = item; onBump() }}>
          {label}
        </button>
      ))}
    </div>
  )
}

function App() {
  const [nonce, setNonce] = useState(0)
  return (
    <div className="min-h-screen bg-paper p-4 space-y-3">
      <header className="space-y-1">
        <h1 className="text-sm font-kai font-medium text-ink">v2 构建编排 · 隔离 UI 验证（mock 数据）</h1>
        <p className="text-[11px] text-ink-faint leading-snug">
          本页全部数据为手写 mock（fetch 已拦截，不连接真实服务端，不代表真实模型/编排能力）；
          leader 进度形状对齐集成契约 LeaderRunProgressDto。左：设置卡「编排模式」；右：构建侧栏 440px 形态。
        </p>
      </header>
      <ControlBar onBump={() => setNonce((value) => value + 1)} />
      <div className="flex flex-wrap gap-3 items-start">
        <div className="w-[520px] max-w-full shrink-0" key={`settings-${nonce}`}>
          <BuildOrchestrationSettings />
        </div>
        <div
          key={`panel-${nonce}`}
          className="w-[440px] max-w-full h-[760px] shrink-0 flex flex-col rounded-md border border-line bg-card-bg shadow-lg overflow-y-auto scrollbar-thin"
          data-testid="fixture-build-sidebar"
        >
          <div className="shrink-0 px-3 py-2 border-b border-line/60">
            <h3 className="text-sm font-kai text-ink">标准库构建 · 侧栏</h3>
          </div>
          <KbBuildPanel
            open
            build={buildDto() as Parameters<typeof KbBuildPanel>[0]['build']}
            issues={[]}
            logs={LOGS}
            onCollapse={() => undefined}
            onCancel={() => undefined}
            cancelling={false}
            layout="sidebar"
          />
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
)
