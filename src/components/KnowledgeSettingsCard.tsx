/**
 * KnowledgeSettingsCard - 知识库设置卡片（T7，04 §4.3 / §7.2）
 *
 * 字段（与 server Config 对齐）：
 *   - knowledgeBaseRoot（本地根目录，B4 配合点）
 *   - watchedRootUrls（飞书根 URL 列表，支持增删；URL 规范化在前端做，
 *     剥离 ?fromScene=... 等查询参数与尾部斜杠，存储 canonical 形式）
 *   - pollIntervalMinutes（轮询间隔，5-1440）
 *   - larkCliPath（可选）
 *
 * 修复要点（2026-06-22 settings-entry-fix）：
 *  1. config=null 时显示骨架占位（不再 return null），避免 API 401/加载中
 *     时整张卡片不渲染，让用户始终看见"配置入口存在"。
 *  2. URL onBlur 自动规范化（剥离 ?fromScene 等），保存时再次规范化去重。
 *  3. 本地根目录支持 Electron desktop.openDataDirectory 打开 userData 目录
 *     作为便捷跳转（不做文件夹选择 dialog——server/desktop API 未暴露该 IPC，
 *     避免误承诺，用户可粘贴绝对路径）。
 *  4. 保存仅传 knowledgeBaseRoot/watchedRootUrls/pollIntervalMinutes/larkCliPath
 *     四字段，绝不回传 llm（避免把 server GET 时 mask 成 '***' 的 apiKey 写回）。
 *  5. URL 列表为空时仍渲染"添加 URL"按钮 + 默认 1 项占位输入框，
 *     确保入口即使无数据也可视可点。
 */

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, FolderOpen, Database, Loader2, AlertCircle } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { Input, Range } from './common/Input';
import { useConfig } from '../hooks/useConfig';
import { useToast } from './common/Toast';
import type { Config } from '../types';
import { normalizeFeishuUrl, normalizeFeishuUrlList } from '../utils/feishu-url';

const DEFAULT_URL_PLACEHOLDER = 'https://xxx.feishu.cn/wiki/<token>';

/**
 * Ensure the watched list always has at least one editable row so the user
 * sees a visible input even before clicking "添加 URL".
 */
function withLeadingBlank(urls: string[] | undefined | null): string[] {
  const list = Array.isArray(urls) ? urls.filter((u) => typeof u === 'string') : [];
  const nonEmpty = list.filter((u) => u.trim().length > 0);
  if (nonEmpty.length > 0) return list;
  return [''];
}

export function KnowledgeSettingsCard() {
  const { config, loading, error, saving, updateConfig } = useConfig();
  const toast = useToast();
  const [local, setLocal] = useState<Partial<Config>>({});
  /**
   * Tracks per-row normalisation feedback so the user sees when a URL they
   * pasted (e.g. with ?fromScene=...) has been canonicalised. Keyed by index.
   */
  const [urlHints, setUrlHints] = useState<Record<number, string>>({});

  useEffect(() => {
    if (config) {
      setLocal({
        ...config,
        watchedRootUrls: withLeadingBlank(config.watchedRootUrls),
      });
    }
  }, [config]);

  const viewState: 'loading' | 'error' | 'ready' = loading
    ? 'loading'
    : config
      ? 'ready'
      : error
        ? 'error'
        : 'loading';

  const cur: Config | null = useMemo(() => {
    if (!config) return null;
    return { ...config, ...local } as Config;
  }, [config, local]);

  const set = <K extends keyof Config>(k: K, v: Config[K]) => {
    setLocal((p) => ({ ...p, [k]: v }));
  };

  const handleSave = async () => {
    if (!cur) return;
    // Strip leading/trailing blank rows, normalise URLs, dedupe.
    const rawUrls = (cur.watchedRootUrls ?? []).filter((u) => u.trim().length > 0);
    const normalizedUrls = normalizeFeishuUrlList(rawUrls);

    if (normalizedUrls.length === 0) {
      toast.push({
        type: 'warning',
        message: '请至少填写一个飞书根 URL',
        hint: '可在飞书知识空间复制链接后粘贴到此处',
      });
      return;
    }

    try {
      // Only send the four knowledge-base fields. NEVER send llm — the
      // server GET masks apiKey to '***', and sending it back would
      // overwrite the user's real key.
      await updateConfig({
        knowledgeBaseRoot: (cur.knowledgeBaseRoot ?? '').trim(),
        watchedRootUrls: normalizedUrls,
        pollIntervalMinutes: cur.pollIntervalMinutes,
        larkCliPath: cur.larkCliPath?.trim() || undefined,
      });
      setUrlHints({});
      const summary =
        normalizedUrls.length === 1
          ? `已保存（1 个飞书根 URL）`
          : `已保存（${normalizedUrls.length} 个飞书根 URL）`;
      toast.push({ type: 'success', message: summary });
    } catch (err) {
      toast.push({
        type: 'error',
        message: '保存失败',
        hint: err instanceof Error ? err.message : '',
      });
    }
  };

  const handleOpenDataDir = async () => {
    if (typeof window !== 'undefined' && window.desktop?.openDataDirectory) {
      try {
        const res = await window.desktop.openDataDirectory();
        if (!res.success) {
          toast.push({
            type: 'warning',
            message: '打开目录失败',
            hint: res.error || '请检查路径是否已配置',
          });
        }
      } catch (err) {
        toast.push({
          type: 'error',
          message: '打开目录失败',
          hint: err instanceof Error ? err.message : '',
        });
      }
    } else {
      toast.push({
        type: 'info',
        message: '当前运行环境不支持打开目录',
        hint: '请直接复制粘贴本地根目录绝对路径',
      });
    }
  };

  const handleUrlBlur = (idx: number, value: string) => {
    const { canonical, wasModified, isValid } = normalizeFeishuUrl(value);
    if (!value.trim()) {
      setUrlHints((p) => {
        const next = { ...p };
        delete next[idx];
        return next;
      });
      return;
    }
    if (wasModified && isValid) {
      setUrlHints((p) => ({ ...p, [idx]: canonical }));
      const next = [...(cur?.watchedRootUrls ?? [])];
      next[idx] = canonical;
      set('watchedRootUrls', next);
    } else if (!isValid) {
      setUrlHints((p) => ({ ...p, [idx]: '__invalid__' }));
    } else {
      setUrlHints((p) => {
        const next = { ...p };
        delete next[idx];
        return next;
      });
    }
  };

  // ===========================================================================
  // Render branches
  // ===========================================================================

  if (viewState === 'loading') {
    return (
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-seal" />
            <h2 className="text-base font-kai font-medium text-ink">知识库设置</h2>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-ink-faint">
            <Loader2 className="w-4 h-4 animate-spin" />
            正在加载配置…
          </div>
          <div className="space-y-2">
            <div className="h-9 rounded-md bg-paper-2 animate-pulse" />
            <div className="h-9 rounded-md bg-paper-2 animate-pulse" />
            <div className="h-9 rounded-md bg-paper-2 animate-pulse w-2/3" />
          </div>
        </CardBody>
      </Card>
    );
  }

  if (viewState === 'error' || !cur) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-seal" />
            <h2 className="text-base font-kai font-medium text-ink">知识库设置</h2>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex items-start gap-2 text-sm text-seal-2 bg-seal-2/5 border border-seal-2/30 rounded-md p-3">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">无法加载配置</p>
              <p className="text-xs text-ink-soft mt-1">{error || '配置服务暂不可用'}</p>
              <p className="text-xs text-ink-faint mt-1">
                若在浏览器开发模式下访问，请确保后端已启动并通过桌面 token 鉴权。
              </p>
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }

  const urlList = withLeadingBlank(cur.watchedRootUrls);

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <Database className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">知识库设置</h2>
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        {/* Local root directory */}
        <div>
          <label className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
            本地根目录
          </label>
          <div className="flex gap-2">
            <Input
              fullWidth
              type="text"
              value={cur.knowledgeBaseRoot ?? ''}
              onChange={(e) => set('knowledgeBaseRoot', e.target.value)}
              placeholder="D:\WorkPace\公司知识库\飞书同步知识库"
            />
            <Button
              variant="secondary"
              size="md"
              onClick={handleOpenDataDir}
              title="打开当前配置的数据目录（userData）"
            >
              <FolderOpen className="w-4 h-4" />
              打开目录
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-ink-faint font-serif">
            本地知识库的根目录绝对路径。同步会将飞书文档写入此目录。
          </p>
        </div>

        {/* Watched root URLs */}
        <div>
          <label className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
            飞书根 URL（支持多个）
          </label>
          <div className="space-y-2">
            {urlList.map((url, idx) => {
              const hint = urlHints[idx];
              const isInvalid = hint === '__invalid__';
              const isNormalized = hint && !isInvalid;
              return (
                <div key={idx} className="space-y-1">
                  <div className="flex gap-2">
                    <Input
                      fullWidth
                      type="url"
                      value={url}
                      error={isInvalid ? '看起来不是有效的飞书 wiki URL（缺少 /wiki/<token>）' : undefined}
                      onChange={(e) => {
                        const next = [...urlList];
                        next[idx] = e.target.value;
                        set('watchedRootUrls', next);
                      }}
                      onBlur={(e) => handleUrlBlur(idx, e.target.value)}
                      placeholder={DEFAULT_URL_PLACEHOLDER}
                    />
                    <Button
                      variant="ghost"
                      size="md"
                      onClick={() => {
                        const next = urlList.filter((_, i) => i !== idx);
                        set('watchedRootUrls', next);
                        setUrlHints((p) => {
                          const nextHints: Record<number, string> = {};
                          // Reindex hints to follow surviving rows.
                          let newIdx = 0;
                          for (let i = 0; i < urlList.length; i++) {
                            if (i === idx) continue;
                            if (p[i]) nextHints[newIdx] = p[i];
                            newIdx++;
                          }
                          return nextHints;
                        });
                      }}
                      title="删除此 URL"
                      disabled={urlList.length === 1 && !url}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  {isNormalized && (
                    <p className="text-xs text-jade font-sans-ui">
                      已规范化（剥离查询参数 / 尾部斜杠）：{hint}
                    </p>
                  )}
                </div>
              );
            })}
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => set('watchedRootUrls', [...urlList, ''])}
              >
                <Plus className="w-3.5 h-3.5" />
                添加 URL
              </Button>
              <span className="text-xs text-ink-faint font-serif">
                支持策划 / 技术等多个知识空间；粘贴带 ?fromScene=… 的链接会自动规范化。
              </span>
            </div>
          </div>
        </div>

        {/* Poll interval */}
        <Range
          label="轮询间隔（分钟）"
          min="5"
          max="1440"
          step="5"
          value={String(cur.pollIntervalMinutes)}
          onChange={(e) => set('pollIntervalMinutes', parseInt(e.target.value, 10) || 30)}
          helperText="范围 5-1440 分钟；默认 30 分钟"
        />

        {/* lark-cli path */}
        <Input
          label="lark-cli 路径（可选）"
          type="text"
          value={cur.larkCliPath ?? ''}
          onChange={(e) => set('larkCliPath', e.target.value || undefined)}
          placeholder="留空则使用系统 PATH"
        />

        <div className="flex justify-end pt-3 border-t border-line">
          <Button onClick={handleSave} loading={saving}>
            保存设置
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
