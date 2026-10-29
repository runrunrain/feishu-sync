/**
 * KbPublishModal —— 反向发布流弹窗（P1-S9，设计 P1 §4.6 UI 段）。
 *
 * 四步发布流：选择（范围/勾选/force）→ 预览（计划行：标题/动作/阻断原因/
 * 警告/门控）→ 确认（按 plan.confirmRequired 输入 PUBLISH 或
 * OVERWRITE_PUBLISHED，输入不符禁用执行）→ 执行（服务端逐篇串行）→
 * 完成态（逐项结果 + 云端链接），完成后回调刷新发布徽标。
 *
 * 发布历史：kb_publications 全量行（时间/文档/状态/警告/错误/云端链接）。
 * 状态覆盖：计划加载失败、执行失败（含 plan 变化 409 重预览）、历史空态、
 * 门控未开（提示去向设置）——不渲染假数据。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CloudUpload,
  ExternalLink,
  History,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import { APIError, executeKbPublish, previewKbPublish } from '../../api/client';
import type { KbTreeNode } from '../../types/agent';
import type {
  KbPublicationRowDto,
  KbPublishPlanDto,
  KbPublishPlanItemDto,
  KbPublishRunResultDto,
} from '../../types/kb-publish';
import {
  countExecutableItems,
  describePublishGates,
  describePublishWarning,
  PUBLISH_ACTION_LABEL,
  PUBLISH_BLOCKED_REASON,
  PUBLISH_CONFIRM_HINT,
  publishTargetKindLabel,
} from '../../utils/kbPublish';
import { formatDateTime } from '../../utils/agentReadiness';
import { KbPublishStateBadge } from './KbPublishStateBadge';

export type KbPublishModalTab = 'publish' | 'history';
type PublishStep = 'select' | 'preview' | 'executing' | 'result';

interface DocEntry { path: string; title: string; }

export interface KbPublishModalProps {
  open: boolean;
  initialTab: KbPublishModalTab;
  onClose: () => void;
  nodes: KbTreeNode[];
  publications: KbPublicationRowDto[];
  publicationsLoading: boolean;
  /** 发布执行完成后刷新发布记录（树/详情徽标随之更新）。 */
  onPublicationsChanged: () => void;
  onJumpToSettings?: () => void;
}

export function KbPublishModal({
  open,
  initialTab,
  onClose,
  nodes,
  publications,
  publicationsLoading,
  onPublicationsChanged,
  onJumpToSettings,
}: KbPublishModalProps) {
  const toast = useToast();
  const [tab, setTab] = useState<KbPublishModalTab>(initialTab);
  const [step, setStep] = useState<PublishStep>('select');
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [force, setForce] = useState(false);
  const [plan, setPlan] = useState<KbPublishPlanDto | null>(null);
  const [previewOptions, setPreviewOptions] = useState<{ kbPaths?: string[]; force?: boolean } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [result, setResult] = useState<KbPublishRunResultDto | null>(null);
  const generationRef = useRef(0);

  const docEntries = useMemo<DocEntry[]>(() => {
    const out: DocEntry[] = [];
    const walk = (list: KbTreeNode[]): void => {
      for (const node of list) {
        if (node.type === 'doc') out.push({ path: node.path, title: node.title ?? node.name });
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
    return out;
  }, [nodes]);

  const titleByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of docEntries) map.set(entry.path, entry.title);
    for (const row of publications) {
      if (!map.has(row.kbPath)) map.set(row.kbPath, row.kbPath);
    }
    return map;
  }, [docEntries, publications]);

  const publicationByPath = useMemo(
    () => new Map(publications.map((row) => [row.kbPath, row])),
    [publications],
  );

  const effectiveChecked = useMemo(
    () => checked ?? new Set(docEntries.map((entry) => entry.path)),
    [checked, docEntries],
  );

  // 打开弹窗即复位流程状态（选择集默认全选；force/确认值/结果清空）。
  useEffect(() => {
    if (!open) return;
    generationRef.current += 1;
    setTab(initialTab);
    setStep('select');
    setScope('selected');
    setChecked(null);
    setForce(false);
    setPlan(null);
    setPreviewOptions(null);
    setError(null);
    setConfirmInput('');
    setResult(null);
    setPreviewing(false);
    return () => { generationRef.current += 1; };
  }, [open, initialTab]);

  const planOptions = useMemo(() => ({
    ...(scope === 'selected' ? { kbPaths: [...effectiveChecked] } : {}),
    ...(force ? { force: true } : {}),
  }), [scope, effectiveChecked, force]);

  const generatePreview = async () => {
    const generation = ++generationRef.current;
    setPreviewing(true);
    setError(null);
    try {
      const dto = await previewKbPublish(planOptions);
      if (generation !== generationRef.current) return;
      setPlan(dto);
      setPreviewOptions(planOptions);
      setConfirmInput('');
      setStep('preview');
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof APIError ? err.message : '发布计划生成失败');
    } finally {
      if (generation === generationRef.current) setPreviewing(false);
    }
  };

  const runPublish = async () => {
    if (!plan || !previewOptions || confirmInput.trim() !== plan.confirmRequired) return;
    const generation = generationRef.current;
    setStep('executing');
    setError(null);
    try {
      const run = await executeKbPublish({ ...previewOptions, confirm: confirmInput.trim(), planKey: plan.planKey });
      onPublicationsChanged();
      if (generation !== generationRef.current) return;
      setResult(run);
      setStep('result');
      const { created, updated, blocked, failed } = run.counts;
      toast.push({
        type: failed > 0 ? 'warning' : 'success',
        message: `发布完成：新建 ${created} · 更新 ${updated} · 阻断 ${blocked} · 失败 ${failed}`,
      });
    } catch (err) {
      if (generation !== generationRef.current) { onPublicationsChanged(); return; }
      // 计划变化/确认值失效等：回到预览位让用户重新预览（保留错误文案）。
      setStep('preview');
      setError(err instanceof APIError ? err.message : '发布执行失败');
    }
  };

  return (
    <Modal open={open} title="发布标准库到飞书" onClose={onClose} contentClassName="max-w-3xl">
      <div className="flex flex-wrap gap-2 border-b border-line pb-3 mb-3" role="tablist" aria-label="反向发布">
        <Button size="sm" role="tab" aria-selected={tab === 'publish'} variant={tab === 'publish' ? 'primary' : 'secondary'} onClick={() => setTab('publish')}>
          <CloudUpload className="w-3.5 h-3.5" /> 发布
        </Button>
        <Button size="sm" role="tab" aria-selected={tab === 'history'} variant={tab === 'history' ? 'primary' : 'secondary'} onClick={() => setTab('history')}>
          <History className="w-3.5 h-3.5" /> 发布历史
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" onClick={onClose}>关闭</Button>
      </div>

      {tab === 'publish' ? (
        step === 'select' ? (
          <div className="space-y-3 text-sm text-ink-soft" data-publish-step="select">
            <p className="leading-relaxed">
              把标准库文档发布为飞书云文档（在发布根下逐篇平铺创建）。发布前先生成只读计划：
              新建 / 更新 / 无变化 / 阻断逐项可见，确认后才写云端。
            </p>
            <fieldset className="space-y-1.5">
              <legend className="text-xs text-ink-faint">发布范围</legend>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="publish-scope" checked={scope === 'selected'} onChange={() => setScope('selected')} className="accent-[#9e2b25]" />
                勾选文档（{scope === 'selected' ? `${effectiveChecked.size}/${docEntries.length}` : `0/${docEntries.length}`}）
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="publish-scope" checked={scope === 'all'} onChange={() => setScope('all')} className="accent-[#9e2b25]" />
                全部文档（全量发布；已从标准库移除的路径将标记「已移除」，不会删除云端文档）
              </label>
            </fieldset>
            {scope === 'selected' ? (
              <div className="rounded border border-line">
                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-line text-xs">
                  <button type="button" className="text-seal underline" onClick={() => setChecked(new Set(docEntries.map((e) => e.path)))}>全选</button>
                  <button type="button" className="text-ink-faint underline" onClick={() => setChecked(new Set())}>清空</button>
                </div>
                <div className="max-h-52 overflow-auto scrollbar-thin p-1.5 space-y-0.5" role="listbox" aria-label="选择要发布的文档">
                  {docEntries.length === 0 ? <p className="p-2 text-xs text-ink-faint">标准库尚未发布或没有文档。</p> : docEntries.map((entry) => (
                    <label key={entry.path} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-paper cursor-pointer">
                      <input
                        type="checkbox"
                        checked={effectiveChecked.has(entry.path)}
                        onChange={(event) => setChecked((previous) => {
                          const base = previous ?? new Set(docEntries.map((e) => e.path));
                          const next = new Set(base);
                          if (event.target.checked) next.add(entry.path);
                          else next.delete(entry.path);
                          return next;
                        })}
                        className="accent-[#9e2b25]"
                      />
                      <span className="truncate text-xs text-ink flex-1">{entry.title}</span>
                      <KbPublishStateBadge state={publicationByPath.get(entry.path)?.state ?? ''} compact cloudUrl={publicationByPath.get(entry.path)?.cloudUrl ?? null} linkVariant="click" />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} className="mt-0.5 accent-[#9e2b25]" />
              <span className="leading-relaxed">
                解除「云端已被编辑」冲突并以覆盖方式发布
                <span className="block text-xs text-ink-faint">确认值将升级为 OVERWRITE_PUBLISHED；被他人修改过的云端文档会被本地内容覆盖</span>
              </span>
            </label>
            {error ? <p role="alert" className="text-xs text-seal-2">{error}</p> : null}
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="secondary" onClick={onClose}>取消</Button>
              <Button size="sm" onClick={() => void generatePreview()} loading={previewing}
                disabled={docEntries.length === 0 || (scope === 'selected' && effectiveChecked.size === 0)}>
                生成发布计划
              </Button>
            </div>
          </div>
        ) : step === 'preview' && plan ? (
          <div className="flex flex-col max-h-[calc(100dvh-230px)] min-h-0 gap-3 text-sm text-ink-soft" data-publish-step="preview">
            <div className="shrink-0"><PlanHeader plan={plan} /></div>
            {describePublishGates(plan.gates).length > 0 ? (
              <div className="shrink-0"><GatesNotice plan={plan} onJumpToSettings={onJumpToSettings} /></div>
            ) : null}
            <div className="min-h-0 shrink overflow-y-auto scrollbar-thin"><PlanItemsTable items={plan.items} /></div>
            {plan.removed.length > 0 ? (
              <p className="shrink-0 text-xs text-ink-faint leading-relaxed">
                将标记「已从标准库移除」（不执行任何云端动作）：{plan.removed.join('、')}
              </p>
            ) : null}
            {error ? <p role="alert" className="shrink-0 text-xs text-seal-2">{error}</p> : null}
            <div className="shrink-0">
              <ConfirmSection
                plan={plan}
                confirmInput={confirmInput}
                onConfirmInput={setConfirmInput}
                busy={false}
                onConfirm={() => void runPublish()}
                onRepreview={() => { setStep('select'); setError(null); }}
                onBack={onClose}
              />
            </div>
          </div>
        ) : step === 'executing' ? (
          <div className="py-10 flex flex-col items-center gap-3 text-sm text-ink-soft" data-publish-step="executing" aria-busy="true">
            <Loader2 className="w-6 h-6 animate-spin text-seal" />
            <p>正在逐篇发布到飞书…（服务端串行执行，文档较多时可能持续数分钟）</p>
          </div>
        ) : result ? (
          <div className="space-y-3 text-sm text-ink-soft" data-publish-step="result">
            <ResultSummary result={result} />
            <ul className="space-y-1.5 max-h-[calc(100dvh-330px)] overflow-y-auto scrollbar-thin">
              {result.items.map((item, index) => (
                <li key={`${item.kbPath}:${index}`} className="rounded border border-line px-3 py-2 flex flex-col gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-1.5 py-px rounded border border-line text-ink-soft">{PUBLISH_ACTION_LABEL[item.action]}{result.items.slice(0, index).some((prev) => prev.kbPath === item.kbPath) ? ' · 互链补写' : ''}</span>
                    <span className="text-xs text-ink flex-1 min-w-0 truncate" title={item.kbPath}>{titleByPath.get(item.kbPath) ?? item.kbPath}</span>
                    <KbPublishStateBadge state={item.state} showAllStates cloudUrl={item.cloudUrl} />
                  </div>
                  {item.error ? <p className="text-xs text-seal-2">{item.error}</p> : null}
                  {item.warnings.length > 0 ? (
                    <ul className="text-xs text-ink-faint list-disc pl-4">
                      {item.warnings.map((warning, i) => <li key={i}>{describePublishWarning(warning)}</li>)}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
            {result.removedMarked.length > 0 ? (
              <p className="text-xs text-ink-faint">已标记「已从标准库移除」：{result.removedMarked.join('、')}</p>
            ) : null}
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="secondary" onClick={() => { setStep('select'); setResult(null); setError(null); }}>再发布一批</Button>
              <Button size="sm" onClick={onClose}>完成</Button>
            </div>
          </div>
        ) : null
      ) : (
        <PublishHistoryList
          publications={publications}
          loading={publicationsLoading}
          titleByPath={titleByPath}
          onRefresh={onPublicationsChanged}
        />
      )}
    </Modal>
  );
}

function PlanHeader({ plan }: { plan: KbPublishPlanDto }) {
  return (
    <div className="text-xs text-ink-soft space-y-1">
      <p>发布版本：<span className="font-mono text-[10px] break-all">{plan.releaseId}</span></p>
      <p>
        发布根：
        {plan.target
          ? `${publishTargetKindLabel(plan.target.kind)} · ${plan.target.label}`
          : <span className="text-seal-2">未配置</span>}
      </p>
    </div>
  );
}

/** 门控未开时的去向提示（preview 只读可出计划，执行会被拒）。 */
function GatesNotice({ plan, onJumpToSettings }: { plan: KbPublishPlanDto; onJumpToSettings?: () => void }) {
  const problems = describePublishGates(plan.gates);
  if (problems.length === 0) return null;
  return (
    <div className="rounded-md border border-[#b8860b]/40 bg-[#b8860b]/5 p-3 space-y-1.5" data-testid="publish-gates">
      <p className="flex items-center gap-1.5 text-xs font-medium text-[#8a6508]"><AlertTriangle className="w-3.5 h-3.5" />以下条件未满足，暂不能执行发布：</p>
      <ul className="text-xs text-[#8a6508] list-disc pl-5 space-y-0.5">
        {problems.map((problem) => <li key={problem}>{problem}</li>)}
      </ul>
      {onJumpToSettings ? <Button size="sm" variant="secondary" onClick={onJumpToSettings}>前往设置</Button> : null}
    </div>
  );
}

export function PlanItemsTable({ items }: { items: KbPublishPlanItemDto[] }) {
  return (
    <div className="rounded border border-line divide-y divide-line" data-testid="publish-plan-items">
      {items.map((item) => (
        <div key={item.kbPath} className="px-3 py-2 flex flex-col gap-1" data-plan-action={item.action}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-1.5 py-px rounded border ${actionClasses(item.action)}`}>{PUBLISH_ACTION_LABEL[item.action]}</span>
            <span className="text-xs text-ink flex-1 min-w-0 truncate" title={item.kbPath}>{item.title}</span>
            {item.state ? <KbPublishStateBadge state={item.state} showAllStates compact cloudUrl={item.cloudUrl} linkVariant="click" /> : null}
            {item.cloudEdited ? <span className="text-[10px] text-seal-2 border border-seal-2/40 rounded px-1">云端有修改</span> : null}
          </div>
          {item.blockedReason ? (
            <p className="text-xs text-seal-2 leading-relaxed">{PUBLISH_BLOCKED_REASON[item.blockedReason]}</p>
          ) : null}
          {item.warnings.length > 0 ? (
            <details className="text-xs text-ink-faint">
              <summary className="cursor-pointer">{item.warnings.length} 条警告</summary>
              <ul className="list-disc pl-4 pt-0.5 space-y-0.5">
                {item.warnings.map((warning, i) => <li key={i}>{describePublishWarning(warning)}</li>)}
              </ul>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ConfirmSection({
  plan,
  confirmInput,
  onConfirmInput,
  busy,
  onConfirm,
  onRepreview,
  onBack,
}: {
  plan: KbPublishPlanDto;
  confirmInput: string;
  onConfirmInput: (value: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onRepreview: () => void;
  onBack: () => void;
}) {
  const gatesBlocked = describePublishGates(plan.gates).length > 0;
  const executable = countExecutableItems(plan.items);
  const matched = confirmInput.trim() === plan.confirmRequired;
  const overwrite = plan.confirmRequired === 'OVERWRITE_PUBLISHED';
  // 全 skip 但有待标记的 kb_removed 路径时仍可执行（removedMarked 需落账）。
  const nothingToDo = executable === 0 && plan.removed.length === 0;
  return (
    <div className="rounded-md border border-line bg-paper/40 p-3 space-y-2" data-testid="publish-confirm">
      <p className={`text-xs leading-relaxed ${overwrite ? 'text-seal-2' : 'text-ink-soft'}`}>
        {PUBLISH_CONFIRM_HINT[plan.confirmRequired]}
      </p>
      {overwrite ? (
        <p className="text-xs text-seal-2 leading-relaxed">
          将覆盖的云端文档：{plan.items.filter((item) => item.cloudEdited).map((item) => item.title).join('、') || '（无）'}
        </p>
      ) : null}
      <input
        value={confirmInput}
        onChange={(event) => onConfirmInput(event.target.value)}
        placeholder={plan.confirmRequired}
        aria-label="发布确认值"
        className="w-full h-8 px-3 text-xs font-mono rounded border border-line bg-card-bg text-ink placeholder:text-ink-faint focus:outline-none focus:border-seal/50"
        autoComplete="off"
        spellCheck={false}
      />
      {nothingToDo ? <p className="text-xs text-ink-faint">没有可执行的新建/更新项，也没有待标记移除的路径。</p> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onBack}>取消</Button>
        <Button size="sm" variant="secondary" onClick={onRepreview}>返回调整选择</Button>
        <Button size="sm" onClick={onConfirm} loading={busy} disabled={!matched || gatesBlocked || nothingToDo}>
          执行发布
        </Button>
      </div>
    </div>
  );
}

function ResultSummary({ result }: { result: KbPublishRunResultDto }) {
  const { created, updated, skipped, blocked, failed, secondPass } = result.counts;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs" data-testid="publish-result-summary">
      <span className="text-jade">新建 {created}</span>
      <span className="text-seal">更新 {updated}</span>
      <span className="text-ink-faint">无变化 {skipped}</span>
      <span className="text-[#8a6508]">阻断 {blocked}</span>
      <span className={failed > 0 ? 'text-seal-2' : 'text-ink-faint'}>失败 {failed}</span>
      {secondPass > 0 ? <span className="text-ink-faint">互链补写 {secondPass}</span> : null}
    </div>
  );
}

export function PublishHistoryList({
  publications,
  loading,
  titleByPath,
  onRefresh,
}: {
  publications: KbPublicationRowDto[];
  loading: boolean;
  titleByPath: Map<string, string>;
  onRefresh: () => void;
}) {
  const sorted = [...publications].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="space-y-2" data-testid="publish-history">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-soft">每篇文档的发布状态、警告与云端链接（按更新时间倒序）。</p>
        <Button size="sm" variant="ghost" onClick={onRefresh} loading={loading}><RefreshCw className="w-3.5 h-3.5" />刷新</Button>
      </div>
      {loading && publications.length === 0 ? <p className="text-xs text-ink-faint py-4">正在读取发布记录…</p>
        : sorted.length === 0 ? <p className="text-xs text-ink-faint py-4">尚无发布记录。发布一次后，这里会记录每篇文档的云端去向。</p>
          : (
            <ul className="rounded border border-line divide-y divide-line max-h-[55vh] overflow-auto scrollbar-thin">
              {sorted.map((row) => (
                <li key={row.kbPath} className="px-3 py-2 flex flex-col gap-1" data-publish-history-state={row.state}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <KbPublishStateBadge state={row.state} showAllStates />
                    <span className="text-xs text-ink flex-1 min-w-0 truncate" title={row.kbPath}>{titleByPath.get(row.kbPath) ?? row.kbPath}</span>
                    <span className="text-[10px] text-ink-faint shrink-0">{formatDateTime(row.updatedAt)}</span>
                    {row.cloudUrl ? (
                      <a href={row.cloudUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[10px] text-jade hover:underline shrink-0" aria-label="打开云端文档">
                        <ExternalLink className="w-3 h-3" />云端
                      </a>
                    ) : null}
                  </div>
                  {row.lastError ? <p className="text-xs text-seal-2">{row.lastError}</p> : null}
                  {row.warnings.warnings.length > 0 ? (
                    <details className="text-xs text-ink-faint">
                      <summary className="cursor-pointer">{row.warnings.warnings.length} 条警告</summary>
                      <ul className="list-disc pl-4 pt-0.5 space-y-0.5">
                        {row.warnings.warnings.map((warning, i) => <li key={i}>{describePublishWarning(warning)}</li>)}
                      </ul>
                    </details>
                  ) : null}
                  {row.warnings.previousCloudTokens?.length ? (
                    <p className="text-[10px] text-ink-faint">历史云端文档：{row.warnings.previousCloudTokens.join('、')}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
    </div>
  );
}

function actionClasses(action: KbPublishPlanItemDto['action']): string {
  switch (action) {
    case 'create':
      return 'border-jade/40 text-jade bg-jade/5';
    case 'update':
      return 'border-seal/40 text-seal bg-seal/5';
    case 'skip_unchanged':
      return 'border-line text-ink-faint bg-paper';
    default:
      return 'border-seal-2/40 text-seal-2 bg-seal-2/5';
  }
}
